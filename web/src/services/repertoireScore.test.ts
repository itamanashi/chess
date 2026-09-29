import { describe, expect, it } from 'vitest';
import type { EngineMove, LichessMove } from '../types/chess';
import { WARNING_ENGINE_ONLY_CHOICE } from '../i18n';
import { DEFAULT_RANKING_CONFIG } from './rankingConfig';
import {
  buildHumanJustification,
  classifyConfidence,
  computeOpponentEdge,
  computeScores,
  eloTierForTarget,
  positionRatingMean,
  rankRepertoireMoves,
  ratingAdjustedRate,
  resolveWeights,
  type RankInput,
} from './repertoireScore';

const FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

function statMove(san: string, uci: string, white: number, draws: number, black: number): LichessMove {
  return { san, uci, white, draws, black };
}

function engineMove(san: string, uci: string, cp: number, depth = 18): EngineMove {
  return {
    uci,
    san,
    cp,
    depth,
    scoreFormatted: `+${(cp / 100).toFixed(2)}`,
    pvSans: [san],
  };
}

function baseInput(overrides: Partial<RankInput> = {}): RankInput {
  return { fen: FEN, playerColor: 'white', eloTier: 'mid', engine: [], stats: [], ...overrides };
}

describe('computeScores (stage 1, pure)', () => {
  it('shrinks a 3/3 small sample toward 50% instead of trusting 100%', () => {
    const rows = computeScores(baseInput({ stats: [statMove('g4', 'g2g4', 3, 0, 0)] }));
    expect(rows).toHaveLength(1);
    const [r] = rows;
    expect(r.scoreRate).toBe(1);
    // (1*3 + 0.5*60) / (3 + 60) ≈ 0.524 — the g4 trap must NOT score ~1.
    expect(r.practicalScore).toBeLessThan(0.55);
    expect(r.practicalScore).toBeCloseTo(33 / 63, 4);
    expect(r.reliability).toBeCloseTo(3 / 303, 5);
  });

  it('honours an injected config (shrinkK = 0 trusts the raw rate)', () => {
    const rows = computeScores(
      baseInput({ stats: [statMove('g4', 'g2g4', 3, 0, 0)] }),
      { ...DEFAULT_RANKING_CONFIG, shrinkK: 0 },
    );
    expect(rows[0].practicalScore).toBe(1);
  });

  it('emits no text: justification/warnings/confidence are later stages', () => {
    const rows = computeScores(
      baseInput({ stats: [statMove('e4', 'e2e4', 100, 20, 30)], engine: [engineMove('e4', 'e2e4', 40)] }),
    );
    for (const r of rows) {
      expect('justification' in r).toBe(false);
      expect('warnings' in r).toBe(false);
      expect('confidence' in r).toBe(false);
    }
  });

  it('flags every engine tie as best, not just the first', () => {
    const rows = computeScores(
      baseInput({
        engine: [engineMove('e4', 'e2e4', 100), engineMove('d4', 'd2d4', 100), engineMove('Nf3', 'g1f3', 20)],
      }),
    );
    const best = rows.filter((r) => r.isEngineBest).map((r) => r.uci).sort();
    expect(best).toEqual(['d2d4', 'e2e4']);
  });

  it('treats an engine-only move as neutral practice (0.5) with best engineScore', () => {
    const rows = computeScores(baseInput({ engine: [engineMove('Nf3', 'g1f3', 30)] }));
    expect(rows).toHaveLength(1);
    const [r] = rows;
    expect(r.hasStats).toBe(false);
    expect(r.hasEngine).toBe(true);
    expect(r.practicalScore).toBe(0.5);
    expect(r.engineScore).toBe(1);
  });

  it('normalizes a Chess960 castle row but keeps the raw statsMove (audit B5)', () => {
    // Source of the B5 asymmetry: the row key is standard (e1g1) while the
    // attached Lichess move stays raw (e1h1). Consumers must query with
    // row.uci and adopt with a normalized payload — never statsMove.uci.
    const castleFen = 'r3k2r/pppppppp/8/8/8/8/PPPPPPPP/R3K2R w KQkq - 0 1';
    const rows = computeScores(
      baseInput({ fen: castleFen, stats: [statMove('O-O', 'e1h1', 100, 20, 30)] }),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].uci).toBe('e1g1');
    expect(rows[0].san).toBe('O-O');
    expect(rows[0].statsMove?.uci).toBe('e1h1');
    expect(rows[0].games).toBe(150);
  });

  it('merges stats and engine castles into one row across the 960 boundary', () => {
    const castleFen = 'r3k2r/pppppppp/8/8/8/8/PPPPPPPP/R3K2R w KQkq - 0 1';
    const rows = computeScores(
      baseInput({
        fen: castleFen,
        stats: [statMove('O-O', 'e1h1', 100, 20, 30)],
        engine: [engineMove('O-O', 'e1g1', 40)],
      }),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].uci).toBe('e1g1');
    expect(rows[0].hasStats).toBe(true);
    expect(rows[0].hasEngine).toBe(true);
  });
});

