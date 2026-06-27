import { useEffect, useState } from "react";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useSessions } from "@/store/sessions";
import {
  useProfiles,
  profileNameTaken,
  PROFILE_COLORS,
  type Profile,
} from "@/store/profiles";

// Create a profile, or edit one when `profile` is given. The same fields drive
// both, so the name/color UI is identical in either case.
export function ProfileDialog({
  open,
  onOpenChange,
  profile,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  profile?: Profile;
}) {
  const editing = !!profile;
  const createProfile = useProfiles((s) => s.createProfile);
  const renameProfile = useProfiles((s) => s.renameProfile);
  const setProfileColor = useProfiles((s) => s.setProfileColor);
  const profiles = useProfiles((s) => s.profiles);
  const hasSessions = useSessions((s) => s.sessions.length > 0);
  const [name, setName] = useState("");
  const [color, setColor] = useState<string | undefined>(undefined);
  const [copyCurrent, setCopyCurrent] = useState(false);
  useEffect(() => {
    if (open) {
      setName(profile?.name ?? "");
      setColor(profile?.color);
      setCopyCurrent(false);
    }
  }, [open, profile]);

  const trimmed = name.trim();
  const duplicate =
    trimmed.length > 0 && profileNameTaken(profiles, trimmed, profile?.id);
  // The default profile may be saved blank to reset its name to "Default".
  const allowBlank = editing && profile.id === "default";

  const submit = () => {
    if ((!trimmed && !allowBlank) || duplicate) return;
    if (editing) {
      if (trimmed !== profile.name) void renameProfile(profile.id, trimmed);
      if (color !== profile.color) void setProfileColor(profile.id, color);
    } else {
      void createProfile(trimmed, { color, copyCurrent });
    }
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>{editing ? "Edit profile" : "New profile"}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1.5">
            <label className="text-sm font-medium">Name</label>
            <input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") submit();
              }}
              placeholder="Work, Experiments…"
              className={cn(
                "w-full rounded-md border bg-background px-3 py-1.5 text-sm outline-none focus-visible:ring-1 focus-visible:ring-ring",
                duplicate ? "border-destructive" : "border-border",
              )}
            />
            {duplicate && (
              <p className="text-xs text-destructive">
                A profile named “{trimmed}” already exists.
              </p>
            )}
          </div>

          <div className="space-y-1.5">
            <label className="text-sm font-medium">Accent color</label>
            <ColorPicker value={color} onChange={setColor} />
          </div>

          {!editing && (
            <label
              className={cn(
                "flex items-center gap-2 text-sm",
                !hasSessions && "opacity-50",
              )}
            >
              <Checkbox
                checked={copyCurrent}
                disabled={!hasSessions}
                onCheckedChange={(v) => setCopyCurrent(v === true)}
              />
              Start with a copy of this window's sessions
            </label>
          )}
        </div>

        <div className="mt-2 flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            size="sm"
            onClick={submit}
            disabled={(!trimmed && !allowBlank) || duplicate}
          >
            {editing ? "Save" : "Create profile"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// A "None" swatch plus the preset colors; the selected one gets a ring.
export function ColorPicker({
  value,
  onChange,
}: {
  value: string | undefined;
  onChange: (c: string | undefined) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <button
        type="button"
        onClick={() => onChange(undefined)}
        aria-label="No color"
        className={cn(
          "size-6 rounded-full border border-border text-muted-foreground",
          !value && "ring-2 ring-ring ring-offset-2 ring-offset-background",
        )}
      >
        <X className="mx-auto size-3" />
      </button>
      {PROFILE_COLORS.map((c) => (
        <button
          type="button"
          key={c}
          onClick={() => onChange(c)}
          aria-label={c}
          style={{ backgroundColor: c }}
          className={cn(
            "size-6 rounded-full",
            value === c && "ring-2 ring-ring ring-offset-2 ring-offset-background",
          )}
        />
      ))}
    </div>
  );
}
