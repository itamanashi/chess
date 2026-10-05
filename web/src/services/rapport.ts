import type { GameShape } from './chesscom';

/** Priorité d'un axe de progression (libellés FR affichés par le panneau). */
export type RapportPriority = 'high' | 'medium' | 'low';

export interface RapportOpeningRef {
  name: string;
  eco: string;
  wins: number;
  games: number;
}

/** Entrée pure du rapport : uniquement des nombres/chaînes déjà agrégés. */
export interface RapportInput {
  me: string;
  totalGames: number;
  wins: number;
  draws: number;
  losses: number;
  /** Score 0–100 (V + N/2). */
  score: number;
  whiteGames: number;
  whiteWins: number;
  blackGames: number;
  blackWins: number;
  botGamesCount: number;
  /** Précision moyenne Stockfish (null si aucune partie analysée). */
  overallAcc: number | null;
  analyzedCount: number;
  accWin: number | null;
  accWinCount: number;
  accLoss: number | null;
  accLossCount: number;
  accDraw: number | null;
  accDrawCount: number;
  /* Qualité des coups (comptes MoveQuality agrégés). */
  brilliant: number;
  best: number;
  excellent: number;
  good: number;
  inaccuracy: number;
  mistake: number;
  blunder: number;
  totalMoves: number;
  /* Tactique. */
  matesFound: number;
  matesMissed: number;
  forksFound: number;
  forksMissed: number;
  hangs: number;
  freebiesFound: number;
  freebiesMissed: number;
  /* Théorie. */
  theoryAvg: number | null;
  theoryCount: number;
  theoryAvailable: boolean;
  /* Forme narrative dominante. */
  topShape: GameShape;
  topShapePct: number;
  bestOpening: RapportOpeningRef | null;
  worstOpening: RapportOpeningRef | null;
  /* ACPL moyen du compte lié (perte moyenne en centipions, null si aucune analyse). */
  acplOverall: number | null;
  acplCount: number;
  /**
   * Comparaison période récente vs précédente (N dernières contre N
   * précédentes). `null`/absent = non calculée (le panneau masque la section).
   */
  evolution?: RapportEvolution | null;
  /* Précision moyenne par couleur jouée (null si aucune partie analysée). */
  accWhite: number | null;
  accWhiteCount: number;
  accBlack: number | null;
  accBlackCount: number;
  /* Parties marquantes (meilleure / à revoir, précision max/min). */
  bestGame: RapportGameRef | null;
  worstGame: RapportGameRef | null;
}

/** Référence vers une partie marquante (meilleure ou à revoir). */
export interface RapportGameRef {
  url: string;
  opponent: string;
  opponentRating: number | null;
  result: 'win' | 'draw' | 'loss';
  accuracy: number;
  /** Libellé de date FR (« 7 oct. 2013 »), prêt à afficher. */
  dateLabel: string;
}

export interface RapportQualitySegment {
  key: string;
  label: string;
  count: number;
  pct: number;
  color: string;
  /** Glyphe façon chess.com/annotations (…, « ?? ») — vide si aucun. */
  glyph: string;
}

export interface RapportTacticRow {
  key: string;
  label: string;
  found: number;
  missed: number;
  /** Taux de réussite 0–100 (null si aucun cas). */
  rate: number | null;
  /** Ligne « inversée » : le chiffre à réduire est `missed` (pièces en prise). */
  invert?: boolean;
}

export type RapportIconKind =
  | 'precision'
  | 'hangs'
  | 'mates'
  | 'freebies'
  | 'forks'
  | 'defense'
  | 'winrate'
  | 'theory'
  | 'blunders'
  | 'mate'
  | 'tactic'
  | 'score'
  | 'info';

export interface RapportAxe {
  icon: RapportIconKind;
  title: string;
  detail: string;
  metric?: string;
  priority: RapportPriority;
  /** Suffixe d'évolution (« s'améliore », « s'aggrave ») quand comparé. */
  evolutionNote?: string;
}

export interface RapportStrength {
  icon: RapportIconKind;
  title: string;
  detail: string;
}

export interface RapportLevel {
  label: string;
  desc: string;
  tone: 'success' | 'warn' | 'danger' | 'neutral';
}

export interface RapportData {
  winPct: number;
  lossPct: number;
  whiteWinPct: number;
  blackWinPct: number;
  betterColor: string;
  worseColor: string;
  hasAcc: boolean;
  goodMoves: number;
  badMoves: number;
  qualitySegments: RapportQualitySegment[];
  tacticRows: RapportTacticRow[];
  level: RapportLevel;
  axes: RapportAxe[];
  strengths: RapportStrength[];
  gaugeColor: string;
  accColor: string;
  acplColor: string;
  evolution: RapportEvolution | null;
  /** Niveau de jeu estimé façon Game Review (affichage seul, null si inconnu). */
  estimatedLevel: number | null;
}

export const RAPPORT_PRIORITY_LABEL: Record<RapportPriority, string> = {
  high: 'Priorité haute',
  medium: 'Priorité moyenne',
  low: 'Info',
};

