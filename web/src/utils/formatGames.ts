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

/** Formate une durée en millisecondes en chaîne lisible (ex: "2h 15m", "45m", "30s"). */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '0s';
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) return `${days}j ${hours % 24}h`;
  if (hours > 0) return `${hours}h ${minutes % 60}m`;
  if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
  return `${seconds}s`;
}

/** Évaluation moyenne lisible en pions (ex: "+1.25", "-0.30", "0.00", "—" si null). */
export function formatEval(evalValue: number | null): string {
  if (evalValue === null) return '—';
  if (evalValue > 0) return `+${(evalValue / 100).toFixed(2)}`;
  if (evalValue < 0) return `${(evalValue / 100).toFixed(2)}`;
  return '0.00';
}
