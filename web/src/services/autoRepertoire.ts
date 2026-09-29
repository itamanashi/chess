/**
 * Génération automatique de répertoire par BFS prioritaire.
 * Port TS de `auto_repertoire.py` (lui-même port de `répertoire/server/explorer.py`).
 *
 * File de priorité : les positions les plus populaires sont explorées en
 * premier. Sélection par couverture, profondeur adaptative (moyenne
 * géométrique), pénalités d'étalement / de livre, bonus cache, transpositions.
 */
import { Chess } from 'chess.js';
import type { EngineMove, LichessMove, RepertoireMove, RepertoireRoot } from '../types/chess';
import { INITIAL_FEN, fenAfterUci, normalizeCastleUci, normalizeFen } from '../utils/repertoire';
import { computeLineValues, type LineValueNode } from '../utils/lineValue';
import { fetchLichessMoves, flushLichessPersist, hasLichessCache, explorerCacheReady } from './lichess';
import { abortableSleep, isAbortError } from '../utils/async';
import { PriorityQueue } from '../utils/priorityQueue';
import { engineEvalCacheKey, idbGetEngineEval, idbPutEngineEval } from '../storage/engineEvalCacheDb';

export interface AutoGenConfig {
  maxDepth?: number;
  maxBranching?: number;
  minFreq?: number;
  coveragePercent?: number;
  minPopularity?: number;
  adaptiveDepth?: boolean;
  adaptiveMinDepth?: number;
  adaptivePow?: number;
  cacheHitBonus?: number;
  siblingSpread?: number;
  contestsMin?: number;
  bookTopMin?: number;
  bookGapMin?: number;
  bookPenalty?: number;
  /** Camp du répertoire : 'white' = 1 coup à nous, N à l'adversaire. */
  repertoireColor?: 'white' | 'black' | 'both';
  maxPositions?: number;
  endpoint?: 'masters' | 'lichess';
  ratingsParam?: string;
  since?: number;
  /** Pause entre requêtes réseau (ms). */
  gapMs?: number;
  /** Tentatives supplémentaires par position après un échec transient (défaut 1). */
  extraFetchRetries?: number;
  /** Élagage final winrate (opt-in) : branches à nous sous ce Line Value (0 = désactivé, défaut 0). */
  pruneMinLineValue?: number;
  /**
   * Juge moteur OPT-IN (choix utilisateur explicite) : à nos positions, la
   * réplique est choisie par Stockfish local (MultiPV) au lieu du gradient
   * Elo (UNE SEULE réplique, comme le gradient). Absent = mode gradient
   * rapide (défaut). Le juge est injecté (tests sans worker) ; le panneau
   * branche le Stockfish local.
   */
  engineJudge?: EngineJudgeSettings;
  /** Optimisme λ de l'élagage (0 = réaliste pur). */
  pruneOptimism?: number;
  /** Valeur hors-répertoire de l'élagage. */
  pruneResidual?: number;
  /** Prolongement tactique max sur captures/échecs au-delà de la profondeur limite (défaut 2). */
  maxQuiescence?: number;
}

export interface AutoGenStats {
  sent: number;
  cached: number;
  api: number;
  /** Lectures du pool de référence (Maîtres) pour le gradient Elo. */
  refCached: number;
  refApi: number;
  /** Positions à nous tranchées par un vrai calcul Stockfish (hors cache). */
  engineNodes: number;
  /** Positions retombées sur le gradient (moteur aveugle/évincé). */
  engineFallbacks: number;
  /** Jugements servis depuis le cache (mémoire du run ou IndexedDB), sans calcul. */
  engineCached: number;
  pruned: number;
  transpositions: number;
  explored: number;
  depthPruned: number;
  popPruned: number;
  bookPenalized: number;
  cacheBoostedChildren: number;
  maxDepthReached: number;
  maxEmittedDepth: number;
  branchesTotal: number;
  emptyPositions: number;
  positionsInterrogees: number;
  /** Positions abandonnées après épuisement des réessais. */
  failed: number;
  /** FEN normalisés en échec (plafonné à 20, pour affichage). */
  failedFens: string[];
  /** Coups retirés par l'élagage Line Value final. */
  prunedValue: number;
  /** Coups mats émis (priorité absolue, jamais filtrés). */
  mates: number;
  /** Positions stabilisées par prolongement tactique (quiescence sur échec/capture). */
  quiescenceExtended: number;
}

export interface EngineEvalLine {
  uci: string;
  san: string;
  /** Valeur moteur, perspective du trait (+Infini = mat pour nous). */
  value: number;
}

export interface AutoGenEvents {
  onNode?: (node: RepertoireMove, parentId: string, nodeId: string) => void;
  onProgress?: (stats: AutoGenStats) => void;
  /** Classement du juge moteur à nos positions (meilleur d'abord) : flèches live. */
  onEngineEval?: (fen: string, ranked: EngineEvalLine[]) => void;
  /** Lignes live pendant la recherche (~2/s) : le meilleur danse avant de se fixer. */
  onEnginePartial?: (fen: string, ranked: EngineEvalLine[]) => void;
  signal?: AbortSignal;
}

export interface AutoGenNode extends RepertoireMove {
  fenKey: string;
  freq: number;
  popularity: number;
  contestedness: number;
  bookScore: number;
  rank: number;
  depth: number;
  transposition: boolean;
  // isMate hérité de RepertoireMove (fin forcée, priorité absolue).
}

const DEFAULTS: Required<Omit<AutoGenConfig, 'ratingsParam' | 'since' | 'engineJudge'>> = {
  maxDepth: 12,
  maxBranching: 4,
  minFreq: 0.3,
  coveragePercent: 100,
  minPopularity: 0.00002,
  adaptiveDepth: true,
  adaptiveMinDepth: 6,
  adaptivePow: 1.0,
  cacheHitBonus: 20,
  siblingSpread: 1.0,
  contestsMin: 0.1,
  bookTopMin: 0.85,
  bookGapMin: 0.6,
  bookPenalty: 0.5,
  repertoireColor: 'both',
  maxPositions: 200,
  endpoint: 'masters',
  gapMs: 600,
  extraFetchRetries: 1,
  pruneMinLineValue: 0,
  pruneOptimism: 0.3,
  pruneResidual: 0.5,
  maxQuiescence: 2,
};

export function gamesOf(m: LichessMove): number {
  return (m.white || 0) + (m.draws || 0) + (m.black || 0);
}

