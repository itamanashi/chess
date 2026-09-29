import { describe, expect, it } from 'vitest';
import {
  castlePhaseOf,
  computeCastlingStats,
  detectGameCastling,
  parseCastleSan,
} from './castling';

describe('parseCastleSan', () => {
  it('reconnaît les deux roques, avec ou sans suffixe', () => {
    expect(parseCastleSan('O-O')).toBe('kingside');
    expect(parseCastleSan('O-O-O')).toBe('queenside');
    expect(parseCastleSan('O-O+')).toBe('kingside');
    expect(parseCastleSan('O-O-O#')).toBe('queenside');
  });

  it('rejette les autres coups (O-O-O testé avant O-O)', () => {
    expect(parseCastleSan('e4')).toBeNull();
    expect(parseCastleSan('Nf3')).toBeNull();
    expect(parseCastleSan('O-O-O-O')).toBeNull();
  });
});

describe('detectGameCastling', () => {
  // Italien : 1.e4 e5 2.Nf3 Nc6 3.Bc4 Bc5 4.O-O Nf6
  const italian = ['e4', 'e5', 'Nf3', 'Nc6', 'Bc4', 'Bc5', 'O-O', 'Nf6'];

  it('attribue le roque au bon camp (moi Blancs)', () => {
    expect(detectGameCastling(italian, 'w')).toEqual({ mine: 'kingside', minePly: 7, opponent: null });
  });

  it('attribue le roque au bon camp (moi Noirs)', () => {
    expect(detectGameCastling(italian, 'b')).toEqual({ mine: null, minePly: null, opponent: 'kingside' });
  });

  it('détecte les deux roques et le bon pli', () => {
    const sans = [...italian, 'd3', 'O-O'];
    expect(detectGameCastling(sans, 'w')).toEqual({ mine: 'kingside', minePly: 7, opponent: 'kingside' });
  });

  it('grand roque adverse', () => {
    expect(detectGameCastling(['e4', 'e5', 'Nf3', 'O-O-O'], 'w').opponent).toBe('queenside');
  });

  it('sans roque ni coups', () => {
    expect(detectGameCastling(['e4', 'e5'], 'w')).toEqual({ mine: null, minePly: null, opponent: null });
    expect(detectGameCastling([], 'w')).toEqual({ mine: null, minePly: null, opponent: null });
  });
});

describe('castlePhaseOf', () => {
  it('suit les bornes du rapport (20/60)', () => {
    expect(castlePhaseOf(null)).toBe('none');
    expect(castlePhaseOf(7)).toBe('opening');
    expect(castlePhaseOf(20)).toBe('opening');
    expect(castlePhaseOf(21)).toBe('middlegame');
    expect(castlePhaseOf(61)).toBe('endgame');
  });
});

describe('computeCastlingStats', () => {
  it('remplit phases et matrice 3×3, isole les PGN illisibles', () => {
    const stats = computeCastlingStats([
      { sans: ['e4', 'e5', 'Nf3', 'Nc6', 'Bc4', 'Bc5', 'O-O', 'Nf6'], myColor: 'w', outcome: 'win' },
      { sans: ['e4', 'e5', 'Nf3', 'O-O-O'], myColor: 'w', outcome: 'loss' },
      { sans: ['e4', 'e5'], myColor: 'w', outcome: 'draw' },
      { sans: [], myColor: 'w', outcome: 'win' },
    ]);
    expect(stats.total).toBe(3);
    expect(stats.unknown).toBe(1);
    expect(stats.byPhase.opening).toEqual({ wins: 1, draws: 0, losses: 0 });
    expect(stats.byPhase.none).toEqual({ wins: 0, draws: 1, losses: 1 });
    expect(stats.matrix.kingside.none).toEqual({ wins: 1, draws: 0, losses: 0 });
    expect(stats.matrix.none.queenside).toEqual({ wins: 0, draws: 0, losses: 1 });
    expect(stats.matrix.none.none).toEqual({ wins: 0, draws: 1, losses: 0 });
  });
});
