import { Chess, type Square } from 'chess.js';
import type { EngineMove } from '../types/chess';
import { normalizeCastleUci } from './repertoire';

/**
 * Shared UCI → SAN conversion for engine principal variations.
 *
 * Used by BOTH the local Stockfish service and the Lichess cloud-eval
 * fetcher, which previously each had their own subtly divergent copy
 * (castling handling, promotion case, first-move fallback, PV length cap).
 * Single rule set:
 *  - Chess960-style castles (e1h1) tolerated via normalizeCastleUci;
 *  - promotion piece lowercased (chess.js expects 'q' | 'r' | 'b' | 'n');
 *  - `null` when the FIRST ply is illegal (caller skips the PV);
 *  - later illegal plies truncate the line (prefix kept);
 *  - SAN capped at `maxPlies` (display), UCIs at `maxUciPlies` (walking —
 *    horizon analyses need the full line, not a display stub).
 */

export interface PvScoreInput {
  cp?: number;
  mate?: number;
}

type Promotion = 'q' | 'r' | 'b' | 'n';

/**
 * Canonical UCI for map keys and stored moves: Chess960 castles converted
 * (e1h1 → e1g1 when a king stands on e1) + lowercase promotion. Both the
 * trajectory recorder and `playPvSanLines` MUST use this exact function —
 * any divergence orphans trajectories silently (audit B3: the write key was
 * raw while the read key was normalized).
 */
export function normalizePvUci(fen: string, rawUci: string): string {
  if (typeof rawUci !== 'string' || rawUci.length < 4) return rawUci;
  const stdUci = normalizeCastleUci(fen, rawUci);
  if (stdUci.length <= 4) return stdUci;
  const promo = stdUci[4]?.toLowerCase();
  const clean = promo === 'q' || promo === 'r' || promo === 'b' || promo === 'n' ? promo : stdUci[4];
  return stdUci.slice(0, 4) + clean;
}

/** Locale-neutral score text ("+0.35", "#+3", "0.00") — identical everywhere. */
export function formatEngineScore(cp?: number, mate?: number): string {
  if (typeof mate === 'number') return mate > 0 ? `#+${mate}` : `#-${Math.abs(mate)}`;
  if (typeof cp === 'number') {
    const val = cp / 100;
    return val > 0 ? `+${val.toFixed(2)}` : val.toFixed(2);
  }
  return '0.00';
}

/** Default UCI horizon: comfortably beyond the deepest trap walk. */
export const MAX_PV_UCI_PLIES = 32;

export interface ParsedPv {
  /** Normalized UCI of the first ply (roques converted). */
  firstUci: string;
  san: string;
  /** SAN line, truncated at the first illegal ply (max `maxPlies`). */
  sans: string[];
  /** Normalized UCIs actually played (max `maxUciPlies`, for walking). */
  ucis: string[];
}

/**
 * Converts UCI plies to SAN by replaying them on `fen`.
 * Throws on invalid FEN (caller validates first); returns `null` when the
 * first ply is illegal.
 */
export function playPvSanLines(
  fen: string,
  ucis: string[],
  maxPlies = 6,
  maxUciPlies = MAX_PV_UCI_PLIES,
): ParsedPv | null {
  const board = new Chess(fen);
  const sanCount = Math.min(ucis.length, Math.max(0, maxPlies));
  const uciCount = Math.min(ucis.length, Math.max(0, maxUciPlies));
  const count = Math.max(sanCount, uciCount);
  let firstUci = '';
  let firstSan: string | null = null;
  const sans: string[] = [];
  const playedUcis: string[] = [];
  for (let i = 0; i < count; i++) {
    const raw = ucis[i];
    if (typeof raw !== 'string' || raw.length < 4) break;
    const stdUci = normalizePvUci(board.fen(), raw);
    const promoChar = stdUci.length > 4 ? stdUci[4] : undefined;
    const promotion = (
      promoChar === 'q' || promoChar === 'r' || promoChar === 'b' || promoChar === 'n'
        ? promoChar
        : undefined
    ) as Promotion | undefined;
    let m;
    try {
      m = board.move({
        from: stdUci.slice(0, 2) as Square,
        to: stdUci.slice(2, 4) as Square,
        promotion,
      });
    } catch {
      break;
    }
    if (!m) break;
    if (i === 0) {
      firstUci = stdUci;
      firstSan = m.san;
    }
    if (sans.length < sanCount) sans.push(m.san);
    playedUcis.push(stdUci);
  }
  if (firstSan === null) return null;
  return { firstUci, san: firstSan, sans, ucis: playedUcis };
}

/** Full PV → EngineMove conversion (`null` when unusable). */
export function pvToEngineMove(
  fen: string,
  ucis: string[],
  score: PvScoreInput,
  depth: number,
  maxPlies = 6,
  maxUciPlies = MAX_PV_UCI_PLIES,
): EngineMove | null {
  const parsed = playPvSanLines(fen, ucis, maxPlies, maxUciPlies);
  if (!parsed) return null;
  return {
    uci: parsed.firstUci,
    san: parsed.san,
    cp: score.cp,
    mate: score.mate,
    depth,
    scoreFormatted: formatEngineScore(score.cp, score.mate),
    pvSans: parsed.sans,
    pvUci: parsed.ucis,
  };
}
