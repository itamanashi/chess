/**
 * Génération de répertoire "Pièges" par BFS Stockfish MultiPV.
 *
 * À NOTRE tour : Stockfish MultiPV évalue NOS candidats, puis pour chaque
 * candidat évalue les RÉPONSES ADVERSES depuis la position résultante.
 * On émet TOUS les candidats pendant la génération (exploration complète),
 * puis POST-TRAITE pour ne garder qu'une seule réponse par position :
 * celle qui minimise le nombre de bonnes réponses adverses (trap score max).
 *
 * À LEUR tour : on couvre toutes les réponses adverses dans la fenêtre
 * configurable (coups ≤ window cp sous le meilleur). Les coups hors-fenêtre
 * sont des "pièges réussis" — l'adversaire a raté le bon coup.
 *
 * Différences vs autoRepertoire.ts :
 * - Budget = appels Stockfish, cache inclus (pas positions Lichess).
 * - Exploration best-first (promesse = trap score) + extension locale
 *   de profondeur sur filon piégeux, au lieu du BFS uniforme.
 * - Les lignes adverses calculées au temps candidat sont réutilisées
 *   au pop sans re-consommer de budget.
 * - Profondeur asymétrique : nos coups à pleine profondeur, réponses
 *   adverses à profondeur réduite (budget neutre, 2-4× plus rapide).
 * - Lichess optionnel (enrichissement seulement, désactivé par défaut).
 * - Seuil trap score opt-in (0 = désactivé par défaut).
 * - Post-traitement : réduction à une seule réponse à notre tour (trap score max).
 */

import { Chess } from 'chess.js';
import type {
  EngineMove,
  LichessMove,
  RepertoireMove,
  RepertoireRoot,
} from '../types/chess';
import {
  INITIAL_FEN,
  fenAfterUci,
  normalizeCastleUci,
  normalizeFen,
} from '../utils/repertoire';
import {
  fetchLichessMovesWithCacheStatus,
  flushLichessPersist,
  explorerCacheReady,
} from './lichess';
import { abortableSleep, isAbortError, throwIfAborted } from '../utils/async';
import { PriorityQueue } from '../utils/priorityQueue';
import {
  engineEvalCacheKey,
  idbGetEngineEval,
  idbPutEngineEval,
} from '../storage/engineEvalCacheDb';
import {
  findMateInOneUcis,
  gamesOf,
  type EngineJudgeFn,
} from './autoRepertoire';

// ─── Configuration ─────────────────────────────────────────────────────────────

export interface TrapGenConfig {
  /** Profondeur Stockfish par appel (défaut 16). */
  depth?: number;
  /** MultiPV pour les évaluations (défaut 6). */
  multiPv?: number;
  /**
   * Budget : nombre d'appels Stockfish, cache inclus.
   * Chaque évaluation consomme 1 unité, qu'elle soit calculée ou relue
   * depuis le cache (IDB/mémoire). Sans plafond côté moteur.
   * Chaque position à notre tour ≈ 1 appel + 1 par candidat sain.
   * Défaut 80.
   */
  maxPositions?: number;
  /** Profondeur maximale de l'arbre en demi-coups (défaut 12). */
  maxDepth?: number;
  /**
   * Fenêtre "bonne réponse adverse" en cp (défaut 50).
   * Coups adverses dans [best, best − window] sont tous couverts.
   */
  trapAdversaryWindow?: number;
  /**
   * Drop-off minimum entre meilleure et 2e réponse adverse (défaut 0 = désactivé).
   * > 0 : élaguer les lignes sans déséquilibre suffisant.
   */
  minTrapScore?: number;
  /**
   * Solidité de nos coups : max écart vs notre meilleur objectif (défaut 60 cp).
   * 0 = désactivé, tout coup accepté même perdant.
   */
  soundnessWindow?: number;
  /**
   * Enrichir avec Lichess : intersectionner les bonnes réponses Stockfish avec
   * les coups joués à l'Elo cible (désactivé par défaut).
   * Off = aucun appel Explorateur (rapide, 100 % moteur) ; mat en 1 local.
   */
  useLichessForOpponent?: boolean;
  endpoint?: 'masters' | 'lichess';
  ratingsParam?: string;
  since?: number;
  repertoireColor?: 'white' | 'black';
  gapMs?: number;
  extraFetchRetries?: number;
  /** Timeout par appel moteur en ms (défaut 10000). */
  timeoutMs?: number;
  /** Prolongement quiescence (défaut 2). */
  maxQuiescence?: number;
  /**
   * Extension locale de profondeur sur filon piégeux (défaut 2 plies).
   * Quand le trap score du coup entrant atteint `trapExtendMinScore`,
   * le sous-arbre peut descendre jusqu'à maxDepth + extension.
   */
  trapExtensionPlies?: number;
  /**
   * Seuil de trap score déclenchant l'extension locale (défaut 80 cp).
   * 0 = extension dès qu'un coup est émis (déconseillé : arbre profond partout).
   */
  trapExtendMinScore?: number;
  /**
   * Réservé benchmark/tests : restaure l'ordre BFS uniforme
   * (profondeur puis insertion) au lieu du best-first par promesse.
   */
  forceBfsOrder?: boolean;
  /**
   * Réservé benchmark/tests : désactive la réutilisation des lignes
   * adverses au pop (retrouve le coût historique : 1 unité par relecture).
   */
  disablePreLinesReuse?: boolean;
  /**
   * Les réponses adverses sont évaluées moins profond que nos coups :
   * `max(8, depth - delta)` (défaut 4 : D16 → D12 adverse).
   * Le drop-off se lit déjà de loin ; nos coups gardent la pleine profondeur.
   * Même nombre d'appels (budget neutre), appels adverses 2-4× plus rapides.
   * 0 = comportement historique (tout à pleine profondeur).
   */
  trapAdversaryDepthDelta?: number;
  /** Juge moteur injectable. */
  judge?: EngineJudgeFn;
}

