//! thel session daemon (Linux and macOS). One binary, two modes: the default
//! invocation boots the Tauri GUI; re-invoking with the hidden `__daemon`
//! argument runs this event loop and never touches the webview. The daemon owns
//! the PTYs so terminals outlive the GUI, and runs an authoritative terminal
//! emulator (`vt100`) per tab so reattach restores the *current screen state*
//! (alt-screen correct), not a byte replay.
//!
//! Tabs are keyed by the GUI's terminal id, so `open` means "attach if I already
//! have this tab, else spawn it", which is what lets a restarted GUI reattach to
//! a still-running shell using the id it already persists. Concurrency is plain
//! threads; the wire is typed, length-prefixed frames (JSON control + binary
//! output/input).

use std::collections::{HashMap, VecDeque};
use std::io::{self, Read, Write};
use std::net::Shutdown;
use std::os::unix::fs::{MetadataExt, PermissionsExt};
use std::os::unix::io::{AsRawFd, RawFd};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::mpsc::{sync_channel, RecvTimeoutError, SyncSender, TrySendError};
use std::sync::{Arc, LazyLock, OnceLock, Weak};
use std::time::{Duration, Instant};

use parking_lot::Mutex;
use portable_pty::{Child, MasterPty, PtySize};
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;

use crate::pty::{decode_utf8_stream, CreateOpts, TermMsg};
use crate::session::{Adopt, Approval, DirSession, Directory, NoteChange, Place, Reply, Request};

const PROTOCOL_VERSION: u32 = 5;
const EMPTY_GRACE: Duration = Duration::from_secs(45);
// How often the daemon samples each tab's foreground state to push busy
// transitions. Foreground-pgroup changes have no kernel event, so this is a
// poll, but it lives here (in-process, no IPC) and the GUI only ever sees the
// resulting events.
const BUSY_POLL: Duration = Duration::from_millis(600);
// How often the daemon looks for listening ports to push. listen(2) has no
// event either. Linux has a cheap unchanged check, so it can look often;
// macOS runs lsof for every look.
const PORTS_POLL: Duration = if cfg!(target_os = "linux") {
    Duration::from_secs(2)
} else {
    Duration::from_secs(5)
};
// Looks in a row that may skip the process walk. The cheap check misses a
// socket handed to a forked child, so a full walk still runs this often.
const PORTS_RESCAN: u32 = 15;
// How often the daemon checks whether each tab runs nothing but its shell, and
// how long that must last before the tab is idle. Long enough that the gap
// between two commands never counts.
const IDLE_POLL: Duration = Duration::from_secs(10);
const IDLE_AFTER: Duration = Duration::from_secs(5 * 60);
const DAEMON_ARG: &str = "__daemon";
// How long a sandboxed caller's request waits for the user's answer. Long
// enough to notice the prompt and read it; the caller is blocked meanwhile.
const APPROVAL_TIMEOUT: Duration = Duration::from_secs(120);
// How long a terminal's sandboxed programs can't ask again after the user
// says no, doubled on each no up to DENY_PAUSE_MAX, so a program can't wear
// the user down with the same question.
const DENY_PAUSE: Duration = Duration::from_secs(30);
const DENY_PAUSE_MAX: Duration = Duration::from_secs(30 * 60);
/// Takes the user's answer to a question: whether allowed, and whether for
/// good.
type AnswerTx = SyncSender<(bool, bool)>;
// How often a waiting approval checks whether its caller hung up.
const HANGUP_POLL: Duration = Duration::from_millis(250);
// The longest request the approval prompt shows, in bytes of its summary. A
// longer one is refused rather than cut, so the user sees all of what they
// allow.
const APPROVAL_SUMMARY_MAX: usize = 4096;
/// Scrollback the VTE keeps (lines), used for the alt-screen snapshot path.
const SCROLLBACK: usize = 1000;
/// Raw normal-screen output kept per tab (bytes) and replayed on reattach so the
/// client gets real scrollback. ponytail: fixed cap; make configurable later.
const MAX_SCROLLBACK_BYTES: usize = 512 * 1024;

// Frame types: [u8 type][u32 LE len][payload].
const CONTROL: u8 = 0; // JSON: Hello/HelloReply, Command (c→d), Event (d→c)
const OUTPUT: u8 = 1; // d→c: [u16 LE id_len][id][raw bytes]
const INPUT: u8 = 2; // c→d: [u16 LE id_len][id][raw bytes]

fn build_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

pub fn is_daemon_arg() -> bool {
    std::env::args().any(|a| a == DAEMON_ARG)
}

fn app_dir_name() -> &'static str {
    if cfg!(debug_assertions) {
        "thel-dev"
    } else {
        "thel"
    }
}

fn runtime_dir() -> PathBuf {
    std::env::var_os("XDG_RUNTIME_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(std::env::temp_dir)
        .join(app_dir_name())
}

fn socket_path() -> PathBuf {
    runtime_dir().join("daemon.sock")
}

// The daemon's pid, written at startup so a newer GUI can kill an incompatible
// daemon by pid (protocol-independent, unlike a command it might not understand).
fn pid_path() -> PathBuf {
    runtime_dir().join("daemon.pid")
}

// ---- security (spec §8) ---------------------------------------------------

/// The runtime dir must be owned by us and mode 0700, else refuse to run rather
/// than blindly chmod-fixing a dir an attacker may have pre-created.
fn dir_is_safe(dir: &Path) -> bool {
    // symlink_metadata (lstat) so a symlink planted at the path is rejected on
    // its own perms rather than followed to a dir we'd wrongly trust. Matters
    // for the /tmp fallback when XDG_RUNTIME_DIR is unset.
    match std::fs::symlink_metadata(dir) {
        Ok(m) => m.uid() == unsafe { libc::geteuid() } && (m.mode() & 0o777) == 0o700,
        Err(_) => false,
    }
}

/// Reject any peer whose uid isn't ours (SO_PEERCRED). On platforms without a
/// peer-cred syscall the 0700 dir + 0600 socket are the only guard.
#[cfg(target_os = "linux")]
fn peer_uid_ok(fd: RawFd) -> bool {
    // SAFETY: geteuid has no preconditions.
    peer_cred(fd).is_some_and(|c| c.uid == unsafe { libc::geteuid() })
}

/// The peer's credentials as of its connect (SO_PEERCRED).
#[cfg(target_os = "linux")]
fn peer_cred(fd: RawFd) -> Option<libc::ucred> {
    // SAFETY: ucred is plain data, so zeroed is a valid value, and cred and
    // len are valid for writes of the size passed.
    unsafe {
        let mut cred: libc::ucred = std::mem::zeroed();
        let mut len = std::mem::size_of::<libc::ucred>() as libc::socklen_t;
        let ret = libc::getsockopt(
            fd,
            libc::SOL_SOCKET,
            libc::SO_PEERCRED,
            &mut cred as *mut _ as *mut libc::c_void,
            &mut len,
        );
        (ret == 0).then_some(cred)
    }
}

/// macOS peer check via LOCAL_PEERCRED (getsockopt on SOL_LOCAL) -- the BSD
/// analogue of SO_PEERCRED. The connecting socket must belong to our own uid.
#[cfg(target_os = "macos")]
fn peer_uid_ok(fd: RawFd) -> bool {
    unsafe {
        let mut cred: libc::xucred = std::mem::zeroed();
        let mut len = std::mem::size_of::<libc::xucred>() as libc::socklen_t;
        let ret = libc::getsockopt(
            fd,
            libc::SOL_LOCAL,
            libc::LOCAL_PEERCRED,
            &mut cred as *mut _ as *mut libc::c_void,
            &mut len,
        );
        ret == 0 && cred.cr_version == libc::XUCRED_VERSION && cred.cr_uid == libc::geteuid()
    }
}

#[cfg(not(any(target_os = "linux", target_os = "macos")))]
fn peer_uid_ok(_fd: RawFd) -> bool {
    true
}

/// Who is on the other end of a connection.
#[derive(Clone)]
struct Peer {
    pid: Option<u32>,
    /// The peer runs confined while the daemon does not: inside Landlock,
    /// seccomp, bubblewrap or Flatpak. It may still post notifications for and
    /// read state of its own terminal, but without the user's yes it must not
    /// get the daemon to start, type into or stop anything, which would run
    /// outside its sandbox.
    sandboxed: bool,
    /// For a sandboxed peer, the tab it runs in, found when it connected,
    /// while it was known to be alive. Its pid could later pass to a process
    /// in another tab. Held as that tab's state too, since a tab that ends
    /// can come back under its id (see own_tab).
    tab: Option<(String, Weak<Mutex<TabShared>>)>,
    /// For a sandboxed peer, the program it belongs to (see sandbox_program),
    /// found alongside its tab.
    program: Option<(u32, u64)>,
    /// The connection, to notice the peer hanging up.
    #[cfg_attr(not(target_os = "linux"), allow(dead_code))]
    fd: RawFd,
}

impl Peer {
    fn of(fd: RawFd, daemon: &Daemon) -> Peer {
        let pid = peer_pid(fd);
        let sandboxed = peer_confined(fd, pid) && !daemon_confined();
        // A sandboxed program that can write to cgroupfs could move itself into
        // another tab's scope, so it is known by its ancestry only. Checked
        // alive after the walk, so a pid that passed to another process
        // meanwhile can't name that process's tab.
        let (tab, program) = match pid {
            Some(p) if sandboxed => {
                let chain = steady_ancestry(p).unwrap_or_default();
                let roots = daemon.roots();
                let tab = chain.iter().find_map(|(p, _)| roots.get(p).cloned()).and_then(|id| {
                    let shared = Arc::downgrade(&daemon.tabs.lock().get(&id)?.shared);
                    Some((id, shared))
                });
                let found = (tab, sandbox_program(&chain));
                if peer_alive(fd) { found } else { (None, None) }
            }
            _ => (None, None),
        };
        Peer { pid, sandboxed, tab, program, fd }
    }

    /// The id of the tab a sandboxed peer connected from, while that tab
    /// runs. A tab that ended and came back under the same id is another
    /// tab, so a program that outlived the first can't act for the second.
    fn own_tab(&self, daemon: &Daemon) -> Option<String> {
        let (id, shared) = self.tab.as_ref()?;
        let same = daemon.tabs.lock().get(id).is_some_and(|t| std::ptr::eq(shared.as_ptr(), Arc::as_ptr(&t.shared)));
        same.then(|| id.clone())
    }

    /// Whether the peer closed its end of the connection, even with bytes it
    /// sent still unread.
    #[cfg(target_os = "linux")]
    fn hung_up(&self) -> bool {
        let mut p = libc::pollfd { fd: self.fd, events: libc::POLLRDHUP, revents: 0 };
        // SAFETY: p is one valid pollfd, and a zero timeout keeps this from
        // blocking.
        let n = unsafe { libc::poll(&mut p, 1, 0) };
        n > 0 && p.revents & (libc::POLLRDHUP | libc::POLLHUP) != 0
    }

    /// Only a sandboxed peer waits for an answer, and nothing reads as
    /// sandboxed outside Linux.
    #[cfg(not(target_os = "linux"))]
    fn hung_up(&self) -> bool {
        false
    }
}

/// Whether the daemon itself runs with no_new_privs. Read once: nothing in
/// the daemon sets the flag, and nothing can clear it.
fn daemon_confined() -> bool {
    static C: OnceLock<bool> = OnceLock::new();
    *C.get_or_init(|| no_new_privs(std::process::id()) == Some(true))
}

/// Whether the peer on `fd` runs with no_new_privs. On Linux a peer that
/// can't be checked counts as confined: one that exited right after
/// connecting has no status left to read, and must not pass for unconfined.
/// Elsewhere there is no flag to check.
fn peer_confined(fd: RawFd, pid: Option<u32>) -> bool {
    let Some(pid) = pid else { return cfg!(target_os = "linux") };
    // The status read was the peer's only if the peer outlived it: once
    // reaped, its pid can go to another process.
    no_new_privs(pid) != Some(false) || !peer_alive(fd)
}

/// Whether the process that connected on `fd` still runs. The kernel keeps
/// the peer from connect time, so this can't mistake a process that got its
/// pid later for it. Kernels before 6.5 have no peer pidfd, and there a
/// reused pid goes unnoticed.
#[cfg(target_os = "linux")]
fn peer_alive(fd: RawFd) -> bool {
    match peer_pidfd(fd) {
        Ok(pidfd) => pidfd_alive(&pidfd),
        Err(errno) => errno == libc::ENOPROTOOPT,
    }
}

#[cfg(not(target_os = "linux"))]
fn peer_alive(_fd: RawFd) -> bool {
    true
}

/// A pidfd for the process that connected on `fd`, or the errno.
#[cfg(target_os = "linux")]
fn peer_pidfd(fd: RawFd) -> Result<std::os::fd::OwnedFd, i32> {
    use std::os::fd::FromRawFd;
    let mut pidfd: libc::c_int = -1;
    let mut len = std::mem::size_of::<libc::c_int>() as libc::socklen_t;
    // SAFETY: pidfd and len are valid for writes of the size passed.
    let ret = unsafe {
        libc::getsockopt(
            fd,
            libc::SOL_SOCKET,
            libc::SO_PEERPIDFD,
            &mut pidfd as *mut _ as *mut libc::c_void,
            &mut len,
        )
    };
    if ret != 0 {
        return Err(std::io::Error::last_os_error().raw_os_error().unwrap_or(0));
    }
    // SAFETY: the kernel just opened this fd for us and nothing else owns it.
    Ok(unsafe { std::os::fd::OwnedFd::from_raw_fd(pidfd) })
}

#[cfg(target_os = "linux")]
fn pidfd_alive(pidfd: &std::os::fd::OwnedFd) -> bool {
    use std::os::fd::AsRawFd;
    // SAFETY: signal 0 only checks that the process exists; a null siginfo is
    // allowed.
    unsafe {
        libc::syscall(
            libc::SYS_pidfd_send_signal,
            pidfd.as_raw_fd(),
            0,
            std::ptr::null::<libc::siginfo_t>(),
            0,
        ) == 0
    }
}

#[cfg(target_os = "linux")]
fn peer_pid(fd: RawFd) -> Option<u32> {
    peer_cred(fd).filter(|c| c.pid > 0).map(|c| c.pid as u32)
}

#[cfg(target_os = "macos")]
fn peer_pid(fd: RawFd) -> Option<u32> {
    // SAFETY: pid and len are valid for writes of the size passed.
    unsafe {
        let mut pid: libc::pid_t = 0;
        let mut len = std::mem::size_of::<libc::pid_t>() as libc::socklen_t;
        let ret = libc::getsockopt(
            fd,
            libc::SOL_LOCAL,
            libc::LOCAL_PEERPID,
            &mut pid as *mut _ as *mut libc::c_void,
            &mut len,
        );
        (ret == 0 && pid > 0).then_some(pid as u32)
    }
}

#[cfg(not(any(target_os = "linux", target_os = "macos")))]
fn peer_pid(_fd: RawFd) -> Option<u32> {
    None
}

/// Whether `pid` runs with no_new_privs, which Landlock and seccomp require
/// and bubblewrap and Flatpak set. Confinement that doesn't set it (AppArmor,
/// a container without no-new-privileges) goes unseen. macOS has no such flag,
/// so nothing reads as confined there.
#[cfg(target_os = "linux")]
fn no_new_privs(pid: u32) -> Option<bool> {
    std::fs::read_to_string(format!("/proc/{pid}/status"))
        .ok()
        .map(|s| status_no_new_privs(&s))
}

#[cfg(not(target_os = "linux"))]
fn no_new_privs(_pid: u32) -> Option<bool> {
    Some(false)
}

/// `pid` and its ancestors with their start times, nearest first, as
/// `ancestors` walks them. None unless the walk still holds once done: each
/// process kept its start time and its parent. A process that exits mid-walk
/// can pass its pid to an unrelated one, which would splice that one's
/// ancestors into the chain.
#[cfg(target_os = "linux")]
fn steady_ancestry(pid: u32) -> Option<Vec<(u32, u64)>> {
    // Each process with its start time and parent, from one read of its stat.
    let seen = std::cell::RefCell::new(Vec::new());
    let n = crate::session::ancestors(pid, |p| {
        let (parent, start) = proc_stat(p)?;
        seen.borrow_mut().push((p, start, parent));
        Some(parent)
    })
    .count();
    let chain = seen.into_inner();
    let holds = chain.len() == n && chain.iter().all(|&(p, start, parent)| proc_stat(p) == Some((parent, start)));
    holds.then(|| chain.into_iter().map(|(p, start, _)| (p, start)).collect())
}

/// Only Linux has sandboxed peers.
#[cfg(not(target_os = "linux"))]
fn steady_ancestry(_pid: u32) -> Option<Vec<(u32, u64)>> {
    None
}

/// The sandboxed program at the start of `chain` (see steady_ancestry) is
/// part of: its topmost ancestor that runs with no_new_privs, as its pid and
/// start time, so a reused pid is another program.
fn sandbox_program(chain: &[(u32, u64)]) -> Option<(u32, u64)> {
    let mut it = chain.iter().copied();
    let first = it.next()?;
    Some(it.take_while(|&(p, _)| no_new_privs(p) == Some(true)).last().unwrap_or(first))
}

/// `pid`'s parent, and when it started in clock ticks since boot.
#[cfg(target_os = "linux")]
fn proc_stat(pid: u32) -> Option<(u32, u64)> {
    let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
    let fields = crate::pty::stat_fields(&stat)?;
    // Fields 4 and 22 of /proc/<pid>/stat, counted from the state field after comm.
    Some((fields.get(1)?.parse().ok()?, fields.get(19)?.parse().ok()?))
}

/// When `pid` started, in clock ticks since boot.
#[cfg(target_os = "linux")]
fn start_time(pid: u32) -> Option<u64> {
    proc_stat(pid).map(|(_, start)| start)
}

/// The executable of the program that started at `start` as `pid`, while it
/// runs. Read before the start time is checked, so a pid that passed to
/// another process meanwhile names nothing.
#[cfg(target_os = "linux")]
fn exe_of(pid: u32, start: u64) -> Option<String> {
    let exe = proc_exe(pid as i32)?;
    (start_time(pid) == Some(start)).then(|| exe.to_string_lossy().into_owned())
}

#[cfg(not(target_os = "linux"))]
fn exe_of(_pid: u32, _start: u64) -> Option<String> {
    None
}

#[cfg(any(target_os = "linux", test))]
fn status_no_new_privs(status: &str) -> bool {
    status
        .lines()
        .find_map(|l| l.strip_prefix("NoNewPrivs:"))
        .is_some_and(|v| v.trim() == "1")
}

// ---- wire protocol --------------------------------------------------------

#[derive(Serialize, Deserialize)]
struct Hello {
    protocol: u32,
    build: String,
}

#[derive(Serialize, Deserialize)]
struct HelloReply {
    protocol: u32,
    build: String,
    ok: bool,
    error: Option<String>,
}

#[derive(Serialize, Deserialize)]
#[serde(tag = "cmd", rename_all = "snake_case")]
enum Command {
    Open {
        id: String,
        command: String,
        #[serde(default)]
        args: Vec<String>,
        cwd: Option<String>,
        env: Option<HashMap<String, String>>,
        cols: u16,
        rows: u16,
    },
    Resize {
        id: String,
        cols: u16,
        rows: u16,
    },
    Detach {
        id: String,
    },
    Kill {
        id: String,
    },
    /// Post a notification for a tab, addressed by id. Lets `thel notify` deliver
    /// out-of-band (a program's hook may have no controlling tty to write the OSC
    /// to); the daemon forwards it to the tab's GUI as a TabNotify event.
    Notify {
        id: String,
        message: String,
    },
    /// Busy state of every tab the daemon owns (foreground pgrp != shell). The
    /// reply is a StatusReply; used for the GUI's working-dot poll.
    Status,
    /// CPU time and memory of every tab the daemon owns. The reply is a
    /// UsageReply; asked for on demand by the GUI's session usage dialog, so
    /// nothing samples this in the background.
    Usage,
    /// Where one tab's shell currently is, for opening a new terminal there.
    /// The reply is a CwdReply.
    Cwd {
        id: String,
    },
    /// SIGTERM to `pid` if it listens on a port in the tab's process tree, as
    /// a fresh sample shows. The reply is a StopReply.
    StopListener {
        id: String,
        pid: u32,
    },
    /// A `thel session` request from a program in one of the tabs. The reply
    /// is a session::Reply.
    Session {
        req: Request,
    },
    /// A GUI asks for the terminals started for `thel session`: each one comes
    /// as an Adopt event, now for those waiting and later for new ones. It
    /// also says where session notes live, for `thel session note`.
    Watch {
        notes_dir: PathBuf,
    },
    /// A GUI window's sessions, for `thel session` to find and list them.
    Directory {
        window: String,
        sessions: Vec<DirSession>,
    },
    /// The user's answer to an Approval. `remember` allows every later
    /// request from the same sandboxed program, until its terminal ends.
    Answer {
        req: u64,
        allow: bool,
        remember: bool,
    },
}

#[derive(Serialize, Deserialize)]
#[serde(tag = "event", rename_all = "snake_case")]
enum Event {
    TabExited { id: String, code: Option<i32> },
    // A tab's foreground state changed (or a heartbeat while busy). The GUI uses
    // this to drive the working animation and the "command finished" heuristic.
    TabBusy { id: String, busy: bool },
    // An out-of-band notification for a tab (from `thel notify`), delivered to the
    // GUI regardless of the caller's tty.
    TabNotify { id: String, message: String },
    // The TCP listeners in a tab's process tree changed. Also sent on attach
    // when the tab has any.
    TabPorts { id: String, ports: Vec<crate::pty::ListenPort> },
    // The tab became idle (nothing but its shell for IDLE_AFTER) or stopped
    // being idle. Also sent on attach when the tab is idle.
    TabIdle { id: String, idle: bool },
    Error { id: String, message: String },
    // A terminal started for `thel session`, for a GUI window to show.
    Adopt { adopt: Adopt },
    // An adopted terminal no longer waits for a window: one opened it, or it
    // was closed. Windows that held it back for a session on its way drop it.
    Claimed { terminal: String },
    // A sandboxed caller's request for the user to allow or deny.
    Approve { approval: Approval },
    // An Approval was answered or timed out; windows still showing it close it.
    Resolved { req: u64 },
    // `thel session note` changed a session's notes to `text` by `edit`.
    Note(NoteChange),
}

/// Reply to Command::Status: tab id -> a foreground command is running.
#[derive(Serialize, Deserialize)]
struct StatusReply {
    busy: HashMap<String, bool>,
}

/// Reply to Command::Usage: tab id -> its process tree's CPU time and memory.
#[derive(Serialize, Deserialize)]
struct UsageReply {
    usage: HashMap<String, crate::pty::Usage>,
}

/// Reply to Command::Cwd: the tab's working directory, absent if it has gone.
#[derive(Serialize, Deserialize)]
struct CwdReply {
    cwd: Option<String>,
}

/// Reply to Command::StopListener: why the process was not signalled, if not.
#[derive(Serialize, Deserialize)]
struct StopReply {
    error: Option<String>,
}

fn frame_bytes(ty: u8, payload: &[u8]) -> Vec<u8> {
    let mut f = Vec::with_capacity(5 + payload.len());
    f.push(ty);
    f.extend_from_slice(&(payload.len() as u32).to_le_bytes());
    f.extend_from_slice(payload);
    f
}

fn write_frame<W: Write>(w: &mut W, ty: u8, payload: &[u8]) -> io::Result<()> {
    w.write_all(&frame_bytes(ty, payload))?;
    w.flush()
}

fn read_frame<R: Read>(r: &mut R) -> io::Result<(u8, Vec<u8>)> {
    let mut head = [0u8; 5];
    r.read_exact(&mut head)?;
    let len = u32::from_le_bytes([head[1], head[2], head[3], head[4]]) as usize;
    // Cap the maximum frame size to 16 MB to prevent uncapped allocations / DoS
    if len > 16 * 1024 * 1024 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "frame size exceeds maximum limit of 16 MB",
        ));
    }
    let mut payload = vec![0u8; len];
    r.read_exact(&mut payload)?;
    Ok((head[0], payload))
}

