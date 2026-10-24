import { useCallback, useEffect, useRef, useState, type MouseEvent } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { useUI } from "@/store/ui";
import { appFocused, onFocusChange } from "@/lib/focus";
import { comboMatches, comboToString, type Combo } from "@/lib/keymap";
import { isMac } from "@/lib/platform";

// How long a guarded prompt keeps its confirm button disabled, the delay
// Firefox puts on its install and permission prompts.
const GUARD_MS = 1000;

// Allows a guarded confirm without a pointer, once its guard is over. A
// program writing to a terminal can't press it: only keys the user presses on
// the prompt reach it, and those held back while the guard runs.
const ALLOW_KEYS: Combo = isMac ? { code: "Enter", meta: true } : { code: "Enter", ctrl: true, shift: true };

export function ConfirmDialog() {
  const confirm = useUI((s) => s.confirm);
  const clearConfirm = useUI((s) => s.clearConfirm);
  const cancel = () => {
    confirm?.onCancel?.();
    clearConfirm();
  };
  const [checked, setChecked] = useState(false);
  const [armedFor, setArmedFor] = useState<typeof confirm>(null);
  // A guarded prompt's text was scrolled to its end, so nothing it asks for
  // hid below the fold.
  const [readFor, setReadFor] = useState<typeof confirm>(null);
  const read = !confirm?.guarded || !confirm.description || readFor === confirm;
  const settled = !confirm?.guarded || armedFor === confirm;
  const armed = settled && read;
  // A guarded confirm's Allow and checkbox take a pointer, or ALLOW_KEYS for
  // Allow: keys typed for the terminal can't reach them by Tab, nor press
  // them once focused (a click from a key has no pointer, so detail is 0).
  const pointerOnly = confirm?.guarded
    ? {
        tabIndex: -1,
        onClickCapture: (e: MouseEvent) => {
          if (e.detail === 0) {
            e.preventDefault();
            e.stopPropagation();
          }
        },
      }
    : {};
  const accept = () => {
    confirm?.onConfirm(checked);
    clearConfirm();
  };
  const contentRef = useRef<HTMLDivElement>(null);
  const description = useRef<HTMLParagraphElement | null>(null);
  const markRead = () => {
    const d = description.current;
    if (d && d.scrollHeight - d.scrollTop - d.clientHeight <= 1) setReadFor(confirm);
  };
  // Called again for each new confirm, once its text is laid out, so text
  // that fits counts as read at once.
  const descriptionRef = useCallback(
    (d: HTMLParagraphElement | null) => {
      description.current = d;
      // The node stays when a queued confirm replaces the shown one, and so
      // would its scroll, which could count as read text never seen.
      if (d) d.scrollTop = 0;
      markRead();
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [confirm],
  );

  useEffect(() => {
    // Each new confirm starts from its own checkbox default.
    setChecked(confirm?.checkbox?.defaultChecked ?? false);
    if (!confirm?.guarded) return;
    // Focus on the dialog itself, where no key answers it. Also when a queued
    // request replaces the one shown: the dialog stays open then, and focus
    // would stay on the button that answered the last one.
    contentRef.current?.focus();
    // The guard starts over whenever the window comes back to the front, so
    // the click that brings it back can't land on a confirm that armed while
    // nobody was looking.
    let t: ReturnType<typeof setTimeout> | undefined;
    let isArmed = false;
    const rearm = () => {
      clearTimeout(t);
      isArmed = false;
      setArmedFor(null);
      if (appFocused() && !document.hidden)
        t = setTimeout(() => {
          isArmed = true;
          setArmedFor(confirm);
        }, GUARD_MS);
    };
    // Keys typed for the terminal would move focus to a button and press it,
    // so until typing stops for the guard's length, no key reaches the dialog.
    const hold = (e: KeyboardEvent) => {
      if (isArmed) return;
      e.preventDefault();
      e.stopPropagation();
      rearm();
    };
    rearm();
    // Tauri's focus events, which WebKitGTK's DOM ones can miss. Losing focus
    // matters most: it disarms before the click that brings the window back.
    const offFocus = onFocusChange(rearm);
    window.addEventListener("keydown", hold, true);
    document.addEventListener("visibilitychange", rearm);
    return () => {
      clearTimeout(t);
      offFocus();
      window.removeEventListener("keydown", hold, true);
      document.removeEventListener("visibilitychange", rearm);
    };
  }, [confirm]);

  return (
    <Dialog
      open={!!confirm}
      onOpenChange={(open) => {
        // Escape, a click elsewhere and the close button answer too, so the
        // guard holds them back like both buttons.
        if (!open && settled) cancel();
      }}
    >
      <DialogContent
        ref={contentRef}
        className="max-w-sm"
        onOpenAutoFocus={(e) => {
          if (!confirm?.guarded) return;
          e.preventDefault();
          contentRef.current?.focus();
        }}
        onKeyDown={(e) => {
          if (!confirm?.guarded || !armed || !comboMatches(e.nativeEvent, ALLOW_KEYS)) return;
          e.preventDefault();
          accept();
        }}
      >
        <DialogHeader>
          <DialogTitle>{confirm?.title}</DialogTitle>
          {confirm?.description && (
            <DialogDescription
              ref={descriptionRef}
              onScroll={confirm.guarded ? markRead : undefined}
              // So a keyboard can scroll it to its end.
              tabIndex={confirm.guarded ? 0 : undefined}
              // anywhere, not break-word: a long word must also wrap when the
              // layout sizes the text by its longest word, or it pushes the
              // rest of the text and the buttons out of view.
              className="max-h-60 overflow-y-auto [overflow-wrap:anywhere]"
            >
              {confirm.description}
            </DialogDescription>
          )}
          {!read && (
            <p className="text-xs text-muted-foreground">Scroll to the end to allow it.</p>
          )}
          {confirm?.guarded && !confirm.okOnly && (
            <p className="text-xs text-muted-foreground">
              Or press{" "}
              <kbd className="rounded border border-border bg-muted px-1 font-mono text-[10px]">
                {comboToString(ALLOW_KEYS)}
              </kbd>{" "}
              to allow it.
            </p>
          )}
        </DialogHeader>
        {confirm?.checkbox && (
          <div className="space-y-1">
            <label className="flex items-center gap-2 text-sm">
              <Checkbox
                {...pointerOnly}
                checked={checked}
                disabled={!settled}
                onCheckedChange={(v) => setChecked(v === true)}
              />
              {confirm.checkbox.label}
            </label>
            {confirm.checkbox.warning && checked && (
              <p className="pl-6 text-xs text-destructive">
                {confirm.checkbox.warning}
              </p>
            )}
          </div>
        )}
        <DialogFooter>
          {!confirm?.okOnly && (
            <Button variant="ghost" disabled={!settled} onClick={cancel}>
              {confirm?.cancelLabel ?? "Cancel"}
            </Button>
          )}
          <Button
            variant={confirm?.okOnly ? "default" : "destructive"}
            disabled={!armed}
            {...pointerOnly}
            aria-keyshortcuts={confirm?.guarded ? (isMac ? "Meta+Enter" : "Control+Shift+Enter") : undefined}
            onClick={accept}
          >
            {confirm?.confirmLabel ?? (confirm?.okOnly ? "OK" : "Confirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