export interface TrapGenStats {
  /** Évaluations Stockfish calculées (hors cache). */
  positionsInterrogees: number;
  sent: number;
  engineNodes: number;
  engineCached: number;
  engineFallbacks: number;
  /** Lignes adverses déjà calculées réutilisées au re-pop (0 budget). */
  engineReused: number;
  /** Nœuds traités grâce à l'extension locale (filon piégeux). */
  trapExtended: number;
  mates: number;
  trapPruned: number;
  unsoundPruned: number;
  adversaryCovered: number;
  adversaryUncovered: number;
  failed: number;
  failedFens: string[];
  transpositions: number;
  explored: number;
  depthPruned: number;
  quiescenceExtended: number;
  closingReplies: number;
  unanswered: number;
  elapsedMs: number;
  cached: number;
  api: number;
}

export interface TrapGenEvents {
  onNode?: (node: RepertoireMove, parentId: string, nodeId: string) => void;
  onProgress?: (stats: TrapGenStats) => void;
  signal?: AbortSignal;
}

// ─── Constantes ────────────────────────────────────────────────────────────────

const DEFAULTS: Required<
  Omit<TrapGenConfig, 'ratingsParam' | 'since' | 'judge'>
> = {
  depth: 16,
  multiPv: 6,
  maxPositions: 80,
  maxDepth: 12,
  trapAdversaryWindow: 50,
  minTrapScore: 0,
  soundnessWindow: 60,
  useLichessForOpponent: false,
  endpoint: 'masters',
  repertoireColor: 'white',
  gapMs: 600,
  extraFetchRetries: 1,
  timeoutMs: 10000,
  maxQuiescence: 2,
  trapExtensionPlies: 2,
  trapExtendMinScore: 80,
  forceBfsOrder: false,
  disablePreLinesReuse: false,
  trapAdversaryDepthDelta: 4,
};

const CACHED_UI_YIELD_INTERVAL = 16;

// ─── Types internes ────────────────────────────────────────────────────────────

interface HeapItem {
  /** Promesse du filon (trap score du coup entrant, mat = très haut). */
  priority: number;
  depth: number;
  fen: string;
  fenKey: string;
  parentId: string;
  pathSans: string[];
  pathUcis: string[];
  seq: number;
  reachProb: number;
  /**
   * Lignes MultiPV déjà calculées pour cette position (éval adverse
   * du temps candidat) : réutilisées au pop sans consommer de budget.
   * Valides uniquement si `preMultiPv` égale la demande du pop.
   */
  preLines?: EngineMove[];
  /** MultiPV demandé lors du calcul de `preLines`. */
  preMultiPv?: number;
  /** Profondeur demandée lors du calcul de `preLines`. */
  preDepth?: number;
  /** Bonus de profondeur hérité (extension locale sur filon piégeux). */
  depthBonus: number;
}

/** Priorité mat : toujours explorée en premier. */
export const TRAP_MATE_PRIORITY = 1_000_000;

/**
 * Best-first : promesse (trap score) d'abord, puis profondeur faible
 * (largeur), puis ordre d'insertion. Sous budget serré, les filons
 * piégeux sont évalués avant les coups plats.
 */
export function heapHigher(a: HeapItem, b: HeapItem): boolean {
  if (a.priority !== b.priority) return a.priority > b.priority;
  if (a.depth !== b.depth) return a.depth < b.depth;
  return a.seq < b.seq;
}

/** Ordre historique BFS uniforme (benchmark : `forceBfsOrder`). */
function bfsHigher(a: HeapItem, b: HeapItem): boolean {
  if (a.depth !== b.depth) return a.depth < b.depth;
  return a.seq < b.seq;
}

// ─── Helpers évaluation ────────────────────────────────────────────────────────

function engineVal(em: EngineMove): number {
  if (em.mate !== undefined)
    return em.mate > 0 ? Number.POSITIVE_INFINITY : Number.NEGATIVE_INFINITY;
  return em.cp ?? Number.NEGATIVE_INFINITY;
}

/**
 * MultiPV adaptatif selon la complexité de la position.
 * Position fermée (peu de coups légaux) → moins de lignes nécessaires.
 * Position ouverte → MultiPV de base pour capturer les nuances.
 */
