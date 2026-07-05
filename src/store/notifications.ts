import { create } from "zustand";
import { useSessions, sessionTerminals, terminalDisplayTitle } from "./sessions";
import { usePrefs } from "./prefs";
import { systemNotify } from "@/lib/systemNotify";
import { appFocused } from "@/lib/focus";

export type NotificationKind = "bell" | "idle" | "message" | "waiting";

export function kindLabel(kind: NotificationKind, detail?: string): string {
  switch (kind) {
    case "bell":
      return "Wants input";
    // A notification the program asked for itself (OSC 9/777/99), with its
    // own message text.
    case "message":
      return detail ?? "Notification";
    // A resident agent (claude) that was working went quiet while still in the
    // foreground: its turn ended and it's waiting for you.
    case "waiting":
      return "Waiting for input";
    case "idle":
      return "Command finished";
  }
}

export interface Notification {
  id: string;
  at: number;
  sessionId: string;
  sessionName: string;
  terminalId: string;
  terminalTitle: string;
  kind: NotificationKind;
  detail?: string;
  read: boolean;
}

// Keep history bounded.
const MAX = 200;

interface NotificationsState {
  items: Notification[];
  add: (n: Omit<Notification, "id" | "at" | "read">) => void;
  markAllRead: () => void;
  clearForTerminal: (terminalId: string) => void;
  clear: () => void;
}

export const useNotifications = create<NotificationsState>((set) => ({
  items: [],
  add: (n) =>
    set((s) => ({
      items: [
        { ...n, id: crypto.randomUUID(), at: Date.now(), read: false },
        ...s.items,
      ].slice(0, MAX),
    })),
  markAllRead: () =>
    set((s) => ({ items: s.items.map((i) => ({ ...i, read: true })) })),
  // Drop a terminal's notifications once the user attends to it.
  clearForTerminal: (terminalId) =>
    set((s) => ({ items: s.items.filter((i) => i.terminalId !== terminalId) })),
  clear: () => set({ items: [] }),
}));

/** Record a notification for a terminal, resolving its session/terminal names.
 * Raises the terminal's attention dot and, when the window is unfocused, an OS
 * banner. Per-kind and desktop toggles (prefs) gate it centrally, so a disabled
 * kind raises nothing (no dot, no list entry, no banner). */
export function notify(
  terminalId: string,
  kind: NotificationKind,
  detail?: string,
) {
  const p = usePrefs.getState();
  if (kind === "bell" && !p.notifyBell) return;
  if (kind === "waiting" && !p.notifyAgentWaiting) return;
  if (kind === "idle" && !p.notifyCommandFinished) return;

  const { sessions, setAttention } = useSessions.getState();
  for (const s of sessions) {
    const t = sessionTerminals(s).find((x) => x.id === terminalId);
    if (t) {
      setAttention(terminalId, true);
      const title = terminalDisplayTitle(t);
      useNotifications.getState().add({
        sessionId: s.id,
        sessionName: s.name,
        terminalId,
        terminalTitle: title,
        kind,
        detail,
      });
      // Mirror to the OS only when the app isn't focused and desktop
      // notifications are enabled; otherwise the in-app dot/panel is enough.
      // Pass the target so a click jumps to this terminal.
      if (!appFocused() && p.notifyDesktop) {
        systemNotify(`${s.name} › ${title}`, kindLabel(kind, detail), {
          sessionId: s.id,
          terminalId,
        });
      }
      return;
    }
  }
}

/** Switch to the terminal a notification was about (the in-app jump and the
 * clicked-OS-banner path share this). Falls back to the session if the exact
 * terminal is gone. No-op if the session was closed. */
export function activateNotification(sessionId: string, terminalId: string) {
  const { sessions, setActiveSession, setActiveTerminal } =
    useSessions.getState();
  const session = sessions.find((s) => s.id === sessionId);
  if (!session) return;
  if (sessionTerminals(session).some((t) => t.id === terminalId)) {
    setActiveTerminal(sessionId, terminalId);
  } else {
    setActiveSession(sessionId);
  }
}
