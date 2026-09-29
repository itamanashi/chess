import type { EvalPoint } from '../types/chess';

/**
 * Engine-eval stability across search depths.
 *
 * Instead of keeping only the final eval, the full trajectory (D1..Dmax,
 * free during search) distinguishes:
 *  - a stable move (converging: confidence bonus),
 *  - a move to watch (still drifting),
 *  - an unstable / flipped move (+ -> -: tactically suspect).
 *
 * Theory score = engineScore (final eval) + bounded adjustment
 * (see STABILITY_ADJUST). The bound is STRUCTURAL: the max gap it can create
 * is smaller than the engineScore gap of a clear edge. In practice a reversal
 * only flips the ranking when the engine gap is small. A clearly better move
 * (e.g. +0.80 stable vs +0.35 stable) always wins.
 *
 * Layering rules:
 *  - every threshold lives in `StabilityOptions` (injectable, testable);
 *  - this module exports METRICS + verdict code + structured driver only —
 *    no sentences. The French one-liner is built by the presentation layer
 *    via `stabilitySummary()` in `i18n/fr.ts`;
 *  - `finalFormatted` / `rangeFormatted` are locale-neutral numeric formats
 *    (same status as engine `scoreFormatted`: "+0.50", "#+3"), not prose.
 */

export type StabilityVerdict = 'stable' | 'watch' | 'unstable' | 'reversal';

export type StabilityTrend = 'up' | 'down' | 'flat';

/** Structured cause for the verdict — the dictionary does the wording. */
export type StabilityDriverKind = 'mate' | 'opp-mate' | 'swing' | 'drift';

export interface StabilityReport {
  points: number;
  minDepth: number;
  maxDepth: number;
  finalFormatted: string;
  rangeFormatted: string; // "+0.50 → −0.45" (locale-neutral numbers)
  swingCp: number; // max-min amplitude (cp, mates capped)
  recentDriftCp: number; // |last − third-to-last|
  reversals: number; // sign flips (dead zone applied)
  crossedZero: boolean;
  trend: StabilityTrend;
  stability: number; // 0..1
  adjustment: number; // applied to the engine score (see STABILITY_ADJUST)
  needsDeeper: boolean; // still moving at the end -> deepen analysis
  verdict: StabilityVerdict;
  driverKind?: StabilityDriverKind;
  driverCp?: number;
}

export interface StabilityOptions {
  /** Depths below this are tactically blind — ignored (default 8). */
  minDepth: number;
  /** Minimum usable points after filtering (default 3). */
  minPoints: number;
  /** |eval| below this is neither + nor − (default 12 cp). */
  deadZoneCp: number;
  /** Mate value used for amplitude (default ±5000). */
  mateCapCp: number;
  /** Swing above this (with drift rule) → watch (default 60 cp). */
  stableSwingMaxCp: number;
  /** Recent drift above this → watch (default 40 cp). */
  watchDriftMinCp: number;
  /** Swing above this → unstable (default 150 cp). */
  unstableSwingMinCp: number;
  /** Recent drift above this → needsDeeper (default 60 cp). */
  deepenDriftMinCp: number;
  /** Crossed zero but |last| below this → needsDeeper (default 150 cp). */
  deepenNearZeroMaxCp: number;
  /** Third-vs-third mean delta for up/down trend (default 25 cp). */
  trendDeltaCp: number;
  /** stability = 1 / (1 + swing / scale) (default 120). */
  stabilitySwingScale: number;
  /** Stability multiplier on zero-crossing (default 0.5). */
  crossedZeroFactor: number;
  /** Stability cap on reversal (default 0.2). */
  reversalStabilityCap: number;
  /** Stability cap on unstable (default 0.45). */
  unstableStabilityCap: number;
}

export const DEFAULT_STABILITY_OPTIONS: StabilityOptions = {
  minDepth: 8,
  minPoints: 3,
  deadZoneCp: 12,
  mateCapCp: 5000,
  stableSwingMaxCp: 60,
  watchDriftMinCp: 40,
  unstableSwingMinCp: 150,
  deepenDriftMinCp: 60,
  deepenNearZeroMaxCp: 150,
  trendDeltaCp: 25,
  stabilitySwingScale: 120,
  crossedZeroFactor: 0.5,
  reversalStabilityCap: 0.2,
  unstableStabilityCap: 0.45,
};

export const STABILITY_ADJUST: Record<StabilityVerdict, number> = {
  stable: 0.05,
  watch: 0,
  unstable: -0.1,
  reversal: -0.15,
};

function fmtCp(cp: number): string {
  return cp > 0 ? `+${(cp / 100).toFixed(2)}` : (cp / 100).toFixed(2);
}