function adaptiveMultiPv(fen: string, base: number): number {
  try {
    const board = new Chess(fen);
    const legalMoves = board.moves().length;

    // Position très fermée : 2-3 lignes suffisent
    if (legalMoves <= 20) return Math.max(2, Math.min(base - 2, 3));
    // Position moyennement fermée : 3-4 lignes
    if (legalMoves <= 30) return Math.max(3, base - 1);

    return base;
  } catch {
    return base;
  }
}

/**
 * Profondeur adaptative pour les réponses adverses.
 * Moins profonde que notre propre position car on cherche juste
 * à distinguer les bonnes réponses des pièges, pas à calculer parfaitement.
 */
/**
 * Trap score d'une position adverse après notre coup M.
 *
 * Stockfish évalue depuis la perspective du joueur ayant le trait (l'adversaire ici).
 * Les lignes sont triées par valeur décroissante (meilleure pour l'adversaire d'abord).
 *
 * trap_score = val(r1) − val(r2) en centipawns.
 * goodResponses = coups dans [best, best − window].
 */
/** Score piège d'une position adverse (testable : pur).
 *
 * Les lignes sont évaluées du point de vue adverse (trait adverse) :
 * +Infinity = l'adversaire NOUS mate (notre coup est perdant → à rejeter),
 * −Infinity = l'adversaire EST maté (notre coup gagne → piège parfait).
 */
export function computeTrapScore(
  advLines: EngineMove[],
  window: number,
): {
  trapScore: number;
  goodResponses: EngineMove[];
  uncovered: number;
} | null {
  if (advLines.length === 0) return null;

  const sorted = [...advLines].sort((a, b) => engineVal(b) - engineVal(a));
  const best = engineVal(sorted[0]);

  // L'adversaire nous mate : notre coup candidat est perdant → signal de rejet.
  // L'appelant doit élaguer (jamais émettre ni primer au tri).
  if (best === Number.POSITIVE_INFINITY) {
    return {
      trapScore: Number.NEGATIVE_INFINITY,
      goodResponses: sorted.slice(0, 1),
      uncovered: sorted.length - 1,
    };
  }

  // L'adversaire est maté quoi qu'il joue : piège parfait.
  if (best === Number.NEGATIVE_INFINITY) {
    return { trapScore: 999, goodResponses: [], uncovered: sorted.length };
  }

  const goodResponses = sorted.filter((l) => {
    const v = engineVal(l);
    if (v === Number.POSITIVE_INFINITY) return true;
    if (!Number.isFinite(v) || !Number.isFinite(best)) return false;
    return best - v <= window;
  });

  const uncovered = sorted.length - goodResponses.length;

  let trapScore: number;
  if (sorted.length < 2) {
    trapScore = 999;
  } else {
    const v1 = engineVal(sorted[0]);
    const v2 = engineVal(sorted[1]);
    trapScore =
      Number.isFinite(v1) && Number.isFinite(v2)
        ? v1 - v2
        : Number.isFinite(v1)
          ? 999
          : 0;
  }

  return { trapScore, goodResponses, uncovered };
}

// ─── Cache évaluations moteur ──────────────────────────────────────────────────

async function cachedEval(
  fen: string,
  depth: number,
  multiPv: number,
  timeoutMs: number,
  judge: EngineJudgeFn,
  runCache: Map<string, EngineMove[]>,
  stats: TrapGenStats,
  signal?: AbortSignal,
): Promise<EngineMove[]> {
  const norm = normalizeFen(fen);
  const key = engineEvalCacheKey(norm, depth, multiPv);

  // 1. IDB cross-session
  try {
    const idbHit = await idbGetEngineEval(key);
    if (idbHit) {
      stats.engineCached++;
      runCache.set(key, idbHit.lines);
      return idbHit.lines;
    }
  } catch {
    /* IDB indisponible, continuer */
  }

  // 2. Mémoire run courant
  const memHit = runCache.get(key);
  if (memHit) {
    stats.engineCached++;
    return memHit;
  }

  // 3. Calcul réel
  const lines = await judge(fen, { multiPv, depth, timeoutMs, signal });
  stats.engineNodes++;
  stats.positionsInterrogees++;
  if (lines && lines.length > 0) {
    runCache.set(key, lines);
    try {
      await idbPutEngineEval({ key, lines, savedAt: Date.now() });
    } catch {
      /* IDB indisponible */
    }
  }
  return lines ?? [];
}

/**
 * Lecture cache seul (IDB + mémoire run), sans incrément de stats.
 * Le budget est consommé par l'appelant dans tous les cas (cache inclus).
 */
async function peekCachedEngineLines(
  fen: string,
  depth: number,
  multiPv: number,
  runCache: Map<string, EngineMove[]>,
): Promise<EngineMove[] | null> {
  const key = engineEvalCacheKey(normalizeFen(fen), depth, multiPv);
  const memHit = runCache.get(key);
  if (memHit) return memHit;
  try {
    const idbHit = await idbGetEngineEval(key);
    if (idbHit) {
      runCache.set(key, idbHit.lines);
      return idbHit.lines;
    }
  } catch {
    /* IDB indisponible : cache manqué */
  }
  return null;
}

