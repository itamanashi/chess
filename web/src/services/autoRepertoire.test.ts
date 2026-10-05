import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
  clampAutoBudget,
  computeBookScore,
  computeContestedness,
  depthWeightedCoverage,
  effectiveMaxDepth,
  pickEngineReplies,
  findMateInOneUcis,
  generateAutoRepertoire,
  pruneLowValueLines,
  selectMovesByCoverage,
  spreadPenalty,
  cloneSubtreeCycleSafe,
  isHigherHeapItem,
  isHigherHeapItemCoverage,
  remainingRequestGapMs,
  type AutoGenNode,
} from './autoRepertoire';
import {
  fetchLichessMoves,
  fetchLichessMovesWithCacheStatus,
  flushLichessPersist,
  hasLichessCache,
} from './lichess';
import { Chess } from 'chess.js';
import { computeLineValues, type LineValueNode } from '../utils/lineValue';
import { fenAfterUci, INITIAL_FEN, normalizeFen } from '../utils/repertoire';
import type { EngineMove, LichessMove, RepertoireMove, RepertoireRoot } from '../types/chess';

vi.mock('./lichess', () => ({
  fetchLichessMoves: vi.fn(),
  fetchLichessMovesWithCacheStatus: vi.fn(),
  hasLichessCache: vi.fn(() => false),
  flushLichessPersist: vi.fn(async () => true),
  explorerCacheReady: vi.fn(async () => {}),
}));

const mockFetch = vi.mocked(fetchLichessMoves);
const mockFetchWithCacheStatus = vi.mocked(fetchLichessMovesWithCacheStatus);
const mockHasCache = vi.mocked(hasLichessCache);

beforeEach(() => {
  vi.resetAllMocks();
  mockHasCache.mockReturnValue(false);
  mockFetchWithCacheStatus.mockImplementation(async (...args) => ({
    data: await mockFetch(...args),
    source: mockHasCache(args[0], args[2], args[3], args[4], args[5]?.since) ? 'memory' : 'network',
  }));
});

function lichessMove(san: string, games: number, uci = 'e2e4'): LichessMove {
  const white = Math.round(games * 0.5);
  const draws = Math.round(games * 0.1);
  return { san, uci, white, draws, black: games - white - draws };
}

describe('selectMovesByCoverage', () => {
  it('trie et filtre par fréquence mini', () => {
    const moves = [lichessMove('e4', 6000), lichessMove('d4', 3000, 'd2d4'), lichessMove('a3', 10, 'a2a3')];
    const sel = selectMovesByCoverage(moves, 10000, { maxBranching: 4, minFreq: 2.5, coveragePercent: 100 });
    expect(sel.map((s) => s.move.san)).toEqual(['e4', 'd4']);
  });

  it('coupe à la couverture cumulée', () => {
    const moves = [lichessMove('e4', 5000), lichessMove('d4', 3000, 'd2d4'), lichessMove('c4', 2000, 'c2c4')];
    const sel = selectMovesByCoverage(moves, 10000, { maxBranching: 4, minFreq: 0, coveragePercent: 60 });
    expect(sel).toHaveLength(2);
  });

  it('garantit le top 1', () => {
    const moves = [lichessMove('e4', 5000), lichessMove('d4', 4000, 'd2d4')];
    const sel = selectMovesByCoverage(moves, 9000, { maxBranching: 4, minFreq: 99, coveragePercent: 100 });
    expect(sel).toHaveLength(1);
    expect(sel[0].move.san).toBe('e4');
  });

  it('minGames : exclut les coups sous le seuil, sans repêchage', () => {
    const moves = [lichessMove('e4', 6000), lichessMove('d4', 3000, 'd2d4'), lichessMove('a3', 50, 'a2a3')];
    // a3 : 50 parties < 100 → exclu même si la couverture le prendrait.
    const sel = selectMovesByCoverage(moves, 9050, { maxBranching: 4, minFreq: 0, minGames: 100, coveragePercent: 100 });
    expect(sel.map((s) => s.move.san)).toEqual(['e4', 'd4']);
    // 0 = désactivé : a3 revient.
    const off = selectMovesByCoverage(moves, 9050, { maxBranching: 4, minFreq: 0, minGames: 0, coveragePercent: 100 });
    expect(off.map((s) => s.move.san)).toEqual(['e4', 'd4', 'a3']);
  });

  it('minGames : aucun éligible → vide (pas de top-1 repêché)', () => {
    const moves = [lichessMove('e4', 60), lichessMove('d4', 40, 'd2d4')];
    const sel = selectMovesByCoverage(moves, 100, { maxBranching: 4, minFreq: 0, minGames: 100, coveragePercent: 100 });
    expect(sel).toHaveLength(0);
  });
});

