import { CheckCircle2, Minus } from "lucide-react";
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
import { usePrefs } from "@/store/prefs";

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <span className="text-muted-foreground">{label}</span>
      <span className="flex items-center gap-1.5 font-medium">{children}</span>
    </div>
  );
}

export function SessionsDialog() {
  const open = useUI((s) => s.sessionsOpen);
  const setOpen = useUI((s) => s.setSessionsOpen);
  const useDaemon = usePrefs((s) => s.useDaemon);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Sessions</DialogTitle>
          <DialogDescription>How thel is backing your terminals.</DialogDescription>
        </DialogHeader>

        <dl className="space-y-2 text-sm">
          <Row label="Backend">
            {useDaemon ? (
              <>
                <CheckCircle2 className="size-4 text-emerald-500" />
                Running in the background
              </>
            ) : (
              <>
                <Minus className="size-4 text-muted-foreground" />
                Stops with the app
              </>
            )}
          </Row>
        </dl>

        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={() => setOpen(false)}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
