import { describe, expect, it, vi } from 'vitest';
import type { EngineMove } from '../types/chess';
import { isAbortError } from '../utils/async';
import { LruCache } from '../utils/lru';
import {
  analyzeAdaptiveFen,
  EngineError,
  engineThreadCount,
  EngineSession,
  isSuperseded,
  type WorkerLike,
} from './localEngine';

const INITIAL = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const clockFen = (n: number): string =>
  `rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 ${n}`;

type Emitter = (line: string) => void;
type Failer = (err: unknown) => void;
type Script = (msg: string, emit: Emitter, fail: Failer) => void;

/** Scripted in-memory Stockfish stand-in (no Worker, no wasm). */
class FakeWorker implements WorkerLike {
  readonly sent: string[] = [];
  terminated = false;
  private handlers: { onLine(data: unknown): void; onError(err: unknown): void } | null = null;
  private readonly script: Script;

  constructor(script: Script) {
    this.script = script;
  }

  postMessage(message: string): void {
    this.sent.push(message);
    this.script(
      message,
      (line) => this.handlers?.onLine(line),
      (err) => this.handlers?.onError(err),
    );
  }

  terminate(): void {
    this.terminated = true;
  }

  setOnlineHandlers(handlers: { onLine(data: unknown): void; onError(err: unknown): void }): void {
    this.handlers = handlers;
  }

  goCount(): number {
    return this.sent.filter((m) => m.startsWith('go ')).length;
  }
}

function standardScript(replyUci = 'e2e4', replyCp = 40): Script {
  return (msg, emit) => {
    if (msg === 'uci') emit('uciok');
    else if (msg === 'isready') emit('readyok');
    else if (msg.startsWith('go ')) {
      emit(
        `info depth 12 seldepth 20 multipv 1 score cp ${replyCp} nodes 100 nps 1000 time 10 pv ${replyUci}`,
      );
      emit(`bestmove ${replyUci}`);
    }
  };
}

/** Comme standardScript, mais expose `option name Threads` (build threadé). */
function threadedScript(replyUci = 'e2e4', replyCp = 40): Script {
  const base = standardScript(replyUci, replyCp);
  return (msg, emit, fail) => {
    if (msg === 'uci') {
      emit('option name Threads type spin default 1 min 1 max 256');
      emit('uciok');
    } else {
      base(msg, emit, fail);
    }
  };
}

function sessionWith(fake: FakeWorker, extra: Record<string, unknown> = {}): EngineSession {
  return new EngineSession({ workerUrl: 'fake', createWorker: () => fake, ...extra });
}

/**
 * Gated script: handshake answers instantly, `go` answers only when the
 * test releases them — full control over worker interleaving.
 */
function gatedScript() {
  const pending: Array<() => void> = [];
  const script: Script = (msg, emit) => {
    if (msg === 'uci') emit('uciok');
    else if (msg === 'isready') emit('readyok');
    else if (msg.startsWith('go ')) {
      pending.push(() => {
        emit('info depth 12 seldepth 20 multipv 1 score cp 40 nodes 100 nps 1000 time 10 pv e2e4');
        emit('bestmove e2e4');
      });
    }
  };
  return { script, pending, release: () => pending.shift()?.() };
}

