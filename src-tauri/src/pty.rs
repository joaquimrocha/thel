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
    // The tab's TCP listeners, pushed by the daemon whenever they change.
    Ports { ports: Vec<ListenPort> },
    // The tab has run nothing but its shell for a while, or stopped doing so.
    Idle { idle: bool },
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
    #[cfg(target_os = "linux")]
    if let Some(bin) = scope_wrapper(command, cwd, env) {
        cmd = CommandBuilder::new(bin);
        cmd.args(crate::cgroup::SCOPE_ARGS);
        cmd.arg(command);
    }
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

/// The systemd-run that puts a new terminal in its own cgroup (see cgroup.rs),
/// or None to spawn it directly. A command that does not resolve skips the
/// wrapper, so it fails at spawn with an error the GUI shows, rather than
/// inside systemd-run after the tab is already up.
#[cfg(target_os = "linux")]
fn scope_wrapper(
    command: &str,
    cwd: Option<&str>,
    env: Option<&HashMap<String, String>>,
) -> Option<&'static std::path::Path> {
    let bin = crate::cgroup::systemd_run()?;
    let path = env
        .and_then(|e| e.get("PATH").cloned())
        .or_else(|| std::env::var("PATH").ok())
        .unwrap_or_default();
    let cwd = std::path::Path::new(cwd.unwrap_or("/"));
    crate::cgroup::which(command, &path, cwd).map(|_| bin)
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

