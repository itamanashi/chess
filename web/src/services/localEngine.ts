import { Chess } from 'chess.js';
import type { EngineMove, EvalPoint } from '../types/chess';
import { analyzeTrajectory } from './evalStability';
import { abortableSleep, isAbortError, throwIfAborted } from '../utils/async';
import { normalizePvUci, pvToEngineMove } from '../utils/enginePv';
import { LruCache } from '../utils/lru';
import {
  ENGINE_INVALID_FEN,
  ENGINE_NOT_READY,
  ENGINE_SUPERSEDED,
  ENGINE_WAIT_TIMEOUT,
  ENGINE_WASM_UNAVAILABLE,
  NO_STABILITY_DATA,
  STABILITY_LABELS,
} from '../i18n';

/**
 * Moteur Stockfish LOCAL (tourne dans le navigateur, aucun cloud).
 *
 * Stockfish 19 smallnet (`@lichess-org/stockfish-web`, celui de l'analyse
 * Lichess) : `public/sf19/` (`sf_19_smallnet.js/.wasm` + réseau
 * `nn-….nnue` + bootstrap `sf-worker.js`), chargé en Web Worker module
 * unique (singleton). Protocole UCI texte inchangé (voir `sf-worker.js`).
 * Ancien moteur (SF10, `public/stockfish.wasm*`) conservé en repli.
 * Chaque analyse envoie `stop` avant de relancer, donc changer de position
 * annule proprement la recherche précédente.
 *
 * Architecture : tout le protocole UCI vit dans `EngineSession`
 * (testable via `WorkerFactory` injectée). Le module conserve UNE session
 * partagée (un seul Stockfish en mémoire) et toutes les fonctions
 * historiques délèguent vers elle — contrats publics inchangés.
 *
 * Concurrence (audit A9) : un seul worker = une seule recherche à la fois.
 * Les analyses sont sérialisées dans une file à priorité (`interactive`
 * d'abord : conseil builder, survol graphe ; `background` sinon). Une
 * arrivée interactive préempte une analyse de fond en vol. Préemption et
 * `stopSearch()` lèvent `EngineError('superseded')` aux points de contrôle
 * — jamais un `[]` silencieux : les appelants distinguent "supplanté"
 * (finir proprement, sans erreur visible) d'un vrai vide moteur.
 */

export interface LocalAnalysisOptions {
  multiPv?: number;
  depth?: number;
  /** Temps max d'analyse avant de rendre le meilleur résultat partiel. */
  timeoutMs?: number;
  onProgress?: (depthReached: number) => void;
  /**
   * Lignes live à chaque profondeur complétée (throttlé ~2/s) : voir la
   * réflexion pendant la recherche, pas seulement sa conclusion. Les
   * trajectoires sont omises (allégé) ; le résultat final reste la source
   * de vérité (les partielles ne sont jamais mises en cache).
   */
  onPartial?: (moves: EngineMove[], depthReached: number) => void;
  /**
   * Annulation appelante (changement de position, relance) : l'analyse en
   * vol est interrompue au plus vite et lève AbortError (jamais un Result).
   */
  signal?: AbortSignal;
  /**
   * Scheduling lane (audit A9, défaut `background`). `interactive` préempte
   * une analyse de fond en vol et passe devant la file ; `background`
   * attend son tour sans jamais préempter.
   */
  priority?: EnginePriority;
  /**
   * Result cache override. Default: the session's shared LRU. Pass a
   * dedicated instance to isolate a workload (e.g. trap leaves, single-use
   * within a run) so it can never evict advice entries.
   */
  cache?: LruCache<string, EngineMove[]>;
}

export type LocalEngineStatus = 'idle' | 'loading' | 'ready' | 'error';

export const LOCAL_ENGINE_DEPTHS = [12, 16, 18, 20, 24] as const;
export const DEFAULT_LOCAL_DEPTH = 18;

/** Structured engine failure — callers keep reading `.message`, and new code
 * can branch on `.code` (engine-not-ready, timeout, invalid-fen, …).
 * Cancellation still uses DOM AbortError (see `isAbortError`). */
export type EngineErrorCode =
  | 'engine-not-ready'
  | 'timeout'
  | 'invalid-fen'
  | 'unavailable'
  | 'superseded';

export class EngineError extends Error {
  readonly code: EngineErrorCode;

  constructor(code: EngineErrorCode, message: string) {
    super(message);
    this.name = 'EngineError';
    this.code = code;
  }
}

/** True for analyses dropped in favor of a newer / higher-priority one. */
export function isSuperseded(err: unknown): boolean {
  return err instanceof EngineError && err.code === 'superseded';
}

/**
 * Scheduling lane: a single Stockfish worker can only run ONE search.
 * `interactive` (builder advice, graph hover) preempts background work and
 * jumps the queue; `background` (robustness, trap) waits its turn.
 */
