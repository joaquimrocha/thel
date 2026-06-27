// Per-terminal output-activity tracking, used to decide when a terminal is
// actively "working" (a command producing output, an agent generating) vs an
// interactive program sitting idle at a prompt (claude/vim waiting for input).
// Kept out of the store: it updates on every output chunk and is read by the
// busy poller, so we avoid render churn.

const lastOutput = new Map<string, number>();
const lastInput = new Map<string, number>();
const lastBusy = new Map<string, number>();

// Output arriving within this window of the user's own keystroke is treated as
// an echo or redraw (typing at a shell prompt, cursor movement in an editor),
// not real work, so it doesn't trip the working animation.
const ECHO_MS = 250;

export function markInput(id: string) {
  lastInput.set(id, Date.now());
}

export function markOutput(id: string) {
  const now = Date.now();
  if (now - (lastInput.get(id) ?? 0) < ECHO_MS) return; // user-driven echo
  lastOutput.set(id, now);
}

/** Milliseconds since the last work-output, or Infinity if none seen. */
export function outputAgeMs(id: string): number {
  const t = lastOutput.get(id);
  return t == null ? Infinity : Date.now() - t;
}

// Record that a foreground command was running. Used to tell a terminal that
// actually ran something (and is now done) from an idle shell that merely got a
// redraw; only the former should signal "finished".
export function markBusy(id: string) {
  lastBusy.set(id, Date.now());
}

/** Milliseconds since this terminal last had a foreground command, or Infinity. */
export function busyAgeMs(id: string): number {
  const t = lastBusy.get(id);
  return t == null ? Infinity : Date.now() - t;
}

export function clearActivity(id: string) {
  lastOutput.delete(id);
  lastInput.delete(id);
  lastBusy.delete(id);
}