/** Waits until n worker `go`s are gated (pump + 80 ms settle take real time). */
async function waitForPending(pending: unknown[], n = 1, budgetMs = 3000): Promise<void> {
  const t0 = Date.now();
  while (pending.length < n) {
    if (Date.now() - t0 > budgetMs) {
      throw new Error(`timed out waiting for ${n} pending go(s), got ${pending.length}`);
    }
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe('EngineSession threads (multicœur)', () => {
  it('engineThreadCount: 1 sans isolation, cœurs plafonnés à 16', () => {
    expect(engineThreadCount(false, 8)).toBe(1);
    expect(engineThreadCount(false, 64)).toBe(1);
    expect(engineThreadCount(true, 1)).toBe(1);
    expect(engineThreadCount(true, 0)).toBe(1);
    expect(engineThreadCount(true, Number.NaN)).toBe(1);
    expect(engineThreadCount(true, 8)).toBe(8);
    expect(engineThreadCount(true, 64)).toBe(16);
  });

  it('applique Threads+Hash au handshake quand isolé, rien sinon', async () => {
    vi.stubGlobal('crossOriginIsolated', true);
    vi.stubGlobal('navigator', { hardwareConcurrency: 8 });
    try {
      const fake = new FakeWorker(threadedScript());
      const session = sessionWith(fake);
      await session.start();
      expect(fake.sent).toContain('setoption name Threads value 8');
      expect(fake.sent).toContain('setoption name Hash value 256');
      expect(session.threadCount).toBe(8);
    } finally {
      vi.unstubAllGlobals();
    }
    // Build sans option Threads : même isolé, aucun setoption.
    vi.stubGlobal('crossOriginIsolated', true);
    vi.stubGlobal('navigator', { hardwareConcurrency: 8 });
    try {
      const fake = new FakeWorker(standardScript());
      const session = sessionWith(fake);
      await session.start();
      expect(fake.sent.some((m) => m.startsWith('setoption'))).toBe(false);
      expect(session.threadCount).toBe(1);
    } finally {
      vi.unstubAllGlobals();
    }
    // Sans isolation : aucun setoption, mono-thread (le moteur marche quand même).
    const plain = new FakeWorker(threadedScript());
    const mono = sessionWith(plain);
    await mono.start();
    expect(plain.sent.some((m) => m.startsWith('setoption'))).toBe(false);
    expect(mono.threadCount).toBe(1);
  });
});

describe('EngineSession handshake', () => {
  it('goes idle → loading → ready and starts only once', async () => {    const fake = new FakeWorker(standardScript());
    let factoryCalls = 0;
    const session = new EngineSession({
      workerUrl: 'fake',
      createWorker: () => {
        factoryCalls++;
        return fake;
      },
    });
    const seen: string[] = [];
    session.onStatusChange((s) => seen.push(s));
    expect(session.getStatus()).toBe('idle');
    await session.start();
    await session.start();
    expect(session.getStatus()).toBe('ready');
    expect(factoryCalls).toBe(1);
    expect(seen).toEqual(['loading', 'ready']);
  });

  it('a throwing status listener does not break the others', async () => {
    const fake = new FakeWorker(standardScript());
    const session = sessionWith(fake);
    const seen: string[] = [];
    session.onStatusChange(() => {
      throw new Error('listener boom');
    });
    session.onStatusChange((s) => seen.push(s));
    await session.start();
    expect(seen).toEqual(['loading', 'ready']);
  });

  it('factory failure → structured unavailable error + error status', async () => {
    const session = new EngineSession({
      workerUrl: 'fake',
      createWorker: () => {
        throw new Error('no Worker here');
      },
    });
    await expect(session.start()).rejects.toMatchObject({ name: 'EngineError', code: 'unavailable' });
    expect(session.getStatus()).toBe('error');
    expect(session.getLastError()?.code).toBe('unavailable');
  });

  it('worker onerror fails fast with unavailable (no timeout hang)', async () => {
    const fake = new FakeWorker((msg, _emit, fail) => {
      if (msg === 'uci') fail(new Error('load failed'));
    });
    const session = sessionWith(fake, { handshakeTimeoutMs: 5000 });
    await expect(session.start()).rejects.toMatchObject({ code: 'unavailable' });
    expect(session.getStatus()).toBe('error');
  });

  it('stopSearch before start is a safe no-op', () => {
    const fake = new FakeWorker(standardScript());
    const session = sessionWith(fake);
    expect(() => session.stopSearch()).not.toThrow();
    expect(session.getStatus()).toBe('idle');
  });
});

describe('EngineSession.analyze', () => {
  it('returns the move and serves repeats from cache (no second go)', async () => {
    const fake = new FakeWorker(standardScript());
    const session = sessionWith(fake);
    const first = await session.analyze(INITIAL, { multiPv: 1, depth: 12 });
    expect(first).toHaveLength(1);
    expect(first[0].san).toBe('e4');
    expect(first[0].trajectory?.length).toBeGreaterThan(0);
    expect(fake.goCount()).toBe(1);
    const second = await session.analyze(INITIAL, { multiPv: 1, depth: 12 });
    expect(second).toBe(first); // same cached reference
    expect(fake.goCount()).toBe(1);
    expect(session.pendingWaiters).toBe(0);
  });

  it('streams live partial lines per completed depth (throttled, never cached)', async () => {
    const script: Script = (msg, emit) => {
      if (msg === 'uci') emit('uciok');
      else if (msg === 'isready') emit('readyok');
      else if (msg.startsWith('go ')) {
        emit('info depth 10 seldepth 14 multipv 1 score cp 30 nodes 100 nps 1000 time 10 pv e2e4');
        setTimeout(() => {
          emit('info depth 13 seldepth 18 multipv 1 score cp 35 nodes 200 nps 2000 time 20 pv e2e4');
          emit('info depth 13 seldepth 18 multipv 2 score cp 20 nodes 200 nps 2000 time 20 pv d2d4');
        }, 450);
        setTimeout(() => {
          emit('info depth 14 seldepth 20 multipv 1 score cp 36 nodes 300 nps 3000 time 30 pv e2e4');
          emit('info depth 14 seldepth 20 multipv 2 score cp 22 nodes 300 nps 3000 time 30 pv d2d4');
          emit('bestmove e2e4');
        }, 900);
      }
    };
    const fake = new FakeWorker(script);
    const session = sessionWith(fake);
    const partials: { depth: number; ucis: string[] }[] = [];
    const moves = await session.analyze(INITIAL, {
      multiPv: 2,
      depth: 14,
      onPartial: (ms, d) => {
        partials.push({ depth: d, ucis: ms.map((m) => m.uci) });
      },
    });
    // Conclusion intacte (les partielles ne changent rien au résultat).
    expect(moves.map((m) => m.uci)).toEqual(['e2e4', 'd2d4']);
    // Un direct par profondeur complétée (les 2e lignes d'une même
    // profondeur ne re-déclenchent pas) : 10 → 13 → 14.
    expect(partials).toEqual([
      { depth: 10, ucis: ['e2e4'] },
      { depth: 13, ucis: ['e2e4'] },
      { depth: 14, ucis: ['e2e4', 'd2d4'] },
    ]);
  });

  it('bounds the cache: eldest entries are evicted', async () => {
    const fake = new FakeWorker(standardScript());
    const session = sessionWith(fake, { cacheCapacity: 3 });
    for (const n of [1, 2, 3, 4]) {
      const moves = await session.analyze(clockFen(n), { multiPv: 1, depth: 12 });
      expect(moves).toHaveLength(1);
    }
    expect(session.cacheSize).toBe(3);
    expect(fake.goCount()).toBe(4);
    // Fen #1 was evicted → re-analysis re-tasks the worker…
    await session.analyze(clockFen(1), { multiPv: 1, depth: 12 });
    expect(fake.goCount()).toBe(5);
    // …while fen #4 is still cached.
    await session.analyze(clockFen(4), { multiPv: 1, depth: 12 });
    expect(fake.goCount()).toBe(5);
    session.clearCache();
    expect(session.cacheSize).toBe(0);
  });

  it('background analyses serialize without stomping each other', async () => {
    const fake = new FakeWorker(standardScript());
    const session = sessionWith(fake);
    // Same tick: B queues behind A instead of killing it (audit A9).
    const a = session.analyze(clockFen(1), { multiPv: 1, depth: 12 });
    const b = session.analyze(clockFen(2), { multiPv: 1, depth: 12 });
    expect((await a)).toHaveLength(1);
    expect((await b)).toHaveLength(1);
    expect(fake.goCount()).toBe(2);
    expect(session.pendingWaiters).toBe(0);
  });

  it('genuine engine silence still resolves [] (not superseded)', async () => {
    const silent: Script = (msg, emit) => {
      if (msg === 'uci') emit('uciok');
      else if (msg === 'isready') emit('readyok');
      else if (msg.startsWith('go ')) emit('bestmove 0000');
    };
    const fake = new FakeWorker(silent);
    const session = sessionWith(fake);
    // 'bestmove 0000' parses to no legal move: best map stays empty.
    const moves = await session.analyze(clockFen(1), { multiPv: 1, depth: 12, timeoutMs: 500 });
    expect(moves).toEqual([]);
  });

  it('invalid FEN fails fast with a structured code (worker untouched)', async () => {
    let factoryCalls = 0;
    const fake = new FakeWorker(standardScript());
    const session = new EngineSession({
      workerUrl: 'fake',
      createWorker: () => {
        factoryCalls++;
        return fake;
      },
    });
    const err = await session.analyze('not a fen').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EngineError);
    expect((err as EngineError).code).toBe('invalid-fen');
    expect(factoryCalls).toBe(0);
  });

  it('stopSearch rejects in-flight work as superseded (never silent [])', async () => {
    const fake = new FakeWorker(standardScript());
    const session = sessionWith(fake);
    const a = session.analyze(clockFen(1), { multiPv: 1, depth: 12 });
    // Let the analysis take its staleness token first: like in production,
    // stopSearch always lands on an already-running search.
    await new Promise((r) => setTimeout(r, 0));
    session.stopSearch();
    await expect(a).rejects.toSatisfy((e: unknown) => isSuperseded(e));
    expect(session.pendingWaiters).toBe(0);
  });

  it('stopSearch purges queued work as plain aborts (existing silent paths)', async () => {
    const { script, pending, release } = gatedScript();
    const fake = new FakeWorker(script);
    const session = sessionWith(fake);
    const a = session.analyze(clockFen(1), { multiPv: 1, depth: 12 });
    await new Promise((r) => setTimeout(r, 120)); // A holds the worker, gated
    const b = session.analyze(clockFen(2), { multiPv: 1, depth: 12 });
    const c = session.analyze(clockFen(3), { multiPv: 1, depth: 12 });
    let bErr: unknown;
    let cErr: unknown;
    void b.catch((e: unknown) => {
      bErr = e;
    });
    void c.catch((e: unknown) => {
      cErr = e;
    });
    expect(pending).toHaveLength(1);
    session.stopSearch();
    await new Promise((r) => setTimeout(r, 0));
    expect(isAbortError(bErr)).toBe(true);
    expect(isAbortError(cErr)).toBe(true);
    // In-flight A dies as superseded once released (stale token).
    release();
    await expect(a).rejects.toSatisfy((e: unknown) => isSuperseded(e));
    expect(session.pendingWaiters).toBe(0);
  });

  it('interactive arrivals preempt background in-flight work', async () => {
    const { script, pending, release } = gatedScript();
    const fake = new FakeWorker(script);
    const session = sessionWith(fake);
    const a = session.analyze(clockFen(1), { multiPv: 1, depth: 12 });
    await waitForPending(pending); // A holds the worker, gated
    const c = session.analyze(clockFen(3), { multiPv: 1, depth: 12, priority: 'interactive' });
    // Release: A resolves first but was preempted → superseded.
    release();
    await expect(a).rejects.toSatisfy((e: unknown) => isSuperseded(e));
    await waitForPending(pending); // only C's go is now pending
    release();
    const moves = await c;
    expect(moves).toHaveLength(1);
    expect(session.pendingWaiters).toBe(0);
  });

  it('interactive jumps the background queue (FIFO per lane)', async () => {
    const { script, pending, release } = gatedScript();
    const fake = new FakeWorker(script);
    const session = sessionWith(fake);
    // A is interactive: later arrivals queue behind without preempting it.
    const a = session.analyze(clockFen(1), { multiPv: 1, depth: 12, priority: 'interactive' });
    await waitForPending(pending); // A holds the worker, gated
    const b = session.analyze(clockFen(2), { multiPv: 1, depth: 12 });
    const c = session.analyze(clockFen(3), { multiPv: 1, depth: 12, priority: 'interactive' });
    release(); // A completes
    expect(await a).toHaveLength(1);
    await waitForPending(pending);
    release(); // C runs next (jumped ahead of B)
    expect(await c).toHaveLength(1);
    await waitForPending(pending);
    release(); // then B
    expect(await b).toHaveLength(1);
    const gos: string[] = [];
    for (const m of fake.sent) {
      if (m.startsWith('position fen ')) gos.push(m.slice('position fen '.length));
    }
    expect(gos).toEqual([clockFen(1), clockFen(3), clockFen(2)]);
    expect(session.pendingWaiters).toBe(0);
  });

  it('B1: background work never stomps in-flight interactive advice', async () => {
    // Exact B1 repro shape (audit): builder advice analyzing while a
    // background analysis (robustness/trap style) starts on the same worker.
    // Pre-A9 the newcomer bumped analysisSeq, advice resolved [] and the UI
    // showed a bogus "engine unavailable" error (cascading to trap disable).
    const { script, pending, release } = gatedScript();
    const fake = new FakeWorker(script);
    const session = sessionWith(fake);
    const advice = session.analyze(clockFen(1), { multiPv: 5, depth: 18, priority: 'interactive' });
    await waitForPending(pending); // advice holds the worker, gated
    const background = session.analyze(clockFen(2), { multiPv: 1, depth: 12 });
    release(); // answer the advice go
    const adviceMoves = await advice;
    expect(adviceMoves).toHaveLength(1); // NOT [] — no bogus engine error downstream
    await waitForPending(pending); // background ran after, never stomped
    release();
    expect(await background).toHaveLength(1);
    expect(session.pendingWaiters).toBe(0);
  });

  it('B2: concurrent background runs serialize without destroying each other', async () => {
    // Exact B2 shape (audit): robustness-style and trap-style runs chaining
    // analyzeLocalFen on the shared worker at the same time. Pre-A9 every
    // new call bumped analysisSeq, so all but the last resolved [] (bogus
    // skips / unknown verdicts, silently). Now: FIFO order, all complete.
    const fake = new FakeWorker(standardScript());
    const session = sessionWith(fake);
    const run = async (fens: string[]): Promise<number> => {
      let total = 0;
      for (const f of fens) {
        const moves = await session.analyze(f, { multiPv: 1, depth: 12 });
        total += moves.length;
      }
      return total;
    };
    const robustnessLike = run([clockFen(1), clockFen(2), clockFen(3)]);
    const trapLike = run([clockFen(4), clockFen(5)]);
    const [rMoves, tMoves] = await Promise.all([robustnessLike, trapLike]);
    // Nothing was stomped into [] and nothing threw: 3 + 2 analyzed moves.
    expect(rMoves).toBe(3);
    expect(tMoves).toBe(2);
    expect(fake.goCount()).toBe(5);
    expect(session.pendingWaiters).toBe(0);
  });

  it('cache hits bypass a busy pump without worker traffic', async () => {
    const { script, release } = gatedScript();
    const fake = new FakeWorker(script);
    const session = sessionWith(fake);
    // Warm the cache first (gated script still answers when released).
    const warm = session.analyze(clockFen(9), { multiPv: 1, depth: 12 });
    await new Promise((r) => setTimeout(r, 120));
    release();
    expect(await warm).toHaveLength(1);
    const gosBefore = fake.goCount();
    // Occupy the worker, then ask for the cached FEN: instant, no new go.
    const busy = session.analyze(clockFen(1), { multiPv: 1, depth: 12 });
    await new Promise((r) => setTimeout(r, 120));
    const cached = await session.analyze(clockFen(9), { multiPv: 1, depth: 12 });
    expect(cached).toHaveLength(1);
    expect(fake.goCount()).toBe(gosBefore + 1); // only the busy job tasked the worker
    release();
    expect(await busy).toHaveLength(1);
  });
});

describe('EngineError', () => {
  it('is an Error with a code', () => {
    const err = new EngineError('timeout', 'Délai dépassé');
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('EngineError');
    expect(err.code).toBe('timeout');
    expect(err.message).toBe('Délai dépassé');
  });
});

describe('per-call cache override (audit A8)', () => {
  it('isolates workloads from the shared session cache', async () => {
    const fake = new FakeWorker(standardScript());
    const session = sessionWith(fake);
    const isolated = new LruCache<string, EngineMove[]>(16);
    await session.analyze(INITIAL, { multiPv: 1, depth: 12, cache: isolated });
    expect(fake.goCount()).toBe(1);
    expect(isolated.size).toBe(1);
    // Shared cache untouched: a default call re-tasks the worker...
    await session.analyze(INITIAL, { multiPv: 1, depth: 12 });
    expect(fake.goCount()).toBe(2);
    expect(session.cacheSize).toBe(1);
    // ...while the isolated cache serves its own repeats.
    await session.analyze(INITIAL, { multiPv: 1, depth: 12, cache: isolated });
    expect(fake.goCount()).toBe(2);
  });
});

describe('trajectory integrity (audit B3)', () => {
  const PROMO_FEN = '8/4P3/8/8/8/1k6/8/4K3 w - - 0 1';

  it('unifies mixed-case PV surfaces into one trajectory key', async () => {
    // Same move written lower- then upper-case across depths: pre-fix this
    // split into two map keys ('e7e8q' + 'e7e8Q') and the lookup only found
    // the final form's points.
    const mixed: Script = (msg, emit) => {
      if (msg === 'uci') emit('uciok');
      else if (msg === 'isready') emit('readyok');
      else if (msg.startsWith('go ')) {
        emit('info depth 8 seldepth 20 multipv 1 score cp 40 nodes 100 nps 1000 time 10 pv e7e8q');
        emit('info depth 9 seldepth 20 multipv 1 score cp 42 nodes 100 nps 1000 time 10 pv e7e8q');
        emit('info depth 10 seldepth 20 multipv 1 score cp 44 nodes 100 nps 1000 time 10 pv e7e8Q');
        emit('info depth 11 seldepth 20 multipv 1 score cp 46 nodes 100 nps 1000 time 10 pv e7e8Q');
        emit('info depth 12 seldepth 20 multipv 1 score cp 48 nodes 100 nps 1000 time 10 pv e7e8Q');
        emit('bestmove e7e8Q');
      }
    };
    const fake = new FakeWorker(mixed);
    const session = sessionWith(fake);
    const moves = await session.analyze(PROMO_FEN, { multiPv: 1, depth: 12 });
    expect(moves).toHaveLength(1);
    expect(moves[0].san).toBe('e8=Q');
    expect(moves[0].uci).toBe('e7e8q');
    expect(moves[0].trajectory?.map((p) => p.depth)).toEqual([8, 9, 10, 11, 12]);
  });

  it('adaptive: returned moves keep the cold first-round trajectory', async () => {
    // Exact B4 shape (audit): round 1 (D12, cold hash) sees a volatile
    // e4 line and deepens; round 2 (D16, warm hash) replays flat early
    // depths. The loop must STOP on round 2's own verdict (stable) but
    // RETURN round 1's trajectory — pre-fix the warm flat line overwrote
    // it (9 flat points) and the advisor scored a hash artifact.
    const script: Script = (msg, emit) => {
      if (msg === 'uci') emit('uciok');
      else if (msg === 'isready') emit('readyok');
      else if (msg === 'go depth 12') {
        for (const [d, cp] of [
          [8, 10],
          [9, 180],
          [10, 20],
          [11, 190],
          [12, 150],
        ] as Array<[number, number]>) {
          emit(`info depth ${d} seldepth 20 multipv 1 score cp ${cp} nodes 100 nps 1000 time 10 pv e2e4`);
        }
        emit('bestmove e2e4');
      } else if (msg === 'go depth 16') {
        for (let d = 8; d <= 16; d++) {
          emit(`info depth ${d} seldepth 20 multipv 1 score cp ${40 + d} nodes 100 nps 1000 time 10 pv e2e4`);
        }
        emit('bestmove e2e4');
      }
    };
    const fake = new FakeWorker(script);
    const session = sessionWith(fake);
    const res = await analyzeAdaptiveFen(INITIAL, {
      multiPv: 1,
      startDepth: 12,
      step: 4,
      maxDepth: 16,
      session,
    });
    // Two rounds ran (D12 volatile → D16 flat → stable stop)…
    expect(fake.goCount()).toBe(2);
    expect(res.reachedDepth).toBe(16);
    expect(res.stable).toBe(true);
    expect(res.stoppedReason).toBe('stable');
    // …but the returned move carries the COLD trajectory, not the warm one.
    expect(res.moves).toHaveLength(1);
    expect(res.moves[0].uci).toBe('e2e4');
    expect(res.moves[0].trajectory?.map((p) => p.cp)).toEqual([10, 180, 20, 190, 150]);
    expect(res.moves[0].trajectory?.map((p) => p.depth)).toEqual([8, 9, 10, 11, 12]);
  });

  it('adaptive: a move born in a later round keeps its own trajectory', async () => {
    // Fallback side of B4: d4 only appears at D16, so no cold trajectory
    // exists for it — it must keep its own, not inherit e4's.
    const script: Script = (msg, emit) => {
      if (msg === 'uci') emit('uciok');
      else if (msg === 'isready') emit('readyok');
      else if (msg === 'go depth 12') {
        for (const [d, cp] of [
          [8, 10],
          [9, 180],
          [10, 20],
          [11, 190],
          [12, 150],
        ] as Array<[number, number]>) {
          emit(`info depth ${d} seldepth 20 multipv 1 score cp ${cp} nodes 100 nps 1000 time 10 pv e2e4`);
        }
        emit('bestmove e2e4');
      } else if (msg === 'go depth 16') {
        for (let d = 8; d <= 16; d++) {
          emit(`info depth ${d} seldepth 20 multipv 1 score cp ${58 + d} nodes 100 nps 1000 time 10 pv d2d4`);
        }
        emit('bestmove d2d4');
      }
    };
    const fake = new FakeWorker(script);
    const session = sessionWith(fake);
    const res = await analyzeAdaptiveFen(INITIAL, {
      multiPv: 1,
      startDepth: 12,
      step: 4,
      maxDepth: 16,
      session,
    });
    expect(fake.goCount()).toBe(2);
    expect(res.moves).toHaveLength(1);
    expect(res.moves[0].uci).toBe('d2d4');
    const traj = res.moves[0].trajectory ?? [];
    // d4's own flat round-2 line — certainly not e4's cold volatile one.
    expect(traj.map((p) => p.cp)).toEqual([66, 67, 68, 69, 70, 71, 72, 73, 74]);
    expect(traj.map((p) => p.depth)).toEqual([8, 9, 10, 11, 12, 13, 14, 15, 16]);
  });

  it('ignores aspiration-bound lines instead of recording fake amplitude', async () => {
    // Tense position: real +30s interleaved with +900 lowerbounds and a
    // mate upperbound. Pre-fix the bounds overwrote same-depth points and
    // fabricated a ~870 cp swing (up to −0.15 stability penalty downstream).
    const tense: Script = (msg, emit) => {
      if (msg === 'uci') emit('uciok');
      else if (msg === 'isready') emit('readyok');
      else if (msg.startsWith('go ')) {
        for (const d of [8, 9, 10, 11, 12]) {
          emit(`info depth ${d} seldepth 20 multipv 1 score cp ${30 + d} nodes 100 nps 1000 time 10 pv e2e4`);
          emit(`info depth ${d} seldepth 20 multipv 1 score cp 900 lowerbound nodes 100 nps 1000 time 10 pv e2e4`);
        }
        emit('info depth 10 seldepth 20 multipv 1 score mate 5 upperbound nodes 100 nps 1000 time 10 pv e2e4');
        emit('bestmove e2e4');
      }
    };
    const fake = new FakeWorker(tense);
    const session = sessionWith(fake);
    const moves = await session.analyze(INITIAL, { multiPv: 1, depth: 12 });
    expect(moves).toHaveLength(1);
    expect(moves[0].san).toBe('e4');
    const traj = moves[0].trajectory ?? [];
    expect(traj.map((p) => p.cp)).toEqual([38, 39, 40, 41, 42]);
    expect(traj.every((p) => p.mate === undefined)).toBe(true);
  });
});
