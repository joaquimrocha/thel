import { test, expect, describe, vi, beforeEach, afterEach } from "vitest";
import { createTerminalActivity, type TerminalActivity } from "./termActivity";
import { clearActivity } from "./activity";

// The core uses bare setTimeout/Date.now, so fake timers drive it deterministically.
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
});
afterEach(() => {
  vi.useRealTimers();
});

let seq = 0;
// A fresh, always-unwatched core with recorded callbacks. Unique id per call so
// the module-level activity maps don't bleed between tests.
function makeCore(watched = () => false) {
  const id = `t${seq++}`;
  const notify = vi.fn();
  const working = vi.fn();
  const core = createTerminalActivity({
    id,
    watched,
    onNotify: notify,
    onWorking: working,
  });
  return { id, core, notify, working };
}

// Push a core past its reattach-replay gate the cheap way: the fallback timer.
function settle(core: TerminalActivity) {
  vi.advanceTimersByTime(3000);
  expect(core.isReplaySettled()).toBe(true);
}

describe("replay gate", () => {
  test("nothing notifies until settled", () => {
    const { core, notify } = makeCore();
    core.noteBell();
    core.noteMessage("hi");
    vi.advanceTimersByTime(2000);
    expect(notify).not.toHaveBeenCalled();
    expect(core.isReplaySettled()).toBe(false);
  });

  test("visible output settles the gate after a pause", () => {
    const { core } = makeCore();
    core.noteOutput(true);
    expect(core.isReplaySettled()).toBe(false);
    vi.advanceTimersByTime(250);
    expect(core.isReplaySettled()).toBe(true);
  });
});

describe("bell", () => {
  test("fires after quiet", () => {
    const { core, notify } = makeCore();
    settle(core);
    core.noteBell();
    expect(core.isBellPending()).toBe(true);
    vi.advanceTimersByTime(1000);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith("bell");
    expect(core.isBellPending()).toBe(false);
  });

  test("dropped when output keeps flowing past the window", () => {
    const { core, notify } = makeCore();
    settle(core);
    core.noteBell();
    // Output arriving every 500ms keeps rearming the quiet timer, so it never
    // fires; each chunk is within BELL_WINDOW_MS of the bell, so none drops it.
    for (let t = 0; t < 4000; t += 500) {
      vi.advanceTimersByTime(500);
      core.absorbOutputBeforeWrite(true);
    }
    // A chunk now past the window means the bell rang mid-action: drop it.
    vi.advanceTimersByTime(500);
    core.absorbOutputBeforeWrite(true);
    expect(core.isBellPending()).toBe(false);
    vi.advanceTimersByTime(2000);
    expect(notify).not.toHaveBeenCalled();
  });

  test("postponed by a brief repaint within the window", () => {
    const { core, notify } = makeCore();
    settle(core);
    core.noteBell();
    vi.advanceTimersByTime(500); // a prompt repaint
    core.absorbOutputBeforeWrite(true);
    // The quiet timer was rearmed, so it hasn't fired at the original deadline.
    vi.advanceTimersByTime(600);
    expect(notify).not.toHaveBeenCalled();
    vi.advanceTimersByTime(400); // now 1000ms since the repaint
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith("bell");
  });

  test("a watched terminal never rings", () => {
    const { core, notify } = makeCore(() => true);
    settle(core);
    core.noteBell();
    vi.advanceTimersByTime(2000);
    expect(notify).not.toHaveBeenCalled();
  });
});

describe("finished (idle) alert", () => {
  test("fires when a command ran and then went quiet", () => {
    const { core, notify } = makeCore();
    settle(core);
    core.noteBusy(true); // a foreground command
    core.noteBusy(false); // that just ended
    core.noteOutput(true);
    vi.advanceTimersByTime(1000);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith("idle");
  });

  test("suppressed while still busy", () => {
    const { core, notify } = makeCore();
    settle(core);
    core.noteBusy(true);
    core.noteOutput(true);
    vi.advanceTimersByTime(1000);
    expect(notify).not.toHaveBeenCalled();
  });

  test("suppressed for an idle shell that was never busy", () => {
    const { core, notify } = makeCore();
    settle(core);
    core.noteOutput(true); // a redraw, no command ever ran
    vi.advanceTimersByTime(1000);
    expect(notify).not.toHaveBeenCalled();
  });

  test("a resize-driven redraw does not alert", () => {
    const { core, notify } = makeCore();
    settle(core);
    core.noteBusy(true);
    core.noteBusy(false);
    core.noteResize();
    core.noteOutput(true); // redraw within the resize-quiet window
    vi.advanceTimersByTime(1000);
    expect(notify).not.toHaveBeenCalled();
  });

  test("cancelIdle stops a pending alert", () => {
    const { core, notify } = makeCore();
    settle(core);
    core.noteBusy(true);
    core.noteBusy(false);
    core.noteOutput(true);
    core.cancelIdle();
    vi.advanceTimersByTime(1000);
    expect(notify).not.toHaveBeenCalled();
  });
});

describe("message", () => {
  test("fires trimmed, once settled", () => {
    const { core, notify } = makeCore();
    settle(core);
    core.noteMessage("  build done  ");
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith("message", "build done");
  });

  test("empty message is dropped", () => {
    const { core, notify } = makeCore();
    settle(core);
    core.noteMessage("   ");
    expect(notify).not.toHaveBeenCalled();
  });
});

describe("working animation", () => {
  test("edges on recent-output + busy, and clears on idle", () => {
    const { core, working } = makeCore();
    settle(core);
    core.noteOutput(true); // recent output
    core.noteBusy(true);
    expect(working).toHaveBeenLastCalledWith(true);
    core.noteBusy(false);
    expect(working).toHaveBeenLastCalledWith(false);
    expect(working).toHaveBeenCalledTimes(2);
  });

  test("no animation for a busy program with no recent output", () => {
    const { core, working } = makeCore();
    settle(core);
    core.noteOutput(true);
    vi.advanceTimersByTime(1001); // output ages out of the active window
    core.noteBusy(true);
    expect(working).not.toHaveBeenCalled();
  });

  test("the reattach replay burst doesn't light the dot for an idle agent", () => {
    // Fresh core = replay in progress (not settled). A resident agent reports
    // busy, and the daemon replays the screen; that must not count as work.
    const { core, working } = makeCore();
    core.noteOutput(true); // replayed screen content, before settle
    core.noteBusy(true); // busy (foreground agent)
    expect(working).not.toHaveBeenCalled();
  });
});

test("dispose cancels a pending bell", () => {
  const { core, notify, id } = makeCore();
  settle(core);
  core.noteBell();
  core.dispose();
  vi.advanceTimersByTime(2000);
  expect(notify).not.toHaveBeenCalled();
  clearActivity(id);
});
