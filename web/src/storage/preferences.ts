import { readRaw, writeRaw } from './storage';
import { warn } from '../utils/async';
import { prefInvalidValue } from '../i18n';
import type { GameShape } from '../services/chesscom';

/**
 * Token + UI preferences — typed, lenient access (safe defaults).
 * Corrupt value → default + logging, never a crash.
 */

const TOKEN_KEY = 'lichess_token';
const ENGINE_DEPTH_KEY = 'chess_local_engine_depth';
const SUGGESTION_SOURCE_KEY = 'chess_suggestion_source';
const AUTOPLAY_KEY = 'chess_auto_play_opponent';
const PIECE_SKIN_KEY = 'chess_piece_skin';
const CHESSCOM_USER_KEY = 'chesscom_username';
const CHESSCOM_AVATAR_KEY = 'chesscom_avatar';

export const tokenStore = {
  get(): string {
    return readRaw(TOKEN_KEY) ?? '';
  },
  set(value: string): void {
    writeRaw(TOKEN_KEY, value.trim());
  },
};

/** Compte Chess.com lié (API publique : pseudo + photo, pas de token). */
export const chesscomStore = {
  get(): string {
    return (readRaw(CHESSCOM_USER_KEY) ?? '').trim().toLowerCase();
  },
  /** Photo persistée avec le pseudo (sidebar + panneau, sans requête). */
  getAvatar(): string {
    return (readRaw(CHESSCOM_AVATAR_KEY) ?? '').trim();
  },
  set(value: string, avatar?: string): void {
    writeRaw(CHESSCOM_USER_KEY, value.trim().toLowerCase());
    writeRaw(CHESSCOM_AVATAR_KEY, (avatar ?? '').trim());
    emitChesscomUserChange();
  },
  clear(): void {
    writeRaw(CHESSCOM_USER_KEY, '');
    writeRaw(CHESSCOM_AVATAR_KEY, '');
    emitChesscomUserChange();
  },
};

const CHESSCOM_USER_EVENT = 'chesscom-user-change';
/** Précisions par partie : map URL -> nombres (léger, persisté). */
export interface StoredAccuracy {
  a: number | null;
  w: number | null;
  b: number | null;
  /** Forme narrative (calculée à l'analyse, absente des anciens lots). */
  s?: GameShape | null;
  /** Fourchettes trouvées / manquées (ordre FORK_PIECE_ORDER). */
  ff?: number[];
  fm?: number[];
  /** Clouages trouvés / manqués (ordre PIN_PIECE_ORDER). */
  pf?: number[];
  pm?: number[];
  /** Mats trouvés / manqués (ordre MATE_DISTANCE_ORDER : 1, 2, 3, 4, 5+). */
  mf?: number[];
  mm?: number[];
  /** Pièces laissées en prise (ordre HUNG_PIECE_ORDER : p, n, b, r, q). */
  hg?: number[];
  /** Pièces gratuites prises / ignorées (ordre HUNG_PIECE_ORDER). */
  gf?: number[];
  gm?: number[];
  /** Qualité des coups : total / blancs / noirs (ordre MOVE_QUALITY_ORDER). */
  q?: number[];
  qw?: number[];
  qb?: number[];
  /** Pièces : effectifs / moyennes par phase (3 phases × ordre PIECE_ORDER). */
  pc?: number[];
  pa?: number[];
}

const accuracyKey = (user: string): string =>
  `chesscom_accuracy_${user.trim().toLowerCase()}`;

export const chesscomAccuracyStore = {
  get(user: string): Record<string, StoredAccuracy> {
    if (!user.trim()) return {};
    try {
      const raw = readRaw(accuracyKey(user));
      if (!raw) return {};
      const parsed = JSON.parse(raw) as Record<string, StoredAccuracy>;
      if (parsed && typeof parsed === 'object') return parsed;
      return {};
    } catch {
      return {};
    }
  },
  setGame(user: string, url: string, patch: StoredAccuracy): void {
    if (!user.trim() || !url) return;
    try {
      const all = chesscomAccuracyStore.get(user);
      all[url] = patch;
      writeRaw(accuracyKey(user), JSON.stringify(all));
    } catch {
      /* quota plein : les badges de session restent, tant pis */
    }
  },
};