describe('classifyConfidence (stage 2)', () => {
  it('high: large sample + deep engine', () => {
    expect(classifyConfidence({ games: 6000, depth: 18, hasEngine: true, hasStats: true })).toBe('high');
  });

  it('medium: solid sample or deep engine-only move', () => {
    expect(classifyConfidence({ games: 800, depth: 12, hasEngine: true, hasStats: true })).toBe('medium');
    expect(classifyConfidence({ games: 0, depth: 16, hasEngine: true, hasStats: false })).toBe('medium');
  });

  it('low: thin data', () => {
    expect(classifyConfidence({ games: 10, depth: 5, hasEngine: false, hasStats: true })).toBe('low');
    expect(classifyConfidence({ games: 0, depth: 0, hasEngine: false, hasStats: false })).toBe('low');
  });

  it('follows an injected config', () => {
    const config = {
      ...DEFAULT_RANKING_CONFIG,
      confidence: {
        ...DEFAULT_RANKING_CONFIG.confidence,
        byEndpoint: {
          ...DEFAULT_RANKING_CONFIG.confidence.byEndpoint,
          lichess: { ...DEFAULT_RANKING_CONFIG.confidence.byEndpoint.lichess, high: 10 },
        },
      },
    };
    expect(classifyConfidence({ games: 10, depth: 18, hasEngine: true, hasStats: true }, config)).toBe('high');
  });
});

describe('buildHumanJustification (stage 3)', () => {
  it('explains a pure engine choice and warns about missing stats', () => {
    const [row] = computeScores(baseInput({ engine: [engineMove('Nf3', 'g1f3', 30, 14)] }));
    const { justification, warnings } = buildHumanJustification(row, {
      isWinner: true,
      engineBest: null,
      tier: 'mid',
    });
    expect(warnings).toContain(WARNING_ENGINE_ONLY_CHOICE);
    expect(justification).toContain('moteur pur');
  });

  it('adds low-sample and shallow-depth warnings from config thresholds', () => {
    const [row] = computeScores(
      baseInput({
        stats: [statMove('e4', 'e2e4', 40, 5, 5)],
        engine: [engineMove('e4', 'e2e4', 40, 8)],
      }),
    );
    const { warnings } = buildHumanJustification(row, { isWinner: true, engineBest: null, tier: 'low' });
    expect(warnings.some((w) => w.includes('Échantillon faible'))).toBe(true);
    expect(warnings.some((w) => w.includes('Profondeur moteur limitée'))).toBe(true);
  });
});

describe('rankRepertoireMoves (orchestration)', () => {
  // A = engine star (+150) with mediocre practice (50% over 2500 games).
  // B = practical hero (+50) with strong practice (85% over 5000 games).
  const engine = [engineMove('e4', 'e2e4', 150), engineMove('d4', 'd2d4', 50)];
  const stats = [
    statMove('e4', 'e2e4', 1000, 500, 1000),
    statMove('d4', 'd2d4', 4000, 500, 500),
  ];

  it('low Elo prefers the practical hero', () => {
    const rows = rankRepertoireMoves({ ...baseInput(), eloTier: 'low', engine, stats });
    expect(rows[0].uci).toBe('d2d4');
  });

  it('high Elo prefers the engine star', () => {
    const rows = rankRepertoireMoves({ ...baseInput(), eloTier: 'high', engine, stats });
    expect(rows[0].uci).toBe('e2e4');
  });

  it('produces complete UI rows (confidence + justification + warnings)', () => {
    const rows = rankRepertoireMoves({ ...baseInput(), eloTier: 'mid', engine, stats });
    expect(rows).toHaveLength(2);
    for (const r of rows) {
      expect(['high', 'medium', 'low']).toContain(r.confidence);
      expect(typeof r.justification).toBe('string');
      expect(r.justification.length).toBeGreaterThan(10);
      expect(Array.isArray(r.warnings)).toBe(true);
    }
  });
});

