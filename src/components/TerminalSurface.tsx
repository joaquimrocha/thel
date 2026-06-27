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
import { comboToString } from "@/lib/keymap";
import { effectiveCombo } from "@/store/keybindings";
import { TerminalPane } from "./TerminalPane";
import { TerminalTabs } from "./TerminalTabs";

interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

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

  // Mount only the active session first so startup isn't blocked by spinning up
  // every terminal in every (invisible) session; bring the rest in just after
  // the first paint so switching stays instant once warmed.
  const [warm, setWarm] = useState(false);
  useEffect(() => {
    const w = window as Window & {
      requestIdleCallback?: (cb: () => void) => number;
      cancelIdleCallback?: (id: number) => void;
    };
    if (w.requestIdleCallback) {
      const id = w.requestIdleCallback(() => setWarm(true));
      return () => w.cancelIdleCallback?.(id);
    }
    const t = setTimeout(() => setWarm(true), 50);
    return () => clearTimeout(t);
  }, []);
  const rendered = warm
    ? sessions
    : sessions.filter((s) => s.id === activeSessionId);

  return (
    <div className="relative h-full w-full bg-[#1e1e1e]">
      {/* Each session's panes stay mounted once shown (keeping their
          PTY/scrollback across switches); only the active layer is visible.
          Inactive sessions are deferred to just after first paint (see `warm`).
          Panes are positioned flat by the layout's computed rects so splitting
          never remounts an existing pane. */}
      {rendered.map((session) => {
        const rects: Record<string, Rect> = {};
        computeRects(session.layout, { left: 0, top: 0, width: 100, height: 100 }, rects);
        const sessionActive = session.id === activeSessionId;
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
                <GroupPane
                  key={group.id}
                  session={session}
                  group={group}
                  rect={r}
                  warm={warm}
                  sessionActive={sessionActive}
                  groupActive={sessionActive && group.id === session.activeGroupId}
                />
              );
            })}
          </div>
        );
      })}

      {!hydrated ? (
        <LoadingPulse />
      ) : (
        !hasActive && <EmptyState hasSession={false} />
      )}
    </div>
  );
}

function GroupPane({
  session,
  group,
  rect,
  warm,
  sessionActive,
  groupActive,
}: {
  session: Session;
  group: PaneGroup;
  rect: Rect;
  // Before warm-up, mount only the visible tab; the rest mount after first paint.
  warm: boolean;
  sessionActive: boolean;
  groupActive: boolean;
}) {
  const setActiveGroup = useSessions((s) => s.setActiveGroup);
  const activeTerminal = group.terminals.find(
    (t) => t.id === group.activeTerminalId,
  );

  // Render the stacked panes in a stable, append-only order, independent of the
  // tab order. Reordering tabs would otherwise move a pane's DOM node, which
  // detaches its xterm canvas and leaves the content blank until the next
  // redraw (visible when reordering by drag, since the pane isn't refocused).
  // The tab strip still follows group.terminals' order.
  const renderOrder = useRef<string[]>([]);
  const liveIds = group.terminals.map((t) => t.id);
  renderOrder.current = [
    ...renderOrder.current.filter((id) => liveIds.includes(id)),
    ...liveIds.filter((id) => !renderOrder.current.includes(id)),
  ];
  const stackedTerminals = renderOrder.current.flatMap((id) => {
    const t = group.terminals.find((x) => x.id === id);
    return t ? [t] : [];
  });
  const showStart = !!activeTerminal && !activeTerminal.started;
  const empty = group.terminals.length === 0;

  return (
    <div
      // Focus this pane when interacted with, so + / split / shortcuts target it.
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
        {stackedTerminals
          .filter(
            (t) => t.started && (warm || t.id === group.activeTerminalId),
          )
          .map((terminal) => (
            <div
              key={terminal.id}
              data-terminal-pane={terminal.id}
              className="absolute inset-0 p-2"
            >
              <TerminalPane
                terminal={terminal}
                visible={sessionActive && terminal.id === group.activeTerminalId}
                focused={groupActive && terminal.id === group.activeTerminalId}
              />
            </div>
          ))}

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
  const combo = effectiveCombo(hasSession ? "new-terminal" : "new-session");
  const keys = combo ? comboToString(combo) : null;
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
