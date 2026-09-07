import { test, gotoApp, expect } from "./app";
import type { Page } from "@playwright/test";

// Reordering slides the rows over 150ms. A drag reorders on every pointer move,
// so a second reorder routinely lands while the first is still sliding. The
// rows must carry on from where they visually are: snapping them to a position
// they have not reached yet is the jump this guards against.
const layout = {
  activeSessionId: "s0",
  sessions: ["s0", "s1", "s2", "s3"].map((id) => ({
    id,
    name: id,
    cwd: "/home/u",
    groups: [
      {
        id: `g-${id}`,
        activeTerminalId: `t-${id}`,
        terminals: [{ id: `t-${id}`, title: "shell", command: "bash", args: [] }],
      },
    ],
    layout: { t: "leaf", group: `g-${id}` },
    activeGroupId: `g-${id}`,
  })),
};

async function open(page: Page) {
  await page.addInitScript((l) => {
    localStorage.setItem("__store__thel-layout.json", JSON.stringify({ layout: l }));
  }, layout);
  await gotoApp(page);
}

const rows = (page: Page) => page.locator("[data-session-list] [data-row-id]");

// Drag over the bottom of a row, which asks for the drop to land after it.
async function over(page: Page, dt: unknown, id: string) {
  const row = page.locator(`[data-row-id='${id}']`);
  const box = (await row.boundingBox())!;
  await row.dispatchEvent("dragover", {
    dataTransfer: dt,
    clientX: box.x + box.width / 2,
    clientY: box.y + box.height * 0.9,
  });
}

test("a reorder landing mid-slide picks up where the rows are", async ({ page }) => {
  await open(page);
  await expect(rows(page)).toHaveCount(4);

  const dragged = page.locator("[data-row-id='s0']");
  const dt = await page.evaluateHandle(() => new DataTransfer());
  await dragged.dispatchEvent("dragstart", { dataTransfer: dt });

  // First reorder starts the slide; interrupt it partway through.
  await over(page, dt, "s2");
  await page.waitForTimeout(60);

  // Both measurements have to happen in the page: a round trip from here takes
  // long enough for the 150ms slide to finish, which would read as a jump.
  const shift = await page.evaluate(
    async ({ dt }) => {
      const tops = () =>
        Object.fromEntries(
          [...document.querySelectorAll("[data-session-list] [data-row-id]")].map(
            (e) => [e.getAttribute("data-row-id")!, e.getBoundingClientRect().top],
          ),
        );
      const row = document.querySelector("[data-row-id='s3']") as HTMLElement;
      const r = row.getBoundingClientRect();
      const before = tops();
      row.dispatchEvent(
        new DragEvent("dragover", {
          bubbles: true,
          cancelable: true,
          dataTransfer: dt as DataTransfer,
          clientX: r.x + r.width / 2,
          clientY: r.y + r.height * 0.9,
        }),
      );
      // React handles a drag event asynchronously, so wait for the frame the
      // reorder and its FLIP pass land in.
      await new Promise((done) => requestAnimationFrame(() => done(null)));
      const after = tops();
      return Math.max(
        ...Object.keys(before).map((id) => Math.abs((after[id] ?? 0) - before[id])),
      );
    },
    { dt },
  );

  // One frame of slide is a couple of px. A row snapping to the layout spot it
  // has not reached is a whole row, 30px.
  expect(shift).toBeLessThan(4);

  await dragged.dispatchEvent("dragend", { dataTransfer: dt });
});

test("the slides settle with the rows in order and untransformed", async ({
  page,
}) => {
  await open(page);
  const dragged = page.locator("[data-row-id='s0']");
  const dt = await page.evaluateHandle(() => new DataTransfer());
  await dragged.dispatchEvent("dragstart", { dataTransfer: dt });
  await over(page, dt, "s3");
  await dragged.dispatchEvent("dragend", { dataTransfer: dt });

  await expect(rows(page)).toHaveText([/s1/, /s2/, /s3/, /s0/]);
  await expect
    .poll(async () =>
      page.$$eval("[data-session-list] [data-row-id]", (els) =>
        els.every((e) => {
          const t = getComputedStyle(e).transform;
          return t === "none" || t === "matrix(1, 0, 0, 1, 0, 0)";
        }),
      ),
    )
    .toBe(true);
});
