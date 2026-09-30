import type { LichessApiResponse } from '../types/chess';
import { isAbortError, warn } from '../utils/async';

const ENABLED = import.meta.env.VITE_SQLITE_CACHE_ENABLED === 'true';

export interface SqliteExplorerRecord {
  data: LichessApiResponse;
  savedAt: number;
}

let available = false;
let entries = 0;
let engineEvaluations = 0;
let warningLogged = false;

function markUnavailable(error?: unknown): void {
  available = false;
  if (error && !warningLogged) {
    warningLogged = true;
    warn('explorer-sqlite', error);
  }
}

export function explorerSqliteStatus(): { available: boolean; entries: number; engineEvaluations: number } {
  return { available, entries, engineEvaluations };
}

export async function loadExplorerSqliteStats(): Promise<void> {
  if (!ENABLED) return;
  try {
    const response = await fetch('/api/explorer-cache/stats', { signal: AbortSignal.timeout(1500) });
    if (!response.ok) throw new Error(`SQLite locale: HTTP ${response.status}.`);
    const result = (await response.json()) as { entries: number; engineEvaluations: number };
    entries = result.entries;
    engineEvaluations = result.engineEvaluations;
    available = true;
  } catch (error) {
    if (!isAbortError(error)) markUnavailable(error);
  }
}

export async function getExplorerSqliteRecord(
  key: string,
  signal?: AbortSignal,
): Promise<SqliteExplorerRecord | null> {
  if (!ENABLED) return null;
  try {
    const response = await fetch(`/api/explorer-cache/entry?key=${encodeURIComponent(key)}`, {
      signal: signal ?? AbortSignal.timeout(1500),
    });
    if (!response.ok) throw new Error(`SQLite locale: HTTP ${response.status}.`);
    const result = (await response.json()) as { record: SqliteExplorerRecord | null };
    available = true;
    return result.record;
  } catch (error) {
    if (isAbortError(error)) throw error;
    markUnavailable(error);
    return null;
  }
}

export async function putExplorerSqliteRecord(
  key: string,
  data: LichessApiResponse,
  savedAt: number,
): Promise<void> {
  if (!ENABLED) return;
  try {
    const response = await fetch('/api/explorer-cache/entry', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key, data, savedAt }),
      signal: AbortSignal.timeout(2000),
    });
    if (!response.ok) throw new Error(`SQLite locale: HTTP ${response.status}.`);
    const result = (await response.json()) as { entries: number };
    available = true;
    entries = result.entries;
    warningLogged = false;
  } catch (error) {
    markUnavailable(error);
  }
}

export async function backupExplorerSqliteRecords(
  records: Array<SqliteExplorerRecord & { key: string }>,
): Promise<void> {
  if (!ENABLED || records.length === 0) return;
  for (let index = 0; index < records.length; index += 100) {
    try {
      const response = await fetch('/api/explorer-cache/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ records: records.slice(index, index + 100) }),
        signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) throw new Error(`SQLite locale: HTTP ${response.status}.`);
    } catch (error) {
      markUnavailable(error);
      return;
    }
  }
  await loadExplorerSqliteStats();
}
