import { Chess, type Square } from 'chess.js';
import type { EngineMove, PieceKind } from '../types/chess';
import {
  ANNOTATION_THRESHOLDS,
  buildGameReport,
  classifyAnnotation,
  isOnlySoundMove,
  moveAccuracyFromWinPercents,
  scoreToWhiteCp,
  whiteCpToWinChance,
  whiteWinToPov,
  type AnalyzedPly,
  type GameReport,
  type MoveAnnotation,
} from '../utils/accuracy';
import { normalizeCastleUci } from '../utils/repertoire';
import { analyzeLocalFen } from './localEngine';

// ---------------------------------------------------------------------------
// Rapport de partie façon en-croissant, sur Stockfish LOCAL (WASM).
//
//  - analyse À REBOURS (finale → début : le hash moteur est réutilisé,
//    cf. docs en-croissant « Analyze Game ») ;
//  - MultiPV ≥ 2 toujours (il faut le 2e meilleur coup pour « only sound »
//    et la vraie perte Win% best − joué) ;
//  - Win% Lichess + précision Lichess + annotations !!/!/!?/?!/?/??
//    (cf. `utils/accuracy.ts`) ;
//  - `analyzeFn` injectable : les tests fournissent un faux moteur
//    (jamais de Worker dans vitest).
// ---------------------------------------------------------------------------

export interface GameAnalysisOptions {
  /** Profondeur Stockfish (défaut 16 : rapport lisible sans attendre). */
  depth?: number;
  /** Lignes analysées (≥ 2 imposé, défaut 2). */
  multiPv?: number;
  /** Budget par position en ms (défaut 2500). */
  timeoutMsPerMove?: number;
  /** Inclure la variante du meilleur coup sur les erreurs (défaut true). */
  showVariations?: boolean;
  /** Annulation appelante (naviguer / fermer / autre analyse). */
  signal?: AbortSignal;
  /** Progression positions traitées (0..total). */
  onProgress?: (done: number, total: number) => void;
  /** Moteur injecté (tests). Signature = sous-ensemble de analyzeLocalFen. */
  analyzeFn?: (fen: string, opts: { multiPv: number; depth: number; timeoutMs: number; signal?: AbortSignal }) => Promise<EngineMove[]>;
  /** Priorité file moteur (le rapport batch reste en fond). */
  priority?: 'interactive' | 'background';
}

export interface GameAnalysisResult extends GameReport {
  movesAnalyzed: number;
  totalPlies: number;
}

export const DEFAULT_ANALYSIS_DEPTH = 16;
export const DEFAULT_ANALYSIS_TIMEOUT_MS = 2500;
export const MIN_ANALYSIS_MULTIPV = 2;

const PIECE_VALUES: Record<string, number> = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw signal.reason instanceof Error ? signal.reason : new DOMException('Analyse annulée', 'AbortError');
  }
}

/** Matériel (pions = 1, …) d'un camp sur un plateau chess.js. */
function materialOf(board: Chess, color: 'w' | 'b'): number {
  let total = 0;
  for (const row of board.board()) {
    for (const sq of row) {
      if (sq && sq.color === color) total += PIECE_VALUES[sq.type] ?? 0;
    }
  }
  return total;
}

/**
 * Sacrifice (approximation documentée du « lightweight Alpha-Beta » en-croissant) :
 * le joueur PERD ≥ 2 points de matériel relatif (pièce mineure ≈ 3) mais sa
 * perte Win% reste < 5 (le moteur valide : c'était le bon plan).
 * Les promotions faussent le compteur (matériel qui monte) → jamais sacrifice.
 */
export function isSacrificeHeuristic(
  fenBefore: string,
  playedUci: string,
  mover: 'w' | 'b',
  winLossPov: number,
): boolean {
  if (winLossPov >= ANNOTATION_THRESHOLDS.dubious) return false;
  let before: Chess;
  let after: Chess;
  try {
    before = new Chess(fenBefore);
    after = new Chess(fenBefore);
    const promo = playedUci.length > 4 ? playedUci[4]?.toLowerCase() : undefined;
    const m = after.move({
      from: playedUci.slice(0, 2) as Square,
      to: playedUci.slice(2, 4) as Square,
      promotion: (promo === 'q' || promo === 'r' || promo === 'b' || promo === 'n' ? promo : undefined) as 'q' | 'r' | 'b' | 'n' | undefined,
    });
    if (!m) return false;
    if (m.promotion) return false;
  } catch {
    return false;
  }
  const me = mover;
  const opp = mover === 'w' ? 'b' : 'w';
  const delta = materialOf(after, me) - materialOf(after, opp) - (materialOf(before, me) - materialOf(before, opp));
  return delta <= -2;
}