export type EnginePriority = 'interactive' | 'background';

/** Minimal worker surface the session needs (real Worker adapted by default). */
export interface WorkerLike {
  postMessage(message: string): void;
  terminate(): void;
  setOnlineHandlers(handlers: {
    onLine(data: unknown): void;
    onError(err: unknown): void;
  }): void;
}

export type WorkerFactory = (url: string) => WorkerLike;

function defaultWorkerFactory(url: string): WorkerLike {
  // Module ES (bootstrap sf-worker.js) : les messages postés pendant l'init
  // wasm + NNUE sont bufferisés par la plateforme, rien n'est perdu.
  const w = new Worker(url, { type: 'module' });
  return {
    postMessage: (message: string) => w.postMessage(message),
    terminate: () => w.terminate(),
    setOnlineHandlers: (handlers) => {
      w.onmessage = (e: MessageEvent) => handlers.onLine(e.data);
      w.onerror = (e: Event | string) => handlers.onError(e);
      w.onmessageerror = (e: MessageEvent) => handlers.onError(e);
    },
  };
}

export interface EngineSessionOptions {
  workerUrl?: string;
  createWorker?: WorkerFactory;
  /** Bounded result cache (default 200 positions). */
  cacheCapacity?: number;
  /** Handshake handshake budget (default 20 s). */
  handshakeTimeoutMs?: number;
  /** Grace delay between `stop` and `go` (default 80 ms). */
  settleDelayMs?: number;
  /** Grace delay after `stop` to collect trailing infos (default 150 ms). */
  graceDelayMs?: number;
}

export const ENGINE_CACHE_CAPACITY = 200;
const DEFAULT_HANDSHAKE_TIMEOUT_MS = 20000;
const DEFAULT_SETTLE_DELAY_MS = 80;
const DEFAULT_GRACE_DELAY_MS = 150;
/** Listener-count tripwire: under normal use ≤ 2 waiters coexist. */
const MAX_LISTENERS_WARN = 8;
/** Plafond de threads (rendements décroissants + mémoire WASM au-delà). */
export const ENGINE_MAX_THREADS = 16;
/** Hash (Mo) quand le multicœur est actif (MultiPV large à D20+). */
const ENGINE_THREADS_HASH_MB = 256;

/**
 * Threads voulus, pur et testable : multicœur seulement si le contexte est
 * isolé cross-origin (SharedArrayBuffer disponible — le serveur dev sert
 * COOP/COEP). Sans isolation, `Threads > 1` ferait échouer le spawn des
 * pthreads : on reste à 1, le moteur marche quand même.
 */
export function engineThreadCount(isolated: boolean, cores: number): number {
  if (!isolated) return 1;
  if (!Number.isFinite(cores) || cores < 2) return 1;
  return Math.max(2, Math.min(Math.floor(cores), ENGINE_MAX_THREADS));
}

/** Threads voulus d'après le navigateur (1 = mono-thread, repli sûr). */
export function desiredEngineThreads(): number {
  try {
    const isolated = typeof crossOriginIsolated === 'boolean' ? crossOriginIsolated : false;
    const cores =
      typeof navigator !== 'undefined' && typeof navigator.hardwareConcurrency === 'number'
        ? navigator.hardwareConcurrency
        : 1;
    return engineThreadCount(isolated, cores);
  } catch {
    return 1;
  }
}

interface WaitHandle {
  promise: Promise<string>;
  /** Cancels the wait (rejects with AbortError). No-op once settled. */
  cancel: () => void;
}

/** One queued engine analysis (audit A9). Lower `lane` runs first. */
interface QueuedAnalysis {
  /** 0 = interactive (builder, hover), 1 = background (robustness, trap). */
  lane: 0 | 1;
  order: number;
  signal?: AbortSignal;
  run: () => Promise<EngineMove[]>;
  resolve: (moves: EngineMove[]) => void;
  reject: (err: unknown) => void;
}

function abortRejection(signal?: AbortSignal): unknown {
  return signal?.reason instanceof Error
    ? signal.reason
    : new DOMException('Analyse annulée', 'AbortError');
}

/**
 * One Stockfish conversation: worker lifecycle, UCI handshake, line routing,
 * per-analysis staleness tokens, bounded result cache.
 */
export class EngineSession {
  private readonly workerUrl: string;
  private readonly createWorker: WorkerFactory;
  private readonly cache: LruCache<string, EngineMove[]>;
  private readonly handshakeTimeoutMs: number;
  private readonly settleDelayMs: number;
  private readonly graceDelayMs: number;

