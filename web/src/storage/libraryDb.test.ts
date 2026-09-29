import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RepertoireItem } from '../types/chess';
import { createFakeIndexedDB } from './idbFake';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe('repertoire library IndexedDB persistence', () => {
  it('round-trips a library larger than the localStorage quota', async () => {
    vi.stubGlobal('indexedDB', createFakeIndexedDB({ maxValueBytes: 10 * 1024 * 1024 }).fake);
    const { idbLoadLibrary, idbSaveLibrary } = await import('./libraryDb');
    const item: RepertoireItem = {
      id: 'rep-large',
      title: 'Répertoire généré',
      color: 'white',
      targetElo: 'all_700',
      createdAt: '2026-09-29T00:00:00.000Z',
      updatedAt: '2026-09-29T00:00:00.000Z',
      schemaVersion: 1,
      root: {
        fen: 'start',
        children: Array.from({ length: 18000 }, (_, index) => ({
          coup: `e${index}`,
          san: `e${index}`,
          uci: 'e2e4',
          fen: `position-${index}`,
          parties: index,
          eco: 'A'.repeat(180),
          victoires_blancs: 0,
          nuls: 0,
          victoires_noirs: 0,
          children: [],
        })),
      },
    };
    expect(JSON.stringify([item]).length).toBeGreaterThan(5 * 1024 * 1024);

    await idbSaveLibrary([item]);

    expect(await idbLoadLibrary()).toEqual([item]);
  });

  it('reports a failed durable write to the caller', async () => {
    vi.stubGlobal('indexedDB', createFakeIndexedDB({ failPuts: true }).fake);
    const { idbSaveLibrary } = await import('./libraryDb');

    await expect(idbSaveLibrary([])).rejects.toThrow('put failed');
  });

  it('does not resolve the save until IndexedDB commits the transaction', async () => {
    vi.stubGlobal('indexedDB', createFakeIndexedDB({ transactionCompleteDelayMs: 30 }).fake);
    const { idbSaveLibrary } = await import('./libraryDb');
    let saved = false;

    const pendingSave = idbSaveLibrary([]).then(() => { saved = true; });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(saved).toBe(false);

    await pendingSave;
    expect(saved).toBe(true);
  });
});
