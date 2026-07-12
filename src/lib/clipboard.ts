import { readText, writeText } from "@tauri-apps/plugin-clipboard-manager";
import { invoke } from "@tauri-apps/api/core";

// Clipboard via the Tauri plugin (reliable under WebKitGTK, where the browser
// Clipboard API is restricted). Best-effort: failures are swallowed.

export async function copyText(text: string): Promise<void> {
  try {
    await writeText(text);
  } catch {
    // ignore
  }
}

export async function pasteText(): Promise<string> {
  try {
    return (await readText()) ?? "";
  } catch {
    return "";
  }
}

// The files on the clipboard (a file-manager "Copy"), as paths; empty when
// the clipboard holds none.
export async function clipboardFiles(): Promise<string[]> {
  try {
    return await invoke<string[]>("clipboard_files");
  } catch {
    return [];
  }
}

// Quote a path for the shell, only when it contains characters that need it.
export function shellQuote(path: string): string {
  if (/^[\w@%+=:,./-]+$/.test(path)) return path;
  return `'${path.replace(/'/g, "'\\''")}'`;
}

/**
 * Left-align a copied indented block (code, log output) while keeping relative
 * indentation. The dedent width is the smallest indent of the lines *after* the
 * first non-blank line, so the body de-indents to meet the first line even when
 * that first line is already flush (e.g. the selection started mid-line). Each
 * line loses at most that many leading whitespace chars, so content is never cut.
 */
export function dedent(text: string): string {
  const indentOf = (l: string) => l.length - l.replace(/^[ \t]+/, "").length;
  const lines = text.split("\n");
  const nonBlank = lines.filter((l) => l.trim() !== "");
  if (nonBlank.length === 0) return text;
  const width =
    nonBlank.length === 1
      ? indentOf(nonBlank[0])
      : Math.min(...nonBlank.slice(1).map(indentOf));
  if (width === 0) return text;
  return lines
    .map((l) => {
      let i = 0;
      while (i < width && (l[i] === " " || l[i] === "\t")) i++;
      return l.slice(i);
    })
    .join("\n");
}
