# End-to-end tests (Playwright)

The app ships as a Tauri webview, but the React frontend is a plain Vite SPA. The
Rust backend can't run under Playwright, so these tests run the frontend in
headless Chromium with the **Tauri IPC layer mocked** (`tests/tauri.ts`): an
in-memory, `localStorage`-backed store plugin, no-op window/dialog/clipboard
plugins, and stubbed app commands (PTY, git, …).

They cover behaviour and regressions in the UI — title bar / profiles, the
command palette, settings, keyboard shortcuts, sessions/terminals/panes, and
persistence.

The Rust backend is tested separately by `pnpm test:rust` (unit tests for the
daemon/PTY parsing helpers, plus integration tests that drive real `git`). CI
runs both jobs.

## Running

```sh
pnpm test            # headless
pnpm test:headed     # watch it in a browser
pnpm test:ui         # Playwright UI mode
```

The config (`playwright.config.ts`) starts the Vite dev server on :1420
automatically (`reuseExistingServer` is on, so an already-running `pnpm dev` is
reused). First run needs the browser: `npx playwright install chromium`.

## Real app (`tests-e2e/`)

A small suite drives the real dev build (Rust backend, daemon, shells) over
WebDriver through `tauri-driver`. Linux only. That build loads its UI from Vite,
which the suite starts unless one already serves :1420.

```sh
cargo install tauri-driver --locked   # once; also needs WebKitWebDriver (webkitgtk)
cargo build --manifest-path src-tauri/Cargo.toml --no-default-features  # what `pnpm tauri dev` builds
pnpm test:e2e
```

- Each run gets its own `XDG_*` dirs in a temp dir, so its own daemon and
  config, and kills every process it started on exit.
- WebKitWebDriver rejects all input commands, so `tests-e2e/app.ts` dispatches
  clicks and keys as DOM events. Terminal text is read through the dev-only
  `window.__AUTOMATION__` hook (`src/lib/automation.ts`).
- Keep it to flows the mock cannot cover: real shells, the daemon, git.
  Everything else belongs in the Playwright suite above.
- Terminals run a plain bash with a `$ ` prompt (the harness sets `SHELL`),
  so tests can match output without caring about the developer's rc files.
- Files run one at a time (`--test-concurrency=1`): each opens a window, and
  parallel windows would fight over focus.
- A failed output check prints what the terminals showed.
- CI runs it in the `e2e-app` job under `xvfb-run`. That job caches the
  dev binary by a hash of the Rust sources, so frontend-only changes skip
  the Rust build.

`pnpm screenshots` uses the same harness to regenerate the README and website
screenshots (`docs/screenshots/`, `website/public/`). It runs isolated from
your own thel setup, with shells on a plain prompt. The scenes and their
seeded profiles, launchers and layout are in `scripts/screenshots.ts`.

## Coverage

`pnpm test` collects V8 coverage and maps it back to `src/*` via source maps
(`tests/coverage.ts` + the global setup/teardown), writing an HTML/lcov report to
`coverage/`. Current app coverage is ~84% of lines.

The uncovered remainder is mostly things that can't run in a mocked browser:
clipboard copy/paste (xterm canvas selection), desktop notifications, and
Tauri-only window operations.

## Writing tests

- `gotoApp(page, config?)` installs the mock, opens the app, and waits for
  hydration. `config` can set `{ label, git, dirExists, ... }` (see MockConfig).
- Prefer roles/labels and the few `data-testid`s (`app-menu`, `profile-row`,
  `data-session-list`, `data-pane-group`) over brittle text.
- Headless Chromium reports a Linux platform, so the app uses the
  `Ctrl+Shift+...` keybindings.
