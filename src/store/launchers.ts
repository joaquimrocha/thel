import { create } from "zustand";
import { load, type Store } from "@tauri-apps/plugin-store";
import { debouncedWriter } from "@/lib/persistDebounce";
import { storeFile } from "@/lib/storeFile";

export interface Launcher {
  id: string;
  name: string;
  // A command line run in the session's cwd. Empty => a plain shell. It may
  // reference __SESSION_DIR__ / __SESSION_ID__ / __SESSION_NAME__, replaced
  // at launch.
  command: string;
  // Run the command via a login shell (PATH/profile apply). Off = exec the
  // command directly. undefined (pre-flag persisted data) means on.
  shell?: boolean;
}

// Fallback when no launcher is starred (or none exist): a plain shell.
export const SHELL_LAUNCHER: Launcher = { id: "shell", name: "Terminal", command: "" };

interface LauncherState {
  launchers: Launcher[];
  // Used by the + button and new sessions.
  defaultLauncherId: string | null;
  add: (launcher: Omit<Launcher, "id">) => void;
  update: (id: string, patch: Partial<Omit<Launcher, "id">>) => void;
  remove: (id: string) => void;
  setDefault: (id: string) => void;
  hydrate: (launchers: Launcher[], defaultLauncherId: string | null) => void;
}

export const useLaunchers = create<LauncherState>((set) => {
  return {
    launchers: [],
    defaultLauncherId: null,
    add: (launcher) =>
      set((s) => ({
        launchers: [...s.launchers, { id: crypto.randomUUID(), ...launcher }],
      })),
    update: (id, patch) =>
      set((s) => ({
        launchers: s.launchers.map((l) => (l.id === id ? { ...l, ...patch } : l)),
      })),
    remove: (id) =>
      set((s) => ({
        launchers: s.launchers.filter((l) => l.id !== id),
        defaultLauncherId:
          s.defaultLauncherId === id ? null : s.defaultLauncherId,
      })),
    // Toggle: clicking the current default clears it (no default => plain shell).
    setDefault: (id) =>
      set((s) => ({ defaultLauncherId: s.defaultLauncherId === id ? null : id })),
    hydrate: (launchers, defaultLauncherId) =>
      set({
        launchers,
        defaultLauncherId:
          defaultLauncherId && launchers.some((l) => l.id === defaultLauncherId)
            ? defaultLauncherId
            : null,
      }),
  };
});

/** The launcher used by the + button / new sessions; a plain shell if none is starred. */
export function getDefaultLauncher(): Launcher {
  const { launchers, defaultLauncherId } = useLaunchers.getState();
  return launchers.find((l) => l.id === defaultLauncherId) ?? SHELL_LAUNCHER;
}

const FILE = storeFile("thel-launchers.json");

let storePromise: Promise<Store> | null = null;
const getStore = () =>
  (storePromise ??= load(FILE, { autoSave: false, defaults: {} }));

export async function hydrateLaunchers(): Promise<void> {
  try {
    const store = await getStore();
    // undefined = nothing ever saved (keep the empty initial state);
    // [] = a deliberately emptied list. Both mean no launchers.
    const launchers = await store.get<Launcher[]>("launchers");
    if (launchers) {
      const def = await store.get<string>("defaultLauncherId");
      useLaunchers.getState().hydrate(launchers, def ?? null);
    }
  } catch (e) {
    console.error("failed to load launchers", e);
  }
}

const writer = debouncedWriter<Pick<LauncherState, "launchers" | "defaultLauncherId">>(async (state) => {
  try {
    const store = await getStore();
    await store.set("launchers", state.launchers);
    await store.set("defaultLauncherId", state.defaultLauncherId);
    await store.save();
  } catch (e) {
    console.error("failed to save launchers", e);
  }
}, 300);

/** Write any pending launcher change immediately (e.g. before the app closes). */
export const flushLaunchers = writer.flush;

export function startLauncherPersistence(): () => void {
  return useLaunchers.subscribe((state) =>
    writer.schedule({
      launchers: state.launchers,
      defaultLauncherId: state.defaultLauncherId,
    }),
  );
}
