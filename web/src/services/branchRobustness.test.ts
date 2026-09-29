import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LichessApiResponse } from '../types/chess';
import { mapWithConcurrency } from '../utils/async';
import {
  robustnessCoverageLine,
  robustnessSkipReasonLabel,
} from '../i18n';
import {
  analyzeBranchRobustness,
  analyzeBranchRobustnessReport,
  combineRobustness,
  createRobustnessSession,
  formatOurEval,
  globalBranchScore,
  stopRobustness,
} from './branchRobustness';
import { cpToOutcome } from '../utils/engineAdvantage';
import { fetchLichessMoves } from './lichess';
import { analyzeLocalFen } from './localEngine';

vi.mock('./lichess', () => ({ fetchLichessMoves: vi.fn() }));
vi.mock('./localEngine', () => ({ analyzeLocalFen: vi.fn(), stopLocalAnalysis: vi.fn() }));

const fetchMock = vi.mocked(fetchLichessMoves);
const engineMock = vi.mocked(analyzeLocalFen);

const FEN0 = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

function lichessResponse(moves: { san: string; uci: string; white: number; draws: number; black: number }[]): LichessApiResponse {
  const white = moves.reduce((s, m) => s + m.white, 0);
  const draws = moves.reduce((s, m) => s + m.draws, 0);
  const black = moves.reduce((s, m) => s + m.black, 0);
  return { white, draws, black, moves };
}

const CANDIDATE_REPLIES = lichessResponse([
  { san: 'e5', uci: 'e7e5', white: 600, draws: 200, black: 200 },
  { san: 'c5', uci: 'c7c5', white: 300, draws: 50, black: 50 },
]);

const OUR_REPLY = lichessResponse([
  { san: 'Nf3', uci: 'g1f3', white: 200, draws: 60, black: 40 },
]);

const ENGINE_TOP = [
  { uci: 'g1f3', san: 'Nf3', cp: 40, depth: 12, scoreFormatted: '+0.40', pvSans: ['Nf3'] },
];

beforeEach(() => {
  vi.clearAllMocks();
  fetchMock.mockResolvedValue(CANDIDATE_REPLIES);
  engineMock.mockResolvedValue(ENGINE_TOP);
});

describe('combineRobustness (pure)', () => {
  it('empty input → neutral defaults', () => {
    expect(combineRobustness([])).toEqual({
      avg: 0.5, worst: 0.5, worstShare: 0, shortfall: 0, robustness: 0.5, danger: false,
    });
  });

  it('weights by frequency and flags danger past the 0.03 shortfall', () => {
    const r = combineRobustness([
      { weight: 90, score: 0.8 },
      { weight: 10, score: 0.2 },
    ]);
    expect(r.avg).toBeCloseTo(0.74, 5);
    expect(r.worst).toBe(0.2);
    expect(r.worstShare).toBeCloseTo(0.1, 5);
    // shortfall = 0.1 * (0.74 - 0.2) = 0.054 > 0.03 → danger
    expect(r.shortfall).toBeCloseTo(0.054, 5);
    expect(r.danger).toBe(true);
    expect(r.robustness).toBeCloseTo(0.686, 5);
  });

  it('a rare bad branch costs ~nothing', () => {
    const r = combineRobustness([
      { weight: 98, score: 0.7 },
      { weight: 2, score: 0.1 },
    ]);
    // avg = 0.688, shortfall = 0.02 * (0.688 - 0.1) = 0.01176 < 0.03
    expect(r.avg).toBeCloseTo(0.688, 5);
    expect(r.shortfall).toBeCloseTo(0.01176, 5);
    expect(r.danger).toBe(false);
    expect(r.robustness).toBeCloseTo(0.67624, 5);
  });
});

