//! Terminal backend. Every terminal is owned by thel's session daemon (see
//! `daemon.rs`), which keeps it alive across the GUI and holds the authoritative
//! screen for reattach; the commands in `lib.rs` reach it through the thin
//! forwarding layer here.
//!
//! This module also owns the pieces the daemon builds on: spawning a PTY with
//! thel's standard environment, sampling a terminal's process tree, and decoding
//! its output as a UTF-8 stream.

use std::collections::HashMap;
#[cfg(any(target_os = "linux", target_os = "macos"))]
use std::collections::HashSet;

use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;

/// Terminals need the daemon, which is unix-only; nothing else can serve them.
#[cfg(not(unix))]
const UNSUPPORTED: &str = "thel needs Linux or macOS to run terminals";

/// Messages streamed to the frontend over a per-session channel.
/// `data` carries terminal output; `exit` is sent once when the child ends.
#[derive(Clone, Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum TermMsg {
    Data { data: String },
    // Foreground busy state, pushed by the daemon so the GUI doesn't poll.
    Busy { busy: bool },
    // An out-of-band notification for this tab (from `thel notify`), forwarded by
    // the daemon so it reaches the GUI even when the caller has no tty.
    Notify { message: String },
    Exit { code: Option<i32> },
}

/// Polled state of a terminal. `busy` = a foreground command is running (vs an
/// idle shell). `dead`/`code` are reserved for parity with the channel exit.
#[derive(Clone, Serialize)]
pub struct TermStatus {
    pub busy: bool,
    pub dead: bool,
    pub code: Option<i32>,
}

#[derive(Deserialize)]
pub struct CreateOpts {
    pub id: String,
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
    pub cwd: Option<String>,
    pub env: Option<HashMap<String, String>>,
    pub cols: u16,
    pub rows: u16,
}

/// Open a PTY and spawn `command` on its slave, returning the master (kept for
/// resize/read/write) and the child. Used by the daemon, which owns every
/// terminal, so the standard environment (TERM + the THEL markers a program uses
/// to detect thel and target `thel notify`) is set in one place. `cols`/
/// `rows` are floored at 1 (a 0-size PTY confuses programs).
pub(crate) fn spawn_pty(
    command: &str,
    args: &[String],
    cwd: Option<&str>,
    env: Option<&HashMap<String, String>>,
    cols: u16,
    rows: u16,
    id: &str,
) -> Result<(Box<dyn MasterPty + Send>, Box<dyn Child + Send + Sync>), String> {
    let pair = native_pty_system()
        .openpty(PtySize {
            rows: rows.max(1),
            cols: cols.max(1),
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| e.to_string())?;

    let mut cmd = CommandBuilder::new(command);
    cmd.args(args);
    if let Some(cwd) = cwd {
        cmd.cwd(cwd);
    }
    // TERM is needed for most agents/shells to emit sane escape sequences.
    cmd.env("TERM", "xterm-256color");
    // Let programs detect thel and address `thel notify` at this tab (delivery
    // is by PTY, so the id is informational).
    cmd.env("THEL", "1");
    cmd.env("THEL_TERMINAL_ID", id);
    if let Some(env) = env {
        for (k, v) in env {
            cmd.env(k, v);
        }
    }

    let child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| format!("failed to spawn '{command}': {e}"))?;
    // Drop the slave so the master sees EOF when the child exits.
    drop(pair.slave);
    Ok((pair.master, child))
}

/// Open (or reattach to) a terminal, streaming its output to `on_data`. The
/// daemon's `open` is attach-if-alive-else-respawn, so a restored tab comes back
/// to its running shell and a new one is spawned at its cwd.
pub fn create(opts: CreateOpts, on_data: Channel<TermMsg>) -> Result<(), String> {
    #[cfg(unix)]
    let res = crate::daemon::open(&opts, on_data);
    #[cfg(not(unix))]
    let res = {
        let _ = (opts, on_data);
        Err(UNSUPPORTED.to_string())
    };
    res
}

pub fn write(id: &str, data: &str) -> Result<(), String> {
    #[cfg(unix)]
    let res = crate::daemon::input(id, data.as_bytes());
    #[cfg(not(unix))]
    let res = {
        let _ = (id, data);
        Err(UNSUPPORTED.to_string())
    };
    res
}

