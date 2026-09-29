import { describe, expect, it } from 'vitest';
import { Chess } from 'chess.js';
import { generateTreePgn, INITIAL_FEN } from './repertoire';
import type { RepertoireMove, RepertoireRoot } from '../types/chess';

function move(
  san: string,
  uci: string,
  fen: string,
  parties = 800,
  children: RepertoireMove[] = [],
  ouverture = 'Ouverture Test',
): RepertoireMove {
  return {
    coup: san, uci, san, parties,
    victoires_blancs: 400, nuls: 100, victoires_noirs: 300,
    ouverture, eco: 'B00', fen, children,
  };
}

const FEN_E4 = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1';
const FEN_E4_E5 = 'rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2';

describe('generateTreePgn (export batch offline)', () => {
  it("arbre vide -> chaîne vide (rien à exporter)", () => {
    expect(generateTreePgn({ fen: INITIAL_FEN, children: [] })).toBe('');
  });

  it('ligne principale numérotée avec en-têtes et commentaires stats', () => {
    const root: RepertoireRoot = {
      fen: INITIAL_FEN,
      children: [
        move('e4', 'e2e4', FEN_E4, 800, [
          move('e5', 'e7e5', FEN_E4_E5, 500, [], 'Défense Test'),
        ]),
      ],
    };
    const pgn = generateTreePgn(root, { white: 'Répertoire', black: 'Adversaire' });
    expect(pgn).toContain('[Event "Répertoire auto (BFS)"]');
    expect(pgn).toContain(`[FEN "${INITIAL_FEN}"]`);
    expect(pgn).toContain('[SetUp "1"]');
    expect(pgn).toContain('[White "Répertoire"]');
    expect(pgn).toContain('1. e4 {Ouverture Test — 800 parties} e5 {Défense Test — 500 parties}');
    expect(pgn.trimEnd().endsWith('*')).toBe(true);
  });

  it('branches secondaires entre parenthèses, principale hors parenthèses', () => {
    const root: RepertoireRoot = {
      fen: INITIAL_FEN,
      children: [
        move('e4', 'e2e4', FEN_E4, 800),
        move('d4', 'd2d4', 'rnbqkbnr/pppppppp/8/8/3P4/8/PPP1PPPP/RNBQKBNR b KQkq - 0 1', 600),
      ],
    };
    const pgn = generateTreePgn(root);
    expect(pgn).toContain('1. e4 {Ouverture Test — 800 parties}');
    expect(pgn).toContain('(1. d4 {Ouverture Test — 600 parties})');
  });

  it('racine trait noir -> premier coup avec "N..."', () => {
    const root: RepertoireRoot = {
      fen: FEN_E4,
      children: [
        move('c5', 'c7c5', 'rnbqkbnr/pp1ppppp/8/2p5/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2', 300),
      ],
    };
    const pgn = generateTreePgn(root);
    expect(pgn).toContain('1... c5 {Ouverture Test — 300 parties}');
  });

  it('coups sans SAN ignorés', () => {
    const root: RepertoireRoot = {
      fen: INITIAL_FEN,
      children: [
        { ...move('e4', 'e2e4', FEN_E4), san: '' },
        move('d4', 'd2d4', 'rnbqkbnr/pppppppp/8/8/3P4/8/PPP1PPPP/RNBQKBNR b KQkq - 0 1', 600),
      ],
    };
    const pgn = generateTreePgn(root);
    expect(pgn).not.toContain('e4');
    expect(pgn).toContain('1. d4');
  });

  it('PGN rechargeable par chess.js (ligne principale intacte)', () => {
    const root: RepertoireRoot = {
      fen: INITIAL_FEN,
      children: [
        move('e4', 'e2e4', FEN_E4, 800, [
          move('e5', 'e7e5', FEN_E4_E5, 500, [
            move('Nf3', 'g1f3', 'rnbqkbnr/pppp1ppp/8/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R b KQkq - 1 2', 400),
          ]),
        ]),
        move('d4', 'd2d4', 'rnbqkbnr/pppppppp/8/8/3P4/8/PPP1PPPP/RNBQKBNR b KQkq - 0 1', 600),
      ],
    };
    const probe = new Chess();
    probe.loadPgn(generateTreePgn(root));
    expect(probe.history()).toEqual(['e4', 'e5', 'Nf3']);
  });
});
