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

async function openUsage(page: Page, row: ReturnType<typeof rows>) {
  await row.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Resource usage" }).click();
}

test("resource panel reports the session it was opened for", async ({
  page,
}) => {
  await gotoApp(page);
  await createSession(page);
  const panel = page.getByRole("dialog");

  await openUsage(page, rows(page).first());
  await expect(panel).toBeVisible();
  // A rate needs two samples; the first render shows "--" until the second.
  await expect(panel.getByText("%", { exact: false }).first()).toBeVisible();
});

test("Ctrl+Shift+R toggles the panel for the active session", async ({
  page,
}) => {
  await gotoApp(page);
  await createSession(page);
  const panel = page.getByRole("dialog");

  await page.keyboard.press("Control+Shift+R");
  await expect(panel).toBeVisible();
  await page.keyboard.press("Control+Shift+R");
  await expect(panel).toBeHidden();
});

test("opening the panel selects the session it reports", async ({ page }) => {
  await gotoApp(page);
  await createSession(page);
  await createSession(page);
  const [first, second] = [rows(page).nth(0), rows(page).nth(1)];

  // Sessions created this way share a name (both "~"), so identify the active
  // one by its row styling rather than by text.
  const activeRow = /text-secondary-foreground/;

  // Open it from the row that isn't active: the panel sits beside the session
  // it describes, so that session comes up with it.
  await second.click();
  await expect(second).toHaveClass(activeRow);
  await openUsage(page, first);
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(first).toHaveClass(activeRow);
});

test("resource panel closes when another session becomes active", async ({
  page,
}) => {
  await gotoApp(page);
  await createSession(page);
  await createSession(page);
  const panel = page.getByRole("dialog");
  const [first, second] = [rows(page).nth(0), rows(page).nth(1)];

  await openUsage(page, first);
  await expect(panel).toBeVisible();

  // Re-selecting the panel's own session is not "navigating away".
  await first.click();
  await expect(panel).toBeVisible();

  // A different session leaves the panel stale, so it closes.
  await second.click();
  await expect(panel).toBeHidden();
});

test("lists a terminal's listening ports and stops one", async ({ page }) => {
  await gotoApp(page, {
    ports: [
      { port: 5173, pid: 4242, name: "node" },
      { port: 8000, pid: 777, name: "python3" },
    ],
  });
  await createSession(page);
  const panel = page.getByRole("dialog");

  await page.keyboard.press("Control+Shift+R");
  const ports = panel.getByTestId("listen-port");
  await expect(ports).toHaveText([/localhost:5173.*node pid 4242/, /localhost:8000.*python3 pid 777/]);

  await panel.getByRole("button", { name: "Stop node (pid 4242)" }).click();
  await expect(ports).toHaveText([/:8000/]);
  const stopped = await page.evaluate(
    () => (window as never as { __MOCK__: { stopped: unknown[] } }).__MOCK__.stopped,
  );
  expect(stopped).toEqual([{ terminal: expect.any(String), pid: 4242 }]);
});

test("opens a listening port in the browser", async ({ page }) => {
  await gotoApp(page, { ports: [{ port: 5173, pid: 4242, name: "node" }] });
  await createSession(page);
  await page.keyboard.press("Control+Shift+R");

  await page.getByRole("button", { name: "localhost:5173" }).click();
  await expect
    .poll(() => page.evaluate(() => (window as never as { __MOCK__: { lastOpenedUrl?: string } }).__MOCK__.lastOpenedUrl))
    .toBe("http://localhost:5173");
});

test("a session with a listening port gets a button to its ports", async ({ page }) => {
  await gotoApp(page, {
    ports: [
      { port: 5173, pid: 4242, name: "node" },
      { port: 8000, pid: 777, name: "python3" },
    ],
  });
  await createSession(page);
  const button = rows(page).first().getByRole("button", { name: "Listening ports" });

  await expect(button).toBeVisible();
  // An icon only: the numbers are in the dialog it opens.
  await expect(button).toHaveText("");
  await button.click();
  await expect(page.getByRole("dialog").getByTestId("listen-port")).toHaveCount(2);
});

test("the ports button sits beside the notes mark, not in its place", async ({ page }) => {
  await gotoApp(page, { ports: [{ port: 5173, pid: 4242, name: "node" }] });
  await createSession(page);
  const row = rows(page).first();
  await row.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Notes" }).click();
  const panel = page.getByRole("dialog");
  await panel.getByRole("textbox").fill("todo");
  await panel.getByRole("button", { name: "Save" }).click();
  await panel.getByRole("button", { name: "Close" }).click();

  const badge = row.getByTestId("ports-indicator");
  const notes = row.getByTestId("notes-indicator");
  await expect(badge).toBeVisible();
  await expect(notes).toBeVisible();
  const [b, n] = [await badge.boundingBox(), await notes.boundingBox()];
  expect(b!.x + b!.width).toBeLessThanOrEqual(n!.x);
});

test("a session with no listening port has no ports button", async ({ page }) => {
  await gotoApp(page);
  await createSession(page);
  await expect(rows(page).first()).toBeVisible();
  await expect(page.getByTestId("ports-indicator")).toHaveCount(0);
});

test("a listening port's row shows the terminal running it", async ({ page }) => {
  await page.addInitScript(() => {
    const term = (id: string, title: string) => ({ id, title, command: "bash", args: [] });
    const layout = {
      activeSessionId: "s0",
      sessions: [
        {
          id: "s0",
          name: "app",
          cwd: "/home/test/app",
          groups: [{ id: "g0", activeTerminalId: "t1", terminals: [term("t0", "vite"), term("t1", "shell")] }],
          layout: { t: "leaf", group: "g0" },
          activeGroupId: "g0",
        },
      ],
    };
    if (!localStorage.getItem("__store__thel-layout.json"))
      localStorage.setItem("__store__thel-layout.json", JSON.stringify({ layout }));
  });
  await gotoApp(page, { ports: [{ port: 5173, pid: 4242, name: "node" }] });
  const tab = (id: string) => page.locator(`[data-tab-id="${id}"]`);
  await expect(tab("t1")).toHaveClass(/bg-secondary/);

  await page.keyboard.press("Control+Shift+R");
  // The mock reports the port on every terminal; the first row is vite's.
  await page.getByRole("button", { name: "Show the terminal running port 5173" }).first().click();
  await expect(tab("t0")).toHaveClass(/bg-secondary/);
});
