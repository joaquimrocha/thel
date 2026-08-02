// True on macOS, where ⌘ is the app modifier (the terminal owns Ctrl).
// Elsewhere we use Ctrl+Shift so we don't steal the shell's Ctrl keys.
export const isMac =
  typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

// True on Windows.
export const isWindows =
  typeof navigator !== "undefined" && /Win/.test(navigator.platform);

// True on Linux.
export const isLinux =
  typeof navigator !== "undefined" && !isMac && !isWindows;

// True on the platforms that run the session daemon (session survival). Both
// Linux and macOS have the pieces the daemon needs -- process reaping by session
// id, peer-cred auth, stray-daemon cleanup -- via /proc on Linux and libproc on
// macOS. Windows has no unix-socket daemon, so it uses a direct PTY. Gating the
// daemon on this keeps us from advertising session-survival we can't deliver.
export const runsDaemon = isLinux || isMac;