/// Stops (SIGTERM) `pid`, which must still listen on a port in terminal `id`'s
/// process tree. The daemon owns the tree, so it checks and signals. Errors
/// carry a message for the user.
pub fn stop_listener(id: &str, pid: u32) -> Result<(), String> {
    #[cfg(unix)]
    let out = crate::daemon::stop_listener(id, pid);
    #[cfg(not(unix))]
    let out = {
        let _ = (id, pid);
        Err(UNSUPPORTED.to_string())
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

/// A TCP port in the LISTEN state and the process holding it.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ListenPort {
    pub port: u16,
    pub pid: u32,
    /// The process name (comm), e.g. "node".
    pub name: String,
}

/// CPU time and resident memory for each root's whole process tree, so a shell
/// running an agent reports the agent's cost too. A root whose process is gone
/// reports zero.
pub(crate) fn process_tree_usage(roots: &[(String, u32)]) -> HashMap<String, Usage> {
    sample_trees(roots)
        .into_iter()
        .map(|(id, usage, _)| (id, usage))
        .collect()
}

/// TCP listeners in each root's whole process tree, sorted by port. Every root
/// is in the result, with an empty list when nothing in its tree listens.
#[cfg(any(target_os = "linux", target_os = "macos"))]
pub(crate) fn process_tree_ports(roots: &[(String, u32)]) -> HashMap<String, Vec<ListenPort>> {
    let sampled = sample_trees(roots);
    let trees: Vec<&HashSet<u32>> = sampled.iter().map(|(_, _, t)| t).collect();
    let all: HashSet<u32> = trees.iter().flat_map(|t| t.iter().copied()).collect();
    let ports = assign_ports(&trees, listening_ports(&all));
    sampled.into_iter().map(|(id, _, _)| id).zip(ports).collect()
}

/// Whether each root's process tree is nothing but its shell: no foreground or
/// background job, and no program started in place of a shell.
#[cfg(any(target_os = "linux", target_os = "macos"))]
pub(crate) fn process_tree_shell_only(roots: &[(String, u32)]) -> HashMap<String, bool> {
    sample_trees(roots)
        .into_iter()
        .map(|(id, _, tree)| (id, shell_only(&tree)))
        .collect()
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
fn shell_only(tree: &HashSet<u32>) -> bool {
    tree.len() == 1 && tree.iter().all(|&pid| is_shell(&process_name(pid)))
}

/// Whether `name` (a process name) is a login shell: one listed in
/// /etc/shells, or a common one where that file is missing.
#[cfg(any(target_os = "linux", target_os = "macos"))]
fn is_shell(name: &str) -> bool {
    static SHELLS: std::sync::OnceLock<HashSet<String>> = std::sync::OnceLock::new();
    SHELLS
        .get_or_init(|| {
            shell_names(&std::fs::read_to_string("/etc/shells").unwrap_or_default())
        })
        .contains(name)
}

/// Base names of the shells in an /etc/shells file, plus common ones.
#[cfg(any(target_os = "linux", target_os = "macos", test))]
fn shell_names(etc_shells: &str) -> HashSet<String> {
    let listed = etc_shells
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty() && !l.starts_with('#'))
        .filter_map(|l| l.rsplit('/').next());
    ["sh", "bash", "zsh", "fish", "dash", "ksh", "tcsh", "csh", "nu"]
        .into_iter()
        .chain(listed)
        .map(String::from)
        .collect()
}

/// The process name (comm), or "" when the process is gone.
#[cfg(target_os = "linux")]
fn process_name(pid: u32) -> String {
    std::fs::read_to_string(format!("/proc/{pid}/comm"))
        .map(|c| c.trim_end().to_string())
        .unwrap_or_default()
}

/// The process name (comm), or "" when the process is gone.
#[cfg(target_os = "macos")]
fn process_name(pid: u32) -> String {
    let Some(info) = macos_task_info(pid) else {
        return String::new();
    };
    let comm: Vec<u8> = info
        .pbsd
        .pbi_comm
        .iter()
        .take_while(|&&c| c != 0)
        .map(|&c| c as u8)
        .collect();
    String::from_utf8_lossy(&comm).into_owned()
}

/// Which TCP sockets listen right now, cheap to read, so a poller can skip the
/// process walk while it is unchanged. None where no cheap check exists, which
/// means the caller must always walk.
#[cfg(unix)]
pub(crate) fn listen_fingerprint() -> Option<Vec<u64>> {
    #[cfg(target_os = "linux")]
    let out = {
        let mut inodes: Vec<u64> = listen_sockets().into_keys().collect();
        inodes.sort_unstable();
        Some(inodes)
    };
    #[cfg(not(target_os = "linux"))]
    let out = None;
    out
}

/// Sends SIGTERM to `pid` if a fresh sample shows it listening on a port in
/// `root`'s process tree. On Linux a pidfd opened before the check pins the
/// process, so a pid reused after the check is never signalled. Errors carry
/// a message for the user.
#[cfg(unix)]
pub(crate) fn stop_tree_listener(root: u32, pid: u32) -> Result<(), String> {
    const GONE: &str = "That process is no longer listening in this terminal";
    let fail = |e: std::io::Error| match e.raw_os_error() {
        Some(libc::ESRCH) => GONE.to_string(),
        _ => e.to_string(),
    };
    // A pid of 0 or one that wraps negative would signal a process group.
    let raw = libc::pid_t::try_from(pid).ok().filter(|&p| p > 0).ok_or(GONE)?;
    #[cfg(target_os = "linux")]
    let pidfd = match pidfd_open(raw) {
        Ok(fd) => Some(fd),
        // No pidfds (Linux before 5.3, or a sandbox that blocks the call), so
        // fall back to kill.
        Err(e) if matches!(e.raw_os_error(), Some(libc::ENOSYS | libc::EPERM)) => None,
        Err(e) => return Err(fail(e)),
    };
    let held = process_tree_ports(&[(String::new(), root)])
        .into_values()
        .flatten()
        .any(|p| p.pid == pid);
    if !held {
        return Err(GONE.into());
    }
    #[cfg(target_os = "linux")]
    if let Some(fd) = pidfd {
        use std::os::fd::AsRawFd;
        // SAFETY: fd is a live pidfd we own; a null siginfo sends the signal as
        // kill(2) would.
        let r = unsafe {
            libc::syscall(
                libc::SYS_pidfd_send_signal,
                fd.as_raw_fd(),
                libc::SIGTERM,
                std::ptr::null::<libc::siginfo_t>(),
                0,
            )
        };
        return if r == 0 { Ok(()) } else { Err(fail(std::io::Error::last_os_error())) };
    }
    // SAFETY: raw is a positive pid, so kill targets that one process.
    if unsafe { libc::kill(raw, libc::SIGTERM) } != 0 {
        return Err(fail(std::io::Error::last_os_error()));
    }
    Ok(())
}

#[cfg(target_os = "linux")]
fn pidfd_open(pid: libc::pid_t) -> std::io::Result<std::os::fd::OwnedFd> {
    use std::os::fd::FromRawFd;
    // SAFETY: pidfd_open takes a pid and flags and returns a new fd or -1.
    let fd = unsafe { libc::syscall(libc::SYS_pidfd_open, pid, 0) };
    if fd < 0 {
        return Err(std::io::Error::last_os_error());
    }
    // SAFETY: fd is a fresh descriptor that nothing else owns.
    Ok(unsafe { std::os::fd::OwnedFd::from_raw_fd(fd as std::os::fd::RawFd) })
}

/// Hands each listener to the root whose tree holds its pid, sorted by port.
/// A socket shared by a parent and its forked children shows once per holder.
#[cfg(any(target_os = "linux", target_os = "macos", test))]
fn assign_ports(trees: &[&HashSet<u32>], ports: Vec<ListenPort>) -> Vec<Vec<ListenPort>> {
    let mut out = vec![Vec::new(); trees.len()];
    for p in ports {
        if let Some(i) = trees.iter().position(|t| t.contains(&p.pid)) {
            out[i].push(p);
        }
    }
    for v in &mut out {
        v.sort_by_key(|p| (p.port, p.pid));
        v.dedup_by_key(|p| (p.port, p.pid));
    }
    out
}

/// Listening TCP sockets by inode, from one /proc/net/tcp or tcp6 table.
/// Columns: `local_address` is hex `ADDR:PORT`, `st` 0A is LISTEN, and the
/// inode is the tenth.
#[cfg(target_os = "linux")]
fn parse_proc_net_tcp(table: &str) -> impl Iterator<Item = (u64, u16)> + '_ {
    table.lines().skip(1).filter_map(|line| {
        let f: Vec<&str> = line.split_ascii_whitespace().collect();
        if *f.get(3)? != "0A" {
            return None;
        }
        let port = u16::from_str_radix(f.get(1)?.rsplit_once(':')?.1, 16).ok()?;
        Some((f.get(9)?.parse().ok()?, port))
    })
}