describe('scores', () => {
  it('contestedness = 1 - max', () => {
    const moves = [lichessMove('e4', 8000), lichessMove('d4', 2000, 'd2d4')];
    expect(computeContestedness(moves, 10000)).toBeCloseTo(0.2, 9);
  });

  it('bookScore = écart top1-top2', () => {
    const moves = [lichessMove('e4', 9000), lichessMove('d4', 500, 'd2d4')];
    expect(computeBookScore(moves, 10000)).toBeCloseTo(0.85, 9);
  });

  it('profondeur adaptative bornée', () => {
    expect(effectiveMaxDepth(12, 0, 1, {})).toBe(12);
    expect(effectiveMaxDepth(12, 4, 1, {})).toBe(12);
    const shallow = effectiveMaxDepth(12, 8, 1e-6, {});
    expect(shallow).toBeGreaterThanOrEqual(6);
    expect(shallow).toBeLessThan(12);
    // Adaptative désactivée : toutes les lignes vont à Profondeur, même rares.
    expect(effectiveMaxDepth(12, 8, 1e-6, { adaptiveDepth: false })).toBe(12);
    expect(effectiveMaxDepth(24, 20, 1e-9, { adaptiveDepth: false })).toBe(24);
  });

  it('spreadPenalty', () => {
    expect(spreadPenalty(0, 0.9, {})).toBe(1);
    expect(spreadPenalty(2, 0.05, {})).toBe(1);
    expect(spreadPenalty(1, 0.5, {})).toBeLessThan(1);
  });

  it('minPopularity 0 → les lignes ultra-rares suivent le budget, pas un seuil', async () => {
    // a3 : 1 partie sur 100000 (popularité 1e-5 < défaut 2e-5).
    const rootData = {
      white: 50000, draws: 10000, black: 40000,
      moves: [
        { san: 'e4', uci: 'e2e4', white: 49999, draws: 10000, black: 40000 },
        { san: 'a3', uci: 'a2a3', white: 1, draws: 0, black: 0 },
      ],
    };
    const empty = { white: 0, draws: 0, black: 0, moves: [] };
    const base = {
      maxDepth: 2, maxBranching: 4, minFreq: 0, coveragePercent: 100,
      maxPositions: 10, gapMs: 0, repertoireColor: 'both' as const, pruneMinLineValue: 0,
    };
    mockFetch.mockResolvedValueOnce(rootData).mockResolvedValue(empty);
    const def = await generateAutoRepertoire(INITIAL_FEN, base);
    expect(def.stats.popPruned).toBe(1);
    expect(def.stats.positionsInterrogees).toBe(2);

    mockFetch.mockReset();
    mockFetch.mockResolvedValueOnce(rootData).mockResolvedValue(empty);
    const noThreshold = await generateAutoRepertoire(INITIAL_FEN, { ...base, minPopularity: 0 });
    expect(noThreshold.stats.popPruned).toBe(0);
    expect(noThreshold.stats.positionsInterrogees).toBe(3);
  });

  it('mode noirs : sans moteur → repli popularité, avec moteur → Stockfish tranche', async () => {
    // Après 1.d4, e5 domine en bas (44 %) : sans juge, le repli popularité
    // garde e5. Avec un juge qui déclasse e5, la réplique retenue est Nf6.
    const rootData = {
      white: 5000, draws: 1000, black: 4000,
      moves: [
        { san: 'e4', uci: 'e2e4', white: 4000, draws: 1000, black: 3000 },
        { san: 'd4', uci: 'd2d4', white: 1000, draws: 300, black: 700 },
      ],
    };
    const afterE4 = {
      white: 5000, draws: 900, black: 4100,
      moves: [
        { san: 'e5', uci: 'e7e5', white: 3500, draws: 500, black: 3000 },
        { san: 'c5', uci: 'c7c5', white: 1000, draws: 300, black: 700 },
      ],
    };
    const afterD4 = {
      white: 4500, draws: 1100, black: 3400,
      moves: [
        { san: 'e5', uci: 'e7e5', white: 2000, draws: 300, black: 1700 },
        { san: 'd5', uci: 'd7d5', white: 1500, draws: 500, black: 1000 },
        { san: 'Nf6', uci: 'g8f6', white: 1000, draws: 300, black: 700 },
      ],
    };
    mockFetch.mockImplementation(async (fen: string) => {
      if (fen.includes('4P3')) return afterE4;
      if (fen.includes('3P4')) return afterD4;
      return rootData;
    });
    const cfgBase = {
      maxDepth: 2, maxBranching: 6, minFreq: 0, coveragePercent: 100,
      maxPositions: 10, gapMs: 0, repertoireColor: 'black' as const, pruneMinLineValue: 0,
      endpoint: 'lichess' as const, ratingsParam: '400,1000',
    };
    // Sans juge : repli popularité → e5 partout.
    const noEngine = await generateAutoRepertoire(INITIAL_FEN, cfgBase);
    const d4no = noEngine.root.children.find((c) => c.san === 'd4');
    const e4no = noEngine.root.children.find((c) => c.san === 'e4');
    expect((d4no?.children ?? []).map((c) => c.san)).toEqual(['e5']);
    expect((e4no?.children ?? []).map((c) => c.san)).toEqual(['e5']);
    expect(noEngine.stats.engineFallbacks).toBe(2);
    expect(noEngine.stats.failed).toBe(0);
    // Avec juge : e5 déclassé → Nf6 après 1.d4.
    mockFetch.mockImplementation(async (fen: string) => {
      if (fen.includes('4P3')) return afterE4;
      if (fen.includes('3P4')) return afterD4;
      return rootData;
    });
    const em = (uci: string, san: string, cp?: number): EngineMove =>
      ({ uci, san, cp, depth: 16, scoreFormatted: '', pvSans: [] });
    const judge = vi.fn(async () => [
      em('g8f6', 'Nf6', 30), em('d7d5', 'd5', 25), em('e7e5', 'e5', -50),
    ]);
    const { root, stats } = await generateAutoRepertoire(INITIAL_FEN, {
      ...cfgBase, engineJudge: { judge },
    });
    const d4 = root.children.find((c) => c.san === 'd4');
    expect((d4?.children ?? []).map((c) => c.san)).toEqual(['Nf6']);
    expect(stats.failed).toBe(0);
  });

  it('minGames : les coups adverses sous le seuil sont exclus, nos répliques non', async () => {
    // Racine (mode both : tout le monde joue plusieurs coups) : a3 ne fait
    // que 50 parties → exclu avec minGames 100, gardé sans seuil.
    const rootData = {
      white: 5000, draws: 1000, black: 4000,
      moves: [
        { san: 'e4', uci: 'e2e4', white: 4000, draws: 800, black: 3200 },
        { san: 'd4', uci: 'd2d4', white: 900, draws: 200, black: 700 },
        { san: 'a3', uci: 'a2a3', white: 25, draws: 10, black: 15 },
      ],
    };
    const empty = { white: 0, draws: 0, black: 0, moves: [] };
    mockFetch.mockImplementation(async (fen: string) =>
      (normalizeFen(fen) === normalizeFen(INITIAL_FEN) ? rootData : empty),
    );
    const cfgBase = {
      maxDepth: 1, maxBranching: 4, minFreq: 0, coveragePercent: 100,
      maxPositions: 10, gapMs: 0, repertoireColor: 'both' as const, pruneMinLineValue: 0,
    };
    const filtered = await generateAutoRepertoire(INITIAL_FEN, { ...cfgBase, minGames: 100 });
    expect(filtered.root.children.map((c) => c.san).sort()).toEqual(['d4', 'e4']);
    const unfiltered = await generateAutoRepertoire(INITIAL_FEN, cfgBase);
    expect(unfiltered.root.children.map((c) => c.san).sort()).toEqual(['a3', 'd4', 'e4']);
  });

  it('minGames : à notre tour, le seuil ne s\u2019applique pas (le moteur tranche)', async () => {
    // Mode noirs, après 1.d4 : tous les candidats font < 100 parties, sans
    // juge → le repli popularité garde quand même le plus joué (pas de
    // branche vide à cause du seuil adverse).
    const rootData = {
      white: 5000, draws: 1000, black: 4000,
      moves: [{ san: 'd4', uci: 'd2d4', white: 4000, draws: 1000, black: 3000 }],
    };
    const afterD4 = {
      white: 45, draws: 11, black: 34,
      moves: [
        { san: 'e5', uci: 'e7e5', white: 20, draws: 3, black: 17 },
        { san: 'd5', uci: 'd7d5', white: 15, draws: 5, black: 10 },
      ],
    };
    const empty = { white: 0, draws: 0, black: 0, moves: [] };
    mockFetch.mockImplementation(async (fen: string) => {
      if (fen.includes('3P4')) return afterD4;
      if (normalizeFen(fen) === normalizeFen(INITIAL_FEN)) return rootData;
      return empty;
    });
    const { root, stats } = await generateAutoRepertoire(INITIAL_FEN, {
      maxDepth: 2, maxBranching: 6, minFreq: 0, minGames: 100, coveragePercent: 100,
      maxPositions: 10, gapMs: 0, repertoireColor: 'black' as const, pruneMinLineValue: 0,
      endpoint: 'lichess' as const, ratingsParam: '400,1000',
    });
    const d4 = root.children.find((c) => c.san === 'd4');
    expect((d4?.children ?? []).map((c) => c.san)).toEqual(['e5']);
    expect(stats.failed).toBe(0);
  });

  it('pickEngineReplies : fenêtre ±30, mat pour nous gardé, aveugle → null', () => {
    const FEN_D4 = 'rnbqkbnr/pppppppp/8/8/3P4/8/PPP1PPPP/RNBQKBNR b KQkq - 0 1';
    const cand = [
      { uci: 'e7e5', san: 'e5' },
      { uci: 'd7d5', san: 'd5' },
      { uci: 'g8f6', san: 'Nf6' },
    ];
    const em = (uci: string, san: string, cp?: number, mate?: number): EngineMove =>
      ({ uci, san, cp, mate, depth: 16, scoreFormatted: '', pvSans: [] });
    // d5 +20, Nf6 +35 (écart 15 ≤ 30 : gardés), e5 −40 (écart 60 : écarté).
    const kept = pickEngineReplies(cand, [
      em('d7d5', 'd5', 20), em('g8f6', 'Nf6', 35), em('e7e5', 'e5', -40),
    ], FEN_D4, { equivalenceCp: 30 });
    expect(kept?.map((k) => k.candidate.san).sort()).toEqual(['Nf6', 'd5']);
    // Mat pour nous : gardé même seul en tête (résultats complets).
    const withMate = pickEngineReplies(cand, [
      em('d7d5', 'd5', 20), em('e7e5', 'e5', undefined, 1), em('g8f6', 'Nf6', 10),
    ], FEN_D4, { equivalenceCp: 30 });
    expect(withMate?.map((k) => k.candidate.san)).toEqual(['e5']);
    // Aveugle : rien de mappé, ou partiel (moins de lignes que de candidats).
    expect(pickEngineReplies(cand, [em('a7a6', 'a6', 10)], FEN_D4, { equivalenceCp: 30 })).toBeNull();
    expect(pickEngineReplies(cand, [em('d7d5', 'd5', 20)], FEN_D4, { equivalenceCp: 30 })).toBeNull();
    expect(pickEngineReplies(cand, [], FEN_D4, { equivalenceCp: 30 })).toBeNull();
  });

  it('juge moteur : MultiPV suit les candidats larges (pas de repli à 8 branches)', async () => {
    // Non-régression : avec Branches max à 12, 8 candidats et un MultiPV
    // fixe de 6, `lines < candidates` → repli gradient systématique (moteur
    // inutile). Le MultiPV couvre désormais les candidats : un seul choix.
    const specs: [string, string, number][] = [
      ['e4', 'e2e4', 2000], ['d4', 'd2d4', 1900], ['c4', 'c2c4', 1500],
      ['Nf3', 'g1f3', 1400], ['e3', 'e2e3', 800], ['g3', 'g2g3', 700],
      ['b3', 'b2b3', 500], ['a3', 'a2a3', 300],
    ];
    mockFetch.mockImplementation(async (_fen: string, _token?: string, db?: 'masters' | 'lichess') => {
      if (db === 'masters') return { white: 0, draws: 0, black: 0, moves: [] };
      return {
        white: 5000, draws: 1000, black: 4000,
        moves: specs.map(([san, uci, games]) => ({
          san, uci,
          white: Math.round(games / 2), draws: 100, black: games - Math.round(games / 2) - 100,
        })),
      };
    });
    const em = (uci: string, san: string, cp: number): EngineMove =>
      ({ uci, san, cp, depth: 20, scoreFormatted: '', pvSans: [] });
    // d4 +40, le reste ≤ +5 (écart > 30 : d4 seul, pas de départage).
    const lines = [
      em('d2d4', 'd4', 40), em('e2e4', 'e4', 5), em('c2c4', 'c4', 4),
      em('g1f3', 'Nf3', 3), em('e2e3', 'e3', 2), em('g2g3', 'g3', 1),
      em('b2b3', 'b3', 0), em('a2a3', 'a3', -5),
    ];
    const judge = vi.fn(async (_judgeFen: string, o: { multiPv: number }) => {
      seenMultiPv.push(o.multiPv);
      return lines;
    });
    const seenMultiPv: number[] = [];
    const { root, stats } = await generateAutoRepertoire(INITIAL_FEN, {
      maxDepth: 1, maxBranching: 12, minFreq: 0, coveragePercent: 100,
      maxPositions: 10, gapMs: 0, repertoireColor: 'white' as const, pruneMinLineValue: 0,
      endpoint: 'lichess' as const, ratingsParam: '400,1000',
      engineJudge: { judge },
    });
    expect(Math.min(...seenMultiPv)).toBeGreaterThanOrEqual(8);
    expect(root.children.map((c) => c.san)).toEqual(['d4']);
    expect(stats.engineNodes).toBe(1);
    expect(stats.engineFallbacks).toBe(0);
    expect(stats.failed).toBe(0);
  });

  it('juge moteur : UNE SEULE réplique à nous (e4 OU d4, pas les deux)', async () => {
    // Non-régression : au départ en mode blancs, e4 et d4 sont équivalents
    // (±30 cp même après creusage) mais le contrat 1-coup impose un choix —
    // le meilleur moteur gagne, le BFS creuse UNE ligne.
    mockFetch.mockImplementation(async (_fen: string, _token?: string, db?: 'masters' | 'lichess') => {
      if (db === 'masters') return { white: 0, draws: 0, black: 0, moves: [] };
      return {
        white: 5000, draws: 1000, black: 4000,
        moves: [
          { san: 'e4', uci: 'e2e4', white: 2500, draws: 500, black: 2000 },
          { san: 'd4', uci: 'd2d4', white: 2000, draws: 500, black: 2000 },
        ],
      };
    });
    const em = (uci: string, san: string, cp = 25): EngineMove =>
      ({ uci, san, cp, depth: 20, scoreFormatted: '', pvSans: [] });
    // d4 +30 > e4 +25 (écart 5) : équivalents, même après creusage (fenêtre ±10).
    const lines = [em('d2d4', 'd4', 30), em('e2e4', 'e4', 25)];
    const judge = vi.fn(async () => lines);
    const engineEvals: { san: string }[][] = [];
    const { root, stats } = await generateAutoRepertoire(INITIAL_FEN, {
      maxDepth: 1, maxBranching: 6, minFreq: 0, coveragePercent: 100,
      maxPositions: 10, gapMs: 0, repertoireColor: 'white' as const, pruneMinLineValue: 0,
      endpoint: 'lichess' as const, ratingsParam: '400,1000',
      engineJudge: { judge },
    }, {
      onEngineEval: (_fen, ranked) => {
        engineEvals.push(ranked);
      },
    });
    expect(root.children.map((c) => c.san)).toEqual(['d4']);
    expect(stats.engineNodes).toBe(1);
    expect(engineEvals).toHaveLength(1);
    expect(engineEvals[0].map((r) => r.san)).toEqual(['d4']);
    expect(stats.failed).toBe(0);
  });

  it('juge moteur : multi-répliques gardées, ex æquo départagés en creusant', async () => {
    // Après 1.d4 : e5 domine en bas mais le moteur le déclasse ; d5 et Nf6
    // équivalents (±30) sont gardés tous les deux, puis le creusage (D22)
    // sépare Nf6 → réplique unique. Sans moteur : repli popularité.
    const rootData = {
      white: 4000, draws: 1000, black: 3000,
      moves: [
        { san: 'd4', uci: 'd2d4', white: 4000, draws: 1000, black: 3000 },
      ],
    };
    const afterD4 = {
      white: 4500, draws: 1100, black: 3400,
      moves: [
        { san: 'e5', uci: 'e7e5', white: 2000, draws: 300, black: 1700 },
        { san: 'd5', uci: 'd7d5', white: 1500, draws: 500, black: 1000 },
        { san: 'Nf6', uci: 'g8f6', white: 1000, draws: 300, black: 700 },
      ],
    };
    mockFetch.mockImplementation(async (fen: string) => {
      if (fen.includes('3P4')) return afterD4;
      return rootData;
    });
    const em = (uci: string, san: string, cp?: number, mate?: number): EngineMove =>
      ({ uci, san, cp, mate, depth: 16, scoreFormatted: '', pvSans: [] });
    // Premier tri (D14) : d5 +25, Nf6 +30 (ex æquo, écart 5 ≤ 15).
    // Creusage (D20) : Nf6 +32, d5 +15 (écart 17 > 10 : Nf6 seul).
    const shallow = [em('d7d5', 'd5', 25), em('g8f6', 'Nf6', 30), em('e7e5', 'e5', -50)];
    const deep = [em('g8f6', 'Nf6', 32), em('d7d5', 'd5', 15), em('e7e5', 'e5', -50)];
    const judge = vi.fn(
      async (
        _fen: string,
        o: { depth: number; onPartial?: (lines: EngineMove[]) => void },
      ) => {
        o.onPartial?.(shallow);
        return o.depth > 14 ? deep : shallow;
      },
    );
    const cfgBase = {
      maxDepth: 2, maxBranching: 6, minFreq: 0, coveragePercent: 100,
      maxPositions: 10, gapMs: 0, repertoireColor: 'black' as const, pruneMinLineValue: 0,
      endpoint: 'lichess' as const, ratingsParam: '400,1000',
    };
    const engineEvals: { fen: string; ranked: { san: string }[] }[] = [];
    const enginePartials: { san: string }[][] = [];
    const { root, stats } = await generateAutoRepertoire(INITIAL_FEN, {
      ...cfgBase, engineJudge: { judge },
    }, {
      onEngineEval: (fen, ranked) => {
        engineEvals.push({ fen, ranked });
      },
      onEnginePartial: (_fen, ranked) => {
        enginePartials.push(ranked);
      },
    });
    const d4 = root.children.find((c) => c.san === 'd4');
    expect((d4?.children ?? []).map((c) => c.san)).toEqual(['Nf6']);
    expect(judge).toHaveBeenCalledTimes(2); // tri + creusage
    expect(stats.engineNodes).toBe(1);
    expect(engineEvals).toHaveLength(1);
    expect(engineEvals[0].ranked.map((r) => r.san)).toEqual(['Nf6']);
    // Direct live : le tri peu profond a dansé avant la conclusion.
    expect(enginePartials.length).toBeGreaterThanOrEqual(1);
    expect(enginePartials[0].map((r) => r.san)).toEqual(['Nf6', 'd5', 'e5']);
    expect(stats.engineFallbacks).toBe(0);
    expect(stats.failed).toBe(0);
  });

  it('juge moteur aveugle → repli popularité, branche conservée', async () => {
    mockFetch.mockImplementation(async (fen: string) => {
      if (fen.includes('3P4')) {
        return {
          white: 4500, draws: 1100, black: 3400,
          moves: [
            { san: 'e5', uci: 'e7e5', white: 2000, draws: 300, black: 1700 },
            { san: 'd5', uci: 'd7d5', white: 1500, draws: 500, black: 1000 },
          ],
        };
      }
      return {
        white: 5000, draws: 1000, black: 4000,
        moves: [{ san: 'd4', uci: 'd2d4', white: 4000, draws: 1000, black: 3000 }],
      };
    });
    const judge = vi.fn(async (): Promise<EngineMove[]> => {
      throw new Error('moteur évincé');
    });
    const { root, stats } = await generateAutoRepertoire(INITIAL_FEN, {
      maxDepth: 2, maxBranching: 6, minFreq: 0, coveragePercent: 100,
      maxPositions: 10, gapMs: 0, repertoireColor: 'black' as const, pruneMinLineValue: 0,
      endpoint: 'lichess' as const, ratingsParam: '400,1000',
      engineJudge: { judge },
    });
    // Repli popularité : e5 (le plus joué, sans juge utilisable) reste la réplique.
    const d4 = root.children.find((c) => c.san === 'd4');
    expect((d4?.children ?? []).map((c) => c.san)).toEqual(['e5']);
    expect(stats.engineFallbacks).toBe(1);
    expect(stats.failed).toBe(0);
  });

  it('depthWeightedCoverage : base à la racine, moitié en profondeur, 100 intact', () => {
    // Base 80, profondeur max 20 : 80 à la racine → 40 tout en bas.
    expect(depthWeightedCoverage(80, 0, 20)).toBe(80);
    expect(depthWeightedCoverage(80, 20, 20)).toBe(40);
    expect(depthWeightedCoverage(80, 10, 20)).toBe(60);
    // 100 = pas de pondération (échappatoire « tout garder »).
    expect(depthWeightedCoverage(100, 15, 20)).toBe(100);
    // Décroissance monotone, jamais sous le plancher.
    const curve = [0, 5, 10, 15, 20].map((d) => depthWeightedCoverage(80, d, 20));
    for (let i = 1; i < curve.length; i++) expect(curve[i]).toBeLessThanOrEqual(curve[i - 1]);
    expect(Math.min(...curve)).toBeGreaterThanOrEqual(10);
  });
});

