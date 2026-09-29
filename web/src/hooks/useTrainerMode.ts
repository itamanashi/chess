import { useCallback, useMemo, useState } from 'react';
import type { TrainingStats } from '../types/chess';

const INITIAL_STATS: TrainingStats = {
  correctMoves: 0,
  wrongMoves: 0,
  currentStreak: 0,
  bestStreak: 0,
  linesCompleted: 0,
};

/**
 * État du mode entraînement : feedback du dernier coup, indice, fin de ligne,
 * statistiques. Réinitialisé à chaque navigation (jump / open / reset).
 */
export function useTrainerMode() {
  const [lastSuccess, setLastSuccess] = useState<boolean | null>(null);
  const [expectedMoveSan, setExpectedMoveSan] = useState('');
  /** UCI du coup attendu (flèche de correction sur l'échiquier). */
  const [expectedMoveUci, setExpectedMoveUci] = useState('');
  const [userPlayedSan, setUserPlayedSan] = useState('');
  const [hintRevealed, setHintRevealed] = useState(false);
  const [isLineFinished, setIsLineFinished] = useState(false);
  const [stats, setStats] = useState<TrainingStats>(INITIAL_STATS);

  /** À appeler sur navigation / ouverture / restart : évite les flags fantômes. */
  const resetForNavigation = useCallback(() => {
    setLastSuccess(null);
    setExpectedMoveUci('');
    setHintRevealed(false);
    setIsLineFinished(false);
  }, []);

  const feedbackSuccess = useCallback(() => {
    setLastSuccess(true);
    setStats((prev) => ({
      ...prev,
      correctMoves: prev.correctMoves + 1,
      currentStreak: prev.currentStreak + 1,
      bestStreak: Math.max(prev.bestStreak, prev.currentStreak + 1),
    }));
  }, []);

  const feedbackError = useCallback((playedSan: string, expectedSan: string, expectedUci = '') => {
    setLastSuccess(false);
    setUserPlayedSan(playedSan);
    setExpectedMoveSan(expectedSan);
    setExpectedMoveUci(expectedUci);
    setStats((prev) => ({
      ...prev,
      wrongMoves: prev.wrongMoves + 1,
      currentStreak: 0,
    }));
  }, []);

  const completeLine = useCallback(() => {
    setIsLineFinished(true);
    setStats((s) => ({ ...s, linesCompleted: s.linesCompleted + 1 }));
  }, []);

  const resetStats = useCallback(() => setStats(INITIAL_STATS), []);

  const showHint = useCallback(() => setHintRevealed(true), []);

  // Objet stable : sans useMemo, chaque rendu d'App recréait l'objet et
  // invalidait `executeMove`/`playUciMove` (dépendances), ce qui relançait
  // l'effet Chessground + tous les memos/effets du builder à chaque survol.
  return useMemo(() => ({
    lastSuccess,
    expectedMoveSan,
    expectedMoveUci,
    userPlayedSan,
    hintRevealed,
    isLineFinished,
    stats,
    setExpectedMoveSan,
    setExpectedMoveUci,
    setLastSuccess,
    setHintRevealed,
    setIsLineFinished,
    resetForNavigation,
    feedbackSuccess,
    feedbackError,
    completeLine,
    resetStats,
    showHint,
  }), [
    lastSuccess, expectedMoveSan, expectedMoveUci, userPlayedSan,
    hintRevealed, isLineFinished, stats,
    setExpectedMoveSan, setExpectedMoveUci, setLastSuccess,
    setHintRevealed, setIsLineFinished, resetForNavigation,
    feedbackSuccess, feedbackError, completeLine, resetStats, showHint,
  ]);
}

export type TrainerMode = ReturnType<typeof useTrainerMode>;
