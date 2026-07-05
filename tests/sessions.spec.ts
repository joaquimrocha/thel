import { test } from "./app";
import { gotoApp, expect } from "./app";
import type { Page } from "@playwright/test";

async function createSession(page: Page) {
  await page.keyboard.press("Control+Shift+N");
  const create = page.getByRole("button", { name: "Create session" });
  await expect(create).toBeEnabled(); // home dir resolves and gets selected
  await create.click();
  await expect(page.getByText("No sessions open.")).toBeHidden();
}

const hasTerminalChannel = (page: Page, id: string) =>
  page.evaluate(
    (terminalId) =>
      (
        window as unknown as {
          __TAURI_INTERNALS__: {
            __hasTerminalChannel: (id: string) => boolean;
          };
        }
      ).__TAURI_INTERNALS__.__hasTerminalChannel(terminalId),
    id,
  );

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

const repeatShortcut = (page: Page, code: string) =>
  page.evaluate((c) => {
    window.dispatchEvent(
      new KeyboardEvent("keydown", {
        code: c,
        key: c.replace(/^Key/, ""),
        ctrlKey: true,
        shiftKey: true,
        repeat: true,
        bubbles: true,
        cancelable: true,
      }),
    );
  }, code);

test("create a session: sidebar entry and terminal controls appear", async ({
  page,
}) => {
  await gotoApp(page);
  await createSession(page);
  await expect(
    page.getByRole("button", { name: "Close session" }),
  ).toHaveCount(1);
  // One terminal opened in the new session (its tab carries a close button).
  await expect(
    page.getByRole("button", { name: "Close terminal" }),
  ).toHaveCount(1);
});

test("closing a session returns to the empty state", async ({ page }) => {
  await gotoApp(page);
  await createSession(page);
  await page.getByRole("button", { name: "Close session" }).click();
  // Closing a session always confirms now; accept in the dialog.
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Close session" })
    .click();
  await expect(page.getByText("No sessions open.")).toBeVisible();
});

test("Ctrl+Shift+T adds a terminal to the pane", async ({ page }) => {
  await gotoApp(page);
  await createSession(page);
  await expect(
    page.getByRole("button", { name: "Close terminal" }),
  ).toHaveCount(1);
  await page.keyboard.press("Control+Shift+T");
  await expect(
    page.getByRole("button", { name: "Close terminal" }),
  ).toHaveCount(2);
});

test("holding new-terminal shortcut is throttled, not suppressed", async ({
  page,
}) => {
  await gotoApp(page);
  await createSession(page);
  const tabs = page.getByTestId("terminal-tab");
  await expect(tabs).toHaveCount(1);

  await repeatShortcut(page, "KeyT");
  await repeatShortcut(page, "KeyT");
  await expect(tabs).toHaveCount(2);

  await page.waitForTimeout(550);
  await repeatShortcut(page, "KeyT");
  await expect(tabs).toHaveCount(3);
});

test("holding close-terminal shortcut is throttled, not suppressed", async ({
  page,
}) => {
  await gotoApp(page);
  await createSession(page);
  await page.keyboard.press("Control+Shift+T");
  await page.keyboard.press("Control+Shift+T");
  const tabs = page.getByTestId("terminal-tab");
  await expect(tabs).toHaveCount(3);

  await repeatShortcut(page, "KeyW");
  await repeatShortcut(page, "KeyW");
  await expect(tabs).toHaveCount(2);

  await page.waitForTimeout(550);
  await repeatShortcut(page, "KeyW");
  await expect(tabs).toHaveCount(1);
});

test("hidden daemon tabs update titles without mounting xterm", async ({ page }) => {
  await gotoApp(page);
  await createSession(page);
  const tabs = page.getByTestId("terminal-tab");
  const firstId = await tabs.first().getAttribute("data-tab-id");

  await page.keyboard.press("Control+Shift+T");
  await expect(tabs).toHaveCount(2);
  await expect(page.locator(".xterm")).toHaveCount(1);
  await expect.poll(() => hasTerminalChannel(page, firstId!)).toBe(true);

  await emitTerminal(page, firstId!, "\x1b]2;agent waiting\x07");
  await expect(tabs.first()).toContainText("agent waiting");
  await expect(page.locator(".xterm")).toHaveCount(1);
});

test("Ctrl+Shift+D splits into a second pane", async ({ page }) => {
  await gotoApp(page);
  await createSession(page);
  await expect(page.locator("[data-pane-group]")).toHaveCount(1);
  await page.keyboard.press("Control+Shift+D");
  await expect(page.locator("[data-pane-group]")).toHaveCount(2);
});

test("closing a pane's terminals collapses the split", async ({ page }) => {
  await gotoApp(page);
  await createSession(page);
  await expect(page.locator("[data-pane-group]")).toHaveCount(1);
  await page.keyboard.press("Control+Shift+D"); // split right
  await expect(page.locator("[data-pane-group]")).toHaveCount(2);
  await page.keyboard.press("Control+Alt+KeyW"); // close all terminals in pane
  await page.getByRole("button", { name: "Close all" }).click();
  await expect(page.locator("[data-pane-group]")).toHaveCount(1);
});

test("palette lists New terminal only when a session exists", async ({
  page,
}) => {
  await gotoApp(page);
  await page.keyboard.press("Control+Shift+P");
  await expect(page.getByText("New terminal")).toHaveCount(0);
  await page.keyboard.press("Escape");

  await createSession(page);
  await page.keyboard.press("Control+Shift+P");
  await expect(page.getByText("New terminal").first()).toBeVisible();
});

test("created session is restored after reload", async ({ page }) => {
  await gotoApp(page);
  await createSession(page);
  await expect(
    page.getByRole("button", { name: "Close session" }),
  ).toHaveCount(1);

  // Persistence is debounced (~400ms); let it flush before reloading.
  await page.waitForTimeout(700);
  await page.reload();
  // The session persists; with no live backend session it comes back idle (Start).
  await expect(
    page.getByRole("button", { name: "Close session" }),
  ).toHaveCount(1);
});