describe('cpToOutcome / formatOurEval (pure)', () => {
  it('mates dominate, null is neutral, cp is logistic', () => {
    expect(cpToOutcome(null)).toBe(0.5);
    expect(cpToOutcome(100, 3)).toBe(0.99);
    expect(cpToOutcome(-50, -2)).toBe(0.01);
    expect(cpToOutcome(0)).toBeCloseTo(0.5, 5);
    expect(cpToOutcome(400)).toBeCloseTo(1 / 1.1, 5);
  });

  it('formats mate / cp / missing', () => {
    expect(formatOurEval(null, 2)).toBe('#+2');
    expect(formatOurEval(null, -3)).toBe('#-3');
    expect(formatOurEval(null)).toBe('—');
    expect(formatOurEval(35)).toBe('+0.35');
  });
});

describe('globalBranchScore', () => {
  it('applies tier weights (low: 25/45/30)', () => {
    expect(globalBranchScore({ theoreticalScore: 1, practicalScore: 0 }, 0, 'low')).toBe(25);
    // high: (0.45*0 + 0.25*1 + 0.3*1) * 100 = 55
    expect(globalBranchScore({ theoreticalScore: 0, practicalScore: 1 }, 1, 'high')).toBe(55);
  });
});

describe('mapWithConcurrency', () => {
  it('preserves order and handles empty input', async () => {
    const out = await mapWithConcurrency([3, 1, 2], 2, async (x) => {
      await new Promise((r) => setTimeout(r, (4 - x) * 5));
      return x * 10;
    });
    expect(out).toEqual([30, 10, 20]);
    expect(await mapWithConcurrency([], 4, async (x: number) => x)).toEqual([]);
  });

  it('never exceeds the parallelism limit', async () => {
    let active = 0;
    let peak = 0;
    await mapWithConcurrency([1, 2, 3, 4, 5, 6], 2, async (x) => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
      return x;
    });
    expect(peak).toBeLessThanOrEqual(2);
    expect(peak).toBeGreaterThan(1);
  });
});

