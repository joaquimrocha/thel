import {
  useSessions,
  sessionTerminals,
  activeGroupOf,
  layoutLeafIds,
  terminalDisplayTitle,
} from "@/store/sessions";
import { useUI } from "@/store/ui";
import { usePrefs } from "@/store/prefs";
import { clampZoomOffset } from "@/lib/theme";
import { terminalBusy } from "@/lib/pty";
import { gitInfo, worktreeInfo, removeWorktree } from "@/lib/git";
import { abbreviatePath } from "@/lib/paths";
import { toast } from "sonner";

/** Close a terminal, confirming first if a command is running. */
export async function closeTerminalConfirmed(terminalId: string) {
  const { sessions, closeTerminal } = useSessions.getState();
  let title = "this terminal";
  let running = false;
  for (const s of sessions) {
    const t = sessionTerminals(s).find((x) => x.id === terminalId);
    if (t) {
      title = terminalDisplayTitle(t);
      running = !!t.started && !t.exited;
      break;
    }
  }
  if (running && (await terminalBusy(terminalId).catch(() => false))) {
    useUI.getState().requestConfirm({
      title: `Close “${title}”?`,
      description: "A command is still running. Closing it ends the process.",
      confirmLabel: "Close terminal",
      onConfirm: () => closeTerminal(terminalId),
    });
  } else {
    closeTerminal(terminalId);
  }
}

/** Close a session, always confirming. When its directory is a linked git
 * worktree, the dialog offers to remove it too (warning when it has
 * uncommitted/untracked changes that a removal would discard). */
export async function closeSessionConfirmed(sessionId: string) {
  const { sessions, removeSession } = useSessions.getState();
  const session = sessions.find((s) => s.id === sessionId);
  if (!session) return;

  const candidates = sessionTerminals(session).filter(
    (t) => t.started && !t.exited,
  );
  const busy = (
    await Promise.all(candidates.map((t) => terminalBusy(t.id).catch(() => false)))
  ).some(Boolean);

  // Offer removal for any linked worktree (not just ones thel created), but never
  // the main checkout. Detect it live; check for changes so we can warn first.
  const wtInfo = session.cwd
    ? await worktreeInfo(session.cwd).catch(() => null)
    : null;
  const wt = wtInfo?.is_linked ? wtInfo : null;
  const dirty = wt
    ? !!(await gitInfo(session.cwd!).catch(() => null))?.dirty
    : false;

  useUI.getState().requestConfirm({
    title: `Close “${session.name}”?`,
    description: busy
      ? "A command is still running in this session. Closing it ends it."
      : undefined,
    confirmLabel: "Close session",
    checkbox: wt
      ? {
          label: `Also delete the worktree (${abbreviatePath(wt.path)})`,
          // Pre-check only when clean; deleting a dirty worktree is destructive
          // and should be a deliberate opt-in.
          defaultChecked: !dirty,
          warning: dirty
            ? "This worktree has uncommitted or untracked changes that will be lost."
            : undefined,
        }
      : undefined,
    onConfirm: (deleteWorktree) => {
      removeSession(sessionId);
      if (wt && deleteWorktree) {
        // Remove from the main worktree (git refuses from inside the target) and
        // force when dirty; the warning already told the user changes are lost.
        void removeWorktree(wt.main, wt.path, dirty).catch((e) =>
          toast.error(`Failed to remove worktree: ${e}`),
        );
      }
    },
  });
}

/** Close the active group's active terminal. */
export function closeActiveTerminal() {
  const { sessions, activeSessionId } = useSessions.getState();
  const s = sessions.find((x) => x.id === activeSessionId);
  const g = s && activeGroupOf(s);
  if (g?.activeTerminalId) void closeTerminalConfirmed(g.activeTerminalId);
}

/** Cycle the active terminal within the active split group (+1 next, -1 prev). */
export function cycleTerminal(dir: 1 | -1) {
  const { sessions, activeSessionId, setActiveTerminal } = useSessions.getState();
  const s = sessions.find((x) => x.id === activeSessionId);
  const g = s && activeGroupOf(s);
  if (!s || !g || g.terminals.length === 0) return;
  const i = g.terminals.findIndex((t) => t.id === g.activeTerminalId);
  const next = (i + dir + g.terminals.length) % g.terminals.length;
  setActiveTerminal(s.id, g.terminals[next].id);
}

