# thel

The terminal app built for AI coding agents and other long-running sessions. thel
keeps each session alive in the background and can anchor it to its own git
worktree, so you can run a fleet of them at once and tell at a glance which one
needs you.

> **Beta.** At the moment thel is developed and tested only on Linux. macOS and
> Windows are a goal, but untested for now, so expect rough edges in those
> platforms.

## Features

- **Persistent sessions.** A built-in background daemon owns the PTYs and an
  authoritative terminal emulator per tab, so your terminals survive closing or
  restarting the app and reattach with their screen restored.
- **Worktree-aware sessions.** Anchor a session to a folder or git worktree, or
  create a new worktree right from the New Session dialog.
- **Splits and tabs.** Divide a session into split panes, each with its own tab
  strip of terminals. Drag tabs to reorder them or move them between panes.
- **Status and notifications.** A live "working" dot while a command runs, and
  auto-detected attention: a finished command, a bell, a coding agent that's done
  and waiting, or an exit. Raises an in-app dot plus an OS banner when the window
  is unfocused; tune which events notify in settings.
- **Keyboard-friendly.** Every major action is reachable from the keyboard,
  through a fuzzy command palette with quick filters or direct shortcuts, and the
  keymap is fully rebindable and persisted.
- **Session icons.** Assign custom icons to your sessions to quickly identify
  them at a glance in the sidebar.
- **Launchers.** Save the commands you start often (e.g. an AI agent) and pick a
  default. Launchers support session variables (like `__SESSION_DIR__`) and can
  run with or without a login shell.
- **Profiles.** Independent profiles, each in its own window with its own layout
  and accent color.

## Notifications

thel notices when a terminal wants your attention and tells you: a command
finishing, a bell, a coding agent going quiet while it waits for input, or a
process exiting. Each shows an in-app dot, plus an OS banner that jumps you to
the terminal when the window is unfocused. Pick which events notify in Settings.

Programs can also notify explicitly with `thel notify [message]`:

```sh
make && thel notify "build finished"
```

It's delivered over the session daemon (falling back to a terminal escape), so
it works from shells, Makefiles, `&&` chains, and hooks that run without a
controlling terminal. Point a coding agent's completion hook at it, e.g. Claude
Code in `settings.json`:

```json
{
  "hooks": {
    "Stop": [
      {
        "hooks": [
          { "type": "command", "command": "thel notify 'Claude is done'" }
        ]
      }
    ]
  }
}
```

Now every finished task pings you in Claude's tab, even in the background. thel
also picks up bells and OSC 9 / 777 / 99 notification escapes from any program.

See [docs/notifications.md](docs/notifications.md) for the full details.

## Prerequisites

- Node 18+ and pnpm
- Rust (stable)
- Platform webview/build libraries for Tauri 2. See the
  [Tauri prerequisites guide](https://v2.tauri.app/start/prerequisites/) for
  your OS.

## Develop

```sh
pnpm install
pnpm tauri dev      # launches the desktop app with HMR
```

The frontend has an end-to-end test suite that runs against a mocked Tauri
layer (no backend needed):

```sh
pnpm test           # Playwright e2e
pnpm test:rust      # Rust unit/integration tests
pnpm typecheck
```

## Build

```sh
pnpm tauri build    # produces a platform bundle
```

## Architecture

A single binary runs in two modes. The default invocation boots the Tauri GUI;
re-invoked with a hidden `__daemon` argument it runs the session daemon and
never touches the webview. The daemon owns the PTYs (via `portable-pty`) and a
`vt100` emulator per tab, so a restarted GUI reattaches to still-running shells
by id. The app keeps owning sessions, profiles, and layout, and persists them
itself; the daemon is a lean "tab server".

```
src/                React app (Vite)
  components/        terminal surface, tabs, sidebar, dialogs, command palette
  lib/               Tauri IPC wrappers, git, persistence, activity, shortcuts
  store/             zustand state: sessions, profiles, launchers, prefs, ui
src-tauri/src/
  daemon.rs          the session daemon (PTYs + VTE + reattach over a socket)
  pty.rs             SessionManager: routes terminals to the daemon or a PTY
  git.rs             worktree/branch commands
  lib.rs             Tauri command surface + plugin wiring
scripts/             icon generator
tests/               Playwright e2e over a mocked Tauri layer
```


## License

Copyright 2026 Joaquim Rocha. Licensed under the Apache License, Version 2.0;
see [LICENSE](./LICENSE).