  private worker: WorkerLike | null = null;
  private readyPromise: Promise<void> | null = null;
  private status: LocalEngineStatus = 'idle';
  private readonly statusListeners = new Set<(s: LocalEngineStatus) => void>();
  private readonly lineListeners = new Set<(line: string) => void>();
  /** Fail-fast registry: every pending wait can be rejected at once. */
  private readonly waitFails = new Set<(err: Error) => void>();
  /** Rising token: an analysis whose token is outdated is stale. */
  private analysisSeq = 0;
  private lastError: EngineError | null = null;
  /** Threads appliqués au dernier handshake (1 = mono-thread / pas encore démarré). */
  private appliedThreads = 1;
  /** Pending analyses, ordered interactive-first then FIFO (audit A9). */
  private analysisQueue: QueuedAnalysis[] = [];
  private queueOrder = 0;
  private pumpActive = false;
  /** Priority of the running analysis (`null` when idle). */
  private runningPriority: 0 | 1 | null = null;

  constructor(opts: EngineSessionOptions = {}) {
    this.workerUrl = opts.workerUrl ?? `${import.meta.env.BASE_URL}sf19/sf-worker.js`;
    this.createWorker = opts.createWorker ?? defaultWorkerFactory;
    this.cache = new LruCache<string, EngineMove[]>(opts.cacheCapacity ?? ENGINE_CACHE_CAPACITY);
    this.handshakeTimeoutMs = opts.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS;
    this.settleDelayMs = opts.settleDelayMs ?? DEFAULT_SETTLE_DELAY_MS;
    this.graceDelayMs = opts.graceDelayMs ?? DEFAULT_GRACE_DELAY_MS;
  }

  getStatus(): LocalEngineStatus {
    return this.status;
  }

  onStatusChange(cb: (s: LocalEngineStatus) => void): () => void {
    this.statusListeners.add(cb);
    return () => {
      this.statusListeners.delete(cb);
    };
  }

  /** Last structured failure (`null` when healthy). */
  getLastError(): EngineError | null {
    return this.lastError;
  }

  get cacheSize(): number {
    return this.cache.size;
  }

  clearCache(): void {
    this.cache.clear();
  }

  /** Threads appliqués au dernier handshake (diagnostic / affichage). */
  get threadCount(): number {
    return this.appliedThreads;
  }

  /** Outstanding line waiters — must return to 0 (leak tripwire for tests). */
  get pendingWaiters(): number {
    return this.lineListeners.size;
  }

  private setStatus(s: LocalEngineStatus): void {
    this.status = s;
    this.statusListeners.forEach((cb) => {
      try {
        cb(s);
      } catch {
        /* a throwing listener must never break the others */
      }
    });
  }

  private dispatchLine(line: string): void {
    // Snapshot: a listener may unsubscribe mid-fan-out.
    for (const cb of [...this.lineListeners]) {
      try {
        cb(line);
      } catch {
        /* a throwing waiter must never break the others */
      }
    }
  }