/** Focus the nth terminal (0-based) of the active split group, if it exists. */
export function focusTerminalByIndex(n: number) {
  const { sessions, activeSessionId, setActiveTerminal } = useSessions.getState();
  const s = sessions.find((x) => x.id === activeSessionId);
  const g = s && activeGroupOf(s);
  const t = g?.terminals[n];
  if (s && t) setActiveTerminal(s.id, t.id);
}

/** Close every terminal in a pane (the active one if omitted), after
 * confirmation. */
export function closeAllTerminals(groupId?: string) {
  const { sessions, activeSessionId, closeTerminal } = useSessions.getState();
  const s = sessions.find((x) => x.id === activeSessionId);
  if (!s) return;
  const group = s.groups.find((g) => g.id === (groupId ?? s.activeGroupId));
  if (!group) return;
  const ids = group.terminals.map((t) => t.id);
  if (ids.length === 0) return;
  useUI.getState().requestConfirm({
    title: "Close all terminals?",
    description: `This closes all ${ids.length} terminal${
      ids.length === 1 ? "" : "s"
    } in this pane.`,
    confirmLabel: "Close all",
    onConfirm: () => ids.forEach((id) => closeTerminal(id)),
  });
}

/** Cycle the focused split pane within the active session (+1 next, -1 prev). */
export function cyclePane(dir: 1 | -1) {
  const { sessions, activeSessionId, setActiveGroup } = useSessions.getState();
  const s = sessions.find((x) => x.id === activeSessionId);
  if (!s) return;
  const ids = layoutLeafIds(s.layout); // visual order
  if (ids.length <= 1) return; // nothing to move between
  const i = ids.indexOf(s.activeGroupId);
  const next = (i + dir + ids.length) % ids.length;
  setActiveGroup(s.id, ids[next]);
}

/** The active group's active terminal id, if any. */
function activeTerminalId(): string | undefined {
  const { sessions, activeSessionId } = useSessions.getState();
  const s = sessions.find((x) => x.id === activeSessionId);
  return (s && activeGroupOf(s))?.activeTerminalId;
}

/** Zoom the active terminal in (+1) or out (-1), one px step per press. */
export function zoomActiveTerminal(delta: 1 | -1) {
  const id = activeTerminalId();
  if (!id) return;
  const { sessions, setZoom } = useSessions.getState();
  const t = sessions.flatMap(sessionTerminals).find((x) => x.id === id);
  if (!t) return;
  const current = t.zoom ?? usePrefs.getState().terminalZoom;
  setZoom(id, clampZoomOffset(current + delta));
}

/** Reset the active terminal to the current default zoom. */
export function resetActiveTerminalZoom() {
  const id = activeTerminalId();
  if (id) useSessions.getState().setZoom(id, usePrefs.getState().terminalZoom);
}

/** Cycle the active session (+1 next, -1 prev). */
export function cycleSession(dir: 1 | -1) {
  const { sessions, activeSessionId, setActiveSession } = useSessions.getState();
  if (sessions.length === 0) return;
  const i = sessions.findIndex((x) => x.id === activeSessionId);
  const next = (i + dir + sessions.length) % sessions.length;
  setActiveSession(sessions[next].id);
}

/** Move the active terminal within its pane one slot left (-1) or right (1). */
export function moveTerminal(dir: 1 | -1) {
  const { sessions, activeSessionId, reorderTerminal } = useSessions.getState();
  const s = sessions.find((x) => x.id === activeSessionId);
  const g = s && activeGroupOf(s);
  if (!s || !g || !g.activeTerminalId) return;
  const i = g.terminals.findIndex((t) => t.id === g.activeTerminalId);
  if (i === -1) return;
  reorderTerminal(s.id, g.id, g.activeTerminalId, i + dir);
}

/** Move the active session up (-1) or down (1) in the sidebar. */
export function moveSession(dir: 1 | -1) {
  const { sessions, activeSessionId, reorderSession } = useSessions.getState();
  if (!activeSessionId) return;
  const i = sessions.findIndex((x) => x.id === activeSessionId);
  if (i === -1) return;
  reorderSession(activeSessionId, i + dir);
}
