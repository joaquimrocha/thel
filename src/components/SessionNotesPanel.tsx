import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Pencil, Check } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  Dialog,
  DialogPanel,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { ActionTooltip } from "./ActionTooltip";
import { isMac } from "@/lib/platform";
import { openUrl } from "@/lib/pty";
import { useUI } from "@/store/ui";
import { useSessions } from "@/store/sessions";
import { useNotes } from "@/store/notes";
import {
  parseBlocks,
  parseInline,
  toggleTask,
  continueList,
  type Span,
} from "@/lib/markdown";

// The panel's own keys, so they aren't part of the rebindable global keymap.
const EDIT_KEYS = isMac ? "⌘⏎" : "Ctrl+Enter";
const SAVE_KEYS = isMac ? "⌘S" : "Ctrl+S";

export function SessionNotesPanel() {
  const sessionId = useUI((s) => s.sessionNotes);
  const close = useUI((s) => s.closeSessionNotes);
  const session = useSessions((s) => s.sessions.find((x) => x.id === sessionId));
  const text = useNotes((s) => (sessionId ? (s.notes[sessionId] ?? "") : ""));
  const setNote = useNotes((s) => s.setNote);
  const [editing, setEditing] = useState(false);
  // The note has been read from disk, so there is something to show.
  const [ready, setReady] = useState(false);
  const editor = useRef<HTMLTextAreaElement>(null);
  const view = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  // Where the caret goes once a rewritten note has been committed to the DOM.
  const caret = useRef<number | null>(null);

  // Notes are read from disk on demand, so wait for the file before choosing
  // between the editor and the rendered view: a session with nothing saved
  // opens straight into the editor.
  useEffect(() => {
    if (!sessionId) return;
    let live = true;
    setReady(false);
    void useNotes
      .getState()
      .loadNote(sessionId)
      .then(() => {
        if (!live) return;
        setEditing(!useNotes.getState().notes[sessionId]);
        setReady(true);
      });
    return () => {
      live = false;
    };
  }, [sessionId]);

  // The panel belongs to one session, so navigating away would leave it stale:
  // close it. Keyed on the change, so opening it for a session that isn't the
  // active one still works.
  useEffect(() => {
    if (!sessionId) return;
    return useSessions.subscribe((s, prevState) => {
      if (
        s.activeSessionId !== prevState.activeSessionId &&
        s.activeSessionId !== sessionId
      ) {
        close();
      }
    });
  }, [sessionId, close]);

  // A note holding nothing but the blank lines someone typed and abandoned is
  // not worth keeping; prune it once the panel leaves that session.
  useEffect(() => {
    if (!sessionId) return;
    return () => {
      const { notes, removeNote } = useNotes.getState();
      if (notes[sessionId] !== undefined && !notes[sessionId].trim()) {
        removeNote(sessionId);
      }
    };
  }, [sessionId]);

  // Take focus when the panel appears (and when it leaves the editor) so its
  // own keys work right away and the notes scroll with the keyboard. The
  // editor focuses itself on mount, so this only covers the rendered view.
  useEffect(() => {
    if (sessionId && ready && !editing) view.current?.focus();
  }, [sessionId, ready, editing]);

  // Esc, on the window in the capture phase, ahead of the dismissable layers.
  // Radix would otherwise decide this: a menu that has just closed can still
  // swallow the key, and either way Esc in the editor has to mean "leave the
  // editor", not "close the panel". Only while the focus is inside the panel,
  // so a terminal that wants Esc keeps getting it.
  useEffect(() => {
    if (!sessionId) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (!panel.current?.contains(document.activeElement)) return;
      e.preventDefault();
      e.stopPropagation();
      if (editor.current && useNotes.getState().notes[sessionId]?.trim()) {
        setEditing(false);
      } else close();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [sessionId, close]);

  // Typing writes straight through to the store (debounced to disk), so
  // "Done" only switches to the rendered view and nothing is ever lost by
  // closing the panel mid-edit.
  const edit = (value: string) => sessionId && setNote(sessionId, value);

  // Enter inside a list continues it, like GitHub's own editor. Rewriting the
  // value by hand loses the browser's undo entry for that keystroke, which is
  // the usual trade for this behaviour in a plain textarea.
  const onEditorKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    const el = e.currentTarget;
    if (e.key === "s" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      setEditing(false);
      return;
    }
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      setEditing(false);
      return;
    }
    if (e.key !== "Enter" || e.shiftKey || el.selectionStart !== el.selectionEnd) {
      return;
    }
    const next = continueList(el.value, el.selectionStart);
    if (!next) return;
    e.preventDefault();
    caret.current = next.caret;
    edit(next.value);
  };

  // The value goes through the store, so the caret can only be placed once the
  // new text is in the DOM. Before paint, not in a frame callback: a keystroke
  // landing between the two would be inserted at the stale caret.
  useLayoutEffect(() => {
    if (caret.current === null) return;
    editor.current?.setSelectionRange(caret.current, caret.current);
    caret.current = null;
  });

  return (
    <Dialog open={!!sessionId} modal={false} onOpenChange={(o) => !o && close()}>
      <DialogPanel
        ref={panel}
        className="w-[560px]"
        onInteractOutside={(e) => e.preventDefault()}
        // Esc is handled by the panel itself (see the listener above), so the
        // dismissable layer never acts on it.
        onEscapeKeyDown={(e) => e.preventDefault()}
        // Focus the notes themselves rather than letting the focus scope land
        // on the close button, so the panel's keys work as soon as it appears.
        onOpenAutoFocus={(e) => {
          e.preventDefault();
          (editor.current ?? view.current)?.focus();
        }}
      >
        <div className="border-b border-border px-4 py-3 pr-10">
          <DialogTitle>Notes</DialogTitle>
          <DialogDescription>
            {session?.name ?? "Session"} · GitHub-flavored markdown
          </DialogDescription>
        </div>

        {!ready ? (
          <div className="flex-1" />
        ) : editing ? (
          <textarea
            ref={editor}
            autoFocus
            value={text}
            onChange={(e) => edit(e.target.value)}
            onKeyDown={onEditorKeyDown}
            placeholder={"# Plan\n\n- [ ] first step\n- [x] done step"}
            spellCheck={false}
            className="flex-1 resize-none bg-transparent px-4 py-3 font-mono text-xs leading-relaxed outline-none placeholder:text-muted-foreground"
          />
        ) : (
          <div
            ref={view}
            tabIndex={-1}
            onDoubleClick={() => setEditing(true)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                setEditing(true);
              }
            }}
            title="Double-click to edit"
            className="flex-1 overflow-y-auto px-4 py-3 text-sm outline-none"
          >
            <Rendered
              source={text}
              onToggle={(line) => edit(toggleTask(text, line))}
            />
          </div>
        )}

        <div className="flex items-center justify-end border-t border-border px-4 py-2">
          <ActionTooltip label={editing ? `Save (${SAVE_KEYS})` : `Edit (${EDIT_KEYS})`}>
            <Button
              variant={editing ? "default" : "ghost"}
              size="sm"
              onClick={() => setEditing((v) => !v)}
            >
              {editing ? (
                <>
                  <Check className="size-4" /> Save
                </>
              ) : (
                <>
                  <Pencil className="size-4" /> Edit
                </>
              )}
            </Button>
          </ActionTooltip>
        </div>
      </DialogPanel>
    </Dialog>
  );
}