fn control_json<T: Serialize>(msg: &T) -> Vec<u8> {
    frame_bytes(CONTROL, &serde_json::to_vec(msg).unwrap_or_default())
}

fn parse_json<T: DeserializeOwned>(payload: &[u8]) -> Option<T> {
    serde_json::from_slice(payload).ok()
}

/// `[u16 id_len][id][data]`: the OUTPUT/INPUT payload layout.
fn id_payload(id: &str, data: &[u8]) -> Vec<u8> {
    let mut p = Vec::with_capacity(2 + id.len() + data.len());
    p.extend_from_slice(&(id.len() as u16).to_le_bytes());
    p.extend_from_slice(id.as_bytes());
    p.extend_from_slice(data);
    p
}

fn parse_id_payload(p: &[u8]) -> Option<(String, &[u8])> {
    if p.len() < 2 {
        return None;
    }
    let n = u16::from_le_bytes([p[0], p[1]]) as usize;
    if p.len() < 2 + n {
        return None;
    }
    Some((String::from_utf8_lossy(&p[2..2 + n]).into_owned(), &p[2 + n..]))
}

// Bounded outbound queue per client, in frames. A steady PTY chunk is <= 8 KiB,
// so this bounds a wedged client to a few MB before we give up on it; the
// reattach snapshot is one larger frame that still fits.
const CLIENT_QUEUE_CAP: usize = 512;

/// A connected GUI client. Output is pushed to a bounded queue drained by a
/// dedicated writer thread, so a slow client can't stall the PTY reader
/// (head-of-line blocking): the reader enqueues and moves on. If the client
/// falls far enough behind that the queue fills, we drop the connection so it
/// reconnects and gets a fresh snapshot, rather than a corrupted, gap-filled
/// stream (dropping frames mid-stream would desync its terminal).
struct Client {
    tx: SyncSender<Arc<Vec<u8>>>,
    // A handle on the connection, to force-close it on overflow so the client's
    // read loop ends and it reconnects.
    conn: UnixStream,
    dropped: AtomicBool,
}

impl Client {
    /// Set up the outbound queue and spawn the writer thread that drains it to
    /// the socket. The writer owns the only write handle; the caller keeps its
    /// own handle for reading. None if the socket can't be cloned.
    fn spawn(conn: &UnixStream) -> Option<Arc<Client>> {
        let mut wconn = conn.try_clone().ok()?;
        let sconn = conn.try_clone().ok()?;
        let (tx, rx) = sync_channel::<Arc<Vec<u8>>>(CLIENT_QUEUE_CAP);
        std::thread::spawn(move || {
            for frame in rx {
                if wconn.write_all(&frame[..]).is_err() || wconn.flush().is_err() {
                    break; // client gone; its read loop cleans up subscriptions
                }
            }
        });
        Some(Arc::new(Client {
            tx,
            conn: sconn,
            dropped: AtomicBool::new(false),
        }))
    }

    /// Queue a frame for delivery. Never blocks the caller (the PTY reader): a
    /// full queue means the client has fallen too far behind, so drop it.
    fn enqueue(&self, frame: Arc<Vec<u8>>) {
        if self.dropped.load(Ordering::Relaxed) {
            return;
        }
        match self.tx.try_send(frame) {
            Ok(()) => {}
            Err(TrySendError::Full(_)) => self.drop_conn(),
            // Writer thread already exited (write error); cleanup is underway.
            Err(TrySendError::Disconnected(_)) => {}
        }
    }

    fn drop_conn(&self) {
        if self.dropped.swap(true, Ordering::Relaxed) {
            return;
        }
        eprintln!("[thel-daemon] dropping a client that fell behind");
        let _ = self.conn.shutdown(Shutdown::Both);
    }
}

// ---- daemon state ---------------------------------------------------------

#[derive(Clone)]
struct Subscriber {
    client: Arc<Client>,
    count: usize,
}

struct TabShared {
    parser: vt100::Parser,
    // Raw output captured while on the normal screen, replayed on reattach so the
    // client has scrollback. Alt-screen output is excluded (it has no scrollback
    // and the VTE snapshot covers it).
    scrollback: VecDeque<u8>,
    subscribers: Vec<Subscriber>,
    // Listeners as last pushed by ports_monitor, for a client that attaches.
    ports: Vec<crate::pty::ListenPort>,
    // Idle state as last pushed by idle_monitor, for a client that attaches.
    idle: bool,
    // Set with the exit code once the tab has ended, so a client that attaches
    // after that gets the exit rather than waiting for one.
    ended: Option<Option<i32>>,
}

/// What to send a (re)attaching client: the raw scrollback, which is the normal
/// screen, plus the authoritative VTE snapshot when the tab is on the alternate
/// screen (where raw replay would be the thing that breaks).
fn snapshot(sh: &TabShared) -> Vec<u8> {
    let mut out = strip_queries(&sh.scrollback.iter().copied().collect::<Vec<u8>>());
    if sh.parser.screen().alternate_screen() {
        // The scrollback still has to go first, and the switch has to be
        // explicit: contents_formatted() is only grid contents, no mode change.
        // Without the 1049h the client paints the alt screen into its normal
        // buffer and keeps it there when the program exits and restores that
        // buffer, leaving a dead pager's text under the shell prompt.
        out.extend_from_slice(b"\x1b[?1049h");
        out.extend_from_slice(&sh.parser.screen().contents_formatted());
    }
    out
}

/// Remove terminal *query* sequences (DSR/CPR `ESC[…n`, DA `ESC[…c`, DECRQM
/// `ESC[…$p`, OSC color/etc queries containing `?`) from replayed scrollback. They produce no
/// visible output; their only effect is to make the reattaching xterm answer and
/// send the reply as INPUT to the live shell, which lands as gibberish on the
/// prompt (`11;rgb:…`, a stray CPR `R`). Their answers only mattered when the
/// program first asked, so dropping them on replay is always safe.
fn strip_queries(input: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(input.len());
    let mut i = 0;
    while i < input.len() {
        if input[i] == 0x1b && i + 1 < input.len() {
            match input[i + 1] {
                b'[' => {
                    // CSI: params/intermediates then a final byte 0x40..=0x7e.
                    let mut j = i + 2;
                    while j < input.len() && !(0x40..=0x7e).contains(&input[j]) {
                        j += 1;
                    }
                    if j < input.len() {
                        // `$p` is DECRQM (mode query, e.g. the ?2026 sync-output
                        // probe); xterm answers it with `…$y` on replay. j >= i+2,
                        // so j-1 is at worst the `[`.
                        let drop = input[j] == b'n'
                            || input[j] == b'c'
                            || (input[j] == b'p' && input[j - 1] == b'$');
                        if !drop {
                            out.extend_from_slice(&input[i..=j]);
                        }
                        i = j + 1;
                        continue;
                    } else {
                        // Incomplete CSI sequence at end of chunk: preserve intact.
                        out.extend_from_slice(&input[i..]);
                        break;
                    }
                }
                b']' => {
                    // OSC: body up to BEL or ST (ESC \). Drop color/status
                    // QUERIES, whose parameter is a bare `?` so the body ends in
                    // ";?" (e.g. OSC 11;? for background), and clipboard writes
                    // (OSC 52), which would otherwise re-set the user's
                    // clipboard from stale history every time a tab reattaches.
                    // Keep every other OSC, including hyperlinks (OSC 8, URL may
                    // contain `?`) and titles, whose payload can legitimately
                    // contain `?`.
                    let mut j = i + 2;
                    let mut term_len = 0usize;
                    while j < input.len() {
                        if input[j] == 0x07 {
                            term_len = 1;
                            j += 1;
                            break;
                        }
                        if input[j] == 0x1b && j + 1 < input.len() && input[j + 1] == b'\\' {
                            term_len = 2;
                            j += 2;
                            break;
                        }
                        j += 1;
                    }
                    if term_len == 0 {
                        // Incomplete OSC sequence at end of chunk: preserve intact.
                        out.extend_from_slice(&input[i..]);
                        break;
                    }
                    let body_end = j.saturating_sub(term_len);
                    let body = &input[i + 2..body_end];
                    let drop = body.ends_with(b";?") || body.starts_with(b"52;");
                    if !drop {
                        out.extend_from_slice(&input[i..j]);
                    }
                    i = j;
                    continue;
                }
                _ => {}
            }
        }
        out.push(input[i]);
        i += 1;
    }
    out
}

struct Tab {
    master: Box<dyn MasterPty + Send>,
    writer: Arc<Mutex<Box<dyn Write + Send>>>,
    child: Arc<Mutex<Box<dyn Child + Send + Sync>>>,
    shared: Arc<Mutex<TabShared>>,
}

struct Daemon {
    tabs: Mutex<HashMap<String, Tab>>,
    clients: AtomicUsize,
    generation: AtomicU64,
    /// GUI clients that sent Watch.
    watchers: Mutex<Vec<Arc<Client>>>,
    /// Terminals started for `thel session` that no GUI has opened yet,
    /// running or ended, with the exit of those that ended. Every GUI that
    /// watches is told about each. A GUI opening one that ended gets its
    /// exit, not a second run of its command.
    adopts: Mutex<Vec<(Adopt, Option<Option<i32>>)>>,
    /// The sessions each GUI window last reported. Kept after the GUI leaves,
    /// so a request still finds its session while no window is open.
    directory: Mutex<Directory>,
    /// Sandboxed callers' requests waiting for an answer, and where to send it.
    approvals: Mutex<Vec<(Approval, AnswerTx)>>,
    next_approval: AtomicU64,
    /// Terminals whose sandboxed programs the user said no to, with when they
    /// may ask again and how long the last pause was.
    denied: Mutex<HashMap<String, (std::time::Instant, Duration)>>,
    /// The sandboxed program in each terminal the user allowed everything
    /// from (see sandbox_program), until the terminal ends.
    trusted: Mutex<HashMap<String, (u32, u64)>>,
    /// The terminal of the sandboxed caller that started each terminal, so
    /// its list shows what it started, until the caller's terminal ends.
    started: Mutex<HashMap<String, String>>,
    /// How long a sandboxed caller's request waits for the user's answer.
    approval_timeout: Duration,
    /// Where session notes live, as the last watching GUI said.
    notes_dir: Mutex<Option<PathBuf>>,
}

pub fn run() {
    // Detach: own session (no controlling tty) + ignore SIGHUP. Safe: startup,
    // main thread, not a group leader, so setsid succeeds.
    unsafe {
        libc::setsid();
        libc::signal(libc::SIGHUP, libc::SIG_IGN);
    }

    let dir = runtime_dir();
    if std::fs::create_dir_all(&dir).is_err() {
        return;
    }
    let _ = std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700));
    if !dir_is_safe(&dir) {
        eprintln!(
            "[thel-daemon] {} has unsafe owner/perms; refusing to start",
            dir.display()
        );
        return;
    }

    let sock = socket_path();
    let listener = match bind_socket(&sock) {
        Some(l) => l,
        None => return,
    };
    let _ = std::fs::set_permissions(&sock, std::fs::Permissions::from_mode(0o600));
    if std::fs::write(pid_path(), std::process::id().to_string()).is_ok() {
        let _ = std::fs::set_permissions(&pid_path(), std::fs::Permissions::from_mode(0o600));
    }
    eprintln!(
        "[thel-daemon] listening on {} (build {})",
        sock.display(),
        build_version()
    );

    let daemon = Daemon::new();
    daemon.maybe_schedule_exit();
    if daemon_confined() {
        eprintln!(
            "[thel-daemon] running with no_new_privs, as a sandboxed program would: \
             no caller can be told apart as sandboxed, so none is asked about"
        );
    }

    std::thread::spawn({
        let daemon = daemon.clone();
        move || busy_monitor(daemon)
    });
    std::thread::spawn({
        let daemon = daemon.clone();
        move || ports_monitor(daemon)
    });
    std::thread::spawn({
        let daemon = daemon.clone();
        move || idle_monitor(daemon)
    });

    for stream in listener.incoming().flatten() {
        let daemon = daemon.clone();
        std::thread::spawn(move || handle_client(stream, daemon));
    }
}

/// Push each tab's foreground busy state to its subscribers. Emits every tick
/// while busy (a heartbeat, so the GUI's "busy age" stays fresh for a long quiet
/// command) and once when it drops to idle; a steadily-idle tab sends nothing.
fn busy_monitor(daemon: Arc<Daemon>) {
    let mut last: HashMap<String, bool> = HashMap::new();
    loop {
        std::thread::sleep(BUSY_POLL);
        // Snapshot (id, busy, subscribers) under the tabs lock, then send after
        // releasing it so a slow/dead peer can't stall the sampling. Also catch
        // a shell that exited while a grandchild kept the pts open, so tab_reader
        // never saw EOF (e.g. Ctrl+D with a `sleep 300 &` still running).
        let mut exited: Vec<(String, Option<i32>)> = Vec::new();
        let snap: Vec<(String, bool, Vec<Arc<Client>>)> = {
            let tabs = daemon.tabs.lock();
            tabs.iter()
                .map(|(id, t)| {
                    if let Ok(Some(status)) = t.child.lock().try_wait() {
                        exited.push((id.clone(), Some(status.exit_code() as i32)));
                    }
                    let subs = t.shared.lock().subscribers.iter().map(|s| s.client.clone()).collect();
                    (id.clone(), tab_busy(t), subs)
                })
                .collect()
        };
        // finish_tab kills the process group, which closes the pts and lets the
        // stuck tab_reader unwind. Done after releasing the tabs lock.
        for (id, code) in exited {
            finish_tab(&daemon, &id, code);
        }
        let mut next: HashMap<String, bool> = HashMap::new();
        for (id, busy, subs) in snap {
            let was = last.get(&id).copied().unwrap_or(false);
            if busy || was {
                let ev = Arc::new(control_json(&Event::TabBusy {
                    id: id.clone(),
                    busy,
                }));
                for c in &subs {
                    c.enqueue(ev.clone());
                }
            }
            next.insert(id, busy);
        }
        // Drop ids for tabs that went away, so `last` can't grow unbounded.
        last = next;
    }
}

