import { create } from "zustand";
import { emit, listen } from "@tauri-apps/api/event";
import { clampZoomOffset } from "@/lib/theme";

// Small persisted UI preferences (localStorage, like the theme).
const COPY_TOASTS_KEY = "thel.copyToasts";
const ZOOM_KEY = "thel.terminalZoom";
const CUSTOM_TITLEBAR_KEY = "thel.customTitlebar";
const AUTO_START_KEY = "thel.autoStartTerminals";
const USE_DAEMON_KEY = "thel.useDaemon";

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
}

export const usePrefs = create<PrefsState>((set) => ({
  copyToasts: readBool(COPY_TOASTS_KEY, true),
  setCopyToasts: (copyToasts) => {
    try {
      localStorage.setItem(COPY_TOASTS_KEY, copyToasts ? "1" : "0");
    } catch {
      // ignore
    }
    set({ copyToasts });
    broadcast(COPY_TOASTS_KEY, copyToasts);
  },
  terminalZoom: clampZoomOffset(readNum(ZOOM_KEY, 0)),
  setTerminalZoom: (value) => {
    const terminalZoom = clampZoomOffset(value);
    try {
      localStorage.setItem(ZOOM_KEY, String(terminalZoom));
    } catch {
      // ignore
    }
    set({ terminalZoom });
    broadcast(ZOOM_KEY, terminalZoom);
  },
  customTitlebar: readBool(CUSTOM_TITLEBAR_KEY, true),
  setCustomTitlebar: (customTitlebar) => {
    try {
      localStorage.setItem(CUSTOM_TITLEBAR_KEY, customTitlebar ? "1" : "0");
    } catch {
      // ignore
    }
    set({ customTitlebar });
    broadcast(CUSTOM_TITLEBAR_KEY, customTitlebar);
  },
  autoStartTerminals: readBool(AUTO_START_KEY, false),
  setAutoStartTerminals: (autoStartTerminals) => {
    try {
      localStorage.setItem(AUTO_START_KEY, autoStartTerminals ? "1" : "0");
    } catch {
      // ignore
    }
    set({ autoStartTerminals });
    broadcast(AUTO_START_KEY, autoStartTerminals);
  },
  useDaemon: readBool(USE_DAEMON_KEY, true),
  setUseDaemon: (useDaemon) => {
    try {
      localStorage.setItem(USE_DAEMON_KEY, useDaemon ? "1" : "0");
    } catch {
      // ignore
    }
    set({ useDaemon });
    broadcast(USE_DAEMON_KEY, useDaemon);
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
