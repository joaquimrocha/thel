import { getCurrentWindow } from "@tauri-apps/api/window";

// Tracks whether the app window is focused, so notifications fire only when the
// user isn't already looking at thel. The window opens focused.
let focused = true;
const focusGainedCbs = new Set<() => void>();

// Update focus state and, on a false->true transition, run the focus-gained
// callbacks. Both the DOM fallback and Tauri's authoritative events funnel
// through here, so a callback runs once per gain no matter which source
// reported it.
function setFocused(next: boolean): void {
  const gained = next && !focused;
  focused = next;
  if (gained) focusGainedCbs.forEach((cb) => cb());
}

// DOM focus/blur as a baseline (plain browser / some webviews).
if (typeof window !== "undefined") {
  window.addEventListener("focus", () => setFocused(true));
  window.addEventListener("blur", () => setFocused(false));
}

/**
 * Subscribe to the desktop window's focus changes. WebKitGTK doesn't reliably
 * emit DOM focus/blur on OS window focus changes, so on desktop we rely on
 * Tauri's window events, which are authoritative. No-op outside Tauri.
 */
export async function initFocusTracking(): Promise<void> {
  try {
    const w = getCurrentWindow();
    await w.onFocusChanged(({ payload }) => setFocused(payload));
  } catch {
    // not running under Tauri; the DOM listeners above handle it
  }
}

/**
 * Run `cb` whenever the app window regains focus (e.g. alt-tab back). Returns an
 * unsubscribe. Uses the same authoritative source as appFocused, so it fires
 * reliably under WebKitGTK, where a raw DOM `focus` listener may not.
 */
export function onFocusGained(cb: () => void): () => void {
  focusGainedCbs.add(cb);
  return () => {
    focusGainedCbs.delete(cb);
  };
}

export function appFocused(): boolean {
  return focused;
}
