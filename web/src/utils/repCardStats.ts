import type { BoardOrientation, RepertoireMove, RepertoireRoot } from '../types/chess';
import type { TrainerReviews } from '../storage/trainerReviews';
import { normalizeFen } from './repertoire';

/** Évaluation moteur d'un nœud en centipions (perspective Blancs) ; null si mat/illisible. */
export function parseNodeEvalCp(text: string | undefined): number | null {
  if (!text) return null;
  const t = text.trim();
  if (t.startsWith('#')) return null; // mat : exclu de la moyenne
  const v = Number(t); // « +0.27 » → 0.27 (pions)
  return Number.isFinite(v) ? Math.round(v * 100) : null;
}

export interface RepCardStats {
  /** Lignes terminales (coups sans suite). */
  variantes: number;
  /** Positions déjà vues via un autre chemin (FEN dupliquée ou clone marqué). */
  transpositions: number;
  /** Profondeur moyenne des lignes (plis, peut être fractionnaire). */
  profondeur: number;
  /** Moyenne des évals moteur en pions, du côté du répertoire (null si aucune). */
  evalMoyenne: number | null;
  /** Score moyen pondéré par parties, de notre côté, 0–1 (null si aucune partie). */
  winrate: number | null;
  /** Positions apprises (FSRS) sur positions totales. */
  learned: number;
  totalPositions: number;
  /** Réussite = apprises / totales, 0–1 (null si jamais étudié). */
  reussite: number | null;
  /** Dernier entraînement (ms epoch, null si jamais). */
  derniereEtude: number | null;
}

/**
 * Statistiques d'une carte répertoire, en une passe d'arbre : contenu
 * (variantes, transpositions, profondeur, éval, winrate) + entraînement
 * (réussite, dernière étude via les révisions FSRS du répertoire).
 */
export function computeRepCardStats(
  root: RepertoireRoot,
  color: BoardOrientation,
  repId: string,
  reviews: TrainerReviews,
): RepCardStats {
  let variantes = 0;
  let transpositions = 0;
  let depthSum = 0;
  let totalPositions = 0;
  let evalSumCp = 0;
  let evalCount = 0;
  let scoreSum = 0;
  let gamesSum = 0;

  // Positions déjà vues (FEN normalisé) : une FEN revue via un autre
  // chemin est une transposition, même sans drapeau `cloned` (vieux arbres).
  const seen = new Set<string>();
  try {
    seen.add(normalizeFen(root.fen));
  } catch {
    seen.add(root.fen);
  }

  const visit = (moves: RepertoireMove[] | undefined, depth: number): void => {
    if (!moves || moves.length === 0) return;
    for (const m of moves) {
      totalPositions++;
      let norm = m.fen;
      try {
        norm = normalizeFen(m.fen);
      } catch {
        norm = m.fen;
      }
      if (m.cloned || seen.has(norm)) {
        transpositions++;
      } else {
        seen.add(norm);
      }
      const games = (m.victoires_blancs || 0) + (m.nuls || 0) + (m.victoires_noirs || 0);
      if (games > 0) {
        const ours = color === 'white' ? m.victoires_blancs || 0 : m.victoires_noirs || 0;
        scoreSum += (ours + (m.nuls || 0) / 2) / games;
        gamesSum += games;
      }
      const cp = parseNodeEvalCp(m.eval);
      if (cp !== null) {
        evalSumCp += cp;
        evalCount++;
      }
      if (!m.children || m.children.length === 0) {
        variantes++;
        depthSum += depth;
      } else {
        visit(m.children, depth + 1);
      }
    }
  };
  visit(root.children, 1);

  // Entraînement : révisions FSRS namespacées `${repId}::…`.
  const prefix = `${repId}::`;
  let learned = 0;
  let derniereEtude: number | null = null;
  let studied = false;
  for (const [key, review] of Object.entries(reviews)) {
    if (!key.startsWith(prefix)) continue;
    studied = true;
    if (review.learned) learned++;
    const at = review.card.last_review ? Date.parse(review.card.last_review) : Number.NaN;
    if (Number.isFinite(at) && (derniereEtude === null || at > derniereEtude)) derniereEtude = at;
  }

  const oursSide = color === 'white' ? 1 : -1;
  return {
    variantes,
    transpositions,
    profondeur: variantes > 0 ? depthSum / variantes : 0,
    evalMoyenne: evalCount > 0 ? (evalSumCp / evalCount / 100) * oursSide : null,
    winrate: gamesSum > 0 ? scoreSum / gamesSum : null,
    learned,
    totalPositions,
    reussite: studied && totalPositions > 0 ? learned / totalPositions : null,
    derniereEtude,
  };
}
