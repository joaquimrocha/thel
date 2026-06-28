import { create } from "zustand";
import { load, type Store } from "@tauri-apps/plugin-store";
import { SHORTCUTS, type Combo } from "@/lib/keymap";
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

const FILE = storeFile("thel-keybindings.json");
const KEY = "overrides";

let storePromise: Promise<Store> | null = null;
const getStore = () =>
  (storePromise ??= load(FILE, { autoSave: false, defaults: {} }));

export async function hydrateKeybindings(): Promise<void> {
  try {
    const store = await getStore();
    const saved = await store.get<Record<string, Combo>>(KEY);
    if (saved) useKeybindings.getState().hydrate(saved);
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
  return useKeybindings.subscribe((state) => writer.schedule(state.overrides));
}
