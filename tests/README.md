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
