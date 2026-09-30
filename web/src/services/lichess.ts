import type { LichessApiResponse } from '../types/chess';
import {
  abortableSleep,
  fetchWithTimeout,
  isAbortError,
  isTimeoutError,
  throwIfAborted,
  warn,
} from '../utils/async';
import { LruCache } from '../utils/lru';
import { normalizeFen } from '../utils/repertoire';
import { readRaw, removeRaw } from '../storage/storage';
import {
  idbDeleteMany,
  idbGet,
  idbLoadAll,
  idbPutMany,
  type ExplorerCacheRecord,
} from '../storage/explorerCacheDb';
import { tokenStore } from '../storage/preferences';
import {
  LICHESS_AUTH_REQUIRED,
  LICHESS_BAD_JSON,
  LICHESS_RATE_LIMITED,
  lichessNetworkError,
  lichessTimeout,
} from '../i18n';

/**
 * Cache Explorer : VRAI LRU (audit A10 — l'ancien `Map` + `slice(-N)`
 * évinçait la plus ancienne insérée, pas la moins récemment utilisée :
 * une position revisitée en boucle pouvait sauter pendant qu'un one-shot
 * restait). `get()` rafraîchit la récence.
 *
 * Durabilité : chaque appel API est conservé INDÉFINIMENT dans IndexedDB
 * (quota navigateur : Go, pas Mo — aucun plafond, aucune expiration). La
 * LRU mémoire (2000) reste le chemin rapide ; une entrée évincée de la
 * mémoire est relue depuis IndexedDB avant tout appel réseau (read-through).
 *
 * CLÉ NORMALISÉE (4 champs FEN, comme `db_cache.py`) : les compteurs
 * demi-coup/coup et l'EP fantôme ne changent pas la position — deux FEN ne
 * différant que par eux partagent UNE entrée. Les clés écrites avant cette
 * normalisation (FEN complet) sont migrées au préchargement (réécrites sous
 * la clé canonique, anciennes supprimées) + repli lecture sur l'ancien
 * format en cas de manqué.
 *
 * COORDONNÉE AVEC LE CACHE PYTHON : Non. Ce cache navigateur est indépendant
 * du db_cache.py SQLite. Les clés ne sont pas compatibles entre les deux environnements.
 * - db_cache.py: pos_key() sur 4 champs FEN (python-chess behavior)
 * - lichess.ts: mémoire LRU + IndexedDB SANS expiration, clés incluant
 *   db/ratings/speeds/since paramètres.
 * Rate limit 25/min : la logique backoff/retry est contenue dans fetchWithRetry.
 * Ne pas supposer que les entrées en cache couvrent les requêtes Python.
 */
interface CachedEntry {
  data: LichessApiResponse;
  /** Date d'enregistrement (info diagnostique ; aucune expiration). */
  savedAt: number;
}

const CACHE_MEMORY_CAPACITY = 2000;
const CACHE_LICHESS = new LruCache<string, CachedEntry>(CACHE_MEMORY_CAPACITY);
let persistHealthy = true;
let cacheReadHealthy = true;
let cacheReadFailureLogged = false;

export interface LichessMovesCacheResult {
  data: LichessApiResponse;
  source: 'memory' | 'indexeddb' | 'network';
  /** Timestamp of the most recent HTTP attempt; used to pace retries safely. */
  networkStartedAtMs?: number;
}

function markCacheReadFailed(err: unknown): void {
  cacheReadHealthy = false;
  if (!cacheReadFailureLogged) {
    cacheReadFailureLogged = true;
    warn('lichess:read', err);
  }
}

/**
 * Single-flight (audit A10) : les requêtes identiques en vol partagent UNE
 * promesse (builder + piège sur la même position = 1 seul appel réseau).
 * Erreurs non mises en cache : un nouvel appel retente.
 */
const INFLIGHT = new Map<string, Promise<LichessMovesCacheResult>>();

const DEFAULT_SPEEDS = 'blitz,rapid,classical';

/** Clé du blob localStorage historique (migré vers IndexedDB puis supprimé). */
const LS_KEY = 'lichess_explorer_cache_v2';

