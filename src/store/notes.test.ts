if (typeof window === "undefined") {
  (globalThis as unknown as Record<string, unknown>).window = globalThis;
}

import { test, expect, describe, beforeEach, vi } from "vitest";
import { useNotes } from "./notes";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string, args: Record<string, unknown>) => {
    if (cmd === "read_note") {
      if (args.sessionId === "s-with-note") return "# My Note";
      if (args.sessionId === "s-empty") return "";
      throw new Error("not found");
    }
    return null;
  }),
}));

beforeEach(() => {
  useNotes.setState({ notes: {} });
});

describe("useNotes store", () => {
  test("setNote updates notes in store", () => {
    useNotes.getState().setNote("s1", "some content");
    expect(useNotes.getState().notes["s1"]).toBe("some content");
  });

  test("removeNote removes note from store", () => {
    useNotes.getState().setNote("s1", "some content");
    useNotes.getState().removeNote("s1");
    expect(useNotes.getState().notes["s1"]).toBeUndefined();
  });

  test("loadNote loads note from disk if not present", async () => {
    await useNotes.getState().loadNote("s-with-note");
    expect(useNotes.getState().notes["s-with-note"]).toBe("# My Note");
  });

  test("loadNote handles empty notes and missing files cleanly", async () => {
    await useNotes.getState().loadNote("s-empty");
    expect(useNotes.getState().notes["s-empty"]).toBe("");

    await useNotes.getState().loadNote("s-missing");
    expect(useNotes.getState().notes["s-missing"]).toBe("");
  });
});