  /**
   * Waits for an engine line matching the predicate. Cancellable via the
   * handle: superseded analyses must not leave ghost listeners behind,
   * even under heavy activity (rapid position switches).
   */
  private waitForLine(predicate: (line: string) => boolean, timeoutMs: number): WaitHandle {
    if (this.lineListeners.size >= MAX_LISTENERS_WARN) {
      console.warn(
        `[chess:engine] ${this.lineListeners.size} pending line waiters — possible leak, check cancel paths.`,
      );
    }
    let timer: ReturnType<typeof setTimeout> | null = null;
    let settled = false;
    let rejectFn: ((err: Error) => void) | null = null;
    let resolveFn: ((line: string) => void) | null = null;
    const cleanup = (): void => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      this.lineListeners.delete(cb);
      this.waitFails.delete(fail);
    };
    const fail = (err: Error): void => {
      if (settled) return;
      settled = true;
      cleanup();
      rejectFn?.(err);
    };
    this.waitFails.add(fail);
    const cb = (line: string): void => {
      if (settled) return;
      let ok = false;
      try {
        ok = predicate(line);
      } catch {
        ok = false;
      }
      if (ok) {
        settled = true;
        cleanup();
        resolveFn?.(line);
      }
    };
    const promise = new Promise<string>((resolve, reject) => {
      resolveFn = resolve;
      rejectFn = reject;
      timer = setTimeout(() => {
        fail(new EngineError('timeout', ENGINE_WAIT_TIMEOUT));
      }, timeoutMs);
    });
    this.lineListeners.add(cb);
    const cancel = (): void => {
      fail(new DOMException('Analyse annulée', 'AbortError'));
    };
    return { promise, cancel };
  }

  /** Rejects every pending wait (worker death) — drained, never throws. */
  private failAllWaits(err: Error): void {
    for (const fail of [...this.waitFails]) {
      try {
        fail(err);
      } catch {
        /* ignore */
      }
    }
  }

  private disposeWorker(): void {
    try {
      this.worker?.terminate();
    } catch {
      /* ignore */
    }
    this.worker = null;
  }

  /** Worker-level failure: fail fast (no 20 s hang), reset for a later retry. */
  private handleWorkerError(err: unknown): void {
    const error =
      err instanceof EngineError ? err : new EngineError('unavailable', ENGINE_WASM_UNAVAILABLE);
    this.lastError = error;
    this.failAllWaits(error);
    this.disposeWorker();
    this.readyPromise = null;
    this.setStatus('error');
  }

  /**
   * Starts the worker (once) and performs the UCI handshake. Idempotent.
   * `signal` aborts a PENDING handshake (AbortError propagates, worker
   * disposed, next caller restarts cleanly).
   */
  async start(signal?: AbortSignal): Promise<void> {
    if (this.readyPromise) return this.readyPromise;

    this.setStatus('loading');
    this.readyPromise = (async (): Promise<void> => {
      let w: WorkerLike;
      try {
        w = this.createWorker(this.workerUrl);
      } catch {
        throw new EngineError('unavailable', ENGINE_WASM_UNAVAILABLE);
      }
      this.worker = w;
      w.setOnlineHandlers({
        onLine: (data) => this.dispatchLine(String(data ?? '')),
        // Fast fallback: a dead/broken worker fails the handshake NOW
        // instead of hanging until the timeout.
        onError: () => this.handleWorkerError(new EngineError('unavailable', ENGINE_WASM_UNAVAILABLE)),
      });
      // Protocol discipline: register the waiter BEFORE sending the command,
      // so a synchronous (or already-queued) answer can never be missed.
      const abortHandshake = (): void => {
        this.failAllWaits(
          signal?.reason instanceof Error
            ? signal.reason
            : new DOMException('Démarrage annulé', 'AbortError'),
        );
      };
      signal?.addEventListener('abort', abortHandshake, { once: true });
      try {
        const uciWait = this.waitForLine((l) => l === 'uciok', this.handshakeTimeoutMs);
        // Mémorise les lignes `option ...` pour détecter le support Threads
        // (un build mono-thread n'expose pas l'option : setoption aveugle).
        const uciSeen: string[] = [];
        const uciTap = (line: string): void => {
          if (uciSeen.length < 200) uciSeen.push(line);
        };
        this.lineListeners.add(uciTap);
        try {
          w.postMessage('uci');
        } catch (err) {
          uciWait.cancel();
          throw err;
        }
        await uciWait.promise;
        this.lineListeners.delete(uciTap);
        const supportsThreads = uciSeen.some((l) => /^option name Threads\b/i.test(l));
        const readyWait = this.waitForLine((l) => l === 'readyok', this.handshakeTimeoutMs);
        try {
          w.postMessage('isready');
        } catch (err) {
          readyWait.cancel();
          throw err;
        }
        await readyWait.promise;
        // Multicœur : build threadé (pthreads) + option exposée + isolation
        // navigateur — sans ce setoption, Stockfish reste à 1 thread malgré
        // les cœurs libres. À froid, avant toute recherche ; un échec ne
        // casse pas le handshake (mono-thread conservé).
        const threads = supportsThreads ? desiredEngineThreads() : 1;
        if (threads > 1) {
          const optWait = this.waitForLine((l) => l === 'readyok', this.handshakeTimeoutMs);
          try {
            w.postMessage(`setoption name Threads value ${threads}`);
            w.postMessage(`setoption name Hash value ${ENGINE_THREADS_HASH_MB}`);
            w.postMessage('isready');
            await optWait.promise;
            this.appliedThreads = threads;
          } catch {
            optWait.cancel();
            // Moteur vivant mais option non confirmée : on continue
            // prudemment en mono-thread plutôt qu'échouer le démarrage.
            this.appliedThreads = 1;
          }
        } else {
          this.appliedThreads = 1;
        }
      } finally {
        signal?.removeEventListener('abort', abortHandshake);
      }
      this.lastError = null;
      this.setStatus('ready');
    })().catch((err: unknown) => {
      if (isAbortError(err)) {
        // Caller went away mid-handshake: drop everything WITHOUT error
        // status (a half-started worker is unsafe to keep) so the next
        // caller restarts cleanly.
        this.disposeWorker();
        this.readyPromise = null;
        this.setStatus('idle');
        throw err;
      }
      const error =
        err instanceof EngineError ? err : new EngineError('unavailable', ENGINE_WASM_UNAVAILABLE);
      this.lastError = error;
      this.disposeWorker();
      this.readyPromise = null;
      this.setStatus('error');
      throw error;
    });

    return this.readyPromise;
  }

  /**
   * Stops the running search and drops every queued analysis (audit A9).
   * In-flight work dies as `superseded` at its next checkpoint; queued work
   * — which never touched the worker — is rejected as a plain abort so all
   * existing silent-cancel paths apply unchanged.
   */
  stopSearch(): void {
    this.analysisSeq++;
    try {
      this.worker?.postMessage('stop');
    } catch {
      /* ignore */
    }
    const pending = this.analysisQueue.splice(0);
    for (const job of pending) {
      try {
        job.reject(abortRejection(job.signal));
      } catch {
        /* ignore */
      }
    }
  }

  /**
   * Enqueues one worker analysis. Interactive arrivals preempt a running
   * BACKGROUND analysis (stale token + stop post: it throws `superseded`
   * at its next checkpoint); anything else waits its turn. FIFO per lane.
   */
  private enqueueAnalysis(
    lane: 0 | 1,
    signal: AbortSignal | undefined,
    run: () => Promise<EngineMove[]>,
  ): Promise<EngineMove[]> {
    return new Promise<EngineMove[]>((resolve, reject) => {
      const job: QueuedAnalysis = {
        lane,
        order: this.queueOrder++,
        signal,
        run,
        resolve,
        reject,
      };
      // Sorted insert: interactive lane first, FIFO within a lane
      // (`order` grows monotonically, so appending per lane suffices).
      const at = this.analysisQueue.findIndex(
        (j) => j.lane > job.lane || (j.lane === job.lane && j.order > job.order),
      );
      if (at < 0) this.analysisQueue.push(job);
      else this.analysisQueue.splice(at, 0, job);
      if (lane === 0 && this.runningPriority === 1) {
        this.preemptRunning();
      }
      this.kickPump();
    });
  }

  /** Preempts the running background analysis for an interactive arrival. */
  private preemptRunning(): void {
    this.analysisSeq++;
    try {
      this.worker?.postMessage('stop');
    } catch {
      /* ignore */
    }
    // The preempted job observes the stale token at its next checkpoint
    // and throws `superseded` (its `bestmove` wait resolves via the stop).
  }

  private kickPump(): void {
    if (this.pumpActive) return;
    const job = this.analysisQueue.shift();
    if (!job) return;
    if (job.signal?.aborted) {
      job.reject(abortRejection(job.signal));
      this.kickPump();
      return;
    }
    this.pumpActive = true;
    this.runningPriority = job.lane;
    job
      .run()
      .then(job.resolve, job.reject)
      .finally(() => {
        this.pumpActive = false;
        this.runningPriority = null;
        this.kickPump();
      });
  }

  /**
   * Analyzes `fen` and returns up to `multiPv` ranked moves (best first).
   *
   * Fast paths (validation, cache hit) run outside the queue so they stay
   * instant even under load. Real worker analyses are serialized through
   * the priority lane queue (audit A9).
   *
   * Throws EngineError('invalid-fen' | 'timeout' | 'unavailable' |
   * 'engine-not-ready' | 'superseded'). `superseded` means another analysis
   * took the worker: never user-facing, callers must end gracefully
   * (partial results kept, no error shown) — exactly like AbortError.
   */
  async analyze(fen: string, opts: LocalAnalysisOptions = {}): Promise<EngineMove[]> {
    const signal = opts.signal;
    throwIfAborted(signal);
    // Fail fast on garbage: structured code, no worker spam.
    try {
      new Chess(fen);
    } catch {
      throw new EngineError('invalid-fen', ENGINE_INVALID_FEN);
    }

    const multiPv = opts.multiPv ?? 3;
    const depth = opts.depth ?? DEFAULT_LOCAL_DEPTH;
    const timeoutMs = opts.timeoutMs ?? 20000;
    const cache = opts.cache ?? this.cache;
    const cacheKey = `${fen}|pv${multiPv}|d${depth}`;
    const cached = cache.get(cacheKey);
    if (cached) return cached;

    const lane: 0 | 1 = opts.priority === 'interactive' ? 0 : 1;
    return this.enqueueAnalysis(lane, signal, () =>
      this.runAnalysis(fen, multiPv, depth, timeoutMs, cache, cacheKey, signal, opts.onProgress, opts.onPartial),
    );
  }

  /**
   * One serialized worker analysis. Runs inside the pump; concurrent work
   * is impossible here, so staleness can only come from preemption
   * (interactive arrival) or stopSearch() — both throw `superseded`.
   */
  private async runAnalysis(
    fen: string,
    multiPv: number,
    depth: number,
    timeoutMs: number,
    cache: LruCache<string, EngineMove[]>,
    cacheKey: string,
    signal: AbortSignal | undefined,
    onProgress: ((depthReached: number) => void) | undefined,
    onPartial: ((moves: EngineMove[], depthReached: number) => void) | undefined,
  ): Promise<EngineMove[]> {
    await this.start(signal);
    const w = this.worker;
    if (!w) throw new EngineError('engine-not-ready', ENGINE_NOT_READY);

    const mySeq = this.analysisSeq;
    const isStale = (): boolean => mySeq !== this.analysisSeq;

    // Let any previous search stop cleanly (abortable: caller went away).
    w.postMessage('stop');
    await abortableSleep(this.settleDelayMs, signal);
    if (isStale()) throw new EngineError('superseded', ENGINE_SUPERSEDED);

    const best = new Map<number, PvInfo>();
    const trajByUci = new Map<string, EvalPoint[]>();
    let maxDepth = 0;
    let lastPartialAt = 0;

    const listener = (line: string): void => {
      if (isStale()) return;
      if (line.startsWith('info ')) {
        const before = maxDepth;
        parseInfoLine(line, best, (d) => {
          if (d > maxDepth) {
            maxDepth = d;
            try {
              onProgress?.(d);
            } catch {
              /* ignore */
            }
          }
        });
        // Lignes live (direct de la réflexion) : la ligne courante est
        // enregistrée AVANT ce snapshot (parseInfoLine notifie avant
        // d'enregistrer — un snapshot dans le callback serait vide).
        // Throttlé, jamais de throw vers le moteur.
        if (onPartial && maxDepth > before) {
          const now = Date.now();
          if (now - lastPartialAt >= 400) {
            lastPartialAt = now;
            try {
              const ordered = [...best.entries()].sort((a, b) => a[0] - b[0]);
              const moves: EngineMove[] = [];
              for (const [, info] of ordered.slice(0, multiPv)) {
                const em = pvInfoToEngineMove(fen, info.pv[0], info);
                if (em) moves.push(em);
              }
              if (moves.length > 0) onPartial(moves, maxDepth);
            } catch {
              /* ignore */
            }
          }
        }
        // Free trajectory: one entry per completed depth and per move.
        // Key MUST use the same canonicalization as em.uci or the lookup
        // below misses silently (audit B3).
        const basics = parseInfoBasics(line);
        if (basics) {
          recordTrajectoryPoint(
            trajByUci,
            normalizePvUci(fen, basics.firstUci),
            basics.depth,
            basics.cp,
            basics.mate,
          );
        }
      }
    };
    this.lineListeners.add(listener);

    let bestmoveWait: WaitHandle | null = null;
    // Caller abort cuts the wait short (AbortError propagates via the catch).
    const abortSearch = (): void => {
      bestmoveWait?.cancel();
    };
    signal?.addEventListener('abort', abortSearch, { once: true });
    try {
      // Waiter first (see start()): a queued `bestmove` must not be missed.
      bestmoveWait = this.waitForLine((l) => l.startsWith('bestmove'), timeoutMs);
      w.postMessage(`setoption name MultiPV value ${multiPv}`);
      w.postMessage(`position fen ${fen}`);
      w.postMessage(`go depth ${depth}`);

      // Waits for `bestmove`, else returns the best partial at timeout.
      try {
        await bestmoveWait.promise;
      } catch (err) {
        // Caller abort wins and propagates as-is. Anything else stale means
        // preemption/stop: explicit `superseded`, never silent [].
        if (isAbortError(err)) throw err;
        if (isStale()) {
          throw err instanceof EngineError && err.code === 'superseded'
            ? err
            : new EngineError('superseded', ENGINE_SUPERSEDED);
        }
        try {
          w.postMessage('stop');
        } catch {
          /* ignore */
        }
        // Short delay for the engine to emit its trailing infos.
        await abortableSleep(this.graceDelayMs, signal);
      }
    } finally {
      signal?.removeEventListener('abort', abortSearch);
      bestmoveWait?.cancel();
      this.lineListeners.delete(listener);
    }

    // Preempted mid-assembly: the listener ignored stale lines, so whatever
    // sits in `best` is untrustworthy — fail explicitly, don't serve it.
    if (isStale()) throw new EngineError('superseded', ENGINE_SUPERSEDED);
    if (best.size === 0) return [];

    const moves: EngineMove[] = [];
    const ordered = [...best.entries()].sort((a, b) => a[0] - b[0]);
    for (const [, info] of ordered.slice(0, multiPv)) {
      const em = pvInfoToEngineMove(fen, info.pv[0], info);
      if (em) {
        const traj = trajByUci.get(em.uci);
        if (traj && traj.length > 0) em.trajectory = traj;
        moves.push(em);
      }
    }

    // Audit B9: only cache complete results. After timeout, partial results
    // (e.g., D14) were stored under the requested depth key (D24), poisoning
    // future D24 requests. Now we cache only if the engine reached the target
    // depth (maxDepth tracks the highest completed depth from info lines).
    if (moves.length > 0 && maxDepth >= depth) {
      cache.set(cacheKey, moves);
    }
    return moves;
  }
}

