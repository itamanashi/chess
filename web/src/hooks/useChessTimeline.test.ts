import { describe, expect, it } from 'vitest';
import { spliceAppend } from './useChessTimeline';
import type { MoveHistoryItem } from '../types/chess';

const item = (san: string, uci: string, fen: string): MoveHistoryItem => ({ san, uci, fen });
const START = item('', '', 'start');
const E4 = item('e4', 'e2e4', 'after-e4');
const E5 = item('e5', 'e7e5', 'after-e5');
const D4 = item('d4', 'd2d4', 'after-d4');

describe('spliceAppend (réplique adverse du trainer)', () => {
  it('redémarrage auto : la vieille ligne est tronquée, la réplique est en index 1', () => {
    // Ligne précédente 1.e4 e5 terminée, retour au début (index 0), puis
    // réplique auto 1.d4 : sans troncature, d4 atterrissait en fin
    // d'historique pendant que l'index pointait l'ancien 1.e4 — le coach
    // validait contre la mauvaise position (attendait 1...e5, refusait 1...d5).
    const next = spliceAppend([START, E4, E5], 0, D4);
    expect(next.history.map((h) => h.san)).toEqual(['', 'd4']);
    expect(next.index).toBe(1);
    // L'item pointé est bien la réplique, pas l'ancien coup.
    expect(next.history[next.index].fen).toBe('after-d4');
  });

  it('en cours de ligne (à la fin) : ajout simple', () => {
    const next = spliceAppend([START, E4], 1, E5);
    expect(next.history.map((h) => h.san)).toEqual(['', 'e4', 'e5']);
    expect(next.index).toBe(2);
  });

  it('navigation arrière : le futur abandonné est jeté', () => {
    const next = spliceAppend([START, E4, E5], 1, D4);
    expect(next.history.map((h) => h.san)).toEqual(['', 'e4', 'd4']);
    expect(next.index).toBe(2);
  });

  it('index hors bornes : clampé, jamais de trou ni d’index fantôme', () => {
    const high = spliceAppend([START, E4], 99, D4);
    expect(high.history.map((h) => h.san)).toEqual(['', 'e4', 'd4']);
    expect(high.index).toBe(2);
    const low = spliceAppend([START, E4], -5, D4);
    expect(low.history.map((h) => h.san)).toEqual(['', 'd4']);
    expect(low.index).toBe(1);
  });
});
