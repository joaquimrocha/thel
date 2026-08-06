import { test, expect, describe } from "vitest";
import { parseBlocks, parseInline, toggleTask, continueList } from "./markdown";

describe("parseBlocks", () => {
  test("headings, rules and paragraphs", () => {
    expect(parseBlocks("## Plan\n\ntwo\nlines\n\n---")).toEqual([
      { t: "h", level: 2, text: "Plan" },
      { t: "p", text: "two\nlines" },
      { t: "hr" },
    ]);
  });

  test("task items carry their state and source line", () => {
    const [list] = parseBlocks("- [ ] todo\n- [x] done\n  - plain");
    expect(list).toEqual({
      t: "list",
      ordered: false,
      start: 1,
      items: [
        { text: "todo", indent: 0, line: 0, task: true, done: false },
        { text: "done", indent: 0, line: 1, task: true, done: true },
        { text: "plain", indent: 1, line: 2, task: false, done: false },
      ],
    });
  });

  test("an ordered list is its own block", () => {
    const blocks = parseBlocks("- a\n1. b");
    expect(blocks.map((b) => b.t === "list" && b.ordered)).toEqual([false, true]);
  });

  test("an ordered list keeps the number it starts from", () => {
    const [list] = parseBlocks("3. three\n4. four");
    expect(list.t === "list" && list.start).toBe(3);
  });

  test("fenced code keeps its lines verbatim", () => {
    expect(parseBlocks("```\n- not a list\n```")).toEqual([
      { t: "code", text: "- not a list" },
    ]);
  });

  test("an unterminated fence does not loop forever", () => {
    expect(parseBlocks("```\nstill open")).toEqual([
      { t: "code", text: "still open" },
    ]);
  });

  test("quote lines fold into one block", () => {
    expect(parseBlocks("> one\n> two")).toEqual([
      { t: "quote", text: "one\ntwo" },
    ]);
  });

  test("a table takes its alignment from the delimiter row", () => {
    expect(parseBlocks("| a | b |\n| :-- | --: |\n| 1 | 2 |")).toEqual([
      {
        t: "table",
        header: ["a", "b"],
        align: ["left", "right"],
        rows: [["1", "2"]],
      },
    ]);
  });

  test("a pipe without a delimiter row is just a paragraph", () => {
    expect(parseBlocks("a | b")).toEqual([{ t: "p", text: "a | b" }]);
  });
});

describe("parseInline", () => {
  test("code, emphasis and links", () => {
    expect(parseInline("run `ls` **now** [docs](https://a.b)")).toEqual([
      { t: "text", v: "run " },
      { t: "code", v: "ls" },
      { t: "text", v: " " },
      { t: "strong", v: "now" },
      { t: "text", v: " " },
      { t: "link", v: "docs", href: "https://a.b" },
    ]);
  });

  test("bare URLs autolink, without the trailing period", () => {
    expect(parseInline("see https://a.b/c.")).toEqual([
      { t: "text", v: "see " },
      { t: "link", v: "https://a.b/c", href: "https://a.b/c" },
      { t: "text", v: "." },
    ]);
    expect(parseInline("www.a.b")).toEqual([
      { t: "link", v: "www.a.b", href: "https://www.a.b" },
    ]);
  });

  test("underscores inside a word are left alone", () => {
    expect(parseInline("snake_case_name")).toEqual([
      { t: "text", v: "snake_case_name" },
    ]);
    expect(parseInline("_yes_")).toEqual([{ t: "em", v: "yes" }]);
  });

  test("a space inside the delimiters keeps the text literal", () => {
    // Shell globs and arithmetic are ordinary things to jot in a note.
    expect(parseInline("rm *.log and *.tmp")).toEqual([
      { t: "text", v: "rm *.log and *.tmp" },
    ]);
    expect(parseInline("2 * 3 * 4")).toEqual([{ t: "text", v: "2 * 3 * 4" }]);
    expect(parseInline("*em*")).toEqual([{ t: "em", v: "em" }]);
    expect(parseInline("**bold**")).toEqual([{ t: "strong", v: "bold" }]);
  });

  test("a script URL never becomes a link", () => {
    const spans = parseInline("[x](javascript:alert(1)) [y](data:text/html,x)");
    expect(spans.every((s) => s.t === "text")).toBe(true);
  });
});

describe("continueList", () => {
  test("a task item continues with an unticked box", () => {
    const src = "- [x] done";
    expect(continueList(src, src.length)).toEqual({
      value: "- [x] done\n- [ ] ",
      caret: 17,
    });
  });

  test("an ordered item continues with the next number", () => {
    const src = "  2. two";
    expect(continueList(src, src.length)?.value).toBe("  2. two\n  3. ");
  });

  test("an empty item ends the list", () => {
    const src = "- [ ] a\n- [ ] ";
    expect(continueList(src, src.length)).toEqual({
      value: "- [ ] a\n",
      caret: 8,
    });
  });

  test("outside a list Enter is left alone", () => {
    expect(continueList("plain text", 4)).toBeNull();
  });

  test("Enter at the start of an item opens a line above it", () => {
    expect(continueList("- a", 0)).toBeNull();
    expect(continueList("- [ ] a", 3)).toBeNull();
  });
});

describe("toggleTask", () => {
  test("flips only the given line", () => {
    const src = "- [ ] a\n- [x] b";
    expect(toggleTask(src, 0)).toBe("- [x] a\n- [x] b");
    expect(toggleTask(src, 1)).toBe("- [ ] a\n- [ ] b");
  });

  test("leaves non-task lines alone", () => {
    expect(toggleTask("- plain", 0)).toBe("- plain");
    expect(toggleTask("- [ ] a", 9)).toBe("- [ ] a");
  });
});
