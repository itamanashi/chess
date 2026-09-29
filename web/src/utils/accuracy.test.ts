import { describe, expect, it } from 'vitest';
import {
  buildGameReport,
  classifyAnnotation,
  gameAccuracyByColor,
  getAccuracy,
  getAnnotation,
  getCPLoss,
  getWinChance,
  isOnlySoundMove,
  moveAccuracyFromWhiteCp,
  moveAccuracyFromWinPercents,
  phaseOfPly,
  whiteCpToWinChance,
  whiteWinToPov,
} from './accuracy';

describe('Win% (formule Lichess, perspective Blancs)', () => {
  it('vaut 50 au centre et est symétrique', () => {
    expect(getWinChance(0)).toBeCloseTo(50, 6);
    expect(getWinChance(100) + getWinChance(-100)).toBeCloseTo(100, 6);
  });

  it('+100 cp ≈ 59 % (régression logistique Lichess, k = 0.00368208)', () => {
    expect(getWinChance(100)).toBeGreaterThan(58);
    expect(getWinChance(100)).toBeLessThan(60);
  });

  it('sature aux extrêmes', () => {
    expect(getWinChance(1000)).toBeGreaterThan(97);
    expect(getWinChance(-1000)).toBeLessThan(3);
  });
});

describe('précision par coup (formule Lichess exacte)', () => {
  it('une amélioration vaut toujours 100', () => {
    expect(moveAccuracyFromWinPercents(50, 60)).toBe(100);
    expect(moveAccuracyFromWinPercents(50, 50)).toBe(100);
  });

  it('référence : diff 5 → 103.1668 * exp(-0.04354 * 5) - 3.1669 + 1', () => {
    const expected = 103.1668 * Math.exp(-0.04354 * 5) - 3.1669 + 1;
    expect(moveAccuracyFromWinPercents(50, 45)).toBeCloseTo(expected, 6);
    expect(expected).toBeGreaterThan(75);
    expect(expected).toBeLessThan(85);
  });

  it('une perte de 100 Win% tombe à ~0', () => {
    expect(moveAccuracyFromWinPercents(100, 0)).toBeLessThan(1);
  });

  it('replie Win% côté joueur depuis des cps blancs', () => {
    // Mêmes cps → 100 des deux côtés.
    expect(moveAccuracyFromWhiteCp(30, 30, 'white')).toBe(100);
    expect(moveAccuracyFromWhiteCp(30, 30, 'black')).toBe(100);
    // +30 → -250 pour les Blancs : diff Win% ≈ 24 → ~34 (courbe Lichess).
    const acc = moveAccuracyFromWhiteCp(30, -250, 'white');
    expect(acc).toBeGreaterThan(30);
    expect(acc).toBeLessThan(38);
    // … mais excellente nouvelle pour les Noirs.
    expect(moveAccuracyFromWhiteCp(30, -250, 'black')).toBe(100);
    // Perdre une finale gagnante sur mat : ~8.
    expect(moveAccuracyFromWhiteCp(600, -1000, 'white')).toBeLessThan(10);
  });

  it('helpers pov cohérents', () => {
    expect(whiteWinToPov(70, 'white')).toBe(70);
    expect(whiteWinToPov(70, 'black')).toBe(30);
    expect(whiteCpToWinChance(0)).toBeCloseTo(50, 6);
  });
});

describe('annotations en-croissant', () => {
  it('seuils ?? / ? / ?! / rien', () => {
    expect(classifyAnnotation({ winLoss: 25 })).toBe('??');
    expect(classifyAnnotation({ winLoss: 20 })).toBe('??');
    expect(classifyAnnotation({ winLoss: 15 })).toBe('?');
    expect(classifyAnnotation({ winLoss: 10 })).toBe('?');
    expect(classifyAnnotation({ winLoss: 7 })).toBe('?!');
    expect(classifyAnnotation({ winLoss: 5 })).toBe('?!');
    expect(classifyAnnotation({ winLoss: 2 })).toBe('');
  });

  it('sacrifices et coups uniques', () => {
    expect(classifyAnnotation({ winLoss: 1, isSacrifice: true, isOnlySound: true })).toBe('!!');
    expect(classifyAnnotation({ winLoss: 1, isSacrifice: true })).toBe('!?');
    expect(classifyAnnotation({ winLoss: 1, isOnlySound: true, prevOpponentMistake: true })).toBe('!');
    expect(classifyAnnotation({ winLoss: 1, isOnlySound: true })).toBe('');
  });

  it('only sound = écart best − 2e best ≥ 10', () => {
    expect(isOnlySoundMove(70, 55)).toBe(true);
    expect(isOnlySoundMove(70, 65)).toBe(false);
    expect(isOnlySoundMove(70, null)).toBe(false);
  });

  it('phase par pli', () => {
    expect(phaseOfPly(1)).toBe('opening');
    expect(phaseOfPly(20)).toBe('opening');
    expect(phaseOfPly(21)).toBe('middlegame');
    expect(phaseOfPly(61)).toBe('endgame');
  });
});

