import {
  daytimeAccuracy,
  emptyDaytimeSlot,
  type DaytimeGameInput,
  type DaytimeSlotStat,
} from './daytime';

/**
 * Jour de la semaine d'une partie (heure LOCALE du navigateur, semaine
 * commençant le lundi comme en France). Réutilise la forme d'entrée et de
 * bilan de `daytime` (horodatage + issue + précision optionnelle).
 */

export type Weekday = 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun';

/** Ordre d'affichage : lundi en premier. */
export const WEEKDAY_ORDER: Weekday[] = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];

export const WEEKDAY_LABEL: Record<Weekday, string> = {
  mon: 'Lundi',
  tue: 'Mardi',
  wed: 'Mercredi',
  thu: 'Jeudi',
  fri: 'Vendredi',
  sat: 'Samedi',
  sun: 'Dimanche',
};

export const WEEKDAY_SHORT: Record<Weekday, string> = {
  mon: 'Lun.',
  tue: 'Mar.',
  wed: 'Mer.',
  thu: 'Jeu.',
  fri: 'Ven.',
  sat: 'Sam.',
  sun: 'Dim.',
};

/** Une couleur par jour, dans la palette neutre de l'échiquier. */
export const WEEKDAY_COLORS: Record<Weekday, string> = {
  mon: '#d8d2c6',
  tue: '#b58863',
  wed: '#9a9488',
  thu: '#5c4632',
  fri: '#ead9b5',
  sat: '#7d9a7e',
  sun: '#6f6a60',
};

/** getDay() (0 = dimanche) → jour semaine commençant lundi. */
const FROM_GET_DAY: Record<number, Weekday> = {
  0: 'sun',
  1: 'mon',
  2: 'tue',
  3: 'wed',
  4: 'thu',
  5: 'fri',
  6: 'sat',
};

export function weekdayOfDate(d: Date): Weekday {
  return FROM_GET_DAY[d.getDay()] ?? 'mon';
}

/** Jour d'une fin de partie (secondes Unix → heure locale). */
export function weekdayOfEndTime(endTimeSec: number): Weekday {
  return weekdayOfDate(new Date(endTimeSec * 1000));
}

export interface WeekdayStats {
  /** Parties à heure lisible (les sans-horodatage sont dans `unknown`). */
  total: number;
  /** Parties sans horodatage exploitable. */
  unknown: number;
  /** Bilan par jour de la semaine. */
  byDay: Record<Weekday, DaytimeSlotStat>;
}

export function emptyWeekdayStats(): WeekdayStats {
  const byDay = {} as Record<Weekday, DaytimeSlotStat>;
  for (const d of WEEKDAY_ORDER) byDay[d] = emptyDaytimeSlot();
  return { total: 0, unknown: 0, byDay };
}

/** Agrège les parties (horodatage + issue connue) par jour de la semaine. */
export function computeWeekdayStats(items: DaytimeGameInput[]): WeekdayStats {
  const stats = emptyWeekdayStats();
  for (const item of items) {
    if (!item.endTime || !Number.isFinite(item.endTime)) {
      stats.unknown++;
      continue;
    }
    const row = stats.byDay[weekdayOfEndTime(item.endTime)];
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

/** Précision moyenne du jour (null si aucune partie notée). */
export function weekdayAccuracy(row: DaytimeSlotStat): number | null {
  return daytimeAccuracy(row);
}
