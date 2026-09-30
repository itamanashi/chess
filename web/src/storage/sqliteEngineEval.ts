import type { EngineMove } from '../types/chess';
import { isAbortError, warn } from '../utils/async';

const ENABLED = import.meta.env.VITE_SQLITE_CACHE_ENABLED === 'true';

export interface SqliteEngineEvalRecord {
  key: string;
  lines: EngineMove[];
  savedAt: number;
}

let warningLogged = false;

function report(error: unknown): void {
  if (warningLogged) return;
  warningLogged = true;
  warn('engine-sqlite', error);
}

export async function getSqliteEngineEval(key: string): Promise<SqliteEngineEvalRecord | undefined> {
  if (!ENABLED) return undefined;
  try {
    const response = await fetch(`/api/eval-cache/entry?key=${encodeURIComponent(key)}`, {
      signal: AbortSignal.timeout(1500),
    });
    if (!response.ok) throw new Error(`SQLite moteur: HTTP ${response.status}.`);
    const result = (await response.json()) as { record: SqliteEngineEvalRecord | null };
    return result.record ?? undefined;
  } catch (error) {
    if (!isAbortError(error)) report(error);
    return undefined;
  }
}

export async function putSqliteEngineEvals(records: SqliteEngineEvalRecord[]): Promise<void> {
  if (!ENABLED || records.length === 0) return;
  for (let index = 0; index < records.length; index += 100) {
    try {
      const response = await fetch('/api/eval-cache/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ records: records.slice(index, index + 100) }),
        signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) throw new Error(`SQLite moteur: HTTP ${response.status}.`);
      warningLogged = false;
    } catch (error) {
      report(error);
      return;
    }
  }
}

export async function clearSqliteEngineEvals(): Promise<void> {
  if (!ENABLED) return;
  try {
    const response = await fetch('/api/eval-cache', {
      method: 'DELETE',
      signal: AbortSignal.timeout(2000),
    });
    if (!response.ok) throw new Error(`SQLite moteur: HTTP ${response.status}.`);
  } catch (error) {
    if (!isAbortError(error)) report(error);
  }
}
