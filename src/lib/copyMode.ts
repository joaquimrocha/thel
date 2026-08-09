/**
 * Keyboard copy mode: move a cursor over the terminal's buffer and select text
 * without a mouse. Pure state so the motions are unit-testable; TerminalPane
 * feeds it a Grid over xterm's buffer and renders the result with
 * `term.select()`.
 *
 * With no anchor set, the "selection" is the single cell under the cursor, so
 * xterm's own selection highlight doubles as the copy-mode cursor. That's why
 * there is no custom cursor rendering anywhere.
 *
 * Rows are absolute buffer rows (scrollback included), the same coordinates
 * `term.select()` and `buffer.getLine()` take.
 */

export interface Grid {
  cols: number;
  rows: number;
  /** Last valid absolute row. */
  maxY: number;
  /** Text of an absolute row; may be shorter than `cols` (trailing blanks trimmed). */
  line(y: number): string;
}

export interface CopyModeState {
  x: number;
  y: number;
  anchor: { x: number; y: number } | null;
}

export type StepResult =
  | { kind: "state"; state: CopyModeState }
  | { kind: "copy" }
  | { kind: "exit" }
  /** Key belongs to copy mode's namespace but does nothing; swallow it. */
  | { kind: "ignore" };

const isWord = (c: string | undefined) => !!c && c !== " ";

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

/** Column of the last non-blank character on the row (0 when the row is blank). */
function lineEnd(g: Grid, y: number): number {
  return clamp(g.line(y).replace(/\s+$/, "").length - 1, 0, g.cols - 1);
}

function nextWord(s: CopyModeState, g: Grid): CopyModeState {
  let { x, y } = s;
  const at = () => g.line(y)[x];
  const adv = () => {
    if (x + 1 < g.cols) x++;
    else if (y + 1 <= g.maxY) (y++, (x = 0));
    else return false;
    return true;
  };
  while (isWord(at()) && adv());
  while (!isWord(at()) && adv());
  return { ...s, x, y };
}

function prevWord(s: CopyModeState, g: Grid): CopyModeState {
  let { x, y } = s;
  const at = () => g.line(y)[x];
  const back = () => {
    if (x > 0) x--;
    else if (y > 0) (y--, (x = g.cols - 1));
    else return false;
    return true;
  };
  if (!back()) return { ...s, x: 0 };
  while (!isWord(at())) if (!back()) return { ...s, x, y };
  // On a word character: walk back to that word's first column.
  for (;;) {
    const px = x;
    const py = y;
    if (!back()) return { ...s, x, y };
    if (!isWord(at())) return { ...s, x: px, y: py };
  }
}

function moveTo(s: CopyModeState, g: Grid, x: number, y: number): StepResult {
  return {
    kind: "state",
    state: { ...s, x: clamp(x, 0, g.cols - 1), y: clamp(y, 0, g.maxY) },
  };
}

/**
 * Apply one keypress. Returns the next state, or that the mode should copy the
 * current selection or exit. Every result means the key was consumed: copy mode
 * owns the keyboard while it's on, so nothing leaks through to the program.
 */
export function step(s: CopyModeState, e: KeyboardEvent, g: Grid): StepResult {
  const half = Math.max(1, Math.floor(g.rows / 2));
  const ctrl = e.ctrlKey || e.metaKey;

  if (ctrl) {
    switch (e.key) {
      case "u":
        return moveTo(s, g, s.x, s.y - half);
      case "d":
        return moveTo(s, g, s.x, s.y + half);
      case "b":
        return moveTo(s, g, s.x, s.y - g.rows);
      case "f":
        return moveTo(s, g, s.x, s.y + g.rows);
    }
    // Other modified keys (app shortcuts) already ran in the global capture
    // handler; don't let them read as motions.
    return { kind: "ignore" };
  }

  switch (e.key) {
    case "Escape":
    case "q":
      return { kind: "exit" };
    case "Enter":
    case "y":
      return { kind: "copy" };
    case " ":
    case "v":
      return {
        kind: "state",
        state: { ...s, anchor: s.anchor ? null : { x: s.x, y: s.y } },
      };
    case "ArrowLeft":
    case "h":
      return moveTo(s, g, s.x - 1, s.y);
    case "ArrowRight":
    case "l":
      return moveTo(s, g, s.x + 1, s.y);
    case "ArrowUp":
    case "k":
      return moveTo(s, g, s.x, s.y - 1);
    case "ArrowDown":
    case "j":
      return moveTo(s, g, s.x, s.y + 1);
    case "PageUp":
      return moveTo(s, g, s.x, s.y - g.rows);
    case "PageDown":
      return moveTo(s, g, s.x, s.y + g.rows);
    case "Home":
    case "0":
      return moveTo(s, g, 0, s.y);
    case "End":
    case "$":
      return moveTo(s, g, lineEnd(g, s.y), s.y);
    case "g":
      return moveTo(s, g, 0, 0);
    case "G":
      return moveTo(s, g, 0, g.maxY);
    case "w":
      return { kind: "state", state: nextWord(s, g) };
    case "b":
      return { kind: "state", state: prevWord(s, g) };
    default:
      return { kind: "ignore" };
  }
}

/**
 * Arguments for `term.select(column, row, length)`: the run from the anchor to
 * the cursor, inclusive, in either direction. Without an anchor it's the one
 * cell under the cursor.
 */
export function selection(
  s: CopyModeState,
  cols: number,
): { column: number; row: number; length: number } {
  const cur = s.y * cols + s.x;
  const anc = s.anchor ? s.anchor.y * cols + s.anchor.x : cur;
  const lo = Math.min(anc, cur);
  const hi = Math.max(anc, cur);
  return { column: lo % cols, row: Math.floor(lo / cols), length: hi - lo + 1 };
}
