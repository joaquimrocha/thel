import { useState } from "react";
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
import { restartDaemon, setDaemonOptOut } from "@/lib/pty";

/// Shown at startup when an incompatible (older) session daemon is still running
/// from a previous version. The user must choose; both choices reload.
export function DaemonSkewDialog() {
  const open = useUI((s) => s.daemonSkew);
  const [busy, setBusy] = useState(false);

  const restart = async () => {
    setBusy(true);
    // Even if the kill reports an error, reload and let a fresh daemon spawn.
    await restartDaemon().catch(() => {});
    window.location.reload();
  };

  const notNow = () => {
    setDaemonOptOut();
    window.location.reload();
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        // Dismissing (X / Escape) means "not now": keep the old daemon, run
        // direct this session.
        if (!o && !busy) notNow();
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
          Choose "Not now" to keep them and open new terminals that stop with the
          app until you restart.
        </p>
        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={notNow} disabled={busy}>
            Not now
          </Button>
          <Button variant="default" size="sm" onClick={restart} disabled={busy}>
            {busy ? "Restarting…" : "Restart"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
