import { Chess, type Square } from 'chess.js';
import { INITIAL_CP, phaseOfPly, whiteCpToWinChance, whiteWinToPov, type PhaseName } from '../utils/accuracy';
import {
  INITIAL_FEN,
  indexRepertoire,
  normalizeCastleUci,
  normalizeFen,
} from '../utils/repertoire';
import type { PieceKind, RepertoireRoot } from '../types/chess';
import { pieceFromSan } from '../types/chess';
import {
  fetchWithTimeout,
  isAbortError,
  isTimeoutError,
  mapWithConcurrency,
  throwIfAborted,
  warn,
} from '../utils/async';
import {
  CHESSCOM_BAD_RESPONSE,
  CHESSCOM_RATE_LIMITED,
  chesscomNetworkError,
  chesscomTimeout,
  chesscomUnknownUser,
} from '../i18n';

/**
 * Chess.com (API publique, sans authentification : « lier » un compte =
 * mémoriser son pseudo, cf. chesscomStore). Téléchargement de l'historique
 * complet via les archives mensuelles, avec concurrence bornée, progression
 * honnête et annulation (AbortSignal).
 *
 * Règles : AbortError/TimeoutError ne sont jamais des erreurs métier
 * (annulation volontaire / budget) ; tout le reste remonte en ChesscomError
 * structurée à message français. Les parties restent en mémoire de session
 * (cache module) : un historique complet pèse des Mo, hors quota
 * localStorage — pas de persistance disque.
 */

export type ChesscomErrorCode =
  | 'unknown-user'
  | 'network'
  | 'rate-limited'
  | 'bad-response'
  | 'timeout';

export class ChesscomError extends Error {
  readonly code: ChesscomErrorCode;
  constructor(code: ChesscomErrorCode, message: string) {
    super(message);
    this.name = 'ChesscomError';
    this.code = code;
  }
}

export function isChesscomError(err: unknown, code?: ChesscomErrorCode): boolean {
  return err instanceof ChesscomError && (code === undefined || err.code === code);
}

/** Pseudos insensibles à la casse côté Chess.com : on normalise une fois. */
export function normalizeUsername(username: string): string {
  return username.trim().toLowerCase();
}

export interface ChesscomProfile {
  username: string;
  name?: string;
  avatar?: string;
  followers?: number;
  /** Inscription (ms epoch), si fournie. */
  joined?: number;
  country?: string;
}

/** Forme brute d'une partie d'archive (sous-ensemble utile de l'API). */
export interface ChesscomArchiveGame {
  url: string;
  pgn: string;
  time_control: string;
  end_time: number;
  rated: boolean;
  time_class: string;
  rules?: string;
  white: { username: string; rating: number; result: string };
  black: { username: string; rating: number; result: string };
}

/** Partie normalisée : métadonnées API + coups et ECO extraits du PGN. */
export interface ChesscomGame extends ChesscomArchiveGame {
  /** Coups en SAN rejouables (vide si le PGN est illisible). */
  sans: string[];
  /** Code ECO du PGN ('?' si absent). */
  eco: string;
  /** Nom d'ouverture du PGN ('' si absent). */
  opening: string;
  /**
   * Précision du camp du COMPTE LIÉ (0-100, rapport en-croissant/Lichess).
   * `null`/absent = non analysée. Conservée pour les badges de liste.
   */
  accuracy?: number | null;
  /** Précision des Blancs (null si non analysée / aucun coup blanc). */
  whiteAccuracy?: number | null;
  /** Précision des Noirs (idem). */
  blackAccuracy?: number | null;
  /**
   * ACPL du camp du COMPTE LIÉ (perte moyenne en centipions, rapport
   * en-croissant). `null`/absent = non analysée. Conservée pour le Rapport
   * (comparaison récente vs précédente) et persistée comme les précisions.
   */
  acpl?: number | null;
  /**
   * Rapport complet (plis annotés, ACPL, phases). Stocké UNIQUEMENT pour
   * la partie analysée en détail (visionneuse) : un historique complet
   * pèserait des Mo. Le batch ne conserve que les nombres ci-dessus.
   */
  gameReport?: import('../utils/accuracy').GameReport | null;
  /**
   * Forme narrative de la partie (voir `classifyGameShape`), calculée à
   * l'analyse depuis la trajectoire Win% et persistée comme les précisions.
   */
  shape?: GameShape | null;
  /**
   * Fourchettes du compte lié (voir `detectUserForks`), calculées à
   * l'analyse et persistées en compact.
   */
  forks?: ForkCounts | null;
  /**
   * Clouages du compte lié (voir `detectUserPins`), calculés à l'analyse
   * et persistés en compact.
   */
  pins?: PinCounts | null;
  /**
   * Mats du compte lié (voir `detectUserMates`), calculés à l'analyse
   * et persistés en compact.
   */
  mates?: MateCounts | null;
  /**
   * Pièces laissées en prise (voir `detectUserHangs`), calculées à
   * l'analyse et persistées en compact.
   */
  hangs?: HungCounts | null;
  /**
   * Pièces gratuites adverses, prises ou ignorées (voir
   * `detectUserFreebies`), calculées à l'analyse et persistées en compact.
   */
  freebies?: FreebieCounts | null;
  /**
   * Qualité des coups (voir `computeGameMoveQuality`), calculée à
   * l'analyse et persistée en compact (total + par couleur).
   */
  moveQuality?: MoveQualityCounts | null;
  /**
   * Coups par pièce + précision moyenne (voir `computeGamePieceStats`),
   * calculés à l'analyse et persistés en compact (par phase).
   */
  pieces?: PieceStats | null;
}

export type ChesscomOutcome = 'win' | 'draw' | 'loss';

/** Résultats nuls côté Chess.com (tout le reste non-gagnant = défaite). */
const DRAW_RESULTS = new Set([
  'agreed',
  'repetition',
  'stalemate',
  'insufficient',
  '50move',
  'timevsinsufficient',
]);

/** Issue de la partie pour `username` (comparaison insensible à la casse). */
export function outcomeFor(game: Pick<ChesscomGame, 'white' | 'black'>, username: string): ChesscomOutcome {
  const user = normalizeUsername(username);
  const meWhite = game.white.username.trim().toLowerCase() === user;
  const myResult = meWhite ? game.white.result : game.black.result;
  if (myResult === 'win') return 'win';
  if (DRAW_RESULTS.has(myResult)) return 'draw';
  return 'loss';
}

/**
 * ACPL du compte lié (perte moyenne en centipions). Lit le champ batch
 * `acpl`, avec repli sur le rapport complet de la visionneuse (parties
 * analysées en détail, y compris lots antérieurs à l'ajout du champ).
 * `null` = jamais analysée au moteur (ni batch ni visionneuse).
 */
export function acplFor(
  game: Pick<ChesscomGame, 'white' | 'black' | 'acpl' | 'gameReport'>,
  username: string,
): number | null {
  if (typeof game.acpl === 'number' && Number.isFinite(game.acpl)) return game.acpl;
  const report = game.gameReport;
  if (report) {
    const v = colorOf(game, username) === 'w' ? report.acpl.white : report.acpl.black;
    if (typeof v === 'number' && Number.isFinite(v)) return v;
  }
  return null;
}

/** Couleur jouée par `username` ('w' | 'b'). */
export function colorOf(
  game: Pick<ChesscomGame, 'white'>,
  username: string,
): 'w' | 'b' {
  return game.white.username.trim().toLowerCase() === normalizeUsername(username) ? 'w' : 'b';
}

/**
 * Comptes robots connus de Chess.com (pas de drapeau « bot » dans l'API
 * publique : détection par nom). Les coachs d'entraînement s'appellent
 * tous « Coach-… » (Coach-Dante, Coach-Noa…) ; Mittens est le cas célèbre
 * isolé. Conservateur : seul l'ADVERSAIRE est testé (jamais soi-même), et
 * un humain nommé « coach-fan » serait un faux positif assumé et rarissime.
 */
const BOT_USERNAMES = new Set(['mittens']);

export function isBotUsername(username: string): boolean {
  const u = username.trim().toLowerCase();
  return u.startsWith('coach-') || BOT_USERNAMES.has(u);
}

/** Vrai si l'adversaire de `username` est un robot (partie d'entraînement). */
export function isBotGame(
  game: Pick<ChesscomGame, 'white' | 'black'>,
  username: string,
): boolean {
  const opp = colorOf(game, username) === 'w' ? game.black.username : game.white.username;
  return isBotUsername(opp);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

function asPlayerSide(v: unknown): ChesscomArchiveGame['white'] {
  const r = isRecord(v) ? v : {};
  return {
    username: typeof r['username'] === 'string' ? (r['username'] as string) : '?',
    rating: typeof r['rating'] === 'number' ? (r['rating'] as number) : 0,
    result: typeof r['result'] === 'string' ? (r['result'] as string) : '',
  };
}

function asArchiveGame(v: unknown): ChesscomArchiveGame | null {
  if (!isRecord(v)) return null;
  if (typeof v['pgn'] !== 'string' || typeof v['url'] !== 'string') return null;
  return {
    url: v['url'] as string,
    pgn: v['pgn'] as string,
    time_control: typeof v['time_control'] === 'string' ? (v['time_control'] as string) : '',
    end_time: typeof v['end_time'] === 'number' ? (v['end_time'] as number) : 0,
    rated: v['rated'] === true,
    time_class: typeof v['time_class'] === 'string' ? (v['time_class'] as string) : '',
    ...(typeof v['rules'] === 'string' ? { rules: v['rules'] as string } : {}),
    white: asPlayerSide(v['white']),
    black: asPlayerSide(v['black']),
  };
}

/**
 * Nom d'ouverture depuis l'URL ECO de Chess.com
 * (https://www.chess.com/openings/Sicilian-Defense-Dragon → nom lisible).
 */
export function ecoNameFromUrl(ecoUrl: string | undefined): string {
  if (!ecoUrl) return '';
  try {
    const slug = decodeURIComponent(ecoUrl.split('/').filter(Boolean).pop() ?? '');
    return slug.replace(/-/g, ' ').replace(/\s+/g, ' ').trim();
  } catch {
    return '';
  }
}

/**
 * Noms par code ECO (REPLI uniquement : les PGN Chess.com portent l'ECO
 * mais pas toujours le nom en clair). Familles volontairement larges :
 * un nom de famille juste vaut mieux qu'une variante fausse.
 */
const ECO_FALLBACK_NAMES: Record<string, string> = {
  A00: "Polish Opening", A01: 'Nimzo-Larsen Attack', A02: "Bird's Opening", A03: "Bird's Opening",
  A04: 'Réti Opening', A06: 'Réti Opening', A07: "King's Indian Attack", A09: 'Réti Opening',
  A10: 'English Opening', A15: 'English Opening', A20: 'English Opening', A30: 'English Opening',
  A40: "Queen's Pawn Game",
  B00: "King's Pawn Opening", B01: 'Scandinavian Defense', B06: 'Modern Defense',
  B07: 'Pirc Defense', B08: 'Pirc Defense', B09: 'Pirc Defense',
  B10: 'Caro-Kann Defense', B12: 'Caro-Kann Defense', B13: 'Caro-Kann Defense',
  B14: 'Caro-Kann Defense', B15: 'Caro-Kann Defense', B18: 'Caro-Kann Defense', B19: 'Caro-Kann Defense',
  B20: 'Sicilian Defense', B22: 'Sicilian Defense', B23: 'Sicilian Defense',
  B30: 'Sicilian Defense', B33: 'Sicilian Defense', B40: 'Sicilian Defense', B45: 'Sicilian Defense',
  B60: 'Sicilian Defense', B70: 'Sicilian Defense', B80: 'Sicilian Defense', B90: 'Sicilian Defense',
  B96: 'Sicilian Defense', B97: 'Sicilian Defense',
  C00: 'French Defense', C02: 'French Defense', C05: 'French Defense', C11: 'French Defense',
  C15: 'French Defense',
  C20: "King's Pawn Game", C23: "Bishop's Opening", C25: 'Vienna Game',
  C30: "King's Gambit Declined", C31: "King's Gambit Declined", C33: "King's Gambit Accepted",
  C40: "King's Knight Opening", C41: 'Philidor Defense', C42: "Petrov's Defense",
  C45: 'Scotch Game', C46: 'Three Knights Opening', C47: 'Four Knights Game',
  C50: 'Italian Game', C55: 'Two Knights Defense',
  C60: 'Ruy Lopez', C65: 'Ruy Lopez', C68: 'Ruy Lopez', C70: 'Ruy Lopez',
  C77: 'Ruy Lopez', C78: 'Ruy Lopez', C80: 'Ruy Lopez', C84: 'Ruy Lopez', C92: 'Ruy Lopez', C95: 'Ruy Lopez',
  D00: "Queen's Pawn Game", D02: "Queen's Pawn Game",
  D06: "Queen's Gambit Declined", D07: "Queen's Gambit Declined", D08: "Queen's Gambit Declined",
  D10: 'Slav Defense', D15: 'Slav Defense',
  D20: "Queen's Gambit Accepted",
  D30: "Queen's Gambit Declined", D31: "Queen's Gambit Declined", D35: "Queen's Gambit Declined",
  D43: 'Semi-Slav Defense',
  D50: "Queen's Gambit Declined", D55: "Queen's Gambit Declined", D60: "Queen's Gambit Declined",
  D70: 'Neo-Grünfeld Defense', D80: 'Grünfeld Defense', D85: 'Grünfeld Defense', D90: 'Grünfeld Defense',
  E00: "Queen's Pawn Game",
  E04: 'Catalan Opening', E11: 'Bogo-Indian Defense', E12: "Queen's Indian Defense", E15: "Queen's Indian Defense",
  E20: 'Nimzo-Indian Defense', E21: 'Nimzo-Indian Defense', E24: 'Nimzo-Indian Defense',
  E30: 'Nimzo-Indian Defense', E32: 'Nimzo-Indian Defense', E40: 'Nimzo-Indian Defense',
  E41: 'Nimzo-Indian Defense', E45: 'Nimzo-Indian Defense', E48: 'Nimzo-Indian Defense',
  E49: 'Nimzo-Indian Defense', E51: 'Nimzo-Indian Defense', E54: 'Nimzo-Indian Defense',
  E60: "King's Indian Defense", E61: "King's Indian Defense", E62: "King's Indian Defense",
  E70: "King's Indian Defense", E75: "King's Indian Defense", E80: "King's Indian Defense",
  E90: "King's Indian Defense", E91: "King's Indian Defense", E92: "King's Indian Defense",
  E94: "King's Indian Defense", E97: "King's Indian Defense", E99: "King's Indian Defense",
};

/**
 * Extrait coups + ECO + NOM du PGN (chess.js). Chaîne de résolution du nom :
 * en-tête Opening → slug ECOUrl → table ECO → ''. Ne lève jamais : PGN
 * exotique (variantes, corrompu) → coups vides, ECO '?' — listable quand même.
 */
export function parseArchiveGame(raw: ChesscomArchiveGame): ChesscomGame {
  let sans: string[] = [];
  let eco = '?';
  let opening = '';
  try {
    const c = new Chess();
    c.loadPgn(raw.pgn);
    sans = c.history();
    const headers = c.header() as Record<string, string | undefined>;
    if (headers['ECO']) eco = headers['ECO'];
    opening =
      headers['Opening'] ||
      ecoNameFromUrl(headers['ECOUrl']) ||
      (eco !== '?' ? (ECO_FALLBACK_NAMES[eco] ?? '') : '');
  } catch {
    /* PGN illisible : métadonnées API conservées, coups vides */
  }
  return { ...raw, sans, eco, opening };
}

// ---------------------------------------------------------------------------
// Réseau.
// ---------------------------------------------------------------------------

const API_ROOT = 'https://api.chess.com/pub';
const DEFAULT_TIMEOUT_MS = 20000;
/** Concurrence polie par défaut (archives mensuelles indépendantes). */
const DEFAULT_ARCHIVE_CONCURRENCY = 4;

async function getJson(
  url: string,
  opts: {
    signal?: AbortSignal;
    timeoutMs?: number;
    notFoundCode?: ChesscomErrorCode;
    /** Message 404 sur mesure (sinon message générique). */
    notFoundMessage?: string;
  },
): Promise<unknown> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let res: Response;
  try {
    res = await fetchWithTimeout(url, { signal: opts.signal, headers: { Accept: 'application/json' } }, timeoutMs);
  } catch (err) {
    if (isAbortError(err)) throw err;
    if (isTimeoutError(err)) throw new ChesscomError('timeout', chesscomTimeout(timeoutMs));
    throw new ChesscomError('network', chesscomNetworkError(err instanceof Error ? err.message : String(err)));
  }
  if (res.status === 404) {
    const code = opts.notFoundCode ?? 'bad-response';
    throw new ChesscomError(code, opts.notFoundMessage ?? CHESSCOM_BAD_RESPONSE);
  }
  if (res.status === 429) throw new ChesscomError('rate-limited', CHESSCOM_RATE_LIMITED);
  if (!res.ok) throw new ChesscomError('bad-response', `${CHESSCOM_BAD_RESPONSE} (HTTP ${res.status}).`);
  try {
    return (await res.json()) as unknown;
  } catch {
    throw new ChesscomError('bad-response', CHESSCOM_BAD_RESPONSE);
  }
}

