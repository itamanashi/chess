import type { EngineMove, LichessMove } from '../types/chess';
import { fetchLichessMoves } from './lichess';
import { analyzeLocalFen } from './localEngine';
import { fenAfterUci, normalizeCastleUci } from '../utils/repertoire';
import { leafAdvantageCp } from '../utils/engineAdvantage';
import { throwIfAborted } from '../utils/async';
import { LruCache } from '../utils/lru';
import {
  TRAP_NOTE_ENGINE_EMPTY,
  TRAP_NOTE_ILLEGAL,
  TRAP_NOTE_NO_DATA,
  TRAP_PROGRESS_DEFENSE,
  TRAP_PROGRESS_REPLIES,
  trapNotePartialFloor,
  trapProgressHorizon,
  trapProgressReply,
} from '../i18n';

/**
 * Trap potential: "bad against perfect defense, good in practice because
 * the adversary often errs" — measured, not vibes.
 *
 * For OUR candidate move from `fen`:
 *  1. Play it → `afterFen` (opponent to move).
 *  2. Real adversary replies from Lichess Explorer (Elo target), kept until
 *     `probMass` coverage (default 85%) capped at `topN`.
 *  3. Perfect defense = local engine best move on `afterFen`.
 *  4. At `horizonPlies` (plies from `afterFen`):
 *     - SAFETY (worst case): force best defense, follow the engine PV to the
 *       horizon, fresh engine eval of the leaf (OUR perspective).
 *     - PRACTICAL (expectation): same per Lichess reply, E = Σp·leaf.
 *       Uncovered mass defaults to the SAFETY floor (conservative).
 *  5. Verdict from configurable cp thresholds (see DEFAULT_TRAP_THRESHOLDS).
 *
 * Eval convention (single, documented): engine cp/mate are side-to-move
 * relative (UCI) → normalized to "+ = WHITE advantage" (Lichess) → flipped
 * to OUR color. `advCp > 0` always means "good for us".
 *
 * Cost model, HONEST and bounded (audit A8): 1 fetch + 1 root analysis
 * (best defense) + per reply 1 PV analysis + 1 leaf eval + safety walk and
 * leaf. Engine PVs carry up to 32 plies so walks usually need NO extra
 * probes; each walk may still fire at most TRAP_FALLBACK_PROBE_CAP (4)
 * best-move probes when a PV is short or truncated. Every probe extends
 * the progress total as it completes, so the bar ends exactly at 100%.
 * Typical topN=6 run ≈ 14 engine analyses (≈ 16 progress units with the
 * fetch and the PV walks); pathological worst case stays bounded and
 * visible. Engine work is sequential (singleton worker); network is a
 * single batched fetch per position.
 *
 * Cache isolation: ALL trap engine calls use a dedicated LRU (never the
 * shared advice cache), cleared together with the report cache.
 */

export type TrapVerdict = 'solid' | 'trap' | 'practical' | 'dangerous' | 'unknown';

export interface TrapThresholds {
  /** safety >= this (cp) AND delta < solidDeltaMaxCp → 'solid'. */
  solidSafetyMinCp: number;
  solidDeltaMaxCp: number;
  /** delta >= this AND defense prob <= max → 'trap'. */
  trapDeltaMinCp: number;
  trapDefenseMaxPct: number;
  /** safety <= this AND defense prob >= min → 'dangerous'. */
  dangerSafetyMaxCp: number;
  dangerDefenseMinPct: number;
}

export const DEFAULT_TRAP_THRESHOLDS: TrapThresholds = {
  solidSafetyMinCp: -20,
  solidDeltaMaxCp: 50,
  trapDeltaMinCp: 80,
  trapDefenseMaxPct: 15,
  dangerSafetyMaxCp: -60,
  dangerDefenseMinPct: 25,
};

export interface TrapEloConfig {
  endpoint: 'masters' | 'lichess';
  ratingsParam?: string;
  speeds?: string;
  /** Temporal filter, included year (audit A7). */
  since?: number;
}