/** Agrégat « précision par numéro de coup » : léger, persisté par compte. */
export interface StoredMoveAccuracy {
  games: string[];
  total: Record<string, { sum: number; n: number }>;
  white: Record<string, { sum: number; n: number }>;
  black: Record<string, { sum: number; n: number }>;
}

const moveAccuracyKey = (user: string): string =>
  `chesscom_move_accuracy_${user.trim().toLowerCase()}`;

export function emptyStoredMoveAccuracy(): StoredMoveAccuracy {
  return { games: [], total: {}, white: {}, black: {} };
}

export const chesscomMoveAccuracyStore = {
  get(user: string): StoredMoveAccuracy {
    if (!user.trim()) return emptyStoredMoveAccuracy();
    try {
      const raw = readRaw(moveAccuracyKey(user));
      if (!raw) return emptyStoredMoveAccuracy();
      const parsed = JSON.parse(raw) as StoredMoveAccuracy;
      if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.games)) {
        return emptyStoredMoveAccuracy();
      }
      return {
        games: parsed.games.filter((u): u is string => typeof u === 'string'),
        total: parsed.total && typeof parsed.total === 'object' ? parsed.total : {},
        white: parsed.white && typeof parsed.white === 'object' ? parsed.white : {},
        black: parsed.black && typeof parsed.black === 'object' ? parsed.black : {},
      };
    } catch {
      return emptyStoredMoveAccuracy();
    }
  },
  set(user: string, data: StoredMoveAccuracy): void {
    if (!user.trim()) return;
    try {
      writeRaw(moveAccuracyKey(user), JSON.stringify(data));
    } catch {
      /* quota plein : l'agrégat de session reste, tant pis */
    }
  },
};
function emitChesscomUserChange(): void {
  try {
    if (typeof window !== 'undefined') window.dispatchEvent(new Event(CHESSCOM_USER_EVENT));
  } catch {
    /* stockage/event indisponible (tests) : pas d'abonnés de toute façon */
  }
}

/** La sidebar s'y abonne pour afficher le compte lié sans recharger. */
export function subscribeChesscomUser(cb: () => void): () => void {
  window.addEventListener(CHESSCOM_USER_EVENT, cb);
  return () => window.removeEventListener(CHESSCOM_USER_EVENT, cb);
}

export type SuggestionSource = 'advice' | 'engine' | 'users';
export type PieceSkin = 'cburnett' | 'unicode';

const SUGGESTION_SOURCES: SuggestionSource[] = ['advice', 'engine', 'users'];
const PIECE_SKINS: PieceSkin[] = ['cburnett', 'unicode'];

export const uiPrefs = {
  getEngineDepth(fallback: number | 'auto'): number | 'auto' {
    const raw = readRaw(ENGINE_DEPTH_KEY);
    if (raw === null || raw === '') return fallback;
    if (raw === 'auto') return 'auto';
    const n = parseInt(raw, 10);
    if (Number.isInteger(n) && n >= 4 && n <= 40) return n;
    warn('prefs:engine-depth', prefInvalidValue(raw));
    return fallback;
  },
  setEngineDepth(depth: number | 'auto'): void {
    writeRaw(ENGINE_DEPTH_KEY, String(depth));
  },

  getSuggestionSource(): SuggestionSource {
    const raw = readRaw(SUGGESTION_SOURCE_KEY);
    if (raw && (SUGGESTION_SOURCES as string[]).includes(raw)) return raw as SuggestionSource;
    if (raw !== null) warn('prefs:suggestion-source', prefInvalidValue(raw));
    return 'advice';
  },
  setSuggestionSource(src: SuggestionSource): void {
    writeRaw(SUGGESTION_SOURCE_KEY, src);
  },

  getAutoPlayOpponent(): boolean {
    const raw = readRaw(AUTOPLAY_KEY);
    if (raw === null) return true;
    return raw === 'true';
  },
  setAutoPlayOpponent(enabled: boolean): void {
    writeRaw(AUTOPLAY_KEY, String(enabled));
  },

  getPieceSkin(): PieceSkin {
    const raw = readRaw(PIECE_SKIN_KEY);
    if (raw && (PIECE_SKINS as string[]).includes(raw)) return raw as PieceSkin;
    if (raw !== null) warn('prefs:piece-skin', prefInvalidValue(raw));
    return 'cburnett';
  },
  setPieceSkin(skin: PieceSkin): void {
    writeRaw(PIECE_SKIN_KEY, skin);
  },
};
