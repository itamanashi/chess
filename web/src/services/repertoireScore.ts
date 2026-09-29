import type { EngineMove, LichessMove, EloTargetKey } from '../types/chess';
import { normalizeCastleUci } from '../utils/repertoire';
import { analyzeTrajectory, type StabilityReport } from './evalStability';
import { cpToOutcome } from '../utils/engineAdvantage';
import {
  WARNING_ENGINE_ONLY_CHOICE,
  WARNING_NO_ENGINE_COVERAGE,
  formatInt,
  justificationDefault,
  justificationEngineOnly,
  justificationPreferred,
  justificationUnanimous,
  statBit,
  tierNote,
  warningLowSample,
  warningShallowDepth,
} from '../i18n';
import { DEFAULT_RANKING_CONFIG, type RankingConfig, type TierWeights } from './rankingConfig';

export type { TierWeights };

/**
 * "Best repertoire move" decision per Elo band.
 *
 * Does NOT blindly pick Stockfish's first move: the final score combines
 * engine strength, practical results (score rate adjusted for WHO plays
 * the line — audit A11) and the opponent-error edge (do observed replies
 * underperform theory?). Popularity for OUR move
 * is deliberately NOT scored — the most-played move is the one the
 * adversary knows best — and survives only as a sort tiebreak.
 * Adaptive weights:
 *  - small sample  -> engine weighs more, practice is neutralized;
 *  - large sample  -> practical results weigh heavily;
 *  - low Elo       -> favor what works in practice;
 *  - high Elo      -> favor theoretical accuracy.
 *
 * Pipeline (each stage independently testable):
 *   1. `computeScores()` — pure numbers, NO generated text;
 *   2. `classifyConfidence()` — codes only ('high' | 'medium' | 'low');
 *   3. `buildHumanJustification()` — French wording via `i18n/fr.ts`;
 *   4. `rankRepertoireMoves()` — orchestration: compute → classify → sort → justify.
 *
 * Hyperparameters live in `rankingConfig.ts` (injectable for tests).
 */

export type EloTier = 'low' | 'mid' | 'high';

export type ConfidenceLevel = 'high' | 'medium' | 'low';

/** Tier base weights (re-exported for historical importers). */
export const TIER_WEIGHTS: Record<EloTier, TierWeights> = DEFAULT_RANKING_CONFIG.tierWeights;

/** UI Elo band -> weighting tier (labels live in `i18n/fr.ts`: TIER_LABELS). */
export function eloTierForTarget(key: EloTargetKey): EloTier {
  switch (key) {
    case 'beginner':
    case 'beginner_club':
    case 'all_700':
    case 'club_low':
      return 'low';
    case 'club_mid':
      return 'mid';
    case 'club_high':
    case 'masters':
      return 'high';
    default:
      return 'mid';
  }
}

/**
 * Pure computation result: every numeric/source field, NO generated text
 * (no justification, no warnings, no confidence). Safe to snapshot in tests.
 */
export interface MoveScores {
  uci: string; // Standard UCI (castles converted)
  san: string;
  // Engine (side-to-move perspective = your side here)
  engineCp?: number;
  engineMate?: number;
  depth: number;
  scoreFormatted: string;
  pvSans: string[];
  isEngineBest: boolean;
  // Practical stats (your-side perspective)
  games: number;
  wins: number;
  draws: number;
  losses: number;
  winPct: number;
  drawPct: number;
  lossPct: number;
  scoreRate: number; // raw observed score rate 0..1 (displayed as-is)
  adjustedScoreRate: number; // 0..1 after rating adjustment (audit A11)
  practicalScore: number; // 0..1 after rating adjustment + Bayesian shrinkage
  engineScore: number; // 0..1 (final eval vs best eval)
  theoreticalScore: number; // 0..1 = engineScore + bounded stability adjustment
  stability?: StabilityReport; // D1..Dmax trajectory (local engine only)
  /**
   * Per-move reliability 0..1 from sample size (audit B11: computed but
   * currently unused; position-level `positionReliability` is used instead
   * for weight adjustment). Kept for potential future per-move weighting.
   */
  reliability: number;
  frequencyShare: number; // 0..1 share of the position's games
  /**
   * Opponent-error edge: E[our score after replies] − P(engine).
   * Positive = adversaries underperform theory = trap profit.
   * `null` = unknown (no reply data or no engine eval).
   */
  opponentEdge: number | null;
  finalScore: number; // 0..100
  openingName?: string;
  eco?: string;
  hasEngine: boolean;
  hasStats: boolean;
  statsMove?: LichessMove;
}

