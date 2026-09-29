import { Chess, type Square } from 'chess.js';
import type { RepertoireMove, RepertoireRoot, MoveHistoryItem } from '../types/chess';

export const INITIAL_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

/**
 * L'API Lichess renvoie le roque en UCI style Chess960 (le roi "prend" la tour :
 * e1h1 / e1a1 / e8h8 / e8a8) alors que chess.js attend la notation standard
 * (e1g1 / e1c1 / e8g8 / e8c8). Sans conversion, O-O est rejeté comme illégal.
 */
const CASTLE_UCI_FIX: Record<string, string> = {
  e1h1: 'e1g1',
  e1a1: 'e1c1',
  e8h8: 'e8g8',
  e8a8: 'e8c8',
};

export function normalizeCastleUci(fen: string, uci: string): string {
  if (uci.length !== 4 && uci.length !== 5) return uci;
  const mapped = CASTLE_UCI_FIX[uci.slice(0, 4)];
  if (!mapped) return uci;
  try {
    const c = new Chess(fen);
    const piece = c.get(uci.slice(0, 2) as Square);
    if (piece?.type === 'k') return mapped + uci.slice(4);
  } catch {
    /* FEN invalide : laisse l'UCI tel quel */
  }
  return uci;
}

/**
 * "Déjà au répertoire" universel (audit B5) : compare en UCI standard.
 * La requête arrive normalisée (computeScores, moteur) ou brute (listes
 * Utilisateurs : e1h1 Lichess) — normalisée ici même. Côté stocké, fast
 * path exact d'abord (aucune instance Chess quand l'arbre est propre),
 * puis repli normalisé pour les coups bruts historiques. Un seul idiome
 * pour tous les boutons Adopter / vérifications d'insertion.
 */
export function isUciAdopted(children: RepertoireMove[], fen: string, uci: string): boolean {
  const std = normalizeCastleUci(fen, uci);
  for (const r of children) {
    if (r.uci === std) return true;
  }
  for (const r of children) {
    if (normalizeCastleUci(fen, r.uci) === std) return true;
  }
  return false;
}

/**
 * Taille d'une branche = nombre de positions du sous-arbre (le coup lui-même
 * + tous ses descendants). Sert à mesurer la couverture d'une variante dans
 * le répertoire pour équilibrer sa croissance face à sa fréquence réelle.
 */
export function countBranchPositions(m: RepertoireMove): number {
  let n = 1;
  const stack: RepertoireMove[] = [...(m.children || [])];
  while (stack.length > 0) {
    const cur = stack.pop()!;
    n += 1;
    if (cur.children && cur.children.length > 0) stack.push(...cur.children);
  }
  return n;
}

/**
 * Normalise un FEN pour gérer les transpositions et unifier les règles En Passant.
 * python-chess omet la case EP si aucune capture n'est légalement possible,
 * alors que chess.js l'inclut parfois. On harmonise sur les 4 premiers champs
 * avec suppression du cas EP lorsqu'aucune capture en passant n'est légale
 * (comportement python-chess, qui est le moteur arrière du projet).
 *
 * Résultat : `pieces turn castling ep` où `ep` est toujours "-" si aucun pion
 * adverse n'est en position de capturer sur cette case.
 */
export function normalizeFen(fen: string): string {
  const parts = fen.trim().split(/\s+/);
  if (parts.length < 4) return fen;

  const [pieces, turn, castling, ep] = parts;
  let cleanEp = ep;

  // Si une case en passant est déclarée, vérifions si un pion adverse est effectivement
  // en mesure de capturer. Si non, on met "-" (comportement python-chess).
  if (ep && ep !== '-') {
    const file = ep.charCodeAt(0) - 97; // 0..7 (a..h)
    const rank = parseInt(ep[1], 10);   // 1..8
    const isWhiteTurn = turn === 'w';
    // Les pions preneurs doivent être sur la rangée 5 pour les Blancs (si prise en rangée 6) ou rangée 4 pour les Noirs
    const capturerRank = isWhiteTurn ? rank - 1 : rank + 1;
    const boardRow = 8 - capturerRank;
    const capturerPawn = isWhiteTurn ? 'P' : 'p';

    const rows = pieces.split('/');
    let canCapture = false;

    if (boardRow >= 0 && boardRow < 8 && rows[boardRow]) {
      const squares: string[] = [];
      for (const char of rows[boardRow]) {
        if (/\d/.test(char)) {
          const emptyCount = parseInt(char, 10);
          for (let k = 0; k < emptyCount; k++) squares.push('');
        } else {
          squares.push(char);
        }
      }

      // Vérifie les colonnes adjacentes (file - 1 et file + 1)
      if (file - 1 >= 0 && squares[file - 1] === capturerPawn) canCapture = true;
      if (file + 1 < 8 && squares[file + 1] === capturerPawn) canCapture = true;
    }

    if (!canCapture) {
      cleanEp = '-';
    }
  }

  return `${pieces} ${turn} ${castling} ${cleanEp}`;
}