/**
 * Flush au plus toutes les 15 s + à la sortie de page + toutes les
 * 25 insertions + en fin de run auto. Incrémental (seules les clés
 * modifiées sont écrites) : un onglet tué ne perd que la queue.
 */
const PERSIST_IDLE_MS = 15000;
let persistTimer: ReturnType<typeof setTimeout> | null = null;
let persistWired = false;
/** Clés réseau écrites depuis le dernier flush (jamais réécrites inutilement). */
const dirtyKeys = new Set<string>();

/**
 * Préchargement durable (mémoire ← IndexedDB) + migration one-shot de
 * l'ancien blob localStorage (puis suppression : libère le quota pour la
 * bibliothèque). Lancé à l'import, attendu par les lectures manquées.
 * Aucune expiration : toute entrée est reprise quel que soit son âge.
 */
async function preloadExplorerCache(): Promise<void> {
  let migrated: ExplorerCacheRecord[] = [];
  try {
    const raw = readRaw(LS_KEY);
    if (raw) {
      const obj = JSON.parse(raw) as Record<string, { data?: LichessApiResponse; savedAt?: number }>;
      migrated = Object.entries(obj)
        .filter(([, v]) => v && v.data)
        .map(([key, v]) => ({
          key,
          data: v.data as LichessApiResponse,
          savedAt: typeof v.savedAt === 'number' ? v.savedAt : Date.now(),
        }));
    }
  } catch {
    /* stockage indisponible ou corrompu : on ignore */
  }
  if (migrated.length > 0) {
    const canon = migrated.map((rec) => {
      const key = canonicalExplorerKey(rec.key) ?? rec.key;
      return key === rec.key ? rec : { key, data: rec.data, savedAt: rec.savedAt };
    });
    for (const rec of canon) {
      CACHE_LICHESS.set(rec.key, { data: rec.data, savedAt: rec.savedAt });
    }
    try {
      await idbPutMany(canon);
      removeRaw(LS_KEY);
    } catch (err) {
      persistHealthy = false;
      warn('lichess:migrate', err);
    }
  }
  removeRaw('lichess_explorer_cache_v1');
  let all: ExplorerCacheRecord[];
  try {
    all = await idbLoadAll();
    cacheReadHealthy = true;
  } catch (err) {
    markCacheReadFailed(err);
    throw err;
  }
  const rewrites: ExplorerCacheRecord[] = [];
  const staleKeys: string[] = [];
  for (const rec of all) {
    const canonical = canonicalExplorerKey(rec.key);
    const key = canonical ?? rec.key;
    if (canonical && canonical !== rec.key) {
      // Ancienne clé (FEN complet) : promeut vers la canonique, sans doublon.
      rewrites.push({ key, data: rec.data, savedAt: rec.savedAt });
      staleKeys.push(rec.key);
    }
    if (!CACHE_LICHESS.has(key)) {
      CACHE_LICHESS.set(key, { data: rec.data, savedAt: rec.savedAt });
    }
  }
  if (rewrites.length > 0) {
    try {
      await idbPutMany(rewrites);
      await idbDeleteMany(staleKeys);
    } catch {
      /* IDB indisponible : mémoire seule, on réessaiera au prochain démarrage */
    }
  }
}

let preloadPromise: Promise<void> | null = null;
/** Résolue quand le cache durable est chargé (tests + attente des manqués). */
export function explorerCacheReady(): Promise<void> {
  if (!preloadPromise) {
    preloadPromise = preloadExplorerCache().catch((err: unknown) => {
      markCacheReadFailed(err);
    });
  }
  return preloadPromise;
}
void explorerCacheReady();

/**
 * Écrit les seules clés modifiées. Résout false en cas d'échec (IDB
 * indisponible, quota extrême...) : le cache mémoire reste actif et la
 * prochaine écriture réessaiera (clés conservées). Jamais d'exception.
 */
export async function flushLichessPersist(): Promise<boolean> {
  if (dirtyKeys.size === 0) return true;
  const keys = [...dirtyKeys];
  try {
    const records: ExplorerCacheRecord[] = [];
    for (const k of keys) {
      const entry = CACHE_LICHESS.peek(k);
      if (entry) records.push({ key: k, data: entry.data, savedAt: entry.savedAt });
    }
    if (records.length > 0) await idbPutMany(records);
    for (const k of keys) dirtyKeys.delete(k);
    insertsSinceFlush = 0;
    persistHealthy = true;
    return true;
  } catch (err) {
    warn('lichess:persist', err);
    persistHealthy = false;
    return false;
  }
}