/**
 * UI-ready row: pure scores + presentation (confidence code, French
 * justification/warnings). Same object shape as before — consumers unchanged.
 */
export interface ScoredMove extends MoveScores {
  confidence: ConfidenceLevel;
  justification: string;
  warnings: string[];
}

export interface RankInput {
  fen: string;
  /** 'white' | 'black': your side (it's your move). */
  playerColor: 'white' | 'black';
  eloTier: EloTier;
  engine: EngineMove[];
  stats: LichessMove[];
  /**
   * Adversary replies per OUR normalized UCI (audit A5): feeds the
   * opponent-error edge. Absent → edge stays null (neutral 0.5 in scoring,
   * historical behavior preserved exactly).
   */
  replyStats?: Record<string, LichessMove[]>;
  /**
   * Explorer endpoint behind `stats` (audit A6): calibrates confidence
   * evidence (masters games are ~100x scarcer). Absent → lichess scale
   * (historical behavior preserved exactly).
   */
  endpoint?: 'masters' | 'lichess';
}

/** Comparable numeric value (side-to-move perspective), mates dominate. */
function evalValue(cp?: number, mate?: number): number | null {
  if (typeof mate === 'number') return mate > 0 ? 100000 - mate : -100000 - mate;
  if (typeof cp === 'number') return cp;
  return null;
}

/**
 * Resolves effective weights for a position (pure, unit-tested).
 *
 * Position-level adaptive weights: high global sample -> practice dominates;
 * low sample -> practice shrinks toward caution. Crucially, what practice
 * loses is NOT transferred to the engine beyond `engineTransferCapMultiplier`
 * (audit A1): uncapped transfer made wE + wP constant and the tier table
 * decorative below thousands of games.
 */
export function resolveWeights(
  base: TierWeights,
  totalGames: number,
  hasEngine: boolean,
  config: RankingConfig = DEFAULT_RANKING_CONFIG,
): TierWeights {
  if (!hasEngine) return { engine: 0, practical: base.practical, frequency: base.frequency };
  const positionReliability = totalGames / (totalGames + config.reliabilityK);
  const wP = base.practical * (config.positionBlendBase + config.positionBlendSlope * positionReliability);
  const wE = Math.min(
    base.engine * config.engineTransferCapMultiplier,
    base.engine + (base.practical - wP),
  );
  return { engine: wE, practical: wP, frequency: base.frequency };
}

function blankScores(seed: {
  uci: string;
  san: string;
  openingName?: string;
  eco?: string;
  hasEngine: boolean;
  hasStats: boolean;
  statsMove?: LichessMove;
  engineCp?: number;
  engineMate?: number;
  depth?: number;
  scoreFormatted?: string;
  pvSans?: string[];
}): MoveScores {
  return {
    uci: seed.uci,
    san: seed.san,
    engineCp: seed.engineCp,
    engineMate: seed.engineMate,
    depth: seed.depth ?? 0,
    scoreFormatted: seed.scoreFormatted ?? '—',
    pvSans: seed.pvSans ?? [],
    isEngineBest: false,
    games: 0,
    wins: 0,
    draws: 0,
    losses: 0,
    winPct: 0,
    drawPct: 0,
    lossPct: 0,
    scoreRate: 0.5,
    adjustedScoreRate: 0.5,
    practicalScore: 0.5,
    engineScore: 0.5,
    theoreticalScore: 0,
    reliability: 0,
    frequencyShare: 0,
    opponentEdge: null,
    finalScore: 0,
    openingName: seed.openingName,
    eco: seed.eco,
    hasEngine: seed.hasEngine,
    hasStats: seed.hasStats,
    statsMove: seed.statsMove,
  };
}

/**
 * Opponent-error edge (audit A5): do adversaries score worse than theory
 * predicts after this move? E = Σ p(reply) × shrunkScoreRate(replyFen),
 * edge = E − P(engineEval). Positive = we profit from their errors.
 * Per-reply shrinkage reuses the ranking doctrine (tiny samples lie).
 * `null` when unknown (no engine eval or no reply games).
 * Pure and unit-tested.
 */
