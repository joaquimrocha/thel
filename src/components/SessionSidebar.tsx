import { useEffect, useRef, useState } from "react";
import {
  X,
  Plus,
  Bell,
  GitBranch,
  PanelLeftClose,
  PanelLeftOpen,
  Zap,
  Settings,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { useSessions, type Session } from "@/store/sessions";
import { usePrefs } from "@/store/prefs";
import { useNotifications } from "@/store/notifications";
import { useUI } from "@/store/ui";
import { closeSessionConfirmed } from "@/lib/actions";
import { StatusDot, sessionDotState } from "./StatusDot";
import { ActionTooltip } from "./ActionTooltip";
import { Logo } from "./Logo";

export function SessionSidebar() {
  const sessions = useSessions((s) => s.sessions);
  const activeSessionId = useSessions((s) => s.activeSessionId);
  const setActiveSession = useSessions((s) => s.setActiveSession);
  const openNewSession = useUI((s) => s.openNewSession);
  const openPalette = useUI((s) => s.setPaletteOpen);
  const openNotifications = useUI((s) => s.openNotifications);
  const unread = useNotifications((s) => s.items.filter((i) => !i.read).length);
  // The custom title bar already shows "thel", so drop the redundant sidebar
  // brand when it's on.
  const customTitlebar = usePrefs((s) => s.customTitlebar);
  const focusTerminal = useUI((s) => s.focusTerminal);
  const width = useUI((s) => s.sidebarWidth);
  const collapsed = useUI((s) => s.sidebarCollapsed);
  const toggleSidebar = useUI((s) => s.toggleSidebar);
  const setSidebarWidth = useUI((s) => s.setSidebarWidth);
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
  // Keyboard navigation cursor while the list is focused.
  const [navFocused, setNavFocused] = useState(false);
  const [highlight, setHighlight] = useState(0);

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
    if (sessions.length === 0) return;
    const max = sessions.length - 1;
    const cur = Math.min(highlight, max);
    if (e.key === "ArrowDown" || e.key === "j") {
      e.preventDefault();
      setHighlight(Math.min(max, cur + 1));
    } else if (e.key === "ArrowUp" || e.key === "k") {
      e.preventDefault();
      setHighlight(Math.max(0, cur - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      setActiveSession(sessions[cur].id);
      e.currentTarget.blur();
      focusTerminal();
    } else if (e.key === "x" || e.key === "Delete" || e.key === "Backspace") {
      e.preventDefault();
      void closeSessionConfirmed(sessions[cur].id);
      setHighlight(Math.max(0, Math.min(cur, max - 1)));
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.currentTarget.blur();
      focusTerminal();
    }
  };

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
        {!customTitlebar && <Logo className="size-4 text-emerald-500" />}
        <ActionTooltip label="New session" shortcutId="new-session">
          <Button
            variant="ghost"
            size="icon"
            onClick={openNewSession}
            aria-label="New session"
          >
            <Plus className="size-4" />
          </Button>
        </ActionTooltip>
      </div>

      <div
        data-session-list
        tabIndex={0}
        onKeyDown={onListKeyDown}
        onFocus={() => {
          setNavFocused(true);
          const i = sessions.findIndex((s) => s.id === activeSessionId);
          setHighlight(i >= 0 ? i : 0);
        }}
        onBlur={() => setNavFocused(false)}
        className="flex-1 space-y-0.5 overflow-y-auto px-2 pb-2 pt-1 outline-none"
      >
        {sessions.length === 0 && (
          <p className="px-2 py-3 text-xs text-muted-foreground">
            No sessions yet.
          </p>
        )}
        {sessions.map((session, i) => (
          <SessionRow
            key={session.id}
            session={session}
            index={i}
            active={session.id === activeSessionId}
            highlighted={navFocused && i === Math.min(highlight, sessions.length - 1)}
            onSelect={() => setActiveSession(session.id)}
            onClose={() => closeSessionConfirmed(session.id)}
          />
        ))}
      </div>

      <div className="flex items-center justify-between border-t border-border px-2 py-1.5">
        <ActionTooltip
          label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          shortcutId="toggle-sidebar"
        >
          <Button
            variant="ghost"
            size="icon"
            className="size-7"
            onClick={handleToggle}
            aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          >
            {collapsed ? (
              <PanelLeftOpen className="size-4" />
            ) : (
              <PanelLeftClose className="size-4" />
            )}
          </Button>
        </ActionTooltip>
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
          onMouseDown={startResize}
          className="absolute -right-1 top-0 z-10 h-full w-2 cursor-col-resize hover:bg-border"
          aria-label="Resize sidebar"
        />
      </aside>
    );
  }

  return (
    <div
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
        setSuppressOverlay(false);
        cancelHide();
        hideTimer.current = window.setTimeout(() => setHovered(false), 200);
      }}
    >
      <div className="flex h-10 w-full shrink-0 items-center justify-center">
        {notificationsButton}
      </div>
      <div className="flex flex-1 flex-col items-center gap-1.5 overflow-y-auto py-1">
        {sessions.map((s) => (
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
                className="size-2"
              />
            </button>
          </ActionTooltip>
        ))}
      </div>
      <div className="flex justify-center border-t border-border py-1.5">
        <ActionTooltip label="Expand sidebar" shortcutId="toggle-sidebar">
          <Button
            variant="ghost"
            size="icon"
            className="size-7"
            onClick={handleToggle}
            aria-label="Expand sidebar"
          >
            <PanelLeftOpen className="size-4" />
          </Button>
        </ActionTooltip>
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