export const RAPPORT_PRIORITY_COLOR: Record<RapportPriority, string> = {
  high: '#d8816f',
  medium: '#d29e6a',
  low: '#8fb996',
};

/* ------------------------------------------------------------------
 * Évolution : période récente vs précédente (N dernières contre N
 * précédentes, triées par date). Pur et testable : le panneau
 * (ChesscomPanel) construit les deux tranches, ce module compare.
 * ------------------------------------------------------------------ */

/** Tranche agrégée d'une période (nombres déjà calculés par l'appelant). */
export interface RapportPeriodSlice {
  games: number;
  wins: number;
  draws: number;
  losses: number;
  /** Score 0–100 (V + N/2). */
  score: number;
  analyzedCount: number;
  overallAcc: number | null;
  acpl: number | null;
  acplCount: number;
  /** Taux de bévues en % des coups (null si aucun coup analysé). */
  blunderRate: number | null;
  /** Pièces en prise par partie analysée (null si aucune analyse). */
  hangsPerGame: number | null;
  theoryAvg: number | null;
  theoryCount: number;
  matesFound: number;
  matesMissed: number;
  forksFound: number;
  forksMissed: number;
  freebiesMissed: number;
  /** Mini-séries chronologiques (paquets de 5 parties) pour les sparklines. */
  sparkScore: number[];
  sparkAcc: number[];
}

export type RapportDeltaTrend = 'up' | 'down' | 'stable';

/** Un indicateur comparé : valeur récente, précédente, écart et lecture. */
export interface RapportDelta {
  key: string;
  label: string;
  recent: number | null;
  previous: number | null;
  /** Écart récent − précédent (null si incomparable). */
  diff: number | null;
  trend: RapportDeltaTrend;
  /**
   * Lecture : true = progression, false = régression, null = stable ou
   * incomparable. Tient compte du sens (baisse ACPL = progression).
   */
  favorable: boolean | null;
  /** Texte FR formaté (« +2,3 pts », « −12 cp », « — »). */
  text: string;
  /** Unité affichée après la valeur (pts, cp, coups…). */
  unit: string;
}

export type RapportGlobalTrend = 'progression' | 'régression' | 'stable' | 'insuffisant';

export interface RapportEvolution {
  /** Taille de fenêtre (N récentes contre N précédentes). */
  window: number;
  recentGames: number;
  previousGames: number;
  /** Faux si la période précédente a < 10 parties (comparaison fragile). */
  sufficient: boolean;
  deltas: RapportDelta[];
  global: RapportGlobalTrend;
  /** Phrases d'analyse FR (1 à 3), prêtes à afficher. */
  narrative: string[];
  /** Mini-séries de la période récente (paquets de 5, ordre chrono). */
  recentSparkScore: number[];
  recentSparkAcc: number[];
}

/** Fenêtre de comparaison : 20 récentes contre 20 précédentes. */
export const RAPPORT_EVOLUTION_WINDOW = 20;
/**
 * Seuil de parties sous lequel une période est trop courte pour un verdict
 * fiable. S'applique aux DEUX côtés : une période récente de 8 parties
 * contre 30 précédentes reste indicative (variance énorme du score).
 */
export const RAPPORT_EVOLUTION_MIN_GAMES = 10;

/* ------------------------------------------------------------------
 * Rapports périodiques : l'historique (trié chronologiquement) est
 * découpé en blocs fixes de N parties. Chaque bloc donne un rapport
 * complet, comparé automatiquement au bloc précédent
 * (progression / régression via `buildEvolution`).
 * ------------------------------------------------------------------ */

/** Taille d'un bloc de rapport périodique : un rapport toutes les 30 parties. */
export const RAPPORT_BLOCK_SIZE = 30;

export interface RapportBlockMeta {
  /** Index du bloc (0 = 1ères parties). */
  index: number;
  /** Numéro de la 1ère partie du bloc (1-based, ordre chrono). */
  start: number;
  /** Numéro de la dernière partie du bloc (1-based). */
  end: number;
  /** Parties réellement dans le bloc (== taille sauf dernier bloc). */
  games: number;
  /** Vrai si le bloc atteint la taille nominale. */
  complete: boolean;
}

/**
 * Découpe une liste (déjà triée chrono par l'appelant) en blocs fixes.
 * Pur : le dernier bloc peut être incomplet (`complete: false`).
 */
export function splitIntoBlocks<T>(sorted: T[], size: number = RAPPORT_BLOCK_SIZE): T[][] {
  if (!Number.isInteger(size) || size <= 0) return sorted.length > 0 ? [ [...sorted] ] : [];
  const out: T[][] = [];
  for (let i = 0; i < sorted.length; i += size) {
    out.push(sorted.slice(i, i + size));
  }
  return out;
}