describe('précision de partie (lila : pondérée + harmonique / 2)', () => {
  it('une partie parfaite vaut 100/100', () => {
    const samples = [
      { beforePov: 50, afterPov: 50, color: 'white' as const },
      { beforePov: 50, afterPov: 50, color: 'black' as const },
      { beforePov: 50, afterPov: 50, color: 'white' as const },
      { beforePov: 50, afterPov: 50, color: 'black' as const },
    ];
    const acc = gameAccuracyByColor(samples);
    expect(acc.white).toBeCloseTo(100, 6);
    expect(acc.black).toBeCloseTo(100, 6);
  });

  it('le blunder d’un camp ne touche pas l’autre', () => {
    const samples = [
      { beforePov: 50, afterPov: 50, color: 'white' as const },
      { beforePov: 50, afterPov: 50, color: 'black' as const },
      { beforePov: 50, afterPov: 50, color: 'white' as const },
      { beforePov: 50, afterPov: 5, color: 'black' as const },
      { beforePov: 50, afterPov: 50, color: 'white' as const },
      { beforePov: 5, afterPov: 5, color: 'black' as const },
    ];
    const acc = gameAccuracyByColor(samples);
    expect(acc.white).toBeCloseTo(100, 6);
    expect(acc.black).toBeLessThan(80);
  });

  it('couleur absente → null', () => {
    const acc = gameAccuracyByColor([{ beforePov: 50, afterPov: 50, color: 'white' }]);
    expect(acc.white).toBeCloseTo(100, 6);
    expect(acc.black).toBeNull();
  });
});

describe('rapport de partie', () => {
  it('agrège précisions, ACPL, annotations et phases', () => {
    const report = buildGameReport([
      {
        ply: 1, san: 'e4', color: 'white', whiteCp: 20, whiteWin: 55,
        winLoss: 0, cpLoss: 0, accuracy: 100, annotation: '',
        isBest: true, isOnlySound: false, isSacrifice: false,
      },
      {
        ply: 2, san: 'e5', color: 'black', whiteCp: 20, whiteWin: 55,
        winLoss: 0, cpLoss: 0, accuracy: 100, annotation: '',
        isBest: true, isOnlySound: false, isSacrifice: false,
      },
      {
        ply: 3, san: 'Qh5', color: 'white', whiteCp: -250, whiteWin: 5,
        winLoss: 50, cpLoss: 270, accuracy: 5, annotation: '??',
        isBest: false, isOnlySound: false, isSacrifice: false,
      },
    ]);
    expect(report.accuracy.white).toBeLessThan(report.accuracy.black ?? 100);
    expect(report.annotations['??']).toBe(1);
    expect(report.acpl.white).toBeGreaterThan(0);
    expect(report.acpl.black).toBe(0);
    expect(report.phases.opening.white).not.toBeNull();
  });
});

describe('compatibilité ascendante (trainer)', () => {
  it('getAccuracy : amélioration → 100, blunder → bas', () => {
    expect(getAccuracy({ type: 'cp', value: 0 }, { type: 'cp', value: 100 }, 'white')).toBe(100);
    // +100 → -300 : diff Win% ≈ 34 → ~21 (courbe Lichess, pas 0).
    expect(getAccuracy({ type: 'cp', value: 100 }, { type: 'cp', value: -300 }, 'white')).toBeLessThan(25);
    // Mate manqué : ~9.
    expect(getAccuracy({ type: 'cp', value: 100 }, { type: 'mate', value: -1 }, 'white')).toBeLessThan(10);
  });

  it('getCPLoss ne rend jamais de négatif', () => {
    expect(getCPLoss({ type: 'cp', value: 0 }, { type: 'cp', value: 50 }, 'white')).toBe(0);
    expect(getCPLoss({ type: 'cp', value: 50 }, { type: 'cp', value: 0 }, 'white')).toBe(50);
  });

  it('getAnnotation : seuils rapides sans moteur', () => {
    expect(
      getAnnotation({ type: 'cp', value: 30 }, { type: 'cp', value: -400 }, 'white'),
    ).toBe('??');
    expect(getAnnotation(null, { type: 'cp', value: 0 }, 'white')).toBe('');
    expect(getAnnotation({ type: 'cp', value: 0 }, { type: 'cp', value: 0 }, 'white')).toBe('');
  });
});
