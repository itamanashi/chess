import { describe, expect, it } from 'vitest';
import { formatDuration, formatEval, formatGames, pct } from './formatGames';

describe('formatGames', () => {
  it('petites valeurs exactes', () => {
    expect(formatGames(0)).toBe('0');
    expect(formatGames(1)).toBe('1');
    expect(formatGames(987)).toBe('987');
  });

  it('milliers compacts', () => {
    expect(formatGames(1000)).toBe('1.0k');
    expect(formatGames(12400)).toBe('12k');
    expect(formatGames(999999)).toBe('1000k');
  });

  it('millions compacts', () => {
    expect(formatGames(1_250_000)).toBe('1.3M');
    expect(formatGames(150_000_000)).toBe('150M');
  });

  it('valeurs invalides → 0', () => {
    expect(formatGames(NaN)).toBe('0');
    expect(formatGames(-5)).toBe('0');
    expect(formatGames(Infinity)).toBe('0');
  });
});

describe('pct', () => {
  it('calcule le pourcentage arrondi', () => {
    expect(pct(42, 100)).toBe(42);
    expect(pct(1, 3)).toBe(33);
  });

  it('total nul ou invalide → 0 (jamais NaN)', () => {
    expect(pct(5, 0)).toBe(0);
    expect(pct(5, -2)).toBe(0);
    expect(pct(NaN, 100)).toBe(0);
  });
});

describe('formatDuration', () => {
  it('secondes et minutes', () => {
    expect(formatDuration(0)).toBe('0s');
    expect(formatDuration(-3)).toBe('0s');
    expect(formatDuration(30_000)).toBe('30s');
    expect(formatDuration(192_000)).toBe('3m 12s');
  });

  it('heures et jours', () => {
    expect(formatDuration(7_500_000)).toBe('2h 5m');
    expect(formatDuration(90_000_000)).toBe('1j 1h');
  });
});

describe('formatEval', () => {
  it('signe et null', () => {
    expect(formatEval(null)).toBe('—');
    expect(formatEval(125)).toBe('+1.25');
    expect(formatEval(-30)).toBe('-0.30');
    expect(formatEval(0)).toBe('0.00');
  });
});
