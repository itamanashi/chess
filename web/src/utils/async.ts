/**
 * Primitives async partagées : annulation uniforme (AbortController),
 * détection d'annulation et journalisation contrôlée.
 *
 * Règle : un `AbortError` n'est JAMAIS une erreur métier — il s'ignore
 * silencieusement (annulation volontaire). Tout autre échec async passe par
 * `warn()` (console) et/ou remonte vers un état d'erreur visible.
 */

/** Vrai si l'erreur est une annulation volontaire (AbortController / moteur). */
export function isAbortError(err: unknown): boolean {
  if (!err) return false;
  if (err instanceof DOMException) return err.name === 'AbortError';
  if (typeof err === 'object' && err !== null && 'name' in err) {
    return (err as { name?: unknown }).name === 'AbortError';
  }
  return false;
}

/** Lève la raison d'annulation si `signal` est annulé (sinon no-op). */
export function throwIfAborted(signal?: AbortSignal | null): void {
  if (signal?.aborted) {
    throw signal.reason instanceof Error
      ? signal.reason
      : new DOMException('Requête annulée', 'AbortError');
  }
}

/**
 * Journalisation contrôlée des échecs async non fatals.
 * Point unique à brancher plus tard sur de la télémétrie.
 */
export function warn(context: string, err: unknown): void {
  const detail = err instanceof Error ? err.message : String(err);
  console.warn(`[chess:${context}] ${detail}`);
}

/**
 * Applique `fn` à chaque item avec au plus `limit` tâches simultanées.
 * L'ordre des résultats suit l'ordre d'entrée. Échec rapide : le premier
 * rejet annule l'attente globale (les tâches déjà parties vont à leur
 * terme). Les appelants voulant une isolation par item capturent l'erreur
 * DANS `fn` et renvoient un résultat discriminé.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const parallelism = Math.max(1, Math.floor(limit) || 1);
  const out = new Array<R>(items.length);
  let next = 0;
  async function worker(): Promise<void> {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  }
  const workers = Array.from(
    { length: Math.min(parallelism, items.length) },
    () => worker(),
  );
  await Promise.all(workers);
  return out;
}

/** Vrai pour les rejets de `fetchWithTimeout` par dépassement de budget. */
export function isTimeoutError(err: unknown): boolean {
  if (!err) return false;
  if (err instanceof DOMException) return err.name === 'TimeoutError';
  if (typeof err === 'object' && err !== null && 'name' in err) {
    return (err as { name?: unknown }).name === 'TimeoutError';
  }
  return false;
}

/**
 * `fetch` avec budget temporel + annulation appelante (audit A10, partagé
 * par les fetchers Lichess explorer et cloud-eval).
 *
 * Double garde : `ctrl.abort()` libère la connexion (honoré par fetch),
 * tandis que `Promise.race` garantit le timeout même si l'implémentation
 * de fetch ignore les signaux (polyfill cassé / mock naïf). Rejette
 * TimeoutError au timeout, propage l'annulation appelante telle quelle.
 */
export async function fetchWithTimeout(
  url: string,
  init: RequestInit & { signal?: AbortSignal },
  timeoutMs: number,
): Promise<Response> {
  const callerSignal = init.signal;
  throwIfAborted(callerSignal);
  const ctrl = new AbortController();
  let timer: ReturnType<typeof setTimeout> | null = null;
  const onCallerAbort = (): void => {
    ctrl.abort(
      callerSignal?.reason instanceof Error
        ? callerSignal.reason
        : new DOMException('Requête annulée', 'AbortError'),
    );
  };
  callerSignal?.addEventListener('abort', onCallerAbort, { once: true });
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      try {
        ctrl.abort(new DOMException('Timeout', 'TimeoutError'));
      } catch {
        /* ignore */
      }
      reject(new DOMException('Timeout', 'TimeoutError'));
    }, timeoutMs);
  });
  try {
    return await Promise.race([fetch(url, { ...init, signal: ctrl.signal }), timeoutPromise]);
  } finally {
    if (timer) clearTimeout(timer);
    callerSignal?.removeEventListener('abort', onCallerAbort);
  }
}

/**
 * Attente annulable : rejette en AbortError si `signal` est annulé.
 * Sert aux délais inter-requêtes (rate-limit Lichess) dans les boucles.
 */
export function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  if (signal?.aborted) {
    return Promise.reject(signal.reason ?? new DOMException('Annulé', 'AbortError'));
  }
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal?.reason ?? new DOMException('Annulé', 'AbortError'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
