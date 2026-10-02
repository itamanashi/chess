import { describe, expect, it } from 'vitest';
import { buildRapport, type RapportInput } from './rapport';

function baseInput(overrides: Partial<RapportInput> = {}): RapportInput {
  return {
    me: 'joueur',
    totalGames: 20,
    wins: 11,
    draws: 2,
    losses: 7,
    score: 60,
    whiteGames: 10,
    whiteWins: 7,
    blackGames: 10,
    blackWins: 4,
    botGamesCount: 0,
    overallAcc: 82,
    analyzedCount: 10,
    accWin: 85,
    accWinCount: 6,
    accLoss: 74,
    accLossCount: 4,
    accDraw: null,
    accDrawCount: 0,
    brilliant: 2,
    best: 10,
    excellent: 8,
    good: 20,
    inaccuracy: 5,
    mistake: 3,
    blunder: 1,
    totalMoves: 49,
    matesFound: 2,
    matesMissed: 0,
    forksFound: 3,
    forksMissed: 1,
    hangs: 1,
    freebiesFound: 2,
    freebiesMissed: 0,
    theoryAvg: 9,
    theoryCount: 5,
    theoryAvailable: true,
    topShape: 'equilibree',
    topShapePct: 30,
    bestOpening: { name: 'Italienne', eco: 'C50', wins: 4, games: 5 },
    worstOpening: { name: 'Sicilienne', eco: 'B20', wins: 1, games: 5 },
    ...overrides,
  };
}

describe('buildRapport', () => {
  it('calcule les compteurs bons/mauvais coups', () => {
    const data = buildRapport(baseInput());
    expect(data.goodMoves).toBe(40);
    expect(data.badMoves).toBe(9);
    expect(data.qualitySegments).toHaveLength(7);
  });

  it('signale la précision faible en priorité haute', () => {
    const data = buildRapport(baseInput({ overallAcc: 68 }));
    const axe = data.axes.find((a) => a.title === 'Précision globale');
    expect(axe?.priority).toBe('high');
  });

  it('signale les bévues fréquentes au-delà de 4 %', () => {
    const data = buildRapport(baseInput({ blunder: 5, totalMoves: 50 }));
    const axe = data.axes.find((a) => a.title === 'Bévues fréquentes');
    expect(axe?.priority).toBe('high');
  });

  it('retourne un repli sans axe ni force quand il manque de données', () => {
    const data = buildRapport(baseInput({
      totalGames: 2, wins: 1, draws: 0, losses: 1, score: 50,
      overallAcc: null, analyzedCount: 0,
      accWin: null, accWinCount: 0, accLoss: null, accLossCount: 0,
      brilliant: 0, best: 0, excellent: 0, good: 0,
      inaccuracy: 0, mistake: 0, blunder: 0, totalMoves: 0,
      matesFound: 0, matesMissed: 0, forksFound: 0, forksMissed: 0,
      hangs: 0, freebiesFound: 0, freebiesMissed: 0,
      theoryAvg: null, theoryCount: 0, theoryAvailable: false,
      topShapePct: 0, bestOpening: null, worstOpening: null,
    }));
    expect(data.axes.some((a) => a.title === 'Données insuffisantes')).toBe(true);
  });
});
