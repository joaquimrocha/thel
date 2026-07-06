// True on macOS, where ⌘ is the app modifier (the terminal owns Ctrl).
// Elsewhere we use Ctrl+Shift so we don't steal the shell's Ctrl keys.
export const isMac =
  typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

// True on Windows.
export const isWindows =
  typeof navigator !== "undefined" && /Win/.test(navigator.platform);

// True on Linux, the only platform that runs the session daemon: it relies on
// /proc (process reaping, peer-cred auth, stray-daemon cleanup) and an
// XDG_RUNTIME_DIR socket. On macOS those degrade to no-ops and on Windows the
// daemon doesn't build, so both use a direct PTY. Gating the daemon on this
// keeps us from advertising session-survival we can't actually deliver.
export const isLinux =
  typeof navigator !== "undefined" && !isMac && !isWindows;
