import { test, gotoApp, expect } from "./app";
import type { Page } from "@playwright/test";

// Find bar, per-terminal mute, and the OSC progress bar: all three hang off a
// terminal's tab, so they share a spec.

async function createSession(page: Page) {
  await page.keyboard.press("Control+Shift+N");
  const create = page.getByRole("button", { name: "Create session" });
  await expect(create).toBeEnabled();
  await create.click();
}

const emitTerminal = (page: Page, id: string, data: string) =>
  page.evaluate(
    ([terminalId, d]) =>
      (
        window as unknown as {
          __TAURI_INTERNALS__: {
            __emitTerminalById: (id: string, d: string) => boolean;
          };
        }
      ).__TAURI_INTERNALS__.__emitTerminalById(
        terminalId as string,
        d as string,
      ),
    [id, data] as const,
  );

const setBusy = (page: Page, id: string, busy: boolean) =>
  page.evaluate(
    ([terminalId, b]) =>
      (
        window as unknown as {
          __TAURI_INTERNALS__: {
            __busyTerminalById: (id: string, busy: boolean) => boolean;
          };
        }
      ).__TAURI_INTERNALS__.__busyTerminalById(terminalId as string, b as boolean),
    [id, busy] as const,
  );

async function activeTerminalId(page: Page): Promise<string> {
  const id = await page
    .getByTestId("terminal-tab")
    .first()
    .getAttribute("data-tab-id");
  return id!;
}

const findInput = (page: Page) =>
  page.getByRole("textbox", { name: "Find in terminal output" });

test("find searches the terminal's output and reports a miss", async ({
  page,
}) => {
  await gotoApp(page);
  await createSession(page);
  const id = await activeTerminalId(page);
  await emitTerminal(page, id, "the needle is in this haystack\r\n");

  await page.locator(".xterm").first().click();
  await page.keyboard.press("Control+Shift+F");
  await expect(findInput(page)).toBeFocused();

  await page.keyboard.type("needle");
  await expect(findInput(page)).not.toHaveClass(/text-destructive/);

  // A term that isn't on screen anywhere reads as a miss.
  await findInput(page).fill("nothing-matches-this");
  await expect(findInput(page)).toHaveClass(/text-destructive/);

  await page.keyboard.press("Escape");
  await expect(findInput(page)).toBeHidden();
});

test("a tab can be muted and unmuted from its own bell button", async ({
  page,
}) => {
  await gotoApp(page);
  await createSession(page);
  const tab = page.getByTestId("terminal-tab").first();

  await tab.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Mute notifications" }).click();

  const unmute = page.getByRole("button", { name: "Unmute notifications" });
  await expect(unmute).toBeVisible();
  await unmute.click();
  await expect(unmute).toBeHidden();
});

test("an OSC 9;4 progress report draws a bar on the tab", async ({ page }) => {
  await gotoApp(page);
  await createSession(page);
  const id = await activeTerminalId(page);

  await emitTerminal(page, id, "\x1b]9;4;1;40\x07");
  await expect(page.getByTestId("tab-progress")).toHaveAttribute(
    "data-progress",
    "40",
  );

  await emitTerminal(page, id, "\x1b]9;4;0\x07");
  await expect(page.getByTestId("tab-progress")).toBeHidden();
});

test("a command that ends without clearing its progress loses the bar", async ({
  page,
}) => {
  await gotoApp(page);
  await createSession(page);
  const id = await activeTerminalId(page);

  await setBusy(page, id, true);
  await emitTerminal(page, id, "\x1b]9;4;1;60\x07");
  await expect(page.getByTestId("tab-progress")).toBeVisible();

  // Killed mid-run: no 9;4;0 ever arrives, so going idle has to clear it.
  await setBusy(page, id, false);
  await expect(page.getByTestId("tab-progress")).toBeHidden();
});

test("the find field keeps taking focus, however it is opened", async ({
  page,
}) => {
  await gotoApp(page);
  await createSession(page);
  const id = await activeTerminalId(page);
  await emitTerminal(page, id, "the needle is in this haystack\r\n");
  const term = page.locator(".xterm").first();

  await term.click();
  await page.keyboard.press("Control+Shift+F");
  await expect(findInput(page)).toBeFocused();

  // Clicking away and asking again refocuses the bar that is already open.
  await term.click();
  await page.keyboard.press("Control+Shift+F");
  await expect(findInput(page)).toBeFocused();

  // Clicking the field itself must reach it, not the xterm canvas beneath.
  await term.click();
  await findInput(page).click();
  await expect(findInput(page)).toBeFocused();

  // And its buttons: the close button ends the bar with one click.
  await page.getByRole("button", { name: "Close find" }).click();
  await expect(findInput(page)).toBeHidden();

  // The right-click menu leaves focus in the field too, despite the menu
  // wanting to hand focus back to its trigger.
  await term.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Find" }).click();
  await expect(findInput(page)).toBeFocused();
  await page.keyboard.type("needle");
  await expect(findInput(page)).toHaveValue("needle");
});

test("the find bar survives a trip to another tab", async ({ page }) => {
  await gotoApp(page);
  await createSession(page);
  const term = page.locator(".xterm").first();

  await term.click();
  await page.keyboard.press("Control+Shift+F");
  await page.keyboard.type("needle");

  // A second tab, then back: the bar and its query are still there. The
  // shortcut has to come from the terminal, since app shortcuts stay out of
  // the way while a text field has the keyboard.
  await term.click();
  await page.keyboard.press("Control+Shift+T");
  await expect(page.getByTestId("terminal-tab")).toHaveCount(2);
  await page.getByTestId("terminal-tab").first().click();
  await expect(findInput(page)).toHaveValue("needle");
});
