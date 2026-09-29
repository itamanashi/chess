import type { GameReport, MoveAnnotation } from '../utils/accuracy';
import { analyzeGamePgn, type GameAnalysisOptions } from './gameAnalysis';

/**
 * Couche compatibilité « Stockfish » → rapport en-croissant sur moteur LOCAL.
 *
 * L'ancien service évaluait les coups avec des heuristiques matérielles
 * (captures, centre, roque…) : scores flatteurs et sans rapport avec la
 * réalité tactique. Il délègue désormais à `services/gameAnalysis.ts`
 * (vrai Stockfish WASM, analyse à rebours, MultiPV ≥ 2, Win% Lichess).
 *
 * Contrats publics conservés : `analyzeGameAccuracy` et `analyzeGamesBatch`
 * gardent leurs signatures (la précision simple = moyenne W/B pour les
 * anciens appelants ; le rapport complet est exposé en plus).
 */

export interface MoveDetail {
  move: string;
  /** Précision du coup (0-100, formule Lichess). */
  score: number;
  /** Annotation + meilleur coup, ex. « ?? (Txd5!) » ou « Coup standard ». */
  reason: string;
}

export interface AnalysisResult {
  /** Précision moyenne W+B (0-100, compat historique). */
  accuracy: number;
  /** Précision des Blancs (null si aucun coup blanc). */
  whiteAccuracy: number | null;
  /** Précision des Noirs (null si aucun coup noir). */
  blackAccuracy: number | null;
  /** Nombre de coups analysés. */
  movesAnalyzed: number;
  /** Détails par coup (ordre chronologique). */
  moveDetails: MoveDetail[];
  /** Rapport complet (ACPL, annotations, phases, plis). */
  report: GameReport | null;
}

export interface BatchOptions extends Pick<GameAnalysisOptions, 'depth' | 'timeoutMsPerMove' | 'signal'> {
  /** Lignes moteur par position (≥ 2 imposé par gameAnalysis). */
  multiPv?: number;
}

/** Progression batch : (parties terminées, total). */
export type BatchProgress = (current: number, total: number) => void;

function detailReason(annotation: MoveAnnotation, bestSan?: string): string {
  // Libellés façon revue chess.com : « ! » = Génial (Great), « ?! » =
  // Imprécision, « ?? » = Gaffe (pas les termes Lichess Excellent/Douteux/Blunder).
  const label: Record<Exclude<MoveAnnotation, ''>, string> = {
    '!!': 'Brillant',
    '!': 'Génial',
    '!?': 'Intéressant',
    '?!': 'Imprécision',
    '?': 'Erreur',
    '??': 'Gaffe',
  };
  if (annotation === '') return 'Coup standard';
  const best = bestSan ? ` (idée : ${bestSan})` : '';
  return `${label[annotation]} ${annotation}${best}`;
}

/**
 * Analyse UNE partie (PGN) avec le vrai moteur local.
 * Ne lève jamais sur PGN vide/illisible (retourne un résultat à 0 + rapport null,
 * comme l'ancien contrat) ; lève AbortError seulement si `signal` annule.
 */
export async function analyzeGameAccuracy(
  pgn: string,
  onProgress?: (progress: number) => void,
  opts: BatchOptions = {},
): Promise<AnalysisResult> {
  const empty: AnalysisResult = {
    accuracy: 0,
    whiteAccuracy: null,
    blackAccuracy: null,
    movesAnalyzed: 0,
    moveDetails: [],
    report: null,
  };
  if (!pgn || !pgn.trim()) return empty;
  let result;
  try {
    result = await analyzeGamePgn(pgn, {
      depth: opts.depth ?? 12,
      timeoutMsPerMove: opts.timeoutMsPerMove ?? 1200,
      multiPv: opts.multiPv ?? 2,
      signal: opts.signal,
      onProgress: onProgress ? (done, total) => onProgress(total > 0 ? done / total : 0) : undefined,
      priority: 'background',
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') throw err;
    if (opts.signal?.aborted) {
      throw opts.signal.reason instanceof Error ? opts.signal.reason : new DOMException('Analyse annulée', 'AbortError');
    }
    return empty;
  }

  const moveDetails: MoveDetail[] = result.plies.map((p) => ({
    move: p.san,
    score: Math.round(p.accuracy),
    reason: detailReason(p.annotation, p.isBest ? undefined : p.bestSan),
  }));
  const { white, black } = result.accuracy;
  const vals = [white, black].filter((v): v is number => typeof v === 'number');
  const accuracy = vals.length > 0 ? Math.round(vals.reduce((s, v) => s + v, 0) / vals.length) : 0;

  return {
    accuracy,
    whiteAccuracy: white,
    blackAccuracy: black,
    movesAnalyzed: result.totalPlies,
    moveDetails,
    report: result,
  };
}

/**
 * Analyse plusieurs parties en séquentiel (UN seul worker Stockfish :
 * le parallélisme n'apporterait rien, la file moteur sérialise déjà).
 * `results[i] = -1` si la partie i est illisible (contrat historique).
 */
export async function analyzeGamesBatch(
  games: Array<{ pgn: string }>,
  onProgress?: BatchProgress,
  opts: BatchOptions = {},
): Promise<number[]> {
  const results: number[] = new Array(games.length).fill(-1);
  for (let i = 0; i < games.length; i++) {
    if (opts.signal?.aborted) {
      throw opts.signal.reason instanceof Error ? opts.signal.reason : new DOMException('Analyse annulée', 'AbortError');
    }
    try {
      const r = await analyzeGameAccuracy(games[i].pgn, undefined, opts);
      results[i] = r.report ? r.accuracy : -1;
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') throw err;
      results[i] = -1;
    }
    try {
      onProgress?.(i + 1, games.length);
    } catch {
      /* listener must never break the run */
    }
  }
  return results;
}