/** Valeur blanche d'une position : eval moteur (trait-relatif) ou terminal. */
function positionWhiteCp(
  fen: string,
  moves: EngineMove[] | null,
  fallbackCp: number,
): { whiteCp: number; mate?: number } {
  if (moves && moves.length > 0) {
    const top = moves[0];
    const side: 'w' | 'b' = fen.split(' ')[1] === 'b' ? 'b' : 'w';
    return { whiteCp: scoreToWhiteCp({ cp: top.cp, mate: top.mate }, side), mate: top.mate };
  }
  // Position terminale sans ligne moteur : mat / pat / nulle.
  try {
    const b = new Chess(fen);
    if (b.isCheckmate()) {
      const stm: 'w' | 'b' = b.turn();
      return { whiteCp: stm === 'w' ? -1000 : 1000, mate: stm === 'w' ? -1 : 1 };
    }
    if (b.isDraw() || b.isStalemate() || b.isThreefoldRepetition() || b.isInsufficientMaterial()) {
      return { whiteCp: 0 };
    }
  } catch {
    /* FEN invalide : repli ci-dessous */
  }
  return { whiteCp: fallbackCp };
}

interface ReplayStep {
  san: string;
  uci: string;
  /** Pièce ayant joué le coup (roque = roi, promotion = pion). */
  piece: PieceKind;
  fenBefore: string;
  fenAfter: string;
  mover: 'w' | 'b';
}

/** Rejoue les SAN → UCI normalisés + FEN avant/après (lève si coup illégal). */
export function replaySans(sans: string[]): { steps: ReplayStep[]; initialFen: string } {
  const board = new Chess();
  const initialFen = board.fen();
  const steps: ReplayStep[] = [];
  sans.forEach((san, i) => {
    const fenBefore = board.fen();
    const mover = board.turn();
    let m;
    try {
      m = board.move(san);
    } catch {
      throw new Error(`Coup illégal au ply ${i + 1} : « ${san} »`);
    }
    const uci = `${m.from}${m.to}${m.promotion ?? ''}`;
    steps.push({
      san: m.san,
      uci: normalizeCastleUci(fenBefore, uci),
      piece: m.piece as PieceKind,
      fenBefore,
      fenAfter: board.fen(),
      mover,
    });
  });
  return { steps, initialFen };
}

/**
 * Analyse une liste de SAN (PGN déjà parsé) et rend le rapport complet.
 * Lève AbortError si `signal` annule ; lève Error si aucun coup rejouable.
 */
