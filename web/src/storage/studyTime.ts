import { readRaw, writeRaw } from './storage';
import { warn } from '../utils/async';

const STORAGE_KEY = 'chess_study_time_v1';

export type StudyTimes = Record<string, number>;

/** Secondes d'entraînement cumulées par répertoire (0 si jamais étudié). */
export function loadStudyTimes(): StudyTimes {
  const raw = readRaw(STORAGE_KEY);
  if (!raw) return {};
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('Format du temps d\u2019étude invalide.');
    }
    return Object.fromEntries(
      Object.entries(value).filter(
        ([key, seconds]) =>
          key.length > 0 && typeof seconds === 'number' && Number.isFinite(seconds) && seconds > 0,
      ),
    );
  } catch (error) {
    warn('study-time:parse', error);
    return {};
  }
}

export function getStudyTime(repId: string): number {
  return loadStudyTimes()[repId] ?? 0;
}

/** Ajoute des secondes au compteur du répertoire (arrondi, jamais négatif). */
export function addStudyTime(repId: string, seconds: number): boolean {
  if (!repId || !Number.isFinite(seconds) || seconds <= 0) return false;
  const times = loadStudyTimes();
  times[repId] = Math.round((times[repId] ?? 0) + seconds);
  return writeRaw(STORAGE_KEY, JSON.stringify(times));
}
