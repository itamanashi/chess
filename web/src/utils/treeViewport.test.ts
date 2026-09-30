import { describe, expect, it } from 'vitest';
import { findVisibleRange } from './treeViewport';

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
