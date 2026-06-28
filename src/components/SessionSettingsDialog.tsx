import { useEffect, useState } from "react";
import { Plus, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { SvgIcon } from "./SvgIcon";
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
import { useIconLibrary, DEFAULT_ICONS } from "@/store/icons";
import { sessionNameForDir } from "@/lib/launch";

export function SessionSettingsDialog() {
  const sessionId = useUI((s) => s.sessionSettings);
  const close = useUI((s) => s.closeSessionSettings);
  const openAddIcon = useUI((s) => s.setAddIconOpen);
  const setSessionIcon = useSessions((s) => s.setSessionIcon);
  const renameSession = useSessions((s) => s.renameSession);
  const session = useSessions((s) =>
    s.sessions.find((x) => x.id === sessionId),
  );
  const icons = useIconLibrary((s) => s.icons);
  const removeIcon = useIconLibrary((s) => s.removeIcon);

  const [name, setName] = useState("");

  useEffect(() => {
    if (session) setName(session.name);
    // Only re-sync when the target session changes, not on every keystroke.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  const fallback = session?.cwd ? sessionNameForDir(session.cwd) : undefined;
  const commitName = () => {
    if (!session) return;
    const next = name.trim();
    if (next && next !== session.name) renameSession(session.id, next);
    // Cleared: revert to the folder-derived default rather than keep blank.
    else if (!next && fallback && fallback !== session.name)
      renameSession(session.id, fallback);
  };

  const done = () => {
    commitName();
    close();
  };

  return (
    <Dialog
      open={!!sessionId}
      onOpenChange={(o) => {
        if (!o) done();
      }}
    >
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Session Settings</DialogTitle>
          <DialogDescription>
            Rename the session and give it a sidebar icon.
          </DialogDescription>
        </DialogHeader>

        <label className="text-xs font-medium text-muted-foreground">Name</label>
        <input
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          onBlur={commitName}
          onKeyDown={(e) => {
            if (e.key === "Enter") done();
          }}
          placeholder={fallback ?? "Session name"}
          className="w-full rounded-md border border-input bg-transparent px-2 py-1.5 text-sm outline-none focus:ring-1 focus:ring-ring"
        />

        <label className="mt-1 text-xs font-medium text-muted-foreground">Icon</label>
        <div className="flex flex-wrap gap-1.5">
          {icons.map((svg) => (
            <div key={svg} className="group relative">
              <button
                aria-label="Use icon"
                onClick={() => sessionId && setSessionIcon(sessionId, svg)}
                className={cn(
                  "flex size-8 items-center justify-center rounded-md border border-border hover:bg-secondary",
                  session?.icon === svg && "ring-1 ring-ring bg-secondary",
                )}
              >
                <SvgIcon svg={svg} color="#a1a1aa" className="size-4" />
              </button>
              {/* Only user-added icons can be removed from the library. */}
              {!DEFAULT_ICONS.includes(svg) && (
                <button
                  aria-label="Delete icon"
                  onClick={() => removeIcon(svg)}
                  className="absolute -right-1 -top-1 flex size-3.5 items-center justify-center rounded-full bg-secondary text-muted-foreground opacity-0 ring-1 ring-border hover:text-destructive group-hover:opacity-100"
                >
                  <X className="size-2.5" />
                </button>
              )}
            </div>
          ))}
          <button
            aria-label="Add icon"
            onClick={() => openAddIcon(true)}
            className="flex size-8 items-center justify-center rounded-md border border-dashed border-border text-muted-foreground hover:bg-secondary hover:text-foreground"
          >
            <Plus className="size-4" />
          </button>
        </div>

        <DialogFooter>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => sessionId && setSessionIcon(sessionId, undefined)}
            disabled={!session?.icon}
          >
            Remove icon
          </Button>
          <Button size="sm" onClick={done}>
            Done
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
