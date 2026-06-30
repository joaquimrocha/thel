import { useRef, useState, useEffect } from "react";
import { TerminalSquare, Play } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  useSessions,
  sessionTerminals,
  terminalDisplayTitle,
  type Session,
  type PaneGroup,
  type LayoutNode,
  type Terminal,
} from "@/store/sessions";
import { abbreviatePath } from "@/lib/paths";
import { shortcutLabel } from "@/store/keybindings";
import { daemonOptedOut } from "@/lib/pty";
import { usePrefs } from "@/store/prefs";
import { createSession, closeSession } from "@/lib/pty";
import {
  clearActivity,
  busyAgeMs,
  markBusy,
  markOutput,
  outputAgeMs,
} from "@/lib/activity";
import { notify } from "@/store/notifications";
import { TerminalPane } from "./TerminalPane";
import { TerminalTabs } from "./TerminalTabs";

// Strips escape/control sequences; matches CSI, OSC and other ESC-introduced
// sequences so what's left is just printable content.
// eslint-disable-next-line no-control-regex
const ESC_SEQ =
  /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[PX^_][^\x1b]*\x1b\\|[@-Z\\-_])/g;

function hasVisibleOutput(data: string): boolean {
  for (const ch of data.replace(ESC_SEQ, "")) {
    const c = ch.codePointAt(0)!;
    if (c >= 0x20 && c !== 0x7f) return true;
  }
  return false;
}

function terminalTitleFromOutput(data: string): string | undefined {
  let title: string | undefined;
  // OSC 0 and 2 set the window/icon title; xterm's onTitleChange follows the
  // same sequences for mounted terminals. Keep the last title in the chunk.
  const re = /\x1b\](?:0|2);([^\x07\x1b]*)(?:\x07|\x1b\\)/g;
  for (let m = re.exec(data); m; m = re.exec(data)) title = m[1];
  return title;
}

const ACTIVE_WINDOW_MS = 1000;

interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

// Unmount a session's terminals once it's been inactive this long, freeing
// their xterms (heavy: scrollback + a WebGL context each). The daemon keeps the
// terminals running, so switching back reattaches and restores them. Chosen so
// quick back-and-forth switching never unmounts; later configurable.
const SESSION_IDLE_UNMOUNT_MS = 10 * 60 * 1000;
// How often to re-check, so a session unmounts once idle even with no input.
const IDLE_CHECK_MS = 60 * 1000;
// A newly-active session only mounts after staying active this long, so cycling
// past sessions (Ctrl+Alt+PgUp/Dn) doesn't cold-mount each one in passing.
const SESSION_SETTLE_MS = 250;
// Height (px) of a pane's tab strip; panes are positioned this far below their
// group's rect top. Must match the strip's fixed height in TerminalTabs (h-10).
const STRIP_H = 40;

// Walk the split tree, assigning each pane a percentage rectangle. Splits divide
// their rect equally among children along their direction.
function computeRects(node: LayoutNode, rect: Rect, out: Record<string, Rect>) {
  if (node.t === "leaf") {
    out[node.group] = rect;
    return;
  }
  const n = node.children.length;
  node.children.forEach((child, i) => {
    const childRect: Rect =
      node.dir === "row"
        ? {
            left: rect.left + (rect.width * i) / n,
            top: rect.top,
            width: rect.width / n,
            height: rect.height,
          }
        : {
            left: rect.left,
            top: rect.top + (rect.height * i) / n,
            width: rect.width,
            height: rect.height / n,
          };
    computeRects(child, childRect, out);
  });
}

