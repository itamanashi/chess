import type { RepertoireItem, RepertoireRoot } from '../types/chess';
import { INITIAL_FEN } from '../utils/repertoire';
import { warn } from '../utils/async';
import { readRaw, writeRaw } from './storage';
import {
  LIBRARY_SCHEMA_VERSION,
  isRecord,
  validateRoot,
  validateStoredItem,
} from './schemas';
import {
  IMPORT_DEFAULT_TITLE,
  IMPORT_EMPTY,
  STORE_CORRUPT_BACKUP,
  storeBackupCreated,
  importEntryPrefix,
  importFailed,
  importNotJson,
  importPrunedBranches,
  importUnrecognizedEntry,
  storePrunedBranches,
} from '../i18n';

export { LIBRARY_SCHEMA_VERSION };

/**
 * Library persistence repository — SINGLE POINT OF PASSAGE.
 *
 * Before: `localStorage` read/written in several places, no versioning,
 * imported JSON never validated (a garbage file became an empty repertoire).
 * Now:
 *   - `loadLibrary()`: reads + migrates (defaults, `schemaVersion`, wraps
 *     legacy shapes); unreadable payload → timestamped backup, never silent
 *     data loss;
 *   - `saveLibrary()`: canonical write (stamps the version), explicit boolean
 *     for user actions (quota full…);
 *   - `parseImport()`: validates before inserting — nothing invalid gets in.
 *
 * Language rule: no French literals here, everything via `i18n/fr.ts`.
 */

const LIBRARY_KEY = 'chess_repertoires_library';

export type LibraryLoadStatus =
  | 'ready'      // versioned data, ready
  | 'migrated'   // legacy data repaired (rewrite canonically)
  | 'empty'      // nothing stored (first launch)
  | 'corrupt'    // unreadable payload, backup created
  | 'unavailable'; // storage unreachable (private browsing…)

export interface LibraryLoadResult {
  status: LibraryLoadStatus;
  items: RepertoireItem[];
  /** Repaired/pruned points (show as a summary, never in a loop). */
  issues: string[];
}

function backupCorrupt(raw: string): void {
  const backupKey = `${LIBRARY_KEY}.corrupt.${Date.now()}`;
  if (writeRaw(backupKey, raw)) {
    warn('library:backup', storeBackupCreated(backupKey));
  }
}

export function loadLibrary(): LibraryLoadResult {
  const raw = readRaw(LIBRARY_KEY);
  if (raw === null) {
    // Clé absente OU stockage inaccessible (déjà journalisé par le wrapper).
    return { status: 'empty', items: [], issues: [] };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    warn('library:parse', err);
    backupCorrupt(raw);
    return { status: 'corrupt', items: [], issues: [STORE_CORRUPT_BACKUP] };
  }

  // Accepted shapes: item array (canonical), { items } envelope,
  // single item, or bare root (legacy direct exports).
  let rawItems: unknown[];
  if (Array.isArray(parsed)) {
    rawItems = parsed;
  } else if (isRecord(parsed) && Array.isArray(parsed.items)) {
    rawItems = parsed.items;
  } else if (isRecord(parsed)) {
    rawItems = [parsed];
  } else {
    backupCorrupt(raw);
    return { status: 'corrupt', items: [], issues: [STORE_CORRUPT_BACKUP] };
  }

  if (rawItems.length === 0) return { status: 'empty', items: [], issues: [] };

  const nowIso = new Date().toISOString();
  const items: RepertoireItem[] = [];
  const issues: string[] = [];
  let touched = false;
  for (let i = 0; i < rawItems.length; i++) {
    const v = validateStoredItem(rawItems[i], i, nowIso);
    if (!v.item) {
      touched = true;
      issues.push(...v.errors);
      continue;
    }
    // Already versioned and strictly conformant → as is; otherwise repaired.
    const storedVersion = isRecord(rawItems[i])
      ? (rawItems[i] as Record<string, unknown>).schemaVersion
      : undefined;
    if (storedVersion !== LIBRARY_SCHEMA_VERSION || v.errors.length > 0 || v.pruned > 0) {
      touched = true;
    }
    if (v.pruned > 0) issues.push(storePrunedBranches(v.pruned));
    issues.push(...v.errors);
    items.push(v.item);
  }

  if (items.length === 0) {
    backupCorrupt(raw);
    return { status: 'corrupt', items: [], issues: [STORE_CORRUPT_BACKUP] };
  }
  return { status: touched ? 'migrated' : 'ready', items, issues };
}

