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
use std::os::unix::fs::{MetadataExt, PermissionsExt};
use std::os::unix::io::{AsRawFd, RawFd};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use parking_lot::Mutex;
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
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

/// Write a prebuilt frame to a shared connection (ignore errors; a dead peer is
/// dropped when its read loop ends).
fn send(conn: &Arc<Mutex<UnixStream>>, frame: &[u8]) {
    let mut s = conn.lock();
    let _ = s.write_all(frame);
    let _ = s.flush();
}

// ---- daemon state ---------------------------------------------------------

struct TabShared {
    parser: vt100::Parser,
    // Raw output captured while on the normal screen, replayed on reattach so the
    // client has scrollback. Alt-screen output is excluded (it has no scrollback
    // and the VTE snapshot covers it).
    scrollback: VecDeque<u8>,
    subscribers: Vec<Arc<Mutex<UnixStream>>>,
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
        // releasing it so a slow/dead peer can't stall the sampling.
        let snap: Vec<(String, bool, Vec<Arc<Mutex<UnixStream>>>)> = {
            let tabs = daemon.tabs.lock();
            tabs.iter()
                .map(|(id, t)| (id.clone(), tab_busy(t), t.shared.lock().subscribers.clone()))
                .collect()
        };
        let mut next: HashMap<String, bool> = HashMap::new();
        for (id, busy, subs) in snap {
            let was = last.get(&id).copied().unwrap_or(false);
            if busy || was {
                let ev = control_json(&Event::TabBusy {
                    id: id.clone(),
                    busy,
                });
                for c in &subs {
                    send(c, &ev);
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
    let write = match stream.try_clone() {
        Ok(s) => Arc::new(Mutex::new(s)),
        Err(_) => return,
    };
    let mut read = stream;

    // Reject a peer that isn't this user before honoring anything (free hardening
    // some terminals omit).
    if !peer_uid_ok(read.as_raw_fd()) {
        eprintln!("[thel-daemon] rejected connection: peer uid mismatch");
        return;
    }

    let hello: Hello = match read_frame(&mut read) {
        Ok((CONTROL, p)) => match parse_json(&p) {
            Some(h) => h,
            None => return,
        },
        _ => return,
    };
    if hello.protocol != PROTOCOL_VERSION {
        send(
            &write,
            &control_json(&HelloReply {
                protocol: PROTOCOL_VERSION,
                build: build_version(),
                ok: false,
                error: Some(format!(
                    "protocol mismatch: daemon {PROTOCOL_VERSION}, client {}",
                    hello.protocol
                )),
            }),
        );
        return;
    }
    send(
        &write,
        &control_json(&HelloReply {
            protocol: PROTOCOL_VERSION,
            build: build_version(),
            ok: true,
            error: None,
        }),
    );

    daemon.generation.fetch_add(1, Ordering::SeqCst);
    let n = daemon.clients.fetch_add(1, Ordering::SeqCst) + 1;
    eprintln!("[thel-daemon] client connected ({n} now)");

    loop {
        match read_frame(&mut read) {
            Ok((CONTROL, p)) => {
                if let Some(cmd) = parse_json::<Command>(&p) {
                    dispatch(&daemon, cmd, &write);
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
        sh.lock().subscribers.retain(|c| !Arc::ptr_eq(c, &write));
    }
    let left = daemon.clients.fetch_sub(1, Ordering::SeqCst) - 1;
    eprintln!("[thel-daemon] client disconnected ({left} left)");
    daemon.maybe_schedule_exit();
}

fn dispatch(daemon: &Arc<Daemon>, cmd: Command, write: &Arc<Mutex<UnixStream>>) {
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
            if let Err(message) = daemon.open(&id, command, args, cwd, env, cols, rows, write) {
                send(write, &control_json(&Event::Error { id, message }));
            }
        }
        Command::Resize { id, cols, rows } => daemon.resize(&id, cols, rows),
        Command::Detach { id } => daemon.detach(&id, write),
        Command::Kill { id } => daemon.kill(&id),
        Command::Status => {
            let busy = daemon.statuses();
            send(write, &control_json(&StatusReply { busy }));
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
        client: &Arc<Mutex<UnixStream>>,
    ) -> Result<(), String> {
        // Already have this tab: reattach. Snapshot the current screen and
        // subscribe under one lock so the snapshot precedes any live output.
        let existing = self.tabs.lock().get(id).map(|t| t.shared.clone());
        if let Some(shared) = existing {
            eprintln!("[thel-daemon] reattach tab {id}");
            let mut sh = shared.lock();
            let snap = snapshot(&sh);
            sh.subscribers.push(client.clone());
            drop(sh);
            send(client, &frame_bytes(OUTPUT, &id_payload(id, &snap)));
            return Ok(());
        }

        // New tab: spawn the PTY + child, wire the VTE, attach the opener.
        let (cols, rows) = (cols.max(1), rows.max(1));
        let pair = native_pty_system()
            .openpty(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| e.to_string())?;
        let mut cb = CommandBuilder::new(&command);
        cb.args(&args);
        if let Some(cwd) = &cwd {
            cb.cwd(cwd);
        }
        cb.env("TERM", "xterm-256color");
        if let Some(env) = &env {
            for (k, v) in env {
                cb.env(k, v);
            }
        }
        let child = pair
            .slave
            .spawn_command(cb)
            .map_err(|e| format!("spawn '{command}': {e}"))?;
        drop(pair.slave);
        let reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
        let writer = pair.master.take_writer().map_err(|e| e.to_string())?;

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
            sh.subscribers.push(client.clone());
            drop(sh);
            send(client, &frame_bytes(OUTPUT, &id_payload(id, &snap)));
        }
        self.tabs.lock().insert(
            id.to_string(),
            Tab {
                master: pair.master,
                writer: Arc::new(Mutex::new(writer)),
                child,
                shared,
            },
        );
        self.generation.fetch_add(1, Ordering::SeqCst);
        eprintln!("[thel-daemon] spawned tab {id} ('{command}')");
        Ok(())
    }

    fn detach(&self, id: &str, client: &Arc<Mutex<UnixStream>>) {
        if let Some(t) = self.tabs.lock().get(id) {
            t.shared
                .lock()
                .subscribers
                .retain(|c| !Arc::ptr_eq(c, client));
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
        if let Some(t) = self.tabs.lock().remove(id) {
            let _ = t.child.lock().kill();
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
                let frame = frame_bytes(OUTPUT, &id_payload(&id, &buf[..n]));
                for c in &subs {
                    send(c, &frame);
                }
            }
        }
    }
    let code = child.lock().wait().ok().map(|s| s.exit_code() as i32);
    eprintln!("[thel-daemon] tab {id} exited (code {code:?})");
    let subs = { shared.lock().subscribers.clone() };
    let ev = control_json(&Event::TabExited {
        id: id.clone(),
        code,
    });
    for c in &subs {
        send(c, &ev);
    }
    daemon.tabs.lock().remove(&id);
    daemon.maybe_schedule_exit();
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
                for _ in 0..40 {
                    std::thread::sleep(Duration::from_millis(50));
                    if unsafe { libc::kill(pid, 0) } != 0 {
                        break; // process is gone
                    }
                }
                unsafe { libc::kill(pid, libc::SIGKILL) };
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
    use super::strip_queries;

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
}
