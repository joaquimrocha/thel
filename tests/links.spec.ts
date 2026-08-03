import { test, gotoApp, expect } from "./app";
import type { Page } from "@playwright/test";

async function createSession(page: Page) {
  await page.keyboard.press("Control+Shift+N");
  const create = page.getByRole("button", { name: "Create session" });
  await expect(create).toBeEnabled();
  await create.click();
  await expect(page.locator(".xterm").first()).toBeVisible();
}

/** Push output into the visible terminal. */
function emit(page: Page, data: string) {
  return page.evaluate((d) => {
    const t = (window as unknown as Record<string, any>).__TAURI_INTERNALS__;
    const panes = document.querySelectorAll("[data-terminal-pane]");
    const id = panes[panes.length - 1]?.getAttribute("data-terminal-pane");
    if (!id) throw new Error("no mounted terminal pane");
    if (!t.__emitTerminalById(id, d))
      throw new Error(`no channel for terminal ${id}`);
  }, data);
}

/** An OSC 8 hyperlink, the sequence `ls --hyperlink` emits. */
const osc8 = (uri: string, text: string) =>
  `\x1b]8;;${uri}\x07${text}\x1b]8;;\x07`;

/** Put the pointer over the first cell, where a cleared screen starts. */
async function hoverFirstCell(page: Page) {
  const box = await page.locator(".xterm-screen").first().boundingBox();
  if (!box) throw new Error("no terminal screen");
  await page.mouse.move(box.x + 4, box.y + 4);
  // The link provider resolves asynchronously; give it a frame to latch on.
  await page.waitForTimeout(200);
}

const openedUrl = (page: Page) =>
  page.evaluate(
    () =>
      (window as unknown as { __MOCK__: Record<string, unknown> }).__MOCK__
        .lastOpenedUrl as string | undefined,
  );

// `ls --hyperlink` wraps each name in OSC 8. xterm parses the sequence but does
// nothing with it unless a link handler is set, and drops non-http schemes
// unless told otherwise, so a file listing's links were dead on arrival.
test("an OSC 8 hyperlink opens its target", async ({ page }) => {
  await gotoApp(page);
  await createSession(page);
  // Home + clear, so the link starts at the first cell.
  await emit(page, `\x1b[H\x1b[2J${osc8("file:///home/u/notes.txt", "notes.txt")}`);

  await hoverFirstCell(page);
  await page.mouse.down();
  await page.mouse.up();

  await expect.poll(() => openedUrl(page)).toBe("file:///home/u/notes.txt");
});

// systemd's --help output points at its man pages with OSC 8 man: links, which
// the desktop opener handles as readily as http.
test("a man: hyperlink opens too", async ({ page }) => {
  await gotoApp(page);
  await createSession(page);
  await emit(
    page,
    `\x1b[H\x1b[2J${osc8("man:systemd-analyze(1)", "systemd-analyze(1)")}`,
  );

  await hoverFirstCell(page);
  await page.keyboard.down("Control");
  await page.mouse.down();
  await page.mouse.up();
  await page.keyboard.up("Control");

  await expect.poll(() => openedUrl(page)).toBe("man:systemd-analyze(1)");
});