pub fn resize(id: &str, cols: u16, rows: u16) -> Result<(), String> {
    #[cfg(unix)]
    let res = crate::daemon::resize(id, cols, rows);
    #[cfg(not(unix))]
    let res = {
        let _ = (id, cols, rows);
        Err(UNSUPPORTED.to_string())
    };
    res
}

/// Detach this terminal's view: the daemon keeps the tab running so a later
/// mount (or a restarted GUI) reattaches to it by id. Off unix this is Ok
/// rather than the usual refusal: nothing was ever opened, and a closing tab
/// has no use for an error.
pub fn close(id: &str) -> Result<(), String> {
    #[cfg(unix)]
    let res = crate::daemon::detach(id);
    #[cfg(not(unix))]
    let res = {
        let _ = id;
        Ok(())
    };
    res
}

/// Permanently destroy a terminal: the user closed the tab, or closed a window
/// with background sessions off.
pub fn kill_window(term_id: &str) {
    #[cfg(unix)]
    let _ = crate::daemon::kill(term_id);
    #[cfg(not(unix))]
    let _ = term_id;
}

/// Whether a foreground command is running in the terminal. Asked on demand,
/// to warn before closing a tab that is still working; the notification
/// heuristics run off the daemon's pushed busy events instead. `dead`/`code`
/// are reserved for parity with the channel exit.
pub fn status(id: &str) -> TermStatus {
    #[cfg(unix)]
    let busy = crate::daemon::statuses().get(id).copied().unwrap_or(false);
    #[cfg(not(unix))]
    let busy = {
        let _ = id;
        false
    };
    TermStatus {
        busy,
        dead: false,
        code: None,
    }
}

/// Resource use of the given terminals, keyed by id. The daemon owns those
/// processes, so it does the sampling; ids with no live process are simply
/// absent from the result.
pub fn usage(ids: &[String]) -> HashMap<String, Usage> {
    if ids.is_empty() {
        return HashMap::new();
    }
    // Sampling walks every tab's process tree, and the usage dialog asks on a
    // tick, so an empty request must not pay for it.
    #[cfg(unix)]
    let out = {
        let all = crate::daemon::usages();
        ids.iter()
            .filter_map(|id| Some((id.clone(), *all.get(id)?)))
            .collect()
    };
    #[cfg(not(unix))]
    let out = {
        let _ = ids;
        HashMap::new()
    };
    out
}

/// Where a terminal's shell currently is, so a new terminal can open where the
/// one you were last in got to. The daemon owns the process, so it answers.
pub fn cwd(id: &str) -> Option<String> {
    #[cfg(unix)]
    let out = crate::daemon::cwd(id);
    #[cfg(not(unix))]
    let out = {
        let _ = id;
        None
    };
    out
}

/// Resource use of one terminal's process tree. `cpu_seconds` is cumulative CPU
/// time since the processes started, not a rate: the frontend turns successive
/// samples into a percentage, so nothing here has to sample over time.
#[derive(Clone, Copy, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Usage {
    pub cpu_seconds: f64,
    pub rss_bytes: u64,
}

#[cfg(target_os = "linux")]
fn clock_ticks() -> f64 {
    let t = unsafe { libc::sysconf(libc::_SC_CLK_TCK) };
    if t > 0 {
        t as f64
    } else {
        100.0
    }
}

#[cfg(target_os = "linux")]
fn page_size() -> u64 {
    let p = unsafe { libc::sysconf(libc::_SC_PAGESIZE) };
    if p > 0 {
        p as u64
    } else {
        4096
    }
}