/** Métadonnées d'affichage des blocs (numéros 1-based, ordre chrono). */
export function describeRapportBlocks(
  totalGames: number,
  size: number = RAPPORT_BLOCK_SIZE,
): RapportBlockMeta[] {
  if (!Number.isInteger(totalGames) || totalGames <= 0) return [];
  if (!Number.isInteger(size) || size <= 0) {
    return [{ index: 0, start: 1, end: totalGames, games: totalGames, complete: true }];
  }
  const out: RapportBlockMeta[] = [];
  const count = Math.ceil(totalGames / size);
  for (let i = 0; i < count; i++) {
    const start = i * size + 1;
    const end = Math.min((i + 1) * size, totalGames);
    out.push({ index: i, start, end, games: end - start + 1, complete: end - start + 1 >= size });
  }
  return out;
}

/** Libellé FR d'un bloc (« Bloc 2 · parties 31–60 »). */
export function rapportBlockLabel(meta: Pick<RapportBlockMeta, 'index' | 'start' | 'end'>): string {
  return `Bloc ${meta.index + 1} · parties ${meta.start}–${meta.end}`;
}

/** Seuils de significativité par indicateur (en deçà → stable). */
const EVOLUTION_THRESHOLDS: Record<string, number> = {
  score: 2,
  precision: 1.5,
  acpl: 8,
  bevues: 0.8,
  'pieces-prise': 0.2,
  theorie: 1,
  mats: 10,
  fourchettes: 10,
};

function formatFrDiff(diff: number, decimals: number, unit: string): string {
  const sign = diff > 0 ? '+' : diff < 0 ? '−' : '';
  const abs = Math.abs(diff).toFixed(decimals).replace('.', ',');
  return `${sign}${abs} ${unit}`;
}

function makeDelta(args: {
  key: string;
  label: string;
  unit: string;
  decimals?: number;
  recent: number | null;
  previous: number | null;
  /** Vrai si une baisse est une bonne nouvelle (ACPL, bévues, prises). */
  lowerIsBetter?: boolean;
}): RapportDelta {
  const { key, label, unit, recent, previous, lowerIsBetter = false } = args;
  const decimals = args.decimals ?? 1;
  const threshold = EVOLUTION_THRESHOLDS[key] ?? 0;
  if (recent === null || previous === null || !Number.isFinite(recent) || !Number.isFinite(previous)) {
    return { key, label, recent, previous, diff: null, trend: 'stable', favorable: null, text: '—', unit };
  }
  const diff = recent - previous;
  const trend: RapportDeltaTrend = Math.abs(diff) < threshold ? 'stable' : diff > 0 ? 'up' : 'down';
  const favorable = trend === 'stable' ? null : lowerIsBetter ? diff < 0 : diff > 0;
  return { key, label, recent, previous, diff, trend, favorable, text: formatFrDiff(diff, decimals, unit), unit };
}

function rateOfEvol(found: number, missed: number): number | null {
  const total = found + missed;
  return total > 0 ? (found / total) * 100 : null;
}

/**
 * Compare deux tranches (récente vs précédente). Pur : seuils fixés
 * ci-dessus, baisse ACPL/bévues/prises = progression. Un verdict ferme
 * exige 10 parties minimum des DEUX côtés ; sinon `sufficient` est faux.
 * Les deltas restent affichés dès que la période précédente suffit (lecture
 * indicateur par indicateur), mais la tendance globale reste « insuffisant ».
 */
