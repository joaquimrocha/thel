import { test } from "./app";
import { gotoApp, expect } from "./app";
import type { Page } from "@playwright/test";

async function openNew(page: Page) {
  await page.keyboard.press("Control+Shift+N");
  await expect(
    page.getByText("Anchor a session to a folder or git worktree."),
  ).toBeVisible();
}

const gitRepo = {
  root: "/home/test",
  branches: ["main", "dev"],
  worktrees: [{ path: "/home/test", branch: "main", is_main: true }],
};

test("a non-git folder shows the plain-folder hint and can be created", async ({
  page,
}) => {
  await gotoApp(page);
  await openNew(page);
  await expect(page.getByText("Not a git repository.")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Create session" }),
  ).toBeEnabled();
});

test("creating a session focuses its new terminal", async ({ page }) => {
  await gotoApp(page);
  await openNew(page);
  await page.getByRole("button", { name: "Create session" }).click();
  // The terminal takes keyboard focus instead of the dialog handing it back to
  // the trigger, so you can type immediately.
  await expect(page.locator(".xterm-helper-textarea")).toBeFocused();
});

test("a missing folder shows not-found and blocks create", async ({ page }) => {
  await gotoApp(page, { dirExists: false });
  await openNew(page);
  await expect(page.getByText("Folder not found.")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Create session" }),
  ).toBeDisabled();
});

test("a git repo shows the worktree tabs", async ({ page }) => {
  await gotoApp(page, { git: gitRepo });
  await openNew(page);
  await expect(page.getByText("Git repository")).toBeVisible();
  await expect(page.getByRole("tab", { name: "Use Worktree" })).toBeVisible();
  await expect(page.getByRole("tab", { name: "Create Worktree" })).toBeVisible();
});

test("create a worktree-backed session calls create_worktree", async ({
  page,
}) => {
  await gotoApp(page, { git: gitRepo });
  await openNew(page);
  await page.getByRole("tab", { name: "Create Worktree" }).click();
  await page.getByPlaceholder("my-new-branch").fill("feature");
  await page.getByRole("button", { name: "Create session" }).click();
  await expect(page.getByText("No sessions open.")).toBeHidden();
  const created = await page.evaluate(
    () => (window as Record<string, any>).__MOCK__.created?.length || 0,
  );
  expect(created).toBe(1);
});

test("a duplicate branch is blocked in the create-worktree tab", async ({
  page,
}) => {
  await gotoApp(page, { git: gitRepo });
  await openNew(page);
  await page.getByRole("tab", { name: "Create Worktree" }).click();
  await page.getByPlaceholder("my-new-branch").fill("dev");
  await expect(page.getByText(/already exists/)).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Create session" }),
  ).toBeDisabled();
});

test("directory autocomplete shows suggestions while typing", async ({
  page,
}) => {
  await gotoApp(page, {
    completeDir: ["/home/test/projects", "/home/test/photos"],
  });
  await openNew(page);
  const path = page.getByPlaceholder("/path/to/folder");
  await path.click();
  await path.fill("/home/test/p");
  await expect(page.getByText(/projects/).first()).toBeVisible();
});

test("Enter selects the highlighted folder completion", async ({ page }) => {
  await gotoApp(page, {
    completeDir: ["/home/test/projects", "/home/test/photos"],
  });
  await openNew(page);
  const path = page.getByPlaceholder("/path/to/folder");
  await path.click();
  await path.fill("/home/test/p");
  await expect(page.getByText(/projects/).first()).toBeVisible();

  await path.press("Enter");
  // Picks the highlighted folder (with a trailing slash) instead of creating
  // the session, so the dialog stays open.
  await expect(path).toHaveValue(/projects\/$/);
  await expect(
    page.getByText("Anchor a session to a folder or git worktree."),
  ).toBeVisible();
});
