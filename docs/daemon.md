# Headless Session Daemon

The `thel` session daemon acts as a "tab server" running in the background. It decouples the terminal processes from the desktop UI lifecycle, ensuring that shells and long-running scripts survive GUI restarts or crashes.

## Daemon Invocation and Lifecycle

The same single compiled binary serves both as the GUI and the daemon.
- **Entry Detection**: On startup, `run()` in `lib.rs` checks `daemon::is_daemon_arg()`. If the argument `__daemon` is present, it directly executes the daemon event loop and bypasses Tauri initialization.
- **Setsid & SIGHUP**: On launch, the daemon detaches from the controlling terminal via `setsid()` and ignores `SIGHUP` so it can run independently.
- **Auto-Termination**: The daemon implements an idle-shutdown check. If there are no active GUI clients *and* no running terminal tabs left (i.e., all tabs are explicitly closed or exited), a 45-second grace window begins. If any terminal tabs are still running, the daemon stays alive indefinitely in the background (even if the GUI is closed), allowing you to reattach to them upon restarting the app. If no new connection or running tab remains during this window, the daemon clean-exits to conserve resources.

## Security Controls

The daemon enforces strict local-security bounds:
1. **Directory Permissions**: The runtime directory containing the socket (`daemon.sock`) and PID file (`daemon.pid`) must be owned by the current user and have `0700` permissions. If permissions are loose, the daemon refuses to start.
2. **Socket Permissions**: The Unix Domain Socket is restricted to `0600` permissions.
3. **Peer Verification**: On Linux, the daemon retrieves connection credentials via `SO_PEERCRED` and matches the peer's UID against its own process UID before performing the handshake.

## Wire Protocol

Communication over the Unix Domain Socket uses length-prefixed frames:
```
┌───────────┬──────────────────────┬─────────────────────────┐
│ Type (u8) │ Length (u32, Little) │      Payload Bytes      │
└───────────┴──────────────────────┴─────────────────────────┘
```

### Frame Types

1. **`CONTROL` (0)**: Holds serialized JSON structures.
   - **`Hello` / `HelloReply`**: Handshake verifying protocol compatibility (currently protocol version `1`).
   - **`Command`**: Client actions (`Open`, `Resize`, `Detach`, `Kill`, `Status`).
   - **`Event`**: Daemon notifications sent to clients (`TabExited`, `TabBusy`, `Error`).
2. **`OUTPUT` (1)**: Streamed output from a terminal to connected clients.
   - Payload layout: `[u16 LE ID Length][Tab ID String][Raw Terminal Bytes]`
3. **`INPUT` (2)**: Client keystrokes or inputs forwarded to a terminal.
   - Payload layout: `[u16 LE ID Length][Tab ID String][Raw Input Bytes]`

## State Management and Reattachment

For each terminal tab, the daemon retains:
- A `MasterPty` handle.
- A `vt100::Parser` instance to track the authoritative state of the terminal.
- A ring buffer containing up to 512 KB of raw output representing normal-screen scrollback.

### Snapshot Generation

When a client attaches or reattaches to a running tab, the daemon produces a snapshot to reconstruct the current screen state:
- **Alternate Screen (e.g., inside vim/less)**: Instead of replaying raw history (which causes screen corruption), the daemon generates a formatted representation of the current grid directly from the authoritative VTE parser.
- **Normal Screen**: The daemon replays the raw scrollback buffer. Before writing this buffer to the new client, it processes the bytes to **strip query sequences** (such as Device Status Reports `DSR`, Device Attributes `DA`, and Color Queries `OSC`). This prevents the attaching client's terminal from responding to old queries, which would otherwise litter the active shell prompt with garbage characters.
