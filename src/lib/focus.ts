import { getCurrentWindow } from "@tauri-apps/api/window";

// Tracks whether the app window is focused, so notifications fire only when the
// user isn't already looking at thel. The window opens focused.
let focused = true;

// DOM focus/blur as a baseline (plain browser / some webviews).
if (typeof window !== "undefined") {
  window.addEventListener("focus", () => {
    focused = true;
  });
  window.addEventListener("blur", () => {
    focused = false;
  });
}

/**
 * Subscribe to the desktop window's focus changes. WebKitGTK doesn't reliably
 * emit DOM focus/blur on OS window focus changes, so on desktop we rely on
 * Tauri's window events, which are authoritative. No-op outside Tauri.
 */
export async function initFocusTracking(): Promise<void> {
  try {
    const w = getCurrentWindow();
    await w.onFocusChanged(({ payload }) => {
      focused = payload;
    });
  } catch {
    // not running under Tauri; the DOM listeners above handle it
  }
}

export function appFocused(): boolean {
  return focused;
}
