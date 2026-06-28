import { test, gotoApp, expect } from "./app";

// Startup cost scales with how many restored terminals mount at launch. This
// seeds several sessions and logs how long until the ACTIVE session is
// interactive vs. until every session has mounted. The active number is what the
// user feels; the gap is the work deferred off the startup path.
const SESSIONS = 4;
const TABS = 4; // per session
const TOTAL = SESSIONS * TABS;

function seedLayout() {
  const sessions = Array.from({ length: SESSIONS }, (_, i) => {
    const terminals = Array.from({ length: TABS }, (_, j) => ({
      id: `t${i}-${j}`,
      title: "shell",
      command: "bash",
      args: [],
    }));
    return {
      id: `s${i}`,
      name: `session ${i}`,
      groups: [
        { id: `g${i}`, activeTerminalId: `t${i}-0`, terminals },
      ],
      layout: { t: "leaf", group: `g${i}` },
      activeGroupId: `g${i}`,
    };
  });
  return { activeSessionId: "s0", sessions };
}

test(`startup with ${TOTAL} restored terminals (${SESSIONS}×${TABS})`, async ({
  page,
}) => {
  // Seed the persisted layout + daemon-on before the app boots.
  await page.addInitScript((layout) => {
    localStorage.setItem(
      "__store__thel-layout.json",
      JSON.stringify({ layout }),
    );
    localStorage.setItem("thel.useDaemon", "1");
  }, seedLayout());

  const t0 = Date.now();
  // Each terminal emits a snapshot to parse, approximating a reattach replay.
  await gotoApp(page, { snapshotBytes: 256 * 1024 });

  // Active session's terminal is rendered (first xterm visible).
  await expect(page.locator(".xterm").first()).toBeVisible();
  const activeMs = Date.now() - t0;

  // Every terminal has eventually mounted (deferred sessions + tabs warmed in).
  // .xterm counts mounted terminals including the hidden ones.
  await expect(page.locator(".xterm")).toHaveCount(TOTAL);
  const allMs = Date.now() - t0;

  console.log(
    `[startup-bench] active interactive: ${activeMs}ms | all ${TOTAL} mounted: ${allMs}ms`,
  );
});

// Deferral is per-tab, not per-pane: a split active session must show every
// pane's visible terminal on first paint, not just one.
test("a split active session loads every pane's visible terminal", async ({
  page,
}) => {
  const term = (id: string) => ({ id, title: "shell", command: "bash", args: [] });
  const layout = {
    activeSessionId: "s0",
    sessions: [
      {
        id: "s0",
        name: "split",
        groups: [
          { id: "ga", activeTerminalId: "a0", terminals: [term("a0"), term("a1")] },
          { id: "gb", activeTerminalId: "b0", terminals: [term("b0"), term("b1")] },
        ],
        layout: {
          t: "split",
          dir: "row",
          children: [
            { t: "leaf", group: "ga" },
            { t: "leaf", group: "gb" },
          ],
        },
        activeGroupId: "ga",
      },
    ],
  };
  await page.addInitScript((l) => {
    localStorage.setItem("__store__thel-layout.json", JSON.stringify({ layout: l }));
    localStorage.setItem("thel.useDaemon", "1");
  }, layout);
  await gotoApp(page);

  // Both panes' active terminals render (not just the active group's).
  await expect(page.locator('[data-terminal-pane="a0"] .xterm')).toBeVisible();
  await expect(page.locator('[data-terminal-pane="b0"] .xterm')).toBeVisible();
  // The hidden tabs behind each pane still warm in afterward.
  await expect(page.locator(".xterm")).toHaveCount(4);
});
