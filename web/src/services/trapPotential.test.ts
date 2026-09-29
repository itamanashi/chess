import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Chess } from 'chess.js';
import type { EngineMove, LichessMove } from '../types/chess';
import {
  analyzeTrapPotential,
  classifyTrapVerdict,
  clearTrapCache,
} from './trapPotential';
import { fetchLichessMoves } from './lichess';
import { analyzeLocalFen } from './localEngine';

vi.mock('./lichess', () => ({ fetchLichessMoves: vi.fn() }));
vi.mock('./localEngine', () => ({ analyzeLocalFen: vi.fn(), stopLocalAnalysis: vi.fn() }));

const fetchMock = vi.mocked(fetchLichessMoves);
const engineMock = vi.mocked(analyzeLocalFen);

const INITIAL = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

function play(fen: string, uci: string): string {
  const c = new Chess(fen);
  const m = c.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci.length > 4 ? uci[4] : undefined });
  if (!m) throw new Error(`fixture setup failed: ${uci} on ${fen}`);
  return c.fen();
}

function lichessMove(san: string, uci: string, white: number, draws: number, black: number): LichessMove {
  return { san, uci, white, draws, black };
}

function engineMove(uci: string, san: string, cp: number, pvUci: string[] = []): EngineMove {
  return { uci, san, cp, depth: 12, scoreFormatted: '', pvSans: [san], pvUci };
}

function lichessResponse(moves: LichessMove[]) {
  const white = moves.reduce((s, m) => s + m.white, 0);
  const draws = moves.reduce((s, m) => s + m.draws, 0);
  const black = moves.reduce((s, m) => s + m.black, 0);
  return { white, draws, black, moves };
}

beforeEach(() => {
  vi.clearAllMocks();
  clearTrapCache();
});

// --- Shared fixture: 1.e4, black to move ---------------------------------
// Replies: e5 (70%), c5 (20%), e6 (10%). Engine best defense: e6.
// Horizon 4 plies. Leaf evals (side-to-move cp):
//   safety (e6 d4 d5 exd5, black): +30  → ourAdv -30
//   e5-line (e5 Nf3 Nc6 Bb5, black): -160 → +160
//   c5-line (c5 Nf3 d6 d4, black): -60  → +60
//   e6-line (e6 d4 d5 Nc3, black): +40  → -40
// E(full) = .7*160 + .2*60 + .1*(-40) = 120, delta = 150, defense 10%.
const AFTER = play(INITIAL, 'e2e4');
const F_E5 = play(AFTER, 'e7e5');
const F_C5 = play(AFTER, 'c7c5');
const F_E6 = play(AFTER, 'e7e6');
const LEAF_SAFETY = play(play(play(play(AFTER, 'e7e6'), 'd2d4'), 'd7d5'), 'e4d5');
const LEAF_E5 = play(play(play(F_E5, 'g1f3'), 'b8c6'), 'f1b5');
const LEAF_C5 = play(play(play(F_C5, 'g1f3'), 'd7d6'), 'd2d4');
const LEAF_E6 = play(play(play(F_E6, 'd2d4'), 'd7d5'), 'b1c3');

const REPLIES = [
  lichessMove('e5', 'e7e5', 490, 140, 70),
  lichessMove('c5', 'c7c5', 140, 40, 20),
  lichessMove('e6', 'e7e6', 70, 20, 10),
];

function seedEngine(table: Map<string, EngineMove[]>) {
  engineMock.mockImplementation(async (fen: string) => table.get(fen) ?? []);
}

function mainTable(): Map<string, EngineMove[]> {
  const t = new Map<string, EngineMove[]>();
  t.set(AFTER, [engineMove('e7e6', 'e6', 0, ['e7e6', 'd2d4', 'd7d5', 'e4d5'])]);
  t.set(F_E5, [engineMove('g1f3', 'Nf3', 0, ['g1f3', 'b8c6', 'f1b5'])]);
  t.set(F_C5, [engineMove('g1f3', 'Nf3', 0, ['g1f3', 'd7d6', 'd2d4'])]);
  t.set(F_E6, [engineMove('d2d4', 'd4', 0, ['d2d4', 'd7d5', 'b1c3'])]);
  const leaf = (cp: number): EngineMove[] => [engineMove('a2a3', 'a3', cp)];
  t.set(LEAF_SAFETY, leaf(30));
  t.set(LEAF_E5, leaf(-160));
  t.set(LEAF_C5, leaf(-60));
  t.set(LEAF_E6, leaf(40));
  return t;
}

