import { test, gotoApp, expect } from "./app";
import type { Page } from "@playwright/test";

async function createSession(page: Page) {
  await page.keyboard.press("Control+Shift+N");
  const create = page.getByRole("button", { name: "Create session" });
  await expect(create).toBeEnabled();
  await create.click();
}

// Report a terminal's process exit, the way the Direct backend does
// over the channel. The polling backend reaches the same handler via its poll.
const exitTerminal = (page: Page, index: number, code: number | null) =>
  page.evaluate(
    ([i, c]) =>
      (
        window as unknown as {
          __TAURI_INTERNALS__: {
            __exitTerminal: (i: number, c: number | null) => void;
          };
        }
      ).__TAURI_INTERNALS__.__exitTerminal(i as number, c as number | null),
    [index, code] as const,
  );

test("a clean process exit (code 0) closes the terminal tab", async ({
  page,
}) => {
  await gotoApp(page);
  await createSession(page);
  await page.keyboard.press("Control+Shift+T"); // a second terminal
  const tabs = page.getByTestId("terminal-tab");
  await expect(tabs).toHaveCount(2);

  await exitTerminal(page, 0, 0);
  await expect(tabs).toHaveCount(1);
});

test("a non-zero (error) exit also closes the tab", async ({ page }) => {
  await gotoApp(page);
  await createSession(page);
  await page.keyboard.press("Control+Shift+T");
  const tabs = page.getByTestId("terminal-tab");
  await expect(tabs).toHaveCount(2);

  await exitTerminal(page, 1, 3); // the program crashed
  await expect(tabs).toHaveCount(1);
});

// the PTY sees no EOF, so a program exit surfaces only as a dead pane
// in the polled status. The batched status poll (not a per-pane timer) must
// notice it and close the tab.
test("a terminal whose backend pane goes dead is closed by the poll", async ({
  page,
}) => {
  await gotoApp(page);
  await createSession(page);
  const tabs = page.getByTestId("terminal-tab");
  await expect(tabs).toHaveCount(1);

  await page.evaluate(() => {
    (window as unknown as { __MOCK__: { terminalDead: boolean } }).__MOCK__.terminalDead =
      true;
  });
  await expect(tabs).toHaveCount(0);
});
