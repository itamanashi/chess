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

    uiPrefs.setPieceSkin('chessnut');

    expect(values.get('chess_piece_skin')).toBe('chessnut');
    expect(uiPrefs.getPieceSkin()).toBe('chessnut');
  });

  it('accepts the expanded Neo skin choices', () => {
    const values = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    });

    uiPrefs.setPieceSkin('staunty');

    expect(uiPrefs.getPieceSkin()).toBe('staunty');
  });

  it('migrates the retired Chess.com hotlink skins to the built-in set', () => {
    const values = new Map([['chess_piece_skin', 'neo']]);
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    });

    expect(uiPrefs.getPieceSkin()).toBe('cburnett');
  });

  it('migrates the former Unicode skin to the illustrated set', () => {
    const values = new Map([['chess_piece_skin', 'unicode']]);
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    });

    expect(uiPrefs.getPieceSkin()).toBe('chessnut');
    expect(values.get('chess_piece_skin')).toBe('chessnut');
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