interface PvInfo {
  cp?: number;
  mate?: number;
  pv: string[];
  depth: number;
}

function parseInfoLine(line: string, best: Map<number, PvInfo>, onDepth: (d: number) => void): void {
  if (!line.startsWith('info ')) return;
  const depthMatch = /depth (\d+)/.exec(line);
  if (depthMatch) onDepth(parseInt(depthMatch[1], 10));
  const mpvMatch = /multipv (\d+)/.exec(line);
  const pvMatch = / pv (.+)$/.exec(line);
  if (!mpvMatch || !pvMatch) return;
  const idx = parseInt(mpvMatch[1], 10);
  // Aspiration-window failures (`score cp N lowerbound|upperbound`) are NOT
  // evaluations: keep tracking PV + depth, but never let the bound overwrite
  // a real score (audit B3 — it fabricated amplitude downstream).
  const bounded = /\b(lower|upper)bound\b/.test(line);
  const scoreMatch = /score (cp (-?\d+)|mate (-?\d+))/.exec(line);
  const pv = pvMatch[1].trim().split(/\s+/);
  if (pv.length === 0 || !pv[0]) return;
  const prev = best.get(idx);
  const entry: PvInfo = {
    pv,
    depth: depthMatch ? parseInt(depthMatch[1], 10) : (prev?.depth ?? 0),
  };
  if (scoreMatch && !bounded) {
    if (scoreMatch[2] !== undefined) entry.cp = parseInt(scoreMatch[2], 10);
    else if (scoreMatch[3] !== undefined) entry.mate = parseInt(scoreMatch[3], 10);
  } else if (prev) {
    entry.cp = prev.cp;
    entry.mate = prev.mate;
  }
  best.set(idx, entry);
}