export function computeOpponentEdge(args: {
  replies: LichessMove[] | null | undefined;
  playerColor: 'white' | 'black';
  engineCp?: number;
  engineMate?: number;
  shrinkK?: number;
}): number | null {
  const { replies, playerColor } = args;
  if (!replies || replies.length === 0) return null;
  if (args.engineCp === undefined && args.engineMate === undefined) return null;
  const shrinkK = args.shrinkK ?? DEFAULT_RANKING_CONFIG.shrinkK;
  let total = 0;
  let expected = 0;
  for (const m of replies) {
    const games = m.white + m.draws + m.black;
    if (games <= 0) continue;
    const myWins = playerColor === 'white' ? m.white : m.black;
    const rate = (myWins + 0.5 * m.draws) / games;
    expected += games * ((rate * games + 0.5 * shrinkK) / (games + shrinkK));
    total += games;
  }
  if (total <= 0) return null;
  return expected / total - cpToOutcome(args.engineCp ?? null, args.engineMate);
}

/**
 * Mean player level of a position, games-weighted over rated moves
 * (audit A11). `null` when no move carries a rating — callers then skip
 * the correction (backward compatible: unrated data scores as before).
 */
export function positionRatingMean(
  moves: { games: number; averageRating?: number }[],
): number | null {
  let total = 0;
  let weighted = 0;
  for (const m of moves) {
    if (typeof m.averageRating !== 'number' || !Number.isFinite(m.averageRating)) continue;
    if (m.games <= 0) continue;
    total += m.games;
    weighted += m.games * m.averageRating;
  }
  if (total <= 0) return null;
  return weighted / total;
}

/**
 * Removes the player-strength confound from a raw score rate (audit A11).
 * Within one Elo band, a line played by the top of the band looks better
 * than it is: `adjusted = raw − (EloExpected(gap) − 0.5)` with the standard
 * 400-Elo logistic (shared with `cpToOutcome`), clamped to [0, 1].
 * Identity when ratings are missing — traps "popular among the weak" stop
 * being systematically underrated, rated data keeps working as before.
 * Pure and unit-tested.
 */
export function ratingAdjustedRate(
  rawRate: number,
  moveAverageRating: number | undefined,
  positionAverageRating: number | null,
): number {
  if (moveAverageRating === undefined || positionAverageRating === null) return rawRate;
  if (!Number.isFinite(moveAverageRating) || !Number.isFinite(positionAverageRating)) return rawRate;
  const gap = moveAverageRating - positionAverageRating;
  const adjusted = rawRate - (cpToOutcome(gap) - 0.5);
  return Math.max(0, Math.min(1, adjusted));
}

/**
 * Stage 1 — pure scoring. No text generation, no sorting, no confidence.
 * Deterministic: same input + config → same output.
 */
