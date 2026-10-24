if (typeof window === "undefined") {
  (globalThis as unknown as Record<string, unknown>).window = globalThis;
}

import { test, expect, describe, beforeEach, afterEach, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { useNotes } from "./notes";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string, args: Record<string, unknown>) => {
    if (cmd === "read_note") {
      if (args.sessionId === "s-with-note") return "# My Note";
      if (args.sessionId === "s-agent") return "old\nagent\n";
      // The backend reads a missing file as "", like an empty one.
      if (args.sessionId === "s-empty" || args.sessionId === "s-missing") return "";
      throw new Error("read failed");
    }
    return null;
  }),
}));

// Forgets what the store last saw on disk too, which it keeps outside its state.
beforeEach(() => {
  for (const id of ["s1", "s2", "s-agent"]) useNotes.getState().removeNote(id);
  useNotes.setState({ notes: {} });
  vi.mocked(invoke).mockClear();
});

// A failed assertion would otherwise leave fake timers on for the next test.
afterEach(() => {
  vi.useRealTimers();
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

  test("an append from thel session note keeps what the user has not saved yet", () => {
    vi.useFakeTimers();
    vi.mocked(invoke).mockClear();
    useNotes.setState({ notes: { s1: "old\n" } });
    useNotes.getState().setNote("s1", "old\ntyped");
    // The daemon appended to what was on disk.
    useNotes.getState().receiveNote("s1", "old\nagent\n", { kind: "append", text: "agent" });
    expect(useNotes.getState().notes["s1"]).toBe("old\ntyped\nagent\n");
    vi.runAllTimers();
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith("write_note", {
      sessionId: "s1",
      text: "old\ntyped\nagent\n",
      base: "old\nagent\n",
    });
  });

  test("a note thel session note changed with nothing unsaved is not written again", () => {
    vi.useFakeTimers();
    vi.mocked(invoke).mockClear();
    useNotes.setState({ notes: { s1: "old\n" } });
    useNotes.getState().receiveNote("s1", "old\nagent\n", { kind: "append", text: "agent" });
    useNotes.getState().receiveNote("s2", "new", { kind: "set", text: "new" });
    expect(useNotes.getState().notes).toEqual({ s1: "old\nagent\n", s2: "new" });
    vi.runAllTimers();
    expect(invoke).not.toHaveBeenCalled();
  });

  test("an append the loaded note already has is not added twice", async () => {
    vi.mocked(invoke).mockClear();
    // Read after the daemon saved the append, before its event came.
    await useNotes.getState().loadNote("s-agent");
    vi.useFakeTimers();
    useNotes.getState().receiveNote("s-agent", "old\nagent\n", { kind: "append", text: "agent" });
    expect(useNotes.getState().notes["s-agent"]).toBe("old\nagent\n");
    vi.runAllTimers();
    expect(invoke).not.toHaveBeenCalledWith("write_note", expect.anything());
  });

  test("an append the loaded note has is not added again after the user typed", async () => {
    await useNotes.getState().loadNote("s-agent");
    vi.useFakeTimers();
    useNotes.getState().setNote("s-agent", "old\nagent\ntyped");
    useNotes.getState().receiveNote("s-agent", "old\nagent\n", { kind: "append", text: "agent" });
    expect(useNotes.getState().notes["s-agent"]).toBe("old\nagent\ntyped");
    vi.runAllTimers();
    expect(invoke).toHaveBeenLastCalledWith("write_note", {
      sessionId: "s-agent",
      text: "old\nagent\ntyped",
      base: "old\nagent\n",
    });
  });

  test("a save that finds the daemon's append on disk leaves it, and the event merges", async () => {
    vi.useFakeTimers();
    useNotes.setState({ notes: { s1: "old\n" } });
    useNotes.getState().receiveNote("s1", "old\n", { kind: "set", text: "old\n" });
    vi.mocked(invoke).mockResolvedValueOnce("old\nagent\n");
    useNotes.getState().setNote("s1", "old\ntyped");
    await vi.advanceTimersByTimeAsync(400);
    useNotes.getState().receiveNote("s1", "old\nagent\n", { kind: "append", text: "agent" });
    expect(useNotes.getState().notes["s1"]).toBe("old\ntyped\nagent\n");
    await vi.runAllTimersAsync();
    expect(vi.mocked(invoke).mock.calls.map((c) => c[1])).toEqual([
      { sessionId: "s1", text: "old\ntyped", base: "old\n" },
      { sessionId: "s1", text: "old\ntyped\nagent\n", base: "old\nagent\n" },
    ]);
  });

  test("a save that finds the note changed outside thel goes over it", async () => {
    vi.useFakeTimers();
    useNotes.setState({ notes: { s1: "old\n" } });
    useNotes.getState().receiveNote("s1", "old\n", { kind: "set", text: "old\n" });
    vi.mocked(invoke).mockResolvedValueOnce("edited\n");
    useNotes.getState().setNote("s1", "old\ntyped");
    await vi.runAllTimersAsync();
    expect(vi.mocked(invoke).mock.calls.map((c) => c[1])).toEqual([
      { sessionId: "s1", text: "old\ntyped", base: "old\n" },
      { sessionId: "s1", text: "old\ntyped", base: "edited\n" },
    ]);
  });

  test("an append to a note not loaded here takes the daemon's text", () => {
    vi.useFakeTimers();
    vi.mocked(invoke).mockClear();
    useNotes.getState().receiveNote("s1", "disk\nagent\n", { kind: "append", text: "agent" });
    expect(useNotes.getState().notes["s1"]).toBe("disk\nagent\n");
    vi.runAllTimers();
    expect(invoke).not.toHaveBeenCalled();
  });

  test("a replace drops what the user has not saved and its pending write", () => {
    vi.useFakeTimers();
    vi.mocked(invoke).mockClear();
    useNotes.setState({ notes: { s1: "old" } });
    useNotes.getState().setNote("s1", "old typed");
    useNotes.getState().receiveNote("s1", "new", { kind: "set", text: "new" });
    expect(useNotes.getState().notes["s1"]).toBe("new");
    vi.runAllTimers();
    expect(invoke).not.toHaveBeenCalled();
  });

  test("a replace that lands while a save is on its way is not written over", async () => {
    vi.useFakeTimers();
    vi.mocked(invoke).mockClear();
    let saved = () => {};
    vi.mocked(invoke).mockImplementationOnce(() => new Promise<null>((r) => (saved = () => r(null))));
    useNotes.setState({ notes: { s1: "old" } });
    useNotes.getState().setNote("s1", "old typed");
    vi.runAllTimers();
    useNotes.getState().receiveNote("s1", "new", { kind: "set", text: "new" });
    saved();
    await vi.runAllTimersAsync();
    expect(vi.mocked(invoke).mock.calls.map((c) => c[1])).toEqual([
      { sessionId: "s1", text: "old typed", base: null },
    ]);
    expect(useNotes.getState().notes["s1"]).toBe("new");
  });

  test("loadNote leaves a failed read unset so it can retry", async () => {
    await useNotes.getState().loadNote("s-error");
    expect(useNotes.getState().notes["s-error"]).toBeUndefined();
  });
});
