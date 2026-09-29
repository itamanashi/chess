import { Chess, type Square } from 'chess.js';
import type { LichessApiResponse, LichessMove } from '../types/chess';
import { fetchLichessMoves } from './lichess';
import { analyzeLocalFen, isSuperseded } from './localEngine';
import { normalizeCastleUci } from '../utils/repertoire';
import { isAbortError, mapWithConcurrency } from '../utils/async';
import { cpToOutcome } from '../utils/engineAdvantage';
import { DEFAULT_RANKING_CONFIG } from './rankingConfig';
import { positionRatingMean, ratingAdjustedRate, TIER_WEIGHTS, type EloTier } from './repertoireScore';
import {
  robustnessProgressEngine,
  robustnessProgressOurs,
  robustnessProgressReplies,
  type RobustnessSkipReason,
} from '../i18n';

/**
 * Branch robustness: a move is judged not on its own value but on what
 * happens AFTER the adversary replies.
 *
 * Per candidate move:
 *   significant adversary replies (weighted by real frequency)
 *     -> our best reply (stats) + local engine eval (theory)
 *     -> reply score (0..1, our perspective)
 *   robustness = weighted average − bad-branch penalty
 *   danger = significant shortfall below the average
 *
 * Branch global score (display) = theory + practice + robustness, weighted
 * per Elo tier (GLOBAL_WEIGHTS): the 3 scores are shown separately.
 * Expensive (local engine per reply): run ONLY on demand, with progress +
 * cancellation + local engine cache.
 *
 * Execution model (v2):
 *   - Phase 1 (network, bounded parallelism): adversary reply lists;
 *   - Phase 2 (network, bounded parallelism): our stats after each reply;
 *   - Phase 3 (SEQUENTIAL engine): the local Stockfish worker is a singleton
 *     (`localEngine.ts`) — concurrent analyses would stomp each other via
 *     `analysisSeq`, so engine work is deliberately serial.
 * A per-run FEN cache dedupes in-flight + repeated Lichess requests
 * (transpositions across candidates share positions).
 */

export interface ReplyAnalysis {
  replyUci: string;
  replySan: string;
  sharePct: number; // share of adversary replies at this position
  games: number;
  ourBestSan: string; // our best reply per stats
  ourGames: number;
  ourCp: number | null; // engine eval from OUR perspective (null if unavailable)
  ourMate?: number;
  ourOutcomeEngine: number; // 0..1 (logistic on the eval)
  ourOutcomeStats: number; // 0..1 (shrunk score rate)
  replyScore: number; // 0..1 blended
  /** False when our-stats fetch failed (vs. genuinely zero games). */
  statsAvailable: boolean;
  /** False when the local engine gave nothing for this reply. */
  engineAvailable: boolean;
}

export interface BranchRobustness {
  candidateUci: string;
  candidateSan: string;
  replies: ReplyAnalysis[];
  coveragePct: number; // share of adversary replies covered by the analysis
  weightedAvg: number; // 0..1 frequency-weighted average
  worst: number; // 0..1 worst reply
  worstShare: number; // 0..1 share of the worst reply
  shortfall: number; // 0..1 average shortfall below the average
  robustness: number; // 0..1 = average − shortfall
  danger: boolean;
}

/** Explicit cancellation token — safe across screens/contexts (no globals). */
export interface RobustnessSession {
  readonly cancelled: boolean;
  cancel(): void;
}

export function createRobustnessSession(): RobustnessSession {
  let cancelled = false;
  return {
    get cancelled() {
      return cancelled;
    },
    cancel() {
      cancelled = true;
    },
  };
}

interface ActiveRun {
  session: RobustnessSession;
  abortNetwork: () => void;
}

let activeRun: ActiveRun | null = null;

/**
 * Legacy global cancel: aborts network in flight + flags the latest
 * registered run as cancelled. Prefer passing an explicit `session` in
 * multi-context use.
 */
export function stopRobustness(): void {
  try {
    activeRun?.abortNetwork();
  } catch {
    /* ignore */
  }
  activeRun?.session.cancel();
  activeRun = null;
}

export interface RobustnessOptions {
  playerColor: 'white' | 'black';
  eloTier: EloTier;
  endpoint: 'masters' | 'lichess';
  ratingsParam?: string;
  /** Temporal filter, included year (audit A7: masters mixes 70 years otherwise). */
  since?: number;
  depth?: number; // local depth per reply (default 12)
  maxReplies?: number; // replies analyzed per move (default 3)
  minShare?: number; // min share to keep a reply (default 0.07)
  timeoutMs?: number;
  /** Max parallel Lichess requests (engine stays serial: singleton worker). */
  networkConcurrency?: number;
  /** Explicit cancellation token (a fresh one is created when absent). */
  session?: RobustnessSession;
  onProgress?: (done: number, total: number, label: string) => void;
}

