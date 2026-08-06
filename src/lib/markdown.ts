/**
 * GitHub Flavored Markdown for session notes: headings, lists with task
 * checkboxes, tables, fenced code, quotes, rules, paragraphs, and inline spans
 * including strikethrough and bare-URL autolinks. Parsing only; the notes panel
 * turns these into React nodes, so nothing is ever fed to innerHTML.
 *
 * ponytail: hand-rolled instead of a markdown dependency, which would also drag
 * in a sanitizer. Left out of GFM: nested emphasis, reference links, footnotes,
 * inline HTML, and setext headings. Reach for `marked` plus DOMPurify if notes
 * ever need those.
 */

export type Span =
  | { t: "text"; v: string }
  | { t: "code"; v: string }
  | { t: "strong"; v: string }
  | { t: "em"; v: string }
  | { t: "del"; v: string }
  | { t: "link"; v: string; href: string };

export interface ListItem {
  text: string;
  indent: number;
  // Source line, so clicking a checkbox can rewrite exactly that line.
  line: number;
  task: boolean;
  done: boolean;
}

export type Align = "left" | "center" | "right";

export type Block =
  | { t: "h"; level: number; text: string }
  | { t: "p"; text: string }
  | { t: "code"; text: string }
  | { t: "quote"; text: string }
  | { t: "hr" }
  // `start` is the first item's number, so a list written from 3. renders from 3.
  | { t: "list"; ordered: boolean; start: number; items: ListItem[] }
  | { t: "table"; header: string[]; align: (Align | null)[]; rows: string[][] };

// GFM's flanking rule, spelled as "no space just inside the delimiters" so a
// line like `rm *.log and *.tmp` or `2 * 3 * 4` stays literal. Written without
// lookbehind, which older WebKitGTK builds don't have.
const between = (inner: string) => `(\\S|\\S${inner}*?\\S)`;

const INLINE = new RegExp(
  [
    "`([^`]+)`", // code
    `\\*\\*${between("[^\\n]")}\\*\\*`, // **strong**
    `__${between("[^\\n]")}__`, // __strong__
    `\\*${between("[^*\\n]")}\\*`, // *em*
    `_${between("[^_\\n]")}_`, // _em_
    `~~${between("[^\\n]")}~~`, // ~~del~~
    "\\[([^\\]\\n]*)\\]\\(([^)\\s]+)\\)", // [text](href)
    "(https?://[^\\s<]+|www\\.[^\\s<]+)", // bare URL
  ].join("|"),
  "g",
);

// Rendered as <a href>, so anything that could execute (javascript:, data:) is
// left as plain text instead.
const SAFE_HREF = /^(https?:\/\/|mailto:)/i;

// GFM leaves intraword underscores alone, so snake_case_names survive.
const isWordChar = (c: string | undefined) => !!c && /\w/.test(c);

// Trailing sentence punctuation belongs to the sentence, not to the URL.
const TRAILING = /[.,;:!?)\]]+$/;

export function parseInline(src: string): Span[] {
  const out: Span[] = [];
  let last = 0;
  // Merges into the previous run, so a stretch that only looked like markup
  // (an intraword underscore) comes back as one span.
  const text = (v: string) => {
    if (!v) return;
    const prev = out[out.length - 1];
    if (prev?.t === "text") prev.v += v;
    else out.push({ t: "text", v });
  };

  for (const m of src.matchAll(INLINE)) {
    const at = m.index ?? 0;
    const [whole, code, strongStar, strongUnder, emStar, emUnder, del, label, href, url] =
      m;
    text(src.slice(last, at));
    last = at + whole.length;

    if (code !== undefined) out.push({ t: "code", v: code });
    else if (strongStar !== undefined) out.push({ t: "strong", v: strongStar });
    else if (emStar !== undefined) out.push({ t: "em", v: emStar });
    else if (del !== undefined) out.push({ t: "del", v: del });
    else if (strongUnder !== undefined || emUnder !== undefined) {
      if (isWordChar(src[at - 1]) || isWordChar(src[last])) text(whole);
      else if (strongUnder !== undefined) out.push({ t: "strong", v: strongUnder });
      else out.push({ t: "em", v: emUnder });
    } else if (url !== undefined) {
      const trimmed = url.replace(TRAILING, "");
      out.push({
        t: "link",
        v: trimmed,
        href: trimmed.startsWith("www.") ? `https://${trimmed}` : trimmed,
      });
      text(url.slice(trimmed.length));
    } else if (SAFE_HREF.test(href)) {
      out.push({ t: "link", v: label || href, href });
    } else text(whole);
  }

  text(src.slice(last));
  return out;
}

