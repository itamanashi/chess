import { Chess } from 'chess.js';

/**
 * Motifs tactiques d'une position, calculés localement sans moteur.
 * Sert la couche visuelle animée de l'échiquier (attaques, défenses,
 * clouages, fourchettes) pour le camp qui a le trait (ou une couleur
 * explicite, utile aux tests).
 */

export type TacticColor = 'w' | 'b';
export type TacticsMotif = 'attack' | 'defense' | 'pin' | 'fork';

export interface AttackMark {
  /** Case de la pièce attaquée / défendue. */
  square: string;
  /** Cases des pièces qui attaquent / défendent. */
  by: string[];
}

export interface PinInfo {
  /** Case de la pièce clouée. */
  square: string;
  /** Case de la pièce qui cloue. */
  pinnedBy: string;
}

export interface ForkInfo {
  /** Case de la pièce qui fait fourchette. */
  square: string;
  /** Cases des pièces adverses attaquées (valeur ≥ 3 ou roi). */
  targets: string[];
}

export interface TacticsReport {
  /** Pièces adverses attaquées (roi exclu : l'échec est déjà signalé). */
  attacks: AttackMark[];
  /** Propres pièces attaquées ET défendues (tenues). Les défenses sans
   * menace ne sont pas affichées : elles n'apprennent rien. */
  defenses: AttackMark[];
  pins: PinInfo[];
  forks: ForkInfo[];
}

export const EMPTY_TACTICS: TacticsReport = { attacks: [], defenses: [], pins: [], forks: [] };

const FILES = 'abcdefgh';
const VALUES: Record<string, number> = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 100 };

const KNIGHT_STEPS = [
  [1, 2], [2, 1], [2, -1], [1, -2], [-1, -2], [-2, -1], [-2, 1], [-1, 2],
];
const KING_STEPS = [
  [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1],
];
const DIAG = [[1, 1], [1, -1], [-1, 1], [-1, -1]];
const ORTHO = [[1, 0], [-1, 0], [0, 1], [0, -1]];

interface Cell {
  type: string;
  color: TacticColor;
}

type Grid = (Cell | null)[][];

function sqName(file: number, rank: number): string | null {
  if (file < 0 || file > 7 || rank < 0 || rank > 7) return null;
  return `${FILES[file]}${rank + 1}`;
}

/** Grille [rangée 0 = rang 1] depuis chess.js (qui renvoie rang 8 → rang 1). */
function toGrid(chess: Chess): Grid {
  const grid: Grid = Array.from({ length: 8 }, () => Array<Cell | null>(8).fill(null));
  const rows = chess.board();
  for (let i = 0; i < 8; i++) {
    const rank = 7 - i;
    for (let f = 0; f < 8; f++) {
      const sq = rows[i][f];
      if (sq) grid[rank][f] = { type: sq.type, color: sq.color as TacticColor };
    }
  }
  return grid;
}

/** Pseudo-attaques d'une pièce (cases contrôlées, occupées ou non). */
function pseudoAttacks(file: number, rank: number, cell: Cell, grid: Grid): string[] {
  const out: string[] = [];
  const push = (f: number, r: number): void => {
    const s = sqName(f, r);
    if (s) out.push(s);
  };
  const ray = (dirs: number[][]): void => {
    for (const [df, dr] of dirs) {
      let f = file + df;
      let r = rank + dr;
      while (f >= 0 && f < 8 && r >= 0 && r < 8) {
        const s = sqName(f, r);
        if (s) out.push(s);
        if (grid[r][f]) break;
        f += df;
        r += dr;
      }
    }
  };

  switch (cell.type) {
    case 'p': {
      const dr = cell.color === 'w' ? 1 : -1;
      push(file - 1, rank + dr);
      push(file + 1, rank + dr);
      break;
    }
    case 'n':
      for (const [df, dr] of KNIGHT_STEPS) push(file + df, rank + dr);
      break;
    case 'b':
      ray(DIAG);
      break;
    case 'r':
      ray(ORTHO);
      break;
    case 'q':
      ray([...DIAG, ...ORTHO]);
      break;
    case 'k':
      for (const [df, dr] of KING_STEPS) push(file + df, rank + dr);
      break;
    default:
      break;
  }
  return out;
}

/** Cases contrôlées par `by` (occupées ou non). */
function controlledSquares(grid: Grid, by: TacticColor): Set<string> {
  const set = new Set<string>();
  for (let r = 0; r < 8; r++) {
    for (let f = 0; f < 8; f++) {
      const cell = grid[r][f];
      if (cell && cell.color === by) {
        for (const s of pseudoAttacks(f, r, cell, grid)) set.add(s);
      }
    }
  }
  return set;
}

function findKing(grid: Grid, color: TacticColor): { file: number; rank: number } | null {  for (let r = 0; r < 8; r++) {
    for (let f = 0; f < 8; f++) {
      const cell = grid[r][f];
      if (cell && cell.type === 'k' && cell.color === color) return { file: f, rank: r };
    }
  }
  return null;
}

/** Clouages absolus sur le roi de `color` (rayons à la python-chess). */
function detectPins(grid: Grid, color: TacticColor): PinInfo[] {
  const king = findKing(grid, color);
  if (!king) return [];
  const pins: PinInfo[] = [];
  const rays = [...DIAG, ...ORTHO];
  for (const [df, dr] of rays) {
    const diagonal = df !== 0 && dr !== 0;
    let f = king.file + df;
    let r = king.rank + dr;
    let pinned: { file: number; rank: number } | null = null;
    while (f >= 0 && f < 8 && r >= 0 && r < 8) {
      const cell = grid[r][f];
      if (cell) {
        if (!pinned) {
          if (cell.color !== color) break; // première pièce adverse : pas de clouage
          pinned = { file: f, rank: r };
        } else {
          if (cell.color === color) break;
          const slider = diagonal ? cell.type === 'b' || cell.type === 'q' : cell.type === 'r' || cell.type === 'q';
          if (slider && pinned) {
            const a = sqName(pinned.file, pinned.rank);
            const b = sqName(f, r);
            if (a && b) pins.push({ square: a, pinnedBy: b });
          }
          break;
        }
      }
      f += df;
      r += dr;
    }
  }
  return pins;
}

