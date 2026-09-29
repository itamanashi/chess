import type { EngineMove } from '../types/chess';
import { abortableSleep, fetchWithTimeout, isAbortError, isTimeoutError, throwIfAborted } from '../utils/async';
import { pvToEngineMove } from '../utils/enginePv';
import { LruCache } from '../utils/lru';
import { tokenStore } from '../storage/preferences';
import {
  CLOUD_BAD_REQUEST,
  CLOUD_NOT_ANALYZED,
  CLOUD_TIMEOUT,
  LICHESS_AUTH_REQUIRED,
  LICHESS_BAD_JSON,
  LICHESS_RATE_LIMITED,
  cloudServerError,
  lichessNetworkError,
} from '../i18n';

/**
 * Lichess cloud evaluation (https://lichess.org/api/cloud-eval).
 *
 * NOTE: currently no in-app caller — kept as the documented fallback when
 * the local Stockfish worker is unavailable (see `localEngine.ts`). Its
 * contract is explicit so wiring it later is trivial:
 *  - success → `{ ok: true, moves, fromCache }` (moves may be empty only
 *    when the cloud genuinely returns zero PVs);
 *  - known absence → `{ ok: false, error: { code: 'not-analyzed' } }`
 *    (definitive: do NOT retry, do NOT show an error);
 *  - failure → `{ ok: false, error }` with a machine-readable `code`;
 *  - caller abort → always THROWS (AbortError), never a Result.
 *
 * Resilience: per-attempt timeout + limited exponential-backoff retries on
 * transient failures only (network, timeout, 429, 5xx). 4xx/parse errors
 * fail fast. PV → SAN conversion is SHARED with the local engine
 * (`utils/enginePv.ts`): a single rule set, no divergent copies.
 */

export type CloudEvalErrorCode =
  | 'not-analyzed'
  | 'unauthorized'
  | 'bad-request'
  | 'rate-limited'
  | 'server'
  | 'http'
  | 'timeout'
  | 'network'
  | 'bad-response';

export interface CloudEvalError {
  code: CloudEvalErrorCode;
  message: string;
  /** HTTP status when relevant. */
  status?: number;
}

export type CloudEvalResult =
  | { ok: true; moves: EngineMove[]; fromCache: boolean }
  | { ok: false; error: CloudEvalError };

export interface CloudEvalOptions {
  /** Caller cancellation (propagated: aborts attempts AND backoff sleeps). */
  signal?: AbortSignal;
  /** Per-attempt budget in ms (default 10 s). */
  timeoutMs?: number;
  /** Retries after the first attempt on transient failures (default 2). */
  maxRetries?: number;
  /** First backoff delay in ms, doubled per retry (default 400). */
  backoffBaseMs?: number;
}

const CLOUD_CACHE_CAPACITY = 300;
const DEFAULT_TIMEOUT_MS = 10000;
const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_BACKOFF_BASE_MS = 400;

const CACHE_CLOUD_EVAL = new LruCache<string, EngineMove[]>(CLOUD_CACHE_CAPACITY);

function fail(code: CloudEvalErrorCode, message: string, status?: number): CloudEvalResult {
  return status === undefined
    ? { ok: false, error: { code, message } }
    : { ok: false, error: { code, message, status } };
}

/**
 * Single HTTP attempt with shared timeout semantics (`utils/async`).
 * Identical behavior to the previous local copy (moved, not changed).
 */