export function TerminalArea() {
  const sessions = useSessions((s) => s.sessions);
  const activeSessionId = useSessions((s) => s.activeSessionId);
  const hydrated = useSessions((s) => s.hydrated);
  const hasActive = sessions.some((s) => s.id === activeSessionId);
  const useDaemon = usePrefs((s) => s.useDaemon);
  const daemonBacked = useDaemon && !daemonOptedOut();
  const setActiveGroup = useSessions((s) => s.setActiveGroup);
  // Append-only order of mounted pane ids, so a tab reorder or cross-pane move
  // (which only changes a pane's position, not the set) never reshuffles the DOM
  // nodes and detaches an xterm canvas.
  const paneOrder = useRef<string[]>([]);

  // Mount only the active session first so startup isn't blocked by spinning up
  // every terminal in every (invisible) session; `warm` then lets a mounted
  // session bring in its background tabs just after first paint.
  const [warm, setWarm] = useState(false);
  // When warm-up ran, used as the idle baseline for sessions never visited this
  // run (they're mounted at warm-up, then unmount once that baseline goes stale).
  const warmAt = useRef<number | null>(null);
  useEffect(() => {
    const onWarm = () => {
      warmAt.current = Date.now();
      setWarm(true);
    };
    const w = window as Window & {
      requestIdleCallback?: (cb: () => void) => number;
      cancelIdleCallback?: (id: number) => void;
    };
    if (w.requestIdleCallback) {
      const id = w.requestIdleCallback(onWarm);
      return () => w.cancelIdleCallback?.(id);
    }
    const t = setTimeout(onWarm, 50);
    return () => clearTimeout(t);
  }, []);

  // A session "commits" (and mounts) only after it's stayed active for the
  // settle delay, so cycling past sessions doesn't cold-mount each one. Already
  // mounted sessions still show instantly via the visibility flip below.
  // lastActiveAt records when a committed session was left, for the idle window;
  // a periodic re-check unmounts sessions once stale.
  const lastActiveAt = useRef<Map<string, number>>(new Map());
  const committedRef = useRef<string | undefined>(undefined);
  const commitTimer = useRef<number | undefined>(undefined);
  const [committedActive, setCommittedActive] = useState<string | undefined>(
    undefined,
  );
  const [, recheckIdle] = useState(0);
  useEffect(() => {
    window.clearTimeout(commitTimer.current);
    const commit = () => {
      const prev = committedRef.current;
      if (prev && prev !== activeSessionId)
        lastActiveAt.current.set(prev, Date.now());
      committedRef.current = activeSessionId;
      setCommittedActive(activeSessionId);
    };
    // Commit at once on the first settle (startup) or when returning to the
    // already-committed session; otherwise wait the delay so a pass-by doesn't
    // mount.
    if (
      committedRef.current === undefined ||
      committedRef.current === activeSessionId
    )
      commit();
    else commitTimer.current = window.setTimeout(commit, SESSION_SETTLE_MS);
    return () => window.clearTimeout(commitTimer.current);
  }, [activeSessionId]);
  useEffect(() => {
    const h = window.setInterval(() => recheckIdle((n) => n + 1), IDLE_CHECK_MS);
    return () => window.clearInterval(h);
  }, []);

  const now = Date.now();
  const isMounted = (id: string) => {
    // Daemon-backed terminals can be detached cheaply and reattached by id.
    // Mount only the visible session so reopening a large layout, or hammering
    // New Terminal, doesn't create a hidden xterm/WebGL instance for every tab.
    if (daemonBacked) return id === activeSessionId;
    if (!warm) return id === activeSessionId; // pre-paint: only the active one
    // The settled (committed) session is mounted; one you only passed through is
    // not, until it commits. Visited/warmed sessions stay mounted until their
    // idle window elapses.
    if (id === committedActive) return true;
    const last = lastActiveAt.current.get(id) ?? warmAt.current;
    return last != null && now - last < SESSION_IDLE_UNMOUNT_MS;
  };
  const rendered = sessions.filter((s) => isMounted(s.id));

  // Direct-PTY hidden tabs must stay mounted (unmount kills them); daemon-backed
  // ones mount only when active (detach/reattach is cheap).
  const eagerMountHiddenTabs = !daemonBacked && warm;
  const isPaneMounted = (group: PaneGroup, t: Terminal) =>
    !!t.started && (eagerMountHiddenTabs || t.id === group.activeTerminalId);

  // Refresh the append-only pane order: keep still-mounted ids in place, append
  // newly-mounted ones. Panes render in this order regardless of tab/group order,
  // so moving a pane between groups doesn't remount or reshuffle it.
  const mountedIds = rendered.flatMap((s) =>
    s.groups.flatMap((g) => g.terminals.filter((t) => isPaneMounted(g, t)).map((t) => t.id)),
  );
  paneOrder.current = [
    ...paneOrder.current.filter((id) => mountedIds.includes(id)),
    ...mountedIds.filter((id) => !paneOrder.current.includes(id)),
  ];

  return (
    <div className="relative h-full w-full bg-[#1e1e1e]">
      {/* Each session's panes stay mounted once shown (keeping their
          PTY/scrollback across switches); only the active layer is visible.
          Inactive sessions are deferred to just after first paint (see `warm`).
          Panes render in one flat list per layer, positioned by the layout's
          computed rects, so splitting or moving a tab between panes repositions
          an existing pane rather than remounting it. */}
      {rendered.map((session) => {
        const rects: Record<string, Rect> = {};
        computeRects(session.layout, { left: 0, top: 0, width: 100, height: 100 }, rects);
        const sessionActive = session.id === activeSessionId;
        // The session's mounted panes with their group's rect + view state, in
        // the stable render order.
        const panes = session.groups.flatMap((group) => {
          const r = rects[group.id];
          if (!r) return [];
          const groupActive = sessionActive && group.id === session.activeGroupId;
          return group.terminals
            .filter((t) => isPaneMounted(group, t))
            .map((terminal) => ({
              terminal,
              group,
              rect: r,
              visible: sessionActive && terminal.id === group.activeTerminalId,
              focused: groupActive && terminal.id === group.activeTerminalId,
            }));
        });
        const ordered = paneOrder.current.flatMap((id) => {
          const p = panes.find((x) => x.terminal.id === id);
          return p ? [p] : [];
        });
        return (
          <div
            key={session.id}
            data-session-layer={session.id}
            className="absolute inset-0"
            style={{ visibility: sessionActive ? "visible" : "hidden" }}
          >
            {session.groups.map((group) => {
              const r = rects[group.id];
              if (!r) return null;
              return (
                <GroupChrome
                  key={group.id}
                  session={session}
                  group={group}
                  rect={r}
                  sessionActive={sessionActive}
                  groupActive={sessionActive && group.id === session.activeGroupId}
                />
              );
            })}
            {ordered.map(({ terminal, group, rect: r, visible, focused }) => (
              <div
                key={terminal.id}
                data-terminal-pane={terminal.id}
                // Clicking a pane focuses its group (the chrome underneath can't
                // receive the click since the pane overlays it).
                onMouseDown={() => {
                  if (sessionActive && group.id !== session.activeGroupId)
                    setActiveGroup(session.id, group.id);
                }}
                className="absolute p-2"
                style={{
                  left: `${r.left}%`,
                  top: `calc(${r.top}% + ${STRIP_H}px)`,
                  width: `${r.width}%`,
                  height: `calc(${r.height}% - ${STRIP_H}px)`,
                }}
              >
                <TerminalPane terminal={terminal} visible={visible} focused={focused} />
              </div>
            ))}
          </div>
        );
      })}
      {daemonBacked && warm && (
        <DaemonBackgroundListeners
          sessions={sessions}
          activeSessionId={activeSessionId}
        />
      )}

      {!hydrated ? (
        <LoadingPulse />
      ) : (
        !hasActive && <EmptyState hasSession={false} />
      )}
    </div>
  );
}

