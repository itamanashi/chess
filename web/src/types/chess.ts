export interface RepertoireMove {
  coup: string;
  uci: string;
  san: string;
  parties: number;
  victoires_blancs: number;
  nuls: number;
  victoires_noirs: number;
  score_moyen?: number;
  ouverture?: string;
  eco?: string;
  fen: string;
  frequencyPct?: number; // Taux d'apparition réel (%) à la tranche d'Elo cible
  eval?: string; // Évaluation de l'ordinateur (ex: "+0.27", "-0.10", "#M2")
  /** Mat (délivré ou mat-en-1) : fin forcée, priorité absolue de génération. Posé par le BFS auto, préservé par fusion/stockage. */
  isMate?: boolean;
  /**
   * Copie de transposition (clone du sous-arbre canonique) : même position
   * déjà explorée ailleurs. Distinct de tout drapeau `transposition` du BFS
   * (le nœud transposé d'origine garde son propre marquage ; ses
   * descendants clonés portent `cloned`). Sert au comptage : un sous-arbre
   * cloné ne doit pas être compté comme positions explorées.
   */
  cloned?: boolean;
  children?: RepertoireMove[];
}

export interface EngineMove {
  uci: string;
  san: string;
  cp?: number;
  mate?: number;
  depth: number;
  scoreFormatted: string;
  pvSans: string[];
  /**
   * Variante principale en UCI normalisé (coup par coup, sans le coup joué
   * lui-même si déjà connu : pvUci[0] === uci en général). Sert à simuler
   * jusqu'à un horizon (analyses "piège"). Absent sur les vieux caches.
   */
  pvUci?: string[];
  /** Évaluation à chaque profondeur complétée (D1..Dmax) : stabilité, tendance. */
  trajectory?: EvalPoint[];
}

/** Un point d'évaluation moteur à une profondeur donnée (perspective du trait). */
export interface EvalPoint {
  depth: number;
  cp?: number;
  mate?: number;
}

export interface RepertoireRoot {
  fen: string;
  children: RepertoireMove[];
}

export type BoardOrientation = 'white' | 'black';

export type EloTargetKey =
  | 'all_700'
  | 'beginner'
  | 'beginner_club'
  | 'club_low'
  | 'club_mid'
  | 'club_high'
  | 'masters';

/**
 * Configuration TECHNIQUE d'une cible Elo (endpoint + filtre de cotes).
 * Les libellés FR vivent dans `i18n/fr.ts` (`eloTargetLabel/Description`).
 */
export interface EloTargetConfig {
  key: EloTargetKey;
  endpoint: 'masters' | 'lichess';
  ratingsParam?: string;
  /**
   * Filtre temporel, année incluse (audit A7) : l'API Masters mélange sinon
   * 70 ans de théorie (défaut serveur 1952), alors que l'objectif est une
   * tranche Elo *actuelle*. Seule l'entrée masters le définit pour l'instant.
   */
  since?: number;
}

export const ELO_TARGET_OPTIONS: EloTargetConfig[] = [
  {
    key: 'all_700',
    endpoint: 'lichess',
    ratingsParam: '1000,1200,1400,1600,1800,2000,2200,2500',
  },
  {
    key: 'beginner',
    endpoint: 'lichess',
    ratingsParam: '400,1000',
  },
  {
    key: 'beginner_club',
    endpoint: 'lichess',
    ratingsParam: '400,1000,1200,1400,1600',
  },
  {
    key: 'club_low',
    endpoint: 'lichess',
    ratingsParam: '1000,1200',
  },
  {
    key: 'club_mid',
    endpoint: 'lichess',
    ratingsParam: '1400,1600',
  },
  {
    key: 'club_high',
    endpoint: 'lichess',
    ratingsParam: '1800,2000',
  },
  {
    key: 'masters',
    endpoint: 'masters',
    since: 2015,
  },
];

export interface RepertoireItem {
  id: string;
  title: string;
  color: BoardOrientation; // Strictement Blancs ou Noirs
  targetElo: EloTargetKey;
  createdAt: string;
  updatedAt: string;
  /** Version du schéma de persistance (cf. storage/schemas.ts). */
  schemaVersion: number;
  root: RepertoireRoot;
}

export interface LichessMove {
  san: string;
  uci: string;
  white: number;
  draws: number;
  black: number;
  averageRating?: number;
  opening?: {
    eco?: string;
    name?: string;
  };
}

export interface LichessApiResponse {
  white: number;
  draws: number;
  black: number;
  moves: LichessMove[];
  opening?: {
    eco?: string;
    name?: string;
  };
}

export type AppView = 'library' | 'studio';

export type StudioTab = 'builder' | 'explorer' | 'tree' | 'trainer' | 'live' | 'games';

export interface MoveHistoryItem {
  san: string;
  uci: string;
  fen: string;
  opening?: string;
}

export interface TrainingStats {
  correctMoves: number;
  wrongMoves: number;
  currentStreak: number;
  bestStreak: number;
  linesCompleted: number;
  /** Score du coup précédent en centipawns (pour calcul de précision) */
  prevScore?: ScoreValue;
  /** Score du coup courant (après le coup joué) */
  nextScore?: ScoreValue;
}

/** Score d'évaluation moteur : centipawns ou mat (contrat trainer/accuracy). */
export interface ScoreValue {
  type: 'cp' | 'mate';
  value: number;
}

/** Pièce ayant joué le coup (pion, cavalier, fou, tour, dame, roi). */
export type PieceKind = 'p' | 'n' | 'b' | 'r' | 'q' | 'k';

/**
 * Pièce jouée depuis un SAN anglais (chess.js / PGN) : roque → roi,
 * initiale KQRBN → la pièce, sinon pion (promotion incluse : c'est le
 * pion qui bouge). Tolérant : SAN vide ou inconnu → pion.
 */
export function pieceFromSan(san: string): PieceKind {
  const s = san.trim();
  if (s.startsWith('O')) return 'k';
  switch (s[0]) {
    case 'K': return 'k';
    case 'Q': return 'q';
    case 'R': return 'r';
    case 'B': return 'b';
    case 'N': return 'n';
    default: return 'p';
  }
}
