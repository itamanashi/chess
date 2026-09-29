import { useCallback, useMemo, useRef, useState } from 'react';
import { Chess, type Square } from 'chess.js';
import type { MoveHistoryItem } from '../types/chess';
import { INITIAL_FEN } from '../utils/repertoire';

/**
 * Tronque le futur après `index` puis ajoute `item`. Pur et testé.
 *
 * Garantit que la réplique adverse du trainer prolonge la position
 * COURANTE (après un retour au début / une navigation), jamais la fin
 * d'une vieille ligne — sinon `currentIndex` pointe un ancien coup et
 * l'entraînement valide contre la mauvaise position (ex. on voit 1.d4
 * mais le coach attend 1...e5 de la ligne 1.e4 précédente).
 */
export function spliceAppend<T>(history: T[], index: number, item: T): { history: T[]; index: number } {
  if (history.length === 0) return { history: [item], index: 0 };
  const base = Math.max(0, Math.min(index, history.length - 1));
  return { history: [...history.slice(0, base + 1), item], index: base + 1 };
}

export interface PhysicalMoveResult {
  san: string;
  uci: string;
  newFen: string;
}

const ROOT_ITEM: MoveHistoryItem = { san: '', uci: '', fen: INITIAL_FEN };

function lastMoveOf(uci: string | undefined): [string, string] | undefined {
  if (!uci) return undefined;
  return [uci.slice(0, 2), uci.slice(2, 4)];
}

/**
 * Timeline d'échecs : source unique de vérité (fen / history / currentIndex / lastMove).
 * Remplace le quadruplet synchronisé manuellement (fen, history, currentIndex, chessInstance).
 * L'instance Chess n'est utilisée que localement pour valider un coup, jamais stockée.
 */
export function useChessTimeline() {
  const [history, setHistory] = useState<MoveHistoryItem[]>([ROOT_ITEM]);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [fen, setFen] = useState(INITIAL_FEN);
  const [lastMove, setLastMove] = useState<[string, string] | undefined>(undefined);
  // Miroir synchrone de currentIndex (même motif que fenRef dans App) : les
  // timers du trainer (réplique à 380/450 ms) tirent avec des closures
  // potentiellement antérieures au dernier jumpTo — l'index FRAIS au moment
  // du tir est lu ici, pas dans la closure.
  const indexRef = useRef(0);
  indexRef.current = currentIndex;

  const jumpTo = useCallback(
    (idx: number) => {
      if (idx < 0 || idx >= history.length) return;
      const target = history[idx];
      setFen(target.fen);
      setCurrentIndex(idx);
      setLastMove(lastMoveOf(target.uci));
    },
    [history],
  );

  const reset = useCallback(() => {
    setHistory([ROOT_ITEM]);
    setCurrentIndex(0);
    setFen(INITIAL_FEN);
    setLastMove(undefined);
  }, []);

  const loadLine = useCallback((items: MoveHistoryItem[]) => {
    if (items.length === 0) return;
    const last = items[items.length - 1];
    setHistory(items);
    setCurrentIndex(items.length - 1);
    setFen(last.fen);
    setLastMove(lastMoveOf(last.uci));
  }, []);

  /**
   * Joue un coup physique depuis la position courante (tronque le futur si on
   * avait navigué en arrière). Retourne null si illégal / partie terminée.
   */
  const playPhysicalMove = useCallback(
    (from: string, to: string, promotion?: string): PhysicalMoveResult | null => {
      const baseFen = history[currentIndex]?.fen ?? INITIAL_FEN;
      let moveResult;
      let newFen: string;
      try {
        const c = new Chess(baseFen);
        if (c.isGameOver()) return null;
        moveResult = c.move({
          from: from as Square,
          to: to as Square,
          promotion: promotion || 'q',
        });
        if (!moveResult) return null;
        newFen = c.fen();
      } catch {
        return null;
      }
      const uci = `${from}${to}${moveResult.promotion || ''}`;
      const item: MoveHistoryItem = { san: moveResult.san, uci, fen: newFen };
      // setHistory synchrone via valeur calculée (évite les lectures stale).
      const updated = [...history.slice(0, currentIndex + 1), item];
      setHistory(updated);
      setCurrentIndex(updated.length - 1);
      setFen(newFen);
      setLastMove([from, to]);
      return { san: moveResult.san, uci, newFen };
    },
    [history, currentIndex],
  );

  /** Ajoute un coup déjà validé (ex. réponse adverse du trainer). */
  const appendValidatedMove = useCallback(
    (san: string, uci: string, newFen: string) => {
      const item: MoveHistoryItem = { san, uci, fen: newFen };
      const updated = [...history.slice(0, currentIndex + 1), item];
      setHistory(updated);
      setCurrentIndex(updated.length - 1);
      setFen(newFen);
      setLastMove([uci.slice(0, 2), uci.slice(2, 4)]);
    },
    [history, currentIndex],
  );

  /**
   * Réponse adverse du trainer : prolonge la position COURANTE (tronque le
   * futur). L'ancien code ajoutait en fin d'historique avec un simple +1 :
   * après un redémarrage auto (jumpTo(0) sur une longue ligne), la réplique
   * atterrissait au bout de l'ancienne ligne pendant que currentIndex
   * pointait son premier coup — l'entraînement validait alors contre la
   * mauvaise position. Sûr dans un setTimeout (index frais via le miroir).
   */
  const appendOpponentMove = useCallback((san: string, uci: string, newFen: string) => {
    const item: MoveHistoryItem = { san, uci, fen: newFen };
    const base = indexRef.current;
    setHistory((prev) => spliceAppend(prev, base, item).history);
    setCurrentIndex(base + 1);
    indexRef.current = base + 1;
    setFen(newFen);
    setLastMove([uci.slice(0, 2), uci.slice(2, 4)]);
  }, []);

  return useMemo(() => ({
    fen,
    history,
    currentIndex,
    lastMove,
    jumpTo,
    reset,
    loadLine,
    playPhysicalMove,
    appendValidatedMove,
    appendOpponentMove,
    goBack: () => jumpTo(currentIndex - 1),
    goForward: () => jumpTo(currentIndex + 1),
  }), [
    fen, history, currentIndex, lastMove, jumpTo, reset, loadLine,
    playPhysicalMove, appendValidatedMove, appendOpponentMove,
  ]);
}

export type ChessTimeline = ReturnType<typeof useChessTimeline>;
