import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Globe } from 'lucide-react';
import { colorOf, normalizeUsername, outcomeFor, type ChesscomGame } from '../services/chesscom';
import { isAbortError } from '../utils/async';
import {
  alpha2OfNumericId,
  computeCountryStats,
  countryAccuracy,
  countryWinRate,
  flagSrc,
  flagSrcSet,
  frenchCountryName,
  UNKNOWN_COUNTRY,
  type CountryRow,
} from '../utils/geography';
import { topoToWorldPaths, worldViewHeight, type WorldFeature } from '../utils/topojson';
import {
  cachedCountry,
  getCountryCache,
  loadOpponentCountries,
  type OpponentCountryMap,
} from '../services/opponentCountry';

interface GeographyPanelProps {
  /** Parties listées (robots déjà exclus sauf option). */
  games: ChesscomGame[];
  /** Pseudo du compte lié (choix du camp adverse + perspective V/N/D). */
  me: string;
}

type GeoView = 'map' | 'list';

type GeoSortKey = 'country' | 'games' | 'winRate' | 'wins' | 'draws' | 'losses' | 'accuracy';

interface GeoColumn {
  key: GeoSortKey;
  label: string;
  title?: string;
}

/** Les 7 colonnes demandées, toutes triables (clic = tri, re-clic = inverse). */
const GEO_COLUMNS: GeoColumn[] = [
  { key: 'country', label: 'Pays' },
  { key: 'games', label: 'Parties' },
  { key: 'winRate', label: '% Victoires', title: 'Part de victoires sur les parties du pays' },
  { key: 'wins', label: 'Victoires' },
  { key: 'draws', label: 'Nulles' },
  { key: 'losses', label: 'Défaites' },
  { key: 'accuracy', label: 'Précision', title: 'Précision moyenne (Win% Lichess) de votre camp' },
];

/** Fond de carte : world-atlas 110m (TopoJSON décodé à l'exécution, sans dépendance). */
const WORLD_URL = 'https://unpkg.com/world-atlas@2/countries-110m.json';
const MAP_W = 1000;
const MAP_H = worldViewHeight(MAP_W);

/** Pays sans partie : fond neutre du thème (lisible en clair comme en sombre). */
const MAP_EMPTY = 'var(--bg-surface)';

let worldPromise: Promise<WorldFeature[] | null> | null = null;
function getWorld(): Promise<WorldFeature[] | null> {
  if (!worldPromise) {
    worldPromise = fetch(WORLD_URL, { headers: { Accept: 'application/json' } })
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json() as Promise<unknown>;
      })
      .then((json) => topoToWorldPaths(json, MAP_W))
      .catch(() => null);
  }
  return worldPromise;
}

/** Mélange hexadécimal (intensité de caramel = volume de parties, échelle log). */
function mixHex(from: string, to: string, t: number): string {
  const c = (hex: string): [number, number, number] => [
    parseInt(hex.slice(1, 3), 16),
    parseInt(hex.slice(3, 5), 16),
    parseInt(hex.slice(5, 7), 16),
  ];
  const [r1, g1, b1] = c(from);
  const [r2, g2, b2] = c(to);
  const m = (a: number, b: number): number => Math.round(a + (b - a) * t);
  const h = (n: number): string => n.toString(16).padStart(2, '0');
  return `#${h(m(r1, r2))}${h(m(g1, g2))}${h(m(b1, b2))}`;
}

interface GeoTooltip {
  x: number;
  y: number;
  code: string | null;
  fallbackName: string;
  row: CountryRow | null;
}

/**
 * Panneau « Géographie » : d'où viennent vos adversaires ? Les pays ne
 * figurent pas dans les parties : un bouton charge les profils adverses
 * (1 requête/pseudo unique, cache persisté, annulable). Carte colorée par
 * volume + infobulle au survol (drapeau, nom, parties, précision, barre
 * V/N/D), ou tableau trié par volume.
 */