export interface RepertoireIndex {
  fenToChildren: Map<string, RepertoireMove[]>;
  totalPositions: number;
  maxDepth: number;
  totalLines: number;
}

/**
 * Indexe récursivement l'arbre de répertoire pour une recherche instantanée par FEN normalisé
 */
export function indexRepertoire(root: RepertoireRoot | null): RepertoireIndex {
  const fenToChildren = new Map<string, RepertoireMove[]>();
  let totalPositions = 0;
  let maxDepth = 0;
  let totalLines = 0;

  if (!root) {
    return { fenToChildren, totalPositions, maxDepth, totalLines };
  }

  function traverse(fen: string, children: RepertoireMove[] | undefined, depth: number) {
    totalPositions++;
    maxDepth = Math.max(maxDepth, depth);

    if (!children || children.length === 0) {
      totalLines++;
      return;
    }

    const norm = normalizeFen(fen);
    const existing = fenToChildren.get(norm) || [];
    
    // Fusionner les coups enfants sans doublons (pour gérer les transpositions)
    const merged = [...existing];
    for (const child of children) {
      if (!merged.some(m => m.uci === child.uci)) {
        merged.push(child);
      }
    }
    fenToChildren.set(norm, merged);

    for (const child of children) {
      traverse(child.fen, child.children, depth + 1);
    }
  }

  traverse(root.fen || INITIAL_FEN, root.children, 0);

  return { fenToChildren, totalPositions, maxDepth, totalLines };
}

/**
 * Génère un PGN valide à partir de l'historique des coups
 */
export function generatePgn(moves: MoveHistoryItem[]): string {
  if (moves.length === 0) return '';
  const chess = new Chess();
  let pgn = '';

  for (let i = 0; i < moves.length; i++) {
    const moveNumber = Math.floor(i / 2) + 1;
    const isWhite = i % 2 === 0;

    if (isWhite) {
      pgn += `${moveNumber}. `;
    }
    pgn += `${moves[i].san} `;

    try {
      chess.move(moves[i].san);
    } catch {
      // Ignorer si déjà validé
    }
  }

  return pgn.trim();
}

export interface TreePgnOptions {
  event?: string;
  site?: string;
  white?: string;
  black?: string;
}

/**
 * Exporte un arbre de répertoire (BFS auto ou manuel) en PGN avec variantes,
 * importable dans Lichess (Étude > Importer PGN). Première branche = ligne
 * principale, autres = `(variantes)`. Chaque coup porte son commentaire
 * `{ouverture — N parties}` (statistiques Explorer, pas un avis moteur).
 * Coups sans SAN ignorés (comme l'exporteur Python historique).
 */
export function generateTreePgn(root: RepertoireRoot, opts: TreePgnOptions = {}): string {
  const children = (root.children || []).filter((c) => c.san && c.uci);
  if (children.length === 0) return '';

  let turn: 'w' | 'b' = 'w';
  let moveNo = 1;
  let rootFen = INITIAL_FEN;
  try {
    const probe = new Chess(root.fen || INITIAL_FEN);
    turn = probe.turn();
    rootFen = probe.fen();
    const parts = rootFen.split(/\s+/);
    const parsed = parseInt(parts[5] || '1', 10);
    if (Number.isFinite(parsed) && parsed >= 1) moveNo = parsed;
  } catch {
    /* FEN illisible : défaut position initiale */
  }

  const comment = (m: RepertoireMove): string => {
    const bits: string[] = [];
    if (m.ouverture) bits.push(m.ouverture.replace(/[{}]/g, ''));
    bits.push(`${(m.parties || 0).toLocaleString('fr-FR')} parties`);
    return ` {${bits.join(' — ')}}`;
  };

  const moveText = (san: string, side: 'w' | 'b', no: number, needNumber: boolean): string => {
    if (side === 'w') return `${no}. ${san}`;
    return needNumber ? `${no}... ${san}` : san;
  };

  const render = (nodes: RepertoireMove[], side: 'w' | 'b', no: number, needNumber: boolean): string => {
    let out = '';
    nodes.forEach((node, i) => {
      if (!node.san) return;
      const nextNo = side === 'w' ? no : no + 1;
      const nextSide: 'w' | 'b' = side === 'w' ? 'b' : 'w';
      if (i === 0) {
        out += `${moveText(node.san, side, no, needNumber)}${comment(node)} `;
        out += render(node.children || [], nextSide, nextNo, false);
      } else {
        const inner = `${moveText(node.san, side, no, true)}${comment(node)} ${render(node.children || [], nextSide, nextNo, false)}`.trim();
        out += `(${inner}) `;
      }
    });
    return out;
  };

  const headers = [
    `[Event "${opts.event || 'Répertoire auto (BFS)'}"]`,
    `[Site "${opts.site || 'Lichess Explorer'}"]`,
    '[Date "????.??.??"]',
    '[Round "-"]',
    `[White "${opts.white || 'Blancs'}"]`,
    `[Black "${opts.black || 'Noirs'}"]`,
    '[Result "*"]',
    `[FEN "${rootFen}"]`,
    '[SetUp "1"]',
    '',
  ];
  return `${headers.join('\n')}${render(children, turn, moveNo, true).trim()} *`;
}

