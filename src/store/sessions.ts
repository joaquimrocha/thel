import { create } from "zustand";
import { killTerminalWindow } from "@/lib/pty";

export interface Terminal {
  id: string;
  title: string;
  // The title to fall back to when the user clears a rename.
  defaultTitle?: string;
  // True once the user manually renamed the tab; pins the name so the running
  // program's title (procTitle) no longer overrides it.
  renamed?: boolean;
  // Runtime-only (not persisted): the title the running program set via the OSC
  // title escape (like GNOME Terminal shows). Drives the tab name unless renamed.
  procTitle?: string;
  // Resolved spawn parameters; set once when the terminal is created.
  command: string;
  args: string[];
  cwd?: string;
  // Runtime-only (not persisted): whether the PTY has been spawned this run.
  // Restored terminals start false and wait for an explicit start.
  started?: boolean;
  exited?: boolean;
  exitCode?: number | null;
  // Runtime-only: wants attention (bell or process exit while not focused).
  attention?: boolean;
  // Runtime-only: a foreground process is running (vs an idle shell). Driven by
  // polling the backend's terminal_status; see useBusyPolling.
  busy?: boolean;
  // Per-terminal zoom as a px offset from the system font size; persisted so a
  // terminal reopens at its set zoom. Undefined falls back to the default zoom.
  zoom?: number;
}

// A pane: its own tab strip of terminals and the one currently shown. A session
// has at least one. Panes are stored flat in `groups`; their on-screen
// arrangement is described by the `layout` split tree.
export interface PaneGroup {
  id: string;
  terminals: Terminal[];
  activeTerminalId?: string;
}

// Split direction: "row" lays panes left-to-right (split right), "col" stacks
// them top-to-bottom (split down).
export type SplitDir = "row" | "col";

// Tree arranging a session's panes. A leaf references a PaneGroup by id; a split
// holds children laid out in its direction.
export type LayoutNode =
  | { t: "leaf"; group: string }
  | { t: "split"; dir: SplitDir; children: LayoutNode[] };

export interface Session {
  id: string;
  name: string;
  // The directory the session is anchored to (a folder or git worktree); its
  // terminals default to this cwd. repoRoot is set when cwd is inside a repo.
  cwd?: string;
  repoRoot?: string;
  // Runtime-only (refreshed from git, not persisted).
  branch?: string;
  dirty?: boolean;
  // Panes (flat) and the split tree that arranges them. activeGroupId is the
  // focused pane.
  groups: PaneGroup[];
  layout: LayoutNode;
  activeGroupId: string;
}

export interface SessionInit {
  name?: string;
  cwd?: string;
  repoRoot?: string;
}

/** All terminals in a session, flattened across its split groups. */
export function sessionTerminals(s: Session): Terminal[] {
  return s.groups.flatMap((g) => g.terminals);
}

/** The name to show on a tab: a manual rename wins, else the running program's
 * title, else the launcher/command default. */
export function terminalDisplayTitle(t: Terminal): string {
  if (t.renamed) return t.title;
  return t.procTitle?.trim() || t.title;
}

/** The focused split group of a session (falls back to the first). */
export function activeGroupOf(s: Session): PaneGroup | undefined {
  return s.groups.find((g) => g.id === s.activeGroupId) ?? s.groups[0];
}

/** Pane ids in visual (layout) order, used for pane cycling. */
export function layoutLeafIds(node: LayoutNode): string[] {
  return node.t === "leaf" ? [node.group] : node.children.flatMap(layoutLeafIds);
}

// Split the target leaf in `dir`, inserting a new leaf beside it. If the
// target's parent already splits in `dir`, insert as a sibling (so repeated
// splits stay evenly sized) instead of nesting another split.
function splitLeaf(
  node: LayoutNode,
  targetId: string,
  dir: SplitDir,
  newId: string,
): LayoutNode {
  if (node.t === "leaf") {
    return node.group === targetId
      ? { t: "split", dir, children: [node, { t: "leaf", group: newId }] }
      : node;
  }
  if (node.dir === dir) {
    const idx = node.children.findIndex(
      (c) => c.t === "leaf" && c.group === targetId,
    );
    if (idx >= 0) {
      const children = [...node.children];
      children.splice(idx + 1, 0, { t: "leaf", group: newId });
      return { ...node, children };
    }
  }
  return {
    ...node,
    children: node.children.map((c) => splitLeaf(c, targetId, dir, newId)),
  };
}

// Remove a leaf and collapse any split left with a single child.
function removeLeaf(node: LayoutNode, groupId: string): LayoutNode | null {
  if (node.t === "leaf") return node.group === groupId ? null : node;
  const children = node.children
    .map((c) => removeLeaf(c, groupId))
    .filter((c): c is LayoutNode => c !== null);
  if (children.length === 0) return null;
  if (children.length === 1) return children[0];
  return { ...node, children };
}

