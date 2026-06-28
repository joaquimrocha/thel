import { useEffect, useMemo, useRef, useState } from "react";
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
import { useIconLibrary } from "@/store/icons";
import { openUrl } from "@/lib/pty";

// Validate that `text` is an SVG document and return it trimmed, else null.
// Rendering happens via an <img> data URI (see SvgIcon), so this is a shape
// check, not a security sanitizer.
export function validSvg(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const doc = new DOMParser().parseFromString(trimmed, "image/svg+xml");
  if (doc.querySelector("parsererror")) return null;
  if (doc.documentElement.tagName.toLowerCase() !== "svg") return null;
  return trimmed;
}

/** Add an SVG to the shared icon library. When opened from a session's
 * settings, the new icon is also selected for that session. */
export function AddIconDialog() {
  const open = useUI((s) => s.addIconOpen);
  const setOpen = useUI((s) => s.setAddIconOpen);
  // The session whose settings dialog opened this one (if any), so the new
  // icon is applied to it right away rather than needing a second click in
  // the picker.
  const sessionId = useUI((s) => s.sessionSettings);
  const setSessionIcon = useSessions((s) => s.setSessionIcon);
  const addIcon = useIconLibrary((s) => s.addIcon);
  const [draft, setDraft] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setDraft("");
      setErr(null);
    }
  }, [open]);

  const draftSvg = useMemo(() => validSvg(draft), [draft]);

  const add = () => {
    const v = validSvg(draft);
    if (!v) {
      setErr("That doesn't look like SVG markup.");
      return;
    }
    addIcon(v);
    if (sessionId) setSessionIcon(sessionId, v);
    setOpen(false);
  };

  const onFile = async (file: File | undefined) => {
    if (!file) return;
    const text = await file.text();
    setDraft(text);
    setErr(validSvg(text) ? null : "That file isn't a valid SVG.");
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Add icon</DialogTitle>
          <DialogDescription>
            Add an SVG to your icon library. Get icons from{" "}
            <button
              className="underline hover:text-foreground"
              onClick={() => void openUrl("https://lucide.dev/icons")}
            >
              Lucide
            </button>{" "}
            or{" "}
            <button
              className="underline hover:text-foreground"
              onClick={() => void openUrl("https://icon-sets.iconify.design")}
            >
              Iconify
            </button>
            .
          </DialogDescription>
        </DialogHeader>

        <div className="flex items-start gap-3">
          <div className="flex size-12 shrink-0 items-center justify-center rounded-md border border-border">
            {draftSvg ? (
              <SvgIcon svg={draftSvg} color="#a1a1aa" className="size-6" />
            ) : (
              <span className="text-[10px] text-muted-foreground">SVG</span>
            )}
          </div>
          <div className="min-w-0 flex-1 space-y-2">
            <input
              ref={fileRef}
              type="file"
              accept=".svg,image/svg+xml"
              className="hidden"
              onChange={(e) => {
                void onFile(e.target.files?.[0]);
                e.target.value = ""; // allow re-selecting the same file
              }}
            />
            <Button variant="outline" size="sm" onClick={() => fileRef.current?.click()}>
              Load SVG file…
            </Button>
            <textarea
              autoFocus
              value={draft}
              onChange={(e) => {
                setDraft(e.target.value);
                setErr(null);
              }}
              placeholder="…or paste SVG markup here"
              rows={4}
              className="w-full resize-none rounded-md border border-input bg-transparent px-2 py-1.5 font-mono text-xs outline-none focus:ring-1 focus:ring-ring"
            />
            {err && <p className="text-xs text-destructive">{err}</p>}
          </div>
        </div>

        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button size="sm" onClick={add} disabled={!draft.trim()}>
            Add to library
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
