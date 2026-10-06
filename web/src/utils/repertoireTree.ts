import { Chess, type Square } from 'chess.js';
import type { BoardOrientation, LichessMove, MoveHistoryItem, RepertoireMove, RepertoireRoot } from '../types/chess';
import { INITIAL_FEN, normalizeCastleUci, normalizeFen } from './repertoire';

/** Nœud mutable de l'arbre (racine ou coup). */
export type MutableTreeNode = {
  fen?: string;
  children?: RepertoireMove[];
};

/**
 * Clone profond sûr : structuredClone quand dispo, sinon JSON.
 * Remplace les JSON.parse(JSON.stringify(...)) dispersés dans App.tsx.
 */
export function deepClone<T>(value: T): T {
  try {
    if (typeof structuredClone === 'function') return structuredClone(value);
  } catch {
    /* fallback JSON ci-dessous */
  }
  return JSON.parse(JSON.stringify(value)) as T;
}

export function cloneRepertoireRoot(root: RepertoireRoot): RepertoireRoot {
  return deepClone(root);
}

/** Coup factice (saisie manuelle) avec stats neutres. */
export function makePlaceholderMove(san: string, uci: string, fen: string): RepertoireMove {
  return {
    coup: san,
    uci,
    san,
    parties: 100,
    victoires_blancs: 50,
    nuls: 25,
    victoires_noirs: 25,
    fen,
    children: [],
  };
}

/**
 * Construit un RepertoireMove depuis un coup Lichess + FEN parent.
 * Normalise le roque Chess960 (e1h1 -> e1g1) et vérifie la légalité.
 * Retourne null si le coup est illégal.
 */
export function buildMoveFromLichess(
  parentFen: string,
  m: LichessMove,
  freqPct?: number,
): RepertoireMove | null {
  const stdUci = normalizeCastleUci(parentFen, m.uci);
  try {
    const testChess = new Chess(parentFen);
    const res = testChess.move({
      from: stdUci.slice(0, 2) as Square,
      to: stdUci.slice(2, 4) as Square,
      promotion: ((stdUci.length > 4 ? stdUci[4] : 'q') || 'q') as 'q' | 'r' | 'b' | 'n',
    });
    if (!res) return null;
    const total = (m.white || 0) + (m.draws || 0) + (m.black || 0);
    return {
      coup: m.san,
      uci: stdUci,
      san: m.san,
      parties: total > 0 ? total : 100,
      victoires_blancs: total > 0 ? m.white : 50,
      nuls: total > 0 ? m.draws : 25,
      victoires_noirs: total > 0 ? m.black : 25,
      score_moyen: m.averageRating,
      ouverture: m.opening?.name,
      eco: m.opening?.eco,
      ...(freqPct !== undefined ? { frequencyPct: freqPct } : {}),
      fen: testChess.fen(),
      children: [],
    };
  } catch {
    return null;
  }
}

/**
 * Garantit le chemin joué dans l'arbre (crée les positions intermédiaires
 * manquantes). Retourne le curseur = nœud de la position parente.
 * Pur côté appelant : opère sur un root déjà cloné.
 */
export function ensurePath(
  root: RepertoireRoot,
  pathItems: MoveHistoryItem[],
): MutableTreeNode {
  let cursor: MutableTreeNode = root;
  for (let i = 1; i < pathItems.length; i++) {
    const h = pathItems[i];
    if (!h.uci) continue;
    if (!cursor.children) cursor.children = [];
    let next: RepertoireMove | undefined = cursor.children.find((c) => c.uci === h.uci);
    if (!next) {
      next = makePlaceholderMove(h.san, h.uci, h.fen);
      cursor.children.push(next);
    }
    cursor = next;
  }
  return cursor;
}

/** Recherche DFS d'un nœud par FEN normalisé. */
export function findNodeByFen(root: RepertoireRoot, targetNormFen: string): MutableTreeNode | null {
  const stack: MutableTreeNode[] = [root];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (normalizeFen(node.fen || INITIAL_FEN) === targetNormFen) return node;
    const kids = node.children || [];
    for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i]);
  }
  return null;
}

/**
 * Insère `child` sous la position `targetNormFen` (recherche globale).
 * Retourne true si la position parente a été trouvée (coup ajouté ou déjà présent).
 */
