import { afterEach, describe, expect, it, vi } from 'vitest';
import { addStudyTime, getStudyTime, loadStudyTimes } from './studyTime';

function fakeStorage(): Storage {
  let store: Record<string, string> = {};
  return {
    get length() {
      return Object.keys(store).length;
    },
    clear: () => {
      store = {};
    },
    getItem: (k: string) => store[k] ?? null,
    key: (i: number) => Object.keys(store)[i] ?? null,
    removeItem: (k: string) => {
      delete store[k];
    },
    setItem: (k: string, v: string) => {
      store[k] = v;
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('studyTime', () => {
  it('cumule les secondes par répertoire, 0 si inconnu', () => {
    vi.stubGlobal('localStorage', fakeStorage());
    expect(getStudyTime('rep-a')).toBe(0);
    expect(addStudyTime('rep-a', 30)).toBe(true);
    expect(addStudyTime('rep-a', 45.6)).toBe(true);
    expect(getStudyTime('rep-a')).toBe(76);
    expect(getStudyTime('rep-b')).toBe(0);
    expect(loadStudyTimes()).toEqual({ 'rep-a': 76 });
  });

  it('ignore les valeurs invalides et le JSON corrompu', () => {
    const storage = fakeStorage();
    vi.stubGlobal('localStorage', storage);
    expect(addStudyTime('', 10)).toBe(false);
    expect(addStudyTime('rep-a', 0)).toBe(false);
    expect(addStudyTime('rep-a', Number.NaN)).toBe(false);
    storage.setItem('chess_study_time_v1', 'pas-du-json{{{');
    expect(loadStudyTimes()).toEqual({});
    storage.setItem('chess_study_time_v1', JSON.stringify({ ok: 12, ko: -5, nul: 0, txt: 'x' }));
    expect(loadStudyTimes()).toEqual({ ok: 12 });
  });
});
