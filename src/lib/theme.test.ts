import { describe, expect, it } from "vitest";
import { TERMINAL_BG, TERMINAL_THEME } from "./theme";

type RGB = [number, number, number];

/** "#rrggbb" or "#rrggbbaa", composited over `under` when it has alpha. */
function parse(hex: string, under: RGB = [0, 0, 0]): RGB {
  const n = hex.replace("#", "");
  const c = [0, 2, 4].map((i) => parseInt(n.slice(i, i + 2), 16)) as RGB;
  const a = n.length === 8 ? parseInt(n.slice(6, 8), 16) / 255 : 1;
  return c.map((v, i) => v * a + under[i] * (1 - a)) as RGB;
}

// WCAG 2 relative luminance and contrast ratio.
function luminance(rgb: RGB): number {
  const [r, g, b] = rgb.map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: RGB, b: RGB): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

describe("terminal selection colours", () => {
  const bg = parse(TERMINAL_BG);
  const sel = parse(TERMINAL_THEME.selectionBackground!, bg);

  it("make the selection, and copy mode's one-cell cursor, stand out from the background", () => {
    // WCAG 1.4.11 asks 3:1 for UI components.
    expect(contrast(sel, bg)).toBeGreaterThanOrEqual(3);
  });

  it("keep selected text readable", () => {
    const fg = parse(TERMINAL_THEME.selectionForeground!);
    expect(contrast(fg, sel)).toBeGreaterThanOrEqual(4.5);
  });
});