export function buildEvolution(
  recent: RapportPeriodSlice,
  previous: RapportPeriodSlice,
  window: number = RAPPORT_EVOLUTION_WINDOW,
): RapportEvolution {
  const prevOk = previous.games >= RAPPORT_EVOLUTION_MIN_GAMES;
  const recentOk = recent.games >= RAPPORT_EVOLUTION_MIN_GAMES;
  const sufficient = prevOk && recentOk;
  const prev: RapportPeriodSlice | null = prevOk ? previous : null;
  const deltas: RapportDelta[] = [
    makeDelta({ key: 'score', label: 'Score', unit: 'pts', recent: recent.score, previous: prev ? prev.score : null }),
    makeDelta({ key: 'precision', label: 'Précision', unit: 'pts', recent: recent.overallAcc, previous: prev ? prev.overallAcc : null }),
    makeDelta({ key: 'acpl', label: 'ACPL', unit: 'cp', decimals: 0, recent: recent.acpl, previous: prev ? prev.acpl : null, lowerIsBetter: true }),
    makeDelta({ key: 'bevues', label: 'Bévues', unit: 'pts', recent: recent.blunderRate, previous: prev ? prev.blunderRate : null, lowerIsBetter: true }),
    makeDelta({ key: 'pieces-prise', label: 'Pièces en prise', unit: '/partie', recent: recent.hangsPerGame, previous: prev ? prev.hangsPerGame : null, lowerIsBetter: true }),
    makeDelta({ key: 'theorie', label: 'Théorie', unit: 'coups', recent: recent.theoryAvg, previous: prev ? prev.theoryAvg : null }),
    makeDelta({
      key: 'mats', label: 'Mats convertis', unit: 'pts',
      recent: rateOfEvol(recent.matesFound, recent.matesMissed),
      previous: prev ? rateOfEvol(prev.matesFound, prev.matesMissed) : null,
    }),
    makeDelta({
      key: 'fourchettes', label: 'Fourchettes', unit: 'pts',
      recent: rateOfEvol(recent.forksFound, recent.forksMissed),
      previous: prev ? rateOfEvol(prev.forksFound, prev.forksMissed) : null,
    }),
  ];

  let global: RapportGlobalTrend = 'insuffisant';
  if (sufficient) {
    const fav = deltas.filter((d) => d.favorable === true).length;
    const unfav = deltas.filter((d) => d.favorable === false).length;
    if (fav > unfav && fav >= 2) global = 'progression';
    else if (unfav > fav && unfav >= 2) global = 'régression';
    else global = 'stable';
  }

  const narrative: string[] = [];
  if (!sufficient) {
    if (!prevOk) {
      const missing = Math.max(0, RAPPORT_EVOLUTION_MIN_GAMES - previous.games);
      narrative.push(
        `Historique encore court : ${previous.games} partie${previous.games > 1 ? 's' : ''} en période précédente. ` +
        (missing > 0
          ? `Analysez encore ${missing} partie${missing > 1 ? 's' : ''} pour activer la comparaison (${window} récentes contre ${window} précédentes).`
          : `La comparaison s'activera avec davantage de parties analysées.`),
      );
    } else {
      narrative.push(
        `Période récente trop courte (${recent.games} parties) : le verdict reste indicatif ` +
        `face aux ${previous.games} parties précédentes. Il se stabilisera à partir de ` +
        `${RAPPORT_EVOLUTION_MIN_GAMES} parties récentes — lisez les écarts un par un.`,
      );
    }
  } else {
    const scored = deltas
      .filter((d) => d.favorable !== null)
      .map((d) => ({ d, strength: Math.abs(d.diff ?? 0) / (EVOLUTION_THRESHOLDS[d.key] || 1) }))
      .sort((a, b) => b.strength - a.strength);
    const good = scored.filter((s) => s.d.favorable === true);
    const bad = scored.filter((s) => s.d.favorable === false);
    if (global === 'progression' && good.length > 0) {
      const top = good.slice(0, 2).map((s) => `${s.d.label} (${s.d.text})`).join(' et ');
      narrative.push(`En progression sur les ${window} dernières parties : ${top}. Continuez sur cette lancée.`);
      if (bad.length > 0) {
        narrative.push(`Point à surveiller malgré tout : ${bad[0].d.label} (${bad[0].d.text}). Consultez l'axe correspondant du plan de progression.`);
      }
    } else if (global === 'régression' && bad.length > 0) {
      const top = bad.slice(0, 2).map((s) => `${s.d.label} (${s.d.text})`).join(' et ');
      narrative.push(`Régression sur les ${window} dernières parties, portée par : ${top}.`);
      narrative.push(`Reprenez les axes liés du plan de progression et analysez vos dernières défaites pour casser la dynamique.`);
    } else {
      narrative.push(
        `Période stable : vos indicateurs évoluent dans la marge sur les ${window} dernières parties. La régularité d'analyse fera apparaître les tendances.`,
      );
    }
  }

  return {
    window,
    recentGames: recent.games,
    previousGames: previous.games,
    sufficient,
    deltas,
    global,
    narrative,
    recentSparkScore: recent.sparkScore,
    recentSparkAcc: recent.sparkAcc,
  };
}

function pct1(n: number, base: number): string {
  if (base <= 0) return '0';
  const p = (n / base) * 100;
  return n > 0 && p < 0.5 ? '<1' : p.toFixed(0);
}

/**
 * Niveau de jeu estimé façon Game Review chess.com (« vous avez joué
 * comme un … »). Échelle indicative, AFFICHAGE SEUL : ne sert jamais à
 * sélectionner ou trier quoi que ce soit.
 */
export function estimatedLevelFor(accuracy: number | null): number | null {
  if (accuracy === null || !Number.isFinite(accuracy)) return null;
  if (accuracy >= 95) return 2200;
  if (accuracy >= 92) return 2100;
  if (accuracy >= 89) return 2000;
  if (accuracy >= 86) return 1900;
  if (accuracy >= 83) return 1800;
  if (accuracy >= 80) return 1700;
  if (accuracy >= 77) return 1600;
  if (accuracy >= 74) return 1500;
  if (accuracy >= 71) return 1400;
  if (accuracy >= 68) return 1300;
  if (accuracy >= 64) return 1200;
  if (accuracy >= 60) return 1100;
  return 1000;
}

/**
 * Construit le modèle du rapport de progression. Pur et testable :
 * mêmes seuils que l'ancien bloc inline (précision < 75, pièces en prise
 * ≥ 0,5/partie, cadeaux ≥ 0,3/partie, défaites > 55 %, bévues > 4 %…),
 * sans JSX ni emoji (les icônes sont résolues par le panneau).
 */