/** Profil public (valide aussi l'existence du compte : 404 → unknown-user). */
export async function fetchPlayer(
  username: string,
  opts: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<ChesscomProfile> {
  const user = normalizeUsername(username);
  if (!user) throw new ChesscomError('unknown-user', chesscomUnknownUser(username));
  const data = await getJson(`${API_ROOT}/player/${encodeURIComponent(user)}`, {
    ...opts,
    notFoundCode: 'unknown-user',
    notFoundMessage: chesscomUnknownUser(user),
  });
  if (!isRecord(data) || typeof data['username'] !== 'string') {
    throw new ChesscomError('bad-response', CHESSCOM_BAD_RESPONSE);
  }
  const profile: ChesscomProfile = { username: data['username'] as string };
  if (typeof data['name'] === 'string' && data['name']) profile.name = data['name'] as string;
  if (typeof data['avatar'] === 'string') profile.avatar = data['avatar'] as string;
  if (typeof data['followers'] === 'number') profile.followers = data['followers'] as number;
  if (typeof data['joined'] === 'number') profile.joined = (data['joined'] as number) * 1000;
  if (typeof data['country'] === 'string') {
    const parts = (data['country'] as string).split('/');
    profile.country = parts[parts.length - 1];
  }
  return profile;
}

/** URLs d'archives mensuelles (ordre chronologique), compte validé. */
export async function fetchArchives(
  username: string,
  opts: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<string[]> {
  const user = normalizeUsername(username);
  const data = await getJson(`${API_ROOT}/player/${encodeURIComponent(user)}/games/archives`, {
    ...opts,
    notFoundCode: 'unknown-user',
    notFoundMessage: chesscomUnknownUser(user),
  });
  if (!isRecord(data) || !Array.isArray(data['archives'])) {
    throw new ChesscomError('bad-response', CHESSCOM_BAD_RESPONSE);
  }
  return (data['archives'] as unknown[]).filter((u): u is string => typeof u === 'string');
}

/** Parties d'une archive mensuelle, normalisées (PGN parsé). */
export async function fetchArchiveGames(
  archiveUrl: string,
  opts: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<ChesscomGame[]> {
  const data = await getJson(archiveUrl, opts);
  if (!isRecord(data) || !Array.isArray(data['games'])) {
    throw new ChesscomError('bad-response', CHESSCOM_BAD_RESPONSE);
  }
  const games: ChesscomGame[] = [];
  for (const g of data['games'] as unknown[]) {
    const raw = asArchiveGame(g);
    if (raw) games.push(parseArchiveGame(raw));
  }
  return games;
}

export interface ChesscomSyncProgress {
  doneArchives: number;
  totalArchives: number;
}

export interface ChesscomSyncResult {
  username: string;
  games: ChesscomGame[];
  archivesTotal: number;
  /** Archives en échec partiel (isolées : les autres sont conservées). */
  archivesFailed: number;
}

export interface ChesscomSyncOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Requêtes archives simultanées (défaut 4, poli). */
  concurrency?: number;
  onProgress?: (p: ChesscomSyncProgress) => void;
}

/**
 * Historique COMPLET : toutes les archives mensuelles, plus récentes
 * d'abord. Une archive en échec n'annule pas les autres (isolée, comptée
 * et journalisée) ; seule l'annulation appelante interrompt tout. Si tout
 * échoue, la première erreur remonte. Zéro partie + zéro échec = compte vide.
 */
export async function fetchAllGames(
  username: string,
  opts: ChesscomSyncOptions = {},
): Promise<ChesscomSyncResult> {
  const user = normalizeUsername(username);
  throwIfAborted(opts.signal);
  const archiveUrls = await fetchArchives(user, opts);
  throwIfAborted(opts.signal);
  const report = (doneArchives: number): void => {
    try {
      opts.onProgress?.({ doneArchives, totalArchives: archiveUrls.length });
    } catch {
      /* listener must never break the run */
    }
  };
  report(0);
  let done = 0;
  let archivesFailed = 0;
  let firstError: unknown = null;
  const perArchive = await mapWithConcurrency(
    archiveUrls,
    opts.concurrency ?? DEFAULT_ARCHIVE_CONCURRENCY,
    async (url): Promise<ChesscomGame[]> => {
      try {
        const games = await fetchArchiveGames(url, opts);
        return games;
      } catch (err) {
        if (isAbortError(err)) throw err;
        // Archive en échec isolée (un mois vide n'en est pas une : ici on
        // ne compte que les vraies erreurs réseau/réponse).
        archivesFailed++;
        if (!firstError) firstError = err;
        warn('chesscom:archive', `${url} — ${err instanceof Error ? err.message : String(err)}`);
        return [];
      } finally {
        done++;
        report(done);
      }
    },
  );
  throwIfAborted(opts.signal);
  const games = perArchive.flat().sort((a, b) => b.end_time - a.end_time);
  if (games.length === 0 && firstError) throw firstError;
  GAMES_CACHE.set(user, { username: user, games, archivesTotal: archiveUrls.length, archivesFailed });
  return { username: user, games, archivesTotal: archiveUrls.length, archivesFailed };
}

// ---------------------------------------------------------------------------
// Cache de session (mémoire : l'historique complet dépasse le localStorage).
// ---------------------------------------------------------------------------

const GAMES_CACHE = new Map<string, ChesscomSyncResult>();

export function getCachedGames(username: string): ChesscomSyncResult | null {
  return GAMES_CACHE.get(normalizeUsername(username)) ?? null;
}

export function clearCachedGames(username?: string): void {
  if (username === undefined) GAMES_CACHE.clear();
  else GAMES_CACHE.delete(normalizeUsername(username));
}

/** Reporte une précision/rapport dans le cache de session (sinon perdu au remontage). */
export function patchCachedGame(
  username: string,
  url: string,
  patch: Pick<ChesscomGame, 'accuracy' | 'whiteAccuracy' | 'blackAccuracy' | 'shape' | 'forks' | 'pins' | 'mates' | 'hangs' | 'freebies' | 'moveQuality' | 'pieces'> & {
    gameReport?: ChesscomGame['gameReport'];
  },
): void {
  const entry = GAMES_CACHE.get(normalizeUsername(username));
  if (!entry) return;
  entry.games = entry.games.map((g) =>
    g.url === url ? { ...g, ...patch } : g,
  );
}

// ---------------------------------------------------------------------------
// Calendrier d'activité (heatmap GitHub-style).
// ---------------------------------------------------------------------------

export interface ActivityDay {
  /** Jour ISO YYYY-MM-DD (UTC). */
  date: string;
  games: number;
  /** Issues du compte lié ce jour-là (0 sans `username`). */
  wins: number;
  draws: number;
  losses: number;
  /** Case vide après aujourd'hui (fin de semaine en cours). */
  future: boolean;
}

const DAY_MS = 86400000;

/**
 * Derniers `days` jours groupés en colonnes de semaines (lundi en haut),
 * la plus récente à droite. Avec `username` (+ white/black sur les parties),
 * chaque jour compte aussi ses V/N/D. Pur et testé : `nowMs` injectable.
 */
export function buildActivityWeeks(
  games: Array<Pick<ChesscomGame, 'end_time'> & Partial<Pick<ChesscomGame, 'white' | 'black'>>>,
  days = 91,
  nowMs: number = Date.now(),
  username = '',
): ActivityDay[][] {
  const user = normalizeUsername(username);
  const keyOf = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
  const counts = new Map<string, { games: number; wins: number; draws: number; losses: number }>();
  const tally = (k: string): { games: number; wins: number; draws: number; losses: number } => {
    let row = counts.get(k);
    if (!row) {
      row = { games: 0, wins: 0, draws: 0, losses: 0 };
      counts.set(k, row);
    }
    return row;
  };
  for (const g of games) {
    if (!g.end_time) continue;
    const row = tally(keyOf(g.end_time * 1000));
    row.games++;
    if (user && g.white?.username && g.black?.username) {
      const outcome = outcomeFor({ white: g.white, black: g.black }, user);
      if (outcome === 'win') row.wins++;
      else if (outcome === 'draw') row.draws++;
      else row.losses++;
    }
  }
  const emptyDay = (date: string, future: boolean): ActivityDay => ({
    date,
    games: 0,
    wins: 0,
    draws: 0,
    losses: 0,
    future,
  });
  const today = new Date(nowMs);
  today.setUTCHours(0, 0, 0, 0);
  const start = new Date(today.getTime() - (days - 1) * DAY_MS);
  // Recule au lundi pour des colonnes complètes.
  start.setTime(start.getTime() - (((start.getUTCDay() + 6) % 7) * DAY_MS));
  const weeks: ActivityDay[][] = [];
  let week: ActivityDay[] = [];
  const cursor = new Date(start.getTime());
  while (cursor.getTime() <= today.getTime()) {
    const k = keyOf(cursor.getTime());
    const c = counts.get(k);
    week.push(c ? { date: k, ...c, future: false } : emptyDay(k, false));
    if (week.length === 7) {
      weeks.push(week);
      week = [];
    }
    cursor.setTime(cursor.getTime() + DAY_MS);
  }
  if (week.length > 0) {
    // Bourre la semaine en cours avec des cases futures (transparentes).
    // Le curseur pointe déjà le lendemain du dernier jour réel : pousser
    // d'abord, incrémenter ensuite (sinon un jour est sauté).
    while (week.length < 7) {
      week.push(emptyDay(keyOf(cursor.getTime()), true));
      cursor.setTime(cursor.getTime() + DAY_MS);
    }
    weeks.push(week);
  }
  return weeks;
}

// ---------------------------------------------------------------------------
// Historique Elo (courbe par cadence).
// ---------------------------------------------------------------------------

export interface RatingPoint {
  /** Fin de partie (ms epoch). */
  t: number;
  /** Elo de l'utilisateur sur la partie. */
  rating: number;
}

export interface RatingSeries {
  timeClass: string;
  points: RatingPoint[];
}

/**
 * Elo après chaque partie, groupé par cadence (les Elos blitz/rapide/…
 * sont indépendants : les mélanger serait faux). Fenêtre `days` comme
 * le calendrier d'activité. Pur et testé (`nowMs` injectable).
 */
export function buildRatingSeries(
  games: ChesscomGame[],
  username: string,
  days = 91,
  nowMs: number = Date.now(),
): RatingSeries[] {
  const user = normalizeUsername(username);
  const cutoff = nowMs - days * DAY_MS;
  const byClass = new Map<string, RatingPoint[]>();
  for (const g of games) {
    const endMs = g.end_time * 1000;
    if (!g.end_time || endMs < cutoff || endMs > nowMs) continue;
    const mine: 'w' | 'b' = g.white.username.trim().toLowerCase() === user ? 'w' : 'b';
    const rating = mine === 'w' ? g.white.rating : g.black.rating;
    if (!rating) continue;
    const cls = g.time_class || '?';
    let pts = byClass.get(cls);
    if (!pts) {
      pts = [];
      byClass.set(cls, pts);
    }
    pts.push({ t: endMs, rating });
  }
  return [...byClass.entries()]
    .map(([timeClass, points]) => ({
      timeClass,
      points: points.sort((a, b) => a.t - b.t),
    }))
    .sort((a, b) => b.points.length - a.points.length);
}

// ---------------------------------------------------------------------------
// Statistiques par couleur jouée.
// ---------------------------------------------------------------------------

export interface SideStatRow {
  side: 'w' | 'b';
  games: number;
  wins: number;
  draws: number;
  losses: number;
}

/** Toujours deux lignes (Blancs puis Noirs), même à zéro. Pur et testé. */
export function computeSideStats(games: ChesscomGame[], username: string): SideStatRow[] {
  const user = normalizeUsername(username);
  const rows: Record<'w' | 'b', SideStatRow> = {
    w: { side: 'w', games: 0, wins: 0, draws: 0, losses: 0 },
    b: { side: 'b', games: 0, wins: 0, draws: 0, losses: 0 },
  };
  for (const g of games) {
    const mine: 'w' | 'b' = g.white.username.trim().toLowerCase() === user ? 'w' : 'b';
    const row = rows[mine];
    row.games++;
    const outcome = outcomeFor(g, user);
    if (outcome === 'win') row.wins++;
    else if (outcome === 'draw') row.draws++;
    else row.losses++;
  }
  return [rows.w, rows.b];
}

// ---------------------------------------------------------------------------
// Fins de partie (comment les points sont gagnés/perdus).
// ---------------------------------------------------------------------------

export interface TerminationRow {
  /** Parties décisives (V ou D selon la ligne). */
  total: number;
  /** Par mat (adversaire 'checkmated'). */
  mate: number;
  /** Par abandon (adversaire 'resigned'). */
  resign: number;
  /** Au temps (adversaire 'timeout'). */
  clock: number;
}

export interface TerminationStats {
  wins: TerminationRow;
  losses: TerminationRow;
}
/**
 * Ventilation V/D par mat / abandon / temps, du point de vue de
 * l'utilisateur (le motif est lu sur le perdant : 'win' ne dit rien).
 * Nulles et fins exotiques (variantes, abandons secs) hors tableau.
 * Pur et testé.
 */
export function computeTerminationStats(
  games: ChesscomGame[],
  username: string,
): TerminationStats {
  const user = normalizeUsername(username);
  const wins: TerminationRow = { total: 0, mate: 0, resign: 0, clock: 0 };
  const losses: TerminationRow = { total: 0, mate: 0, resign: 0, clock: 0 };
  for (const g of games) {
    const mine: 'w' | 'b' = g.white.username.trim().toLowerCase() === user ? 'w' : 'b';
    const myResult = mine === 'w' ? g.white.result : g.black.result;
    const oppResult = mine === 'w' ? g.black.result : g.white.result;
    if (myResult === 'win') {
      wins.total++;
      if (oppResult === 'checkmated') wins.mate++;
      else if (oppResult === 'resigned') wins.resign++;
      else if (oppResult === 'timeout') wins.clock++;
    } else if (!DRAW_RESULTS.has(myResult) && myResult !== '') {
      losses.total++;
      if (myResult === 'checkmated') losses.mate++;
      else if (myResult === 'resigned') losses.resign++;
      else if (myResult === 'timeout') losses.clock++;
    }
  }
  return { wins, losses };
}

// ---------------------------------------------------------------------------
// Fins de partie détaillées (V + nulles par motif + D, barre unique).
// ---------------------------------------------------------------------------

/** Nulles par motif Chess.com (les deux camps portent le même code). */
export interface DrawEndingRow {
  /** Accord mutuel ('agreed'). */
  agreed: number;
  /** Triple répétition ('repetition'). */
  repetition: number;
  /** Pat ('stalemate'). */
  stalemate: number;
  /** Règle des 50 coups ('50move'). */
  fiftyMove: number;
  /** Manque de matériel ('insufficient'). */
  insufficient: number;
  /** Temps contre manque de matériel ('timevsinsufficient'). */
  timeVsInsufficient: number;
  /** Autre motif nul. */
  other: number;
  total: number;
}

export interface EndingStats {
  wins: TerminationRow;
  draws: DrawEndingRow;
  losses: TerminationRow;
  /** Parties au motif inclassable (résultat vide/exotique). */
  other: number;
  /** Parties dans le périmètre (base 100 % de la barre unique). */
  total: number;
}

/**
 * Ventilation complète des fins de partie : victoires (mat/abandon/temps),
 * nulles par motif (accord, répétition, pat, 50 coups, manque de matériel,
 * temps contre manque de matériel) et défaites (mat/abandon/temps).
 * Pur et testé.
 */
export function computeEndingStats(games: ChesscomGame[], username: string): EndingStats {
  const user = normalizeUsername(username);
  const wins: TerminationRow = { total: 0, mate: 0, resign: 0, clock: 0 };
  const draws: DrawEndingRow = {
    agreed: 0,
    repetition: 0,
    stalemate: 0,
    fiftyMove: 0,
    insufficient: 0,
    timeVsInsufficient: 0,
    other: 0,
    total: 0,
  };
  const losses: TerminationRow = { total: 0, mate: 0, resign: 0, clock: 0 };
  let other = 0;
  for (const g of games) {
    const mine: 'w' | 'b' = g.white.username.trim().toLowerCase() === user ? 'w' : 'b';
    const myResult = mine === 'w' ? g.white.result : g.black.result;
    const oppResult = mine === 'w' ? g.black.result : g.white.result;
    if (myResult === 'win') {
      wins.total++;
      if (oppResult === 'checkmated') wins.mate++;
      else if (oppResult === 'resigned') wins.resign++;
      else if (oppResult === 'timeout') wins.clock++;
    } else if (DRAW_RESULTS.has(myResult)) {
      draws.total++;
      if (myResult === 'agreed') draws.agreed++;
      else if (myResult === 'repetition') draws.repetition++;
      else if (myResult === 'stalemate') draws.stalemate++;
      else if (myResult === '50move') draws.fiftyMove++;
      else if (myResult === 'insufficient') draws.insufficient++;
      else if (myResult === 'timevsinsufficient') draws.timeVsInsufficient++;
      else draws.other++;
    } else if (myResult !== '') {
      losses.total++;
      if (myResult === 'checkmated') losses.mate++;
      else if (myResult === 'resigned') losses.resign++;
      else if (myResult === 'timeout') losses.clock++;
    } else {
      other++;
    }
  }
  return { wins, draws, losses, other, total: games.length };
}

// ---------------------------------------------------------------------------
// Statistiques d'ouvertures.
// ---------------------------------------------------------------------------

export interface OpeningStatRow {
  eco: string;
  name: string;
  games: number;
  wins: number;
  draws: number;
  losses: number;
  /** 0..100 (wins + draws/2) / games. */
  scorePct: number;
  /** Durée moyenne d'une partie dans l'ouverture (coups pleins). */
  avgMoves: number;
}

/**
 * Regroupe par code ECO (triées par volume décroissant). `color` filtre
 * la couleur JOUÉE par l'utilisateur (pas le trait). Pur, testé.
 */
export function computeOpeningStats(
  games: ChesscomGame[],
  username: string,
  color: 'all' | 'w' | 'b' = 'all',
): OpeningStatRow[] {
  const user = normalizeUsername(username);
  const acc = new Map<string, { name: string; games: number; wins: number; draws: number; losses: number; plies: number }>();
  for (const g of games) {
    const mine: 'w' | 'b' = g.white.username.trim().toLowerCase() === user ? 'w' : 'b';
    if (color !== 'all' && mine !== color) continue;
    // Sans ECO, on regroupe par nom (plutôt qu'un fourre-tout '?').
    const eco = g.eco || '?';
    const key = eco !== '?' ? eco : g.opening ? `~${g.opening}` : '?';
    let row = acc.get(key);
    if (!row) {
      row = { name: '', games: 0, wins: 0, draws: 0, losses: 0, plies: 0 };
      acc.set(key, row);
    }
    if (!row.name && g.opening) row.name = g.opening;
    row.games++;
    row.plies += g.sans.length;
    const outcome = outcomeFor(g, user);
    if (outcome === 'win') row.wins++;
    else if (outcome === 'draw') row.draws++;
    else row.losses++;
  }
  return [...acc.entries()]
    .map(([key, r]) => ({
      eco: key.startsWith('~') ? '?' : key,
      name: r.name,
      games: r.games,
      wins: r.wins,
      draws: r.draws,
      losses: r.losses,
      scorePct: r.games > 0 ? ((r.wins + r.draws / 2) / r.games) * 100 : 0,
      avgMoves: r.games > 0 ? r.plies / r.games / 2 : 0,
    }))
    .sort((a, b) => b.games - a.games || b.scorePct - a.scorePct);
}

// ---------------------------------------------------------------------------
// Performances par ouverture (top N + coups caractéristiques + V/N/D).
// ---------------------------------------------------------------------------

export interface OpeningPerformanceRow {
  /** Clé stable (ECO ou `~nom`), unique par ligne. */
  key: string;
  eco: string;
  name: string;
  /** Premiers coups communs (ex. « 1. e4 c5 »), « — » si inconnus. */
  movesLabel: string;
  /** Variante SAN commune (≤ `maxPlies`), pour la prévisualisation. */
  sansPrefix: string[];
  games: number;
  wins: number;
  draws: number;
  losses: number;
}

/** Plus long préfixe SAN commun (borne à `maxPlies`), ex. [e4, c5]. */
function commonSansPrefix(lists: string[][], maxPlies: number): { prefix: string[]; truncated: boolean } {
  if (lists.length === 0) return { prefix: [], truncated: false };
  const first = lists[0];
  const prefix: string[] = [];
  const len = Math.min(first.length, maxPlies);
  for (let i = 0; i < len; i++) {
    const san = first[i];
    if (!lists.every((l) => l[i] === san)) break;
    prefix.push(san);
  }
  return { prefix, truncated: prefix.length === maxPlies && lists.some((l) => l.length > maxPlies) };
}

/** Préfixe SAN → « 1. e4 c5 2. Nf3… ». */
function formatSansPrefix(prefix: string[], truncated: boolean): string {
  if (prefix.length === 0) return '—';
  let out = '';
  for (let i = 0; i < prefix.length; i += 2) {
    out += `${i / 2 + 1}. ${prefix[i]}`;
    if (prefix[i + 1]) out += ` ${prefix[i + 1]}`;
    out += ' ';
  }
  return out.trim() + (truncated ? ' …' : '');
}

/**
 * Top `topN` des ouvertures les plus jouées d'une couleur, avec coups
 * caractéristiques (préfixe commun, 3 coups max) et ventilation V/N/D.
 * Pur et testé.
 */
export function computeOpeningPerformances(
  games: ChesscomGame[],
  username: string,
  color: 'w' | 'b',
  topN = 10,
  maxPlies = 6,
): OpeningPerformanceRow[] {
  const user = normalizeUsername(username);
  const acc = new Map<string, { name: string; games: number; wins: number; draws: number; losses: number }>();
  for (const g of games) {
    const mine: 'w' | 'b' = g.white.username.trim().toLowerCase() === user ? 'w' : 'b';
    if (mine !== color) continue;
    const eco = g.eco || '?';
    const key = eco !== '?' ? eco : g.opening ? `~${g.opening}` : '?';
    let row = acc.get(key);
    if (!row) {
      row = { name: '', games: 0, wins: 0, draws: 0, losses: 0 };
      acc.set(key, row);
    }
    if (!row.name && g.opening) row.name = g.opening;
    row.games++;
    const outcome = outcomeFor(g, user);
    if (outcome === 'win') row.wins++;
    else if (outcome === 'draw') row.draws++;
    else row.losses++;
  }
  const topKeys = [...acc.entries()]
    .sort((a, b) => b[1].games - a[1].games)
    .slice(0, topN)
    .map(([key]) => key);
  const sansByKey = new Map<string, string[][]>();
  for (const g of games) {
    const mine: 'w' | 'b' = g.white.username.trim().toLowerCase() === user ? 'w' : 'b';
    if (mine !== color || !g.sans || g.sans.length === 0) continue;
    const eco = g.eco || '?';
    const key = eco !== '?' ? eco : g.opening ? `~${g.opening}` : '?';
    if (!topKeys.includes(key)) continue;
    const list = sansByKey.get(key);
    if (list) list.push(g.sans);
    else sansByKey.set(key, [g.sans]);
  }
  return topKeys.map((key) => {
    const r = acc.get(key) as { name: string; games: number; wins: number; draws: number; losses: number };
    const { prefix, truncated } = commonSansPrefix(sansByKey.get(key) ?? [], maxPlies);
    return {
      key,
      eco: key.startsWith('~') ? '?' : key,
      name: r.name,
      movesLabel: formatSansPrefix(prefix, truncated),
      sansPrefix: prefix,
      games: r.games,
      wins: r.wins,
      draws: r.draws,
      losses: r.losses,
    };
  });
}

// ---------------------------------------------------------------------------
// Statistiques par année.
// ---------------------------------------------------------------------------

export interface YearStatRow {
  year: number;
  games: number;
  wins: number;
  draws: number;
  losses: number;
}

/**
 * Regroupe les parties par année civile (basé sur end_time). Triées par
 * année décroissante (plus récentes en haut). Pur et testé.
 */
export function computeYearStats(games: ChesscomGame[], username: string): YearStatRow[] {
  const user = normalizeUsername(username);
  const byYear = new Map<number, { games: number; wins: number; draws: number; losses: number }>();
  for (const g of games) {
    if (!g.end_time) continue;
    const date = new Date(g.end_time * 1000);
    const year = date.getUTCFullYear();
    let row = byYear.get(year);
    if (!row) {
      row = { games: 0, wins: 0, draws: 0, losses: 0 };
      byYear.set(year, row);
    }
    row.games++;
    const outcome = outcomeFor(g, user);
    if (outcome === 'win') row.wins++;
    else if (outcome === 'draw') row.draws++;
    else row.losses++;
  }
  return [...byYear.entries()]
    .map(([year, r]) => ({ year, games: r.games, wins: r.wins, draws: r.draws, losses: r.losses }))
    .sort((a, b) => b.year - a.year);
}

// ---------------------------------------------------------------------------
// Statistiques par période (granularité adaptative : jour / mois / année).
// ---------------------------------------------------------------------------

export type PeriodGranularity = 'day' | 'month' | 'year';

export interface PeriodStatRow {
  /** Clé de tri ISO : 'YYYY-MM-DD' | 'YYYY-MM' | 'YYYY'. */
  key: string;
  /** Libellé complet FR : '12 janv. 2026' | 'janv. 2026' | '2026'. */
  label: string;
  /** Libellé court pour l'axe du graphique. */
  shortLabel: string;
  games: number;
  wins: number;
  draws: number;
  losses: number;
}

export interface PeriodStats {
  granularity: PeriodGranularity;
  /** Triées par ordre chronologique (anciennes à gauche sur le graphique). */
  rows: PeriodStatRow[];
}

const MONTH_SHORT_FR = [
  'janv.', 'févr.', 'mars', 'avr.', 'mai', 'juin',
  'juil.', 'août', 'sept.', 'oct.', 'nov.', 'déc.',
];

/**
 * Regroupe les parties par jour / mois / année selon l'étendue réelle de
 * l'historique : ≤ 62 jours → jour, ≤ ~2 ans (800 j) → mois, sinon année.
 * Basé sur end_time (UTC). Pur.
 */
export function computePeriodStats(
  games: Pick<ChesscomGame, 'end_time' | 'white' | 'black'>[],
  username: string,
): PeriodStats {
  const user = normalizeUsername(username);
  const times = games.filter((g) => g.end_time).map((g) => g.end_time);
  if (times.length === 0) return { granularity: 'month', rows: [] };
  const spanDays = (Math.max(...times) - Math.min(...times)) / 86400;
  const granularity: PeriodGranularity =
    spanDays <= 62 ? 'day' : spanDays <= 800 ? 'month' : 'year';
  const acc = new Map<string, PeriodStatRow>();
  for (const g of games) {
    if (!g.end_time) continue;
    const d = new Date(g.end_time * 1000);
    const y = d.getUTCFullYear();
    const m = d.getUTCMonth();
    const day = d.getUTCDate();
    let key: string;
    let label: string;
    let shortLabel: string;
    if (granularity === 'day') {
      const mm = String(m + 1).padStart(2, '0');
      const dd = String(day).padStart(2, '0');
      key = `${y}-${mm}-${dd}`;
      label = `${day} ${MONTH_SHORT_FR[m]} ${y}`;
      shortLabel = `${dd}/${mm}`;
    } else if (granularity === 'month') {
      const mm = String(m + 1).padStart(2, '0');
      key = `${y}-${mm}`;
      label = `${MONTH_SHORT_FR[m]} ${y}`;
      shortLabel = `${MONTH_SHORT_FR[m]} ${String(y).slice(2)}`;
    } else {
      key = `${y}`;
      label = `${y}`;
      shortLabel = `${y}`;
    }
    let row = acc.get(key);
    if (!row) {
      row = { key, label, shortLabel, games: 0, wins: 0, draws: 0, losses: 0 };
      acc.set(key, row);
    }
    row.games++;
    const outcome = outcomeFor(g, user);
    if (outcome === 'win') row.wins++;
    else if (outcome === 'draw') row.draws++;
    else row.losses++;
  }
  return {
    granularity,
    rows: [...acc.values()].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)),
  };
}

