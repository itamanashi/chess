import type { EloTier } from './repertoireScore';

/**
 * Hyperparamètres du classement des coups — SINGLE SOURCE OF TRUTH.
 *
 * Avant : constantes magiques dispersées dans `rankRepertoireMoves`
 * (RELIABILITY_K, SHRINK_K, seuils 5000/16, 500/12…). Maintenant : un seul
 * objet documenté, injectable (`computeScores(input, config)`) pour tester
 * la sensibilité du ranking sans toucher au code.
 */

export interface TierWeights {
  engine: number;
  practical: number;
  /**
   * Funds the opponent-error edge (audit A5): observed replies beating
   * theory. Deliberately NOT a mainline bonus (audit A3) — scoring
   * popularity rewards the line the adversary knows best.
   */
  frequency: number;
}

/** Absolute game-count floors, per explorer endpoint (audit A6). */
export interface EndpointSampleThresholds {
  high: number;
  medium: number;
  /** Below this many games → low-sample warning (unless relatively dominant). */
  lowSample: number;
}

export interface ConfidenceThresholds {
  highMinDepth: number;
  mediumMinDepth: number;
  /** Engine-only move (no stats) reaching this depth. */
  mediumEngineOnlyMinDepth: number;
  /** Below this depth → shallow-engine warning. */
  shallowMaxDepth: number;
  /**
   * Absolute floors per endpoint. Masters games are ~2 orders of magnitude
   * scarcer than Lichess community games: the same absolute bar cannot
   * serve both (a ply-10 masters move rarely passes a few hundred games).
   * Lichess values preserve the historical behavior exactly.
   */
  byEndpoint: Record<'masters' | 'lichess', EndpointSampleThresholds>;
  /** Endpoint assumed when the caller provides none (historical default). */
  defaultEndpoint: 'masters' | 'lichess';
  /**
   * Relative evidence (endpoint-agnostic): a move dominating its position
   * is informative even with modest absolute counts — e.g. 60% of 400
   * masters games at ply 12. Both the share AND the position volume must
   * clear their floors.
   */
  highMinShare: number;
  highMinPositionGames: number;
  mediumMinShare: number;
  mediumMinPositionGames: number;
}

export interface RankingConfig {
  /**
   * Sample size at which reliability hits 50% (games / (games + K)).
   * K = 300: with an explorer filtered on two Elo bands, ~300 games already
   * covers a mid-repertoire position (audit A1 — 2000 matched ply 4-6 only).
   */
  reliabilityK: number;
  /**
   * Bayesian shrinkage of the score rate toward 50% (avoids 3/3 = 100%).
   * K = 60 (audit A2): a 3/3 still shrinks to 0.524 (guard holds), while
   * 300 games keep ~83% of a 65% signal (vs 43% at K = 400, which buried
   * the practical component exactly where traps live).
   */
  shrinkK: number;
  /** Engine-gap softening scale: engineScore = 1 / (1 + cpLoss / scale). */
  engineCpScale: number;
  /** Practice-weight scaling by position reliability: wP * (base + slope * rel). */
  positionBlendBase: number;
  positionBlendSlope: number;
  /**
   * Cap on the reliability transfer INTO the engine weight, as a multiple
   * of the tier's base engine weight (audit A1). Without it, wE absorbs
   * everything practice loses (wE + wP constant) and the tier table only
   * holds at infinite sample — the app would be Stockfish dressing.
   */
  engineTransferCapMultiplier: number;
  /** Per-tier base weights (engine / practical / frequency). */
  tierWeights: Record<EloTier, TierWeights>;
  confidence: ConfidenceThresholds;
  /** Output scale of finalScore (0..scale). */
  finalScoreScale: number;
}

export const DEFAULT_RANKING_CONFIG: RankingConfig = {
  reliabilityK: 300,
  shrinkK: 60,
  engineCpScale: 100,
  positionBlendBase: 0.3,
  positionBlendSlope: 0.7,
  engineTransferCapMultiplier: 1.3,
  tierWeights: {
    low: { engine: 0.25, practical: 0.6, frequency: 0.1 },
    mid: { engine: 0.4, practical: 0.45, frequency: 0.1 },
    high: { engine: 0.55, practical: 0.3, frequency: 0.1 },
  },
  confidence: {
    highMinDepth: 16,
    mediumMinDepth: 12,
    mediumEngineOnlyMinDepth: 16,
    shallowMaxDepth: 12,
    byEndpoint: {
      lichess: { high: 5000, medium: 500, lowSample: 100 },
      masters: { high: 300, medium: 60, lowSample: 10 },
    },
    defaultEndpoint: 'lichess',
    highMinShare: 0.5,
    highMinPositionGames: 300,
    mediumMinShare: 0.25,
    mediumMinPositionGames: 100,
  },
  finalScoreScale: 100,
};
