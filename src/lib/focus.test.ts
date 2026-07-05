import { test, expect } from "vitest";

// focus.ts registers window focus/blur listeners at import time, so give it a
// window (an EventTarget) before importing, then drive it with real events.
const win = new EventTarget();
(globalThis as unknown as { window: EventTarget }).window = win;
const { onFocusGained } = await import("./focus");

test("onFocusGained fires once per refocus and unsubscribe stops it", () => {
  let fired = 0;
  const off = onFocusGained(() => {
    fired++;
  });

  win.dispatchEvent(new Event("blur")); // focused: true -> false
  win.dispatchEvent(new Event("focus")); // false -> true: fires
  expect(fired).toBe(1);

  // A focus while already focused isn't a gain, so it doesn't re-fire.
  win.dispatchEvent(new Event("focus"));
  expect(fired).toBe(1);

  off();
  win.dispatchEvent(new Event("blur"));
  win.dispatchEvent(new Event("focus")); // unsubscribed: no fire
  expect(fired).toBe(1);
});
