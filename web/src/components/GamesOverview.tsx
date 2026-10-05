import { useMemo, type FC } from 'react';
import { CalendarDays } from 'lucide-react';
import '../styles/games-overview.css';
import {
  buildActivityWeeks,
  buildRatingSeries,
  computeOpponentRatingStats,
  computePeriodStats,
  computeSideStats,
  type ChesscomGame,
  type OpponentRatingRow,
  type PeriodStatRow,
} from '../services/chesscom';
import { DaytimePanel } from './DaytimePanel';
import { WeekdayPanel } from './WeekdayPanel';
import { GeographyPanel } from './GeographyPanel';

/* ------------------------------------------------------------------
 * Vue d'ensemble (Mes parties) : section extraite de ChesscomPanel,
 * mêmes agrégats, mêmes chiffres, mêmes libellés FR, mêmes rôles/aria.
 * ------------------------------------------------------------------ */

/** Couleurs d'issue : identiques à l'original (badges + légendes). */
const OUTCOME_COLOR = {
  win: '#8fb996',
  draw: '#8e887c',
  loss: '#d8816f',
} as const;

/** Libellé de granularité du regroupement temporel : identique. */
const PERIOD_GRANULARITY_LABEL: Record<string, string> = {
  day: 'par jour',
  month: 'par mois',
  year: 'par an',
};

/** Libellés de cadence pour la légende Elo : identiques. */
const CLASS_LABELS: Record<string, string> = {
  bullet: 'Bullet',
  blitz: 'Blitz',
  rapid: 'Rapide',
  daily: 'Corresp.',
};

/** Une couleur par cadence (ordre = volume décroissant) : identique. */
const RATING_COLORS = ['#d8d2c6', '#d29e6a', '#8fb996', '#d8816f', '#9a9488'];

/** Couleur UNIQUE d'une case d'activité : score interpolé (identique). */
const ACTIVITY_MID_RGB: [number, number, number] = [210, 158, 106]; // #d29e6a

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

const ACTIVITY_WIN_RGB = hexToRgb(OUTCOME_COLOR.win);
const ACTIVITY_LOSS_RGB = hexToRgb(OUTCOME_COLOR.loss);

function activityScoreColor(wins: number, draws: number, losses: number): string {
  const total = wins + draws + losses;
  if (total <= 0) return 'transparent';
  const score = (wins + draws / 2) / total;
  const from = score <= 0.5 ? ACTIVITY_LOSS_RGB : ACTIVITY_MID_RGB;
  const to = score <= 0.5 ? ACTIVITY_MID_RGB : ACTIVITY_WIN_RGB;
  const t = score <= 0.5 ? score * 2 : (score - 0.5) * 2;
  const mix = (i: number): number => Math.round(from[i] + (to[i] - from[i]) * t);
  return `rgb(${mix(0)}, ${mix(1)}, ${mix(2)})`;
}

function formatActivityDay(isoDate: string): string {
  try {
    return new Date(`${isoDate}T00:00:00Z`).toLocaleDateString('fr-FR', {
      day: 'numeric',
      month: 'short',
    });
  } catch {
    return isoDate;
  }
}

/* --- Barre V/N/D en pilule : mêmes seuils (12 %), mêmes title. --- */

const OaWdlBar: FC<{
  wins: number;
  draws: number;
  losses: number;
  title: string;
  small?: boolean;
}> = ({ wins, draws, losses, title, small }) => {
  const total = wins + draws + losses;
  const winPct = total > 0 ? (wins / total) * 100 : 0;
  const drawPct = total > 0 ? (draws / total) * 100 : 0;
  const lossPct = total > 0 ? 100 - winPct - drawPct : 0;
  return (
    <div className={`oa-wdl${small ? ' oa-wdl--sm' : ''}`} title={title}>
      {winPct > 0 && (
        <div className="oa-wdl-seg oa-wdl-win" style={{ width: `${winPct}%` }}>
          {winPct >= 12 ? `${winPct.toFixed(0)}%` : ''}
        </div>
      )}
      {drawPct > 0 && (
        <div className="oa-wdl-seg oa-wdl-draw" style={{ width: `${drawPct}%` }}>
          {drawPct >= 12 ? `${drawPct.toFixed(0)}%` : ''}
        </div>
      )}
      {lossPct > 0 && (
        <div className="oa-wdl-seg oa-wdl-loss" style={{ width: `${lossPct}%` }}>
          {lossPct >= 12 ? `${lossPct.toFixed(0)}%` : ''}
        </div>
      )}
    </div>
  );
};

