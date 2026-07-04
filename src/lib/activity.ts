// Per-terminal output-activity tracking, used to decide when a terminal is
// actively "working" (a command producing output, an agent generating) vs an
// interactive program sitting idle at a prompt (claude/vim waiting for input).
// Kept out of the store: it updates on every output chunk and is read by the
// busy poller, so we avoid render churn.

const lastOutput = new Map<string, number>();
const lastInput = new Map<string, number>();
const lastBusy = new Map<string, number>();
const burstStart = new Map<string, number>();
const lastBurstOut = new Map<string, number>();

// Output chunks closer than this are one continuous burst; a bigger gap starts
// a new one. A spinner repaints many times a second (small gaps); an idle
// prompt repaints sparsely (big gaps).
const BURST_GAP_MS = 1000;
// A burst must be sustained at least this long to count as real work, so a lone
// repaint or a brief shimmer at an idle prompt never registers as "working".
const BURST_MIN_MS = 1500;

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

// Record a visible-output chunk and report whether the terminal is in a
// sustained work burst (rapid output going for at least BURST_MIN_MS): the
// signal that a resident agent is actively generating, as opposed to sitting
// idle at its prompt. Drives the "waiting for input" notification's arming.
export function noteBurst(id: string, now: number = Date.now()): boolean {
  if (now - (lastBurstOut.get(id) ?? 0) >= BURST_GAP_MS) burstStart.set(id, now);
  lastBurstOut.set(id, now);
  return now - (burstStart.get(id) ?? now) >= BURST_MIN_MS;
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
  burstStart.delete(id);
  lastBurstOut.delete(id);
}