// ---------------------------------------------------------------------------
// Précision moyenne (jeux analysés uniquement).
// ---------------------------------------------------------------------------

export interface AccuracyPeriodRow {
  /** Clé de tri ISO : 'YYYY-MM-DD' | 'YYYY-MM' | 'YYYY'. */
  key: string;
  /** Libellé complet FR. */
  label: string;
  /** Libellé court pour l'axe du graphique. */
  shortLabel: string;
  /** Moyenne des précisions du compte lié sur la période. */
  avg: number;
  /** Parties analysées sur la période. */
  count: number;
}

export interface AccuracyStats {
  granularity: PeriodGranularity;
  /** Périodes avec au moins une partie analysée, ordre chronologique. */
  rows: AccuracyPeriodRow[];
  overallAvg: number | null;
  overallCount: number;
  winAvg: number | null;
  winCount: number;
  drawAvg: number | null;
  drawCount: number;
  lossAvg: number | null;
  lossCount: number;
}

function periodBucket(endTimeSec: number, granularity: PeriodGranularity): {
  key: string;
  label: string;
  shortLabel: string;
} {
  const d = new Date(endTimeSec * 1000);
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth();
  const day = d.getUTCDate();
  if (granularity === 'day') {
    const mm = String(m + 1).padStart(2, '0');
    const dd = String(day).padStart(2, '0');
    return {
      key: `${y}-${mm}-${dd}`,
      label: `${day} ${MONTH_SHORT_FR[m]} ${y}`,
      shortLabel: `${dd}/${mm}`,
    };
  }
  if (granularity === 'month') {
    const mm = String(m + 1).padStart(2, '0');
    return {
      key: `${y}-${mm}`,
      label: `${MONTH_SHORT_FR[m]} ${y}`,
      shortLabel: `${MONTH_SHORT_FR[m]} ${String(y).slice(2)}`,
    };
  }
  return { key: `${y}`, label: `${y}`, shortLabel: `${y}` };
}