/// Every LISTEN socket in the daemon's network namespace, inode -> port.
/// /proc/net/tcp is per namespace, and the terminals run in the daemon's.
#[cfg(target_os = "linux")]
fn listen_sockets() -> HashMap<u64, u16> {
    let mut sockets = HashMap::new();
    for path in ["/proc/net/tcp", "/proc/net/tcp6"] {
        if let Ok(table) = std::fs::read_to_string(path) {
            sockets.extend(parse_proc_net_tcp(&table));
        }
    }
    sockets
}

/// Listeners among `pids`: match each pid's socket fds against the kernel's
/// LISTEN table.
#[cfg(target_os = "linux")]
fn listening_ports(pids: &HashSet<u32>) -> Vec<ListenPort> {
    let sockets = listen_sockets();
    if sockets.is_empty() {
        return Vec::new();
    }
    let mut out = Vec::new();
    for &pid in pids {
        let Ok(fds) = std::fs::read_dir(format!("/proc/{pid}/fd")) else {
            continue;
        };
        let ports: Vec<u16> = fds
            .flatten()
            .filter_map(|fd| {
                let link = std::fs::read_link(fd.path()).ok()?;
                let inode = link.to_str()?.strip_prefix("socket:[")?.strip_suffix(']')?;
                sockets.get(&inode.parse::<u64>().ok()?).copied()
            })
            .collect();
        if ports.is_empty() {
            continue;
        }
        let name = process_name(pid);
        out.extend(ports.into_iter().map(|port| ListenPort { port, pid, name: name.clone() }));
    }
    out
}