/** Extracts the essentials of an `info` line: depth, score, PV first move. */
function parseInfoBasics(line: string): { depth: number; cp?: number; mate?: number; firstUci: string } | null {
  if (!line.startsWith('info ')) return null;
  // Aspiration bounds are window failures, not evals: no trajectory point.
  if (/\b(lower|upper)bound\b/.test(line)) return null;
  const depthMatch = /\bdepth (\d+)/.exec(line);
  const pvMatch = /\bpv (\S+)/.exec(line);
  if (!depthMatch || !pvMatch) return null;
  const scoreMatch = /\bscore (cp (-?\d+)|mate (-?\d+))/.exec(line);
  const out: { depth: number; cp?: number; mate?: number; firstUci: string } = {
    depth: parseInt(depthMatch[1], 10),
    firstUci: pvMatch[1],
  };
  if (scoreMatch) {
    if (scoreMatch[2] !== undefined) out.cp = parseInt(scoreMatch[2], 10);
    else if (scoreMatch[3] !== undefined) out.mate = parseInt(scoreMatch[3], 10);
  }
  return out;
}

/**
 * Records the (depth -> eval) point in the move trajectory.
 * Depths arrive in ascending order; a depth duplicate overwrites the
 * previous one (engine refinement within the same iteration).
 */
