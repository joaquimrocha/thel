import { useRef } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  Minus,
  Square,
  X,
  Check,
  Plus,
  FolderGit2,
  Settings,
  Users,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useSessions } from "@/store/sessions";
import { useProfiles } from "@/store/profiles";
import { useUI } from "@/store/ui";
import { ActionTooltip } from "@/components/ActionTooltip";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { Logo } from "@/components/Logo";
import { SvgIcon } from "@/components/SvgIcon";

// Custom titlebar (the OS one is disabled via decorations:false). The bar is a
// drag region; the window controls and the profile menu sit on top and stay
// clickable because they don't carry the drag-region attribute.
export function Titlebar() {
  const name = useSessions((s) =>
    s.sessions.find((x) => x.id === s.activeSessionId)?.name,
  );
  const icon = useSessions((s) =>
    s.sessions.find((x) => x.id === s.activeSessionId)?.icon,
  );
  // The current profile's accent tints this window's title bar border.
  const color = useProfiles(
    (s) => s.profiles.find((p) => p.id === s.currentId)?.color,
  );

  return (
    <div
      data-tauri-drag-region
      className={cn(
        "relative flex h-9 shrink-0 select-none items-center bg-background pl-2",
        color && "border-b-[1.5px]",
      )}
      style={color ? { borderBottomColor: color } : undefined}
    >
      <ProfileMenu />
      {/* Centered on the window regardless of the side widths. pointer-events-none
          lets a drag started here fall through to the bar. */}
      {name && (
        <div className="pointer-events-none absolute inset-x-0 flex items-center justify-center gap-1.5">
          {icon ? (
            <SvgIcon svg={icon} color="#a1a1aa" className="size-3.5 shrink-0" />
          ) : (
            <FolderGit2 className="size-3.5 shrink-0 text-muted-foreground" />
          )}
          <span
            data-testid="active-session-name"
            className="max-w-[50%] truncate text-sm text-muted-foreground"
          >
            {name}
          </span>
        </div>
      )}
      <div className="ml-auto flex h-full items-center gap-1 pr-2">
        <ControlButton label="Minimize" onClick={(w) => w.minimize()}>
          <Minus className="size-3" />
        </ControlButton>
        <ControlButton label="Maximize" onClick={(w) => w.toggleMaximize()}>
          <Square className="size-2.5" />
        </ControlButton>
        <ControlButton label="Close" danger onClick={(w) => w.close()}>
          <X className="size-3" />
        </ControlButton>
      </div>
    </div>
  );
}

/**
 * The logo button and its menu: profiles, and the way into Settings. Each
 * profile opens in its own window, so picking one focuses (or opens) that
 * window. Lives in the custom title bar, and in the sidebar header when the OS
 * draws the window instead, so it is reachable either way. `withName` is off
 * there: the header has no room for it and the OS title bar carries it.
 */
export function ProfileMenu({ withName = true }: { withName?: boolean }) {
  const profiles = useProfiles((s) => s.profiles);
  const currentId = useProfiles((s) => s.currentId);
  const current = useProfiles((s) =>
    s.profiles.find((p) => p.id === s.currentId),
  );
  const currentName = current?.name ?? "Default";
  // The name only adds information once there are several profiles, or once the
  // lone default has been given a custom name; otherwise it's just clutter.
  const showName =
    withName && (profiles.length > 1 || currentName !== "Default");
  const switchProfile = useProfiles((s) => s.switchProfile);
  // Open state lives in the UI store so a global shortcut can toggle it.
  const open = useUI((s) => s.profileMenuOpen);
  const setOpen = useUI((s) => s.setProfileMenuOpen);
  const openSettings = useUI((s) => s.openSettings);
  const setProfileDialogOpen = useUI((s) => s.setProfileDialogOpen);
  const menuRef = useRef<HTMLDivElement>(null);

  return (
    <DropdownMenu open={open} onOpenChange={setOpen} modal={false}>
      <ActionTooltip label="App menu" shortcutId="app-menu" side="bottom">
        <DropdownMenuTrigger asChild>
          <button
            data-testid="app-menu"
            aria-label="App menu"
            className="flex items-center gap-1.5 rounded px-1.5 py-0.5 text-sm hover:bg-secondary"
          >
            <Logo
              className="size-[18px] text-zinc-300"
              style={current?.color ? { color: current.color } : undefined}
            />
            {showName && (
              <>
                <span className="text-muted-foreground">/</span>
                <span className="text-muted-foreground">{currentName}</span>
              </>
            )}
          </button>
        </DropdownMenuTrigger>
      </ActionTooltip>
      <DropdownMenuContent
        ref={menuRef}
        align="start"
        loop
        className="w-56"
        // Land on the active profile rather than the first item.
        onOpenAutoFocus={(e) => {
          const active = menuRef.current?.querySelector<HTMLElement>("[data-active]");
          if (!active) return;
          e.preventDefault();
          active.focus();
        }}
      >
        <div className="flex items-center justify-between py-1 pl-2 pr-1">
          <span className="text-xs text-muted-foreground">Profiles</span>
          <DropdownMenuItem
            onSelect={() => openSettings("profiles")}
            title="Manage profiles"
            aria-label="Manage profiles"
            className="p-0.5 text-muted-foreground"
          >
            <Users className="size-3.5" />
          </DropdownMenuItem>
        </div>
        {profiles.map((p) => (
          <DropdownMenuItem
            key={p.id}
            data-active={p.id === currentId ? "" : undefined}
            onSelect={() => void switchProfile(p.id)}
            className="justify-start"
          >
            <Check
              className={cn(
                "size-3.5 shrink-0",
                p.id === currentId ? "opacity-100" : "opacity-0",
              )}
            />
            <span
              className="size-2.5 shrink-0 rounded-full border border-border"
              style={p.color ? { backgroundColor: p.color } : undefined}
            />
            <span className="truncate">{p.name}</span>
          </DropdownMenuItem>
        ))}
        <DropdownMenuItem
          onSelect={() => setProfileDialogOpen(true)}
          className="justify-start"
        >
          <Plus className="size-3.5 shrink-0" /> New profile
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => openSettings()} className="justify-start">
          <Settings className="size-3.5 shrink-0" /> Settings
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function ControlButton({
  label,
  danger,
  onClick,
  children,
}: {
  label: string;
  danger?: boolean;
  onClick: (w: ReturnType<typeof getCurrentWindow>) => Promise<void>;
  children: React.ReactNode;
}) {
  return (
    <button
      aria-label={label}
      // Resolve the window lazily so importing this file never touches Tauri.
      onClick={() => void onClick(getCurrentWindow())}
      className={cn(
        "flex size-6 items-center justify-center rounded text-muted-foreground hover:bg-secondary",
        danger && "hover:bg-destructive hover:text-destructive-foreground",
      )}
    >
      {children}
    </button>
  );
}