describe('resolveWeights (audit A1: capped transfer, K = 300)', () => {
  const LOW = { engine: 0.25, practical: 0.6, frequency: 0.1 };

  it('caps the engine transfer at 1.3x base in the construction zone', () => {
    // n = 900: uncapped transfer would give wE = 0.355.
    const w900 = resolveWeights(LOW, 900, true);
    expect(w900.engine).toBe(0.325);
    expect(w900.practical).toBeCloseTo(0.495, 12);
    expect(w900.frequency).toBe(0.1);
    // n = 0: uncapped transfer would give wE = 0.67.
    const w0 = resolveWeights(LOW, 0, true);
    expect(w0.engine).toBe(0.325);
    expect(w0.practical).toBeCloseTo(0.18, 12);
  });

  it('lets the cap go once the sample is large', () => {
    // n = 7600: natural transfer (0.279) below the 0.325 cap.
    const w = resolveWeights(LOW, 7600, true);
    expect(w.engine).toBeCloseTo(0.266, 3);
    expect(w.practical).toBeCloseTo(0.584, 3);
  });

  it('practice outweighs engine at low tier in the construction zone', () => {
    // The audit's core demand: below the old crossover (2800 games),
    // announced weights (0.25 < 0.60) must actually hold. Takeover happens
    // past ~159 games (0.6·(0.3+0.7r) > 0.325); below that, caution rules
    // but the engine can never exceed its 1.3x cap (no more 1.7x inversion).
    for (const n of [200, 500, 900, 1200, 2000]) {
      const w = resolveWeights(LOW, n, true);
      expect(w.practical).toBeGreaterThan(w.engine);
    }
    for (const n of [0, 50, 100, 10000]) {
      expect(resolveWeights(LOW, n, true).engine).toBeLessThanOrEqual(0.325);
    }
  });

  it('keeps full practice weight without engine (no transfer target)', () => {
    expect(resolveWeights(LOW, 900, false)).toEqual({ engine: 0, practical: 0.6, frequency: 0.1 });
  });
});

describe('g4 guard holds at shrinkK = 60 (audit A2)', () => {
  // g4: 3/3 (shrinks to 0.524) with a decent engine score must still lose
  // to a solid main line — the guard survives the recalibration.
  const engine = [
    { uci: 'd2d4', san: 'd4', cp: 60, depth: 18, scoreFormatted: '+0.60', pvSans: ['d4'] },
    { uci: 'g2g4', san: 'g4', cp: 30, depth: 18, scoreFormatted: '+0.30', pvSans: ['g4'] },
  ];
  const stats = [
    { san: 'd4', uci: 'd2d4', white: 1100, draws: 200, black: 700 },
    { san: 'g4', uci: 'g2g4', white: 3, draws: 0, black: 0 },
  ];

  it('a 3/3 flash never outranks a solid main line', () => {
    const rows = rankRepertoireMoves({ ...baseInput(), eloTier: 'low', engine, stats });
    const g4 = rows.find((r) => r.uci === 'g2g4')!;
    expect(g4.practicalScore).toBeCloseTo(33 / 63, 4);
    expect(rows[0].uci).toBe('d2d4');
  });
});

