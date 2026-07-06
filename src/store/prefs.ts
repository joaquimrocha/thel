import { create } from "zustand";
import { emit, listen } from "@tauri-apps/api/event";
import { clampZoomOffset } from "@/lib/theme";
import { isLinux } from "@/lib/platform";

// Small persisted UI preferences (localStorage, like the theme).
const COPY_TOASTS_KEY = "thel.copyToasts";
const ZOOM_KEY = "thel.terminalZoom";
const CUSTOM_TITLEBAR_KEY = "thel.customTitlebar";
const AUTO_START_KEY = "thel.autoStartTerminals";
const USE_DAEMON_KEY = "thel.useDaemon";
const NOTIFY_DESKTOP_KEY = "thel.notifyDesktop";
const NOTIFY_BELL_KEY = "thel.notifyBell";
const NOTIFY_WAITING_KEY = "thel.notifyAgentWaiting";
const NOTIFY_FINISHED_KEY = "thel.notifyCommandFinished";

// Prefs live in localStorage shared by every app window, but each window caches
// them in its own store. We broadcast each change so the others update live
// instead of only on next launch (push-based; no polling). `applyingRemote`
// guards against re-emitting a change we just received.
const SYNC_EVENT = "prefs:changed";
let applyingRemote = false;
function broadcast(key: string, value: boolean | number): void {
  if (applyingRemote) return;
  void emit(SYNC_EVENT, { key, value }).catch(() => {});
}

function persistBool(key: string, value: boolean): void {
  try {
    localStorage.setItem(key, value ? "1" : "0");
  } catch {
    // ignore
  }
  broadcast(key, value);
}

function persistNum(key: string, value: number): void {
  try {
    localStorage.setItem(key, String(value));
  } catch {
    // ignore
  }
  broadcast(key, value);
}

function readBool(key: string, def: boolean): boolean {
  if (typeof localStorage === "undefined") return def;
  const v = localStorage.getItem(key);
  return v === null ? def : v === "1";
}

function readNum(key: string, def: number): number {
  if (typeof localStorage === "undefined") return def;
  const n = Number(localStorage.getItem(key));
  return Number.isFinite(n) ? n : def;
}

interface PrefsState {
  // Show an in-app toast when copying from a terminal.
  copyToasts: boolean;
  setCopyToasts: (value: boolean) => void;
  // Default zoom offset (px from the system font size) for terminals that the
  // user hasn't individually zoomed.
  terminalZoom: number;
  setTerminalZoom: (value: number) => void;
  // Use the app's own title bar (OS decorations off) vs the native title bar.
  customTitlebar: boolean;
  setCustomTitlebar: (value: boolean) => void;
  // When the daemon is off, auto-start restored terminals on launch instead of
  // showing their Start button.
  autoStartTerminals: boolean;
  setAutoStartTerminals: (value: boolean) => void;
  // Back terminals with thel's own session daemon (unix) so they survive the
  // app; off falls back to a direct, non-persistent PTY. Default on.
  useDaemon: boolean;
  setUseDaemon: (value: boolean) => void;
  // Desktop (OS) notifications when the window is unfocused; the in-app
  // notification list is unaffected. Master switch for the ones below.
  notifyDesktop: boolean;
  setNotifyDesktop: (value: boolean) => void;
  // Notify when a program rings the terminal bell.
  notifyBell: boolean;
  setNotifyBell: (value: boolean) => void;
  // Notify when a busy terminal (a resident agent) goes quiet, i.e. its turn
  // ended. Best-effort screen-activity heuristic.
  notifyAgentWaiting: boolean;
  setNotifyAgentWaiting: (value: boolean) => void;
  // Notify when a foreground command finishes in a background terminal.
  notifyCommandFinished: boolean;
  setNotifyCommandFinished: (value: boolean) => void;
}

