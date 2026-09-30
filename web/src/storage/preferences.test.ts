import { afterEach, describe, expect, it, vi } from 'vitest';
import { uiPrefs } from './preferences';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('piece skin preference', () => {
  it('uses the existing Chessground pieces by default', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => null,
      setItem: () => undefined,
      removeItem: () => undefined,
    });

    expect(uiPrefs.getPieceSkin()).toBe('cburnett');
  });

  it('persists a selected skin between reads', () => {
    const values = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    });

    uiPrefs.setPieceSkin('unicode');

    expect(values.get('chess_piece_skin')).toBe('unicode');
    expect(uiPrefs.getPieceSkin()).toBe('unicode');
  });

  it('falls back safely when the stored value is not a supported skin', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => 'unknown',
      setItem: () => undefined,
      removeItem: () => undefined,
    });

    expect(uiPrefs.getPieceSkin()).toBe('cburnett');
  });
});