const BASE_ARGS = {
  fen: INITIAL,
  ourColor: 'white' as const,
  ourMoveUci: 'e2e4',
  ourMoveSan: 'e4',
  elo: { endpoint: 'masters' as const },
};

describe('analyzeTrapPotential — risky but trappy line', () => {
  it("detects trap: negative safety, far better expectation, rare perfect defense", async () => {
    fetchMock.mockResolvedValue(lichessResponse(REPLIES));
    seedEngine(mainTable());
    const rep = await analyzeTrapPotential({ ...BASE_ARGS, config: { horizonPlies: 4, probMass: 1 } });

    expect(rep.verdict).toBe('trap');
    expect(rep.safetyLeafAdvCp).toBe(-30);
    expect(rep.expectedLeafAdvCp).toBe(120);
    expect(rep.trapDeltaCp).toBe(150);
    expect(rep.bestDefenseUci).toBe('e7e6');
    expect(rep.bestDefenseProbability).toBe(10);
    expect(rep.coveragePct).toBe(100);
    expect(rep.replies).toHaveLength(3);
    expect(rep.fromCache).toBe(false);
    // 1 root + 3 reply PVs + 4 leaf evals.
    expect(engineMock).toHaveBeenCalledTimes(8);
  });

  it('caches the full report (second call is free)', async () => {
    fetchMock.mockResolvedValue(lichessResponse(REPLIES));
    seedEngine(mainTable());
    const args = { ...BASE_ARGS, config: { horizonPlies: 4, probMass: 1 } };
    await analyzeTrapPotential(args);
    expect(engineMock).toHaveBeenCalledTimes(8);
    const again = await analyzeTrapPotential(args);
    expect(again.fromCache).toBe(true);
    expect(again.verdict).toBe('trap');
    expect(engineMock).toHaveBeenCalledTimes(8);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('respects probMass: uncovered tail floored with safety', async () => {
    fetchMock.mockResolvedValue(lichessResponse(REPLIES));
    seedEngine(mainTable());
    // Default mass 0.85 → e5 (.7) + c5 (.2); e6 excluded, defense prob null.
    const rep = await analyzeTrapPotential({ ...BASE_ARGS, config: { horizonPlies: 4 } });

    expect(rep.replies.map((r) => r.uci)).toEqual(['e7e5', 'c7c5']);
    expect(rep.coveragePct).toBe(90);
    // E = .7*160 + .2*60 + .1*(-30 floor) = 121
    expect(rep.expectedLeafAdvCp).toBe(121);
    expect(rep.trapDeltaCp).toBe(151);
    expect(rep.bestDefenseProbability).toBeNull();
    expect(rep.verdict).toBe('trap');
    expect(engineMock).toHaveBeenCalledTimes(6);
  });

  it('custom thresholds can demote trap → practical', async () => {
    fetchMock.mockResolvedValue(lichessResponse(REPLIES));
    seedEngine(mainTable());
    const rep = await analyzeTrapPotential({
      ...BASE_ARGS,
      config: { horizonPlies: 4, probMass: 1, thresholds: { trapDeltaMinCp: 1000 } as never },
    });
    expect(rep.verdict).toBe('practical');
  });
});

describe('analyzeTrapPotential — unknown paths', () => {
  it('illegal our move → unknown without network or engine', async () => {
    const rep = await analyzeTrapPotential({ ...BASE_ARGS, ourMoveUci: 'e2e5' });
    expect(rep.verdict).toBe('unknown');
    expect(rep.note).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(engineMock).not.toHaveBeenCalled();
  });

  it('no Lichess data → unknown, engine never tasked', async () => {
    fetchMock.mockResolvedValue(lichessResponse([]));
    const rep = await analyzeTrapPotential({ ...BASE_ARGS, config: { horizonPlies: 4 } });
    expect(rep.verdict).toBe('unknown');
    expect(engineMock).not.toHaveBeenCalled();
  });

  it('pre-aborted signal throws and fetches nothing', async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(
      analyzeTrapPotential({ ...BASE_ARGS, signal: ctrl.signal }),
    ).rejects.toSatisfy(
      (e: unknown) => e instanceof DOMException && e.name === 'AbortError',
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('analyzeTrapPotential — Lichess castles end to end', () => {
  it('normalizes Chess960 reply castles (e8a8 → e8c8) and still concludes', async () => {
    const castleFen = 'r3k2r/pppppppp/8/8/4P3/8/PPPP1PPP/R3K2R w KQkq - 0 1';
    const afterCastle = play(castleFen, 'e1g1');
    const afterLongCastle = play(afterCastle, 'e8c8');
    const leafFen = play(afterLongCastle, 'd2d4');
    fetchMock.mockResolvedValue(
      lichessResponse([lichessMove('O-O-O', 'e8a8', 10, 80, 10)]),
    );
    const t = new Map<string, EngineMove[]>();
    t.set(afterCastle, [engineMove('e8a8', 'O-O-O', 0, ['e8a8', 'd2d4'])]);
    t.set(afterLongCastle, [engineMove('d2d4', 'd4', 0, ['d2d4'])]);
    t.set(leafFen, [engineMove('a7a6', 'a6', 20)]);
    seedEngine(t);

    const rep = await analyzeTrapPotential({
      fen: castleFen,
      ourColor: 'white',
      ourMoveUci: 'e1h1', // Chess960 form from Lichess, tolerated
      ourMoveSan: 'O-O',
      elo: { endpoint: 'masters' as const },
      config: { horizonPlies: 2 },
    });

    expect(rep.verdict).toBe('solid');
    expect(rep.replies).toHaveLength(1);
    expect(rep.replies[0].uci).toBe('e8c8');
    expect(rep.replies[0].isBestDefense).toBe(true);
    expect(rep.bestDefenseProbability).toBe(100);
    expect(rep.safetyLeafAdvCp).toBe(-20);
  });
});

describe('classifyTrapVerdict boundaries', () => {
  it('solid needs safety AND small delta', () => {
    expect(classifyTrapVerdict(0, 20, 50)).toBe('solid');
    expect(classifyTrapVerdict(-20, 29, 90)).toBe('solid');
    expect(classifyTrapVerdict(-21, 0, 90)).toBe('practical');
    expect(classifyTrapVerdict(0, 50, 90)).toBe('practical');
  });

  it('trap needs big delta AND rare perfect defense', () => {
    expect(classifyTrapVerdict(-30, 120, 10)).toBe('trap');
    expect(classifyTrapVerdict(-30, 120, 16)).toBe('practical');
    expect(classifyTrapVerdict(-30, 49, 10)).toBe('practical'); // delta 79 < 80
  });

  it('dangerous needs bad safety AND common perfect defense', () => {
    expect(classifyTrapVerdict(-100, -90, 40)).toBe('dangerous');
    expect(classifyTrapVerdict(-100, -90, 10)).toBe('practical');
    expect(classifyTrapVerdict(-59, -50, 90)).toBe('practical');
  });
});

describe('analyzeTrapPotential — bounded fallback cost (audit A8)', () => {
  // Horizon 8 with single-ply seeds: each walk needs 7 probes, the cap
  // allows 4. Ruy Lopez chain from 1.e4 e5 (all FENs computed for real).
  const AFTER = play(INITIAL, 'e2e4');
  const B1 = play(AFTER, 'e7e5');
  const B2 = play(B1, 'g1f3');
  const B3 = play(B2, 'b8c6');
  const B4 = play(B3, 'f1b5');
  const B5 = play(B4, 'a7a6');
  // B6 = play(B5, 'f1a4') would be the 5th probe — must never be analyzed.

  function seedCappedTable(): void {
    const t = new Map<string, EngineMove[]>();
    const noPv = (uci: string, san: string): EngineMove[] => [{ uci, san, cp: 0, depth: 12, scoreFormatted: '', pvSans: [san] }];
    t.set(AFTER, noPv('e7e5', 'e5')); // best defense, NO pvUci → fallback engages
    t.set(B1, noPv('g1f3', 'Nf3'));
    t.set(B2, noPv('b8c6', 'Nc6'));
    t.set(B3, noPv('f1b5', 'Bb5'));
    t.set(B4, noPv('a7a6', 'a6'));
    t.set(B5, [{ uci: 'a2a3', san: 'a3', cp: 40, depth: 12, scoreFormatted: '', pvSans: ['a3'] }]);
    engineMock.mockImplementation(async (fen: string) => t.get(fen) ?? []);
  }

  function probeDepths(): number[] {
    return engineMock.mock.calls.map((c) => (c[1] as { depth?: number }).depth ?? -1);
  }

  it('caps fallback probes per walk instead of paying one per missing ply', async () => {
    fetchLichessMovesMocked([lichessMove('e5', 'e7e5', 70, 20, 10)]);
    seedCappedTable();
    const rep = await analyzeTrapPotential({
      fen: INITIAL,
      ourColor: 'white',
      ourMoveUci: 'e2e4',
      ourMoveSan: 'e4',
      elo: { endpoint: 'masters' as const },
      config: { horizonPlies: 8 },
    });

    // Safety walk (1 seed ply + 4 probes) and reply walk (same): 8 probes
    // total, NOT 14. Each probe runs at reduced depth.
    expect(probeDepths().filter((d) => d === 8)).toHaveLength(8);
    // Walks stop after 1 + 4 plies: B6 (5th probe target) never analyzed.
    expect(engineMock).toHaveBeenCalledTimes(12);
    // …yet the report still concludes honestly on the partial horizon.
    expect(rep.verdict).toBe('solid');
    expect(rep.safetyLeafAdvCp).toBe(40);
    expect(rep.coveragePct).toBe(100);
  });

  it('reports done/total monotonically and ends exactly at 100%', async () => {
    fetchLichessMovesMocked([lichessMove('e5', 'e7e5', 70, 20, 10)]);
    seedCappedTable();
    const pairs: [number, number][] = [];
    await analyzeTrapPotential({
      fen: INITIAL,
      ourColor: 'white',
      ourMoveUci: 'e2e4',
      ourMoveSan: 'e4',
      elo: { endpoint: 'masters' as const },
      config: { horizonPlies: 8 },
      onProgress: (done, total) => {
        pairs.push([done, total]);
      },
    });
    expect(pairs.length).toBeGreaterThan(0);
    for (const [done, total] of pairs) {
      expect(done).toBeLessThanOrEqual(total);
    }
    const last = pairs[pairs.length - 1];
    expect(last[0]).toBe(last[1]);
    // 6 base units (fetch, root, 2 walks, 2 leaves) + 8 probes.
    expect(last).toEqual([14, 14]);
  });

  it('fails honestly on a hallucinated best defense (zero-ply walk)', async () => {
    fetchLichessMovesMocked([lichessMove('e5', 'e7e5', 70, 20, 10)]);
    // A0 proposes an illegal move: the safety line cannot even start.
    engineMock.mockImplementation(async () => [{ uci: 'a2a3', san: 'a3', cp: 0, depth: 12, scoreFormatted: '', pvSans: ['a3'] }]);
    const rep = await analyzeTrapPotential({
      fen: INITIAL,
      ourColor: 'white',
      ourMoveUci: 'e2e4',
      ourMoveSan: 'e4',
      elo: { endpoint: 'masters' as const },
      config: { horizonPlies: 8 },
    });
    expect(rep.verdict).toBe('unknown');
    expect(rep.replies).toHaveLength(0);
    // Fetch + root analysis + ONE fallback probe (which also finds nothing
    // playable): no leaf storm on a broken line.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(engineMock).toHaveBeenCalledTimes(2);
  });

  function fetchLichessMovesMocked(moves: LichessMove[]): void {
    const white = moves.reduce((s, m) => s + m.white, 0);
    const draws = moves.reduce((s, m) => s + m.draws, 0);
    const black = moves.reduce((s, m) => s + m.black, 0);
    fetchMock.mockResolvedValue({ white, draws, black, moves });
  }
});