describe('no mainline bonus (audit A3)', () => {
  // Same engine eval (cp 40), same 65% rate; only volume differs:
  // A = 700 games (share 92%), B = 60 games (share 8%).
  // Pre-fix gap was 11 points (80 vs 69), ~7.5 of pure popularity bonus.
  const engine = [
    { uci: 'e2e4', san: 'e4', cp: 40, depth: 18, scoreFormatted: '+0.40', pvSans: ['e4'] },
    { uci: 'd2d4', san: 'd4', cp: 40, depth: 18, scoreFormatted: '+0.40', pvSans: ['d4'] },
  ];
  const stats = [
    { san: 'e4', uci: 'e2e4', white: 385, draws: 140, black: 175 },
    { san: 'd4', uci: 'd2d4', white: 36, draws: 6, black: 18 },
  ];

  it('popularity alone moves the score by < 5 points, not ~11', () => {
    const rows = rankRepertoireMoves({ ...baseInput(), eloTier: 'low', engine, stats });
    const gap = Math.abs(rows[0].finalScore - rows[1].finalScore);
    expect(gap).toBeLessThanOrEqual(4);
  });

  it('frequencyShare survives as data (tiebreak + future A5 use)', () => {
    const rows = computeScores({ ...baseInput(), eloTier: 'low', engine, stats });
    const byUci = new Map(rows.map((r) => [r.uci, r]));
    expect(byUci.get('e2e4')?.frequencyShare).toBeCloseTo(700 / 760, 5);
    expect(byUci.get('d2d4')?.frequencyShare).toBeCloseTo(60 / 760, 5);
  });
});

describe('uncovered moves inherit the worst analyzed score (audit A4)', () => {
  // Three moves, identical stats (400 games @58%). Engine covers two:
  // SF#1 (best) and a -150cp line (0.4). The third escapes MultiPV.
  const engine = [
    { uci: 'd2d4', san: 'd4', cp: 60, depth: 18, scoreFormatted: '+0.60', pvSans: ['d4'] },
    { uci: 'c2c4', san: 'c4', cp: -90, depth: 18, scoreFormatted: '-0.90', pvSans: ['c4'] },
  ];
  const stats = [
    { san: 'd4', uci: 'd2d4', white: 200, draws: 64, black: 136 },
    { san: 'c4', uci: 'c2c4', white: 200, draws: 64, black: 136 },
    { san: 'Nf3', uci: 'g1f3', white: 200, draws: 64, black: 136 },
  ];
  const input = { ...baseInput(), eloTier: 'low' as const, engine, stats };

  it('imputes the lot minimum instead of the 0.5 freebie', () => {
    const rows = computeScores(input);
    const byUci = new Map(rows.map((r) => [r.uci, r]));
    expect(byUci.get('g1f3')?.hasEngine).toBe(false);
    expect(byUci.get('g1f3')?.engineScore).toBe(byUci.get('c2c4')?.engineScore);
    expect(byUci.get('g1f3')?.engineScore).toBeLessThan(0.5);
  });

  it('an unanalyzed move never outranks its analyzed-bad twin on equal stats', () => {
    const rows = rankRepertoireMoves(input);
    const byUci = new Map(rows.map((r) => [r.uci, r]));
    expect(byUci.get('g1f3')!.finalScore).toBeLessThanOrEqual(byUci.get('c2c4')!.finalScore);
  });

  it('keeps the neutral 0.5 when there is no engine at all', () => {
    const rows = computeScores({ ...baseInput(), engine: [], stats });
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect(r.engineScore).toBe(0.5);
  });
});

describe('trap can win at low tier (audit A1 acceptance)', () => {
  // Main line: engine best (+50), 600 games @55%. Trap: -20cp, 100% over 300.
  const engine = [
    { uci: 'd2d4', san: 'd4', cp: 50, depth: 18, scoreFormatted: '+0.50', pvSans: ['d4'] },
    { uci: 'e2e4', san: 'e4', cp: 30, depth: 18, scoreFormatted: '+0.30', pvSans: ['e4'] },
  ];
  const stats = [
    { san: 'd4', uci: 'd2d4', white: 300, draws: 60, black: 240 },
    { san: 'e4', uci: 'e2e4', white: 300, draws: 0, black: 0 },
  ];

  it('-20cp at 100%/300 beats the theoretical main line', () => {
    const rows = rankRepertoireMoves({ ...baseInput(), eloTier: 'low', engine, stats });
    expect(rows[0].uci).toBe('e2e4');
  });
});

