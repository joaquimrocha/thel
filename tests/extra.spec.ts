import { test, gotoApp, expect } from "./app";
import type { Page } from "@playwright/test";

async function createSession(page: Page) {
  await page.keyboard.press("Control+Shift+N");
  const c = page.getByRole("button", { name: "Create session" });
  await expect(c).toBeEnabled();
  await c.click();
  await expect(page.getByText("No sessions open.")).toBeHidden();
}
async function rename(page: Page, name: string) {
  await page
    .locator('[data-session-list] [title="Double-click for session settings"]')
    .last()
    .dblclick();
  const dialog = page.getByRole("dialog");
  await dialog.locator("input").first().fill(name);
  await dialog.getByRole("button", { name: "Done" }).click();
}
const activeName = (page: Page) => page.getByTestId("active-session-name");

test("terminal tabs: click to switch, close via the X", async ({ page }) => {
  await gotoApp(page);
  await createSession(page);
  await page.keyboard.press("Control+Shift+T"); // 2 terminals
  await expect(
    page.getByRole("button", { name: "Close terminal" }),
  ).toHaveCount(2);
  // Click the first tab to focus it, then close it.
  await page
    .locator('[title="Double-click to rename"]', { hasText: "Terminal" })
    .first()
    .click();
  await page.getByRole("button", { name: "Close terminal" }).first().click();
  await expect(
    page.getByRole("button", { name: "Close terminal" }),
  ).toHaveCount(1);
});

test("collapsing the sidebar shows a rail with the session", async ({
  page,
}) => {
  await gotoApp(page);
  await createSession(page);
  await rename(page, "Alpha");
  await expect(page.locator("[data-session-list]")).toBeVisible();
  await page.keyboard.press("Control+Shift+B");
  await expect(page.locator("[data-session-list]")).toBeHidden();
  await expect(
    page.getByRole("button", { name: "Alpha", exact: true }),
  ).toBeVisible();
});

test("window resize grips fire startResizeDragging without error", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await gotoApp(page);
  const grips = page.locator(
    ".cursor-ns-resize, .cursor-ew-resize, .cursor-nwse-resize, .cursor-nesw-resize",
  );
  const n = await grips.count();
  expect(n).toBe(8); // 4 edges + 4 corners
  for (let i = 0; i < n; i++) {
    await grips.nth(i).dispatchEvent("mousedown", { button: 0 });
  }
  expect(errors).toEqual([]);
});

test("session list: j/k navigate and Enter switches", async ({ page }) => {
  await gotoApp(page);
  await createSession(page);
  await rename(page, "Alpha");
  await createSession(page);
  await rename(page, "Beta");
  await expect(activeName(page)).toHaveText("Beta");
  await page.keyboard.press("Control+Shift+E");
  await page.keyboard.press("k"); // up
  await page.keyboard.press("Enter");
  await expect(activeName(page)).toHaveText("Alpha");
});

test("use-worktree: pick a worktree and create the session", async ({
  page,
}) => {
  await gotoApp(page, {
    git: {
      root: "/home/test",
      branches: ["main", "feat"],
      worktrees: [
        { path: "/home/test", branch: "main", is_main: true },
        { path: "/home/test.feat", branch: "feat" },
      ],
    },
  });
  await page.keyboard.press("Control+Shift+N");
  await expect(page.getByRole("tab", { name: "Use Worktree" })).toBeVisible();
  await page.getByRole("button", { name: /feat/ }).click();
  await page.getByRole("button", { name: "Create session" }).click();
  await expect(
    page.getByRole("button", { name: "Close session" }),
  ).toHaveCount(1);
});

test("create-worktree base field suggests branches", async ({ page }) => {
  await gotoApp(page, {
    git: {
      root: "/home/test",
      branches: ["main", "dev"],
      worktrees: [{ path: "/home/test", branch: "main", is_main: true }],
    },
  });
  await page.keyboard.press("Control+Shift+N");
  await page.getByRole("tab", { name: "Create Worktree" }).click();
  await page.getByPlaceholder("my-new-branch").fill("x");
  await page.getByRole("button", { name: "Options" }).click();
  await page.getByPlaceholder("HEAD").click(); // the Base input
  await expect(page.getByText("dev", { exact: true })).toBeVisible();
});

test("collapsed fly-out hides only after a delay once the mouse leaves", async ({
  page,
}) => {
  await gotoApp(page);
  await page.keyboard.press("Control+Shift+B"); // collapse to the rail
  const list = page.locator("[data-session-list]");
  await expect(list).toBeHidden();

  await page.mouse.move(24, 300); // enter the rail -> fly-out opens
  await expect(list).toBeVisible();

  await page.mouse.move(900, 400); // leave
  await expect(list).toBeVisible(); // still open right after leaving
  await expect(list).toBeHidden({ timeout: 1500 }); // gone after the delay
});

test("re-entering the collapsed rail cancels the pending hide", async ({
  page,
}) => {
  await gotoApp(page);
  await page.keyboard.press("Control+Shift+B");
  const list = page.locator("[data-session-list]");

  await page.mouse.move(24, 300);
  await expect(list).toBeVisible();
  await page.mouse.move(900, 400); // leave -> hide scheduled
  await page.mouse.move(24, 300); // re-enter before it fires -> cancelled
  await page.waitForTimeout(350); // past the 200ms window
  await expect(list).toBeVisible();
});
