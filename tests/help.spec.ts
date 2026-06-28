import { test } from "./app";
import { gotoApp, expect } from "./app";

test("shortcuts panel lists rebindable and fixed shortcuts", async ({
  page,
}) => {
  await gotoApp(page);
  await page.keyboard.press("Shift+Slash"); // "?"
  await expect(page.getByText("Command palette")).toBeVisible();
  await expect(page.getByText("Fixed")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Ctrl+Shift+P", exact: true }),
  ).toBeVisible();
});

test("rebind a shortcut and reset it", async ({ page }) => {
  await gotoApp(page);
  await page.keyboard.press("Shift+Slash");
  await page
    .getByRole("button", { name: "Ctrl+Shift+P", exact: true })
    .click();
  await expect(page.getByText("Press keys…")).toBeVisible();
  await page.keyboard.press("Control+Shift+J");
  await expect(
    page.getByRole("button", { name: "Ctrl+Shift+J", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Ctrl+Shift+P", exact: true }),
  ).toHaveCount(0);

  await page.getByRole("button", { name: "reset", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Ctrl+Shift+P", exact: true }),
  ).toBeVisible();
});