export const GeographyPanel: React.FC<GeographyPanelProps> = ({ games, me }) => {
  const [view, setView] = useState<GeoView>('map');
  const [cache, setCache] = useState<OpponentCountryMap>(() => getCountryCache());
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [loadStatus, setLoadStatus] = useState<string | null>(null);
  const loadAbort = useRef<AbortController | null>(null);
  const [world, setWorld] = useState<WorldFeature[] | null>(null);
  const [worldState, setWorldState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [tooltip, setTooltip] = useState<GeoTooltip | null>(null);
  const mapWrap = useRef<HTMLDivElement | null>(null);
  /** Tri du tableau : « Pays inconnu » reste épinglé en fin, précision absente en dernier. */
  const [sortKey, setSortKey] = useState<GeoSortKey>('games');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');

  // Adversaires uniques (pseudo normalisé → pseudo d'affichage).
  const opponents = useMemo(() => {
    const map = new Map<string, string>();
    for (const g of games) {
      const mine = colorOf(g, me);
      const opp = (mine === 'w' ? g.black.username : g.white.username) ?? '';
      const key = normalizeUsername(opp);
      if (key && !map.has(key)) map.set(key, opp);
    }
    return map;
  }, [games, me]);

  const unresolved = useMemo(
    () => [...opponents.keys()].filter((u) => cachedCountry(cache, u) === null),
    [opponents, cache],
  );

  const rows = useMemo(() => {
    const items = games.map((g) => {
      const mine = colorOf(g, me);
      const opp = mine === 'w' ? g.black.username : g.white.username;
      return {
        country: cachedCountry(cache, opp ?? '') ?? UNKNOWN_COUNTRY,
        outcome: outcomeFor(g, me),
        accuracy: typeof g.accuracy === 'number' ? g.accuracy : null,
      };
    });
    const all = computeCountryStats(items);
    // « Pays inconnu » en fin de tableau (jamais entre deux pays).
    const known = all.filter((r) => r.code !== UNKNOWN_COUNTRY);
    const unknown = all.filter((r) => r.code === UNKNOWN_COUNTRY);
    return [...known, ...unknown];
  }, [games, me, cache]);

  const byCode = useMemo(() => new Map(rows.map((r) => [r.code, r])), [rows]);
  const maxGames = useMemo(() => Math.max(1, ...rows.map((r) => r.games)), [rows]);

  const toggleSort = useCallback((key: GeoSortKey) => {
    if (key === sortKey) {
      setSortDir(sortDir === 'asc' ? 'desc' : 'asc');
    } else {
      setSortKey(key);
      // Sens naturel du nouveau critère : A→Z pour le pays, décroissant sinon.
      setSortDir(key === 'country' ? 'asc' : 'desc');
    }
  }, [sortKey, sortDir]);

  /** Lignes triées (« Pays inconnu » toujours en fin, jamais trié). */
  const sortedRows = useMemo(() => {
    const known = rows.filter((r) => r.code !== UNKNOWN_COUNTRY);
    const unknown = rows.filter((r) => r.code === UNKNOWN_COUNTRY);
    const dir = sortDir === 'asc' ? 1 : -1;
    const value = (r: CountryRow): number | string => {
      switch (sortKey) {
        case 'country': return frenchCountryName(r.code);
        case 'winRate': return countryWinRate(r);
        case 'accuracy': return countryAccuracy(r) ?? Number.NaN;
        default: return r[sortKey];
      }
    };
    known.sort((a, b) => {
      const va = value(a);
      const vb = value(b);
      // Précision absente : toujours en dernier, quel que soit le sens.
      if (typeof va === 'number' && Number.isNaN(va)) return 1;
      if (typeof vb === 'number' && Number.isNaN(vb)) return -1;
      if (typeof va === 'string' || typeof vb === 'string') {
        return String(va).localeCompare(String(vb), 'fr') * dir;
      }
      return ((va as number) - (vb as number)) * dir;
    });
    return [...known, ...unknown];
  }, [rows, sortKey, sortDir]);

  const loadWorld = useCallback(() => {
    setWorldState('loading');
    getWorld().then((features) => {
      if (features && features.length > 0) {
        setWorld(features);
        setWorldState('ready');
      } else {
        worldPromise = null;
        setWorldState('error');
      }
    });
  }, []);

  useEffect(() => {
    loadWorld();
  }, [loadWorld]);

  useEffect(() => {
    return () => {
      loadAbort.current?.abort();
    };
  }, []);

  const loadCountries = useCallback(async () => {
    if (loading || unresolved.length === 0) return;
    setLoading(true);
    setLoadStatus(null);
    setProgress({ done: 0, total: unresolved.length });
    const ctrl = new AbortController();
    loadAbort.current = ctrl;
    try {
      const result = await loadOpponentCountries(unresolved, {
        signal: ctrl.signal,
        onProgress: (p) => setProgress(p),
      });
      setCache(result.cache);
      const known = Object.values(result.cache).filter((c) => c).length;
      setLoadStatus(
        result.failed > 0
          ? `Pays chargés : ${result.resolved} adversaire(s), ${result.failed} sans réponse (comptés « sans pays »). ${known} pays en cache.`
          : `Pays chargés : ${result.resolved} adversaire(s). ${known} pays en cache.`,
      );
    } catch (err) {
      if (isAbortError(err)) setLoadStatus('Chargement interrompu (les pays déjà résolus sont conservés).');
      else setLoadStatus(`Profils inaccessibles : ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      loadAbort.current = null;
      setLoading(false);
    }
  }, [loading, unresolved]);

  const cancelLoad = useCallback(() => {
    loadAbort.current?.abort();
  }, []);

  const onHoverFeature = useCallback(
    (e: React.MouseEvent, feature: WorldFeature) => {
      const rect = mapWrap.current?.getBoundingClientRect();
      if (!rect) return;
      const px = e.clientX - rect.left;
      const py = e.clientY - rect.top;
      const code = alpha2OfNumericId(feature.id);
      setTooltip({
        x: Math.max(8, Math.min(px + 16, rect.width - 248)),
        y: Math.max(8, Math.min(py + 16, rect.height - 40)),
        code,
        fallbackName: feature.name,
        row: code ? (byCode.get(code) ?? null) : null,
      });
    },
    [byCode],
  );

  const ratedTotal = rows.reduce((s, r) => s + r.accN, 0);

  return (
    <div className="chesscom-stats-grid">
      <div className="panel-card">
        <div className="card-title-row">
          <h3 className="card-title">
            <Globe size={16} className="title-icon" />
            Géographie
          </h3>
        </div>
        <div className="activity-subtitle text-muted">
          {opponents.size.toLocaleString('fr-FR')} adversaire(s) · {rows.filter((r) => r.code !== UNKNOWN_COUNTRY).length} pays
          {ratedTotal > 0 && ` · ${ratedTotal.toLocaleString('fr-FR')} partie(s) notée(s)`}
        </div>

        {unresolved.length > 0 && !loading && (
          <div className="chesscom-summary">
            <span>{unresolved.length.toLocaleString('fr-FR')} adversaire(s) sans pays connu</span>
            <button
              className="action-btn"
              onClick={loadCountries}
              title="Un profil Chess.com par adversaire (concurrence 4, mise en cache : une seule fois par pseudo). Annulable à tout moment."
            >
              Charger les pays
            </button>
          </div>
        )}
        {loading && (
          <div className="chesscom-summary">
            <span>Chargement des pays ({progress.done}/{progress.total})</span>
            <button className="action-btn" onClick={cancelLoad} title="Interrompre (les pays déjà résolus sont conservés)">
              Annuler
            </button>
          </div>
        )}
        {loadStatus && (
          <div className="chesscom-analyze-status text-muted" role="status">
            {loadStatus}
          </div>
        )}

        <div className="chesscom-filter-group" role="group" aria-label="Affichage">
          <button
            className={`db-toggle-btn ${view === 'map' ? 'active' : ''}`}
            onClick={() => setView('map')}
          >
            <span>Carte du monde</span>
          </button>
          <button
            className={`db-toggle-btn ${view === 'list' ? 'active' : ''}`}
            onClick={() => setView('list')}
          >
            <span>Vue liste</span>
          </button>
        </div>

        {view === 'map' ? (
          worldState === 'loading' ? (
            <div className="empty-state">Chargement du fond de carte…</div>
          ) : worldState === 'error' || !world ? (
            <div className="empty-state">
              Fond de carte inaccessible (hors-ligne ?). La vue liste reste disponible.{' '}
              <button className="action-btn" onClick={loadWorld}>Réessayer</button>
            </div>
          ) : (
            <div className="geo-map-wrap" ref={mapWrap} onMouseLeave={() => setTooltip(null)}>
              <svg className="geo-map" viewBox={`0 0 ${MAP_W} ${MAP_H}`} role="img" aria-label="Carte du monde des adversaires par pays">
                {world.map((f) => {
                  const code = alpha2OfNumericId(f.id);
                  const row = code ? byCode.get(code) : undefined;
                  const n = row?.games ?? 0;
                  const fill = n > 0
                    ? mixHex('#1e1c18', '#d29e6a', Math.log1p(n) / Math.log1p(maxGames))
                    : MAP_EMPTY;
                  return (
                    <path
                      key={f.id}
                      d={f.path}
                      fill={fill}
                      onMouseEnter={(e) => onHoverFeature(e, f)}
                      onMouseMove={(e) => onHoverFeature(e, f)}
                    >
                      <title>{code ? frenchCountryName(code) : f.name}</title>
                    </path>
                  );
                })}
              </svg>
              {tooltip && (
                <div className="geo-tooltip" style={{ left: tooltip.x, top: tooltip.y }} role="status">
                  <div className="geo-tooltip-head">
                    {tooltip.code && flagSrc(tooltip.code) ? (
                      <img
                        className="geo-flag"
                        src={flagSrc(tooltip.code) as string}
                        srcSet={flagSrcSet(tooltip.code) ?? undefined}
                        alt=""
                        width={28}
                      />
                    ) : null}
                    <strong>{tooltip.code ? frenchCountryName(tooltip.code) : tooltip.fallbackName}</strong>
                  </div>
                  {tooltip.row ? (
                    <>
                      <div className="activity-subtitle text-muted">
                        {tooltip.row.games.toLocaleString('fr-FR')} partie(s)
                        {(() => {
                          const acc = countryAccuracy(tooltip.row as CountryRow);
                          return acc !== null ? ` · précision ${acc.toFixed(1)} %` : '';
                        })()}
                      </div>
                      <div
                        className="chesscom-wdl-bar"
                        role="img"
                        aria-label={`${tooltip.row.wins} victoires, ${tooltip.row.draws} nulles, ${tooltip.row.losses} défaites`}
                      >
                        {tooltip.row.wins > 0 && (
                          <div className="chesscom-wdl-segment chesscom-wdl-win" style={{ width: `${(tooltip.row.wins / tooltip.row.games) * 100}%` }} />
                        )}
                        {tooltip.row.draws > 0 && (
                          <div className="chesscom-wdl-segment chesscom-wdl-draw" style={{ width: `${(tooltip.row.draws / tooltip.row.games) * 100}%` }} />
                        )}
                        {tooltip.row.losses > 0 && (
                          <div className="chesscom-wdl-segment chesscom-wdl-loss" style={{ width: `${(tooltip.row.losses / tooltip.row.games) * 100}%` }} />
                        )}
                      </div>
                      <div className="activity-subtitle">
                        {tooltip.row.wins}V · {tooltip.row.draws}N · {tooltip.row.losses}D
                      </div>
                    </>
                  ) : (
                    <div className="activity-subtitle text-muted">Aucune partie.</div>
                  )}
                </div>
              )}
            </div>
          )
        ) : rows.length === 0 ? (
          <div className="empty-state">Aucun adversaire.</div>
        ) : (
          <div className="table-scroll">
            <div className="activity-subtitle text-muted">Cliquez un en-tête pour trier.</div>
            <table className="chesscom-stats-table">
              <thead>
                <tr>
                  {GEO_COLUMNS.map((col) => {
                    const active = sortKey === col.key;
                    return (
                      <th
                        key={col.key}
                        title={col.title}
                        aria-sort={active ? (sortDir === 'asc' ? 'ascending' : 'descending') : 'none'}
                      >
                        <button
                          className="geo-sort-btn"
                          onClick={() => toggleSort(col.key)}
                          title={`Trier par ${col.label}`}
                        >
                          <span>{col.label}</span>
                          {active && (
                            <span className="geo-sort-arrow" aria-hidden="true">
                              {sortDir === 'asc' ? '▲' : '▼'}
                            </span>
                          )}
                        </button>
                      </th>
                    );
                  })}
                </tr>
              </thead>
              <tbody>
                {sortedRows.map((r) => {
                  const acc = countryAccuracy(r);
                  const winRate = countryWinRate(r);
                  const src = flagSrc(r.code);
                  return (
                    <tr key={r.code || 'unknown'}>
                      <td>
                        {src ? (
                          <img className="geo-flag geo-flag-inline" src={src} srcSet={flagSrcSet(r.code) ?? undefined} alt="" width={20} />
                        ) : null}
                        {r.code ? frenchCountryName(r.code) : 'Pays inconnu'}
                      </td>
                      <td>{r.games.toLocaleString('fr-FR')}</td>
                      <td>{Number.isNaN(winRate) ? '—' : `${winRate.toFixed(0)} %`}</td>
                      <td>{r.wins.toLocaleString('fr-FR')}</td>
                      <td>{r.draws.toLocaleString('fr-FR')}</td>
                      <td>{r.losses.toLocaleString('fr-FR')}</td>
                      <td>{acc !== null ? `${acc.toFixed(1)} %` : '—'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
};
