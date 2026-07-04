# PTY and Session Management

The Tauri backend manages both daemon-backed persistent terminal tabs and direct, non-persistent, in-process terminal processes through `SessionManager`.

## Session Types

```
                   SessionManager::create()
                              │
               ┌──────────────┴──────────────┐
               ▼ (use_daemon == true)        ▼ (use_daemon == false)
      ┌──────────────────┐          ┌──────────────────────┐
      │  Daemon Session  │          │    Direct Session    │
      │                  │          │                      │
      │ Inputs/Resizes   │          │ Spawns portable-pty  │
      │ forwarded to the │          │ child in-process;    │
      │ background       │          │ killed instantly     │
      │ daemon process   │          │ when tab closes.     │
      └──────────────────┘          └──────────────────────┘
```

### 1. Daemon-Backed Sessions (Default on Unix)
When a session is requested with `use_daemon: true` (or defaulted), the Tauri backend forwards the command parameters to the background daemon over the Unix socket. 
- The master PTY, process, and VTE are managed entirely inside the daemon process.
- The Tauri backend registers the terminal ID inside `daemon_ids` (a thread-safe `HashSet`) and maps future input, resizing, or close operations directly to Unix Domain Socket frames.

### 2. Direct Sessions (Non-Unix or Explicit Fallback)
If the daemon is toggled off or is running on a non-Unix platform (like Windows, where Unix Domain sockets and background daemonization are restricted), `SessionManager` spawns a direct in-process PTY.
- The backend relies on `portable_pty` to spawn and manage the child command.
- An in-process background read thread (`read_loop`) is spawned per active terminal to stream standard outputs back to the frontend.
- When closed, the child process is terminated immediately.

---

## Safe UTF-8 Stream Reassembly

Terminal outputs can be read and sliced at arbitrary byte boundaries. If a multi-byte UTF-8 character (like an emoji) is split across two read chunks or two network frames, a naive conversion to a string would result in corruption (displaying replacement characters like `\u{FFFD}`).

To prevent this, `SessionManager` implements a thread-safe decoding utility: `decode_utf8_stream()`.
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
The PTY system determines busy status by querying the terminal's foreground process group:
- When a shell starts, it runs as the process group leader (`child.process_id()`).
- When the user runs a command (e.g. `pnpm install` or `cargo build`), the shell moves that command into the foreground process group.
- The backend queries the PTY's current foreground process group leader (`master.process_group_leader()`).
- **Busy Rule**: If the current foreground process group leader PID does **not** match the original shell's PID, a command is running. If they are equal, the terminal is idling at the prompt.

### Broadcast Monitor Thread
In the daemon, a background thread (`busy_monitor`) polls all active tabs every 600ms.
- It checks the busy rule for each tab.
- If a tab is busy, it dispatches a `TabBusy` event over the socket to active subscribers.
- This serves as a heartbeat so the GUI can keep its activity age fresh and trigger completion notifications when the state drops back to idle.