export function computeScores(
  input: RankInput,
  config: RankingConfig = DEFAULT_RANKING_CONFIG,
): MoveScores[] {
  const { fen, playerColor, eloTier, engine, stats } = input;
  const weights = config.tierWeights[eloTier];
  const totalGames = stats.reduce((s, m) => s + m.white + m.draws + m.black, 0);
  // Reference player level once per position (audit A11): unrated data
  // yields null and every row below behaves exactly as before.
  const positionRating = positionRatingMean(
    stats.map((m) => ({ games: m.white + m.draws + m.black, averageRating: m.averageRating })),
  );

  // Engine index by standard UCI.
  const engineByUci = new Map<string, EngineMove>();
  for (const e of engine) engineByUci.set(e.uci, e);
  let bestValue: number | null = null;
  for (const e of engine) {
    const v = evalValue(e.cp, e.mate);
    if (v !== null && (bestValue === null || v > bestValue)) bestValue = v;
  }
  // Every tie at the best value is flagged (not just the first).
  const isBestValue = (cp?: number, mate?: number): boolean =>
    bestValue !== null && evalValue(cp, mate) === bestValue;

  const engineScoreOf = (cp?: number, mate?: number): number => {
    if (bestValue === null) return 0.5;
    const v = evalValue(cp, mate);
    if (v === null) return 0.5;
    // Softened engine gap: −0.15 must not bury a move (100 scale).
    const cpLoss = Math.max(0, bestValue - v);
    return 1 / (1 + cpLoss / config.engineCpScale);
  };

  const rows: MoveScores[] = [];
  const seen = new Set<string>();

  for (const m of stats) {
    const stdUci = normalizeCastleUci(fen, m.uci);
    if (seen.has(stdUci)) continue;
    seen.add(stdUci);
    const games = m.white + m.draws + m.black;
    const myWins = playerColor === 'white' ? m.white : m.black;
    const myLosses = playerColor === 'white' ? m.black : m.white;
    const eng = engineByUci.get(stdUci);
    const row = blankScores({
      uci: stdUci,
      san: m.san,
      openingName: m.opening?.name,
      eco: m.opening?.eco,
      hasEngine: !!eng,
      hasStats: games > 0,
      statsMove: m,
      engineCp: eng?.cp,
      engineMate: eng?.mate,
      depth: eng?.depth,
      scoreFormatted: eng?.scoreFormatted,
      pvSans: eng?.pvSans,
    });
    row.isEngineBest = isBestValue(eng?.cp, eng?.mate);
    row.games = games;
    row.wins = myWins;
    row.draws = m.draws;
    row.losses = myLosses;
    row.winPct = games > 0 ? (myWins / games) * 100 : 0;
    row.drawPct = games > 0 ? (m.draws / games) * 100 : 0;
    row.lossPct = games > 0 ? (myLosses / games) * 100 : 0;
    row.scoreRate = games > 0 ? (myWins + 0.5 * m.draws) / games : 0.5;
    row.adjustedScoreRate = ratingAdjustedRate(row.scoreRate, m.averageRating, positionRating);
    row.practicalScore =
      (row.adjustedScoreRate * games + 0.5 * config.shrinkK) / (games + config.shrinkK);
    row.reliability = games / (games + config.reliabilityK);
    row.frequencyShare = totalGames > 0 ? games / totalGames : 0;
    // 0.5 below is a placeholder; uncovered rows are imputed just after
    // the engine-only loop (audit A4).
    row.engineScore = eng ? engineScoreOf(eng.cp, eng.mate) : 0.5;
    row.opponentEdge = computeOpponentEdge({
      replies: input.replyStats?.[stdUci],
      playerColor,
      engineCp: eng?.cp,
      engineMate: eng?.mate,
      shrinkK: config.shrinkK,
    });
    rows.push(row);
  }

  // Engine-only moves (never played at this Elo).
  for (const e of engine) {
    if (seen.has(e.uci)) continue;
    seen.add(e.uci);
    const row = blankScores({
      uci: e.uci,
      san: e.san,
      hasEngine: true,
      hasStats: false,
      engineCp: e.cp,
      engineMate: e.mate,
      depth: e.depth,
      scoreFormatted: e.scoreFormatted,
      pvSans: e.pvSans,
    });
    row.isEngineBest = isBestValue(e.cp, e.mate);
    row.engineScore = engineScoreOf(e.cp, e.mate);
    row.opponentEdge = computeOpponentEdge({
      replies: input.replyStats?.[e.uci],
      playerColor,
      engineCp: e.cp,
      engineMate: e.mate,
      shrinkK: config.shrinkK,
    });
    rows.push(row);
  }

  // Impute uncovered moves with the worst ANALYZED score (audit A4).
  // The old 0.5 default equals cpLoss = 100, so any move beyond MultiPV
  // outscored an analyzed -150cp move (0.4) for free — rewarding escape
  // from analysis. Imputation assumes unobserved = as bad as worst
  // observed (conservative). With no engine at all, 0.5 stays as the
  // neutral no-information value.
  const analyzedScores = rows.filter((r) => r.hasEngine).map((r) => r.engineScore);
  const fallbackEngineScore =
    analyzedScores.length > 0 ? Math.min(...analyzedScores) : 0.5;
  for (const r of rows) {
    if (!r.hasEngine) r.engineScore = fallbackEngineScore;
  }

  const hasAnyEngine = engine.length > 0;

  // Effective weights, resolved ONCE per position (same for every move).
  // NOTE (audits A3+A5): the `frequency` tier weight is NOT a mainline
  // bonus anymore — it funds the opponent-error edge (theory vs observed
  // replies). Popularity for OUR move survives only as a sort tiebreak.
  const { engine: wE, practical: wP, frequency: wFreq } = resolveWeights(
    weights,
    totalGames,
    hasAnyEngine,
    config,
  );

  for (const r of rows) {
    // Small PER-MOVE samples are neutralized by the Bayesian shrinkage of
    // the score rate (otherwise a 3/3 at 100% + good engine score would
    // wrongly win, cf. the g4 trap).
    // Theory score: final eval + stability (bounded [-0.15, +0.05] via
    // STABILITY_ADJUST: only flips engine gaps < ~25 cp).
    const engMove = engineByUci.get(r.uci);
    const stab = engMove?.trajectory ? analyzeTrajectory(engMove.trajectory) : null;
    r.stability = stab ?? undefined;
    r.theoreticalScore = Math.max(0, Math.min(1, r.engineScore + (stab?.adjustment ?? 0)));
  }

  // The edge term only joins when at least one row actually has reply data;
  // otherwise the neutral 0.5 keeps historical scores bit-identical.
  const useEdge = rows.some((r) => r.opponentEdge !== null);
  const wEdge = useEdge ? wFreq : 0;
  const total = wE + wP + wEdge || 1;
  for (const r of rows) {
    const edge01 = r.opponentEdge === null ? 0.5 : Math.max(0, Math.min(1, 0.5 + r.opponentEdge / 2));
    r.finalScore = Math.round(
      ((wE * r.theoreticalScore + wP * r.practicalScore + wEdge * edge01) / total) *
        config.finalScoreScale,
    );
  }

  return rows;
}

