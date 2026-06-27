import { Plus, Trash2, Star } from "lucide-react";
import { cn, inputClass } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { useUI } from "@/store/ui";
import { useLaunchers } from "@/store/launchers";
import { ActionTooltip } from "./ActionTooltip";

export function LaunchersDialog() {
  const open = useUI((s) => s.launchersOpen);
  const setOpen = useUI((s) => s.setLaunchersOpen);
  const launchers = useLaunchers((s) => s.launchers);
  const defaultLauncherId = useLaunchers((s) => s.defaultLauncherId);
  const add = useLaunchers((s) => s.add);
  const update = useLaunchers((s) => s.update);
  const remove = useLaunchers((s) => s.remove);
  const setDefault = useLaunchers((s) => s.setDefault);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="max-h-[85vh] max-w-xl">
        <DialogHeader>
          <DialogTitle>Launchers</DialogTitle>
          <DialogDescription>
            A launcher opens a terminal that runs a command in the session's
            working directory (empty command = a plain shell). Star a launcher to
            use it for the + button and new sessions; with none starred they open
            a plain default terminal.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-2">
          {/* Scrolls internally once there are more launchers than fit. */}
          <div className="max-h-[55vh] space-y-2 overflow-y-auto">
          {launchers.map((l) => {
            const isDefault = l.id === defaultLauncherId;
            return (
              <div key={l.id} className="flex items-start gap-2">
                <ActionTooltip
                  label={isDefault ? "Default launcher (click to unset)" : "Set as default"}
                >
                  <button
                    onClick={() => setDefault(l.id)}
                    aria-label={isDefault ? "Default launcher" : "Set as default"}
                    className="mt-1.5 shrink-0"
                  >
                    <Star
                      className={cn(
                        "size-4",
                        isDefault
                          ? "fill-amber-400 text-amber-400"
                          : "text-muted-foreground/40 hover:text-muted-foreground",
                      )}
                    />
                  </button>
                </ActionTooltip>
                <div className="grid flex-1 grid-cols-[1fr_2fr] gap-2">
                  <input
                    value={l.name}
                    onChange={(e) => update(l.id, { name: e.target.value })}
                    placeholder="Name"
                    spellCheck={false}
                    className={inputClass}
                  />
                  <input
                    value={l.command}
                    onChange={(e) => update(l.id, { command: e.target.value })}
                    placeholder="Command (empty = shell)"
                    spellCheck={false}
                    className={`${inputClass} font-mono text-xs`}
                  />
                </div>
                <ActionTooltip label="Delete launcher">
                  <Button
                    variant="ghost"
                    size="icon"
                    className="shrink-0"
                    onClick={() => remove(l.id)}
                    aria-label="Delete launcher"
                  >
                    <Trash2 className="size-4" />
                  </Button>
                </ActionTooltip>
              </div>
            );
          })}
          </div>

          <Button variant="outline" size="sm" onClick={add}>
            <Plus className="size-4" /> Add launcher
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
