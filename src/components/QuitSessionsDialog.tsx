import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { useQuitPrompt } from "@/lib/quitPrompt";

const count = (n: number, one: string, many: string) =>
  `${n} ${n === 1 ? one : many}`;

/// Shown when the window is closing and the sessions setting is "ask each time".
/// Nothing has been stopped by the time this appears, so cancelling really does
/// leave everything as it was.
export function QuitSessionsDialog() {
  const prompt = useQuitPrompt((s) => s.prompt);
  const answer = useQuitPrompt((s) => s.answer);

  return (
    <Dialog
      open={!!prompt}
      onOpenChange={(o) => {
        // Dismissing (X / Escape) is the safe answer: stay open, decide later.
        if (!o) answer("cancel");
      }}
    >
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Keep these terminals running?</DialogTitle>
          <DialogDescription>
            {prompt &&
              `${count(prompt.terminals, "terminal is", "terminals are")} still running in ${count(prompt.sessions, "session", "sessions")}.`}
          </DialogDescription>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">
          Choose to keep them and they will carry on in the background, coming
          back with their screen when you reopen thel. Choose to stop them and
          they will end with this window, along with whatever they were running.
        </p>
        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={() => answer("cancel")}>
            Cancel
          </Button>
          <Button variant="outline" size="sm" onClick={() => answer("stop")}>
            Stop them
          </Button>
          <Button variant="default" size="sm" onClick={() => answer("keep")}>
            Keep running
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