/// Push each attached tab's listening ports to its subscribers when they change.
/// A look skips the process walk while the set of listening sockets and of
/// attached tabs is unchanged, up to PORTS_RESCAN looks in a row.
fn ports_monitor(daemon: Arc<Daemon>) {
    let (mut last_sockets, mut last_roots) = (None, Vec::new());
    let mut skipped = 0;
    loop {
        std::thread::sleep(PORTS_POLL);
        let attached = tab_roots(&daemon, true);
        if attached.is_empty() {
            last_roots.clear();
            continue;
        }
        let mut roots: Vec<(String, u32)> = attached.iter().map(|(id, pid, _)| (id.clone(), *pid)).collect();
        roots.sort_unstable();
        let sockets = crate::pty::listen_fingerprint();
        if sockets.is_some() && sockets == last_sockets && roots == last_roots && skipped < PORTS_RESCAN {
            skipped += 1;
            continue;
        }
        skipped = 0;
        let mut ports = crate::pty::process_tree_ports(&roots);
        (last_sockets, last_roots) = (sockets, roots);
        for (id, _, shared) in attached {
            let now = ports.remove(&id).unwrap_or_default();
            push_on_change(&shared, |sh| {
                (sh.ports != now).then(|| {
                    sh.ports = now.clone();
                    Event::TabPorts { id, ports: now }
                })
            });
        }
    }
}

/// Push each tab's idle state to its subscribers when it changes. A tab is
/// idle once it has run nothing but its shell for IDLE_AFTER.
fn idle_monitor(daemon: Arc<Daemon>) {
    let mut since: HashMap<String, Instant> = HashMap::new();
    loop {
        std::thread::sleep(IDLE_POLL);
        let tabs = tab_roots(&daemon, false);
        let roots: Vec<(String, u32)> = tabs.iter().map(|(id, pid, _)| (id.clone(), *pid)).collect();
        let shell_only = crate::pty::process_tree_shell_only(&roots);
        let now = Instant::now();
        // Also drops tabs that went away, so `since` can't grow unbounded.
        since.retain(|id, _| shell_only.get(id) == Some(&true));
        for (id, _, shared) in tabs {
            if shell_only.get(&id) == Some(&true) {
                since.entry(id.clone()).or_insert(now);
            }
            let idle = since.get(&id).is_some_and(|&at| now - at >= IDLE_AFTER);
            push_on_change(&shared, |sh| {
                (sh.idle != idle).then(|| {
                    sh.idle = idle;
                    Event::TabIdle { id, idle }
                })
            });
        }
    }
}

/// Each tab's id, child pid and shared state, only the tabs with a subscriber
/// when `attached_only`. Tabs whose child has no pid are left out.
fn tab_roots(daemon: &Daemon, attached_only: bool) -> Vec<(String, u32, Arc<Mutex<TabShared>>)> {
    let tabs = daemon.tabs.lock();
    tabs.iter()
        .filter(|(_, t)| !attached_only || !t.shared.lock().subscribers.is_empty())
        .filter_map(|(id, t)| Some((id.clone(), t.child.lock().process_id()?, t.shared.clone())))
        .collect()
}

/// Run `update` under the tab's lock and send the event it returns, if any, to
/// the tab's subscribers after the lock is released.
fn push_on_change(shared: &Mutex<TabShared>, update: impl FnOnce(&mut TabShared) -> Option<Event>) {
    let (ev, subs): (Event, Vec<Arc<Client>>) = {
        let mut sh = shared.lock();
        let Some(ev) = update(&mut sh) else { return };
        (ev, sh.subscribers.iter().map(|s| s.client.clone()).collect())
    };
    let ev = Arc::new(control_json(&ev));
    for c in &subs {
        c.enqueue(ev.clone());
    }
}

fn bind_socket(sock: &Path) -> Option<UnixListener> {
    match UnixListener::bind(sock) {
        Ok(l) => Some(l),
        Err(e) if e.kind() == io::ErrorKind::AddrInUse => {
            if UnixStream::connect(sock).is_ok() {
                None
            } else {
                let _ = std::fs::remove_file(sock);
                UnixListener::bind(sock).ok()
            }
        }
        Err(_) => None,
    }
}

fn handle_client(stream: UnixStream, daemon: Arc<Daemon>) {
    // Count the client (and bump the generation) immediately, before the
    // handshake, so a connection cancels any pending idle-exit grace right away.
    // Otherwise the 45s grace could fire mid-handshake and drop the client. The
    // matching decrement + reschedule run here regardless of how serve_client
    // returns, so the count stays balanced.
    daemon.generation.fetch_add(1, Ordering::SeqCst);
    let n = daemon.clients.fetch_add(1, Ordering::SeqCst) + 1;
    eprintln!("[thel-daemon] client connected ({n} now)");

    serve_client(stream, &daemon);

    let left = daemon.clients.fetch_sub(1, Ordering::SeqCst) - 1;
    eprintln!("[thel-daemon] client disconnected ({left} left)");
    daemon.maybe_schedule_exit();
}

/// Handshake, then read commands until the client disconnects. May return on any
/// handshake failure; handle_client owns the client count, so the balance holds
/// no matter where this returns.
fn serve_client(stream: UnixStream, daemon: &Arc<Daemon>) {
    // Reject a peer that isn't this user before honoring anything (free hardening
    // some terminals omit).
    if !peer_uid_ok(stream.as_raw_fd()) {
        eprintln!("[thel-daemon] rejected connection: peer uid mismatch");
        return;
    }
    let peer = Peer::of(stream.as_raw_fd(), daemon);
    if peer.sandboxed {
        eprintln!(
            "[thel-daemon] pid {} is sandboxed: it may notify, read state, and ask through `thel session`",
            peer.pid.unwrap_or(0)
        );
    }
    // This thread reads commands from `conn`; the handshake replies are written
    // directly here, before the Client's writer thread takes over the write side.
    let mut conn = stream;

    let hello: Hello = match read_frame(&mut conn) {
        Ok((CONTROL, p)) => match parse_json(&p) {
            Some(h) => h,
            None => return,
        },
        _ => return,
    };
    if hello.protocol != PROTOCOL_VERSION {
        let reply = control_json(&HelloReply {
            protocol: PROTOCOL_VERSION,
            build: build_version(),
            ok: false,
            error: Some(format!(
                "protocol mismatch: daemon {PROTOCOL_VERSION}, client {}",
                hello.protocol
            )),
        });
        let _ = conn.write_all(&reply);
        let _ = conn.flush();
        return;
    }
    let reply = control_json(&HelloReply {
        protocol: PROTOCOL_VERSION,
        build: build_version(),
        ok: true,
        error: None,
    });
    if conn.write_all(&reply).is_err() || conn.flush().is_err() {
        return;
    }

    // Handshake done: hand the write side to a dedicated queue+writer so a slow
    // client can't stall PTY drain. From here this thread only reads commands.
    let client = match Client::spawn(&conn) {
        Some(c) => c,
        None => return,
    };

    loop {
        match read_frame(&mut conn) {
            Ok((CONTROL, p)) => {
                if let Some(cmd) = parse_json::<Command>(&p) {
                    if peer.sandboxed && !cmd.harmless(peer.own_tab(daemon).as_deref()) {
                        refuse(cmd, &client);
                    } else {
                        dispatch(daemon, cmd, &client, &peer);
                    }
                }
            }
            Ok((INPUT, p)) if !peer.sandboxed => {
                if let Some((id, data)) = parse_id_payload(&p) {
                    // A GUI's keystrokes to a tab that just ended go nowhere,
                    // and the tab's exit tells it so.
                    let _ = daemon.input(&id, data);
                }
            }
            Ok((INPUT, _)) => {}
            _ => break,
        }
    }

    let shareds: Vec<_> = daemon.tabs.lock().values().map(|t| t.shared.clone()).collect();
    for sh in shareds {
        sh.lock().subscribers.retain(|s| !Arc::ptr_eq(&s.client, &client));
    }
    daemon.watchers.lock().retain(|w| !Arc::ptr_eq(w, &client));
}

impl Command {
    /// Whether a sandboxed peer in tab `own` may send this: it neither runs,
    /// types into nor stops anything, and what it names is its own terminal.
    /// A Session request applies its own rule for sandboxed callers (see
    /// Daemon::session).
    fn harmless(&self, own: Option<&str>) -> bool {
        match self {
            Command::Notify { id, .. } | Command::Cwd { id } => own == Some(id.as_str()),
            Command::Session { .. } => true,
            _ => false,
        }
    }
}

/// Answers a sandboxed peer's refused command, so a client waiting on a reply
/// gets an error instead of hanging. Every command is named, so a new one that
/// waits for a reply can't be missed here.
fn refuse(cmd: Command, client: &Arc<Client>) {
    let message = "thel refuses this from a sandboxed process".to_string();
    let reply = match cmd {
        Command::Open { id, .. } => control_json(&Event::Error { id, message }),
        Command::StopListener { .. } => control_json(&StopReply { error: Some(message) }),
        Command::Cwd { .. } => control_json(&CwdReply { cwd: None }),
        Command::Status => control_json(&StatusReply { busy: HashMap::new() }),
        Command::Usage => control_json(&UsageReply { usage: HashMap::new() }),
        Command::Resize { .. }
        | Command::Detach { .. }
        | Command::Kill { .. }
        | Command::Notify { .. }
        | Command::Session { .. }
        | Command::Watch { .. }
        | Command::Directory { .. }
        | Command::Answer { .. } => return,
    };
    client.enqueue(Arc::new(reply));
}

fn dispatch(daemon: &Arc<Daemon>, cmd: Command, client: &Arc<Client>, peer: &Peer) {
    match cmd {
        Command::Open {
            id,
            command,
            args,
            cwd,
            env,
            cols,
            rows,
        } => {
            // A terminal started for `thel session` runs once: a GUI opening it
            // attaches to it, or gets its exit when it already ended. Under the
            // adopts lock, which a tab that ends records its exit under before
            // it leaves the tabs, so this finds the tab or its exit. A killed
            // tab leaves first, with no exit code to find, and reads as
            // exited with none.
            let waiting = {
                let mut adopts = daemon.adopts.lock();
                adopts.iter().position(|(a, _)| a.terminal == id).map(|i| {
                    let (_, exited) = adopts.remove(i);
                    (exited, daemon.tabs.lock().get(&id).map(|t| t.shared.clone()))
                })
            };
            if let Some((exited, shared)) = waiting {
                daemon.broadcast(&Event::Claimed { terminal: id.clone() });
                match shared {
                    Some(shared) => reattach(&mut shared.lock(), &id, client),
                    None => {
                        let ev = Event::TabExited { id, code: exited.flatten() };
                        client.enqueue(Arc::new(control_json(&ev)));
                    }
                }
            } else if let Err(message) = daemon.open(&id, command, args, cwd, env, cols, rows, Some(client)) {
                client.enqueue(Arc::new(control_json(&Event::Error { id, message })));
            }
        }
        Command::Resize { id, cols, rows } => daemon.resize(&id, cols, rows),
        Command::Detach { id } => daemon.detach(&id, client),
        Command::Kill { id } => daemon.kill(&id),
        Command::Notify { id, message } => daemon.notify_tab(&id, message),
        Command::Status => {
            let busy = daemon.statuses();
            client.enqueue(Arc::new(control_json(&StatusReply { busy })));
        }
        Command::Usage => {
            let usage = daemon.usages();
            client.enqueue(Arc::new(control_json(&UsageReply { usage })));
        }
        Command::Cwd { id } => {
            let cwd = daemon.cwd(&id);
            client.enqueue(Arc::new(control_json(&CwdReply { cwd })));
        }
        Command::StopListener { id, pid } => {
            let error = daemon.stop_listener(&id, pid).err();
            client.enqueue(Arc::new(control_json(&StopReply { error })));
        }
        Command::Session { req } => {
            let reply = daemon.session(peer, req);
            client.enqueue(Arc::new(control_json(&reply)));
        }
        Command::Watch { notes_dir } => {
            *daemon.notes_dir.lock() = Some(notes_dir);
            // Held across the replay: what is added meanwhile is broadcast once
            // the lock is free, so it reaches this watcher instead of falling
            // between the replay and the registration.
            let mut watchers = daemon.watchers.lock();
            for (adopt, _) in daemon.adopts.lock().iter().cloned() {
                client.enqueue(Arc::new(control_json(&Event::Adopt { adopt })));
            }
            for (approval, _) in daemon.approvals.lock().iter() {
                let approval = approval.clone();
                client.enqueue(Arc::new(control_json(&Event::Approve { approval })));
            }
            if !watchers.iter().any(|w| Arc::ptr_eq(w, client)) {
                watchers.push(client.clone());
            }
        }
        Command::Directory { window, sessions } => daemon.report(window, sessions),
        Command::Answer { req, allow, remember } => daemon.answer(req, allow, remember),
    }
}

/// Subscribe `client` to an existing tab. The snapshot, the tab's ports and
/// its idle state are queued before the subscriber is added, all under the
/// caller's lock on `sh`, so they precede any live output (tab_reader clones
/// the subscriber list under the same lock).
fn reattach(sh: &mut TabShared, id: &str, client: &Arc<Client>) {
    if let Some(code) = sh.ended {
        let ev = Event::TabExited { id: id.to_string(), code };
        client.enqueue(Arc::new(control_json(&ev)));
        return;
    }
    let snap = snapshot(sh);
    client.enqueue(Arc::new(frame_bytes(OUTPUT, &id_payload(id, &snap))));
    if !sh.ports.is_empty() {
        let ports = sh.ports.clone();
        client.enqueue(Arc::new(control_json(&Event::TabPorts { id: id.to_string(), ports })));
    }
    if sh.idle {
        client.enqueue(Arc::new(control_json(&Event::TabIdle { id: id.to_string(), idle: true })));
    }
    if let Some(sub) = sh.subscribers.iter_mut().find(|s| Arc::ptr_eq(&s.client, client)) {
        sub.count += 1;
    } else {
        sh.subscribers.push(Subscriber {
            client: client.clone(),
            count: 1,
        });
    }
}

/// A foreground command is running when the tab's PTY foreground process group
/// isn't the shell itself (mirrors the direct-PTY check in pty.rs).
fn tab_busy(t: &Tab) -> bool {
    match (t.master.process_group_leader(), t.child.lock().process_id()) {
        (Some(leader), Some(pid)) => leader as i64 != pid as i64,
        _ => false,
    }
}

impl Daemon {
    fn new() -> Arc<Daemon> {
        Arc::new(Daemon {
            tabs: Mutex::new(HashMap::new()),
            clients: AtomicUsize::new(0),
            generation: AtomicU64::new(0),
            watchers: Mutex::new(Vec::new()),
            adopts: Mutex::new(Vec::new()),
            directory: Mutex::new(HashMap::new()),
            approvals: Mutex::new(Vec::new()),
            next_approval: AtomicU64::new(first_approval_id()),
            denied: Mutex::new(HashMap::new()),
            trusted: Mutex::new(HashMap::new()),
            started: Mutex::new(HashMap::new()),
            approval_timeout: APPROVAL_TIMEOUT,
            notes_dir: Mutex::new(None),
        })
    }

    #[allow(clippy::too_many_arguments)]
    fn open(
        self: &Arc<Self>,
        id: &str,
        command: String,
        args: Vec<String>,
        cwd: Option<String>,
        env: Option<HashMap<String, String>>,
        cols: u16,
        rows: u16,
        client: Option<&Arc<Client>>,
    ) -> Result<Arc<Mutex<TabShared>>, String> {
        // Already have this tab: reattach. Snapshot the current screen and
        // subscribe under one lock so the snapshot precedes any live output.
        let existing = self.tabs.lock().get(id).map(|t| t.shared.clone());
        if let Some(shared) = existing {
            eprintln!("[thel-daemon] reattach tab {id}");
            if let Some(client) = client {
                reattach(&mut shared.lock(), id, client);
            }
            return Ok(shared);
        }

        // New tab: spawn the PTY + child, wire the VTE, attach the opener. The
        // parser needs the floored size too, so compute it here.
        let (cols, rows) = (cols.max(1), rows.max(1));
        let (master, child) = crate::pty::spawn_pty(
            &command,
            &args,
            cwd.as_deref(),
            env.as_ref(),
            cols,
            rows,
            id,
        )?;
        let reader = master.try_clone_reader().map_err(|e| e.to_string())?;
        let writer = master.take_writer().map_err(|e| e.to_string())?;

        let shared = Arc::new(Mutex::new(TabShared {
            parser: vt100::Parser::new(rows, cols, SCROLLBACK),
            scrollback: VecDeque::new(),
            subscribers: Vec::new(),
            ports: Vec::new(),
            idle: false,
            ended: None,
        }));
        let child = Arc::new(Mutex::new(child));

        let mut tabs = self.tabs.lock();
        if let Some(existing_tab) = tabs.get(id) {
            // Concurrent open call raced and created this tab first.
            // Kill extra child process and reattach to existing tab.
            kill_session_and_reap(&child);
            let shared = existing_tab.shared.clone();
            drop(tabs);
            if let Some(client) = client {
                reattach(&mut shared.lock(), id, client);
            }
            return Ok(shared);
        }

        std::thread::spawn({
            let (id, shared, child, daemon) =
                (id.to_string(), shared.clone(), child.clone(), self.clone());
            move || tab_reader(id, reader, shared, child, daemon)
        });

        if let Some(client) = client {
            reattach(&mut shared.lock(), id, client);
        }
        tabs.insert(
            id.to_string(),
            Tab {
                master,
                writer: Arc::new(Mutex::new(writer)),
                child,
                shared: shared.clone(),
            },
        );
        drop(tabs);
        self.generation.fetch_add(1, Ordering::SeqCst);
        eprintln!("[thel-daemon] spawned tab {id} ('{command}')");
        Ok(shared)
    }

    fn detach(&self, id: &str, client: &Arc<Client>) {
        if let Some(t) = self.tabs.lock().get(id) {
            let mut sh = t.shared.lock();
            if let Some(pos) = sh.subscribers.iter().position(|s| Arc::ptr_eq(&s.client, client)) {
                sh.subscribers[pos].count = sh.subscribers[pos].count.saturating_sub(1);
                if sh.subscribers[pos].count == 0 {
                    sh.subscribers.swap_remove(pos);
                }
            }
        }
    }

    // Forward an out-of-band notification to a tab's GUI subscribers. No-op if the
    // tab is unknown (e.g. a stale id). Mirrors busy_monitor's send: snapshot the
    // subscribers under the tabs lock, then enqueue.
    fn notify_tab(&self, id: &str, message: String) {
        let subs = match self.tabs.lock().get(id) {
            Some(t) => t.shared.lock().subscribers.iter().map(|s| s.client.clone()).collect::<Vec<_>>(),
            None => return,
        };
        let ev = Arc::new(control_json(&Event::TabNotify {
            id: id.to_string(),
            message,
        }));
        for c in &subs {
            c.enqueue(ev.clone());
        }
    }

    /// Types `data` into tab `id`.
    fn input(&self, id: &str, data: &[u8]) -> Result<(), String> {
        let writer = self.tabs.lock().get(id).map(|t| t.writer.clone());
        let writer = writer.ok_or_else(|| format!("no terminal {id}"))?;
        let mut w = writer.lock();
        w.write_all(data).and_then(|()| w.flush()).map_err(|e| format!("typing into {id}: {e}"))
    }

    fn resize(&self, id: &str, cols: u16, rows: u16) {
        let (cols, rows) = (cols.max(1), rows.max(1));
        let shared = match self.tabs.lock().get(id) {
            Some(t) => {
                let _ = t.master.resize(PtySize {
                    rows,
                    cols,
                    pixel_width: 0,
                    pixel_height: 0,
                });
                t.shared.clone()
            }
            None => return,
        };
        shared.lock().parser.set_size(rows, cols);
    }

