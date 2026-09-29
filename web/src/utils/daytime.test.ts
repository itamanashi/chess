import { describe, expect, it } from 'vitest';
import {
  computeDaytimeStats,
  daytimeAccuracy,
  DAY_SLOT_ORDER,
  slotOfEndTime,
  slotOfHour,
} from './daytime';

describe('slotOfHour', () => {
  it('découpe la journée en 4 tranches (bornes 6h/12h/18h/0h)', () => {
    expect(slotOfHour(0)).toBe('night');
    expect(slotOfHour(5)).toBe('night');
    expect(slotOfHour(6)).toBe('morning');
    expect(slotOfHour(11)).toBe('morning');
    expect(slotOfHour(12)).toBe('afternoon');
    expect(slotOfHour(17)).toBe('afternoon');
    expect(slotOfHour(18)).toBe('evening');
    expect(slotOfHour(23)).toBe('evening');
  });
});

describe('slotOfEndTime', () => {
  // Horodatages construits en heure LOCALE : indépendants du fuseau du runner.
  const atHour = (h: number): number =>
    Math.floor(new Date(2026, 4, 12, h, 30, 0).getTime() / 1000);

  it('convertit un timestamp Unix en tranche locale', () => {
    expect(slotOfEndTime(atHour(9))).toBe('morning');
    expect(slotOfEndTime(atHour(15))).toBe('afternoon');
    expect(slotOfEndTime(atHour(21))).toBe('evening');
    expect(slotOfEndTime(atHour(2))).toBe('night');
  });
});

describe('computeDaytimeStats', () => {
  const atHour = (h: number): number =>
    Math.floor(new Date(2026, 4, 12, h, 30, 0).getTime() / 1000);

  it('agrège résultats et précision par tranche, isole les sans-horodatage', () => {
    const stats = computeDaytimeStats([
      { endTime: atHour(9), outcome: 'win', accuracy: 80 },
      { endTime: atHour(10), outcome: 'loss', accuracy: 60 },
      { endTime: atHour(15), outcome: 'draw' },
      { endTime: atHour(22), outcome: 'win', accuracy: 90 },
      { endTime: 0, outcome: 'win', accuracy: 50 },
    ]);
    expect(stats.total).toBe(4);
    expect(stats.unknown).toBe(1);
    expect(stats.bySlot.morning).toMatchObject({ games: 2, wins: 1, draws: 0, losses: 1, accN: 2 });
    expect(stats.bySlot.afternoon).toMatchObject({ games: 1, wins: 0, draws: 1, losses: 0, accN: 0 });
    expect(stats.bySlot.evening).toMatchObject({ games: 1, wins: 1, draws: 0, losses: 0, accN: 1 });
    expect(stats.bySlot.night.games).toBe(0);
    expect(daytimeAccuracy(stats.bySlot.morning)).toBe(70);
    expect(daytimeAccuracy(stats.bySlot.afternoon)).toBeNull();
    // Les 4 tranches existent toujours (graphes à 4 barres stables).
    expect(DAY_SLOT_ORDER).toHaveLength(4);
  });
});
