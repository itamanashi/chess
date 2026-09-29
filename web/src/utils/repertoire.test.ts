import { describe, expect, it } from 'vitest';
import { Chess } from 'chess.js';
import { buildHistoryFromSans, makePlaceholderMove } from './repertoireTree';
import { isUciAdopted } from './repertoire';

const CASTLE_FEN = 'r3k2r/pppppppp/8/8/8/8/PPPPPPPP/R3K2R w KQkq - 0 1';
const OPEN_FEN = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1';

describe('isUciAdopted (audit B5)', () => {
  it('matches a normalized store with a normalized query (clean fast path)', () => {
    const store = [makePlaceholderMove('O-O', 'e1g1', CASTLE_FEN)];
    expect(isUciAdopted(store, CASTLE_FEN, 'e1g1')).toBe(true);
    expect(isUciAdopted(store, CASTLE_FEN, 'e1c1')).toBe(false);
  });

  it('matches a normalized store with a RAW Lichess query (users-list case)', () => {
    // Exact B5 repro: the "Utilisateurs" list queries with the raw e1h1
    // while the repertoire stores e1g1. The old inline
    // `r.uci === m.uci` stayed false forever → "Adopter ce coup" stuck.
    const store = [makePlaceholderMove('O-O', 'e1g1', CASTLE_FEN)];
    expect(isUciAdopted(store, CASTLE_FEN, 'e1h1')).toBe(true);
  });

  it('matches a legacy-raw store with a normalized query (fallback loop)', () => {
    const store = [makePlaceholderMove('O-O', 'e1h1', CASTLE_FEN)];
    expect(isUciAdopted(store, CASTLE_FEN, 'e1g1')).toBe(true);
    expect(isUciAdopted(store, CASTLE_FEN, 'e1h1')).toBe(true);
  });

  it('leaves ordinary moves on exact match (no normalization side effects)', () => {
    const store = [makePlaceholderMove('e5', 'e7e5', OPEN_FEN)];
    expect(isUciAdopted(store, OPEN_FEN, 'e7e5')).toBe(true);
    expect(isUciAdopted(store, OPEN_FEN, 'e7e6')).toBe(false);
    expect(isUciAdopted([], OPEN_FEN, 'e7e5')).toBe(false);
  });

  it('does not treat e1h1 as a castle when no king sits on e1', () => {
    const store = [makePlaceholderMove('Rh1?', 'e1h1', '8/8/8/8/8/8/8/R6R w - - 0 1')];
    // No king on e1: e1h1 is a (weird) rook move, not O-O - e1g1 must not match it.
    expect(isUciAdopted(store, '8/8/8/8/8/8/8/R6R w - - 0 1', 'e1g1')).toBe(false);
  });
});

describe('buildHistoryFromSans (games viewer)', () => {
  it('replays SANs into FEN-per-ply items with standard UCI', () => {
    const items = buildHistoryFromSans(['e4', 'e5', 'Nf3']);
    expect(items).toHaveLength(4);
    expect(items[0]).toMatchObject({ san: '', uci: '' });
    expect(items[1]).toMatchObject({ san: 'e4', uci: 'e2e4' });
    expect(items[2]).toMatchObject({ san: 'e5', uci: 'e7e5' });
    expect(items[3]).toMatchObject({ san: 'Nf3', uci: 'g1f3' });
    // Last FEN matches a real replay.
    const c = new Chess();
    c.move('e4');
    c.move('e5');
    c.move('Nf3');
    expect(items[3].fen).toBe(c.fen());
  });

  it('stops at the first illegal SAN, keeping the playable prefix', () => {
    const items = buildHistoryFromSans(['e4', 'bidule', 'Nf3']);
    expect(items.map((i) => i.san)).toEqual(['', 'e4']);
  });

  it('returns the root alone for an empty game', () => {
    const items = buildHistoryFromSans([]);
    expect(items).toHaveLength(1);
    expect(items[0].uci).toBe('');
  });
});
