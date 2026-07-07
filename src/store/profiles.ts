import { create } from "zustand";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { load, type Store } from "@tauri-apps/plugin-store";
import { copyLayoutToProfile } from "@/lib/persistence";
import { storeFile } from "@/lib/storeFile";

// A profile is a named set of sessions. Each profile is shown in its own OS
// window; the default profile lives in the main window and needs no setup.
export interface Profile {
  id: string;
  name: string;
  // Optional accent color used to tint this profile's window.
  color?: string;
}

export interface NewProfileOpts {
  color?: string;
  // Start the new profile as a copy of the current window's session layout.
  copyCurrent?: boolean;
}

export const DEFAULT_PROFILE: Profile = { id: "default", name: "Default" };

// Preset accent colors offered when creating/editing a profile.
export const PROFILE_COLORS = [
  "#ef4444",
  "#f59e0b",
  "#facc15",
  "#10b981",
  "#06b6d4",
  "#3b82f6",
  "#8b5cf6",
  "#ec4899",
  "#64748b",
];

const FILE = storeFile("thel-profiles.json");
const KEY = "profiles";

// The default profile is the main window; others get a profile-<id> window.
const labelFor = (id: string) => (id === "default" ? "main" : `profile-${id}`);
const idFromLabel = (label: string) =>
  label === "main" ? "default" : label.replace(/^profile-/, "");

/** The profile id of the window this code is running in. */
export function currentProfileId(): string {
  return idFromLabel(getCurrentWindow().label);
}

let storePromise: Promise<Store> | null = null;
const getStore = () =>
  (storePromise ??= load(FILE, { autoSave: false, defaults: {} }));

// Guards the one-time cross-window change subscription (see hydrate).
let synced = false;

// Labels whose window is mid-creation. getByLabel doesn't see a freshly-created
// WebviewWindow until it registers, so two quick switchProfile calls (a
// double-click, or a notification jump racing a manual switch) would otherwise
// both pass the existence check and open duplicate windows for one profile.
const opening = new Set<string>();

/** Whether a profile named `name` already exists (case-insensitive), other
 * than `exceptId`. Names must be unique. */
export function profileNameTaken(
  profiles: Profile[],
  name: string,
  exceptId?: string,
): boolean {
  const n = name.trim().toLowerCase();
  return profiles.some((p) => p.id !== exceptId && p.name.toLowerCase() === n);
}

// The default profile is the implicit main window, but its name/color overrides
// are stored alongside the others so it can be customized too.
async function persistProfiles(profiles: Profile[]) {
  try {
    const store = await getStore();
    await store.set(KEY, profiles);
    await store.save();
  } catch (e) {
    console.error("failed to save profiles", e);
  }
}

interface ProfilesState {
  profiles: Profile[];
  currentId: string;
  hydrate: () => Promise<void>;
  // Create a profile and open its window.
  createProfile: (name: string, opts?: NewProfileOpts) => Promise<void>;
  // Focus the profile's window, opening it if needed.
  switchProfile: (id: string) => Promise<void>;
  // Management (the default profile can be edited but not removed).
  renameProfile: (id: string, name: string) => Promise<void>;
  setProfileColor: (id: string, color: string | undefined) => Promise<void>;
  removeProfile: (id: string) => Promise<void>;
}

export const useProfiles = create<ProfilesState>((set, get) => ({
  // Default is always present; the rest load from disk on hydrate().
  profiles: [DEFAULT_PROFILE],
  currentId: currentProfileId(),

  hydrate: async () => {
    try {
      const store = await getStore();
      // The default profile always exists and stays first; a stored entry for it
      // carries its name/color overrides.
      const apply = (saved: Profile[] | undefined) => {
        const list = saved ?? [];
        const savedDefault = list.find((p) => p.id === "default");
        set({
          profiles: [
            savedDefault ?? DEFAULT_PROFILE,
            ...list.filter((p) => p.id !== "default"),
          ],
        });
      };
      apply(await store.get<Profile[]>(KEY));
      // The store is shared across profile windows, so a rename/add/remove in one
      // emits a key change the others apply -- keeping every window's list live
      // instead of stale until reload. Subscribe once per window.
      if (!synced) {
        synced = true;
        await store.onKeyChange<Profile[]>(KEY, apply);
      }
    } catch (e) {
      console.error("failed to load profiles", e);
    }
  },

  createProfile: async (name, opts) => {
    const trimmed = name.trim() || "Untitled";
    if (profileNameTaken(get().profiles, trimmed)) return;
    const profile: Profile = {
      id: crypto.randomUUID(),
      name: trimmed,
      color: opts?.color,
    };
    // Persist before opening the window so the new window sees itself in the
    // registry (and its copied layout) when it hydrates.
    const profiles = [...get().profiles, profile];
    set({ profiles });
    await persistProfiles(profiles);
    if (opts?.copyCurrent) await copyLayoutToProfile(profile.id);
    await get().switchProfile(profile.id);
  },

  switchProfile: async (id) => {
    if (id === get().currentId) return;
    const label = labelFor(id);
    if (opening.has(label)) return;
    try {
      const existing = await WebviewWindow.getByLabel(label);
      if (existing) {
        await existing.setFocus();
        return;
      }
      const profile = get().profiles.find((p) => p.id === id);
      opening.add(label);
      // The new window loads the same app and reads its own label to know which
      // profile (and which session layout) to show.
      const w = new WebviewWindow(label, {
        url: "index.html",
        title: profile ? `thel — ${profile.name}` : "thel",
        decorations: false,
        // Match the app background so the new window doesn't flash white.
        backgroundColor: [9, 9, 11, 255],
        width: 1100,
        height: 720,
        minWidth: 640,
        minHeight: 400,
      });
      // Release the guard once the window exists (or fails to), so a later
      // re-open can still happen after this window is closed.
      w.once("tauri://created", () => opening.delete(label));
      w.once("tauri://error", () => opening.delete(label));
    } catch (e) {
      opening.delete(label);
      console.error("failed to switch profile", e);
    }
  },

  renameProfile: async (id, name) => {
    const trimmed = name.trim();
    // Clearing the default's name reverts it to "Default"; other profiles
    // can't be left blank.
    const finalName = trimmed || (id === "default" ? DEFAULT_PROFILE.name : "");
    if (!finalName || profileNameTaken(get().profiles, finalName, id)) return;
    const profiles = get().profiles.map((p) =>
      p.id === id ? { ...p, name: finalName } : p,
    );
    set({ profiles });
    await persistProfiles(profiles);
  },

  setProfileColor: async (id, color) => {
    const profiles = get().profiles.map((p) =>
      p.id === id ? { ...p, color } : p,
    );
    set({ profiles });
    await persistProfiles(profiles);
  },

  removeProfile: async (id) => {
    // Never remove the default or the profile of the window you're in.
    if (id === "default" || id === get().currentId) return;
    const profiles = get().profiles.filter((p) => p.id !== id);
    set({ profiles });
    await persistProfiles(profiles);
    try {
      const w = await WebviewWindow.getByLabel(labelFor(id));
      await w?.close();
    } catch {
      // window may not be open; ignore
    }
  },
}));
