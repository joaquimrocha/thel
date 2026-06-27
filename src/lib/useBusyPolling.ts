import { useEffect } from "react";
import { useSessions, sessionTerminals } from "@/store/sessions";
import { terminalStatuses } from "./pty";
import { outputAgeMs, markBusy } from "./activity";
import { appFocused } from "./focus";

// How often to ask the backend whether each live terminal has foreground work.
// Fast enough to feel live, slow enough to stay cheap with many terminals.
const POLL_MS = 600;

// A terminal counts as working only if it produced output this recently. This
// is what stops a long-lived interactive program (claude, vim) from animating
// forever while it just sits at a prompt: it's a foreground process, but quiet.
const ACTIVE_WINDOW_MS = 1000;

/**
 * One batched poll over every started, not-exited terminal that does two jobs:
 *  - closes a terminal whose program exited (the PTY sees no EOF, so
 *    a dead pane in the status is the only exit signal);
 *  - mirrors a "working" flag into the store to drive the dot animation.
 * A terminal is working when a foreground process is running AND it produced
 * output very recently; the flag is only written when it flips, to avoid render
 * churn. Exit handling runs even when the window is unfocused (a background
 * program finishing must still close its tab); the dot updates are skipped
 * there since they aren't visible.
 */
export function useBusyPolling() {
  useEffect(() => {
    let cancelled = false;

    const tick = async () => {
      const live = useSessions
        .getState()
        .sessions.flatMap(sessionTerminals)
        .filter((t) => t.started && !t.exited);
      if (live.length === 0) return;

      let statuses: Record<string, { busy: boolean; dead: boolean }>;
      try {
        // One IPC for every terminal; the backend batches the busy probe.
        statuses = await terminalStatuses();
      } catch {
        return;
      }
      if (cancelled) return;

      const focused = appFocused();
      // Re-read after the await: a terminal may have gone away meanwhile. Index
      // once so the loop stays O(n).
      const fresh = new Map(
        useSessions
          .getState()
          .sessions.flatMap(sessionTerminals)
          .map((t) => [t.id, t] as const),
      );
      for (const t of live) {
        const current = fresh.get(t.id);
        if (!current || current.exited) continue;
        const st = statuses[t.id];
        // The program exited: close the tab (this also kills the backend session).
        // Absence from the map is NOT death; a just-created terminal may not be
        // in the backend snapshot yet, so only an explicit dead flag counts.
        if (st?.dead) {
          useSessions.getState().closeTerminal(t.id);
          continue;
        }
        if (!focused) continue; // the dot isn't visible; skip the rest
        const foreground = st?.busy ?? false;
        // Remember the terminal actually ran something, so the "finished"
        // heuristic can tell it apart from an idle shell that just redrew.
        if (foreground) markBusy(t.id);
        const working = foreground && outputAgeMs(t.id) < ACTIVE_WINDOW_MS;
        if (!!current.busy !== working) {
          useSessions.getState().setBusy(t.id, working);
        }
      }
    };

    const handle = window.setInterval(tick, POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(handle);
    };
  }, []);
}
