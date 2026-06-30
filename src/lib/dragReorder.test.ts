import { test, expect, describe } from "vitest";
import { reorderIndex } from "./dragReorder";

// Items [a,b,c,d], indices 0..3. `after` = pointer past the item's midpoint.
describe("reorderIndex", () => {
  test("dragging earlier item forward past a later item's midpoint", () => {
    // Drag a(0) over c(2), past its midpoint → lands after c, adjusted for a's
    // removal: index 2.
    expect(reorderIndex(0, 2, true)).toBe(2);
    // Before c's midpoint → lands before c, adjusted: index 1.
    expect(reorderIndex(0, 2, false)).toBe(1);
  });

  test("dragging later item backward past an earlier item's midpoint", () => {
    // Drag d(3) over b(1), before its midpoint → index 1 (no removal shift,
    // since from > to).
    expect(reorderIndex(3, 1, false)).toBe(1);
    // Past b's midpoint → index 2.
    expect(reorderIndex(3, 1, true)).toBe(2);
  });

  test("hovering the item's own slot is a no-op relative to from", () => {
    // Over the neighbour just after `from`, before its midpoint → stays put.
    expect(reorderIndex(1, 2, false)).toBe(1);
  });

  test("dropping at the very end", () => {
    expect(reorderIndex(0, 3, true)).toBe(3);
  });
});