describe('computeLineValues', () => {
  it('max chez nous, moyenne pondérée chez adversaire', () => {
    const leaf = (partial: Partial<LineValueNode>): LineValueNode => ({
      depth: 1, white: 0, black: 0, draws: 0, freq: 0, children: [], ...partial,
    });
    const root: LineValueNode = {
      depth: 0, white: 0, black: 0, draws: 0, freq: 100,
      children: [
        leaf({ white: 60, black: 30, draws: 10, freq: 60 }),
        leaf({ white: 20, black: 70, draws: 10, freq: 40 }),
      ],
    };
    computeLineValues(root, { side: 'white', optimism: 0, residual: 0.5, prior: 30, drawWeight: 0.5 });
    // depth 0 = trait blancs = nous (side white) -> max des enfants
    const kids = root.children ?? [];
    expect(root.lineValue).toBeCloseTo(Math.max(kids[0].lineValue ?? 0, kids[1].lineValue ?? 0), 9);
  });
});

function repMove({ san, uci, ...rest }: Partial<RepertoireMove> & { san: string; uci: string }): RepertoireMove {
  return {
    coup: san, san, uci,
    parties: 100, victoires_blancs: 50, nuls: 25, victoires_noirs: 25,
    fen: INITIAL_FEN,
    children: [],
    ...rest,
  };
}

