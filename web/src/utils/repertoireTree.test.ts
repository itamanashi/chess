import { describe, expect, it } from 'vitest';
import {
  findUciPathToPosition,
  getTrainerPositionKeys,
  mergeAutoRoot,
} from './repertoireTree';
import { INITIAL_FEN } from './repertoire';
import type { RepertoireMove, RepertoireRoot } from '../types/chess';

function move(san: string, uci: string, parties = 100, extra: Partial<RepertoireMove> = {}): RepertoireMove {
  return {
    coup: san, san, uci, parties,
    victoires_blancs: 50, nuls: 25, victoires_noirs: 25,
    fen: INITIAL_FEN, children: [], ...extra,
  };
}

describe('mergeAutoRoot — fusion BFS dans le répertoire', () => {
  it('ajoute les nouveaux coups sans dupliquer (par UCI)', () => {
    const target: RepertoireRoot = { fen: INITIAL_FEN, children: [move('e4', 'e2e4')] };
    const source: RepertoireRoot = {
      fen: INITIAL_FEN,
      children: [move('e4', 'e2e4', 200), move('d4', 'd2d4')],
    };
    expect(mergeAutoRoot(target, source)).toBe(1);
    expect(target.children.map((c) => c.san).sort()).toEqual(['d4', 'e4']);
    // Stats les plus riches conservées sur le coup existant.
    expect(target.children.find((c) => c.san === 'e4')?.parties).toBe(200);
  });

  describe('findUciPathToPosition', () => {
    it('finds a stored position through its move path, ignoring FEN counters', () => {
      const afterE4 = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1';
      const root: RepertoireRoot = {
        fen: INITIAL_FEN,
        children: [move('e4', 'e2e4', 100, { fen: afterE4 })],
      };

      expect(findUciPathToPosition(root, `${afterE4.split(' ').slice(0, 4).join(' ')} 9 5`))
        .toEqual(['e2e4']);
      expect(findUciPathToPosition(root, '8/8/8/8/8/8/8/8 w - - 0 1')).toBeNull();
    });
  });

  describe('getTrainerPositionKeys', () => {
    it('lists only positions where the repertoire side has a move to learn', () => {
        const afterE4 = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1';
        const afterE5 = 'rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2';
        const root: RepertoireRoot = {
          fen: INITIAL_FEN,
          children: [
            move('e4', 'e2e4', 100, {
              fen: afterE4,
              children: [
                move('e5', 'e7e5', 100, {
                  fen: afterE5,
                  children: [move('Nf3', 'g1f3')],
                }),
              ],
            }),
          ],
        };

        expect(getTrainerPositionKeys(root, 'white')).toEqual([
          INITIAL_FEN.split(' ').slice(0, 4).join(' '),
          afterE5.split(' ').slice(0, 4).join(' '),
        ]);
        expect(getTrainerPositionKeys(root, 'black')).toEqual([
          afterE4.split(' ').slice(0, 4).join(' '),
        ]);
    });
  });

  it('préserve isMate : nouveau nœud + nœud existant', () => {
    const mate = move('Qh4#', 'd8h4', 5, { isMate: true });
    const target: RepertoireRoot = {
      fen: INITIAL_FEN,
      children: [move('Nf6', 'g8f6', 8000), move('Qh4#', 'd8h4', 5)],
    };
    const source: RepertoireRoot = {
      fen: INITIAL_FEN,
      children: [move('Nf6', 'g8f6', 8000), mate],
    };
    mergeAutoRoot(target, source);
    // Nouveau : flag cloné ; existant : flag complété (jamais perdu).
    expect(target.children.find((c) => c.san === 'Qh4#')?.isMate).toBe(true);
    const target2: RepertoireRoot = { fen: INITIAL_FEN, children: [] };
    mergeAutoRoot(target2, source);
    expect(target2.children.find((c) => c.san === 'Qh4#')?.isMate).toBe(true);
  });
});
