import type { Terminal } from "@xterm/xterm";

// Dev-only read access to terminal contents for the end-to-end suite
// (tests-e2e/). The WebGL renderer draws to a canvas, so the text is not in the
// DOM for WebDriver to read.
const terminals = import.meta.env.DEV ? new Map<string, Terminal>() : null;

/** Makes a terminal's buffer readable through `window.__AUTOMATION__` (dev builds only). */
export function registerTerminal(id: string, term: Terminal) {
  terminals?.set(id, term);
}

/** Drops a terminal registered with registerTerminal. */
export function unregisterTerminal(id: string) {
  terminals?.delete(id);
}

function bufferText(term: Terminal): string {
  const buf = term.buffer.active;
  const lines: string[] = [];
  for (let i = 0; i < buf.length; i++) {
    lines.push(buf.getLine(i)?.translateToString(true) ?? "");
  }
  return lines.join("\n");
}

if (terminals) {
  (window as unknown as { __AUTOMATION__: unknown }).__AUTOMATION__ = {
    terminals: () =>
      Object.fromEntries([...terminals].map(([id, t]) => [id, bufferText(t)])),
  };
}
