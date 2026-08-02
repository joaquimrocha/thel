//! Terminal backend. Terminals are normally owned by thel's session daemon (see
//! `daemon.rs`), which keeps them alive across the GUI and holds the authoritative
//! screen for reattach. This module also provides the direct in-process PTY
//! fallback used when the daemon is off or unavailable (e.g. non-unix).
//!
//! For daemon-backed ids, input/resize/close route to the daemon; a direct
//! terminal is a `portable-pty` child whose output is read on a background thread
//! and streamed to the frontend over a per-session channel.

use std::collections::HashMap;
#[cfg(unix)]
use std::collections::HashSet;
use std::io::{Read, Write};
use std::sync::Arc;

use parking_lot::Mutex;
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;

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
    // Back this terminal with thel's own session daemon (unix); defaults on.
    // When off (or non-unix) it runs as a direct, non-persistent PTY.
    #[serde(default)]
    pub use_daemon: Option<bool>,
}

/// Open a PTY and spawn `command` on its slave, returning the master (kept for
/// resize/read/write) and the child. Shared by the direct-PTY fallback here and
/// the daemon, so the standard environment (TERM + the THEL markers a program
/// uses to detect thel and target `thel notify`) is set in one place. `cols`/
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

struct Session {
    // Kept for resize() and busy queries; MasterPty methods take &self.
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    // Shared with the reader thread so it can wait() for the exit code while
    // the manager can still kill() on close.
    child: Arc<Mutex<Box<dyn Child + Send + Sync>>>,
    // The shell/agent pid; used to tell an idle shell from one running a command.
    pid: Option<u32>,
}

#[derive(Default)]
pub struct SessionManager {
    sessions: Mutex<HashMap<String, Session>>,
    // Ids backed by thel's own session daemon; their input/resize/close route to
    // the daemon instead of a local PTY.
    #[cfg(unix)]
    daemon_ids: Mutex<HashSet<String>>,
}

impl SessionManager {
    pub fn create(&self, opts: CreateOpts, on_data: Channel<TermMsg>) -> Result<(), String> {
        #[cfg(unix)]
        if opts.use_daemon.unwrap_or(true) {
            crate::daemon::open(&opts, on_data)?;
            self.daemon_ids.lock().insert(opts.id);
            return Ok(());
        }
        // The daemon is the default backend; without it (toggled off, or non-unix)
        // fall back to a direct, non-persistent PTY.
        self.create_direct(opts, on_data)
    }

    fn create_direct(&self, opts: CreateOpts, on_data: Channel<TermMsg>) -> Result<(), String> {
        let (master, child) = spawn_pty(
            &opts.command,
            &opts.args,
            opts.cwd.as_deref(),
            opts.env.as_ref(),
            opts.cols,
            opts.rows,
            &opts.id,
        )?;
        let pid = child.process_id();
        self.spawn_session(opts.id, master, child, pid, on_data)
    }

    // Wire up the reader thread and register a direct session.
    fn spawn_session(
        &self,
        id: String,
        master: Box<dyn MasterPty + Send>,
        child: Box<dyn Child + Send + Sync>,
        pid: Option<u32>,
        on_data: Channel<TermMsg>,
    ) -> Result<(), String> {
        let reader = master.try_clone_reader().map_err(|e| e.to_string())?;
        let writer = master.take_writer().map_err(|e| e.to_string())?;
        let child = Arc::new(Mutex::new(child));
        let thread_child = child.clone();
        std::thread::spawn(move || read_loop(reader, on_data, thread_child));
        self.sessions.lock().insert(
            id,
            Session {
                master,
                writer,
                child,
                pid,
            },
        );
        Ok(())
    }

    pub fn write(&self, id: &str, data: &str) -> Result<(), String> {
        #[cfg(unix)]
        {
            let is_daemon = self.daemon_ids.lock().contains(id);
            if is_daemon {
                return crate::daemon::input(id, data.as_bytes());
            }
        }
        let mut map = self.sessions.lock();
        let session = map.get_mut(id).ok_or("unknown session")?;
        session
            .writer
            .write_all(data.as_bytes())
            .map_err(|e| e.to_string())?;
        session.writer.flush().map_err(|e| e.to_string())
    }

