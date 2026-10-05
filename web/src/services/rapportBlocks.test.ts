import { describe, expect, it } from 'vitest';
import {
  describeRapportBlocks,
  rapportBlockLabel,
  splitIntoBlocks,
} from './rapport';
import { aggregatePeriodSlice, buildRapportBlocks } from './rapportBlocks';
import type { ChesscomGame } from './chesscom';

function fakeGame(url: string, endTime: number, whiteResult: string, meWhite = true): ChesscomGame {
  return {
    url,
    pgn: '',
    time_control: '600',
    end_time: endTime,
    rated: true,
    time_class: 'rapid',
    white: meWhite
      ? { username: 'Joueur', rating: 1500, result: whiteResult }
      : { username: 'Adv', rating: 1500, result: whiteResult },
    black: meWhite
      ? { username: 'Adv', rating: 1500, result: whiteResult === 'win' ? 'resigned' : whiteResult }
      : { username: 'Joueur', rating: 1500, result: whiteResult },
    sans: ['e4', 'e5'],
    eco: 'C20',
    opening: "King's Pawn Game",
    accuracy: 80,
    whiteAccuracy: 80,
    blackAccuracy: 80,
    acpl: 40,
  };
}

describe('splitIntoBlocks', () => {
  it('découpe en blocs fixes de 30', () => {
    const games = Array.from({ length: 65 }, (_, i) => i);
    const blocks = splitIntoBlocks(games, 30);
    expect(blocks).toHaveLength(3);
    expect(blocks[0]).toHaveLength(30);
    expect(blocks[1]).toHaveLength(30);
    expect(blocks[2]).toHaveLength(5);
  });

  it('retourne un tableau vide sans parties', () => {
    expect(splitIntoBlocks([], 30)).toEqual([]);
  });
});

describe('describeRapportBlocks', () => {
  it('numérote les blocs en 1-based', () => {
    const metas = describeRapportBlocks(65, 30);
    expect(metas).toHaveLength(3);
    expect(metas[0]).toMatchObject({ index: 0, start: 1, end: 30, games: 30, complete: true });
    expect(metas[1]).toMatchObject({ index: 1, start: 31, end: 60, games: 30, complete: true });
    expect(metas[2]).toMatchObject({ index: 2, start: 61, end: 65, games: 5, complete: false });
    expect(rapportBlockLabel(metas[1])).toBe('Bloc 2 · parties 31–60');
  });

  it('retourne vide sans parties', () => {
    expect(describeRapportBlocks(0, 30)).toEqual([]);
  });
});

describe('aggregatePeriodSlice', () => {
  it('compte victoires et précision', () => {
    const games = [
      fakeGame('u1', 1000, 'win'),
      fakeGame('u2', 2000, 'win'),
      fakeGame('u3', 3000, 'checkmated', true),
    ];
    const slice = aggregatePeriodSlice(games, 'Joueur', new Map());
    expect(slice.games).toBe(3);
    expect(slice.wins).toBe(2);
    expect(slice.losses).toBe(1);
    expect(slice.score).toBeCloseTo((2 / 3) * 100, 5);
    expect(slice.overallAcc).toBe(80);
    expect(slice.acpl).toBe(40);
  });
});

describe('buildRapportBlocks', () => {
  it('un rapport par bloc avec comparaison au précédent', () => {
    const games: ChesscomGame[] = Array.from({ length: 35 }, (_, i) =>
      fakeGame(`u${i}`, 1000 + i * 100, i % 3 === 0 ? 'win' : 'resigned'),
    );
    const blocks = buildRapportBlocks(games, 'Joueur', new Map(), false, 30);
    expect(blocks).toHaveLength(2);
    expect(blocks[0].input.totalGames).toBe(30);
    expect(blocks[1].input.totalGames).toBe(5);
    /* Bloc 1 : pas de précédent → comparaison insuffisante. */
    expect(blocks[0].input.evolution?.sufficient).toBe(false);
    /* Bloc 2 (5 parties) vs bloc 1 (30) : récente trop courte → indicatif. */
    expect(blocks[1].input.evolution?.sufficient).toBe(false);
    expect(blocks[1].input.evolution?.global).toBe('insuffisant');
    expect(blocks[1].input.evolution?.previousGames).toBe(30);
    expect(blocks[1].label).toBe('Bloc 2 · parties 31–35');
  });

  it('retourne vide sans parties', () => {
    expect(buildRapportBlocks([], 'Joueur')).toEqual([]);
  });

  it('signale le bloc en cours comme comparaison indicative', () => {
    const games: ChesscomGame[] = Array.from({ length: 35 }, (_, i) =>
      fakeGame(`u${i}`, 1000 + i * 100, i % 3 === 0 ? 'win' : 'resigned'),
    );
    const blocks = buildRapportBlocks(games, 'Joueur', new Map(), false, 30);
    expect(blocks[1].input.evolution?.narrative[0]).toContain('Bloc en cours (5/30)');
    expect(blocks[0].input.evolution?.narrative[0]).not.toContain('Bloc en cours');
  });
});
