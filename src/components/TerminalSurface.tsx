import { useRef, useState, useEffect } from "react";
import { TerminalSquare } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  useSessions,
  type Session,
  type PaneGroup,
  type LayoutNode,
  type Terminal,
} from "@/store/sessions";
import { shortcutLabel } from "@/store/keybindings";
import { createSession, closeSession } from "@/lib/pty";
import { clearActivity, noteBurst } from "@/lib/activity";
import { createTerminalActivity, AGENT_QUIET_MS } from "@/lib/termActivity";
import { notify } from "@/store/notifications";
import {
  hasVisibleOutput,
  oscNotifications,
  terminalTitleFromOutput,
} from "@/lib/ansi";
import { TerminalPane } from "./TerminalPane";
import { TerminalTabs } from "./TerminalTabs";

interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

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
  const setActiveGroup = useSessions((s) => s.setActiveGroup);
  // Append-only order of mounted pane ids, so a tab reorder or cross-pane move
  // (which only changes a pane's position, not the set) never reshuffles the DOM
  // nodes and detaches an xterm canvas.
  const paneOrder = useRef<string[]>([]);

  // Terminals are detached cheaply and reattached by id, so only the visible
  // session is mounted: reopening a large layout, or hammering New Terminal,
  // never creates a hidden xterm/WebGL instance for every tab. `warm` holds the
  // background listeners back until just after first paint, so startup isn't
  // blocked by wiring up every unmounted tab.
  const [warm, setWarm] = useState(false);
  useEffect(() => {
    const onWarm = () => setWarm(true);
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

  const rendered = sessions.filter((s) => s.id === activeSessionId);


  const isPaneMounted = (group: PaneGroup, t: Terminal) =>
    t.id === group.activeTerminalId;

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
      {/* Only the active session is mounted; switching away detaches its panes
          and switching back reattaches them by id, screen included. Panes render
          in one flat list per layer, positioned by the layout's computed rects,
          so splitting or moving a tab between panes repositions an existing pane
          rather than remounting it. */}
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
      {warm && (
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
  const setBusy = useSessions((s) => s.setBusy);
  const setProcTitle = useSessions((s) => s.setProcTitle);
  const closeTerminal = useSessions((s) => s.closeTerminal);

  useEffect(() => {
    let closed = false;
    const agentTimer = { current: undefined as number | undefined };
    const agentArmed = { current: false };

    // The shared notification core (replay gate, bell debounce, idle alert,
    // busy→working edge). A background listener is never watched, so watched()
    // is () => false. The waiting-for-input heuristic below stays the listener's
    // own: it has no screen buffer, so it works off output bursts.
    const activity = createTerminalActivity({
      id: terminal.id,
      watched: () => false,
      onNotify: (kind, text) => notify(terminal.id, kind, text),
      onWorking: (working) => setBusy(terminal.id, working),
    });

    // Best-effort waiting detection for background tabs (no screen buffer to
    // inspect, unlike a mounted pane): fires once a work burst falls quiet
    // while still busy.
    const armAgentTimer = () => {
      window.clearTimeout(agentTimer.current);
      agentTimer.current = window.setTimeout(() => {
        if (closed || !activity.isBusy() || activity.isBellPending()) return;
        agentArmed.current = false;
        notify(terminal.id, "waiting");
      }, AGENT_QUIET_MS);
    };

    createSession(
      {
        id: terminal.id,
        command: terminal.command,
        args: terminal.args,
        cwd: terminal.cwd,
        cols: 80,
        rows: 24,
      },
      (msg) => {
        if (closed) return;
        if (msg.kind === "data") {
          const title = terminalTitleFromOutput(msg.data);
          if (title !== undefined) setProcTitle(terminal.id, title);
          const visible = hasVisibleOutput(msg.data);
          activity.absorbOutputBeforeWrite(visible);
          // OSC notification requests carry their own message and fire at once;
          // the bell check uses the stripped rest so an OSC terminator byte
          // doesn't also ring. Both are gated by the replay state internally.
          const osc = oscNotifications(msg.data);
          if (osc.texts.length || osc.rest.includes("\x07"))
          for (const text of osc.texts) activity.noteMessage(text);
          if (osc.rest.includes("\x07")) activity.noteBell();
          activity.noteOutput(visible);
          // Waiting-for-input fallback: a sustained work burst arms it, then
          // AGENT_QUIET_MS of silence while still busy fires it once. No screen
          // buffer here, so it works off output bursts rather than screen text.
          if (visible && activity.isReplaySettled()) {
            if (noteBurst(terminal.id)) agentArmed.current = true;
            if (agentArmed.current) armAgentTimer();
          }
        } else if (msg.kind === "busy") {
          activity.noteBusy(msg.busy);
        } else if (msg.kind === "notify") {
          // `thel notify` via the daemon: a background tab is never watched, so
          // deliver it straight through (skips the replay gate -- it's live).
          notify(terminal.id, "message", msg.message);
        } else {
          closeTerminal(terminal.id);
        }
      },
    ).catch((e) => console.error("background terminal attach failed", e));

    return () => {
      closed = true;
      window.clearTimeout(agentTimer.current);
      activity.dispose();
      clearActivity(terminal.id);
      closeSession(terminal.id).catch(() => {});
    };
  }, [
    closeTerminal,
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
      <div className="relative min-h-0 flex-1">{empty && <EmptyState hasSession />}</div>
    </div>
  );
}

// Shown while the saved layout is still loading: the same expanding/fading dot
// as a running command, but gray.
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