/** Sélection par couverture : tri parties ↓, filtre minFreq, coupe coverage/branching. */
export function selectMovesByCoverage(
  moves: LichessMove[],
  total: number,
  cfg: Pick<AutoGenConfig, 'maxBranching' | 'minFreq' | 'coveragePercent'>,
): { move: LichessMove; freq: number }[] {
  const maxBranching = cfg.maxBranching ?? DEFAULTS.maxBranching;
  const minFreq = cfg.minFreq ?? DEFAULTS.minFreq;
  const coverage = cfg.coveragePercent ?? DEFAULTS.coveragePercent;
  if (total <= 0 || moves.length === 0) return [];
  const ordered = [...moves].sort((a, b) => gamesOf(b) - gamesOf(a));
  const selected: { move: LichessMove; freq: number }[] = [];
  let cumulative = 0;
  const coverageActive = coverage < 100;
  for (const m of ordered) {
    const freq = (gamesOf(m) / total) * 100;
    if (freq < minFreq) continue;
    selected.push({ move: m, freq });
    cumulative += freq;
    if (coverageActive && cumulative >= coverage) break;
    if (selected.length >= maxBranching) break;
  }
  if (selected.length === 0) {
    const top = ordered[0];
    selected.push({ move: top, freq: (gamesOf(top) / total) * 100 });
  }
  return selected;
}

/**
 * Couverture pondérée par profondeur : large à la base (les ouvertures
 * ratissent large), resserrée vers les lignes profondes (on ne suit que
 * le cœur). Décroissance linéaire de `base` (profondeur 0) vers `base/2`
 * (plancher 10) à `maxDepth`. `100` = pas de pondération (tout garder,
 * sous le plafond de sécurité).
 */
export function depthWeightedCoverage(base: number, depth: number, maxDepth: number): number {
  const b = Number.isFinite(base) ? Math.max(10, Math.min(100, Math.round(base))) : 100;
  if (b >= 100 || !Number.isFinite(maxDepth) || maxDepth <= 0 || depth <= 0) return b;
  const floor = Math.max(10, Math.round(b / 2));
  const t = Math.min(1, depth / Math.max(1, Math.round(maxDepth)));
  return Math.round(b + (floor - b) * t);
}

export function computeContestedness(moves: LichessMove[], total: number): number {
  if (moves.length === 0 || total <= 0) return 0;
  const best = Math.max(...moves.map((m) => gamesOf(m) / total));
  return Math.max(0, 1 - best);
}

export function computeBookScore(moves: LichessMove[], total: number): number {
  if (moves.length < 2 || total <= 0) return 0;
  const freqs = moves.map((m) => gamesOf(m) / total).sort((a, b) => b - a);
  return Math.max(0, freqs[0] - freqs[1]);
}

export function effectiveMaxDepth(
  base: number,
  depth: number,
  popularity: number,
  cfg: Pick<AutoGenConfig, 'adaptiveDepth' | 'adaptiveMinDepth' | 'adaptivePow'>,
): number {
  const adaptive = cfg.adaptiveDepth ?? DEFAULTS.adaptiveDepth;
  const minD = cfg.adaptiveMinDepth ?? DEFAULTS.adaptiveMinDepth;
  const pow = cfg.adaptivePow ?? DEFAULTS.adaptivePow;
  if (!adaptive || depth <= 0) return base;
  const floor = Math.min(minD, base);
  const geoMean = Math.max(0, popularity) ** (1 / depth);
  const factor = geoMean ** pow;
  const eff = floor + (base - floor) * factor;
  return Math.max(floor, Math.min(base, Math.round(eff)));
}

export function spreadPenalty(
  rank: number,
  contestedness: number,
  cfg: Pick<AutoGenConfig, 'siblingSpread' | 'contestsMin'>,
): number {
  const spread = cfg.siblingSpread ?? DEFAULTS.siblingSpread;
  const min = cfg.contestsMin ?? DEFAULTS.contestsMin;
  if (rank === 0 || contestedness < min) return 1;
  return 1 / (1 + contestedness * spread * rank);
}

/**
 * Mats en 1 depuis `fen` (UCI standard), par génération légale chess.js —
 * aucune évaluation, aucun moteur : un mat est une fin de partie forcée,
 * pas un avis. Ensemble vide si FEN illisible ou aucun mat.
 */
export function findMateInOneUcis(fen: string): Set<string> {
  const mates = new Set<string>();
  try {
    const c = new Chess(fen);
    for (const m of c.moves({ verbose: true })) {
      if (m.san.endsWith('#')) mates.add(`${m.from}${m.to}${m.promotion ?? ''}`);
    }
  } catch {
    /* FEN illisible : aucun mat détecté */
  }
  return mates;
}

/** Bonus de priorité d'un mat : terminal (aucun sous-arbre), il passe devant tout. */
export const MATE_PRIORITY_BONUS = 1e6;

/**
 * Juge moteur injectable : une recherche MultiPV rend les coups classés
 * (meilleur d'abord). Le défaut branché par le panneau est le Stockfish
 * local (worker, annulable) ; les tests injectent un faux synchrone.
 */
export interface EngineJudgeFn {
  (
    fen: string,
    opts: {
      multiPv: number;
      depth: number;
      timeoutMs: number;
      signal?: AbortSignal;
      /** Lignes live pendant la recherche (direct de la réflexion). */
      onPartial?: (lines: EngineMove[]) => void;
    },
  ): Promise<EngineMove[]>;
}

export interface EngineJudgeSettings {
  judge: EngineJudgeFn;
  /** Profondeur du premier tri (défaut 14 : SF19 tranche vite et fort). */
  depth?: number;
  /** Lignes demandées (défaut 6, étendu au nombre de candidats, plafonné). */
  multiPv?: number;
  /** Fenêtre d'équivalence en cp : tout ce qui est à ±X du meilleur est gardé (défaut 30, multi-répliques). */
  equivalenceCp?: number;
  /** Profondeur du départage des ex æquo (défaut 20). */
  tiebreakDepth?: number;
  /** Fenêtre resserrée du départage (défaut 10). */
  tiebreakWindowCp?: number;
  /** Budget par nœud en ms (partiels rendus au-delà, défaut 6000). */
  timeoutMs?: number;
  /** Budget du départage en ms (défaut 10000). */
  tiebreakTimeoutMs?: number;
  /** Seuil de domination (ex 0.85) : si le 1er coup a >= 85% de fréquence et un fort écart, skip le moteur. */
  skipDominantThreshold?: number;
  /** Cache d'évaluations (défaut : cache isolé pour le run). */
  cache?: Map<string, EngineMove[]>;
}

