import { useState } from "react";
import { Plus, Trash2, Star } from "lucide-react";
import { cn, inputClass } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { useUI } from "@/store/ui";
import { useLaunchers, type Launcher } from "@/store/launchers";
import { ActionTooltip } from "./ActionTooltip";

export function LaunchersDialog() {
  const open = useUI((s) => s.launchersOpen);
  const setOpen = useUI((s) => s.setLaunchersOpen);
  const launchers = useLaunchers((s) => s.launchers);
  const defaultLauncherId = useLaunchers((s) => s.defaultLauncherId);
  const remove = useLaunchers((s) => s.remove);
  const setDefault = useLaunchers((s) => s.setDefault);
  // "new" opens the editor empty; a Launcher opens it prefilled.
  const [editing, setEditing] = useState<Launcher | "new" | null>(null);

  return (
    <>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[85vh] max-w-xl">
          <DialogHeader>
            <DialogTitle>Launchers</DialogTitle>
            <DialogDescription>
              A launcher opens a terminal that runs a command in the session's
              working directory. Star a launcher to use it for the + button and
              new sessions; with none starred they open a plain shell. Click a
              launcher to edit it.
            </DialogDescription>
          </DialogHeader>

          {/* DialogContent is a grid; min-w-0 stops this grid item from
              sizing to a long command line and overflowing the dialog, so
              the row-level truncation can do its job. */}
          <div className="min-w-0 space-y-2">
            {/* Scrolls internally once there are more launchers than fit. */}
            <div className="max-h-[55vh] space-y-1 overflow-y-auto">
              {launchers.map((l) => {
                const isDefault = l.id === defaultLauncherId;
                return (
                  <div key={l.id} className="flex items-center gap-2">
                    <ActionTooltip
                      label={
                        isDefault
                          ? "Default launcher (click to unset)"
                          : "Set as default"
                      }
                    >
                      <button
                        onClick={() => setDefault(l.id)}
                        aria-label={
                          isDefault ? "Default launcher" : "Set as default"
                        }
                        className="shrink-0"
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
                    <button
                      onClick={() => setEditing(l)}
                      className="flex min-w-0 flex-1 items-baseline gap-3 rounded-md px-2 py-1.5 text-left hover:bg-secondary"
                    >
                      <span className="min-w-0 truncate text-sm">{l.name}</span>
                    </button>
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

            <Button variant="outline" size="sm" onClick={() => setEditing("new")}>
              <Plus className="size-4" /> Create launcher…
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <LauncherEditDialog
        // Remount per target so the fields reset without effect bookkeeping.
        key={editing === "new" ? "new" : editing?.id ?? "closed"}
        editing={editing}
        onClose={() => setEditing(null)}
      />
    </>
  );
}

function LauncherEditDialog({
  editing,
  onClose,
}: {
  editing: Launcher | "new" | null;
  onClose: () => void;
}) {
  const add = useLaunchers((s) => s.add);
  const update = useLaunchers((s) => s.update);
  const launchers = useLaunchers((s) => s.launchers);
  const isNew = editing === "new";
  const base = isNew ? null : editing;
  const [name, setName] = useState(base?.name ?? "");
  const [command, setCommand] = useState(base?.command ?? "");
  const [shell, setShell] = useState(base?.shell ?? true);

  // Names identify launchers in the palette and tab titles, so two launchers
  // with the same name would be indistinguishable there.
  const nameClash = launchers.some(
    (l) =>
      l.id !== base?.id &&
      l.name.trim().toLowerCase() === name.trim().toLowerCase(),
  );

  const save = () => {
    const n = name.trim();
    if (!n || nameClash) return;
    const patch = { name: n, command: command.trim(), shell };
    if (base) update(base.id, patch);
    else add(patch);
    onClose();
  };
  const submitOnEnter = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") save();
  };

  return (
    <Dialog
      open={!!editing}
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
    >
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{isNew ? "Create Launcher" : "Edit Launcher"}</DialogTitle>
          <DialogDescription>
            Runs a command in a new terminal, in the session's working
            directory. Leave the command empty for a plain shell.
          </DialogDescription>
        </DialogHeader>

        <label className="text-xs font-medium text-muted-foreground">Name</label>
        <input
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={submitOnEnter}
          placeholder="e.g. Claude"
          spellCheck={false}
          className={inputClass}
        />
        {nameClash && (
          <p className="text-xs text-destructive">
            A launcher with this name already exists.
          </p>
        )}

        <label className="mt-1 text-xs font-medium text-muted-foreground">
          Command
        </label>
        <input
          value={command}
          onChange={(e) => setCommand(e.target.value)}
          onKeyDown={submitOnEnter}
          placeholder="claude --continue (empty = shell)"
          spellCheck={false}
          className={`${inputClass} font-mono text-xs`}
        />
        <p className="text-xs text-muted-foreground">
          __SESSION_DIR__, __SESSION_ID__ and __SESSION_NAME__ in the command
          are replaced with the session's directory, id and name when the
          terminal starts.
        </p>

        <div className="mt-1 flex items-center justify-between gap-4">
          <div>
            <p className="text-sm">Run in a login shell</p>
            <p className="text-xs text-muted-foreground">
              Uses your shell, so PATH and profile apply. Turn off to run the
              command directly.
            </p>
          </div>
          <Switch checked={shell} onCheckedChange={setShell} />
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={save} disabled={!name.trim() || nameClash}>
            {isNew ? "Create" : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