/// Parses `lsof -F pcn` output: a `p<pid>` line opens each process, `c<name>`
/// names it, and each `n<addr>:<port>` is one socket. Addresses can be IPv6
/// (`[::1]:3000`) or `*:3000`, so the port is after the last colon.
#[cfg(any(target_os = "macos", test))]
fn parse_lsof(out: &str) -> Vec<ListenPort> {
    let (mut pid, mut name, mut ports) = (0u32, String::new(), Vec::new());
    for line in out.lines() {
        let (tag, value) = line.split_at(line.len().min(1));
        match tag {
            "p" => pid = value.parse().unwrap_or(0),
            "c" => name = value.to_string(),
            "n" => {
                if let Some(port) = value.rsplit_once(':').and_then(|(_, p)| p.parse().ok()) {
                    ports.push(ListenPort { port, pid, name: name.clone() });
                }
            }
            _ => {}
        }
    }
    ports
}

/// macOS has no /proc/net, and libproc's socket info needs a call per fd, so
/// one `lsof` run covers every pid instead. lsof exits 1 when nothing matches,
/// so its status is not an error.
#[cfg(target_os = "macos")]
fn listening_ports(pids: &HashSet<u32>) -> Vec<ListenPort> {
    if pids.is_empty() {
        return Vec::new();
    }
    let list: Vec<String> = pids.iter().map(u32::to_string).collect();
    std::process::Command::new("/usr/sbin/lsof")
        .args(["-nP", "-a", "-iTCP", "-sTCP:LISTEN", "-F", "pcn", "-p"])
        .arg(list.join(","))
        .output()
        .map(|o| parse_lsof(&String::from_utf8_lossy(&o.stdout)))
        .unwrap_or_default()
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

/// Each root's CPU time, resident memory and set of pids. A terminal in its
/// own cgroup (see cgroup.rs) is read from there, which also counts processes
/// that left the shell's tree; the rest are walked from /proc.
///
/// ponytail: RSS is summed naively, so pages shared between a parent and its
/// children are counted more than once; read PSS from /proc/<pid>/smaps_rollup
/// instead if the number ever has to be exact.
#[cfg(target_os = "linux")]
fn sample_trees(roots: &[(String, u32)]) -> Vec<(String, Usage, HashSet<u32>)> {
    let (mut sampled, mut loose) = (Vec::new(), Vec::new());
    for (id, pid) in roots {
        match crate::cgroup::scope_of(*pid) {
            Some(scope) => sampled.push(scope_usage(id, &scope)),
            None => loose.push((id.clone(), *pid)),
        }
    }
    sampled.extend(walk_process_trees(&loose));
    sampled
}

/// Resident pages of one process. From statm, not stat's field 24: that one
/// undercounts (its own man page calls it inaccurate), and statm's matches
/// VmRSS, which is what ps and top show. Disagreeing with those would just look
/// wrong.
#[cfg(target_os = "linux")]
fn rss_pages(proc_dir: &std::path::Path) -> u64 {
    std::fs::read_to_string(proc_dir.join("statm"))
        .ok()
        .and_then(|m| m.split_ascii_whitespace().nth(1)?.parse::<u64>().ok())
        .unwrap_or(0)
}

#[cfg(target_os = "linux")]
fn scope_usage(id: &str, scope: &std::path::Path) -> (String, Usage, HashSet<u32>) {
    let pids: HashSet<u32> = crate::cgroup::procs(scope).into_iter().collect();
    let rss: u64 = pids
        .iter()
        .map(|pid| rss_pages(std::path::Path::new(&format!("/proc/{pid}"))))
        .sum();
    let usage = Usage {
        cpu_seconds: crate::cgroup::cpu_seconds(scope),
        rss_bytes: rss * page_size(),
    };
    (id.to_string(), usage, pids)
}

/// Each root's whole process tree, from one pass over /proc for every root,
/// since the alternative walks it once per terminal.
#[cfg(target_os = "linux")]
fn walk_process_trees(roots: &[(String, u32)]) -> Vec<(String, Usage, HashSet<u32>)> {
    if roots.is_empty() {
        return Vec::new();
    }
    // pid -> (ppid, cpu ticks, rss pages)
    let mut procs: HashMap<u32, (u32, u64, u64)> = HashMap::new();
    let Ok(dir) = std::fs::read_dir("/proc") else {
        return Vec::new();
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
        procs.insert(pid, (at(1) as u32, at(11) + at(12), rss_pages(&entry.path())));
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
            let usage = Usage {
                cpu_seconds: cpu as f64 / ticks,
                rss_bytes: rss * page,
            };
            (id.clone(), usage, seen)
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
    let info = macos_task_info(pid)?;
    let cpu_ns = info.ptinfo.pti_total_user + info.ptinfo.pti_total_system;
    Some((info.pbsd.pbi_ppid, cpu_ns, info.ptinfo.pti_resident_size))
}

/// One PROC_PIDTASKALLINFO call for `pid`. None if the process is gone or task
/// info is denied (another user's process).
#[cfg(target_os = "macos")]
fn macos_task_info(pid: u32) -> Option<libc::proc_taskallinfo> {
    // SAFETY: proc_taskallinfo is plain C data, valid when all zero.
    let mut info: libc::proc_taskallinfo = unsafe { std::mem::zeroed() };
    let size = std::mem::size_of::<libc::proc_taskallinfo>() as libc::c_int;
    // SAFETY: the buffer is a live proc_taskallinfo and `size` is its length.
    let n = unsafe {
        libc::proc_pidinfo(
            pid as libc::c_int,
            libc::PROC_PIDTASKALLINFO,
            0,
            &mut info as *mut _ as *mut libc::c_void,
            size,
        )
    };
    (n == size).then_some(info)
}

/// macOS equivalent of the Linux /proc walk: one libproc pass builds the pid ->
/// (ppid, cpu, rss) map, then each root's whole tree is summed. CPU comes back in
/// nanoseconds and RSS in bytes, so no clock-tick / page-size scaling is needed.
#[cfg(target_os = "macos")]
fn sample_trees(roots: &[(String, u32)]) -> Vec<(String, Usage, HashSet<u32>)> {
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
            let usage = Usage {
                cpu_seconds: cpu_ns as f64 / 1_000_000_000.0,
                rss_bytes: rss,
            };
            (id.clone(), usage, seen)
        })
        .collect()
}

