import { describe, expect, it } from 'vitest';
import { Chess } from 'chess.js';
import { INITIAL_FEN } from '../utils/repertoire';
import { parseImport } from './libraryRepository';

describe('Python repertoire imports', () => {
  it('maps games and white/draws/black aliases to web statistics', () => {
    const chess = new Chess();
    const move = chess.move('e4');
    const imported = parseImport(
      JSON.stringify({
        title: 'Export Python',
        root: {
          fen: INITIAL_FEN,
          children: [
            {
              coup: move.san,
              uci: `${move.from}${move.to}`,
              fen: chess.fen(),
              games: 42,
              white: 18,
              draws: 16,
              black: 8,
              children: [],
            },
          ],
        },
      }),
      'python.json',
    );

    expect(imported.items).toHaveLength(1);
    expect(imported.items[0]?.title).toBe('Export Python');
    expect(imported.items[0]?.root.children[0]).toMatchObject({
      san: 'e4',
      coup: 'e4',
      parties: 42,
      victoires_blancs: 18,
      nuls: 16,
      victoires_noirs: 8,
    });
    expect(imported.warnings).toEqual([]);
  });

  it('keeps canonical Python field names when aliases are also present', () => {
    const chess = new Chess();
    const move = chess.move('d4');
    const imported = parseImport(
      JSON.stringify({
        fen: INITIAL_FEN,
        children: [
          {
            san: move.san,
            uci: `${move.from}${move.to}`,
            fen: chess.fen(),
            parties: 7,
            victoires_blancs: 3,
            nuls: 2,
            victoires_noirs: 2,
            games: 99,
            white: 88,
            draws: 77,
            black: 66,
          },
        ],
      }),
      'python.json',
    );

    expect(imported.items[0]?.root.children[0]).toMatchObject({
      parties: 7,
      victoires_blancs: 3,
      nuls: 2,
      victoires_noirs: 2,
    });
  });
});