/* --- Calendrier d'activité : même logique (91 jours, lundi-dimanche,
   une couleur par case = score V/N/D), mêmes aria/title. --- */

const OaActivityCalendar: FC<{ games: ChesscomGame[]; username: string }> = ({ games, username }) => {
  const weeks = useMemo(() => buildActivityWeeks(games, 91, Date.now(), username), [games, username]);
  const activeDays = useMemo(
    () => weeks.flat().filter((d) => !d.future && d.games > 0).length,
    [weeks],
  );
  return (
    <div className="oa-cal-wrap" title={`${games.length} parties sur les 3 derniers mois`}>
      <div className="oa-cal" role="img" aria-label={`${games.length} parties sur les 3 derniers mois`}>
        {weeks.map((week, wi) => (
          <div key={wi} className="oa-cal-week">
            {week.map((d) => (
              <span
                key={d.date}
                className={`oa-cal-cell${d.future ? ' is-future' : ''}`}
                style={d.games > 0 ? { background: activityScoreColor(d.wins, d.draws, d.losses), borderColor: 'transparent' } : undefined}
                title={
                  d.future
                    ? undefined
                    : d.games > 0
                      ? `${d.wins}V / ${d.draws}N / ${d.losses}D — ${formatActivityDay(d.date)}`
                      : `Aucune partie — ${formatActivityDay(d.date)}`
                }
              />
            ))}
          </div>
        ))}
      </div>
      <div className="oa-cal-caption text-muted">
        {games.length.toLocaleString('fr-FR')} parties · {activeDays} jours actifs
      </div>
      <div className="oa-legend" aria-hidden="true">
        <span className="oa-legend-item">
          <span className="oa-dot" style={{ background: OUTCOME_COLOR.win }} />V
        </span>
        <span className="oa-legend-item">
          <span className="oa-dot" style={{ background: OUTCOME_COLOR.draw }} />N
        </span>
        <span className="oa-legend-item">
          <span className="oa-dot" style={{ background: OUTCOME_COLOR.loss }} />D
        </span>
      </div>
    </div>
  );
};

/* --- Courbe Elo par cadence : même géométrie, mêmes aria/title. --- */