export interface TrapPotentialConfig {
  /** Plies from afterFen (12 ≈ 6 full moves; 14 ≈ 7). Default 12. */
  horizonPlies?: number;
  /** Max adversary replies considered (default 6). */
  topN?: number;
  /** Probability mass to cover, 0..1 (default 0.85). */
  probMass?: number;
  /** Local engine depth for root + PV + leaf analyses (default 12). */
  depth?: number;
  /** Per-analysis engine budget in ms (default 15000). */
  engineTimeoutMs?: number;
  /** Locked to the documented convention (forward-compat slot). */
  evalConvention?: 'white-relative';
  thresholds?: TrapThresholds;
  /** How to treat probability mass without a horizon eval. */
  uncoveredMass?: 'safety-floor' | 'renormalize';
}

export interface TrapReplyDetail {
  san: string;
  uci: string;
  /** 0..100 share of ALL Lichess games at afterFen. */
  probabilityPct: number;
  games: number;
  /** Our advantage at the horizon leaf (null when unevaluable). */
  leafAdvCp: number | null;
  /** p·leaf contribution (null when leaf unknown). */
  contributionCp: number | null;
  isBestDefense: boolean;
}

export interface TrapPotentialReport {
  candidateSan: string;
  candidateUci: string;
  ourColor: 'white' | 'black';
  verdict: TrapVerdict;
  /** Our advantage at the safety leaf, cp (null when unknown). */
  safetyLeafAdvCp: number | null;
  /** Probability-weighted horizon expectation, cp (null when unknown). */
  expectedLeafAdvCp: number | null;
  /** expected − safety, cp (null when unknown). */
  trapDeltaCp: number | null;
  bestDefenseUci: string | null;
  bestDefenseSan: string | null;
  /** 0..100 Lichess frequency of the best defense (null when unplayed). */
  bestDefenseProbability: number | null;
  /** 0..100 analyzed probability mass. */
  coveragePct: number;
  horizonPlies: number;
  replies: TrapReplyDetail[];
  /** Human note for unknown/partial outcomes. */
  note?: string;
  fromCache: boolean;
}

export interface TrapAnalyzeArgs {
  fen: string;
  ourColor: 'white' | 'black';
  ourMoveUci: string;
  ourMoveSan?: string;
  elo: TrapEloConfig;
  config?: TrapPotentialConfig;
  signal?: AbortSignal;
  onProgress?: (done: number, total: number, label: string) => void;
}

const TRAP_CACHE_CAPACITY = 30;
/** Fallback walk uses a cheaper depth (full depth reserved for leaf evals). */
const FALLBACK_DEPTH_DELTA = 4;
const FALLBACK_MIN_DEPTH = 8;
/**
 * Max fallback engine probes PER walk (audit A8). PVs now carry up to 32
 * plies so probes rarely fire; this cap bounds the pathological case
 * (truncated/illegal tails) instead of paying one analysis per missing ply.
 */
export const TRAP_FALLBACK_PROBE_CAP = 4;

const TRAP_CACHE = new LruCache<string, TrapPotentialReport>(TRAP_CACHE_CAPACITY);
/**
 * Isolated engine cache for trap analyses (audit A8): trap leaves are
 * single-use within a run and report-cached across runs, so writing them
 * to the shared session LRU would only evict advice entries. Cleared
 * together with the report cache.
 */
const TRAP_ENGINE_CACHE_CAPACITY = 64;
const TRAP_ENGINE_CACHE = new LruCache<string, EngineMove[]>(TRAP_ENGINE_CACHE_CAPACITY);

export function clearTrapCache(): void {
  TRAP_CACHE.clear();
  TRAP_ENGINE_CACHE.clear();
}

function resolveConfig(config?: TrapPotentialConfig): Required<
  Omit<TrapPotentialConfig, 'thresholds' | 'evalConvention'>
> & { thresholds: TrapThresholds } {
  return {
    horizonPlies: config?.horizonPlies ?? 12,
    topN: config?.topN ?? 6,
    probMass: config?.probMass ?? 0.85,
    depth: config?.depth ?? 12,
    engineTimeoutMs: config?.engineTimeoutMs ?? 15000,
    thresholds: config?.thresholds ?? DEFAULT_TRAP_THRESHOLDS,
    uncoveredMass: config?.uncoveredMass ?? 'safety-floor',
  };
}

