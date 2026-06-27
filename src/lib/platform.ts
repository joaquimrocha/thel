// True on macOS, where ⌘ is the app modifier (the terminal owns Ctrl).
// Elsewhere we use Ctrl+Shift so we don't steal the shell's Ctrl keys.
export const isMac =
  typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

// True on Windows; used to hide backend-only options (not available on Windows).
export const isWindows =
  typeof navigator !== "undefined" && /Win/.test(navigator.platform);
