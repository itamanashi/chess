import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
  computeTrapScore,
  generateTrapRepertoire,
  heapHigher,
  readTrapScore,
  reduceTrapTreeToSingleOwnTurn,
  TRAP_MATE_PRIORITY,
} from './trapAutoRepertoire';
import type { EngineMove, RepertoireRoot } from '../types/chess';
import { INITIAL_FEN } from '../utils/repertoire';

const { idbStore } = vi.hoisted(() => ({
  idbStore: new Map<string, { lines: EngineMove[] }>(),
}));

vi.mock('./lichess', () => ({
  fetchLichessMovesWithCacheStatus: vi.fn(),
  flushLichessPersist: vi.fn(async () => true),
  explorerCacheReady: vi.fn(async () => {}),
}));

vi.mock('../storage/engineEvalCacheDb', () => ({
  engineEvalCacheKey: (fen: string, depth: number, multiPv: number) =>
    `${fen}|${depth}|${multiPv}`,
  idbGetEngineEval: vi.fn(async (key: string) => idbStore.get(key) ?? null),
  idbPutEngineEval: vi.fn(
    async (entry: { key: string; lines: EngineMove[] }) => {
      idbStore.set(entry.key, { lines: entry.lines });
    },
  ),
}));

async function mockEmptyExplorer(): Promise<void> {
  const { fetchLichessMovesWithCacheStatus } = await import('./lichess');
  vi.mocked(fetchLichessMovesWithCacheStatus).mockResolvedValue({
    data: { white: 0, draws: 0, black: 0, moves: [] },
    source: 'memory',
  } as never);
}

beforeEach(async () => {
  vi.resetAllMocks();
  idbStore.clear();
  await mockEmptyExplorer();
});

function line(uci: string, san: string, cp: number): EngineMove {
  return { uci, san, cp, depth: 10, scoreFormatted: `${cp}cp`, pvSans: [] };
}

describe('computeTrapScore', () => {
  it('retourne null sans réponse adverse', () => {
    expect(computeTrapScore([], 50)).toBeNull();
  });

  it('couvre les réponses dans la fenêtre, score = écart top-2', () => {
    const r = computeTrapScore([line('a', 'a', 100), line('b', 'b', 80)], 50);
    expect(r?.trapScore).toBe(20);
    expect(r?.goodResponses).toHaveLength(2);
    expect(r?.uncovered).toBe(0);
  });

  it('compte hors-fenêtre en non couvertes', () => {
    const r = computeTrapScore([line('a', 'a', 100), line('b', 'b', 0)], 50);
    expect(r?.trapScore).toBe(100);
    expect(r?.goodResponses).toHaveLength(1);
    expect(r?.uncovered).toBe(1);
  });

  it('réponse unique : piège maximal (999)', () => {
    const r = computeTrapScore([line('a', 'a', 30)], 50);
    expect(r?.trapScore).toBe(999);
    expect(r?.uncovered).toBe(0);
  });

  it('position déjà perdue : pas un piège', () => {
    // mate:+1 du point de vue adverse = l'adversaire NOUS mate → rejet.
    const r = computeTrapScore(
      [
        {
          uci: 'a',
          san: 'a#',
          mate: 1,
          depth: 10,
          scoreFormatted: '#+',
          pvSans: [],
        },
      ],
      50,
    );
    expect(r?.trapScore).toBe(Number.NEGATIVE_INFINITY);
    expect(r?.goodResponses).toHaveLength(1);
  });

  it('adversaire maté : piège parfait', () => {
    // mate:-1 du point de vue adverse = l'adversaire EST maté → on gagne.
    const r = computeTrapScore(
      [
        {
          uci: 'a',
          san: 'a',
          mate: -1,
          depth: 10,
          scoreFormatted: '#-',
          pvSans: [],
        },
      ],
      50,
    );
    expect(r?.trapScore).toBe(999);
  });

  it('readTrapScore préfère le champ numérique au regex (repli compat)', () => {
    expect(
      readTrapScore({
        coup: 'e4',
        uci: 'e2e4',
        san: 'e4',
        parties: 1,
        victoires_blancs: 0,
        nuls: 0,
        victoires_noirs: 0,
        fen: 'f',
        trapScore: 75,
        eval: 'trap:75cp',
      } as never),
    ).toBe(75);
    expect(
      readTrapScore({
        coup: 'd4',
        uci: 'd2d4',
        san: 'd4',
        parties: 1,
        victoires_blancs: 0,
        nuls: 0,
        victoires_noirs: 0,
        fen: 'f',
        eval: 'trap:42cp',
      } as never),
    ).toBe(42);
  });
});