/**
 * Précision moyenne du compte lié par période (même granularité adaptative
 * que les parties : jour / mois / année) + moyennes par issue. Seules les
 * parties ANALYSÉES (accuracy non nulle) comptent. Pur.
 */export function computeAccuracyStats(
  games: Pick<ChesscomGame, 'end_time' | 'white' | 'black' | 'accuracy'>[],
  username: string,
): AccuracyStats {
  const user = normalizeUsername(username);
  const empty: AccuracyStats = {
    granularity: 'month',
    rows: [],
    overallAvg: null,
    overallCount: 0,
    winAvg: null,
    winCount: 0,
    drawAvg: null,
    drawCount: 0,
    lossAvg: null,
    lossCount: 0,
  };
  const analyzed = games.filter(
    (g) => g.end_time && typeof g.accuracy === 'number' && Number.isFinite(g.accuracy),
  );
  if (analyzed.length === 0) return empty;
  const times = analyzed.map((g) => g.end_time);
  const spanDays = (Math.max(...times) - Math.min(...times)) / 86400;
  const granularity: PeriodGranularity =
    spanDays <= 62 ? 'day' : spanDays <= 800 ? 'month' : 'year';
  const acc = new Map<string, { label: string; shortLabel: string; sum: number; count: number }>();
  let winSum = 0;
  let drawSum = 0;
  let lossSum = 0;
  let winCount = 0;
  let drawCount = 0;
  let lossCount = 0;
  for (const g of analyzed) {
    const a = g.accuracy as number;
    const { key, label, shortLabel } = periodBucket(g.end_time, granularity);
    let row = acc.get(key);
    if (!row) {
      row = { label, shortLabel, sum: 0, count: 0 };
      acc.set(key, row);
    }
    row.sum += a;
    row.count++;
    const outcome = outcomeFor(g, user);
    if (outcome === 'win') {
      winSum += a;
      winCount++;
    } else if (outcome === 'draw') {
      drawSum += a;
      drawCount++;
    } else {
      lossSum += a;
      lossCount++;
    }
  }
  const overallCount = analyzed.length;
  const total = analyzed.reduce((s, g) => s + (g.accuracy as number), 0);
  return {
    granularity,
    rows: [...acc.entries()]
      .map(([key, r]) => ({
        key,
        label: r.label,
        shortLabel: r.shortLabel,
        avg: r.sum / r.count,
        count: r.count,
      }))
      .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)),
    overallAvg: total / overallCount,
    overallCount,
    winAvg: winCount > 0 ? winSum / winCount : null,
    winCount,
    drawAvg: drawCount > 0 ? drawSum / drawCount : null,
    drawCount,
    lossAvg: lossCount > 0 ? lossSum / lossCount : null,
    lossCount,
  };
}

// ---------------------------------------------------------------------------
// Précision par numéro de coup (agrégat incrémental, toutes couleurs + W/B).
// ---------------------------------------------------------------------------

export interface MoveNumberAgg {
  sum: number;
  n: number;
}

/**
 * Agrégat de précision par numéro de coup (1, 2, 3…), construit au fil des
 * analyses (batch + visionneuse) puis persisté tel quel (léger : ~centaines
 * d'entrées). `games` = URLs déjà comptées (anti double-comptage).
 */
export interface MoveAccuracyByNumber {
  games: string[];
  total: Record<string, MoveNumberAgg>;
  white: Record<string, MoveNumberAgg>;
  black: Record<string, MoveNumberAgg>;
}

export function emptyMoveAccuracy(): MoveAccuracyByNumber {
  return { games: [], total: {}, white: {}, black: {} };
}

function addToMoveAgg(
  rec: Record<string, MoveNumberAgg>,
  moveNo: number,
  accuracy: number,
): Record<string, MoveNumberAgg> {
  if (!Number.isInteger(moveNo) || moveNo < 1) return rec;
  const key = String(moveNo);
  const prev = rec[key];
  const next = { ...rec };
  next[key] = prev
    ? { sum: prev.sum + accuracy, n: prev.n + 1 }
    : { sum: accuracy, n: 1 };
  return next;
}

/**
 * Ajoute les plis d'une partie analysée à l'agrégat (numéro de coup =
 * ceil(pli / 2)). Ignore les URLs déjà comptées et les précisions non
 * finies. Pur (ne mute pas `prev`).
 */
export function addPliesToMoveAccuracy(
  prev: MoveAccuracyByNumber,
  url: string,
  plies: Array<{ ply?: number; color?: string; accuracy?: number }>,
): MoveAccuracyByNumber {
  if (!url || prev.games.includes(url)) return prev;
  let total = prev.total;
  let white = prev.white;
  let black = prev.black;
  let counted = false;
  plies.forEach((p, i) => {
    const a = p.accuracy;
    if (typeof a !== 'number' || !Number.isFinite(a)) return;
    const plyNo = Number.isInteger(p.ply) && (p.ply as number) > 0 ? (p.ply as number) : i + 1;
    const moveNo = Math.floor((plyNo - 1) / 2) + 1;
    total = addToMoveAgg(total, moveNo, a);
    if (p.color === 'white') white = addToMoveAgg(white, moveNo, a);
    else if (p.color === 'black') black = addToMoveAgg(black, moveNo, a);
    counted = true;
  });
  if (!counted) return prev;
  return { games: [...prev.games, url], total, white, black };
}

// ---------------------------------------------------------------------------
// Résultats par classement de l'adversaire (tranches de 100 Elo).
// ---------------------------------------------------------------------------

export interface OpponentRatingRow {
  /** Début de tranche (800 → « 800-899 »). */
  bucket: number;
  label: string;
  games: number;
  wins: number;
  draws: number;
  losses: number;
}

/**
 * Regroupe les parties par tranche de 100 Elo du CLASSEMENT ADVERSE
 * (0-99, 100-199, …), triées par Elo croissant. Les parties sans classement
 * adverse sont ignorées. Pur.
 */
export function computeOpponentRatingStats(
  games: Pick<ChesscomGame, 'white' | 'black'>[],
  username: string,
): OpponentRatingRow[] {
  const user = normalizeUsername(username);
  const acc = new Map<number, { games: number; wins: number; draws: number; losses: number }>();
  for (const g of games) {
    const mine: 'w' | 'b' = g.white.username.trim().toLowerCase() === user ? 'w' : 'b';
    const oppRating = mine === 'w' ? g.black.rating : g.white.rating;
    if (typeof oppRating !== 'number' || !Number.isFinite(oppRating) || oppRating <= 0) continue;
    const bucket = Math.floor(oppRating / 100) * 100;
    let row = acc.get(bucket);
    if (!row) {
      row = { games: 0, wins: 0, draws: 0, losses: 0 };
      acc.set(bucket, row);
    }
    row.games++;
    const outcome = outcomeFor(g, user);
    if (outcome === 'win') row.wins++;
    else if (outcome === 'draw') row.draws++;
    else row.losses++;
  }
  return [...acc.entries()]
    .map(([bucket, r]) => ({
      bucket,
      label: `${bucket}–${bucket + 99}`,
      games: r.games,
      wins: r.wins,
      draws: r.draws,
      losses: r.losses,
    }))
    .sort((a, b) => a.bucket - b.bucket);
}

// ---------------------------------------------------------------------------
// Maîtrise : suivi du répertoire en parties réelles.
// ---------------------------------------------------------------------------

/** Qui sort en premier de la théorie (livre = répertoires fusionnés). */
export type MasteryDeviator = 'me' | 'opponent' | 'none' | 'out-of-scope';

export interface MasteryGame {
  url: string;
  endTime: number;
  eco: string;
  name: string;
  myColor: 'w' | 'b';
  deviator: MasteryDeviator;
  /** N° du coup (1, 2, 3…) de MA première sortie de théorie, si c'est moi. */
  myDeviationMove: number | null;
}

/**
 * Fusionne les répertoires en table de théorie : FEN normalisé → UCIs
 * standard attendus (roques Lichess e1h1 normalisées en e1g1 pour comparer
 * au replay chess.js). Pur.
 */
