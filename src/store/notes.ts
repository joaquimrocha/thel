import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { debouncedWriter } from "@/lib/persistDebounce";

// Markdown notes, one file per session under thel's config dir. Plain .md
// rather than a store file: they are the user's own text, so they stay
// readable and editable outside the app. A note is read when its panel first
// opens, and closing a session removes its file.
interface NotesState {
  /** Loaded notes. A missing key means "not read from disk yet", not "empty". */
  notes: Record<string, string>;
  setNote: (sessionId: string, text: string) => void;
  /** Drop a session's notes (its session was closed). */
  removeNote: (sessionId: string) => void;
  /** Read a session's note into the store, once. */
  loadNote: (sessionId: string) => Promise<void>;
}

// One debounced writer per session, so two panels can't overwrite each other.
const writers = new Map<string, ReturnType<typeof debouncedWriter<string>>>();
function writerFor(sessionId: string) {
  let w = writers.get(sessionId);
  if (!w) {
    w = debouncedWriter<string>(async (text) => {
      try {
        await invoke("write_note", { sessionId, text });
      } catch (e) {
        console.error("failed to save notes", e);
      }
    }, 400);
    writers.set(sessionId, w);
  }
  return w;
}

export const useNotes = create<NotesState>((set, get) => ({
  notes: {},
  setNote: (sessionId, text) => {
    set((s) => ({ notes: { ...s.notes, [sessionId]: text } }));
    writerFor(sessionId).schedule(text);
  },
  removeNote: (sessionId) => {
    // Cancel first: a write scheduled seconds ago would otherwise land after
    // the delete and put the file back.
    writers.get(sessionId)?.cancel();
    writers.delete(sessionId);
    void invoke("delete_note", { sessionId }).catch((e) =>
      console.error("failed to delete notes", e),
    );
    set((s) => {
      if (!(sessionId in s.notes)) return s;
      const notes = { ...s.notes };
      delete notes[sessionId];
      return { notes };
    });
  },
  loadNote: async (sessionId) => {
    if (get().notes[sessionId] !== undefined) return;
    try {
      const text = await invoke<string>("read_note", { sessionId });
      // An edit may have landed while the read was in flight; it wins.
      set((s) =>
        s.notes[sessionId] === undefined
          ? { notes: { ...s.notes, [sessionId]: text } }
          : s,
      );
    } catch (e) {
      console.error("failed to load notes", e);
    }
  },
}));

/** Write any pending note change immediately (e.g. before the app closes). */
export const flushNotes = async (): Promise<void> => {
  await Promise.all([...writers.values()].map((w) => w.flush()));
};