function DaemonBackgroundListeners({
  sessions,
  activeSessionId,
}: {
  sessions: Session[];
  activeSessionId?: string;
}) {
  return (
    <>
      {sessions.flatMap((session) => {
        const sessionActive = session.id === activeSessionId;
        return session.groups.flatMap((group) =>
          group.terminals
            .filter(
              (terminal) =>
                terminal.started &&
                !(sessionActive && terminal.id === group.activeTerminalId),
            )
            .map((terminal) => (
              <DaemonTerminalListener key={terminal.id} terminal={terminal} />
            )),
        );
      })}
    </>
  );
}

function DaemonTerminalListener({ terminal }: { terminal: Terminal }) {
  const setAttention = useSessions((s) => s.setAttention);
  const setBusy = useSessions((s) => s.setBusy);
  const setProcTitle = useSessions((s) => s.setProcTitle);
  const closeTerminal = useSessions((s) => s.closeTerminal);

  useEffect(() => {
    let closed = false;
    const idleTimer = { current: undefined as number | undefined };
    const settleTimer = { current: undefined as number | undefined };
    const bellTimer = { current: undefined as number | undefined };
    const bellPending = { current: false };
    const replaySettled = { current: false };
    const busyRef = { current: false };
    const workingRef = { current: false };

    const settleFallback = window.setTimeout(() => {
      replaySettled.current = true;
    }, 3000);

    createSession(
      {
        id: terminal.id,
        command: terminal.command,
        args: terminal.args,
        cwd: terminal.cwd,
        cols: 80,
        rows: 24,
        use_daemon: true,
      },
      (msg) => {
        if (closed) return;
        if (msg.kind === "data") {
          const title = terminalTitleFromOutput(msg.data);
          if (title !== undefined) setProcTitle(terminal.id, title);
          const visible = hasVisibleOutput(msg.data);
          // Fresh output in a later chunk means a pending bell wasn't the agent
          // finishing; cancel it before arming a new one for this chunk's bell.
          if (visible && bellPending.current) {
            bellPending.current = false;
            window.clearTimeout(bellTimer.current);
          }
          // Defer the bell notification until the terminal falls quiet: resident
          // agents (claude) ring the bell mid-action, and only a bell followed by
          // silence means "done, wants you".
          if (msg.data.includes("\x07") && replaySettled.current) {
            bellPending.current = true;
            window.clearTimeout(bellTimer.current);
            bellTimer.current = window.setTimeout(() => {
              bellPending.current = false;
              if (closed) return;
              setAttention(terminal.id, true);
              notify(terminal.id, "bell");
            }, 1000);
          }
          if (!visible) return;
          markOutput(terminal.id);
          if (!replaySettled.current) {
            window.clearTimeout(settleTimer.current);
            settleTimer.current = window.setTimeout(() => {
              replaySettled.current = true;
            }, 250);
          }
          window.clearTimeout(idleTimer.current);
          idleTimer.current = window.setTimeout(() => {
            if (closed || busyRef.current) return;
            if (busyAgeMs(terminal.id) > 8000) return;
            setAttention(terminal.id, true);
            notify(terminal.id, "idle");
          }, 1000);
        } else if (msg.kind === "busy") {
          busyRef.current = msg.busy;
          if (msg.busy) markBusy(terminal.id);
          const working = msg.busy && outputAgeMs(terminal.id) < ACTIVE_WINDOW_MS;
          if (workingRef.current !== working) {
            workingRef.current = working;
            setBusy(terminal.id, working);
          }
        } else {
          closeTerminal(terminal.id);
        }
      },
    ).catch((e) => console.error("background terminal attach failed", e));

    return () => {
      closed = true;
      window.clearTimeout(idleTimer.current);
      window.clearTimeout(settleTimer.current);
      window.clearTimeout(bellTimer.current);
      window.clearTimeout(settleFallback);
      clearActivity(terminal.id);
      closeSession(terminal.id).catch(() => {});
    };
  }, [
    closeTerminal,
    setAttention,
    setBusy,
    setProcTitle,
    terminal.args,
    terminal.command,
    terminal.cwd,
    terminal.id,
  ]);

  return null;
}