/**
 * Rapport tactique pour `color` (défaut : trait de la position).
 * Les clouages sont cherchés sur les deux rois (un coup peut clouer sur
 * le roi adverse). Position invalide → rapport vide (jamais d'exception).
 */
export function detectTactics(fen: string, color?: TacticColor): TacticsReport {
  let chess: Chess;
  try {
    chess = new Chess(fen);
  } catch {
    return EMPTY_TACTICS;
  }
  const side: TacticColor = color ?? (chess.turn() as TacticColor);
  const foe: TacticColor = side === 'w' ? 'b' : 'w';
  const grid = toGrid(chess);

  const attackSources = new Map<string, string[]>();
  const defenseSources = new Map<string, string[]>();
  // Menaces adverses : une défense n'est montrée que sur une pièce attaquée.
  const foeThreats = controlledSquares(grid, foe);
  const markTarget = (map: Map<string, string[]>, target: string, by: string): void => {
    const list = map.get(target);
    if (list) {
      if (!list.includes(by)) list.push(by);
    } else {
      map.set(target, [by]);
    }
  };
  for (let r = 0; r < 8; r++) {
    for (let f = 0; f < 8; f++) {
      const cell = grid[r][f];
      if (!cell || cell.color !== side) continue;
      const from = sqName(f, r);
      if (!from) continue;
      for (const s of pseudoAttacks(f, r, cell, grid)) {
        const peer = grid[Number(s[1]) - 1]?.[s.charCodeAt(0) - 97];
        if (!peer || peer.type === 'k') continue;
        if (peer.color === foe) markTarget(attackSources, s, from);
        else if (foeThreats.has(s)) markTarget(defenseSources, s, from);
      }
    }
  }
  const attacks: AttackMark[] = [...attackSources.entries()].map(([square, by]) => ({ square, by }));
  const defenses: AttackMark[] = [...defenseSources.entries()].map(([square, by]) => ({ square, by }));
  const pins: PinInfo[] = [...detectPins(grid, 'w'), ...detectPins(grid, 'b')];

  const forks: ForkInfo[] = [];
  for (let r = 0; r < 8; r++) {
    for (let f = 0; f < 8; f++) {
      const cell = grid[r][f];
      if (!cell || cell.color !== side || cell.type === 'k') continue;
      const targets: string[] = [];
      for (const s of pseudoAttacks(f, r, cell, grid)) {
        const peer = grid[Number(s[1]) - 1]?.[s.charCodeAt(0) - 97];
        if (peer && peer.color === foe && (peer.type === 'k' || (VALUES[peer.type] ?? 0) >= 3)) {
          targets.push(s);
        }
      }
      if (targets.length >= 2) {
        const from = sqName(f, r);
        if (from) forks.push({ square: from, targets });
      }
    }
  }

  return { attacks, defenses, pins, forks };
}

/** Position grille (ligne/colonne 0..7) d'une case selon l'orientation. */
export function squareToCell(square: string, orientation: 'white' | 'black'): { row: number; col: number } {
  const file = square.charCodeAt(0) - 97;
  const rank = Number(square.slice(1)) - 1;
  return orientation === 'white' ? { row: 7 - rank, col: file } : { row: rank, col: 7 - file };
}

export interface TacticShape {
  orig: string;
  dest: string;
  brush: 'green' | 'red' | 'yellow' | 'blue';
}

/**
 * Ne garde que les motifs créés par le dernier coup : tout ce qui part de
 * la case d'arrivée (nouvelles attaques/défenses/fourchettes) plus les
 * clouages où la pièce arrivée cloue ou se fait clouer.
 */
export function filterReportForMove(report: TacticsReport, moved: string): TacticsReport {
  return {
    attacks: report.attacks.filter((a) => a.by.includes(moved)),
    defenses: report.defenses.filter((d) => d.by.includes(moved)),
    pins: report.pins.filter((p) => p.square === moved || p.pinnedBy === moved),
    forks: report.forks.filter((f) => f.square === moved),
  };
}

/** Convertit un rapport filtré en flèches Chessground.
 * Rouge = attaques (fourchettes incluses, dédupliquées),
 * bleu = défenses, jaune = clouages. */
export function tacticsToShapes(
  report: TacticsReport,
  moved: string,
  enabled: Record<TacticsMotif, boolean>,
): TacticShape[] {
  const shapes: TacticShape[] = [];
  const seen = new Set<string>();
  const push = (s: TacticShape): void => {
    const key = `${s.orig}${s.dest}${s.brush}`;
    if (!seen.has(key)) {
      seen.add(key);
      shapes.push(s);
    }
  };
  if (enabled.attack) {
    for (const a of report.attacks) push({ orig: moved, dest: a.square, brush: 'red' });
  }
  if (enabled.fork) {
    for (const f of report.forks) {
      for (const t of f.targets) push({ orig: moved, dest: t, brush: 'red' });
    }
  }
  if (enabled.defense) {
    for (const d of report.defenses) push({ orig: moved, dest: d.square, brush: 'blue' });
  }
  if (enabled.pin) {
    for (const p of report.pins) push({ orig: p.pinnedBy, dest: p.square, brush: 'yellow' });
  }
  return shapes;
}
