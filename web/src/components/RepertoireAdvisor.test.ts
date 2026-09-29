import { describe, expect, it } from 'vitest';
import type { EngineMove, LichessMove } from '../types/chess';
import { adoptPayloadForMove, rankRepertoireMoves } from '../services/repertoireScore';

const CASTLE_FEN = 'r3k2r/pppppppp/8/8/8/8/PPPPPPPP/R3K2R w KQkq - 0 1';

function statMove(san: string, uci: string, white: number, draws: number, black: number): LichessMove {
  return { san, uci, white, draws, black };
}

function engineMove(san: string, uci: string, cp: number): EngineMove {
  return { uci, san, cp, depth: 18, scoreFormatted: '+0.40', pvSans: [san] };
}

describe('adoptPayloadForMove (audit B5)', () => {
  it('carries the normalized row UCI, not the raw Chess960 statsMove', () => {
    // End-to-end through the real pipeline: Lichess says e1h1, the row key
    // is e1g1, and the adopt payload must be e1g1 (the key isAdopted saw).
    const [m] = rankRepertoireMoves({
      fen: CASTLE_FEN,
      playerColor: 'white',
      eloTier: 'mid',
      engine: [],
      stats: [statMove('O-O', 'e1h1', 100, 20, 30)],
    });
    expect(m.uci).toBe('e1g1');
    const payload = adoptPayloadForMove(m);
    expect(payload.uci).toBe('e1g1');
    // …while keeping the real Lichess stats (not zeroed).
    expect(payload.white).toBe(100);
    expect(payload.draws).toBe(20);
    expect(payload.black).toBe(30);
    expect(payload.san).toBe('O-O');
  });

  it('falls back to zeroed stats with the row UCI when there is no statsMove', () => {
    const [m] = rankRepertoireMoves({
      fen: CASTLE_FEN,
      playerColor: 'white',
      eloTier: 'mid',
      engine: [engineMove('O-O', 'e1g1', 40)],
      stats: [],
    });
    expect(m.statsMove).toBeUndefined();
    expect(adoptPayloadForMove(m)).toEqual({
      san: 'O-O',
      uci: 'e1g1',
      white: 0,
      draws: 0,
      black: 0,
    });
  });
});
