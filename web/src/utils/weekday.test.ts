import { describe, expect, it } from 'vitest';
import {
  computeWeekdayStats,
  weekdayAccuracy,
  WEEKDAY_COLORS,
  WEEKDAY_ORDER,
  weekdayOfDate,
  weekdayOfEndTime,
} from './weekday';

describe('weekdayOfDate', () => {
  it('mappe getDay() (0 = dimanche) vers une semaine commençant lundi', () => {
    // 21 septembre 2026 = un lundi (ancrage calendaire connu).
    const monday = new Date(2026, 8, 21, 12, 0, 0);
    expect(weekdayOfDate(monday)).toBe('mon');
    for (let i = 0; i < 7; i++) {
      const d = new Date(2026, 8, 21 + i, 12, 0, 0);
      expect(weekdayOfDate(d)).toBe(WEEKDAY_ORDER[i]);
    }
    expect(weekdayOfDate(new Date(2026, 8, 27, 12, 0, 0))).toBe('sun');
  });
});

describe('weekdayOfEndTime', () => {
  it('convertit un timestamp Unix en jour local', () => {
    const ts = (day: number): number =>
      Math.floor(new Date(2026, 8, day, 20, 0, 0).getTime() / 1000);
    expect(weekdayOfEndTime(ts(21))).toBe('mon');
    expect(weekdayOfEndTime(ts(26))).toBe('sat');
    expect(weekdayOfEndTime(ts(27))).toBe('sun');
  });
});

describe('computeWeekdayStats', () => {
  const ts = (day: number): number =>
    Math.floor(new Date(2026, 8, day, 20, 0, 0).getTime() / 1000);

  it('agrège résultats et précision par jour, isole les sans-horodatage', () => {
    const stats = computeWeekdayStats([
      { endTime: ts(21), outcome: 'win', accuracy: 80 },
      { endTime: ts(21), outcome: 'loss', accuracy: 60 },
      { endTime: ts(26), outcome: 'draw' },
      { endTime: 0, outcome: 'win', accuracy: 50 },
    ]);
    expect(stats.total).toBe(3);
    expect(stats.unknown).toBe(1);
    expect(stats.byDay.mon).toMatchObject({ games: 2, wins: 1, draws: 0, losses: 1, accN: 2 });
    expect(stats.byDay.sat).toMatchObject({ games: 1, wins: 0, draws: 1, losses: 0, accN: 0 });
    expect(stats.byDay.sun.games).toBe(0);
    expect(weekdayAccuracy(stats.byDay.mon)).toBe(70);
    expect(weekdayAccuracy(stats.byDay.sat)).toBeNull();
    // Les 7 jours existent toujours (camembert + graphes stables).
    expect(WEEKDAY_ORDER).toHaveLength(7);
    expect(Object.keys(WEEKDAY_COLORS)).toHaveLength(7);
  });
});
