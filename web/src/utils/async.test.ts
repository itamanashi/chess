import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchWithTimeout, isAbortError, isTimeoutError } from './async';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('fetchWithTimeout', () => {
  it('passes successful responses through', async () => {
    const mock = vi.fn(async () => new Response('{"a":1}', { status: 200 }));
    vi.stubGlobal('fetch', mock);
    const res = await fetchWithTimeout('https://x.test/', {}, 1000);
    expect(res.status).toBe(200);
    expect(mock).toHaveBeenCalledTimes(1);
  });

  it('rejects TimeoutError on budget expiry, even if fetch ignores abort', async () => {
    const mock = vi.fn(() => new Promise<Response>(() => {}));
    vi.stubGlobal('fetch', mock);
    const err = await fetchWithTimeout('https://x.test/', {}, 20).catch((e: unknown) => e);
    expect(isTimeoutError(err)).toBe(true);
    expect(isAbortError(err)).toBe(false);
  });

  it('propagates caller abort instead of timing out', async () => {
    const mock = vi.fn(
      (_url: unknown, init?: { signal?: AbortSignal }) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
        }),
    );
    vi.stubGlobal('fetch', mock);
    const ctrl = new AbortController();
    const pending = fetchWithTimeout('https://x.test/', { signal: ctrl.signal }, 5000);
    ctrl.abort();
    await expect(pending).rejects.toSatisfy((e: unknown) => isAbortError(e));
  });
});