export function insertMoveAtFen(
  root: RepertoireRoot,
  targetNormFen: string,
  child: RepertoireMove,
): boolean {
  const node = findNodeByFen(root, targetNormFen);
  if (!node) return false;
  if (!node.children) node.children = [];
  if (!node.children.some((c) => c.uci === child.uci)) {
    node.children.push(child);
  }
  return true;
}

/**
 * Garantit le chemin puis insère : logique unique remplaçant les 3 blocs
 * dupliqués de App.tsx (executeMove / handleAddAndPlayMove / handleBatchAdd).
 */
export function ensurePathAndInsert(
  root: RepertoireRoot,
  historyPath: MoveHistoryItem[],
  prevNormFen: string,
  child: RepertoireMove,
): void {
  const cursor = ensurePath(root, historyPath);
  const cursorNorm = normalizeFen(cursor.fen || root.fen || INITIAL_FEN);
  if (cursorNorm === prevNormFen) {
    if (!cursor.children) cursor.children = [];
    if (!cursor.children.some((c) => c.uci === child.uci)) cursor.children.push(child);
    return;
  }
  // L'historique a divergé (navigation arrière, transposition...) : fallback global.
  if (!insertMoveAtFen(root, prevNormFen, child)) {
    if (!cursor.children) cursor.children = [];
    if (!cursor.children.some((c) => c.uci === child.uci)) cursor.children.push(child);
  }
}

/** Insère en lot (variantes adverses majeures) sous la position courante. */
export function ensurePathAndInsertBatch(
  root: RepertoireRoot,
  historyPath: MoveHistoryItem[],
  prevNormFen: string,
  children: RepertoireMove[],
): void {
  const cursor = ensurePath(root, historyPath);
  const cursorNorm = normalizeFen(cursor.fen || root.fen || INITIAL_FEN);
  const target =
    cursorNorm === prevNormFen ? cursor : (findNodeByFen(root, prevNormFen) ?? cursor);
  if (!target.children) target.children = [];
  for (const child of children) {
    if (!target.children.some((c) => c.uci === child.uci)) target.children.push(child);
  }
}

/**
 * Fusionne un arbre généré automatiquement (BFS) dans un répertoire existant.
 * Port de l'idée `tree.add()` du projet `répertoire` : les coups déjà présents
 * gardent leurs stats enrichies, les nouveaux sont ajoutés, la fusion est
 * récursive par UCI (donc les transpositions rejouées ne dupliquent pas).
 * Retourne le nombre de coups ajoutés.
 */
export function mergeAutoRoot(target: RepertoireRoot, source: RepertoireRoot): number {
  let added = 0;
  const mergeLists = (dst: RepertoireMove[], src: RepertoireMove[]): void => {
    for (const s of src) {
      const existing = dst.find((c) => c.uci === s.uci);
      if (!existing) {
        dst.push(deepClone(s));
        added++;
      } else {
        // Stats les plus riches (max parties) + métadonnées manquantes.
        if ((s.parties || 0) > (existing.parties || 0)) {
          existing.parties = s.parties;
          existing.victoires_blancs = s.victoires_blancs;
          existing.nuls = s.nuls;
          existing.victoires_noirs = s.victoires_noirs;
        }
        if (!existing.ouverture && s.ouverture) existing.ouverture = s.ouverture;
        if (!existing.eco && s.eco) existing.eco = s.eco;
        if (!existing.fen && s.fen) existing.fen = s.fen;
        if (existing.trapScore === undefined && s.trapScore !== undefined) {
          existing.trapScore = s.trapScore;
          if (!existing.eval && s.eval) existing.eval = s.eval;
        }
        // Le mat est une propriété de la position, pas un avis : jamais perdu à la fusion.
        if (!existing.isMate && s.isMate) existing.isMate = true;
        mergeLists(existing.children || (existing.children = []), s.children || []);
      }
    }
  };
  if (!target.children) target.children = [];
  mergeLists(target.children, source.children || []);
  return added;
}

/**
 * Supprime un coup (et sa sous-branche) identifié par son chemin UCI.
 * Retourne true si un enfant a été retiré.
 */
export function deleteMoveByPath(root: RepertoireRoot, uciPath: string[]): boolean {
  if (uciPath.length === 0) return false;
  let cursor: MutableTreeNode | undefined = root;
  for (let i = 0; i < uciPath.length - 1; i++) {
    const wanted = uciPath[i] as string;
    const found: RepertoireMove | undefined = (cursor?.children || []).find(
      (c: RepertoireMove) => c.uci === wanted,
    );
    if (!found) return false;
    cursor = found;
  }
  if (!cursor?.children) return false;
  const target = uciPath[uciPath.length - 1];
  const before = cursor.children.length;
  cursor.children = cursor.children.filter((c) => c.uci !== target);
  return cursor.children.length !== before;
}

