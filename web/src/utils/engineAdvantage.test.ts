import { describe, expect, it } from 'vitest';
import {
  MATE_LEAF_CP,
  evalToWhiteCp,
  formatAdvCp,
  leafAdvantageCp,
  whiteCpToOurAdvantage,
} from './engineAdvantage';

const INITIAL_W = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const INITIAL_B = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1';

describe('eval convention (+ = White, then flip to us)', () => {
  it('keeps White-relative evals, flips Black-relative ones', () => {
    expect(evalToWhiteCp(50, undefined, 'w')).toBe(50);
    expect(evalToWhiteCp(50, undefined, 'b')).toBe(-50);
    expect(evalToWhiteCp(-30, undefined, 'b')).toBe(30);
    expect(evalToWhiteCp(undefined, undefined, 'w')).toBeNull();
  });

  it('caps mates decisively on both sides', () => {
    expect(evalToWhiteCp(undefined, 3, 'w')).toBe(MATE_LEAF_CP);
    expect(evalToWhiteCp(undefined, 3, 'b')).toBe(-MATE_LEAF_CP);
    expect(evalToWhiteCp(undefined, -2, 'w')).toBe(-MATE_LEAF_CP);
    expect(evalToWhiteCp(undefined, -2, 'b')).toBe(MATE_LEAF_CP);
  });

  it('flips to our color', () => {
    expect(whiteCpToOurAdvantage(40, 'white')).toBe(40);
    expect(whiteCpToOurAdvantage(40, 'black')).toBe(-40);
  });

  it('leafAdvantageCp reads the side to move from the FEN', () => {
    // +30 for the side to move.
    expect(leafAdvantageCp(30, undefined, INITIAL_W, 'white')).toBe(30);
    expect(leafAdvantageCp(30, undefined, INITIAL_W, 'black')).toBe(-30);
    expect(leafAdvantageCp(30, undefined, INITIAL_B, 'white')).toBe(-30);
    expect(leafAdvantageCp(30, undefined, INITIAL_B, 'black')).toBe(30);
  });

  it('formats signed pawn units', () => {
    expect(formatAdvCp(40)).toBe('+0.40');
    expect(formatAdvCp(-15)).toBe('-0.15');
    expect(formatAdvCp(0)).toBe('0.00');
  });
});
