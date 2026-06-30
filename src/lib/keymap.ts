import { isMac } from "./platform";
import { useUI } from "@/store/ui";
import { addTerminal, splitPane } from "@/lib/launch";
import {
  closeActiveTerminal,
  closeAllTerminals,
  cycleTerminal,
  cycleSession,
  cyclePane,
  moveTerminal,
  moveSession,
} from "@/lib/actions";

export interface Combo {
  code: string; // KeyboardEvent.code, e.g. "KeyK", "BracketRight", "Tab"
  meta?: boolean;
  ctrl?: boolean;
  shift?: boolean;
  alt?: boolean;
}

export interface Shortcut {
  id: string;
  description: string;
  defaultCombo: Combo;
  run: () => void;
  // Handled inside the focused terminal (see TerminalPane), not the global
  // shortcut handler. Still listed/rebindable in the shortcuts panel; the
  // global handler skips it so the key reaches xterm.
  terminalOnly?: boolean;
  // Rate-limit OS key-repeat for actions that enqueue async UI/backend work.
  // Holding a key can still repeat, but queued repeat bursts won't all execute
  // after the UI catches up.
  repeatThrottleMs?: number;
}

const ui = () => useUI.getState();
const def = (mac: Combo, other: Combo): Combo => (isMac ? mac : other);

