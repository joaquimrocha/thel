import { useEffect, useRef, useState } from "react";
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
import { ProfileDialog } from "@/components/ProfileDialog";
import { ActionTooltip } from "@/components/ActionTooltip";
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

// "thel >_ <profile>" doubles as the profile switcher: each profile opens in its
// own window, so picking one focuses (or opens) that window.
function ProfileMenu() {
  const profiles = useProfiles((s) => s.profiles);
  const currentId = useProfiles((s) => s.currentId);
  const current = useProfiles((s) =>
    s.profiles.find((p) => p.id === s.currentId),
  );
  const currentName = current?.name ?? "Default";
  // The name only adds information once there are several profiles, or once the
  // lone default has been given a custom name; otherwise it's just clutter.
  const showName = profiles.length > 1 || currentName !== "Default";
  const switchProfile = useProfiles((s) => s.switchProfile);
  // Open state lives in the UI store so a global shortcut can toggle it.
  const open = useUI((s) => s.profileMenuOpen);
  const setOpen = useUI((s) => s.setProfileMenuOpen);
  const toggle = useUI((s) => s.toggleProfileMenu);
  const openSettings = useUI((s) => s.openSettings);
  const [dialogOpen, setDialogOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  // Close on Escape and hand focus back to the trigger. The window listener
  // catches it even if focus has drifted out of the menu.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, setOpen]);

  // On open, move focus into the menu (the active profile, else the first item).
  useEffect(() => {
    if (!open) return;
    const menu = menuRef.current;
    const active = menu?.querySelector<HTMLElement>('[data-active="true"]');
    (active ?? menu?.querySelector<HTMLElement>('[role="menuitem"]'))?.focus();
  }, [open]);

  // Roving arrow-key navigation between the menu items (WAI-ARIA menu pattern).
  const onMenuKeyDown = (e: React.KeyboardEvent) => {
    const items = Array.from(
      menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [],
    );
    if (!items.length) return;
    const cur = items.indexOf(document.activeElement as HTMLElement);
    const focusAt = (n: number) => {
      e.preventDefault();
      items[(n + items.length) % items.length]?.focus();
    };
    if (e.key === "ArrowDown") focusAt(cur + 1);
    else if (e.key === "ArrowUp") focusAt(cur - 1);
    else if (e.key === "Home") focusAt(0);
    else if (e.key === "End") focusAt(items.length - 1);
    else if (e.key === "Tab") setOpen(false); // menus close on Tab
  };

  return (
    <div className="relative">
      <ActionTooltip label="App menu" shortcutId="app-menu" side="bottom">
        <button
          ref={triggerRef}
          data-testid="app-menu"
          aria-label="App menu"
          aria-haspopup="menu"
          aria-expanded={open}
          onClick={() => toggle()}
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
      </ActionTooltip>

      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div
            ref={menuRef}
            role="menu"
            aria-label="App menu"
            aria-orientation="vertical"
            onKeyDown={onMenuKeyDown}
            className="absolute left-0 top-full z-50 mt-1 w-56 rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-md"
          >
            <div className="flex items-center justify-between py-1 pl-2 pr-1">
              <span className="text-xs text-muted-foreground">Profiles</span>
              <button
                role="menuitem"
                tabIndex={-1}
                onClick={() => {
                  setOpen(false);
                  openSettings("profiles");
                }}
                title="Manage profiles"
                aria-label="Manage profiles"
                className="rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-accent-foreground"
              >
                <Users className="size-3.5" />
              </button>
            </div>
            {profiles.map((p) => (
              <button
                key={p.id}
                role="menuitem"
                tabIndex={-1}
                data-active={p.id === currentId ? "true" : undefined}
                onClick={() => {
                  void switchProfile(p.id);
                  setOpen(false);
                }}
                className="flex w-full items-center gap-2 rounded px-2 py-1 text-left text-sm hover:bg-accent hover:text-accent-foreground"
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
              </button>
            ))}
            <button
              role="menuitem"
              tabIndex={-1}
              onClick={() => {
                setOpen(false);
                setDialogOpen(true);
              }}
              className="flex w-full items-center gap-2 rounded px-2 py-1 text-left text-sm hover:bg-accent hover:text-accent-foreground"
            >
              <Plus className="size-3.5 shrink-0" /> New profile
            </button>
            <div className="my-1 h-px bg-border" />
            <button
              role="menuitem"
              tabIndex={-1}
              onClick={() => {
                setOpen(false);
                openSettings();
              }}
              className="flex w-full items-center gap-2 rounded px-2 py-1 text-left text-sm hover:bg-accent hover:text-accent-foreground"
            >
              <Settings className="size-3.5 shrink-0" /> Settings
            </button>
          </div>
        </>
      )}

      <ProfileDialog open={dialogOpen} onOpenChange={setDialogOpen} />
    </div>
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