function fmtPoint(p: EvalPoint): string {
  if (typeof p.mate === 'number') return p.mate > 0 ? `#+${p.mate}` : `#-${Math.abs(p.mate)}`;
  if (typeof p.cp === 'number') return fmtCp(p.cp);
  return '?';
}

function signDeadZone(v: number, deadZoneCp: number): number {
  if (v > deadZoneCp) return 1;
  if (v < -deadZoneCp) return -1;
  return 0;
}

export function analyzeTrajectory(
  traj: EvalPoint[] | undefined,
  options: Partial<StabilityOptions> = {},
): StabilityReport | null {
  const o = { ...DEFAULT_STABILITY_OPTIONS, ...options };
  if (!traj) return null;
  const pts = [...traj]
    .filter((p) => p.depth >= o.minDepth)
    .sort((a, b) => a.depth - b.depth);
  if (pts.length < o.minPoints) return null;

  const pointValue = (p: EvalPoint): number | null => {
    if (typeof p.mate === 'number') return p.mate > 0 ? o.mateCapCp : -o.mateCapCp;
    if (typeof p.cp === 'number') return p.cp;
    return null;
  };

  const vals: number[] = [];
  for (const p of pts) {
    const v = pointValue(p);
    if (v !== null) vals.push(v);
  }
  if (vals.length < o.minPoints) return null;

  const first = pts[0];
  const last = pts[pts.length - 1];
  const lo = Math.min(...vals);
  const hi = Math.max(...vals);
  const swingCp = hi - lo;
  const tail = vals.slice(-3);
  const recentDriftCp = Math.abs(tail[tail.length - 1] - tail[0]);

  // Signs ignoring the dead zone: +0.05 and −0.04 are not a reversal.
  const signs: number[] = [];
  for (const v of vals) {
    const s = signDeadZone(v, o.deadZoneCp);
    if (s === 0) continue;
    if (signs.length === 0 || signs[signs.length - 1] !== s) signs.push(s);
  }
  let reversals = 0;
  for (let i = 1; i < signs.length; i++) {
    if (signs[i] !== signs[i - 1]) reversals++;
  }
  const crossedZero = reversals > 0;

  // Trend: mean of last third vs first third.
  const third = Math.max(1, Math.floor(vals.length / 3));
  const headMean = vals.slice(0, third).reduce((s, v) => s + v, 0) / third;
  const tailMean = vals.slice(-third).reduce((s, v) => s + v, 0) / third;
  const trend: StabilityTrend =
    tailMean - headMean > o.trendDeltaCp ? 'up' : tailMean - headMean < -o.trendDeltaCp ? 'down' : 'flat';

  const lastIsMateUs = typeof last.mate === 'number' && last.mate > 0;
  const oppMateSeen = pts.some((p) => typeof p.mate === 'number' && p.mate < 0);

  let stability = 1 / (1 + swingCp / o.stabilitySwingScale);
  if (crossedZero) stability *= o.crossedZeroFactor;

  const needsDeeper =
    !lastIsMateUs &&
    !oppMateSeen &&
    (recentDriftCp > o.deepenDriftMinCp ||
      (crossedZero && Math.abs(vals[vals.length - 1]) < o.deepenNearZeroMaxCp));

  let verdict: StabilityVerdict;
  let driverKind: StabilityDriverKind | undefined;
  let driverCp: number | undefined;
  if (lastIsMateUs) {
    verdict = 'stable';
    driverKind = 'mate';
  } else if (oppMateSeen) {
    verdict = 'reversal';
    driverKind = 'opp-mate';
  } else if (crossedZero) {
    verdict = 'reversal';
  } else if (swingCp > o.unstableSwingMinCp) {
    verdict = 'unstable';
  } else if (swingCp > o.stableSwingMaxCp || recentDriftCp > o.watchDriftMinCp) {
    verdict = 'watch';
    if (swingCp > o.stableSwingMaxCp) {
      driverKind = 'swing';
      driverCp = swingCp;
    } else {
      driverKind = 'drift';
      driverCp = recentDriftCp;
    }
  } else {
    verdict = 'stable';
  }

  if (verdict === 'reversal' || verdict === 'unstable') {
    stability = Math.min(
      stability,
      verdict === 'reversal' ? o.reversalStabilityCap : o.unstableStabilityCap,
    );
  }

  return {
    points: vals.length,
    minDepth: first.depth,
    maxDepth: last.depth,
    finalFormatted: fmtPoint(last),
    rangeFormatted: `${fmtPoint(first)} → ${fmtPoint(last)}`,
    swingCp: Math.round(swingCp),
    recentDriftCp: Math.round(recentDriftCp),
    reversals,
    crossedZero,
    trend,
    stability: Math.round(stability * 100) / 100,
    adjustment: STABILITY_ADJUST[verdict],
    needsDeeper,
    verdict,
    driverKind,
    driverCp: driverCp === undefined ? undefined : Math.round(driverCp),
  };
}
