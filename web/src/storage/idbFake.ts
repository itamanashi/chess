/**
 * Faux IndexedDB en mémoire pour vitest (l'environnement node n'a pas
 * d'IndexedDB). Couvre juste la surface utilisée par
 * `storage/explorerCacheDb.ts` : open (+upgrade), transaction, get, getAll,
 * put (keyPath `key`), delete, count. Résolution asynchrone comme le vrai.
 *
 * Usage : `vi.stubGlobal('indexedDB', createFakeIndexedDB().fake)` puis
 * `vi.unstubAllGlobals()` en afterEach (ou un faux frais par test pour
 * isoler les données).
 */

export interface FakeIdbOptions {
  /** Les puts rejettent (simule un quota/disque en panne). */
  failPuts?: boolean;
  /** L'ouverture rejette (navigateur sans IndexedDB, base verrouillée). */
  failOpen?: boolean;
  /** Les valeurs sérialisées au-delà de cette taille rejettent (quota serré). */
  maxValueBytes?: number;
  /** Retarde le commit simulé pour vérifier l'attente de la transaction. */
  transactionCompleteDelayMs?: number;
}

interface FakeDbEntry {
  version: number;
  stores: Map<string, Map<unknown, unknown>>;
}

export function createFakeIndexedDB(opts: FakeIdbOptions = {}): {
  fake: unknown;
  stats: { opens: number; puts: number; gets: number };
} {
  const databases = new Map<string, FakeDbEntry>();
  const stats = { opens: 0, puts: 0, gets: 0 };

  const asyncErr = (req: Record<string, unknown>, error: unknown): void => {
    queueMicrotask(() => {
      req['error'] = error;
      (req['onerror'] as ((ev: unknown) => void) | null)?.({ target: req });
    });
  };

  const storeApi = (
    entry: FakeDbEntry,
    storeName: string,
    tx?: Record<string, unknown>,
  ): Record<string, unknown> => {
    const mapOf = (): Map<unknown, unknown> => {
      const m = entry.stores.get(storeName);
      if (!m) throw new Error(`no such object store: ${storeName}`);
      return m;
    };
    return {
      get: (key: unknown): Record<string, unknown> => {
        const req: Record<string, unknown> = { onsuccess: null, onerror: null };
        stats.gets++;
        queueMicrotask(() => {
          try {
            req['result'] = mapOf().get(key);
            (req['onsuccess'] as ((ev: unknown) => void) | null)?.({ target: req });
          } catch (e) {
            asyncErr(req, e);
          }
        });
        return req;
      },
      getAll: (): Record<string, unknown> => {
        const req: Record<string, unknown> = { onsuccess: null, onerror: null };
        queueMicrotask(() => {
          try {
            req['result'] = [...mapOf().values()];
            (req['onsuccess'] as ((ev: unknown) => void) | null)?.({ target: req });
          } catch (e) {
            asyncErr(req, e);
          }
        });
        return req;
      },
      put: (value: unknown): Record<string, unknown> => {
        const req: Record<string, unknown> = { onsuccess: null, onerror: null };
        stats.puts++;
        queueMicrotask(() => {
          try {
            if (opts.failPuts) throw new Error('put failed (simulated)');
            if (opts.maxValueBytes != null && JSON.stringify(value).length > opts.maxValueBytes) {
              throw new DOMException('quota', 'QuotaExceededError');
            }
            const rec = value as { key?: unknown };
            if (rec == null || rec.key === undefined) throw new Error('put without keyPath key');
            mapOf().set(rec.key, value);
            req['result'] = rec.key;
            (req['onsuccess'] as ((ev: unknown) => void) | null)?.({ target: req });
            if (tx) {
              setTimeout(() => {
                (tx['oncomplete'] as ((ev: unknown) => void) | null)?.({ target: tx });
              }, opts.transactionCompleteDelayMs ?? 0);
            }
          } catch (e) {
            asyncErr(req, e);
          }
        });
        return req;
      },
      count: (): Record<string, unknown> => {
        const req: Record<string, unknown> = { onsuccess: null, onerror: null };
        queueMicrotask(() => {
          try {
            req['result'] = mapOf().size;
            (req['onsuccess'] as ((ev: unknown) => void) | null)?.({ target: req });
          } catch (e) {
            asyncErr(req, e);
          }
        });
        return req;
      },
      delete: (key: unknown): Record<string, unknown> => {
        const req: Record<string, unknown> = { onsuccess: null, onerror: null };
        queueMicrotask(() => {
          try {
            mapOf().delete(key);
            req['result'] = undefined;
            (req['onsuccess'] as ((ev: unknown) => void) | null)?.({ target: req });
          } catch (e) {
            asyncErr(req, e);
          }
        });
        return req;
      },
    };
  };

  const fake = {
    open: (name: string, version?: number): Record<string, unknown> => {
      const req: Record<string, unknown> = { onsuccess: null, onerror: null, onupgradeneeded: null };
      stats.opens++;
      queueMicrotask(() => {
        try {
          if (opts.failOpen) throw new Error('open failed (simulated)');
          const want = version ?? 1;
          let entry = databases.get(name);
          if (!entry) {
            entry = { version: 0, stores: new Map() };
            databases.set(name, entry);
          }
          const current = entry;
          const db: Record<string, unknown> = {
            objectStoreNames: { contains: (s: string) => current.stores.has(s) },
            createObjectStore: (s: string) => {
              if (!current.stores.has(s)) current.stores.set(s, new Map());
              return storeApi(current, s);
            },
            transaction: (names: string | string[]) => {
              const list = Array.isArray(names) ? names : [names];
              const tx: Record<string, unknown> = {
                objectStore: (s: string) => {
                  if (!list.includes(s)) throw new Error(`not in transaction: ${s}`);
                  return storeApi(current, s, tx);
                },
                oncomplete: null,
                onerror: null,
                onabort: null,
              };
              return tx;
            },
            close: () => {},
            onversionchange: null,
            onclose: null,
          };
          if (want > current.version) {
            current.version = want;
            req['result'] = db;
            (req['onupgradeneeded'] as ((ev: unknown) => void) | null)?.({ target: req });
          }
          req['result'] = db;
          (req['onsuccess'] as ((ev: unknown) => void) | null)?.({ target: req });
        } catch (e) {
          asyncErr(req, e);
        }
      });
      return req;
    },
  };

  return { fake, stats };
}
