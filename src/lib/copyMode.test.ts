import { test, expect, describe } from "vitest";
import { step, selection, type Grid, type CopyModeState } from "./copyMode";

// A 10x3 viewport over 4 buffer rows (one row of scrollback).
const LINES = ["hello world", "  foo bar", "", "baz"];
const grid: Grid = {
  cols: 10,
  rows: 3,
  maxY: LINES.length - 1,
  line: (y) => LINES[y] ?? "",
};

const at = (x: number, y: number, anchor: CopyModeState["anchor"] = null) => ({
  x,
  y,
  anchor,
});
const key = (k: string, mods: Partial<KeyboardEvent> = {}) =>
  ({ key: k, ctrlKey: false, metaKey: false, ...mods }) as KeyboardEvent;

const moved = (s: CopyModeState, k: string, mods?: Partial<KeyboardEvent>) => {
  const r = step(s, key(k, mods), grid);
  if (r.kind !== "state") throw new Error(`expected state, got ${r.kind}`);
  return r.state;
};

describe("motions", () => {
  test("hjkl and arrows move one cell", () => {
    expect(moved(at(1, 1), "l")).toMatchObject({ x: 2, y: 1 });
    expect(moved(at(1, 1), "h")).toMatchObject({ x: 0, y: 1 });
    expect(moved(at(1, 1), "ArrowUp")).toMatchObject({ x: 1, y: 0 });
    expect(moved(at(1, 1), "ArrowDown")).toMatchObject({ x: 1, y: 2 });
  });

  test("motions clamp to the buffer instead of wrapping", () => {
    expect(moved(at(0, 0), "h")).toMatchObject({ x: 0, y: 0 });
    expect(moved(at(0, 0), "k")).toMatchObject({ x: 0, y: 0 });
    expect(moved(at(9, 3), "l")).toMatchObject({ x: 9, y: 3 });
    expect(moved(at(0, 3), "j")).toMatchObject({ x: 0, y: 3 });
  });

  test("0 and $ jump to the row's first and last non-blank column", () => {
    expect(moved(at(4, 1), "0")).toMatchObject({ x: 0, y: 1 });
    // "  foo bar" ends at column 8.
    expect(moved(at(0, 1), "$")).toMatchObject({ x: 8, y: 1 });
    // A blank row has no last column; stay at 0 rather than going negative.
    expect(moved(at(5, 2), "$")).toMatchObject({ x: 0, y: 2 });
  });

  test("g and G jump to the top and bottom of the scrollback", () => {
    expect(moved(at(4, 2), "g")).toMatchObject({ x: 0, y: 0 });
    expect(moved(at(4, 0), "G")).toMatchObject({ x: 0, y: 3 });
  });

  test("paging is bounded by the buffer", () => {
    expect(moved(at(0, 3), "PageUp")).toMatchObject({ y: 0 });
    expect(moved(at(0, 0), "PageDown")).toMatchObject({ y: 3 });
    expect(moved(at(0, 0), "d", { ctrlKey: true })).toMatchObject({ y: 1 });
    expect(moved(at(0, 3), "u", { ctrlKey: true })).toMatchObject({ y: 2 });
  });
});

describe("word motions", () => {
  test("w walks to the next word, crossing rows", () => {
    // "hello world" -> from 'h' to 'w'
    expect(moved(at(0, 0), "w")).toMatchObject({ x: 6, y: 0 });
    // Past the last word of a row, land on the next row's first word.
    expect(moved(at(6, 0), "w")).toMatchObject({ x: 2, y: 1 });
    // Blank rows are skipped on the way.
    expect(moved(at(6, 1), "w")).toMatchObject({ x: 0, y: 3 });
  });

  test("b walks back to the start of the previous word", () => {
    expect(moved(at(6, 0), "b")).toMatchObject({ x: 0, y: 0 });
    // From the start of a row, back across the row boundary.
    expect(moved(at(2, 1), "b")).toMatchObject({ x: 6, y: 0 });
    // Mid-word goes to that word's own start, like vi.
    expect(moved(at(8, 0), "b")).toMatchObject({ x: 6, y: 0 });
  });

  test("word motions stop at the buffer edges", () => {
    expect(moved(at(0, 0), "b")).toMatchObject({ x: 0, y: 0 });
    expect(moved(at(2, 3), "w")).toMatchObject({ y: 3 });
  });
});

describe("selection", () => {
  test("without an anchor it is the single cell under the cursor", () => {
    expect(selection(at(3, 2), 10)).toEqual({ column: 3, row: 2, length: 1 });
  });

  test("an anchor selects the inclusive run, in either direction", () => {
    expect(selection(at(5, 1, { x: 2, y: 1 }), 10)).toEqual({
      column: 2,
      row: 1,
      length: 4,
    });
    // Cursor before the anchor: same run.
    expect(selection(at(2, 1, { x: 5, y: 1 }), 10)).toEqual({
      column: 2,
      row: 1,
      length: 4,
    });
    // Across rows the run wraps, which is what term.select() expects.
    expect(selection(at(1, 2, { x: 8, y: 0 }), 10)).toEqual({
      column: 8,
      row: 0,
      length: 14,
    });
  });

  test("Space toggles the anchor at the cursor", () => {
    const anchored = moved(at(4, 1), " ");
    expect(anchored.anchor).toEqual({ x: 4, y: 1 });
    expect(moved(anchored, "v").anchor).toBeNull();
  });
});

describe("exits", () => {
  test("Escape and q leave, Enter and y copy", () => {
    expect(step(at(0, 0), key("Escape"), grid).kind).toBe("exit");
    expect(step(at(0, 0), key("q"), grid).kind).toBe("exit");
    expect(step(at(0, 0), key("Enter"), grid).kind).toBe("copy");
    expect(step(at(0, 0), key("y"), grid).kind).toBe("copy");
  });

  test("unknown keys are swallowed, never passed to the program", () => {
    expect(step(at(0, 0), key("z"), grid).kind).toBe("ignore");
    expect(step(at(0, 0), key("a", { ctrlKey: true }), grid).kind).toBe("ignore");
  });
});
