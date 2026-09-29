import type { RepertoireItem } from '../types/chess';

/** Copie durable de la bibliothèque dans IndexedDB, hors quota localStorage. */
const DB_NAME = 'chess-repertoire-library';
const DB_VERSION = 1;
const STORE = 'library';
const LIBRARY_RECORD_KEY = 'current';

interface LibraryRecord {
  key: string;
  items: RepertoireItem[];
}

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
    }).catch((err: unknown) => {
      openPromise = null;
      throw err;
    });
  }
  return openPromise;
}

async function withStore<T>(
  mode: IDBTransactionMode,
  fn: (store: IDBObjectStore) => Promise<T>,
): Promise<T> {
  const db = await openDb();
  return fn(db.transaction(STORE, mode).objectStore(STORE));
}

export async function idbLoadLibrary(): Promise<RepertoireItem[] | null> {
  const record = await withStore('readonly', (store) =>
    promisify(store.get(LIBRARY_RECORD_KEY)),
  ) as LibraryRecord | undefined;
  return record?.items ?? null;
}

export function idbSaveLibrary(items: RepertoireItem[]): Promise<void> {
  return withStore('readwrite', async (store) => {
    await promisify(store.put({ key: LIBRARY_RECORD_KEY, items } satisfies LibraryRecord));
  });
}