export const usePrefs = create<PrefsState>((set) => ({
  copyToasts: readBool(COPY_TOASTS_KEY, true),
  setCopyToasts: (copyToasts) => {
    persistBool(COPY_TOASTS_KEY, copyToasts);
    set({ copyToasts });
  },
  terminalZoom: clampZoomOffset(readNum(ZOOM_KEY, 0)),
  setTerminalZoom: (value) => {
    const terminalZoom = clampZoomOffset(value);
    persistNum(ZOOM_KEY, terminalZoom);
    set({ terminalZoom });
  },
  customTitlebar: readBool(CUSTOM_TITLEBAR_KEY, true),
  setCustomTitlebar: (customTitlebar) => {
    persistBool(CUSTOM_TITLEBAR_KEY, customTitlebar);
    set({ customTitlebar });
  },
  autoStartTerminals: readBool(AUTO_START_KEY, false),
  setAutoStartTerminals: (autoStartTerminals) => {
    persistBool(AUTO_START_KEY, autoStartTerminals);
    set({ autoStartTerminals });
  },
  // Linux-only. Off elsewhere regardless of any saved value, so Mac/Windows
  // never activate the daemon (and never restore terminals expecting reattach).
  useDaemon: isLinux && readBool(USE_DAEMON_KEY, true),
  setUseDaemon: (useDaemon) => {
    persistBool(USE_DAEMON_KEY, useDaemon);
    set({ useDaemon });
  },
  notifyDesktop: readBool(NOTIFY_DESKTOP_KEY, true),
  setNotifyDesktop: (notifyDesktop) => {
    persistBool(NOTIFY_DESKTOP_KEY, notifyDesktop);
    set({ notifyDesktop });
  },
  notifyBell: readBool(NOTIFY_BELL_KEY, true),
  setNotifyBell: (notifyBell) => {
    persistBool(NOTIFY_BELL_KEY, notifyBell);
    set({ notifyBell });
  },
  notifyAgentWaiting: readBool(NOTIFY_WAITING_KEY, true),
  setNotifyAgentWaiting: (notifyAgentWaiting) => {
    persistBool(NOTIFY_WAITING_KEY, notifyAgentWaiting);
    set({ notifyAgentWaiting });
  },
  notifyCommandFinished: readBool(NOTIFY_FINISHED_KEY, true),
  setNotifyCommandFinished: (notifyCommandFinished) => {
    persistBool(NOTIFY_FINISHED_KEY, notifyCommandFinished);
    set({ notifyCommandFinished });
  },
}));

// Apply a change received from another window. Reuses the public setters (under
// the `applyingRemote` guard so they don't re-broadcast), which also refreshes
// this window's localStorage cache.
const REMOTE_APPLIERS: Record<string, (value: unknown) => void> = {
  [COPY_TOASTS_KEY]: (v) => usePrefs.getState().setCopyToasts(Boolean(v)),
  [ZOOM_KEY]: (v) => usePrefs.getState().setTerminalZoom(Number(v)),
  [CUSTOM_TITLEBAR_KEY]: (v) => usePrefs.getState().setCustomTitlebar(Boolean(v)),
  [AUTO_START_KEY]: (v) => usePrefs.getState().setAutoStartTerminals(Boolean(v)),
  [USE_DAEMON_KEY]: (v) => usePrefs.getState().setUseDaemon(Boolean(v)),
  [NOTIFY_DESKTOP_KEY]: (v) => usePrefs.getState().setNotifyDesktop(Boolean(v)),
  [NOTIFY_BELL_KEY]: (v) => usePrefs.getState().setNotifyBell(Boolean(v)),
  [NOTIFY_WAITING_KEY]: (v) => usePrefs.getState().setNotifyAgentWaiting(Boolean(v)),
  [NOTIFY_FINISHED_KEY]: (v) =>
    usePrefs.getState().setNotifyCommandFinished(Boolean(v)),
};

/** Mirror preference changes made in other app windows. No-op outside Tauri. */
export async function initPrefsSync(): Promise<void> {
  try {
    await listen<{ key: string; value: unknown }>(SYNC_EVENT, ({ payload }) => {
      const apply = REMOTE_APPLIERS[payload.key];
      if (!apply) return;
      applyingRemote = true;
      try {
        apply(payload.value);
      } finally {
        applyingRemote = false;
      }
    });
  } catch {
    // not running under Tauri; nothing to sync
  }
}
