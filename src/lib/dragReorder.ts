// Shared drag-to-reorder helpers for the session list (vertical) and the
// terminal tab strip (horizontal). The two differ only in axis; the reorder
// math, the drag-image snapshot, and the FLIP slide are one implementation.

import type { DragEvent } from "react";

// The destination index once the pointer crosses a neighbour's midpoint.
// `after` is true when the pointer is past the midpoint of the item at
// `overIndex`. Accounts for the dragged item (at `from`) being removed first, so
// dropping just past an item that sits after `from` lands in the right slot.
// Returns `from` when nothing should move, so the caller can skip a no-op.
export function reorderIndex(
  from: number,
  overIndex: number,
  after: boolean,
): number {
  let to = overIndex + (after ? 1 : 0);
  if (from < to) to -= 1;
  return to;
}

// Set a solid, visible clone as the drag image. The live element is hidden
// (opacity-0) while dragging and an inactive row/tab has a transparent
// background, so the browser's default drag image would be see-through. The
// clone is placed offscreen and removed once the browser has snapshotted it.
// `strip` removes the identifying attributes/classes specific to each caller.
export function setClonedDragImage(
  e: DragEvent,
  strip?: (clone: HTMLElement) => void,
): void {
  const node = e.currentTarget as HTMLElement;
  const rect = node.getBoundingClientRect();
  const clone = node.cloneNode(true) as HTMLElement;
  strip?.(clone);
  // A solid background so the dragged copy is fully opaque.
  clone.classList.add("bg-secondary", "text-secondary-foreground");
  clone.style.transform = "";
  clone.style.transition = "none";
  clone.style.position = "fixed";
  clone.style.top = "-9999px";
  clone.style.left = "-9999px";
  clone.style.width = `${rect.width}px`;
  clone.style.pointerEvents = "none";
  document.body.appendChild(clone);
  e.dataTransfer.setDragImage(clone, e.clientX - rect.left, e.clientY - rect.top);
  setTimeout(() => clone.remove(), 0);
}

// FLIP: slide each `[attr]` child in `container` from its previous position to
// its new one when the order changed, so a reorder (drag or shortcut) animates.
// `axis` picks the translate axis; `prev` holds each child's last position and
// is updated in place (the caller keeps it in a ref across renders).
export function flipReorder(
  container: HTMLElement,
  attr: string,
  axis: "x" | "y",
  prev: Map<string, number>,
): void {
  container.querySelectorAll<HTMLElement>(`[${attr}]`).forEach((el) => {
    const id = el.getAttribute(attr)!;
    const r = el.getBoundingClientRect();
    const pos = axis === "y" ? r.top : r.left;
    const was = prev.get(id);
    if (was != null && was !== pos) {
      el.style.transition = "none";
      el.style.transform =
        axis === "y" ? `translateY(${was - pos}px)` : `translateX(${was - pos}px)`;
      requestAnimationFrame(() => {
        el.style.transition = "transform 150ms ease";
        el.style.transform = "";
      });
    }
    prev.set(id, pos);
  });
}
