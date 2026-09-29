import type { EngineMove } from '../types/chess';

/**
 * Cache durable des évaluations moteur sur IndexedDB.
 *
 * Permet de ne jamais recalculer une position déjà évaluée par Stockfish
 * lors d'un run précédent. Les évaluations sont indexées par FEN normalisé
 * + profondeur + MultiPV, car une même position peut être évaluée à
 * différentes profondeurs selon le contexte (premier tri vs départage).
 *
 * Toute panne (navigateur sans IndexedDB, quota extrême, base verrouillée)
 * rejette : les appelants dégradent en mémoire seule, jamais d'exception
 * visible.
 */

export interface EngineEvalRecord {
  /** Clé composite : FEN normalisé|depth|multiPv */
  key: string;
  /** Lignes moteur classées (meilleur d'abord) */
  lines: EngineMove[];
  savedAt: number;
}

const DB_NAME = 'chess-engine-eval-cache';
const DB_VERSION = 1;
const STORE = 'evaluations';

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

/** Génère une clé de cache à partir des paramètres d'évaluation */
export function engineEvalCacheKey(fen: string, depth: number, multiPv: number): string {
  return `${fen}|d${depth}|pv${multiPv}`;
}

/** Une évaluation par clé (lecture différée). */
export async function idbGetEngineEval(key: string): Promise<EngineEvalRecord | undefined> {
  try {
    return await withStore('readonly', (store) => promisify(store.get(key)));
  } catch {
    return undefined;
  }
}

/** Écriture d'une évaluation. */
export async function idbPutEngineEval(record: EngineEvalRecord): Promise<void> {
  try {
    await withStore('readwrite', (store) => promisify(store.put(record)));
  } catch {
    // Échec silencieux : dégradation en mémoire seule
  }
}

/** Écriture groupée d'évaluations. */
export async function idbPutManyEngineEval(records: EngineEvalRecord[]): Promise<void> {
  if (records.length === 0) return Promise.resolve();
  try {
    await withStore('readwrite', async (store) => {
      await Promise.all(records.map((rec) => promisify(store.put(rec))));
    });
  } catch {
    // Échec silencieux : dégradation en mémoire seule
  }
}

/** Nombre d'évaluations en cache (diagnostic). */
export async function idbCountEngineEval(): Promise<number> {
  try {
    return await withStore('readonly', (store) => promisify(store.count()));
  } catch {
    return 0;
  }
}

/** Nettoie toutes les évaluations (option utilisateur). */
export async function idbClearEngineEval(): Promise<void> {
  try {
    await withStore('readwrite', (store) => promisify(store.clear()));
  } catch {
    // Échec silencieux
  }
}