/**
 * Evidence available beyond the row itself: position volume + explorer
 * endpoint. Absent → historical absolute behavior (lichess scale).
 */
export interface SampleContext {
  totalGames: number;
  endpoint?: 'masters' | 'lichess';
}

function endpointThresholds(
  config: RankingConfig,
  endpoint: 'masters' | 'lichess' | undefined,
): { high: number; medium: number; lowSample: number } {
  return config.confidence.byEndpoint[endpoint ?? config.confidence.defaultEndpoint];
}

/**
 * Stage 2 — confidence classification. Pure function of (games, depth,
 * coverage, sample) + config thresholds. Codes only.
 *
 * Two evidence channels (audit A6): absolute game counts, normalized per
 * endpoint (masters games are ~100x scarcer), OR relative dominance of a
 * well-sampled position (share + volume). Either channel suffices.
 */
export function classifyConfidence(
  row: Pick<MoveScores, 'games' | 'depth' | 'hasEngine' | 'hasStats'>,
  config: RankingConfig = DEFAULT_RANKING_CONFIG,
  sample?: SampleContext,
): ConfidenceLevel {
  const c = config.confidence;
  const t = endpointThresholds(config, sample?.endpoint);
  const total = sample?.totalGames ?? 0;
  const share = total > 0 ? row.games / total : 0;
  const dominates = (minShare: number, minPosition: number): boolean =>
    total > 0 && share >= minShare && total >= minPosition;
  const highSample =
    row.games >= t.high || dominates(c.highMinShare, c.highMinPositionGames);
  if (highSample && row.depth >= c.highMinDepth) return 'high';
  const mediumSample =
    row.games >= t.medium || dominates(c.mediumMinShare, c.mediumMinPositionGames);
  if (
    (mediumSample && row.depth >= c.mediumMinDepth) ||
    (row.hasEngine && !row.hasStats && row.depth >= c.mediumEngineOnlyMinDepth)
  ) {
    return 'medium';
  }
  return 'low';
}

export interface JustificationContext {
  isWinner: boolean;
  engineBest: { san: string; scoreFormatted: string; engineCp?: number; practicalScore: number } | null;
  tier: EloTier;
  /** Position evidence for the sample warning (absent → absolute rule). */
  sample?: SampleContext;
}

/**
 * Stage 3 — human-facing text. The ONLY stage producing French (via `i18n`).
 * Takes pure scores in, returns { justification, warnings }.
 */
