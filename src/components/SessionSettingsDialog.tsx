import { useEffect, useState } from "react";
import { Ban, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { SvgIcon } from "./SvgIcon";
import { ActionTooltip } from "./ActionTooltip";
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
import { useProfiles } from "@/store/profiles";
import { sessionNameForDir } from "@/lib/launch";
import { moveSessionToProfile } from "@/lib/persistence";

export function SessionSettingsDialog() {
  const sessionId = useUI((s) => s.sessionSettings);
  const close = useUI((s) => s.closeSessionSettings);
  const openAddIcon = useUI((s) => s.setAddIconOpen);
  const setSessionIcon = useSessions((s) => s.setSessionIcon);
  const clearIcon = useSessions((s) => s.clearIcon);
  const renameSession = useSessions((s) => s.renameSession);
  const session = useSessions((s) =>
    s.sessions.find((x) => x.id === sessionId),
  );
  const icons = useIconLibrary((s) => s.icons);
  const removeIcon = useIconLibrary((s) => s.removeIcon);
  const profiles = useProfiles((s) => s.profiles);
  const currentProfileId = useProfiles((s) => s.currentId);
  const otherProfiles = profiles.filter((p) => p.id !== currentProfileId);

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
            Rename the session, give it a sidebar icon, or move it to another profile.
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
          {/* First slot clears the association: the session shows the default dot. */}
          <ActionTooltip label="No icon">
            <button
              aria-label="No icon"
              onClick={() => sessionId && setSessionIcon(sessionId, undefined)}
              className={cn(
                "flex size-8 items-center justify-center rounded-md border border-border text-muted-foreground hover:bg-secondary",
                !session?.icon && "ring-1 ring-ring bg-secondary",
              )}
            >
              <Ban className="size-4" />
            </button>
          </ActionTooltip>
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
              {/* Only user-added icons can be deleted; doing so reverts any
                  session still using it to the default. */}
              {!DEFAULT_ICONS.includes(svg) && (
                <button
                  aria-label="Delete icon"
                  onClick={() => {
                    removeIcon(svg);
                    clearIcon(svg);
                  }}
                  className="absolute -right-1 -top-1 flex size-3.5 items-center justify-center rounded-full bg-secondary text-muted-foreground opacity-0 ring-1 ring-border hover:text-destructive group-hover:opacity-100"
                >
                  <Trash2 className="size-2.5" />
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

        {otherProfiles.length > 0 && (
          <>
            <label className="mt-1 text-xs font-medium text-muted-foreground">
              Move to profile
            </label>
            <div className="flex flex-wrap gap-1.5">
              {otherProfiles.map((p) => (
                <Button
                  key={p.id}
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    if (!sessionId) return;
                    commitName();
                    close();
                    const moving = useSessions
                      .getState()
                      .sessions.find((x) => x.id === sessionId)?.name;
                    moveSessionToProfile(sessionId, p.id).then(
                      () => toast(`Moved ${moving} to ${p.name}`),
                      (e) => toast.error(`Could not move the session to ${p.name}: ${e}`),
                    );
                  }}
                >
                  {p.color && (
                    <span
                      className="size-2 rounded-full"
                      style={{ backgroundColor: p.color }}
                    />
                  )}
                  {p.name}
                </Button>
              ))}
            </div>
          </>
        )}

        <DialogFooter>
          <Button size="sm" onClick={done}>
            Done
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