describe('pruneLowValueLines', () => {
  it('retire nos coups faibles, garde le meilleur', () => {
    const root: RepertoireRoot = {
      fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
      children: [
        repMove({ san: 'e4', uci: 'e2e4', victoires_blancs: 90, victoires_noirs: 5, nuls: 5, parties: 100 }),
        repMove({ san: 'a3', uci: 'a2a3', victoires_blancs: 5, victoires_noirs: 90, nuls: 5, parties: 100 }),
      ],
    };
    const removed = pruneLowValueLines(root, { side: 'white', minLineValue: 0.45 });
    expect(removed).toBe(1);
    expect(root.children.map((c) => c.san)).toEqual(['e4']);
  });

  it('ne prune jamais à zéro : le meilleur reste', () => {
    const root: RepertoireRoot = {
      fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
      children: [
        repMove({ san: 'e4', uci: 'e2e4', victoires_blancs: 20, victoires_noirs: 70, nuls: 10, parties: 100 }),
        repMove({ san: 'a3', uci: 'a2a3', victoires_blancs: 5, victoires_noirs: 90, nuls: 5, parties: 100 }),
      ],
    };
    const removed = pruneLowValueLines(root, { side: 'white', minLineValue: 0.45 });
    expect(removed).toBe(1);
    expect(root.children).toHaveLength(1);
    expect(root.children[0].san).toBe('e4');
  });

  it('ne touche pas aux nœuds adverses (leurs coups sont la réalité)', () => {
    const root: RepertoireRoot = {
      fen: 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1',
      children: [
        repMove({ san: 'e5', uci: 'e7e5', victoires_blancs: 5, victoires_noirs: 90, nuls: 5, parties: 100 }),
        repMove({ san: 'c5', uci: 'c7c5', victoires_blancs: 90, victoires_noirs: 5, nuls: 5, parties: 100 }),
      ],
    };
    // Racine trait noir, side white : depth 0 = adversaire → intact même
    // si e5 est mauvais pour nous.
    const removed = pruneLowValueLines(root, { side: 'white', minLineValue: 0.45 });
    expect(removed).toBe(0);
    expect(root.children).toHaveLength(2);
  });

  it('ne prune jamais un mat (fin forcée prioritaire)', () => {
    const mate = repMove({ san: 'Qh4#', uci: 'd8h4', victoires_blancs: 5, victoires_noirs: 90, nuls: 5, parties: 100 });
    (mate as unknown as { isMate: boolean }).isMate = true;
    const root: RepertoireRoot = {
      fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
      children: [
        repMove({ san: 'e4', uci: 'e2e4', victoires_blancs: 90, victoires_noirs: 5, nuls: 5, parties: 100 }),
        mate,
      ],
    };
    const removed = pruneLowValueLines(root, { side: 'white', minLineValue: 0.45 });
    expect(removed).toBe(0);
    expect(root.children).toHaveLength(2);
  });
});

describe('mats prioritaires (sans moteur)', () => {
  // Après 1.f3 e5 2.g4??, trait noir : Qh4# mate.
  const FOOLS = 'rnbqkbnr/pppp1ppp/8/4p3/6P1/5P2/PPPPP2P/RNBQKBNR b KQkq - 0 2';

  it('findMateInOneUcis détecte Qh4#, rien au départ, rien sur FEN invalide', () => {
    expect(findMateInOneUcis(FOOLS).has('d8h4')).toBe(true);
    expect(findMateInOneUcis(INITIAL_FEN).size).toBe(0);
    expect(findMateInOneUcis('nimporte-quoi').size).toBe(0);
  });

  it('mat sous les seuils → inclus de force, en premier, compté', async () => {
    mockFetch
      .mockResolvedValueOnce({
        white: 4500, draws: 500, black: 4000,
        moves: [
          { san: 'Nf6', uci: 'g8f6', white: 4000, draws: 450, black: 3550 },
          { san: 'Qh4#', uci: 'd8h4', white: 0, draws: 0, black: 5 },
        ],
      })
      .mockResolvedValue({ white: 0, draws: 0, black: 0, moves: [] });
    const { root, stats } = await generateAutoRepertoire(FOOLS, {
      maxDepth: 2, maxBranching: 4, minFreq: 50, maxPositions: 10, gapMs: 0,
      repertoireColor: 'both', pruneMinLineValue: 0,
    });
    // Qh4# : 5 parties sur 9005 (< 1 %) mais mat → premier, flaggé, compté.
    expect(root.children.map((c) => c.san)).toEqual(['Qh4#', 'Nf6']);
    expect((root.children[0] as { isMate?: boolean }).isMate).toBe(true);
    expect(stats.mates).toBe(1);
  });
});

