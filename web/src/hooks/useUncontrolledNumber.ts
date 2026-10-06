import { useCallback, useEffect, useRef } from 'react';

/**
 * Champ numérique non-contrôlé partagé (Auto + Pièges) : zéro rendu React à
 * la frappe, validation au blur/Entrée uniquement. `read` permet de lire la
 * valeur affichée de façon synchrone (ex. au clic Générer sans blur préalable).
 */
export function useUncontrolledNumber(
  setValue: (n: number) => void,
  clamp: (n: number) => number,
): {
  attach: (key: string) => (el: HTMLInputElement | null) => void;
  commit: (key: string, fallback: number) => () => void;
  write: (key: string, v: number) => void;
  read: (key: string, fallback: number) => number;
} {
  const refs = useRef<Record<string, HTMLInputElement | null>>({});
  const latest = useRef({ setValue, clamp });
  useEffect(() => {
    latest.current = { setValue, clamp };
  });
  const attachFns = useRef<
    Record<string, (el: HTMLInputElement | null) => void>
  >({});
  const commitFns = useRef<
    Record<string, { fallback: number; fn: () => void }>
  >({});

  const parseEl = (key: string, fallback: number): number => {
    const el = refs.current[key];
    if (!el) return fallback;
    const raw = el.value.trim().replace(',', '.');
    const parsed = Number(raw);
    return raw === '' || !Number.isFinite(parsed)
      ? fallback
      : latest.current.clamp(parsed);
  };

  const attach = useCallback((key: string) => {
    if (!attachFns.current[key]) {
      attachFns.current[key] = (el: HTMLInputElement | null): void => {
        refs.current[key] = el;
      };
    }
    return attachFns.current[key];
  }, []);

  const commit = useCallback((key: string, fallback: number) => {
    const cached = commitFns.current[key];
    if (!cached) {
      const fn = (): void => {
        const next = parseEl(key, commitFns.current[key]?.fallback ?? fallback);
        latest.current.setValue(next);
        commitFns.current[key].fallback = next;
        const el = refs.current[key];
        if (el) el.value = String(next);
      };
      commitFns.current[key] = { fallback, fn };
      return fn;
    }
    cached.fallback = fallback;
    return cached.fn;
  }, []);

  const write = useCallback((key: string, v: number): void => {
    const entry = commitFns.current[key];
    if (entry) entry.fallback = v;
    const el = refs.current[key];
    if (el) el.value = String(v);
  }, []);

  const read = useCallback((key: string, fallback: number): number => {
    const next = parseEl(key, commitFns.current[key]?.fallback ?? fallback);
    latest.current.setValue(next);
    commitFns.current[key] = commitFns.current[key] ?? {
      fallback: next,
      fn: () => {},
    };
    commitFns.current[key].fallback = next;
    const el = refs.current[key];
    if (el) el.value = String(next);
    return next;
  }, []);

  return { attach, commit, write, read };
}

/** Entier borné [min, max] (arrondi). */
export const clampInt =
  (min: number, max: number) =>
  (n: number): number =>
    Math.max(min, Math.min(max, Math.round(n)));

/** Blur au Entrée pour les champs numériques. */
export const blurOnEnter = (e: React.KeyboardEvent<HTMLInputElement>): void => {
  if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
};