const FENCE = /^\s*```/;
const HEADING = /^(#{1,6})\s+(.*)$/;
const RULE = /^\s*(-{3,}|\*{3,}|_{3,})\s*$/;
const BULLET = /^(\s*)[-*+]\s+(.*)$/;
const NUMBER = /^(\s*)\d+[.)]\s+(.*)$/;
const TASK = /^\[([ xX])\]\s*(.*)$/;
const QUOTE = /^\s*>\s?(.*)$/;

const DELIMITER = /^\s*\|?(\s*:?-+:?\s*\|)+\s*:?-+:?\s*\|?\s*$/;

const itemMatch = (line: string) => BULLET.exec(line) ?? NUMBER.exec(line);

const cells = (line: string) =>
  line
    .trim()
    .replace(/^\||\|$/g, "")
    .split("|")
    .map((c) => c.trim());

const alignOf = (spec: string): Align | null => {
  const s = spec.trim();
  if (s.startsWith(":") && s.endsWith(":")) return "center";
  if (s.endsWith(":")) return "right";
  if (s.startsWith(":")) return "left";
  return null;
};

export function parseBlocks(src: string): Block[] {
  const lines = src.split("\n");
  const blocks: Block[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (FENCE.test(line)) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !FENCE.test(lines[i])) body.push(lines[i++]);
      i++; // closing fence, or past the end for an unterminated block
      blocks.push({ t: "code", text: body.join("\n") });
      continue;
    }

    if (!line.trim()) {
      i++;
      continue;
    }

    const h = HEADING.exec(line);
    if (h) {
      blocks.push({ t: "h", level: h[1].length, text: h[2] });
      i++;
      continue;
    }

    if (RULE.test(line)) {
      blocks.push({ t: "hr" });
      i++;
      continue;
    }

    if (QUOTE.test(line)) {
      const body: string[] = [];
      while (i < lines.length) {
        const q = QUOTE.exec(lines[i]);
        if (!q) break;
        body.push(q[1]);
        i++;
      }
      blocks.push({ t: "quote", text: body.join("\n") });
      continue;
    }

    // A table is a header row followed by a --- | :--: delimiter row.
    if (line.includes("|") && DELIMITER.test(lines[i + 1] ?? "")) {
      const header = cells(line);
      const align = cells(lines[i + 1]).map(alignOf);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i].includes("|") && lines[i].trim()) {
        rows.push(cells(lines[i++]));
      }
      blocks.push({ t: "table", header, align, rows });
      continue;
    }

    if (itemMatch(line)) {
      const ordered = !BULLET.test(line);
      const start = ordered ? Number.parseInt(line.trim(), 10) || 1 : 1;
      const items: ListItem[] = [];
      while (i < lines.length) {
        const m = itemMatch(lines[i]);
        if (!m || !BULLET.test(lines[i]) !== ordered) break;
        const task = TASK.exec(m[2]);
        items.push({
          text: task ? task[2] : m[2],
          // Two spaces per level, the usual markdown convention.
          indent: Math.floor(m[1].length / 2),
          line: i,
          task: !!task,
          done: !!task && task[1].toLowerCase() === "x",
        });
        i++;
      }
      blocks.push({ t: "list", ordered, start, items });
      continue;
    }

    const body: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() &&
      !FENCE.test(lines[i]) &&
      !HEADING.test(lines[i]) &&
      !RULE.test(lines[i]) &&
      !QUOTE.test(lines[i]) &&
      !itemMatch(lines[i]) &&
      !(lines[i].includes("|") && DELIMITER.test(lines[i + 1] ?? ""))
    ) {
      body.push(lines[i++]);
    }
    blocks.push({ t: "p", text: body.join("\n") });
  }

  return blocks;
}

const ITEM_PREFIX = /^(\s*)([-*+]|\d+[.)])(\s+)(\[[ xX]\]\s*)?/;

/**
 * GitHub's editor behaviour for Enter inside a list: continue the list with a
 * fresh marker (an unticked box under a task item), or drop the marker when the
 * item is empty, which is how you end a list. Returns the rewritten note and
 * the new caret, or null when the caret isn't in a list item and Enter should
 * do its usual thing.
 */
export function continueList(
  value: string,
  caret: number,
): { value: string; caret: number } | null {
  const start = value.lastIndexOf("\n", caret - 1) + 1;
  const end = value.indexOf("\n", caret) === -1 ? value.length : value.indexOf("\n", caret);
  const line = value.slice(start, end);
  const m = ITEM_PREFIX.exec(line);
  if (!m) return null;

  const [prefix, indent, marker, gap, box] = m;

  // Caret still inside the marker (Enter at the start of an item opens a line
  // above it), so there is no item to continue.
  if (caret < start + prefix.length) return null;

  // Nothing typed after the marker: clear the item instead of adding another.
  if (!line.slice(prefix.length).trim()) {
    return {
      value: value.slice(0, start) + value.slice(end),
      caret: start,
    };
  }

  const next = /\d/.test(marker)
    ? `${Number.parseInt(marker, 10) + 1}${marker.slice(-1)}`
    : marker;
  const insert = `\n${indent}${next}${gap}${box ? "[ ] " : ""}`;
  return {
    value: value.slice(0, caret) + insert + value.slice(caret),
    caret: caret + insert.length,
  };
}

/** Flip the checkbox on one source line, returning the rewritten note. */
export function toggleTask(src: string, line: number): string {
  const lines = src.split("\n");
  const l = lines[line];
  if (l === undefined) return src;
  const next = l.replace(
    /^(\s*(?:[-*+]|\d+[.)])\s+\[)([ xX])(\])/,
    (_, open, mark, close) => `${open}${mark === " " ? "x" : " "}${close}`,
  );
  if (next === l) return src;
  lines[line] = next;
  return lines.join("\n");
}
