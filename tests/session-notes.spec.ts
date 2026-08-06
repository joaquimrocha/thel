import { test } from "./app";
import { gotoApp, expect } from "./app";
import type { Page } from "@playwright/test";

async function createSession(page: Page) {
  await page.keyboard.press("Control+Shift+N");
  const create = page.getByRole("button", { name: "Create session" });
  await expect(create).toBeEnabled();
  await create.click();
}

const rows = (page: Page) => page.locator("[data-session-list] [data-row-id]");

async function openNotes(page: Page, row: ReturnType<typeof rows>) {
  await row.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Notes" }).click();
}

test("notes are written as markdown and render on save", async ({ page }) => {
  await gotoApp(page);
  await createSession(page);
  const panel = page.getByRole("dialog");

  await openNotes(page, rows(page).first());
  // A session with no notes opens straight into the editor.
  const editor = panel.getByRole("textbox");
  await expect(editor).toBeVisible();
  await editor.fill("## Plan\n\n- [ ] ship it");

  await panel.getByRole("button", { name: "Save" }).click();
  await expect(panel.getByText("Plan")).toBeVisible();
  const box = panel.getByRole("checkbox");
  await expect(box).not.toBeChecked();

  // Ticking a rendered checkbox writes the change back into the markdown.
  await box.check();
  await expect(box).toBeChecked();
  await panel.getByRole("button", { name: "Edit" }).click();
  await expect(editor).toHaveValue("## Plan\n\n- [x] ship it");
});

test("Enter continues a checklist and Ctrl+S saves", async ({ page }) => {
  await gotoApp(page);
  await createSession(page);
  const panel = page.getByRole("dialog");

  await openNotes(page, rows(page).first());
  const editor = panel.getByRole("textbox");
  await editor.fill("- [x] first");
  await editor.press("End");
  await editor.press("Enter");
  await editor.type("second");
  await expect(editor).toHaveValue("- [x] first\n- [ ] second");

  // Enter on the empty item that follows ends the list.
  await editor.press("Enter");
  await editor.press("Enter");
  await expect(editor).toHaveValue("- [x] first\n- [ ] second\n");

  await editor.press("Control+s");
  await expect(editor).toBeHidden();
  await expect(panel.getByRole("checkbox")).toHaveCount(2);

  // The rendered view takes focus on save, so Ctrl+Enter goes back to editing.
  await page.keyboard.press("Control+Enter");
  await expect(editor).toBeVisible();
});

test("Escape leaves the editor before it closes the panel", async ({ page }) => {
  await gotoApp(page);
  await createSession(page);
  const panel = page.getByRole("dialog");

  await openNotes(page, rows(page).first());
  const editor = panel.getByRole("textbox");
  await editor.fill("half a thought");

  await editor.press("Escape");
  await expect(editor).toBeHidden();
  await expect(panel).toBeVisible();

  await page.keyboard.press("Escape");
  await expect(panel).toBeHidden();
});

test("notes survive closing and reopening the panel", async ({ page }) => {
  await gotoApp(page);
  await createSession(page);
  const panel = page.getByRole("dialog");

  await openNotes(page, rows(page).first());
  await panel.getByRole("textbox").fill("remember this");
  // The shortcut is suppressed while an input has focus, so leave the editor
  // first; that is also how the panel behaves for real.
  await panel.getByRole("button", { name: "Save" }).click();
  await page.keyboard.press("Control+Alt+N");
  await expect(panel).toBeHidden();

  await page.keyboard.press("Control+Alt+N");
  await expect(panel.getByText("remember this")).toBeVisible();
  // The panel takes focus as it opens, so its keys work without a click first.
  await page.keyboard.press("Control+Enter");
  await expect(panel.getByRole("textbox")).toBeFocused();
});

test("closing a session takes its notes with it", async ({ page }) => {
  await gotoApp(page);
  await createSession(page);
  const panel = page.getByRole("dialog");

  await openNotes(page, rows(page).first());
  await panel.getByRole("textbox").fill("scratch");
  await panel.getByRole("button", { name: "Save" }).click();

  await rows(page).first().click({ button: "right" });
  await page.getByRole("menuitem", { name: "Close" }).click();
  await page.getByRole("button", { name: "Close session" }).click();
  await expect(rows(page)).toHaveCount(0);

  // A new session reuses no ids, so its notes start empty.
  await createSession(page);
  await openNotes(page, rows(page).first());
  await expect(panel.getByRole("textbox")).toHaveValue("");
});
