//! thel session daemon (Linux-first). One binary, two modes: the default
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
use std::sync::mpsc::{sync_channel, SyncSender, TrySendError};
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use parking_lot::Mutex;
use portable_pty::{Child, MasterPty, PtySize};
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;

use crate::pty::{decode_utf8_stream, CreateOpts, TermMsg};

const PROTOCOL_VERSION: u32 = 1;
const EMPTY_GRACE: Duration = Duration::from_secs(45);
// How often the daemon samples each tab's foreground state to push busy
// transitions. Foreground-pgroup changes have no kernel event, so this is a
// poll, but it lives here (in-process, no IPC) and the GUI only ever sees the
// resulting events.
const BUSY_POLL: Duration = Duration::from_millis(600);
const DAEMON_ARG: &str = "__daemon";
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

/// Reject any peer whose uid isn't ours (SO_PEERCRED). Linux-only; elsewhere the
/// 0700 dir + 0600 socket are the guard (spec is Linux-first).
#[cfg(target_os = "linux")]
fn peer_uid_ok(fd: RawFd) -> bool {
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
        ret == 0 && cred.uid == libc::geteuid()
    }
}

#[cfg(not(target_os = "linux"))]
fn peer_uid_ok(_fd: RawFd) -> bool {
    true
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
    Error { id: String, message: String },
}

/// Reply to Command::Status: tab id -> a foreground command is running.
#[derive(Serialize, Deserialize)]
struct StatusReply {
    busy: HashMap<String, bool>,
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

struct TabShared {
    parser: vt100::Parser,
    // Raw output captured while on the normal screen, replayed on reattach so the
    // client has scrollback. Alt-screen output is excluded (it has no scrollback
    // and the VTE snapshot covers it).
    scrollback: VecDeque<u8>,
    subscribers: Vec<Arc<Client>>,
}

/// What to send a (re)attaching client: the raw scrollback on the normal screen,
/// or the authoritative VTE snapshot when on the alternate screen (where raw
/// replay would be the thing that breaks).
fn snapshot(sh: &TabShared) -> Vec<u8> {
    if sh.parser.screen().alternate_screen() {
        sh.parser.screen().contents_formatted()
    } else {
        strip_queries(&sh.scrollback.iter().copied().collect::<Vec<u8>>())
    }
}

/// Remove terminal *query* sequences (DSR/CPR `ESC[…n`, DA `ESC[…c`, OSC
/// color/etc queries containing `?`) from replayed scrollback. They produce no
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
                        let drop = input[j] == b'n' || input[j] == b'c';
                        if !drop {
                            out.extend_from_slice(&input[i..=j]);
                        }
                        i = j + 1;
                        continue;
                    }
                }
                b']' => {
                    // OSC: body up to BEL or ST (ESC \). Drop only color/status
                    // QUERIES, whose parameter is a bare `?` so the body ends in
                    // ";?" (e.g. OSC 11;? for background). Keep every other OSC,
                    // including hyperlinks (OSC 8, URL may contain `?`) and
                    // titles, whose payload can legitimately contain `?`.
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
                    let body_end = j.min(input.len()).saturating_sub(term_len);
                    let is_query = input[i + 2..body_end].ends_with(b";?");
                    if !is_query {
                        out.extend_from_slice(&input[i..j.min(input.len())]);
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

    let daemon = Arc::new(Daemon {
        tabs: Mutex::new(HashMap::new()),
        clients: AtomicUsize::new(0),
        generation: AtomicU64::new(0),
    });
    daemon.maybe_schedule_exit();

    std::thread::spawn({
        let daemon = daemon.clone();
        move || busy_monitor(daemon)
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
                    (id.clone(), tab_busy(t), t.shared.lock().subscribers.clone())
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
                    dispatch(daemon, cmd, &client);
                }
            }
            Ok((INPUT, p)) => {
                if let Some((id, data)) = parse_id_payload(&p) {
                    daemon.input(&id, data);
                }
            }
            _ => break,
        }
    }

    let shareds: Vec<_> = daemon.tabs.lock().values().map(|t| t.shared.clone()).collect();
    for sh in shareds {
        sh.lock().subscribers.retain(|c| !Arc::ptr_eq(c, &client));
    }
}

