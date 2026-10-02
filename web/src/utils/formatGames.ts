/**
 * Format compact façon distant (`formatGames`) + pourcentage (`pct`).
 *
 * Utilisé par les panneaux Explorer / Lichess Live pour les compteurs
 * (ex : `1,2k parties`, `42-30-28`). Le format long `toLocaleString('fr-FR')`
 * reste utilisé ailleurs pour les valeurs exactes.
 */

/** 987 → "987", 12 400 → "12k", 1 250 000 → "1.3M". Jamais d'exception. */
export function formatGames(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0';
  const v = Math.floor(n);
  if (v >= 1_000_000) {
    const m = v / 1_000_000;
    return `${m >= 100 ? Math.round(m).toString() : m.toFixed(1)}M`;
  }
  if (v >= 10_000) return `${Math.round(v / 1000)}k`;
  if (v >= 1000) return `${(v / 1000).toFixed(1)}k`;
  return String(v);
}

/** Part en % arrondi, 0 si total <= 0 (jamais NaN). */
export function pct(part: number, total: number): number {
  if (!Number.isFinite(part) || !Number.isFinite(total) || total <= 0) return 0;
  if (part <= 0) return 0;
  return Math.round((part / total) * 100);
}
