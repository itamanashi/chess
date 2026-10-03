/**
 * Analyse de précision — spec en-croissant / Lichess.
 *
 * Références :
 *  - docs en-croissant « Analyze Game » : Win% Lichess, Win% loss comme
 *    métrique primaire, MultiPV ≥ 2, analyse à rebours, annotations
 *    !!/!/!?/?!/?/?? avec sacrifices + « only sound move ».
 *  - lila `AccuracyPercent.scala` : précision par coup + précision de partie
 *    (moyenne pondérée par volatilité + moyenne harmonique) / 2.
 *
 * Conventions (엄격, partagées avec `engineAdvantage.ts`) :
 *  - les evals moteur brutes sont relatives au TRAIT (UCI) ;
 *  - Win% est TOUJOURS perspective Blancs (0..100) ;
 *  - la précision d'un coup est perspective JOUEUR
 *    (on replie Win% : pov = blanc ? w : 100 - w).
 */

import type { PieceKind, ScoreValue } from '../types/chess';

export type { PieceKind, ScoreValue };

// ---------------------------------------------------------------------------
// Constantes (Lichess, inchangées).
// ---------------------------------------------------------------------------

/** Pente logistique Win% (≈ échelle 400 Elo). */
export const WIN_CHANCE_K = 0.00368208;
/** Précision par coup : a * exp(-k * winDiff) + b (+ bonus d'incertitude). */
export const MOVE_ACC_A = 103.1668;
export const MOVE_ACC_K = 0.04354;
export const MOVE_ACC_B = -3.1669;
export const MOVE_ACC_BONUS = 1;

/** Seuils d'annotation en-croissant (perte de Win% : best − joué, pov joueur). */
export const ANNOTATION_THRESHOLDS = {
  dubious: 5,
  mistake: 10,
  blunder: 20,
} as const;

/** Écart best − 2e best au-delà duquel le meilleur coup est « only sound ». */
export const ONLY_SOUND_GAP = 10;

/** Cp initial Lichess (position de départ légèrement blanche). */
export const INITIAL_CP = 15;

/** Plafond cp pour les mates dans les conversions Win% (décisif, borné). */
export const MATE_WIN_CP = 1000;

export type MoveAnnotation = '!!' | '!' | '!?' | '?!' | '?' | '??' | '';
export type PhaseName = 'opening' | 'middlegame' | 'endgame';

// ---------------------------------------------------------------------------
// Win% (perspective Blancs, 0..100).
// ---------------------------------------------------------------------------

/** Centipawns (perspective Blancs) → Win% Blancs. */
export function getWinChance(centipawns: number): number {
  return 50 + 50 * (2 / (1 + Math.exp(-WIN_CHANCE_K * centipawns)) - 1);
}

/** Alias explicite : cp Blancs → Win% Blancs. */
export function whiteCpToWinChance(whiteCp: number): number {
  return getWinChance(whiteCp);
}

/** Score cp/mate (relatif au trait) → cp perspective Blancs. */
export function scoreToWhiteCp(
  score: { cp?: number; mate?: number },
  sideToMove: 'w' | 'b',
): number {
  if (typeof score.mate === 'number') {
    const sign = sideToMove === 'w' ? 1 : -1;
    return sign * (score.mate > 0 ? MATE_WIN_CP : -MATE_WIN_CP);
  }
  const cp = typeof score.cp === 'number' && Number.isFinite(score.cp) ? score.cp : 0;
  return (sideToMove === 'w' ? 1 : -1) * cp;
}

/** Score (trait-relatif) → Win% Blancs direct. */
export function scoreToWhiteWinChance(
  score: { cp?: number; mate?: number },
  sideToMove: 'w' | 'b',
): number {
  return whiteCpToWinChance(scoreToWhiteCp(score, sideToMove));
}

/** Win% Blancs → Win% point de vue joueur. */
export function whiteWinToPov(whiteWin: number, color: 'white' | 'black'): number {
  return color === 'white' ? whiteWin : 100 - whiteWin;
}

// ---------------------------------------------------------------------------
// Précision par coup (formule Lichess exacte).
// ---------------------------------------------------------------------------

/**
 * Précision d'un coup depuis Win% pov joueur AVANT / APRÈS.
 * Si le coup améliore la position (after >= before) → 100.
 */
export function moveAccuracyFromWinPercents(beforePov: number, afterPov: number): number {
  if (afterPov >= beforePov) return 100;
  const winDiff = beforePov - afterPov;
  const raw = MOVE_ACC_A * Math.exp(-MOVE_ACC_K * winDiff) + MOVE_ACC_B + MOVE_ACC_BONUS;
  return Math.max(0, Math.min(100, raw));
}

