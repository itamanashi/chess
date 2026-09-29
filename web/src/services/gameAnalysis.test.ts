import { describe, expect, it, vi } from 'vitest';
import type { EngineMove } from '../types/chess';
import { analyzeGamePgn, analyzeGameSans, replaySans } from './gameAnalysis';

function em(partial: Partial<EngineMove> & { uci: string }): EngineMove {
  return {
    san: partial.uci,
    depth: 10,
    scoreFormatted: '+0.00',
    pvSans: [partial.san ?? partial.uci],
    ...partial,
  } as EngineMove;
}

/**
 * Faux moteur déterministe :
 *  - position initiale (trait blanc) : meilleur = e2e4 (+30), 2e = d2d4 (+20) ;
 *  - trait noir au 1er coup (après 1.f3) : les Noirs sont bien mieux (+250) ;
 *  - trait blanc au 2e coup : la position reste mauvaise pour les Blancs.
 * Donc 1.f3 est un blunder (??) et 1…e5 le meilleur coup (aucune annotation).
 */
function mockBlunderEngine(calls: string[]) {
  return async (fen: string): Promise<EngineMove[]> => {
    calls.push(fen);
    const parts = fen.split(' ');
    const side = parts[1];
    const fullmove = Number(parts[5]);
    if (side === 'w' && fullmove === 1) {
      return [
        em({ uci: 'e2e4', san: 'e4', cp: 30, pvSans: ['e4', 'e5'] }),
        em({ uci: 'd2d4', san: 'd4', cp: 20, pvSans: ['d4'] }),
      ];
    }
    if (side === 'b') {
      return [
        em({ uci: 'e7e5', san: 'e5', cp: 250, pvSans: ['e5', 'Nf3'] }),
        em({ uci: 'c7c5', san: 'c5', cp: 100, pvSans: ['c5'] }),
      ];
    }
    return [
      em({ uci: 'g1f3', san: 'Nf3', cp: -250, pvSans: ['Nf3'] }),
      em({ uci: 'b1c3', san: 'Nc3', cp: -260, pvSans: ['Nc3'] }),
    ];
  };
}

describe('replaySans', () => {
  it('rejoue SAN → UCI + FEN (avec roque normalisé)', () => {
    const { steps } = replaySans(['e4', 'e5', 'Nf3']);
    expect(steps).toHaveLength(3);
    expect(steps[0]).toMatchObject({ san: 'e4', uci: 'e2e4', mover: 'w', piece: 'p' });
    expect(steps[1]).toMatchObject({ san: 'e5', uci: 'e7e5', mover: 'b', piece: 'p' });
    expect(steps[2]).toMatchObject({ san: 'Nf3', mover: 'w', piece: 'n' });
    expect(steps[2].fenAfter).toContain(' b ');
  });

  it('pièce jouée : cavalier, fou, dame, tour, roque (= roi)', () => {
    const { steps } = replaySans(['a4', 'd5', 'Ra3', 'Nf6', 'Nf3', 'Bg4', 'Ne5', 'Qd6', 'Nxg4', 'Qxh2']);
    expect(steps.map((s) => s.piece)).toEqual(['p', 'p', 'r', 'n', 'n', 'b', 'n', 'q', 'n', 'q']);
  });

  it('roque = coup de roi', () => {
    const { steps } = replaySans(['e4', 'e5', 'Nf3', 'Nc6', 'Bc4', 'Bc5', 'O-O']);
    expect(steps[steps.length - 1]).toMatchObject({ san: 'O-O', uci: 'e1g1', piece: 'k' });
  });

  it('lève sur coup illégal', () => {
    expect(() => replaySans(['e4', 'e4'])).toThrow(/illégal/);
  });
});