describe('generateAutoRepertoire — échecs et arrêt', () => {
  const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
  const rootData = {
    white: 5000,
    draws: 1300,
    black: 3700,
    moves: [
      { san: 'e4', uci: 'e2e4', white: 4000, draws: 1000, black: 3000 },
      { san: 'd4', uci: 'd2d4', white: 1000, draws: 300, black: 700 },
    ],
  };

  it('échec persistant → branche comptée, pas jetée en silence', async () => {
    mockFetch.mockRejectedValue(new Error('429 rate limited'));
    const { root, stats, completed } = await generateAutoRepertoire(START, {
      maxDepth: 1, maxBranching: 2, minFreq: 0, maxPositions: 10, gapMs: 0,
      repertoireColor: 'both', pruneMinLineValue: 0,
    });
    expect(completed).toBe(true);
    expect(root.children).toHaveLength(0);
    expect(stats.failed).toBe(1);
    expect(stats.failedFens).toHaveLength(1);
  });

  it('échec transient → réessai puis succès, zéro échec compté', async () => {
    mockFetch.mockRejectedValueOnce(new Error('timeout')).mockResolvedValue(rootData);
    const { root, stats } = await generateAutoRepertoire(START, {
      maxDepth: 1, maxBranching: 2, minFreq: 0, maxPositions: 10, gapMs: 0,
      repertoireColor: 'both', pruneMinLineValue: 0,
    });
    expect(stats.failed).toBe(0);
    expect(root.children.map((c) => c.san).sort()).toEqual(['d4', 'e4']);
  });

  it('signal déjà annulé → partiel rendu avec completed=false', async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const { root, stats, completed } = await generateAutoRepertoire(START, {
      maxDepth: 2, maxPositions: 10, gapMs: 0, pruneMinLineValue: 0,
    }, { signal: ctrl.signal });
    expect(completed).toBe(false);
    expect(root.children).toHaveLength(0);
    expect(stats.explored).toBe(0);
  });
});

describe('anti-freeze (budget + yield)', () => {
  const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

  it('clampAutoBudget : fini ≥ 1, pas de plafond (décision utilisateur)', () => {
    expect(clampAutoBudget(60)).toBe(60);
    expect(clampAutoBudget(4)).toBe(4);
    expect(clampAutoBudget(0)).toBe(1);
    expect(clampAutoBudget(5000)).toBe(5000);
    expect(clampAutoBudget(1e9)).toBe(1e9);
    expect(clampAutoBudget(Number.NaN)).toBe(200);
    expect(clampAutoBudget(Number.POSITIVE_INFINITY)).toBe(200);
    expect(clampAutoBudget(undefined)).toBe(200);
  });

  it('budget énorme + positions en cache → se termine par épuisement, sans blocage', async () => {
    // Le chemin 100 % cache n'a aucune pause réseau : chaque position rend
    // la main (yieldToUI). Sans plafond, le run se termine quand la file
    // est vide (ici profondeur 1 : une seule position interrogée).
    mockHasCache.mockReturnValue(true);
    mockFetch.mockResolvedValue({
      white: 5000, draws: 1300, black: 3700,
      moves: [
        { san: 'e4', uci: 'e2e4', white: 4000, draws: 1000, black: 3000 },
        { san: 'd4', uci: 'd2d4', white: 1000, draws: 300, black: 700 },
      ],
    });
    const { stats, completed } = await generateAutoRepertoire(START, {
      maxDepth: 1, maxBranching: 2, minFreq: 0, maxPositions: 1e9, gapMs: 0,
      repertoireColor: 'both', pruneMinLineValue: 0,
    });
    expect(completed).toBe(true);
    expect(stats.positionsInterrogees).toBe(1);
    expect(stats.cached).toBe(stats.positionsInterrogees);
    // Le partiel est persisté en fin de run (jamais de session perdue).
    expect(vi.mocked(flushLichessPersist)).toHaveBeenCalled();
  });

  it('compte les hits IndexedDB comme cache, pas comme requêtes API', async () => {
    mockFetchWithCacheStatus.mockResolvedValueOnce({
      data: { white: 1, draws: 0, black: 0, moves: [] },
      source: 'indexeddb',
    });
    const { stats } = await generateAutoRepertoire(START, {
      maxDepth: 1, maxPositions: 1, gapMs: 0, pruneMinLineValue: 0,
    });
    expect(stats.positionsInterrogees).toBe(1);
    expect(stats.cached).toBe(1);
    expect(stats.api).toBe(0);
  });

  it('arrêt pendant un run 100 % cache → partiel, completed=false', async () => {    // Coups LÉGAUX générés depuis chaque FEN : l'arbre reste alimenté
    // (profondeur 12, 2 branches) donc le run dure assez pour que
    // l'arrêt à 20 ms l'interrompe vraiment.
    mockHasCache.mockReturnValue(true);
    mockFetch.mockImplementation(async (fen: string) => {
      const c = new Chess(fen as string);
      const legal = c.moves({ verbose: true }).slice(0, 2);
      return {
        white: 5000, draws: 1300, black: 3700,
        moves: legal.map((m, i) => ({
          san: m.san,
          uci: `${m.from}${m.to}${m.promotion ?? ''}`,
          white: i === 0 ? 4000 : 1000,
          draws: 300,
          black: 700,
        })),
      };
    });
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 20);
    const { completed } = await generateAutoRepertoire(START, {
      maxDepth: 12, maxBranching: 2, minFreq: 0, maxPositions: 5000, gapMs: 0,
      repertoireColor: 'both', pruneMinLineValue: 0,
    }, { signal: ctrl.signal });
    // L'arrêt est honoré au lieu de bloquer jusqu'au bout du budget.
    expect(completed).toBe(false);
  });

  it('budget = plafond : arbre exhaustif sous les seuils → terminé, budget non consommé', async () => {
    // Coups légaux : l'arbre s'épuise par la profondeur adaptative bien
    // avant le budget de 200 — completed reste vrai, les coupes sont comptées.
    mockHasCache.mockReturnValue(false);
    mockFetch.mockImplementation(async (fen: string) => {
      const c = new Chess(fen as string);
      const legal = c.moves({ verbose: true }).slice(0, 2);
      return {
        white: 5000, draws: 1300, black: 3700,
        moves: legal.map((m, i) => ({
          san: m.san,
          uci: `${m.from}${m.to}${m.promotion ?? ''}`,
          white: i === 0 ? 4000 : 1000,
          draws: 300,
          black: 700,
        })),
      };
    });
    const { stats, completed } = await generateAutoRepertoire(START, {
      maxDepth: 2, maxBranching: 2, minFreq: 0, maxPositions: 200, gapMs: 0,
      repertoireColor: 'both', pruneMinLineValue: 0,
    });
    expect(completed).toBe(true);
    expect(stats.positionsInterrogees).toBeLessThan(200);
    expect(stats.positionsInterrogees).toBeGreaterThan(0);
    // Les petits-enfants (prof. 2 = limite adaptative) sont coupés, pas explorés.
    expect(stats.depthPruned).toBeGreaterThan(0);
  });
});

