import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  BoardOrientation,
  EloTargetKey,
  RepertoireItem,
  RepertoireRoot,
} from '../types/chess';
import { warn } from '../utils/async';
import {
  TOAST_LIBRARY_DURABLE_LOAD_FAILED,
  TOAST_LIBRARY_SAVE_FAILED,
  TOAST_LIBRARY_CORRUPT,
  TOAST_STORAGE_UNAVAILABLE,
  toastLibraryUpgraded,
} from '../i18n';
import {
  LIBRARY_SCHEMA_VERSION,
  buildLibraryItem,
  decodeLibraryData,
  emptyRoot,
  loadLibrary,
  parseImport,
  type ImportParseResult,
} from '../storage/libraryRepository';
import { idbLoadLibrary, idbSaveLibrary } from '../storage/libraryDb';
import { createDefaultOpenings } from '../storage/defaultOpenings';
import { cloneRepertoireRoot, deleteMoveByPath } from '../utils/repertoireTree';
import { useToast } from './useToast';

/**
 * Bibliothèque de répertoires : CRUD + persistance via le repository
 * (`storage/libraryRepository.ts` : versionnage, migration, validation).
 * Le hook ne touche plus jamais `localStorage` directement.
 */
export function useRepertoireLibrary() {
  const [repertoires, setRepertoires] = useState<RepertoireItem[]>([]);
  const [activeRepertoireId, setActiveRepertoireId] = useState<string | null>(null);
  const repertoiresRef = useRef(repertoires);
  const mutationRevision = useRef(0);
  const idbWriteQueue = useRef<Promise<void>>(Promise.resolve());
  const saveFailureNotified = useRef(false);
  const loadFailureNotified = useRef(false);
  const toast = useToast();
  // Un seul feedback par montage (StrictMode rejoue l'effet en dev).
  const loadFeedbackSent = useRef(false);

  const publish = useCallback((items: RepertoireItem[]) => {
    repertoiresRef.current = items;
    setRepertoires(items);
  }, []);

  /** IndexedDB pour la bibliothèque (pas de quota localStorage). */
  const persist = useCallback((items: RepertoireItem[], isMutation = true) => {
    if (isMutation) mutationRevision.current++;
    const write = idbWriteQueue.current
      .catch(() => undefined)
      .then(() => idbSaveLibrary(items));
    idbWriteQueue.current = write;
    const durableWrite = write.then(() => {
      saveFailureNotified.current = false;
      return true;
    }).catch((err: unknown) => {
      warn('library:idb-save', err);
      if (!saveFailureNotified.current) {
        saveFailureNotified.current = true;
        toast.error(TOAST_LIBRARY_SAVE_FAILED);
      }
      return false;
    });
    return durableWrite;
  }, [toast]);

  // Chargement local immédiat, puis réconciliation avec la copie sans quota
  // IndexedDB. Une écriture faite entre-temps reste prioritaire sur le chargement.
  useEffect(() => {
    const loaded = loadLibrary();
    let initialItems: RepertoireItem[];
if (loaded.status === 'ready' || loaded.status === 'migrated') {
        initialItems = loaded.items;
        publish(initialItems);
        if (loaded.status === 'migrated') {
          // Réécrit sous forme canonique pour les prochains lancements (IndexedDB).
          persist(loaded.items, false);
        }
      if (!loadFeedbackSent.current && loaded.issues.length > 0) {
        loadFeedbackSent.current = true;
        toast.info(toastLibraryUpgraded(loaded.issues[0], LIBRARY_SCHEMA_VERSION));
      }
    } else if (loaded.status === 'corrupt' && !loadFeedbackSent.current) {
      loadFeedbackSent.current = true;
      toast.error(TOAST_LIBRARY_CORRUPT);
      initialItems = createDefaultOpenings();
      publish(initialItems);
    } else if (loaded.status === 'unavailable' && !loadFeedbackSent.current) {
      loadFeedbackSent.current = true;
      toast.error(TOAST_STORAGE_UNAVAILABLE);
      initialItems = createDefaultOpenings();
      publish(initialItems);
} else {
        initialItems = createDefaultOpenings();
        publish(initialItems);
        if (loaded.status === 'empty') {
          persist(initialItems, false);
        }
      }

    let cancelled = false;
    const startingRevision = mutationRevision.current;
    void idbLoadLibrary().then((storedItems) => {
      if (cancelled || mutationRevision.current !== startingRevision) return;
      if (storedItems === null) {
        persist(initialItems, false);
        return;
      }
      const checked = decodeLibraryData(storedItems);
      if (checked.status === 'corrupt') {
        warn('library:idb-load', checked.issues);
        if (!loadFailureNotified.current) {
          loadFailureNotified.current = true;
          toast.error(TOAST_LIBRARY_DURABLE_LOAD_FAILED);
        }
        return;
      }
      if (checked.issues.length > 0) {
        warn('library:idb-load', checked.issues);
        if (!loadFailureNotified.current) {
          loadFailureNotified.current = true;
          toast.error(TOAST_LIBRARY_DURABLE_LOAD_FAILED);
        }
        return;
      }
      publish(checked.items);
if (checked.status === 'migrated') persist(checked.items, false);
    }).catch((err: unknown) => {
      warn('library:idb-load', err);
      if (!loadFailureNotified.current) {
        loadFailureNotified.current = true;
        toast.error(TOAST_LIBRARY_DURABLE_LOAD_FAILED);
      }
    });
    return () => { cancelled = true; };
  // One-time startup hydration; dependencies are stable for the hook lifetime.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Persiste + publie. Les autosaves durables sont sérialisés en arrière-plan. */
  const saveAll = useCallback((updatedList: RepertoireItem[]) => {
    publish(updatedList);
    persist(updatedList);
  }, [persist, publish]);

  const activeRepertoire = useMemo(
    () => repertoires.find((r) => r.id === activeRepertoireId) || null,
    [repertoires, activeRepertoireId],
  );

  /** Applique une mutation pure sur une copie du root actif (structuredClone). */
  const updateActiveRoot = useCallback(
    (repId: string, mutator: (root: RepertoireRoot) => void) => {
      const updated = repertoiresRef.current.map((r) => {
        if (r.id !== repId) return r;
        const cloned = cloneRepertoireRoot(r.root);
        mutator(cloned);
        return { ...r, root: cloned, updatedAt: new Date().toISOString() };
      });
      publish(updated);
      return persist(updated);
    },
    [persist, publish],
  );

  const deleteRepertoireMove = useCallback(
    (repId: string, uciPath: string[]) => {
      if (uciPath.length === 0) return;
      updateActiveRoot(repId, (root) => {
        deleteMoveByPath(root, uciPath);
      });
    },
    [updateActiveRoot],
  );

  const createRepertoire = useCallback(
    (title: string, color: BoardOrientation, targetElo: EloTargetKey): RepertoireItem => {
      const newRep: RepertoireItem = {
        ...buildLibraryItem(title, color, emptyRoot()),
        targetElo,
      };
      const updated = [newRep, ...repertoiresRef.current];
      persist(updated);
      publish(updated);
      setActiveRepertoireId(newRep.id);
      return newRep;
    },
    [persist, publish],
  );

  const deleteRepertoire = useCallback(
    (id: string) => {
      saveAll(repertoiresRef.current.filter((r) => r.id !== id));
      if (activeRepertoireId === id) setActiveRepertoireId(null);
    },
    [saveAll, activeRepertoireId],
  );

  /**
   * Import validé AVANT insertion (parseImport lève une Error explicite si
   * rien n'est importable). Retourne items + avertissements (branches élaguées).
   */
  const importRepertoire = useCallback(
    (content: string, filename: string): ImportParseResult => {
      const parsed = parseImport(content, filename);
      const updated = [...parsed.items, ...repertoiresRef.current];
      persist(updated);
      publish(updated);
      return parsed;
    },
    [persist, publish],
  );

  return useMemo(() => ({
    repertoires,
    activeRepertoire,
    activeRepertoireId,
    setActiveRepertoireId,
    saveAll,
    updateActiveRoot,
    deleteRepertoireMove,
    createRepertoire,
    deleteRepertoire,
    importRepertoire,
  }), [
    repertoires, activeRepertoire, activeRepertoireId, setActiveRepertoireId,
    saveAll, updateActiveRoot, deleteRepertoireMove, createRepertoire,
    deleteRepertoire, importRepertoire,
  ]);
}

export type RepertoireLibrary = ReturnType<typeof useRepertoireLibrary>;