export async function analyzeGameSans(sans: string[], opts: GameAnalysisOptions = {}): Promise<GameAnalysisResult> {
  const depth = opts.depth ?? DEFAULT_ANALYSIS_DEPTH;
  const multiPv = Math.max(MIN_ANALYSIS_MULTIPV, opts.multiPv ?? MIN_ANALYSIS_MULTIPV);
  const timeoutMs = opts.timeoutMsPerMove ?? DEFAULT_ANALYSIS_TIMEOUT_MS;
  const showVariations = opts.showVariations ?? true;
  const signal = opts.signal;
  const analyze: NonNullable<GameAnalysisOptions['analyzeFn']> = opts.analyzeFn ??
    ((fen, o) => analyzeLocalFen(fen, { multiPv: o.multiPv, depth: o.depth, timeoutMs: o.timeoutMs, signal: o.signal, priority: opts.priority ?? 'background' }));

  const { steps } = replaySans(sans);
  if (steps.length === 0) throw new Error('Partie vide : aucun coup à analyser.');

  const fens: string[] = [steps[0].fenBefore, ...steps.map((s) => s.fenAfter)];
  const total = fens.length;
  let done = 0;
  const report = (n: number): void => {
    try {
      opts.onProgress?.(n, total);
    } catch {
      /* listener must never break the run */
    }
  };
  report(0);

  // --- Passe moteur À REBOURS (finale d'abord : réutilisation du hash). ---
  const evals = new Array<EngineMove[] | null>(total).fill(null);
  for (let i = total - 1; i >= 0; i--) {
    throwIfAborted(signal);
    try {
      const moves = await analyze(fens[i], { multiPv, depth, timeoutMs, signal });
      evals[i] = moves.length > 0 ? moves : null;
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') throw err;
      if (signal?.aborted) throwIfAborted(signal);
      evals[i] = null; // position isolée en échec : repli sur les voisines
    }
    done++;
    report(done);
  }

  // --- Passe rapport (ordre chronologique). ---
  const plies: AnalyzedPly[] = [];
  let prevAnnotation: MoveAnnotation = '';
  // Eval de secours : la plus proche réussie (évite les faux blunders à 0).
  const nearestCp = (idx: number): number => {
    for (let d = 0; d < total; d++) {
      for (const j of [idx + d, idx - d]) {
        if (j >= 0 && j < total && evals[j] && evals[j]!.length > 0) {
          const top = evals[j]![0];
          const side: 'w' | 'b' = fens[j].split(' ')[1] === 'b' ? 'b' : 'w';
          return scoreToWhiteCp({ cp: top.cp, mate: top.mate }, side);
        }
      }
    }
    return 0;
  };

  steps.forEach((step, i) => {
    const color: 'white' | 'black' = step.mover === 'w' ? 'white' : 'black';
    const ply = i + 1;
    const sideBefore: 'w' | 'b' = step.mover;

    const beforeMoves = evals[i];
    const best = beforeMoves?.[0] ?? null;
    const second = beforeMoves?.[1] ?? null;
    const bestWhiteCp = best ? scoreToWhiteCp({ cp: best.cp, mate: best.mate }, sideBefore) : nearestCp(i);
    const bestPovWin = whiteWinToPov(whiteCpToWinChance(bestWhiteCp), color);

    const afterPos = positionWhiteCp(step.fenAfter, evals[i + 1], nearestCp(i + 1));
    const afterWhiteCp = afterPos.whiteCp;
    const afterPovWin = whiteWinToPov(whiteCpToWinChance(afterWhiteCp), color);

    const playedUci = step.uci;
    const bestUci = best ? normalizeCastleUci(step.fenBefore, best.uci) : undefined;
    const isBest = bestUci !== undefined && playedUci === bestUci;
    // Perte vs le MEILLEUR (métrique primaire en-croissant). Par construction
    // after ≤ best en théorie ; on borne à ≥ 0 (bruit moteur / repli).
    const winLoss = Math.max(0, bestPovWin - afterPovWin);
    const signedCp = color === 'white' ? bestWhiteCp - afterWhiteCp : afterWhiteCp - bestWhiteCp;
    const cpLoss = Math.max(0, Math.round(signedCp));

    const secondPovWin =
      second !== null && second !== undefined
        ? whiteWinToPov(whiteCpToWinChance(scoreToWhiteCp({ cp: second.cp, mate: second.mate }, sideBefore)), color)
        : null;
    const isOnlySound = isOnlySoundMove(bestPovWin, secondPovWin);
    const isSacrifice = isSacrificeHeuristic(step.fenBefore, playedUci, step.mover, winLoss);
    const prevOpponentMistake = prevAnnotation === '?' || prevAnnotation === '??' || prevAnnotation === '?!';
    const annotation = classifyAnnotation({ winLoss, isSacrifice, isOnlySound, prevOpponentMistake });
    prevAnnotation = annotation;

    plies.push({
      ply,
      san: step.san,
      color,
      piece: step.piece,
      whiteCp: afterWhiteCp,
      ...(afterPos.mate !== undefined ? { mate: afterPos.mate } : {}),
      whiteWin: whiteCpToWinChance(afterWhiteCp),
      ...(best ? { bestSan: best.san, bestUci, bestWhiteCp } : {}),
      ...(best && typeof best.mate === 'number' ? { bestMate: best.mate } : {}),
      winLoss: Math.round(winLoss * 10) / 10,
      cpLoss,
      // Précision Lichess : 100 si le coup égale le meilleur (winLoss = 0).
      accuracy: 0, // rempli ci-dessous via le cœur partagé (besoin before/after)
      annotation,
      isBest,
      isOnlySound,
      isSacrifice,
      ...(showVariations && best && annotation !== '' && annotation !== '!' && best.pvSans && best.pvSans.length > 1
        ? { bestLineSans: best.pvSans }
        : {}),
    });
  });

  // Précisions par coup via le cœur Lichess (before = valeur avant, after = après).
  // before du ply i = valeur blanche de fens[i] (best si dispo, sinon after du précédent).
  const beforeWhiteCps: number[] = steps.map((_, i) => {
    const bm = evals[i]?.[0];
    if (bm) {
      const side: 'w' | 'b' = fens[i].split(' ')[1] === 'b' ? 'b' : 'w';
      return scoreToWhiteCp({ cp: bm.cp, mate: bm.mate }, side);
    }
    return plies[i].whiteCp;
  });
  plies.forEach((p, i) => {
    const beforePov = whiteWinToPov(whiteCpToWinChance(beforeWhiteCps[i]), p.color);
    const afterPov = whiteWinToPov(p.whiteWin, p.color);
    p.accuracy = Math.round(moveAccuracyFromWinPercents(beforePov, afterPov) * 10) / 10;
  });

  const reportBuilt = buildGameReport(plies);
  const movesAnalyzed = evals.filter((e) => e && e.length > 0).length;
  return { ...reportBuilt, movesAnalyzed, totalPlies: steps.length };
}

/** Analyse depuis un PGN brut (en-têtes ignorées, coups rejoués). */
export async function analyzeGamePgn(pgn: string, opts: GameAnalysisOptions = {}): Promise<GameAnalysisResult> {
  const board = new Chess();
  try {
    board.loadPgn(pgn);
  } catch {
    throw new Error('PGN illisible : impossible d’extraire les coups.');
  }
  const sans = board.history();
  if (sans.length === 0) throw new Error('PGN sans coups.');
  return analyzeGameSans(sans, opts);
}
