import { phaseOfPly, type PhaseName } from './accuracy';

/**
 * Roque détecté depuis les SAN (aucun moteur requis : fonctionne sur tout
 * l'historique, même non analysé).
 */

export type CastleSide = 'kingside' | 'queenside';
/** Statut de roque d'un camp dans une partie. */
export type CastleStatus = CastleSide | 'none';

export interface GameCastling {
  mine: CastleSide | null;
  /** Pli (1-based) de mon roque, null si absent. */
  minePly: number | null;
  opponent: CastleSide | null;
}

/** Phase du rapport (ouverture ≤ 20 plis, milieu ≤ 60, sinon finale). */
export type CastlePhase = PhaseName | 'none';

export const CASTLE_SIDE_LABEL: Record<CastleSide, string> = {
  kingside: 'Petit roque (aile roi)',
  queenside: 'Grand roque (aile dame)',
};

export const CASTLE_STATUS_LABEL: Record<CastleStatus, string> = {
  kingside: 'Petit roque',
  queenside: 'Grand roque',
  none: 'Pas de roque',
};

/** Reconnaît O-O / O-O-O avec suffixes d'échec ou mat éventuels. */
export function parseCastleSan(san: string): CastleSide | null {
  const s = san.replace(/[+#]+$/, '');
  if (s === 'O-O-O') return 'queenside';
  if (s === 'O-O') return 'kingside';
  return null;
}

/**
 * Roque des deux camps : `sans[i]` = pli i+1, les Blancs jouent aux
 * indices pairs. Premier roque retenu par camp (un seul possible en pratique).
 */
export function detectGameCastling(sans: string[], myColor: 'w' | 'b'): GameCastling {
  let mine: CastleSide | null = null;
  let minePly: number | null = null;
  let opponent: CastleSide | null = null;
  const myParity = myColor === 'w' ? 0 : 1;
  for (let i = 0; i < sans.length; i++) {
    const side = parseCastleSan(sans[i]);
    if (!side) continue;
    if (i % 2 === myParity) {
      if (!mine) {
        mine = side;
        minePly = i + 1;
      }
    } else if (!opponent) {
      opponent = side;
    }
    if (mine && opponent) break;
  }
  return { mine, minePly, opponent };
}

/** Phase de mon roque ('none' si absent). */
export function castlePhaseOf(minePly: number | null): CastlePhase {
  return minePly == null ? 'none' : phaseOfPly(minePly);
}

export interface Wld {
  wins: number;
  draws: number;
  losses: number;
}

export function emptyWld(): Wld {
  return { wins: 0, draws: 0, losses: 0 };
}

export type CastleOutcome = 'win' | 'draw' | 'loss';

export function addOutcome(w: Wld, outcome: CastleOutcome): void {
  if (outcome === 'win') w.wins++;
  else if (outcome === 'draw') w.draws++;
  else w.losses++;
}

export interface CastleGameInput {
  sans: string[];
  myColor: 'w' | 'b';
  outcome: CastleOutcome;
}

export interface CastlingStats {
  /** Parties à coups lisibles (les PGN illisibles sont dans `unknown`). */
  total: number;
  /** Parties au PGN illisible (sans coups : roque inconnu). */
  unknown: number;
  /** Bilan par phase de MON roque. */
  byPhase: Record<CastlePhase, Wld>;
  /** Matrice [mon roque][roque adverse] (clé 'none' = absent). */
  matrix: Record<CastleStatus, Record<CastleStatus, Wld>>;
}

const PHASE_KEYS: CastlePhase[] = ['opening', 'middlegame', 'endgame', 'none'];
const STATUS_KEYS: CastleStatus[] = ['kingside', 'queenside', 'none'];

export function emptyCastlingStats(): CastlingStats {
  const byPhase = {} as Record<CastlePhase, Wld>;
  for (const p of PHASE_KEYS) byPhase[p] = emptyWld();
  const matrix = {} as Record<CastleStatus, Record<CastleStatus, Wld>>;
  for (const m of STATUS_KEYS) {
    matrix[m] = {} as Record<CastleStatus, Wld>;
    for (const o of STATUS_KEYS) matrix[m][o] = emptyWld();
  }
  return { total: 0, unknown: 0, byPhase, matrix };
}

/** Agrège les parties (SAN + issue connue) en stats de roque. */
export function computeCastlingStats(items: CastleGameInput[]): CastlingStats {
  const stats = emptyCastlingStats();
  for (const item of items) {
    if (item.sans.length === 0) {
      stats.unknown++;
      continue;
    }
    stats.total++;
    const { mine, minePly, opponent } = detectGameCastling(item.sans, item.myColor);
    addOutcome(stats.byPhase[castlePhaseOf(minePly)], item.outcome);
    addOutcome(stats.matrix[mine ?? 'none'][opponent ?? 'none'], item.outcome);
  }
  return stats;
}

/** Nombre de parties d'un bilan (V+N+D). */
export function wldTotal(w: Wld): number {
  return w.wins + w.draws + w.losses;
}
