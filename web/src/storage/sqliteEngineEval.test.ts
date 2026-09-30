import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFakeIndexedDB } from './idbFake';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('SQLite Stockfish persistence', () => {
  it('reads a saved evaluation when the browser database misses', async () => {
    vi.resetModules();
    vi.stubEnv('VITE_SQLITE_CACHE_ENABLED', 'true');
    vi.stubGlobal('indexedDB', createFakeIndexedDB().fake);
    const record = {
      key: 'normalized-fen|d14|pv6',
      lines: [{
        uci: 'e2e4',
        san: 'e4',
        cp: 24,
        depth: 14,
        scoreFormatted: '+0.24',
        pvSans: ['e4'],
      }],
      savedAt: 42,
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).startsWith('/api/eval-cache/entry?')) {
        return new Response(JSON.stringify({ record }), { status: 200 });
      }
      return new Response(JSON.stringify({ stored: 1, entries: 1 }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
    const { idbGetEngineEval } = await import('./engineEvalCacheDb');

    const result = await idbGetEngineEval(record.key);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(result).toEqual(record);
    expect(fetchMock.mock.calls.some(([url]) => String(url).startsWith('/api/eval-cache/entry?'))).toBe(true);
  });
});
