# PTY and Session Management

Every terminal is owned by the session daemon. The Tauri backend never holds a
PTY of its own: `pty.rs` is a thin forwarding layer between the IPC commands in
`lib.rs` and the daemon client, plus the pieces the daemon builds on (spawning a
PTY, sampling a process tree, decoding output).

```
   create_session / write_session / resize_session / …   (IPC command)
                              │
                              ▼
                     pty.rs  (forwarding)
                              │  Unix socket frames
                              ▼
                    Session daemon process
             master PTY + vt100 emulator + child process
```

Terminals are addressed by id the whole way down, which is what makes a tab
survive its pane, its window, and the GUI process itself. The daemon's `open` is
attach-if-alive-else-respawn, so mounting a pane either reattaches to the running
shell (replaying its screen) or spawns a fresh one at the terminal's cwd. A
restored layout needs no separate "start" step.

Off Linux and macOS there is no daemon, so these commands return an error rather
than a backend that cannot keep the app's promises. See `docs/daemon.md` for what
the daemon needs from the platform.

## Lifecycle

| Frontend action | Command | Daemon effect |
| --- | --- | --- |
| Pane mounts | `create_session` | `Open`: attach to the tab, or spawn it |
| Pane unmounts, session switch | `close_session` | `Detach`: stop streaming, keep it running |
| User closes a tab | `kill_terminal_window` | `Kill`: end the shell's whole session |
| Window closes, terminals set to stop | `kill_terminal_window` per tab | as above |

What a closing window does to its terminals is a three-way preference: keep
them running, stop them, or ask at the time. The prompt runs inside
`onCloseRequested` before anything is killed, so cancelling it leaves the
window and its terminals untouched. A crash never reaches this path at all,
which is what makes an interrupted run recoverable regardless of the setting.

`Kill` without an established daemon connection is a no-op: if the GUI never
connected there is no daemon holding the tab, and spawning one to kill nothing
would be worse than doing nothing.

---

## Safe UTF-8 Stream Reassembly

Terminal outputs can be read and sliced at arbitrary byte boundaries. If a multi-byte UTF-8 character (like an emoji) is split across two read chunks or two network frames, a naive conversion to a string would result in corruption (displaying replacement characters like `\u{FFFD}`).

To prevent this, `pty.rs` provides a decoding utility used by the daemon's PTY
reader and by the client's frame decoder: `decode_utf8_stream()`.
- **Carry Buffer**: Each terminal session (or network routing path) maintains an individual `carry` byte buffer.
- **Incremental Parsing**:
  1. Incoming raw bytes are appended directly to the `carry` buffer.
  2. `std::str::from_utf8` attempts to parse the buffer.
  3. If it succeeds completely, the decoded string is emitted, and the `carry` buffer is cleared.
  4. If a parsing error occurs:
     - The parser decodes everything up to the first invalid byte.
     - Any fully invalid bytes are replaced with `\u{FFFD}` and removed from the buffer.
     - If the error represents an **incomplete trailing codepoint** (i.e. more bytes are needed to complete the UTF-8 sequence), the valid portion is emitted, and the trailing partial bytes are retained in the `carry` buffer to be completed by the next chunk.

---

## Foreground Activity & Busy Monitoring

The application shows a live "working" animation in the sidebar (a pulsing dot) and triggers notifications when a command finishes in the background. This heuristic relies on knowing whether a shell is idling at a prompt or actively executing a foreground command.

### Process Group Monitoring
The daemon determines busy status by querying the terminal's foreground process group:
- When a shell starts, it runs as the process group leader (`child.process_id()`).
- When the user runs a command (e.g. `pnpm install` or `cargo build`), the shell moves that command into the foreground process group.
- The daemon queries the PTY's current foreground process group leader (`master.process_group_leader()`).
- **Busy Rule**: If the current foreground process group leader PID does **not** match the original shell's PID, a command is running. If they are equal, the terminal is idling at the prompt.

### Broadcast Monitor Thread
In the daemon, a background thread (`busy_monitor`) polls all active tabs every 600ms.
- It checks the busy rule for each tab.
- If a tab is busy, it dispatches a `TabBusy` event over the socket to active subscribers.
- This serves as a heartbeat so the GUI can keep its activity age fresh and trigger completion notifications when the state drops back to idle.

The GUI can also ask directly (`terminal_status`), which the "command finished"
heuristic polls per tab.
