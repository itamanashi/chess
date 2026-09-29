import { warn } from '../utils/async';

/**
 * Accès bas niveau au localStorage — POINT DE PASSAGE UNIQUE.
 *
 * Tout le module `storage/` (repository, préférences, caches) passe par ici :
 * plus aucun `localStorage.getItem/setItem` dispersé dans les composants ou
 * services. Les échecs (navigation privée, quota dépassé, JSON corrompu) ne
 * lèvent jamais : lecture → `null`, écriture → `false`, avec journalisation
 * contrôlée. C'est l'appelant métier qui décide de la visibilité (toast…).
 */

export function readRaw(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch (err) {
    warn(`storage:read:${key}`, err);
    return null;
  }
}

export function writeRaw(key: string, value: string): boolean {
  try {
    localStorage.setItem(key, value);
    return true;
  } catch (err) {
    warn(`storage:write:${key}`, err);
    return false;
  }
}

export function removeRaw(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch (err) {
    warn(`storage:remove:${key}`, err);
  }
}
