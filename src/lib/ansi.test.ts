import { test, expect, describe } from "vitest";
import {
  hasVisibleOutput,
  oscNotifications,
  scanClipboardWrites,
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

describe("scanClipboardWrites", () => {
  const b64 = (s: string) => btoa(String.fromCharCode(...new TextEncoder().encode(s)));
  // A single chunk, which is all most sequences ever need.
  const scan = (data: string) => scanClipboardWrites("", data);

  test("decodes a clipboard write, with either terminator", () => {
    expect(scan(`${ESC}]52;c;${b64("hello")}${BEL}`).text).toBe("hello");
    expect(scan(`${ESC}]52;c;${b64("hello")}${ST}`).text).toBe("hello");
  });

  test("an empty target list means the clipboard", () => {
    expect(scan(`${ESC}]52;;${b64("copied")}${BEL}`).text).toBe("copied");
  });

  test("ignores a read request, which would leak the clipboard back", () => {
    expect(scan(`${ESC}]52;c;?${BEL}`).text).toBeUndefined();
  });

  test("ignores a write aimed only at the primary selection", () => {
    expect(scan(`${ESC}]52;p;${b64("nope")}${BEL}`).text).toBeUndefined();
  });

  test("survives a payload that isn't valid base64", () => {
    expect(scan(`${ESC}]52;c;not base64!${BEL}`).text).toBeUndefined();
  });

  test("drops an oversized payload rather than truncating it", () => {
    const huge = "A".repeat(1024 * 1024 + 4);
    expect(scan(`${ESC}]52;c;${huge}${BEL}`).text).toBeUndefined();
  });

  test("keeps multibyte text intact", () => {
    expect(scan(`${ESC}]52;c;${b64("héllo ❤")}${BEL}`).text).toBe("héllo ❤");
  });

  test("the last write in a chunk wins", () => {
    const data = `${ESC}]52;c;${b64("first")}${BEL}x${ESC}]52;c;${b64("second")}${BEL}`;
    expect(scan(data).text).toBe("second");
  });

  test("plain output asks for nothing and carries nothing", () => {
    expect(scan("just text")).toEqual({ text: undefined, carry: "" });
    expect(scan(`${ESC}]0;title${BEL}`).text).toBeUndefined();
  });

  test("drops one trailing newline, so a paste can't self-execute", () => {
    expect(scan(`${ESC}]52;c;${b64("rm -rf /\n")}${BEL}`).text).toBe("rm -rf /");
    expect(scan(`${ESC}]52;c;${b64("rm -rf /\r\n")}${BEL}`).text).toBe("rm -rf /");
    // Only the last one: an intentionally copied blank line survives.
    expect(scan(`${ESC}]52;c;${b64("a\n\n")}${BEL}`).text).toBe("a\n");
  });

  describe("across chunk boundaries", () => {
    // Output arrives in 8 KB frames, so any copy over ~6 KB is split.
    const whole = `${ESC}]52;c;${b64("split payload")}${BEL}`;

    test("a sequence cut anywhere still copies", () => {
      for (let at = 1; at < whole.length; at++) {
        const first = scanClipboardWrites("", whole.slice(0, at));
        expect(first.text).toBeUndefined();
        expect(scanClipboardWrites(first.carry, whole.slice(at)).text).toBe(
          "split payload",
        );
      }
    });

    test("a sequence cut into three still copies", () => {
      const a = scanClipboardWrites("", whole.slice(0, 4));
      const b = scanClipboardWrites(a.carry, whole.slice(4, 11));
      expect(scanClipboardWrites(b.carry, whole.slice(11)).text).toBe("split payload");
    });

    test("surrounding output is not carried", () => {
      const r = scanClipboardWrites("", `before${whole}after`);
      expect(r.text).toBe("split payload");
      expect(r.carry).toBe("");
    });

    test("an abandoned sequence is dropped, not carried forever", () => {
      // A fresh escape after the introducer means this one will never finish.
      expect(scan(`${ESC}]52;c;abc${ESC}[0m`).carry).toBe("");
      // Terminated but malformed (no payload field): also unfinishable.
      expect(scan(`${ESC}]52;c${BEL}`).carry).toBe("");
    });

    test("the carry is bounded, so an endless sequence can't grow it", () => {
      const flood = `${ESC}]52;c;${"A".repeat(1024 * 1024 + 8)}`;
      expect(scan(flood).carry).toBe("");
    });
  });
});