function recordTrajectoryPoint(
  trajByUci: Map<string, EvalPoint[]>,
  firstUci: string,
  depth: number,
  cp?: number,
  mate?: number,
): void {
  if (cp === undefined && mate === undefined) return;
  let arr = trajByUci.get(firstUci);
  if (!arr) {
    arr = [];
    trajByUci.set(firstUci, arr);
  }
  const last = arr[arr.length - 1];
  const pt: EvalPoint = { depth, cp, mate };
  if (!last) arr.push(pt);
  else if (depth > last.depth) arr.push(pt);
  else if (depth === last.depth) arr[arr.length - 1] = pt;
}

/**
 * Local UCI info → EngineMove via the SHARED converter (`utils/enginePv`).
 * Same rule set as the cloud fetcher (castle tolerance, promotion case,
 * SAN capped at 6 for display, full UCI line kept for horizon walks):
 * no more divergent copies.
 */
function pvInfoToEngineMove(fen: string, firstUci: string, info: PvInfo): EngineMove | null {
  return pvToEngineMove(
    fen,
    info.pv.length > 0 ? info.pv : [firstUci],
    { cp: info.cp, mate: info.mate },
    info.depth,
  );
}

// ---------------------------------------------------------------------------
// Module singleton: one Stockfish in memory, historical API preserved.
// ---------------------------------------------------------------------------

const sharedSession = new EngineSession();

export function getLocalEngineStatus(): LocalEngineStatus {
  return sharedSession.getStatus();
}

export function onLocalEngineStatusChange(cb: (s: LocalEngineStatus) => void): () => void {
  return sharedSession.onStatusChange(cb);
}