    fn kill(self: &Arc<Self>, id: &str) {
        // Take the tab out from under the tabs lock first, so the blocking wait()
        // in kill_session_and_reap doesn't hold the global lock across it.
        let removed = self.tabs.lock().remove(id);
        if let Some(t) = removed {
            kill_session_and_reap(&t.child);
            // A GUI closes a terminal no window was shown when it closed the
            // terminal's session, so none waits for it.
            let claimed = {
                let mut adopts = self.adopts.lock();
                let before = adopts.len();
                adopts.retain(|(a, _)| a.terminal != id);
                adopts.len() < before
            };
            if claimed {
                self.broadcast(&Event::Claimed { terminal: id.to_string() });
            }
            self.forget_tab(id);
        }
        self.maybe_schedule_exit();
    }

    /// Keeps the exit of tab `id`, which just ended, for the GUI that opens it
    /// if it still waits for one.
    fn keep_exit(&self, id: &str, code: Option<i32>) {
        // Under the adopts lock, so a GUI opening it meanwhile finds the exit.
        if let Some((_, exit)) = self.adopts.lock().iter_mut().find(|(a, _)| a.terminal == id) {
            exit.get_or_insert(code);
        }
    }

    /// Forgets tab `id`, once it's out of the tabs: its trust, its pause and
    /// its open questions go. After the removal, so a question or trust added
    /// meanwhile, which checks the tab is there, is found here.
    fn forget_tab(&self, id: &str) {
        let asked: Vec<u64> =
            self.approvals.lock().iter().filter(|(a, _)| a.caller == id).map(|(a, _)| a.req).collect();
        // Dropping the answer's sender tells the waiting request the terminal closed.
        for req in asked {
            self.resolve(req, false);
        }
        self.trusted.lock().remove(id);
        self.denied.lock().remove(id);
        self.started.lock().retain(|_, caller| caller != id);
    }

    fn statuses(&self) -> HashMap<String, bool> {
        self.tabs
            .lock()
            .iter()
            .map(|(id, t)| (id.clone(), tab_busy(t)))
            .collect()
    }

    fn usages(&self) -> HashMap<String, crate::pty::Usage> {
        // Snapshot the pids under the lock and walk /proc outside it: the walk is
        // slow enough that holding `tabs` would stall the PTY readers.
        let roots: Vec<(String, u32)> = {
            let tabs = self.tabs.lock();
            tabs.iter()
                .filter_map(|(id, t)| Some((id.clone(), t.child.lock().process_id()?)))
                .collect()
        };
        crate::pty::process_tree_usage(&roots)
    }

    fn stop_listener(&self, id: &str, pid: u32) -> Result<(), String> {
        let root = self.tabs.lock().get(id).and_then(|t| t.child.lock().process_id());
        crate::pty::stop_tree_listener(root.ok_or("That terminal has no running process")?, pid)
    }

    /// Carries out a `thel session` request for the program behind `peer`.
    fn session(self: &Arc<Self>, peer: &Peer, req: Request) -> Reply {
        self.try_session(peer, req).unwrap_or_else(|e| Reply { error: Some(e), ..Reply::default() })
    }

    fn try_session(self: &Arc<Self>, peer: &Peer, req: Request) -> Result<Reply, String> {
        let outside = "thel session works only from inside a thel terminal";
        let caller = if peer.sandboxed {
            peer.tab.as_ref().ok_or(outside)?;
            peer.own_tab(self).ok_or("the caller's terminal closed")?
        } else {
            peer.pid.and_then(|p| self.tab_of_pid(p)).ok_or(outside)?
        };
        // A sandboxed program may list sessions, but anything that starts or
        // types needs the user's yes, which runs it outside the sandbox.
        let trusted = peer.program.is_some() && self.trusted.lock().get(&caller) == peer.program.as_ref();
        let asks = peer.sandboxed && req != (Request::List { all: false }) && !trusted;
        req.check()?;
        let req = if asks {
            // Before the lookups, so a request that can't be asked fails the
            // same way whatever it names.
            self.may_ask(&self.approvals.lock(), &caller)?;
            let (req, session) = self.pin_session(&caller, req.resolved()?)?;
            self.ask(peer, &caller, &req, session.as_deref())?;
            req
        } else {
            req
        };
        self.carry_out(&caller, req, peer.sandboxed, asks)
    }

    /// Notes that `caller` started `terminal`, for its list, if it's sandboxed.
    fn mark_started(&self, terminal: &str, caller: &str, sandboxed: bool) {
        if sandboxed {
            self.started.lock().insert(terminal.to_string(), caller.to_string());
        }
    }

    /// Records the sessions `window` shows. A window that leaves hands the
    /// questions it was showing to another, which asks them again.
    fn report(&self, window: String, sessions: Vec<crate::session::DirSession>) {
        let left = sessions.is_empty();
        let to = {
            let mut dir = self.directory.lock();
            crate::session::report(&mut dir, window.clone(), sessions);
            dir.keys().min().cloned()
        };
        if !left {
            return;
        }
        let moved: Vec<Approval> = self
            .approvals
            .lock()
            .iter_mut()
            .filter(|(a, _)| a.window.as_deref() == Some(window.as_str()))
            .map(|(a, _)| {
                a.window = to.clone();
                a.clone()
            })
            .collect();
        for approval in moved {
            self.broadcast(&Event::Approve { approval });
        }
    }

    /// The GUI window that shows tab `tab`.
    fn window_of(&self, tab: &str) -> Option<String> {
        crate::session::session_of(&self.directory.lock(), tab).map(|(w, _)| w.to_string())
    }

    /// Carries out `req` for tab `caller`, with its session `pinned` to an id
    /// by pin_session.
    fn carry_out(self: &Arc<Self>, caller: &str, req: Request, sandboxed: bool, pinned: bool) -> Result<Reply, String> {
        match req {
            Request::New { name, cwd, command } => {
                let name = name.unwrap_or_else(|| crate::session::name_for_dir(&cwd));
                // The window the caller is in, so the session shows up beside it.
                let window = self.window_of(caller);
                let terminal = self.start(command, cwd, Place::NewSession { name, window }, sandboxed)?;
                self.mark_started(&terminal, caller, sandboxed);
                Ok(Reply { terminal: Some(terminal), ..Reply::default() })
            }
            Request::Terminal { session, cwd, command } => {
                let (id, _) = self.session_id(caller, session.as_deref(), pinned)?;
                let terminal = self.start(command, cwd, Place::Session { id }, sandboxed)?;
                self.mark_started(&terminal, caller, sandboxed);
                Ok(Reply { terminal: Some(terminal), ..Reply::default() })
            }
            Request::List { all } => {
                let alive: std::collections::HashSet<String> =
                    self.tabs.lock().keys().cloned().collect();
                let dir = self.directory.lock();
                let mut sessions = crate::session::list(&dir, &alive, self.adopts.lock().iter().map(|(a, _)| a));
                // Without asking, a sandboxed program sees only its own session
                // and those it started: the others' names can be private.
                if sandboxed && !all {
                    let own = crate::session::session_of(&dir, caller).map(|(_, s)| s.id.as_str());
                    let started = self.started.lock();
                    sessions.retain(|l| {
                        (l.id.is_some() && l.id.as_deref() == own)
                            || l.terminals.iter().any(|t| started.get(&t.id).is_some_and(|c| c == caller))
                    });
                }
                Ok(Reply { sessions, ..Reply::default() })
            }
            Request::SendKeys { terminal, data } => {
                self.input(&terminal, &data)?;
                Ok(Reply::default())
            }
            Request::Note { session, edit } => {
                let (id, _) = self.session_id(caller, session.as_deref(), pinned)?;
                // Held to the end, so edits from programs running at once
                // apply one after another and the GUIs hear them in order.
                let dir = self.notes_dir.lock();
                let dir = dir.as_ref().ok_or("no thel window has opened yet")?;
                let path = crate::session::note_file(dir, &id)?;
                let _lock = crate::session::lock_notes(dir)?;
                let text = crate::session::read_note(&path)?;
                // An edit's reply leaves the notes out: a yes to an edit is
                // not a yes to reading them.
                let Some(edit) = edit else { return Ok(Reply { note: Some(text), ..Reply::default() }) };
                let text = edit.apply(&text);
                crate::session::write_note(&path, &text)?;
                self.broadcast(&Event::Note(NoteChange { session: id, text, edit }));
                Ok(Reply::default())
            }
        }
    }

    /// The id and name of the session `key` names, or of the one showing
    /// `caller`. A `pinned` key is an id only: the session the user allowed
    /// a request for, which mustn't turn into another one named like it.
    fn session_id(&self, caller: &str, key: Option<&str>, pinned: bool) -> Result<(String, String), String> {
        let dir = self.directory.lock();
        let found = match key {
            Some(key) if pinned => crate::session::session_by_id(&dir, key)
                .ok_or("the session this was allowed for closed")?,
            Some(key) => crate::session::find_session(&dir, key)?,
            None => crate::session::session_of(&dir, caller)
                .ok_or("this terminal's session is unknown; pass -t SESSION")?,
        };
        Ok((found.1.id.clone(), found.1.name.clone()))
    }

    /// `req` with its session pinned to the id it names now, and how the
    /// prompt names that session, so it names the one the request acts on.
    fn pin_session(&self, caller: &str, req: Request) -> Result<(Request, Option<String>), String> {
        Ok(match req {
            Request::Terminal { session, cwd, command } => {
                let (id, label) = self.pinned(caller, session.as_deref())?;
                (Request::Terminal { session: Some(id), cwd, command }, Some(label))
            }
            Request::Note { session, edit } => {
                let (id, label) = self.pinned(caller, session.as_deref())?;
                (Request::Note { session: Some(id), edit }, Some(label))
            }
            other => (other, None),
        })
    }

    /// The id of the session `key` names, and how the prompt names it.
    fn pinned(&self, caller: &str, key: Option<&str>) -> Result<(String, String), String> {
        // Only a sandboxed caller pins, and its list hides the sessions it
        // didn't start, so a failed lookup mustn't tell it their names or ids.
        let (id, name) = self
            .session_id(caller, key, false)
            .map_err(|e| if key.is_some() { "no session by that name or id".to_string() } else { e })?;
        let label = crate::session::session_label(&self.directory.lock(), &id, &name);
        Ok((id, label))
    }

    /// Asks the watching GUIs to allow `req` from a sandboxed program in tab
    /// `caller`, and waits for the answer. Fails on a no, or when nobody
    /// answers in time.
    fn ask(&self, peer: &Peer, caller: &str, req: &Request, session: Option<&str>) -> Result<(), String> {
        let summary = crate::session::describe(req, session.unwrap_or_default());
        if summary.len() > APPROVAL_SUMMARY_MAX {
            return Err(format!(
                "this request is too long to ask about ({} bytes; at most {APPROVAL_SUMMARY_MAX})",
                summary.len()
            ));
        }
        let target = match req {
            Request::SendKeys { terminal, .. } => Some(terminal.clone()),
            _ => None,
        };
        let (caller_session, target_session) = {
            let dir = self.directory.lock();
            let label = |t: &str| {
                crate::session::session_of(&dir, t).map(|(_, s)| crate::session::session_label(&dir, &s.id, &s.name))
            };
            (label(caller), target.as_deref().and_then(label))
        };
        let approval = Approval {
            req: self.next_approval.fetch_add(1, Ordering::Relaxed),
            caller: caller.to_string(),
            caller_session,
            summary,
            target_session,
            target,
            window: self.window_of(caller),
            program: peer.program.and_then(|(pid, start)| exe_of(pid, start)),
        };
        let (tx, rx) = sync_channel(1);
        {
            // One question per terminal at a time, so a program can't bury the
            // user in prompts.
            let mut approvals = self.approvals.lock();
            self.may_ask(&approvals, caller)?;
            // Under the approvals lock, so a tab that ends after this check
            // finds the question when its end settles them.
            if !self.tabs.lock().contains_key(caller) {
                return Err("the caller's terminal closed".into());
            }
            approvals.push((approval.clone(), tx));
        }
        self.broadcast(&Event::Approve { approval: approval.clone() });
        // A caller that gives up (Ctrl-C) takes its question with it, so a
        // later yes can't run what nobody waits for anymore.
        let deadline = std::time::Instant::now() + self.approval_timeout;
        let answer = loop {
            let left = deadline.saturating_duration_since(std::time::Instant::now());
            match rx.recv_timeout(left.min(HANGUP_POLL)) {
                Ok((true, _)) if peer.hung_up() => break Err("the caller hung up".to_string()),
                Ok(answer) => break Ok(answer),
                Err(RecvTimeoutError::Disconnected) => break Err("the caller's terminal closed".to_string()),
                Err(_) if peer.hung_up() => break Err("the caller hung up".to_string()),
                Err(_) if left.is_zero() => {
                    break Err(format!(
                        "no answer in thel within {} s; is a thel window open?",
                        self.approval_timeout.as_secs()
                    ))
                }
                Err(_) => {}
            }
        };
        match answer {
            Ok((true, remember)) => {
                // A yes for good needs the program the prompt named.
                if let Some(program) = peer.program.filter(|_| remember && approval.program.is_some()) {
                    // Checked under the trusted lock, so a tab that ends
                    // meanwhile drops the trust again when its end takes it.
                    let mut trusted = self.trusted.lock();
                    if self.tabs.lock().contains_key(caller) {
                        trusted.insert(caller.to_string(), program);
                    }
                }
                self.denied.lock().remove(caller);
                Ok(())
            }
            Ok((false, _)) => Err("denied in thel".into()),
            Err(e) => {
                // A question withdrawn while shown pauses too, so a program
                // can't swap it for another under the user's click. So does
                // one the user allowed as its caller hung up.
                if self.resolve(approval.req, true).is_none() {
                    let _approvals = self.approvals.lock();
                    if self.tabs.lock().contains_key(caller) {
                        self.lengthen_pause(caller);
                    }
                }
                Err(e)
            }
        }
    }

    /// Whether tab `caller` may ask now: with no question of its own waiting
    /// and no pause after a no. Called under the approvals lock, which a
    /// question's pause is set under as it goes, so no request slips in
    /// between the two.
    fn may_ask(&self, approvals: &[(Approval, AnswerTx)], caller: &str) -> Result<(), String> {
        // One question per terminal at a time, so a program can't bury the
        // user in prompts.
        if approvals.iter().any(|(a, _)| a.caller == caller) {
            return Err("a request from this terminal is already waiting for an answer".into());
        }
        if let Some((until, _)) = self.denied.lock().get(caller) {
            let left = until.saturating_duration_since(std::time::Instant::now());
            if !left.is_zero() {
                return Err(format!("denied in thel; ask again in {} s", left.as_secs() + 1));
            }
        }
        Ok(())
    }

    /// The user's answer to approval `req`.
    fn answer(&self, req: u64, allow: bool, remember: bool) {
        if let Some((_, tx)) = self.resolve(req, !allow) {
            let _ = tx.try_send((allow, remember));
        }
    }

    /// Drops approval `req` and tells the GUIs it's settled. With `longer`
    /// (a no, or a question withdrawn or timed out) its terminal's pause
    /// doubles. A withdrawn question counts too, so a program can't ask and
    /// give up over and over to stay at the shortest pause. A yes lifts the
    /// pause only once its request goes ahead (see ask).
    fn resolve(&self, req: u64, longer: bool) -> Option<(Approval, AnswerTx)> {
        let mut approvals = self.approvals.lock();
        let i = approvals.iter().position(|(a, _)| a.req == req)?;
        let found = approvals.remove(i);
        if longer {
            self.lengthen_pause(&found.0.caller);
        }
        drop(approvals);
        self.broadcast(&Event::Resolved { req });
        Some(found)
    }

    /// Doubles the pause of tab `caller`'s sandboxed programs, or starts it.
    /// Called under the approvals lock, which ask reads the pause under.
    fn lengthen_pause(&self, caller: &str) {
        let mut denied = self.denied.lock();
        let p = denied.get(caller).map_or(DENY_PAUSE, |(_, p)| (*p * 2).min(DENY_PAUSE_MAX));
        denied.insert(caller.to_string(), (std::time::Instant::now() + p, p));
    }

    /// Starts a terminal with no GUI attached and hands it to the watching
    /// GUIs to show at `place`, for a sandboxed program if `sandboxed`.
    /// Returns its id.
    fn start(
        self: &Arc<Self>,
        command: Vec<String>,
        cwd: String,
        place: Place,
        sandboxed: bool,
    ) -> Result<String, String> {
        let (command, args) = match command.split_first() {
            Some((c, a)) => (c.clone(), a.to_vec()),
            None => (crate::default_shell(), Vec::new()),
        };
        // A pty given a missing folder starts in $HOME instead.
        if !Path::new(&cwd).is_dir() {
            return Err(format!("no folder {cwd}"));
        }
        let id = new_id().map_err(|e| format!("no terminal id: {e}"))?;
        let adopt = Adopt { terminal: id.clone(), command, args, cwd, place, sandboxed };
        // The GUI resizes it to its pane when it shows it.
        let a = &adopt;
        let shared = self.open(&id, a.command.clone(), a.args.clone(), Some(a.cwd.clone()), None, 80, 24, None)?;
        {
            // Listed only once its tab exists, so no Watch replay or Open finds
            // the entry first. A tab that ends marks itself ended before it
            // looks for its entry under this lock, so its exit is kept either way.
            let mut adopts = self.adopts.lock();
            let ended = shared.lock().ended;
            adopts.push((adopt.clone(), ended));
        }
        self.broadcast(&Event::Adopt { adopt });
        Ok(id)
    }

    /// Sends `ev` to every watching GUI.
    fn broadcast(&self, ev: &Event) {
        let ev = Arc::new(control_json(ev));
        for w in self.watchers.lock().iter() {
            w.enqueue(ev.clone());
        }
    }

    /// Each tab's shell pid, and the tab.
    fn roots(&self) -> HashMap<u32, String> {
        self.tabs.lock().iter().filter_map(|(id, t)| Some((t.child.lock().process_id()?, id.clone()))).collect()
    }

    /// The tab whose processes include `pid`: by ancestry, or on Linux by the
    /// tab's cgroup scope, which also holds processes that left its tree.
    fn tab_of_pid(&self, pid: u32) -> Option<String> {
        let roots = self.roots();
        crate::session::tab_of(pid, &roots, parent_pid).or_else(|| tab_by_scope(pid, &roots))
    }

    /// Where one tab's shell is now, for opening a new terminal alongside it.
    fn cwd(&self, id: &str) -> Option<String> {
        let pid = self.tabs.lock().get(id)?.child.lock().process_id()?;
        crate::pty::process_cwd(pid)
    }

    /// Idle-exit when nothing uses the daemon: no clients AND no tabs. A live tab
    /// with no client attached keeps it up (the whole point). Cancels itself if a
    /// client/tab shows up during the grace window.
    fn maybe_schedule_exit(self: &Arc<Self>) {
        if self.clients.load(Ordering::SeqCst) != 0 || !self.tabs.lock().is_empty() {
            return;
        }
        let gen = self.generation.load(Ordering::SeqCst);
        let me = self.clone();
        std::thread::spawn(move || {
            std::thread::sleep(EMPTY_GRACE);
            if me.clients.load(Ordering::SeqCst) == 0
                && me.tabs.lock().is_empty()
                && me.generation.load(Ordering::SeqCst) == gen
            {
                eprintln!("[thel-daemon] idle past grace, exiting");
                std::process::exit(0);
            }
        });
    }
}

/// A random start for approval ids, so an answer meant for a daemon that
/// ended can't settle a request of the one after it. Under 2^53, which a
/// JavaScript number holds exactly.
fn first_approval_id() -> u64 {
    // Without /dev/urandom the ids start at 1, which only loses that guard.
    urandom().map_or(1, |b| (u64::from_le_bytes(b) >> 12).max(1))
}

