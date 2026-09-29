import { describe, expect, it } from 'vitest';
import { createDefaultOpenings } from './defaultOpenings';
import { indexRepertoire } from '../utils/repertoire';

describe('default opening library', () => {
  it('seeds eight playable opening repertoires', () => {
    const openings = createDefaultOpenings();
    expect(openings).toHaveLength(8);
    expect(new Set(openings.map((opening) => opening.id)).size).toBe(8);
    expect(openings.every((opening) => opening.root.children.length > 0)).toBe(true);
    expect(openings.every((opening) => indexRepertoire(opening.root).totalPositions > 1)).toBe(true);
  });
});