export function buildRapport(input: RapportInput): RapportData {
  const {
    totalGames, wins, losses, score,
    whiteGames, whiteWins, blackGames, blackWins,
    overallAcc, analyzedCount,
    brilliant, best, excellent, good, inaccuracy, mistake, blunder, totalMoves,
    matesFound, matesMissed, forksFound, forksMissed,
    hangs, freebiesFound, freebiesMissed,
    theoryAvg, theoryCount, theoryAvailable,
  } = input;
  const evolution = input.evolution ?? null;

  const winPct = totalGames > 0 ? (wins / totalGames) * 100 : 0;
  const lossPct = totalGames > 0 ? (losses / totalGames) * 100 : 0;
  const whiteWinPct = whiteGames > 0 ? (whiteWins / whiteGames) * 100 : 0;
  const blackWinPct = blackGames > 0 ? (blackWins / blackGames) * 100 : 0;
  const betterColor = whiteWinPct >= blackWinPct ? 'les Blancs' : 'les Noirs';
  const worseColor = whiteWinPct >= blackWinPct ? 'les Noirs' : 'les Blancs';
  const hasAcc = analyzedCount > 0 && overallAcc !== null && overallAcc > 0;

  const goodMoves = brilliant + best + excellent + good;
  const badMoves = inaccuracy + mistake + blunder;
  const qualitySegments: RapportQualitySegment[] = [
    { key: 'brillant', label: 'Brillant', count: brilliant, pct: totalMoves > 0 ? (brilliant / totalMoves) * 100 : 0, color: '#8fb996', glyph: '!!' },
    { key: 'meilleur', label: 'Meilleur', count: best, pct: totalMoves > 0 ? (best / totalMoves) * 100 : 0, color: '#9ab89b', glyph: '!' },
    { key: 'excellent', label: 'Excellent', count: excellent, pct: totalMoves > 0 ? (excellent / totalMoves) * 100 : 0, color: '#c5d4b5', glyph: '' },
    { key: 'bon', label: 'Bon', count: good, pct: totalMoves > 0 ? (good / totalMoves) * 100 : 0, color: '#d8d2c6', glyph: '' },
    { key: 'imprecision', label: 'Imprécision', count: inaccuracy, pct: totalMoves > 0 ? (inaccuracy / totalMoves) * 100 : 0, color: '#ead9b5', glyph: '?!' },
    { key: 'erreur', label: 'Erreur', count: mistake, pct: totalMoves > 0 ? (mistake / totalMoves) * 100 : 0, color: '#c8956a', glyph: '?' },
    { key: 'gaffe', label: 'Bévue', count: blunder, pct: totalMoves > 0 ? (blunder / totalMoves) * 100 : 0, color: '#d8816f', glyph: '??' },
  ];

  const rateOf = (found: number, missed: number): number | null => {
    const total = found + missed;
    return total > 0 ? (found / total) * 100 : null;
  };
  const tacticRows: RapportTacticRow[] = [
    { key: 'mates', label: 'Mats convertis', found: matesFound, missed: matesMissed, rate: rateOf(matesFound, matesMissed) },
    { key: 'forks', label: 'Fourchettes jouées', found: forksFound, missed: forksMissed, rate: rateOf(forksFound, forksMissed) },
    { key: 'hangs', label: 'Pièces en prise', found: 0, missed: hangs, rate: hangs > 0 ? 0 : null, invert: true },
    { key: 'freebies', label: 'Cadeaux captés', found: freebiesFound, missed: freebiesMissed, rate: rateOf(freebiesFound, freebiesMissed) },
  ];

  const axes: RapportAxe[] = [];
  if (hasAcc && overallAcc !== null && overallAcc < 75) {
    axes.push({
      icon: 'precision', title: 'Précision globale',
      detail: `Précision moyenne de ${overallAcc.toFixed(1)} %, sous le seuil de 80 % visé à votre niveau. Analysez chaque partie au moteur pour repérer vos schémas d'erreur récurrents.`,
      metric: `${overallAcc.toFixed(1)} %`, priority: 'high',
    });
  }
  if (hangs > 0 && analyzedCount > 0) {
    const perGame = hangs / analyzedCount;
    if (perGame >= 0.5) {
      axes.push({
        icon: 'hangs', title: 'Pièces en prise',
        detail: `${hangs} pièces laissées en prise (environ ${perGame.toFixed(1)} par partie). Avant chaque coup, contrôlez les pièces non défendues.`,
        metric: `${hangs} au total`, priority: 'high',
      });
    }
  }
  if (matesMissed > 0) {
    axes.push({
      icon: 'mates', title: 'Mats manqués',
      detail: `${matesMissed} mat${matesMissed > 1 ? 's' : ''} non joué${matesMissed > 1 ? 's' : ''}. Un entraînement quotidien aux mats (15 à 20 minutes) développe la vision des finales.`,
      metric: `${matesMissed} manqué${matesMissed > 1 ? 's' : ''}`, priority: 'high',
    });
  }
  if (freebiesMissed > 0 && analyzedCount > 0) {
    const perGame = freebiesMissed / analyzedCount;
    if (perGame >= 0.3) {
      axes.push({
        icon: 'freebies', title: 'Cadeaux adverses ignorés',
        detail: `${freebiesMissed} prise${freebiesMissed > 1 ? 's gratuites' : ' gratuite'} manquée${freebiesMissed > 1 ? 's' : ''}. Après chaque coup adverse, cherchez la prise immédiate disponible.`,
        metric: `${freebiesMissed} ignorée${freebiesMissed > 1 ? 's' : ''}`, priority: 'medium',
      });
    }
  }
  if (forksMissed > 0) {
    axes.push({
      icon: 'forks', title: 'Fourchettes manquées',
      detail: `${forksMissed} fourchette${forksMissed > 1 ? 's' : ''} non jouée${forksMissed > 1 ? 's' : ''}. Les fourchettes de cavalier sont les plus fréquentes : travaillez les motifs de double attaque.`,
      metric: `${forksMissed} manquée${forksMissed > 1 ? 's' : ''}`, priority: 'medium',
    });
  }
  if (lossPct > 55) {
    axes.push({
      icon: 'defense', title: 'Solidité défensive',
      detail: `${lossPct.toFixed(0)} % de défaites. Travaillez les finales (tours, pions) et les positions défensives difficiles pour améliorer votre résilience.`,
      metric: `${lossPct.toFixed(0)} % de défaites`, priority: 'high',
    });
  } else if (winPct < 40 && totalGames >= 20) {
    axes.push({
      icon: 'winrate', title: 'Taux de victoires',
      detail: `${winPct.toFixed(0)} % de victoires seulement. Analysez vos cinq dernières défaites pour identifier un motif commun (ouverture, milieu de jeu, finale).`,
      metric: `${winPct.toFixed(0)} %`, priority: 'medium',
    });
  }
  if (theoryAvailable && theoryAvg !== null && theoryAvg < 5) {
    axes.push({
      icon: 'theory', title: 'Répertoire d\u2019ouverture',
      detail: `Sortie de théorie au coup ${theoryAvg.toFixed(1)} en moyenne. Visez 8 à 10 coups dans vos ouvertures principales pour aborder le milieu de jeu développé.`,
      metric: `coup ${theoryAvg.toFixed(1)}`, priority: 'medium',
    });
  }
  if (totalMoves > 0 && blunder / totalMoves > 0.04) {
    axes.push({
      icon: 'blunders', title: 'Bévues fréquentes',
      detail: `${blunder} bévue${blunder > 1 ? 's' : ''} sur ${totalMoves} coups (${pct1(blunder, totalMoves)} %). Ralentissez sur les positions complexes et appliquez une liste de vérification avant chaque coup important.`,
      metric: `${pct1(blunder, totalMoves)} %`, priority: 'high',
    });
  }

  const strengths: RapportStrength[] = [];
  if (hasAcc && overallAcc !== null && overallAcc >= 80) {
    strengths.push({ icon: 'precision', title: 'Précision excellente', detail: `${overallAcc.toFixed(1)} % de précision moyenne : votre jeu est très propre.` });
  }
  if (matesFound > 0) {
    strengths.push({ icon: 'mate', title: 'Vision du mat', detail: `${matesFound} mat${matesFound > 1 ? 's' : ''} converti${matesFound > 1 ? 's' : ''} : finition efficace.` });
  }
  if (forksFound > 0) {
    strengths.push({ icon: 'tactic', title: 'Tactique offensive', detail: `${forksFound} fourchette${forksFound > 1 ? 's' : ''} jouée${forksFound > 1 ? 's' : ''} avec succès.` });
  }
  if (theoryAvg !== null && theoryAvg >= 8) {
    strengths.push({ icon: 'theory', title: 'Maîtrise théorique', detail: `${theoryAvg.toFixed(1)} coups théoriques en moyenne : répertoire solide.` });
  }
  if (winPct >= 55) {
    strengths.push({ icon: 'score', title: 'Domination', detail: `${winPct.toFixed(0)} % de victoires : vous surperformez la moyenne.` });
  }
  if (axes.length === 0 && strengths.length === 0) {
    axes.push({
      icon: 'info', title: 'Données insuffisantes',
      detail: 'Lancez « Analyser précision » pour obtenir un rapport détaillé au moteur. Le rapport s\u2019enrichit avec davantage de parties analysées.',
      priority: 'low',
    });
  }

  const level: RapportLevel = !hasAcc
    ? (score >= 60
      ? { label: 'Joueur solide', desc: 'Bon score, sans analyse de précision disponible.', tone: 'warn' }
      : { label: 'En progression', desc: 'Analysez vos parties pour un diagnostic complet.', tone: 'neutral' })
    : (() => {
      const a = overallAcc ?? 0;
      if (a >= 85 && score >= 55) return { label: 'Expert', desc: 'Précision et résultats au sommet : continuez sur cette lancée.', tone: 'success' as const };
      if (a >= 80) return { label: 'Avancé', desc: 'Très bonne précision. Travaillez la régularité.', tone: 'success' as const };
      if (a >= 70) return { label: 'Intermédiaire', desc: 'Solide, avec des faiblesses identifiables à corriger.', tone: 'warn' as const };
      if (a >= 55) return { label: 'En développement', desc: 'Des progrès rapides sont possibles avec un entraînement ciblé.', tone: 'warn' as const };
      return { label: 'Débutant avancé', desc: 'Concentrez-vous sur la tactique et la réduction des bévues.', tone: 'danger' as const };
    })();

  const gaugeColor = score >= 55 ? '#8fb996' : score >= 45 ? '#d29e6a' : '#d8816f';
  const accColor = hasAcc && overallAcc !== null
    ? overallAcc >= 80 ? '#8fb996' : overallAcc >= 65 ? '#d29e6a' : '#d8816f'
    : '#8e887c';
  const acplColor = input.acplOverall === null
    ? '#8e887c'
    : input.acplOverall <= 40 ? '#8fb996' : input.acplOverall <= 80 ? '#d29e6a' : '#d8816f';

  /* Suffixes d'évolution sur les axes (période récente vs précédente). */
  if (evolution && evolution.sufficient) {
    const deltaOf = (key: string) => evolution.deltas.find((d) => d.key === key);
    const noteFor = (key: string): string | undefined => {
      const d = deltaOf(key);
      if (!d || d.favorable === null) return undefined;
      return d.favorable
        ? `S'améliore sur la période récente (${d.text}).`
        : `S'aggrave sur la période récente (${d.text}).`;
    };
    const axeDeltaKey: Record<string, string> = {
      'Précision globale': 'precision',
      'Pièces en prise': 'pieces-prise',
      'Mats manqués': 'mats',
      'Fourchettes manquées': 'fourchettes',
      'Bévues fréquentes': 'bevues',
      'Répertoire d\u2019ouverture': 'theorie',
    };
    for (const axe of axes) {
      const key = axeDeltaKey[axe.title];
      if (!key) continue;
      const note = noteFor(key);
      if (note) axe.evolutionNote = note;
    }
  }

  void theoryCount;
  return {
    winPct, lossPct, whiteWinPct, blackWinPct, betterColor, worseColor,
    hasAcc, goodMoves, badMoves, qualitySegments, tacticRows,
    level, axes, strengths, gaugeColor, accColor, acplColor, evolution,
    estimatedLevel: hasAcc ? estimatedLevelFor(overallAcc) : null,
  };
}

