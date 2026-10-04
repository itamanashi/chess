import { describe, expect, it } from 'vitest';
import { buildEvolution, buildRapport, estimatedLevelFor, type RapportInput, type RapportPeriodSlice } from './rapport';

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
    acplOverall: 35,
    acplCount: 10,
    accWhite: 84,
    accWhiteCount: 6,
    accBlack: 79,
    accBlackCount: 4,
    bestGame: null,
    worstGame: null,
    ...overrides,
  };
}

function slice(overrides: Partial<RapportPeriodSlice> = {}): RapportPeriodSlice {
  return {
    games: 20,
    wins: 11,
    draws: 2,
    losses: 7,
    score: 60,
    analyzedCount: 10,
    overallAcc: 82,
    acpl: 35,
    acplCount: 10,
    blunderRate: 2,
    hangsPerGame: 0.1,
    theoryAvg: 9,
    theoryCount: 5,
    matesFound: 2,
    matesMissed: 0,
    forksFound: 3,
    forksMissed: 1,
    freebiesMissed: 0,
    sparkScore: [50, 55, 60, 62],
    sparkAcc: [78, 80, 82, 83],
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
      acplOverall: null, acplCount: 0,
    }));
    expect(data.axes.some((a) => a.title === 'Données insuffisantes')).toBe(true);
  });

  it('colore l\u2019ACPL en succès sous 40 cp', () => {
    const data = buildRapport(baseInput({ acplOverall: 35 }));
    expect(data.acplColor).toBe('#8fb996');
  });

  it('expose les glyphes de classification façon chess.com', () => {
    const data = buildRapport(baseInput());
    const byKey = new Map(data.qualitySegments.map((s) => [s.key, s.glyph]));
    expect(byKey.get('brillant')).toBe('!!');
    expect(byKey.get('meilleur')).toBe('!');
    expect(byKey.get('gaffe')).toBe('??');
  });

  it('estime le niveau de jeu depuis la précision', () => {
    expect(estimatedLevelFor(null)).toBeNull();
    expect(estimatedLevelFor(94.6)).toBe(2100);
    expect(estimatedLevelFor(82)).toBe(1700);
    expect(estimatedLevelFor(55)).toBe(1000);
    const data = buildRapport(baseInput({ overallAcc: 82 }));
    expect(data.estimatedLevel).toBe(1700);
  });
});

describe('buildEvolution', () => {
  it('détecte une progression (score, précision, ACPL en baisse)', () => {
    const evo = buildEvolution(
      slice({ score: 65, overallAcc: 84, acpl: 28 }),
      slice({ score: 55, overallAcc: 78, acpl: 45 }),
    );
    expect(evo.sufficient).toBe(true);
    expect(evo.global).toBe('progression');
    expect(evo.deltas.find((d) => d.key === 'score')?.favorable).toBe(true);
    expect(evo.deltas.find((d) => d.key === 'precision')?.favorable).toBe(true);
    /* Baisse ACPL = progression (sens inversé). */
    expect(evo.deltas.find((d) => d.key === 'acpl')?.favorable).toBe(true);
    expect(evo.narrative.length).toBeGreaterThan(0);
  });

  it('détecte une régression quand tout se dégrade', () => {
    const evo = buildEvolution(
      slice({ score: 45, overallAcc: 70, acpl: 90, blunderRate: 6, hangsPerGame: 1 }),
      slice({ score: 60, overallAcc: 82, acpl: 35, blunderRate: 2, hangsPerGame: 0.1 }),
    );
    expect(evo.global).toBe('régression');
    expect(evo.deltas.find((d) => d.key === 'bevues')?.favorable).toBe(false);
    expect(evo.deltas.find((d) => d.key === 'pieces-prise')?.favorable).toBe(false);
    expect(evo.narrative.join(' ')).toContain('Régression');
  });

  it('reste stable dans la marge des seuils', () => {
    const evo = buildEvolution(
      slice({ score: 60.5, overallAcc: 82.3 }),
      slice({ score: 60, overallAcc: 82 }),
    );
    expect(evo.global).toBe('stable');
  });

  it('marque insuffisant quand la période précédente a moins de 10 parties', () => {
    const evo = buildEvolution(slice({}), slice({ games: 4 }));
    expect(evo.sufficient).toBe(false);
    expect(evo.global).toBe('insuffisant');
    expect(evo.deltas.every((d) => d.text === '—')).toBe(true);
  });

  it('annote les axes du rapport avec la note d\u2019évolution', () => {
    const evo = buildEvolution(
      slice({ overallAcc: 68, hangsPerGame: 1 }),
      slice({ overallAcc: 82, hangsPerGame: 0.1 }),
    );
    const data = buildRapport(baseInput({ overallAcc: 68, hangs: 10, analyzedCount: 10, evolution: evo }));
    const axe = data.axes.find((a) => a.title === 'Précision globale');
    expect(axe?.evolutionNote).toContain('aggrave');
  });
});
