/**
 * Moment de la journée d'une partie (heure LOCALE du navigateur : c'est
 * l'heure à laquelle vous avez joué qui compte, pas UTC).
 *
 * Tranches : Matin 6h–12h, Après-midi 12h–18h, Soir 18h–0h, Nuit 0h–6h.
 * Aucun moteur requis pour les résultats ; la précision vient des parties
 * analysées (g.accuracy), comme les autres panneaux.
 */

export type DaySlot = 'morning' | 'afternoon' | 'evening' | 'night';

export const DAY_SLOT_ORDER: DaySlot[] = ['morning', 'afternoon', 'evening', 'night'];

export const DAY_SLOT_LABEL: Record<DaySlot, string> = {
  morning: 'Matin',
  afternoon: 'Après-midi',
  evening: 'Soir',
  night: 'Nuit',
};

export const DAY_SLOT_SHORT: Record<DaySlot, string> = {
  morning: 'Matin',
  afternoon: 'Après-m.',
  evening: 'Soir',
  night: 'Nuit',
};

/** Plage horaire locale de la tranche (affichage). */
export const DAY_SLOT_RANGE: Record<DaySlot, string> = {
  morning: '6h–12h',
  afternoon: '12h–18h',
  evening: '18h–0h',
  night: '0h–6h',
};

/** Tranche à partir de l'heure locale (0–23). Bornes : 6h / 12h / 18h / 0h. */
export function slotOfHour(hour: number): DaySlot {
  const h = Math.floor(hour);
  if (h >= 6 && h < 12) return 'morning';
  if (h >= 12 && h < 18) return 'afternoon';
  if (h >= 18 && h < 24) return 'evening';
  return 'night';
}

/** Tranche d'une fin de partie (secondes Unix → heure locale). */
export function slotOfEndTime(endTimeSec: number): DaySlot {
  return slotOfHour(new Date(endTimeSec * 1000).getHours());
}

export type DaytimeOutcome = 'win' | 'draw' | 'loss';

export interface DaytimeGameInput {
  /** Fin de partie en secondes Unix (0/absent = inconnu). */
  endTime: number;
  outcome: DaytimeOutcome;
  /** Précision du compte lié (absente si partie non analysée). */
  accuracy?: number | null;
}

export interface DaytimeSlotStat {
  games: number;
  wins: number;
  draws: number;
  losses: number;
  accSum: number;
  accN: number;
}

export interface DaytimeStats {
  /** Parties à heure lisible (les sans-horodatage sont dans `unknown`). */
  total: number;
  /** Parties sans horodatage exploitable. */
  unknown: number;
  /** Bilan par moment de la journée. */
  bySlot: Record<DaySlot, DaytimeSlotStat>;
}

export function emptyDaytimeSlot(): DaytimeSlotStat {
  return { games: 0, wins: 0, draws: 0, losses: 0, accSum: 0, accN: 0 };
}

export function emptyDaytimeStats(): DaytimeStats {
  const bySlot = {} as Record<DaySlot, DaytimeSlotStat>;
  for (const s of DAY_SLOT_ORDER) bySlot[s] = emptyDaytimeSlot();
  return { total: 0, unknown: 0, bySlot };
}

/** Agrège les parties (horodatage + issue connue) par moment de la journée. */
export function computeDaytimeStats(items: DaytimeGameInput[]): DaytimeStats {
  const stats = emptyDaytimeStats();
  for (const item of items) {
    if (!item.endTime || !Number.isFinite(item.endTime)) {
      stats.unknown++;
      continue;
    }
    const row = stats.bySlot[slotOfEndTime(item.endTime)];
    stats.total++;
    row.games++;
    if (item.outcome === 'win') row.wins++;
    else if (item.outcome === 'draw') row.draws++;
    else row.losses++;
    if (typeof item.accuracy === 'number' && Number.isFinite(item.accuracy)) {
      row.accSum += item.accuracy;
      row.accN++;
    }
  }
  return stats;
}

/** Précision moyenne de la tranche (null si aucune partie notée). */
export function daytimeAccuracy(row: DaytimeSlotStat): number | null {
  return row.accN > 0 ? row.accSum / row.accN : null;
}