    pub fn resize(&self, id: &str, cols: u16, rows: u16) -> Result<(), String> {
        #[cfg(unix)]
        {
            let is_daemon = self.daemon_ids.lock().contains(id);
            if is_daemon {
                return crate::daemon::resize(id, cols, rows);
            }
        }
        let map = self.sessions.lock();
        let session = map.get(id).ok_or("unknown session")?;
        session
            .master
            .resize(PtySize {
                rows: rows.max(1),
                cols: cols.max(1),
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| e.to_string())
    }

    /// Detach this terminal's view. A daemon tab keeps running (reattach later);
    /// a direct terminal's child is killed.
    pub fn close(&self, id: &str) -> Result<(), String> {
        #[cfg(unix)]
        {
            // Detach only (keep the id so an explicit tab-close can still kill
            // it): the daemon keeps the tab running for reattach.
            let is_daemon = self.daemon_ids.lock().contains(id);
            if is_daemon {
                return crate::daemon::detach(id);
            }
        }
        if let Some(session) = self.sessions.lock().remove(id) {
            let _ = session.child.lock().kill();
        }
        Ok(())
    }

    /// Permanently destroy a terminal (the user closed the tab): kill the daemon
    /// tab, or the direct child.
    pub fn kill_window(&self, _session_id: &str, term_id: &str) {
        #[cfg(unix)]
        {
            let was_daemon = self.daemon_ids.lock().remove(term_id);
            if was_daemon {
                let _ = crate::daemon::kill(term_id);
                return;
            }
        }
        if let Some(session) = self.sessions.lock().remove(term_id) {
            let _ = session.child.lock().kill();
            return;
        }
        #[cfg(unix)]
        {
            // A restored daemon tab may not have been mounted in this GUI run yet,
            // so it is not in daemon_ids. If a compatible daemon is already up,
            // still ask it to kill the tab by id; do not spawn one just to kill.
            if crate::daemon::check() == "ok" {
                let _ = crate::daemon::kill(term_id);
            }
        }
    }

    pub fn status(&self, id: &str) -> TermStatus {
        // Daemon tabs live in the daemon, not in `sessions`; query it (the
        // TerminalPane "finished" notification heuristic polls this per tab, so
        // it must cover daemon tabs or the notification never fires).
        #[cfg(unix)]
        {
            if self.daemon_ids.lock().contains(id) {
                let busy = crate::daemon::statuses().get(id).copied().unwrap_or(false);
                return TermStatus {
                    busy,
                    dead: false,
                    code: None,
                };
            }
        }
        let map = self.sessions.lock();
        if let Some(session) = map.get(id) {
            return TermStatus {
                busy: is_busy(session),
                dead: false,
                code: None,
            };
        }
        drop(map);
        #[cfg(unix)]
        let busy = crate::daemon::statuses().get(id).copied().unwrap_or(false);
        #[cfg(not(unix))]
        let busy = false;
        TermStatus {
            busy,
            dead: false,
            code: None,
        }
    }

    /// Resource use of the given terminals, keyed by id. Daemon tabs are resolved
    /// by the daemon (it owns those processes); the rest are direct PTYs owned
    /// here. Ids with no live process are simply absent from the result.
    pub fn usage(&self, ids: &[String]) -> HashMap<String, Usage> {
        let mut out = HashMap::new();
        #[cfg(unix)]
        {
            let daemon_ids = self.daemon_ids.lock();
            let mine: Vec<&String> = ids.iter().filter(|i| daemon_ids.contains(i.as_str())).collect();
            let want = !mine.is_empty();
            drop(daemon_ids);
            if want {
                let all = crate::daemon::usages();
                out.extend(
                    ids.iter()
                        .filter_map(|id| Some((id.clone(), *all.get(id)?))),
                );
            }
        }
        let map = self.sessions.lock();
        let roots: Vec<(String, u32)> = ids
            .iter()
            .filter(|id| !out.contains_key(*id))
            .filter_map(|id| Some((id.clone(), map.get(id)?.pid?)))
            .collect();
        drop(map);
        out.extend(process_tree_usage(&roots));
        out
    }
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

/// A foreground command is running when the PTY's foreground process group isn't
/// the shell itself.
fn is_busy(s: &Session) -> bool {
    match (s.master.process_group_leader(), s.pid) {
        (Some(leader), Some(pid)) => leader as i64 != pid as i64,
        _ => false,
    }
}

/// Decode a chunk of a UTF-8 byte stream, replacing invalid sequences with
/// U+FFFD. A partial trailing codepoint is held back in `carry` and completed
/// by the next chunk, so a multibyte char split across reads/frames isn't
/// mangled. Used by the direct-PTY read loop and the daemon client's frame
/// decoder (where the split happens across OUTPUT frames).
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

/// Blocking read loop on its own thread. Splits output on valid UTF-8 boundaries
/// (carrying a partial trailing codepoint) so a multibyte char split across reads
/// isn't mangled.
fn read_loop(
    mut reader: Box<dyn Read + Send>,
    chan: Channel<TermMsg>,
    child: Arc<Mutex<Box<dyn Child + Send + Sync>>>,
) {
    let mut buf = [0u8; 8192];
    let mut carry: Vec<u8> = Vec::new();
    loop {
        match reader.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => {
                let s = decode_utf8_stream(&mut carry, &buf[..n]);
                if !s.is_empty() && chan.send(TermMsg::Data { data: s }).is_err() {
                    return;
                }
            }
            Err(_) => break,
        }
    }

    let code = child.lock().wait().ok().map(|s| s.exit_code() as i32);
    let _ = chan.send(TermMsg::Exit { code });
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