export interface SessionState {
  sessions: Session[];
  activeSessionId?: string;
  // False until the saved layout has been loaded; gates the "No sessions" empty
  // state so it doesn't flash before restore on launch.
  hydrated: boolean;

  addSession: (init?: SessionInit) => Session;
  removeSession: (id: string) => void;
  setActiveSession: (id: string) => void;
  renameSession: (id: string, name: string) => void;
  setSessionGit: (id: string, branch: string | undefined, dirty: boolean) => void;

  // groupId defaults to the session's active group.
  addTerminal: (sessionId: string, term: Terminal, groupId?: string) => void;
  // Open `term` in a new pane split off `targetGroupId` (or the active pane) in
  // the given direction.
  splitGroup: (
    sessionId: string,
    term: Terminal,
    dir: SplitDir,
    targetGroupId?: string,
  ) => void;
  startTerminal: (terminalId: string) => void;
  startAllInSession: (sessionId: string) => void;
  renameTerminal: (terminalId: string, title: string) => void;
  setProcTitle: (terminalId: string, title: string) => void;
  closeTerminal: (terminalId: string) => void;
  setActiveTerminal: (sessionId: string, terminalId: string) => void;
  setActiveGroup: (sessionId: string, groupId: string) => void;
  // Reorder a session in the sidebar / a terminal within its pane. toIndex is
  // clamped; used by drag-and-drop and the move shortcuts.
  reorderSession: (id: string, toIndex: number) => void;
  reorderTerminal: (
    sessionId: string,
    groupId: string,
    terminalId: string,
    toIndex: number,
  ) => void;
  // Move a terminal to another pane in the same session, at toIndex. Collapses
  // the source pane if it ends up empty. Used by cross-pane drag.
  moveTerminalToGroup: (
    sessionId: string,
    terminalId: string,
    toGroupId: string,
    toIndex: number,
  ) => void;
  markExited: (terminalId: string, code: number | null) => void;
  setAttention: (terminalId: string, value: boolean) => void;
  // Drop the attention indicator from every terminal (e.g. the user cleared the
  // notifications panel).
  clearAllAttention: () => void;
  setBusy: (terminalId: string, value: boolean) => void;
  // zoom = undefined resets the terminal to the default zoom.
  setZoom: (terminalId: string, zoom: number | undefined) => void;
}

// Pick the neighbor that slides into a removed item's slot, clamping to the end.
function neighborId<T extends { id: string }>(
  remaining: T[],
  removedIdx: number,
): string | undefined {
  return remaining[Math.min(removedIdx, remaining.length - 1)]?.id;
}

// Apply a patch to one terminal wherever it lives, across all sessions/groups.
function patchTerminal(
  sessions: Session[],
  terminalId: string,
  patch: Partial<Terminal>,
): Session[] {
  return sessions.map((ss) => ({
    ...ss,
    groups: ss.groups.map((g) => ({
      ...g,
      terminals: g.terminals.map((t) =>
        t.id === terminalId ? { ...t, ...patch } : t,
      ),
    })),
  }));
}

