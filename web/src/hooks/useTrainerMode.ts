import { useCallback, useEffect, useMemo, useState } from 'react';
import type { TrainingStats } from '../types/chess';
import {
  loadTrainerReviews,
  saveTrainerReviews,
  scheduleTrainerReview,
  summarizeTrainerReviews,
  TrainerRating,
  type TrainerReviews,
} from '../storage/trainerReviews';

const INITIAL_STATS: TrainingStats = {
  correctMoves: 0,
  wrongMoves: 0,
  currentStreak: 0,
  bestStreak: 0,
  linesCompleted: 0,
};
const EMPTY_POSITION_KEYS: readonly string[] = [];

/**
 * État du mode entraînement : feedback du dernier coup, indice, fin de ligne,
 * statistiques. Réinitialisé à chaque navigation (jump / open / reset).
 */
export function useTrainerMode(
  repertoireId?: string,
  positionKeys: readonly string[] = EMPTY_POSITION_KEYS,
) {
  const [lastSuccess, setLastSuccess] = useState<boolean | null>(null);
  const [expectedMoveSan, setExpectedMoveSan] = useState('');
  /** UCI du coup attendu (flèche de correction sur l'échiquier). */
  const [expectedMoveUci, setExpectedMoveUci] = useState('');
  const [userPlayedSan, setUserPlayedSan] = useState('');
  const [hintRevealed, setHintRevealed] = useState(false);
  const [isLineFinished, setIsLineFinished] = useState(false);
  const [stats, setStats] = useState<TrainingStats>(INITIAL_STATS);
  const [reviews, setReviews] = useState<TrainerReviews>(loadTrainerReviews);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  const recordReview = useCallback((
    positionKey: string | undefined,
    rating: TrainerRating,
  ) => {
    if (!repertoireId || !positionKey) return;
    const key = `${repertoireId}::${positionKey}`;
    setReviews((current) => ({
      ...current,
      [key]: scheduleTrainerReview(current[key], rating),
    }));
  }, [repertoireId]);

  useEffect(() => {
    saveTrainerReviews(reviews);
  }, [reviews]);

  const reviewSummary = useMemo(() => {
    const repertoireReviews = repertoireId
      ? Object.fromEntries(
          Object.entries(reviews)
            .filter(([key]) => key.startsWith(`${repertoireId}::`))
            .map(([key, review]) => [key.slice(repertoireId.length + 2), review]),
        )
      : {};
    return summarizeTrainerReviews(
      repertoireReviews,
      positionKeys,
      now,
    );
  }, [repertoireId, reviews, positionKeys, now]);

  /** À appeler sur navigation / ouverture / restart : évite les flags fantômes. */
  const resetForNavigation = useCallback(() => {
    setLastSuccess(null);
    setExpectedMoveUci('');
    setHintRevealed(false);
    setIsLineFinished(false);
  }, []);

  const feedbackSuccess = useCallback((positionKey?: string, usedHint = false) => {
    setLastSuccess(true);
    recordReview(positionKey, usedHint ? TrainerRating.Hard : TrainerRating.Good);
    setStats((prev) => ({
      ...prev,
      correctMoves: prev.correctMoves + 1,
      currentStreak: prev.currentStreak + 1,
      bestStreak: Math.max(prev.bestStreak, prev.currentStreak + 1),
    }));
  }, [recordReview]);

  const feedbackError = useCallback((
    playedSan: string,
    expectedSan: string,
    expectedUci = '',
    positionKey?: string,
  ) => {
    setLastSuccess(false);
    recordReview(positionKey, TrainerRating.Again);
    setUserPlayedSan(playedSan);
    setExpectedMoveSan(expectedSan);
    setExpectedMoveUci(expectedUci);
    setStats((prev) => ({
      ...prev,
      wrongMoves: prev.wrongMoves + 1,
      currentStreak: 0,
    }));
  }, [recordReview]);

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
    reviewSummary,
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
    hintRevealed, isLineFinished, stats, reviewSummary,
    setExpectedMoveSan, setExpectedMoveUci, setLastSuccess,
    setHintRevealed, setIsLineFinished, resetForNavigation,
    feedbackSuccess, feedbackError, completeLine, resetStats, showHint,
  ]);
}

export type TrainerMode = ReturnType<typeof useTrainerMode>;