const ENGINE_DEFAULTS = {
  depth: 14,
  multiPv: 6,
  equivalenceCp: 30,
  tiebreakDepth: 20,
  tiebreakWindowCp: 10,
  /** Creusage seulement si le top-2 est dans cette fenêtre (classement déjà clair au-delà). */
  tiebreakTriggerCp: 15,
  timeoutMs: 6000,
  tiebreakTimeoutMs: 10000,
  /**
   * Plafond du MultiPV dynamique : le juge couvre tous les candidats
   * (sinon `lines < candidates` = repli gradient systématique sur les
   * positions larges), sans dépasser ce plafond (coût moteur).
   */
  multiPvCap: 12,
} as const;

/** Cache global optionnel pour partager entre sessions si souhaité. */
export const globalEngineEvalCache = new Map<string, EngineMove[]>();

export function clearEngineEvalCache(): void {
  globalEngineEvalCache.clear();
}

/** Nettoie le cache persistant IndexedDB des évaluations moteur. */
export async function clearPersistentEngineEvalCache(): Promise<void> {
  const { idbClearEngineEval } = await import('../storage/engineEvalCacheDb');
  await idbClearEngineEval();
}

/** Valeur moteur d'une ligne (perspective du trait : comparable entre répliques du même nœud). */
function engineValue(em: EngineMove): number {
  if (em.mate !== undefined) return em.mate > 0 ? Number.POSITIVE_INFINITY : Number.NEGATIVE_INFINITY;
  return em.cp ?? Number.NEGATIVE_INFINITY;
}

/**
 * Classe des coups candidats par les lignes moteur (retourne null si le
 * moteur est aveugle ici : aucune ligne, ou résultats partiels couvrant
 * moins de coups que de candidats — on ne tronque jamais à l'aveugle).
 * Les lignes sont mappées par UCI normalisé (repli SAN). Le meilleur est
 * toujours gardé ; un mat pour nous vaut +infini (gardé), un mat contre
 * nous −infini (écarté sauf si tout est perdu).
 */
export function pickEngineReplies<T extends { uci: string; san: string }>(
  candidates: T[],
  lines: EngineMove[],
  fen: string,
  opts: { equivalenceCp: number },
): { candidate: T; value: number }[] | null {
  if (candidates.length === 0 || lines.length === 0) return null;
  const byKey = new Map<string, EngineMove>();
  for (const em of lines) {
    if (em.uci) byKey.set(`u:${normalizeCastleUci(fen, em.uci)}`, em);
    if (em.san) byKey.set(`s:${em.san}`, em);
  }
  const keyOf = (c: T): string | null => {
    if (c.uci && byKey.has(`u:${normalizeCastleUci(fen, c.uci)}`)) {
      return `u:${normalizeCastleUci(fen, c.uci)}`;
    }
    if (c.san && byKey.has(`s:${c.san}`)) return `s:${c.san}`;
    return null;
  };
  const mapped = candidates
    .map((candidate) => {
      const key = keyOf(candidate);
      return key ? { candidate, value: engineValue(byKey.get(key) as EngineMove) } : null;
    })
    .filter((x): x is { candidate: T; value: number } => x !== null);
  // Résultats partiels (moins de lignes que de candidats) : repli, pas de
  // troncature à l'aveugle. Idem si rien n'est mappé.
  if (mapped.length === 0 || lines.length < candidates.length) return null;
  let best = -Infinity;
  for (const m of mapped) if (m.value > best) best = m.value;
  // Infinis : pas de soustraction (INF − INF = NaN mangerait tout). Mat(s)
  // pour nous seul(s) gardé(s) ; si tout est maté, on garde tout (position
  // perdue de toute façon, la couverture est préservée).
  if (best === Number.POSITIVE_INFINITY) return mapped.filter((m) => m.value === best);
  if (best === Number.NEGATIVE_INFINITY) return [...mapped];
  return mapped.filter((m) => best - m.value <= opts.equivalenceCp);
}

/** Parties mini du pool de référence pour un lift fiable (en dessous : repli popularité pure). */
export const MIN_REF_GAMES = 30;

/**
 * Tranche notre réplique par le juge moteur (null = repli gradient :
 * pas de juge branché, un seul candidat, moteur aveugle ou évincé).
 * Rend les coups sains classés (meilleur d'abord après départage) ; c'est
 * l'appelant qui ne garde que le meilleur (contrat 1-coup des modes
 * blancs/noirs). Ex æquo départagés par une recherche profonde en fenêtre
 * resserrée — si ça ne sépare pas, le meilleur du creusage gagne : le BFS
 * creuse UNE ligne via l'API et re-jugera en profondeur. Un abandon
 * (Arrêter) se propage toujours.
 */