// The per-group chrome: the tab strip plus the empty/start-card placeholder. The
// actual terminal panes are rendered flat by TerminalArea and overlay this
// group's pane area, so they survive being moved between groups. A fixed-height
// strip (h-10 = STRIP_H) is what lets the flat panes align below it.
function GroupChrome({
  session,
  group,
  rect,
  sessionActive,
  groupActive,
}: {
  session: Session;
  group: PaneGroup;
  rect: Rect;
  sessionActive: boolean;
  groupActive: boolean;
}) {
  const setActiveGroup = useSessions((s) => s.setActiveGroup);
  const activeTerminal = group.terminals.find(
    (t) => t.id === group.activeTerminalId,
  );
  const showStart = !!activeTerminal && !activeTerminal.started;
  const empty = group.terminals.length === 0;

  return (
    <div
      // Focus this pane when the strip/placeholder is clicked (the pane overlay
      // handles clicks on the terminal itself).
      data-pane-group={group.id}
      onMouseDown={() => {
        if (sessionActive && !groupActive) setActiveGroup(session.id, group.id);
      }}
      className={cn(
        "absolute flex flex-col border-border",
        // Internal dividers only (panes not flush against the surface edge).
        rect.left > 0 && "border-l",
        rect.top > 0 && "border-t",
      )}
      style={{
        left: `${rect.left}%`,
        top: `${rect.top}%`,
        width: `${rect.width}%`,
        height: `${rect.height}%`,
      }}
    >
      <TerminalTabs sessionId={session.id} group={group} groupActive={groupActive} />
      <div className="relative min-h-0 flex-1">
        {empty ? (
          <EmptyState hasSession />
        ) : showStart ? (
          <StartCard terminal={activeTerminal!} session={session} />
        ) : null}
      </div>
    </div>
  );
}