function ensurePersistWiring(): void {
  if (persistWired || typeof window === 'undefined') return;
  persistWired = true;
  const flush = (): void => {
    void flushLichessPersist();
  };
  window.addEventListener('pagehide', flush);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flush();
  });
}

/** Marque le cache comme à sauvegarder (flush différé + sortie de page). */
function markDirtyPersist(): void {
  ensurePersistWiring();
  if (persistTimer || typeof window === 'undefined') return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    void flushLichessPersist();
  }, PERSIST_IDLE_MS);
}

/**
 * Flush toutes les N insertions réseau : un onglet tué (freeze, crash,
 * fermeture brutale) ne déclenche pas `pagehide` — sans flush périodique,
 * toute la session de batch était perdue et le cache semblait « supprimé ».
 * Incrémental donc quasi gratuit (quelques puts), négligeable face aux
 * 600 ms de pause inter-requêtes. (Le test « coalesces bursts » verrouille
 * toujours l'absence d'écriture pour les micro-rafales < 25.)
 */
const FLUSH_EVERY_INSERTS = 25;
let insertsSinceFlush = 0;

/** Nombre de positions en cache mémoire (rempli par préchargement + session). */
export function lichessCacheMemorySize(): number {
  return CACHE_LICHESS.size;
}

/** Disponibilité des lectures et écritures durables, affichée dans le panneau. */
export function lichessPersistHealthy(): boolean {
  return persistHealthy && cacheReadHealthy;
}

function lichessCacheKey(
  fen: string,
  db: 'masters' | 'lichess',
  ratings?: string,
  speeds?: string,
  since?: number,
): string {
  // FEN normalisé (4 champs : compteurs et EP fantôme ignorés, comme le
  // cache Python) : une même position = UNE entrée, quel que soit le
  // compteur de coups du chemin qui y mène (transpositions).
  return `${db}:${ratings || 'all'}:${speeds || DEFAULT_SPEEDS}:${since ?? ''}:${normalizeFen(fen)}`;
}

/** Ancien format (FEN complet) : repli lecture pour les entrées déjà écrites. */
function legacyLichessCacheKey(
  fen: string,
  db: 'masters' | 'lichess',
  ratings?: string,
  speeds?: string,
  since?: number,
): string {
  return `${db}:${ratings || 'all'}:${speeds || DEFAULT_SPEEDS}:${since ?? ''}:${fen}`;
}

/**
 * Canonise une clé stockée (ancien FEN complet → FEN normalisé). Null si
 * format inconnu (laissée telle quelle).
 */
function canonicalExplorerKey(storedKey: string): string | null {
  const parts = storedKey.split(':');
  if (parts.length < 5) return null;
  const [db, ratings, speeds, since, ...fenParts] = parts;
  if (db !== 'masters' && db !== 'lichess') return null;
  const fen = fenParts.join(':');
  return `${db}:${ratings}:${speeds}:${since}:${normalizeFen(fen)}`;
}

/** Vrai si la position est déjà en cache mémoire (aucune requête nécessaire). */
export function hasLichessCache(
  fen: string,
  db: 'masters' | 'lichess' = 'masters',
  ratings?: string,
  speeds: string = DEFAULT_SPEEDS,
  since?: number,
): boolean {
  return CACHE_LICHESS.has(lichessCacheKey(fen, db, ratings, speeds, since));
}

export interface LichessFetchOptions {
  /** Annule la requête (changement de position / démontage / nouvelle requête). */
  signal?: AbortSignal;
  /**
   * Filtre temporel, année incluse (endpoint Masters : spec officielle,
   * défaut serveur 1952). Fait partie de la clé de cache : deux `since`
   * différents = deux entrées (pas de collision filtré/non filtré).
   */
  since?: number;
  /** Budget par tentative en ms (défaut 15 s). */
  timeoutMs?: number;
  /** Tentatives après la première sur échec transient (défaut 2). */
  maxRetries?: number;
  /** Premier délai de backoff en ms, doublé par retry (défaut 500). */
  backoffBaseMs?: number;
}

