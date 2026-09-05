import { test, gotoApp, expect } from "./app";
import type { Page } from "@playwright/test";

// Two checkouts of one repo (the main one and a linked worktree) and a folder
// outside any repo.
const layout = {
  activeSessionId: "s0",
  sessions: [
    session("s0", "thel", "/work/thel"),
    session("s1", "feature", "/work/thel.feature"),
    session("s2", "notes", "/home/u/notes"),
  ],
};

function session(id: string, name: string, cwd: string) {
  return {
    id,
    name,
    cwd,
    groups: [
      {
        id: `g-${id}`,
        activeTerminalId: `t-${id}`,
        terminals: [{ id: `t-${id}`, title: "shell", command: "bash", args: [] }],
      },
    ],
    layout: { t: "leaf", group: `g-${id}` },
    activeGroupId: `g-${id}`,
  };
}

async function open(
  page: Page,
  grouping?: boolean,
  l: typeof layout = layout,
  branch?: string,
) {
  await page.addInitScript(
    ([l, g]) => {
      localStorage.setItem("__store__thel-layout.json", JSON.stringify({ layout: l }));
      if (g) localStorage.setItem("thel.groupSessionsByRepo", "1");
    },
    [l, grouping] as const,
  );
  await gotoApp(page, { git: { root: "/work/thel", branch } });
}

const rows = (page: Page) => page.locator("[data-session-list] [data-row-id]");
const header = (page: Page) => page.getByRole("button", { name: "thel repo" });
const group = (page: Page) => page.locator("[data-repo-group='/work/thel']");

test("off by default; the settings switch groups a repo's worktrees under it", async ({
  page,
}) => {
  await open(page);
  await expect(rows(page)).toHaveCount(3);
  await expect(header(page)).toHaveCount(0);

  await page.keyboard.press("Control+Comma");
  await page.getByRole("tab", { name: "Sessions" }).click();
  await page.getByLabel("Group sessions by repo").click();
  await page.keyboard.press("Escape");

  await expect(header(page)).toBeVisible();
  // Expanded: the sessions are visible, so no need for a count.
  await expect(header(page)).not.toContainText("2");
  await expect(group(page).locator("[data-row-id]")).toHaveText([/thel/, /feature/]);
  // The non-repo session stays a plain row after the groups.
  await expect(rows(page).last()).toContainText("notes");
  await expect(group(page).locator("[data-row-id='s2']")).toHaveCount(0);
});

test("folding a group hides its rows and shows a count; expanding drops it", async ({
  page,
}) => {
  await open(page, true);
  await expect(header(page)).toHaveAttribute("aria-expanded", "true");
  await expect(group(page)).not.toContainText("2");
  await header(page).click();
  await expect(header(page)).toHaveAttribute("aria-expanded", "false");
  await expect(group(page)).toContainText("2");
  await expect(rows(page)).toHaveCount(1);
  await expect(rows(page)).toContainText("notes");

  await page.reload();
  await expect(header(page)).toHaveAttribute("aria-expanded", "false");
  await expect(rows(page)).toHaveCount(1);
});

test("switching to a session in a folded group unfolds it", async ({ page }) => {
  await open(page, true);
  await header(page).click();
  await expect(rows(page)).toHaveCount(1);

  await page.keyboard.press("Control+Shift+P");
  await page
    .getByPlaceholder("Type a command or search sessions...")
    .fill("feature");
  await page.keyboard.press("Enter");

  await expect(header(page)).toHaveAttribute("aria-expanded", "true");
  await expect(rows(page)).toHaveCount(3);
  await expect(page.locator("[data-row-id='s1']")).toHaveClass(/bg-secondary/);
});

test("the icon rail keeps the grouped order", async ({ page }) => {
  // Interleaved: the non-repo session sits between the repo's two worktrees,
  // so grouping visibly reorders the list.
  await open(page, true, {
    activeSessionId: "s0",
    sessions: [
      session("s0", "thel", "/work/thel"),
      session("s2", "notes", "/home/u/notes"),
      session("s1", "feature", "/work/thel.feature"),
    ],
  });
  await expect(rows(page)).toHaveText([/thel/, /feature/, /notes/]);

  await page.keyboard.press("Control+Shift+B");
  const icons = page.locator("[data-session-rail] button");
  await expect(icons).toHaveCount(3);
  expect(
    await icons.evaluateAll((bs) => bs.map((b) => b.getAttribute("aria-label"))),
  ).toEqual(["thel", "feature", "notes"]);
  // A thin line separates the repo group from the ungrouped icons.
  await expect(
    page.locator("[data-session-rail] [role='separator']"),
  ).toHaveCount(1);
});

test("keyboard navigation skips the rows of a folded group", async ({ page }) => {
  await open(page, true);
  await header(page).click();
  await page.keyboard.press("Control+Shift+E");
  await page.keyboard.press("Enter");
  // The only visible row is the ungrouped session, so Enter lands there.
  await expect(page.locator("[data-row-id='s2']")).toHaveClass(/bg-secondary/);
});

