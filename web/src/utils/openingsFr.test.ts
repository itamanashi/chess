import { describe, expect, it } from 'vitest';
import { frenchOpeningName, frenchOpeningVariant, splitOpeningName } from './openingsFr';

describe('frenchOpeningName', () => {
  it('traduit les têtes exactes les plus courantes', () => {
    expect(frenchOpeningName('Sicilian Defense')).toBe('Défense sicilienne');
    expect(frenchOpeningName('French Defense')).toBe('Défense française');
    expect(frenchOpeningName('Ruy Lopez')).toBe('Partie espagnole');
    expect(frenchOpeningName('Italian Game')).toBe('Partie italienne');
    expect(frenchOpeningName("Queen's Gambit")).toBe('Gambit dame');
    expect(frenchOpeningName('London System')).toBe('Système de Londres');
    expect(frenchOpeningName("King's Indian Defense")).toBe('Défense est-indienne');
    expect(frenchOpeningName("King's Knight Opening")).toBe('Début du cavalier roi');
  });

  it('compose « Tête : suite » (format Lichess)', () => {
    expect(frenchOpeningName('Sicilian Defense: Najdorf Variation')).toBe(
      'Défense sicilienne : variante Naïdorf',
    );
    expect(frenchOpeningName("King's Gambit Accepted")).toBe('Gambit du roi accepté');
    expect(frenchOpeningName('Ruy Lopez: Berlin Defense')).toBe(
      'Partie espagnole : défense de Berlin',
    );
    expect(frenchOpeningName('Italian Game: Evans Gambit')).toBe(
      'Partie italienne : gambit Evans',
    );
  });

  it('compose « Tête suite » (slugs ECOUrl Chess.com déballés)', () => {
    expect(frenchOpeningName('Sicilian Defense Open Sicilian')).toBe(
      'Défense sicilienne, Sicilienne ouverte',
    );
  });

  it('traduit les suites seules connues', () => {
    expect(frenchOpeningName('Accepted')).toBe('accepté');
  });

  it('repli anglais intact si rien n\u2019est connu (jamais de charabia)', () => {
    expect(frenchOpeningName('Foo Defense: Bar Variation')).toBe('Foo Defense: Bar Variation');
    expect(frenchOpeningName('Sodium Attack')).toBe('Sodium Attack');
    expect(frenchOpeningName('')).toBe('');
    expect(frenchOpeningName(null)).toBe('');
  });

  it('ne reformatte pas quand tête connue mais suite inconnue (garde la suite anglaise)', () => {
    expect(frenchOpeningName('Sicilian Defense: Hypermodern Whatever')).toBe(
      'Défense sicilienne : Hypermodern Whatever',
    );
  });
});

describe('splitOpeningName', () => {
  it('découpe tête et suite (deux-points, virgule, préfixe)', () => {
    expect(splitOpeningName('Sicilian Defense: Najdorf Variation')).toEqual({
      parent: 'Sicilian Defense',
      variant: 'Najdorf Variation',
    });
    expect(splitOpeningName('Sicilian Defense, Najdorf Variation')).toEqual({
      parent: 'Sicilian Defense',
      variant: 'Najdorf Variation',
    });
    expect(splitOpeningName('Sicilian Defense Open Sicilian')).toEqual({
      parent: 'Sicilian Defense',
      variant: 'Open Sicilian',
    });
    expect(splitOpeningName('Sicilian Defense')).toEqual({ parent: 'Sicilian Defense', variant: null });
    expect(splitOpeningName('')).toEqual({ parent: '', variant: null });
  });
});

describe('frenchOpeningVariant', () => {
  it('traduit la suite seule, null si inconnue', () => {
    expect(frenchOpeningVariant('Najdorf Variation')).toBe('variante Naïdorf');
    expect(frenchOpeningVariant('Evans Gambit')).toBe('gambit Evans');
    expect(frenchOpeningVariant('Funky Variation')).toBeNull();
    expect(frenchOpeningVariant(null)).toBeNull();
  });
});
