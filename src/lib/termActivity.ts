// The notification state machine shared by a mounted terminal pane (driving a
// live xterm) and the background daemon listener (driving the raw output
// stream). Both watch the same signals to decide when a terminal wants your
// attention: a bell that's followed by quiet, an explicit OSC notification, a
// foreground command that just finished. This owns the timers and gates common
// to both; the "waiting for input" heuristic stays with each caller because it
// reads different signals (a mounted pane inspects screen text; the listener
// only has output bursts).

import { markOutput, markBusy, busyAgeMs, outputAgeMs } from "@/lib/activity";

// A foreground command animates the dot only if it produced output this
// recently; keeps a quiet resident program (claude, vim) from pulsing forever.
const ACTIVE_WINDOW_MS = 1000;
// Silence required after a bell before notifying.
const BELL_QUIET_MS = 1000;
// Output continuing this long after a bell means it rang mid-action (agent
// still working), not on completion; the pending notification is dropped.
const BELL_WINDOW_MS = 4000;
// After a sustained work burst, this much silence while still foreground means
// the turn ended and the terminal is waiting for you. Read by each caller's
// waiting heuristic, so exported.
export const AGENT_QUIET_MS = 3000;
// A terminal that goes quiet after output is "finished" once silent this long.
const IDLE_QUIET_MS = 1000;
// The initial output burst is treated as reattach replay until it pauses for
// this long (or the fallback fires), so a BEL in the replay isn't a live bell.
const SETTLE_MS = 250;
const SETTLE_FALLBACK_MS = 3000;
// A "finished" alert only fires if a foreground command actually ran this
// recently; an idle shell that merely got a redraw was never busy.
const BUSY_RECENCY_MS = 8000;
// A resize (SIGWINCH) makes programs redraw; ignore that as activity briefly.
const RESIZE_QUIET_MS = 1000;

export interface TerminalActivityOptions {
  id: string;
  // Whether the user is currently attending this terminal (visible + app
  // focused). Activity on a watched terminal never notifies. The background
  // listener passes () => false: a detached tab is never watched.
  watched: () => boolean;
  onNotify: (kind: "bell" | "idle" | "message", text?: string) => void;
  onWorking: (working: boolean) => void;
}

export interface TerminalActivity {
  // Call with each output chunk's visibility BEFORE writing it to the terminal,
  // so a bell inside this chunk (armed during the write) isn't judged by its
  // own trailing text.
  absorbOutputBeforeWrite(visible: boolean): void;
  // Call after the chunk is written/parsed. Records work output and arms the
  // "finished" timer; a control-only chunk (visible=false) is ignored.
  noteOutput(visible: boolean): void;
  // A bell rang. Deferred: only a bell followed by quiet is a real request.
  noteBell(): void;
  // An explicit OSC notification with its own message; fires at once.
  noteMessage(text: string): void;
  // The daemon's pushed foreground-busy state.
  noteBusy(busy: boolean): void;
  // A resize happened (pane only): suppress the redraw it provokes.
  noteResize(): void;
  // Cancel a pending "finished" alert (pane only, on becoming visible).
  cancelIdle(): void;
  isBusy(): boolean;
  isReplaySettled(): boolean;
  isBellPending(): boolean;
  dispose(): void;
}

