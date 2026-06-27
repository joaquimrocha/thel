import { useState } from "react";
import { Plus, Pencil, Trash2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { useProfiles, type Profile } from "@/store/profiles";
import { ProfileDialog } from "@/components/ProfileDialog";

export function ProfilesSettings() {
  const profiles = useProfiles((s) => s.profiles);
  const currentId = useProfiles((s) => s.currentId);
  const removeProfile = useProfiles((s) => s.removeProfile);
  // `editing` undefined = the dialog is in create mode.
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<Profile | undefined>(undefined);

  const open = (profile?: Profile) => {
    setEditing(profile);
    setDialogOpen(true);
  };

  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">
        Each profile opens in its own window. Edits here apply to other open
        windows after they're restarted.
      </p>
      <div className="space-y-2">
        {profiles.map((p) => {
          const isDefault = p.id === "default";
          const isCurrent = p.id === currentId;
          return (
            <div
              key={p.id}
              data-testid="profile-row"
              className="flex items-center gap-2 rounded-md border border-border p-2"
            >
              <span
                className="size-4 shrink-0 rounded-full border border-border"
                style={p.color ? { backgroundColor: p.color } : undefined}
              />
              <span className="min-w-0 flex-1 truncate text-sm">{p.name}</span>
              {isCurrent && (
                <span className="shrink-0 text-xs text-muted-foreground">
                  current
                </span>
              )}
              <button
                type="button"
                aria-label="Edit profile"
                onClick={() => open(p)}
                className="shrink-0 rounded p-1 text-muted-foreground hover:bg-secondary disabled:pointer-events-none disabled:opacity-30"
              >
                <Pencil className="size-3.5" />
              </button>
              <button
                type="button"
                aria-label="Delete profile"
                disabled={isDefault || isCurrent}
                onClick={() => void removeProfile(p.id)}
                className={cn(
                  "shrink-0 rounded p-1 text-muted-foreground",
                  "hover:bg-destructive hover:text-destructive-foreground",
                  "disabled:pointer-events-none disabled:opacity-30",
                )}
              >
                <Trash2 className="size-3.5" />
              </button>
            </div>
          );
        })}
      </div>
      <Button variant="outline" size="sm" onClick={() => open()}>
        <Plus className="size-4" /> New profile
      </Button>
      <ProfileDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        profile={editing}
      />
    </div>
  );
}