fn dispatch(daemon: &Arc<Daemon>, cmd: Command, client: &Arc<Client>) {
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
            if let Err(message) = daemon.open(&id, command, args, cwd, env, cols, rows, client) {
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
        client: &Arc<Client>,
    ) -> Result<(), String> {
        // Already have this tab: reattach. Snapshot the current screen and
        // subscribe under one lock so the snapshot precedes any live output.
        let existing = self.tabs.lock().get(id).map(|t| t.shared.clone());
        if let Some(shared) = existing {
            eprintln!("[thel-daemon] reattach tab {id}");
            let mut sh = shared.lock();
            let snap = snapshot(&sh);
            // Queue the snapshot before adding the subscriber, both under this
            // lock, so it precedes any live output (tab_reader clones the
            // subscriber list under the same lock).
            client.enqueue(Arc::new(frame_bytes(OUTPUT, &id_payload(id, &snap))));
            // A client re-opening a tab it already subscribes to (e.g. after a
            // webview reload over the same connection) must not be added twice,
            // or it receives every output frame once per entry.
            if !sh.subscribers.iter().any(|c| Arc::ptr_eq(c, client)) {
                sh.subscribers.push(client.clone());
            }
            drop(sh);
            return Ok(());
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
        }));
        let child = Arc::new(Mutex::new(child));

        std::thread::spawn({
            let (id, shared, child, daemon) =
                (id.to_string(), shared.clone(), child.clone(), self.clone());
            move || tab_reader(id, reader, shared, child, daemon)
        });

        {
            let mut sh = shared.lock();
            let snap = snapshot(&sh);
            client.enqueue(Arc::new(frame_bytes(OUTPUT, &id_payload(id, &snap))));
            sh.subscribers.push(client.clone());
            drop(sh);
        }
        self.tabs.lock().insert(
            id.to_string(),
            Tab {
                master,
                writer: Arc::new(Mutex::new(writer)),
                child,
                shared,
            },
        );
        self.generation.fetch_add(1, Ordering::SeqCst);
        eprintln!("[thel-daemon] spawned tab {id} ('{command}')");
        Ok(())
    }

    fn detach(&self, id: &str, client: &Arc<Client>) {
        if let Some(t) = self.tabs.lock().get(id) {
            t.shared
                .lock()
                .subscribers
                .retain(|c| !Arc::ptr_eq(c, client));
        }
    }

    // Forward an out-of-band notification to a tab's GUI subscribers. No-op if the
    // tab is unknown (e.g. a stale id). Mirrors busy_monitor's send: snapshot the
    // subscribers under the tabs lock, then enqueue.
    fn notify_tab(&self, id: &str, message: String) {
        let subs = match self.tabs.lock().get(id) {
            Some(t) => t.shared.lock().subscribers.clone(),
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

    fn input(&self, id: &str, data: &[u8]) {
        let writer = self.tabs.lock().get(id).map(|t| t.writer.clone());
        if let Some(writer) = writer {
            let mut w = writer.lock();
            let _ = w.write_all(data);
            let _ = w.flush();
        }
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
        }
        self.maybe_schedule_exit();
    }

    fn statuses(&self) -> HashMap<String, bool> {
        self.tabs
            .lock()
            .iter()
            .map(|(id, t)| (id.clone(), tab_busy(t)))
            .collect()
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
    let Ok(entries) = std::fs::read_dir("/proc") else {
        return;
    };
    for entry in entries.flatten() {
        let Some(pid) = entry
            .file_name()
            .to_str()
            .and_then(|s| s.parse::<i32>().ok())
        else {
            continue;
        };
        if unsafe { libc::getsid(pid) } == sid {
            unsafe { libc::kill(pid, libc::SIGKILL) };
        }
    }
}

/// Tear a tab down once: remove it, kill its process group + reap, and tell
/// subscribers it exited. Guarded by the tabs-map removal, so the three paths
/// that can end a tab -- tab_reader's read EOF, the busy poller catching a shell
/// that exited while a grandchild held the pts, and an explicit Kill -- can all
/// call it and only the first wins.
fn finish_tab(daemon: &Arc<Daemon>, id: &str, code: Option<i32>) {
    let removed = daemon.tabs.lock().remove(id);
    let Some(t) = removed else {
        return; // already finished by another path
    };
    kill_session_and_reap(&t.child);
    let subs = t.shared.lock().subscribers.clone();
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
                    sh.subscribers.clone()
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

/// Terminate a tab's process and forget it (the user closed the tab).
pub fn kill(id: &str) -> Result<(), String> {
    let c = client()?;
    c.routes.lock().remove(id);
    let cmd = Command::Kill { id: id.to_string() };
    on_client_error(c.send_frame(CONTROL, &serde_json::to_vec(&cmd).unwrap_or_default()))
}

/// Busy state of every daemon tab, for the GUI's working-dot poll. Uses a
/// short-lived query connection (like probe_existing) so the reply doesn't have
/// to be correlated against the multiplexed output stream. Returns an empty map
/// on any error rather than failing the whole status poll.
pub fn statuses() -> std::collections::HashMap<String, bool> {
    let empty = std::collections::HashMap::new();
    let Ok(mut stream) = UnixStream::connect(socket_path()) else {
        return empty;
    };
    let hello = serde_json::to_vec(&Hello {
        protocol: PROTOCOL_VERSION,
        build: build_version(),
    })
    .unwrap_or_default();
    if write_frame(&mut stream, CONTROL, &hello).is_err() {
        return empty;
    }
    match read_frame(&mut stream) {
        Ok((CONTROL, p)) => match parse_json::<HelloReply>(&p) {
            Some(r) if r.ok => {}
            _ => return empty,
        },
        _ => return empty,
    }
    let cmd = serde_json::to_vec(&Command::Status).unwrap_or_default();
    if write_frame(&mut stream, CONTROL, &cmd).is_err() {
        return empty;
    }
    match read_frame(&mut stream) {
        Ok((CONTROL, p)) => parse_json::<StatusReply>(&p).map(|r| r.busy).unwrap_or(empty),
        _ => empty,
    }
}

/// Post a notification for `id` through the daemon (out-of-band, no tty needed).
/// Short-lived connection like statuses(): Hello, then one Notify command, then
/// close. Returns whether it was handed off. Used by `thel notify` when a running
/// daemon owns the tab.
pub fn send_notify(id: &str, message: &str) -> bool {
    let Ok(mut stream) = UnixStream::connect(socket_path()) else {
        return false;
    };
    let hello = serde_json::to_vec(&Hello {
        protocol: PROTOCOL_VERSION,
        build: build_version(),
    })
    .unwrap_or_default();
    if write_frame(&mut stream, CONTROL, &hello).is_err() {
        return false;
    }
    match read_frame(&mut stream) {
        Ok((CONTROL, p)) => match parse_json::<HelloReply>(&p) {
            Some(r) if r.ok => {}
            _ => return false,
        },
        _ => return false,
    }
    let cmd = serde_json::to_vec(&Command::Notify {
        id: id.to_string(),
        message: message.to_string(),
    })
    .unwrap_or_default();
    write_frame(&mut stream, CONTROL, &cmd).is_ok()
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
                Some(Event::Error { id, message }) => {
                    eprintln!("[thel] daemon error for {id}: {message}");
                }
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
#[cfg(target_os = "linux")]
fn kill_stray_daemons() {
    let Ok(exe) = std::env::current_exe() else {
        return;
    };
    let Ok(entries) = std::fs::read_dir("/proc") else {
        return;
    };
    for entry in entries.flatten() {
        let Some(pid) = entry
            .file_name()
            .to_str()
            .and_then(|s| s.parse::<i32>().ok())
        else {
            continue;
        };
        let same_exe = std::fs::read_link(format!("/proc/{pid}/exe"))
            .map(|p| p == exe)
            .unwrap_or(false);
        if same_exe && is_thel_daemon(pid) {
            unsafe { libc::kill(pid, libc::SIGKILL) };
        }
    }
}

#[cfg(not(target_os = "linux"))]
fn kill_stray_daemons() {}

/// Confirm a pid is a thel daemon (its argv contains `__daemon`) before killing.
#[cfg(target_os = "linux")]
fn is_thel_daemon(pid: i32) -> bool {
    std::fs::read(format!("/proc/{pid}/cmdline"))
        .map(|c| c.split(|&b| b == 0).any(|a| a == DAEMON_ARG.as_bytes()))
        .unwrap_or(false)
}

#[cfg(not(target_os = "linux"))]
fn is_thel_daemon(_pid: i32) -> bool {
    true // best-effort off Linux; restart is only offered after a live probe
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
