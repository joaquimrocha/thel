import { create } from "zustand";
import { type Store } from "@tauri-apps/plugin-store";
import { debouncedWriter } from "@/lib/persistDebounce";
import { load } from "@/lib/storeFile";

// Markdown notes, one per session, kept in thel's config dir. Sessions live in
// per-profile layout files, but their ids are unique across profiles, so a
// single notes file serves every window.
interface NotesState {
  notes: Record<string, string>;
  setNote: (sessionId: string, text: string) => void;
  /** Drop a session's notes (its session was closed). */
  removeNote: (sessionId: string) => void;
  hydrate: (notes: Record<string, string>) => void;
}

export const useNotes = create<NotesState>((set) => ({
  notes: {},
  setNote: (sessionId, text) =>
    set((s) => {
      const notes = { ...s.notes };
      // A cleared note is a deleted note. Only exactly empty, though: dropping
      // whitespace too would swallow the blank lines someone types to make
      // room at the top of a note that has nothing in it yet.
      if (text) notes[sessionId] = text;
      else delete notes[sessionId];
      return { notes };
    }),
  removeNote: (sessionId) =>
    set((s) => {
      if (!(sessionId in s.notes)) return s;
      const notes = { ...s.notes };
      delete notes[sessionId];
      return { notes };
    }),
  hydrate: (notes) => set({ notes }),
}));

const FILE = "thel-notes.json";
const KEY = "notes";

let storePromise: Promise<Store> | null = null;
const getStore = () =>
  (storePromise ??= load(FILE, { autoSave: false, defaults: {} }));

// True while applying a change synced in from another profile window, so the
// persistence subscriber skips it and can't ping-pong the write back.
let applyingRemote = false;
let synced = false;
// The last map this window wrote. The store resource is shared, so our own
// writes come back through onKeyChange; replaying one would undo whatever was
// typed since it went out.
let lastWritten: string | null = null;

function applyNotes(saved: Record<string, string> | undefined) {
  if (!saved) return;
  if (JSON.stringify(saved) === lastWritten) return;
  applyingRemote = true;
  useNotes.getState().hydrate(saved);
  applyingRemote = false;
}

export async function hydrateNotes(): Promise<void> {
  try {
    const store = await getStore();
    applyNotes(await store.get<Record<string, string>>(KEY));
    // Every window writes the whole map, so a window that never re-read would
    // overwrite another's notes with its own stale copy. Subscribe once.
    if (!synced) {
      synced = true;
      await store.onKeyChange<Record<string, string>>(KEY, applyNotes);
    }
  } catch (e) {
    console.error("failed to load notes", e);
  }
}

const writer = debouncedWriter<Record<string, string>>(async (notes) => {
  try {
    const store = await getStore();
    lastWritten = JSON.stringify(notes);
    await store.set(KEY, notes);
    await store.save();
  } catch (e) {
    console.error("failed to save notes", e);
  }
}, 400);

/** Write any pending note change immediately (e.g. before the app closes). */
export const flushNotes = writer.flush;

export function startNotePersistence(): () => void {
  return useNotes.subscribe((state) => {
    if (applyingRemote) return; // a synced-in change, not a local edit
    writer.schedule(state.notes);
  });
}
