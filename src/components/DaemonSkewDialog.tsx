import { useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
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
import { restartDaemon } from "@/lib/pty";

/// Shown at startup when an incompatible (older) session daemon is still running
/// from a previous version. The old daemon holds the socket, so this build gets
/// no terminals until the user either takes it over or steps out of the way.
export function DaemonSkewDialog() {
  const open = useUI((s) => s.daemonSkew);
  const [busy, setBusy] = useState(false);

  const restart = async () => {
    setBusy(true);
    // Even if the kill reports an error, reload and let a fresh daemon spawn.
    await restartDaemon().catch(() => {});
    window.location.reload();
  };

  const closeWindow = () => void getCurrentWindow().close();

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        // Dismissing (X / Escape) means the same as the button: leave the old
        // daemon and its terminals alone.
        if (!o && !busy) closeWindow();
      }}
    >
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Restart background sessions?</DialogTitle>
          <DialogDescription>
            A newer version of thel is running, but your background sessions are
            still managed by the previous version, and they can't talk to each
            other.
          </DialogDescription>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">
          Restarting lets the new version take over, but it will{" "}
          <strong>close every terminal still running in the background</strong>.
          Closing this window leaves them running under the previous version;
          reopen thel once they're done.
        </p>
        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={closeWindow} disabled={busy}>
            Close window
          </Button>
          <Button variant="default" size="sm" onClick={restart} disabled={busy}>
            {busy ? "Restarting…" : "Restart"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