async function judgeOwnReplies(
  fen: string,
  candidates: LichessMove[],
  settings: EngineJudgeSettings | undefined,
  signal: AbortSignal | undefined,
  stats: AutoGenStats,
  cache: Map<string, EngineMove[]>,
  onPartial?: (ranked: EngineEvalLine[]) => void,
): Promise<{ candidate: LichessMove; value: number }[] | null> {
  if (!settings || candidates.length < 2) return null;

  // Déclenchement intelligent (Cutoff) : si un coup est ultra-dominant dans la pratique
  // (ex: >= 85% des parties et gap >= 60% avec le second), pas besoin d'invoquer le moteur.
  const skipThreshold = settings.skipDominantThreshold;
  if (skipThreshold !== undefined && skipThreshold > 0 && skipThreshold <= 1.0) {
    const totalCandGames = candidates.reduce((s, m) => s + gamesOf(m), 0);
    if (totalCandGames >= 30) {
      const sortedCand = [...candidates].sort((a, b) => gamesOf(b) - gamesOf(a));
      const topRatio = gamesOf(sortedCand[0]) / totalCandGames;
      const secondRatio = sortedCand.length > 1 ? gamesOf(sortedCand[1]) / totalCandGames : 0;
      if (topRatio >= skipThreshold && (topRatio - secondRatio) >= 0.6) {
        return null;
      }
    }
  }

  const multiPv = Math.max(
    settings.multiPv ?? ENGINE_DEFAULTS.multiPv,
    // Couvrir tous les candidats : avec Branches max à 12, un MultiPV fixe
    // de 6 rendrait moins de lignes que de candidats → `pickEngineReplies`
    // verrait un résultat partiel et replierait sur le gradient à chaque
    // position large (des centaines de replis, moteur inutile).
    Math.min(candidates.length, ENGINE_DEFAULTS.multiPvCap),
  );
  const depth = settings.depth ?? ENGINE_DEFAULTS.depth;
  const timeoutMs = settings.timeoutMs ?? ENGINE_DEFAULTS.timeoutMs;
  const equivalenceCp = settings.equivalenceCp ?? ENGINE_DEFAULTS.equivalenceCp;
  const tiebreakDepth = settings.tiebreakDepth ?? ENGINE_DEFAULTS.tiebreakDepth;
  const tiebreakWindowCp = settings.tiebreakWindowCp ?? ENGINE_DEFAULTS.tiebreakWindowCp;
  const tiebreakTimeoutMs = settings.tiebreakTimeoutMs ?? ENGINE_DEFAULTS.tiebreakTimeoutMs;
  const tiebreakTriggerCp = ENGINE_DEFAULTS.tiebreakTriggerCp;
  const toEvalLines = (lines: EngineMove[]): EngineEvalLine[] =>
    [...lines]
      .sort((a, b) => engineValue(b) - engineValue(a))
      .map((em) => ({ uci: em.uci, san: em.san, value: engineValue(em) }));

  const runJudge = async (d: number, t: number): Promise<{ lines: EngineMove[]; cached: boolean }> => {
    const norm = normalizeFen(fen);
    const cacheKey = engineEvalCacheKey(norm, d, multiPv);

    // 1. Cache IndexedDB persistant (cross-session)
    const idbCached = await idbGetEngineEval(cacheKey);
    if (idbCached) {
      stats.engineCached = (stats.engineCached || 0) + 1;
      if (onPartial && idbCached.lines.length > 0) onPartial(toEvalLines(idbCached.lines));
      cache.set(cacheKey, idbCached.lines);
      return { lines: idbCached.lines, cached: true };
    }

    // 2. Cache mémoire (run courant)
    const memCached = cache.get(cacheKey);
    if (memCached) {
      stats.engineCached = (stats.engineCached || 0) + 1;
      if (onPartial && memCached.length > 0) onPartial(toEvalLines(memCached));
      return { lines: memCached, cached: true };
    }

    // 3. Évaluation moteur
    const lines = await (settings as EngineJudgeSettings).judge(fen, {
      multiPv,
      depth: d,
      timeoutMs: t,
      signal,
      onPartial: onPartial
        ? (pLines: EngineMove[]) => {
            if (pLines.length > 0) onPartial(toEvalLines(pLines));
          }
        : undefined,
    });
    if (lines && lines.length > 0) {
      cache.set(cacheKey, lines);
      // Persister dans IndexedDB pour les runs futurs
      await idbPutEngineEval({
        key: cacheKey,
        lines,
        savedAt: Date.now(),
      });
    }
    return { lines, cached: false };
  };

  try {
    throwIfAborted(signal);
    const tri = await runJudge(depth, timeoutMs);
    const picked = pickEngineReplies(candidates, tri.lines, fen, { equivalenceCp });
    if (!picked || picked.length === 0) {
      stats.engineFallbacks++;
      return null;
    }
    // engineNodes = vrais calculs uniquement : un jugement 100 % servi par
    // le cache (tri + éventuel départage) ne compte qu'en sf-cache.
    let computed = !tri.cached;
    // Départage seulement si le top-2 est serré : au-delà, le classement
    // est déjà clair (le meilleur gagne sans surcoût).
    if (picked.length > 1) {
      let top1 = -Infinity;
      let top2 = -Infinity;
      for (const p of picked) {
        if (p.value > top1) {
          top2 = top1;
          top1 = p.value;
        } else if (p.value > top2) {
          top2 = p.value;
        }
      }
      if (top1 - top2 <= tiebreakTriggerCp) {
        try {
          throwIfAborted(signal);
          const deep = await runJudge(tiebreakDepth, tiebreakTimeoutMs);
          if (!deep.cached) computed = true;
          const split = pickEngineReplies(
            picked.map((p) => p.candidate), deep.lines, fen, { equivalenceCp: tiebreakWindowCp },
          );
          if (split && split.length > 0) {
            if (computed) stats.engineNodes++;
            return split;
          }
        } catch (err) {
          if (isAbortError(err) || signal?.aborted) throw err;
          /* départage raté : on garde le meilleur du tri initial */
        }
      }
    }
    if (computed) stats.engineNodes++;
    return picked;
  } catch (err) {
    if (isAbortError(err) || signal?.aborted) throw err;
    // Moteur aveugle/évincé : repli gradient, branche conservée (jamais d'abandon).
    stats.engineFallbacks++;
    return null;
  }
}
/** Plafond du multiplicateur de qualité (×3 : l'ancrage local reste dominant). */
export const QUALITY_LIFT_CAP = 2;
/** Plancher du multiplicateur (un coup abandonné des forts est écrasé, jamais inversé). */
export const QUALITY_LIFT_FLOOR = 0.1;
/** Lissage du lift (évite la division par ~0 sur les coups rarissimes). */
const QUALITY_EPS = 0.02;

/**
 * Qualité fréquentiste d'un coup, SANS winrate ni moteur : combine sa part
 * à notre niveau (`userGames/userTotal`, ancrage : sous-arbre riche en
 * parties) et son gradient Elo (part chez les Maîtres − part chez nous).
 * Un coup qui monte avec le niveau est boosté (×3 max), un coup que les
 * forts ont abandonné est écrasé (×0.1 min). Référence vide ou peu fournie
 * → popularité pure (repli automatique, aucun échec compté).
 */
export function qualityScore(userGames: number, userTotal: number, refGames: number, refTotal: number): number {
  const fUser = userTotal > 0 ? Math.max(0, userGames) / userTotal : 0;
  if (!(refTotal >= MIN_REF_GAMES)) return fUser;
  const fRef = Math.max(0, refGames) / refTotal;
  const lift = (fRef - fUser) / (fUser + QUALITY_EPS);
  const mult = Math.max(QUALITY_LIFT_FLOOR, Math.min(1 + QUALITY_LIFT_CAP, 1 + lift));
  return fUser * mult;
}

/**
 * Plafond du budget positions : sans borne, une valeur tapée trop grande
 * (le champ était "illimité") lançait une boucle de dizaines de milliers
 * de positions qui monopolisait le thread principal — l'onglet semblait
 * gelé et seul sa fermeture aidait. Le panneau borne déjà la saisie, ce
 * garde-fou protège aussi les appels directs.
 */
export const MAX_AUTO_POSITIONS = 5000;

