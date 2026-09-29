import type { BoardOrientation } from '../types/chess';

/**
 * Flèches coudées (en L) pour les coups de cavalier : Chessground ne trace
 * que du droit, illisible pour un bond en L. Ce module calcule la géométrie
 * d'un calque SVG (viewBox 0 0 8 8) superposé au plateau — utilisé par
 * `Chessboard` pour TOUTES les flèches (moteur, correction, tactiques).
 */

export interface BoardShape {
  orig?: string;
  dest?: string;
  brush?: string;
}

/** Couleurs alignées sur la palette Chessground (`draw` brushes). */
export const BRUSH_COLORS: Record<string, string> = {
  green: '#15781B',
  red: '#882020',
  blue: '#003088',
  yellow: '#e68f00',
};

export const FALLBACK_BRUSH_COLOR = '#4a4a4a';

/** Épaisseur du trait (unités case) et raccourcis aux extrémités. */
export const ARROW_WIDTH = 0.14;
/** Opacité des flèches : 0.6, comme Chessground qui applique
 * `opacity: 0.6` sur tout son calque `.cg-shapes`
 * (chessground.base.css) — les pinceaux eux-mêmes sont à 1.
 * L'opacité du `<path>` s'applique aussi à sa pointe (marqueur). */
export const ARROW_OPACITY = 0.6;
/**
 * Tête de flèche identique à Chessground (`renderMarker` : triangle
 * `M0,0 V4 L3,2 Z`, viewport 4×4, refX 2.05). À refX, la demi-hauteur du
 * triangle (0.63 unité) couvre le bout rond du trait (rayon 0.5) : aucun
 * rond ne dépasse de la pointe. Ne pas rétrécir sans refaire ce calcul.
 */
export const ARROWHEAD = {
  width: 4,
  height: 4,
  refX: 2.05,
  refY: 2,
  d: 'M0,0 V4 L3,2 Z',
} as const;
const HEAD_LEN = 0.34;
const TAIL_GAP = 0.3;

export interface Point {
  x: number;
  y: number;
}

function fileOf(sq: string): number {
  return sq.charCodeAt(0) - 97;
}

function rankOf(sq: string): number {
  return parseInt(sq[1], 10);
}

/** Vrai si orig→dest est un bond de cavalier (indépendant de l'orientation). */
export function isKnightJump(orig: string, dest: string): boolean {
  if (!orig || !dest || orig.length < 2 || dest.length < 2) return false;
  const dx = Math.abs(fileOf(orig) - fileOf(dest));
  const dy = Math.abs(rankOf(orig) - rankOf(dest));
  return (dx === 1 && dy === 2) || (dx === 2 && dy === 1);
}

/** Centre d'une case en unités plateau (0..8, y=0 en haut). */
export function squareCenter(sq: string, orientation: BoardOrientation): Point {
  const f = fileOf(sq);
  const r = rankOf(sq);
  const x = orientation === 'white' ? f : 7 - f;
  const y = orientation === 'white' ? 8 - r : r - 1;
  return { x: x + 0.5, y: y + 0.5 };
}

/**
 * Case du coude : on part par la grande branche (2 cases) puis la petite
 * (1 case). Ex. Cf3-g5 : f3 → f5 → g5.
 */
export function knightElbow(orig: string, dest: string): { file: number; rank: number } {
  const fo = fileOf(orig);
  const ro = rankOf(orig);
  const fd = fileOf(dest);
  const rd = rankOf(dest);
  if (Math.abs(fd - fo) > Math.abs(rd - ro)) return { file: fd, rank: ro };
  return { file: fo, rank: rd };
}

/** Point à `dist` de `from` vers `to` (raccourcis tête/queue). */
function along(from: Point, to: Point, dist: number): Point {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const len = Math.hypot(dx, dy) || 1;
  return { x: from.x + (dx / len) * dist, y: from.y + (dy / len) * dist };
}

/**
 * Chemin SVG `M…L…L…` d'une flèche coudée : départ légèrement après le
 * centre d'origine (sous la pièce), coude à angle droit, pointe raccourcie
 * (la tête du marqueur finit au centre d'arrivée).
 */
export function knightArrowPath(orig: string, dest: string, orientation: BoardOrientation): string {
  const start = squareCenter(orig, orientation);
  const end = squareCenter(dest, orientation);
  const eb = knightElbow(orig, dest);
  const ef = orientation === 'white' ? eb.file : 7 - eb.file;
  const er = orientation === 'white' ? 8 - eb.rank : eb.rank - 1;
  const elbow: Point = { x: ef + 0.5, y: er + 0.5 };
  const p0 = along(start, elbow, TAIL_GAP);
  const p2 = along(elbow, end, Math.max(0, Math.hypot(end.x - elbow.x, end.y - elbow.y) - HEAD_LEN));
  const f = (n: number): number => Math.round(n * 100) / 100;
  return `M ${f(p0.x)} ${f(p0.y)} L ${f(elbow.x)} ${f(elbow.y)} L ${f(p2.x)} ${f(p2.y)}`;
}

/** Couleur d'un pinceau (repli gris si inconnu). */
export function brushColor(brush: string | undefined): string {
  return (brush && BRUSH_COLORS[brush]) || FALLBACK_BRUSH_COLOR;
}

/** Sépare les bonds de cavalier (calque SVG) du reste (Chessground). Générique : le type d'entrée est préservé. */
export function splitBoardShapes<T extends BoardShape>(shapes: T[]): { straight: T[]; knight: T[] } {
  const straight: T[] = [];
  const knight: T[] = [];
  for (const s of shapes) {
    if (s.orig && s.dest && isKnightJump(s.orig, s.dest)) knight.push(s);
    else straight.push(s);
  }
  return { straight, knight };
}
