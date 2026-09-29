import { Chess } from 'chess.js';
import {
  ELO_TARGET_OPTIONS,
  type EloTargetKey,
  type RepertoireItem,
  type RepertoireMove,
  type RepertoireRoot,
} from '../types/chess';
import { INITIAL_FEN, normalizeCastleUci } from '../utils/repertoire';
import {
  NODE_BAD_FEN,
  NODE_BAD_SAN,
  NODE_CHILDREN_NOT_ARRAY,
  NODE_NOT_OBJECT,
  STORE_CHILDREN_NOT_ARRAY,
  STORE_ROOT_BAD_FEN,
  STORE_ROOT_INVALID,
  TREE_TOO_DEEP,
  importTruncated,
  nodeBadUci,
  storeEntryIssue,
  storeEntryRejected,
  storeEntryUnreadable,
  storeMigratedTitle,
  treeTooManyChildren,
} from '../i18n';

/**
 * Runtime schemas + validation for persisted / imported data.
 *
 * Deliberate choice: hand-rolled validation instead of zod/io-ts — zero
 * extra dependencies, French error messages with precise JSON paths
 * (`children[2].children[0].uci`, wording from `i18n/fr.ts`), and fine
 * business rules:
 *   - strict on identity (san/uci/fen/shape): an invalid branch is pruned
 *     and reported, never inserted;
 *   - lenient on stats (default 0) and unknown enums (default + forward
 *     compat: a file from a future version stays readable);
 *   - anti-abuse guardrails (depth, node count, children per node).
 */

/** Current library schema version (stored on every item). */
export const LIBRARY_SCHEMA_VERSION = 1;

/** Guardrails: a legitimate import is far below these ceilings. */
export const MAX_TREE_DEPTH = 200;
export const MAX_TREE_NODES = 20000;
export const MAX_CHILDREN_PER_NODE = 128;
const MAX_ERROR_DETAILS = 25;
const MAX_FEN_LENGTH = 200;
const MAX_SAN_LENGTH = 20;

const UCI_RE = /^[a-h][1-8][a-h][1-8][qrbnQRBN]?$/;
const ELO_KEYS = new Set<string>(ELO_TARGET_OPTIONS.map((o) => o.key));

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isNonEmptyString(v: unknown, maxLen = 200): v is string {
  return typeof v === 'string' && v.length > 0 && v.length <= maxLen;
}

export function isValidFen(fen: unknown): fen is string {
  if (typeof fen !== 'string' || fen.length === 0 || fen.length > MAX_FEN_LENGTH) return false;
  try {
    new Chess(fen);
    return true;
  } catch {
    return false;
  }
}

/** Game stat: strict on type, defaults to 0 when absent. */
function statNumber(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0;
}

interface TreeCtx {
  nodes: number;
  pruned: number;
  truncated: boolean;
  errors: string[];
}

function pushError(ctx: TreeCtx, msg: string): void {
  if (ctx.errors.length < MAX_ERROR_DETAILS) ctx.errors.push(msg);
}

/**
 * Validates + sanitizes a move and its subtree. Returns `null` when the node
 * is invalid (the branch is then pruned and counted in `pruned`).
 *
 * UCI NORMALIZATION (single choke point): Lichess sends castles in
 * Chess960 form (e1h1) while the app compares/store standard UCI (e1g1).
 * Every comparison in the app (`isAdopted`, `ensurePath`, repertoire index)
 * is an exact string match, so ONE non-normalized node breaks adoption
 * display AND forks a duplicate branch. Normalized here against the parent
 * FEN — covers imports, migration and stored-library loads at once.
 */
function sanitizeMove(
  raw: unknown,
  path: string,
  depth: number,
  ctx: TreeCtx,
  parentFen: string,
): RepertoireMove | null {
  if (ctx.nodes >= MAX_TREE_NODES) {
    if (!ctx.truncated) {
      ctx.truncated = true;
      pushError(ctx, importTruncated(MAX_TREE_NODES));
    }
    return null;
  }
  if (depth > MAX_TREE_DEPTH) {
    ctx.pruned++;
    pushError(ctx, `${path} : ${TREE_TOO_DEEP}`);
    return null;
  }
  if (!isRecord(raw)) {
    ctx.pruned++;
    pushError(ctx, `${path} : ${NODE_NOT_OBJECT}`);
    return null;
  }
  const sanRaw = raw.san ?? raw.coup;
  const san = isNonEmptyString(sanRaw, MAX_SAN_LENGTH) ? sanRaw : null;
  if (!san) {
    ctx.pruned++;
    pushError(ctx, `${path} : ${NODE_BAD_SAN}`);
    return null;
  }
  const uciRaw = typeof raw.uci === 'string' ? raw.uci : '';
  if (!UCI_RE.test(uciRaw)) {
    ctx.pruned++;
    pushError(ctx, `${path} (${san}) : ${nodeBadUci(uciRaw)}`);
    return null;
  }
  if (!isValidFen(raw.fen)) {
    ctx.pruned++;
    pushError(ctx, `${path} (${san}) : ${NODE_BAD_FEN}`);
    return null;
  }
  // Canonical form from here on (e1h1 → e1g1…). parentFen is always valid:
  // the root was validated first and each level validates before recursing
  // (plus normalizeCastleUci itself tolerates a bad FEN).
  const uci = normalizeCastleUci(parentFen, uciRaw);

  let children: RepertoireMove[] = [];
  if (raw.children !== undefined) {
    if (!Array.isArray(raw.children)) {
      ctx.pruned++;
      pushError(ctx, `${path} (${san}) : ${NODE_CHILDREN_NOT_ARRAY}`);
      return null;
    }
    const list = raw.children;
    if (list.length > MAX_CHILDREN_PER_NODE) {
      pushError(
        ctx,
        `${path} (${san}) : ${treeTooManyChildren(list.length, MAX_CHILDREN_PER_NODE)}`,
      );
    }
    const kept = list.slice(0, MAX_CHILDREN_PER_NODE);
    const nodeFen = raw.fen as string;
    kept.forEach((ch, i) => {
      const m = sanitizeMove(ch, `${path}.children[${i}]`, depth + 1, ctx, nodeFen);
      if (m) children.push(m);
    });
  }

  ctx.nodes++;
  return {
    coup: isNonEmptyString(raw.coup, MAX_SAN_LENGTH) ? raw.coup : san,
    uci,
    san,
    parties: statNumber(raw.parties ?? raw.games),
    victoires_blancs: statNumber(raw.victoires_blancs ?? raw.white),
    nuls: statNumber(raw.nuls ?? raw.draws),
    victoires_noirs: statNumber(raw.victoires_noirs ?? raw.black),
    ...(typeof raw.score_moyen === 'number' && Number.isFinite(raw.score_moyen)
      ? { score_moyen: raw.score_moyen }
      : {}),
    ...(typeof raw.ouverture === 'string' ? { ouverture: raw.ouverture } : {}),
    ...(typeof raw.eco === 'string' ? { eco: raw.eco } : {}),
    ...(typeof raw.eval === 'string' ? { eval: raw.eval } : {}),
    ...(typeof raw.frequencyPct === 'number' && Number.isFinite(raw.frequencyPct)
      ? { frequencyPct: raw.frequencyPct }
      : {}),
    fen: raw.fen as string,
    children,
  };
}

