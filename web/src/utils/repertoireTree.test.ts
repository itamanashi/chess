import { describe, expect, it } from 'vitest';
import { mergeAutoRoot } from './repertoireTree';
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