export function buildMasteryTheory(
  roots: Array<RepertoireRoot | null | undefined>,
): Map<string, string[]> {
  const theory = new Map<string, Set<string>>();
  for (const root of roots) {
    if (!root) continue;
    const { fenToChildren } = indexRepertoire(root);
    for (const [fen, children] of fenToChildren) {
      let set = theory.get(fen);
      if (!set) {
        set = new Set<string>();
        theory.set(fen, set);
      }
      for (const m of children) {
        if (m.uci) set.add(normalizeCastleUci(fen, m.uci));
      }
    }
  }
  return new Map([...theory].map(([fen, set]) => [fen, [...set]] as [string, string[]]));
}

/**
 * Rejoue chaque partie contre la théorie : le premier coup (de n'importe
 * quel camp) absent du livre désigne le déviateur. Sortir d'une fin de
 * ligne compte comme dévier (on n'est plus en prep). Parties hors livre
 * dès le départ (aucun répertoire) ou aux coups illisibles : `out-of-scope`.
 * Pur (replay chess.js local, sans moteur).
 */
export function analyzeMasteryGames(
  games: Pick<ChesscomGame, 'url' | 'sans' | 'white' | 'black' | 'eco' | 'opening' | 'end_time'>[],
  username: string,
  theory: Map<string, string[]>,
): MasteryGame[] {
  const user = normalizeUsername(username);
  const startMoves = theory.get(normalizeFen(INITIAL_FEN)) ?? [];
  return games.map((g) => {
    const mine: 'w' | 'b' = g.white.username.trim().toLowerCase() === user ? 'w' : 'b';
    const base = {
      url: g.url,
      endTime: g.end_time,
      eco: g.eco,
      name: g.opening,
      myColor: mine,
    };
    if (startMoves.length === 0 || !g.sans || g.sans.length === 0) {
      return { ...base, deviator: 'out-of-scope' as const, myDeviationMove: null };
    }
    let board: Chess;
    try {
      board = new Chess(INITIAL_FEN);
    } catch {
      return { ...base, deviator: 'out-of-scope' as const, myDeviationMove: null };
    }
    for (let i = 0; i < g.sans.length; i++) {
      const expected = theory.get(normalizeFen(board.fen()));
      let playedUci: string;
      try {
        const mv = board.move(g.sans[i]);
        playedUci = mv.from + mv.to + (mv.promotion ?? '');
      } catch {
        return { ...base, deviator: 'out-of-scope' as const, myDeviationMove: null };
      }
      if (!expected || !expected.includes(playedUci)) {
        const moverIsMe = (i % 2 === 0) === (mine === 'w');
        return {
          ...base,
          deviator: moverIsMe ? ('me' as const) : ('opponent' as const),
          myDeviationMove: moverIsMe ? Math.floor(i / 2) + 1 : null,
        };
      }
    }
    return { ...base, deviator: 'none' as const, myDeviationMove: null };
  });
}

export interface MasteryTrendRow {
  key: string;
  label: string;
  shortLabel: string;
  /** Coups théoriques moyens (avant MA déviation). */
  avg: number;
  count: number;
}

export interface MasteryTrend {
  granularity: PeriodGranularity;
  /** Ordre chronologique (anciennes à gauche). */
  rows: MasteryTrendRow[];
}

/**
 * Coups théoriques moyens par période (même granularité adaptative que les
 * parties : jour / mois / année). Entrée : fins déjà filtrées (en général
 * mes déviations). Pur.
 */
export function computeMasteryTrend(
  games: Array<{ endTime: number; theoryMoves: number }>,
): MasteryTrend {
  const dated = games.filter((g) => g.endTime);
  if (dated.length === 0) return { granularity: 'month', rows: [] };
  const times = dated.map((g) => g.endTime);
  const spanDays = (Math.max(...times) - Math.min(...times)) / 86400;
  const granularity: PeriodGranularity =
    spanDays <= 62 ? 'day' : spanDays <= 800 ? 'month' : 'year';
  const acc = new Map<string, { label: string; shortLabel: string; sum: number; count: number }>();
  for (const g of dated) {
    const { key, label, shortLabel } = periodBucket(g.endTime, granularity);
    let row = acc.get(key);
    if (!row) {
      row = { label, shortLabel, sum: 0, count: 0 };
      acc.set(key, row);
    }
    row.sum += g.theoryMoves;
    row.count++;
  }
  return {
    granularity,
    rows: [...acc.entries()]
      .map(([key, r]) => ({ key, label: r.label, shortLabel: r.shortLabel, avg: r.sum / r.count, count: r.count }))
      .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)),
  };
}

export interface MasteryOpeningRow {
  key: string;
  eco: string;
  name: string;
  /** Parties dans le périmètre (théorie + couleur). */
  total: number;
  /** % de parties où JE dévie en premier (0-100). */
  devFirstShare: number;
  /** Coup moyen de MA déviation (null si jamais moi). */
  avgDevMove: number | null;
}

/**
 * Maîtrise par ouverture (ECO) pour une couleur jouée : volume, part de
 * parties où je dévie en premier, coup moyen de ma déviation. Triées par
 * volume décroissant. Pur et testé.
 */
export function computeMasteryOpenings(
  games: MasteryGame[],
  myColor: 'w' | 'b',
): MasteryOpeningRow[] {
  const acc = new Map<string, { eco: string; name: string; total: number; devFirst: number; devMoveSum: number }>();
  for (const g of games) {
    if (g.myColor !== myColor || g.deviator === 'out-of-scope') continue;
    const key = g.eco && g.eco !== '?' ? g.eco : g.name ? `~${g.name}` : '?';
    let row = acc.get(key);
    if (!row) {
      row = { eco: g.eco, name: g.name, total: 0, devFirst: 0, devMoveSum: 0 };
      acc.set(key, row);
    }
    if (!row.name && g.name) row.name = g.name;
    row.total++;
    if (g.deviator === 'me' && g.myDeviationMove !== null) {
      row.devFirst++;
      row.devMoveSum += g.myDeviationMove;
    }
  }
  return [...acc.entries()]
    .map(([key, r]) => ({
      key,
      eco: key.startsWith('~') ? '?' : key,
      name: r.name,
      total: r.total,
      devFirstShare: r.total > 0 ? (r.devFirst / r.total) * 100 : 0,
      avgDevMove: r.devFirst > 0 ? r.devMoveSum / r.devFirst : null,
    }))
    .sort((a, b) => b.total - a.total);
}

// ---------------------------------------------------------------------------
// Phases de la partie (fin / précision / résultats par phase).
// ---------------------------------------------------------------------------

export const PHASE_ORDER: PhaseName[] = ['opening', 'middlegame', 'endgame'];

export const PHASE_LABELS: Record<PhaseName, string> = {
  opening: 'Ouverture',
  middlegame: 'Milieu de jeu',
  endgame: 'Finale',
};

/** Cumul V/N/D + précision d'un périmètre (total ou une couleur jouée). */
export interface PhaseSideStat {
  games: number;
  wins: number;
  draws: number;
  losses: number;
  accSum: number;
  accN: number;
}

export interface PhaseStatRow {
  phase: PhaseName;
  total: PhaseSideStat;
  /** Parties jouées avec les Blancs. */
  white: PhaseSideStat;
  /** Parties jouées avec les Noirs. */
  black: PhaseSideStat;
}

function emptyPhaseSideStat(): PhaseSideStat {
  return { games: 0, wins: 0, draws: 0, losses: 0, accSum: 0, accN: 0 };
}

function tallyPhaseSideStat(
  row: PhaseSideStat,
  outcome: ChesscomOutcome,
  accuracy: number | null | undefined,
): void {
  row.games++;
  if (outcome === 'win') row.wins++;
  else if (outcome === 'draw') row.draws++;
  else row.losses++;
  if (typeof accuracy === 'number' && Number.isFinite(accuracy)) {
    row.accSum += accuracy;
    row.accN++;
  }
}

/**
 * Regroupe les parties par phase de FIN (même convention que les rapports :
 * ouverture ≤ 20 plis, milieu ≤ 60, sinon finale), avec détail par couleur
 * jouée et précision moyenne du compte lié. Les parties aux coups illisibles
 * (0 pli) sont exclues. Pur et testé.
 */
export function computePhaseStats(
  games: Pick<ChesscomGame, 'sans' | 'white' | 'black' | 'accuracy'>[],
  username: string,
): PhaseStatRow[] {
  const user = normalizeUsername(username);
  const rows = new Map<PhaseName, PhaseStatRow>();
  for (const g of games) {
    if (!g.sans || g.sans.length === 0) continue;
    const phase = phaseOfPly(g.sans.length);
    let row = rows.get(phase);
    if (!row) {
      row = { phase, total: emptyPhaseSideStat(), white: emptyPhaseSideStat(), black: emptyPhaseSideStat() };
      rows.set(phase, row);
    }
    const mine: 'w' | 'b' = g.white.username.trim().toLowerCase() === user ? 'w' : 'b';
    const outcome = outcomeFor(g, user);
    tallyPhaseSideStat(row.total, outcome, g.accuracy);
    tallyPhaseSideStat(mine === 'w' ? row.white : row.black, outcome, g.accuracy);
  }
  return PHASE_ORDER.filter((p) => rows.has(p)).map((p) => rows.get(p) as PhaseStatRow);
}

// ---------------------------------------------------------------------------
// Forme narrative de la partie (depuis la trajectoire Win%).
// ---------------------------------------------------------------------------

/** Forme de partie : un seul récit par partie (premier motif qui colle). */
export type GameShape =
  | 'gachee'
  | 'intense'
  | 'abrupte'
  | 'tendue'
  | 'tranquille'
  | 'mouvementee'
  | 'equilibree';

export const GAME_SHAPE_LABELS: Record<GameShape, string> = {
  gachee: 'Gâchée',
  intense: 'Intense',
  abrupte: 'Abrupte',
  tendue: 'Tendue',
  tranquille: 'Tranquille',
  mouvementee: 'Mouvementée',
  equilibree: 'Équilibrée',
};

export const GAME_SHAPE_DESCRIPTIONS: Record<GameShape, string> = {
  gachee: 'Un joueur était en train de gagner, mais a gâché sa chance',
  intense: 'Une partie sérieuse !',
  abrupte: 'Une partie serrée, perdue à cause d’une erreur',
  tendue: 'Une partie à rebondissements où les deux joueurs ont eu leur chance',
  tranquille: 'Un joueur a pris l’avantage et ne l’a plus lâché',
  mouvementee: 'Une partie chaotique où les deux joueurs ont eu plusieurs chances de gagner',
  equilibree: 'Aucun des deux joueurs n’a pris l’avantage',
};

/** Ordre d'affichage (barre + légende). */
export const GAME_SHAPE_ORDER: GameShape[] = [
  'gachee',
  'intense',
  'abrupte',
  'tendue',
  'tranquille',
  'mouvementee',
  'equilibree',
];

/** Seuils de lecture d'une trajectoire Win% Blancs (0-100). */
const SHAPE_BIG_LEAD = 75; // au-delà : un camp a une vraie chance
const SHAPE_TIGHT = 15; // |Win% − 50| : partie serrée
const SHAPE_SWING = 20; // variation d'un coup : l'erreur qui décide
const SHAPE_SCARE = 10; // rechute : plus d'une frayeur = disputée

/**
 * Classifie le récit d'une partie depuis sa trajectoire Win% Blancs
 * (après chaque coup) + issue côté Blancs. Règles ordonnées, disjointes :
 * équilibrée (personne ne décolle), mouvementée (≥ 3 bascules), tendue
 * (les deux ont eu leur chance), gâchée (le meneur n'a pas gagné),
 * abrupte (serrée puis une erreur), tranquille (avantage tenu),
 * intense (décisive disputée, sinon). Pur et testé.
 */
export function classifyGameShape(
  whiteWins: number[],
  whiteWon: boolean,
  isDraw: boolean,
): GameShape {
  const start = whiteCpToWinChance(INITIAL_CP);
  const xs = [start, ...whiteWins.filter((w) => typeof w === 'number' && Number.isFinite(w))];
  const peak = Math.max(...xs);
  const trough = Math.min(...xs);
  const whiteBig = peak >= SHAPE_BIG_LEAD;
  const blackBig = trough <= 100 - SHAPE_BIG_LEAD;
  // Bascules : changements de meneur (seuil 50, rare égalité flottante).
  let changes = 0;
  for (let i = 1; i < xs.length; i++) {
    if (xs[i] >= 50 !== xs[i - 1] >= 50) changes++;
  }
  // 1. Personne n'a pris l'avantage.
  if (!whiteBig && !blackBig) return 'equilibree';
  // 2. Chaotique : plusieurs chances de chaque côté.
  if (changes >= 3) return 'mouvementee';
  // 3. Rebondissements : les deux ont eu leur chance.
  if (whiteBig && blackBig) return 'tendue';
  // 4. Le meneur n'a pas gagné.
  const leaderWhite = whiteBig;
  const leaderWon = leaderWhite ? whiteWon : !whiteWon && !isDraw;
  if (!leaderWon) return 'gachee';
  // 5. Menée puis gagnée : serrée + une erreur qui décide.
  let maxSwing = 0;
  for (let i = 1; i < xs.length; i++) {
    maxSwing = Math.max(maxSwing, Math.abs(xs[i] - xs[i - 1]));
  }
  const tightFrac = xs.filter((w) => Math.abs(w - 50) <= SHAPE_TIGHT).length / xs.length;
  if (maxSwing >= SHAPE_SWING && tightFrac >= 0.5) return 'abrupte';
  // 6. Avantage pris puis tenu (au plus une frayeur de ≥ 10 points,
  //    point de vue du meneur : chaque rechute entame un nouveau palier).
  let scares = 0;
  let legPeak = -Infinity;
  for (const w of xs) {
    const pov = leaderWhite ? w : 100 - w;
    if (pov > legPeak) legPeak = pov;
    else if (legPeak - pov >= SHAPE_SCARE) {
      scares++;
      legPeak = pov;
    }
  }
  if (scares <= 1) return 'tranquille';
  // 7. Décisive disputée.
  return 'intense';
}

