# System Architecture Overview

Thel is a persistent, multi-session terminal emulator designed for long-running workflows. It splits its execution across two distinct process boundaries: a desktop GUI frontend built on Tauri and a headless Unix session daemon that manages pseudoterminals (PTYs).

## High-Level Component Layout

```
 ┌────────────────────────────────────────────────────────┐
 │                   Tauri Desktop GUI                    │
 │                                                        │
 │ ┌──────────────────────┐      ┌──────────────────────┐ │
 │ │  Frontend (React)    │ ───► │  Zustand UI State    │ │
 │ │  (xterm.js View)     │      │  (Sessions/Profiles) │ │
 │ └──────────┬───────────┘      └──────────────────────┘ │
 └────────────┼───────────────────────────────────────────┘
              │ (Tauri IPC / Channel)
              ▼
 ┌────────────────────────────────────────────────────────┐
 │                    Tauri Backend                       │
 │                                                        │
 │       ┌────────────────────────────────────────┐       │
 │       │             SessionManager             │       │
 │       └───────────────────┬────────────────────┘       │
 └───────────────────────────┼────────────────────────────┘
                             │ (Unix Socket / Wire Protocol)
                             ▼
 ┌────────────────────────────────────────────────────────┐
 │                  Headless Unix Daemon                  │
 │                                                        │
 │  ┌───────────────────┐        ┌─────────────────────┐  │
 │  │    UnixListener   │ ◄────► │    Daemon State     │  │
 │  │ (Multiplex Loop)  │        │   (Tabs / VT100s)   │  │
 │  └───────────────────┘        └──────────┬──────────┘  │
 │                                          │             │
 │                                          ▼             │
 │                                   ┌─────────────┐      │
 │                                   │     PTY     │      │
 │                                   │ (Shell/Cmd) │      │
 │                                   └─────────────┘      │
 └────────────────────────────────────────────────────────┘
```

## Key Components

1. **Frontend (Vite / React / xterm.js)**: Runs in the Webview window. It renders the terminals using `xterm.js` and manages tab organization, panels, command palettes, and keyboard shortcuts via Zustand state.
2. **Tauri Backend (Rust)**: Handles native capabilities (such as Git integration, file completion, system notifications, and font detection) and delegates terminal communication to either the session daemon (default) or an in-process direct PTY fallback.
3. **Session Daemon (`thel-daemon`)**: A long-lived, headless background process that actually owns the OS-level PTYs and maintains an authoritative virtual terminal emulator (VTE) for each active tab.

## Security Boundary

The webview is the trust boundary. Being a terminal, thel deliberately exposes
IPC commands that run arbitrary programs (`create_session` takes a command,
args, cwd, and environment) and read the filesystem (directory completion,
existence checks). Any code running in the webview can invoke these, so a
compromised webview is equivalent to arbitrary code execution as the user.
There is no allowlist behind these commands, and there is no meaningful one to
add: spawning what the user asks for is the app's whole job.

The defenses therefore live at the webview edge, not behind the IPC commands:

- A strict Content-Security-Policy (`script-src 'self'`, no inline/remote
  scripts, `connect-src` limited to local IPC) so terminal output or a
  supply-chain issue can't get script running in the webview.
- No remote content is ever loaded into the window.
- Terminal-controlled strings (titles, OSC notification bodies, link targets)
  are treated as untrusted and escaped/validated before reaching any sink.

The daemon's local-security controls (`docs/daemon.md`) are a *separate* boundary:
they stop other local users from driving your PTYs, not the webview, which is
trusted by design.

## Data Flow for Terminal I/O

- **Output Stream**:
  1. The underlying child process writes bytes to the PTY master.
  2. The Daemon reads the raw stream, updates its internal `vt100` parser, and broadcasts the chunk to all subscribed GUI clients over a Unix Domain Socket.
  3. The Tauri backend receives the frame, decodes the UTF-8 stream safely (preserving boundaries), and sends it to the React frontend via a Tauri IPC `Channel`.
  4. The frontend writes the data to the `xterm.js` terminal object.
- **Input Stream**:
  1. Keystrokes in `xterm.js` trigger `onData` events in React.
  2. The frontend invokes a Tauri command (`write_session`), passing the text.
  3. The Tauri backend routes this to the Unix Socket as an `INPUT` frame.
  4. The Daemon writes the payload directly into the PTY master writer.
