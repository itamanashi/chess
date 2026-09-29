import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchCloudEvaluation } from './engine';
import { formatEngineScore, normalizePvUci, playPvSanLines, pvToEngineMove } from '../utils/enginePv';

const FEN0 = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
/** Same legal position with a distinct move clock → distinct cache keys. */
const fenN = (n: number): string =>
  `rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 ${n}`;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function stubFetch(
  impl: (url: unknown, init?: { signal?: AbortSignal }) => unknown,
): ReturnType<typeof vi.fn> {
  const mock = vi.fn(impl);
  vi.stubGlobal('fetch', mock);
  return mock;
}

/** Never-resolving fetch that honors abort, like production fetch. */
function hanging(signal?: AbortSignal): Promise<Response> {
  return new Promise<Response>((_resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
      return;
    }
    signal?.addEventListener(
      'abort',
      () => reject(signal.reason ?? new DOMException('Aborted', 'AbortError')),
      { once: true },
    );
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('fetchCloudEvaluation', () => {
  it('parses multi-PV payloads and caches the success', async () => {
    const fetchMock = stubFetch(async () =>
      jsonResponse({
        depth: 30,
        pvs: [
          { moves: 'e2e4 e7e5 g1f3', cp: 35 },
          { moves: 'd2d4 g8f6', mate: 3 },
        ],
      }),
    );
    const first = await fetchCloudEvaluation(fenN(11), 2);
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error('expected ok');
    expect(first.fromCache).toBe(false);
    expect(first.moves).toHaveLength(2);
    expect(first.moves[0]).toMatchObject({ san: 'e4', uci: 'e2e4', cp: 35, scoreFormatted: '+0.35' });
    expect(first.moves[0].pvSans).toEqual(['e4', 'e5', 'Nf3']);
    expect(first.moves[1]).toMatchObject({ san: 'd4', scoreFormatted: '#+3' });

    const second = await fetchCloudEvaluation(fenN(11), 2);
    expect(second.ok).toBe(true);
    if (!second.ok) throw new Error('expected ok');
    expect(second.fromCache).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('404 is definitive: not-analyzed, no retry, no error UI', async () => {
    const fetchMock = stubFetch(async () => new Response('{}', { status: 404 }));
    const res = await fetchCloudEvaluation(fenN(12));
    expect(res).toEqual({ ok: false, error: expect.objectContaining({ code: 'not-analyzed', status: 404 }) });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('retries 5xx then succeeds', async () => {
    let calls = 0;
    const fetchMock = stubFetch(async () => {
      calls++;
      if (calls < 3) return new Response('x', { status: 500 });
      return jsonResponse({ depth: 20, pvs: [{ moves: 'e2e4', cp: 10 }] });
    });
    const res = await fetchCloudEvaluation(fenN(13), 1, { backoffBaseMs: 1 });
    expect(res.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('gives up after maxRetries with a server code', async () => {
    const fetchMock = stubFetch(async () => new Response('x', { status: 503 }));
    const res = await fetchCloudEvaluation(fenN(14), 1, { maxRetries: 2, backoffBaseMs: 1 });
    expect(res).toEqual({ ok: false, error: expect.objectContaining({ code: 'server', status: 503 }) });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('retries network errors, not client errors', async () => {
    // Network failure then success.
    let flaky = 0;
    stubFetch(async () => {
      flaky++;
      if (flaky === 1) throw new TypeError('fetch failed');
      return jsonResponse({ depth: 20, pvs: [{ moves: 'e2e4', cp: 10 }] });
    });
    const recovered = await fetchCloudEvaluation(fenN(15), 1, { backoffBaseMs: 1 });
    expect(recovered.ok).toBe(true);
    vi.unstubAllGlobals();

    // 400/401 fail fast without retry.
    for (const status of [400, 401]) {
      const fetchMock = stubFetch(async () => new Response('x', { status }));
      const res = await fetchCloudEvaluation(fenN(20 + status), 1);
      expect(res.ok).toBe(false);
      if (!res.ok) expect([400, 401]).toContain(res.error.status);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      vi.unstubAllGlobals();
    }
  });

  it('times out a hanging request', async () => {
    // Signal-aware mock like a real fetch; the race backstop covers even
    // implementations that ignore the signal.
    stubFetch((_url: unknown, init?: { signal?: AbortSignal }) => hanging(init?.signal));
    const res = await fetchCloudEvaluation(fenN(30), 1, { timeoutMs: 20, maxRetries: 0 });
    expect(res).toEqual({ ok: false, error: expect.objectContaining({ code: 'timeout' }) });
  });

  it('caller abort throws instead of returning a Result', async () => {
    stubFetch((_url: unknown, init?: { signal?: AbortSignal }) => hanging(init?.signal));
    const ctrl = new AbortController();
    const pending = fetchCloudEvaluation(fenN(31), 1, { timeoutMs: 5000, signal: ctrl.signal });
    ctrl.abort();
    await expect(pending).rejects.toSatisfy(
      (e: unknown) => e instanceof DOMException && e.name === 'AbortError',
    );
  });

  it('rejects malformed payloads without retrying', async () => {
    // Invalid JSON.
    let fetchMock = stubFetch(async () => new Response('not json{{{', { status: 200 }));
    let res = await fetchCloudEvaluation(fenN(32), 1);
    expect(res).toEqual({ ok: false, error: expect.objectContaining({ code: 'bad-response' }) });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();

    // pvs not an array.
    fetchMock = stubFetch(async () => jsonResponse({ depth: 10, pvs: {} }));
    res = await fetchCloudEvaluation(fenN(33), 1);
    expect(res).toEqual({ ok: false, error: expect.objectContaining({ code: 'bad-response' }) });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();

    // 200 but zero convertible PVs → divergent payload, not empty data.
    fetchMock = stubFetch(async () =>
      jsonResponse({ depth: 10, pvs: [{ moves: 'e2e5', cp: 5 }] }),
    );
    res = await fetchCloudEvaluation(fenN(34), 1);
    expect(res).toEqual({ ok: false, error: expect.objectContaining({ code: 'bad-response' }) });
    vi.unstubAllGlobals();

    // Genuine empty pvs is a valid empty success.
    stubFetch(async () => jsonResponse({ depth: 10, pvs: [] }));
    res = await fetchCloudEvaluation(fenN(35), 1);
    expect(res).toEqual({ ok: true, moves: [], fromCache: false });
  });
});

describe('shared PV parsing (utils/enginePv)', () => {
  it('formats scores identically for both engines', () => {
    expect(formatEngineScore(35)).toBe('+0.35');
    expect(formatEngineScore(-5)).toBe('-0.05');
    expect(formatEngineScore(undefined, 2)).toBe('#+2');
    expect(formatEngineScore(undefined, -1)).toBe('#-1');
    expect(formatEngineScore()).toBe('0.00');
  });

  it('converts a PV line and caps at 6 plies', () => {
    const parsed = playPvSanLines(FEN0, ['e2e4', 'e7e5', 'g1f3', 'b8c6', 'f1b5', 'a7a6', 'b5a4']);
    expect(parsed?.san).toBe('e4');
    expect(parsed?.sans).toEqual(['e4', 'e5', 'Nf3', 'Nc6', 'Bb5', 'a6']);
  });

  it('keeps the full UCI line for horizon walks (display stays capped)', () => {
    const pv = ['e2e4', 'e7e5', 'g1f3', 'b8c6', 'f1b5', 'a7a6', 'b5a4', 'g8f6', 'e1g1', 'f8e7', 'f1e1', 'd7d6'];
    const parsed = playPvSanLines(FEN0, pv);
    expect(parsed?.sans).toHaveLength(6);
    expect(parsed?.ucis).toHaveLength(12);
    expect(parsed?.ucis[8]).toBe('e1g1');
  });

  it('returns null on illegal first ply, truncates later ones', () => {
    expect(playPvSanLines(FEN0, ['e2e5'])).toBeNull();
    expect(playPvSanLines(FEN0, ['e2e4', 'e7e5', 'zzz'])?.sans).toEqual(['e4', 'e5']);
  });

  it('handles promotions case-insensitively', () => {
    const fen = '8/4P3/8/8/8/1k6/8/4K3 w - - 0 1';
    expect(playPvSanLines(fen, ['e7e8q'])?.san).toBe('e8=Q');
    expect(playPvSanLines(fen, ['e7e8Q'])?.san).toBe('e8=Q');
  });

  it('tolerates Chess960-style castles like the repertoire does', () => {
    const fen = 'r3k2r/pppppppp/8/8/8/8/PPPPPPPP/R3K2R w KQkq - 0 1';
    const parsed = playPvSanLines(fen, ['e1h1']);
    expect(parsed?.san).toBe('O-O');
    expect(parsed?.firstUci).toBe('e1g1');
  });

  it('normalizePvUci canonicalizes map keys (castle + promotion case)', () => {
    const castleFen = 'r3k2r/pppppppp/8/8/8/8/PPPPPPPP/R3K2R w KQkq - 0 1';
    expect(normalizePvUci(castleFen, 'e1h1')).toBe('e1g1');
    expect(normalizePvUci(castleFen, 'e1g1')).toBe('e1g1');
    expect(normalizePvUci(FEN0, 'e7e8Q')).toBe('e7e8q');
    expect(normalizePvUci(FEN0, 'e2e4')).toBe('e2e4');
    // No king on e1: not a castle, left untouched.
    expect(normalizePvUci('8/8/8/8/8/8/8/R6R w - - 0 1', 'e1h1')).toBe('e1h1');
    expect(normalizePvUci(FEN0, 'zz')).toBe('zz');
  });

  it('pvToEngineMove builds the full EngineMove or null', () => {
    const em = pvToEngineMove(FEN0, ['e2e4', 'e7e5'], { cp: 35 }, 30);
    expect(em).toMatchObject({ uci: 'e2e4', san: 'e4', depth: 30, scoreFormatted: '+0.35' });
    expect(pvToEngineMove(FEN0, ['e2e5'], { cp: 5 }, 30)).toBeNull();
  });
});