/** FEN après un coup UCI (notation Lichess e1h1 acceptée pour le roque). Null si illégal. */
export function fenAfterUci(fen: string, uci: string): string | null {
  try {
    const stdUci = normalizeCastleUci(fen, uci);
    const c = new Chess(fen);
    const m = c.move({
      from: stdUci.slice(0, 2) as Square,
      to: stdUci.slice(2, 4) as Square,
      promotion: stdUci.length > 4 ? stdUci[4] : undefined,
    });
    return m ? c.fen() : null;
  } catch {
    return null;
  }
}

/**
 * Télécharge un fichier texte (JSON ou PGN) dans le navigateur
 */
export function downloadFile(filename: string, content: string, contentType: string = 'text/plain') {
  const blob = new Blob([content], { type: `${contentType};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

export interface MaterialCount {
  p: number;
  n: number;
  b: number;
  r: number;
  q: number;
  total: number;
}

export interface MaterialBalance {
  white: MaterialCount;
  black: MaterialCount;
  /** > 0 : les Blancs ont plus de matériel (P=1, N=B=3, R=5, D=9). */
  diffWhite: number;
}

const PIECE_VALUES = { p: 1, n: 3, b: 3, r: 5, q: 9 } as const;

/** Différence de matériel d'une position (rois exclus). Null si FEN invalide. */
export function materialBalance(fen: string): MaterialBalance | null {
  try {
    const c = new Chess(fen);
    const zero = (): MaterialCount => ({ p: 0, n: 0, b: 0, r: 0, q: 0, total: 0 });
    const white = zero();
    const black = zero();
    for (const row of c.board()) {
      for (const sq of row) {
        if (!sq || sq.type === 'k') continue;
        const target = sq.color === 'w' ? white : black;
        target[sq.type]++;
        target.total += PIECE_VALUES[sq.type];
      }
    }
    return { white, black, diffWhite: white.total - black.total };
  } catch {
    return null;
  }
}

const WHITE_SYMBOLS: Record<keyof Omit<MaterialCount, 'total'>, string> = {
  p: '♙',
  n: '♘',
  b: '♗',
  r: '♖',
  q: '♕',
};

const BLACK_SYMBOLS: Record<keyof Omit<MaterialCount, 'total'>, string> = {
  p: '♟',
  n: '♞',
  b: '♝',
  r: '♜',
  q: '♛',
};

/** Ligne compacte : "♙8 ♘2 ♗2 ♖2 ♕1" (cases vides omises). */
export function materialLine(count: MaterialCount, white: boolean): string {
  const syms = white ? WHITE_SYMBOLS : BLACK_SYMBOLS;
  const parts: string[] = [];
  for (const t of ['p', 'n', 'b', 'r', 'q'] as const) {
    if (count[t] > 0) parts.push(`${syms[t]}${count[t]}`);
  }
  return parts.join(' ');
}

/**
 * Position weakness CODE — never a display string. UI wording comes from
 * `weaknessLabel()` in `i18n/fr.ts`, so component logic must branch on
 * `code` (e.g. `code === 'check-suffered'`), never on labels.
 */
export type WeaknessCode =
  | 'none'
  | 'checkmate-suffered'
  | 'stalemate'
  | 'draw'
  | 'check-suffered'
  | 'material-deficit';

export interface Weakness {
  /** 0 = nothing to report, 1 = mated (critical hole). */
  score: number;
  code: WeaknessCode;
  /** Material deficit in pawn units (only when code is 'material-deficit'). */
  materialDeficit?: number;
}

/**
 * How BAD a position is for us (hole detection).
 * Mated = 1, checked = 0.5, material deficit = up to 1 (5 pts+),
 * stalemate/draw = 0.2. Mating = 0 (excellent, not a weakness).
 */
export function weaknessOfPosition(fen: string, playerColor: 'white' | 'black'): Weakness {
  try {
    const c = new Chess(fen);
    const us = playerColor === 'white' ? 'w' : 'b';
    if (c.isCheckmate()) {
      if (c.turn() === us) return { score: 1, code: 'checkmate-suffered' };
      return { score: 0, code: 'none' };
    }
    if (c.isStalemate()) return { score: 0.2, code: 'stalemate' };
    if (c.isDraw() || c.isThreefoldRepetition()) return { score: 0.2, code: 'draw' };
    let score = 0;
    let code: WeaknessCode = 'none';
    let materialDeficit: number | undefined;
    if (c.turn() === us && c.inCheck()) {
      score = 0.5;
      code = 'check-suffered';
    }
    const bal = materialBalance(fen);
    if (bal) {
      const ours = playerColor === 'white' ? bal.diffWhite : -bal.diffWhite;
      if (ours < 0) {
        const mScore = Math.min(1, -ours / 5);
        if (mScore > score) {
          score = mScore;
          code = 'material-deficit';
          materialDeficit = ours;
        }
      }
    }
    return { score, code, materialDeficit };
  } catch {
    return { score: 0, code: 'none' };
  }
}
