import type { ITheme } from "@xterm/xterm";
import { monospaceFont } from "./pty";

// GNOME Adwaita dark palette (full 16 ANSI colors) so colored program output
// looks like a modern system terminal rather than xterm's harsh defaults.
export const TERMINAL_BG = "#1e1e1e";

export const TERMINAL_THEME: ITheme = {
  background: TERMINAL_BG,
  foreground: "#ffffff",
  cursor: "#ffffff",
  cursorAccent: TERMINAL_BG,
  selectionBackground: "rgba(53, 132, 228, 0.30)",

  black: "#241f31",
  red: "#c01c28",
  green: "#2ec27e",
  yellow: "#f5c211",
  blue: "#3584e4",
  magenta: "#9841bb",
  cyan: "#2aa1b3",
  white: "#c0bfbc",

  brightBlack: "#5e5c64",
  brightRed: "#ed333b",
  brightGreen: "#57e389",
  brightYellow: "#f8e45c",
  brightBlue: "#78aeed",
  brightMagenta: "#c061cb",
  brightCyan: "#4fd2fd",
  brightWhite: "#f6f5f4",
};

export interface TermFont {
  fontFamily: string;
  fontSize: number;
}

// Web fonts fall back to whatever the system provides; the leading family is
// the GNOME monospace font resolved at runtime. The trailing symbol/emoji
// families give xterm's glyph atlas a per-glyph fallback for Nerd Font PUA
// icons (shell MOTDs, prompts) and emoji, which the code fonts lack -- without
// them those glyphs render blank, unlike a native terminal that gets fontconfig
// fallback for free.
const FALLBACK_STACK =
  '"Cascadia Code", "JetBrains Mono", "DejaVu Sans Mono", "Source Code Pro", "Symbols Nerd Font Mono", "Symbols Nerd Font", "Noto Color Emoji", monospace';

const DEFAULT_FONT: TermFont = { fontFamily: FALLBACK_STACK, fontSize: 14 };

let cached: TermFont = DEFAULT_FONT;

export function getTerminalFont(): TermFont {
  return cached;
}

// Zoom is a px offset from the resolved system font size, applied per terminal.
export const ZOOM_FONT_MIN = 6;
export const ZOOM_FONT_MAX = 40;

/** Clamp a zoom offset so base + offset stays in the legible font-size range. */
export function clampZoomOffset(offset: number): number {
  const base = cached.fontSize;
  return Math.max(ZOOM_FONT_MIN - base, Math.min(ZOOM_FONT_MAX - base, offset));
}

/** Effective terminal font size (px) for a given zoom offset. */
export function zoomedFontSize(offset: number): number {
  return Math.max(ZOOM_FONT_MIN, Math.min(ZOOM_FONT_MAX, cached.fontSize + offset));
}

/** Resolve (and cache) the system monospace font. Safe to call repeatedly. */
export async function loadTerminalFont(): Promise<TermFont> {
  try {
    const f = await monospaceFont();
    if (f && f.family) {
      // gsettings reports point size; CSS wants px (96/72 dpi ratio).
      const px = f.size_pt ? Math.round((f.size_pt * 96) / 72) : DEFAULT_FONT.fontSize;
      cached = {
        fontFamily: `"${f.family}", ${FALLBACK_STACK}`,
        fontSize: px,
      };
    }
  } catch {
    // Keep the fallback stack.
  }
  return cached;
}

// Warm the cache as soon as the app loads so the first terminal opens with the
// right font.
void loadTerminalFont();
