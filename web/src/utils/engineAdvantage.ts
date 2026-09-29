import { turnOfFen } from './repertoireTree';

/**
 * Eval convention (SINGLE, documented, reused by trap + robustness views):
 *
 *  1. Stockfish `score cp/mate` is relative to the SIDE TO MOVE (UCI).
 *  2. We normalize to "+ = WHITE advantage" (Lichess convention).
 *  3. We then flip to OUR perspective: `ourAdvCp > 0` always means
 *     "good for the repertoire color", whatever it is.
 *
 * Mates are capped (±MATE_LEAF_CP) so a forced mate stays decisive without
 * exploding weighted averages.
 */

export const MATE_LEAF_CP = 5000;

/** Side-to-move-relative eval → White-relative centipawns. */
export function evalToWhiteCp(
  cp: number | undefined,
  mate: number | undefined,
  sideToMove: 'w' | 'b',
): number | null {
  const sign = sideToMove === 'w' ? 1 : -1;
  if (typeof mate === 'number') return sign * (mate > 0 ? MATE_LEAF_CP : -MATE_LEAF_CP);
  if (typeof cp === 'number' && Number.isFinite(cp)) return sign * cp;
  return null;
}

/** White-relative centipawns → our-color-relative advantage. */
export function whiteCpToOurAdvantage(whiteCp: number, ourColor: 'white' | 'black'): number {
  return ourColor === 'white' ? whiteCp : -whiteCp;
}

/**
 * One-step helper: engine eval at `leafFen` → our advantage in cp.
 * Returns `null` when no usable eval (caller decides floor/skip policy).
 */
export function leafAdvantageCp(
  cp: number | undefined,
  mate: number | undefined,
  leafFen: string,
  ourColor: 'white' | 'black',
): number | null {
  let side: 'w' | 'b';
  try {
    side = turnOfFen(leafFen);
  } catch {
    return null;
  }
  const whiteCp = evalToWhiteCp(cp, mate, side);
  if (whiteCp === null) return null;
  return whiteCpToOurAdvantage(whiteCp, ourColor);
}

/** Display "+0.40" / "-0.15" for an our-advantage value. */
export function formatAdvCp(advCp: number): string {
  const v = advCp / 100;
  return v > 0 ? `+${v.toFixed(2)}` : v.toFixed(2);
}

/**
 * Engine eval (side-to-move perspective) → outcome probability 0..1.
 * Logistic curve (400-Elo scale): +100 cp ≈ 64%, mate ≈ decided.
 * Pure and shared (trap expectation baseline, robustness blending).
 */
export function cpToOutcome(cp: number | null, mate?: number): number {
  if (typeof mate === 'number') return mate > 0 ? 0.99 : 0.01;
  if (cp === null) return 0.5;
  return 1 / (1 + Math.pow(10, -cp / 400));
}