/**
 * Reconstruit l'historique rejouable depuis un chemin UCI (ouverture d'une
 * ligne depuis la bibliothèque). S'arrête au premier coup illégal.
 */
export function findUciPathsToPositions(
  root: RepertoireRoot,
  targetFens: readonly string[],
): Map<string, string[]> {
  const targets = new Set(targetFens.map(normalizeFen));
  const paths = new Map<string, string[]>();
  const search = (fen: string, children: RepertoireMove[], path: string[]): void => {
    const normalizedFen = normalizeFen(fen);
    if (targets.delete(normalizedFen)) paths.set(normalizedFen, path);
    if (targets.size === 0) return;
    for (const move of children) {
      search(move.fen, move.children ?? [], [...path, move.uci]);
      if (targets.size === 0) return;
    }
  };
  search(root.fen, root.children, []);
  return paths;
}

export function getTrainerPositionKeys(
  root: RepertoireRoot,
  color: BoardOrientation,
): string[] {
  const playerTurn = color === 'white' ? 'w' : 'b';
  const positions: string[] = [];
  const seen = new Set<string>();
  const visit = (fen: string, children: RepertoireMove[]): void => {
    const key = normalizeFen(fen);
    if (key.split(' ')[1] === playerTurn && children.length > 0 && !seen.has(key)) {
      seen.add(key);
      positions.push(key);
    }
    for (const move of children) visit(move.fen, move.children ?? []);
  };
  visit(root.fen, root.children);
  return positions;
}

export function findUciPathToPosition(
  root: RepertoireRoot,
  targetFen: string,
): string[] | null {
  return findUciPathsToPositions(root, [targetFen]).get(normalizeFen(targetFen)) ?? null;
}

export function buildHistoryFromUciPath(startFen: string, uciPath: string[]): MoveHistoryItem[] {
  const c = new Chess();
  try {
    c.load(startFen);
  } catch {
    c.reset();
  }
  const items: MoveHistoryItem[] = [{ san: '', uci: '', fen: c.fen() }];
  for (const rawUci of uciPath) {
    let stdUci: string;
    try {
      stdUci = normalizeCastleUci(c.fen(), rawUci);
    } catch {
      break;
    }
    try {
      const promo = stdUci.length > 4 ? stdUci[4] : 'q';
      const m = c.move({
        from: stdUci.slice(0, 2) as Square,
        to: stdUci.slice(2, 4) as Square,
        promotion: promo,
      });
      if (!m) break;
      items.push({ san: m.san, uci: stdUci, fen: c.fen() });
    } catch {
      break;
    }
  }
  return items;
}

/**
 * Reconstruit l'historique rejouable depuis une liste de SAN (ex. partie
 * Chess.com) : rejoue depuis la position initiale, UCI standard + FEN par
 * ply. S'arrête au premier SAN illégal (préfixe conservé).
 */
export function buildHistoryFromSans(sans: string[]): MoveHistoryItem[] {
  const c = new Chess();
  try {
    c.reset();
  } catch {
    /* position initiale toujours valide */
  }
  const items: MoveHistoryItem[] = [{ san: '', uci: '', fen: c.fen() }];
  for (const san of sans) {
    let m;
    try {
      m = c.move(san);
    } catch {
      break;
    }
    if (!m) break;
    items.push({ san: m.san, uci: `${m.from}${m.to}${m.promotion || ''}`, fen: c.fen() });
  }
  return items;
}

/** Compte les coups d'un arbre de répertoire (racine exclue). */
export function countNodes(root: RepertoireRoot): number {
  let n = 0;
  const stack = [...(root.children || [])];
  while (stack.length > 0) {
    const cur = stack.pop()!;
    n++;
    if (cur.children) stack.push(...cur.children);
  }
  return n;
}

/** Trait à partir d'un FEN ('w' | 'b'), sans instance Chess mutable. */
export function turnOfFen(fen: string): 'w' | 'b' {
  const parts = fen.trim().split(/\s+/);
  return parts[1] === 'b' ? 'b' : 'w';
}
