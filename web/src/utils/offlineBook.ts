import { Chess } from 'chess.js';
import type { LichessApiResponse, LichessMove } from '../types/chess';
import { INITIAL_FEN, normalizeFen } from './repertoire';

/**
 * Livre hors-ligne de secours (port du `book.ts` distant).
 *
 * AFFICHAGE SEUL — RÈGLE EXPLICITE :
 * ces chiffres sont INDICATIFS (volumes figés, pas des relevés Masters) et
 * ne doivent JAMAIS alimenter `services/autoRepertoire.ts` (génération
 * fréquentiste pure sur l'Explorer à l'Elo cible). Seul usage autorisé :
 * repli d'affichage dans `LichessLivePanel` quand l'API est injoignable
 * (429, offline, train…) avec le bandeau `OFFLINE_BOOK_NOTICE`.
 */
export const OFFLINE_BOOK_NOTICE = 'Livre hors-ligne (indicatif — pas Masters)';

interface BookLine {
  sans: string[];
  eco: string;
  name: string;
  white: number;
  draws: number;
  black: number;
}

const LINES: BookLine[] = [
  { sans: ['e4'], eco: 'B00', name: 'King\u2019s Pawn', white: 420000, draws: 210000, black: 250000 },
  { sans: ['e4', 'e5'], eco: 'C20', name: 'Open Game', white: 180000, draws: 110000, black: 105000 },
  { sans: ['e4', 'e5', 'Nf3'], eco: 'C40', name: 'King\u2019s Knight Opening', white: 160000, draws: 100000, black: 90000 },
  { sans: ['e4', 'e5', 'Nf3', 'Nc6'], eco: 'C44', name: 'King\u2019s Knight', white: 140000, draws: 90000, black: 80000 },
  { sans: ['e4', 'e5', 'Nf3', 'Nc6', 'Bc4'], eco: 'C50', name: 'Italian Game', white: 55000, draws: 32000, black: 28000 },
  { sans: ['e4', 'e5', 'Nf3', 'Nc6', 'Bc4', 'Bc5'], eco: 'C50', name: 'Giuoco Piano', white: 32000, draws: 20000, black: 15000 },
  { sans: ['e4', 'e5', 'Nf3', 'Nc6', 'Bc4', 'Nf6'], eco: 'C55', name: 'Two Knights Defence', white: 18000, draws: 9000, black: 11000 },
  { sans: ['e4', 'e5', 'Nf3', 'Nc6', 'Bb5'], eco: 'C60', name: 'Ruy Lopez', white: 70000, draws: 45000, black: 38000 },
  { sans: ['e4', 'e5', 'Nf3', 'Nc6', 'Bb5', 'a6'], eco: 'C70', name: 'Ruy Lopez: Morphy Defence', white: 48000, draws: 30000, black: 25000 },
  { sans: ['e4', 'e5', 'Nf3', 'Nc6', 'Bb5', 'Nf6'], eco: 'C65', name: 'Ruy Lopez: Berlin', white: 16000, draws: 14000, black: 9000 },
  { sans: ['e4', 'c5'], eco: 'B20', name: 'Sicilian Defence', white: 150000, draws: 70000, black: 95000 },
  { sans: ['e4', 'c5', 'Nf3'], eco: 'B27', name: 'Sicilian Defence', white: 130000, draws: 60000, black: 82000 },
  { sans: ['e4', 'c5', 'Nf3', 'd6'], eco: 'B50', name: 'Sicilian: Open', white: 70000, draws: 32000, black: 45000 },
  { sans: ['e4', 'c5', 'Nf3', 'Nc6'], eco: 'B30', name: 'Sicilian: Old', white: 35000, draws: 16000, black: 22000 },
  { sans: ['e4', 'c5', 'Nf3', 'e6'], eco: 'B40', name: 'Sicilian: French Variation', white: 22000, draws: 11000, black: 14000 },
  { sans: ['e4', 'e6'], eco: 'C00', name: 'French Defence', white: 42000, draws: 25000, black: 28000 },
  { sans: ['e4', 'e6', 'd4', 'd5'], eco: 'C00', name: 'French Defence', white: 38000, draws: 23000, black: 25000 },
  { sans: ['e4', 'c6'], eco: 'B10', name: 'Caro-Kann Defence', white: 36000, draws: 24000, black: 22000 },
  { sans: ['e4', 'c6', 'd4', 'd5'], eco: 'B12', name: 'Caro-Kann Defence', white: 32000, draws: 22000, black: 19000 },
  { sans: ['e4', 'd5'], eco: 'B01', name: 'Scandinavian Defence', white: 14000, draws: 7000, black: 9000 },
  { sans: ['e4', 'd6'], eco: 'B07', name: 'Pirc Defence', white: 9000, draws: 5000, black: 6000 },
  { sans: ['e4', 'Nf6'], eco: 'B02', name: 'Alekhine Defence', white: 6000, draws: 3000, black: 4000 },
  { sans: ['e4', 'g6'], eco: 'B06', name: 'Modern Defence', white: 7000, draws: 4000, black: 5000 },
  { sans: ['d4'], eco: 'D00', name: 'Queen\u2019s Pawn', white: 310000, draws: 180000, black: 170000 },
  { sans: ['d4', 'd5'], eco: 'D00', name: 'Queen\u2019s Pawn Game', white: 140000, draws: 90000, black: 70000 },
  { sans: ['d4', 'd5', 'c4'], eco: 'D06', name: 'Queen\u2019s Gambit', white: 90000, draws: 60000, black: 45000 },
  { sans: ['d4', 'd5', 'c4', 'e6'], eco: 'D30', name: 'Queen\u2019s Gambit Declined', white: 50000, draws: 35000, black: 22000 },
  { sans: ['d4', 'd5', 'c4', 'c6'], eco: 'D10', name: 'Slav Defence', white: 25000, draws: 18000, black: 12000 },
  { sans: ['d4', 'd5', 'c4', 'dxc4'], eco: 'D20', name: 'Queen\u2019s Gambit Accepted', white: 12000, draws: 8000, black: 7000 },
  { sans: ['d4', 'd5', 'Nf3'], eco: 'D02', name: 'Queen\u2019s Pawn: London / Colle', white: 28000, draws: 18000, black: 14000 },
  { sans: ['d4', 'd5', 'Nf3', 'Nf6', 'Bf4'], eco: 'D02', name: 'London System', white: 16000, draws: 11000, black: 8000 },
  { sans: ['d4', 'Nf6'], eco: 'A45', name: 'Indian Defence', white: 130000, draws: 70000, black: 75000 },
  { sans: ['d4', 'Nf6', 'c4'], eco: 'A50', name: 'Indian Defence', white: 90000, draws: 50000, black: 52000 },
  { sans: ['d4', 'Nf6', 'c4', 'g6'], eco: 'E60', name: 'King\u2019s Indian / Gr\u00fcfeld', white: 40000, draws: 20000, black: 26000 },
  { sans: ['d4', 'Nf6', 'c4', 'e6'], eco: 'E00', name: 'Indian: Nimzo / Queen\u2019s', white: 35000, draws: 22000, black: 18000 },
  { sans: ['d4', 'Nf6', 'Nf3'], eco: 'A46', name: 'Indian: Knights', white: 25000, draws: 16000, black: 14000 },
  { sans: ['d4', 'Nf6', 'Bf4'], eco: 'A45', name: 'London System', white: 14000, draws: 9000, black: 8000 },
  { sans: ['Nf3'], eco: 'A04', name: 'R\u00e9ti Opening', white: 70000, draws: 45000, black: 38000 },
  { sans: ['c4'], eco: 'A10', name: 'English Opening', white: 65000, draws: 42000, black: 35000 },
];