/** Borne anti-freeze du budget (saisie panneau + appels directs). */
export function clampAutoBudget(n: unknown): number {
  return typeof n === 'number' && Number.isFinite(n)
    ? Math.max(1, Math.min(MAX_AUTO_POSITIONS, Math.round(n)))
    : DEFAULTS.maxPositions;
}

export interface PruneOptions {
  side: 'white' | 'black';
  minLineValue: number;
  optimism?: number;
  residual?: number;
}

/**
 * Passe d'élagage finale : à nos nœuds de décision, retire les coups sous
 * `minLineValue` (Line Value par induction arrière). Le meilleur coup est
 * toujours conservé (jamais d'élagage à zéro). Les nœuds adverses sont
 * intacts : leurs coups sont la réalité, pas un choix.
 * Retourne le nombre de coups retirés (sous-arbres inclus).
 */
export function pruneLowValueLines(root: RepertoireRoot, opts: PruneOptions): number {
  const assignDepth = (node: LineValueNode, depth: number): void => {
    node.depth = depth;
    for (const c of node.children || []) assignDepth(c, depth + 1);
  };
  assignDepth(root as unknown as LineValueNode, 0);
  // Les nœuds générés portent les stats Lichess en `victoires_*`, pas en
  // `white/draws/black` : on les mappe avant l'induction (sinon LV = 0.5 partout).
  const syncStats = (node: LineValueNode): void => {
    const m = node as unknown as {
      victoires_blancs?: number; nuls?: number; victoires_noirs?: number;
    };
    if (node.white == null && m.victoires_blancs != null) node.white = m.victoires_blancs;
    if (node.draws == null && m.nuls != null) node.draws = m.nuls;
    if (node.black == null && m.victoires_noirs != null) node.black = m.victoires_noirs;
    for (const c of node.children || []) syncStats(c);
  };
  syncStats(root as unknown as LineValueNode);
  let rootWhite = true;
  try {
    rootWhite = new Chess(root.fen || INITIAL_FEN).turn() === 'w';
  } catch {
    /* défaut : trait blanc */
  }
  computeLineValues(root as unknown as LineValueNode, {
    side: opts.side,
    optimism: opts.optimism ?? 0.3,
    residual: opts.residual ?? 0.5,
    rootWhite,
  });

  const countSubtree = (node: LineValueNode): number =>
    1 + (node.children || []).reduce((s, c) => s + countSubtree(c), 0);

  let removed = 0;
  const pruneAt = (node: LineValueNode, depth: number): void => {
    const kids = node.children || [];
    for (const k of kids) pruneAt(k, depth + 1);
    const whiteToMove = (depth % 2 === 0) === rootWhite;
    const ourTurn = whiteToMove === (opts.side === 'white');
    if (!ourTurn || kids.length <= 1) return;
    let best = kids[0];
    for (const k of kids) {
      if ((k.lineValue ?? -1) > (best.lineValue ?? -1)) best = k;
    }
    // Les mats ne sont jamais élagués (fin forcée prioritaire, pas un avis).
    const isMateNode = (k: LineValueNode): boolean =>
      (k as unknown as { isMate?: boolean }).isMate === true;
    const kept = kids.filter(
      (k) => k === best || isMateNode(k) || (k.lineValue ?? 0) >= opts.minLineValue,
    );
    if (kept.length !== kids.length) {
      removed += kids.reduce((s, k) => s + (kept.includes(k) ? 0 : countSubtree(k)), 0);
      node.children = kept;
    }
  };
  pruneAt(root as unknown as LineValueNode, 0);
  return removed;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    const err = new Error('Aborted');
    (err as { name: string }).name = 'AbortError';
    throw err;
  }
}

/**
 * Rend la main au navigateur (macrotask) pour que React peigne et que le
 * bouton Arrêter reste cliquable. Indispensable sur le chemin 100 % cache :
 * sans pause réseau, la boucle n'était qu'une chaîne de microtasks qui ne
 * laissait jamais l'onglet respirer (freeze apparent). Rejette en
 * AbortError si le signal est annulé pendant l'attente.
 */
