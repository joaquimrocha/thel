import { test, expect, describe } from "vitest";
import {
  hasVisibleOutput,
  oscNotifications,
  terminalTitleFromOutput,
} from "./ansi";

const ESC = "\x1b";
const BEL = "\x07";
const ST = "\x1b\\";

describe("hasVisibleOutput", () => {
  test("printable text counts", () => {
    expect(hasVisibleOutput("hello")).toBe(true);
    expect(hasVisibleOutput(`${ESC}[32mhi${ESC}[0m`)).toBe(true);
  });

  test("a wide/unicode glyph counts", () => {
    expect(hasVisibleOutput("😀")).toBe(true);
  });

  test("control-only chunks do not count", () => {
    expect(hasVisibleOutput("")).toBe(false);
    expect(hasVisibleOutput(BEL)).toBe(false);
    // A cursor-visibility broadcast (the backend sends this to every client on attach).
    expect(hasVisibleOutput(`${ESC}[?25h`)).toBe(false);
    expect(hasVisibleOutput(`${ESC}[2J${ESC}[H`)).toBe(false);
    // An OSC title change is not screen content on its own.
    expect(hasVisibleOutput(`${ESC}]0;title${BEL}`)).toBe(false);
  });

  test("whitespace-only control (space) counts as visible, DEL does not", () => {
    expect(hasVisibleOutput(" ")).toBe(true);
    expect(hasVisibleOutput("\x7f")).toBe(false);
  });
});

describe("oscNotifications", () => {
  test("OSC 9 body, BEL-terminated", () => {
    const { texts, rest } = oscNotifications(`${ESC}]9;build done${BEL}`);
    expect(texts).toEqual(["build done"]);
    // The terminator is stripped so it can't read as a bell.
    expect(rest).toBe("");
  });

  test("OSC 777;notify joins title and body with a colon", () => {
    const { texts } = oscNotifications(`${ESC}]777;notify;Title;Body${BEL}`);
    expect(texts).toEqual(["Title: Body"]);
  });

  test("OSC 99 takes the payload after the metadata field", () => {
    const { texts } = oscNotifications(`${ESC}]99;i=1;hello${BEL}`);
    expect(texts).toEqual(["hello"]);
  });

  test("ST-terminated sequences work too", () => {
    const { texts, rest } = oscNotifications(`${ESC}]9;msg${ST}`);
    expect(texts).toEqual(["msg"]);
    expect(rest).toBe("");
  });

  test("empty bodies are dropped, surrounding text preserved", () => {
    const { texts, rest } = oscNotifications(`a${ESC}]9;${BEL}b`);
    expect(texts).toEqual([]);
    expect(rest).toBe("ab");
  });

  test("multiple notifications in one chunk", () => {
    const { texts } = oscNotifications(
      `${ESC}]9;one${BEL}mid${ESC}]9;two${BEL}`,
    );
    expect(texts).toEqual(["one", "two"]);
  });

  test("leaves a lone BEL intact so it can still ring", () => {
    const { texts, rest } = oscNotifications(`work${BEL}`);
    expect(texts).toEqual([]);
    expect(rest.includes(BEL)).toBe(true);
  });
});

describe("terminalTitleFromOutput", () => {
  test("OSC 0 and OSC 2 both set the title", () => {
    expect(terminalTitleFromOutput(`${ESC}]0;my title${BEL}`)).toBe("my title");
    expect(terminalTitleFromOutput(`${ESC}]2;other${ST}`)).toBe("other");
  });

  test("the last title in a chunk wins", () => {
    expect(terminalTitleFromOutput(`${ESC}]0;a${BEL}${ESC}]2;b${BEL}`)).toBe("b");
  });

  test("no title sequence yields undefined", () => {
    expect(terminalTitleFromOutput("plain output")).toBeUndefined();
    // An OSC 9 notification is not a title.
    expect(terminalTitleFromOutput(`${ESC}]9;notif${BEL}`)).toBeUndefined();
  });
});
