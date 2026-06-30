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
        let pair = native_pty_system()
            .openpty(PtySize {
                rows: opts.rows.max(1),
                cols: opts.cols.max(1),
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| e.to_string())?;

        let mut cmd = CommandBuilder::new(&opts.command);
        cmd.args(&opts.args);
        if let Some(cwd) = &opts.cwd {
            cmd.cwd(cwd);
        }
        // TERM is needed for most agents/shells to emit sane escape sequences.
        cmd.env("TERM", "xterm-256color");
        if let Some(env) = &opts.env {
            for (k, v) in env {
                cmd.env(k, v);
            }
        }

        let child = pair
            .slave
            .spawn_command(cmd)
            .map_err(|e| format!("failed to spawn '{}': {e}", opts.command))?;
        // Drop the slave so the master sees EOF when the child exits.
        drop(pair.slave);

        let pid = child.process_id();
        self.spawn_session(opts.id, pair.master, child, pid, on_data)
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
        let busy = map.get(id).map(|s| is_busy(s)).unwrap_or(false);
        TermStatus {
            busy,
            dead: false,
            code: None,
        }
    }

    /// Busy state of every terminal in one shot: direct terminals probed
    /// in-process, daemon terminals via one query to the daemon. This is what
    /// drives the "working" dot, so daemon tabs (the default backend) must be
    /// included or the animation never fires.
    pub fn all_statuses(&self) -> HashMap<String, TermStatus> {
        let mut out: HashMap<String, TermStatus> = self
            .sessions
            .lock()
            .iter()
            .map(|(id, s)| {
                (
                    id.clone(),
                    TermStatus {
                        busy: is_busy(s),
                        dead: false,
                        code: None,
                    },
                )
            })
            .collect();
        #[cfg(unix)]
        {
            let ids = self.daemon_ids.lock();
            if !ids.is_empty() {
                let busy = crate::daemon::statuses();
                for id in ids.iter() {
                    out.insert(
                        id.clone(),
                        TermStatus {
                            busy: busy.get(id).copied().unwrap_or(false),
                            dead: false,
                            code: None,
                        },
                    );
                }
            }
        }
        out
    }
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