/** Budget consommé : calculs réels + relectures cache (1 unité par appel). */
function budgetUsed(stats: TrapGenStats): number {
  return stats.positionsInterrogees + stats.engineCached;
}

// ─── Point d'entrée ────────────────────────────────────────────────────────────

export async function generateTrapRepertoire(
  startFen: string = INITIAL_FEN,
  cfgIn: TrapGenConfig = {},
  events: TrapGenEvents = {},
): Promise<{ root: RepertoireRoot; stats: TrapGenStats; completed: boolean }> {
  const cfg: Required<
    Omit<TrapGenConfig, 'ratingsParam' | 'since' | 'judge'>
  > & {
    ratingsParam?: string;
    since?: number;
    judge?: EngineJudgeFn;
  } = { ...DEFAULTS, ...cfgIn };

  cfg.maxDepth = Math.max(1, Math.min(32, Math.round(cfg.maxDepth)));
  cfg.maxPositions = Math.max(1, Math.round(cfg.maxPositions));
  cfg.depth = Math.max(8, Math.min(30, Math.round(cfg.depth)));
  cfg.multiPv = Math.max(2, Math.min(16, Math.round(cfg.multiPv)));
  cfg.trapAdversaryWindow = Math.max(0, cfg.trapAdversaryWindow);
  cfg.minTrapScore = Math.max(0, cfg.minTrapScore);
  cfg.soundnessWindow = Math.max(0, cfg.soundnessWindow);
  cfg.trapExtensionPlies = Math.max(
    0,
    Math.min(8, Math.round(cfg.trapExtensionPlies)),
  );
  cfg.trapExtendMinScore = Math.max(0, cfg.trapExtendMinScore);
  cfg.trapAdversaryDepthDelta = Math.max(
    0,
    Math.min(12, Math.round(cfg.trapAdversaryDepthDelta)),
  );

  if (!cfg.judge)
    throw new Error(
      'TrapGenConfig.judge est requis (injecter analyzeLocalFen).',
    );

  const startedAt = Date.now();
  const rootFen = startFen || INITIAL_FEN;
  const root: RepertoireRoot = { fen: rootFen, children: [] };
  const emitted = new Map<string, RepertoireMove | RepertoireRoot>();
  emitted.set('root', root);

  try {
    await explorerCacheReady();
  } catch {
    /* mémoire seule */
  }

  const stats: TrapGenStats = {
    positionsInterrogees: 0,
    sent: 0,
    engineNodes: 0,
    engineCached: 0,
    engineFallbacks: 0,
    engineReused: 0,
    trapExtended: 0,
    mates: 0,
    trapPruned: 0,
    unsoundPruned: 0,
    adversaryCovered: 0,
    adversaryUncovered: 0,
    failed: 0,
    failedFens: [],
    transpositions: 0,
    explored: 0,
    depthPruned: 0,
    quiescenceExtended: 0,
    closingReplies: 0,
    unanswered: 0,
    elapsedMs: 0,
    cached: 0,
    api: 0,
  };
  let completed = true;

  const repColor = cfg.repertoireColor;
  const isOwnTurnFen = (f: string): boolean => {
    try {
      const turn = new Chess(f).turn();
      return (
        (repColor === 'white' && turn === 'w') ||
        (repColor === 'black' && turn === 'b')
      );
    } catch {
      return false;
    }
  };

  const initialFenKey = normalizeFen(rootFen);
  const heap = new PriorityQueue<HeapItem>(
    cfg.forceBfsOrder ? bfsHigher : heapHigher,
  );
  const latestSeq = new Map<string, number>([[initialFenKey, 0]]);
  const seen = new Set<string>([initialFenKey]);
  const visited = new Set<string>();
  const canonicalNodesByFen = new Map<string, RepertoireMove>();
  const transpositionNodes: { node: RepertoireMove; fenKey: string }[] = [];
  const runCache = new Map<string, EngineMove[]>();
  let seq = 1; // commence à 1, 0 réservé à la racine
  let cachedSinceYield = 0;
  let lastNetworkStartedAtMs: number | undefined;

  heap.push({
    priority: 0,
    depth: 0,
    fen: rootFen,
    fenKey: initialFenKey,
    parentId: 'root',
    pathSans: [],
    pathUcis: [],
    seq: 0,
    reachProb: 1,
    depthBonus: 0,
  });

  const findParentList = (parentId: string): RepertoireMove[] => {
    const holder = emitted.get(parentId);
    if (!holder) return root.children;
    if ('children' in holder && Array.isArray(holder.children))
      return holder.children;
    return root.children;
  };

  /** Émet un nœud dans l'arbre et l'enregistre dans le heap si nécessaire. */
  const emit = (
    stdUci: string,
    san: string,
    childFen: string,
    games: number,
    w: number,
    d: number,
    b: number,
    isMate: boolean,
    trapScore: number | null,
    depth: number,
    closing: boolean,
    pathSans: string[],
    pathUcis: string[],
    parentId: string,
    reachProb: number,
    opts: {
      /** Promesse du filon pour le heap (défaut : trapScore ou 0). */
      promise?: number;
      /** Lignes déjà calculées à réutiliser au pop (0 budget). */
      preLines?: EngineMove[];
      /** MultiPV demandé pour `preLines`. */
      preMultiPv?: number;
      /** Profondeur demandée pour `preLines`. */
      preDepth?: number;
      /** Bonus de profondeur hérité/propagé. */
      depthBonus?: number;
    } = {},
  ): void => {
    const childKey = normalizeFen(childFen);
    const isTranspo = seen.has(childKey);
    seen.add(childKey);

    // Affichage seul : le tri/post-traitement utilise le champ numérique
    // (l'ancien couplage par regex "trap:Xcp" cassait sur Infinity).
    const safeTrap =
      trapScore === null || Number.isNaN(trapScore)
        ? null
        : Number.isFinite(trapScore)
          ? Math.round(trapScore)
          : 999;
    const node: RepertoireMove = {
      coup: san,
      uci: stdUci,
      san,
      parties: games || 50,
      victoires_blancs: w,
      nuls: d,
      victoires_noirs: b,
      fen: childFen,
      children: [],
      ...(isMate ? { isMate: true as const } : {}),
      ...(safeTrap !== null
        ? { eval: `trap:${safeTrap}cp`, trapScore: safeTrap }
        : {}),
    };

    findParentList(parentId).push(node);
    // Clé canonique UCI (les SAN se répètent entre transpositions).
    const nodeId = [...pathUcis, stdUci].join(' ') || 'root-child';
    emitted.set(nodeId, node);
    stats.sent++;
    if (isMate) stats.mates++;
    if (closing && !isMate) stats.closingReplies++;

    if (!isTranspo) {
      canonicalNodesByFen.set(childKey, node);
      const bonus = Math.min(opts.depthBonus ?? 0, cfg.trapExtensionPlies);
      if (!closing && depth + 1 < cfg.maxDepth + bonus + cfg.maxQuiescence) {
        const s = seq++;
        latestSeq.set(childKey, s);
        heap.push({
          priority: opts.promise ?? safeTrap ?? 0,
          depth: depth + 1,
          fen: childFen,
          fenKey: childKey,
          parentId: nodeId,
          pathSans: [...pathSans, san],
          pathUcis: [...pathUcis, stdUci],
          seq: s,
          reachProb: reachProb,
          ...(opts.preLines && opts.preLines.length > 0
            ? {
                preLines: opts.preLines,
                preMultiPv: opts.preMultiPv,
                preDepth: opts.preDepth,
              }
            : {}),
          depthBonus: bonus,
        });
      }
    } else {
      stats.transpositions++;
      transpositionNodes.push({ node, fenKey: childKey });
    }

    events.onNode?.(node, parentId, nodeId);
  };

  // ─── Boucle BFS ─────────────────────────────────────────────────────────────
  try {
    while (heap.length > 0) {
      throwIfAborted(events.signal);
      const item = heap.pop()!;
      if (latestSeq.get(item.fenKey) !== item.seq) continue;

      const { depth, fen, pathSans, pathUcis, parentId, reachProb } = item;
      const isOwnTurn = isOwnTurnFen(fen);

      // Fin de partie
      try {
        if (new Chess(fen).isGameOver()) continue;
      } catch {
        continue;
      }

      // Limite de profondeur + quiescence + extension locale (filon piégeux).
      const limit =
        cfg.maxDepth + Math.min(item.depthBonus, cfg.trapExtensionPlies);
      const maxQ = cfg.maxQuiescence;
      let closing = false;
      if (depth >= limit) {
        let isUnstable = false;
        if (maxQ > 0 && depth < limit + maxQ) {
          try {
            const probe = new Chess(fen);
            const lastSan = pathSans.at(-1) ?? '';
            isUnstable =
              probe.inCheck() || lastSan.includes('x') || lastSan.includes('+');
          } catch {
            /* */
          }
        }
        if (isUnstable) {
          stats.quiescenceExtended++;
        } else if (isOwnTurn) {
          closing = true;
        } else {
          stats.depthPruned++;
          continue;
        }
      } else if (depth >= cfg.maxDepth && item.depthBonus > 0) {
        stats.trapExtended++;
      }

      const fenKey = normalizeFen(fen);
      if (visited.has(fenKey)) continue;
      visited.add(fenKey);
      stats.explored++;

      // ── Fetch Lichess (enrichissement adverse uniquement) ──
      // Sauté quand l'enrichissement est off (défaut) : aucun appel réseau,
      // aucune attente gapMs, aucun "unanswered" réseau. Le mat en 1 reste
      // détecté en local (findMateInOneUcis + repli coups légaux).
      let lichessMoves: LichessMove[] = [];
      let lichessTotal = 0;
      if (cfg.useLichessForOpponent) {
        let data: Awaited<
          ReturnType<typeof fetchLichessMovesWithCacheStatus>
        > | null = null;
        const lookupStart = Date.now();
        for (let attempt = 0; attempt <= cfg.extraFetchRetries; attempt++) {
          try {
            data = await fetchLichessMovesWithCacheStatus(
              fen,
              undefined,
              cfg.endpoint,
              cfg.ratingsParam,
              undefined,
              { signal: events.signal, since: cfg.since },
            );
            break;
          } catch (err) {
            if (isAbortError(err) || events.signal?.aborted) throw err;
            if (attempt < cfg.extraFetchRetries)
              await abortableSleep(cfg.gapMs * 2, events.signal);
          }
        }
        if (!data) {
          stats.failed++;
          if (stats.failedFens.length < 20) stats.failedFens.push(fenKey);
          // Trou à notre tour : compté (seule tolérance acceptée, cf. AGENTS.md).
          if (isOwnTurn) stats.unanswered++;
          events.onProgress?.({ ...stats, elapsedMs: Date.now() - startedAt });
          continue;
        }
        if (data.source !== 'network') {
          stats.cached++;
          cachedSinceYield++;
        } else {
          stats.api++;
          lastNetworkStartedAtMs = data.networkStartedAtMs ?? lookupStart;
          cachedSinceYield = 0;
          if (cfg.gapMs > 0) {
            const wait =
              cfg.gapMs -
              (Date.now() - (lastNetworkStartedAtMs ?? lookupStart));
            if (wait > 0) {
              try {
                await abortableSleep(wait, events.signal);
              } catch (err) {
                if (isAbortError(err)) throw err;
              }
            }
          }
        }
        lichessMoves = data.data.moves ?? [];
        const posTotal =
          (data.data.white ?? 0) +
          (data.data.draws ?? 0) +
          (data.data.black ?? 0);
        lichessTotal =
          posTotal > 0
            ? posTotal
            : lichessMoves.reduce((s, m) => s + gamesOf(m), 0);

        if (cachedSinceYield >= CACHED_UI_YIELD_INTERVAL) {
          await new Promise<void>((r) => setTimeout(r, 0));
          throwIfAborted(events.signal);
          cachedSinceYield = 0;
        }
      }

      // ── Mats en 1 ────────────────────────────────────────────────────────────
      const mateUcis = findMateInOneUcis(fen);
      const isMateMove = (uci: string, san: string): boolean =>
        san.endsWith('#') ||
        (uci !== '' && mateUcis.has(normalizeCastleUci(fen, uci)));

      // ── Évaluation Stockfish de la position ──────────────────────────────────
      // MultiPV adaptatif selon la complexité de la position
      const effectivePv = Math.max(adaptiveMultiPv(fen, cfg.multiPv), 2);

      // ── Mat en 1 à notre tour : sans moteur ni budget ─────────────────────
      // Toujours inclus, jamais élagué — y compris quand l'Explorer est vide
      // (repli local sur les coups légaux, mateUcis déjà calculé ci-dessus).
      if (isOwnTurn) {
        const mateMoves = lichessMoves.filter((m) => isMateMove(m.uci, m.san));
        let mateDone = false;
        if (mateMoves.length > 0) {
          const best = mateMoves[0];
          const childFen = fenAfterUci(fen, best.uci);
          if (childFen) {
            emit(
              normalizeCastleUci(fen, best.uci),
              best.san,
              childFen,
              gamesOf(best),
              best.white,
              best.draws,
              best.black,
              true,
              null,
              depth,
              closing,
              pathSans,
              pathUcis,
              parentId,
              reachProb,
              { promise: TRAP_MATE_PRIORITY, depthBonus: item.depthBonus },
            );
            mateDone = true;
          } else {
            mateDone = true; // mat connu mais inapplicable : rien d'autre à tenter ici.
          }
        } else if (mateUcis.size > 0) {
          try {
            const board = new Chess(fen);
            for (const m of board.moves({ verbose: true })) {
              const uci = `${m.from}${m.to}${m.promotion ?? ''}`;
              if (mateUcis.has(normalizeCastleUci(fen, uci))) {
                const childFen = fenAfterUci(fen, uci);
                if (childFen) {
                  emit(
                    uci,
                    m.san,
                    childFen,
                    0,
                    0,
                    0,
                    0,
                    true,
                    null,
                    depth,
                    closing,
                    pathSans,
                    pathUcis,
                    parentId,
                    reachProb,
                    {
                      promise: TRAP_MATE_PRIORITY,
                      depthBonus: item.depthBonus,
                    },
                  );
                  mateDone = true;
                }
                break;
              }
            }
          } catch {
            /* FEN illisible : retomber sur l'évaluation moteur */
          }
        }
        if (mateDone) {
          events.onProgress?.({ ...stats, elapsedMs: Date.now() - startedAt });
          continue;
        }
      }

      // Profondeur asymétrique : nos coups à pleine profondeur, les réponses
      // adverses à profondeur réduite (le drop-off se lit de loin).
      // Même nombre d'appels (budget neutre), évals adverses 2-4× plus rapides.
      const advDepth = Math.max(8, cfg.depth - cfg.trapAdversaryDepthDelta);
      const wantDepth = isOwnTurn ? cfg.depth : advDepth;

      // Budget : chaque appel moteur consomme 1 unité, cache inclus.
      // Lignes déjà calculées au temps candidat : réutilisation à coût nul
      // (même demande profondeur/MultiPV, sinon relecture normale).
      throwIfAborted(events.signal);
      const canReusePreLines =
        !cfg.disablePreLinesReuse &&
        item.preLines &&
        item.preLines.length > 0 &&
        item.preMultiPv === effectivePv &&
        item.preDepth === wantDepth;
      if (!canReusePreLines && budgetUsed(stats) >= cfg.maxPositions) {
        if (isOwnTurn) stats.unanswered++;
        break;
      }
      const peekedLines = canReusePreLines
        ? null
        : await peekCachedEngineLines(fen, wantDepth, effectivePv, runCache);
      let engineLines: EngineMove[];
      if (canReusePreLines) {
        stats.engineReused++;
        engineLines = item.preLines!;
      } else if (peekedLines) {
        stats.engineCached++;
        engineLines = peekedLines;
      } else {
        engineLines = await cachedEval(
          fen,
          wantDepth,
          effectivePv,
          cfg.timeoutMs,
          cfg.judge,
          runCache,
          stats,
          events.signal,
        );
      }

      if (engineLines.length === 0) {
        stats.engineFallbacks++;
        if (isOwnTurn) stats.unanswered++;
        events.onProgress?.({ ...stats, elapsedMs: Date.now() - startedAt });
        continue;
      }

      // ── NOTRE TOUR ────────────────────────────────────────────────────────────
      if (isOwnTurn) {
        // (Les mats en 1 sont déjà émis plus haut, sans moteur ni budget.)
        // Candidats sains + trap score.
        const ourBest = engineVal(engineLines[0]);
        interface Candidate {
          move: EngineMove;
          trapScore: number;
          childFen: string;
          advUncovered: number;
          /** Lignes adverses complètes : réutilisées au pop (0 budget). */
          advLines: EngineMove[];
        }
        const candidates: Candidate[] = [];

        for (const ourMove of engineLines) {
          const ourVal = engineVal(ourMove);
          if (
            cfg.soundnessWindow > 0 &&
            Number.isFinite(ourBest) &&
            Number.isFinite(ourVal) &&
            ourBest - ourVal > cfg.soundnessWindow
          ) {
            stats.unsoundPruned++;
            continue;
          }

          const stdUci = normalizeCastleUci(fen, ourMove.uci);
          const childFen = fenAfterUci(fen, stdUci);
          if (!childFen) continue;

          throwIfAborted(events.signal);
          // Réponses adverses à profondeur réduite (advDepth) : le drop-off
          // se lit de loin, nos coups gardent la pleine profondeur.
          // Budget par candidat : chaque appel compte, cache inclus.
          if (budgetUsed(stats) >= cfg.maxPositions) break;
          const advPeeked = await peekCachedEngineLines(
            childFen,
            advDepth,
            effectivePv,
            runCache,
          );
          let advLines: EngineMove[];
          if (advPeeked) {
            stats.engineCached++;
            advLines = advPeeked;
          } else {
            advLines = await cachedEval(
              childFen,
              advDepth,
              effectivePv,
              cfg.timeoutMs,
              cfg.judge,
              runCache,
              stats,
              events.signal,
            );
          }
          if (advLines.length === 0) continue;

          const trapResult = computeTrapScore(
            advLines,
            cfg.trapAdversaryWindow,
          );
          if (!trapResult) continue;
          // Notre coup se fait mater : élaguer, jamais primer au tri.
          if (trapResult.trapScore === Number.NEGATIVE_INFINITY) {
            stats.unsoundPruned++;
            continue;
          }

          candidates.push({
            move: ourMove,
            trapScore: trapResult.trapScore,
            childFen,
            advUncovered: trapResult.uncovered,
            advLines,
          });
        }

        if (candidates.length === 0) {
          stats.unanswered++;
          events.onProgress?.({ ...stats, elapsedMs: Date.now() - startedAt });
          continue;
        }

        // Trier par trap score décroissant : le coup le plus piégeux entre
        // en premier dans le heap et sera exploré en priorité à profondeur égale.
        candidates.sort((a, b) => b.trapScore - a.trapScore);

        // Filtre minTrapScore opt-in : retire les coups sous le seuil.
        // On garde au moins 1 coup (le meilleur) même s'il est sous le seuil,
        // sinon la position resterait sans réponse.
        const eligible =
          cfg.minTrapScore > 0
            ? candidates.filter((c) => c.trapScore >= cfg.minTrapScore)
            : candidates;
        const toEmit = eligible.length > 0 ? eligible : [candidates[0]];
        stats.trapPruned += candidates.length - toEmit.length;

        // Émettre TOUS les candidats éligibles pour exploration complète.
        // Le post-traitement réduira à une seule réponse par position à notre tour.
        // Le heap priorise par trap score (best-first) ; les lignes adverses
        // suivent le candidat pour réutilisation au pop (0 budget).
        for (const cand of toEmit) {
          const stdUci = normalizeCastleUci(fen, cand.move.uci);
          const lm = lichessMoves.find(
            (m) => normalizeCastleUci(fen, m.uci) === stdUci,
          );
          emit(
            stdUci,
            cand.move.san,
            cand.childFen,
            lm ? gamesOf(lm) : 0,
            lm?.white ?? 0,
            lm?.draws ?? 0,
            lm?.black ?? 0,
            false,
            cand.trapScore,
            depth,
            closing,
            pathSans,
            pathUcis,
            parentId,
            reachProb,
            {
              promise: cand.trapScore,
              preLines: cand.advLines,
              preMultiPv: effectivePv,
              preDepth: advDepth,
              depthBonus:
                cand.trapScore >= cfg.trapExtendMinScore
                  ? cfg.trapExtensionPlies
                  : 0,
            },
          );
          stats.adversaryUncovered += cand.advUncovered;
        }
        events.onProgress?.({ ...stats, elapsedMs: Date.now() - startedAt });

        // ── LEUR TOUR ─────────────────────────────────────────────────────────────
      } else {
        const advBest = engineVal(engineLines[0]);
        interface AdvResponse {
          uci: string;
          san: string;
          value: number;
          games: number;
        }
        const toCover: AdvResponse[] = [];

        for (const advMove of engineLines) {
          const val = engineVal(advMove);
          if (
            Number.isFinite(advBest) &&
            Number.isFinite(val) &&
            advBest - val > cfg.trapAdversaryWindow
          ) {
            stats.adversaryUncovered++;
            continue;
          }
          if (val === Number.NEGATIVE_INFINITY) {
            stats.adversaryUncovered++;
            continue;
          }

          const stdUci = normalizeCastleUci(fen, advMove.uci);

          let games = 0;
          if (cfg.useLichessForOpponent && lichessTotal > 0) {
            const lm = lichessMoves.find(
              (m) => normalizeCastleUci(fen, m.uci) === stdUci,
            );
            if (!lm) {
              stats.adversaryUncovered++;
              continue;
            }
            games = gamesOf(lm);
          }

          if (!toCover.some((e) => e.uci === stdUci)) {
            toCover.push({ uci: stdUci, san: advMove.san, value: val, games });
          }
        }

        if (toCover.length === 0) {
          // Aucune bonne réponse adverse : piège parfait (ou position gagnée nette).
          events.onProgress?.({ ...stats, elapsedMs: Date.now() - startedAt });
          continue;
        }

        for (const adv of toCover) {
          throwIfAborted(events.signal);
          const childFen = fenAfterUci(fen, adv.uci);
          if (!childFen) continue;
          emit(
            adv.uci,
            adv.san,
            childFen,
            adv.games || 50,
            0,
            0,
            0,
            false,
            null,
            depth,
            false,
            pathSans,
            pathUcis,
            parentId,
            reachProb,
            { promise: item.priority, depthBonus: item.depthBonus },
          );
          stats.adversaryCovered++;
        }
        events.onProgress?.({ ...stats, elapsedMs: Date.now() - startedAt });
      }
    }
  } catch (err) {
    if (isAbortError(err) || events.signal?.aborted) {
      completed = false;
    } else {
      throw err;
    }
  }

  // ── Résolution transpositions ──────────────────────────────────────────────
  for (const { node, fenKey } of transpositionNodes) {
    const canonical = canonicalNodesByFen.get(fenKey);
    if (canonical?.children?.length) {
      node.children = canonical.children.map((c) => ({
        ...c,
        cloned: true,
        children: [],
      }));
    }
  }

  // ── Post-traitement : une seule réponse à notre tour (trap score max) ───────
  reduceTrapTreeToSingleOwnTurn(root, repColor);

  await flushLichessPersist();
  stats.elapsedMs = Date.now() - startedAt;
  return { root, stats, completed };
}