/// A fresh terminal id: 128 random bits in hex.
fn new_id() -> std::io::Result<String> {
    Ok(urandom::<16>()?.iter().map(|x| format!("{x:02x}")).collect())
}

fn urandom<const N: usize>() -> std::io::Result<[u8; N]> {
    let mut b = [0u8; N];
    std::fs::File::open("/dev/urandom")?.read_exact(&mut b)?;
    Ok(b)
}

/// The tab, among `roots` (root pid to tab id), whose cgroup scope holds
/// `pid`. A scope the daemon shares (it runs in a thel terminal, and tabs that
/// got no scope of their own inherit it) says nothing about which tab.
#[cfg(target_os = "linux")]
fn tab_by_scope(pid: u32, roots: &HashMap<u32, String>) -> Option<String> {
    let scope = crate::cgroup::scope_of(pid)
        .filter(|s| crate::cgroup::scope_of(std::process::id()).as_ref() != Some(s))?;
    roots
        .iter()
        .find(|(&root, _)| crate::cgroup::scope_of(root).as_ref() == Some(&scope))
        .map(|(_, id)| id.clone())
}

#[cfg(not(target_os = "linux"))]
fn tab_by_scope(_pid: u32, _roots: &HashMap<u32, String>) -> Option<String> {
    None
}

#[cfg(target_os = "linux")]
fn parent_pid(pid: u32) -> Option<u32> {
    proc_stat(pid).map(|(parent, _)| parent)
}

#[cfg(target_os = "macos")]
fn parent_pid(pid: u32) -> Option<u32> {
    // SAFETY: proc_bsdinfo is plain data, so all zeroes is a valid value.
    let mut info: libc::proc_bsdinfo = unsafe { std::mem::zeroed() };
    let size = std::mem::size_of::<libc::proc_bsdinfo>() as libc::c_int;
    // SAFETY: info is valid for writes of `size` bytes.
    let n = unsafe {
        libc::proc_pidinfo(
            pid as libc::c_int,
            libc::PROC_PIDTBSDINFO,
            0,
            &mut info as *mut _ as *mut libc::c_void,
            size,
        )
    };
    (n == size).then_some(info.pbi_ppid)
}

#[cfg(not(any(target_os = "linux", target_os = "macos")))]
fn parent_pid(_pid: u32) -> Option<u32> {
    None
}

/// SIGKILL every process in the shell's session -- foreground and background
/// jobs alike, whatever process group they're in -- then reap the shell so it
/// isn't a zombie. Killing the session (not just the process group) is what
/// reaches a job-control background job like `sleep 300 &`, which the shell puts
/// in its own group; killing them also closes the pts so a stuck tab_reader
/// unwinds. PTY children are session leaders (setsid), so the session id is the
/// child's pid.
fn kill_session_and_reap(child: &Arc<Mutex<Box<dyn Child + Send + Sync>>>) {
    let mut child = child.lock();
    if let Some(pid) = child.process_id() {
        kill_session(pid as i32);
    }
    let _ = child.kill();
    let _ = child.wait();
}

/// SIGKILL every process whose session id is `sid`. kill() only reaches our own
/// processes (same uid), and only this shell's descendants share its session, so
/// this can't touch the daemon or another tab (each pty child is its own
/// session). A job that detached with setsid/nohup left the session and is
/// spared, matching a normal terminal.
fn kill_session(sid: i32) {
    // Never touch sessions 0/1 (kernel/init): a stray getsid() returning one of
    // those must not be read as a match and wipe out unrelated processes.
    if sid <= 1 {
        return;
    }
    for pid in all_pids() {
        if pid <= 1 {
            continue;
        }
        let session_id = unsafe { libc::getsid(pid) };
        if session_id > 0 && session_id == sid {
            unsafe { libc::kill(pid, libc::SIGKILL) };
        }
    }
}

/// Every process id on the system, the basis for the session-kill and
/// stray-daemon scans. Linux reads `/proc`; macOS asks the kernel via
/// `proc_listallpids`. Other unixes have no portable enumeration, so the scans
/// there become no-ops (the direct `child.kill()` still reaps the shell itself).
#[cfg(target_os = "linux")]
fn all_pids() -> Vec<i32> {
    let Ok(entries) = std::fs::read_dir("/proc") else {
        return Vec::new();
    };
    entries
        .flatten()
        .filter_map(|e| e.file_name().to_str().and_then(|s| s.parse::<i32>().ok()))
        .collect()
}

#[cfg(target_os = "macos")]
fn all_pids() -> Vec<i32> {
    // proc_listallpids(NULL, 0) reports how many pids exist; then we fetch them
    // into a buffer. Over-allocate a little since the set can grow between the
    // sizing call and the fetch.
    let n = unsafe { libc::proc_listallpids(std::ptr::null_mut(), 0) };
    if n <= 0 {
        return Vec::new();
    }
    let cap = n as usize + 64;
    let mut pids = vec![0i32; cap];
    let bytes = (cap * std::mem::size_of::<i32>()) as libc::c_int;
    let got = unsafe { libc::proc_listallpids(pids.as_mut_ptr() as *mut libc::c_void, bytes) };
    if got <= 0 {
        return Vec::new();
    }
    pids.truncate(got as usize);
    pids.retain(|&p| p > 0);
    pids
}

#[cfg(not(any(target_os = "linux", target_os = "macos")))]
fn all_pids() -> Vec<i32> {
    Vec::new()
}

/// Tear a tab down once: remove it, kill its process group + reap, and tell
/// subscribers it exited. Guarded by the tabs-map removal, so the three paths
/// that can end a tab -- tab_reader's read EOF, the busy poller catching a shell
/// that exited while a grandchild held the pts, and an explicit Kill -- can all
/// call it and only the first wins.
fn finish_tab(daemon: &Arc<Daemon>, id: &str, code: Option<i32>) {
    // Before keep_exit, for a terminal `start` lists meanwhile.
    if let Some(t) = daemon.tabs.lock().get(id) {
        t.shared.lock().ended.get_or_insert(code);
    }
    // Before the tab goes, so a GUI opening it meanwhile finds either the tab
    // or its exit.
    daemon.keep_exit(id, code);
    let removed = daemon.tabs.lock().remove(id);
    let Some(t) = removed else {
        return; // already finished by another path
    };
    daemon.forget_tab(id);
    kill_session_and_reap(&t.child);
    let subs = t.shared.lock().subscribers.iter().map(|s| s.client.clone()).collect::<Vec<_>>();
    let ev = Arc::new(control_json(&Event::TabExited {
        id: id.to_string(),
        code,
    }));
    for c in &subs {
        c.enqueue(ev.clone());
    }
    daemon.maybe_schedule_exit();
}

fn tab_reader(
    id: String,
    mut reader: Box<dyn Read + Send>,
    shared: Arc<Mutex<TabShared>>,
    child: Arc<Mutex<Box<dyn Child + Send + Sync>>>,
    daemon: Arc<Daemon>,
) {
    let mut buf = [0u8; 8192];
    loop {
        match reader.read(&mut buf) {
            Ok(0) | Err(_) => break,
            Ok(n) => {
                // Update authoritative state and snapshot the subscriber list
                // under one lock; broadcast outside it. ponytail: unbounded
                // per-client; add bounded buffers / drop policy (spec §9) later.
                let subs = {
                    let mut sh = shared.lock();
                    // Capture normal-screen output for scrollback; skip while on
                    // the alt screen (the VTE snapshot covers that on reattach).
                    let was_alt = sh.parser.screen().alternate_screen();
                    sh.parser.process(&buf[..n]);
                    if !was_alt && !sh.parser.screen().alternate_screen() {
                        sh.scrollback.extend(buf[..n].iter().copied());
                        let over = sh.scrollback.len().saturating_sub(MAX_SCROLLBACK_BYTES);
                        if over > 0 {
                            sh.scrollback.drain(0..over);
                        }
                    }
                    sh.subscribers.iter().map(|s| s.client.clone()).collect::<Vec<_>>()
                };
                let frame = Arc::new(frame_bytes(OUTPUT, &id_payload(&id, &buf[..n])));
                for c in &subs {
                    c.enqueue(frame.clone());
                }
            }
        }
    }
    let code = child.lock().wait().ok().map(|s| s.exit_code() as i32);
    eprintln!("[thel-daemon] tab {id} exited (code {code:?})");
    finish_tab(&daemon, &id, code);
}

// ---- GUI side: a single multiplexed connection to the daemon --------------

struct DaemonClient {
    write: Mutex<UnixStream>,
    routes: Arc<Mutex<HashMap<String, Channel<TermMsg>>>>,
    build: String,
}

impl DaemonClient {
    fn send_frame(&self, ty: u8, payload: &[u8]) -> Result<(), String> {
        let mut w = self.write.lock();
        write_frame(&mut *w, ty, payload).map_err(|e| e.to_string())
    }
}

fn client_cell() -> &'static Mutex<Option<Arc<DaemonClient>>> {
    static C: OnceLock<Mutex<Option<Arc<DaemonClient>>>> = OnceLock::new();
    C.get_or_init(|| Mutex::new(None))
}

fn client() -> Result<Arc<DaemonClient>, String> {
    let mut g = client_cell().lock();
    if let Some(c) = g.as_ref() {
        return Ok(c.clone());
    }
    let (stream, build) = connect_or_spawn()?;
    let reader = stream.try_clone().map_err(|e| e.to_string())?;
    let routes: Arc<Mutex<HashMap<String, Channel<TermMsg>>>> = Arc::new(Mutex::new(HashMap::new()));
    let read_routes = routes.clone();
    std::thread::spawn(move || client_read_loop(reader, read_routes));
    let c = Arc::new(DaemonClient {
        write: Mutex::new(stream),
        routes,
        build,
    });
    for cmd in SESSION_REPLAY.lock().commands() {
        // A failed send leaves this connection broken, and the next call that
        // uses it drops it and reconnects, which replays again.
        let _ = c.send_frame(CONTROL, &serde_json::to_vec(&cmd).unwrap_or_default());
    }
    *g = Some(c.clone());
    Ok(c)
}

/// On a write/connection error, drop the cached client so the next call
/// reconnects (and respawns the daemon if it died).
fn on_client_error(res: Result<(), String>) -> Result<(), String> {
    if res.is_err() {
        *client_cell().lock() = None;
    }
    res
}

/// Establish the daemon connection at GUI startup (spawning if needed) and keep
/// it open for the GUI's lifetime. Returns the daemon's build string.
pub fn ensure() -> Result<String, String> {
    Ok(client()?.build.clone())
}

/// Open (or reattach to) a tab for `opts.id`, routing its output to `on_data`.
pub fn open(opts: &CreateOpts, on_data: Channel<TermMsg>) -> Result<(), String> {
    let c = client()?;
    c.routes.lock().insert(opts.id.clone(), on_data);
    let cmd = Command::Open {
        id: opts.id.clone(),
        command: opts.command.clone(),
        args: opts.args.clone(),
        cwd: opts.cwd.clone(),
        env: opts.env.clone(),
        cols: opts.cols,
        rows: opts.rows,
    };
    let res = c.send_frame(CONTROL, &serde_json::to_vec(&cmd).unwrap_or_default());
    if res.is_err() {
        c.routes.lock().remove(&opts.id);
    }
    on_client_error(res)
}

pub fn input(id: &str, data: &[u8]) -> Result<(), String> {
    let c = client()?;
    on_client_error(c.send_frame(INPUT, &id_payload(id, data)))
}

pub fn resize(id: &str, cols: u16, rows: u16) -> Result<(), String> {
    let c = client()?;
    let cmd = Command::Resize {
        id: id.to_string(),
        cols,
        rows,
    };
    on_client_error(c.send_frame(CONTROL, &serde_json::to_vec(&cmd).unwrap_or_default()))
}

/// Stop receiving a tab's output but leave it running (pane unmount / app quit).
pub fn detach(id: &str) -> Result<(), String> {
    let c = client()?;
    c.routes.lock().remove(id);
    let cmd = Command::Detach { id: id.to_string() };
    on_client_error(c.send_frame(CONTROL, &serde_json::to_vec(&cmd).unwrap_or_default()))
}

/// Terminate a tab's process and forget it (the user closed the tab, or the
/// window it belonged to). Without an established connection there is no daemon
/// holding the tab, so this is a no-op rather than a reason to spawn one.
pub fn kill(id: &str) -> Result<(), String> {
    let cached = client_cell().lock().clone();
    let Some(c) = cached else {
        return Ok(());
    };
    c.routes.lock().remove(id);
    let cmd = Command::Kill { id: id.to_string() };
    on_client_error(c.send_frame(CONTROL, &serde_json::to_vec(&cmd).unwrap_or_default()))
}

/// Connect, handshake, send one command. A short-lived connection of its own
/// (like probe_existing) so a reply doesn't have to be correlated against the
/// long-lived client's multiplexed output stream. Errors carry a message for
/// the user.
fn query_send(cmd: &Command) -> Result<UnixStream, String> {
    let hung_up = |_| "the thel daemon hung up".to_string();
    let mut stream =
        UnixStream::connect(socket_path()).map_err(|_| "no thel daemon to talk to; is thel running?")?;
    let hello = serde_json::to_vec(&Hello {
        protocol: PROTOCOL_VERSION,
        build: build_version(),
    })
    .unwrap_or_default();
    write_frame(&mut stream, CONTROL, &hello).map_err(hung_up)?;
    match read_frame(&mut stream) {
        // A daemon speaking another protocol rejects the hello, so this returns
        // rather than waiting on a reply it would never send. The GUI's skew
        // prompt is what resolves that.
        Ok((CONTROL, p)) => match parse_json::<HelloReply>(&p) {
            Some(r) if r.ok => {}
            Some(HelloReply { error: Some(e), .. }) => return Err(format!("{e}; restart thel to update its daemon")),
            _ => return Err("the thel daemon refused the connection".into()),
        },
        _ => return Err("the thel daemon hung up".into()),
    }
    let payload = serde_json::to_vec(cmd).unwrap_or_default();
    write_frame(&mut stream, CONTROL, &payload).map_err(hung_up)?;
    Ok(stream)
}

/// Ask the daemon one command and decode the reply it sends back.
fn query<T: DeserializeOwned>(cmd: &Command) -> Result<T, String> {
    let mut stream = query_send(cmd)?;
    match read_frame(&mut stream) {
        Ok((CONTROL, p)) => parse_json::<T>(&p).ok_or_else(|| "garbled reply".into()),
        _ => Err("the thel daemon hung up".into()),
    }
}

/// Busy state of every daemon tab, for the GUI's working-dot poll. Empty on any
/// error rather than failing the whole status poll.
pub fn statuses() -> std::collections::HashMap<String, bool> {
    query::<StatusReply>(&Command::Status)
        .map(|r| r.busy)
        .unwrap_or_default()
}

/// CPU time and memory of every daemon tab, for the GUI's session usage dialog.
/// Empty on any error, so the dialog shows the terminals without numbers rather
/// than failing.
pub fn usages() -> std::collections::HashMap<String, crate::pty::Usage> {
    query::<UsageReply>(&Command::Usage)
        .map(|r| r.usage)
        .unwrap_or_default()
}

/// Where a daemon-owned tab's shell currently is.
pub fn cwd(id: &str) -> Option<String> {
    query::<CwdReply>(&Command::Cwd { id: id.to_string() }).ok()?.cwd
}

/// Stops (SIGTERM) `pid` if it listens on a port in tab `id`'s process tree.
/// Errors carry a message for the user.
pub fn stop_listener(id: &str, pid: u32) -> Result<(), String> {
    let cmd = Command::StopListener { id: id.to_string(), pid };
    let reply = query::<StopReply>(&cmd).map_err(|_| "The terminal daemon did not answer")?;
    reply.error.map_or(Ok(()), Err)
}

/// What this GUI told the daemon for `thel session`. A daemon that was
/// restarted, or that dropped the old connection, knows none of it, so each new
/// connection sends it again.
#[derive(Default)]
struct SessionReplay {
    notes_dir: Option<PathBuf>,
    /// Each window's last report. A window that left keeps its empty one, so
    /// a daemon that missed it still drops that window's sessions.
    directory: Directory,
}

impl SessionReplay {
    fn commands(&self) -> Vec<Command> {
        let mut cmds: Vec<Command> = self
            .directory
            .iter()
            .map(|(window, sessions)| Command::Directory {
                window: window.clone(),
                sessions: sessions.clone(),
            })
            .collect();
        cmds.extend(self.notes_dir.clone().map(|notes_dir| Command::Watch { notes_dir }));
        cmds
    }
}

static SESSION_REPLAY: LazyLock<Mutex<SessionReplay>> = LazyLock::new(Default::default);

/// The app the GUI's connection hands `thel session` events to.
static SESSION_APP: OnceLock<tauri::AppHandle> = OnceLock::new();

fn session_event(name: &'static str, payload: impl Serialize) {
    if let (Some(app), Ok(v)) = (SESSION_APP.get(), serde_json::to_value(payload)) {
        // Fails only once the app is shutting down, when no window is left to
        // show it; the daemon keeps what waits for the next start.
        let _ = tauri::Emitter::emit(app, name, v);
    }
}

/// Sends `cmd` on the GUI's connection.
fn send_command(cmd: &Command) -> Result<(), String> {
    let c = client()?;
    on_client_error(c.send_frame(CONTROL, &serde_json::to_vec(cmd).unwrap_or_default()))
}

/// Has the daemon send this GUI `thel session` events: every terminal started
/// for it, every approval to ask (the waiting ones first) and every notes
/// change. `notes_dir` is where the GUI keeps session notes. The first call's
/// `app` gets them all; later calls just replay what is waiting.
pub fn watch(notes_dir: PathBuf, app: tauri::AppHandle) -> Result<(), String> {
    // Already set by an earlier call, which keeps getting them.
    let _ = SESSION_APP.set(app);
    SESSION_REPLAY.lock().notes_dir = Some(notes_dir.clone());
    send_command(&Command::Watch { notes_dir })
}

/// Passes on the user's answer to a sandboxed caller's request.
pub fn answer(req: u64, allow: bool, remember: bool) -> Result<(), String> {
    send_command(&Command::Answer { req, allow, remember })
}

/// Reports a window's sessions, so `thel session` can find and list them.
pub fn report_sessions(window: String, sessions: Vec<DirSession>) -> Result<(), String> {
    // Sent under the replay lock, so two reports reach the daemon in the order
    // they were recorded and the last one wins on both sides. The client
    // comes first: a reconnect takes the replay lock after the client's.
    let c = client()?;
    let mut replay = SESSION_REPLAY.lock();
    replay.directory.insert(window.clone(), sessions.clone());
    let res = c.send_frame(CONTROL, &serde_json::to_vec(&Command::Directory { window, sessions }).unwrap_or_default());
    drop(replay);
    on_client_error(res)
}

/// Send a `thel session` request and wait for the daemon's answer.
pub fn session_request(req: &Request) -> Result<Reply, String> {
    query(&Command::Session { req: req.clone() })
}

/// Post a notification for `id` through the daemon (out-of-band, no tty needed).
/// Returns whether it was handed off, which says the daemon accepted the frame,
/// not that it owns the tab. Used by `thel notify` when a daemon is running.
pub fn send_notify(id: &str, message: &str) -> bool {
    query_send(&Command::Notify {
        id: id.to_string(),
        message: message.to_string(),
    })
    .is_ok()
}