export const SHORTCUTS: Shortcut[] = [
  {
    id: "palette",
    description: "Command palette",
    defaultCombo: def(
      { code: "KeyK", meta: true },
      { code: "KeyP", ctrl: true, shift: true },
    ),
    run: () => ui().togglePalette(),
  },
  {
    id: "new-session",
    description: "New session",
    defaultCombo: def(
      { code: "KeyN", meta: true },
      { code: "KeyN", ctrl: true, shift: true },
    ),
    run: () => ui().openNewSession(),
    repeatThrottleMs: 500,
  },
  {
    id: "new-terminal",
    description: "New terminal",
    defaultCombo: def(
      { code: "KeyT", meta: true },
      { code: "KeyT", ctrl: true, shift: true },
    ),
    run: () => void addTerminal(),
    repeatThrottleMs: 500,
  },
  {
    id: "split-pane",
    description: "Split right",
    defaultCombo: def(
      { code: "KeyD", meta: true },
      { code: "KeyD", ctrl: true, shift: true },
    ),
    run: () => void splitPane(undefined, "row"),
    repeatThrottleMs: 500,
  },
  {
    id: "close-terminal",
    description: "Close terminal",
    defaultCombo: def(
      { code: "KeyW", meta: true },
      { code: "KeyW", ctrl: true, shift: true },
    ),
    run: () => closeActiveTerminal(),
    repeatThrottleMs: 500,
  },
  {
    id: "close-all-terminals",
    description: "Close all terminals",
    defaultCombo: def(
      { code: "KeyW", meta: true, shift: true },
      { code: "KeyW", ctrl: true, alt: true },
    ),
    run: () => closeAllTerminals(),
    repeatThrottleMs: 500,
  },
  {
    id: "terminal-copy",
    description: "Copy",
    terminalOnly: true,
    defaultCombo: def(
      { code: "KeyC", meta: true },
      { code: "KeyC", ctrl: true, shift: true },
    ),
    run: () => {},
  },
  {
    id: "terminal-paste",
    description: "Paste",
    terminalOnly: true,
    defaultCombo: def(
      { code: "KeyV", meta: true },
      { code: "KeyV", ctrl: true, shift: true },
    ),
    run: () => {},
  },
  {
    id: "terminal-copy-dedent",
    description: "Copy without indentation",
    terminalOnly: true,
    defaultCombo: def(
      { code: "KeyC", meta: true, alt: true },
      { code: "KeyC", ctrl: true, alt: true },
    ),
    run: () => {},
  },
  {
    id: "next-terminal",
    description: "Next terminal",
    defaultCombo: { code: "PageDown", ctrl: true },
    run: () => cycleTerminal(1),
  },
  {
    id: "prev-terminal",
    description: "Previous terminal",
    defaultCombo: { code: "PageUp", ctrl: true },
    run: () => cycleTerminal(-1),
  },
  {
    id: "next-session",
    description: "Next session",
    defaultCombo: def(
      { code: "PageDown", meta: true, alt: true },
      { code: "PageDown", ctrl: true, alt: true },
    ),
    run: () => cycleSession(1),
  },
  {
    id: "prev-session",
    description: "Previous session",
    defaultCombo: def(
      { code: "PageUp", meta: true, alt: true },
      { code: "PageUp", ctrl: true, alt: true },
    ),
    run: () => cycleSession(-1),
  },
  {
    id: "next-pane",
    description: "Next pane (split)",
    defaultCombo: def(
      { code: "BracketRight", meta: true, shift: true },
      { code: "BracketRight", ctrl: true, shift: true },
    ),
    run: () => cyclePane(1),
  },
  {
    id: "prev-pane",
    description: "Previous pane (split)",
    defaultCombo: def(
      { code: "BracketLeft", meta: true, shift: true },
      { code: "BracketLeft", ctrl: true, shift: true },
    ),
    run: () => cyclePane(-1),
  },
  {
    id: "move-terminal-right",
    description: "Move terminal right",
    defaultCombo: { code: "PageDown", ctrl: true, shift: true },
    run: () => moveTerminal(1),
  },
  {
    id: "move-terminal-left",
    description: "Move terminal left",
    defaultCombo: { code: "PageUp", ctrl: true, shift: true },
    run: () => moveTerminal(-1),
  },
  {
    id: "move-session-down",
    description: "Move session down",
    defaultCombo: def(
      { code: "PageDown", meta: true, alt: true, shift: true },
      { code: "PageDown", ctrl: true, alt: true, shift: true },
    ),
    run: () => moveSession(1),
  },
  {
    id: "move-session-up",
    description: "Move session up",
    defaultCombo: def(
      { code: "PageUp", meta: true, alt: true, shift: true },
      { code: "PageUp", ctrl: true, alt: true, shift: true },
    ),
    run: () => moveSession(-1),
  },
  {
    id: "focus-sessions",
    description: "Focus session list",
    defaultCombo: def(
      { code: "KeyE", meta: true, shift: true },
      { code: "KeyE", ctrl: true, shift: true },
    ),
    run: () => focusSessions(),
  },
  {
    id: "focus-terminal",
    description: "Focus current terminal",
    defaultCombo: def(
      { code: "KeyL", meta: true, shift: true },
      { code: "KeyL", ctrl: true, shift: true },
    ),
    run: () => ui().focusTerminal(),
  },
  {
    id: "toggle-sidebar",
    description: "Toggle sidebar",
    defaultCombo: def(
      { code: "KeyB", meta: true },
      { code: "KeyB", ctrl: true, shift: true },
    ),
    run: () => ui().toggleSidebar(),
  },
  {
    id: "notifications",
    description: "Notifications",
    defaultCombo: def(
      { code: "KeyO", meta: true, shift: true },
      { code: "KeyO", ctrl: true, shift: true },
    ),
    run: () => ui().openNotifications(),
  },
  {
    id: "app-menu",
    description: "App menu",
    defaultCombo: def(
      { code: "KeyM", meta: true, shift: true },
      { code: "KeyM", ctrl: true, shift: true },
    ),
    run: () => ui().toggleProfileMenu(),
  },
  {
    id: "settings",
    description: "Settings",
    defaultCombo: def({ code: "Comma", meta: true }, { code: "Comma", ctrl: true }),
    run: () => ui().openSettings(),
  },
  {
    id: "help",
    description: "Keyboard shortcuts",
    defaultCombo: def({ code: "Slash", meta: true }, { code: "Slash", ctrl: true }),
    run: () => {
      const s = useUI.getState();
      s.setHelpOpen(!s.helpOpen);
    },
  },
];

// Shown in the panel as fixed references (not rebindable).
export const STATIC_SHORTCUTS: { keys: string; description: string }[] = [
  { keys: isMac ? "⌘+ / ⌘- / ⌘0" : "Ctrl++ / Ctrl+- / Ctrl+0", description: "Zoom terminal in / out / reset" },
  { keys: isMac ? "⌘1–9" : "Alt+1–9", description: "Jump to terminal 1–9" },
  { keys: "↑ / ↓ or j / k", description: "Move between sessions (list focused)" },
  { keys: "Enter", description: "Open highlighted session" },
  { keys: "x", description: "Close highlighted session" },
  { keys: "Esc", description: "Back to terminal / close dialog" },
  { keys: "?", description: "This shortcuts panel" },
];

