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