/** Mat de l'écolier : Qh5xf7# (les Blancs matent en 1). */
const SCHOLARS_MATE =
  'r1bqkb1r/pppp1ppp/2n2n2/4p2Q/2B1P3/8/PPPP1PPP/RNB1K1NR w KQkq - 4 4';

describe('heapHigher', () => {
  function item(priority: number, depth: number, seq: number) {
    return {
      priority,
      depth,
      fen: 'f',
      fenKey: 'f',
      parentId: 'root',
      pathSans: [],
      pathUcis: [],
      seq,
      reachProb: 1,
      depthBonus: 0,
    };
  }

  it("best-first : promesse d'abord, puis profondeur, puis insertion", () => {
    // Filon piégeux (75) avant coup plat (5) même si plus profond.
    expect(heapHigher(item(75, 2, 9), item(5, 1, 1))).toBe(true);
    expect(heapHigher(item(5, 1, 1), item(75, 2, 9))).toBe(false);
    // À promesse égale : moins profond d'abord.
    expect(heapHigher(item(5, 1, 2), item(5, 2, 1))).toBe(true);
    // À promesse et profondeur égales : FIFO.
    expect(heapHigher(item(5, 1, 1), item(5, 1, 2))).toBe(true);
    // Mat toujours premier.
    expect(heapHigher(item(TRAP_MATE_PRIORITY, 3, 9), item(999, 0, 0))).toBe(
      true,
    );
  });
});

