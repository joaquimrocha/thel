import { test } from "./app";
import { gotoApp, expect, createSession } from "./app";

test("empty state points to the new-session shortcut, not Ctrl+K", async ({
  page,
}) => {
  await gotoApp(page);
  await expect(page.getByText("No sessions open.")).toBeVisible();
  await expect(page.getByText(/to start a session/)).toBeVisible();
  await expect(page.getByText("Ctrl+Shift+N", { exact: true })).toBeVisible();
  await expect(page.getByText("Ctrl+K")).toHaveCount(0);
});

test("palette opens the new-session dialog", async ({ page }) => {
  await gotoApp(page);
  await page.keyboard.press("Control+Shift+P");
  await page.getByText("New session…").click();
  await expect(
    page.getByText("Anchor a session to a folder or git worktree."),
  ).toBeVisible();
});

test("palette opens settings", async ({ page }) => {
  await gotoApp(page);
  await page.keyboard.press("Control+Shift+P");
  await page.getByText("Settings…").click();
  await expect(page.getByRole("tab", { name: "Appearance" })).toBeVisible();
});

test("palette opens the launchers manager", async ({ page }) => {
  await gotoApp(page);
  await page.keyboard.press("Control+Shift+P");
  await page.getByText("Launchers…").click();
  await expect(
    page.getByText(/A launcher opens a terminal that runs a command/),
  ).toBeVisible();
});

test("sidebar resize handle works with arrow keys", async ({ page }) => {
  await gotoApp(page);
  const handle = page.getByRole("separator", { name: "Resize sidebar" });
  await handle.focus();
  const before = Number(await handle.getAttribute("aria-valuenow"));
  await handle.press("ArrowRight");
  await expect(handle).toHaveAttribute("aria-valuenow", String(before + 16));
  await handle.press("ArrowLeft");
  await expect(handle).toHaveAttribute("aria-valuenow", String(before));
});

test("sidebar resize handle sits between the session list and the pane's +", async ({ page }) => {
  await gotoApp(page);
  await createSession(page);
  const sep = page.getByRole("separator", { name: "Resize sidebar" });
  const handle = await sep.boundingBox();
  const list = await page.locator("[data-session-list]").boundingBox();
  const plus = await page.getByRole("button", { name: "New terminal in this pane" }).first().boundingBox();
  expect(handle).not.toBeNull();
  expect(list).not.toBeNull();
  expect(plus).not.toBeNull();
  if (handle && list && plus) {
    expect(handle.x).toBeGreaterThanOrEqual(list.x + list.width);
    expect(plus.x).toBeGreaterThanOrEqual(handle.x + handle.width);
  }
  // Still on top of the terminal area it now overlaps.
  await sep.hover();
});

test("Ctrl+B toggles the sidebar's session list", async ({ page }) => {
  await gotoApp(page);
  await expect(page.locator("[data-session-list]")).toBeVisible();
  await page.keyboard.press("Control+Shift+B");
  await expect(page.locator("[data-session-list]")).toBeHidden();
  await page.keyboard.press("Control+Shift+B");
  await expect(page.locator("[data-session-list]")).toBeVisible();
});