/**
 * Précision d'un coup depuis des cps perspective Blancs + couleur du joueur.
 * (Replie Win% côté joueur avant d'appliquer la formule.)
 */
export function moveAccuracyFromWhiteCp(
  beforeWhiteCp: number,
  afterWhiteCp: number,
  color: 'white' | 'black',
): number {
  const before = whiteWinToPov(whiteCpToWinChance(beforeWhiteCp), color);
  const after = whiteWinToPov(whiteCpToWinChance(afterWhiteCp), color);
  return moveAccuracyFromWinPercents(before, after);
}

// ---------------------------------------------------------------------------
// Agrégation de partie (lila AccuracyPercent.gameAccuracy).
// Moyenne pondérée par volatilité + moyenne harmonique, / 2, par couleur.
// ---------------------------------------------------------------------------

function mean(xs: number[]): number {
  return xs.reduce((s, v) => s + v, 0) / xs.length;
}

export function standardDeviation(xs: number[]): number {
  if (xs.length === 0) return 0;
  const m = mean(xs);
  return Math.sqrt(mean(xs.map((x) => (x - m) ** 2)));
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function weightedMean(pairs: Array<[number, number]>): number | null {
  let sw = 0;
  let s = 0;
  for (const [v, w] of pairs) {
    s += v * w;
    sw += w;
  }
  return sw > 0 ? s / sw : null;
}

function harmonicMean(xs: number[]): number | null {
  if (xs.length === 0) return null;
  let s = 0;
  for (const x of xs) {
    if (x <= 0) return 0;
    s += 1 / x;
  }
  return xs.length / s;
}

export interface AccuracySample {
  /** Win% pov joueur AVANT le coup. */
  beforePov: number;
  /** Win% pov joueur APRÈS le coup. */
  afterPov: number;
  /** Couleur du joueur qui vient de jouer. */
  color: 'white' | 'black';
}

/**
 * Précision de partie par couleur, fidèle à lila :
 * poids = écart-type glissant des Win% (fenêtre size/10 clampée 2..8),
 * poids clampé 0.5..12, puis (weightedMean + harmonicMean) / 2.
 */
export function gameAccuracyByColor(samples: AccuracySample[]): { white: number | null; black: number | null } {
  const out: { white: number | null; black: number | null } = { white: null, black: null };
  (['white', 'black'] as const).forEach((color) => {
    const own = samples.filter((s) => s.color === color);
    if (own.length === 0) return;
    // Win% pov joueur chaînés : before0, after0(=before1), …
    const povWins: number[] = [own[0].beforePov, ...own.map((s) => s.afterPov)];
    const windowSize = clamp(Math.floor(samples.length / 10), 2, 8);
    const weights: number[] = own.map((_, i) => {
      const win = povWins.slice(i, i + windowSize);
      while (win.length < windowSize) win.push(win[win.length - 1] ?? 50);
      return clamp(standardDeviation(win), 0.5, 12);
    });
    const accs = own.map((s) => moveAccuracyFromWinPercents(s.beforePov, s.afterPov));
    const weighted = weightedMean(accs.map((a, i) => [a, weights[i]] as [number, number]));
    const harmonic = harmonicMean(accs);
    if (weighted === null || harmonic === null) return;
    out[color] = clamp((weighted + harmonic) / 2, 0, 100);
  });
  return out;
}

/**
 * Variante pratique : depuis une liste de cps perspective Blancs
 * (position initiale INCLUSE en tête) + couleur du trait initial.
 */
export function gameAccuracyFromWhiteCps(
  whiteCps: number[],
  startColor: 'white' | 'black' = 'white',
): { white: number | null; black: number | null } {
  const samples: AccuracySample[] = [];
  for (let i = 0; i + 1 < whiteCps.length; i++) {
    const mover: 'white' | 'black' = i % 2 === 0 ? startColor : startColor === 'white' ? 'black' : 'white';
    samples.push({
      beforePov: whiteWinToPov(whiteCpToWinChance(whiteCps[i]), mover),
      afterPov: whiteWinToPov(whiteCpToWinChance(whiteCps[i + 1]), mover),
      color: mover,
    });
  }
  return gameAccuracyByColor(samples);
}

// ---------------------------------------------------------------------------
// Annotations en-croissant.
// ---------------------------------------------------------------------------

export interface AnnotationContext {
  /** Perte Win% pov joueur : best − joué (≥ 0 = le coup coûte). */
  winLoss: number;
  /** Le coup est-il un sacrifice matériel ? */
  isSacrifice?: boolean;
  /** Le meilleur coup est-il le seul raisonnable ? */
  isOnlySound?: boolean;
  /** Le coup adverse précédent était-il une erreur (?! ou pire) ? */
  prevOpponentMistake?: boolean;
}

/**
 * Table en-croissant :
 *  ?? 20..100 · ? 10..20 · ?! 5..10 · !? sacrifice non-only-sound ·
 *  ! only-sound qui punit · !! sacrifice + only-sound.
 */
export function classifyAnnotation(ctx: AnnotationContext): MoveAnnotation {
  const { winLoss } = ctx;
  if (winLoss >= ANNOTATION_THRESHOLDS.blunder) return '??';
  if (winLoss >= ANNOTATION_THRESHOLDS.mistake) return '?';
  if (winLoss >= ANNOTATION_THRESHOLDS.dubious) return '?!';
  if (ctx.isSacrifice && ctx.isOnlySound) return '!!';
  if (ctx.isSacrifice) return '!?';
  if (ctx.isOnlySound && ctx.prevOpponentMistake) return '!';
  return '';
}

/** Best vs 2e best : écart Win% pov joueur ≥ seuil → « only sound ». */
export function isOnlySoundMove(bestPovWin: number, secondBestPovWin: number | null, gap = ONLY_SOUND_GAP): boolean {
  if (secondBestPovWin === null || !Number.isFinite(secondBestPovWin)) return false;
  return bestPovWin - secondBestPovWin >= gap;
}

// ---------------------------------------------------------------------------
// Rapport de partie.
// ---------------------------------------------------------------------------

export interface AnalyzedPly {
  ply: number;
  san: string;
  color: 'white' | 'black';
  /** Pièce ayant joué le coup (roque = roi). Absent des vieux rapports. */
  piece?: PieceKind;
  /** Eval APRÈS le coup, perspective Blancs. */
  whiteCp: number;
  mate?: number;
  /** Win% Blancs APRÈS le coup. */
  whiteWin: number;
  /** Meilleur coup moteur à cette position (avant le coup joué). */
  bestSan?: string;
  bestUci?: string;
  bestWhiteCp?: number;
  /** Mat annoncé pour le trait avant le coup (> 0 = le trait mate). */
  bestMate?: number;
  /** Perte Win% pov joueur (best − joué). */
  winLoss: number;
  /** Perte cp pov joueur (best − joué, ≥ 0). */
  cpLoss: number;
  accuracy: number;
  annotation: MoveAnnotation;
  isBest: boolean;
  isOnlySound: boolean;
  isSacrifice: boolean;
  /** Ligne moteur du meilleur coup (variante à afficher sur les erreurs). */
  bestLineSans?: string[];
}

export interface GameReport {
  plies: AnalyzedPly[];
  accuracy: { white: number | null; black: number | null };
  acpl: { white: number | null; black: number | null };
  annotations: Record<Exclude<MoveAnnotation, ''>, number>;
  phases: Record<PhaseName, { white: number | null; black: number | null }>;
}

/** Phase simplifiée (pli) : ouverture ≤ 20, milieu ≤ 60, sinon finale. */
export function phaseOfPly(ply: number): PhaseName {
  if (ply <= 20) return 'opening';
  if (ply <= 60) return 'middlegame';
  return 'endgame';
}

export function emptyAnnotationCounts(): GameReport['annotations'] {
  return { '!!': 0, '!': 0, '!?': 0, '?!': 0, '?': 0, '??': 0 };
}

/** Construit le rapport (précisions, ACPL, annotations, phases) depuis les plis. */
export function buildGameReport(plies: AnalyzedPly[]): GameReport {
  const samples: AccuracySample[] = plies.map((p) => {
    const moverWinAfter = whiteWinToPov(p.whiteWin, p.color);
    // before = after du pli précédent (ou position initiale).
    const idx = plies.indexOf(p);
    const beforeWhiteWin = idx === 0 ? whiteCpToWinChance(INITIAL_CP) : plies[idx - 1].whiteWin;
    return {
      beforePov: whiteWinToPov(beforeWhiteWin, p.color),
      afterPov: moverWinAfter,
      color: p.color,
    };
  });
  const accuracy = gameAccuracyByColor(samples);

  const acpl = ((): GameReport['acpl'] => {
    const acc: Record<'white' | 'black', number[]> = { white: [], black: [] };
    for (const p of plies) acc[p.color].push(p.cpLoss);
    const avg = (xs: number[]): number | null => (xs.length ? mean(xs) : null);
    return { white: avg(acc.white), black: avg(acc.black) };
  })();

  const annotations = emptyAnnotationCounts();
  for (const p of plies) {
    if (p.annotation !== '') annotations[p.annotation as Exclude<MoveAnnotation, ''>]++;
  }

  const phases = ((): GameReport['phases'] => {
    const byPhase: Record<PhaseName, AccuracySample[]> = { opening: [], middlegame: [], endgame: [] };
    plies.forEach((p, i) => {
      byPhase[phaseOfPly(p.ply)].push(samples[i]);
    });
    return {
      opening: gameAccuracyByColor(byPhase.opening),
      middlegame: gameAccuracyByColor(byPhase.middlegame),
      endgame: gameAccuracyByColor(byPhase.endgame),
    };
  })();

  return { plies, accuracy, acpl, annotations, phases };
}

// ---------------------------------------------------------------------------
// Compatibilité ascendante (TrainerPanel + anciens appelants).
// Réimplémentés sur le cœur ci-dessus, avec gestion mate correcte.
// ---------------------------------------------------------------------------

function legacyScoreToWhiteCp(score: ScoreValue, color: 'white' | 'black'): number {
  // ScoreValue est déjà « pov joueur » dans l'ancien contrat (inversé pour
  // les Noirs à l'appel). On le replie vers Blancs ici.
  const povCp = score.type === 'mate'
    ? Math.sign(score.value || 1) * MATE_WIN_CP
    : score.value;
  return color === 'white' ? povCp : -povCp;
}

/** Précision (%) entre deux évaluations (contrat historique du trainer). */
export function getAccuracy(
  prevScore: ScoreValue,
  nextScore: ScoreValue,
  color: 'white' | 'black',
): number {
  const beforeWhite = legacyScoreToWhiteCp(prevScore, color);
  const afterWhite = legacyScoreToWhiteCp(nextScore, color);
  return Math.round(moveAccuracyFromWhiteCp(beforeWhite, afterWhite, color));
}

/** Perte cp pov joueur (≥ 0). */
export function getCPLoss(
  prevScore: ScoreValue,
  nextScore: ScoreValue,
  color: 'white' | 'black',
): number {
  const diff = legacyScoreToWhiteCp(prevScore, color) - legacyScoreToWhiteCp(nextScore, color);
  const signed = color === 'white' ? diff : -diff;
  return Math.max(0, signed);
}

/** Annotation rapide sans contexte moteur (seuils ?!/?/?? uniquement). */
export function getAnnotation(
  prevScore: ScoreValue | null,
  nextScore: ScoreValue,
  color: 'white' | 'black',
): MoveAnnotation {
  if (!prevScore) return '';
  const beforeWhite = legacyScoreToWhiteCp(prevScore, color);
  const afterWhite = legacyScoreToWhiteCp(nextScore, color);
  const winLoss =
    whiteWinToPov(whiteCpToWinChance(beforeWhite), color) -
    whiteWinToPov(whiteCpToWinChance(afterWhite), color);
  return classifyAnnotation({ winLoss });
}

/**
 * Annotation enrichie (contrat historique) : ajoute !/!!/!? quand le
 * contexte sacrifice est fourni. Le « only sound » complet (MultiPV 2)
 * est calculé par `services/gameAnalysis.ts`.
 */
export function evaluateMoveAnnotation(
  prevPrevScore: ScoreValue | null,
  prevScore: ScoreValue | null,
  nextScore: ScoreValue,
  color: 'white' | 'black',
  _san: string,
  isSacrifice?: boolean,
): MoveAnnotation {
  if (!prevScore) return '';
  void prevPrevScore;
  const beforeWhite = legacyScoreToWhiteCp(prevScore, color);
  const afterWhite = legacyScoreToWhiteCp(nextScore, color);
  const winLoss =
    whiteWinToPov(whiteCpToWinChance(beforeWhite), color) -
    whiteWinToPov(whiteCpToWinChance(afterWhite), color);
  return classifyAnnotation({ winLoss, isSacrifice });
}

/** Couleur d'affichage d'une précision (pastilles et tableaux). */
export function accuracyColor(v: number | null | undefined): string {
  if (v === null || v === undefined) return '#8e887c';
  if (v >= 90) return '#8fb996';
  if (v >= 80) return '#9a9488';
  if (v >= 70) return '#ead9b5';
  if (v >= 50) return '#d29e6a';
  return '#d8816f';
}

/** Score par défaut d'une position neutre. */
export const INITIAL_SCORE: ScoreValue = {
  type: 'cp',
  value: 0,
};
