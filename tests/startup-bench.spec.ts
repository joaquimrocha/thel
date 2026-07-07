import { test, gotoApp, expect } from "./app";

// Startup cost must not scale with every restored terminal. This seeds several
// sessions and logs how long until the ACTIVE session is interactive. With the
// daemon backend, hidden tabs stay detached and reattach on demand.
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

  // Daemon-backed hidden tabs do not mount their xterm until selected.
  await expect(page.locator(".xterm")).toHaveCount(1);

  console.log(
    `[startup-bench] active interactive: ${activeMs}ms | ${TOTAL} configured, 1 mounted`,
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
  // The hidden tabs behind each pane stay detached until selected.
  await expect(page.locator(".xterm")).toHaveCount(2);
});

// The headline scaling guard: launching with a large restored layout must not
// mount an xterm per terminal. With the daemon, hidden tabs AND whole hidden
// sessions stay detached, so exactly one xterm mounts whether you restored 16
// terminals or 100. A regression that eagerly mounts every restored terminal
// fails the count assertion (and the logged time balloons).
const BIG_SESSIONS = 10;
const BIG_TABS = 10;
const BIG_TOTAL = BIG_SESSIONS * BIG_TABS; // 100

function seedBig() {
  const sessions = Array.from({ length: BIG_SESSIONS }, (_, i) => {
    const terminals = Array.from({ length: BIG_TABS }, (_, j) => ({
      id: `b${i}-${j}`,
      title: "shell",
      command: "bash",
      args: [],
    }));
    return {
      id: `bs${i}`,
      name: `session ${i}`,
      groups: [{ id: `bg${i}`, activeTerminalId: `b${i}-0`, terminals }],
      layout: { t: "leaf", group: `bg${i}` },
      activeGroupId: `bg${i}`,
    };
  });
  return { activeSessionId: "bs0", sessions };
}

test(`startup stays flat with ${BIG_TOTAL} restored terminals (${BIG_SESSIONS}×${BIG_TABS})`, async ({
  page,
}) => {
  await page.addInitScript((layout) => {
    localStorage.setItem("__store__thel-layout.json", JSON.stringify({ layout }));
    localStorage.setItem("thel.useDaemon", "1");
  }, seedBig());

  const t0 = Date.now();
  await gotoApp(page, { snapshotBytes: 16 * 1024 });
  await expect(page.locator(".xterm").first()).toBeVisible();
  const activeMs = Date.now() - t0;

  // The invariant: one xterm mounts, regardless of the 100 restored terminals.
  await expect(page.locator(".xterm")).toHaveCount(1);
  console.log(
    `[startup-bench] ${BIG_TOTAL} terminals -> interactive ${activeMs}ms, 1 xterm mounted`,
  );

  // Switching to a hidden session mounts its terminal on demand and detaches the
  // old one, so the mounted count tracks what's on screen, never the layout size.
  await page.getByText("session 9", { exact: true }).click();
  await expect(page.locator(".xterm")).toHaveCount(1);
});

// Companion to the session-spread case: 100 tabs in a SINGLE pane. This stresses
// the tab strip (all 100 render as tabs) rather than the session list, and
// confirms hidden tabs within a pane detach just like hidden sessions -- the
// strip is cheap, but only the active tab's xterm mounts.
const MANY_TABS = 100;

test(`startup stays flat with ${MANY_TABS} tabs in one pane`, async ({ page }) => {
  const terminals = Array.from({ length: MANY_TABS }, (_, j) => ({
    id: `tab${j}`,
    title: "shell",
    command: "bash",
    args: [],
  }));
  const layout = {
    activeSessionId: "s0",
    sessions: [
      {
        id: "s0",
        name: "many tabs",
        groups: [{ id: "g0", activeTerminalId: "tab0", terminals }],
        layout: { t: "leaf", group: "g0" },
        activeGroupId: "g0",
      },
    ],
  };
  await page.addInitScript((l) => {
    localStorage.setItem("__store__thel-layout.json", JSON.stringify({ layout: l }));
    localStorage.setItem("thel.useDaemon", "1");
  }, layout);

  const t0 = Date.now();
  await gotoApp(page, { snapshotBytes: 16 * 1024 });
  await expect(page.locator(".xterm").first()).toBeVisible();
  const activeMs = Date.now() - t0;

  // All 100 tabs render in the strip...
  await expect(page.getByTestId("terminal-tab")).toHaveCount(MANY_TABS);
  // ...but only the active tab's xterm mounts.
  await expect(page.locator(".xterm")).toHaveCount(1);
  console.log(
    `[startup-bench] ${MANY_TABS} tabs in one pane -> interactive ${activeMs}ms, 1 xterm mounted`,
  );
});