describe('generateTrapRepertoire', () => {
  it('émet le mat en 1 même quand l\u2019Explorer est vide (repli local)', async () => {
    const judge = vi.fn(async () => [] as EngineMove[]);
    const { root, stats } = await generateTrapRepertoire(SCHOLARS_MATE, {
      depth: 12,
      maxDepth: 2,
      maxPositions: 10,
      gapMs: 0,
      repertoireColor: 'white',
      judge,
    });
    expect(stats.mates).toBe(1);
    expect(root.children).toHaveLength(1);
    expect(root.children[0].san).toBe('Qxf7#');
    expect(root.children[0].isMate).toBe(true);
    // Aucune évaluation moteur consommée : le mat court-circuite tout.
    expect(judge).not.toHaveBeenCalled();
    expect(stats.positionsInterrogees).toBe(0);
  });

  it('compte unanswered quand le fetch Explorer échoue à notre tour', async () => {
    const { fetchLichessMovesWithCacheStatus } = await import('./lichess');
    vi.mocked(fetchLichessMovesWithCacheStatus).mockRejectedValue(
      new Error('429 rate limited'),
    );
    const judge = vi.fn(async () => [] as EngineMove[]);
    const { stats } = await generateTrapRepertoire(INITIAL_FEN, {
      depth: 12,
      maxDepth: 1,
      maxPositions: 10,
      gapMs: 0,
      extraFetchRetries: 0,
      repertoireColor: 'white',
      useLichessForOpponent: true,
      judge,
    });
    expect(stats.failed).toBe(1);
    expect(stats.unanswered).toBe(1);
  });

  /** Juge : nos coups au départ, réponses adverses différenciées par position. */
  function trapJudge() {
    return vi.fn(async (fen: string) => {
      if (fen === INITIAL_FEN) {
        return [line('e2e4', 'e4', 30), line('d2d4', 'd4', 20)];
      }
      if (fen.includes('4P3')) {
        // Après 1.e4 : deux bonnes réponses proches → trap score 5.
        return [line('e7e5', 'e5', -20), line('c7c5', 'c5', -25)];
      }
      // Après 1.d4 : une seule bonne réponse → trap score 75.
      return [line('d7d5', 'd5', -20), line('e7e6', 'e6', -95)];
    });
  }

  it('réduit à une seule réponse à notre tour : trap score max (champ numérique)', async () => {
    const { root, stats } = await generateTrapRepertoire(INITIAL_FEN, {
      depth: 10,
      maxDepth: 1,
      maxPositions: 20,
      gapMs: 0,
      repertoireColor: 'white',
      judge: trapJudge(),
    });
    expect(stats.unanswered).toBe(0);
    expect(stats.trapPruned).toBe(0);
    // d4 (75) bat e4 (5) : le champ trapScore pilote la réduction.
    expect(root.children).toHaveLength(1);
    expect(root.children[0].san).toBe('d4');
    expect(root.children[0].eval).toBe('trap:75cp');
    expect(root.children[0].trapScore).toBe(75);
  });

  it('un coup qui se fait mater est élagué, jamais émis', async () => {
    const mateJudge = vi.fn(async (fen: string) => {
      if (fen === INITIAL_FEN) {
        return [line('e2e4', 'e4', 30), line('d2d4', 'd4', 20)];
      }
      if (fen.includes('4P3')) {
        // Après 1.e4 : l'adversaire mate → candidat perdant à rejeter.
        return [
          {
            uci: 'd8h4',
            san: 'Qh4#',
            mate: 1,
            depth: 10,
            scoreFormatted: '#+',
            pvSans: [],
          },
        ];
      }
      return [line('d7d5', 'd5', -20), line('e7e6', 'e6', -95)];
    });
    const { root, stats } = await generateTrapRepertoire(INITIAL_FEN, {
      depth: 10,
      maxDepth: 1,
      maxPositions: 20,
      gapMs: 0,
      repertoireColor: 'white',
      judge: mateJudge,
    });
    expect(root.children).toHaveLength(1);
    expect(root.children[0].san).toBe('d4');
    expect(stats.unsoundPruned).toBeGreaterThanOrEqual(1);
  });

  it('reduceTrapTreeToSingleOwnTurn garde le trapScore max (numérique d\u2019abord)', () => {
    const root = {
      fen: INITIAL_FEN,
      children: [
        {
          coup: 'e4',
          uci: 'e2e4',
          san: 'e4',
          parties: 1,
          victoires_blancs: 0,
          nuls: 0,
          victoires_noirs: 0,
          fen: 'f1',
          trapScore: 5,
          eval: 'trap:5cp',
          children: [],
        },
        {
          coup: 'd4',
          uci: 'd2d4',
          san: 'd4',
          parties: 1,
          victoires_blancs: 0,
          nuls: 0,
          victoires_noirs: 0,
          fen: 'f2',
          trapScore: 75,
          eval: 'trap:75cp',
          children: [],
        },
      ],
    } as unknown as RepertoireRoot;
    reduceTrapTreeToSingleOwnTurn(root, 'white');
    expect(root.children).toHaveLength(1);
    expect(root.children[0].san).toBe('d4');
  });

  it('minTrapScore élague mais conserve toujours 1 coup', async () => {
    const { root, stats } = await generateTrapRepertoire(INITIAL_FEN, {
      depth: 11,
      maxDepth: 1,
      maxPositions: 20,
      gapMs: 0,
      minTrapScore: 200,
      repertoireColor: 'white',
      judge: trapJudge(),
    });
    expect(root.children).toHaveLength(1);
    expect(root.children[0].san).toBe('d4');
    expect(stats.trapPruned).toBe(1);
  });

  it('le budget compte le cache : relecture = 1 unité', async () => {
    const cfg = {
      depth: 14,
      maxDepth: 1,
      maxPositions: 50,
      gapMs: 0,
      repertoireColor: 'white' as const,
    };
    const warm = await generateTrapRepertoire(INITIAL_FEN, {
      ...cfg,
      judge: trapJudge(),
    });
    expect(warm.root.children).toHaveLength(1);
    expect(warm.stats.positionsInterrogees).toBeGreaterThan(0);

    // Second run à budget égal : tout est relu depuis le cache, aucun calcul,
    // mais le même budget suffit à reproduire l'arbre (cache inclus).
    const judge2 = vi.fn(async (fen: string) => trapJudge()(fen));
    const cold = await generateTrapRepertoire(INITIAL_FEN, {
      ...cfg,
      judge: judge2,
    });
    expect(judge2).not.toHaveBeenCalled();
    expect(cold.stats.positionsInterrogees).toBe(0);
    expect(cold.stats.engineCached).toBeGreaterThan(0);
    expect(cold.root.children).toHaveLength(1);
    expect(cold.root.children[0].san).toBe('d4');

    // Budget minuscule : même le cache l'épuise → pas d'arbre complet.
    const judge3 = vi.fn(async (fen: string) => trapJudge()(fen));
    const tiny = await generateTrapRepertoire(INITIAL_FEN, {
      ...cfg,
      maxPositions: 1,
      judge: judge3,
    });
    expect(judge3).not.toHaveBeenCalled();
    expect(tiny.stats.engineCached).toBeGreaterThanOrEqual(1);
    expect(tiny.root.children.length === 0 || tiny.stats.unanswered > 0).toBe(
      true,
    );
  });

  it('réutilise les lignes adverses au pop : 0 appel moteur', async () => {
    const judge = trapJudge();
    const { root, stats } = await generateTrapRepertoire(INITIAL_FEN, {
      depth: 10,
      maxDepth: 2,
      maxPositions: 50,
      gapMs: 0,
      repertoireColor: 'white',
      judge,
    });
    // e4 et d4 (tour adverse, profondeur 1) rejouent leurs lignes
    // calculées au temps candidat au lieu de re-consommer du budget.
    expect(stats.engineReused).toBeGreaterThanOrEqual(2);
    expect(root.children.length).toBeGreaterThan(0);
  });

  it('extension locale : le filon piégeux dépasse maxDepth, le coup plat non', async () => {
    const { root, stats } = await generateTrapRepertoire(INITIAL_FEN, {
      depth: 10,
      maxDepth: 1,
      maxPositions: 50,
      gapMs: 0,
      repertoireColor: 'white',
      trapExtendMinScore: 50,
      trapExtensionPlies: 2,
      judge: trapJudge(),
    });
    // d4 (trap 75 ≥ 50) creusé au-delà de maxDepth=1, e4 (5) élagué.
    expect(stats.trapExtended).toBeGreaterThan(0);
    expect(stats.depthPruned).toBeGreaterThanOrEqual(1);
    expect(root.children).toHaveLength(1);
    expect(root.children[0].san).toBe('d4');
    expect(root.children[0].children!.length).toBeGreaterThan(0);
  });

  it('profondeur asymétrique : nos coups à D, réponses adverses à D-delta', async () => {
    const depths: number[] = [];
    const judge = vi.fn(async (fen: string, opts: { depth: number }) => {
      depths.push(opts.depth);
      return trapJudge()(fen);
    });
    await generateTrapRepertoire(INITIAL_FEN, {
      depth: 14,
      maxDepth: 1,
      maxPositions: 20,
      gapMs: 0,
      repertoireColor: 'white',
      trapAdversaryDepthDelta: 4,
      judge: judge as never,
    });
    // Racine (notre tour) à 14, réponses adverses à max(8, 14-4) = 10.
    expect(depths).toContain(14);
    expect(depths).toContain(10);
    expect(Math.max(...depths)).toBe(14);
  });

  it('delta 0 : tout à pleine profondeur (historique)', async () => {
    const depths: number[] = [];
    const judge = vi.fn(async (fen: string, opts: { depth: number }) => {
      depths.push(opts.depth);
      return trapJudge()(fen);
    });
    await generateTrapRepertoire(INITIAL_FEN, {
      depth: 14,
      maxDepth: 1,
      maxPositions: 20,
      gapMs: 0,
      repertoireColor: 'white',
      trapAdversaryDepthDelta: 0,
      judge: judge as never,
    });
    expect(depths.length).toBeGreaterThan(0);
    expect(new Set(depths)).toEqual(new Set([14]));
  });

  it("skip Lichess : aucun appel Explorateur quand l'enrichissement est off", async () => {
    const { fetchLichessMovesWithCacheStatus } = await import('./lichess');
    await generateTrapRepertoire(INITIAL_FEN, {
      depth: 10,
      maxDepth: 1,
      maxPositions: 10,
      gapMs: 0,
      repertoireColor: 'white',
      judge: trapJudge(),
    });
    expect(vi.mocked(fetchLichessMovesWithCacheStatus)).not.toHaveBeenCalled();
  });

  it("fetch Lichess : appelé quand l'enrichissement est on", async () => {
    const { fetchLichessMovesWithCacheStatus } = await import('./lichess');
    await generateTrapRepertoire(INITIAL_FEN, {
      depth: 10,
      maxDepth: 1,
      maxPositions: 10,
      gapMs: 0,
      repertoireColor: 'white',
      useLichessForOpponent: true,
      judge: trapJudge(),
    });
    expect(vi.mocked(fetchLichessMovesWithCacheStatus)).toHaveBeenCalled();
  });
});
