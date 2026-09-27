# Headless Session Daemon

The `thel` session daemon acts as a "tab server" running in the background. It decouples the terminal processes from the desktop UI lifecycle, ensuring that shells and long-running scripts survive GUI restarts or crashes.

## Daemon Invocation and Lifecycle

The same single compiled binary serves both as the GUI and the daemon.
- **Entry Detection**: On startup, `run()` in `lib.rs` checks `daemon::is_daemon_arg()`. If the argument `__daemon` is present, it directly executes the daemon event loop and bypasses Tauri initialization.
- **Setsid & SIGHUP**: On launch, the daemon detaches from the controlling terminal via `setsid()` and ignores `SIGHUP` so it can run independently.
- **Auto-Termination**: The daemon implements an idle-shutdown check. If there are no active GUI clients *and* no running terminal tabs left (i.e., all tabs are explicitly closed or exited), a 45-second grace window begins. If any terminal tabs are still running, the daemon stays alive indefinitely in the background (even if the GUI is closed), allowing you to reattach to them upon restarting the app. If no new connection or running tab remains during this window, the daemon clean-exits to conserve resources.

## Terminal cgroups (Linux)

With a systemd user manager, the daemon starts each shell through `systemd-run --user --scope`, so every terminal gets its own transient scope under `app-thel.slice` (see `systemd-cgls --user-unit app-thel.slice`). The shell keeps its pid, session, environment and working directory. The scope holds everything the terminal starts, including processes that `setsid` or double-fork away from the shell, so the resource dialog counts their CPU, memory and listening ports too. CPU comes from the scope's own counter; memory is still RSS summed over its processes, to match `ps` and `top`.

The scope is only read. Closing a terminal still kills just the shell's session, so a `nohup` job outlives the tab as in any terminal, and the scope goes away once its last process exits.

The daemon probes once, when it spawns its first terminal, by starting a throwaway scope. Without systemd 254 or newer, or without a reachable user manager (containers, CI), terminals spawn directly and the resource dialog walks the shell's process tree instead. macOS always does the latter.

## Security Controls

The daemon enforces strict local-security bounds:
1. **Directory Permissions**: The runtime directory containing the socket (`daemon.sock`) and PID file (`daemon.pid`) must be owned by the current user and have `0700` permissions. If permissions are loose, the daemon refuses to start.
2. **Socket Permissions**: The Unix Domain Socket is restricted to `0600` permissions.
3. **Peer Verification**: The daemon matches the connecting peer's UID against its own before performing the handshake — via `SO_PEERCRED` on Linux and `LOCAL_PEERCRED` on macOS.

The daemon runs on Linux and macOS. Both provide what it needs to reap a shell's whole session (by session id) and to identify a stray daemon process: Linux through `/proc`, macOS through libproc (`proc_listallpids`, `proc_pidpath`) and `sysctl(KERN_PROCARGS2)`. Windows has no unix-socket daemon, and since the daemon owns every terminal, it has no terminals: the session commands return an error there until it grows a port.

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
- **Normal Screen**: The daemon replays the raw scrollback buffer. Before writing this buffer to the new client, it processes the bytes to **strip query sequences** (such as Device Status Reports `DSR`, Device Attributes `DA`, and Color Queries `OSC`). This prevents the attaching client's terminal from responding to old queries, which would otherwise litter the active shell prompt with garbage characters.
- **Alternate Screen (e.g., inside vim/less)**: The scrollback replay above comes first, followed by an explicit `ESC[?1049h` and a formatted representation of the current grid taken from the authoritative VTE parser (replaying the raw alt-screen history instead would corrupt the screen). The mode switch has to be sent because the formatted grid carries no mode change: without it the client paints the alternate screen into its normal buffer and keeps it there once the program exits and restores that buffer.