export function createTerminalActivity(
  opts: TerminalActivityOptions,
): TerminalActivity {
  const { id, watched, onNotify, onWorking } = opts;

  let closed = false;
  let replaySettled = false;
  let bellPending = false;
  let bellAt = 0;
  let busy = false;
  let working = false;
  let resizeQuietUntil = 0;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let settleTimer: ReturnType<typeof setTimeout> | undefined;
  let bellTimer: ReturnType<typeof setTimeout> | undefined;

  // Fallback: if a terminal replays nothing (empty snapshot), no output ever
  // arrives to settle the burst, so arm the heuristics anyway after a beat.
  const settleFallback = setTimeout(() => {
    replaySettled = true;
  }, SETTLE_FALLBACK_MS);

  // (Re)start the quiet timer behind a pending bell; fires the notification
  // once the terminal has stayed silent for BELL_QUIET_MS.
  const armBellTimer = () => {
    clearTimeout(bellTimer);
    bellTimer = setTimeout(() => {
      bellPending = false;
      if (closed || watched()) return;
      onNotify("bell");
    }, BELL_QUIET_MS);
  };

  return {
    absorbOutputBeforeWrite(visible) {
      // Output shortly after a bell is the program repainting its prompt
      // (claude rings BEL, then renders): postpone until quiet. Output still
      // flowing past the window means the bell rang mid-action, so drop it.
      if (visible && bellPending) {
        if (Date.now() - bellAt > BELL_WINDOW_MS) {
          bellPending = false;
          clearTimeout(bellTimer);
        } else {
          armBellTimer();
        }
      }
    },

    noteOutput(visible) {
      // Control-only chunks (e.g. a cursor-visibility broadcast when another
      // client attaches) aren't activity and must not trip the heuristics.
      if (!visible) return;
      // Treat the initial output burst as reattach replay: refresh the settle
      // timer while it flows, and mark it settled once it pauses.
      if (!replaySettled) {
        clearTimeout(settleTimer);
        settleTimer = setTimeout(() => {
          replaySettled = true;
        }, SETTLE_MS);
      } else {
        // Record live output (unless it's an echo of the user's own typing) so
        // the working dot animates. Replayed screen content is deliberately NOT
        // counted: the daemon replays the screen on every reattach, and doing so
        // would light the dot for a resident agent (e.g. an idle Claude) on
        // every session switch.
        markOutput(id);
      }
      // Flag the terminal once it goes quiet after output. Skip a
      // resize-triggered redraw, and skip while watched (nothing to alert).
      if (!watched() && Date.now() >= resizeQuietUntil) {
        clearTimeout(idleTimer);
        idleTimer = setTimeout(() => {
          if (closed || watched()) return;
          // Only a real return to the shell prompt counts as "finished". A
          // still-foreground process (an agent thinking, a dev server, an
          // editor) isn't done; resident agents signal turn-completion via the
          // bell, not this heuristic.
          if (busy) return;
          // Only if a foreground command actually ran and just ended; an idle
          // shell that merely got a redraw was never busy.
          if (busyAgeMs(id) > BUSY_RECENCY_MS) return;
          onNotify("idle");
        }, IDLE_QUIET_MS);
      }
    },

    noteBell() {
      // Skip when watched, or when the BEL is just a byte in the reattach
      // replay burst (historical, not a live request).
      if (watched() || !replaySettled) return;
      bellPending = true;
      bellAt = Date.now();
      armBellTimer();
    },

    noteMessage(text) {
      const t = text.trim();
      // The replay gate keeps a reattach snapshot from re-notifying with stale
      // messages; watched terminals don't notify.
      if (!replaySettled || !t || watched()) return;
      onNotify("message", t);
    },

    noteBusy(next) {
      busy = next;
      // The heartbeat keeps busyAgeMs fresh, so a long quiet command is still
      // known to have been busy when it finishes.
      if (next) markBusy(id);
      // Animate only while a foreground command is actively producing output.
      const w = next && outputAgeMs(id) < ACTIVE_WINDOW_MS;
      if (working !== w) {
        working = w;
        onWorking(w);
      }
    },

    noteResize() {
      resizeQuietUntil = Date.now() + RESIZE_QUIET_MS;
      clearTimeout(idleTimer);
    },

    cancelIdle() {
      clearTimeout(idleTimer);
    },

    isBusy: () => busy,
    isReplaySettled: () => replaySettled,
    isBellPending: () => bellPending,

    dispose() {
      closed = true;
      clearTimeout(idleTimer);
      clearTimeout(settleTimer);
      clearTimeout(settleFallback);
      clearTimeout(bellTimer);
    },
  };
}
