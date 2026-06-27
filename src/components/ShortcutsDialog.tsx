import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogPanel,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { useUI } from "@/store/ui";
import { SHORTCUTS, STATIC_SHORTCUTS, comboToString } from "@/lib/keymap";
import { isMac } from "@/lib/platform";
import { useKeybindings, effectiveCombo } from "@/store/keybindings";

export function ShortcutsDialog() {
  const open = useUI((s) => s.helpOpen);
  const setOpen = useUI((s) => s.setHelpOpen);
  const overrides = useKeybindings((s) => s.overrides);
  const recordingId = useKeybindings((s) => s.recordingId);
  const setRecording = useKeybindings((s) => s.setRecording);
  const resetBinding = useKeybindings((s) => s.resetBinding);
  const resetAll = useKeybindings((s) => s.resetAll);
  const requestConfirm = useUI((s) => s.requestConfirm);

  const confirmResetAll = () =>
    requestConfirm({
      title: "Reset all shortcuts?",
      description: "This restores every keyboard shortcut to its default.",
      confirmLabel: "Reset all",
      onConfirm: resetAll,
    });

  // Detect duplicate bindings to warn about conflicts.
  const counts: Record<string, number> = {};
  for (const s of SHORTCUTS) {
    const c = effectiveCombo(s.id);
    if (c) counts[comboToString(c)] = (counts[comboToString(c)] ?? 0) + 1;
  }

  return (
    <Dialog
      open={open}
      modal={false}
      onOpenChange={(next) => {
        if (!next) setRecording(null);
        setOpen(next);
      }}
    >
      <DialogPanel
        onInteractOutside={(e) => e.preventDefault()}
        onOpenAutoFocus={(e) => e.preventDefault()}
      >
        <div className="border-b border-border px-4 py-3 pr-10">
          <DialogTitle>Keyboard shortcuts</DialogTitle>
          <DialogDescription>
            Click a shortcut to rebind it, then press the new keys (must include
            {isMac ? " ⌘, ⌃, or ⌥" : " Ctrl or Alt"}). Esc cancels.
          </DialogDescription>
        </div>

        <div className="flex-1 overflow-y-auto px-2 py-2">
          {SHORTCUTS.map((s) => {
            const combo = effectiveCombo(s.id)!;
            const str = comboToString(combo);
            const recording = recordingId === s.id;
            const conflict = counts[str] > 1;
            const overridden = !!overrides[s.id];
            return (
              <div
                key={s.id}
                className="flex items-center gap-2 rounded-md px-2 py-1 text-sm hover:bg-secondary/40"
              >
                <span className="flex-1 truncate">{s.description}</span>
                {conflict && !recording && (
                  <span className="shrink-0 text-xs text-amber-500">conflict</span>
                )}
                {overridden && !recording && (
                  <button
                    onClick={() => resetBinding(s.id)}
                    className="shrink-0 text-xs text-muted-foreground hover:text-foreground"
                    title="Reset to default"
                  >
                    reset
                  </button>
                )}
                <button
                  onClick={() => setRecording(recording ? null : s.id)}
                  className={
                    "min-w-20 shrink-0 rounded border px-2 py-1 text-center font-mono text-xs " +
                    (recording
                      ? "border-ring text-foreground"
                      : "border-border bg-muted text-foreground hover:bg-secondary")
                  }
                >
                  {recording ? "Press keys…" : str}
                </button>
              </div>
            );
          })}

          <p className="mt-3 border-t border-border px-2 pt-3 pb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Fixed
          </p>
          {STATIC_SHORTCUTS.map((s) => (
            <div
              key={s.description}
              className="flex items-center justify-between gap-4 px-2 py-1 text-sm"
            >
              <span className="text-muted-foreground">{s.description}</span>
              <kbd className="shrink-0 rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-xs">
                {s.keys}
              </kbd>
            </div>
          ))}
        </div>

        <div className="flex justify-end border-t border-border px-3 py-2">
          <Button variant="ghost" size="sm" onClick={confirmResetAll}>
            Reset all
          </Button>
        </div>
      </DialogPanel>
    </Dialog>
  );
}
