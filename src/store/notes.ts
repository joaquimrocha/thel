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
  /** Take a note `thel session note` already saved as `text`. An append
   * also goes after what the user typed but has not saved yet, which the
   * daemon never saw, and that is saved again; a replace drops it. */
  receiveNote: (sessionId: string, text: string, edit: NoteEdit) => void;
  /** Save a pending edit and forget the note here, keeping its file: its
   * session moved to another window, and this one must read it fresh if the
   * session comes back. */
  releaseNote: (sessionId: string) => Promise<void>;
  /** Read a session's note into the store, once. */
  loadNote: (sessionId: string) => Promise<void>;
}

/** How `thel session note` changed a note (session::NoteEdit). */
export type NoteEdit = { kind: "set" | "append"; text: string };

// The same rule as NoteEdit::apply in session.rs, so a merged append reads as
// one the daemon made.
function appendNote(old: string, text: string) {
  if (text === "") return old;
  const out = (old === "" || old.endsWith("\n") ? old : `${old}\n`) + text;
  return out.endsWith("\n") ? out : `${out}\n`;
}

// One debounced writer per session, so two panels can't overwrite each other.
const writers = new Map<string, ReturnType<typeof debouncedWriter<string>>>();
// The save of each session's note that is on its way to disk.
const saving = new Map<string, Promise<unknown>>();
// Each session's note as this window last read, saved or heard it is on disk,
// to tell unsaved typing from a note that already has a change it hears of.
const disk = new Map<string, string>();
// How long a save that found the note changed waits for the event of the
// `thel session note` edit that changed it.
const CHANGE_WAIT_MS = 1000;
function writerFor(sessionId: string) {
  let w = writers.get(sessionId);
  if (!w) {
    w = debouncedWriter<string>(async (text) => {
      const base = disk.get(sessionId);
      const done = invoke<string | null>("write_note", { sessionId, text, base: base ?? null });
      saving.set(sessionId, done);
      try {
        const changed = await done;
        // An event heard meanwhile moved `disk` on already.
        if (disk.get(sessionId) !== base) return;
        if (changed === null) disk.set(sessionId, text);
        else setTimeout(() => overwrite(sessionId, base, changed), CHANGE_WAIT_MS);
      } catch (e) {
        console.error("failed to save notes", e);
      } finally {
        if (saving.get(sessionId) === done) saving.delete(sessionId);
      }
    }, 400);
    writers.set(sessionId, w);
  }
  return w;
}

// A note changed on disk with no event: something outside thel edited it,
// and this window's text goes over it.
// ponytail: an event slower than CHANGE_WAIT_MS loses its edit the same way.
function overwrite(sessionId: string, base: string | undefined, now: string) {
  const text = useNotes.getState().notes[sessionId];
  if (disk.get(sessionId) !== base || text === undefined || !writers.has(sessionId)) return;
  disk.set(sessionId, now);
  writerFor(sessionId).schedule(text);
}

function forget(sessionId: string) {
  useNotes.setState((s) => {
    if (!(sessionId in s.notes)) return s;
    const notes = { ...s.notes };
    delete notes[sessionId];
    return { notes };
  });
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
    disk.delete(sessionId);
    void invoke("write_note", { sessionId, text: "" }).catch((e) =>
      console.error("failed to delete notes", e),
    );
    forget(sessionId);
  },
  receiveNote: (sessionId, text, edit) => {
    // A note read or saved after the daemon's write has its edit already.
    if (disk.get(sessionId) === text) return;
    const local = get().notes[sessionId];
    const unsaved = local !== undefined && local !== disk.get(sessionId);
    const merged = edit.kind === "append" && unsaved ? appendNote(local, edit.text) : text;
    disk.set(sessionId, text);
    if (merged === text) writers.get(sessionId)?.cancel();
    else writerFor(sessionId).schedule(merged);
    set((s) => ({ notes: { ...s.notes, [sessionId]: merged } }));
  },
  releaseNote: async (sessionId) => {
    const writer = writers.get(sessionId);
    const inFlight = saving.get(sessionId);
    writers.delete(sessionId);
    disk.delete(sessionId);
    forget(sessionId);
    await writer?.flush();
    await inFlight?.catch(() => {});
  },
  loadNote: async (sessionId) => {
    if (get().notes[sessionId] !== undefined) return;
    try {
      const text = await invoke<string>("read_note", { sessionId });
      // An edit may have landed while the read was in flight; it wins.
      set((s) => {
        if (s.notes[sessionId] !== undefined) return s;
        disk.set(sessionId, text);
        return { notes: { ...s.notes, [sessionId]: text } };
      });
    } catch (e) {
      // A missing file reads as "" on the backend, so this is a real failure.
      // Leave the key unset so the next load retries instead of showing an
      // empty note in place of one that exists.
      console.error("failed to load notes", e);
    }
  },
}));

/** Write any pending note change immediately (e.g. before the app closes). */
export const flushNotes = async (): Promise<void> => {
  await Promise.all([...writers.values()].map((w) => w.flush()));
};
