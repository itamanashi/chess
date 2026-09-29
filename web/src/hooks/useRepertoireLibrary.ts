import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  BoardOrientation,
  EloTargetKey,
  RepertoireItem,
  RepertoireRoot,
} from '../types/chess';
import { warn } from '../utils/async';
import {
  STORE_INIT_SAVE_FAILED,
  TOAST_LIBRARY_CORRUPT,
  TOAST_STORAGE_UNAVAILABLE,
  quotaSaveError,
  toastLibraryUpgraded,
} from '../i18n';
import {
  LIBRARY_SCHEMA_VERSION,
  buildLibraryItem,
  emptyRoot,
  loadLibrary,
  parseImport,
  saveLibrary,
  type ImportParseResult,
} from '../storage/libraryRepository';
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
  const toast = useToast();
  // Un seul feedback par montage (StrictMode rejoue l'effet en dev).
  const loadFeedbackSent = useRef(false);

  // Chargement initial : repository (migré si besoin) puis défauts embarqués.
  useEffect(() => {
    const loaded = loadLibrary();
    if (loaded.status === 'ready' || loaded.status === 'migrated') {
      setRepertoires(loaded.items);
      if (loaded.status === 'migrated') {
        // Réécrit sous forme canonique pour les prochains lancements.
        saveLibrary(loaded.items);
      }
      if (!loadFeedbackSent.current && loaded.issues.length > 0) {
        loadFeedbackSent.current = true;
        toast.info(toastLibraryUpgraded(loaded.issues[0], LIBRARY_SCHEMA_VERSION));
      }
      return;
    }
    if (loaded.status === 'corrupt' && !loadFeedbackSent.current) {
      loadFeedbackSent.current = true;
      toast.error(TOAST_LIBRARY_CORRUPT);
    }
    if (loaded.status === 'unavailable' && !loadFeedbackSent.current) {
      loadFeedbackSent.current = true;
      toast.error(TOAST_STORAGE_UNAVAILABLE);
    }
    const initialLibrary = createDefaultOpenings();
    setRepertoires(initialLibrary);
    if (loaded.status === 'empty' && !saveLibrary(initialLibrary)) {
      warn('library:init-save', STORE_INIT_SAVE_FAILED);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Persiste + publie. Les échecs silencieux sont journalisés (autosaves fréquentes). */
  const saveAll = useCallback((updatedList: RepertoireItem[]) => {
    setRepertoires(updatedList);
    saveLibrary(updatedList);
  }, []);

  const activeRepertoire = useMemo(
    () => repertoires.find((r) => r.id === activeRepertoireId) || null,
    [repertoires, activeRepertoireId],
  );

  /** Applique une mutation pure sur une copie du root actif (structuredClone). */
  const updateActiveRoot = useCallback(
    (repId: string, mutator: (root: RepertoireRoot) => void) => {
      setRepertoires((prev) => {
        const updated = prev.map((r) => {
          if (r.id !== repId) return r;
          const cloned = cloneRepertoireRoot(r.root);
          mutator(cloned);
          return { ...r, root: cloned, updatedAt: new Date().toISOString() };
        });
        saveLibrary(updated);
        return updated;
      });
    },
    [],
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
      const updated = [newRep, ...repertoires];
      if (!saveLibrary(updated)) {
        throw new Error(quotaSaveError('création'));
      }
      setRepertoires(updated);
      setActiveRepertoireId(newRep.id);
      return newRep;
    },
    [repertoires],
  );

  const deleteRepertoire = useCallback(
    (id: string) => {
      saveAll(repertoires.filter((r) => r.id !== id));
      if (activeRepertoireId === id) setActiveRepertoireId(null);
    },
    [repertoires, saveAll, activeRepertoireId],
  );

  /**
   * Import validé AVANT insertion (parseImport lève une Error explicite si
   * rien n'est importable). Retourne items + avertissements (branches élaguées).
   */
  const importRepertoire = useCallback(
    (content: string, filename: string): ImportParseResult => {
      const parsed = parseImport(content, filename);
      const updated = [...parsed.items, ...repertoires];
      if (!saveLibrary(updated)) {
        throw new Error(quotaSaveError('import'));
      }
      setRepertoires(updated);
      return parsed;
    },
    [repertoires],
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