/* ------------------------------------------------------------------
 * Export : sérialise un rapport en Markdown (pur). Pensé pour être
 * relu hors appli — par un humain comme par un agent : toutes les
 * valeurs, les deltas et les phrases d'analyse y figurent.
 * ------------------------------------------------------------------ */

function mdFr1(v: number): string {
  return v.toFixed(1).replace('.', ',');
}

function mdDeltaValue(d: RapportDelta, v: number | null): string {
  if (v === null || !Number.isFinite(v)) return '—';
  switch (d.key) {
    case 'acpl':
      return `${Math.round(v)} cp`;
    case 'pieces-prise':
      return `${mdFr1(v)} /partie`;
    case 'theorie':
      return `${mdFr1(v)} coups`;
    default:
      return `${mdFr1(v)} %`;
  }
}

function mdDeltaReading(d: RapportDelta): string {
  if (d.favorable === true) return 'progression';
  if (d.favorable === false) return 'régression';
  return 'stable';
}

/**
 * Rapport complet en Markdown : identité, score, précision, ACPL,
 * qualité des coups, tactique, théorie, ouvertures, parties marquantes,
 * évolution (deltas + tendance + analyse), points forts et axes.
 * `title` = portée (« Tout l'historique », « Bloc 2 · parties 31–60 »).
 */
