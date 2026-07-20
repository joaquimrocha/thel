import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";

/**
 * A label that becomes a text input on double-click. Enter or blur commits,
 * Escape cancels. Empty or unchanged values are ignored. Stops event
 * propagation so it can live inside clickable rows/tabs without triggering
 * their handlers (or the global command-palette shortcut).
 */
export function EditableLabel({
  value,
  onCommit,
  fallback,
  className,
  editSignal,
}: {
  value: string;
  onCommit: (value: string) => void;
  /** When the field is cleared, revert to this default instead of keeping the old value. */
  fallback?: string;
  className?: string;
  /** Bump to a new number to start editing from outside (e.g. a context menu). */
  editSignal?: number;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editSignal !== undefined) {
      setDraft(value);
      setEditing(true);
    }
    // Only react to the signal, not to value changes while editing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editSignal]);

  useEffect(() => {
    if (editing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [editing]);

  const commit = () => {
    const next = draft.trim();
    if (next) {
      if (next !== value) onCommit(next);
    } else if (fallback !== undefined && fallback !== value) {
      // Cleared: revert to the default name.
      onCommit(fallback);
    }
    setEditing(false);
  };

  if (editing) {
    return (
      <input
        ref={inputRef}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onClick={(e) => e.stopPropagation()}
        onDoubleClick={(e) => e.stopPropagation()}
        onBlur={commit}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Enter") commit();
          else if (e.key === "Escape") setEditing(false);
        }}
        className={cn(
          // w-full so the input fills its column instead of falling back to the
          // browser's intrinsic input width, which would overflow narrow rows
          // and overlap the close button. min-w-0 keeps it shrinkable in flex.
          "w-full min-w-0 rounded-sm bg-background px-1 text-foreground outline-none ring-1 ring-ring",
          className,
        )}
      />
    );
  }

  return (
    <span
      className={className}
      title="Double-click to rename"
      onDoubleClick={(e) => {
        e.stopPropagation();
        setDraft(value);
        setEditing(true);
      }}
    >
      {value}
    </span>
  );
}