describe('Améliorations BFS : Quiescence, Transpositions, Cache Moteur', () => {
  it('isHigherHeapItem compare par priorité décroissante, profondeur croissante, ordre croissant', () => {
    const item1 = { priority: 10, depth: 1, order: 2, fen: '', pathSans: [], pathUcis: [], pathFens: [], parentId: '', popularity: 1 };
    const item2 = { priority: 20, depth: 1, order: 1, fen: '', pathSans: [], pathUcis: [], pathFens: [], parentId: '', popularity: 1 };
    const item3 = { priority: 10, depth: 3, order: 1, fen: '', pathSans: [], pathUcis: [], pathFens: [], parentId: '', popularity: 1 };
    const item4 = { priority: 10, depth: 1, order: 3, fen: '', pathSans: [], pathUcis: [], pathFens: [], parentId: '', popularity: 1 };

    expect(isHigherHeapItem(item2, item1)).toBe(true); // priorité 20 > 10
    expect(isHigherHeapItem(item1, item3)).toBe(true); // profondeur 1 < 3
    expect(isHigherHeapItem(item1, item4)).toBe(true); // ordre 2 < 3
  });

  it('l’ordre couverture termine le pli courant et le gap réseau ne double pas une requête lente', () => {
    const shallow = { priority: 1, depth: 1, order: 2, fen: '', pathSans: [], pathUcis: [], pathFens: [], parentId: '', popularity: 0.1 };
    const deep = { ...shallow, priority: 9, depth: 2, order: 1, popularity: 0.9 };
    expect(isHigherHeapItem(deep, shallow)).toBe(true);
    expect(isHigherHeapItemCoverage(shallow, deep)).toBe(true);

    expect(remainingRequestGapMs(1000, 600, 1500)).toBe(100);
    expect(remainingRequestGapMs(1000, 600, 1700)).toBe(0);
    expect(remainingRequestGapMs(1000, 0, 1000)).toBe(0);
  });

  it('ordre couverture : avec un petit budget, interroge le pli suivant avant la ligne populaire plus profonde', async () => {
    const start = INITIAL_FEN;
    const afterE4 = fenAfterUci(start, 'e2e4')!;
    const afterD4 = fenAfterUci(start, 'd2d4')!;
    const afterE4E5 = fenAfterUci(afterE4, 'e7e5')!;
    const rootData = {
      white: 90, draws: 0, black: 10,
      moves: [
        { san: 'e4', uci: 'e2e4', white: 81, draws: 0, black: 9 },
        { san: 'd4', uci: 'd2d4', white: 9, draws: 0, black: 1 },
      ],
    };
    const e4Data = {
      white: 90, draws: 0, black: 10,
      moves: [
        { san: 'e5', uci: 'e7e5', white: 81, draws: 0, black: 9 },
        { san: 'c5', uci: 'c7c5', white: 9, draws: 0, black: 1 },
      ],
    };
    const empty = { white: 0, draws: 0, black: 0, moves: [] };
    const run = async (explorationOrder: 'popular' | 'coverage'): Promise<string[]> => {
      const queried: string[] = [];
      mockFetch.mockImplementation(async (fen: string) => {
        queried.push(fen);
        if (fen === start) return rootData;
        if (fen === afterE4) return e4Data;
        return empty;
      });
      await generateAutoRepertoire(start, {
        maxDepth: 3, maxBranching: 2, minFreq: 0, maxPositions: 3, gapMs: 0,
        repertoireColor: 'both', explorationOrder, pruneMinLineValue: 0,
      });
      return queried;
    };

    expect((await run('popular'))[2]).toBe(afterE4E5);
    expect((await run('coverage'))[2]).toBe(afterD4);
  });

  it('Quiescence : prolonge les lignes instables (capture en cours)', async () => {
    // Position après 1.e4 d5 : White joue exd5 (capture avec 'x')
    const SCANDINAVIAN = 'rnbqkbnr/ppp1pppp/8/3p4/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2';
    mockFetch.mockImplementation(async (fen: string) => {
      if (fen.includes('3p4/4P3')) {
        return {
          white: 5000, draws: 1000, black: 4000,
          moves: [{ san: 'exd5', uci: 'e4d5', white: 3000, draws: 1000, black: 1000 }],
        };
      }
      return {
        white: 4000, draws: 1000, black: 3000,
        moves: [{ san: 'Qxd5', uci: 'd8d5', white: 2000, draws: 500, black: 1500 }],
      };
    });

    const { stats } = await generateAutoRepertoire(SCANDINAVIAN, {
      maxDepth: 1, maxPositions: 5, gapMs: 0, maxQuiescence: 2,
    });
    expect(stats.quiescenceExtended).toBeGreaterThanOrEqual(1);
  });

  it('Transpositions : réplique le sous-arbre canonique dans le nœud transposé sans cycle', async () => {
    // Deux ordres de coups légaux transposant :
    // A: 1.d4 Nf6 2.c4
    // B: 1.c4 Nf6 2.d4 -> même FEN
    mockFetch.mockImplementation(async (fen: string) => {
      const norm = normalizeFen(fen);
      const c = new Chess(fen as string);
      // Racine
      if (norm === normalizeFen(INITIAL_FEN)) {
        return {
          white: 5000, draws: 1000, black: 4000,
          moves: [
            { san: 'd4', uci: 'd2d4', white: 3000, draws: 1000, black: 2000 },
            { san: 'c4', uci: 'c2c4', white: 2000, draws: 1000, black: 2000 },
          ],
        };
      }
      // Après 1.d4 ou 1.c4 : réponse Nf6
      if (c.turn() === 'b' && norm.includes('3P4') && !norm.includes('2PP4')) {
        return {
          white: 3000, draws: 1000, black: 2000,
          moves: [{ san: 'Nf6', uci: 'g8f6', white: 2000, draws: 500, black: 1500 }],
        };
      }
      if (c.turn() === 'b' && norm.includes('2P5') && !norm.includes('2PP4')) {
        return {
          white: 2000, draws: 1000, black: 2000,
          moves: [{ san: 'Nf6', uci: 'g8f6', white: 1500, draws: 500, black: 1000 }],
        };
      }
      // Après 1.d4 Nf6 -> 2.c4 ; après 1.c4 Nf6 -> 2.d4
      if (c.turn() === 'w' && !norm.includes('2PP4')) {
        const move = norm.includes('3P4')
          ? { san: 'c4', uci: 'c2c4', white: 1500, draws: 500, black: 1000 }
          : { san: 'd4', uci: 'd2d4', white: 1500, draws: 500, black: 1000 };
        return { white: 2000, draws: 500, black: 1500, moves: [move] };
      }
      // Position transposée (les deux pions c4 et d4 sont joués avec Nf6)
      if (norm.includes('2PP4')) {
        return {
          white: 2000, draws: 500, black: 1500,
          moves: [{ san: 'e6', uci: 'e7e6', white: 1500, draws: 500, black: 1000 }],
        };
      }
      return { white: 0, draws: 0, black: 0, moves: [] };
    });

    const { root, stats } = await generateAutoRepertoire(INITIAL_FEN, {
      maxDepth: 4, maxBranching: 2, minFreq: 0, maxPositions: 20, gapMs: 0,
      repertoireColor: 'both', pruneMinLineValue: 0,
    });

    expect(stats.transpositions).toBeGreaterThanOrEqual(1);
    const d4Branch = root.children.find((c) => c.san === 'd4');
    const c4Branch = root.children.find((c) => c.san === 'c4');

    const d4Sub = d4Branch?.children?.[0]?.children?.[0]; // d4 -> Nf6 -> c4
    const c4Sub = c4Branch?.children?.[0]?.children?.[0]; // c4 -> Nf6 -> d4

    // Le sous-arbre canonique e6 a été répliqué dans le nœud transposé
    expect(d4Sub?.children?.map((c) => c.san)).toEqual(['e6']);
    expect(c4Sub?.children?.map((c) => c.san)).toEqual(['e6']);
  });

  it('Cache moteur : réutilise les évaluations Stockfish de la session et skip si coup ultra-dominant', async () => {
    const em = (uci: string, san: string, cp = 25): EngineMove =>
      ({ uci, san, cp, depth: 16, scoreFormatted: '', pvSans: [] });
    const judge = vi.fn(async () => [em('e2e4', 'e4', 30), em('d2d4', 'd4', 20)]);

    const localCache = new Map<string, EngineMove[]>();
    const cfg = {
      maxDepth: 1, maxPositions: 5, gapMs: 0, repertoireColor: 'white' as const,
      engineJudge: { judge, cache: localCache, skipDominantThreshold: 0.90 },
      endpoint: 'lichess' as const,
    };

    // 1. Coup dominant (e4 a ~98% des coups) -> skipDominantThreshold évite l'appel moteur
    mockFetch.mockResolvedValueOnce({
      white: 5000, draws: 1000, black: 4000,
      moves: [
        { san: 'e4', uci: 'e2e4', white: 4500, draws: 300, black: 3800 },
        { san: 'd4', uci: 'd2d4', white: 100, draws: 50, black: 50 },
      ],
    });
    await generateAutoRepertoire(INITIAL_FEN, cfg);
    expect(judge).not.toHaveBeenCalled();

    // 2. Coups équilibrés -> appel moteur (tri + tiebreak car top-2 serré), résultat stocké dans localCache
    mockFetch.mockResolvedValueOnce({
      white: 5000, draws: 1000, black: 4000,
      moves: [
        { san: 'e4', uci: 'e2e4', white: 2500, draws: 500, black: 2000 },
        { san: 'd4', uci: 'd2d4', white: 2000, draws: 500, black: 2000 },
      ],
    });
    await generateAutoRepertoire(INITIAL_FEN, cfg);
    expect(judge).toHaveBeenCalledTimes(2);
    expect(localCache.size).toBeGreaterThan(0);

    // 3. Deuxième run avec le même FEN -> servi depuis localCache sans ré-appeler judge
    judge.mockClear();
    mockFetch.mockResolvedValueOnce({
      white: 5000, draws: 1000, black: 4000,
      moves: [
        { san: 'e4', uci: 'e2e4', white: 2500, draws: 500, black: 2000 },
        { san: 'd4', uci: 'd2d4', white: 2000, draws: 500, black: 2000 },
      ],
    });
    const res3 = await generateAutoRepertoire(INITIAL_FEN, cfg);
    expect(judge).not.toHaveBeenCalled();
    expect(res3.stats.engineCached).toBeGreaterThanOrEqual(1);
    // 100 % cache → zéro calcul : engineNodes ne compte que les vrais calculs.
    expect(res3.stats.engineNodes).toBe(0);
  });
});