export function rapportToMarkdown(
  input: RapportInput,
  title = "Tout l'historique",
  dateStr?: string,
): string {
  const data = buildRapport(input);
  const day = dateStr
    ?? new Date().toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' });
  const L: string[] = [];
  L.push(`# Rapport de progression — ${input.me}`);
  L.push('');
  L.push(`*${title} · ${day} · ${input.totalGames} parties (${input.wins}V · ${input.draws}N · ${input.losses}D)*`);
  L.push('');
  L.push(`Niveau : **${data.level.label}** — ${data.level.desc}`);
  if (data.estimatedLevel !== null) {
    L.push(`Niveau de jeu estimé : ≈ ${data.estimatedLevel} Elo.`);
  }
  L.push('');
  L.push('## Score');
  L.push('');
  L.push(`- Score : **${mdFr1(input.score)} %** (${input.wins}V · ${input.draws}N · ${input.losses}D)`);
  L.push(`- Blancs : ${mdFr1(data.whiteWinPct)} % sur ${input.whiteGames} parties`);
  L.push(`- Noirs : ${mdFr1(data.blackWinPct)} % sur ${input.blackGames} parties`);
  L.push('');
  if (data.hasAcc && input.overallAcc !== null) {
    L.push('## Précision et ACPL (moteur)');
    L.push('');
    L.push(`- Précision moyenne : **${mdFr1(input.overallAcc)} %** sur ${input.analyzedCount} parties analysées`);
    if (input.accWin !== null) L.push(`- Victoires : ${mdFr1(input.accWin)} % (${input.accWinCount})`);
    if (input.accDraw !== null) L.push(`- Nulles : ${mdFr1(input.accDraw)} % (${input.accDrawCount})`);
    if (input.accLoss !== null) L.push(`- Défaites : ${mdFr1(input.accLoss)} % (${input.accLossCount})`);
    if (input.accWhite !== null) L.push(`- Blancs : ${mdFr1(input.accWhite)} % (${input.accWhiteCount})`);
    if (input.accBlack !== null) L.push(`- Noirs : ${mdFr1(input.accBlack)} % (${input.accBlackCount})`);
    if (input.acplOverall !== null) L.push(`- ACPL moyen : ${Math.round(input.acplOverall)} cp (${input.acplCount} parties)`);
    L.push('');
  }
  if (input.totalMoves > 0) {
    L.push('## Qualité des coups');
    L.push('');
    for (const s of data.qualitySegments) {
      if (s.count <= 0) continue;
      L.push(`- ${s.label}${s.glyph ? ` (${s.glyph})` : ''} : ${s.count} (${s.pct.toFixed(0)} %)`);
    }
    L.push(`- Bons coups : ${data.goodMoves} · mauvais coups : ${data.badMoves}`);
    L.push('');
  }
  if (input.analyzedCount > 0) {
    L.push('## Bilan tactique');
    L.push('');
    for (const row of data.tacticRows) {
      if (row.invert) {
        if (row.missed > 0) {
          const perGame = input.analyzedCount > 0 ? mdFr1(row.missed / input.analyzedCount) : null;
          L.push(`- ${row.label} : ${row.missed} concédée${row.missed > 1 ? 's' : ''}${perGame ? ` (${perGame} /partie)` : ''}`);
        } else {
          L.push(`- ${row.label} : 0 (aucune pièce laissée sans défense)`);
        }
      } else {
        const total = row.found + row.missed;
        const note = row.key === 'mates' ? ' — calculé par position à mat forcé' : '';
        L.push(row.rate !== null
          ? `- ${row.label} : ${row.found}/${total} (${row.rate.toFixed(0)} %)${note}`
          : `- ${row.label} : aucun cas détecté`);
      }
    }
    if (input.theoryAvg !== null) {
      L.push(`- Théorie : sortie au coup ${mdFr1(input.theoryAvg)} en moyenne (${input.theoryCount} parties)`);
    }
    L.push('');
  }
  if (input.bestOpening ?? input.worstOpening) {
    L.push('## Ouvertures (3 parties min.)');
    L.push('');
    if (input.bestOpening) {
      L.push(`- Meilleure : ${input.bestOpening.name} (${input.bestOpening.eco}) — ${input.bestOpening.wins}/${input.bestOpening.games} victoires`);
    }
    if (input.worstOpening) {
      L.push(`- À retravailler : ${input.worstOpening.name} (${input.worstOpening.eco}) — ${input.worstOpening.wins}/${input.worstOpening.games} victoires`);
    }
    L.push('');
  }
  if (input.bestGame ?? input.worstGame) {
    L.push('## Parties marquantes');
    L.push('');
    const line = (tag: string, g: RapportGameRef): string =>
      `- ${tag} : contre ${g.opponent}${g.opponentRating !== null ? ` (${g.opponentRating})` : ''} — ${g.result} à ${mdFr1(g.accuracy)} %${g.dateLabel ? ` (${g.dateLabel})` : ''} — ${g.url}`;
    if (input.bestGame) L.push(line('Meilleure', input.bestGame));
    if (input.worstGame) L.push(line('À revoir', input.worstGame));
    L.push('');
  }
  if (data.evolution) {
    const evo = data.evolution;
    L.push('## Évolution (récente vs précédente)');
    L.push('');
    L.push(`Tendance globale : **${evo.global}** (${evo.recentGames} récentes vs ${evo.previousGames} précédentes).`);
    L.push('');
    L.push('| Indicateur | Récent | Précédent | Écart | Lecture |');
    L.push('| --- | --- | --- | --- | --- |');
    for (const d of evo.deltas) {
      L.push(`| ${d.label} | ${mdDeltaValue(d, d.recent)} | ${mdDeltaValue(d, d.previous)} | ${d.text} | ${mdDeltaReading(d)} |`);
    }
    L.push('');
    for (const p of evo.narrative) {
      L.push(`> ${p}`);
      L.push('');
    }
  }
  if (data.strengths.length > 0) {
    L.push('## Points forts');
    L.push('');
    for (const s of data.strengths) {
      L.push(`- ${s.title} : ${s.detail}`);
    }
    L.push('');
  }
  L.push('## Plan de progression');
  L.push('');
  if (data.axes.length === 0) {
    L.push('Aucun axe critique détecté.');
  } else {
    for (const ax of data.axes) {
      L.push(`- [${RAPPORT_PRIORITY_LABEL[ax.priority]}] ${ax.title}${ax.metric ? ` (${ax.metric})` : ''} : ${ax.detail}${ax.evolutionNote ? ` ${ax.evolutionNote}` : ''}`);
    }
  }
  L.push('');
  return L.join('\n');
}