function focusSessions() {
  const find = () => document.querySelector<HTMLElement>("[data-session-list]");
  const el = find();
  if (el) el.focus();
  else {
    useUI.getState().toggleSidebar();
    setTimeout(() => find()?.focus(), 50);
  }
}

export function comboMatches(e: KeyboardEvent, c: Combo): boolean {
  return (
    e.code === c.code &&
    e.metaKey === !!c.meta &&
    e.ctrlKey === !!c.ctrl &&
    e.shiftKey === !!c.shift &&
    e.altKey === !!c.alt
  );
}

const CODE_LABEL: Record<string, string> = {
  Tab: "Tab",
  PageUp: "PgUp",
  PageDown: "PgDn",
  Comma: ",",
  Period: ".",
  Slash: "/",
  Backslash: "\\",
  BracketLeft: "[",
  BracketRight: "]",
  Backquote: "`",
  Minus: "-",
  Equal: "=",
  Space: "Space",
  Enter: "Enter",
  ArrowUp: "↑",
  ArrowDown: "↓",
  ArrowLeft: "←",
  ArrowRight: "→",
};

function codeLabel(code: string): string {
  if (CODE_LABEL[code]) return CODE_LABEL[code];
  if (code.startsWith("Key")) return code.slice(3);
  if (code.startsWith("Digit")) return code.slice(5);
  return code;
}

export function comboToString(c: Combo): string {
  const parts: string[] = [];
  if (isMac) {
    if (c.ctrl) parts.push("⌃");
    if (c.alt) parts.push("⌥");
    if (c.shift) parts.push("⇧");
    if (c.meta) parts.push("⌘");
    return parts.join("") + codeLabel(c.code);
  }
  if (c.ctrl) parts.push("Ctrl");
  if (c.alt) parts.push("Alt");
  if (c.shift) parts.push("Shift");
  if (c.meta) parts.push("Meta");
  parts.push(codeLabel(c.code));
  return parts.join("+");
}

const MOD_CODES = /^(Shift|Control|Alt|Meta|OS)(Left|Right)?$/;

/**
 * Build a Combo from a keydown while recording. Returns null until a real key
 * with at least one of ⌘/Ctrl/Alt is pressed (a bare key would clobber the
 * terminal, so we require a modifier).
 */
export function comboFromEvent(e: KeyboardEvent): Combo | null {
  if (MOD_CODES.test(e.code)) return null;
  if (!e.metaKey && !e.ctrlKey && !e.altKey) return null;
  return {
    code: e.code,
    meta: e.metaKey || undefined,
    ctrl: e.ctrlKey || undefined,
    shift: e.shiftKey || undefined,
    alt: e.altKey || undefined,
  };
}

export function matchJumpDigit(e: KeyboardEvent): number | null {
  const ok = isMac ? e.metaKey && !e.altKey : e.altKey && !e.ctrlKey;
  if (ok && /^Digit[1-9]$/.test(e.code)) return Number(e.code.slice(5)) - 1;
  return null;
}

// Terminal zoom. Uses the platform's primary modifier. Zoom IN ignores Shift so
// both Ctrl+= and Ctrl++ (Shift+=) work, like browsers/GNOME Terminal. Zoom OUT
// requires Shift to be UP: Ctrl+Shift+- is Ctrl+_ (e.g. emacs undo), which must
// reach the terminal. Not rebindable (the +/= Shift ambiguity doesn't fit the
// single-combo model).
export function matchZoom(e: KeyboardEvent): "in" | "out" | "reset" | null {
  const primary = isMac ? e.metaKey : e.ctrlKey;
  if (!primary || e.altKey) return null;
  switch (e.code) {
    case "Equal":
    case "NumpadAdd":
      return "in";
    case "Minus":
      return e.shiftKey ? null : "out";
    case "NumpadSubtract":
      return "out";
    case "Digit0":
    case "Numpad0":
      return "reset";
    default:
      return null;
  }
}
