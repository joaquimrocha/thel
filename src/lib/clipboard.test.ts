import { describe, it, expect } from "vitest";
import { shellQuote } from "./clipboard";

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
