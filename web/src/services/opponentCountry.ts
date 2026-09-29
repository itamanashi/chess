import { fetchPlayer, normalizeUsername } from './chesscom';
import { isAbortError, mapWithConcurrency, throwIfAborted } from '../utils/async';
import { readRaw, writeRaw } from '../storage/storage';

/**
 * Pays des adversaires : absents des parties, ils se résolvent via le profil
 * public (`fetchPlayer` → `country`, code alpha-2 en queue d'URL).
 *
 * Une requête par adversaire UNIQUE seulement : le résultat est persisté en
 * localStorage (pseudo minuscule → alpha-2, '' = sans pays/résolu-vide) et
 * ne repart jamais sur le réseau. Chargement explicite, concurrence bornée
 * et annulable (même discipline que `fetchAllGames`).
 */

const CACHE_KEY = 'chesscom_opp_country_v1';
/** Garde-fou : au-delà, on oublie la moitié la plus ancienne. */
const CACHE_CAP = 8000;
const CONCURRENCY = 4;

/** Pseudo normalisé → alpha-2 ('…' = connu-sans-pays, absent = à charger). */
export type OpponentCountryMap = Record<string, string>;

function readCache(): OpponentCountryMap {
  try {
    const raw = readRaw(CACHE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: OpponentCountryMap = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof k === 'string' && typeof v === 'string') out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

function writeCache(map: OpponentCountryMap): void {
  try {
    const keys = Object.keys(map);
    const trimmed: OpponentCountryMap =
      keys.length > CACHE_CAP
        ? Object.fromEntries(keys.slice(keys.length - CACHE_CAP).map((k) => [k, map[k]]))
        : map;
    writeRaw(CACHE_KEY, JSON.stringify(trimmed));
  } catch {
    /* quota plein : le cache de session reste, tant pis */
  }
}

/** Cache persistant (lecture immédiate, sans réseau). */
export function getCountryCache(): OpponentCountryMap {
  return readCache();
}

/** Pays en cache pour `username` (null = jamais résolu). */
export function cachedCountry(cache: OpponentCountryMap, username: string): string | null {
  const key = normalizeUsername(username);
  if (!key) return '';
  return Object.hasOwn(cache, key) ? cache[key] : null;
}

export interface CountryLoadProgress {
  done: number;
  total: number;
}

export interface CountryLoadResult {
  /** Cache complet après chargement (à conserver côté appelant). */
  cache: OpponentCountryMap;
  /** Adversaires résolus pendant cet appel. */
  resolved: number;
  /** Adversaires en échec (isolés : comptés comme sans pays pour la session). */
  failed: number;
}

export interface CountryLoadOptions {
  signal?: AbortSignal;
  concurrency?: number;
  onProgress?: (p: CountryLoadProgress) => void;
}

/**
 * Résout les pays des pseudos inconnus du cache. Chaque échec est isolé
 * (adversaire compté « sans pays », sans annuler les autres) ; seule
 * l'annulation appelante interrompt tout.
 */
export async function loadOpponentCountries(
  usernames: string[],
  opts: CountryLoadOptions = {},
): Promise<CountryLoadResult> {
  throwIfAborted(opts.signal);
  const cache = readCache();
  const queue = [...new Set(usernames.map(normalizeUsername))].filter(
    (u) => u && !Object.hasOwn(cache, u),
  );
  const report = (done: number): void => {
    try {
      opts.onProgress?.({ done, total: queue.length });
    } catch {
      /* listener must never break the run */
    }
  };
  report(0);
  let done = 0;
  let failed = 0;
  await mapWithConcurrency(queue, opts.concurrency ?? CONCURRENCY, async (user): Promise<void> => {
    try {
      const profile = await fetchPlayer(user, { signal: opts.signal });
      const code = (profile.country ?? '').trim().toUpperCase();
      cache[user] = /^[A-Z]{2}$/.test(code) ? code : '';
    } catch (err) {
      if (isAbortError(err)) throw err;
      failed++;
      cache[user] = '';
    } finally {
      done++;
      report(done);
    }
  });
  throwIfAborted(opts.signal);
  writeCache(cache);
  return { cache, resolved: queue.length - failed, failed };
}