export const useSessions = create<SessionState>((set, get) => ({
  sessions: [],
  activeSessionId: undefined,
  hydrated: false,

  addSession: (init) => {
    const groupId = crypto.randomUUID();
    const session: Session = {
      id: crypto.randomUUID(),
      name: init?.name ?? `Session ${get().sessions.length + 1}`,
      cwd: init?.cwd,
      repoRoot: init?.repoRoot,
      groups: [{ id: groupId, terminals: [] }],
      layout: { t: "leaf", group: groupId },
      activeGroupId: groupId,
    };
    set((s) => ({
      sessions: [...s.sessions, session],
      activeSessionId: session.id,
    }));
    return session;
  },

  removeSession: (id) => {
    // Kill every terminal's process in the session. The daemon keeps tabs alive
    // on detach, so closing a session must kill them explicitly.
    const session = get().sessions.find((x) => x.id === id);
    if (session) {
      for (const g of session.groups) {
        for (const t of g.terminals) void killTerminalWindow(id, t.id);
      }
    }
    set((s) => {
      const idx = s.sessions.findIndex((x) => x.id === id);
      const sessions = s.sessions.filter((x) => x.id !== id);
      const activeSessionId =
        s.activeSessionId === id
          ? neighborId(sessions, idx)
          : s.activeSessionId;
      return { sessions, activeSessionId };
    });
  },

  setActiveSession: (id) => set({ activeSessionId: id }),

  renameSession: (id, name) =>
    set((s) => ({
      sessions: s.sessions.map((ss) =>
        ss.id === id ? { ...ss, name } : ss,
      ),
    })),

  setSessionGit: (id, branch, dirty) =>
    set((s) => ({
      sessions: s.sessions.map((ss) =>
        ss.id === id ? { ...ss, branch, dirty } : ss,
      ),
    })),

  addTerminal: (sessionId, term, groupId) =>
    set((s) => ({
      activeSessionId: sessionId,
      sessions: s.sessions.map((ss) => {
        if (ss.id !== sessionId) return ss;
        const gid = groupId ?? ss.activeGroupId;
        return {
          ...ss,
          activeGroupId: gid,
          groups: ss.groups.map((g) =>
            g.id === gid
              ? {
                  ...g,
                  // Newly created terminals spawn immediately.
                  terminals: [...g.terminals, { ...term, started: true }],
                  activeTerminalId: term.id,
                }
              : g,
          ),
        };
      }),
    })),

  splitGroup: (sessionId, term, dir, targetGroupId) =>
    set((s) => ({
      activeSessionId: sessionId,
      sessions: s.sessions.map((ss) => {
        if (ss.id !== sessionId) return ss;
        const target = targetGroupId ?? ss.activeGroupId;
        const newGroup: PaneGroup = {
          id: crypto.randomUUID(),
          terminals: [{ ...term, started: true }],
          activeTerminalId: term.id,
        };
        return {
          ...ss,
          groups: [...ss.groups, newGroup],
          layout: splitLeaf(ss.layout, target, dir, newGroup.id),
          activeGroupId: newGroup.id,
        };
      }),
    })),

  startTerminal: (terminalId) =>
    set((s) => ({
      sessions: patchTerminal(s.sessions, terminalId, {
        started: true,
        exited: false,
        exitCode: null,
      }),
    })),

  startAllInSession: (sessionId) =>
    set((s) => ({
      sessions: s.sessions.map((sess) =>
        sess.id !== sessionId
          ? sess
          : {
              ...sess,
              groups: sess.groups.map((g) => ({
                ...g,
                terminals: g.terminals.map((t) =>
                  t.started
                    ? t
                    : { ...t, started: true, exited: false, exitCode: null },
                ),
              })),
            },
      ),
    })),

  renameTerminal: (terminalId, title) =>
    set((s) => ({
      sessions: s.sessions.map((ss) => ({
        ...ss,
        groups: ss.groups.map((g) => ({
          ...g,
          terminals: g.terminals.map((t) =>
            t.id === terminalId
              ? // Renaming back to the default un-pins it: the process title resumes.
                { ...t, title, renamed: title !== (t.defaultTitle ?? title) }
              : t,
          ),
        })),
      })),
    })),

  // The running program set its title via the OSC escape. Ignored once the user
  // has pinned a manual name. Runtime-only: not written to the layout file.
  setProcTitle: (terminalId, title) =>
    set((s) => ({ sessions: patchTerminal(s.sessions, terminalId, { procTitle: title }) })),

  setZoom: (terminalId, zoom) =>
    set((s) => ({ sessions: patchTerminal(s.sessions, terminalId, { zoom }) })),

  closeTerminal: (terminalId) => {
    // Permanently remove the terminal's backend session. Found before the state
    // update so we still know which session it belonged to. No-op without a backend session.
    const owner = get().sessions.find((ss) =>
      ss.groups.some((g) => g.terminals.some((t) => t.id === terminalId)),
    );
    if (owner) void killTerminalWindow(owner.id, terminalId);
    set((s) => ({
      sessions: s.sessions.map((ss) => {
        const gi = ss.groups.findIndex((g) =>
          g.terminals.some((t) => t.id === terminalId),
        );
        if (gi === -1) return ss;
        const group = ss.groups[gi];
        const ti = group.terminals.findIndex((t) => t.id === terminalId);
        const terminals = group.terminals.filter((t) => t.id !== terminalId);

        // The pane keeps other terminals: just update it.
        if (terminals.length > 0) {
          const activeTerminalId =
            group.activeTerminalId === terminalId
              ? neighborId(terminals, ti)
              : group.activeTerminalId;
          const groups = ss.groups.map((g, i) =>
            i === gi ? { ...g, terminals, activeTerminalId } : g,
          );
          return { ...ss, groups };
        }

        // Emptied the pane: remove it and prune the layout.
        const remaining = ss.groups.filter((_, i) => i !== gi);
        const pruned = removeLeaf(ss.layout, group.id);
        if (!pruned || remaining.length === 0) {
          // Last pane in the session: leave one fresh empty pane.
          const fresh: PaneGroup = { id: crypto.randomUUID(), terminals: [] };
          return {
            ...ss,
            groups: [fresh],
            layout: { t: "leaf", group: fresh.id },
            activeGroupId: fresh.id,
          };
        }
        const activeGroupId =
          ss.activeGroupId === group.id
            ? layoutLeafIds(pruned)[0]
            : ss.activeGroupId;
        return { ...ss, groups: remaining, layout: pruned, activeGroupId };
      }),
    }));
  },

  setActiveTerminal: (sessionId, terminalId) =>
    set((s) => ({
      activeSessionId: sessionId,
      sessions: s.sessions.map((ss) => {
        if (ss.id !== sessionId) return ss;
        const gid =
          ss.groups.find((g) => g.terminals.some((t) => t.id === terminalId))
            ?.id ?? ss.activeGroupId;
        return {
          ...ss,
          activeGroupId: gid,
          groups: ss.groups.map((g) =>
            g.id === gid ? { ...g, activeTerminalId: terminalId } : g,
          ),
        };
      }),
    })),

  setActiveGroup: (sessionId, groupId) =>
    set((s) => ({
      activeSessionId: sessionId,
      sessions: s.sessions.map((ss) =>
        ss.id === sessionId ? { ...ss, activeGroupId: groupId } : ss,
      ),
    })),

  reorderSession: (id, toIndex) =>
    set((s) => {
      const from = s.sessions.findIndex((x) => x.id === id);
      if (from === -1) return s;
      const to = Math.max(0, Math.min(toIndex, s.sessions.length - 1));
      if (from === to) return s;
      const sessions = [...s.sessions];
      const [moved] = sessions.splice(from, 1);
      sessions.splice(to, 0, moved);
      return { sessions };
    }),

  reorderTerminal: (sessionId, groupId, terminalId, toIndex) =>
    set((s) => ({
      sessions: s.sessions.map((ss) => {
        if (ss.id !== sessionId) return ss;
        return {
          ...ss,
          groups: ss.groups.map((g) => {
            if (g.id !== groupId) return g;
            const from = g.terminals.findIndex((t) => t.id === terminalId);
            if (from === -1) return g;
            const to = Math.max(0, Math.min(toIndex, g.terminals.length - 1));
            if (from === to) return g;
            const terminals = [...g.terminals];
            const [moved] = terminals.splice(from, 1);
            terminals.splice(to, 0, moved);
            return { ...g, terminals };
          }),
        };
      }),
    })),

  moveTerminalToGroup: (sessionId, terminalId, toGroupId, toIndex) =>
    set((s) => {
      const ss = s.sessions.find((x) => x.id === sessionId);
      const fromGroup = ss?.groups.find((g) =>
        g.terminals.some((t) => t.id === terminalId),
      );
      if (!ss || !fromGroup || fromGroup.id === toGroupId) return s;
      const moved = fromGroup.terminals.find((t) => t.id === terminalId)!;
      const ti = fromGroup.terminals.findIndex((t) => t.id === terminalId);

      let groups = ss.groups.map((g) => {
        if (g.id === fromGroup.id) {
          const terminals = g.terminals.filter((t) => t.id !== terminalId);
          return {
            ...g,
            terminals,
            activeTerminalId:
              g.activeTerminalId === terminalId
                ? neighborId(terminals, ti)
                : g.activeTerminalId,
          };
        }
        if (g.id === toGroupId) {
          const to = Math.max(0, Math.min(toIndex, g.terminals.length));
          const terminals = [...g.terminals];
          terminals.splice(to, 0, moved);
          return { ...g, terminals, activeTerminalId: terminalId };
        }
        return g;
      });

      // Collapse the source pane if the move emptied it.
      let layout = ss.layout;
      const src = groups.find((g) => g.id === fromGroup.id)!;
      if (src.terminals.length === 0) {
        const pruned = removeLeaf(ss.layout, fromGroup.id);
        if (pruned) {
          groups = groups.filter((g) => g.id !== fromGroup.id);
          layout = pruned;
        }
      }

      return {
        activeSessionId: sessionId,
        sessions: s.sessions.map((x) =>
          x.id === sessionId ? { ...x, groups, layout, activeGroupId: toGroupId } : x,
        ),
      };
    }),

  markExited: (terminalId, code) =>
    set((s) => ({
      sessions: patchTerminal(s.sessions, terminalId, {
        exited: true,
        exitCode: code,
        busy: false,
      }),
    })),

  setAttention: (terminalId, value) =>
    set((s) => ({
      sessions: patchTerminal(s.sessions, terminalId, { attention: value }),
    })),

  clearAllAttention: () =>
    set((s) => ({
      sessions: s.sessions.map((ss) => ({
        ...ss,
        groups: ss.groups.map((g) => ({
          ...g,
          // Only rewrite terminals that actually had it, to avoid churn.
          terminals: g.terminals.map((t) =>
            t.attention ? { ...t, attention: false } : t,
          ),
        })),
      })),
    })),

  setBusy: (terminalId, value) =>
    set((s) => ({
      sessions: patchTerminal(s.sessions, terminalId, { busy: value }),
    })),
}));