const OaRatingChart: FC<{ games: ChesscomGame[]; username: string }> = ({ games, username }) => {
  const series = useMemo(() => buildRatingSeries(games, username), [games, username]);
  if (series.length === 0) {
    return <div className="oa-empty">Aucune partie classée sur la période.</div>;
  }
  const W = 560;
  const H = 170;
  const padL = 36;
  const padR = 10;
  const padT = 10;
  const padB = 22;
  const all = series.flatMap((s) => s.points);
  let minT = Math.min(...all.map((p) => p.t));
  let maxT = Math.max(...all.map((p) => p.t));
  if (maxT <= minT) {
    minT -= 43200000;
    maxT += 43200000;
  }
  let minR = Math.min(...all.map((p) => p.rating));
  let maxR = Math.max(...all.map((p) => p.rating));
  if (maxR <= minR) {
    minR -= 25;
    maxR += 25;
  } else {
    minR -= 10;
    maxR += 10;
  }
  const x = (t: number): number => padL + ((t - minT) / (maxT - minT)) * (W - padL - padR);
  const y = (r: number): number => padT + (1 - (r - minR) / (maxR - minR)) * (H - padT - padB);
  // Repères mensuels (max ~6 étiquettes).
  const monthTicks: Array<{ x: number; label: string }> = [];
  {
    const cursor = new Date(minT);
    cursor.setUTCDate(1);
    cursor.setUTCHours(0, 0, 0, 0);
    if (cursor.getTime() < minT) cursor.setUTCMonth(cursor.getUTCMonth() + 1);
    const starts: number[] = [];
    for (let t = cursor.getTime(); t <= maxT;) {
      starts.push(t);
      cursor.setUTCMonth(cursor.getUTCMonth() + 1);
      t = cursor.getTime();
    }
    const step = Math.max(1, Math.ceil(starts.length / 6));
    starts.forEach((t, i) => {
      if (i % step === 0) {
        monthTicks.push({
          x: x(t),
          label: new Date(t).toLocaleDateString('fr-FR', { month: 'short' }),
        });
      }
    });
  }
  const gridRs = [minR, (minR + maxR) / 2, maxR];
  return (
    <div>
      <svg className="oa-chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Historique Elo par cadence">
        {gridRs.map((r) => (
          <g key={r}>
            <line x1={padL} x2={W - padR} y1={y(r)} y2={y(r)} className="oa-grid-line" />
            <text x={padL - 5} y={y(r) + 3.5} textAnchor="end" className="oa-axis">
              {Math.round(r)}
            </text>
          </g>
        ))}
        {monthTicks.map((t) => (
          <text key={t.label + t.x} x={t.x} y={H - 7} textAnchor="middle" className="oa-axis">
            {t.label}
          </text>
        ))}
        {series.map((s, si) => {
          const color = RATING_COLORS[si % RATING_COLORS.length];
          const pts = s.points.map((p) => `${x(p.t).toFixed(1)},${y(p.rating).toFixed(1)}`).join(' ');
          const dotStep = Math.max(1, Math.ceil(s.points.length / 120));
          return (
            <g key={s.timeClass}>
              <polyline points={pts} fill="none" stroke={color} strokeWidth={2} strokeLinejoin="round" />
              {s.points.map((p, i) =>
                i % dotStep === 0 || i === s.points.length - 1 ? (
                  <circle key={i} cx={x(p.t)} cy={y(p.rating)} r={2.4} fill={color}>
                    <title>{`${p.rating} — ${new Date(p.t).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' })}`}</title>
                  </circle>
                ) : null,
              )}
            </g>
          );
        })}
      </svg>
      <div className="oa-legend">
        {series.map((s, si) => (
          <span key={s.timeClass} className="oa-legend-item">
            <span className="oa-dot" style={{ background: RATING_COLORS[si % RATING_COLORS.length] }} />
            <span>{CLASS_LABELS[s.timeClass] ?? s.timeClass}</span>
            <strong>{s.points[s.points.length - 1].rating}</strong>
          </span>
        ))}
      </div>
    </div>
  );
};

/* --- Barres des parties par période : même géométrie, mêmes aria. --- */

const OaPeriodGamesChart: FC<{ rows: PeriodStatRow[] }> = ({ rows }) => {
  if (rows.length === 0) {
    return <div className="oa-empty">Aucune donnée sur la période.</div>;
  }
  const W = 560;
  const H = 150;
  const padL = 40;
  const padR = 10;
  const padT = 10;
  const padB = 30;
  const maxGames = Math.max(...rows.map((r) => r.games));
  const barWidth = (W - padL - padR) / rows.length;
  const x = (i: number): number => padL + i * barWidth;
  const y = (games: number): number => padT + (1 - games / maxGames) * (H - padT - padB);
  // Étiquettes échantillonnées (max ~8) pour rester lisibles en granularité jour.
  const labelStep = Math.max(1, Math.ceil(rows.length / 8));
  return (
    <div>
      <svg className="oa-chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Parties par période">
        {[0, 0.25, 0.5, 0.75, 1].map((pct) => {
          const val = Math.round(maxGames * pct);
          const yPos = y(val);
          return (
            <g key={pct}>
              <line x1={padL} x2={W - padR} y1={yPos} y2={yPos} className="oa-grid-line" />
              <text x={padL - 5} y={yPos + 3.5} textAnchor="end" className="oa-axis">
                {val}
              </text>
            </g>
          );
        })}
        {rows.map((r, i) => (
          <g key={r.key}>
            <rect
              x={x(i)}
              y={y(r.games)}
              width={barWidth}
              height={H - padB - y(r.games)}
              fill="#d8d2c6"
            >
              <title>{r.label} : {r.games} parties</title>
            </rect>
            {(i % labelStep === 0 || i === rows.length - 1) && (
              <text x={x(i) + barWidth / 2} y={H - 8} textAnchor="middle" className="oa-axis">
                {r.shortLabel}
              </text>
            )}
          </g>
        ))}
      </svg>
    </div>
  );
};

/* --- Barres empilées par tranche Elo adverse : mêmes segments, mêmes
   légendes et notes (« En bas : défaites · … »). --- */