/** Threads appliqués au dernier handshake du singleton (1 = mono-thread / pas démarré). */
export function getLocalEngineThreads(): number {
  return sharedSession.threadCount;
}

/** Last structured engine failure (`null` when healthy). */
export function getLocalEngineError(): EngineError | null {
  return sharedSession.getLastError();
}

/** Clears the bounded result cache (memory pressure, tests). */
export function clearLocalEngineCache(): void {
  sharedSession.clearCache();
}

/** Starts the worker (once) and awaits the UCI handshake. */
export function ensureLocalEngine(): Promise<void> {
  return sharedSession.start();
}

/** Stops the running search (the next `analyzeLocalFen` restarts cleanly). */
export function stopLocalAnalysis(): void {
  sharedSession.stopSearch();
}

/**
 * Analyzes `fen` with the local Stockfish, returning up to `multiPv`
 * ranked moves (best first).
 */
export async function analyzeLocalFen(fen: string, opts: LocalAnalysisOptions = {}): Promise<EngineMove[]> {
  return sharedSession.analyze(fen, opts);
}

export interface AdaptiveOptions {
  multiPv?: number;
  startDepth?: number;
  step?: number;
  maxDepth?: number;
  timeoutMsPerRound?: number;
  onProgress?: (depth: number, verdict: string) => void;
  /** Scheduling lane, forwarded to every round (audit A9). */
  priority?: EnginePriority;
  /**
   * Annulation appelante (audit B10): changement de position, démontage.
   * Propagé à chaque round. Absent → seule la péremption peut annuler.
   */
  signal?: AbortSignal;
  /**
   * Explicit session (tests, multi-context). Defaults to the shared
   * singleton — production callers pass nothing and behave as before.
   */
  session?: EngineSession;
}

export interface AdaptiveResult {
  moves: EngineMove[];
  reachedDepth: number;
  stable: boolean;
  stoppedReason: 'stable' | 'max-depth' | 'no-data';
}

/**
 * Adaptive depth: D12 -> if the best move's eval is stable we stop (fast);
 * if it still moves we deepen stepwise up to maxDepth. The engine hash table
 * persists across rounds, so deepening costs less than a direct maxDepth
 * analysis.
 *
 * Trajectory honesty (audit B4): rounds after the first replay early depths
 * from the warm hash (≈ final eval), so their trajectories look flat even
 * when the position is volatile. The loop still stops/starts on each
 * round's own verdict, but the RETURNED moves always carry the FIRST round's
 * (cold, genuine) trajectories, matched by UCI — a move that only appears
 * in later rounds keeps its own. Downstream (stability adjustment, advisor)
 * therefore never scores a hash artifact.
 */
export async function analyzeAdaptiveFen(fen: string, opts: AdaptiveOptions = {}): Promise<AdaptiveResult> {
  const multiPv = opts.multiPv ?? 5;
  const step = opts.step ?? 4;
  const maxDepth = opts.maxDepth ?? 28;
  const timeoutMsPerRound = opts.timeoutMsPerRound ?? 15000;
  let depth = opts.startDepth ?? 12;
  const session = opts.session ?? sharedSession;

  const firstTrajectories = new Map<string, EvalPoint[] | undefined>();
  let isFirstRound = true;
  const withFirstTrajectories = (ms: EngineMove[]): EngineMove[] =>
    ms.map((m) => {
      const cold = firstTrajectories.get(m.uci);
      return cold && cold.length > 0 ? { ...m, trajectory: cold } : m;
    });

  let moves: EngineMove[] = [];
  for (let round = 0; round < 8; round++) {
    moves = await session.analyze(fen, {
      multiPv,
      depth,
      timeoutMs: timeoutMsPerRound,
      priority: opts.priority,
      signal: opts.signal,
    });
    if (isFirstRound) {
      isFirstRound = false;
      for (const m of moves) firstTrajectories.set(m.uci, m.trajectory);
    }
    const top = moves[0];
    const rep = top?.trajectory ? analyzeTrajectory(top.trajectory) : null;
    try {
      opts.onProgress?.(depth, rep ? STABILITY_LABELS[rep.verdict] : NO_STABILITY_DATA);
    } catch {
      /* ignore */
    }
    if (!rep || !rep.needsDeeper || depth >= maxDepth) {
      if (!rep) {
        return { moves: withFirstTrajectories(moves), reachedDepth: depth, stable: true, stoppedReason: 'no-data' };
      }
      return {
        moves: withFirstTrajectories(moves),
        reachedDepth: depth,
        stable: !rep.needsDeeper,
        stoppedReason: rep.needsDeeper ? 'max-depth' : 'stable',
      };
    }
    depth = Math.min(depth + step, maxDepth);
  }
  return { moves: withFirstTrajectories(moves), reachedDepth: depth, stable: false, stoppedReason: 'max-depth' };
}
