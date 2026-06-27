import { invoke } from "@tauri-apps/api/core";

// Coalesce a burst of in-app notifications into a single OS notification, so a
// command that bells repeatedly (or several terminals finishing at once) does
// not spam the desktop. Items arriving within this window are merged.
const DEBOUNCE_MS = 1200;

interface Target {
  sessionId: string;
  terminalId: string;
}

interface Item {
  title: string;
  body: string;
  target?: Target;
}

let buffer: Item[] = [];
let timer: number | undefined;

function send(summary: string, body: string, target?: Target) {
  // Sent by the Rust `notify` command (notify-rust over the session bus), which
  // works under WebKitGTK and inside a distrobox where the Web Notification API
  // does not. Best-effort: ignore failures (e.g. running outside Tauri).
  // The target lets a click jump to the right terminal.
  invoke("notify", {
    summary,
    body,
    sessionId: target?.sessionId,
    terminalId: target?.terminalId,
  }).catch(() => {});
}

// Notification bodies are parsed as Pango-style markup by most daemons (the
// body-markup capability), so untrusted text (terminal titles set by whatever
// runs in the terminal) must be escaped before it lands in a body. Summaries
// are plain text per the spec and need no escaping.
const escapeMarkup = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");

function flush() {
  const items = buffer;
  buffer = [];
  if (items.length === 0) return;

  if (items.length === 1) {
    send(items[0].title, items[0].body, items[0].target);
  } else {
    // Summarize, listing the most recent few so the desktop stays tidy. A click
    // jumps to the most recent terminal in the batch.
    const lines = items.slice(-4).map((i) => escapeMarkup(`${i.title}: ${i.body}`));
    send(
      `thel — ${items.length} notifications`,
      lines.join("\n"),
      items[items.length - 1].target,
    );
  }
}

/** Queue a desktop notification, debounced. No-op if the backend can't send. */
export function systemNotify(title: string, body: string, target?: Target) {
  buffer.push({ title, body, target });
  clearTimeout(timer);
  timer = window.setTimeout(flush, DEBOUNCE_MS);
}