describe('correctifs audit — probabilité d’atteinte, transpositions, quiescence, cache', () => {
  const START = INITIAL_FEN;
  const empty = { white: 0, draws: 0, black: 0, moves: [] };

  it('#1 : à notre tour le coup retenu vaut 100 % (facteur 1, pas la fréquence)', async () => {
    const rootData = {
      white: 5000, draws: 1000, black: 4000,
      moves: [
        { san: 'e4', uci: 'e2e4', white: 4000, draws: 800, black: 3200 },
        { san: 'd4', uci: 'd2d4', white: 1000, draws: 200, black: 800 },
      ],
    };
    mockFetch.mockImplementation(async (fen: string) => {
      return normalizeFen(fen) === normalizeFen(START) ? rootData : empty;
    });
    const { root } = await generateAutoRepertoire(START, {
      maxDepth: 1, maxBranching: 4, minFreq: 0, coveragePercent: 100,
      maxPositions: 10, gapMs: 0, repertoireColor: 'white' as const,
      endpoint: 'masters' as const, pruneMinLineValue: 0,
    });
    // Contrat 1-coup : e4 seul (le plus populaire ici, pas de double lecture
    // en endpoint Maîtres) avec une probabilité d'atteinte de 100.
    expect(root.children.map((c) => c.san)).toEqual(['e4']);
    expect((root.children[0] as AutoGenNode).popularity).toBe(100);
  });

  it('#1 : mat à notre tour → seul le mat est gardé (zéro budget perdu)', async () => {
    // Après 1.f3 e5 2.g4??, trait noir : Qh4# mate, Nf6 populaire.
    const FOOLS = 'rnbqkbnr/pppp1ppp/8/4p3/6P1/5P2/PPPPP2P/RNBQKBNR b KQkq - 0 2';
    mockFetch.mockImplementation(async (fen: string) => {
      if (normalizeFen(fen) === normalizeFen(FOOLS)) {
        return {
          white: 4500, draws: 500, black: 4000,
          moves: [
            { san: 'Nf6', uci: 'g8f6', white: 4000, draws: 450, black: 3550 },
            { san: 'Qh4#', uci: 'd8h4', white: 0, draws: 0, black: 5 },
          ],
        };
      }
      return empty;
    });
    const { root, stats } = await generateAutoRepertoire(FOOLS, {
      maxDepth: 2, maxBranching: 4, minFreq: 0, coveragePercent: 100,
      maxPositions: 10, gapMs: 0, repertoireColor: 'black' as const, pruneMinLineValue: 0,
    });
    expect(root.children.map((c) => c.san)).toEqual(['Qh4#']);
    expect(stats.mates).toBe(1);
  });

  it('#2 + #3 : masse sommée sur les deux ordres, copie récursive flaggée cloned', async () => {
    const via = (sans: string[]): string => {
      const c = new Chess(INITIAL_FEN);
      for (const s of sans) c.move(s);
      return normalizeFen(c.fen());
    };
    const F_D4 = via(['d4']);
    const F_C4 = via(['c4']);
    const F_D4_NF6 = via(['d4', 'Nf6']);
    const F_C4_NF6 = via(['c4', 'Nf6']);
    const F_TRANSPO = via(['d4', 'Nf6', 'c4']);
    // Sanity : les deux ordres mènent bien à la même position normalisée.
    expect(via(['c4', 'Nf6', 'd4'])).toBe(F_TRANSPO);
    const pos = (total: number, specs: [string, string, number][]) => ({
      white: Math.round(total * 0.5),
      draws: Math.round(total * 0.1),
      black: total - Math.round(total * 0.5) - Math.round(total * 0.1),
      moves: specs.map(([san, uci, games]) => ({
        san, uci,
        white: Math.round(games * 0.5),
        draws: Math.round(games * 0.1),
        black: games - Math.round(games * 0.5) - Math.round(games * 0.1),
      })),
    });
    const table = new Map<string, ReturnType<typeof pos>>([
      [normalizeFen(START), pos(10000, [['d4', 'd2d4', 6000], ['c4', 'c2c4', 4000]])],
      [F_D4, pos(6000, [['Nf6', 'g8f6', 6000]])],
      [F_C4, pos(4000, [['Nf6', 'g8f6', 4000]])],
      [F_D4_NF6, pos(6000, [['c4', 'c2c4', 6000]])],
      [F_C4_NF6, pos(4000, [['d4', 'd2d4', 4000]])],
      [F_TRANSPO, pos(10000, [['e6', 'e7e6', 10000]])],
    ]);
    mockFetch.mockImplementation(async (fen: string) => table.get(normalizeFen(fen)) ?? empty);
    const { root, stats } = await generateAutoRepertoire(START, {
      maxDepth: 4, maxBranching: 2, minFreq: 0, coveragePercent: 100,
      maxPositions: 20, gapMs: 0, repertoireColor: 'both' as const, pruneMinLineValue: 0,
    });
    expect(stats.transpositions).toBeGreaterThanOrEqual(1);
    const d4Branch = root.children.find((c) => c.san === 'd4');
    const c4Branch = root.children.find((c) => c.san === 'c4');
    const canon = d4Branch?.children?.[0]?.children?.[0] as AutoGenNode | undefined; // d4 → Nf6 → c4 (canonique)
    const copy = c4Branch?.children?.[0]?.children?.[0] as AutoGenNode | undefined; // c4 → Nf6 → d4 (transposition)
    expect(canon?.transposition).toBe(false);
    expect(copy?.transposition).toBe(true);
    // Masse réelle 60 % + 40 % = 100 % (pas 60 % du premier chemin seul).
    expect(canon?.popularity).toBe(100);
    // Réplication complète des deux côtés, copie marquée cloned.
    expect(canon?.children?.map((c) => c.san)).toEqual(['e6']);
    expect(copy?.children?.map((c) => c.san)).toEqual(['e6']);
    expect(canon?.children?.[0]?.cloned).toBeFalsy();
    expect(copy?.children?.[0]?.cloned).toBe(true);
  });

  it('cloneSubtreeCycleSafe marque les copies cloned:true', () => {
    const src: RepertoireMove[] = [{
      coup: 'e4', san: 'e4', uci: 'e2e4', parties: 100,
      victoires_blancs: 50, nuls: 25, victoires_noirs: 25,
      fen: INITIAL_FEN, children: [],
    }];
    const out = cloneSubtreeCycleSafe(src, new Set());
    expect(out).toHaveLength(1);
    expect(out[0].san).toBe('e4');
    expect(out[0].cloned).toBe(true);
  });

  it('#4 : ligne calme à la limite → coupée sans prolongement', async () => {
    mockFetch.mockImplementation(async (fen: string) => {
      if (normalizeFen(fen) === normalizeFen(START)) {
        return {
          white: 5000, draws: 1000, black: 4000,
          moves: [{ san: 'e4', uci: 'e2e4', white: 4000, draws: 800, black: 3200 }],
        };
      }
      return empty;
    });
    const { stats } = await generateAutoRepertoire(START, {
      maxDepth: 1, maxBranching: 2, minFreq: 0, coveragePercent: 100,
      maxPositions: 5, gapMs: 0, repertoireColor: 'both' as const, pruneMinLineValue: 0,
    });
    expect(stats.quiescenceExtended).toBe(0);
    expect(stats.depthPruned).toBeGreaterThanOrEqual(1);
  });

  it('#5 : bonus cache neutre → arbre identique avec ou sans cache', async () => {
    const rootData = {
      white: 5000, draws: 1000, black: 4000,
      moves: [
        { san: 'e4', uci: 'e2e4', white: 4000, draws: 800, black: 3200 },
        { san: 'd4', uci: 'd2d4', white: 1000, draws: 200, black: 800 },
      ],
    };
    const impl = async (fen: string): Promise<typeof empty> =>
      (normalizeFen(fen) === normalizeFen(START) ? rootData : empty) as typeof empty;
    const cfg = {
      maxDepth: 2, maxBranching: 2, minFreq: 0, coveragePercent: 100,
      maxPositions: 10, gapMs: 0, repertoireColor: 'both' as const, pruneMinLineValue: 0,
    };
    mockHasCache.mockReturnValue(false);
    mockFetch.mockImplementation(impl);
    const cold = await generateAutoRepertoire(START, cfg);
    mockFetch.mockReset();
    mockFetch.mockImplementation(impl);
    mockHasCache.mockReturnValue(true);
    const warm = await generateAutoRepertoire(START, cfg);
    expect(JSON.stringify(warm.root)).toBe(JSON.stringify(cold.root));
    expect(cold.stats.api).toBeGreaterThan(0);
    expect(warm.stats.cached).toBeGreaterThan(0);
  });
});

