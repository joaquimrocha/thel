import { test, expect, describe, vi, afterEach } from "vitest";
import { matchZoom, type Combo, type Shortcut } from "./keymap";

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

describe("shortcut defaults", () => {
  // Defaults are picked per platform at module load, so each map is checked
  // against its own platform.
  const shortcutsFor = async (mac: boolean): Promise<Shortcut[]> => {
    vi.resetModules();
    vi.doMock("./platform", () => ({
      isMac: mac,
      isWindows: false,
      isLinux: !mac,
      runsDaemon: true,
    }));
    return (await import("./keymap")).SHORTCUTS;
  };

  afterEach(() => {
    vi.doUnmock("./platform");
    vi.resetModules();
  });

  // Compare modifiers, not the printed label: a collision is about the event
  // both bindings match.
  const combo = (c: Combo) =>
    [c.code, !!c.meta, !!c.ctrl, !!c.shift, !!c.alt].join("|");

  test.each([
    ["mac", true],
    ["other", false],
  ])("no two %s shortcuts claim the same combo", async (_name, mac) => {
    const seen = new Map<string, string>();
    const clashes: string[] = [];
    for (const s of await shortcutsFor(mac as boolean)) {
      const k = combo(s.defaultCombo);
      const other = seen.get(k);
      if (other) clashes.push(`${k}: ${other} vs ${s.id}`);
      else seen.set(k, s.id);
    }
    expect(clashes).toEqual([]);
  });
});
