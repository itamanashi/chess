import { afterEach, describe, expect, it, vi } from 'vitest';
import { ELO_TARGET_OPTIONS } from '../types/chess';
import {
  fetchLichessMoves,
  fetchLichessMovesWithCacheStatus,
  hasLichessCache,
} from './lichess';
import { createFakeIndexedDB } from '../storage/idbFake';

/**
 * Une position distincte par test (le module partage son cache entre tests).
 * Le `n` est encodé en binaire sur la 3e rangée (N = case occupée) : les clés
 * de cache sont normalisées sur les 4 premiers champs FEN (compteurs et EP
 * fantôme ignorés), donc un simple compteur de coups ne suffirait plus à
 * distinguer deux positions.
 */
const fenN = (n: number): string => {
  const row = Array.from({ length: 8 }, (_, i) => ((n >> i) & 1 ? 'N' : '1'))
    .join('')
    .replace(/1+/g, (m) => String(m.length));
  return `rnbqkbnr/pppppppp/8/8/8/${row}/PPPPPPPP/RNBQKBNR w KQkq - 0 1`;
};

function stubOk(): ReturnType<typeof vi.fn> {
  const mock = vi.fn(async () =>
    new Response(JSON.stringify({ white: 10, draws: 2, black: 3, moves: [] }), { status: 200 }),
  );
  vi.stubGlobal('fetch', mock);
  return mock;
}

