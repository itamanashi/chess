import { describe, expect, it } from 'vitest';
import { Chess } from 'chess.js';
import {
  applyOpeningPatches,
  collectOpeningGroups,
  type OpeningPatch,
} from './openingGroups';
import type { RepertoireMove } from '../types/chess';

const ROOT = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

function mv(partial: Partial<RepertoireMove> & { uci: string; san: string; fen: string }): RepertoireMove {
  return {
    coup: partial.san,
    san: partial.san,
    uci: partial.uci,
    parties: 0,
    victoires_blancs: 0,
    nuls: 0,
    victoires_noirs: 0,
    fen: partial.fen,
    children: [],
    ...partial,
  } as RepertoireMove;
}

describe('collectOpeningGroups', () => {
  it('hérite du nom de l\u2019ancêtre et regroupe les variantes sous le parent', () => {
    const tree = [
      mv({
        uci: 'e2e4', san: 'e4', fen: 'fen-e4', parties: 100,
        ouverture: 'Sicilian Defense', children: [
          mv({ uci: 'c7c5', san: 'c5', fen: 'fen-c5', parties: 80 }),
          mv({
            uci: 'g1f3', san: 'Nf3', fen: 'fen-nf3', parties: 60,
            ouverture: 'Sicilian Defense: Najdorf Variation',
          }),
        ],
      }),
    ];
    const { parents, unknownFens } = collectOpeningGroups(tree, ROOT);
    expect(unknownFens).toEqual([]);
    expect(parents).toHaveLength(1);
    const sicilian = parents[0];
    expect(sicilian.key).toBe('Sicilian Defense');
    // Tronc (e4 + c5 hérité) + variante Najdorf.
    expect(sicilian.moves).toBe(3);
    expect(sicilian.leaves.map((l) => l.variant)).toEqual([null, 'Najdorf Variation']);
    expect(sicilian.leaves[0].moves).toBe(2);
    expect(sicilian.leaves[1].repFen).toBe('fen-nf3');
  });

  it('collecte les FEN sans nom (ni propre ni hérité), dédupliquées', () => {
    const tree = [
      mv({ uci: 'a2a3', san: 'a3', fen: 'fen-a3', parties: 5 }),
      mv({ uci: 'a2a3', san: 'a3', fen: 'fen-a3', parties: 3 }),
    ];
    const { parents, unknownFens } = collectOpeningGroups(tree, ROOT);
    expect(parents).toEqual([]);
    expect(unknownFens).toEqual(['fen-a3']);
  });
});

describe('applyOpeningPatches', () => {
  const after = (...sans: string[]): string => {
    const c = new Chess();
    for (const san of sans) c.move(san);
    return c.fen();
  };
  const e4 = after('e4');
  const e4e5 = after('e4', 'e5');

  it('remplit les champs manquants par FEN sans écraser', () => {
    const root = {
      fen: ROOT,
      children: [
        mv({ uci: 'e2e4', san: 'e4', fen: e4, children: [mv({ uci: 'e7e5', san: 'e5', fen: e4e5 })] }),
      ],
    };
    const patches: OpeningPatch[] = [
      { fen: e4e5, ouverture: "King's Pawn Game", eco: 'C20' },
      { fen: after('e4', 'c5'), ouverture: 'X', eco: 'Y' },
      { fen: '', ouverture: 'X', eco: 'Y' },
    ];
    expect(applyOpeningPatches(root, patches)).toBe(1);
    expect(root.children[0].children![0].ouverture).toBe("King's Pawn Game");
    expect(root.children[0].children![0].eco).toBe('C20');
    // Second passage : déjà rempli → 0 (pas d'écrasement).
    expect(applyOpeningPatches(root, patches.slice(0, 1))).toBe(0);
  });

  it('retrouve les transpositions (même FEN sur deux chemins)', () => {
    const same = after('Nf3', 'd5', 'e3');
    const root = {
      fen: ROOT,
      children: [
        mv({ uci: 'g1f3', san: 'Nf3', fen: after('Nf3'), children: [mv({ uci: 'e2e3', san: 'e3', fen: same })] }),
        mv({ uci: 'e2e3', san: 'e3', fen: after('e3'), children: [mv({ uci: 'g1f3', san: 'Nf3', fen: same })] }),
      ],
    };
    expect(applyOpeningPatches(root, [{ fen: same, ouverture: 'N', eco: 'E' }])).toBe(2);
  });
});
