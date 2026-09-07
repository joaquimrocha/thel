import { test, expect, describe } from "vitest";
import { dropAnchor, reorderIndex } from "./dragReorder";

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

// Units [a,b,c]; `edge` is identity here, so a unit's anchor is its own name.
describe("dropAnchor", () => {
  const units = ["a", "b", "c"];
  const edge = (u: string) => u;
  const drop = (from: number, over: number, after: boolean) =>
    dropAnchor(units, from, over, after, edge);

  test("lands before the unit whose top half the pointer is in", () => {
    // Drag a(0) over c(2), before c's midpoint → a goes just before c.
    expect(drop(0, 2, false)).toEqual({ anchorId: "c", after: false });
  });

  test("lands after the last unit when the pointer is past its midpoint", () => {
    expect(drop(0, 2, true)).toEqual({ anchorId: "c", after: true });
  });

  test("stays put next to its own neighbour, so a still pointer does not oscillate", () => {
    // a(0) over b(1): the near half of b is a's current slot, so nothing moves.
    expect(drop(0, 1, false)).toBeNull();
    // Past b's midpoint is the gap between b and c, named as "before c".
    expect(drop(0, 1, true)).toEqual({ anchorId: "c", after: false });
  });

  test("stays put over itself, whichever half", () => {
    expect(drop(1, 1, false)).toBeNull();
    expect(drop(1, 1, true)).toBeNull();
  });

  test("moves backwards past an earlier unit", () => {
    expect(drop(2, 0, false)).toEqual({ anchorId: "a", after: false });
    // Both of these name the same gap, between a and b.
    expect(drop(2, 0, true)).toEqual({ anchorId: "b", after: false });
    expect(drop(2, 1, false)).toEqual({ anchorId: "b", after: false });
    // And the far half of b is where c already is.
    expect(drop(2, 1, true)).toBeNull();
  });

  test("has nowhere to go when it is the only unit", () => {
    expect(dropAnchor(["a"], 0, 0, true, edge)).toBeNull();
  });
});
