import { test, gotoApp, expect } from "./app";
import type { Page } from "@playwright/test";

async function createSession(page: Page) {
  await page.keyboard.press("Control+Shift+N");
  const create = page.getByRole("button", { name: "Create session" });
  await expect(create).toBeEnabled();
  await create.click();
}

const ACTIVE = /text-secondary-foreground/;

test("Ctrl+Shift+PageUp/PageDown move the active terminal tab", async ({
  page,
}) => {
  await gotoApp(page);
  await createSession(page);
  await page.keyboard.press("Control+Shift+T"); // a second terminal, now active

  const tabs = page.getByTestId("terminal-tab");
  await expect(tabs).toHaveCount(2);
  await expect(tabs.nth(1)).toHaveClass(ACTIVE); // active is the second tab

  await page.keyboard.press("Control+Shift+PageUp"); // move it left
  await expect(tabs.nth(0)).toHaveClass(ACTIVE);

  await page.keyboard.press("Control+Shift+PageDown"); // and back right
  await expect(tabs.nth(1)).toHaveClass(ACTIVE);
});

test("dragging a terminal tab reorders it but keeps the panes' DOM order stable", async ({
  page,
}) => {
  await gotoApp(page);
  await createSession(page);
  await page.keyboard.press("Control+Shift+T"); // 2 terminals

  const panes = () =>
    page.$$eval("[data-terminal-pane]", (els) =>
      els.map((e) => (e as HTMLElement).dataset.terminalPane),
    );
  const tabs = page.getByTestId("terminal-tab");
  const tabId = (i: number) => tabs.nth(i).getAttribute("data-tab-id");
  const before = await panes();
  const first = await tabId(0);

  // Drag the first tab past the second's midpoint (a realistic dragover —
  // dragTo drops at the centre and never crosses the threshold).
  const dt = await page.evaluateHandle(() => new DataTransfer());
  await tabs.nth(0).dispatchEvent("dragstart", { dataTransfer: dt });
  const box = (await tabs.nth(1).boundingBox())!;
  await tabs.nth(1).dispatchEvent("dragover", {
    dataTransfer: dt,
    clientX: box.x + box.width * 0.85,
    clientY: box.y + box.height / 2,
  });
  await tabs.nth(0).dispatchEvent("dragend", { dataTransfer: dt });

  // The dragged tab moved to the second slot, but the stacked panes' DOM order
  // is unchanged (moving a pane node would blank its xterm until a redraw).
  await expect.poll(() => tabId(1)).toBe(first);
  expect(await panes()).toEqual(before);
});

test("dragging a tab onto another pane moves it and collapses the empty pane", async ({
  page,
}) => {
  await gotoApp(page);
  await createSession(page);
  await page.keyboard.press("Control+Shift+D"); // split into two panes

  const panes = page.locator("[data-pane-group]");
  const tabs = page.getByTestId("terminal-tab");
  await expect(panes).toHaveCount(2);
  await expect(tabs).toHaveCount(2);

  // Drop the first pane's tab onto the second pane's tab.
  const dt = await page.evaluateHandle(() => new DataTransfer());
  await tabs.nth(0).dispatchEvent("dragstart", { dataTransfer: dt });
  const box = (await tabs.nth(1).boundingBox())!;
  await tabs.nth(1).dispatchEvent("drop", {
    dataTransfer: dt,
    clientX: box.x + box.width / 2,
    clientY: box.y + box.height / 2,
  });

  // The source pane emptied and collapsed; both tabs now live in one pane.
  await expect(panes).toHaveCount(1);
  await expect(tabs).toHaveCount(2);
});

test("a tab dragged to another pane and back stays visible", async ({ page }) => {
  await gotoApp(page);
  await createSession(page);
  await page.keyboard.press("Control+Shift+T"); // left pane: two terminals
  await page.keyboard.press("Control+Shift+D"); // split: a second pane

  const tabs = page.getByTestId("terminal-tab");
  await expect(tabs).toHaveCount(3);
  const a = await tabs.nth(0).getAttribute("data-tab-id"); // left
  const b = await tabs.nth(1).getAttribute("data-tab-id"); // left
  const c = await tabs.nth(2).getAttribute("data-tab-id"); // right

  const drag = async (fromId: string | null, toId: string | null) => {
    const dt = await page.evaluateHandle(() => new DataTransfer());
    await page.locator(`[data-tab-id="${fromId}"]`).dispatchEvent("dragstart", {
      dataTransfer: dt,
    });
    const to = page.locator(`[data-tab-id="${toId}"]`);
    const box = (await to.boundingBox())!;
    // No dragend dispatched — the source tab unmounts on the move, mirroring the
    // real case where its dragend never fires.
    await to.dispatchEvent("drop", {
      dataTransfer: dt,
      clientX: box.x + box.width / 2,
      clientY: box.y + box.height / 2,
    });
  };

  await drag(a, c); // A: left pane -> right pane
  await drag(a, b); // A: right pane -> back to the left pane

  // Back home, A must not be stuck hidden by stale drag state.
  await expect(page.locator(`[data-tab-id="${a}"]`)).not.toHaveClass(/opacity-0/);
});

test("Ctrl+Alt+Shift+PageUp/PageDown move the active session", async ({
  page,
}) => {
  await gotoApp(page);
  await createSession(page);
  await createSession(page); // second session, now active (last row)

  const rows = page.locator("[data-session-list] > div");
  await expect(rows).toHaveCount(2);
  await expect(rows.last()).toHaveClass(ACTIVE);

  await page.keyboard.press("Control+Alt+Shift+PageUp"); // move it up
  await expect(rows.first()).toHaveClass(ACTIVE);

  await page.keyboard.press("Control+Alt+Shift+PageDown"); // and back down
  await expect(rows.last()).toHaveClass(ACTIVE);
});
