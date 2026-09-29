import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  cachedCountry,
  getCountryCache,
  loadOpponentCountries,
} from './opponentCountry';

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubProfiles(): void {
  vi.stubGlobal('fetch', vi.fn(async (url: unknown) => {
    const u = String(url);
    if (u.endsWith('/player/alice')) {
      return new Response(JSON.stringify({ username: 'alice', country: 'https://api.chess.com/pub/country/FR' }), { status: 200 });
    }
    if (u.endsWith('/player/bob')) {
      return new Response(JSON.stringify({ username: 'bob' }), { status: 200 });
    }
    return new Response('nope', { status: 404 });
  }));
}

describe('loadOpponentCountries', () => {
  it('résout les pays (dédupliqués, insensibles à la casse), isole les 404', async () => {
    stubProfiles();
    const seen: Array<{ done: number; total: number }> = [];
    const result = await loadOpponentCountries(['Alice', 'BOB', 'gone', 'alice'], {
      onProgress: (p) => seen.push(p),
    });
    expect(result.cache).toMatchObject({ alice: 'FR', bob: '', gone: '' });
    expect(result.resolved).toBe(2);
    expect(result.failed).toBe(1);
    expect(seen[seen.length - 1]).toEqual({ done: 3, total: 3 });
    expect(cachedCountry(result.cache, 'ALICE')).toBe('FR');
    expect(cachedCountry(result.cache, 'inconnu')).toBeNull();
  });

  it('refuse de démarrer si déjà annulé', async () => {
    stubProfiles();
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(loadOpponentCountries(['alice'], { signal: ctrl.signal })).rejects.toThrow();
  });
});

describe('getCountryCache', () => {
  it('retourne un objet vide sans localStorage (jamais de crash)', () => {
    expect(getCountryCache()).toEqual({});
  });
});
