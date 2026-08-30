import { test, expect, describe } from "vitest";
import { terminalDotState, sessionDotState } from "./StatusDot";
import type { Session, Terminal } from "@/store/sessions";

const term = (id: string, extra: Partial<Terminal> = {}): Terminal => ({
  id,
  title: id,
  command: "bash",
  args: [],
  ...extra,
});

const session = (terminals: Terminal[]): Session => ({
  id: "s1",
  name: "S1",
  groups: [{ id: "g1", terminals, activeTerminalId: terminals[0]?.id }],
  layout: { t: "leaf", group: "g1" },
  activeGroupId: "g1",
});

describe("a muted terminal doesn't pulse", () => {
  test("its own dot shows running, not busy", () => {
    expect(terminalDotState(term("t1", { busy: true }))).toBe("busy");
    expect(terminalDotState(term("t1", { busy: true, muted: true }))).toBe(
      "running",
    );
  });

  test("it doesn't pulse the session it belongs to", () => {
    expect(sessionDotState(session([term("t1", { busy: true })]))).toBe("busy");
    expect(
      sessionDotState(session([term("t1", { busy: true, muted: true })])),
    ).toBe("running");
  });

  test("an unmuted sibling still pulses the session", () => {
    const s = session([
      term("t1", { busy: true, muted: true }),
      term("t2", { busy: true }),
    ]);
    expect(sessionDotState(s)).toBe("busy");
  });
});
