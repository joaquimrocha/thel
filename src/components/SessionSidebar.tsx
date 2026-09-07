import { Fragment, useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  X,
  Plus,
  Bell,
  GitBranch,
  PanelLeft,
  PanelLeftClose,
  PanelLeftOpen,
  Zap,
  Settings,
  ChevronDown,
  ChevronRight,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { useSessions, revertBrokenIcon, type Session } from "@/store/sessions";
import { usePrefs } from "@/store/prefs";
import { useNotifications } from "@/store/notifications";
import { useUI, SIDEBAR_MIN, SIDEBAR_MAX } from "@/store/ui";
import { closeSessionConfirmed } from "@/lib/actions";
import { shortcutLabel, useKeybindings } from "@/store/keybindings";
import {
  dropAnchor,
  setClonedDragImage,
  flipCapture,
  flipReorder,
  flipState,
} from "@/lib/dragReorder";
import {
  sidebarItems,
  itemSessions,
  itemEdgeId,
  sessionsInDisplayOrder,
  sessionNameInGroup,
  type RepoGroup,
  type SidebarItem,
} from "@/lib/sessionGroups";
import { StatusDot, sessionDotState } from "./StatusDot";
import { ActionTooltip } from "./ActionTooltip";
import { ProfileMenu } from "./Titlebar";
import {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuShortcut,
} from "@/components/ui/context-menu";

// Rail chunks: a group is one run of icons, and so is each stretch of loose
// sessions between groups, so the separators line up with the list's own.
function chunkItems(items: SidebarItem[]): Session[][] {
  const chunks: Session[][] = [];
  let looseRun: Session[] | null = null;
  for (const it of items) {
    if (it.t === "group") {
      looseRun = null;
      chunks.push(it.group.sessions);
      continue;
    }
    if (!looseRun) {
      looseRun = [];
      chunks.push(looseRun);
    }
    looseRun.push(it.session);
  }
  return chunks;
}

export function SessionSidebar() {
  const sessions = useSessions((s) => s.sessions);
  const activeSessionId = useSessions((s) => s.activeSessionId);
  const setActiveSession = useSessions((s) => s.setActiveSession);
  const openNewSession = useUI((s) => s.openNewSession);
  const openPalette = useUI((s) => s.setPaletteOpen);
  const openNotifications = useUI((s) => s.openNotifications);
  const unread = useNotifications((s) => s.items.filter((i) => !i.read).length);
  // The custom title bar carries the app menu; the sidebar takes it over when
  // the OS draws the window instead.
  const customTitlebar = usePrefs((s) => s.customTitlebar);
  const appMenuOpen = useUI((s) => s.profileMenuOpen);
  const focusTerminal = useUI((s) => s.focusTerminal);
  const width = useUI((s) => s.sidebarWidth);
  const collapsed = useUI((s) => s.sidebarCollapsed);
  const toggleSidebar = useUI((s) => s.toggleSidebar);
  const setSidebarWidth = useUI((s) => s.setSidebarWidth);
  const grouping = usePrefs((s) => s.groupSessionsByRepo);
  const collapsedRepos = useUI((s) => s.collapsedRepos);
  const toggleRepoCollapsed = useUI((s) => s.toggleRepoCollapsed);
  const expandRepo = useUI((s) => s.expandRepo);
  const items = grouping ? sidebarItems(sessions) : null;
  // Rows in display order, which the keyboard cursor walks; a folded group's
  // sessions are off screen and skipped (unless that would hide everything).
  const visible: Session[] = sessionsInDisplayOrder(sessions, grouping, collapsedRepos);
  // The icon rail shows every session, folded groups included, but in grouped
  // display order so it matches the expanded list. One chunk per group, and
  // one per run of loose sessions between groups; a thin line separates them.
  const railChunks: Session[][] = (
    items ? chunkItems(items) : [sessions]
  ).filter((c) => c.length > 0);
  // Switching to a session inside a folded group (palette, or cycling when
  // every group is folded) unfolds it, so the row you are now in is on
  // screen.
  useEffect(() => {
    if (!grouping) return;
    const s = useSessions.getState().sessions.find((x) => x.id === activeSessionId);
    const key = s?.repoMain ?? s?.repoRoot;
    if (key) expandRepo(key);
  }, [activeSessionId, grouping, expandRepo]);
  const [hovered, setHovered] = useState(false);
  const [suppressOverlay, setSuppressOverlay] = useState(false);
  // Closing the collapsed fly-out lags the mouse leaving by a moment, so a
  // brief slip off the panel (or re-entering it) doesn't snap it shut.
  const hideTimer = useRef<number | null>(null);
  const cancelHide = () => {
    if (hideTimer.current !== null) {
      window.clearTimeout(hideTimer.current);
      hideTimer.current = null;
    }
  };
  useEffect(() => cancelHide, []);
  // A row's context menu portals its content and puts pointer-events:none on
  // the body, which fires a spurious mouseleave on the rail that would hide
  // the fly-out (and the menu anchored in it). Hold it open while a menu is
  // up; on close, hide unless the pointer is back over the rail.
  const rowMenuOpen = useRef(false);
  const railRef = useRef<HTMLDivElement>(null);
  const onRowMenuOpenChange = (open: boolean) => {
    rowMenuOpen.current = open;
    if (open) {
      cancelHide();
      return;
    }
    cancelHide();
    hideTimer.current = window.setTimeout(() => {
      // Checked inside the timeout: by then Radix has restored the body's
      // pointer events, so :hover is reliable again.
      if (!railRef.current?.matches(":hover")) setHovered(false);
    }, 200);
  };
  // Keyboard navigation cursor while the list is focused.
  const [navFocused, setNavFocused] = useState(false);
  const [highlight, setHighlight] = useState(0);

  // Drag-to-reorder, mirroring the terminal tab strip: the dragged row is
  // hidden (opacity-0) so its slot reads as the empty landing space, the list
  // reorders live as the pointer crosses a neighbour's middle, and a FLIP pass
  // slides the rows that move. A group header drags its whole group the same
  // way, so `drag` holds the block of sessions in flight rather than one id.
  const reorderSessionBlock = useSessions((s) => s.reorderSessionBlock);
  const drag = useRef<{ ids: string[]; key: string; group: boolean } | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  // A drag suppresses mouse events, so :hover sticks on the row the pointer
  // ended over, leaving its action buttons visible. Disarm on any drag and
  // re-arm on the next real pointer move.
  const [hoverArmed, setHoverArmed] = useState(true);
  const listRef = useRef<HTMLDivElement>(null);
  const flip = useRef(flipState());

  const order = sessions.map((s) => s.id).join(",");
  useLayoutEffect(() => {
    const list = listRef.current;
    if (list) flipReorder(list, "data-row-id", "y", flip.current);
  }, [order]);

  useEffect(() => {
    const clear = () => {
      drag.current = null;
      setDragging(null);
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

  const startDrag = (
    e: React.DragEvent,
    key: string,
    ids: string[],
    group: boolean,
  ) => {
    drag.current = { ids, key, group };
    setClonedDragImage(e, (clone) => {
      clone.removeAttribute("data-row-id");
      // Drop the keyboard-nav highlight ring so the dragged copy doesn't carry
      // a stray white border.
      clone.classList.remove("ring-1", "ring-ring");
    });
    setDragging(key);
    e.dataTransfer.setData("text/plain", key);
    e.dataTransfer.effectAllowed = "move";
  };

  // Land the block in flight beside `anchorId`, which is a session id: the
  // store moves the whole block there in one go.
  const dropBeside = (spot: { anchorId: string; after: boolean } | null) => {
    const d = drag.current;
    if (!d || !spot || d.ids.includes(spot.anchorId)) return;
    const list = listRef.current;
    if (list) flipCapture(list, "data-row-id", "y", flip.current);
    reorderSessionBlock(d.ids, spot.anchorId, spot.after);
  };

  const pastMidpoint = (e: React.DragEvent) => {
    const rect = e.currentTarget.getBoundingClientRect();
    return e.clientY >= rect.top + rect.height / 2;
  };

  // A row only reorders within its own group. Dragging it out would be futile
  // anyway: a session belongs to its repo's group wherever it lands, so it
  // would snap straight back and look like the list jumped for nothing. To
  // move a group, drag its header. A group header or a loose session bubbles
  // to the item handler.
  const onRowDragOver = (e: React.DragEvent, session: Session) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    const d = drag.current;
    if (!d) return;
    if (!items) {
      // Ungrouped: every row is its own unit, in the flat order.
      e.stopPropagation();
      dropBeside(
        dropAnchor(
          sessions,
          sessions.findIndex((s) => s.id === d.ids[0]),
          sessions.indexOf(session),
          pastMidpoint(e),
          (s) => s.id,
        ),
      );
      return;
    }
    if (d.group) return;
    const owner = items.find((it) =>
      itemSessions(it).some((s) => s.id === session.id),
    );
    if (!owner || owner.t !== "group") return;
    const covered = owner.group.sessions;
    const from = covered.findIndex((s) => s.id === d.ids[0]);
    if (from === -1) return;
    e.stopPropagation();
    dropBeside(
      dropAnchor(covered, from, covered.indexOf(session), pastMidpoint(e), (s) => s.id),
    );
  };

  // The top level: groups and loose sessions move as whole units.
  // `e.currentTarget` is the item's own box, so the midpoint that decides which
  // side to land on is the whole group's, not whichever row happens to be under
  // the pointer. Using a row's midpoint made a hair's movement over a group's
  // first row fling the dragged item clear of the entire group.
  const onItemDragOver = (e: React.DragEvent, item: SidebarItem) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    const d = drag.current;
    if (!d || !items) return;
    const from = items.findIndex((it) =>
      itemSessions(it).some((s) => d.ids.includes(s.id)),
    );
    if (from === -1) return;
    // A grouped session stays in its group. Landing it beside another item
    // would put its repo's group wherever it went: a group is drawn where its
    // first session is, so dragging that row out drags the group with it.
    if (!d.group && items[from].t === "group") return;
    dropBeside(
      dropAnchor(items, from, items.indexOf(item), pastMidpoint(e), itemEdgeId),
    );
  };

  const handleToggle = () => {
    setHovered(false);
    if (!collapsed) {
      setSuppressOverlay(true);
      window.setTimeout(() => setSuppressOverlay(false), 400);
    }
    toggleSidebar();
  };

  const startResize = (e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = width;
    const onMove = (ev: MouseEvent) =>
      setSidebarWidth(startW + ev.clientX - startX);
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      document.body.style.userSelect = "";
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    document.body.style.userSelect = "none";
  };

  const onListKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (visible.length === 0) return;
    const max = visible.length - 1;
    const cur = Math.min(highlight, max);
    if (e.key === "ArrowDown" || e.key === "j") {
      e.preventDefault();
      setHighlight(Math.min(max, cur + 1));
    } else if (e.key === "ArrowUp" || e.key === "k") {
      e.preventDefault();
      setHighlight(Math.max(0, cur - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      setActiveSession(visible[cur].id);
      e.currentTarget.blur();
      focusTerminal();
    } else if (e.key === "x" || e.key === "Delete" || e.key === "Backspace") {
      e.preventDefault();
      void closeSessionConfirmed(visible[cur].id);
      setHighlight(Math.max(0, Math.min(cur, max - 1)));
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.currentTarget.blur();
      focusTerminal();
    }
  };

  // Drag indices are positions in the flat session order, whichever way the
  // list is drawn; the keyboard highlight follows the drawn order.
  const renderRow = (session: Session, groupName?: string) => (
    <SessionRow
      key={session.id}
      session={session}
      displayName={
        groupName ? sessionNameInGroup(session.name, groupName) : session.name
      }
      active={session.id === activeSessionId}
      highlighted={
        navFocused &&
        visible.indexOf(session) === Math.min(highlight, visible.length - 1)
      }
      dragging={dragging === session.id}
      hoverArmed={hoverArmed}
      onSelect={() => setActiveSession(session.id)}
      onClose={() => closeSessionConfirmed(session.id)}
      onDragStart={(e) => startDrag(e, session.id, [session.id], false)}
      onDragOver={(e) => onRowDragOver(e, session)}
      onMenuOpenChange={onRowMenuOpenChange}
    />
  );

  const notificationsButton = (
    <ActionTooltip label="Notifications" shortcutId="notifications">
      <Button
        variant="ghost"
        size="icon"
        className="relative"
        onClick={openNotifications}
        aria-label="Notifications"
      >
        <Bell className="size-4" />
        {unread > 0 && (
          <span className="absolute right-0.5 top-0.5 flex min-w-3.5 items-center justify-center rounded-full bg-blue-500 px-1 text-[10px] font-medium leading-none text-white">
            {unread > 9 ? "9+" : unread}
          </span>
        )}
      </Button>
    </ActionTooltip>
  );

  // Global actions that live at the bottom of the sidebar.
  const globalActions = (
    <>
      <ActionTooltip label="Command palette" shortcutId="palette">
        <Button
          variant="ghost"
          size="icon"
          className="size-7"
          onClick={() => openPalette(true)}
          aria-label="Command palette"
        >
          <Zap className="size-4" />
        </Button>
      </ActionTooltip>
    </>
  );

  const body = (
    <>
      <div className="flex items-center justify-between px-2 py-1">
        {notificationsButton}
        {/* With the OS drawing the window there is no title bar to hold the app
            menu, so it sits here instead of a decorative logo. */}
        {!customTitlebar && <ProfileMenu withName={false} />}
        <ActionTooltip label="New session" shortcutId="new-session">
          <Button
            variant="ghost"
            size="icon"
            onClick={() => openNewSession()}
            aria-label="New session"
          >
            <Plus className="size-4" />
          </Button>
        </ActionTooltip>
      </div>

      <div
        data-session-list
        ref={listRef}
        tabIndex={0}
        onKeyDown={onListKeyDown}
        onFocus={() => {
          setNavFocused(true);
          const i = visible.findIndex((s) => s.id === activeSessionId);
          setHighlight(i >= 0 ? i : 0);
        }}
        onBlur={() => setNavFocused(false)}
        // Allow dropping in the gaps/padding between rows, not just on a row.
        onDragOver={(e) => e.preventDefault()}
        // `relative` makes this the rows' offset parent, which is what the FLIP
        // pass measures against (the tab strip does the same).
        className="relative flex-1 space-y-0.5 overflow-y-auto px-2 pb-2 pt-1 outline-none"
      >
        {sessions.length === 0 && (
          <p className="px-2 py-3 text-xs text-muted-foreground">
            No sessions yet.
          </p>
        )}
        {items ? (
          items.map((it, i) =>
            it.t === "group" ? (
              <RepoGroupRows
                key={it.group.key}
                group={it.group}
                folded={collapsedRepos.includes(it.group.key)}
                onToggle={() => toggleRepoCollapsed(it.group.key)}
                renderRow={renderRow}
                hoverArmed={hoverArmed}
                onItemDragOver={(e) => onItemDragOver(e, it)}
                dragging={dragging === it.group.key}                onHeaderDragStart={(e) =>
                  startDrag(
                    e,
                    it.group.key,
                    it.group.sessions.map((s) => s.id),
                    true,
                  )
                }
              />
            ) : (
              <Fragment key={it.session.id}>
                {/* A loose session sits at the same level as the groups, so it
                    reads as a peer of them rather than part of a neighbour. */}
                {i > 0 && items[i - 1].t === "group" && (
                  <div role="separator" className="!my-1.5 border-t border-border" />
                )}
                {/* A loose session is its own item, so it takes the
                    item-level drop handler directly. */}
                <div onDragOver={(e) => onItemDragOver(e, it)}>
                  {renderRow(it.session)}
                </div>
                {items[i + 1]?.t === "group" && (
                  <div role="separator" className="!my-1.5 border-t border-border" />
                )}
              </Fragment>
            ),
          )
        ) : (
          sessions.map((s) => renderRow(s))
        )}
      </div>

      <div className="flex items-center justify-between border-t border-border px-2 py-1.5">
        <SidebarMenu
          collapsed={collapsed}
          onToggleCollapsed={handleToggle}
          shortcutTarget={!collapsed}
        />
        <div className="flex items-center gap-0.5">{globalActions}</div>
      </div>
    </>
  );

  if (!collapsed) {
    return (
      <aside
        style={{ width }}
        className="relative flex shrink-0 flex-col border-r border-border bg-background"
      >
        {body}
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize sidebar"
          aria-valuenow={width}
          aria-valuemin={SIDEBAR_MIN}
          aria-valuemax={SIDEBAR_MAX}
          tabIndex={0}
          onMouseDown={startResize}
          onKeyDown={(e) => {
            if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
              e.preventDefault();
              setSidebarWidth(width + (e.key === "ArrowRight" ? 16 : -16));
            }
          }}
          className="absolute -right-1 top-0 z-10 h-full w-2 cursor-col-resize outline-none hover:bg-border focus-visible:bg-ring"
        />
      </aside>
    );
  }

  return (
    <div
      ref={railRef}
      className="relative flex w-12 shrink-0 flex-col items-center border-r border-border bg-background"
      // Don't fly the sidebar open mid-drag (e.g. selecting terminal text that
      // crosses onto the rail); only on a plain hover with no button held.
      onMouseEnter={(e) => {
        if (e.buttons === 0) {
          cancelHide();
          setHovered(true);
        }
      }}
      onMouseLeave={(e) => {
        // The window-resize grips sit a few px inside the bottom/left edges,
        // above the rail. Moving onto one isn't really leaving the sidebar, so
        // don't let approaching the edge snap the fly-out shut.
        if ((e.relatedTarget as Element | null)?.closest?.("[data-window-resize]"))
          return;
        if (rowMenuOpen.current) return;
        // The app menu is wider than the sidebar, so reaching for an item takes
        // the pointer off the rail; hiding there would close the menu with it.
        if (appMenuOpen) return;
        setSuppressOverlay(false);
        cancelHide();
        hideTimer.current = window.setTimeout(() => setHovered(false), 200);
      }}
    >
      <div className="flex h-10 w-full shrink-0 items-center justify-center">
        {notificationsButton}
      </div>
      <div
        data-session-rail
        className="flex flex-1 flex-col items-center gap-1.5 overflow-y-auto py-1"
      >
        {railChunks.map((chunk, i) => (
          <Fragment key={chunk[0].id}>
            {i > 0 && (
              <div
                role="separator"
                className="h-px w-6 shrink-0 bg-muted-foreground/40"
              />
            )}
            {chunk.map((s) => (
              <ActionTooltip key={s.id} label={s.name}>
                <button
                  onClick={() => setActiveSession(s.id)}
                  aria-label={s.name}
                  className={cn(
                    "flex size-7 items-center justify-center rounded-md",
                    s.id === activeSessionId
                      ? "bg-secondary"
                      : "hover:bg-secondary/50",
                  )}
                >
                  <StatusDot
                    state={sessionDotState(s)}
                    icon={s.icon}
                    onIconError={() => revertBrokenIcon(s.id, s.icon)}
                    className="size-2"
                  />
                </button>
              </ActionTooltip>
            ))}
          </Fragment>
        ))}
      </div>
      <div className="flex justify-center border-t border-border py-1.5">
        <SidebarMenu collapsed onToggleCollapsed={handleToggle} shortcutTarget />
      </div>

      {hovered && !suppressOverlay && (
        <div
          style={{ width }}
          className="absolute left-0 top-0 z-30 flex h-full flex-col border-r border-border bg-background shadow-xl duration-150 animate-in fade-in-0 slide-in-from-left-2"
        >
          {body}
        </div>
      )}
    </div>
  );
}

/**
 * The sidebar's own menu, anchored at the foot of the panel: it collapses or
 * expands the sidebar and carries the settings that shape the session list.
 * Hovering opens it, so the options are one gesture away, and clicking still
 * works for keyboard and touch.
 *
 * `shortcutTarget` marks the instance the shortcut drives. A collapsed sidebar
 * renders one menu on the rail and another in the hover fly-out, and only the
 * rail's is always on screen, so it takes the shortcut.
 */
function SidebarMenu({
  collapsed,
  onToggleCollapsed,
  shortcutTarget,
}: {
  collapsed: boolean;
  onToggleCollapsed: () => void;
  shortcutTarget: boolean;
}) {
  const grouping = usePrefs((s) => s.groupSessionsByRepo);
  const setGrouping = usePrefs((s) => s.setGroupSessionsByRepo);
  // Re-render on a rebind so the shortcuts shown here stay current.
  useKeybindings((s) => s.overrides);
  // The shortcut toggles the store's flag, so the instance it drives reads its
  // open state from there; the other keeps its own, purely for hover.
  const storeOpen = useUI((s) => s.sidebarMenuOpen);
  const setStoreOpen = useUI((s) => s.setSidebarMenuOpen);
  const [localOpen, setLocalOpen] = useState(false);
  const open = shortcutTarget ? storeOpen : localOpen;
  const setOpen = shortcutTarget ? setStoreOpen : setLocalOpen;
  const rootRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  // A hover-opened menu must not steal focus from the terminal; one opened by
  // the shortcut or a click has to take it, or there is no way to walk it.
  const byPointer = useRef(false);
  // Closing lags the pointer leaving by a moment so the gap between the button
  // and the menu doesn't snap it shut on the way in.
  const closeTimer = useRef<number | null>(null);
  const cancelClose = () => {
    if (closeTimer.current !== null) {
      window.clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
  };
  useEffect(() => cancelClose, []);
  const scheduleClose = () => {
    cancelClose();
    closeTimer.current = window.setTimeout(() => setOpen(false), 200);
  };

  // Leave the shared flag down when this instance goes away (collapsing the
  // sidebar swaps which one is on screen), so the next one doesn't come up open.
  useEffect(() => {
    if (!shortcutTarget) return;
    return () => setStoreOpen(false);
  }, [shortcutTarget, setStoreOpen]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setOpen(false);
      rootRef.current?.querySelector("button")?.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, setOpen]);

  useEffect(() => {
    // Arm the next open: a shortcut press has no pointer behind it.
    if (!open) {
      byPointer.current = false;
      return;
    }
    if (byPointer.current) return;
    menuRef.current?.querySelector<HTMLElement>("button")?.focus();
  }, [open]);

  const keys = shortcutLabel("toggle-sidebar");
  return (
    <div
      ref={rootRef}
      className="relative"
      onMouseEnter={() => {
        cancelClose();
        byPointer.current = true;
        setOpen(true);
      }}
      onMouseLeave={scheduleClose}
    >
      <ActionTooltip label="Sidebar menu" shortcutId="sidebar-menu">
        <Button
          variant="ghost"
          size="icon"
          className="size-7"
          onClick={() => {
            byPointer.current = true;
            setOpen(!open);
          }}
          aria-label="Sidebar menu"
          aria-haspopup="menu"
          aria-expanded={open}
        >
          <PanelLeft className="size-4" />
        </Button>
      </ActionTooltip>
      {open && (
        <div
          ref={menuRef}
          role="menu"
          aria-label="Sidebar menu"
          aria-orientation="vertical"
          onBlur={(e) => {
            // Tabbing out of the menu closes it; focus moving between its own
            // items does not.
            if (!e.currentTarget.contains(e.relatedTarget as Node | null))
              setOpen(false);
          }}
          className="absolute bottom-full left-0 z-50 mb-1 w-56 rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-md"
        >
          <label className="flex cursor-pointer items-center gap-2 rounded px-2 py-1 text-sm hover:bg-accent hover:text-accent-foreground">
            <Switch
              checked={grouping}
              onCheckedChange={setGrouping}
              aria-label="Group sessions by repo"
            />
            Group sessions by repo
          </label>
          <div role="separator" className="my-1 border-t border-border" />
          <button
            role="menuitem"
            onClick={() => {
              setOpen(false);
              onToggleCollapsed();
            }}
            className="flex w-full items-center gap-2 rounded px-2 py-1 text-left text-sm hover:bg-accent hover:text-accent-foreground"
          >
            {collapsed ? (
              <PanelLeftOpen className="size-4 shrink-0" />
            ) : (
              <PanelLeftClose className="size-4 shrink-0" />
            )}
            <span>{collapsed ? "Expand sidebar" : "Collapse sidebar"}</span>
            {keys && (
              <kbd className="ml-auto rounded border border-border bg-muted px-1 font-mono text-[10px] text-muted-foreground">
                {keys}
              </kbd>
            )}
          </button>
        </div>
      )}
    </div>
  );
}

function RepoGroupRows({
  group,
  folded,
  onToggle,
  renderRow,
  hoverArmed,
  dragging,
  onHeaderDragStart,
  onItemDragOver,
}: {
  group: RepoGroup;
  folded: boolean;
  onToggle: () => void;
  renderRow: (session: Session, groupName?: string) => React.ReactNode;
  hoverArmed: boolean;
  dragging: boolean;
  onHeaderDragStart: (e: React.DragEvent) => void;
  onItemDragOver: (e: React.DragEvent) => void;
}) {
  const openNewSession = useUI((s) => s.openNewSession);
  const Chevron = folded ? ChevronRight : ChevronDown;
  // A folded group still has to show that something inside wants you.
  const attention =
    folded && group.sessions.some((s) => sessionDotState(s) === "attention");
  return (
    // The drop handler sits on the whole group, so the pointer is measured
    // against the group's full height. A row inside takes the event first and
    // stops it only when it is reordering within this group.
    <div
      data-repo-group={group.key}
      onDragOver={onItemDragOver}
      className={cn("group/repo space-y-0.5", dragging && "opacity-0")}
    >
      <div
        draggable
        onDragStart={onHeaderDragStart}
        className={cn(
          "flex items-center gap-1 rounded-md px-1 py-1",
          // Only while the pointer is really hovering: a drag freezes :hover on
          // whatever it passes over, lighting up rows it is merely crossing.
          hoverArmed && "hover:bg-secondary/50",
        )}
      >
        <button
          onClick={onToggle}
          aria-expanded={!folded}
          aria-label={`${group.name} repo`}
          className="flex min-w-0 flex-1 items-center gap-1 text-xs font-medium text-muted-foreground"
        >
          <Chevron className="size-3.5 shrink-0" />
          <span className="truncate">{group.name}</span>
          {attention && (
            <span className="size-1.5 shrink-0 rounded-full bg-blue-500" />
          )}
        </button>
        <ActionTooltip label="New session here">
          <button
            onClick={(e) => {
              e.stopPropagation();
              openNewSession(group.key);
            }}
            className={cn(
              "shrink-0 rounded opacity-0 focus-visible:opacity-100 hover:bg-background/60",
              hoverArmed && "group-hover/repo:opacity-100",
            )}
            aria-label={`New session in ${group.name}`}
          >
            <Plus className="size-3.5" />
          </button>
        </ActionTooltip>
        {/* The count stands in for the chevron's collapsed state: once you can
            see the sessions, counting them is pointless. */}
        {folded && (
          <span className="pl-1 text-xs tabular-nums text-muted-foreground/70">
            {group.sessions.length}
          </span>
        )}
      </div>
      {!folded && (
        <div className="space-y-0.5 pl-2">
          {group.sessions.map((s) => renderRow(s, group.name))}
        </div>
      )}
    </div>
  );
}

function SessionRow({
  session,
  displayName,
  active,
  highlighted,
  dragging,
  hoverArmed,
  onSelect,
  onClose,
  onDragStart,
  onDragOver,
  onMenuOpenChange,
}: {
  session: Session;
  displayName: string;
  active: boolean;
  highlighted: boolean;
  dragging: boolean;
  hoverArmed: boolean;
  onSelect: () => void;
  onClose: () => void;
  onDragStart: (e: React.DragEvent) => void;
  onDragOver: (e: React.DragEvent) => void;
  onMenuOpenChange: (open: boolean) => void;
}) {
  const openSessionSettings = useUI((s) => s.openSessionSettings);
  const openSessionUsage = useUI((s) => s.openSessionUsage);
  const openSessionNotes = useUI((s) => s.openSessionNotes);
  return (
    <ContextMenu onOpenChange={onMenuOpenChange}>
      <ContextMenuTrigger asChild>
    <div
      data-row-id={session.id}
      onClick={onSelect}
      onDoubleClick={() => openSessionSettings(session.id)}
      draggable
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDrop={(e) => e.preventDefault()}
      className={cn(
        "group flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm",
        active
          ? "bg-secondary text-secondary-foreground"
          : cn(
              "text-muted-foreground",
              // Only while the pointer is really hovering: a drag freezes
              // :hover on whatever it passes over, lighting up rows it is
              // merely crossing on the way somewhere else.
              hoverArmed && "hover:bg-secondary/50",
            ),
        highlighted && "ring-1 ring-ring",
        dragging && "opacity-0",
      )}
    >
      {/* Fixed slot so a row's text starts at the same x whether it shows the
          small dot or a larger icon. */}
      <span
        data-status-slot
        className="flex size-4 shrink-0 items-center justify-center"
      >
        <StatusDot
          state={sessionDotState(session)}
          icon={session.icon}
          onIconError={() => revertBrokenIcon(session.id, session.icon)}
        />
      </span>
      <div className="min-w-0 flex-1">
        <span className="block truncate" title="Double-click for session settings">
          {displayName}
        </span>
        {session.branch && (
          <span className="flex items-center gap-1 text-xs text-muted-foreground/80">
            <GitBranch data-branch-icon className="size-3 shrink-0" />
            {/* The name above already says the branch when they match (a
                worktree named after its own branch), so only the icon
                needs to show; naming it again would be noise. */}
            {session.branch !== displayName && (
              <span data-branch-name className="truncate">
                {session.branch}
              </span>
            )}
            {session.dirty && <span className="text-amber-500">✱</span>}
          </span>
        )}
      </div>
      <ActionTooltip label="Session settings" shortcutId="session-settings">
        <button
          onClick={(e) => {
            e.stopPropagation();
            openSessionSettings(session.id);
          }}
          className={cn(
            "shrink-0 rounded opacity-0 focus-visible:opacity-100 hover:bg-background/60",
            hoverArmed && "group-hover:opacity-100",
          )}
          aria-label="Session settings"
        >
          <Settings className="size-3.5" />
        </button>
      </ActionTooltip>
      <ActionTooltip label="Close session">
        <button
          onClick={(e) => {
            e.stopPropagation();
            onClose();
          }}
          className={cn(
            "shrink-0 rounded opacity-0 focus-visible:opacity-100 hover:bg-background/60",
            hoverArmed && "group-hover:opacity-100",
          )}
          aria-label="Close session"
        >
          <X className="size-3.5" />
        </button>
      </ActionTooltip>
    </div>
      </ContextMenuTrigger>
      {/* Every item here opens something that takes focus itself. The menu
          restores focus to this row when it finishes unmounting, which lands
          a few hundred ms later and would pull focus back out of whatever
          just opened. */}
      <ContextMenuContent onCloseAutoFocus={(e) => e.preventDefault()}>
        {/* Both items open a dialog; defer past the menu's own close so its
            exit animation doesn't race the dialog's pointer-events lock. */}
        <ContextMenuItem
          onSelect={() => setTimeout(() => openSessionSettings(session.id), 0)}
        >
          Settings
          <ContextMenuShortcut>{shortcutLabel("session-settings")}</ContextMenuShortcut>
        </ContextMenuItem>
        <ContextMenuItem
          onSelect={() =>
            setTimeout(() => {
              onSelect();
              openSessionNotes(session.id);
            }, 0)
          }
        >
          Notes
          <ContextMenuShortcut>{shortcutLabel("session-notes")}</ContextMenuShortcut>
        </ContextMenuItem>
        <ContextMenuItem
          onSelect={() =>
            setTimeout(() => {
              // The panel is docked beside the session it reports and closes
              // when you navigate away, so bring that session up rather than
              // describing one that isn't on screen.
              onSelect();
              openSessionUsage(session.id);
            }, 0)
          }
        >
          Resource usage
          <ContextMenuShortcut>{shortcutLabel("session-usage")}</ContextMenuShortcut>
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => setTimeout(onClose, 0)}>
          Close
          <ContextMenuShortcut>{shortcutLabel("close-session")}</ContextMenuShortcut>
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}
