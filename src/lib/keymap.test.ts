import { test, expect, describe } from "vitest";
import { matchZoom } from "./keymap";

// Minimal KeyboardEvent stand-in (matchZoom only reads code + modifier flags).
function key(
  code: string,
  mods: Partial<{ ctrl: boolean; shift: boolean; alt: boolean }> = {},
): KeyboardEvent {
  return {
    code,
    ctrlKey: mods.ctrl ?? false,
    shiftKey: mods.shift ?? false,
    altKey: mods.alt ?? false,
    metaKey: false,
  } as unknown as KeyboardEvent;
}

describe("matchZoom", () => {
  test("Ctrl+- zooms out, but Ctrl+Shift+- (Ctrl+_) passes through", () => {
    expect(matchZoom(key("Minus", { ctrl: true }))).toBe("out");
    expect(matchZoom(key("Minus", { ctrl: true, shift: true }))).toBeNull();
  });

  test("zoom in accepts Shift (Ctrl++ is Ctrl+Shift+=)", () => {
    expect(matchZoom(key("Equal", { ctrl: true }))).toBe("in");
    expect(matchZoom(key("Equal", { ctrl: true, shift: true }))).toBe("in");
  });

  test("Ctrl+0 resets; numpad minus still zooms out", () => {
    expect(matchZoom(key("Digit0", { ctrl: true }))).toBe("reset");
    expect(matchZoom(key("NumpadSubtract", { ctrl: true }))).toBe("out");
  });

  test("no primary modifier or Alt held means no zoom", () => {
    expect(matchZoom(key("Minus"))).toBeNull();
    expect(matchZoom(key("Minus", { ctrl: true, alt: true }))).toBeNull();
  });
});
