# thel

A cross-platform terminal helper specialized for running coding agents, built
with Tauri 2 + React + TypeScript + shadcn/ui. See [DESIGN.md](./DESIGN.md) for
architecture and roadmap.

## Status

v1 vertical slice: sessions anchored to folders/git worktrees, multiplexed
PTY terminal tabs, attention indicators, and a `Cmd/Ctrl+K` command palette.
Configurable command profiles (Claude, etc.) are planned.

## Prerequisites

- Node 18+ and pnpm
- Rust (stable)
- `daemon` (recommended): terminals run inside a session daemon so sessions survive app
  restarts and crashes. Without it, thel falls back to spawning commands
  directly (no persistence).
- Platform webview/build libraries for Tauri 2:
  - **Fedora**: `sudo dnf install webkit2gtk4.1-devel libsoup3-devel gtk3-devel librsvg2-devel openssl-devel curl wget file`
  - **Debian/Ubuntu**: `sudo apt install libwebkit2gtk-4.1-dev libgtk-3-dev libsoup-3.0-dev librsvg2-dev libssl-dev build-essential curl wget file`
  - **macOS**: Xcode Command Line Tools (`xcode-select --install`)
  - **Windows**: WebView2 runtime (preinstalled on Win 11) + MSVC build tools

## Develop

```sh
pnpm install
pnpm tauri dev      # launches the desktop app with HMR
```

## Build

```sh
pnpm tauri build    # produces a platform bundle
```

## Project layout

```
src/                React app (Vite)
  components/        UI: TabBar, TerminalPane, TerminalSurface, CommandPalette
  lib/               pty IPC wrappers, launchers, profiles, utils
  store/             zustand session/tab state
src-tauri/           Rust backend
  src/pty.rs         PTY SessionManager (portable-pty) + output streaming
  src/lib.rs         Tauri commands + plugin wiring
scripts/             icon generator
```

## Regenerating the app icon

```sh
node scripts/generate-icon.cjs   # writes icon-src.png
pnpm tauri icon icon-src.png     # regenerates src-tauri/icons/*
```
