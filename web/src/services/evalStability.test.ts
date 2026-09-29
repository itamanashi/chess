import { describe, expect, it } from 'vitest';
import type { EvalPoint } from '../types/chess';
import { STABILITY_LABELS, stabilitySummary } from '../i18n';
import {
  analyzeTrajectory,
  DEFAULT_STABILITY_OPTIONS,
  STABILITY_ADJUST,
  type StabilityReport,
} from './evalStability';

function cps(values: number[], startDepth = 8): EvalPoint[] {
  return values.map((cp, i) => ({ depth: startDepth + i, cp }));
}

function verdictOf(report: StabilityReport | null): string {
  if (!report) throw new Error('expected a report, got null');
  return report.verdict;
}

describe('analyzeTrajectory verdicts (default thresholds)', () => {
  it('stable: converged eval', () => {
    const r = analyzeTrajectory(cps([45, 48, 52, 50, 51, 49, 50]));
    expect(verdictOf(r)).toBe('stable');
    expect(r?.needsDeeper).toBe(false);
    expect(r?.driverKind).toBeUndefined();
  });

  it('watch on swing with structured swing driver', () => {
    const r = analyzeTrajectory(cps([30, 45, 60, 75, 95, 110]));
    expect(verdictOf(r)).toBe('watch');
    expect(r?.driverKind).toBe('swing');
    expect(r?.driverCp).toBe(80);
  });

  it('watch on drift with structured drift driver', () => {
    const r = analyzeTrajectory(cps([10, 12, 14, 16, 18, 60]));
    expect(verdictOf(r)).toBe('watch');
    expect(r?.driverKind).toBe('drift');
    expect(r?.driverCp).toBe(44);
  });

  it('unstable on large swing without sign flip', () => {
    const r = analyzeTrajectory(cps([10, 180, 20, 190, 30, 170]));
    expect(verdictOf(r)).toBe('unstable');
    expect(r?.stability).toBeLessThanOrEqual(0.45);
  });

  it('reversal on sign flip across the dead zone', () => {
    const r = analyzeTrajectory(cps([120, 130, 110, -120, -130, -110]));
    expect(verdictOf(r)).toBe('reversal');
    expect(r?.crossedZero).toBe(true);
    expect(r?.stability).toBeLessThanOrEqual(0.2);
  });

  it('dead zone: oscillation within ±12 cp is NOT a reversal', () => {
    const r = analyzeTrajectory(cps([5, -4, 6, -5, 4, -6]));
    expect(verdictOf(r)).toBe('stable');
    expect(r?.reversals).toBe(0);
  });

  it('decisive mate: stable with mate driver, no deepening', () => {
    const traj: EvalPoint[] = [...cps([40, 45, 50, 55, 60]), { depth: 13, mate: 3 }];
    const r = analyzeTrajectory(traj);
    expect(verdictOf(r)).toBe('stable');
    expect(r?.driverKind).toBe('mate');
    expect(r?.needsDeeper).toBe(false);
  });

  it('opponent mate seen: reversal with opp-mate driver', () => {
    const traj: EvalPoint[] = [...cps([50, 55, 52, 48, 60]), { depth: 13, mate: -2 }];
    const r = analyzeTrajectory(traj);
    expect(verdictOf(r)).toBe('reversal');
    expect(r?.driverKind).toBe('opp-mate');
  });

  it('needsDeeper when the tail still drifts', () => {
    const r = analyzeTrajectory(cps([10, 20, 30, 40, 50, 150]));
    expect(r?.needsDeeper).toBe(true);
  });

  it('returns null below the point floor', () => {
    expect(analyzeTrajectory(cps([10, 20]))).toBeNull();
    expect(analyzeTrajectory(undefined)).toBeNull();
  });
});

describe('thresholds are parameterized (no magic constants)', () => {
  const swingy = cps([10, 180, 20, 190, 30, 170]); // swing 180 → unstable by default

  it('raising unstableSwingMinCp downgrades unstable → watch', () => {
    expect(verdictOf(analyzeTrajectory(swingy))).toBe('unstable');
    expect(verdictOf(analyzeTrajectory(swingy, { unstableSwingMinCp: 10000 }))).toBe('watch');
  });

  it('widening the dead zone absorbs a reversal → unstable', () => {
    const flip = cps([120, 130, 110, -120, -130, -110]);
    expect(verdictOf(analyzeTrajectory(flip))).toBe('reversal');
    expect(verdictOf(analyzeTrajectory(flip, { deadZoneCp: 200 }))).toBe('unstable');
  });

  it('minPoints is honored', () => {
    const two = cps([10, 20]);
    expect(analyzeTrajectory(two)).toBeNull();
    expect(verdictOf(analyzeTrajectory(two, { minPoints: 2 }))).toBe('stable');
  });

  it('minDepth filters shallow noise', () => {
    // Huge D1 spike, flat afterwards: ignored by default (minDepth 8).
    const noisy: EvalPoint[] = [{ depth: 1, cp: 500 }, ...cps([50, 51, 52, 51, 50])];
    expect(verdictOf(analyzeTrajectory(noisy))).toBe('stable');
    expect(analyzeTrajectory(noisy, { minDepth: 1 })?.swingCp).toBeGreaterThan(400);
  });

  it('defaults are documented and stable', () => {
    expect(DEFAULT_STABILITY_OPTIONS).toMatchObject({
      minDepth: 8,
      minPoints: 3,
      deadZoneCp: 12,
      unstableSwingMinCp: 150,
      stableSwingMaxCp: 60,
    });
    expect(Object.keys(STABILITY_ADJUST).sort()).toEqual(['reversal', 'stable', 'unstable', 'watch']);
  });
});

describe('core exports metrics/verdict only — no prose', () => {
  it('report carries no summary key', () => {
    const r = analyzeTrajectory(cps([30, 45, 60, 75, 95, 110]));
    expect(r).not.toBeNull();
    expect('summary' in (r as object)).toBe(false);
    expect(r?.verdict).toBe('watch');
    expect(typeof r?.swingCp).toBe('number');
  });
});

describe('stabilitySummary (presentation layer, i18n)', () => {
  const range = '+0.50 → +0.45';
  it('formats every verdict in French', () => {
    expect(
      stabilitySummary({ verdict: 'stable', range, minDepth: 8, maxDepth: 18, swingCp: 5 }),
    ).toContain('converge');
    expect(
      stabilitySummary({ verdict: 'stable', range, minDepth: 8, maxDepth: 18, swingCp: 5, driverKind: 'mate' }),
    ).toContain('mat');
    expect(
      stabilitySummary({ verdict: 'reversal', range, minDepth: 8, maxDepth: 18, swingCp: 250 }),
    ).toContain('suspect');
    expect(
      stabilitySummary({ verdict: 'unstable', range, minDepth: 8, maxDepth: 18, swingCp: 200 }),
    ).toContain('200 cp');
    expect(
      stabilitySummary({ verdict: 'watch', range, minDepth: 8, maxDepth: 18, swingCp: 90, driverKind: 'swing', driverCp: 90 }),
    ).toContain('amplitude 90 cp');
    expect(
      stabilitySummary({ verdict: 'watch', range, minDepth: 8, maxDepth: 18, swingCp: 50, driverKind: 'drift', driverCp: 45 }),
    ).toContain('dérive 45 cp');
  });

  it('labels every verdict code', () => {
    expect(STABILITY_LABELS).toEqual({
      stable: 'Stable',
      watch: 'À surveiller',
      unstable: 'Instable',
      reversal: 'Renversement',
    });
  });
});
