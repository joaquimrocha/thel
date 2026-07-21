import { test, gotoApp, expect } from "./app";
import type { Page, CDPSession } from "@playwright/test";

// Frontend memory-leak probes. Each scenario measures the JS heap (after a
// forced GC via CDP) at two checkpoints with identical work between them: a
// leak grows linearly with the work, clean memory plateaus. The Rust daemon is
// not covered here (its buffers are capped in daemon.rs: MAX_SCROLLBACK_BYTES).

async function gcHeapMB(page: Page, cdp: CDPSession): Promise<number> {
  // Let xterm drain its write queue before measuring.
  await page.waitForTimeout(400);
  await cdp.send("HeapProfiler.collectGarbage");
  await cdp.send("HeapProfiler.collectGarbage");
  const { metrics } = await cdp.send("Performance.getMetrics");
  const used = metrics.find((m) => m.name === "JSHeapUsedSize")?.value ?? 0;
  return used / (1024 * 1024);
}

async function newCdp(page: Page): Promise<CDPSession> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Performance.enable");
  return cdp;
}

/** Push ~`kb` KB of output into the visible (mounted) terminal, in-page. */
function pump(page: Page, kb: number) {
  return page.evaluate(async (kb) => {
    const t = (window as unknown as Record<string, any>).__TAURI_INTERNALS__;
    const panes = document.querySelectorAll("[data-terminal-pane]");
    const id = panes[panes.length - 1]?.getAttribute("data-terminal-pane");
    if (!id) throw new Error("no mounted terminal pane");
    const line = "output from a long-running process 0123456789abcdef\r\n";
    const chunk = line.repeat(20); // ~1 KB
    for (let i = 0; i < kb; i++) {
      if (!t.__emitTerminalById(id, chunk))
        throw new Error(`no channel for terminal ${id}`);
      if (i % 64 === 0) await new Promise((r) => setTimeout(r, 0));
    }
  }, kb);
}

async function createSession(page: Page) {
  await page.keyboard.press("Control+Shift+N");
  const create = page.getByRole("button", { name: "Create session" });
  await expect(create).toBeEnabled();
  await create.click();
  await expect(page.locator(".xterm").first()).toBeVisible();
}

const tabs = (page: Page) => page.getByTestId("terminal-tab");

test("long-running session: heap plateaus while output streams", async ({
  page,
}) => {
  await gotoApp(page);
  const cdp = await newCdp(page);
  await createSession(page);

  // Warm up (JIT, xterm buffers reach steady state), then baseline.
  await pump(page, 1024);
  const base = await gcHeapMB(page, cdp);

  await pump(page, 4096); // ~4 MB of output
  const h1 = await gcHeapMB(page, cdp);
  await pump(page, 4096); // same again
  const h2 = await gcHeapMB(page, cdp);

  console.log(
    `[memory] long-running: base ${base.toFixed(1)} MB, +4MB out ${h1.toFixed(1)} MB, +8MB out ${h2.toFixed(1)} MB`,
  );
  // Scrollback is capped (2000 lines), so equal extra output must not add
  // equal extra heap.
  expect(h2 - h1).toBeLessThan(4);
});

test("tab churn: open/pump/close terminals returns memory", async ({ page }) => {
  test.setTimeout(180_000);
  await gotoApp(page);
  const cdp = await newCdp(page);
  await createSession(page);

  const cycle = async () => {
    await page.keyboard.press("Control+Shift+T");
    await expect(tabs(page)).toHaveCount(2);
    await pump(page, 256);
    await page.keyboard.press("Control+Shift+W");
    await expect(tabs(page)).toHaveCount(1);
  };

  for (let i = 0; i < 5; i++) await cycle(); // warm-up
  const h1 = await gcHeapMB(page, cdp);
  const CYCLES = Number(process.env.MEM_CYCLES) || 15;
  for (let i = 0; i < CYCLES; i++) await cycle();
  const h2 = await gcHeapMB(page, cdp);

  const perCycleKB = ((h2 - h1) * 1024) / CYCLES;
  console.log(
    `[memory] tab churn: ${h1.toFixed(1)} -> ${h2.toFixed(1)} MB over ${CYCLES} cycles (${perCycleKB.toFixed(0)} KB/cycle)`,
  );
  // Only the visible terminal's xterm stays mounted.
  await expect(page.locator(".xterm")).toHaveCount(1);
  // A leaked xterm Terminal (scrollback + renderer) costs ~1MB+/cycle.
  expect(perCycleKB).toBeLessThan(250);
});

test("launcher churn: launching an app via a launcher stays clean", async ({
  page,
}) => {
  test.setTimeout(180_000);
  await gotoApp(page);
  const cdp = await newCdp(page);
  await createSession(page);

  // Create a launcher that runs a command ("an app").
  await page.keyboard.press("Control+Shift+P");
  await page.getByText("Launchers…").click();
  await page.getByRole("button", { name: "Create launcher…" }).click();
  await page.getByPlaceholder("e.g. Claude").fill("AppSim");
  await page.getByPlaceholder(/empty = shell/).fill("appsim --serve");
  await page.getByRole("button", { name: "Create", exact: true }).click();
  await page.keyboard.press("Escape");
  await expect(tabs(page)).toHaveCount(1);

  const cycle = async () => {
    await page.keyboard.press("Control+Shift+P");
    await page.getByText("AppSim in current session").click();
    await expect(tabs(page)).toHaveCount(2);
    await pump(page, 256);
    await page.keyboard.press("Control+Shift+W");
    await expect(tabs(page)).toHaveCount(1);
  };

  for (let i = 0; i < 3; i++) await cycle(); // warm-up
  const h1 = await gcHeapMB(page, cdp);
  const CYCLES = 10;
  for (let i = 0; i < CYCLES; i++) await cycle();
  const h2 = await gcHeapMB(page, cdp);

  const perCycleKB = ((h2 - h1) * 1024) / CYCLES;
  console.log(
    `[memory] launcher churn: ${h1.toFixed(1)} -> ${h2.toFixed(1)} MB over ${CYCLES} cycles (${perCycleKB.toFixed(0)} KB/cycle)`,
  );
  expect(perCycleKB).toBeLessThan(250);
});