fn client_read_loop(mut r: UnixStream, routes: Arc<Mutex<HashMap<String, Channel<TermMsg>>>>) {
    // Per-tab UTF-8 carry: tabs interleave on this one connection, so a
    // multibyte char split across OUTPUT frames must be reassembled per id.
    let mut carries: HashMap<String, Vec<u8>> = HashMap::new();
    loop {
        match read_frame(&mut r) {
            Ok((OUTPUT, p)) => {
                if let Some((id, data)) = parse_id_payload(&p) {
                    let text = decode_utf8_stream(carries.entry(id.clone()).or_default(), data);
                    if !text.is_empty() {
                        if let Some(ch) = routes.lock().get(&id) {
                            let _ = ch.send(TermMsg::Data { data: text });
                        }
                    }
                }
            }
            Ok((CONTROL, p)) => match parse_json::<Event>(&p) {
                Some(Event::TabExited { id, code }) => {
                    if let Some(ch) = routes.lock().get(&id) {
                        let _ = ch.send(TermMsg::Exit { code });
                    }
                    routes.lock().remove(&id);
                    carries.remove(&id);
                }
                Some(Event::TabBusy { id, busy }) => {
                    if let Some(ch) = routes.lock().get(&id) {
                        let _ = ch.send(TermMsg::Busy { busy });
                    }
                }
                Some(Event::TabNotify { id, message }) => {
                    if let Some(ch) = routes.lock().get(&id) {
                        let _ = ch.send(TermMsg::Notify { message });
                    }
                }
                Some(Event::TabPorts { id, ports }) => {
                    if let Some(ch) = routes.lock().get(&id) {
                        let _ = ch.send(TermMsg::Ports { ports });
                    }
                }
                Some(Event::TabIdle { id, idle }) => {
                    if let Some(ch) = routes.lock().get(&id) {
                        let _ = ch.send(TermMsg::Idle { idle });
                    }
                }
                Some(Event::Error { id, message }) => {
                    eprintln!("[thel] daemon error for {id}: {message}");
                }
                Some(Event::Adopt { adopt }) => session_event("thel-session-adopt", adopt),
                Some(Event::Claimed { terminal }) => session_event("thel-session-claimed", terminal),
                Some(Event::Approve { approval }) => session_event("thel-session-approve", approval),
                Some(Event::Resolved { req }) => session_event("thel-session-resolved", req),
                Some(Event::Note(change)) => session_event("thel-session-note", change),
                None => {}
            },
            _ => break, // EOF / error: daemon gone
        }
    }
}

/// Result of probing the running daemon (if any) with a handshake.
enum Probe {
    /// A compatible daemon accepted us; carries the live connection + its build.
    Ready(UnixStream, String),
    /// A daemon is running but speaks a different protocol (incompatible version).
    Skew,
    /// No daemon reachable.
    None,
}

fn probe_existing() -> Probe {
    let Ok(mut stream) = UnixStream::connect(socket_path()) else {
        return Probe::None;
    };
    let hello = serde_json::to_vec(&Hello {
        protocol: PROTOCOL_VERSION,
        build: build_version(),
    })
    .unwrap_or_default();
    if write_frame(&mut stream, CONTROL, &hello).is_err() {
        return Probe::None;
    }
    match read_frame(&mut stream) {
        Ok((CONTROL, p)) => match parse_json::<HelloReply>(&p) {
            Some(reply) if reply.ok => Probe::Ready(stream, reply.build),
            // Reachable but rejected us with a different protocol: an older,
            // incompatible daemon is still running.
            Some(reply) if reply.protocol != PROTOCOL_VERSION => Probe::Skew,
            _ => Probe::None,
        },
        _ => Probe::None,
    }
}

fn connect_or_spawn() -> Result<(UnixStream, String), String> {
    match probe_existing() {
        Probe::Ready(s, build) => return Ok((s, build)),
        // Don't spawn over an incompatible daemon (it holds the socket); the GUI
        // resolves this via the restart prompt.
        Probe::Skew => return Err("thel daemon version mismatch".into()),
        Probe::None => {}
    }
    spawn_daemon()?;
    for _ in 0..100 {
        std::thread::sleep(Duration::from_millis(30));
        if let Probe::Ready(s, build) = probe_existing() {
            return Ok((s, build));
        }
    }
    Err("thel daemon did not become ready".into())
}

/// Probe the running daemon for the GUI's startup check: "ok", "skew" (an
/// incompatible version is running), or "none" (nothing to talk to yet).
pub fn check() -> &'static str {
    match probe_existing() {
        Probe::Ready(..) => "ok",
        Probe::Skew => "skew",
        Probe::None => "none",
    }
}

/// Kill the running daemon by its pid and clear its socket so a fresh one can
/// bind. Closing the daemon hangs up its PTYs, ending the running sessions, which
/// is why the GUI warns before calling this.
pub fn restart() -> Result<(), String> {
    if let Ok(s) = std::fs::read_to_string(pid_path()) {
        if let Ok(pid) = s.trim().parse::<i32>() {
            // Only signal it if it's actually our daemon, so a recycled pid in a
            // stale file can't get killed.
            if is_thel_daemon(pid) {
                unsafe { libc::kill(pid, libc::SIGTERM) };
                let mut alive = true;
                for _ in 0..40 {
                    std::thread::sleep(Duration::from_millis(50));
                    if unsafe { libc::kill(pid, 0) } != 0 {
                        alive = false; // process is gone
                        break;
                    }
                }
                // Only force-kill if it's still alive AND still our daemon:
                // during the grace it may have exited and the pid been recycled
                // to an unrelated process, which we must not SIGKILL.
                if alive && is_thel_daemon(pid) {
                    unsafe { libc::kill(pid, libc::SIGKILL) };
                }
            }
        }
    }
    // Fallback for a missing/stale pid file (e.g. a daemon started before pid
    // files existed): kill any of our daemons found by scanning processes.
    kill_stray_daemons();
    let _ = std::fs::remove_file(socket_path());
    let _ = std::fs::remove_file(pid_path());
    *client_cell().lock() = None; // force a fresh connect/spawn next time
    Ok(())
}

/// Kill any process running THIS binary as the daemon. Covers a missing/stale pid
/// file; across a real update the old daemon runs a different binary, so the pid
/// file (not this) handles that case.
#[cfg(any(target_os = "linux", target_os = "macos"))]
fn kill_stray_daemons() {
    let Ok(exe) = std::env::current_exe() else {
        return;
    };
    for pid in all_pids() {
        if proc_exe(pid).as_deref() == Some(exe.as_path()) && is_thel_daemon(pid) {
            unsafe { libc::kill(pid, libc::SIGKILL) };
        }
    }
}

#[cfg(not(any(target_os = "linux", target_os = "macos")))]
fn kill_stray_daemons() {}

/// The executable path a pid is running, for matching a daemon against our own
/// binary. Linux reads `/proc/<pid>/exe`; macOS asks `proc_pidpath`.
#[cfg(target_os = "linux")]
fn proc_exe(pid: i32) -> Option<PathBuf> {
    std::fs::read_link(format!("/proc/{pid}/exe")).ok()
}

#[cfg(target_os = "macos")]
fn proc_exe(pid: i32) -> Option<PathBuf> {
    let mut buf = [0u8; libc::PROC_PIDPATHINFO_MAXSIZE as usize];
    let n = unsafe {
        libc::proc_pidpath(pid, buf.as_mut_ptr() as *mut libc::c_void, buf.len() as u32)
    };
    if n <= 0 {
        return None;
    }
    let s = std::str::from_utf8(&buf[..n as usize]).ok()?;
    Some(PathBuf::from(s))
}

/// Confirm a pid is a thel daemon (its argv contains `__daemon`) before killing.
#[cfg(target_os = "linux")]
fn is_thel_daemon(pid: i32) -> bool {
    std::fs::read(format!("/proc/{pid}/cmdline"))
        .map(|c| c.split(|&b| b == 0).any(|a| a == DAEMON_ARG.as_bytes()))
        .unwrap_or(false)
}

/// macOS argv via sysctl `KERN_PROCARGS2`. The blob is `[i32 argc][exec path\0]
/// [padding][argv0\0 argv1\0 ...][env...]`; splitting on NUL and matching the
/// `__daemon` token mirrors the Linux `/proc/<pid>/cmdline` check. Reading argv
/// of another user's process is denied, but every thel daemon shares our uid.
#[cfg(target_os = "macos")]
fn is_thel_daemon(pid: i32) -> bool {
    let mut mib = [libc::CTL_KERN, libc::KERN_PROCARGS2, pid];
    let mut size: libc::size_t = 0;
    // First call sizes the buffer.
    if unsafe {
        libc::sysctl(
            mib.as_mut_ptr(),
            mib.len() as libc::c_uint,
            std::ptr::null_mut(),
            &mut size,
            std::ptr::null_mut(),
            0,
        )
    } != 0
        || size == 0
    {
        return false;
    }
    let mut buf = vec![0u8; size];
    if unsafe {
        libc::sysctl(
            mib.as_mut_ptr(),
            mib.len() as libc::c_uint,
            buf.as_mut_ptr() as *mut libc::c_void,
            &mut size,
            std::ptr::null_mut(),
            0,
        )
    } != 0
    {
        return false;
    }
    buf.truncate(size);
    buf.split(|&b| b == 0).any(|a| a == DAEMON_ARG.as_bytes())
}

#[cfg(not(any(target_os = "linux", target_os = "macos")))]
fn is_thel_daemon(_pid: i32) -> bool {
    true // best-effort elsewhere; restart is only offered after a live probe
}