export interface RobustnessSkipped {
  san: string;
  uci: string;
  reason: RobustnessSkipReason;
}

export interface RobustnessIssue {
  /** Human context, e.g. "e4 … c5". */
  where: string;
  message: string;
}

/**
 * Full analysis outcome: results PLUS error/coverage metadata so the UI can
 * explain partial runs ("2/3 moves analyzed, 1 with no data") instead of a
 * bare empty list.
 */
export interface RobustnessReport {
  results: BranchRobustness[];
  requestedCandidates: number;
  analyzedCandidates: number;
  skipped: RobustnessSkipped[];
  repliesAnalyzed: number;
  issues: RobustnessIssue[];
  suppressedIssueCount: number;
  cancelled: boolean;
  durationMs: number;
}

/** Robustness = weighted average (frequency) MINUS bad-branch penalty, itself
 * frequency-weighted: a 38%-ish branch that is only 2% of replies costs
 * ~nothing; the same at 30% tanks the score. The worst case counts, but pro
 * rata its real probability. */
export function combineRobustness(scores: { weight: number; score: number }[]): {
  avg: number;
  worst: number;
  worstShare: number;
  shortfall: number;
  robustness: number;
  danger: boolean;
} {
  if (scores.length === 0) {
    return { avg: 0.5, worst: 0.5, worstShare: 0, shortfall: 0, robustness: 0.5, danger: false };
  }
  const wSum = scores.reduce((s, x) => s + x.weight, 0) || 1;
  const avg = scores.reduce((s, x) => s + (x.weight / wSum) * x.score, 0);
  let worst = scores[0].score;
  let worstShare = scores[0].weight / wSum;
  for (const x of scores) {
    if (x.score < worst) {
      worst = x.score;
      worstShare = x.weight / wSum;
    }
  }
  const shortfall = scores.reduce((s, x) => s + (x.weight / wSum) * Math.max(0, avg - x.score), 0);
  const robustness = Math.max(0, avg - shortfall);
  return { avg, worst, worstShare, shortfall, robustness, danger: shortfall > 0.03 };
}

export function formatOurEval(cp: number | null, mate?: number): string {
  if (typeof mate === 'number') return mate > 0 ? `#+${mate}` : `#-${Math.abs(mate)}`;
  if (cp === null) return '—';
  return cp > 0 ? `+${(cp / 100).toFixed(2)}` : (cp / 100).toFixed(2);
}

export interface GlobalWeights {
  theory: number;
  practical: number;
  robustness: number;
}

/** Final score = Theory + Practice + Robustness, weights per Elo tier. */
export const GLOBAL_WEIGHTS: Record<EloTier, GlobalWeights> = {
  low: { theory: 0.25, practical: 0.45, robustness: 0.3 },
  mid: { theory: 0.35, practical: 0.35, robustness: 0.3 },
  high: { theory: 0.45, practical: 0.25, robustness: 0.3 },
};

export function globalBranchScore(
  move: { theoreticalScore: number; practicalScore: number },
  robustness01: number,
  tier: EloTier,
): number {
  const w = GLOBAL_WEIGHTS[tier];
  const tot = w.theory + w.practical + w.robustness || 1;
  return Math.round(
    ((w.theory * move.theoreticalScore + w.practical * move.practicalScore + w.robustness * robustness01) / tot) * 100,
  );
}

function playUci(fen: string, uci: string): string | null {
  try {
    const stdUci = normalizeCastleUci(fen, uci);
    const c = new Chess(fen);
    const m = c.move({
      from: stdUci.slice(0, 2) as Square,
      to: stdUci.slice(2, 4) as Square,
      promotion: stdUci.length > 4 ? stdUci[4] : undefined,
    });
    return m ? c.fen() : null;
  } catch {
    return null;
  }
}

/** Defaults for the run envelope (per-reply analysis params stay inline). */
export const DEFAULT_NETWORK_CONCURRENCY = 4;
const MAX_REPORT_ISSUES = 8;

interface PlannedCandidate {
  cand: { uci: string; san: string };
  candFen: string;
}

