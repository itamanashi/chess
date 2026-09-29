import { describe, expect, it } from 'vitest';
import { Chess } from 'chess.js';
import { validateRoot, validateStoredItem } from './schemas';

const CASTLE_FEN = 'r3k2r/pppppppp/8/8/8/8/PPPPPPPP/R3K2R w KQkq - 0 1';

function castleChildFen(): string {
  const c = new Chess(CASTLE_FEN);
  const m = c.move({ from: 'e1', to: 'g1' });
  if (!m) throw new Error('fixture setup failed');
  return c.fen();
}

describe('UCI normalization at the validation boundary', () => {
  it('converts Chess960-style castles (e1h1 → e1g1) on import', () => {
    const childFen = castleChildFen();
    const v = validateRoot({
      fen: CASTLE_FEN,
      children: [{ san: 'O-O', uci: 'e1h1', fen: childFen, children: [] }],
    });
    expect(v.root).not.toBeNull();
    expect(v.root?.children).toHaveLength(1);
    expect(v.root?.children[0]?.uci).toBe('e1g1');
    expect(v.root?.children[0]?.fen).toBe(childFen);
    expect(v.pruned).toBe(0);
  });

  it('normalizes nested levels against their own parent FEN', () => {
    const c = new Chess(CASTLE_FEN);
    c.move({ from: 'e1', to: 'g1' }); // O-O
    const afterCastle = c.fen();
    c.move({ from: 'e7', to: 'e5' }); // …e5
    const afterE5 = c.fen();
    const v = validateRoot({
      fen: CASTLE_FEN,
      children: [
        {
          san: 'O-O',
          uci: 'e1h1',
          fen: afterCastle,
          children: [{ san: 'e5', uci: 'e7e5', fen: afterE5, children: [] }],
        },
      ],
    });
    const top = v.root?.children[0];
    expect(top?.uci).toBe('e1g1');
    expect(top?.children?.[0]?.uci).toBe('e7e5');
  });

  it('leaves standard UCIs untouched', () => {
    const after = new Chess(CASTLE_FEN);
    after.move({ from: 'e2', to: 'e4' });
    const v = validateRoot({
      fen: CASTLE_FEN,
      children: [{ san: 'e4', uci: 'e2e4', fen: after.fen(), children: [] }],
    });
    expect(v.root?.children[0]?.uci).toBe('e2e4');
  });

  it('normalizes during stored-library migration too', () => {
    const childFen = castleChildFen();
    const v = validateStoredItem(
      { title: 'Vieux', color: 'white', root: { fen: CASTLE_FEN, children: [{ san: 'O-O', uci: 'e1h1', fen: childFen }] } },
      0,
      new Date().toISOString(),
    );
    expect(v.item?.root.children[0]?.uci).toBe('e1g1');
  });

  it('still rejects invalid castles instead of normalizing them', () => {
    // e1h1 from the initial position: king present but the "castle" is illegal.
    // Normalization maps the shape (king on e1), FEN validity is separate.
    const v = validateRoot({
      fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
      children: [
        {
          san: 'O-O-O??',
          uci: 'zzz',
          fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
          children: [],
        },
      ],
    });
    expect(v.root?.children).toHaveLength(0);
    expect(v.pruned).toBe(1);
  });
});