function cacheKey(
  fen: string,
  ourUci: string,
  ourColor: string,
  elo: TrapEloConfig,
  cfg: ReturnType<typeof resolveConfig>,
): string {
  return [
    fen,
    ourUci,
    ourColor,
    elo.endpoint,
    elo.ratingsParam ?? '',
    elo.speeds ?? '',
    elo.since ?? '',
    cfg.horizonPlies,
    cfg.topN,
    cfg.probMass,
    cfg.depth,
    JSON.stringify(cfg.thresholds),
    cfg.uncoveredMass,
  ].join('|');
}

function unknownReport(
  args: Pick<TrapAnalyzeArgs, 'ourColor' | 'ourMoveUci' | 'ourMoveSan'>,
  horizonPlies: number,
  note: string,
): TrapPotentialReport {
  return {
    candidateSan: args.ourMoveSan ?? args.ourMoveUci,
    candidateUci: args.ourMoveUci,
    ourColor: args.ourColor,
    verdict: 'unknown',
    safetyLeafAdvCp: null,
    expectedLeafAdvCp: null,
    trapDeltaCp: null,
    bestDefenseUci: null,
    bestDefenseSan: null,
    bestDefenseProbability: null,
    coveragePct: 0,
    horizonPlies,
    replies: [],
    note,
    fromCache: false,
  };
}

export function classifyTrapVerdict(
  safetyCp: number,
  expectedCp: number,
  bestDefenseProbabilityPct: number,
  thresholds: TrapThresholds = DEFAULT_TRAP_THRESHOLDS,
): Exclude<TrapVerdict, 'unknown'> {
  const delta = expectedCp - safetyCp;
  const prob = bestDefenseProbabilityPct;
  if (delta >= thresholds.trapDeltaMinCp && prob <= thresholds.trapDefenseMaxPct) return 'trap';
  if (safetyCp <= thresholds.dangerSafetyMaxCp && prob >= thresholds.dangerDefenseMinPct) {
    return 'dangerous';
  }
  if (safetyCp >= thresholds.solidSafetyMinCp && delta < thresholds.solidDeltaMaxCp) return 'solid';
  return 'practical';
}

interface WalkCtx {
  ourColor: 'white' | 'black';
  depth: number;
  engineTimeoutMs: number;
  signal?: AbortSignal;
  assertLive: () => void;
  /** Isolated engine cache (never touches the shared advice cache). */
  engineCache: LruCache<string, EngineMove[]>;
  /** Fired per fallback probe (honest progress accounting). */
  onFallbackProbe?: () => void;
}

export interface WalkResult {
  leafFen: string;
  /** Plies actually walked from startFen (seed + fallback probes). */
  pliesPlayed: number;
}

/** Fresh engine eval of a leaf, converted to OUR advantage (null if none). */
async function analyzeLeafAdv(
  leafFen: string,
  ourColor: 'white' | 'black',
  depth: number,
  engineTimeoutMs: number,
  signal: AbortSignal | undefined,
  assertLive: () => void,
  engineCache: LruCache<string, EngineMove[]>,
): Promise<number | null> {
  assertLive();
  const ev = await analyzeLocalFen(leafFen, {
    multiPv: 1,
    depth,
    timeoutMs: engineTimeoutMs,
    signal,
    cache: engineCache,
  });
  assertLive();
  const first = ev[0];
  if (!first) return null;
  return leafAdvantageCp(first.cp, first.mate, leafFen, ourColor);
}

/**
 * Extends a line to `budgetPlies` from `startFen`: replays `seedUcis` while
 * legal, then falls back to ply-by-ply best-move probes (cheaper depth).
 * Fallback probes are EXPLICITLY capped (`TRAP_FALLBACK_PROBE_CAP`): without
 * a cap, a truncated PV at horizon 14 costs one engine analysis PER missing
 * ply on a sequential worker. Returns the leaf + plies actually walked.
 */