describe('analyzeGameSans (moteur simulé)', () => {
  it('analyse À REBOURS (finale d’abord : réutilisation du hash)', async () => {
    const calls: string[] = [];
    const result = await analyzeGameSans(['f3', 'e5'], {
      analyzeFn: mockBlunderEngine(calls),
    });
    expect(result.totalPlies).toBe(2);
    // 3 positions : initiale, après f3, après e5 — la dernière en premier.
    expect(calls).toHaveLength(3);
    // Ordre strict : finale → milieu → initiale.
    const { steps } = replaySans(['f3', 'e5']);
    const fens = [steps[0].fenBefore, steps[0].fenAfter, steps[1].fenAfter];
    expect(calls).toEqual([fens[2], fens[1], fens[0]]);
    expect(result.movesAnalyzed).toBe(3);
  });

  it('1.f3 = ??, 1…e5 = ! (seul bon coup qui punit)', async () => {
    const calls: string[] = [];
    const result = await analyzeGameSans(['f3', 'e5'], {
      analyzeFn: mockBlunderEngine(calls),
    });
    const [p1, p2] = result.plies;
    expect(p1.san).toBe('f3');
    expect(p1.isBest).toBe(false);
    expect(p1.annotation).toBe('??');
    expect(p1.bestSan).toBe('e4');
    expect(p1.bestLineSans).toEqual(['e4', 'e5']);
    // e5 est le meilleur coup, le seul raisonnable (écart ≥ 10 avec c5),
    // juste après la gaffe blanche → « Good » en-croissant.
    expect(p2.san).toBe('e5');
    expect(p2.isBest).toBe(true);
    expect(p2.isOnlySound).toBe(true);
    expect(p2.annotation).toBe('!');
  });

  it('précisions W/B : les Blancs chutent, les Noirs restent à 100', async () => {
    const calls: string[] = [];
    const result = await analyzeGameSans(['f3', 'e5'], {
      analyzeFn: mockBlunderEngine(calls),
    });
    expect(result.accuracy.white).toBeLessThan(50);
    expect(result.accuracy.black).toBeCloseTo(100, 6);
    expect(result.acpl.white).toBeGreaterThan(0);
    expect(result.acpl.black).toBe(0);
  });

  it('propage le mat annoncé du meilleur coup (bestMate, relatif au trait)', async () => {
    const mateEngine = async (fen: string): Promise<EngineMove[]> => {
      const side = fen.split(' ')[1];
      if (side === 'w') return [em({ uci: 'e2e4', san: 'e4', mate: 3, pvSans: ['e4'] })];
      return [em({ uci: 'e7e5', san: 'e5', cp: 20, pvSans: ['e5'] })];
    };
    const result = await analyzeGameSans(['e4', 'e5'], { analyzeFn: mateEngine });
    expect(result.plies[0].bestMate).toBe(3);
    expect(result.plies[1].bestMate).toBeUndefined();
  });

  it('partie vide → erreur explicite', async () => {
    await expect(analyzeGameSans([], { analyzeFn: async () => [] })).rejects.toThrow(/vide/);
  });

  it('annulation → AbortError', async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(
      analyzeGameSans(['e4'], { analyzeFn: async () => [], signal: ctrl.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('onProgress rapporte 0..total', async () => {
    const seen: Array<[number, number]> = [];
    const calls: string[] = [];
    await analyzeGameSans(['f3', 'e5'], {
      analyzeFn: mockBlunderEngine(calls),
      onProgress: (done, total) => seen.push([done, total]),
    });
    expect(seen[0]).toEqual([0, 3]);
    expect(seen[seen.length - 1]).toEqual([3, 3]);
  });
});

describe('analyzeGamePgn', () => {
  it('parse un PGN avec en-têtes', async () => {
    const calls: string[] = [];
    const pgn = '[White "A"]\n[Black "B"]\n\n1. f3 e5 *';
    const result = await analyzeGamePgn(pgn, { analyzeFn: mockBlunderEngine(calls) });
    expect(result.totalPlies).toBe(2);
    expect(result.plies[0].annotation).toBe('??');
  });

  it('PGN illisible → erreur explicite', async () => {
    const fn = vi.fn(async () => []);
    await expect(analyzeGamePgn('ceci n’est pas un pgn ((((', { analyzeFn: fn })).rejects.toThrow();
    expect(fn).not.toHaveBeenCalled();
  });
});
