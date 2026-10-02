import { describe, expect, it } from 'vitest';
import { formatGames, pct } from './formatGames';

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