describe('garantie réplique (tout coup adverse émis a sa réponse)', () => {
  const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

  /** Coups légaux factices (parts décroissantes) pour n'importe quel FEN. */
  function mockLegalMoves(slice: number): void {
    mockHasCache.mockReturnValue(false);
    mockFetch.mockImplementation(async (fen: string) => {
      const c = new Chess(fen);
      const legal = c.moves({ verbose: true }).slice(0, slice);
      return {
        white: 6000, draws: 2000, black: 2000,
        moves: legal.map((m, i) => ({
          san: m.san,
          uci: `${m.from}${m.to}${m.promotion ?? ''}`,
          white: i === 0 ? 4000 : 1000,
          draws: 300,
          black: 700,
        })),
      };
    });
  }

  /**
   * Invariant : tout nœud à nous non terminal a ≥ 1 enfant (la réplique).
   * Les feuilles au trait adverse sont des lignes closes normales, les fins
   * de partie n'attendent aucune réplique.
   */
  function expectAllOpponentMovesAnswered(root: RepertoireRoot, ourColor: 'white' | 'black'): void {
    const holes: string[] = [];
    const walk = (node: RepertoireMove | RepertoireRoot, fen: string): void => {
      const c = new Chess(fen);
      if (c.isGameOver()) return;
      const ours = (ourColor === 'white') === (c.turn() === 'w');
      const kids = node.children ?? [];
      if (ours && kids.length === 0) holes.push(fen);
      for (const k of kids) walk(k, k.fen);
    };
    walk(root, root.fen);
    expect(holes).toEqual([]);
  }

  it('blancs, budget serré : plafond respecté ET arbre clos (pas de trou)', async () => {
    mockLegalMoves(3);
    const { root, stats } = await generateAutoRepertoire(START, {
      maxDepth: 4, maxBranching: 3, minFreq: 0, minPopularity: 0, coveragePercent: 100,
      maxPositions: 8, gapMs: 0, repertoireColor: 'white' as const, pruneMinLineValue: 0,
    });
    // Discipline de réserve : le budget n'est jamais dépassé…
    expect(stats.positionsInterrogees).toBeLessThanOrEqual(8);
    // …et pourtant chaque coup adverse émis a sa réplique.
    expectAllOpponentMovesAnswered(root, 'white');
    expect(stats.unanswered).toBe(0);
  });

  it('blancs, profondeur 2 : répliques de clôture au-delà de la limite', async () => {
    mockLegalMoves(2);
    const { root, stats } = await generateAutoRepertoire(START, {
      maxDepth: 2, maxBranching: 2, minFreq: 0, minPopularity: 0, coveragePercent: 100,
      maxPositions: 200, gapMs: 0, maxQuiescence: 0,
      repertoireColor: 'white' as const, pruneMinLineValue: 0,
    });
    expectAllOpponentMovesAnswered(root, 'white');
    expect(stats.unanswered).toBe(0);
    // Les nœuds à nous en limite ont reçu leur +1 pli (jamais étendu).
    expect(stats.closingReplies).toBeGreaterThan(0);
    expect(stats.maxEmittedDepth).toBe(3);
  });

  it('noirs : invariant tenu sur l\'autre couleur', async () => {
    mockLegalMoves(2);
    const { root, stats } = await generateAutoRepertoire(START, {
      maxDepth: 3, maxBranching: 2, minFreq: 0, minPopularity: 0, coveragePercent: 100,
      maxPositions: 30, gapMs: 0, maxQuiescence: 0,
      repertoireColor: 'black' as const, pruneMinLineValue: 0,
    });
    expect(stats.positionsInterrogees).toBeLessThanOrEqual(30);
    expectAllOpponentMovesAnswered(root, 'black');
    expect(stats.unanswered).toBe(0);
  });

  it('réserve : la largeur cède devant la clôture quand le budget fond', async () => {
    mockLegalMoves(4);
    const wide = await generateAutoRepertoire(START, {
      maxDepth: 6, maxBranching: 4, minFreq: 0, minPopularity: 0, coveragePercent: 100,
      maxPositions: 1000, gapMs: 0, maxQuiescence: 0,
      repertoireColor: 'white' as const, pruneMinLineValue: 0,
    });
    mockLegalMoves(4);
    const tight = await generateAutoRepertoire(START, {
      maxDepth: 6, maxBranching: 4, minFreq: 0, minPopularity: 0, coveragePercent: 100,
      maxPositions: 10, gapMs: 0, maxQuiescence: 0,
      repertoireColor: 'white' as const, pruneMinLineValue: 0,
    });
    expect(tight.stats.positionsInterrogees).toBeLessThanOrEqual(10);
    expectAllOpponentMovesAnswered(tight.root, 'white');
    expect(tight.stats.unanswered).toBe(0);
    // Budget serré = moins de positions ouvertes, mais toujours clos.
    expect(tight.stats.positionsInterrogees).toBeLessThan(wide.stats.positionsInterrogees);
  });
});