const OaOpponentRatingChart: FC<{ rows: OpponentRatingRow[] }> = ({ rows }) => {
  if (rows.length === 0) {
    return <div className="oa-empty">Aucune partie classée.</div>;
  }
  const W = 560;
  const H = 170;
  const padL = 36;
  const padR = 10;
  const padT = 10;
  const padB = 30;
  const maxGames = Math.max(...rows.map((r) => r.games));
  const barWidth = (W - padL - padR) / rows.length;
  const x = (i: number): number => padL + i * barWidth;
  const y = (games: number): number => padT + (1 - games / maxGames) * (H - padT - padB);
  // Étiquettes échantillonnées (max ~8) quand il y a beaucoup de tranches.
  const labelStep = Math.max(1, Math.ceil(rows.length / 8));
  const SEGMENTS = [
    { key: 'losses', color: '#d8816f', name: 'Défaites' },
    { key: 'draws', color: '#8e887c', name: 'Nulles' },
    { key: 'wins', color: 'var(--success)', name: 'Victoires' },
  ] as const;
  return (
    <div>
      <svg className="oa-chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Résultats par classement de l'adversaire">
        {[0, 0.25, 0.5, 0.75, 1].map((pct) => {
          const val = Math.round(maxGames * pct);
          const yPos = y(val);
          return (
            <g key={pct}>
              <line x1={padL} x2={W - padR} y1={yPos} y2={yPos} className="oa-grid-line" />
              <text x={padL - 5} y={yPos + 3.5} textAnchor="end" className="oa-axis">
                {val}
              </text>
            </g>
          );
        })}
        {rows.map((r, i) => {
          let stacked = 0;
          return (
            <g key={r.bucket}>
              <title>{`${r.label} : ${r.games} parties (${r.wins}V / ${r.draws}N / ${r.losses}D)`}</title>
              {SEGMENTS.map((s) => {
                const count = r[s.key];
                const yTop = y(stacked + count);
                const yBottom = y(stacked);
                stacked += count;
                if (count <= 0) return null;
                return (
                  <rect
                    key={s.key}
                    x={x(i)}
                    y={yTop}
                    width={barWidth}
                    height={Math.max(0, yBottom - yTop)}
                    fill={s.color}
                  >
                    <title>{`${r.label} — ${s.name} : ${count}`}</title>
                  </rect>
                );
              })}
              {(i % labelStep === 0 || i === rows.length - 1) && (
                <text x={x(i) + barWidth / 2} y={H - 8} textAnchor="middle" className="oa-axis">
                  {r.bucket}
                </text>
              )}
            </g>
          );
        })}
      </svg>
      <div className="oa-legend">
        <span className="oa-legend-item">
          <span className="oa-dot" style={{ background: 'var(--success)' }} />
          <span>Victoires</span>
        </span>
        <span className="oa-legend-item">
          <span className="oa-dot" style={{ background: '#8e887c' }} />
          <span>Nulles</span>
        </span>
        <span className="oa-legend-item">
          <span className="oa-dot" style={{ background: '#d8816f' }} />
          <span>Défaites</span>
        </span>
      </div>
      <div className="oa-chart-foot">En bas : défaites · au milieu : nulles · en haut : victoires</div>
    </div>
  );
};

export interface GamesOverviewProps {
  /** Parties listées (filtre robots déjà appliqué par l'appelant). */
  games: ChesscomGame[];
  /** Pseudo du compte lié (perspective V/N/D + couleurs). */
  me: string;
}

/**
 * Section « Vue d'ensemble » extraite de ChesscomPanel : mêmes
 * agrégats (computeSideStats / computePeriodStats /
 * computeOpponentRatingStats), mêmes chiffres, mêmes libellés FR,
 * mêmes rôles/aria.
 */