/// CPU time and resident memory for each root's whole process tree, so a shell
/// running an agent reports the agent's cost too. One pass over /proc serves
/// every root, since the alternative walks it once per terminal.
///
/// ponytail: RSS is summed naively, so pages shared between a parent and its
/// children are counted more than once; read PSS from /proc/<pid>/smaps_rollup
/// instead if the number ever has to be exact.
#[cfg(target_os = "linux")]
pub(crate) fn process_tree_usage(roots: &[(String, u32)]) -> HashMap<String, Usage> {
    // pid -> (ppid, cpu ticks, rss pages)
    let mut procs: HashMap<u32, (u32, u64, u64)> = HashMap::new();
    let Ok(dir) = std::fs::read_dir("/proc") else {
        return HashMap::new();
    };
    for entry in dir.flatten() {
        let Ok(pid) = entry.file_name().to_string_lossy().parse::<u32>() else {
            continue;
        };
        // Racy by nature: a process can exit between the readdir and this read.
        let Ok(stat) = std::fs::read_to_string(entry.path().join("stat")) else {
            continue;
        };
        // comm (field 2) is parenthesised and may itself contain spaces and
        // parens, so fields are counted from its *last* closing paren onwards,
        // where index 0 is field 3.
        let Some((_, rest)) = stat.rsplit_once(')') else {
            continue;
        };
        let f: Vec<&str> = rest.split_ascii_whitespace().collect();
        let at = |i: usize| f.get(i).and_then(|v| v.parse::<u64>().ok()).unwrap_or(0);
        // 1-based ppid=4, utime=14, stime=15, all shifted down by 3.
        // RSS comes from statm, not stat's field 24: that one undercounts (its
        // own man page calls it inaccurate), and statm's matches VmRSS, which is
        // what ps and top show. Disagreeing with those would just look wrong.
        let rss = std::fs::read_to_string(entry.path().join("statm"))
            .ok()
            .and_then(|m| m.split_ascii_whitespace().nth(1)?.parse::<u64>().ok())
            .unwrap_or(0);
        procs.insert(pid, (at(1) as u32, at(11) + at(12), rss));
    }

    let mut children: HashMap<u32, Vec<u32>> = HashMap::new();
    for (pid, (ppid, _, _)) in &procs {
        children.entry(*ppid).or_default().push(*pid);
    }

    let (ticks, page) = (clock_ticks(), page_size());
    roots
        .iter()
        .map(|(id, root)| {
            let (mut cpu, mut rss) = (0u64, 0u64);
            let mut stack = vec![*root];
            let mut seen = HashSet::new();
            while let Some(pid) = stack.pop() {
                // pid reuse could in principle close a loop; the guard is cheap.
                if !seen.insert(pid) {
                    continue;
                }
                if let Some((_, c, r)) = procs.get(&pid) {
                    cpu += c;
                    rss += r;
                }
                if let Some(kids) = children.get(&pid) {
                    stack.extend(kids);
                }
            }
            (
                id.clone(),
                Usage {
                    cpu_seconds: cpu as f64 / ticks,
                    rss_bytes: rss * page,
                },
            )
        })
        .collect()
}

/// All process ids on the system, via libproc (macOS has no /proc). Over-allocate
/// since the set can grow between the sizing call and the fetch.
#[cfg(target_os = "macos")]
fn macos_all_pids() -> Vec<u32> {
    let n = unsafe { libc::proc_listallpids(std::ptr::null_mut(), 0) };
    if n <= 0 {
        return Vec::new();
    }
    let cap = n as usize + 64;
    let mut pids = vec![0i32; cap];
    let got = unsafe {
        libc::proc_listallpids(
            pids.as_mut_ptr() as *mut libc::c_void,
            (cap * std::mem::size_of::<i32>()) as libc::c_int,
        )
    };
    if got <= 0 {
        return Vec::new();
    }
    pids.truncate(got as usize);
    pids.into_iter().filter(|&p| p > 0).map(|p| p as u32).collect()
}

/// (ppid, cpu nanoseconds, resident bytes) for one pid via a single
/// PROC_PIDTASKALLINFO call, which bundles the BSD info (ppid) and task info
/// (CPU + RSS). None if the process is gone or owned by another user (task info
/// is same-uid/root only) -- our own shells and their descendants are always
/// readable, which is all a root's tree contains.
#[cfg(target_os = "macos")]
fn macos_proc_usage(pid: u32) -> Option<(u32, u64, u64)> {
    let mut info: libc::proc_taskallinfo = unsafe { std::mem::zeroed() };
    let size = std::mem::size_of::<libc::proc_taskallinfo>() as libc::c_int;
    let n = unsafe {
        libc::proc_pidinfo(
            pid as libc::c_int,
            libc::PROC_PIDTASKALLINFO,
            0,
            &mut info as *mut _ as *mut libc::c_void,
            size,
        )
    };
    if n != size {
        return None; // gone, or task info denied for another user's process
    }
    let cpu_ns = info.ptinfo.pti_total_user + info.ptinfo.pti_total_system;
    Some((info.pbsd.pbi_ppid, cpu_ns, info.ptinfo.pti_resident_size))
}