/// No process enumeration on other platforms (Windows), so the dialog shows the
/// terminals with no numbers until one is added.
#[cfg(not(any(target_os = "linux", target_os = "macos")))]
fn sample_trees(_roots: &[(String, u32)]) -> Vec<(String, Usage, ())> {
    Vec::new()
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

    /// A listener this test process opens must show up on its own tree, with
    /// our pid, and nowhere else.
    #[cfg(target_os = "linux")]
    #[test]
    fn finds_a_listening_port_in_the_tree() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let me = std::process::id();
        let out = super::process_tree_ports(&[
            ("self".to_string(), me),
            ("gone".to_string(), u32::MAX),
        ]);
        assert!(
            out["self"].iter().any(|p| p.port == port && p.pid == me),
            "port {port} missing from {:?}",
            out["self"],
        );
        assert!(out["gone"].is_empty());
    }

    /// Stops a child that listens, and refuses one that does not.
    #[cfg(target_os = "linux")]
    #[test]
    fn stops_only_a_listener_in_the_tree() {
        use std::io::BufRead;
        let script = "import socket,time\n\
            s=socket.socket(); s.bind(('127.0.0.1',0)); s.listen()\n\
            print(s.getsockname()[1], flush=True); time.sleep(30)";
        let mut child = std::process::Command::new("python3")
            .args(["-c", script])
            .stdout(std::process::Stdio::piped())
            .spawn()
            .unwrap();
        let mut line = String::new();
        std::io::BufReader::new(child.stdout.take().unwrap())
            .read_line(&mut line)
            .unwrap();
        let pid = child.id();

        let me = std::process::id();
        assert_eq!(
            super::stop_tree_listener(pid, me),
            Err("That process is no longer listening in this terminal".to_string()),
        );
        assert_eq!(super::stop_tree_listener(pid, pid), Ok(()));
        use std::os::unix::process::ExitStatusExt;
        assert_eq!(child.wait().unwrap().signal(), Some(libc::SIGTERM));
    }

    /// The point of a terminal cgroup: a process that double-forked out of the
    /// shell's tree is gone from the /proc walk but still in the scope. Runs
    /// only where a systemd user manager answers.
    #[cfg(target_os = "linux")]
    #[test]
    fn a_scope_counts_a_process_that_left_the_tree() {
        let Some(bin) =
            crate::cgroup::systemd_run().filter(|_| !crate::cgroup::tests::in_container())
        else {
            eprintln!("no systemd user manager in view; skipping");
            return;
        };
        let mut shell = std::process::Command::new(bin)
            .args(crate::cgroup::SCOPE_ARGS)
            .args(["sh", "-c", "(sleep 30 &); exec sleep 30"])
            .spawn()
            .unwrap();
        let root = shell.id();
        let scope = (0..100)
            .find_map(|_| {
                std::thread::sleep(std::time::Duration::from_millis(20));
                let scope = crate::cgroup::tests::new_scope_of(root)?;
                (crate::cgroup::procs(&scope).len() == 2).then_some(scope)
            })
            .expect("the shell and its escaped child share a scope");
        let walked = super::walk_process_trees(&[("t".to_string(), root)]);
        let (_, _, scoped) = super::scope_usage("t", &scope);
        for pid in &scoped {
            unsafe { libc::kill(*pid as libc::pid_t, libc::SIGKILL) };
        }
        let _ = shell.wait();

        assert_eq!(walked[0].2.len(), 1, "the walk sees only the shell");
        assert_eq!(scoped.len(), 2, "the scope also holds the escaped child");
    }

    #[test]
    fn knows_shells_from_etc_shells_and_by_default() {
        let names = super::shell_names("# comment\n/bin/bash\n/usr/bin/xonsh\n\n");
        assert!(names.contains("bash") && names.contains("xonsh"));
        assert!(names.contains("zsh"), "common shells even if unlisted");
        assert!(!names.contains("claude") && !names.contains("node"));
    }

    /// Walked directly rather than through process_tree_shell_only, which reads
    /// the terminal scope the tests may themselves run in.
    #[cfg(target_os = "linux")]
    #[test]
    fn a_lone_shell_is_shell_only_and_one_with_a_job_is_not() {
        use std::os::unix::process::CommandExt;
        use std::process::{Command, Stdio};
        let sample = |pid: u32| {
            let walked = super::walk_process_trees(&[("t".to_string(), pid)]);
            super::shell_only(&walked[0].2)
        };
        // Waits on its stdin, running nothing.
        let mut lone = Command::new("sh").stdin(Stdio::piped()).spawn().unwrap();
        // A background job keeps the shell alive beside it.
        let mut job = Command::new("sh")
            .args(["-c", "sleep 30 & wait"])
            .process_group(0)
            .spawn()
            .unwrap();
        std::thread::sleep(std::time::Duration::from_millis(200));
        let (lone_only, job_only) = (sample(lone.id()), sample(job.id()));
        let _ = lone.kill();
        // SAFETY: a negative pid signals the job's own process group, which
        // process_group(0) made; it holds only the test's sh and sleep.
        unsafe { libc::kill(-(job.id() as libc::pid_t), libc::SIGKILL) };
        let _ = lone.wait();
        let _ = job.wait();
        assert!(lone_only, "a shell alone");
        assert!(!job_only, "a shell with a job");
    }

    /// The same check read from a terminal scope, where the shell is in its
    /// own cgroup. Runs only where a systemd user manager answers.
    #[cfg(target_os = "linux")]
    #[test]
    fn a_scoped_lone_shell_is_shell_only_and_one_with_a_job_is_not() {
        use std::process::{Command, Stdio};
        let Some(bin) =
            crate::cgroup::systemd_run().filter(|_| !crate::cgroup::tests::in_container())
        else {
            eprintln!("no systemd user manager in view; skipping");
            return;
        };
        let spawn = |args: &[&str]| {
            Command::new(bin)
                .args(crate::cgroup::SCOPE_ARGS)
                .args(args)
                .stdin(Stdio::piped())
                .spawn()
                .unwrap()
        };
        let scoped = |pid: u32, procs: usize| {
            let scope = (0..100)
                .find_map(|_| {
                    std::thread::sleep(std::time::Duration::from_millis(20));
                    let scope = crate::cgroup::tests::new_scope_of(pid)?;
                    (crate::cgroup::procs(&scope).len() == procs).then_some(scope)
                })
                .expect("the shell lands in a thel scope");
            super::scope_usage("t", &scope).2
        };
        let mut lone = spawn(&["sh"]);
        let mut job = spawn(&["sh", "-c", "sleep 30 & wait"]);
        let (lone_tree, job_tree) = (scoped(lone.id(), 1), scoped(job.id(), 2));
        let (lone_only, job_only) = (super::shell_only(&lone_tree), super::shell_only(&job_tree));
        for pid in lone_tree.iter().chain(&job_tree) {
            // SAFETY: each pid is a live process of this test's own scopes.
            unsafe { libc::kill(*pid as libc::pid_t, libc::SIGKILL) };
        }
        let _ = lone.wait();
        let _ = job.wait();
        assert!(lone_only, "a shell alone in its scope");
        assert!(!job_only, "a shell with a job in its scope");
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn parses_only_listening_rows_of_proc_net_tcp() {
        // Trimmed rows: a LISTEN on 127.0.0.1:3000 (0BB8) and an ESTABLISHED
        // (01) connection, which must be skipped.
        let table = "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: 0100007F:0BB8 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 424242 1 0000000000000000 100 0 0 10 0
   1: 0100007F:A1B2 0100007F:0BB8 01 00000000:00000000 00:00000000 00000000  1000        0 434343 1 0000000000000000 20 4 30 10 -1
";
        let got: Vec<_> = super::parse_proc_net_tcp(table).collect();
        assert_eq!(got, vec![(424242, 3000)]);
    }

    #[test]
    fn parses_lsof_field_output() {
        let out = "p501\ncnode\nf23\nn*:5173\nf24\nn[::1]:9229\np777\ncpython3\nf3\nn127.0.0.1:8000\n";
        let got = super::parse_lsof(out);
        let port = |port, pid, name: &str| super::ListenPort { port, pid, name: name.into() };
        assert_eq!(
            got,
            vec![port(5173, 501, "node"), port(9229, 501, "node"), port(8000, 777, "python3")]
        );
    }

    #[test]
    fn assigns_ports_to_the_tree_that_holds_the_pid() {
        let port = |port, pid| super::ListenPort { port, pid, name: String::new() };
        let (a, b) = (
            std::collections::HashSet::from([1, 2]),
            std::collections::HashSet::from([3]),
        );
        let got = super::assign_ports(
            &[&a, &b],
            // Unsorted, a duplicate from tcp and tcp6, and a pid in no tree.
            vec![port(8080, 2), port(3000, 1), port(3000, 1), port(5000, 3), port(9, 99)],
        );
        assert_eq!(got, vec![vec![port(3000, 1), port(8080, 2)], vec![port(5000, 3)]]);
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
