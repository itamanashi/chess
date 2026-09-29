import { describe, expect, it } from 'vitest';
import {
  alpha2OfNumericId,
  computeCountryStats,
  countryAccuracy,
  countryWinRate,
  flagSrc,
  frenchCountryName,
} from './geography';

describe('alpha2OfNumericId', () => {
  it('convertit les identifiants world-atlas (France, voisins, lointains)', () => {
    expect(alpha2OfNumericId('250')).toBe('FR');
    expect(alpha2OfNumericId('276')).toBe('DE');
    expect(alpha2OfNumericId('840')).toBe('US');
    expect(alpha2OfNumericId('392')).toBe('JP');
  });

  it('retourne null pour les inconnus (Kosovo « -99 », Antarctique, vide)', () => {
    expect(alpha2OfNumericId('-99')).toBeNull();
    expect(alpha2OfNumericId('010')).toBeNull();
    expect(alpha2OfNumericId(null)).toBeNull();
    expect(alpha2OfNumericId('999')).toBeNull();
  });
});

describe('frenchCountryName / flagSrc', () => {
  it('nom français via Intl, repli = code ; inconnu = libellé générique', () => {
    expect(frenchCountryName('FR')).toBe('France');
    expect(frenchCountryName('')).toBe('Pays inconnu');
  });

  it('URL flagcdn en minuscules, null si code invalide', () => {
    expect(flagSrc('FR')).toBe('https://flagcdn.com/w80/fr.png');
    expect(flagSrc('')).toBeNull();
    expect(flagSrc('FRA')).toBeNull();
  });
});

describe('computeCountryStats', () => {
  it('agrège par pays, triés par volume, précision et %V calculés', () => {
    const rows = computeCountryStats([
      { country: 'FR', outcome: 'win', accuracy: 80 },
      { country: 'FR', outcome: 'loss', accuracy: 60 },
      { country: 'DE', outcome: 'draw' },
      { country: '', outcome: 'win', accuracy: 50 },
    ]);
    expect(rows.map((r) => r.code)).toEqual(['FR', '', 'DE']);
    const fr = rows[0];
    expect(fr).toMatchObject({ games: 2, wins: 1, draws: 0, losses: 1, accN: 2 });
    expect(countryAccuracy(fr)).toBe(70);
    expect(countryWinRate(fr)).toBe(50);
    expect(countryAccuracy(rows[2])).toBeNull();
  });
});
