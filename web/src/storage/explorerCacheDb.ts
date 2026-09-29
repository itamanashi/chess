import type { LichessApiResponse } from '../types/chess';

/**
 * Cache Explorer durable sur IndexedDB (quota navigateur : Go, pas Mo).
 *
 * Le localStorage (~5 Mo partagés avec la bibliothèque) ne peut pas garder
 * « chaque appel API indéfiniment » : cette couche remplace le blob JSON
 * `lichess_explorer_cache_v2` (migré une fois puis supprimé). Chaque entrée
 * réseau y est conservée sans plafond ni expiration ; la LRU mémoire de
 * `services/lichess.ts` reste le chemin rapide, avec lecture différée ici
 * en cas d'éviction mémoire.
 *
 * Toute panne (navigateur sans IndexedDB, quota extrême, base verrouillée)
 * rejette : les appelants dégradent en mémoire seule, jamais d'exception
 * visible (voir `lichessPersistHealthy` côté service).
 */

export interface ExplorerCacheRecord {
  /** Clé opaque (endpoint/cotes/filtre/FEN, construite côté service). */
  key: string;
  data: LichessApiResponse;
  savedAt: number;
}

const DB_NAME = 'chess-explorer-cache';
const DB_VERSION = 1;
const STORE = 'entries';

function factory(): IDBFactory {
  if (typeof indexedDB === 'undefined') {
    throw new Error('IndexedDB indisponible dans cet environnement.');
  }
  return indexedDB;
}

function promisify<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Requête IndexedDB rejetée.'));
  });
}

let openPromise: Promise<IDBDatabase> | null = null;

/** Ouvre (et crée au besoin) la base. Promesse mise en cache par module. */
function openDb(): Promise<IDBDatabase> {
  if (!openPromise) {
    openPromise = new Promise<IDBDatabase>((resolve, reject) => {
      let request: IDBOpenDBRequest;
      try {
        request = factory().open(DB_NAME, DB_VERSION);
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
        return;
      }
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(STORE)) {
          db.createObjectStore(STORE, { keyPath: 'key' });
        }
      };
      request.onsuccess = () => {
        const db = request.result;
        // Un autre onglet fait évoluer le schéma : on ferme pour ne pas
        // bloquer, la prochaine opération rouvre proprement.
        db.onversionchange = () => {
          db.close();
          openPromise = null;
        };
        resolve(db);
      };
      request.onerror = () => reject(request.error ?? new Error('Ouverture IndexedDB impossible.'));
    });
  }
  return openPromise;
}

async function withStore<T>(
  mode: IDBTransactionMode,
  fn: (store: IDBObjectStore) => Promise<T>,
): Promise<T> {
  const db = await openDb();
  const tx = db.transaction(STORE, mode);
  const store = tx.objectStore(STORE);
  return fn(store);
}

/** Toutes les entrées (préchargement mémoire au démarrage). */
export function idbLoadAll(): Promise<ExplorerCacheRecord[]> {
  return withStore('readonly', (store) => promisify(store.getAll()));
}

/** Une entrée par clé (lecture différée après éviction mémoire). */
export function idbGet(key: string): Promise<ExplorerCacheRecord | undefined> {
  return withStore('readonly', (store) => promisify(store.get(key)));
}

/** Écriture incrémentale (flush des seules clés modifiées). */
export function idbPutMany(records: ExplorerCacheRecord[]): Promise<void> {
  if (records.length === 0) return Promise.resolve();
  return withStore('readwrite', async (store) => {
    await Promise.all(records.map((rec) => promisify(store.put(rec))));
  });
}

/** Suppression (migration de clés obsolètes : pas d'orphelins durables). */
export function idbDeleteMany(keys: string[]): Promise<void> {
  if (keys.length === 0) return Promise.resolve();
  return withStore('readwrite', async (store) => {
    await Promise.all(keys.map((key) => promisify(store.delete(key))));
  });
}

/** Nombre d'entrées durables (diagnostic/tests). */
export function idbCount(): Promise<number> {
  return withStore('readonly', (store) => promisify(store.count()));
}