describe('sessions', () => {
  it('a pre-cancelled session runs nothing and reports cancelled', async () => {
    const session = createRobustnessSession();
    session.cancel();
    const report = await analyzeBranchRobustnessReport(
      FEN0,
      [{ uci: 'e2e4', san: 'e4' }],
      { playerColor: 'white', eloTier: 'mid', endpoint: 'masters', session },
    );
    expect(report.cancelled).toBe(true);
    expect(report.results).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('stopRobustness without an active run is a no-op', () => {
    expect(() => stopRobustness()).not.toThrow();
  });
});

describe('analyzeBranchRobustnessReport (mocked network + engine)', () => {
  const baseOpts = {
    playerColor: 'white' as const,
    eloTier: 'mid' as const,
    endpoint: 'masters' as const,
    depth: 12,
  };

  it('analyzes candidates, skips the illegal move, reports coverage', async () => {
    // Workers start in index order: the two candidate reply-list fetches go
    // first (queue), then the four our-stats fetches (OUR_REPLY).
    const queue = [CANDIDATE_REPLIES, CANDIDATE_REPLIES];
    fetchMock.mockImplementation(async () => queue.shift() ?? OUR_REPLY);

    const report = await analyzeBranchRobustnessReport(
      FEN0,
      [
        { uci: 'e2e4', san: 'e4' },
        { uci: 'd2d4', san: 'd4' },
        { uci: 'z9z9', san: '??' },
      ],
      baseOpts,
    );

    expect(report.requestedCandidates).toBe(3);
    expect(report.analyzedCandidates).toBe(2);
    expect(report.results).toHaveLength(2);
    expect(report.repliesAnalyzed).toBe(4);
    expect(report.cancelled).toBe(false);
    expect(report.issues).toEqual([]);
    expect(report.skipped).toEqual([{ san: '??', uci: 'z9z9', reason: 'illegal-move' }]);
    for (const r of report.results) {
      expect(r.replies).toHaveLength(2);
      for (const a of r.replies) {
        expect(a.statsAvailable).toBe(true);
        expect(a.engineAvailable).toBe(true);
      }
    }
  });

  it('dedupes identical FENs through the session cache', async () => {
    fetchMock.mockResolvedValue(CANDIDATE_REPLIES);
    // Same candidate twice → same candFen + same reply FENs.
    // Without the cache: 2 + 4 = 6 fetches. With it: 1 + 2 = 3.
    engineMock.mockResolvedValue(ENGINE_TOP);
    const report = await analyzeBranchRobustnessReport(
      FEN0,
      [
        { uci: 'e2e4', san: 'e4' },
        { uci: 'e2e4', san: 'e4!' },
      ],
      { ...baseOpts, networkConcurrency: 2 },
    );
    expect(report.analyzedCandidates).toBe(2);
    expect(fetchMock.mock.calls.length).toBe(3);
  });

  it('records issues + skips when stats fetches fail', async () => {
    fetchMock.mockRejectedValue(new Error('boom'));
    const report = await analyzeBranchRobustnessReport(
      FEN0,
      [
        { uci: 'e2e4', san: 'e4' },
        { uci: 'd2d4', san: 'd4' },
      ],
      baseOpts,
    );
    expect(report.results).toEqual([]);
    expect(report.analyzedCandidates).toBe(0);
    expect(report.skipped).toHaveLength(2);
    expect(report.skipped[0].reason).toBe('candidate-stats-unavailable');
    expect(report.issues).toHaveLength(2);
    expect(engineMock).not.toHaveBeenCalled();
  });

  it('marks engineAvailable false when the engine yields nothing', async () => {
    fetchMock.mockResolvedValue(CANDIDATE_REPLIES);
    engineMock.mockResolvedValue([]);
    const report = await analyzeBranchRobustnessReport(
      FEN0,
      [{ uci: 'e2e4', san: 'e4' }],
      { ...baseOpts, maxReplies: 1 },
    );
    expect(report.results).toHaveLength(1);
    expect(report.results[0].replies[0].engineAvailable).toBe(false);
  });

  it('legacy entry point still returns bare results', async () => {
    fetchMock.mockResolvedValue(CANDIDATE_REPLIES);
    const res = await analyzeBranchRobustness(FEN0, [{ uci: 'e2e4', san: 'e4' }], baseOpts);
    expect(Array.isArray(res)).toBe(true);
    expect(res).toHaveLength(1);
  });
});

describe('i18n robustness helpers', () => {
  it('labels every skip reason and formats the coverage line', () => {
    for (const r of ['illegal-move', 'candidate-stats-unavailable', 'no-adversary-data', 'no-analyzable-reply', 'cancelled'] as const) {
      expect(robustnessSkipReasonLabel(r).length).toBeGreaterThan(0);
    }
    expect(robustnessCoverageLine(2, 3, 5)).toContain('2/3');
  });
});

describe('player-strength correction (audit A11)', () => {
  it('picks the best reply at reference level, not by raw clientele', async () => {
    // Same 100 games each. Raw: Nf3 80% (strong clientele) beats Bc4 65%.
    // Adjusted to the 1600 position mean: Nf3 0.597 < Bc4 0.721.
    const ourData = {
      white: 140,
      draws: 10,
      black: 50,
      moves: [
        { san: 'Nf3', uci: 'g1f3', white: 80, draws: 0, black: 20, averageRating: 1800 },
        { san: 'Bc4', uci: 'f1c4', white: 60, draws: 10, black: 30, averageRating: 1400 },
      ],
    };
    // Candidate replies are fetched at the candidate FEN (after our move),
    // our-stats at the reply FENs: serve by call order (phase 1, then 2).
    const queue = [CANDIDATE_REPLIES];
    fetchMock.mockImplementation(async () => queue.shift() ?? ourData);
    engineMock.mockResolvedValue([]);
    const report = await analyzeBranchRobustnessReport(
      FEN0,
      [{ uci: 'e2e4', san: 'e4' }],
      { playerColor: 'white' as const, eloTier: 'mid' as const, endpoint: 'masters' as const },
    );
    expect(report.results).toHaveLength(1);
    expect(report.results[0].replies[0].ourBestSan).toBe('Bc4');
  });
});
