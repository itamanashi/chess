/** Padded viewport rectangle in world coordinates (shared by node/edge culling). */
export interface PadRect {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

/**
 * True when the segment (x1,y1)-(x2,y2) touches `rect`. Tested on the
 * segment bounding box: our edge curves stay within their endpoints box
 * (control points share the endpoints x/y), so no crossing edge is missed.
 * A link can cross the screen while both circles are culled (wide trees +
 * zoom); endpoint-membership culling alone drops it.
 */
export function edgeIntersectsRect(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  rect: PadRect,
): boolean {
  const x0 = Math.min(x1, x2);
  const x3 = Math.max(x1, x2);
  const y0 = Math.min(y1, y2);
  const y3 = Math.max(y1, y2);
  return x3 >= rect.left && x0 <= rect.right && y3 >= rect.top && y0 <= rect.bottom;
}

/**
 * Returns the half-open range of vertically sorted items whose rows intersect
 * [top, bottom]. `getY` returns each item's top edge.
 */
export function findVisibleRange<T>(
  items: readonly T[],
  top: number,
  bottom: number,
  getY: (item: T) => number,
  itemHeight: number,
): [number, number] {
  let low = 0;
  let high = items.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (getY(items[middle]) + itemHeight < top) low = middle + 1;
    else high = middle;
  }
  const start = low;

  high = items.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (getY(items[middle]) <= bottom) low = middle + 1;
    else high = middle;
  }
  return [start, low];
}