/**
 * Réduit l'arbre à une seule réponse par position à notre tour.
 * Critère : trap score max (champ numérique ; regex "trap:Xcp" en repli
 * pour les arbres persistés avant le champ structuré).
 *
 * @param root racine de l'arbre à réduire (mutée en place)
 * @param repColor couleur du répertoire (définit "notre tour")
 */
export function reduceTrapTreeToSingleOwnTurn(
  root: RepertoireRoot,
  repColor: 'white' | 'black',
): void {
  const reduce = (node: RepertoireRoot | RepertoireMove): void => {
    if (!node.children || node.children.length === 0) return;

    let isOwnTurn = false;
    try {
      const turn = new Chess(node.fen).turn();
      isOwnTurn =
        (repColor === 'white' && turn === 'w') ||
        (repColor === 'black' && turn === 'b');
    } catch {
      isOwnTurn = false;
    }

    if (isOwnTurn && node.children.length > 1) {
      const scored = node.children.map((child) => ({
        child,
        trapScore: readTrapScore(child),
      }));
      scored.sort((a, b) => b.trapScore - a.trapScore);
      node.children = [scored[0].child];
    }

    for (const child of node.children) reduce(child);
  };
  reduce(root);
}

/** Lit le trap score : champ numérique d'abord, annotation "trap:Xcp" en repli. */
export function readTrapScore(child: RepertoireMove): number {
  if (typeof child.trapScore === 'number' && Number.isFinite(child.trapScore))
    return child.trapScore;
  const match = (child.eval || '').match(/trap:(\d+)cp/);
  return match ? parseInt(match[1], 10) : 0;
}