const DEFAULT_TIMEOUT_MS = 15000;
const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_BACKOFF_BASE_MS = 500;
/** Plafond d'attente sur Retry-After serveur (au-delà : backoff local). */
const MAX_RETRY_AFTER_MS = 30000;

/** Délai avant retry : Retry-After serveur si présent et raisonnable, sinon backoff local. */
function retryDelayMs(response: Response, attempt: number, backoffBaseMs: number): number {
  const header = response.headers.get('Retry-After');
  if (header !== null) {
    const seconds = Number.parseInt(header.trim(), 10);
    if (Number.isFinite(seconds) && seconds > 0) {
      return Math.min(seconds * 1000, MAX_RETRY_AFTER_MS);
    }
  }
  return backoffBaseMs * 2 ** attempt;
}

export async function fetchLichessMoves(
  fen: string,
  token?: string,
  db: 'masters' | 'lichess' = 'masters',
  ratings?: string,
  speeds: string = DEFAULT_SPEEDS,
  opts?: LichessFetchOptions
): Promise<LichessApiResponse> {
  const result = await fetchLichessMovesWithCacheStatus(fen, token, db, ratings, speeds, opts);
  return result.data;
}

export async function fetchLichessMovesWithCacheStatus(
  fen: string,
  token?: string,
  db: 'masters' | 'lichess' = 'masters',
  ratings?: string,
  speeds: string = DEFAULT_SPEEDS,
  opts?: LichessFetchOptions
): Promise<LichessMovesCacheResult> {
  const cacheKey = lichessCacheKey(fen, db, ratings, speeds, opts?.since);
  const hit = CACHE_LICHESS.get(cacheKey);
  if (hit) {
    return { data: hit.data, source: 'memory' };
  }
  // Lecture différée durable : une entrée évincée de la LRU (ou arrivée
  // avant la fin du préchargement) reste disponible sans réseau. Le
  // préchargement est attendu ici (promesse résolue après chauffe : coût
  // d'une microtask par manqué).
  try {
    await explorerCacheReady();
    const stored = await idbGet(cacheKey);
    cacheReadHealthy = true;
    if (stored) {
      if (!CACHE_LICHESS.has(cacheKey)) {
        CACHE_LICHESS.set(cacheKey, { data: stored.data, savedAt: stored.savedAt });
      }
      return { data: stored.data, source: 'indexeddb' };
    }
    // Repli migration : entrée écrite avant la normalisation des clés
    // (FEN complet). Promotion vers la clé canonique (persistée au prochain
    // flush) ; l'ancienne clé est volontairement conservée ici (jamais de
    // suppression avant persistance — anti-perte) : le préchargement du
    // prochain démarrage la nettoiera après réécriture.
    const legacyKey = legacyLichessCacheKey(fen, db, ratings, speeds, opts?.since);
    if (legacyKey !== cacheKey) {
      const legacy = await idbGet(legacyKey);
      cacheReadHealthy = true;
      if (legacy) {
        CACHE_LICHESS.set(cacheKey, { data: legacy.data, savedAt: legacy.savedAt });
        dirtyKeys.add(cacheKey);
        markDirtyPersist();
        return { data: legacy.data, source: 'indexeddb' };
      }
    }
  } catch (err) {
    markCacheReadFailed(err);
    /* IDB indisponible : on passe au réseau */
  }
  // Single-flight : une clé en vol = une seule requête partagée.
  const flying = INFLIGHT.get(cacheKey);
  if (flying) {
    return flying;
  }
  const p = fetchWithRetry(fen, token, db, ratings, speeds, opts).then(
    ({ data, lastRequestStartedAtMs }) => {
      // Tout succès entre au cache, y compris moves:[] : un 200 vide est
      // une réponse autoritaire ("aucune partie"), pas une erreur (seules
      // les erreurs sont exclues, comme db_cache.py). Ne pas le mettre en
      // cache re-demanderait la position à chaque render (budget 25/min).
      // Conservé indéfiniment : mémoire LRU 2000 + IndexedDB sans plafond.
      CACHE_LICHESS.set(cacheKey, { data, savedAt: Date.now() });
      dirtyKeys.add(cacheKey);
      markDirtyPersist();
      insertsSinceFlush++;
      if (insertsSinceFlush >= FLUSH_EVERY_INSERTS) {
        // Sauvegarde anti-perte : un onglet tué avant le timer de 15 s ne
        // perd au pire que les 25 dernières positions, pas la session.
        void flushLichessPersist();
      }
      INFLIGHT.delete(cacheKey);
      return {
        data,
        source: 'network' as const,
        networkStartedAtMs: lastRequestStartedAtMs,
      };
    },
    (err: unknown) => {
      INFLIGHT.delete(cacheKey);
      throw err;
    },
  );
  INFLIGHT.set(cacheKey, p);
  return p;
}