function SessionRow({
  session,
  index,
  active,
  highlighted,
  onSelect,
  onClose,
}: {
  session: Session;
  index: number;
  active: boolean;
  highlighted: boolean;
  onSelect: () => void;
  onClose: () => void;
}) {
  const reorderSession = useSessions((s) => s.reorderSession);
  const openSessionSettings = useUI((s) => s.openSessionSettings);
  return (
    <div
      onClick={onSelect}
      onDoubleClick={() => openSessionSettings(session.id)}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData("text/plain", session.id);
        e.dataTransfer.effectAllowed = "move";
      }}
      onDragOver={(e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
      }}
      onDrop={(e) => {
        e.preventDefault();
        const id = e.dataTransfer.getData("text/plain");
        if (id && id !== session.id) reorderSession(id, index);
      }}
      className={cn(
        "group flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm",
        active
          ? "bg-secondary text-secondary-foreground"
          : "text-muted-foreground hover:bg-secondary/50",
        highlighted && "ring-1 ring-ring",
      )}
    >
      {/* Fixed slot so a row's text starts at the same x whether it shows the
          small dot or a larger icon. */}
      <span
        data-status-slot
        className="flex size-4 shrink-0 items-center justify-center"
      >
        <StatusDot state={sessionDotState(session)} icon={session.icon} />
      </span>
      <div className="min-w-0 flex-1">
        <span className="block truncate" title="Double-click for session settings">
          {session.name}
        </span>
        {session.branch && (
          <span className="flex items-center gap-1 text-xs text-muted-foreground/80">
            <GitBranch className="size-3 shrink-0" />
            <span className="truncate">{session.branch}</span>
            {session.dirty && <span className="text-amber-500">✱</span>}
          </span>
        )}
      </div>
      <ActionTooltip label="Session settings">
        <button
          onClick={(e) => {
            e.stopPropagation();
            openSessionSettings(session.id);
          }}
          className="shrink-0 rounded opacity-0 hover:bg-background/60 group-hover:opacity-100"
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
          className="shrink-0 rounded opacity-0 hover:bg-background/60 group-hover:opacity-100"
          aria-label="Close session"
        >
          <X className="size-3.5" />
        </button>
      </ActionTooltip>
    </div>
  );
}
