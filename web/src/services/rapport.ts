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
}

export interface RapportQualitySegment {
  key: string;
  label: string;
  count: number;
  pct: number;
  color: string;
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

function pct1(n: number, base: number): string {
  if (base <= 0) return '0';
  const p = (n / base) * 100;
  return n > 0 && p < 0.5 ? '<1' : p.toFixed(0);
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
    { key: 'brillant', label: 'Brillant', count: brilliant, pct: totalMoves > 0 ? (brilliant / totalMoves) * 100 : 0, color: '#8fb996' },
    { key: 'meilleur', label: 'Meilleur', count: best, pct: totalMoves > 0 ? (best / totalMoves) * 100 : 0, color: '#9ab89b' },
    { key: 'excellent', label: 'Excellent', count: excellent, pct: totalMoves > 0 ? (excellent / totalMoves) * 100 : 0, color: '#c5d4b5' },
    { key: 'bon', label: 'Bon', count: good, pct: totalMoves > 0 ? (good / totalMoves) * 100 : 0, color: '#d8d2c6' },
    { key: 'imprecision', label: 'Imprécision', count: inaccuracy, pct: totalMoves > 0 ? (inaccuracy / totalMoves) * 100 : 0, color: '#ead9b5' },
    { key: 'erreur', label: 'Erreur', count: mistake, pct: totalMoves > 0 ? (mistake / totalMoves) * 100 : 0, color: '#c8956a' },
    { key: 'gaffe', label: 'Bévue', count: blunder, pct: totalMoves > 0 ? (blunder / totalMoves) * 100 : 0, color: '#d8816f' },
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

  void theoryCount;
  return {
    winPct, lossPct, whiteWinPct, blackWinPct, betterColor, worseColor,
    hasAcc, goodMoves, badMoves, qualitySegments, tacticRows,
    level, axes, strengths, gaugeColor, accColor,
  };
}