// ---------------------------------------------------------------------------
// Qualité des coups : 9 catégories (façon revue chess.com).
// ---------------------------------------------------------------------------

/** Catégorie d'un coup (un seul récit par coup, premier motif qui colle). */
export type MoveQuality =
  | 'brillant'
  | 'genial'
  | 'meilleur'
  | 'tres-bien'
  | 'bon'
  | 'theorique'
  | 'imprecision'
  | 'erreur'
  | 'gaffe'
  | 'gain-manque';

export const MOVE_QUALITY_ORDER: MoveQuality[] = [
  'brillant',
  'genial',
  'meilleur',
  'tres-bien',
  'bon',
  'theorique',
  'imprecision',
  'erreur',
  'gaffe',
  'gain-manque',
];

/** Ordre avant l'ajout de 'genial' (persistance 9 entrées) : mapping par nom. */
const LEGACY_QUALITY_ORDER: MoveQuality[] = [
  'brillant',
  'meilleur',
  'tres-bien',
  'bon',
  'theorique',
  'imprecision',
  'erreur',
  'gaffe',
  'gain-manque',
];

export const MOVE_QUALITY_LABELS: Record<MoveQuality, string> = {
  brillant: 'Brillant',
  genial: 'Génial',
  meilleur: 'Meilleur',
  'tres-bien': 'Très bien',
  bon: 'Bon',
  theorique: 'Théorique',
  imprecision: 'Imprécision',
  erreur: 'Erreur',
  gaffe: 'Gaffe',
  'gain-manque': 'Gain manqué',
};

export const MOVE_QUALITY_COLORS: Record<MoveQuality, string> = {
  brillant: '#8fb996',
  genial: '#d8d2c6',
  meilleur: '#8fb996',
  'tres-bien': '#8fb996',
  bon: '#9a9488',
  theorique: '#d29e6a',
  imprecision: '#ead9b5',
  erreur: '#d29e6a',
  gaffe: '#d8816f',
  'gain-manque': '#d29e6a',
};

/** Premiers plis considérés comme théorie (livre d'ouvertures). */
const QUALITY_BOOK_PLIES = 10;
/** Précision Lichess à partir de laquelle un bon coup est « très bien ». */
const QUALITY_GREAT_ACCURACY = 90;
/**
 * Seuils Win% pov joueur calés sur le modèle « Expected Points » V2 de
 * chess.com (bandes 0.00/0.02/0.05/0.10/0.20 — identiques à nos 0/2/5/10/20 ;
 * seule la courbe Win% diffère : logistique Lichess rating-blind contre
 * courbe data-science rating-dépendante). La générosité Elo de chess.com
 * (Great/Brilliant plus faciles à bas Elo) n'est pas modélisée.
 */
const QUALITY_WINNING = 75; // position gagnante (cf. SHAPE_BIG_LEAD)
const QUALITY_LOSING = 40; // position perdante (retournement Great)
const QUALITY_EQUAL = 50;
const QUALITY_MISS_GAP = 10; // écart best − joué d'un gain manqué
const QUALITY_NO_WORSEN = 5; // tolérance « position non aggravée » (Miss)
const QUALITY_BRILLIANT_AFTER = 50; // pas en mauvaise posture après
const QUALITY_BRILLIANT_BEFORE = 90; // pas déjà complètement gagnant avant

export interface QualityPly {
  annotation?: string;
  isBest?: boolean;
  isOnlySound?: boolean;
  isSacrifice?: boolean;
  bestMate?: number;
  accuracy?: number;
  ply?: number;
  color?: 'white' | 'black';
  /** Win% Blancs APRÈS le coup (0..100) — présent sur AnalyzedPly. */
  whiteWin?: number;
  /** Perte Win% pov joueur best − joué (≥ 0) — présent sur AnalyzedPly. */
  winLoss?: number;
  /** Eval blanche du meilleur coup (dérive bestPovWin sinon). */
  bestWhiteCp?: number;
  /** Overrides directs (tests) : Win% pov joueur. */
  beforePovWin?: number;
  afterPovWin?: number;
  bestPovWin?: number;
}

interface QualityPovs {
  before: number | null;
  after: number | null;
  best: number | null;
}

/**
 * Replie les Win% côté joueur. `prevWhiteWin` = Win% Blancs du pli
 * précédent (chaîne before = after précédent, comme buildGameReport).
 */
function resolveQualityPovs(ply: QualityPly, prevWhiteWin: number | null): QualityPovs {
  const color = ply.color === 'black' ? 'black' : 'white';
  const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
  const after = finite(ply.afterPovWin)
    ? ply.afterPovWin as number
    : finite(ply.whiteWin)
      ? whiteWinToPov(ply.whiteWin as number, color)
      : null;
  const best = finite(ply.bestPovWin)
    ? ply.bestPovWin as number
    : finite(ply.bestWhiteCp)
      ? whiteWinToPov(whiteCpToWinChance(ply.bestWhiteCp as number), color)
      : after !== null && finite(ply.winLoss)
        ? after + Math.max(0, ply.winLoss as number)
        : null;
  const before = finite(ply.beforePovWin)
    ? ply.beforePovWin as number
    : finite(prevWhiteWin)
      ? whiteWinToPov(prevWhiteWin as number, color)
      : null;
  return { before, after, best };
}

/**
 * Classifie UN coup façon revue chess.com (Classification V2).
 * Priorité : gain manqué (Miss, sans aggravation), gaffe, erreur,
 * brillant (sacrifice + meilleur/quasi + position compétitive), génial
 * (Great : seul bon coup ou retournement), très bien (!/!?) ,
 * imprécision (y compris d'ouverture : le livre ne couvre que les coups
 * sains), théorique, meilleur, très bien (précision), bon.
 * `prevWhiteWin` = Win% Blancs du pli précédent (chaîne des befores).
 * Pur et testé.
 */
export function classifyMoveQuality(ply: QualityPly, prevWhiteWin: number | null = null): MoveQuality {
  const annotation = ply.annotation ?? '';
  const { before, after, best } = resolveQualityPovs(ply, prevWhiteWin);
  const known = (v: number | null): v is number => typeof v === 'number' && Number.isFinite(v);
  // Position non aggravée (ou inconnue : on ne déclasse pas sans preuve).
  const noWorsen = !known(before) || !known(after) || after >= before - QUALITY_NO_WORSEN;

  // 1. Gain manqué : mat manqué OU occasion gagnante manquée (tactique
  //    ratée en restant à égalité — pas un Blunder). Antérieur à ?? :
  //    rater une fourchette sans rien perdre, c'est un Miss.
  const missedMate = !ply.isBest
    && typeof ply.bestMate === 'number' && Number.isFinite(ply.bestMate) && ply.bestMate > 0;
  const mateGapOk = !known(best) || !known(after) || best - after >= 1;
  if (missedMate && noWorsen && mateGapOk) return 'gain-manque';
  if (!ply.isBest && known(best) && known(after)
    && best - after >= QUALITY_MISS_GAP && best >= QUALITY_WINNING && after < QUALITY_WINNING
    && noWorsen) {
    return 'gain-manque';
  }

  // 2. Gaffe / Erreur (bandes EP V2 : 0.20 / 0.10).
  if (annotation === '??') return 'gaffe';
  if (annotation === '?') return 'erreur';

  // 3. Brillant (V2) : sacrifice + meilleur ou quasi, sans être déjà
  //    gagnant avant ni mal après. Pas d'exigence de « seul coup »
  //    (contrairement à l'ancien mapping !! strict).
  if (annotation === '!!') {
    if (!(known(before) && before > QUALITY_BRILLIANT_BEFORE)) return 'brillant';
    // Sacrifice en position déjà gagnée : beau mais pas brillant → retombe.
  }
  if (ply.isSacrifice === true && ply.isBest === true && known(after) && known(before)
    && after >= QUALITY_BRILLIANT_AFTER && before <= QUALITY_BRILLIANT_BEFORE) {
    return 'brillant';
  }

  // 4. Génial (Great V2 : « ! ») : seul bon coup trouvé, ou coup critique
  //    qui retourne la partie (perdant→égal, égal→gagnant).
  if (annotation === '!') return 'genial';
  if (ply.isBest === true && (ply.isOnlySound === true
    || (known(before) && known(after)
      && ((before < QUALITY_LOSING && after >= QUALITY_EQUAL)
        || (before < QUALITY_WINNING - 5 && after >= QUALITY_WINNING))))) {
    return 'genial';
  }

  // 5. Intéressant (!?) : sacrifice correct mais non brillant.
  if (annotation === '!?') return 'tres-bien';

  // 6. Imprécision AVANT Théorique : une ?! d'ouverture reste une
  //    imprécision (le livre ne couvre que les coups sains).
  if (annotation === '?!') return 'imprecision';

  // 7. Théorique : début de partie sans annotation négative.
  if (typeof ply.ply === 'number' && ply.ply <= QUALITY_BOOK_PLIES) return 'theorique';

  // 8. Meilleur (choix moteur, ou perte nulle : mat alternatif à égalité —
  //    EP 0.00 comme chess.com) / Très bien (précision ≥ 90 ≈ Excellent V2
  //    ≤ 0.02) / Bon.
  if (ply.isBest || (known(best) && known(after) && best - after <= 0)) return 'meilleur';
  if (typeof ply.accuracy === 'number' && ply.accuracy >= QUALITY_GREAT_ACCURACY) return 'tres-bien';
  return 'bon';
}

export interface MoveQualityCounts {
  total: Record<MoveQuality, number>;
  /** Coups des Blancs. */
  white: Record<MoveQuality, number>;
  /** Coups des Noirs. */
  black: Record<MoveQuality, number>;
}

function emptyQualityRecord(): Record<MoveQuality, number> {
  return {
    brillant: 0,
    genial: 0,
    meilleur: 0,
    'tres-bien': 0,
    bon: 0,
    theorique: 0,
    imprecision: 0,
    erreur: 0,
    gaffe: 0,
    'gain-manque': 0,
  };
}

export function emptyMoveQualityCounts(): MoveQualityCounts {
  return { total: emptyQualityRecord(), white: emptyQualityRecord(), black: emptyQualityRecord() };
}

/**
 * Ventile les plis analysés par qualité (total + couleur jouée).
 * `color` = camp du joueur du pli ('white' | 'black'). La Win% Blancs
 * chemine (before = after précédent, position initiale en tête comme
 * buildGameReport) pour les règles Miss/Great/Brilliant. Pur et testé.
 */
export function computeGameMoveQuality(
  plies: Array<QualityPly & { color?: string }>,
): MoveQualityCounts {
  const counts = emptyMoveQualityCounts();
  let prevWhiteWin: number | null = whiteCpToWinChance(INITIAL_CP);
  for (const p of plies) {
    const q = classifyMoveQuality(p, prevWhiteWin);
    counts.total[q]++;
    if (p.color === 'white') counts.white[q]++;
    else if (p.color === 'black') counts.black[q]++;
    if (typeof p.whiteWin === 'number' && Number.isFinite(p.whiteWin)) prevWhiteWin = p.whiteWin;
  }
  return counts;
}

/** Compteurs compacts persistés (ordre MOVE_QUALITY_ORDER). */
export function moveQualityToArrays(counts: MoveQualityCounts): { q: number[]; qw: number[]; qb: number[] } {
  const pack = (rec: Record<MoveQuality, number>): number[] =>
    MOVE_QUALITY_ORDER.map((c) => rec[c] ?? 0);
  return { q: pack(counts.total), qw: pack(counts.white), qb: pack(counts.black) };
}

/** Lecture tolérante des compteurs persistés (corrompu → zéros). */
export function moveQualityFromArrays(q: unknown, qw: unknown, qb: unknown): MoveQualityCounts {
  const clean = (v: unknown): number =>
    typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0;
  const read = (src: unknown): Record<MoveQuality, number> => {
    const rec = emptyQualityRecord();
    if (Array.isArray(src)) {
      // 9 entrées = persistance d'avant 'genial' : mapping par nom
      // (un mapping positionnel décalerait tout après 'brillant').
      const order = src.length === LEGACY_QUALITY_ORDER.length ? LEGACY_QUALITY_ORDER : MOVE_QUALITY_ORDER;
      order.forEach((c, i) => {
        rec[c] = clean(src[i]);
      });
    }
    return rec;
  };
  return { total: read(q), white: read(qw), black: read(qb) };
}

// ---------------------------------------------------------------------------
// Pièces : coups joués par pièce + précision moyenne (total + par phase).
// ---------------------------------------------------------------------------

export const PIECE_ORDER: PieceKind[] = ['p', 'n', 'b', 'r', 'q', 'k'];

export const PIECE_LABELS: Record<PieceKind, string> = {
  p: 'Pion',
  n: 'Cavalier',
  b: 'Fou',
  r: 'Tour',
  q: 'Dame',
  k: 'Roi',
};

export const PIECE_GLYPHS: Record<PieceKind, string> = {
  p: '♟',
  n: '♞',
  b: '♝',
  r: '♜',
  q: '♛',
  k: '♚',
};

export const PIECE_COLORS: Record<PieceKind, string> = {
  p: '#9a9488',
  n: '#d29e6a',
  b: '#8fb996',
  r: '#d29e6a',
  q: '#d8816f',
  k: '#d8d2c6',
};

/** Phases dans l'ordre d'affichage (cf. `phaseOfPly`). */
export const PIECE_PHASE_ORDER: PhaseName[] = ['opening', 'middlegame', 'endgame'];

export interface PiecePhaseStat {
  /** Coups joués par pièce sur la phase. */
  counts: Record<PieceKind, number>;
  /** Somme des précisions Lichess (moyenne = accSum / counts). */
  accSum: Record<PieceKind, number>;
}

