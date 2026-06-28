# thel

The terminal app built for AI coding agents and other long-running sessions. thel
keeps each session alive in the background and can anchor it to its own git
worktree, so you can run a fleet of them at once and tell at a glance which one
needs you.

> **Alpha.** thel builds for Linux, macOS, and Windows, but it is currently only
> tested on Linux. Expect rough edges.

## Features

- **Persistent sessions.** A built-in background daemon owns the PTYs and an
  authoritative terminal emulator per tab, so your terminals survive closing or
  restarting the app and reattach with their screen restored.
- **Worktree-aware sessions.** Anchor a session to a folder or git worktree, or
  create a new worktree right from the New Session dialog.
- **Splits and tabs.** Divide a session into split panes, each with its own tab
  strip of terminals. Drag tabs to reorder them or move them between panes.
- **Status and notifications.** A live "working" dot while a command runs and an
  attention dot when a background terminal rings the bell or exits, with matching
  in-app and OS notifications when the window is unfocused.
- **Command palette and shortcuts.** Fuzzy palette with quick filters and a
  rebindable, persisted keymap for sessions, terminals, and app actions.
- **Session icons.** Assign custom icons to your sessions to quickly identify
  them at a glance in the sidebar.
- **Launchers.** Save the commands you start often (e.g. an AI agent) and pick a
  default. Launchers support session variables (like `__SESSION_DIR__`) and can
  run with or without a login shell.
- **Profiles.** Independent profiles, each in its own window with its own layout
  and accent color.

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