export const GamesOverview: FC<GamesOverviewProps> = ({ games, me }) => {
  const sideRows = useMemo(() => computeSideStats(games, me), [games, me]);
  const opponentRatingRows = useMemo(() => computeOpponentRatingStats(games, me), [games, me]);
  const periodStats = useMemo(() => computePeriodStats(games, me), [games, me]);
  const periodRows = periodStats.rows;

  const totals = useMemo(() => {
    const totalGames = periodRows.reduce((sum, r) => sum + r.games, 0);
    const totalWins = periodRows.reduce((sum, r) => sum + r.wins, 0);
    const totalDraws = periodRows.reduce((sum, r) => sum + r.draws, 0);
    const totalLosses = periodRows.reduce((sum, r) => sum + r.losses, 0);
    const winPct = totalGames > 0 ? (totalWins / totalGames) * 100 : 0;
    const drawPct = totalGames > 0 ? (totalDraws / totalGames) * 100 : 0;
    const lossPct = totalGames > 0 ? 100 - winPct - drawPct : 0;
    return { totalGames, totalWins, totalDraws, totalLosses, winPct, drawPct, lossPct };
  }, [periodRows]);

  return (
    <div className="oa-overview">
      <div className="oa-grid">
        <div className="oa-card">
          <div className="oa-card-head">
            <h3 className="oa-title">
              <CalendarDays size={16} className="oa-icon" />
              Activité
            </h3>
          </div>
          <div className="oa-sub text-muted">3 derniers mois</div>
          <OaActivityCalendar games={games} username={me} />
        </div>

        <div className="oa-card">
          <div className="oa-card-head">
            <h3 className="oa-title">Elo</h3>
          </div>
          <OaRatingChart games={games} username={me} />
        </div>

        <div className="oa-card oa-card--wide">
          <div className="oa-card-head">
            <h3 className="oa-title">Parties dans le temps</h3>
          </div>
          <div className="oa-sub text-muted">{PERIOD_GRANULARITY_LABEL[periodStats.granularity] ?? ''}</div>
          <div className="oa-summary">
            <span><strong>{totals.totalGames.toLocaleString('fr-FR')}</strong> parties totales</span>
            <span aria-hidden="true" className="oa-sep">•</span>
            <span style={{ color: OUTCOME_COLOR.win }}>{totals.totalWins}V</span>
            <span aria-hidden="true" className="oa-sep">•</span>
            <span className="text-muted">{totals.totalDraws}N</span>
            <span aria-hidden="true" className="oa-sep">•</span>
            <span style={{ color: OUTCOME_COLOR.loss }}>{totals.totalLosses}D</span>
          </div>
          <OaWdlBar
            wins={totals.totalWins}
            draws={totals.totalDraws}
            losses={totals.totalLosses}
            title={`Victoires : ${totals.winPct.toFixed(0)} % · Nulles : ${totals.drawPct.toFixed(0)} % · Défaites : ${totals.lossPct.toFixed(0)} %`}
          />
          <OaPeriodGamesChart rows={periodRows} />
        </div>

        <div className="oa-card">
          <div className="oa-card-head">
            <h3 className="oa-title">Parties par couleur</h3>
          </div>
          <div className="oa-table-wrap">
            <table className="oa-table">
              <thead>
                <tr>
                  <th>Camp</th>
                  <th>Parties</th>
                  <th title="Victoires - Nulles - Défaites">V % - N % - D %</th>
                </tr>
              </thead>
              <tbody>
                {sideRows.map((r) => (
                  <tr key={r.side}>
                    <td>{r.side === 'w' ? '♔ White' : '♚ Black'}</td>
                    <td>{r.games}</td>
                    <td>
                      <OaWdlBar
                        small
                        wins={r.wins}
                        draws={r.draws}
                        losses={r.losses}
                        title={`V ${(r.games > 0 ? (r.wins / r.games) * 100 : 0).toFixed(0)} % · N ${(r.games > 0 ? (r.draws / r.games) * 100 : 0).toFixed(0)} % · D ${(r.games > 0 ? 100 - (r.wins / r.games) * 100 - (r.draws / r.games) * 100 : 0).toFixed(0)} %`}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <div className="oa-card">
          <div className="oa-card-head">
            <h3 className="oa-title">Résultats par classement de l'adversaire</h3>
          </div>
          <div className="oa-sub text-muted">Tranches de 100 Elo</div>
          <OaOpponentRatingChart rows={opponentRatingRows} />
        </div>
      </div>

      <div className="oa-embed">
        <DaytimePanel games={games} me={me} />
      </div>
      <div className="oa-embed">
        <WeekdayPanel games={games} me={me} />
      </div>
      <div className="oa-embed">
        <GeographyPanel games={games} me={me} />
      </div>
    </div>
  );
};