export interface PieceStats {
  opening: PiecePhaseStat;
  middlegame: PiecePhaseStat;
  endgame: PiecePhaseStat;
}

function emptyPiecePhaseStat(): PiecePhaseStat {
  return {
    counts: { p: 0, n: 0, b: 0, r: 0, q: 0, k: 0 },
    accSum: { p: 0, n: 0, b: 0, r: 0, q: 0, k: 0 },
  };
}

export function emptyPieceStats(): PieceStats {
  return {
    opening: emptyPiecePhaseStat(),
    middlegame: emptyPiecePhaseStat(),
    endgame: emptyPiecePhaseStat(),
  };
}

export interface PiecePly {
  piece?: unknown;
  san?: string;
  accuracy?: number;
  ply?: number;
}

function asPieceKind(v: unknown, san: string): PieceKind {
  if (typeof v === 'string' && (PIECE_ORDER as string[]).includes(v)) return v as PieceKind;
  return pieceFromSan(san);
}

/**
 * Ventile les plis analysés par pièce jouée et phase, avec la précision
 * cumulée pour la moyenne. Les plis sans précision finie sont ignorés
 * (position isolée en échec). Pur et testé.
 */
export function computeGamePieceStats(plies: PiecePly[]): PieceStats {
  const stats = emptyPieceStats();
  plies.forEach((p, i) => {
    if (typeof p?.accuracy !== 'number' || !Number.isFinite(p.accuracy)) return;
    const piece = asPieceKind(p.piece, p.san ?? '');
    const phase = phaseOfPly(typeof p.ply === 'number' ? p.ply : i + 1);
    stats[phase].counts[piece]++;
    stats[phase].accSum[piece] += p.accuracy as number;
  });
  return stats;
}

/**
 * Ajoute les compteurs d'une partie à l'agrégat (somme sur l'historique
 * pour le panel). Pur et testé.
 */
export function addPieceStatsInto(target: PieceStats, src: PieceStats): PieceStats {
  for (const phase of PIECE_PHASE_ORDER) {
    for (const piece of PIECE_ORDER) {
      target[phase].counts[piece] += src[phase]?.counts[piece] ?? 0;
      target[phase].accSum[piece] += src[phase]?.accSum[piece] ?? 0;
    }
  }
  return target;
}

/**
 * Compteurs compacts persistés (3 phases × 6 pièces : effectifs puis
 * moyennes arrondies au dixième). Les moyennes se réagrègent exactement
 * via moyenne × effectif (cf. `pieceStatsFromArrays`).
 */
export function pieceStatsToArrays(stats: PieceStats): { pc: number[]; pa: number[] } {
  const pc: number[] = [];
  const pa: number[] = [];
  for (const phase of PIECE_PHASE_ORDER) {
    for (const piece of PIECE_ORDER) {
      const n = stats[phase]?.counts[piece] ?? 0;
      pc.push(n);
      pa.push(n > 0 ? Math.round(((stats[phase]?.accSum[piece] ?? 0) / n) * 10) / 10 : 0);
    }
  }
  return { pc, pa };
}

/** Lecture tolérante des compteurs persistés (corrompu → zéros). */
export function pieceStatsFromArrays(pc: unknown, pa: unknown): PieceStats {
  const stats = emptyPieceStats();
  const counts = Array.isArray(pc) ? pc : [];
  const avgs = Array.isArray(pa) ? pa : [];
  PIECE_PHASE_ORDER.forEach((phase, pi) => {
    PIECE_ORDER.forEach((piece, i) => {
      const idx = pi * PIECE_ORDER.length + i;
      const n = counts[idx];
      const a = avgs[idx];
      const count = typeof n === 'number' && Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
      const avg = typeof a === 'number' && Number.isFinite(a) && a >= 0 ? Math.min(100, a) : 0;
      stats[phase].counts[piece] = count;
      stats[phase].accSum[piece] = avg * count;
    });
  });
  return stats;
}

export interface QualityTrendRow {
  key: string;
  label: string;
  shortLabel: string;
  total: Record<MoveQuality, number>;
  white: Record<MoveQuality, number>;
  black: Record<MoveQuality, number>;
  /** Coups analysés sur la période. */
  moves: number;
}

export interface QualityTrend {
  granularity: PeriodGranularity;
  /** Ordre chronologique (anciennes à gauche). */
  rows: QualityTrendRow[];
}

/**
 * Qualité des coups au fil du temps (granularité adaptative jour/mois/an,
 * UN seul graphe à 100 %). Entrée : fins de parties classées datées.
 * Pur et testé.
 */
export function computeQualityTrend(
  games: Array<{ endTime: number; quality: MoveQualityCounts }>,
): QualityTrend {
  const dated = games.filter((g) => g.endTime);
  if (dated.length === 0) return { granularity: 'month', rows: [] };
  const times = dated.map((g) => g.endTime);
  const spanDays = (Math.max(...times) - Math.min(...times)) / 86400;
  const granularity: PeriodGranularity =
    spanDays <= 62 ? 'day' : spanDays <= 800 ? 'month' : 'year';
  const acc = new Map<string, { label: string; shortLabel: string; counts: MoveQualityCounts; moves: number }>();
  for (const g of dated) {
    const { key, label, shortLabel } = periodBucket(g.endTime, granularity);
    let row = acc.get(key);
    if (!row) {
      row = { label, shortLabel, counts: emptyMoveQualityCounts(), moves: 0 };
      acc.set(key, row);
    }
    for (const c of MOVE_QUALITY_ORDER) {
      row.counts.total[c] += g.quality.total[c] ?? 0;
      row.counts.white[c] += g.quality.white[c] ?? 0;
      row.counts.black[c] += g.quality.black[c] ?? 0;
    }
    row.moves += MOVE_QUALITY_ORDER.reduce((sum, c) => sum + (g.quality.total[c] ?? 0), 0);
  }
  return {
    granularity,
    rows: [...acc.entries()]
      .map(([key, r]) => ({ key, label: r.label, shortLabel: r.shortLabel, total: r.counts.total, white: r.counts.white, black: r.counts.black, moves: r.moves }))
      .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)),
  };
}

// ---------------------------------------------------------------------------
// Pièces gratuites : pièces adverses en prise, prises ou ignorées.
// ---------------------------------------------------------------------------

export interface FreebieCounts {
  found: Record<HungPiece, number>;
  missed: Record<HungPiece, number>;
}

export function emptyFreebieCounts(): FreebieCounts {
  return {
    found: { p: 0, n: 0, b: 0, r: 0, q: 0 },
    missed: { p: 0, n: 0, b: 0, r: 0, q: 0 },
  };
}

/** Compteurs compacts persistés (ordre HUNG_PIECE_ORDER). */
export function freebieCountsToArrays(counts: FreebieCounts): { gf: number[]; gm: number[] } {
  return {
    gf: HUNG_PIECE_ORDER.map((p) => counts.found[p] ?? 0),
    gm: HUNG_PIECE_ORDER.map((p) => counts.missed[p] ?? 0),
  };
}

/** Lecture tolérante des compteurs persistés (corrompu → zéros). */
export function freebieCountsFromArrays(gf: unknown, gm: unknown): FreebieCounts {
  const out = emptyFreebieCounts();
  const read = (src: unknown): Record<HungPiece, number> => {
    const rec = { ...out.found };
    if (Array.isArray(src)) {
      HUNG_PIECE_ORDER.forEach((p, i) => {
        const v = src[i];
        rec[p] = typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0;
      });
    }
    return rec;
  };
  return { found: read(gf), missed: read(gm) };
}

/**
 * Pièces GRATUITES (adversaire en prise) : à chacun de MES coups, capturer
 * une pièce adverse pendante = trouvée ; laisser passer (chaque épisode
 * compte une fois) = manquée. En passant géré (case capturée ≠ arrivée).
 * Pur (replay chess.js local, sans moteur).
 */
export function detectUserFreebies(sans: string[], myColor: 'w' | 'b'): FreebieCounts {
  const counts = emptyFreebieCounts();
  const opp = myColor === 'w' ? 'b' : 'w';
  let board: Chess;
  try {
    board = new Chess(INITIAL_FEN);
  } catch {
    return counts;
  }
  let prevFree = new Map<string, HungPiece>();
  const charged = new Set<string>();
  for (let i = 0; i < sans.length; i++) {
    const mover = i % 2 === 0 ? 'w' : 'b';
    let capturedKey: string | null = null;
    let capturedType: HungPiece | null = null;
    try {
      const mv = board.move(sans[i]);
      if (mv.captured && mover === myColor) {
        const capturedSquare = mv.flags.includes('e') ? mv.to[0] + mv.from[1] : mv.to;
        capturedKey = `${mv.captured}@${capturedSquare}`;
        if (mv.captured !== 'k') capturedType = mv.captured as HungPiece;
      }
    } catch {
      break; // coups illisibles : on garde le partiel
    }
    const hanging = hangingPieces(board, opp);
    if (mover === myColor) {
      if (capturedKey && capturedType && prevFree.has(capturedKey)) {
        counts.found[capturedType]++;
      }
      for (const [key, piece] of prevFree) {
        if (key !== capturedKey && !charged.has(key)) {
          counts.missed[piece]++;
          charged.add(key);
        }
      }
    }
    for (const key of [...charged]) {
      if (!hanging.has(key)) charged.delete(key);
    }
    prevFree = hanging;
  }
  return counts;
}

// ---------------------------------------------------------------------------
// Pièces en prise : laissées attaquées sans défense, par pièce.
// ---------------------------------------------------------------------------

/** Pièce laissée en prise (le roi ne peut pas l'être : coup illégal). */
export type HungPiece = 'p' | 'n' | 'b' | 'r' | 'q';

export const HUNG_PIECE_ORDER: HungPiece[] = ['p', 'n', 'b', 'r', 'q'];

export const HUNG_PIECE_LABELS: Record<HungPiece, string> = {
  p: 'Pion',
  n: 'Cavalier',
  b: 'Fou',
  r: 'Tour',
  q: 'Dame',
};

export type HungCounts = Record<HungPiece, number>;

export function emptyHungCounts(): HungCounts {
  return { p: 0, n: 0, b: 0, r: 0, q: 0 };
}

/** Compteur compact persisté (ordre HUNG_PIECE_ORDER). */
export function hungCountsToArray(counts: HungCounts): number[] {
  return HUNG_PIECE_ORDER.map((p) => counts[p] ?? 0);
}

/** Lecture tolérante du compteur persisté (corrompu → zéros). */
export function hungCountsFromArray(src: unknown): HungCounts {
  const out = emptyHungCounts();
  if (Array.isArray(src)) {
    HUNG_PIECE_ORDER.forEach((p, i) => {
      const v = src[i];
      out[p] = typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0;
    });
  }
  return out;
}

/**
 * Pièces d'un camp attaquées par l'adversaire et défendues par personne
 * (définition géométrique, sans moteur : un sacrifice qui marche compte
 * quand même). Clé stable `type@case`.
 */
function hangingPieces(board: Chess, color: 'w' | 'b'): Map<string, HungPiece> {
  const enemy = color === 'w' ? 'b' : 'w';
  const out = new Map<string, HungPiece>();
  for (const rank of board.board()) {
    for (const sq of rank) {
      if (!sq || sq.color !== color || sq.type === 'k') continue;
      let attacked = false;
      try {
        attacked = board.attackers(sq.square, enemy).length > 0;
      } catch {
        continue;
      }
      if (!attacked) continue;
      let defended = false;
      try {
        defended = board.attackers(sq.square, color).length > 0;
      } catch {
        continue;
      }
      if (!defended) out.set(`${sq.type}@${sq.square}`, sq.type as HungPiece);
    }
  }
  return out;
}

/**
 * Pièces que LE COMPTE LIÉ a laissées en prise : à chacun de ses coups,
 * les pièces nouvellement pendantes (il les expose) + celles qu'il ne
 * relève pas (menace adverse ignorée). Chaque épisode compte une fois.
 * Pur (replay chess.js local, sans moteur).
 */
export function detectUserHangs(sans: string[], myColor: 'w' | 'b'): HungCounts {
  const counts = emptyHungCounts();
  let board: Chess;
  try {
    board = new Chess(INITIAL_FEN);
  } catch {
    return counts;
  }
  let prev = new Map<string, HungPiece>();
  let pending = new Map<string, HungPiece>();
  for (let i = 0; i < sans.length; i++) {
    const mover = i % 2 === 0 ? 'w' : 'b';
    try {
      board.move(sans[i]);
    } catch {
      break; // coups illisibles : on garde le partiel
    }
    const hanging = hangingPieces(board, myColor);
    if (mover !== myColor) {
      // Menace adverse : à moi de la relever au coup suivant.
      pending = new Map([...hanging].filter(([key]) => !prev.has(key)));
    } else {
      for (const [key, piece] of hanging) {
        if (!prev.has(key) || pending.has(key)) counts[piece]++;
      }
      pending = new Map<string, HungPiece>();
    }
    prev = hanging;
  }
  return counts;
}

// ---------------------------------------------------------------------------
// Mats : trouvés (joués) et manqués, par distance (1, 2, 3, 4, 5+).
// ---------------------------------------------------------------------------

export const MATE_DISTANCE_ORDER = [1, 2, 3, 4, 5] as const;

/** Distance de mat (5 = « 5 coups et + »). */
export type MateDistance = (typeof MATE_DISTANCE_ORDER)[number];

export const MATE_DISTANCE_LABELS: Record<MateDistance, string> = {
  1: 'Mat en 1',
  2: 'Mat en 2',
  3: 'Mat en 3',
  4: 'Mat en 4',
  5: 'Mat en 5+',
};

export interface MateCounts {
  found: Record<MateDistance, number>;
  missed: Record<MateDistance, number>;
}

export function emptyMateCounts(): MateCounts {
  return {
    found: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 },
    missed: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 },
  };
}

