// Pure ANSI/escape-sequence parsing shared by the mounted terminal pane (which
// also has xterm's own parser) and the background daemon listener (which only
// sees the raw byte stream). Kept dependency-free so both can use one copy and
// it can be unit-tested.

// Strips escape/control sequences; matches CSI, OSC and other ESC-introduced
// sequences so what's left is just printable content.
// eslint-disable-next-line no-control-regex
export const ESC_SEQ =
  /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[PX^_][^\x1b]*\x1b\\|[@-Z\\-_])/g;

// Whether a data chunk carries actual screen content (a printable character)
// rather than only control sequences. a multiplexer broadcasts a cursor-visibility update
// to every attached client whenever another client attaches; treating that as
// output would make every other terminal flag itself "finished".
export function hasVisibleOutput(data: string): boolean {
  for (const ch of data.replace(ESC_SEQ, "")) {
    const c = ch.codePointAt(0)!;
    if (c >= 0x20 && c !== 0x7f) return true;
  }
  return false;
}

// Explicit notification requests in raw output: OSC 9;body (iTerm2, what
// Claude Code emits), OSC 777;notify;title;body (rxvt), OSC 99;meta;body
// (kitty, minimal). Returns the message texts plus the data with those
// sequences removed, so their BEL terminators can't read as ring-the-bell.
export function oscNotifications(data: string): { texts: string[]; rest: string } {
  const texts: string[] = [];
  // eslint-disable-next-line no-control-regex
  const re =
    /\x1b\](?:9;([^\x07\x1b]*)|777;notify;([^\x07\x1b]*)|99;[^\x07\x1b;]*;([^\x07\x1b]*))(?:\x07|\x1b\\)/g;
  const rest = data.replace(re, (_m, m9, m777, m99) => {
    const text = (m9 ?? m777?.replace(";", ": ") ?? m99 ?? "").trim();
    if (text) texts.push(text);
    return "";
  });
  return { texts, rest };
}

// A program can put text on the clipboard with OSC 52 (`ESC ] 52 ; targets ;
// base64 BEL/ST`), which is how a remote shell copies through ssh. Only writes
// are honoured: a `?` payload asks the terminal to *read* the clipboard back,
// which would let anything on the far end of a connection exfiltrate it.
// Payloads above the cap are dropped rather than truncated, since half a
// base64 blob is not what anyone meant to copy.
const MAX_CLIPBOARD_B64 = 1024 * 1024;

// The last clipboard text a chunk asks for, or undefined. Later writes in one
// chunk win, matching how the clipboard itself behaves.
export function oscClipboardWrite(data: string): string | undefined {
  let text: string | undefined;
  // eslint-disable-next-line no-control-regex
  const re = /\x1b\]52;([^;\x07\x1b]*);([^\x07\x1b]*)(?:\x07|\x1b\\)/g;
  for (let m = re.exec(data); m; m = re.exec(data)) {
    const [, targets, payload] = m;
    // Targets name which selection to set; "c" (or the default) is the
    // clipboard. A primary-selection-only write has nowhere to go here.
    if (targets && !targets.includes("c")) continue;
    if (payload === "?" || payload.length > MAX_CLIPBOARD_B64) continue;
    try {
      const bytes = Uint8Array.from(atob(payload), (c) => c.charCodeAt(0));
      text = new TextDecoder().decode(bytes);
    } catch {
      // Not valid base64: ignore rather than paste garbage.
    }
  }
  return text;
}

// The last window/icon title set in a chunk via OSC 0 or OSC 2, or undefined.
// xterm's onTitleChange follows the same sequences for mounted terminals.
export function terminalTitleFromOutput(data: string): string | undefined {
  let title: string | undefined;
  const re = /\x1b\](?:0|2);([^\x07\x1b]*)(?:\x07|\x1b\\)/g;
  for (let m = re.exec(data); m; m = re.exec(data)) title = m[1];
  return title;
}