describe('eloTierForTarget', () => {
  it('maps UI bands to weighting tiers', () => {
    expect(eloTierForTarget('beginner')).toBe('low');
    expect(eloTierForTarget('all_700')).toBe('low');
    expect(eloTierForTarget('club_mid')).toBe('mid');
    expect(eloTierForTarget('masters')).toBe('high');
    expect(eloTierForTarget('club_high')).toBe('high');
  });
});

describe('computeOpponentEdge (audit A5)', () => {
  // Adversaries defend well: 800 games @37.5% for us, 200 @40%.
  const solidReplies = [
    statMove('e5', 'e7e5', 200, 200, 400),
    statMove('c5', 'c7c5', 60, 40, 100),
  ];
  // Adversaries blunder: single reply, 500 games @90% for us.
  const leakyReplies = [statMove('f6?', 'g8f6', 400, 100, 0)];

  it('is negative when replies outperform... actually underperform theory', () => {
    const edge = computeOpponentEdge({
      replies: solidReplies,
      playerColor: 'white',
      engineCp: 100,
    });
    // E ≈ 0.3916, P(engine +100) ≈ 0.6401 → edge ≈ -0.248.
    expect(edge).toBeCloseTo(-0.2484, 3);
  });

  it('is positive when adversaries err', () => {
    const edge = computeOpponentEdge({
      replies: leakyReplies,
      playerColor: 'white',
      engineCp: 0,
    });
    // E ≈ 0.8571 shrunk... precisely (450+30)/560, P(0) = 0.5.
    expect(edge).toBeCloseTo(480 / 560 - 0.5, 5);
    expect(edge).toBeGreaterThan(0.25);
  });

  it('shrinks tiny samples instead of trusting them', () => {
    const edge = computeOpponentEdge({
      replies: [statMove('x', 'a2a3', 5, 0, 0)],
      playerColor: 'white',
      engineCp: 0,
    });
    // (5+30)/65 ≈ 0.538, not 1.0.
    expect(edge).toBeCloseTo(35 / 65 - 0.5, 5);
  });

  it('reads black wins from the black perspective', () => {
    const edgeWhite = computeOpponentEdge({
      replies: [statMove('x', 'a2a3', 100, 0, 0)],
      playerColor: 'white',
      engineCp: 0,
    });
    const edgeBlack = computeOpponentEdge({
      replies: [statMove('x', 'a2a3', 0, 0, 100)],
      playerColor: 'black',
      engineCp: 0,
    });
    expect(edgeWhite).toBeCloseTo(edgeBlack!, 10);
  });

  it('returns null when unknown (no data, no games, no engine)', () => {
    expect(
      computeOpponentEdge({ replies: [], playerColor: 'white', engineCp: 50 }),
    ).toBeNull();
    expect(
      computeOpponentEdge({
        replies: [statMove('x', 'a2a3', 0, 0, 0)],
        playerColor: 'white',
        engineCp: 50,
      }),
    ).toBeNull();
    expect(
      computeOpponentEdge({ replies: solidReplies, playerColor: 'white' }),
    ).toBeNull();
  });
});