/** Compteurs compacts persistés (ordre MATE_DISTANCE_ORDER). */
export function mateCountsToArrays(counts: MateCounts): { mf: number[]; mm: number[] } {
  return {
    mf: MATE_DISTANCE_ORDER.map((d) => counts.found[d] ?? 0),
    mm: MATE_DISTANCE_ORDER.map((d) => counts.missed[d] ?? 0),
  };
}

/** Lecture tolérante des compteurs persistés (corrompu → zéros). */
export function mateCountsFromArrays(mf: unknown, mm: unknown): MateCounts {
  const out = emptyMateCounts();
  const read = (src: unknown): Record<MateDistance, number> => {
    const rec = { ...out.found };
    if (Array.isArray(src)) {
      MATE_DISTANCE_ORDER.forEach((d, i) => {
        const v = src[i];
        rec[d] = typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0;
      });
    }
    return rec;
  };
  return { found: read(mf), missed: read(mm) };
}

function mateBucket(mate: number): MateDistance {
  const d = Math.floor(Math.abs(mate));
  if (d <= 1) return 1;
  if (d === 2) return 2;
  if (d === 3) return 3;
  if (d === 4) return 4;
  return 5;
}

/**
 * Mats DU COMPTE LIÉ : à chaque position avec mat annoncé pour moi,
 * coup joué = le meilleur (isBest) → trouvé, sinon → manqué. Un mat
 * effectivement délivré (partie terminée par mon mat) compte trouvé en M1.
 * `bestMate` = mat moteur RELATIF au trait (> 0 = le trait mate). Pur.
 */
export function detectUserMates(
  plies: Array<{ color?: string; isBest?: boolean; bestMate?: number }>,
  myColor: 'w' | 'b',
  endedByMyMate: boolean,
): MateCounts {
  const counts = emptyMateCounts();
  plies.forEach((p, i) => {
    const moverIsMe = (p.color === 'white') === (myColor === 'w');
    if (!moverIsMe) return;
    if (i === plies.length - 1 && endedByMyMate) {
      counts.found[1]++;
      return;
    }
    if (typeof p.bestMate !== 'number' || !Number.isFinite(p.bestMate) || p.bestMate <= 0) return;
    const bucket = mateBucket(p.bestMate);
    if (p.isBest) counts.found[bucket]++;
    else counts.missed[bucket]++;
  });
  return counts;
}

// ---------------------------------------------------------------------------
// Clouages : joués (trouvés) et manqués, par pièce qui cloue.
// ---------------------------------------------------------------------------

/** Pièce qui cloue (seules les pièces à glissière clouent). */
export type PinPiece = 'b' | 'r' | 'q';

export const PIN_PIECE_ORDER: PinPiece[] = ['b', 'r', 'q'];

export const PIN_PIECE_LABELS: Record<PinPiece, string> = {
  b: 'Fou',
  r: 'Tour',
  q: 'Dame',
};

export interface PinInfo {
  /** Pièce qui cloue. */
  piece: PinPiece;
  /** Case de la pièce qui cloue. */
  pinner: string;
  /** Case de la pièce clouée. */
  pinned: string;
}

export interface PinCounts {
  found: Record<PinPiece, number>;
  missed: Record<PinPiece, number>;
}

export function emptyPinCounts(): PinCounts {
  return { found: { b: 0, r: 0, q: 0 }, missed: { b: 0, r: 0, q: 0 } };
}

/** Compteurs compacts persistés (ordre PIN_PIECE_ORDER). */
export function pinCountsToArrays(counts: PinCounts): { pf: number[]; pm: number[] } {
  return {
    pf: PIN_PIECE_ORDER.map((p) => counts.found[p] ?? 0),
    pm: PIN_PIECE_ORDER.map((p) => counts.missed[p] ?? 0),
  };
}

/** Lecture tolérante des compteurs persistés (corrompu → zéros). */
export function pinCountsFromArrays(pf: unknown, pm: unknown): PinCounts {
  const out = emptyPinCounts();
  const read = (src: unknown): Record<PinPiece, number> => {
    const rec = { ...out.found };
    if (Array.isArray(src)) {
      PIN_PIECE_ORDER.forEach((p, i) => {
        const v = src[i];
        rec[p] = typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0;
      });
    }
    return rec;
  };
  return { found: read(pf), missed: read(pm) };
}

const PIN_RAY_DIRS: Record<PinPiece, Array<[number, number]>> = {
  b: [[1, 1], [1, -1], [-1, 1], [-1, -1]],
  r: [[1, 0], [-1, 0], [0, 1], [0, -1]],
  q: [[1, 1], [1, -1], [-1, 1], [-1, -1], [1, 0], [-1, 0], [0, 1], [0, -1]],
};

const PIN_FILES = 'abcdefgh';

function pinXyToSquare(x: number, y: number): Square | null {
  if (x < 0 || x > 7 || y < 0 || y > 7) return null;
  return `${PIN_FILES[x]}${y + 1}` as Square;
}

/**
 * Clouages ABSOLUS d'un camp : ses fou/tour/dame alignés avec le roi adverse
 * avec exactement UNE pièce adverse entre les deux (la clouée). Géométrique
 * pur, sans moteur. Exposé pour les tests.
 */
export function findAbsolutePinsFen(fen: string, color: 'w' | 'b'): PinInfo[] {
  const board = new Chess(fen);
  const enemy = color === 'w' ? 'b' : 'w';
  const pins: PinInfo[] = [];
  for (const piece of PIN_PIECE_ORDER) {
    for (let fx = 0; fx < 8; fx++) {
      for (let fy = 0; fy < 8; fy++) {
        const from = pinXyToSquare(fx, fy);
        if (!from) continue;
        const occupant = board.get(from);
        if (!occupant || occupant.color !== color || occupant.type !== piece) continue;
        for (const [dx, dy] of PIN_RAY_DIRS[piece]) {
          let first: { square: Square; type: string; color: 'w' | 'b' } | null = null;
          let x = fx + dx;
          let y = fy + dy;
          for (;;) {
            const sq = pinXyToSquare(x, y);
            if (!sq) break;
            const occ = board.get(sq);
            if (!occ) {
              x += dx;
              y += dy;
              continue;
            }
            if (!first) {
              if (occ.color === color) break; // rayon bouché par une pièce amie
              first = { square: sq, type: occ.type, color: occ.color };
              x += dx;
              y += dy;
              continue;
            }
            // Deuxième pièce du rayon : clouage si c'est le roi adverse.
            if (occ.color === enemy && occ.type === 'k') {
              pins.push({ piece, pinner: from, pinned: first.square });
            }
            break;
          }
        }
      }
    }
  }
  return pins;
}

/** Clouages après un UCI joué (null si coup illégal). */
function pinsAfterMoveFen(fenBefore: string, uci: string, color: 'w' | 'b'): PinInfo[] | null {
  try {
    const board = new Chess(fenBefore);
    if (board.turn() !== color) return null;
    const from = uci.slice(0, 2) as Square;
    const to = uci.slice(2, 4) as Square;
    const mv = uci.length > 4
      ? board.move({ from, to, promotion: uci[4] as 'q' | 'r' | 'b' | 'n' })
      : board.move({ from, to });
    if (!mv) return null;
    return findAbsolutePinsFen(board.fen(), color);
  } catch {
    return null;
  }
}

/**
 * Clouages DU COMPTE LIÉ dans une partie : coup joué qui crée un clouage =
 * trouvé ; meilleur coup moteur qui en créait un à la place = manqué
 * (jamais de double-compte : un clouage joué l'emporte). Pur.
 */
export function detectUserPins(
  sans: string[],
  bestUcis: Array<string | undefined>,
  myColor: 'w' | 'b',
): PinCounts {
  const counts = emptyPinCounts();
  let board: Chess;
  try {
    board = new Chess(INITIAL_FEN);
  } catch {
    return counts;
  }
  const keyOf = (p: PinInfo): string => `${p.pinner}${p.pinned}`;
  for (let i = 0; i < sans.length; i++) {
    const mover = i % 2 === 0 ? 'w' : 'b';
    const fenBefore = board.fen();
    let playedUci: string;
    try {
      const mv = board.move(sans[i]);
      playedUci = mv.from + mv.to + (mv.promotion ?? '');
    } catch {
      break; // coups illisibles : on garde le partiel
    }
    if (mover !== myColor) continue;
    const before = findAbsolutePinsFen(fenBefore, mover);
    const beforeKeys = new Set(before.map(keyOf));
    const created = findAbsolutePinsFen(board.fen(), mover).filter((p) => !beforeKeys.has(keyOf(p)));
    if (created.length > 0) {
      for (const p of created) counts.found[p.piece]++;
      continue;
    }
    const best = bestUcis[i];
    if (!best || best === playedUci) continue;
    const afterBest = pinsAfterMoveFen(fenBefore, best, mover);
    if (!afterBest) continue;
    for (const p of afterBest.filter((q) => !beforeKeys.has(keyOf(q)))) {
      counts.missed[p.piece]++;
    }
  }
  return counts;
}

// ---------------------------------------------------------------------------
// Fourchettes : trouvées (jouées) et manquées, par pièce qui fourche.
// ---------------------------------------------------------------------------

/** Pièce qui donne la fourchette (pion → roi). */
export type ForkPiece = 'p' | 'n' | 'b' | 'r' | 'q' | 'k';

export const FORK_PIECE_ORDER: ForkPiece[] = ['p', 'n', 'b', 'r', 'q', 'k'];

export const FORK_PIECE_LABELS: Record<ForkPiece, string> = {
  p: 'Pion',
  n: 'Cavalier',
  b: 'Fou',
  r: 'Tour',
  q: 'Dame',
  k: 'Roi',
};

export interface ForkCounts {
  found: Record<ForkPiece, number>;
  missed: Record<ForkPiece, number>;
}

export function emptyForkCounts(): ForkCounts {
  const zero = (): Record<ForkPiece, number> => ({ p: 0, n: 0, b: 0, r: 0, q: 0, k: 0 });
  return { found: zero(), missed: zero() };
}

/** Compteurs compacts persistés (ordre FORK_PIECE_ORDER). */
export function forkCountsToArrays(counts: ForkCounts): { ff: number[]; fm: number[] } {
  return {
    ff: FORK_PIECE_ORDER.map((p) => counts.found[p] ?? 0),
    fm: FORK_PIECE_ORDER.map((p) => counts.missed[p] ?? 0),
  };
}

/** Lecture tolérante des compteurs persistés (corrompu → zéros). */
export function forkCountsFromArrays(ff: unknown, fm: unknown): ForkCounts {
  const out = emptyForkCounts();
  const read = (src: unknown): Record<ForkPiece, number> => {
    const rec = { ...out.found };
    if (Array.isArray(src)) {
      FORK_PIECE_ORDER.forEach((p, i) => {
        const v = src[i];
        rec[p] = typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0;
      });
    }
    return rec;
  };
  return { found: read(ff), missed: read(fm) };
}

/**
 * La pièce en `to` (venant d'être jouée par `color`) attaque-t-elle ≥ 2
 * pièces adverses NON-pions ? Géométrique pur (ni moteur, ni qualité du
 * coup) : une fourchette jouée qui perd ailleurs compte quand même.
 */
function pieceForksFrom(board: Chess, to: Square, color: 'w' | 'b'): ForkPiece | null {
  const piece = board.get(to);
  if (!piece || piece.color !== color) return null;
  let targets = 0;
  for (const rank of board.board()) {
    for (const sq of rank) {
      if (!sq || sq.color === color || sq.type === 'p') continue;
      try {
        if (board.attackers(sq.square, color).includes(to)) {
          targets++;
          if (targets >= 2) return piece.type as ForkPiece;
        }
      } catch {
        /* case exotique : on ignore la cible */
      }
    }
  }
  return null;
}

/**
 * Teste un UCI dans une position (FEN) : type de la pièce fourchante ou
 * `null` (coup illégal ou pas de fourchette). Exposé pour les tests.
 */
export function moveGivesForkFen(fenBefore: string, uci: string): ForkPiece | null {
  try {
    const board = new Chess(fenBefore);
    const from = uci.slice(0, 2) as Square;
    const to = uci.slice(2, 4) as Square;
    const mover = board.turn();
    const mv = uci.length > 4
      ? board.move({ from, to, promotion: uci[4] as 'q' | 'r' | 'b' | 'n' })
      : board.move({ from, to });
    if (!mv) return null;
    return pieceForksFrom(board, to, mover);
  } catch {
    return null;
  }
}

/**
 * Fourchettes DU COMPTE LIÉ dans une partie : jouée qui fourche = trouvée ;
 * meilleur coup moteur (UCI) qui fourchait à la place = manquée. Si le coup
 * joué fourche déjà, on ne compte que la trouvée (pas de double-compte).
 * `bestUcis[i]` = meilleur UCI au pli i (indéfini si inconnu). Pur.
 */
export function detectUserForks(
  sans: string[],
  bestUcis: Array<string | undefined>,
  myColor: 'w' | 'b',
): ForkCounts {
  const counts = emptyForkCounts();
  let board: Chess;
  try {
    board = new Chess(INITIAL_FEN);
  } catch {
    return counts;
  }
  for (let i = 0; i < sans.length; i++) {
    const mover = i % 2 === 0 ? 'w' : 'b';
    const fenBefore = board.fen();
    let playedUci: string;
    let playedTo: Square;
    try {
      const mv = board.move(sans[i]);
      playedUci = mv.from + mv.to + (mv.promotion ?? '');
      playedTo = mv.to;
    } catch {
      break; // coups illisibles : on garde le partiel
    }
    if (mover !== myColor) continue;
    const found = pieceForksFrom(board, playedTo, mover);
    if (found) {
      counts.found[found]++;
      continue;
    }
    const best = bestUcis[i];
    if (!best || best === playedUci) continue;
    const missed = moveGivesForkFen(fenBefore, best);
    if (missed) counts.missed[missed]++;
  }
  return counts;
}