/** Canonical write (stamps `schemaVersion`). `false` = failure (quota…). */
export function saveLibrary(items: RepertoireItem[]): boolean {
  try {
    const stamped = items.map((r) => ({ ...r, schemaVersion: LIBRARY_SCHEMA_VERSION }));
    return writeRaw(LIBRARY_KEY, JSON.stringify(stamped));
  } catch (err) {
    warn('library:save', err);
    return false;
  }
}

/** Fresh item (creation / import) with version + timestamps. */
export function buildLibraryItem(title: string, color: RepertoireItem['color'], root: RepertoireRoot): RepertoireItem {
  const nowIso = new Date().toISOString();
  return {
    id: `rep_${Date.now()}_${Math.floor(Math.random() * 1e6)}`,
    title,
    color,
    targetElo: 'all_700',
    createdAt: nowIso,
    updatedAt: nowIso,
    schemaVersion: LIBRARY_SCHEMA_VERSION,
    root,
  };
}

export interface ImportParseResult {
  items: RepertoireItem[];
  /** Branches pruned during validation (empty = faithful import). */
  warnings: string[];
}

/**
 * Parses + validates a file before insertion. Throws an explicit `Error`
 * when nothing is importable. Accepted shapes: `{ fen, children }` root
 * (standard export), full item, or an array of both.
 */
export function parseImport(content: string, filename: string): ImportParseResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error(importNotJson(filename));
  }

  const raws: unknown[] = Array.isArray(parsed) ? parsed : [parsed];
  if (raws.length === 0) throw new Error(IMPORT_EMPTY);

  const baseTitle = filename.replace(/\.json$/i, '').trim().slice(0, 80) || IMPORT_DEFAULT_TITLE;
  const items: RepertoireItem[] = [];
  const warnings: string[] = [];
  const errors: string[] = [];

  raws.forEach((entry, i) => {
    // Garde anti-garbage : on exige la forme racine `{ children: [...] }`
    // (ou item avec clé `root`). Sans ça, n'importe quel objet JSON devenait
    // silencieusement un répertoire vide.
    const looksLikeRoot =
      isRecord(entry) && (Array.isArray(entry.children) || isRecord(entry.root));
    if (!looksLikeRoot) {
      errors.push(importUnrecognizedEntry(i + 1));
      return;
    }
    // Item complet ? (clé `root` objet) sinon racine nue.
    const asRoot = isRecord(entry) && isRecord(entry.root) ? entry.root : entry;
    const v = validateRoot(asRoot);
    if (!v.root) {
      errors.push(importEntryPrefix(i + 1, v.errors[0] ?? STORE_CORRUPT_BACKUP));
      return;
    }
    const title =
      raws.length > 1
        ? `${baseTitle} (${i + 1})`
        : isRecord(entry) && typeof entry.title === 'string' && entry.title.trim()
          ? entry.title.trim().slice(0, 80)
          : baseTitle;
    items.push(buildLibraryItem(title, 'black', v.root));
    if (v.pruned > 0) {
      warnings.push(importPrunedBranches(v.pruned, i + 1));
    }
    v.errors.forEach((e) => warnings.push(importEntryPrefix(i + 1, e)));
  });

  if (items.length === 0) {
    throw new Error(importFailed(errors.slice(0, 3).join(' ')));
  }
  return { items, warnings };
}

/** Canonical empty root (creation). */
export function emptyRoot(): RepertoireRoot {
  return { fen: INITIAL_FEN, children: [] };
}