async function extendToHorizon(
  startFen: string,
  seedUcis: string[],
  budgetPlies: number,
  ctx: WalkCtx,
): Promise<WalkResult> {
  let fen = startFen;
  let played = 0;
  for (const u of seedUcis) {
    if (played >= budgetPlies) break;
    const next = fenAfterUci(fen, u);
    if (!next) break;
    fen = next;
    played++;
  }
  const fallbackDepth = Math.max(FALLBACK_MIN_DEPTH, ctx.depth - FALLBACK_DEPTH_DELTA);
  let probes = 0;
  while (played < budgetPlies && probes < TRAP_FALLBACK_PROBE_CAP) {
    ctx.assertLive();
    const moves = await analyzeLocalFen(fen, {
      multiPv: 1,
      depth: fallbackDepth,
      timeoutMs: ctx.engineTimeoutMs,
      signal: ctx.signal,
      cache: ctx.engineCache,
    });
    ctx.assertLive();
    probes++;
    ctx.onFallbackProbe?.();
    const best = moves[0];
    if (!best) break;
    const next = fenAfterUci(fen, best.uci);
    if (!next) break;
    fen = next;
    played++;
  }
  return { leafFen: fen, pliesPlayed: played };
}

export async function analyzeTrapPotential(args: TrapAnalyzeArgs): Promise<TrapPotentialReport> {
  const { fen, ourColor, ourMoveUci, elo, signal } = args;
  const cfg = resolveConfig(args.config);
  const assertLive = (): void => {
    throwIfAborted(signal);
  };
  assertLive();

  // 1. Play our move (Lichess castles tolerated).
  const stdOurUci = normalizeCastleUci(fen, ourMoveUci);
  const afterFen = fenAfterUci(fen, stdOurUci);
  if (!afterFen) {
    return unknownReport(args, cfg.horizonPlies, TRAP_NOTE_ILLEGAL);
  }

  const key = cacheKey(fen, stdOurUci, ourColor, elo, cfg);
  const cached = TRAP_CACHE.get(key);
  if (cached) return { ...cached, fromCache: true };

  let done = 0;
  // Honest progress (audit A8): base units are known upfront (fetch + root
  // + per reply PV + per leaf), and every fallback probe BOTH extends the
  // total and completes a unit — so done/total rises monotonically and ends
  // exactly at 100% instead of blocking at a capped estimate.
  let totalEst = 0;
  const progress = (label: string): void => {
    if (signal?.aborted) return;
    try {
      args.onProgress?.(Math.min(done, totalEst), totalEst, label);
    } catch {
      /* listener must never break the run */
    }
  };
  // Latest unit label, reused so fallback probes refresh the bar live.
  let currentLabel = '';
  const reportProgress = async <T>(label: string, work: () => Promise<T>): Promise<T> => {
    currentLabel = label;
    try {
      return await work();
    } finally {
      done++;
      progress(label);
      // Cède un tour d'event-loop après chaque unité : React peut repeindre
      // la barre de progression et le bouton Annuler, même pendant une longue
      // chaîne de microtasks moteur (audit freeze).
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
  };

  const walkCtx: WalkCtx = {
    ourColor,
    depth: cfg.depth,
    engineTimeoutMs: cfg.engineTimeoutMs,
    signal,
    assertLive,
    engineCache: TRAP_ENGINE_CACHE,
    onFallbackProbe: () => {
      totalEst++;
      done++;
      progress(currentLabel);
    },
  };

  // 2. Real adversary replies (single batched fetch, cancellable — aborts
  // propagate as-is, other failures as Results via the caller's catch).
  totalEst = 2; // fetch + root analysis; refined once N replies are known
  progress(TRAP_PROGRESS_REPLIES);
  const lichess = await fetchLichessMoves(afterFen, undefined, elo.endpoint, elo.ratingsParam, elo.speeds, {
    signal,
    since: elo.since,
  });
  const replyMoves = lichess.moves || [];
  done++;
  assertLive();

  // Total games at this position (root-level, audit B6): the API returns up
  // to 12 moves but the TOTAL is in the response root. Using replyMoves.reduce
  // would undercount and make bestDefenseProbability=null when best defense is
  // outside top 12 → automatic 'trap' verdict (prob=0 ≤ trapDefenseMaxPct=15).
  const totalGames = lichess.white + lichess.draws + lichess.black;
  if (totalGames <= 0) {
    return unknownReport(args, cfg.horizonPlies, TRAP_NOTE_NO_DATA);
  }
  const ranked = [...replyMoves]
    .map((m) => ({ m, games: m.white + m.draws + m.black }))
    .sort((a, b) => b.games - a.games);
  const picked: { m: LichessMove; games: number; prob: number }[] = [];
  let covered = 0;
  for (const { m, games } of ranked) {
    if (picked.length >= cfg.topN || covered >= cfg.probMass) break;
    if (games <= 0) continue;
    picked.push({ m, games, prob: games / totalGames });
    covered += games / totalGames;
  }
  if (picked.length === 0) {
    return unknownReport(args, cfg.horizonPlies, TRAP_NOTE_NO_DATA);
  }
  // Exact base budget: fetch + root + safety walk + safety leaf + 2 per reply.
  // Fallback probes extend it live (total++ AND done++ each: monotonic, exact).
  totalEst = 4 + 2 * picked.length;

  // 3. Perfect defense: engine best on afterFen (opponent to move).
  progress(TRAP_PROGRESS_DEFENSE);
  const root = await analyzeLocalFen(afterFen, {
    multiPv: 1,
    depth: cfg.depth,
    timeoutMs: cfg.engineTimeoutMs,
    signal,
    cache: TRAP_ENGINE_CACHE,
  });
  done++;
  assertLive();
  const bestDefense: EngineMove | undefined = root[0];
  if (!bestDefense) {
    return unknownReport(args, cfg.horizonPlies, TRAP_NOTE_ENGINE_EMPTY);
  }
  // Normalize defensively (local engines emit standard UCI, but the reply
  // comparison below must hold whatever the source shape).
  const bestDefenseUci = normalizeCastleUci(afterFen, bestDefense.uci);

  // 4. Safety line: force best defense, walk PV to the horizon, fresh leaf eval.
  // (pvUci[0] normalized before comparing: some sources emit Chess960
  // castles, which would otherwise duplicate the first ply and break the walk)
  const pv0 =
    bestDefense.pvUci && bestDefense.pvUci.length > 0
      ? normalizeCastleUci(afterFen, bestDefense.pvUci[0])
      : null;
  const safetySeed =
    bestDefense.pvUci && bestDefense.pvUci.length > 0
      ? pv0 === bestDefenseUci
        ? bestDefense.pvUci
        : [bestDefenseUci, ...bestDefense.pvUci]
      : [bestDefenseUci];
  const safetyWalk = await reportProgress(trapProgressHorizon(bestDefense.san), async () => {
    assertLive();
    return extendToHorizon(afterFen, safetySeed, cfg.horizonPlies, walkCtx);
  });
  // A zero-ply walk means even the best defense was unplayable (engine
  // hallucination): evaluating afterFen as a "leaf" would silently answer
  // the wrong question, so fail honestly instead.
  if (safetyWalk.pliesPlayed === 0) {
    return unknownReport(args, cfg.horizonPlies, TRAP_NOTE_ENGINE_EMPTY);
  }
  const safetyAdv = await reportProgress(trapProgressHorizon(bestDefense.san), () =>
    analyzeLeafAdv(safetyWalk.leafFen, ourColor, cfg.depth, cfg.engineTimeoutMs, signal, assertLive, TRAP_ENGINE_CACHE),
  );
  if (safetyAdv === null) {
    return unknownReport(args, cfg.horizonPlies, TRAP_NOTE_ENGINE_EMPTY);
  }

  // 5. Practical line: per reply, PV walk + leaf eval (sequential engine).
  const replies: TrapReplyDetail[] = [];
  let nullLeaves = 0;
  let partialReplies = 0;
  for (const { m, games, prob } of picked) {
    assertLive();
    const replyUci = normalizeCastleUci(afterFen, m.uci);
    const replyFen = fenAfterUci(afterFen, replyUci);
    if (!replyFen) {
      nullLeaves++;
      replies.push({
        san: m.san, uci: replyUci, probabilityPct: prob * 100, games,
        leafAdvCp: null, contributionCp: null, isBestDefense: false,
      });
      continue;
    }
    const replyAnalysis = await reportProgress(trapProgressReply(m.san), () =>
      analyzeLocalFen(replyFen, {
        multiPv: 1,
        depth: cfg.depth,
        timeoutMs: cfg.engineTimeoutMs,
        signal,
        cache: TRAP_ENGINE_CACHE,
      }),
    );
    assertLive();
    const first = replyAnalysis[0];
    const seed =
      first?.pvUci && first.pvUci.length > 0 ? [replyUci, ...first.pvUci] : [replyUci];
    // Note: replyUci was verified playable above, so this walk always
    // advances ≥ 1 ply (no zero-play guard needed here, unlike safety).
    const replyWalk = await extendToHorizon(afterFen, seed, cfg.horizonPlies, walkCtx);
    if (replyWalk.pliesPlayed < cfg.horizonPlies) partialReplies++;
    const leafAdv = await reportProgress(trapProgressHorizon(m.san), () =>
      analyzeLeafAdv(replyWalk.leafFen, ourColor, cfg.depth, cfg.engineTimeoutMs, signal, assertLive, TRAP_ENGINE_CACHE),
    );
    const isBestDefense = replyUci === bestDefenseUci;
    if (leafAdv === null) nullLeaves++;
    replies.push({
      san: m.san,
      uci: replyUci,
      probabilityPct: prob * 100,
      games,
      leafAdvCp: leafAdv,
      contributionCp: leafAdv === null ? null : prob * leafAdv,
      isBestDefense,
    });
  }

  // 6. Expectation (uncovered mass floored with safety by default).
  const coveredMass = replies.reduce(
    (s, r) => s + (r.leafAdvCp === null ? 0 : r.probabilityPct / 100),
    0,
  );
  let expected: number | null;
  if (coveredMass <= 0) {
    return unknownReport(args, cfg.horizonPlies, TRAP_NOTE_ENGINE_EMPTY);
  }
  const coveredSum = replies.reduce((s, r) => s + (r.contributionCp ?? 0), 0);
  expected =
    cfg.uncoveredMass === 'renormalize'
      ? coveredSum / coveredMass
      : coveredSum + (1 - coveredMass) * safetyAdv;
  // Rounded: prob sums like .7+.2+.1 land on 99.999… in floats.
  const coveragePct = Math.round(coveredMass * 1000) / 10;

  const defenseHit = replies.find((r) => r.isBestDefense);
  // Frequency over ALL games (not just covered): matches the verdict scale.
  const defenseGames = defenseHit?.games ?? 0;
  const bestDefenseProbability = defenseHit ? (defenseGames / totalGames) * 100 : null;

  const verdict = classifyTrapVerdict(
    safetyAdv,
    expected,
    bestDefenseProbability ?? 0,
    cfg.thresholds,
  );

  const notes: string[] = [];
  // Audit B8: safety vs practical leaves may be at different depths if walks
  // stopped early (PV exhausted, fallback probe cap hit). Flag partial comparisons.
  if (safetyWalk.pliesPlayed < cfg.horizonPlies) {
    notes.push(`Sécurité partielle (${safetyWalk.pliesPlayed} coups au lieu de ${Math.round(cfg.horizonPlies / 2)}).`);
  }
  if (partialReplies > 0) {
    notes.push(`${partialReplies} réponse(s) pratique(s) partielle(s).`);
  }
  if (nullLeaves > 0) {
    notes.push(trapNotePartialFloor(nullLeaves));
  }

  const report: TrapPotentialReport = {
    candidateSan: args.ourMoveSan ?? ourMoveUci,
    candidateUci: stdOurUci,
    ourColor,
    verdict,
    safetyLeafAdvCp: safetyAdv,
    expectedLeafAdvCp: expected,
    trapDeltaCp: expected - safetyAdv,
    bestDefenseUci,
    bestDefenseSan: bestDefense.san,
    bestDefenseProbability,
    coveragePct,
    horizonPlies: cfg.horizonPlies,
    replies,
    ...(notes.length > 0 ? { note: notes.join(' ') } : {}),
    fromCache: false,
  };
  TRAP_CACHE.set(key, report);
  return report;
}
