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

// Where a dragged unit lands, expressed as "beside this other unit" rather than
// as an index. `reorderSessionBlock` moves a set of sessions next to an anchor,
// which an index cannot address once a unit spans several sessions (a repo
// group) or the units are not contiguous. `edge` yields a unit's first or last
// session id. Returns null when the unit should stay put, which is what keeps a
// drag from oscillating: the pointer sitting still recomputes the same slot.
export function dropAnchor<T>(
  units: T[],
  fromIndex: number,
  overIndex: number,
  after: boolean,
  edge: (unit: T, after: boolean) => string,
): { anchorId: string; after: boolean } | null {
  const to = reorderIndex(fromIndex, overIndex, after);
  if (to === fromIndex) return null;
  const rest = units.filter((_, i) => i !== fromIndex);
  if (rest.length === 0) return null;
  return to < rest.length
    ? { anchorId: edge(rest[to], false), after: false }
    : { anchorId: edge(rest[rest.length - 1], true), after: true };
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
  clone.style.width = `${rect.width}px`;
  // The snapshot is taken in device pixels but drawn back in CSS pixels
  // without dividing, so on a HiDPI screen the dragged copy comes out
  // devicePixelRatio times too big. Pre-shrink it by the same factor. The
  // wrapper carries the scale so the clone's own transform stays clear, and
  // it is sized to the scaled result so the snapshot is not mostly padding.
  const dpr = window.devicePixelRatio || 1;
  const holder = document.createElement("div");
  holder.style.position = "fixed";
  holder.style.top = "-9999px";
  holder.style.left = "-9999px";
  holder.style.pointerEvents = "none";
  holder.style.width = `${rect.width / dpr}px`;
  holder.style.height = `${rect.height / dpr}px`;
  if (dpr !== 1) {
    clone.style.transform = `scale(${1 / dpr})`;
    clone.style.transformOrigin = "top left";
  }
  holder.appendChild(clone);
  document.body.appendChild(holder);
  e.dataTransfer.setDragImage(
    holder,
    (e.clientX - rect.left) / dpr,
    (e.clientY - rect.top) / dpr,
  );
  setTimeout(() => holder.remove(), 0);
}

/**
 * State a FLIP pass carries between renders: `pos` is each child's last layout
 * position, `carry` the translate it still had in flight when the reorder was
 * requested. Keep one per animated container, in a ref.
 */
export type FlipState = {
  pos: Map<string, number>;
  carry: Map<string, number>;
};

export function flipState(): FlipState {
  return { pos: new Map(), carry: new Map() };
}

/**
 * Record how far each child is currently displaced by a slide still running.
 * Call this immediately before requesting a reorder, not after: React relocates
 * the moved node, and moving a node cancels the CSS transition on it, so by the
 * time the layout effect runs its offset is gone and it has already snapped to
 * its new spot. That snap is the jump you see when reorders come in faster than
 * the 150ms slide, which dragging does constantly.
 */
export function flipCapture(
  container: HTMLElement,
  attr: string,
  axis: "x" | "y",
  state: FlipState,
): void {
  container.querySelectorAll<HTMLElement>(`[${attr}]`).forEach((el) => {
    const t = currentTranslate(el, axis);
    if (t !== 0) state.carry.set(el.getAttribute(attr)!, t);
  });
}

// FLIP: slide each `[attr]` child in `container` from its previous position to
// its new one when the order changed, so a reorder (drag or shortcut) animates.
// `axis` picks the translate axis; `state` is updated in place.
export function flipReorder(
  container: HTMLElement,
  attr: string,
  axis: "x" | "y",
  state: FlipState,
): void {
  const { pos: prev, carry } = state;
  container.querySelectorAll<HTMLElement>(`[${attr}]`).forEach((el) => {
    const id = el.getAttribute(attr)!;
    // Hidden (no offset parent): position reads 0, which is not a real spot.
    // Forget it, so reappearing does not read as a move from the origin.
    if (!el.offsetParent) {
      prev.delete(id);
      return;
    }
    // Layout position, not getBoundingClientRect: the rect includes the FLIP
    // transform still running from the previous reorder, and shifts when the
    // strip scrolls, both of which read as a move that never happened.
    const pos = axis === "y" ? el.offsetTop : el.offsetLeft;
    const was = prev.get(id);
    prev.set(id, pos);
    if (was == null) return;
    // The captured offset wins: a node React moved has lost its transition, so
    // the DOM no longer remembers where it visually was.
    const from = flipStart(was, pos, carry.get(id) ?? currentTranslate(el, axis));
    if (from === 0) return;
    el.style.transition = "none";
    el.style.transform =
      axis === "y" ? `translateY(${from}px)` : `translateX(${from}px)`;
    requestAnimationFrame(() => {
      el.style.transition = "transform 150ms ease";
      el.style.transform = "";
    });
  });
  carry.clear();
}

/**
 * Where a slide has to start for the element not to jump. `was` and `pos` are
 * the layout positions before and after the reorder, `curr` the translate still
 * in flight from an earlier one. Dragging reorders on every pointer move, so
 * most slides interrupt a running slide: starting from the plain layout delta
 * would snap the element to a spot it is not at yet, which is what makes a
 * flurry of reorders look fast and erratic. Offsetting by `curr` starts it from
 * where it actually is.
 */
export function flipStart(was: number, pos: number, curr: number): number {
  return was + curr - pos;
}

// The translate the element currently carries on `axis`, in px: mid-transition
// this is the live interpolated value, which is exactly the visual offset the
// next slide has to continue from.
function currentTranslate(el: HTMLElement, axis: "x" | "y"): number {
  const t = getComputedStyle(el).transform;
  if (!t || t === "none") return 0;
  const m = new DOMMatrixReadOnly(t);
  return axis === "y" ? m.m42 : m.m41;
}
