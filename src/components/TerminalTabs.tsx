import { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  X,
  Plus,
  SplitSquareHorizontal,
  SplitSquareVertical,
  Trash2,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  useSessions,
  terminalDisplayTitle,
  type PaneGroup,
} from "@/store/sessions";
import { addTerminal, splitPane } from "@/lib/launch";
import { closeTerminalConfirmed, closeAllTerminals } from "@/lib/actions";
import { useUI } from "@/store/ui";
import { EditableLabel } from "./EditableLabel";
import { StatusDot, terminalDotState } from "./StatusDot";
import { ActionTooltip } from "./ActionTooltip";

// One split column's tab strip: its terminals plus the new-terminal and split
// controls that act on this column.
export function TerminalTabs({
  sessionId,
  group,
  groupActive,
}: {
  sessionId: string;
  group: PaneGroup;
  // This pane is the focused one (its active tab is the focused terminal).
  groupActive: boolean;
}) {
  const setActiveTerminal = useSessions((s) => s.setActiveTerminal);
  const renameTerminal = useSessions((s) => s.renameTerminal);
  const reorderTerminal = useSessions((s) => s.reorderTerminal);
  const moveTerminalToGroup = useSessions((s) => s.moveTerminalToGroup);

  // The tab currently being dragged (synchronous ref for the dragover handler,
  // state for dimming it).
  const draggingId = useRef<string | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  // Whether hover-revealed controls (the close button) may show. A drag
  // suppresses mouse events, so :hover sticks on whatever tab the pointer ended
  // over; disarm on any drag and re-arm on the next real pointer move, which
  // re-establishes the correct :hover.
  const [hoverArmed, setHoverArmed] = useState(true);
  const stripRef = useRef<HTMLDivElement>(null);
  const prevLefts = useRef<Map<string, number>>(new Map());

  // Scroll the strip horizontally (only) just enough to fully show a tab. Uses
  // offset geometry rather than scrollIntoView, so it ignores the FLIP
  // transform that's mid-animation right after a reorder and never scrolls an
  // ancestor on the vertical axis. Relies on the strip being the offset parent
  // (it's `relative`).
  const revealTab = (id: string) => {
    const strip = stripRef.current;
    const el = strip?.querySelector<HTMLElement>(
      `[data-tab-id="${CSS.escape(id)}"]`,
    );
    if (!strip || !el) return;
    const left = el.offsetLeft;
    const right = left + el.offsetWidth;
    if (left < strip.scrollLeft) strip.scrollLeft = left;
    else if (right > strip.scrollLeft + strip.clientWidth)
      strip.scrollLeft = right - strip.clientWidth;
  };

  // FLIP: whenever the tab order changes, slide each tab from its previous
  // position to the new one so a reorder (drag or shortcut) animates.
  const order = group.terminals.map((t) => t.id).join(",");
  useLayoutEffect(() => {
    const strip = stripRef.current;
    if (!strip) return;
    strip.querySelectorAll<HTMLElement>("[data-tab-id]").forEach((el) => {
      const id = el.dataset.tabId!;
      const left = el.getBoundingClientRect().left;
      const prev = prevLefts.current.get(id);
      if (prev != null && prev !== left) {
        el.style.transition = "none";
        el.style.transform = `translateX(${prev - left}px)`;
        requestAnimationFrame(() => {
          el.style.transition = "transform 150ms ease";
          el.style.transform = "";
        });
      }
      prevLefts.current.set(id, left);
    });
  }, [order]);

  // Keep the active tab in view: newly created (appended off-screen), selected,
  // or shifted by a keyboard reorder (move-terminal-left/right), which changes
  // the order but not the active id or the count. Skip during a drag, where the
  // drop handlers reveal the dragged tab instead.
  useEffect(() => {
    if (draggingId.current) return;
    const active = group.activeTerminalId;
    if (active) requestAnimationFrame(() => revealTab(active));
  }, [group.activeTerminalId, group.terminals.length, order]);

  // Clear the dragged state when any drag ends (e.g. dropped outside).
  useEffect(() => {
    const clear = () => {
      const id = draggingId.current;
      draggingId.current = null;
      setDragging(null);
      // A within-pane reorder changes neither the active tab nor the count, so
      // the active-tab effect won't run; a tab dropped at an edge can stay
      // partially clipped. Scroll it fully into view now it's at its final spot.
      if (id) requestAnimationFrame(() => revealTab(id));
    };
    const disarm = () => setHoverArmed(false);
    const rearm = () => setHoverArmed(true);
    window.addEventListener("dragend", clear);
    window.addEventListener("dragstart", disarm);
    window.addEventListener("pointermove", rearm);
    return () => {
      window.removeEventListener("dragend", clear);
      window.removeEventListener("dragstart", disarm);
      window.removeEventListener("pointermove", rearm);
    };
  }, []);

  // If the dragged tab left this pane (moved to another), clear the state here
  // too: its source element unmounted, so its dragend never fired, which would
  // otherwise keep the tab hidden (opacity-0) when it returns to this pane.
  useEffect(() => {
    if (dragging && !group.terminals.some((t) => t.id === dragging)) {
      draggingId.current = null;
      setDragging(null);
    }
  }, [dragging, group.terminals]);

  // While dragging within this pane, reorder live once the pointer crosses a
  // neighbour's middle.
  const onTabDragOver = (e: React.DragEvent, overId: string, overIndex: number) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    const id = draggingId.current;
    if (!id || id === overId) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const after = e.clientX >= rect.left + rect.width / 2;
    let to = overIndex + (after ? 1 : 0);
    const from = group.terminals.findIndex((t) => t.id === id);
    if (from < to) to -= 1; // account for removing the dragged tab first
    if (from !== -1 && to !== from) reorderTerminal(sessionId, group.id, id, to);
  };

  // A drop on this pane's strip. Within the pane it's already been reordered
  // live; a terminal from another pane moves here at the pointer's position.
  const onStripDrop = (e: React.DragEvent) => {
    e.preventDefault();
    const id = e.dataTransfer.getData("text/plain");
    if (!id || group.terminals.some((t) => t.id === id)) return;
    const els = [
      ...(stripRef.current?.querySelectorAll<HTMLElement>("[data-tab-id]") ?? []),
    ];
    let to = els.length;
    for (let k = 0; k < els.length; k++) {
      const r = els[k].getBoundingClientRect();
      if (e.clientX < r.left + r.width / 2) {
        to = k;
        break;
      }
    }
    moveTerminalToGroup(sessionId, id, group.id, to);
    // The moved tab becomes active here, so the active-tab effect reveals it.
  };

  return (
    <div className="flex items-center border-b border-border bg-background">
      {/* Pinned outside the scroller so it's always reachable. Just a +; on
          hover it reveals a menu with the + (new terminal) and split, stacked. */}
      <div className="group/add relative ml-1 shrink-0">
        <ActionTooltip label="New terminal" shortcutId="new-terminal">
          <Button
            variant="ghost"
            size="icon"
            onClick={() => void addTerminal(undefined, group.id)}
            aria-label="New terminal in this pane"
          >
            <Plus className="size-4" />
          </Button>
        </ActionTooltip>
        {/* Overlays the anchor (top-0) so on hover the + stays in place and the
            split drops in below it, like the button expanded into a menu. */}
        <div className="absolute left-0 top-0 z-30 hidden flex-col overflow-hidden rounded-md bg-background shadow-md ring-1 ring-border group-hover/add:flex">
          <ActionTooltip label="New terminal" shortcutId="new-terminal" side="right">
            <Button
              variant="ghost"
              size="icon"
              onClick={() => void addTerminal(undefined, group.id)}
              aria-label="New terminal in this pane"
            >
              <Plus className="size-4" />
            </Button>
          </ActionTooltip>
          <ActionTooltip label="Split right" shortcutId="split-pane" side="right">
            <Button
              variant="ghost"
              size="icon"
              onClick={() => void splitPane(group.id, "row")}
              aria-label="Split right"
            >
              <SplitSquareHorizontal className="size-4" />
            </Button>
          </ActionTooltip>
          <ActionTooltip label="Split down" side="right">
            <Button
              variant="ghost"
              size="icon"
              onClick={() => void splitPane(group.id, "col")}
              aria-label="Split down"
            >
              <SplitSquareVertical className="size-4" />
            </Button>
          </ActionTooltip>
          <div className="h-px bg-border" />
          <ActionTooltip label="Close all terminals" shortcutId="close-all-terminals" side="right">
            <Button
              variant="ghost"
              size="icon"
              onClick={() => closeAllTerminals(group.id)}
              aria-label="Close all terminals"
              className="hover:text-destructive"
            >
              <Trash2 className="size-4" />
            </Button>
          </ActionTooltip>
        </div>
      </div>
      <div
        // Vertical wheel scrolls the strip horizontally, since the scrollbar is
        // hidden and a plain mouse can't scroll a horizontal container otherwise.
        onWheel={(e) => {
          const el = e.currentTarget;
          if (el.scrollWidth > el.clientWidth && e.deltaY !== 0) {
            el.scrollLeft += e.deltaY;
          }
        }}
        ref={stripRef}
        onDragOver={(e) => e.preventDefault()}
        onDrop={onStripDrop}
        className="no-scrollbar relative flex min-w-0 flex-1 items-center gap-1 overflow-x-auto px-1 py-1"
      >
        {group.terminals.map((t, i) => (
          <div
            key={t.id}
            data-testid="terminal-tab"
            data-tab-id={t.id}
            draggable
            onDragStart={(e) => {
              draggingId.current = t.id;
              // The webview's default drag image tracks the live element, which
              // we hide (opacity-0), so snapshot a visible clone to use as the
              // dragged copy instead. Removed once the browser has captured it.
              const node = e.currentTarget;
              const rect = node.getBoundingClientRect();
              const clone = node.cloneNode(true) as HTMLElement;
              clone.removeAttribute("data-testid");
              clone.removeAttribute("data-tab-id");
              // A solid background so the dragged copy is fully opaque (an
              // inactive tab's background is transparent, which renders the drag
              // image see-through).
              clone.classList.add("bg-secondary", "text-secondary-foreground");
              clone.style.transform = "";
              clone.style.transition = "none";
              clone.style.position = "fixed";
              clone.style.top = "-9999px";
              clone.style.left = "-9999px";
              clone.style.width = `${rect.width}px`;
              clone.style.pointerEvents = "none";
              document.body.appendChild(clone);
              e.dataTransfer.setDragImage(
                clone,
                e.clientX - rect.left,
                e.clientY - rect.top,
              );
              setTimeout(() => clone.remove(), 0);
              setDragging(t.id);
              e.dataTransfer.setData("text/plain", t.id);
              e.dataTransfer.effectAllowed = "move";
            }}
            onDragOver={(e) => onTabDragOver(e, t.id, i)}
            onClick={() => {
              setActiveTerminal(sessionId, t.id);
              // Clicking a tab leaves DOM focus off the xterm (or no transition
              // at all when it's already the active tab), so the focused effect
              // won't refocus on its own; nudge it via the focus nonce.
              useUI.getState().focusTerminal();
            }}
            className={cn(
              "group flex h-8 max-w-52 shrink-0 cursor-pointer items-center gap-2 rounded-md px-3 text-sm",
              t.id === group.activeTerminalId
                ? "bg-secondary text-secondary-foreground"
                : "text-muted-foreground hover:bg-secondary/50",
              dragging === t.id && "opacity-0",
            )}
          >
            <StatusDot state={terminalDotState(t)} />
            <EditableLabel
              value={terminalDisplayTitle(t)}
              onCommit={(v) => renameTerminal(t.id, v)}
              fallback={t.defaultTitle}
              className={cn(
                "truncate",
                groupActive && t.id === group.activeTerminalId && "font-semibold",
              )}
            />
            <ActionTooltip label="Close terminal" shortcutId="close-terminal">
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  void closeTerminalConfirmed(t.id);
                }}
                className={cn(
                  "ml-1 rounded opacity-0 hover:bg-background/60",
                  // Only reveal on hover when not dragging and not in the brief
                  // window after a drag before the pointer moves (stuck :hover).
                  hoverArmed && "group-hover:opacity-100",
                )}
                aria-label="Close terminal"
              >
                <X className="size-3.5" />
              </button>
            </ActionTooltip>
          </div>
        ))}
      </div>
    </div>
  );
}