const byFen = new Map<string, LichessApiResponse>();
const bySans: { sans: string[]; eco: string; name: string }[] = [];

function ensure(fen: string): LichessApiResponse {
  const key = normalizeFen(fen);
  let entry = byFen.get(key);
  if (!entry) {
    entry = { white: 0, draws: 0, black: 0, moves: [] };
    byFen.set(key, entry);
  }
  return entry;
}

function addMove(fen: string, move: LichessMove): void {
  const entry = ensure(fen);
  entry.white += move.white;
  entry.draws += move.draws;
  entry.black += move.black;
  const existing = entry.moves.find((m) => m.uci === move.uci);
  if (existing) {
    existing.white += move.white;
    existing.draws += move.draws;
    existing.black += move.black;
  } else {
    entry.moves.push({ ...move });
  }
}

for (const line of LINES) {
  bySans.push({ sans: line.sans, eco: line.eco, name: line.name });
  const chess = new Chess();
  for (const san of line.sans) {
    const parent = chess.fen();
    let played;
    try {
      played = chess.move(san);
    } catch {
      break;
    }
    if (!played) break;
    addMove(parent, {
      san: played.san,
      uci: played.from + played.to + (played.promotion ?? ''),
      white: line.white,
      draws: line.draws,
      black: line.black,
      opening: { eco: line.eco, name: line.name },
    });
  }
  try {
    ensure(chess.fen()).opening = { eco: line.eco, name: line.name };
  } catch {
    /* ignore */
  }
}

try {
  ensure(INITIAL_FEN).opening = { eco: 'A00', name: 'Starting position' };
} catch {
  /* ignore */
}

/** Repli d'affichage pour un FEN (copie triée), null si hors livre. */
export function getOfflineExplorer(fen: string): LichessApiResponse | null {
  let entry: LichessApiResponse | undefined;
  try {
    entry = byFen.get(normalizeFen(fen));
  } catch {
    return null;
  }
  if (!entry) return null;
  const moves = [...entry.moves].sort(
    (a, b) => b.white + b.draws + b.black - (a.white + a.draws + a.black),
  );
  return { white: entry.white, draws: entry.draws, black: entry.black, moves, opening: entry.opening };
}

/** Nom d'ouverture par plus long préfixe SAN (repli quand l'API est down). */
export function offlineOpeningFromSans(sans: string[]): { eco: string; name: string } {
  if (sans.length === 0) return { eco: '', name: 'Starting position' };
  let best = { eco: '', name: 'Opening', len: 0 };
  for (const row of bySans) {
    if (row.sans.length > sans.length || row.sans.length === 0) continue;
    if (row.sans.every((s, i) => sans[i] === s) && row.sans.length > best.len) {
      best = { eco: row.eco, name: row.name, len: row.sans.length };
    }
  }
  return { eco: best.eco, name: best.name };
}
