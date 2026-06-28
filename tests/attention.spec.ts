import { test, gotoApp, expect } from "./app";
import type { Page } from "@playwright/test";

async function createSession(page: Page) {
  await page.keyboard.press("Control+Shift+N");
  const create = page.getByRole("button", { name: "Create session" });
  await expect(create).toBeEnabled();
  await create.click();
}

const emitTerminal = (page: Page, index: number, data: string) =>
  page.evaluate(
    ([i, d]) =>
      (
        window as unknown as {
          __TAURI_INTERNALS__: {
            __emitTerminal: (i: number, d: string) => void;
          };
        }
      ).__TAURI_INTERNALS__.__emitTerminal(i as number, d as string),
    [index, data] as const,
  );

const fireWindow = (page: Page, type: "focus" | "blur") =>
  page.evaluate((t) => window.dispatchEvent(new Event(t)), type);

// The dot on the first (background) session row.
const firstSessionDot = (page: Page) =>
  page.locator("[data-session-list] > div").first().locator(".bg-blue-500");

test("a background terminal's bell shows the blue attention dot", async ({
  page,
}) => {
  await gotoApp(page);
  // Two sessions: the second is active, so the first runs in the background.
  await createSession(page);
  await createSession(page);

  await emitTerminal(page, 0, "\x07"); // bell on the background terminal
  await expect(firstSessionDot(page)).toBeVisible();
});

test("a terminal reply does not clear the attention dot", async ({ page }) => {
  await gotoApp(page);
  await createSession(page);
  await createSession(page);

  await emitTerminal(page, 0, "\x07");
  await expect(firstSessionDot(page)).toBeVisible();

  // A cursor-position query makes xterm reply via onData (as a multiplexer's probes do).
  // That must not be mistaken for the user attending the terminal.
  await emitTerminal(page, 0, "\x1b[6n");
  await page.waitForTimeout(100);
  await expect(firstSessionDot(page)).toBeVisible();
});

test("clearing all notifications removes the attention dots", async ({
  page,
}) => {
  await gotoApp(page);
  await createSession(page);
  await createSession(page);

  await emitTerminal(page, 0, "\x07"); // bell on the background terminal
  await expect(firstSessionDot(page)).toBeVisible();

  // Clearing the notifications panel should also drop the attention dot it flagged.
  await page.getByRole("button", { name: "Notifications" }).click();
  await page.getByRole("button", { name: "Clear all" }).click();
  await expect(firstSessionDot(page)).toHaveCount(0);
});

test("the active terminal's dot survives a window refocus, clears on typing", async ({
  page,
}) => {
  await gotoApp(page);
  await createSession(page); // single, active+visible terminal

  // Bell while the window is unfocused, then refocus. The dot must remain so you
  // can still see which terminal wanted you (regression: the visible terminal's
  // dot was wiped the instant the window regained focus).
  await fireWindow(page, "blur");
  await emitTerminal(page, 0, "\x07");
  const dot = firstSessionDot(page);
  await expect(dot).toBeVisible();
  await fireWindow(page, "focus");
  await expect(dot).toBeVisible();

  // Typing into the terminal attends it, which clears the dot.
  await page.locator(".xterm").first().click();
  await page.keyboard.type("x");
  await expect(firstSessionDot(page)).toHaveCount(0);
});

test("clicking the terminal clears its attention dot (no typing needed)", async ({
  page,
}) => {
  await gotoApp(page);
  await createSession(page);

  await fireWindow(page, "blur");
  await emitTerminal(page, 0, "\x07");
  await expect(firstSessionDot(page)).toBeVisible();
  await fireWindow(page, "focus");
  await expect(firstSessionDot(page)).toBeVisible(); // refocus alone keeps it

  // A click into the terminal attends it, clearing the dot without a keystroke.
  await page.locator(".xterm").first().click();
  await expect(firstSessionDot(page)).toHaveCount(0);
});
