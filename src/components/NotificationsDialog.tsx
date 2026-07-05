import { useEffect } from "react";
import { Bell, Check, CircleX, Settings } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { useUI } from "@/store/ui";
import { useSessions } from "@/store/sessions";
import {
  useNotifications,
  kindLabel,
  activateNotification,
  type Notification,
} from "@/store/notifications";

const label = (n: Notification) => kindLabel(n.kind, n.detail);

function Icon({ kind }: { kind: Notification["kind"] }) {
  const cls = "size-4 shrink-0";
  if (kind === "bell") return <Bell className={cls + " text-blue-500"} />;
  if (kind === "idle") return <Check className={cls + " text-emerald-500"} />;
  return <CircleX className={cls + " text-muted-foreground"} />;
}

function ago(at: number): string {
  const s = Math.floor((Date.now() - at) / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export function NotificationsDialog() {
  const open = useUI((s) => s.notificationsOpen);
  const setOpen = useUI((s) => s.setNotificationsOpen);
  const items = useNotifications((s) => s.items);
  const markAllRead = useNotifications((s) => s.markAllRead);
  const clearItems = useNotifications((s) => s.clear);
  const clearAllAttention = useSessions((s) => s.clearAllAttention);
  // Clearing the panel also drops the attention dots on sessions/tabs that
  // those notifications were flagging.
  const clear = () => {
    clearItems();
    clearAllAttention();
  };

  // Opening the panel counts as seeing them.
  useEffect(() => {
    if (open) markAllRead();
  }, [open, markAllRead]);

  const jump = (n: Notification) => {
    activateNotification(n.sessionId, n.terminalId);
    setOpen(false);
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Notifications</DialogTitle>
          <DialogDescription>
            Activity in terminals you weren't looking at.
          </DialogDescription>
        </DialogHeader>

        <div className="max-h-80 space-y-1 overflow-y-auto">
          {items.length === 0 && (
            <p className="py-6 text-center text-sm text-muted-foreground">
              No notifications.
            </p>
          )}
          {items.map((n) => (
            <button
              key={n.id}
              onClick={() => jump(n)}
              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent"
            >
              <Icon kind={n.kind} />
              <span className="min-w-0 flex-1">
                <span className="block truncate">
                  <span className="text-muted-foreground">{n.sessionName}</span>
                  {" › "}
                  {n.terminalTitle}
                </span>
                <span className="block truncate text-xs text-muted-foreground">
                  {label(n)}
                </span>
              </span>
              <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                {ago(n.at)}
              </span>
            </button>
          ))}
        </div>

        <DialogFooter>
          {items.length > 0 && (
            <Button variant="ghost" size="sm" onClick={clear}>
              Clear all
            </Button>
          )}
          <Button
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-xs text-muted-foreground"
            aria-label="Notification settings"
            onClick={() => {
              setOpen(false);
              useUI.getState().openSettings("notifications");
            }}
          >
            <Settings className="size-3.5" /> Settings
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