/**
 * Une requête + retries. Transient = timeout réseau, erreur réseau, 429,
 * 5xx (avec Retry-After honoré). Terminal = abort (propage), 401, autres
 * 4xx, JSON illisible. Seuls les succès entrent au cache (jamais d'erreur).
 */
async function fetchWithRetry(
  fen: string,
  token: string | undefined,
  db: 'masters' | 'lichess',
  ratings: string | undefined,
  speeds: string,
  opts: LichessFetchOptions | undefined,
): Promise<{ data: LichessApiResponse; lastRequestStartedAtMs: number }> {
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxRetries = opts?.maxRetries ?? DEFAULT_MAX_RETRIES;
  const backoffBaseMs = opts?.backoffBaseMs ?? DEFAULT_BACKOFF_BASE_MS;
  const signal = opts?.signal;

  let url = '';
  if (db === 'masters') {
    url = `https://explorer.lichess.ovh/masters?fen=${encodeURIComponent(fen)}&moves=12`;
    if (opts?.since !== undefined) {
      url += `&since=${opts.since}`;
    }
  } else {
    url = `https://explorer.lichess.ovh/lichess?fen=${encodeURIComponent(fen)}&moves=12&speeds=${speeds}`;
    if (ratings) {
      url += `&ratings=${ratings}`;
    }
  }

  const headers: Record<string, string> = {
    'Accept': 'application/json',
  };

  const authToken = token || tokenStore.get();
  if (authToken) {
    headers['Authorization'] = `Bearer ${authToken.trim()}`;
  }

  let attempt = 0;
  let lastRequestStartedAtMs = Date.now();
  for (;;) {
    throwIfAborted(signal);
    let response: Response;
    try {
      lastRequestStartedAtMs = Date.now();
      response = await fetchWithTimeout(url, { headers, signal }, timeoutMs);
    } catch (err) {
      // Annulation volontaire : on la propage telle quelle (les appelants l'ignorent).
      if (signal?.aborted || isAbortError(err)) throw err;
      const timedOut = isTimeoutError(err);
      if (attempt < maxRetries) {
        attempt++;
        await abortableSleep(backoffBaseMs * 2 ** (attempt - 1), signal);
        continue;
      }
      throw new Error(
        timedOut
          ? lichessTimeout(timeoutMs)
          : lichessNetworkError(err instanceof Error ? err.message : String(err)),
      );
    }

    if (response.status === 401) {
      throw new Error(LICHESS_AUTH_REQUIRED);
    }

    if (response.status === 429 || response.status >= 500) {
      if (attempt < maxRetries) {
        attempt++;
        await abortableSleep(retryDelayMs(response, attempt - 1, backoffBaseMs), signal);
        continue;
      }
      if (response.status === 429) {
        throw new Error(LICHESS_RATE_LIMITED);
      }
      throw new Error(`Erreur HTTP ${response.status} de l'API Lichess.`);
    }

    if (!response.ok) {
      throw new Error(`Erreur HTTP ${response.status} de l'API Lichess.`);
    }

    try {
      const data = (await response.json()) as LichessApiResponse;
      return { data, lastRequestStartedAtMs };
    } catch (err) {
      if (signal?.aborted || isAbortError(err)) throw err;
      throw new Error(LICHESS_BAD_JSON);
    }
  }
}