function lastUrl(mock: ReturnType<typeof vi.fn>): string {
  const calls = mock.mock.calls;
  if (calls.length === 0) throw new Error('fetch never called');
  return String(calls[calls.length - 1][0]);
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('masters temporal filter (audit A7)', () => {
  it('masters entry pins the explorer to 2015+', () => {
    expect(ELO_TARGET_OPTIONS.find((o) => o.key === 'masters')?.since).toBe(2015);
  });

  it('appends &since to masters URLs only when provided', async () => {
    const fetchMock = stubOk();
    await fetchLichessMoves(fenN(1), undefined, 'masters', undefined, undefined, { since: 2015 });
    expect(lastUrl(fetchMock)).toContain('since=2015');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();

    const fetchMock2 = stubOk();
    await fetchLichessMoves(fenN(2), undefined, 'masters');
    expect(lastUrl(fetchMock2)).not.toContain('since=');
    expect(fetchMock2).toHaveBeenCalledTimes(1);
  });

  it('separates cache entries per since (no filtered/unfiltered collision)', async () => {
    const fetchMock = stubOk();
    const fen = fenN(3);
    await fetchLichessMoves(fen, undefined, 'masters', undefined, undefined, { since: 2015 });
    await fetchLichessMoves(fen, undefined, 'masters');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    // Repeats hit their own entries.
    await fetchLichessMoves(fen, undefined, 'masters', undefined, undefined, { since: 2015 });
    await fetchLichessMoves(fen, undefined, 'masters');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(hasLichessCache(fen, 'masters', undefined, undefined, 2015)).toBe(true);
    expect(hasLichessCache(fen, 'masters')).toBe(true);
    expect(hasLichessCache(fen, 'masters', undefined, undefined, 2020)).toBe(false);
  });

  it('leaves community URLs untouched without since', async () => {
    const fetchMock = stubOk();
    await fetchLichessMoves(fenN(4), undefined, 'lichess', '1000,1200');
    const url = lastUrl(fetchMock);
    expect(url).toContain('ratings=1000,1200');
    expect(url).not.toContain('since=');
  });
});

describe('single-flight (audit A10)', () => {
  it('shares one network call between concurrent identical requests', async () => {
    let calls = 0;
    const mock = vi.fn(async () => {
      calls++;
      await new Promise((r) => setTimeout(r, 20));
      return new Response(JSON.stringify({ white: 5, draws: 1, black: 2, moves: [] }), { status: 200 });
    });
    vi.stubGlobal('fetch', mock);
    const fen = fenN(10);
    const [a, b] = await Promise.all([
      fetchLichessMoves(fen, undefined, 'masters', undefined, undefined, { since: 2015 }),
      fetchLichessMoves(fen, undefined, 'masters', undefined, undefined, { since: 2015 }),
    ]);
    expect(calls).toBe(1);
    expect(a).toBe(b);
    expect(mock).toHaveBeenCalledTimes(1);
  });

  it('does not share failures: a retry after error refetches', async () => {
    let calls = 0;
    const mock = vi.fn(async () => {
      calls++;
      if (calls === 1) throw new TypeError('fetch failed');
      return new Response(JSON.stringify({ white: 1, draws: 0, black: 0, moves: [] }), { status: 200 });
    });
    vi.stubGlobal('fetch', mock);
    // maxRetries 0: first call fails fast…
    await expect(
      fetchLichessMoves(fenN(11), undefined, 'masters', undefined, undefined, { maxRetries: 0 }),
    ).rejects.toThrow();
    // …and the failure was not cached as in-flight: second call refetches.
    const res = await fetchLichessMoves(fenN(11), undefined, 'masters');
    expect(res.white).toBe(1);
    expect(mock).toHaveBeenCalledTimes(2);
  });
});

describe('source du cache', () => {
  it('distingue réseau et mémoire sans changer la réponse API', async () => {
    const fetchMock = stubOk();
    const fen = fenN(14);
    const network = await fetchLichessMovesWithCacheStatus(fen);
    expect(network).toMatchObject({ source: 'network', data: { white: 10 } });
    expect(network.networkStartedAtMs).toEqual(expect.any(Number));
    const memory = await fetchLichessMovesWithCacheStatus(fen);
    expect(memory).toMatchObject({ source: 'memory', data: network.data });
    expect(memory.networkStartedAtMs).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await expect(fetchLichessMoves(fen)).resolves.toEqual(network.data);
  });
});

describe('retry/backoff (audit A10)', () => {
  it('retries 429 then succeeds (Retry-After honored without stalling the test)', async () => {
    const mock = vi.fn(async () => new Response('x', { status: 429 }));
    vi.stubGlobal('fetch', mock);
    // No Retry-After header here → local backoff applies (tiny in test).
    await expect(
      fetchLichessMoves(fenN(12), undefined, 'masters', undefined, undefined, { maxRetries: 1, backoffBaseMs: 1 }),
    ).rejects.toThrow(/limite|429/i);
    expect(mock).toHaveBeenCalledTimes(2);
  });

  it('recovers after transient 5xx', async () => {
    let calls = 0;
    const mock = vi.fn(async () => {
      calls++;
      if (calls < 3) return new Response('x', { status: 503 });
      return new Response(JSON.stringify({ white: 7, draws: 0, black: 0, moves: [] }), { status: 200 });
    });
    vi.stubGlobal('fetch', mock);
    const res = await fetchLichessMoves(fenN(13), undefined, 'masters', undefined, undefined, { backoffBaseMs: 1 });
    expect(res.white).toBe(7);
    expect(mock).toHaveBeenCalledTimes(3);
  });

  it('never retries auth, client errors or bad JSON', async () => {
    for (const [status, body] of [[401, 'x'], [400, 'x']] as const) {
      const mock = vi.fn(async () => new Response(body, { status }));
      vi.stubGlobal('fetch', mock);
      await expect(fetchLichessMoves(fenN(20 + status), undefined, 'masters')).rejects.toThrow();
      expect(mock).toHaveBeenCalledTimes(1);
      vi.unstubAllGlobals();
    }
    const mock = vi.fn(async () => new Response('not json{{{', { status: 200 }));
    vi.stubGlobal('fetch', mock);
    await expect(fetchLichessMoves(fenN(30), undefined, 'masters')).rejects.toThrow(/illisible/i);
    expect(mock).toHaveBeenCalledTimes(1);
  });

  it('times out a hanging request', async () => {
    const mock = vi.fn(() => new Promise<Response>(() => {}));
    vi.stubGlobal('fetch', mock);
    await expect(
      fetchLichessMoves(fenN(31), undefined, 'masters', undefined, undefined, { timeoutMs: 20, maxRetries: 0 }),
    ).rejects.toThrow(/lai/i);
    expect(mock).toHaveBeenCalledTimes(1);
  });
});

describe('persistance IndexedDB (durable, sans plafond)', () => {
  /**
   * Graphe de modules frais par test : mémoire, promesse de préchargement et
   * connexion IDB isolées (le module réel partage tout cela globalement).
   * Le faux IndexedDB est re-stubb avant chaque import.
   */
  async function freshLichess() {
    vi.resetModules();
    const lichess = await import('./lichess');
    const db = await import('../storage/explorerCacheDb');
    return { lichess, db };
  }

  it('coalesces bursts: no write before 25 inserts, one flush covers all', async () => {
    const { fake } = createFakeIndexedDB();
    vi.stubGlobal('indexedDB', fake);
    const { lichess, db } = await freshLichess();
    await lichess.explorerCacheReady();
    const before = await db.idbCount();
    stubOk();
    await lichess.fetchLichessMoves(fenN(40), undefined, 'masters');
    await lichess.fetchLichessMoves(fenN(41), undefined, 'masters');
    await lichess.fetchLichessMoves(fenN(42), undefined, 'masters');
    // Micro-rafale < 25 : rien écrit.
    expect(await db.idbCount()).toBe(before);
    expect(await lichess.flushLichessPersist()).toBe(true);
    expect(await db.idbCount()).toBe(before + 3);
    expect(await lichess.flushLichessPersist()).toBe(true);
    expect(await db.idbCount()).toBe(before + 3); // clean → no rewrite
  });

  it('persists every insert durably: no cap, no expiry', async () => {
    const { fake } = createFakeIndexedDB();
    vi.stubGlobal('indexedDB', fake);
    const { lichess, db } = await freshLichess();
    await lichess.explorerCacheReady();
    stubOk();
    // 60 positions VRAIMENT distinctes (le compteur de coups seul ne distingue
    // plus deux clés depuis la normalisation 4-champs) : fenN(100..159).
    for (let i = 0; i < 60; i++) {
      await lichess.fetchLichessMoves(fenN(100 + i), undefined, 'masters');
    }
    // Flushes périodiques (25/50) déjà passés + reliquat manuel : tout est là.
    expect(await lichess.flushLichessPersist()).toBe(true);
    expect(await db.idbCount()).toBe(60);
  });

  it('signale une panne de lecture IndexedDB et continue via le réseau', async () => {
    const { fake } = createFakeIndexedDB({ failOpen: true });
    vi.stubGlobal('indexedDB', fake);
    const { lichess } = await freshLichess();
    await lichess.explorerCacheReady();
    expect(lichess.lichessPersistHealthy()).toBe(false);
    stubOk();
    const result = await lichess.fetchLichessMovesWithCacheStatus(fenN(51), undefined, 'masters');
    expect(result.source).toBe('network');
    expect(lichess.lichessPersistHealthy()).toBe(false);
  });

  it('IDB failure degrades to memory-only without throwing', async () => {
    const { fake } = createFakeIndexedDB({ failPuts: true });
    vi.stubGlobal('indexedDB', fake);
    const { lichess } = await freshLichess();
    await lichess.explorerCacheReady();
    stubOk();
    await lichess.fetchLichessMoves(fenN(50), undefined, 'masters');
    expect(await lichess.flushLichessPersist()).toBe(false);
    expect(lichess.lichessPersistHealthy()).toBe(false);
    // Memory cache intact: same key resolves with zero network.
    const fetchMock = stubOk();
    const res = await lichess.fetchLichessMoves(fenN(50), undefined, 'masters');
    expect(res.white).toBe(10);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('santé persistance : true après flush réussi', async () => {
    const { fake } = createFakeIndexedDB();
    vi.stubGlobal('indexedDB', fake);
    const { lichess } = await freshLichess();
    await lichess.explorerCacheReady();
    stubOk();
    await lichess.fetchLichessMoves(fenN(70), undefined, 'masters');
    expect(await lichess.flushLichessPersist()).toBe(true);
    expect(lichess.lichessPersistHealthy()).toBe(true);
  });

  it('read-through : une entrée évincée de la mémoire revient sans réseau', async () => {
    const { fake } = createFakeIndexedDB();
    vi.stubGlobal('indexedDB', fake);
    const first = await freshLichess();
    await first.lichess.explorerCacheReady();
    stubOk();
    await first.lichess.fetchLichessMoves(fenN(71), undefined, 'masters');
    expect(await first.lichess.flushLichessPersist()).toBe(true);
    // Nouveau module = mémoire vide, même IndexedDB : pas de réseau.
    const second = await freshLichess();
    await second.lichess.explorerCacheReady();
    const fetchMock = stubOk();
    const res = await second.lichess.fetchLichessMoves(fenN(71), undefined, 'masters');
    expect(res.white).toBe(10);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('relit une réponse depuis SQLite locale avant de consulter Lichess', async () => {
    const { fake } = createFakeIndexedDB();
    vi.stubGlobal('indexedDB', fake);
    vi.stubEnv('VITE_SQLITE_CACHE_ENABLED', 'true');
    const record = { white: 31, draws: 12, black: 8, moves: [] };
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).startsWith('/api/explorer-cache/entry?')) {
        return new Response(JSON.stringify({ record: { data: record, savedAt: 123 } }), { status: 200 });
      }
      throw new Error('Lichess ne doit pas être interrogé si SQLite a la position.');
    });
    vi.stubGlobal('fetch', fetchMock);
    const { lichess } = await freshLichess();
    await lichess.explorerCacheReady();

    const result = await lichess.fetchLichessMovesWithCacheStatus(fenN(73), undefined, 'masters');

    expect(result.source).toBe('sqlite');
    expect(result.data.white).toBe(31);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('normalisation 4-champs : compteurs et EP fantôme partagent une entrée', async () => {
    const { fake } = createFakeIndexedDB();
    vi.stubGlobal('indexedDB', fake);
    const { lichess } = await freshLichess();
    await lichess.explorerCacheReady();
    const fetchMock = stubOk();
    // Même position logique : EP e3 fantôme (aucun pion noir en d4/f4) +
    // compteurs différents → UNE seule entrée, UN seul appel réseau.
    const a = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1';
    const b = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 7';
    await lichess.fetchLichessMoves(a, undefined, 'masters');
    await lichess.fetchLichessMoves(b, undefined, 'masters');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(lichess.hasLichessCache(b, 'masters')).toBe(true);
  });

  it('migration : ancienne clé (FEN complet) relue puis réécrite canonique', async () => {
    const { fake } = createFakeIndexedDB();
    vi.stubGlobal('indexedDB', fake);
    const first = await freshLichess();
    await first.lichess.explorerCacheReady();
    const fullFen = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 9';
    const legacyKey = `masters:all:blitz,rapid,classical::${fullFen}`;
    await first.db.idbPutMany([
      { key: legacyKey, data: { white: 11, draws: 0, black: 0, moves: [] }, savedAt: 1 },
    ]);
    // Nouveau module : le préchargement migre vers la clé canonique…
    const second = await freshLichess();
    await second.lichess.explorerCacheReady();
    const fetchMock = stubOk();
    const otherCounters = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 5 42';
    const res = await second.lichess.fetchLichessMoves(otherCounters, undefined, 'masters');
    expect(res.white).toBe(11);
    expect(fetchMock).not.toHaveBeenCalled();
    // …ancienne clé supprimée, canonique présente (zéro orphelin).
    expect(await second.db.idbCount()).toBe(1);
  });

  it('repli lecture : clé legacy écrite après préchargement reste lisible', async () => {
    const { fake } = createFakeIndexedDB();
    vi.stubGlobal('indexedDB', fake);
    const { lichess, db } = await freshLichess();
    await lichess.explorerCacheReady();
    // La clé legacy contient le FEN COMPLET : le repli ne vaut que pour un
    // FEN à l'octet près (même chemin d'exploration) — la normalisation
    // couvre, elle, les transpositions (compteurs/EP différents).
    const fullFen = 'rnbqkbnr/pppppppp/8/8/8/3P4/PPP1PPPP/RNBQKBNR w KQkq - 0 3';
    const legacyKey = `masters:all:blitz,rapid,classical::${fullFen}`;
    await db.idbPutMany([
      { key: legacyKey, data: { white: 12, draws: 0, black: 0, moves: [] }, savedAt: 1 },
    ]);
    const fetchMock = stubOk();
    const result = await lichess.fetchLichessMovesWithCacheStatus(fullFen, undefined, 'masters');
    expect(result.source).toBe('indexeddb');
    expect(result.data.white).toBe(12);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(lichess.hasLichessCache(fullFen, 'masters')).toBe(true);
  });

  it('migration : blob localStorage rejoint IndexedDB puis est supprimé', async () => {
    const seedFen = fenN(80);
    const seedKey = `masters:all:blitz,rapid,classical::${seedFen}`;
    const store = new Map<string, string>([
      ['lichess_explorer_cache_v2', JSON.stringify({
        [seedKey]: { data: { white: 42, draws: 1, black: 2, moves: [] }, savedAt: Date.now() },
      })],
    ]);
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
      setItem: (k: string, v: string) => {
        store.set(k, String(v));
      },
      removeItem: (k: string) => {
        store.delete(k);
      },
    });
    const { fake } = createFakeIndexedDB();
    vi.stubGlobal('indexedDB', fake);
    const fetchMock = vi.fn(async () => {
      throw new Error('network forbidden');
    });
    vi.stubGlobal('fetch', fetchMock);
    const { lichess, db } = await freshLichess();
    await lichess.explorerCacheReady();
    const res = await lichess.fetchLichessMoves(seedFen, undefined, 'masters');
    expect(res.white).toBe(42);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(store.has('lichess_explorer_cache_v2')).toBe(false);
    expect(await db.idbCount()).toBe(1);
  });

  it('migration en panne : conserve le blob et réutilise ses données en mémoire', async () => {
    const seedFen = fenN(81);
    const seedKey = `masters:all:blitz,rapid,classical::${seedFen}`;
    const store = new Map<string, string>([
      ['lichess_explorer_cache_v2', JSON.stringify({
        [seedKey]: { data: { white: 43, draws: 1, black: 2, moves: [] }, savedAt: Date.now() },
      })],
    ]);
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => { store.set(key, value); },
      removeItem: (key: string) => { store.delete(key); },
    });
    const { fake } = createFakeIndexedDB({ failPuts: true });
    vi.stubGlobal('indexedDB', fake);
    const fetchMock = vi.fn(async () => {
      throw new Error('network forbidden');
    });
    vi.stubGlobal('fetch', fetchMock);
    const { lichess } = await freshLichess();
    await lichess.explorerCacheReady();
    const result = await lichess.fetchLichessMovesWithCacheStatus(seedFen, undefined, 'masters');
    expect(result).toMatchObject({ source: 'memory', data: { white: 43 } });
    expect(store.has('lichess_explorer_cache_v2')).toBe(true);
    expect(lichess.lichessPersistHealthy()).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