async function fetchAttempt(
  url: string,
  headers: Record<string, string>,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<Response> {
  return fetchWithTimeout(url, { headers, signal }, timeoutMs);
}

interface UnvalidatedPv {
  moves?: unknown;
  cp?: unknown;
  mate?: unknown;
}

function isValidCloudBody(data: unknown): data is { depth?: unknown; pvs?: unknown } {
  return typeof data === 'object' && data !== null;
}

export async function fetchCloudEvaluation(
  fen: string,
  multiPv: number = 4,
  opts: CloudEvalOptions = {},
): Promise<CloudEvalResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxRetries = opts.maxRetries ?? DEFAULT_MAX_RETRIES;
  const backoffBaseMs = opts.backoffBaseMs ?? DEFAULT_BACKOFF_BASE_MS;
  const signal = opts.signal;

  const cacheKey = `${fen}:${multiPv}`;
  const cached = CACHE_CLOUD_EVAL.get(cacheKey);
  if (cached) return { ok: true, moves: cached, fromCache: true };

  const url = `https://lichess.org/api/cloud-eval?fen=${encodeURIComponent(fen)}&multiPv=${multiPv}`;

  const headers: Record<string, string> = {
    Accept: 'application/json',
  };
  const token = tokenStore.get();
  if (token) {
    headers['Authorization'] = `Bearer ${token.trim()}`;
  }

  let attempt = 0;
  for (;;) {
    throwIfAborted(signal);
    let response: Response;
    try {
      response = await fetchAttempt(url, headers, timeoutMs, signal);
    } catch (err) {
      // Caller abort always propagates (never becomes a Result).
      if (signal?.aborted || isAbortError(err)) throw err;
      const timedOut = isTimeoutError(err);
      const message = timedOut
        ? CLOUD_TIMEOUT
        : lichessNetworkError(err instanceof Error ? err.message : String(err));
      if (attempt < maxRetries) {
        attempt++;
        try {
          await abortableSleep(backoffBaseMs * 2 ** (attempt - 1), signal);
        } catch {
          throwIfAborted(signal);
          throw err;
        }
        continue;
      }
      return fail(timedOut ? 'timeout' : 'network', message);
    }

    if (response.status === 404) {
      // Definitive: the cloud never analyzed this position. No retry,
      // no error UI — and NOT cached (a later analysis may add it).
      return fail('not-analyzed', CLOUD_NOT_ANALYZED, 404);
    }
    if (response.status === 401 || response.status === 403) {
      return fail('unauthorized', LICHESS_AUTH_REQUIRED, response.status);
    }
    if (response.status === 400) {
      return fail('bad-request', CLOUD_BAD_REQUEST, 400);
    }
    if (response.status === 429) {
      if (attempt < maxRetries) {
        attempt++;
        try {
          await abortableSleep(backoffBaseMs * 2 ** (attempt - 1), signal);
        } catch {
          throwIfAborted(signal);
        }
        continue;
      }
      return fail('rate-limited', LICHESS_RATE_LIMITED, 429);
    }
    if (response.status >= 500) {
      if (attempt < maxRetries) {
        attempt++;
        try {
          await abortableSleep(backoffBaseMs * 2 ** (attempt - 1), signal);
        } catch {
          throwIfAborted(signal);
        }
        continue;
      }
      return fail('server', cloudServerError(response.status), response.status);
    }
    if (!response.ok) {
      return fail('http', cloudServerError(response.status), response.status);
    }

    let data: unknown;
    try {
      data = await response.json();
    } catch (err) {
      if (signal?.aborted || isAbortError(err)) throw err;
      return fail('bad-response', LICHESS_BAD_JSON, response.status);
    }
    if (signal?.aborted) {
      throwIfAborted(signal);
    }
    if (!isValidCloudBody(data) || !Array.isArray(data.pvs)) {
      return fail('bad-response', LICHESS_BAD_JSON, response.status);
    }

    const depth = typeof data.depth === 'number' && Number.isFinite(data.depth) ? data.depth : 50;
    const engineMoves: EngineMove[] = [];
    for (const raw of data.pvs as UnvalidatedPv[]) {
      if (typeof raw !== 'object' || raw === null) continue;
      const movesStr = typeof raw.moves === 'string' ? raw.moves : '';
      const ucis = movesStr.trim().split(/\s+/).filter((s) => s.length > 0);
      if (ucis.length === 0) continue;
      let parsed: EngineMove | null;
      try {
        parsed = pvToEngineMove(
          fen,
          ucis,
          {
            cp: typeof raw.cp === 'number' ? raw.cp : undefined,
            mate: typeof raw.mate === 'number' ? raw.mate : undefined,
          },
          depth,
        );
      } catch {
        continue; // invalid FEN or divergent PV: skip this line, not the batch
      }
      if (parsed) engineMoves.push(parsed);
    }

    // A 200 with zero convertible PVs signals a divergent payload, not an
    // empty analysis (an empty `pvs: []` legitimately yields zero moves).
    if (engineMoves.length === 0 && (data.pvs as unknown[]).length > 0) {
      return fail('bad-response', LICHESS_BAD_JSON, response.status);
    }

    if (engineMoves.length > 0) CACHE_CLOUD_EVAL.set(cacheKey, engineMoves);
    return { ok: true, moves: engineMoves, fromCache: false };
  }
}