fn spawn_daemon() -> Result<(), String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let _ = std::fs::create_dir_all(runtime_dir());
    let stderr = if cfg!(debug_assertions) {
        std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(runtime_dir().join("daemon.log"))
            .map(std::process::Stdio::from)
            .unwrap_or_else(|_| std::process::Stdio::null())
    } else {
        std::process::Stdio::null()
    };
    std::process::Command::new(exe)
        .arg(DAEMON_ARG)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(stderr)
        .spawn()
        .map_err(|e| format!("failed to spawn thel daemon: {e}"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    #[test]
    fn strips_query_replies_keeps_content() {
        // OSC color queries + CPR query interleaved with real output.
        let input =
            b"hi\x1b]11;?\x07there\x1b[6n\x1b[0mdone\x1b]10;?\x1b\\!\x1b[c".to_vec();
        let out = strip_queries(&input);
        assert_eq!(out, b"hithere\x1b[0mdone!");
    }

    #[test]
    fn strips_decrqm_mode_queries_keeps_other_p_finals() {
        // The synchronized-output probe (DECRQM): replaying it makes xterm
        // answer `ESC[?2026;0$y` into the live shell.
        let input = b"a\x1b[?2026$pb\x1b[4$pc".to_vec();
        assert_eq!(strip_queries(&input), b"abc");
        // DECSTR (soft reset, `!p`) is not a query and must survive.
        let reset = b"\x1b[!pok".to_vec();
        assert_eq!(strip_queries(&reset), reset);
    }

    #[test]
    fn keeps_non_query_osc_and_csi() {
        // A title-set OSC and an SGR must survive untouched.
        let input = b"\x1b]0;title\x07\x1b[31mred\x1b[0m".to_vec();
        assert_eq!(strip_queries(&input), input);
    }

    #[test]
    fn keeps_osc_with_question_mark_that_is_not_a_query() {
        // A hyperlink URL and a title can contain '?' without being a color
        // query; only a bare "?" parameter (body ending ";?") is stripped.
        let link = b"\x1b]8;;https://e.com/p?q=1\x1b\\text\x1b]8;;\x1b\\".to_vec();
        assert_eq!(strip_queries(&link), link);
        let title = b"\x1b]0;ready?\x07ok".to_vec();
        assert_eq!(strip_queries(&title), title);
    }

    #[test]
    fn strips_clipboard_writes_from_replay() {
        // OSC 52 sets the clipboard. Replaying one would silently overwrite
        // whatever the user copied since, every time the tab reattaches.
        let input = b"a\x1b]52;c;aGVsbG8=\x07b\x1b]52;;d29ybGQ=\x1b\\c".to_vec();
        assert_eq!(strip_queries(&input), b"abc");
        // OSC 5-something-else is not a clipboard write and must survive.
        let other = b"\x1b]521;x\x07ok".to_vec();
        assert_eq!(strip_queries(&other), other);
    }

    #[test]
    fn preserves_incomplete_escape_sequences_at_chunk_boundaries() {
        // Truncated CSI sequence at end of chunk.
        let csi = b"hello\x1b[6".to_vec();
        assert_eq!(strip_queries(&csi), csi);

        // Truncated OSC sequence at end of chunk (no BEL or ST yet).
        let osc = b"hello\x1b]11;?".to_vec();
        assert_eq!(strip_queries(&osc), osc);

        let osc_title = b"hello\x1b]0;title".to_vec();
        assert_eq!(strip_queries(&osc_title), osc_title);
    }

    fn blank_tab() -> TabShared {
        TabShared {
            parser: vt100::Parser::new(24, 80, 100),
            scrollback: VecDeque::new(),
            subscribers: Vec::new(),
            ports: Vec::new(),
            idle: false,
            ended: None,
        }
    }

    fn tab_with(normal: &[u8], alt: &[u8]) -> TabShared {
        let mut sh = blank_tab();
        sh.parser.process(normal);
        sh.scrollback.extend(normal.iter().copied());
        // Alt-screen output is deliberately kept out of the scrollback, as the
        // reader does.
        sh.parser.process(alt);
        sh
    }

    /// Byte offset of `needle` in `hay`.
    fn find(hay: &[u8], needle: &[u8]) -> Option<usize> {
        hay.windows(needle.len()).position(|w| w == needle)
    }

    #[test]
    fn alt_screen_snapshot_replays_scrollback_then_switches_screens() {
        let normal = b"$ ls\r\nnotes.txt\r\n$ less notes.txt\r\n";
        let sh = tab_with(normal, b"\x1b[?1049h\x1b[HPAGERTEXT");
        assert!(sh.parser.screen().alternate_screen());

        let snap = snapshot(&sh);
        let scrollback = find(&snap, normal).expect("scrollback replayed");
        let enter = find(&snap, b"\x1b[?1049h").expect("alt screen entered");
        let alt = find(&snap, b"PAGERTEXT").expect("alt screen contents");
        // Order matters: the client needs its normal buffer filled before the
        // switch, or exiting the pager restores the pager's own screen.
        assert!(scrollback < enter, "scrollback must precede the switch");
        assert!(enter < alt, "the switch must precede the alt contents");
    }

    #[test]
    fn normal_screen_snapshot_is_scrollback_only() {
        let normal = b"$ echo hi\r\nhi\r\n";
        let sh = tab_with(normal, b"\x1b[?1049h\x1b[HPAGERTEXT\x1b[?1049l");
        assert!(!sh.parser.screen().alternate_screen());

        let snap = snapshot(&sh);
        assert_eq!(snap, normal.to_vec());
    }

    #[test]
    fn subscriber_ref_counting_handles_overlapping_attach_detach() {
        let (a, _b) = std::os::unix::net::UnixStream::pair().unwrap();
        let client = Client::spawn(&a).unwrap();

        let mut sh = blank_tab();

        // Attach from background listener (count 1).
        sh.subscribers.push(Subscriber {
            client: client.clone(),
            count: 1,
        });
        assert_eq!(sh.subscribers.len(), 1);
        assert_eq!(sh.subscribers[0].count, 1);

        // Attach from active pane (count 2).
        if let Some(sub) = sh.subscribers.iter_mut().find(|s| Arc::ptr_eq(&s.client, &client)) {
            sub.count += 1;
        }
        assert_eq!(sh.subscribers.len(), 1);
        assert_eq!(sh.subscribers[0].count, 2);

        // Detach from background listener (count 1, remains subscribed).
        if let Some(pos) = sh.subscribers.iter().position(|s| Arc::ptr_eq(&s.client, &client)) {
            sh.subscribers[pos].count = sh.subscribers[pos].count.saturating_sub(1);
            if sh.subscribers[pos].count == 0 {
                sh.subscribers.swap_remove(pos);
            }
        }
        assert_eq!(sh.subscribers.len(), 1);
        assert_eq!(sh.subscribers[0].count, 1);

        // Detach from active pane (count 0, removed).
        if let Some(pos) = sh.subscribers.iter().position(|s| Arc::ptr_eq(&s.client, &client)) {
            sh.subscribers[pos].count = sh.subscribers[pos].count.saturating_sub(1);
            if sh.subscribers[pos].count == 0 {
                sh.subscribers.swap_remove(pos);
            }
        }
        assert_eq!(sh.subscribers.len(), 0);
    }

    /// Opens tab "caller" running a shell, and returns its pid.
    fn caller_tab(d: &Arc<Daemon>) -> u32 {
        d.open("caller", "sh".into(), vec![], Some("/".into()), None, 80, 24, None).unwrap();
        d.tabs.lock()["caller"].child.lock().process_id().unwrap()
    }

    /// A peer `pid`, in `d`'s tab "caller" when `sandboxed`.
    fn peer(d: &Daemon, pid: Option<u32>, sandboxed: bool) -> Peer {
        let tab = sandboxed.then(|| ("caller".into(), Arc::downgrade(&d.tabs.lock()["caller"].shared)));
        Peer { pid, sandboxed, tab, program: None, fd: -1 }
    }

    /// A terminal started for `thel session` that ends before any GUI shows it
    /// stays on the waiting list, and the GUI opening it later gets its exit
    /// instead of a second run.
    #[test]
    fn an_unshown_terminal_that_ended_is_not_run_again() {
        let d = Daemon::new();
        let pid = caller_tab(&d);
        let inside = peer(&d, Some(pid), false);
        let req = Request::New { name: None, cwd: "/".into(), command: vec!["true".into()] };
        let id = d.session(&inside, req).terminal.expect("a terminal id");
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        // The exit is kept before the tab goes, so wait for both.
        while d.adopts.lock().iter().all(|(_, exit)| exit.is_none()) || d.tabs.lock().contains_key(&id) {
            assert!(std::time::Instant::now() < deadline, "the terminal never ended");
            std::thread::sleep(Duration::from_millis(10));
        }
        assert!(d.adopts.lock().iter().any(|(a, _)| a.terminal == id));

        let (a, mut b) = std::os::unix::net::UnixStream::pair().unwrap();
        b.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
        let client = Client::spawn(&a).unwrap();
        let open = Command::Open {
            id: id.clone(),
            command: "true".into(),
            args: vec![],
            cwd: None,
            env: None,
            cols: 80,
            rows: 24,
        };
        d.watchers.lock().push(client.clone());
        dispatch(&d, open, &client, &peer(&d, None, false));

        // Every window hears it is placed, so none holds it back to place again.
        let mut next = || parse_json::<Event>(&read_frame(&mut b).unwrap().1);
        assert!(matches!(next(), Some(Event::Claimed { terminal }) if terminal == id));
        match next() {
            Some(Event::TabExited { id: got, code }) => assert_eq!((got, code), (id.clone(), Some(0))),
            _ => panic!("expected TabExited"),
        }
        assert!(!d.tabs.lock().contains_key(&id), "ran again");
        assert!(d.adopts.lock().is_empty());
        // So does closing one no window opened yet.
        let req = Request::New { name: None, cwd: "/".into(), command: vec!["sleep".into(), "10".into()] };
        let id = d.session(&inside, req).terminal.expect("a terminal id");
        assert!(matches!(next(), Some(Event::Adopt { .. })));
        d.kill(&id);
        assert!(matches!(next(), Some(Event::Claimed { terminal }) if terminal == id));
        d.kill("caller");
    }

    #[test]
    fn reattach_queues_the_ports_after_the_snapshot() {
        let (a, mut b) = std::os::unix::net::UnixStream::pair().unwrap();
        b.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
        let client = Client::spawn(&a).unwrap();
        let port = crate::pty::ListenPort { port: 5173, pid: 42, name: "node".into() };
        let mut sh = TabShared { ports: vec![port.clone()], ..blank_tab() };

        reattach(&mut sh, "t1", &client);

        let (ty, p) = read_frame(&mut b).unwrap();
        assert_eq!((ty, parse_id_payload(&p).map(|(id, _)| id)), (OUTPUT, Some("t1".into())));
        let (ty, p) = read_frame(&mut b).unwrap();
        assert_eq!(ty, CONTROL);
        match parse_json::<Event>(&p) {
            Some(Event::TabPorts { id, ports }) => assert_eq!((id.as_str(), ports), ("t1", vec![port])),
            _ => panic!("expected TabPorts after the snapshot"),
        }
        assert_eq!(sh.subscribers.len(), 1);
    }

    #[test]
    fn kill_session_rejects_invalid_sids() {
        // Must safely return without attempting to signal PID 0 or PID 1.
        kill_session(-1);
        kill_session(0);
        kill_session(1);
    }

    /// A program in one tab opens a session and a terminal, lists them and
    /// types into one; the same requests from outside any tab, or from a
    /// sandboxed program, are refused.
    #[test]
    fn a_program_in_a_tab_drives_sessions() {
        let d = Daemon::new();
        let pid = caller_tab(&d);
        d.directory.lock().insert(
            "main".into(),
            vec![DirSession { id: "s1".into(), name: "api".into(), terminals: vec!["caller".into()] }],
        );
        let inside = peer(&d, Some(pid), false);
        let ask = |peer: &Peer, req: Request| d.session(peer, req);

        let new = ask(&inside, Request::New { name: None, cwd: "/tmp".into(), command: vec![] });
        let new_id = new.terminal.expect("a terminal id");
        let term = ask(&inside, Request::Terminal { session: None, cwd: "/".into(), command: vec!["cat".into()] });
        let cat = term.terminal.expect("a terminal id");
        assert_eq!(
            d.adopts.lock().iter().map(|(a, _)| a.place.clone()).collect::<Vec<_>>(),
            [
                Place::NewSession { name: "tmp".into(), window: Some("main".into()) },
                Place::Session { id: "s1".into() },
            ]
        );
        assert!(d.adopts.lock().iter().all(|(a, _)| !a.sandboxed));

        let listed = ask(&inside, Request::List { all: false }).sessions;
        assert!(listed.iter().any(|l| l.id.as_deref() == Some("s1")
            && l.terminals.iter().any(|t| t.id == cat && t.state == crate::session::TerminalState::Starting)));
        assert!(ask(&inside, Request::SendKeys { terminal: cat.clone(), data: b"hi\r".to_vec() })
            .error
            .is_none());
        let err = |r: Reply| r.error.unwrap_or_default();
        assert_eq!(
            err(ask(&inside, Request::SendKeys { terminal: "nope".into(), data: vec![] })),
            "no terminal nope"
        );
        let nope = Request::Terminal { session: Some("nope".into()), cwd: "/".into(), command: vec![] };
        assert!(err(ask(&inside, nope)).contains("no session named or with id \"nope\""));

        let outside = peer(&d, Some(std::process::id()), false);
        assert!(ask(&outside, Request::List { all: false }).error.unwrap().contains("inside a thel terminal"));
        // A sandboxed program may list, but must ask for the rest (see
        // a_sandboxed_request_waits_for_the_users_answer).
        let sandboxed = peer(&d, Some(pid), true);
        assert!(ask(&sandboxed, Request::List { all: false }).error.is_none());

        for id in ["caller".to_string(), new_id, cat] {
            d.kill(&id);
        }
        assert!(d.adopts.lock().is_empty());
    }

    /// `thel session note` reads and edits the caller's session notes, or
    /// another's by name, and tells the watching GUIs what changed.
    #[test]
    fn a_program_in_a_tab_edits_session_notes() {
        use crate::session::NoteEdit;
        let d = Daemon::new();
        let pid = caller_tab(&d);
        d.directory.lock().insert(
            "main".into(),
            vec![
                DirSession { id: "s1".into(), name: "api".into(), terminals: vec!["caller".into()] },
                DirSession { id: "s2".into(), name: "web".into(), terminals: vec![] },
            ],
        );
        let inside = peer(&d, Some(pid), false);
        let note = |session: Option<&str>, edit: Option<NoteEdit>| {
            d.session(&inside, Request::Note { session: session.map(Into::into), edit })
        };

        assert!(note(None, None).error.unwrap().contains("no thel window"));
        let tmp = crate::session::TestDir::new("thel-notes");
        let dir = tmp.0.clone();
        *d.notes_dir.lock() = Some(dir.clone());

        assert_eq!(note(None, None).note.as_deref(), Some(""));
        let add = |t: &str| Some(NoteEdit::Append { text: t.into() });
        note(None, add("one"));
        assert_eq!(note(None, add("two")).note, None, "an edit doesn't read the notes back");
        assert_eq!(note(None, None).note.as_deref(), Some("one\ntwo\n"));
        assert_eq!(std::fs::read_to_string(dir.join("s1.md")).unwrap(), "one\ntwo\n");
        note(Some("web"), Some(NoteEdit::Set { text: "w".into() }));
        assert_eq!(note(Some("s2"), None).note.as_deref(), Some("w"));
        note(Some("web"), Some(NoteEdit::Set { text: String::new() }));
        assert!(!dir.join("s2.md").exists(), "cleared notes leave no file");
        assert!(note(Some("nope"), None).error.is_some());

        // Appends from programs running at once all land.
        std::thread::scope(|s| {
            for i in 0..8 {
                let note = &note;
                s.spawn(move || {
                    for j in 0..10 {
                        note(Some("web"), add(&format!("{i}.{j}")));
                    }
                });
            }
        });
        assert_eq!(note(Some("web"), None).note.unwrap().lines().count(), 80);

        d.kill("caller");
    }

    /// Sends `req` from `peer` on another thread, for one that waits for an
    /// answer.
    #[cfg(target_os = "linux")]
    fn ask_bg(d: &Arc<Daemon>, peer: &Peer, req: Request) -> std::thread::JoinHandle<Reply> {
        let (d, peer) = (d.clone(), peer.clone());
        std::thread::spawn(move || d.session(&peer, req))
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn a_sandboxed_program_asks_before_reading_notes() {
        let d = Daemon::new();
        caller_tab(&d);
        d.directory.lock().insert(
            "main".into(),
            vec![
                DirSession { id: "s1".into(), name: "api".into(), terminals: vec!["caller".into()] },
                DirSession { id: "s2".into(), name: "web".into(), terminals: vec!["t2".into()] },
                DirSession { id: "s3".into(), name: "web".into(), terminals: vec![] },
            ],
        );
        let peer = peer(&d, None, true);
        let waiter = ask_bg(&d, &peer, Request::Note { session: Some("s2".into()), edit: None });
        // The prompt names the session the id stands for.
        let a = first_approval(&d);
        assert_eq!(a.summary, "read the notes of session \"web\" (id s2)");
        d.answer(a.req, false, false);
        assert_eq!(waiter.join().unwrap().error.as_deref(), Some("denied in thel"));

        // An allowed request acts on the session it was allowed for, not on
        // one that took its place under a name like its id.
        d.denied.lock().clear();
        let waiter = ask_bg(&d, &peer, Request::Note { session: Some("s2".into()), edit: None });
        let a = first_approval(&d);
        d.directory.lock().get_mut("main").unwrap()[1] =
            DirSession { id: "s9".into(), name: "s2".into(), terminals: vec![] };
        d.answer(a.req, true, false);
        assert_eq!(waiter.join().unwrap().error.as_deref(), Some("the session this was allowed for closed"));

        d.kill("caller");
    }

    /// A sandboxed program gets one question at a time per terminal, and a
    /// request too long to show in full is refused without asking.
    #[cfg(target_os = "linux")]
    #[test]
    fn a_sandboxed_program_cant_flood_the_prompt() {
        let d = Daemon::new();
        let pid = caller_tab(&d);
        let peer = peer(&d, Some(pid), true);
        let long = Request::SendKeys { terminal: "caller".into(), data: vec![b'x'; APPROVAL_SUMMARY_MAX] };
        let err = d.session(&peer, long).error.unwrap();
        assert!(err.contains("too long"), "{err}");
        assert!(d.approvals.lock().is_empty());

        let keys = || Request::SendKeys { terminal: "caller".into(), data: b"ls".to_vec() };
        let waiter = ask_bg(&d, &peer, keys());
        let req = first_approval(&d).req;
        let err = d.session(&peer, keys()).error.unwrap();
        assert!(err.contains("already waiting"), "{err}");
        // Whatever it names, so a wait tells it nothing about what is there.
        let note = Request::Note { session: Some("nope".into()), edit: None };
        let folder = Request::New { name: None, cwd: "/nope".into(), command: vec![] };
        for req in [note, folder] {
            assert!(d.session(&peer, req).error.unwrap().contains("already waiting"));
        }
        d.answer(req, false, false);
        assert_eq!(waiter.join().unwrap().error.as_deref(), Some("denied in thel"));
        d.kill("caller");
    }

    /// A question shown in a window that leaves is asked again in another.
    #[cfg(target_os = "linux")]
    #[test]
    fn a_window_that_leaves_hands_on_its_questions() {
        let d = Daemon::new();
        caller_tab(&d);
        let api = DirSession { id: "s1".into(), name: "api".into(), terminals: vec!["caller".into()] };
        d.report("w1".into(), vec![api]);
        d.report("w2".into(), vec![DirSession { id: "s2".into(), name: "web".into(), terminals: vec![] }]);
        let peer = peer(&d, None, true);
        let waiter = ask_bg(&d, &peer, Request::SendKeys { terminal: "caller".into(), data: b"ls".to_vec() });
        assert_eq!(first_approval(&d).window.as_deref(), Some("w1"));
        d.report("w1".into(), vec![]);
        let a = first_approval(&d);
        assert_eq!(a.window.as_deref(), Some("w2"));
        d.answer(a.req, false, false);
        waiter.join().unwrap();
        d.kill("caller");
    }

    /// A terminal asked to start in a folder that isn't there doesn't start.
    #[test]
    fn a_terminal_starts_only_in_a_folder() {
        let d = Daemon::new();
        let start = |cwd: &str| d.start(vec![], cwd.into(), Place::Session { id: "s1".into() }, false);
        assert_eq!(start("/nope").unwrap_err(), "no folder /nope");
        assert!(d.adopts.lock().is_empty());
    }

    /// A sandboxed list shows the caller's session and the ones it started
    /// without asking, and every session after a yes.
    #[cfg(target_os = "linux")]
    #[test]
    fn a_sandboxed_list_shows_what_it_started_and_asks_for_the_rest() {
        let d = Daemon::new();
        caller_tab(&d);
        d.directory.lock().insert(
            "main".into(),
            vec![
                DirSession { id: "s1".into(), name: "api".into(), terminals: vec!["caller".into()] },
                DirSession { id: "s2".into(), name: "web".into(), terminals: vec!["t2".into()] },
            ],
        );
        let peer = peer(&d, None, true);
        let names = |r: Reply| r.sessions.into_iter().map(|l| l.name).collect::<Vec<_>>();
        let new = Request::New { name: Some("dev".into()), cwd: "/".into(), command: vec!["cat".into()] };
        let waiter = ask_bg(&d, &peer, new);
        d.answer(first_approval(&d).req, true, false);
        let dev = waiter.join().unwrap().terminal.expect("a terminal id");
        assert_eq!(names(d.session(&peer, Request::List { all: false })), ["api", "dev"]);

        // Once a window shows it, the session has an id and still lists.
        d.adopts.lock().clear();
        d.directory.lock().get_mut("main").unwrap().push(DirSession {
            id: "s3".into(),
            name: "dev".into(),
            terminals: vec![dev.clone()],
        });
        assert_eq!(names(d.session(&peer, Request::List { all: false })), ["api", "dev"]);

        let waiter = ask_bg(&d, &peer, Request::List { all: true });
        let a = first_approval(&d);
        assert_eq!(a.summary, "list every session and its terminals");
        d.answer(a.req, true, false);
        assert_eq!(names(waiter.join().unwrap()), ["api", "web", "dev"]);
        d.kill(&dev);
        d.kill("caller");
        assert!(d.started.lock().is_empty());
    }

    /// The first question waiting for an answer, once one comes in.
    #[cfg(target_os = "linux")]
    fn first_approval(d: &Daemon) -> Approval {
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        loop {
            if let Some((a, _)) = d.approvals.lock().first() {
                return a.clone();
            }
            assert!(std::time::Instant::now() < deadline, "no question came in");
            std::thread::sleep(Duration::from_millis(5));
        }
    }

    /// An allowed request acts on the session it was allowed for, not on one
    /// that took its place under a name like its id, and a sandboxed list
    /// shows only the caller's own session.
    #[cfg(target_os = "linux")]
    #[test]
    fn a_sandboxed_request_acts_on_the_session_it_was_allowed_for() {
        let d = Daemon::new();
        caller_tab(&d);
        d.directory.lock().insert(
            "main".into(),
            vec![
                DirSession { id: "s1".into(), name: "api".into(), terminals: vec!["caller".into()] },
                DirSession { id: "s2".into(), name: "web".into(), terminals: vec!["t2".into()] },
            ],
        );
        let peer = peer(&d, None, true);
        // A name it can't see gets the same answer whether it exists or not.
        let nope = Request::Terminal { session: Some("nope".into()), cwd: "/".into(), command: vec![] };
        assert_eq!(d.session(&peer, nope).error.as_deref(), Some("no session by that name or id"));
        assert!(d.approvals.lock().is_empty());
        let req = Request::Terminal { session: Some("s2".into()), cwd: "/".into(), command: vec![] };
        let waiter = ask_bg(&d, &peer, req);
        let a = first_approval(&d);
        assert_eq!(a.summary, "open a terminal running a shell in /, in session \"web\"");
        assert_eq!(a.caller_session.as_deref(), Some("session \"api\""));
        d.directory.lock().get_mut("main").unwrap()[1] =
            DirSession { id: "s9".into(), name: "s2".into(), terminals: vec![] };
        d.answer(a.req, true, false);
        assert_eq!(waiter.join().unwrap().error.as_deref(), Some("the session this was allowed for closed"));
        assert!(d.adopts.lock().is_empty());

        let listed = d.session(&peer, Request::List { all: false }).sessions;
        assert_eq!(listed.iter().map(|l| l.name.as_str()).collect::<Vec<_>>(), ["api"]);
        d.kill("caller");
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn a_sandboxed_request_waits_for_the_users_answer() {
        let d = Daemon::new();
        let pid = caller_tab(&d);
        d.directory.lock().insert(
            "main".into(),
            vec![DirSession { id: "s1".into(), name: "api".into(), terminals: vec!["caller".into()] }],
        );
        let peer = Peer { program: Some((pid, start_time(pid).unwrap())), ..peer(&d, Some(pid), true) };
        let keys = || Request::SendKeys { terminal: "caller".into(), data: b"ls\r".to_vec() };
        let asking = {
            let (d, peer) = (d.clone(), peer.clone());
            move |answer: Option<(bool, bool)>| {
                let waiter = ask_bg(&d, &peer, keys());
                let a = first_approval(&d);
                assert_eq!(a.target.as_deref(), Some("caller"));
                assert_eq!(a.window.as_deref(), Some("main"));
                // The terminal's process stands in for the sandboxed program.
                assert!(a.program.is_some_and(|p| p.starts_with('/')), "names the program");
                let req = a.req;
                if let Some((allow, remember)) = answer {
                    d.answer(req, allow, remember);
                    // A no's pause is set as the answer lands, before the
                    // request wakes.
                    assert!(allow || d.denied.lock().contains_key("caller"));
                }
                waiter.join().unwrap()
            }
        };

        assert_eq!(asking(Some((false, false))).error.as_deref(), Some("denied in thel"));
        // A no holds back the next question, longer after each no.
        let again = || d.session(&peer, keys()).error.unwrap_or_default();
        let pause_over = || d.denied.lock().get_mut("caller").unwrap().0 = std::time::Instant::now();
        assert_eq!(again(), "denied in thel; ask again in 30 s");
        pause_over();
        assert_eq!(asking(Some((false, false))).error.as_deref(), Some("denied in thel"));
        assert_eq!(again(), "denied in thel; ask again in 60 s");
        pause_over();
        assert!(asking(Some((true, false))).error.is_none());
        assert!(d.denied.lock().is_empty());
        assert!(d.approvals.lock().is_empty());
        // Allowed for good: the next request goes through without asking.
        assert!(asking(Some((true, true))).error.is_none());
        assert!(d.session(&peer, keys()).error.is_none());
        let new = d.session(&peer, Request::New { name: None, cwd: "/".into(), command: vec![] });
        assert!(d.adopts.lock().iter().all(|(a, _)| a.sandboxed));
        d.kill(&new.terminal.expect("a terminal id"));
        assert!(d.approvals.lock().is_empty());
        // For that program only: another one in the terminal still asks.
        let other = Peer { program: Some((pid, 2)), ..peer.clone() };
        // One the prompt can't name is allowed once at most.
        let waiter = ask_bg(&d, &other, keys());
        let a = first_approval(&d);
        assert_eq!(a.program, None);
        d.answer(a.req, true, true);
        assert!(waiter.join().unwrap().error.is_none());
        assert_eq!(d.trusted.lock().get("caller"), peer.program.as_ref());
        let waiter = ask_bg(&d, &other, keys());
        d.answer(first_approval(&d).req, false, false);
        assert_eq!(waiter.join().unwrap().error.as_deref(), Some("denied in thel"));
        // Until the terminal ends.
        d.kill("caller");
        assert!(d.trusted.lock().is_empty());
    }

    /// A caller that hangs up while it waits takes its question with it, and
    /// one nobody answers gives up after the timeout.
    #[cfg(target_os = "linux")]
    #[test]
    fn a_question_ends_with_its_caller_or_its_timeout() {
        let mut d = Daemon::new();
        Arc::get_mut(&mut d).unwrap().approval_timeout = Duration::from_millis(300);
        caller_tab(&d);
        let keys = || Request::SendKeys { terminal: "caller".into(), data: b"ls".to_vec() };
        let (ours, theirs) = UnixStream::pair().unwrap();
        let peer = Peer { fd: ours.as_raw_fd(), ..peer(&d, None, true) };

        let waiter = ask_bg(&d, &peer, keys());
        first_approval(&d);
        // Bytes left unread don't hide the hangup.
        (&theirs).write_all(b"x").unwrap();
        drop(theirs);
        assert_eq!(waiter.join().unwrap().error.as_deref(), Some("the caller hung up"));
        assert!(d.approvals.lock().is_empty());
        // And pauses the terminal, so it can't swap in another question at once.
        assert!(d.session(&peer, keys()).error.unwrap().contains("ask again in 30 s"));
        d.denied.lock().get_mut("caller").unwrap().0 = std::time::Instant::now();

        // Also when an Allow comes in before the daemon noticed: it doesn't
        // lift the pause, which goes on doubling.
        let (ours2, theirs) = UnixStream::pair().unwrap();
        let late = Peer { fd: ours2.as_raw_fd(), ..peer.clone() };
        let waiter = ask_bg(&d, &late, keys());
        let req = first_approval(&d).req;
        drop(theirs);
        d.answer(req, true, false);
        assert_eq!(waiter.join().unwrap().error.as_deref(), Some("the caller hung up"));
        assert!(d.session(&peer, keys()).error.unwrap().contains("ask again in 60 s"));

        // Each question that goes unanswered lengthens the pause, like a no.
        d.denied.lock().insert("caller".into(), (std::time::Instant::now(), DENY_PAUSE));
        let alone = Peer { fd: -1, ..peer };
        assert!(d.session(&alone, keys()).error.unwrap().contains("no answer in thel"));
        assert!(d.approvals.lock().is_empty());
        assert!(d.session(&alone, keys()).error.unwrap().contains("ask again in 60 s"));
        d.kill("caller");
    }

    /// A terminal that ends takes its questions with it, and a yes that lands
    /// after the end can't trust it, nor can a question from it be asked.
    #[cfg(target_os = "linux")]
    #[test]
    fn a_question_ends_with_its_terminal() {
        let d = Daemon::new();
        caller_tab(&d);
        let peer = peer(&d, None, true);
        let keys = || Request::SendKeys { terminal: "caller".into(), data: b"ls".to_vec() };
        let waiter = ask_bg(&d, &peer, keys());
        let req = first_approval(&d).req;
        d.kill("caller");
        assert_eq!(waiter.join().unwrap().error.as_deref(), Some("the caller's terminal closed"));
        assert!(d.approvals.lock().is_empty());
        d.answer(req, true, true);
        assert!(d.trusted.lock().is_empty());
        assert_eq!(d.session(&peer, keys()).error.as_deref(), Some("the caller's terminal closed"));
        // Nor once a new tab takes its id.
        caller_tab(&d);
        assert_eq!(d.session(&peer, keys()).error.as_deref(), Some("the caller's terminal closed"));
        assert!(d.approvals.lock().is_empty());
        d.kill("caller");
    }

    /// A client attaching to a tab that already ended gets its exit at once.
    #[test]
    fn reattach_to_an_ended_tab_gets_its_exit() {
        let (a, mut b) = UnixStream::pair().unwrap();
        b.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
        let client = Client::spawn(&a).unwrap();
        let mut sh = TabShared { ended: Some(Some(3)), ..blank_tab() };
        reattach(&mut sh, "t1", &client);
        let (ty, p) = read_frame(&mut b).unwrap();
        assert_eq!(ty, CONTROL);
        assert!(matches!(
            parse_json::<Event>(&p),
            Some(Event::TabExited { id, code: Some(3) }) if id == "t1"
        ));
        assert!(sh.subscribers.is_empty());
    }

    /// A refused command that waits for a reply gets one.
    #[test]
    fn refused_commands_that_wait_get_an_answer() {
        let (a, mut b) = UnixStream::pair().unwrap();
        b.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
        let client = Client::spawn(&a).unwrap();
        refuse(Command::StopListener { id: "t".into(), pid: 1 }, &client);
        let (_, p) = read_frame(&mut b).unwrap();
        let reply = parse_json::<StopReply>(&p).unwrap();
        assert!(reply.error.unwrap().contains("sandboxed"));
        refuse(Command::Cwd { id: "t".into() }, &client);
        let (_, p) = read_frame(&mut b).unwrap();
        assert_eq!(parse_json::<CwdReply>(&p).unwrap().cwd, None);
    }

    /// A new connection tells the daemon the windows' sessions, then watches
    /// again; a GUI that never watched sends no Watch.
    #[test]
    fn a_new_connection_replays_what_the_gui_told_the_daemon() {
        let mut r = SessionReplay::default();
        assert!(r.commands().is_empty());
        let s = DirSession { id: "s1".into(), name: "api".into(), terminals: vec!["t1".into()] };
        r.directory.insert("main".into(), vec![s]);
        assert!(matches!(
            r.commands().as_slice(),
            [Command::Directory { window, sessions }] if window == "main" && sessions[0].id == "s1"
        ));
        r.notes_dir = Some("/n".into());
        assert!(matches!(
            r.commands().as_slice(),
            [Command::Directory { .. }, Command::Watch { notes_dir }] if notes_dir == Path::new("/n")
        ));
        // A window that closed for good is told again that it has nothing.
        r.directory.insert("main".into(), vec![]);
        assert!(matches!(
            r.commands().as_slice(),
            [Command::Directory { window, sessions }, Command::Watch { .. }] if window == "main" && sessions.is_empty()
        ));
    }

    /// A program is known by its start time, which stays put while it runs
    /// and comes after its parent's.
    #[cfg(target_os = "linux")]
    #[test]
    fn reads_a_start_time_that_stays_put() {
        let me = std::process::id();
        let first = start_time(me).expect("readable");
        let busy = std::time::Instant::now();
        while busy.elapsed() < Duration::from_millis(100) {
            std::hint::black_box(first);
        }
        assert_eq!(start_time(me), Some(first));
        assert!(first >= start_time(parent_pid(me).unwrap()).unwrap());
        let chain = steady_ancestry(me).expect("a steady chain");
        assert_eq!(chain[0], (me, first));
        assert!(sandbox_program(&chain).is_some());
        assert_eq!(exe_of(me, first), std::env::current_exe().ok().map(|e| e.to_string_lossy().into_owned()));
        assert_eq!(exe_of(me, first + 1), None);
    }

    #[test]
    fn reads_no_new_privs_from_proc_status() {
        assert!(status_no_new_privs("Name:\tsh\nNoNewPrivs:\t1\nSeccomp:\t0\n"));
        assert!(!status_no_new_privs("Name:\tsh\nNoNewPrivs:\t0\n"));
        assert!(!status_no_new_privs("Name:\tsh\n"), "older kernels lack the line");
    }

    #[test]
    fn a_sandboxed_peer_may_only_notify_and_read() {
        let id = || "t".to_string();
        let own = Some("t");
        assert!(Command::Notify { id: id(), message: "m".into() }.harmless(own));
        assert!(Command::Cwd { id: id() }.harmless(own));
        // Only for its own terminal.
        assert!(!Command::Notify { id: "u".into(), message: "m".into() }.harmless(own));
        assert!(!Command::Cwd { id: "u".into() }.harmless(own));
        assert!(!Command::Cwd { id: id() }.harmless(None));
        assert!(!Command::Kill { id: id() }.harmless(own));
        // They show every terminal's activity.
        assert!(!Command::Status.harmless(own) && !Command::Usage.harmless(own));
        assert!(!Command::Detach { id: id() }.harmless(own));
        assert!(!Command::Resize { id: id(), cols: 1, rows: 1 }.harmless(own));
        // Otherwise it could approve its own requests, or misplace them.
        assert!(!Command::Answer { req: 1, allow: true, remember: true }.harmless(own));
        assert!(!Command::Directory { window: "main".into(), sessions: vec![] }.harmless(own));
        assert!(!Command::Watch { notes_dir: "/n".into() }.harmless(own));
        let open = Command::Open {
            id: id(),
            command: "sh".into(),
            args: vec![],
            cwd: None,
            env: None,
            cols: 80,
            rows: 24,
        };
        assert!(!open.harmless(own));
    }

    /// The abstract socket address `name`, for a forked child to connect to
    /// with async-signal-safe calls only.
    #[cfg(target_os = "linux")]
    fn raw_abstract_addr(name: &str) -> (libc::sockaddr_un, libc::socklen_t) {
        // SAFETY: sockaddr_un is plain data, so all zeroes is a valid value.
        let mut sa: libc::sockaddr_un = unsafe { std::mem::zeroed() };
        sa.sun_family = libc::AF_UNIX as libc::sa_family_t;
        for (d, s) in sa.sun_path[1..].iter_mut().zip(name.bytes()) {
            *d = s as libc::c_char;
        }
        let len = (std::mem::size_of::<libc::sa_family_t>() + 1 + name.len()) as libc::socklen_t;
        (sa, len)
    }

    /// A peer that connects and is gone before the daemon looks at it reads as
    /// confined; a live one reads as what it is.
    #[cfg(target_os = "linux")]
    #[test]
    fn a_peer_gone_before_the_check_reads_as_confined() {
        use std::os::linux::net::SocketAddrExt;
        use std::os::unix::net::{SocketAddr, UnixListener};
        let name = format!("thel-test-peer-{}", std::process::id());
        let addr = || SocketAddr::from_abstract_name(&name).unwrap();
        let listener = UnixListener::bind_addr(&addr()).unwrap();

        let live = UnixStream::connect_addr(&addr()).unwrap();
        let (accepted, _) = listener.accept().unwrap();
        let me = no_new_privs(std::process::id()) == Some(true);
        assert_eq!(peer_confined(accepted.as_raw_fd(), peer_pid(accepted.as_raw_fd())), me);
        assert!(peer_alive(accepted.as_raw_fd()));
        drop(live);

        let (sa, len) = raw_abstract_addr(&name);
        // SAFETY: the child makes only async-signal-safe calls, then exits.
        unsafe {
            let child = libc::fork();
            if child == 0 {
                let s = libc::socket(libc::AF_UNIX, libc::SOCK_STREAM, 0);
                libc::connect(s, &sa as *const _ as *const libc::sockaddr, len);
                libc::_exit(0);
            }
            libc::waitpid(child, std::ptr::null_mut(), 0);
        }
        let (accepted, _) = listener.accept().unwrap();
        assert!(peer_confined(accepted.as_raw_fd(), peer_pid(accepted.as_raw_fd())));
        let fd = accepted.as_raw_fd();
        assert!(!peer_alive(fd) || matches!(peer_pidfd(fd), Err(libc::ENOPROTOOPT)));
    }

    /// A live no_new_privs peer of an unconfined daemon reads as confined.
    #[cfg(target_os = "linux")]
    #[test]
    fn a_no_new_privs_peer_reads_as_confined() {
        use std::os::linux::net::SocketAddrExt;
        use std::os::unix::net::{SocketAddr, UnixListener};
        if no_new_privs(std::process::id()) == Some(true) {
            eprintln!("the tests themselves run sandboxed; skipping");
            return;
        }
        let name = format!("thel-test-nnp-{}", std::process::id());
        let listener = UnixListener::bind_addr(&SocketAddr::from_abstract_name(&name).unwrap()).unwrap();
        let (sa, len) = raw_abstract_addr(&name);
        let mut hold = [0; 2];
        // SAFETY: hold has room for the two fds pipe writes.
        assert_eq!(unsafe { libc::pipe(hold.as_mut_ptr()) }, 0);
        // SAFETY: the child makes only async-signal-safe calls: it sets
        // no_new_privs, connects, then waits for the pipe to close and exits.
        let child = unsafe {
            let child = libc::fork();
            if child == 0 {
                libc::close(hold[1]);
                libc::prctl(libc::PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0);
                let s = libc::socket(libc::AF_UNIX, libc::SOCK_STREAM, 0);
                libc::connect(s, &sa as *const _ as *const libc::sockaddr, len);
                let mut b = 0u8;
                libc::read(hold[0], &mut b as *mut u8 as *mut libc::c_void, 1);
                libc::_exit(0);
            }
            libc::close(hold[0]);
            child
        };
        let (accepted, _) = listener.accept().unwrap();
        let confined = peer_confined(accepted.as_raw_fd(), peer_pid(accepted.as_raw_fd()));
        // SAFETY: closing our end lets the child exit; then it is reaped.
        unsafe {
            libc::close(hold[1]);
            libc::waitpid(child, std::ptr::null_mut(), 0);
        }
        assert!(confined);
    }

    // ---- wire protocol framing: [u8 type][u32 LE len][payload] ----

    #[test]
    fn frame_round_trips_through_write_then_read() {
        let mut buf = Cursor::new(Vec::new());
        write_frame(&mut buf, OUTPUT, b"hello").unwrap();
        buf.set_position(0);
        let (ty, payload) = read_frame(&mut buf).unwrap();
        assert_eq!(ty, OUTPUT);
        assert_eq!(payload, b"hello");
    }

    #[test]
    fn frame_bytes_layout_is_type_then_le_len_then_payload() {
        assert_eq!(frame_bytes(CONTROL, b"ab"), vec![CONTROL, 2, 0, 0, 0, b'a', b'b']);
    }

    #[test]
    fn empty_payload_round_trips() {
        let mut buf = Cursor::new(Vec::new());
        write_frame(&mut buf, INPUT, b"").unwrap();
        buf.set_position(0);
        let (ty, payload) = read_frame(&mut buf).unwrap();
        assert_eq!(ty, INPUT);
        assert!(payload.is_empty());
    }

    #[test]
    fn read_frame_rejects_a_truncated_header() {
        // Only 3 of the 5 header bytes are present.
        let mut buf = Cursor::new(vec![OUTPUT, 0, 0]);
        assert!(read_frame(&mut buf).is_err());
    }

    #[test]
    fn read_frame_rejects_a_truncated_payload() {
        // Header declares 4 payload bytes but only 1 follows.
        let mut buf = Cursor::new(vec![OUTPUT, 4, 0, 0, 0, b'x']);
        assert!(read_frame(&mut buf).is_err());
    }

    #[test]
    fn read_frame_rejects_an_oversized_length_before_allocating() {
        // A 17 MB frame is over the 16 MB cap: reject on the header alone, with
        // no payload present (so this can't have allocated 17 MB first).
        let len: u32 = 17 * 1024 * 1024;
        let mut head = vec![OUTPUT];
        head.extend_from_slice(&len.to_le_bytes());
        let err = read_frame(&mut Cursor::new(head)).unwrap_err();
        assert_eq!(err.kind(), std::io::ErrorKind::InvalidData);
    }

    // ---- id_payload: [u16 LE id_len][id][data], the OUTPUT/INPUT body ----

    #[test]
    fn id_payload_round_trips_with_binary_data() {
        // Bound to a local: parse_id_payload borrows it and returns a slice into it.
        let p = id_payload("tab-1", b"\x00\x01data");
        let (id, data) = parse_id_payload(&p).unwrap();
        assert_eq!(id, "tab-1");
        assert_eq!(data, &b"\x00\x01data"[..]);
    }

    #[test]
    fn id_payload_round_trips_empty_id_and_data() {
        let p = id_payload("", b"");
        let (id, data) = parse_id_payload(&p).unwrap();
        assert_eq!(id, "");
        assert!(data.is_empty());
    }

    #[test]
    fn parse_id_payload_rejects_short_and_overlong_len() {
        // Fewer than 2 bytes: can't read the length prefix.
        assert!(parse_id_payload(&[0u8]).is_none());
        // id_len says 5 but only 3 id bytes follow.
        let mut p = 5u16.to_le_bytes().to_vec();
        p.extend_from_slice(b"abc");
        assert!(parse_id_payload(&p).is_none());
    }

    // ---- Hello / HelloReply handshake over a CONTROL frame ----

    #[test]
    fn hello_round_trips_over_a_control_frame() {
        let frame = control_json(&Hello {
            protocol: PROTOCOL_VERSION,
            build: "test-build".into(),
        });
        let (ty, payload) = read_frame(&mut Cursor::new(frame)).unwrap();
        assert_eq!(ty, CONTROL);
        let hello: Hello = parse_json(&payload).unwrap();
        assert_eq!(hello.protocol, PROTOCOL_VERSION);
        assert_eq!(hello.build, "test-build");
    }

    #[test]
    fn hello_reply_exposes_protocol_skew_for_the_client_check() {
        // A daemon on a different protocol replies ok:false; the client's probe
        // compares reply.protocol against its own PROTOCOL_VERSION to detect skew.
        let frame = control_json(&HelloReply {
            protocol: PROTOCOL_VERSION + 1,
            build: "other".into(),
            ok: false,
            error: Some("protocol mismatch".into()),
        });
        let (_, payload) = read_frame(&mut Cursor::new(frame)).unwrap();
        let reply: HelloReply = parse_json(&payload).unwrap();
        assert_ne!(reply.protocol, PROTOCOL_VERSION);
        assert!(!reply.ok);
    }

    #[test]
    fn parse_json_returns_none_on_garbage() {
        assert!(parse_json::<Hello>(b"not json").is_none());
    }

    // ---- Client: bounded outbound queue with drop-on-overflow (B6) ----

    #[test]
    fn frames_reach_a_reading_client_in_order() {
        let (a, mut b) = std::os::unix::net::UnixStream::pair().unwrap();
        let client = Client::spawn(&a).unwrap();
        client.enqueue(std::sync::Arc::new(frame_bytes(OUTPUT, b"one")));
        client.enqueue(std::sync::Arc::new(frame_bytes(CONTROL, b"two")));
        // The writer thread drains the queue to the socket in FIFO order.
        let (t1, p1) = read_frame(&mut b).unwrap();
        let (t2, p2) = read_frame(&mut b).unwrap();
        assert_eq!(t1, OUTPUT);
        assert_eq!(p1, b"one");
        assert_eq!(t2, CONTROL);
        assert_eq!(p2, b"two");
    }

    // ---- process enumeration backing kill_session / stray-daemon cleanup ----

    #[cfg(any(target_os = "linux", target_os = "macos"))]
    #[test]
    fn all_pids_includes_our_own_process() {
        // The scan must at least see ourselves; an empty list would mean
        // kill_session silently reaps nothing (the macOS bug this fixes).
        let me = std::process::id() as i32;
        let pids = all_pids();
        assert!(!pids.is_empty(), "process enumeration returned nothing");
        assert!(pids.contains(&me), "our own pid {me} missing from the scan");
    }

    #[cfg(any(target_os = "linux", target_os = "macos"))]
    #[test]
    fn proc_exe_of_self_matches_current_exe() {
        // proc_exe underpins matching a stray daemon against our binary.
        let me = std::process::id() as i32;
        let want = std::env::current_exe().unwrap();
        assert_eq!(proc_exe(me).as_deref(), Some(want.as_path()));
    }

    #[cfg(any(target_os = "linux", target_os = "macos"))]
    #[test]
    fn is_thel_daemon_false_for_the_test_runner() {
        // The test binary carries no `__daemon` arg, so the argv check must not
        // flag it -- otherwise restart() could SIGKILL the wrong pid.
        assert!(!is_thel_daemon(std::process::id() as i32));
    }

    #[test]
    fn a_wedged_client_is_dropped_not_blocked() {
        // The peer never reads, so the socket buffer fills and the writer thread
        // blocks. enqueue must stay non-blocking, and once the queue fills the
        // client is dropped rather than stalling the (simulated) PTY reader.
        let (a, b) = std::os::unix::net::UnixStream::pair().unwrap();
        let client = Client::spawn(&a).unwrap();
        let frame = std::sync::Arc::new(vec![0u8; 8192]);
        let mut dropped = false;
        // Far more than the queue cap + any socket buffer; if enqueue ever
        // blocked, this loop would hang instead of finishing.
        for _ in 0..(CLIENT_QUEUE_CAP + 20_000) {
            client.enqueue(frame.clone());
            if client.dropped.load(std::sync::atomic::Ordering::Relaxed) {
                dropped = true;
                break;
            }
        }
        assert!(dropped, "a client that never reads should be dropped, not block");
        drop(b);
    }
}