export function buildHumanJustification(
  row: MoveScores,
  ctx: JustificationContext,
  config: RankingConfig = DEFAULT_RANKING_CONFIG,
): { justification: string; warnings: string[] } {
  const warnings: string[] = [];
  if (row.hasEngine && !row.hasStats) warnings.push(WARNING_ENGINE_ONLY_CHOICE);
  // Thin-evidence warning (audit A6): absolute per-endpoint floor, waived
  // when the move dominates its position (relatively well-evidenced).
  // Without sample context, falls back to the absolute rule.
  const warnThresholds = endpointThresholds(config, ctx.sample?.endpoint);
  const sampleTotal = ctx.sample?.totalGames ?? 0;
  const sampleShare = sampleTotal > 0 ? row.games / sampleTotal : 0;
  const relativelySolid =
    sampleTotal > 0 && sampleShare >= config.confidence.mediumMinShare;
  if (row.hasStats && row.games < warnThresholds.lowSample && !relativelySolid) {
    warnings.push(warningLowSample(row.games));
  }
  if (row.hasEngine && row.depth > 0 && row.depth < config.confidence.shallowMaxDepth) {
    warnings.push(warningShallowDepth(row.depth));
  }
  if (!row.hasEngine && row.hasStats) warnings.push(WARNING_NO_ENGINE_COVERAGE);

  const parts: string[] = [];
  if (!row.hasStats && row.hasEngine) {
    parts.push(justificationEngineOnly(row.scoreFormatted, row.depth));
    return { justification: parts.join(' '), warnings };
  }

  const bit = statBit(row.games, row.winPct.toFixed(1), row.drawPct.toFixed(1));
  if (ctx.engineBest && ctx.isWinner) {
    // Practice preferred over the engine (audit B7): verify the winner
    // actually has better practicalScore, not just frequency bonus or that
    // the engine move lacks stats. Text must reflect reality.
    const hasBetterPractical = row.practicalScore > ctx.engineBest.practicalScore;
    const loss =
      row.engineCp !== undefined && ctx.engineBest.engineCp !== undefined
        ? ((ctx.engineBest.engineCp - row.engineCp) / 100).toFixed(2)
        : null;
    if (hasBetterPractical) {
      parts.push(
        justificationPreferred({
          san: ctx.engineBest.san,
          scoreFormatted: ctx.engineBest.scoreFormatted,
          statBit: bit,
          loss,
        }),
      );
    } else {
      // Winner via frequency or opponent-error edge, not raw practical score.
      parts.push(
        justificationDefault(row.scoreFormatted, row.depth, row.winPct.toFixed(1), formatInt(row.games)),
      );
    }
    parts.push(tierNote(ctx.tier));
  } else if (ctx.isWinner && !ctx.engineBest) {
    parts.push(justificationUnanimous(row.scoreFormatted, row.depth, bit));
  } else {
    parts.push(
      justificationDefault(row.scoreFormatted, row.depth, row.winPct.toFixed(1), formatInt(row.games)),
    );
  }
  // NOTE: stability detail has its own visual line in the card
  // (RepertoireAdvisor) — not duplicated here.
  return { justification: parts.join(' '), warnings };
}

/**
 * Stage 4 — orchestration: compute → classify → sort → justify.
 * Output shape unchanged (UI consumers untouched).
 */
export function rankRepertoireMoves(
  input: RankInput,
  config: RankingConfig = DEFAULT_RANKING_CONFIG,
): ScoredMove[] {
  const computed = computeScores(input, config);
  const sample: SampleContext = {
    totalGames: computed.reduce((s, r) => s + r.games, 0),
    endpoint: input.endpoint,
  };
  const rows: ScoredMove[] = computed.map((r) => ({
    ...r,
    confidence: classifyConfidence(r, config, sample),
    justification: '',
    warnings: [],
  }));

  // Frequency demoted to tiebreak (audit A3): it may order ex-aequo rows,
  // never decide between them. `games` stays as the final deterministic key.
  rows.sort(
    (a, b) => b.finalScore - a.finalScore || b.frequencyShare - a.frequencyShare || b.games - a.games,
  );

  // Justifications (the winner knows the best engine move).
  const engBest = rows.find((r) => r.isEngineBest) ?? null;
  const winner = rows[0] ?? null;
  for (const r of rows) {
    const { justification, warnings } = buildHumanJustification(
      r,
      {
        isWinner: winner !== null && r.uci === winner.uci,
        engineBest: engBest && engBest.uci !== r.uci ? engBest : null,
        tier: input.eloTier,
        sample,
      },
      config,
    );
    r.justification = justification;
    r.warnings = warnings;
  }

  return rows;
}

/**
 * Payload d'adoption (audit B5) : les vraies stats Lichess quand elles
 * existent, mais TOUJOURS l'UCI standard du conseil (`m.uci`), jamais le
 * brut Chess960 de `statsMove` (e1h1). L'objet qui traverse la frontière
 * porte donc exactement la clé que `isAdopted` vient d'interroger —
 * adopter O-O n'est plus invisible au second passage.
 */
export function adoptPayloadForMove(m: ScoredMove): LichessMove {
  if (m.statsMove) return { ...m.statsMove, uci: m.uci };
  return { san: m.san, uci: m.uci, white: 0, draws: 0, black: 0 };
}
