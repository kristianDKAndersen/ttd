// Pure drag-and-drop maths. No DOM access: view.ts feeds it measured rects.

export interface RowRect {
  top: number
  height: number
}

/** Pixels the pointer must travel before a press becomes a drag (below it, the press is a click). */
export const DRAG_THRESHOLD = 4

export function exceedsThreshold(dx: number, dy: number): boolean {
  return Math.hypot(dx, dy) >= DRAG_THRESHOLD
}

/**
 * Slot (0..rects.length) the pointer is over: the number of rows whose midpoint lies above `y`.
 * Slot i means "before row i"; slot n means "after the last row". Rects are in list order.
 */
export function dropSlot(rects: readonly RowRect[], y: number): number {
  let slot = 0
  for (const r of rects) if (r.top + r.height / 2 < y) slot++
  return slot
}

/**
 * Turns a slot (as returned by dropSlot over ALL rows, dragged one included) into the store's relative
 * move. Returns null when the drop leaves the order unchanged (or the id is unknown).
 */
export function planMove(ids: readonly string[], id: string, slot: number): { after: string | null } | null {
  const from = ids.indexOf(id)
  if (from < 0) return null
  const to = slot > from ? slot - 1 : slot // index in the list once the dragged row is removed
  if (to === from) return null
  const rest = ids.filter((x) => x !== id)
  return { after: to === 0 ? null : (rest[to - 1] ?? null) }
}