function yieldToUI(signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    const err = new Error('Aborted');
    (err as { name: string }).name = 'AbortError';
    return Promise.reject(err);
  }
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, 0);
    const onAbort = (): void => {
      clearTimeout(timer);
      const err = new Error('Aborted');
      (err as { name: string }).name = 'AbortError';
      reject(err);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export interface HeapItem {
  priority: number;
  depth: number;
  order: number;
  fen: string;
  pathSans: string[];
  pathUcis: string[];
  pathFens: string[];
  parentId: string;
  popularity: number;
}

export function isHigherHeapItem(a: HeapItem, b: HeapItem): boolean {
  if (a.priority !== b.priority) return a.priority > b.priority;
  if (a.depth !== b.depth) return a.depth < b.depth;
  return a.order < b.order;
}

/**
 * Clone récursivement un sous-arbre de répertoire en garantissant l'absence de cycles
 * (protection contre les répétitions triples / manœuvres de pièces).
 */
export function cloneSubtreeCycleSafe(
  moves: RepertoireMove[],
  ancestorFens: Set<string>,
  maxDepth = 12,
): RepertoireMove[] {
  if (maxDepth <= 0 || !moves || moves.length === 0) return [];
  const result: RepertoireMove[] = [];
  for (const m of moves) {
    const norm = normalizeFen(m.fen);
    if (ancestorFens.has(norm)) {
      result.push({ ...m, children: [] });
      continue;
    }
    const nextAncestors = new Set(ancestorFens);
    nextAncestors.add(norm);
    result.push({
      ...m,
      children: m.children && m.children.length > 0
        ? cloneSubtreeCycleSafe(m.children, nextAncestors, maxDepth - 1)
        : [],
    });
  }
  return result;
}

export async function generateAutoRepertoire(
  startFen: string = INITIAL_FEN,
  cfgIn: AutoGenConfig = {},
  events: AutoGenEvents = {},
): Promise<{ root: RepertoireRoot; stats: AutoGenStats; completed: boolean }> {
  const cfg = { ...DEFAULTS, ...cfgIn };
  // Sanitize anti-freeze (défense en profondeur : le panneau borne déjà la
  // saisie, mais un appel direct avec maxPositions = 1e9 bouclait sans fin).
  {
    const rawMax = (cfg as AutoGenConfig).maxPositions as unknown;
    cfg.maxPositions = clampAutoBudget(rawMax);
    const rawDepth = (cfg as AutoGenConfig).maxDepth as unknown;
    const d = typeof rawDepth === 'number' ? rawDepth : DEFAULTS.maxDepth;
    cfg.maxDepth = Number.isFinite(d)
      ? Math.max(1, Math.min(32, Math.round(d)))
      : DEFAULTS.maxDepth;
    const rawBranch = (cfg as AutoGenConfig).maxBranching as unknown;
    const b = typeof rawBranch === 'number' ? rawBranch : DEFAULTS.maxBranching;
    cfg.maxBranching = Number.isFinite(b)
      ? Math.max(1, Math.min(12, Math.round(b)))
      : DEFAULTS.maxBranching;
  }
  const rootFen = startFen || INITIAL_FEN;
  const root: RepertoireRoot = { fen: rootFen, children: [] };
  const emitted = new Map<string, RepertoireMove | RepertoireRoot>();
  emitted.set('root', root);

  // Chauffe du cache durable AVANT le premier `hasLichessCache` : sans ça,
  // les positions déjà en IndexedDB sont comptées « API » (le read-through
  // du fetch évite pourtant le réseau) et le bonus cache des enfants rate.
  // (Ne lève jamais : le run continue en mémoire seule. L'annulation est
  // honorée par le throwIfAborted de la boucle, DANS le try → partiel.)
  try {
    await explorerCacheReady();
  } catch {
    /* IDB indisponible : mémoire seule, le run continue */
  }

  const stats: AutoGenStats = {
    sent: 0, cached: 0, api: 0, refCached: 0, refApi: 0, engineNodes: 0, engineFallbacks: 0,
    engineCached: 0, pruned: 0, transpositions: 0, explored: 0,
    depthPruned: 0, popPruned: 0, bookPenalized: 0, cacheBoostedChildren: 0,
    maxDepthReached: 0, maxEmittedDepth: 0, branchesTotal: 0, emptyPositions: 0,
    positionsInterrogees: 0, failed: 0, failedFens: [], prunedValue: 0, mates: 0,
    quiescenceExtended: 0,
  };
  let completed = true;

  const initialFenKey = normalizeFen(rootFen);
  const heap = new PriorityQueue<HeapItem>(isHigherHeapItem);
  heap.push({
    priority: 1, depth: 0, order: 0, fen: rootFen,
    pathSans: [], pathUcis: [], pathFens: [initialFenKey],
    parentId: 'root', popularity: 1,
  });

  let order = 0;
  const visited = new Set<string>();
  const seen = new Set<string>([initialFenKey]);
  const canonicalNodesByFen = new Map<string, AutoGenNode>();
  const transpositionNodes: { node: AutoGenNode; fenKey: string; ancestorFens: Set<string> }[] = [];
  const engineCache = cfg.engineJudge?.cache ?? new Map<string, EngineMove[]>();

  const findParentList = (parentId: string): RepertoireMove[] => {
    const holder = emitted.get(parentId);
    if (!holder) return root.children;
    if ('children' in holder) return holder.children || [];
    return root.children;
  };

  try {
  while (heap.length > 0) {
    throwIfAborted(events.signal);
    const item = heap.pop()!;
    const { depth, fen, pathSans, pathUcis, pathFens, parentId, popularity } = item;

    try {
      const probe = new Chess(fen);
      if (probe.isGameOver()) continue;
    } catch {
      continue;
    }
    if (popularity < (cfg.minPopularity as number)) {
      stats.popPruned++;
      continue;
    }
    const limit = effectiveMaxDepth(cfg.maxDepth as number, depth, popularity, cfg);
    const maxQuiescence = cfg.maxQuiescence ?? DEFAULTS.maxQuiescence;
    if (depth >= limit) {
      let isUnstable = false;
      if (maxQuiescence > 0 && depth < limit + maxQuiescence) {
        try {
          const probe = new Chess(fen);
          const inCheck = probe.inCheck();
          const lastSan = pathSans.length > 0 ? pathSans[pathSans.length - 1] : '';
          const wasCaptureOrCheck = lastSan.includes('x') || lastSan.includes('+');
          
          // Détection tactique avancée : recaptures et pièces pendantes
          let hasRecapture = false;
          let hasHangingPiece = false;
          
          if (wasCaptureOrCheck) {
            // Recapture : si un pion/pièce vient d'être pris, la reprise est naturelle
            if (lastSan.includes('x')) {
              const moves = probe.moves({ verbose: true });
              for (const m of moves) {
                if (m.san.includes('x')) {
                  hasRecapture = true;
                  break;
                }
              }
            }
            
            // Pièce pendante : une pièce adverse est attaquée sans défense
            const board = probe.board();
            for (const row of board) {
              for (const square of row) {
                if (!square || square.color === probe.turn()) continue;
                // Pièce adverse : vérifier si elle est attaquée sans défense
                const attacked = probe.moves({ square: square.square, verbose: true });
                if (attacked.length > 0) {
                  // Vérifier si la pièce est défendue (tous les coups qui arrivent sur cette case)
                  const allMoves = probe.moves({ verbose: true });
                  const defenders = allMoves.filter(m => m.to === square.square);
                  if (defenders.length === 0) {
                    hasHangingPiece = true;
                    break;
                  }
                }
              }
              if (hasHangingPiece) break;
            }
          }
          
          isUnstable = inCheck || wasCaptureOrCheck || hasRecapture || hasHangingPiece;
        } catch {
          isUnstable = false;
        }
      }
      if (isUnstable) {
        stats.quiescenceExtended = (stats.quiescenceExtended || 0) + 1;
      } else {
        stats.depthPruned++;
        continue;
      }
    }
    if (stats.positionsInterrogees >= (cfg.maxPositions as number)) break;

    const fenKey = normalizeFen(fen);
    if (visited.has(fenKey)) continue;
    visited.add(fenKey);
    stats.explored++;
    stats.maxDepthReached = Math.max(stats.maxDepthReached, depth);

    let data: Awaited<ReturnType<typeof fetchLichessMoves>> | null = null;
    const wasCached = hasLichessCache(fen, cfg.endpoint, cfg.ratingsParam, undefined, cfg.since);
    const extraRetries = cfg.extraFetchRetries as number;
    for (let attempt = 0; attempt <= extraRetries; attempt++) {
      try {
        data = await fetchLichessMoves(fen, undefined, cfg.endpoint, cfg.ratingsParam, undefined, {
          signal: events.signal,
          since: cfg.since,
        });
        break;
      } catch (err) {
        if (isAbortError(err) || events.signal?.aborted) throw err;
        if (attempt < extraRetries) {
          // Échec transient : une seconde chance après un délai doublé
          // (annulation pendant l'attente → remonte vers l'arrêt propre).
          await abortableSleep((cfg.gapMs as number) * 2, events.signal);
          continue;
        }
        // Épuisé : la branche est abandonnée MAIS comptée et visible.
        stats.failed++;
        if (stats.failedFens.length < 20) stats.failedFens.push(fenKey);
        events.onProgress?.({ ...stats });
      }
    }
    if (!data) continue;
    stats.positionsInterrogees++;
    if (wasCached) stats.cached++;
    else {
      stats.api++;
      if (stats.positionsInterrogees < (cfg.maxPositions as number) && (cfg.gapMs as number) > 0) {
        try {
          await abortableSleep(cfg.gapMs as number, events.signal);
        } catch (err) {
          if (isAbortError(err)) throw err;
        }
      }
    }
    if (wasCached) {
      // Chemin 100 % cache : aucune pause réseau ni fetch macrotask, la
      // boucle n'était qu'une chaîne de microtasks qui gelait l'onglet
      // (aucune peinture, Arrêter inerte). On rend la main à chaque
      // position en cache : l'UI reste fluide et l'arrêt est immédiat.
      await yieldToUI(events.signal);
    }

    const moves = data.moves || [];
    const total = moves.reduce((s, m) => s + gamesOf(m), 0);
    if (!total) {
      stats.emptyPositions++;
      continue;
    }

    // À notre tour (modes blancs/noirs) : double lecture Maîtres pour le
    // gradient Elo (trouver les coups sains sans winrate ni moteur) — SAUF
    // juge moteur actif : Stockfish tranche seul, pas de double lecture.
    // Le pool adverse reste toujours le nôtre uniquement (ce qu'on va
    // affronter) ; en mode 'both' ou endpoint Maîtres, pas de double
    // lecture (pas de « nous » / même pool → repli popularité pure).
    let isOwnTurnNode = false;
    try {
      const turn = new Chess(fen).turn(); // 'w' | 'b'
      const repColor = cfg.repertoireColor as string;
      isOwnTurnNode =
        (repColor === 'white' && turn === 'w') || (repColor === 'black' && turn === 'b');
    } catch {
      /* FEN illisible : pas de double lecture */
    }
    // Part du coup chez les Maîtres (0 si absent) + total de référence.
    // Échec de la référence → dégradation silencieuse (jamais d'abandon
    // de branche : la qualité retombe sur la popularité pure).
    let refTotal = 0;
    const refGamesByKey = new Map<string, number>();
    if (isOwnTurnNode && !cfg.engineJudge && (cfg.endpoint as string) !== 'masters') {
      const refWasCached = hasLichessCache(fen, 'masters', undefined, undefined, cfg.since);
      try {
        const ref = await fetchLichessMoves(fen, undefined, 'masters', undefined, undefined, {
          signal: events.signal,
          since: cfg.since,
        });
        const refMoves = ref.moves || [];
        refTotal = refMoves.reduce((s, m) => s + gamesOf(m), 0);
        for (const m of refMoves) {
          if (m.uci) refGamesByKey.set(`u:${normalizeCastleUci(fen, m.uci)}`, gamesOf(m));
          refGamesByKey.set(`s:${m.san}`, gamesOf(m));
        }
        if (refWasCached) stats.refCached++;
        else {
          stats.refApi++;
          if ((cfg.gapMs as number) > 0) {
            try {
              await abortableSleep(cfg.gapMs as number, events.signal);
            } catch (err) {
              if (isAbortError(err)) throw err;
            }
          }
        }
      } catch (err) {
        if (isAbortError(err) || events.signal?.aborted) throw err;
        refTotal = 0;
        refGamesByKey.clear();
      }
    }
    const refGamesOf = (m: LichessMove): number => {
      if (m.uci) {
        const g = refGamesByKey.get(`u:${normalizeCastleUci(fen, m.uci)}`);
        if (g !== undefined) return g;
      }
      return refGamesByKey.get(`s:${m.san}`) ?? 0;
    };
    const qualityOf = (m: LichessMove): number =>
      qualityScore(gamesOf(m), total, refGamesOf(m), refTotal);

    // Couverture pondérée par profondeur (large à la base, resserrée en haut).
    const effCoverage = depthWeightedCoverage(
      cfg.coveragePercent as number, depth, cfg.maxDepth as number,
    );
    const inQuiescence = depth >= limit;
    const branchCap = inQuiescence
      ? Math.min(2, cfg.maxBranching as number)
      : (cfg.maxBranching as number);
    let selected = selectMovesByCoverage(moves, total, {
      ...cfg,
      maxBranching: branchCap,
      coveragePercent: effCoverage,
    });
    // Mats prioritaires (deux camps) : un mat est une fin forcée, pas un
    // avis — inclusion garantie même sous les seuils, exploré en premier.
    // Détection sans moteur : '#' Explorer + mat-en-1 légal (chess.js).
    const mateUcis = findMateInOneUcis(fen);
    const isMateMove = (m: LichessMove): boolean =>
      m.san.endsWith('#') || (m.uci !== '' && mateUcis.has(normalizeCastleUci(fen, m.uci)));
    const keptSel = new Set(selected.map((s) => s.move));
    for (const m of moves) {
      if (!keptSel.has(m) && m.uci && isMateMove(m)) {
        selected.push({ move: m, freq: (gamesOf(m) / total) * 100 });
        keptSel.add(m);
      }
    }
    // Tri stable : mats d'abord, le reste garde l'ordre de couverture.
    selected.sort((a, b) => Number(isMateMove(b.move)) - Number(isMateMove(a.move)));
    // Mode couleur : à notre tour, nos répliques — juge moteur OPT-IN
    // (choix utilisateur explicite : le meilleur selon Stockfish, départagé
    // en creusant si le top-2 est serré), sinon qualité gradient-Elo.
    // Dans les deux cas : UNE SEULE réplique (contrat 1-coup des modes
    // blancs/noirs). Les mats restent inclus (fin forcée prioritaire) à côté
    // du coup sain.
    if (isOwnTurnNode && selected.length > 0) {
      const mates = selected.filter((s) => isMateMove(s.move));
      const others = selected.filter((s) => !isMateMove(s.move));
      const judged = await judgeOwnReplies(
        fen, others.map((s) => s.move), cfg.engineJudge as EngineJudgeSettings | undefined,
        events.signal, stats, engineCache,
        events.onEnginePartial ? (ranked) => events.onEnginePartial?.(fen, ranked) : undefined,
      );
      if (judged) {
        // Le juge rend les équivalents classés (meilleur d'abord pour les
        // flèches live) mais l'arbre ne garde que le MEILLEUR : en mode
        // blancs/noirs, à notre tour, on choisit une ligne (e4 OU d4, pas
        // les deux). `judged` suit l'ordre candidats (popularité), on trie
        // donc par valeur moteur pour extraire l'argmax.
        const ranked = [...judged].sort((a, b) => b.value - a.value);
        // Flèche finale = le coup retenu seul (l'arbre ne garde que lui).
        const best = ranked[0];
        events.onEngineEval?.(
          fen,
          [{ uci: best.candidate.uci, san: best.candidate.san, value: best.value }],
        );
        const bestSel = others.find((s) => s.move === best.candidate) ?? others[0];
        selected = [bestSel, ...mates.filter((s) => s !== bestSel)];
      } else {
        const pool = others.length > 0 ? others : mates;
        let best = pool[0];
        let bestQ = -Infinity;
        for (const s of pool) {
          const q = qualityOf(s.move);
          if (q > bestQ) {
            bestQ = q;
            best = s;
          }
        }
        selected = [best, ...mates.filter((s) => s !== best)];
      }
    }
    if (selected.length === 0) {
      stats.emptyPositions++;
      continue;
    }
    stats.branchesTotal += selected.length;

    const contestedness = computeContestedness(moves, total);
    const bookScore = computeBookScore(moves, total);
    const topFreq = moves.length > 0 ? gamesOf(moves[0]) / total : 0;
    const isBook = bookScore >= (cfg.bookGapMin as number) && topFreq >= (cfg.bookTopMin as number);
    if (isBook) stats.bookPenalized++;

    const kept = new Set(selected.map((s) => s.move));
    for (const m of moves) if (!kept.has(m)) stats.pruned++;

    for (let rank = 0; rank < selected.length; rank++) {
      throwIfAborted(events.signal);
      const { move, freq } = selected[rank];
      const childFen = fenAfterUci(fen, move.uci);
      if (!childFen) continue;
      const stdUci = normalizeCastleUci(fen, move.uci);
      const childKey = normalizeFen(childFen);
      const isTranspo = seen.has(childKey);
      seen.add(childKey);
      if (isTranspo) stats.transpositions++;

      const childPop = popularity * (freq / 100);
      const sp = spreadPenalty(rank, contestedness, cfg);
      const bp = isBook ? (cfg.bookPenalty as number) : 1;
      const childCached = hasLichessCache(childFen, cfg.endpoint, cfg.ratingsParam, undefined, cfg.since);
      const cb = childCached ? (cfg.cacheHitBonus as number) : 1;
      if (childCached && (cfg.cacheHitBonus as number) > 1) stats.cacheBoostedChildren++;
      // Mat terminal (aucun sous-arbre) : priorité absolue d'exploration.
      const mate = isMateMove(move);
      const priority = childPop * sp * bp * cb + (mate ? MATE_PRIORITY_BONUS : 0);

      const games = gamesOf(move);
      const node: AutoGenNode = {
        coup: move.san,
        uci: stdUci,
        san: move.san,
        parties: games > 0 ? games : 100,
        victoires_blancs: move.white,
        nuls: move.draws,
        victoires_noirs: move.black,
        score_moyen: move.averageRating,
        ouverture: move.opening?.name,
        eco: move.opening?.eco,
        fen: childFen,
        children: [],
        fenKey: childKey,
        freq: Math.round(freq * 10) / 10,
        popularity: Math.round(childPop * 100 * 10000) / 10000,
        contestedness: Math.round(contestedness * 1000) / 1000,
        bookScore: Math.round(bookScore * 1000) / 1000,
        rank,
        depth: depth + 1,
        transposition: isTranspo,
        ...(mate ? { isMate: true as const } : {}),
      };

      findParentList(parentId).push(node);
      const nodeId = [...pathSans, move.san].join('_');
      emitted.set(nodeId, node);
      stats.sent++;
      if (mate) stats.mates++;
      stats.maxEmittedDepth = Math.max(stats.maxEmittedDepth, depth + 1);
      events.onNode?.(node, parentId, nodeId);
      events.onProgress?.({ ...stats });

      if (!isTranspo) {
        if (!canonicalNodesByFen.has(childKey)) {
          canonicalNodesByFen.set(childKey, node);
        }
        order++;
        heap.push({
          priority, depth: depth + 1, order, fen: childFen,
          pathSans: [...pathSans, move.san], pathUcis: [...pathUcis, stdUci],
          pathFens: [...pathFens, childKey],
          parentId: nodeId, popularity: childPop,
        });
      } else {
        transpositionNodes.push({
          node,
          fenKey: childKey,
          ancestorFens: new Set(pathFens),
        });
      }
    }
  }
  } catch (err) {
    // Annulation volontaire : on garde l'arbre partiel au lieu de tout jeter.
    if (isAbortError(err) || events.signal?.aborted) {
      completed = false;
    } else {
      throw err;
    }
  }

  // Réplication de sous-arbres pour les transpositions :
  // Les transpositions reçoivent une copie cycle-safe des réponses calculées sur le nœud canonique.
  for (const { node, fenKey, ancestorFens } of transpositionNodes) {
    const canonical = canonicalNodesByFen.get(fenKey);
    if (canonical && canonical.children && canonical.children.length > 0) {
      node.children = cloneSubtreeCycleSafe(canonical.children, ancestorFens);
    }
  }

  // Le run est fini (complet ou interrompu) : on persiste le partiel tout de
  // suite au lieu d'attendre le timer de 15 s — un onglet fermé/tué avant le
  // timer perdait toute la session (cache « supprimé » apparent au run suivant).
  // Ne lève jamais (flush protégé) : le rapport est rendu dans tous les cas.
  await flushLichessPersist();

  // Passe d'élagage (y compris sur partiel interrompu) : retire nos coups
  // faibles (Line Value), jamais chez l'adversaire (ses coups sont la
  // réalité). Le meilleur est toujours conservé.
  const minLV = cfg.pruneMinLineValue as number;
  const repColor = cfg.repertoireColor as string;
  if (minLV > 0 && (repColor === 'white' || repColor === 'black')) {
    stats.prunedValue = pruneLowValueLines(root, {
      side: repColor,
      minLineValue: minLV,
      optimism: cfg.pruneOptimism as number,
      residual: cfg.pruneResidual as number,
    });
  }

  return { root, stats, completed };
}
