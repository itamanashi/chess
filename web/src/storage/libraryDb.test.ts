import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RepertoireItem, RepertoireMove } from '../types/chess';
import { createFakeIndexedDB } from './idbFake';
import { decodeLibraryData } from './libraryRepository';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe('repertoire library IndexedDB persistence', () => {
  it('round-trips a library larger than the localStorage quota', async () => {
    vi.stubGlobal('indexedDB', createFakeIndexedDB({ maxValueBytes: 10 * 1024 * 1024 }).fake);
    const { idbLoadLibrary, idbSaveLibrary } = await import('./libraryDb');
    const makeChain = (length: number): RepertoireMove[] => {
      const nodes: RepertoireMove[] = [];
      let tail = nodes;
      for (let index = 0; index < length; index++) {
        const node = {
          coup: 'e4',
          san: 'e4',
          uci: 'e2e4',
          fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
          parties: index,
          victoires_blancs: 0,
          nuls: 0,
          victoires_noirs: 0,
          eco: 'A'.repeat(350),
          children: [],
        };
        tail.push(node);
        tail = node.children;
      }
      return nodes;
    };
    const item: RepertoireItem = {
      id: 'rep-large',
      title: 'Répertoire généré',
      color: 'white',
      targetElo: 'all_700',
      createdAt: '2026-09-29T00:00:00.000Z',
      updatedAt: '2026-09-29T00:00:00.000Z',
      schemaVersion: 1,
      root: {
        fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
        children: Array.from({ length: 128 }, (_, index) => ({
          ...makeChain(index === 0 ? 159 : 122)[0]!,
        })),
      },
    };
    const storedLength = JSON.stringify([item]).length;
    expect(storedLength).toBeGreaterThan(5 * 1024 * 1024);

    await idbSaveLibrary([item]);
    const stored = await idbLoadLibrary();
    expect(stored).toEqual([item]);
    const decoded = decodeLibraryData(stored);
    expect(decoded.status).toBe('ready');
    const savedNodes = decoded.items[0]?.root.children.reduce((total, node) => {
      let count = 0;
      let current: RepertoireMove | undefined = node;
      while (current) {
        count++;
        current = current.children?.[0];
      }
      return total + count;
    }, 0);
    expect(savedNodes).toBe(15653);
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
