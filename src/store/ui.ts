import { create } from "zustand";

export interface ConfirmRequest {
  title: string;
  description?: string;
  confirmLabel?: string;
  // Optional opt-in checkbox (e.g. "also delete the worktree"); its checked
  // state is passed to onConfirm. `warning` shows under the label (e.g. a
  // data-loss caveat that applies to the checked action, not the dialog itself).
  checkbox?: { label: string; defaultChecked?: boolean; warning?: string };
  onConfirm: (checked: boolean) => void;
}

interface UIState {
  newSessionOpen: boolean;
  setNewSessionOpen: (open: boolean) => void;
  openNewSession: () => void;

  settingsOpen: boolean;
  // Which settings tab to show when the dialog (re)opens.
  settingsTab: string;
  setSettingsOpen: (open: boolean) => void;
  openSettings: (tab?: string) => void;

  launchersOpen: boolean;
  setLaunchersOpen: (open: boolean) => void;
  openLaunchers: () => void;

  notificationsOpen: boolean;
  setNotificationsOpen: (open: boolean) => void;
  openNotifications: () => void;

  // The sessions/backend dialog.
  sessionsOpen: boolean;
  setSessionsOpen: (open: boolean) => void;
  openSessions: () => void;

  // An incompatible session daemon (older version) is running; prompt to restart.
  daemonSkew: boolean;
  setDaemonSkew: (open: boolean) => void;

  paletteOpen: boolean;
  // Initial query for the palette (e.g. a section prefix like "l:"), consumed
  // when it opens. Plain open/toggle clear it.
  paletteSeed: string;
  setPaletteOpen: (open: boolean) => void;
  togglePalette: () => void;
  openPaletteWith: (seed: string) => void;

  helpOpen: boolean;
  setHelpOpen: (open: boolean) => void;
  openHelp: () => void;

  // The "thel >_" app/profile menu in the title bar.
  profileMenuOpen: boolean;
  setProfileMenuOpen: (open: boolean) => void;
  toggleProfileMenu: () => void;

  // Bumped to ask the active terminal to refocus (e.g. leaving sidebar nav).
  focusNonce: number;
  focusTerminal: () => void;

  sidebarWidth: number;
  setSidebarWidth: (w: number) => void;
  sidebarCollapsed: boolean;
  toggleSidebar: () => void;

  // The session whose settings dialog (name + icon) is open (null = closed).
  sessionSettings: string | null;
  openSessionSettings: (sessionId: string) => void;
  closeSessionSettings: () => void;

  // The "add an icon to the library" dialog (global, not session-specific).
  addIconOpen: boolean;
  setAddIconOpen: (open: boolean) => void;

  // The confirmation currently shown, plus any requested while it's open. A
  // single slot would let a second request (a rapid second close, a launcher
  // error) clobber an open dialog; queue them so each is answered in turn.
  confirm: ConfirmRequest | null;
  confirmQueue: ConfirmRequest[];
  requestConfirm: (req: ConfirmRequest) => void;
  clearConfirm: () => void;
}

export const SIDEBAR_MIN = 160;
export const SIDEBAR_MAX = 480;

const WIDTH_KEY = "thel.sidebarWidth";
const COLLAPSED_KEY = "thel.sidebarCollapsed";

function readWidth(): number {
  if (typeof localStorage === "undefined") return 224;
  const n = Number(localStorage.getItem(WIDTH_KEY));
  return Number.isFinite(n) && n > 0
    ? Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, n))
    : 224;
}

function readCollapsed(): boolean {
  return (
    typeof localStorage !== "undefined" &&
    localStorage.getItem(COLLAPSED_KEY) === "1"
  );
}

export const useUI = create<UIState>((set) => ({
  newSessionOpen: false,
  setNewSessionOpen: (open) => set({ newSessionOpen: open }),
  openNewSession: () => set({ newSessionOpen: true }),

  settingsOpen: false,
  settingsTab: "appearance",
  setSettingsOpen: (open) => set({ settingsOpen: open }),
  openSettings: (tab = "appearance") =>
    set({ settingsOpen: true, settingsTab: tab }),

  launchersOpen: false,
  setLaunchersOpen: (open) => set({ launchersOpen: open }),
  openLaunchers: () => set({ launchersOpen: true }),

  notificationsOpen: false,
  setNotificationsOpen: (open) => set({ notificationsOpen: open }),
  openNotifications: () => set({ notificationsOpen: true }),

  sessionsOpen: false,
  setSessionsOpen: (open) => set({ sessionsOpen: open }),
  openSessions: () => set({ sessionsOpen: true }),

  daemonSkew: false,
  setDaemonSkew: (open) => set({ daemonSkew: open }),

  paletteOpen: false,
  paletteSeed: "",
  setPaletteOpen: (open) => set({ paletteOpen: open, paletteSeed: "" }),
  togglePalette: () =>
    set((s) => ({ paletteOpen: !s.paletteOpen, paletteSeed: "" })),
  openPaletteWith: (seed) => set({ paletteOpen: true, paletteSeed: seed }),

  helpOpen: false,
  setHelpOpen: (open) => set({ helpOpen: open }),
  openHelp: () => set({ helpOpen: true }),

  profileMenuOpen: false,
  setProfileMenuOpen: (open) => set({ profileMenuOpen: open }),
  toggleProfileMenu: () => set((s) => ({ profileMenuOpen: !s.profileMenuOpen })),

  focusNonce: 0,
  focusTerminal: () => set((s) => ({ focusNonce: s.focusNonce + 1 })),

  sidebarWidth: readWidth(),
  setSidebarWidth: (w) => {
    const clamped = Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, w));
    localStorage.setItem(WIDTH_KEY, String(clamped));
    set({ sidebarWidth: clamped });
  },
  sidebarCollapsed: readCollapsed(),
  toggleSidebar: () =>
    set((s) => {
      const collapsed = !s.sidebarCollapsed;
      localStorage.setItem(COLLAPSED_KEY, collapsed ? "1" : "0");
      return { sidebarCollapsed: collapsed };
    }),

  sessionSettings: null,
  openSessionSettings: (sessionId) => set({ sessionSettings: sessionId }),
  closeSessionSettings: () => set({ sessionSettings: null }),

  addIconOpen: false,
  setAddIconOpen: (open) => set({ addIconOpen: open }),

  confirm: null,
  confirmQueue: [],
  // Show it now if nothing's open, else line it up behind the current one.
  requestConfirm: (req) =>
    set((s) =>
      s.confirm ? { confirmQueue: [...s.confirmQueue, req] } : { confirm: req },
    ),
  // Advance to the next queued confirmation, or close when none remain.
  clearConfirm: () =>
    set((s) => {
      const [next, ...rest] = s.confirmQueue;
      return { confirm: next ?? null, confirmQueue: rest };
    }),
}));