/// macOS equivalent of the Linux /proc walk: one libproc pass builds the pid ->
/// (ppid, cpu, rss) map, then each root's whole tree is summed. CPU comes back in
/// nanoseconds and RSS in bytes, so no clock-tick / page-size scaling is needed.
#[cfg(target_os = "macos")]
pub(crate) fn process_tree_usage(roots: &[(String, u32)]) -> HashMap<String, Usage> {
    // pid -> (ppid, cpu nanoseconds, rss bytes)
    let mut procs: HashMap<u32, (u32, u64, u64)> = HashMap::new();
    for pid in macos_all_pids() {
        if let Some(u) = macos_proc_usage(pid) {
            procs.insert(pid, u);
        }
    }

    let mut children: HashMap<u32, Vec<u32>> = HashMap::new();
    for (pid, (ppid, _, _)) in &procs {
        children.entry(*ppid).or_default().push(*pid);
    }

    roots
        .iter()
        .map(|(id, root)| {
            let (mut cpu_ns, mut rss) = (0u64, 0u64);
            let mut stack = vec![*root];
            let mut seen = HashSet::new();
            while let Some(pid) = stack.pop() {
                // pid reuse could in principle close a loop; the guard is cheap.
                if !seen.insert(pid) {
                    continue;
                }
                if let Some((_, c, r)) = procs.get(&pid) {
                    cpu_ns += c;
                    rss += r;
                }
                if let Some(kids) = children.get(&pid) {
                    stack.extend(kids);
                }
            }
            (
                id.clone(),
                Usage {
                    cpu_seconds: cpu_ns as f64 / 1_000_000_000.0,
                    rss_bytes: rss,
                },
            )
        })
        .collect()
}

/// No process enumeration on other platforms (Windows), so the dialog shows the
/// terminals with no numbers until one is added.
#[cfg(not(any(target_os = "linux", target_os = "macos")))]
pub(crate) fn process_tree_usage(_roots: &[(String, u32)]) -> HashMap<String, Usage> {
    HashMap::new()
}

/// Where a process currently is, so a new terminal can open where the one you
/// were last in got to. Asked of the kernel rather than of the shell: OSC 7
/// would need shell cooperation most setups don't have (Fedora's vte.sh only
/// arms itself under VTE), and it can name a directory that isn't ours, whereas
/// this is by definition a live local one. None when the process is gone.
#[cfg(target_os = "linux")]
pub(crate) fn process_cwd(pid: u32) -> Option<String> {
    std::fs::read_link(format!("/proc/{pid}/cwd"))
        .ok()?
        .to_str()
        .map(String::from)
}

#[cfg(target_os = "macos")]
pub(crate) fn process_cwd(pid: u32) -> Option<String> {
    let mut info: libc::proc_vnodepathinfo = unsafe { std::mem::zeroed() };
    let size = std::mem::size_of::<libc::proc_vnodepathinfo>() as libc::c_int;
    let n = unsafe {
        libc::proc_pidinfo(
            pid as libc::c_int,
            libc::PROC_PIDVNODEPATHINFO,
            0,
            &mut info as *mut _ as *mut libc::c_void,
            size,
        )
    };
    if n != size {
        return None; // gone, or denied for another user's process
    }
    // libc spells the path as [[c_char; 32]; 32] to stay buildable on old rustc,
    // so read it back as the flat NUL-terminated buffer it really is.
    let buf = &info.pvi_cdir.vip_path;
    let bytes =
        unsafe { std::slice::from_raw_parts(buf.as_ptr() as *const u8, std::mem::size_of_val(buf)) };
    let end = bytes.iter().position(|&b| b == 0).unwrap_or(bytes.len());
    String::from_utf8(bytes[..end].to_vec()).ok()
}

#[cfg(not(any(target_os = "linux", target_os = "macos")))]
pub(crate) fn process_cwd(_pid: u32) -> Option<String> {
    None
}

