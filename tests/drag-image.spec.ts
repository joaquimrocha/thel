import { test, gotoApp, expect } from "./app";
import type { Page } from "@playwright/test";

// The drag image is composited by the OS, so its rendered size is not
// observable from the page. What is observable is the element handed to
// setDragImage: record it at dragstart and measure that instead.
async function recordDragImage(page: Page) {
  await page.evaluate(() => {
    const w = window as unknown as { __dragImg?: unknown };
    const real = DataTransfer.prototype.setDragImage;
    DataTransfer.prototype.setDragImage = function (img, x, y) {
      const el = img as HTMLElement;
      const r = el.getBoundingClientRect();
      w.__dragImg = { w: r.width, h: r.height, x, y, dpr: window.devicePixelRatio };
      return real.call(this, img, x, y);
    };
  });
}

const readDragImage = (page: Page) =>
  page.evaluate(
    () =>
      (window as unknown as {
        __dragImg: { w: number; h: number; x: number; y: number; dpr: number };
      }).__dragImg,
  );

const layout = {
  activeSessionId: "s0",
  sessions: ["s0", "s1"].map((id) => ({
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

// Drag a session row and report the drag image's box against the row's own.
async function dragRow(page: Page) {
  const row = page.locator("[data-row-id='s0']");
  const box = (await row.boundingBox())!;
  await recordDragImage(page);
  const dt = await page.evaluateHandle(() => new DataTransfer());
  // Grab the row at its centre, so the recorded anchor is meaningful.
  await row.dispatchEvent("dragstart", {
    dataTransfer: dt,
    clientX: box.x + box.width / 2,
    clientY: box.y + box.height / 2,
  });
  await row.dispatchEvent("dragend", { dataTransfer: dt });
  return { box, img: await readDragImage(page) };
}

test("the drag image matches the row's size on a 1x display", async ({ page }) => {
  await open(page);
  const { box, img } = await dragRow(page);
  expect(img.dpr).toBe(1);
  expect(img.w).toBeCloseTo(box.width, 0);
  expect(img.h).toBeCloseTo(box.height, 0);
});

test.describe("on a HiDPI display", () => {
  test.use({ deviceScaleFactor: 2 });

  test("the drag image is pre-shrunk so it is not drawn double size", async ({
    page,
  }) => {
    await open(page);
    const { box, img } = await dragRow(page);
    expect(img.dpr).toBe(2);
    // The browser snapshots in device pixels and draws back without dividing,
    // so handing it a half-size element yields one the size of the row.
    expect(img.w).toBeCloseTo(box.width / 2, 0);
    expect(img.h).toBeCloseTo(box.height / 2, 0);
    // The cursor anchor shrinks with it, so it stays at the same point of the
    // dragged copy rather than sliding towards its top-left.
    expect(img.x).toBeCloseTo(img.w / 2, 0);
  });
});