test("cycling sessions skips a folded group instead of springing it open", async ({
  page,
}) => {
  await open(page, true, {
    activeSessionId: "s3",
    sessions: [
      session("s0", "thel", "/work/thel"),
      session("s1", "feature", "/work/thel.feature"),
      session("s2", "notes", "/home/u/notes"),
      session("s3", "other", "/home/u/other"),
    ],
  });
  await header(page).click();
  await expect(header(page)).toHaveAttribute("aria-expanded", "false");

  // From the last visible row, next wraps to the first visible row, not into
  // the folded group.
  await page.keyboard.press("Control+Alt+PageDown");
  await expect(page.locator("[data-row-id='s2']")).toHaveClass(/bg-secondary/);
  await expect(header(page)).toHaveAttribute("aria-expanded", "false");

  // And back the other way.
  await page.keyboard.press("Control+Alt+PageUp");
  await expect(page.locator("[data-row-id='s3']")).toHaveClass(/bg-secondary/);
  await expect(header(page)).toHaveAttribute("aria-expanded", "false");
});

test("cycling still works when every group is folded", async ({ page }) => {
  await open(page, true, {
    activeSessionId: "s0",
    sessions: [
      session("s0", "thel", "/work/thel"),
      session("s1", "feature", "/work/thel.feature"),
    ],
  });
  await header(page).click();
  await expect(rows(page)).toHaveCount(0);

  // Nothing is on screen to land on, so cycling falls back to the full list
  // and unfolds the group it lands in.
  await page.keyboard.press("Control+Alt+PageDown");
  await expect(header(page)).toHaveAttribute("aria-expanded", "true");
  await expect(page.locator("[data-row-id='s1']")).toHaveClass(/bg-secondary/);
});

test("a row hides the branch name when it matches, but keeps the branch icon", async ({
  page,
}) => {
  await open(
    page,
    true,
    {
      activeSessionId: "s0",
      sessions: [
        session("s0", "thel", "/work/thel"),
        session("s1", "thel.feature", "/work/thel.feature"),
      ],
    },
    "feature",
  );
  // s1's displayed name is "feature" (the group prefix dropped) and its
  // branch is also "feature": the icon still marks it as a branch, but the
  // name isn't repeated.
  const row = page.locator("[data-row-id='s1']");
  await expect(row.locator("[data-branch-icon]")).toBeVisible();
  await expect(row.locator("[data-branch-name]")).toHaveCount(0);

  // s0's branch is also "feature" but its name is "thel": still different,
  // so the branch line spells it out.
  const s0 = page.locator("[data-row-id='s0']");
  await expect(s0.locator("[data-branch-name]")).toHaveText("feature");
});

test("a grouped row drops the repo name its session is prefixed with", async ({
  page,
}) => {
  await open(page, true, {
    activeSessionId: "s0",
    sessions: [
      session("s0", "thel", "/work/thel"),
      session("s1", "thel.feature", "/work/thel.feature"),
      session("s2", "thel.notes", "/home/u/notes"),
    ],
  });
  // The header already says "thel", so only the part after it is left; the
  // session named exactly after the repo keeps its name, and an ungrouped one
  // is untouched.
  await expect(group(page).locator("[data-row-id]")).toHaveText([
    /^thel/,
    /^feature/,
  ]);
  await expect(rows(page).last()).toContainText("thel.notes");
});

test("a group's + button opens a new session anchored to its repo root", async ({
  page,
}) => {
  await open(page, true);
  await page.getByLabel("New session in thel").click({ force: true });
  await expect(
    page.getByText("Anchor a session to a folder or git worktree."),
  ).toBeVisible();
  await expect(page.getByPlaceholder("/path/to/folder")).toHaveValue("/work/thel/");
});

test("the sidebar menu toggles grouping and collapses the panel", async ({
  page,
}) => {
  await open(page);
  await expect(header(page)).toHaveCount(0);

  // Hovering the menu button is enough to reach the options.
  await page.getByRole("button", { name: "Sidebar menu" }).hover();
  const menu = page.getByRole("menu", { name: "Sidebar menu" });
  await expect(menu).toBeVisible();

  await menu.getByRole("switch", { name: "Group sessions by repo" }).click();
  await expect(header(page)).toBeVisible();

  await menu.getByRole("menuitem", { name: /Collapse sidebar/ }).click();
  await expect(page.locator("[data-session-list]")).toBeHidden();
});

test("Ctrl+Alt+B toggles the sidebar menu", async ({ page }) => {
  await open(page);
  const menu = page.getByRole("menu", { name: "Sidebar menu" });
  await expect(menu).toBeHidden();

  await page.keyboard.press("Control+Alt+B");
  await expect(menu).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(menu).toBeHidden();

  // The rail's menu takes over once the sidebar is collapsed.
  await page.keyboard.press("Control+Shift+B");
  await expect(page.locator("[data-session-list]")).toBeHidden();
  await page.keyboard.press("Control+Alt+B");
  await expect(menu).toBeVisible();
});
