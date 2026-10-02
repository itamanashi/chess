import { describe, expect, it } from 'vitest';
import { Chess } from 'chess.js';
import { INITIAL_FEN } from './repertoire';
import { getOfflineExplorer, offlineOpeningFromSans } from './offlineBook';

function fenAfter(sans: string[]): string {
  const c = new Chess();
  for (const s of sans) c.move(s);
  return c.fen();
}

describe('offlineBook (repli affichage seul)', () => {
  it('position initiale : e4/d4/Nf3/c4', () => {
    const data = getOfflineExplorer(INITIAL_FEN);
    expect(data).not.toBeNull();
    const sans = data!.moves.map((m) => m.san);
    expect(sans).toContain('e4');
    expect(sans).toContain('d4');
    expect(data!.white + data!.draws + data!.black).toBeGreaterThan(0);
  });

  it('après 1.e4 : e5/c5/e6/c6', () => {
    const data = getOfflineExplorer(fenAfter(['e4']));
    expect(data).not.toBeNull();
    const sans = data!.moves.map((m) => m.san);
    expect(sans).toContain('e5');
    expect(sans).toContain('c5');
  });

  it('position hors livre → null', () => {
    // Ligne absurde mais légale : aucune entrée du mini-livre.
    const data = getOfflineExplorer(fenAfter(['h4', 'h5', 'Rh3', 'Rh6']));
    expect(data).toBeNull();
  });

  it('openingFromSans : plus long préfixe', () => {
    expect(offlineOpeningFromSans([]).name).toBe('Starting position');
    expect(offlineOpeningFromSans(['e4', 'e5', 'Nf3', 'Nc6', 'Bb5'])).toMatchObject({
      eco: 'C60',
      name: 'Ruy Lopez',
    });
  });
});