describe('opponent edge decides close calls (audit A5 integration)', () => {
  // A and B are TWINS (500 games @60%, same engine eval): without reply
  // data they tie and insertion order wins. Reply data breaks the tie on
  // observed adversary errors — the term actually moves the ranking.
  const engine = [
    { uci: 'e2e4', san: 'e4', cp: 50, depth: 18, scoreFormatted: '+0.50', pvSans: ['e4'] },
    { uci: 'd2d4', san: 'd4', cp: 50, depth: 18, scoreFormatted: '+0.50', pvSans: ['d4'] },
  ];
  const stats = [
    { san: 'e4', uci: 'e2e4', white: 250, draws: 100, black: 150 },
    { san: 'd4', uci: 'd2d4', white: 250, draws: 100, black: 150 },
  ];
  const replyStats = {
    e2e4: [statMove('e5', 'e7e5', 50, 100, 350)],
    d2d4: [statMove('d5', 'd7d5', 400, 100, 0)],
  };

  it('ties without reply data (insertion order)', () => {
    const rows = rankRepertoireMoves({ ...baseInput(), eloTier: 'low', engine, stats });
    expect(rows[0].uci).toBe('e2e4');
    expect(rows[0].opponentEdge).toBeNull();
    expect(rows[1].opponentEdge).toBeNull();
  });

  it('flips to the error-prone line once replies are known', () => {
    const rows = rankRepertoireMoves({ ...baseInput(), eloTier: 'low', engine, stats, replyStats });
    const byUci = new Map(rows.map((r) => [r.uci, r]));
    expect(byUci.get('e2e4')!.opponentEdge).toBeLessThan(0);
    expect(byUci.get('d2d4')!.opponentEdge).toBeGreaterThan(0);
    expect(rows[0].uci).toBe('d2d4');
  });

  it('unmatched reply keys leave historical scores bit-identical', () => {
    const plain = rankRepertoireMoves({ ...baseInput(), eloTier: 'low', engine, stats });
    const withJunk = rankRepertoireMoves({
      ...baseInput(),
      eloTier: 'low',
      engine,
      stats,
      replyStats: { z9z9: [statMove('x', 'a2a3', 10, 0, 0)] },
    });
    expect(withJunk.map((r) => r.finalScore)).toEqual(plain.map((r) => r.finalScore));
    expect(withJunk.every((r) => r.opponentEdge === null)).toBe(true);
  });
});

describe('confidence calibrated per endpoint + share (audit A6)', () => {
  const deep = { depth: 16, hasEngine: true, hasStats: true };

  it('masters scale: 350 games is strong evidence, invisible on lichess scale', () => {
    const row = { games: 350, ...deep };
    expect(
      classifyConfidence(row, DEFAULT_RANKING_CONFIG, { totalGames: 2000, endpoint: 'masters' }),
    ).toBe('high');
    expect(classifyConfidence(row)).toBe('low');
  });

  it('relative upgrade: 60% of a 400-game position is high anywhere', () => {
    const row = { games: 240, ...deep };
    expect(
      classifyConfidence(row, DEFAULT_RANKING_CONFIG, { totalGames: 400, endpoint: 'lichess' }),
    ).toBe('high');
    expect(
      classifyConfidence(row, DEFAULT_RANKING_CONFIG, { totalGames: 400, endpoint: 'masters' }),
    ).toBe('high');
  });

  it('relative medium: 30% share clears the bar', () => {
    const row = { games: 60, depth: 12, hasEngine: true, hasStats: true };
    expect(classifyConfidence(row, DEFAULT_RANKING_CONFIG, { totalGames: 200 })).toBe('medium');
  });

  it('volume floor: dominant share of a tiny position stays low', () => {
    const row = { games: 60, ...deep };
    expect(classifyConfidence(row, DEFAULT_RANKING_CONFIG, { totalGames: 80 })).toBe('low');
  });

  it('warning waived for relatively solid moves, kept otherwise', () => {
    const input = {
      ...baseInput(),
      eloTier: 'low' as const,
      engine: [engineMove('e4', 'e2e4', 40)],
      stats: [statMove('e4', 'e2e4', 40, 5, 5), statMove('d4', 'd2d4', 300, 20, 30)],
    };
    // 50 games of 400 on masters (>= 10): no low-sample warning.
    const masters = rankRepertoireMoves({ ...input, endpoint: 'masters' });
    const e4masters = masters.find((r) => r.uci === 'e2e4')!;
    expect(e4masters.warnings.some((w) => w.includes('chantillon'))).toBe(false);
    // Same move, lichess scale: 50 < 100 and 12.5% share -> warning stays.
    const lichess = rankRepertoireMoves({ ...input, endpoint: 'lichess' });
    const e4lichess = lichess.find((r) => r.uci === 'e2e4')!;
    expect(e4lichess.warnings.some((w) => w.includes('chantillon'))).toBe(true);
    // No endpoint (historical default): same as lichess.
    const def = rankRepertoireMoves(input);
    expect(def.find((r) => r.uci === 'e2e4')!.warnings).toEqual(e4lichess.warnings);
  });

  it('masters absolute scale contrasts with lichess default end to end', () => {
    // e4: 350 games of 2000 (17.5% share — no relative upgrade either way).
    const input = {
      ...baseInput(),
      eloTier: 'low' as const,
      endpoint: 'masters' as const,
      engine: [engineMove('e4', 'e2e4', 40)],
      stats: [
        statMove('e4', 'e2e4', 200, 50, 100),
        statMove('d4', 'd2d4', 800, 100, 100),
        statMove('c4', 'c2c4', 400, 100, 150),
      ],
    };
    const e4masters = rankRepertoireMoves(input).find((r) => r.uci === 'e2e4')!;
    expect(e4masters.confidence).toBe('high'); // 350 >= 300 masters
    const e4default = rankRepertoireMoves({ ...input, endpoint: undefined }).find(
      (r) => r.uci === 'e2e4',
    )!;
    expect(e4default.confidence).toBe('low'); // 350 << 5000, 17.5% share
  });
});