interface PickedReply {
  m: LichessMove;
  games: number;
  share: number;
  replyFen: string | null;
}

interface ReplyJob {
  cand: { uci: string; san: string };
  m: LichessMove;
  games: number;
  share: number;
  replyFen: string | null;
  stats: { ourBestSan: string; ourGames: number; ourStat: number; ourPosTotal: number } | null;
  statsAvailable: boolean;
  ourCp: number | null;
  ourMate: number | undefined;
  engineAvailable: boolean;
}

export async function analyzeBranchRobustnessReport(
  currentFen: string,
  candidates: { uci: string; san: string }[],
  opts: RobustnessOptions,
): Promise<RobustnessReport> {
  const t0 = Date.now();
  const depth = opts.depth ?? 12;
  const maxReplies = opts.maxReplies ?? 3;
  const minShare = opts.minShare ?? 0.07;
  const timeoutMs = opts.timeoutMs ?? 9000;
  const networkConcurrency = opts.networkConcurrency ?? DEFAULT_NETWORK_CONCURRENCY;
  const weights = TIER_WEIGHTS[opts.eloTier];
  const shrinkK = DEFAULT_RANKING_CONFIG.shrinkK;
  const reliabilityK = DEFAULT_RANKING_CONFIG.reliabilityK;
  const blendBase = DEFAULT_RANKING_CONFIG.positionBlendBase;
  const blendSlope = DEFAULT_RANKING_CONFIG.positionBlendSlope;

  const session = opts.session ?? createRobustnessSession();
  const ctrl = new AbortController();
  activeRun = {
    session,
    abortNetwork: () => ctrl.abort(),
  };

  // Per-run FEN cache: dedupes in-flight + repeated Lichess requests
  // (transpositions across candidates share positions). Failures are NOT
  // cached — a retry within the run refetches.
  const fenCache = new Map<string, Promise<LichessApiResponse>>();
  const fetchCached = (fen: string): Promise<LichessApiResponse> => {
    const key = `${opts.endpoint}:${opts.ratingsParam ?? ''}:${opts.since ?? ''}:${fen}`;
    const existing = fenCache.get(key);
    if (existing) return existing;
    const p = fetchLichessMoves(fen, undefined, opts.endpoint, opts.ratingsParam, undefined, {
      signal: ctrl.signal,
      since: opts.since,
    }).then(
      (v) => v,
      (err: unknown) => {
        fenCache.delete(key);
        throw err;
      },
    );
    fenCache.set(key, p);
    return p;
  };

  const results: BranchRobustness[] = [];
  const skipped: RobustnessSkipped[] = [];
  const issues: RobustnessIssue[] = [];
  let suppressedIssueCount = 0;
  let repliesAnalyzed = 0;
  const accounted = new Set<PlannedCandidate>();

  const reportIssue = (where: string, err: unknown): void => {
    if (isAbortError(err)) return;
    if (issues.length < MAX_REPORT_ISSUES) {
      issues.push({ where, message: err instanceof Error ? err.message : String(err) });
    } else {
      suppressedIssueCount++;
    }
  };

  let done = 0;
  const totalEst = candidates.length * (1 + maxReplies * 2);
  const progress = (label: string): void => {
    if (session.cancelled || ctrl.signal.aborted) return;
    try {
      opts.onProgress?.(Math.min(done, totalEst), totalEst, label);
    } catch {
      /* listener must never break the run */
    }
  };
  const cancelledNow = (): boolean => session.cancelled || ctrl.signal.aborted;

  const finish = (cancelled: boolean): RobustnessReport => ({
    results,
    requestedCandidates: candidates.length,
    analyzedCandidates: results.length,
    skipped,
    repliesAnalyzed,
    issues,
    suppressedIssueCount,
    cancelled,
    durationMs: Date.now() - t0,
  });

  // Running total of candidates already accounted for (result or skipped).
  const markRemainingCancelled = (planned: PlannedCandidate[]): void => {
    for (const p of planned) {
      if (!accounted.has(p)) {
        accounted.add(p);
        skipped.push({ san: p.cand.san, uci: p.cand.uci, reason: 'cancelled' });
      }
    }
  };

  // ---- Phase 0: resolve candidate FENs (pure, sync). ----
  const planned: PlannedCandidate[] = [];
  for (const cand of candidates) {
    if (cancelledNow()) break;
    const candFen = playUci(currentFen, cand.uci);
    if (!candFen) {
      skipped.push({ san: cand.san, uci: cand.uci, reason: 'illegal-move' });
      continue;
    }
    planned.push({ cand, candFen });
  }
  if (cancelledNow()) {
    markRemainingCancelled(planned);
    return finish(true);
  }

  // ---- Phase 1: adversary reply lists (network, bounded parallelism). ----
  const pickedPerCandidate = await mapWithConcurrency(
    planned,
    networkConcurrency,
    async ({ cand, candFen }, index): Promise<PickedReply[]> => {
      if (cancelledNow()) return [];
      try {
        const repData = await fetchCached(candFen);
        const repMoves = repData.moves || [];
        done++;
        progress(robustnessProgressReplies(cand.san));
        const repTotal = repMoves.reduce((s, m) => s + m.white + m.draws + m.black, 0);
        if (repTotal <= 0) {
          accounted.add(planned[index]);
          skipped.push({ san: cand.san, uci: cand.uci, reason: 'no-adversary-data' });
          return [];
        }
        let picked = repMoves
          .map((m) => ({ m, games: m.white + m.draws + m.black }))
          .filter((x) => x.games / repTotal >= minShare)
          .slice(0, maxReplies);
        if (picked.length === 0) {
          picked = repMoves
            .slice(0, Math.min(2, repMoves.length))
            .map((m) => ({ m, games: m.white + m.draws + m.black }));
        }
        return picked.map(({ m, games }) => ({
          m,
          games,
          share: games / repTotal,
          replyFen: playUci(candFen, m.uci),
        }));
      } catch (err) {
        if (cancelledNow() || isAbortError(err)) return [];
        reportIssue(cand.san, err);
        accounted.add(planned[index]);
        skipped.push({ san: cand.san, uci: cand.uci, reason: 'candidate-stats-unavailable' });
        done++;
        progress(robustnessProgressReplies(cand.san));
        return [];
      }
    },
  );
  if (cancelledNow()) {
    markRemainingCancelled(planned);
    return finish(true);
  }

  // ---- Phase 2: our stats after each reply (network, bounded parallelism). ----
  const jobs: ReplyJob[] = [];
  pickedPerCandidate.forEach((replies, i) => {
    const { cand } = planned[i];
    for (const r of replies) {
      jobs.push({
        cand,
        m: r.m,
        games: r.games,
        share: r.share,
        replyFen: r.replyFen,
        stats: null,
        statsAvailable: false,
        ourCp: null,
        ourMate: undefined,
        engineAvailable: false,
      });
    }
  });

  await mapWithConcurrency(jobs, networkConcurrency, async (job): Promise<void> => {
    if (cancelledNow() || !job.replyFen) return;
    try {
      const ourData = await fetchCached(job.replyFen);
      const ours = ourData.moves || [];
      const ourPosTotal = ours.reduce((s, o) => s + o.white + o.draws + o.black, 0);
      // Same player-strength correction as the ranking (audit A11):
      // best reply judged at reference level, not by its clientele.
      const replyPosRating = positionRatingMean(
        ours.map((o) => ({
          games: o.white + o.draws + o.black,
          averageRating: o.averageRating,
        })),
      );
      let bestS = -1;
      let ourBestSan = '—';
      let ourGames = 0;
      let ourStat = 0.5;
      for (const o of ours) {
        const g = o.white + o.draws + o.black;
        if (g <= 0) continue;
        const w = opts.playerColor === 'white' ? o.white : o.black;
        const rate = (w + 0.5 * o.draws) / g;
        const adjRate = ratingAdjustedRate(rate, o.averageRating, replyPosRating);
        const s = (adjRate * g + 0.5 * shrinkK) / (g + shrinkK);
        if (s > bestS) {
          bestS = s;
          ourBestSan = o.san;
          ourGames = g;
          ourStat = s;
        }
      }
      job.stats = { ourBestSan, ourGames, ourStat, ourPosTotal };
      job.statsAvailable = true;
    } catch (err) {
      if (!cancelledNow() && !isAbortError(err)) {
        reportIssue(`${job.cand.san} … ${job.m.san}`, err);
      }
    } finally {
      done++;
      progress(robustnessProgressOurs(job.cand.san, job.m.san));
    }
  });
  if (cancelledNow()) {
    markRemainingCancelled(planned);
    return finish(true);
  }

  // ---- Phase 3: local engine per reply (SEQUENTIAL — singleton worker). ----
  // Concurrent analyzeLocalFen calls would stomp each other through
  // analysisSeq (each new call stops the previous search), so no parallelism
  // here by design. The trait is back to US (our move + their reply), so
  // Stockfish already speaks from our perspective: NO sign flip (flipping
  // gave absurd −1.0s and flat 50/50 robustness).
  const jobsByCandidate = new Map<PlannedCandidate, ReplyJob[]>();
  {
    let k = 0;
    for (let i = 0; i < planned.length; i++) {
      const group: ReplyJob[] = [];
      for (let j = 0; j < pickedPerCandidate[i].length; j++) {
        group.push(jobs[k++]);
      }
      jobsByCandidate.set(planned[i], group);
    }
  }

  for (const p of planned) {
    if (accounted.has(p)) continue; // already skipped in an earlier phase
    if (cancelledNow()) {
      markRemainingCancelled(planned);
      return finish(true);
    }
    const group = jobsByCandidate.get(p) ?? [];
    const analyses: ReplyAnalysis[] = [];
    for (const job of group) {
      if (cancelledNow()) break;
      if (job.replyFen) {
        try {
          const ev = await analyzeLocalFen(job.replyFen, { multiPv: 1, depth, timeoutMs });
          const first = ev[0];
          if (first) {
            if (typeof first.mate === 'number') job.ourMate = first.mate;
            else if (typeof first.cp === 'number') job.ourCp = first.cp;
            job.engineAvailable = true;
          }
        } catch (err) {
          // Supplanté par une analyse interactive : on dégrade en silence
          // (score stats seules), sans faux incident "moteur indisponible".
          if (!cancelledNow() && !isAbortError(err) && !isSuperseded(err)) {
            reportIssue(`${job.cand.san} … ${job.m.san} (moteur)`, err);
          }
        }
      }
      done++;
      progress(robustnessProgressEngine(job.cand.san, job.m.san));

      const stats = job.stats;
      const hasEng = job.ourCp !== null || job.ourMate !== undefined;
      const hasStats = stats !== null && stats.ourGames > 0;
      const engOutcome = cpToOutcome(job.ourCp, job.ourMate);
      let wE = weights.engine;
      let wP = weights.practical;
      if (!hasEng) {
        wE = 0;
      } else if (!hasStats) {
        wP = 0;
      } else {
        const ourPosTotal = (stats as NonNullable<typeof stats>).ourPosTotal;
        const R = ourPosTotal / (ourPosTotal + reliabilityK);
        const pW = wP * (blendBase + blendSlope * R);
        wE = wE + (wP - pW);
        wP = pW;
      }
      const tot = wE + wP || 1;
      const ourStat = stats?.ourStat ?? 0.5;
      analyses.push({
        replyUci: job.m.uci,
        replySan: job.m.san,
        sharePct: job.share * 100,
        games: job.games,
        ourBestSan: stats?.ourBestSan ?? '—',
        ourGames: stats?.ourGames ?? 0,
        ourCp: job.ourCp,
        ourMate: job.ourMate,
        ourOutcomeEngine: engOutcome,
        ourOutcomeStats: ourStat,
        replyScore: (wE * engOutcome + wP * ourStat) / tot,
        statsAvailable: job.statsAvailable,
        engineAvailable: job.engineAvailable,
      });
    }
    if (cancelledNow()) {
      markRemainingCancelled(planned);
      return finish(true);
    }
    if (analyses.length === 0) {
      accounted.add(p);
      skipped.push({ san: p.cand.san, uci: p.cand.uci, reason: 'no-analyzable-reply' });
      continue;
    }
    const combined = combineRobustness(
      analyses.map((a) => ({ weight: a.games, score: a.replyScore })),
    );
    results.push({
      candidateUci: p.cand.uci,
      candidateSan: p.cand.san,
      replies: analyses,
      coveragePct: analyses.reduce((s, a) => s + a.sharePct, 0),
      weightedAvg: combined.avg,
      worst: combined.worst,
      worstShare: combined.worstShare,
      shortfall: combined.shortfall,
      robustness: combined.robustness,
      danger: combined.danger,
    });
    accounted.add(p);
    repliesAnalyzed += analyses.length;
  }

  return finish(cancelledNow());
}

/**
 * Legacy entry point (results only). Prefer `analyzeBranchRobustnessReport`
 * for error/coverage metadata.
 */
export async function analyzeBranchRobustness(
  currentFen: string,
  candidates: { uci: string; san: string }[],
  opts: RobustnessOptions,
): Promise<BranchRobustness[]> {
  return (await analyzeBranchRobustnessReport(currentFen, candidates, opts)).results;
}
