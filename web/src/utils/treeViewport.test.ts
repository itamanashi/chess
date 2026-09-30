import { describe, expect, it } from 'vitest';
import { edgeIntersectsRect, findVisibleRange, type PadRect } from './treeViewport';

describe('findVisibleRange', () => {
  const rows = [0, 50, 100, 150];

  it('includes rows that overlap either viewport edge', () => {
    expect(findVisibleRange(rows, 75, 125, (y) => y, 40)).toEqual([1, 3]);
  });

  it('returns an empty range when all rows are outside the viewport', () => {
    expect(findVisibleRange(rows, 210, 250, (y) => y, 40)).toEqual([4, 4]);
    expect(findVisibleRange(rows, -80, -41, (y) => y, 40)).toEqual([0, 0]);
  });

  it('includes boundary-touching rows', () => {
    expect(findVisibleRange(rows, 40, 50, (y) => y, 40)).toEqual([0, 2]);
  });
});

describe('edgeIntersectsRect', () => {
  const rect: PadRect = { left: 100, right: 200, top: 100, bottom: 200 };

  it('keeps edges fully inside', () => {
    expect(edgeIntersectsRect(120, 120, 180, 180, rect)).toBe(true);
  });

  it('keeps crossing edges whose endpoints are both outside', () => {
    // Parent culled left, child culled right: the link still crosses the screen.
    expect(edgeIntersectsRect(0, 150, 300, 160, rect)).toBe(true);
    // Parent culled above, child culled below.
    expect(edgeIntersectsRect(150, 0, 150, 300, rect)).toBe(true);
  });

  it('keeps edges touching a single viewport side', () => {
    expect(edgeIntersectsRect(0, 150, 100, 150, rect)).toBe(true);
    expect(edgeIntersectsRect(150, 200, 150, 500, rect)).toBe(true);
  });

  it('drops edges fully outside', () => {
    expect(edgeIntersectsRect(0, 0, 50, 50, rect)).toBe(false);
    expect(edgeIntersectsRect(250, 150, 400, 160, rect)).toBe(false);
    expect(edgeIntersectsRect(150, 250, 150, 400, rect)).toBe(false);
  });
});