// Shown while the saved layout is still loading:
// the same expanding/fading dot as a running command, but gray.
function LoadingPulse() {
  return (
    <div className="absolute inset-0 flex items-center justify-center">
      <span className="relative flex size-5">
        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-muted-foreground opacity-75" />
        <span className="relative inline-flex h-full w-full rounded-full bg-muted-foreground" />
      </span>
    </div>
  );
}

function EmptyState({ hasSession }: { hasSession: boolean }) {
  // Point at the action that actually applies: a new terminal when a session
  // exists, a new session otherwise (the palette's session commands are useless
  // with no session).
  const keys = shortcutLabel(hasSession ? "new-terminal" : "new-session");
  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 text-muted-foreground">
      <TerminalSquare className="size-10 opacity-40" />
      <div className="text-center text-sm">
        <p>{hasSession ? "No terminals in this pane." : "No sessions open."}</p>
        {keys && (
          <p className="opacity-70">
            Press{" "}
            <kbd className="rounded border border-border bg-muted px-1.5 py-0.5 text-xs">
              {keys}
            </kbd>{" "}
            to {hasSession ? "open a terminal" : "start a session"}.
          </p>
        )}
      </div>
    </div>
  );
}

function StartCard({ terminal, session }: { terminal: Terminal; session: Session }) {
  const startTerminal = useSessions((s) => s.startTerminal);
  const startAllInSession = useSessions((s) => s.startAllInSession);
  const cmdline = [terminal.command, ...terminal.args].join(" ");
  // Only offer "Start all" when it would start more than just this terminal.
  const unstarted = sessionTerminals(session).filter((t) => !t.started).length;
  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 text-muted-foreground">
      <div className="w-full max-w-md rounded-lg border border-border bg-background/60 p-5 text-center">
        <p className="mb-1 text-sm font-medium text-foreground">
          {terminalDisplayTitle(terminal)}
        </p>
        <p className="truncate font-mono text-xs opacity-70">{cmdline}</p>
        {terminal.cwd && (
          <p className="truncate font-mono text-xs opacity-50">
            {abbreviatePath(terminal.cwd)}
          </p>
        )}
        <div className="mt-4 flex flex-col items-center gap-2">
          <Button onClick={() => startTerminal(terminal.id)}>
            <Play className="size-4" /> Start
          </Button>
          {unstarted > 1 && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => startAllInSession(session.id)}
            >
              Start all ({unstarted})
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