function Rendered({
  source,
  onToggle,
}: {
  source: string;
  onToggle: (line: number) => void;
}) {
  const blocks = parseBlocks(source);
  if (blocks.length === 0) {
    return <p className="text-muted-foreground">No notes yet.</p>;
  }
  return (
    <div className="space-y-2">
      {blocks.map((b, i) => {
        switch (b.t) {
          case "h":
            return (
              <p
                key={i}
                className={cn(
                  "font-semibold",
                  b.level === 1 && "text-base",
                  b.level >= 3 && "text-xs uppercase tracking-wide",
                )}
              >
                <Inline spans={parseInline(b.text)} />
              </p>
            );
          case "hr":
            return <hr key={i} className="border-border" />;
          case "code":
            return (
              <pre
                key={i}
                className="overflow-x-auto rounded-md bg-muted p-2 font-mono text-xs"
              >
                {b.text}
              </pre>
            );
          case "quote":
            return (
              <p
                key={i}
                className="whitespace-pre-wrap border-l-2 border-border pl-3 text-muted-foreground"
              >
                <Inline spans={parseInline(b.text)} />
              </p>
            );
          case "table":
            return (
              <div key={i} className="overflow-x-auto">
                <table className="w-full border-collapse text-left">
                  <thead>
                    <tr>
                      {b.header.map((h, c) => (
                        <th
                          key={c}
                          style={{ textAlign: b.align[c] ?? undefined }}
                          className="border-b border-border px-2 py-1 font-semibold"
                        >
                          <Inline spans={parseInline(h)} />
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {b.rows.map((row, r) => (
                      <tr key={r}>
                        {row.map((cell, c) => (
                          <td
                            key={c}
                            style={{ textAlign: b.align[c] ?? undefined }}
                            className="border-b border-border/50 px-2 py-1"
                          >
                            <Inline spans={parseInline(cell)} />
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
          case "list":
            return (
              <ul key={i} className="space-y-1">
                {b.items.map((item, n) => (
                  <li
                    key={item.line}
                    style={{ paddingLeft: `${item.indent * 16}px` }}
                    className="flex items-start gap-2"
                  >
                    {item.task ? (
                      <input
                        type="checkbox"
                        checked={item.done}
                        onChange={() => onToggle(item.line)}
                        className="mt-1 size-3.5 shrink-0 accent-emerald-500"
                      />
                    ) : (
                      <span className="mt-px shrink-0 text-muted-foreground">
                        {b.ordered ? `${b.start + n}.` : "•"}
                      </span>
                    )}
                    <span
                      className={cn(
                        "min-w-0 flex-1",
                        item.done && "text-muted-foreground line-through",
                      )}
                    >
                      <Inline spans={parseInline(item.text)} />
                    </span>
                  </li>
                ))}
              </ul>
            );
          default:
            return (
              <p key={i} className="whitespace-pre-wrap">
                <Inline spans={parseInline(b.text)} />
              </p>
            );
        }
      })}
    </div>
  );
}

function Inline({ spans }: { spans: Span[] }) {
  return (
    <>
      {spans.map((s, i) => {
        switch (s.t) {
          case "code":
            return (
              <code key={i} className="rounded bg-muted px-1 font-mono text-xs">
                {s.v}
              </code>
            );
          case "strong":
            return (
              <strong key={i} className="font-semibold">
                {s.v}
              </strong>
            );
          case "em":
            return <em key={i}>{s.v}</em>;
          case "del":
            return (
              <span key={i} className="line-through">
                {s.v}
              </span>
            );
          case "link":
            return (
              // Handed to the OS browser: there is nowhere for the webview to
              // navigate to, and letting it try would strand the app window.
              <a
                key={i}
                href={s.href}
                onClick={(e) => {
                  e.preventDefault();
                  void openUrl(s.href);
                }}
                className="text-blue-400 underline underline-offset-2"
              >
                {s.v}
              </a>
            );
          default:
            return <span key={i}>{s.v}</span>;
        }
      })}
    </>
  );
}