describe('player-strength correction (audit A11)', () => {
  function ratedMove(
    san: string, uci: string, white: number, draws: number, black: number, averageRating?: number,
  ): LichessMove {
    return { san, uci, white, draws, black, averageRating };
  }

  it('positionRatingMean is games-weighted over rated moves only', () => {
    expect(
      positionRatingMean([
        { games: 100, averageRating: 1700 },
        { games: 300, averageRating: 1500 },
        { games: 50 },
        { games: 0, averageRating: 2000 },
      ]),
    ).toBe(1550);
    expect(positionRatingMean([])).toBeNull();
    expect(positionRatingMean([{ games: 10 }])).toBeNull();
  });

  it('ratingAdjustedRate recenters on the position mean (400-Elo logistic)', () => {
    // +150 gap on a 60% line: 0.60 − (E(150) − 0.5) ≈ 0.397.
    expect(ratingAdjustedRate(0.6, 1750, 1600)).toBeCloseTo(0.3966, 3);
    // −150 gap on a 60% line: 0.60 + 0.203 ≈ 0.803.
    expect(ratingAdjustedRate(0.6, 1450, 1600)).toBeCloseTo(0.8034, 3);
    // Extreme gaps clamp instead of exploding.
    expect(ratingAdjustedRate(0.4, 2000, 1600)).toBe(0);
    expect(ratingAdjustedRate(0.6, 1200, 1600)).toBe(1);
    // Missing data: identity (backward compatible).
    expect(ratingAdjustedRate(0.62, undefined, 1600)).toBe(0.62);
    expect(ratingAdjustedRate(0.62, 1700, null)).toBe(0.62);
  });

  it('lifts weak-clientele lines and discounts strong-clientele ones', () => {
    const stats = [
      ratedMove('e4', 'e2e4', 500, 200, 300, 1750), // 60% raw, top of band
      ratedMove('d4', 'd2d4', 500, 200, 300, 1450), // 60% raw, bottom of band
    ];
    const rows = rankRepertoireMoves({ ...baseInput(), eloTier: 'low', engine: [], stats });
    const byUci = new Map(rows.map((r) => [r.uci, r]));
    const a = byUci.get('e2e4')!;
    const b = byUci.get('d2d4')!;
    // Observed facts preserved…
    expect(a.scoreRate).toBe(0.6);
    expect(b.scoreRate).toBe(0.6);
    // …but the model corrects: same raw 60% → 0.397 vs 0.803.
    expect(a.adjustedScoreRate).toBeCloseTo(0.3966, 3);
    expect(b.adjustedScoreRate).toBeCloseTo(0.8034, 3);
    expect(b.practicalScore).toBeGreaterThan(a.practicalScore);
  });

  it('leaves unrated positions exactly as before', () => {
    const stats = [
      statMove('e4', 'e2e4', 500, 200, 300),
      statMove('d4', 'd2d4', 400, 100, 150),
    ];
    const rows = rankRepertoireMoves({ ...baseInput(), eloTier: 'low', engine: [], stats });
    for (const r of rows) {
      expect(r.adjustedScoreRate).toBe(r.scoreRate);
    }
  });
});
