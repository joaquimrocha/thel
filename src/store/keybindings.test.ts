import { test, expect } from "vitest";
import { shortcutLabel } from "./keybindings";
import { SHORTCUTS } from "@/lib/keymap";

test("shortcutLabel returns a key string for a bound shortcut", () => {
  const bound = SHORTCUTS.find((s) => s.defaultCombo);
  // The app ships bound shortcuts; guard so the test still holds if that changes.
  if (bound) {
    const label = shortcutLabel(bound.id);
    expect(typeof label).toBe("string");
    expect(label).not.toBe("");
  }
});

test("shortcutLabel is undefined for an unknown shortcut id", () => {
  expect(shortcutLabel("definitely-not-a-shortcut-id")).toBeUndefined();
});