export interface TreeValidation {
  children: RepertoireMove[];
  errors: string[];
  pruned: number;
  truncated: boolean;
}

export function validateMoveChildren(
  rawChildren: unknown,
  basePath: string,
  parentFen: string,
): TreeValidation {
  const ctx: TreeCtx = { nodes: 0, pruned: 0, truncated: false, errors: [] };
  if (rawChildren === undefined) return { children: [], errors: [], pruned: 0, truncated: false };
  if (!Array.isArray(rawChildren)) {
    return { children: [], errors: [`${basePath} : ${STORE_CHILDREN_NOT_ARRAY}`], pruned: 0, truncated: false };
  }
  const children: RepertoireMove[] = [];
  rawChildren.slice(0, MAX_CHILDREN_PER_NODE).forEach((ch, i) => {
    const m = sanitizeMove(ch, `${basePath}[${i}]`, 1, ctx, parentFen);
    if (m) children.push(m);
  });
  return { children, errors: ctx.errors, pruned: ctx.pruned, truncated: ctx.truncated };
}

export interface RootValidation {
  root: RepertoireRoot | null;
  errors: string[];
  pruned: number;
}

/** Validates a `{ fen, children }` root. Missing FEN → initial position. */
export function validateRoot(raw: unknown): RootValidation {
  if (!isRecord(raw)) {
    return { root: null, errors: [STORE_ROOT_INVALID], pruned: 0 };
  }
  const fen = raw.fen === undefined ? INITIAL_FEN : raw.fen;
  if (!isValidFen(fen)) {
    return { root: null, errors: [STORE_ROOT_BAD_FEN], pruned: 0 };
  }
  const tree = validateMoveChildren(raw.children, 'children', fen);
  return { root: { fen, children: tree.children }, errors: tree.errors, pruned: tree.pruned };
}

/** Strictly white/black color, `fallback` otherwise (compatibility). */
export function coerceColor(v: unknown, fallback: 'white' | 'black' = 'black'): 'white' | 'black' {
  return v === 'white' || v === 'black' ? v : fallback;
}

/** Known Elo tier, defaults to `all_700` when unknown (forward compat). */
export function coerceEloTarget(v: unknown): EloTargetKey {
  return typeof v === 'string' && ELO_KEYS.has(v) ? (v as EloTargetKey) : 'all_700';
}

function coerceTitle(v: unknown, fallback: string): string {
  if (typeof v === 'string' && v.trim().length > 0) return v.trim().slice(0, 120);
  return fallback;
}

export interface ItemValidation {
  item: RepertoireItem | null;
  errors: string[];
  pruned: number;
}

/**
 * Validates a full `{ id, title, color, targetElo, root, … }` item.
 * Used for local-store migration (lenient: repairs + timestamps).
 */
export function validateStoredItem(raw: unknown, index: number, nowIso: string): ItemValidation {
  const errors: string[] = [];
  if (!isRecord(raw)) {
    return { item: null, errors: [storeEntryUnreadable(index + 1)], pruned: 0 };
  }
  // Forme racine nue (ancien export direct) → enveloppée en item.
  const rawRoot = isRecord(raw.root) ? raw.root : raw;
  const tree = validateRoot(rawRoot);
  if (!tree.root) {
    return { item: null, errors: [storeEntryRejected(index + 1, tree.errors[0] ?? STORE_ROOT_INVALID)], pruned: 0 };
  }
  const id = isNonEmptyString(raw.id, 80) ? raw.id : `rep_migrated_${Date.now()}_${index}`;
  errors.push(...tree.errors.map((e) => storeEntryIssue(coerceTitle(raw.title, `#${index + 1}`), e)));
  return {
    item: {
      id,
      title: coerceTitle(raw.title, storeMigratedTitle(index + 1)),
      color: coerceColor(raw.color),
      targetElo: coerceEloTarget(raw.targetElo),
      createdAt: isNonEmptyString(raw.createdAt, 40) ? (raw.createdAt as string) : nowIso,
      updatedAt: nowIso,
      schemaVersion: LIBRARY_SCHEMA_VERSION,
      root: tree.root,
    },
    errors,
    pruned: tree.pruned,
  };
}
