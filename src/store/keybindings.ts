import { create } from "zustand";
import { load, type Store } from "@tauri-apps/plugin-store";
import { SHORTCUTS, comboToString, type Combo } from "@/lib/keymap";
import { debouncedWriter } from "@/lib/persistDebounce";
import { storeFile } from "@/lib/storeFile";

interface KeybindingsState {
  // Per-shortcut overrides of the default combo.
  overrides: Record<string, Combo>;
  // Id of the shortcut currently capturing a new combo (null = not recording).
  recordingId: string | null;
  setBinding: (id: string, combo: Combo) => void;
  resetBinding: (id: string) => void;
  resetAll: () => void;
  setRecording: (id: string | null) => void;
  hydrate: (overrides: Record<string, Combo>) => void;
}

export const useKeybindings = create<KeybindingsState>((set) => ({
  overrides: {},
  recordingId: null,
  setBinding: (id, combo) =>
    set((s) => ({
      overrides: { ...s.overrides, [id]: combo },
      recordingId: null,
    })),
  resetBinding: (id) =>
    set((s) => {
      const next = { ...s.overrides };
      delete next[id];
      return { overrides: next };
    }),
  resetAll: () => set({ overrides: {} }),
  setRecording: (id) => set({ recordingId: id }),
  hydrate: (overrides) => set({ overrides }),
}));

/** The active combo for a shortcut: override if set, else its default. */
export function effectiveCombo(id: string): Combo | null {
  const ov = useKeybindings.getState().overrides[id];
  if (ov) return ov;
  return SHORTCUTS.find((s) => s.id === id)?.defaultCombo ?? null;
}

/** The current key label for a shortcut id (e.g. "Ctrl+Shift+N"), or undefined
 * if it's unbound. Combines effectiveCombo + comboToString, used wherever a
 * shortcut's keys are shown (tooltips, menus, empty states). */
export function shortcutLabel(id: string): string | undefined {
  const c = effectiveCombo(id);
  return c ? comboToString(c) : undefined;
}

const FILE = storeFile("thel-keybindings.json");
const KEY = "overrides";

let storePromise: Promise<Store> | null = null;
const getStore = () =>
  (storePromise ??= load(FILE, { autoSave: false, defaults: {} }));

// True while applying a change synced in from another window, so the persistence
// subscriber skips it and can't ping-pong the write back. Set only around the
// synchronous hydrate() (zustand fires subscribers within set()).
let applyingRemote = false;
let synced = false;

function applyOverrides(saved: Record<string, Combo> | undefined) {
  if (!saved) return;
  applyingRemote = true;
  useKeybindings.getState().hydrate(saved);
  applyingRemote = false;
}

export async function hydrateKeybindings(): Promise<void> {
  try {
    const store = await getStore();
    applyOverrides(await store.get<Record<string, Combo>>(KEY));
    // The store is shared across profile windows; re-apply on external changes
    // so a rebinding in one window reaches all. Subscribe once per window.
    if (!synced) {
      synced = true;
      await store.onKeyChange<Record<string, Combo>>(KEY, applyOverrides);
    }
  } catch (e) {
    console.error("failed to load keybindings", e);
  }
}

const writer = debouncedWriter<Record<string, Combo>>(async (overrides) => {
  try {
    const store = await getStore();
    await store.set(KEY, overrides);
    await store.save();
  } catch (e) {
    console.error("failed to save keybindings", e);
  }
}, 300);

/** Write any pending keybinding change immediately (e.g. before the app closes). */
export const flushKeybindings = writer.flush;

export function startKeybindingPersistence(): () => void {
  return useKeybindings.subscribe((state) => {
    if (applyingRemote) return; // a synced-in change, not a local edit
    writer.schedule(state.overrides);
  });
}