/// Decode a chunk of a UTF-8 byte stream, replacing invalid sequences with
/// U+FFFD. A partial trailing codepoint is held back in `carry` and completed
/// by the next chunk, so a multibyte char split across reads/frames isn't
/// mangled. Used by the daemon's PTY reader and by the client's frame decoder
/// (where the split happens across OUTPUT frames).
pub(crate) fn decode_utf8_stream(carry: &mut Vec<u8>, chunk: &[u8]) -> String {
    carry.extend_from_slice(chunk);
    let mut out = String::with_capacity(carry.len());
    loop {
        match std::str::from_utf8(carry) {
            Ok(s) => {
                out.push_str(s);
                carry.clear();
                return out;
            }
            Err(e) => {
                let valid = e.valid_up_to();
                // Safe: from_utf8 just validated this prefix.
                out.push_str(unsafe { std::str::from_utf8_unchecked(&carry[..valid]) });
                match e.error_len() {
                    Some(bad) => {
                        out.push('\u{FFFD}');
                        carry.drain(..valid + bad);
                    }
                    None => {
                        // Incomplete trailing codepoint: keep it for the next chunk.
                        carry.drain(..valid);
                        return out;
                    }
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::decode_utf8_stream;

    /// The /proc parse is easy to get subtly wrong (comm can contain spaces and
    /// parens, and the field offsets shift past it), so pin it against the one
    /// tree the test can be sure about: its own.
    #[cfg(target_os = "linux")]
    #[test]
    fn reads_a_process_tree_from_proc() {
        let me = std::process::id();
        let out = super::process_tree_usage(&[
            ("self".to_string(), me),
            // No such pid: must contribute nothing rather than be omitted or panic.
            ("gone".to_string(), u32::MAX),
        ]);
        assert!(out["self"].rss_bytes > 0, "our own process has resident memory");
        assert_eq!(out["gone"].rss_bytes, 0);
        assert_eq!(out["gone"].cpu_seconds, 0.0);
    }

    /// macOS reads the tree through libproc instead of /proc. Spawn a real child
    /// so there's a descendant to sum, and check the tree rooted at us includes
    /// it -- the point of walking a *tree* rather than a single pid.
    #[cfg(target_os = "macos")]
    #[test]
    fn reads_a_process_tree_via_libproc() {
        let me = std::process::id();
        let mut child = std::process::Command::new("/bin/sh")
            .args(["-c", "sleep 30"])
            .spawn()
            .expect("spawn a child process");
        let child_pid = child.id();

        let out = super::process_tree_usage(&[
            ("tree".to_string(), me),
            ("child".to_string(), child_pid),
            // No such pid: must contribute nothing rather than be omitted or panic.
            ("gone".to_string(), u32::MAX),
        ]);

        let _ = child.kill();
        let _ = child.wait();

        assert!(out["tree"].rss_bytes > 0, "our own process has resident memory");
        assert!(out["child"].rss_bytes > 0, "the child reports resident memory");
        // The child is our descendant, so the tree rooted at us must include it.
        assert!(
            out["tree"].rss_bytes >= out["child"].rss_bytes,
            "tree total {} should include the child {}",
            out["tree"].rss_bytes,
            out["child"].rss_bytes,
        );
        assert_eq!(out["gone"].rss_bytes, 0);
        assert_eq!(out["gone"].cpu_seconds, 0.0);
    }

    #[test]
    fn carries_a_multibyte_char_split_across_chunks() {
        let mut carry = Vec::new();
        let heart = "❤".as_bytes(); // 3 bytes
        assert_eq!(decode_utf8_stream(&mut carry, &heart[..2]), "");
        assert_eq!(decode_utf8_stream(&mut carry, &heart[2..]), "❤");
        assert!(carry.is_empty());
    }

    #[test]
    fn replaces_invalid_bytes_and_keeps_going() {
        let mut carry = Vec::new();
        assert_eq!(decode_utf8_stream(&mut carry, b"a\xffb\xfe"), "a\u{FFFD}b\u{FFFD}");
        assert!(carry.is_empty());
    }

    #[test]
    fn partial_tail_then_invalid_completion() {
        let mut carry = Vec::new();
        // First byte of a 3-byte char, then a byte that can't continue it.
        assert_eq!(decode_utf8_stream(&mut carry, b"ok\xe2"), "ok");
        assert_eq!(decode_utf8_stream(&mut carry, b"x"), "\u{FFFD}x");
        assert!(carry.is_empty());
    }
}
