import { describe, expect, it, vi, beforeEach } from 'vitest';
import { Chess } from 'chess.js';
import {
  generateTrapRepertoire,
  type TrapGenConfig,
} from './trapAutoRepertoire';
import type { EngineMove, RepertoireRoot } from '../types/chess';
import { INITIAL_FEN } from '../utils/repertoire';
import { countNodes } from '../utils/repertoireTree';

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

function hashFen(fen: string): number {
  let h = 0;
  for (let i = 0; i < fen.length; i++) h = (h * 31 + fen.charCodeAt(i)) >>> 0;
  return h;
}

/**
 * Juge simule deterministe : 6 lignes MultiPV sur les coups legaux reels.
 * 25 % des positions sont "piegeuses" (drop-off r1-r2 = 120cp),
 * les autres plates (drop-off 8cp). Memes FEN -> memes lignes.
 *
 * Latence par profondeur (vrai Stockfish : ~x2 tous les 2 plies) :
 * D12 = 25 ms, D8 = 6 ms. Les relectures cache restent instantanees :
 * l'ecart de temps mesure exactement le cout des profondeurs demandees.
 */
function depthLatencyMs(depth: number): number {
  return Math.max(2, Math.round(25 * 2 ** ((depth - 12) / 2)));
}

function benchJudge() {
  return async (
    fen: string,
    opts?: { depth?: number },
  ): Promise<EngineMove[]> => {
    await new Promise((r) => setTimeout(r, depthLatencyMs(opts?.depth ?? 12)));
    const board = new Chess(fen);
    const legal = board.moves({ verbose: true }).slice(0, 6);
    const trappy = hashFen(fen) % 4 === 0;
    return legal.map((m, i) => {
      const uci = `${m.from}${m.to}${m.promotion ?? ''}`;
      const cp = i === 0 ? 40 : trappy ? 40 - 120 - (i - 1) * 8 : 40 - i * 8;
      return {
        uci,
        san: m.san,
        cp,
        depth: 16,
        scoreFormatted: `${cp}cp`,
        pvSans: [],
      };
    });
  };
}

/** Profondeur max de l'arbre en plies (racine = 0). */
function maxDepthOf(root: RepertoireRoot): number {
  let max = 0;
  const visit = (nodes: RepertoireRoot['children'], d: number): void => {
    for (const n of nodes) {
      if (d > max) max = d;
      if (n.children) visit(n.children, d + 1);
    }
  };
  visit(root.children, 1);
  return max;
}

describe('benchmark pieges (meme budget, meme juge simule)', () => {
  it('compare avant / reutil / priorite / complet', async () => {
    const base: TrapGenConfig = {
      depth: 12,
      maxDepth: 6,
      maxPositions: 120,
      gapMs: 0,
      soundnessWindow: 200,
      trapAdversaryWindow: 50,
      repertoireColor: 'white',
    };
    const scenarios: { name: string; extra: TrapGenConfig }[] = [
      {
        name: 'avant (BFS, sans reutil, sans extension)',
        extra: {
          forceBfsOrder: true,
          disablePreLinesReuse: true,
          trapExtensionPlies: 0,
          trapAdversaryDepthDelta: 0,
        },
      },
      {
        name: '+ reutilisation lignes (0 appel au re-pop)',
        extra: { forceBfsOrder: true, trapExtensionPlies: 0 },
      },
      {
        name: '+ priorite prometteuse (best-first)',
        extra: { trapExtensionPlies: 0 },
      },
      { name: 'complet (+ extension filon piegeux)', extra: {} },
      {
        name: 'avant CONTROLE (re-run a froid, anti-cache)',
        extra: {
          forceBfsOrder: true,
          disablePreLinesReuse: true,
          trapExtensionPlies: 0,
          trapAdversaryDepthDelta: 0,
        },
      },
    ];

    const rows: string[] = [];
    let baselineNodes = 0;
    let baselineCalls = 0;
    let baselineMs = 0;
    for (const s of scenarios) {
      idbStore.clear(); // depart a froid : aucun scenario ne profite du precedent
      const judge = vi.fn(benchJudge());
      const t0 = performance.now();
      const { root, stats } = await generateTrapRepertoire(
        INITIAL_FEN,
        { ...base, ...s.extra, judge },
        {},
      );
      const ms = performance.now() - t0;
      const nodes = countNodes(root);
      const depth = maxDepthOf(root);
      if (s.name.startsWith('avant (BFS')) {
        baselineNodes = nodes;
        baselineCalls = judge.mock.calls.length;
        baselineMs = ms;
      }
      const isRef = s.name.startsWith('avant');
      const nodeGain =
        baselineNodes > 0 && !isRef
          ? `+${Math.round(((nodes - baselineNodes) / baselineNodes) * 100)}%`
          : '-';
      const speedGain =
        baselineMs > 0 && !isRef
          ? `${ms < baselineMs ? 'plus vite' : 'plus lent'} (${Math.round(ms - baselineMs)} ms)`
          : '-';
      rows.push(
        `| ${s.name} | ${judge.mock.calls.length} calculs | ${(ms / 1000).toFixed(1)} s (${speedGain}) | ${nodes} coups (${nodeGain}) | ${depth} plies | ${stats.engineReused} | ${stats.trapExtended} |`,
      );
      if (s.name.startsWith('complet')) {
        expect(stats.engineReused).toBeGreaterThan(0);
        expect(stats.trapExtended).toBeGreaterThan(0);
        expect(root.children.length).toBeGreaterThan(0);
      }
      if (s.name.includes('CONTROLE')) {
        // Anti-cache : le re-run a froid redonne les memes chiffres.
        expect(judge.mock.calls.length).toBe(baselineCalls);
        expect(nodes).toBe(baselineNodes);
      }
    }

    console.log(
      [
        '',
        '### Benchmark pieges - budget 120 appels, profondeur 6, depart a froid',
        '_Latence simulee par profondeur : D12 = 25 ms, D8 = 6 ms (facteur x2 / 2 plies) ;_',
        "_reponses adverses a D-4 sauf 'avant' (tout a D12). Relectures cache instantanees._",
        "_Chaque scenario part d'un cache vide._",
        '',
        '| scenario | calculs | temps | coups generes | profondeur max | lignes reutilisees | noeuds creuses |',
        '| --- | --- | --- | --- | --- | --- | --- |',
        ...rows,
        '',
        `_Reference "avant" : ${baselineCalls} calculs, ${(baselineMs / 1000).toFixed(1)} s pour ${baselineNodes} coups._`,
        '',
      ].join('\n'),
    );
  }, 90000);
});
