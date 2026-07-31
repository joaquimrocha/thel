import { describe, it, expect } from "vitest";
import { paragraphs, shellQuote } from "./clipboard";

describe("paragraphs", () => {
  it("joins indented continuation lines and keeps paragraph breaks", () => {
    expect(
      paragraphs("some text\n   some other line\n   last line.\n\n   another line."),
    ).toBe("some text some other line last line.\nanother line.");
  });

  it("collapses runs of blank lines into one break", () => {
    expect(paragraphs("a\nb\n\n \n\nc")).toBe("a b\nc");
  });

  it("drops leading and trailing blank lines", () => {
    expect(paragraphs("\n  hello\n  world\n\n")).toBe("hello world");
  });

  it("leaves a single line untouched", () => {
    expect(paragraphs("just one line")).toBe("just one line");
  });
});

describe("shellQuote", () => {
  it("leaves plain paths bare", () => {
    expect(shellQuote("/tmp/shot-42.png")).toBe("/tmp/shot-42.png");
  });

  it("quotes paths with spaces", () => {
    expect(shellQuote("/tmp/my shot.png")).toBe("'/tmp/my shot.png'");
  });

  it("escapes embedded single quotes", () => {
    expect(shellQuote("/tmp/it's.png")).toBe("'/tmp/it'\\''s.png'");
  });
});
