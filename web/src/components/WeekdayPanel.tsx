import React, { useMemo } from 'react';
import { Calendar } from 'lucide-react';
import { outcomeFor, type ChesscomGame } from '../services/chesscom';
import {
  computeWeekdayStats,
  weekdayAccuracy,
  WEEKDAY_COLORS,
  WEEKDAY_LABEL,
  WEEKDAY_ORDER,
  WEEKDAY_SHORT,
  type WeekdayStats,
} from '../utils/weekday';

interface WeekdayPanelProps {
  /** Parties listées (robots déjà exclus sauf option). */
  games: ChesscomGame[];
  /** Pseudo du compte lié (perspective V/N/D + précision). */
  me: string;
}

const OUTCOME_COLOR = { win: '#10b981', draw: '#9ca3af', loss: '#f43f5e' } as const;

/** Camembert des parties par jour (SVG pur, même technique que le roque). */
const WeekdayDonut: React.FC<{ stats: WeekdayStats }> = ({ stats }) => {
  const segments = WEEKDAY_ORDER.map((d) => ({
    label: WEEKDAY_LABEL[d],
    count: stats.byDay[d].games,
    color: WEEKDAY_COLORS[d],
  }));
  const total = segments.reduce((s, x) => s + x.count, 0);
  if (total <= 0) return <div className="empty-state">Aucune partie.</div>;
  const size = 150;
  const c = size / 2;
  const r = 52;
  const C = 2 * Math.PI * r;
  const segs = segments.reduce<Array<{ label: string; count: number; color: string; frac: number; start: number }>>((out, s) => {
    if (s.count <= 0) return out;
    const prev = out.length > 0 ? out[out.length - 1] : null;
    return [...out, { ...s, frac: s.count / total, start: prev ? prev.start + prev.frac : 0 }];
  }, []);
  return (
    <div className="stat-donut">
      <svg viewBox={`0 0 ${size} ${size}`} width={size} height={size} role="img" aria-label={`Parties par jour : ${segs.map((s) => `${s.label} ${s.count}`).join(', ')}`}>
        {segs.map((s) => (
          <circle
            key={s.label}
            cx={c}
            cy={c}
            r={r}
            fill="none"
            stroke={s.color}
            strokeWidth={24}
            strokeDasharray={`${Math.max(0, s.frac * C - 1.5).toFixed(2)} ${C.toFixed(2)}`}
            strokeDashoffset={(-s.start * C).toFixed(2)}
            transform={`rotate(-90 ${c} ${c})`}
          >
            <title>{`${s.label} : ${s.count.toLocaleString('fr-FR')} (${(s.frac * 100).toFixed(1)} %)`}</title>
          </circle>
        ))}
        <text x={c} y={c - 1} textAnchor="middle" className="stat-donut-total">
          {total.toLocaleString('fr-FR')}
        </text>
        <text x={c} y={c + 15} textAnchor="middle" className="stat-donut-caption">
          Parties
        </text>
      </svg>
      <div className="rating-legend">
        {segs.map((s) => (
          <span key={s.label} className="rating-legend-item" title={s.label}>
            <span className="rating-dot" style={{ background: s.color }} />
            <span>{s.label}</span>
            <strong>{s.count.toLocaleString('fr-FR')}</strong>
            <span className="text-muted">{(s.frac * 100).toFixed(0)} %</span>
          </span>
        ))}
      </div>
    </div>
  );
};

/** 7 barres verticales de précision moyenne, côte à côte, axe fixe 0–100. */
const WeekdayAccuracyChart: React.FC<{ stats: WeekdayStats }> = ({ stats }) => {
  const rows = WEEKDAY_ORDER.map((day) => ({
    day,
    avg: weekdayAccuracy(stats.byDay[day]),
    n: stats.byDay[day].accN,
  }));
  if (rows.every((r) => r.avg === null)) {
    return <div className="empty-state">Lancez « Analyser précision » pour la précision par jour de la semaine.</div>;
  }
  const W = 560;
  const H = 170;
  const padL = 36;
  const padR = 10;
  const padT = 10;
  const padB = 30;
  const barWidth = (W - padL - padR) / rows.length;
  const x = (i: number): number => padL + i * barWidth;
  const y = (v: number): number => padT + (1 - v / 100) * (H - padT - padB);
  const base = H - padB;
  return (
    <div>
      <svg className="rating-chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Précision moyenne par jour de la semaine, de 0 à 100">
        {[0, 25, 50, 75, 100].map((v) => (
          <g key={v}>
            <line x1={padL} x2={W - padR} y1={y(v)} y2={y(v)} className="rating-grid" />
            <text x={padL - 5} y={y(v) + 3.5} textAnchor="end" className="rating-axis">
              {v}
            </text>
          </g>
        ))}
        {rows.map((r, i) => (
          <g key={r.day}>
            {r.avg !== null && (
              <>
                <rect
                  x={x(i)}
                  y={y(r.avg)}
                  width={barWidth}
                  height={Math.max(0, base - y(r.avg))}
                  fill="#10b981"
                >
                  <title>{`${WEEKDAY_LABEL[r.day]} : ${r.avg.toFixed(1)} % (${r.n} partie(s) notée(s))`}</title>
                </rect>
                <text x={x(i) + barWidth / 2} y={y(r.avg) - 4} textAnchor="middle" className="rating-axis">
                  {r.avg.toFixed(0)}
                </text>
              </>
            )}
            <text x={x(i) + barWidth / 2} y={H - 8} textAnchor="middle" className="rating-axis">
              <title>{WEEKDAY_LABEL[r.day]}</title>
              {WEEKDAY_SHORT[r.day]}
            </text>
          </g>
        ))}
      </svg>
    </div>
  );
};

/** 7 barres verticales V/N/D à 100 %, côte à côte (une par jour). */
const WeekdayResultsChart: React.FC<{ stats: WeekdayStats }> = ({ stats }) => {
  const rows = WEEKDAY_ORDER.map((day) => ({ day, ...stats.byDay[day] }));
  if (rows.every((r) => r.games === 0)) {
    return <div className="empty-state">Aucune partie à heure lisible.</div>;
  }
  const SEGMENTS = [
    { key: 'losses', color: OUTCOME_COLOR.loss, name: 'Défaites' },
    { key: 'draws', color: OUTCOME_COLOR.draw, name: 'Nulles' },
    { key: 'wins', color: OUTCOME_COLOR.win, name: 'Victoires' },
  ] as const;
  const W = 560;
  const H = 170;
  const padL = 36;
  const padR = 10;
  const padT = 10;
  const padB = 30;
  const barWidth = (W - padL - padR) / rows.length;
  const x = (i: number): number => padL + i * barWidth;
  const y = (pct: number): number => padT + (1 - pct / 100) * (H - padT - padB);
  return (
    <div>
      <svg className="rating-chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Résultats en pourcent par jour de la semaine">
        {[0, 25, 50, 75, 100].map((v) => (
          <g key={v}>
            <line x1={padL} x2={W - padR} y1={y(v)} y2={y(v)} className="rating-grid" />
            <text x={padL - 5} y={y(v) + 3.5} textAnchor="end" className="rating-axis">
              {v}
            </text>
          </g>
        ))}
        {rows.map((r, i) => {
          if (r.games === 0) {
            return (
              <text key={r.day} x={x(i) + barWidth / 2} y={H - 8} textAnchor="middle" className="rating-axis">
                <title>{`${WEEKDAY_LABEL[r.day]} — aucune partie`}</title>
                {WEEKDAY_SHORT[r.day]}
              </text>
            );
          }
          let stacked = 0;
          return (
            <g key={r.day}>
              <title>{`${WEEKDAY_LABEL[r.day]} : ${r.games} parties (${r.wins}V / ${r.draws}N / ${r.losses}D)`}</title>
              {SEGMENTS.map((s) => {
                const count = r[s.key];
                const share = (count / r.games) * 100;
                const yTop = y(stacked + share);
                const yBottom = y(stacked);
                const yMid = (yTop + yBottom) / 2;
                stacked += share;
                if (count <= 0) return null;
                return (
                  <g key={s.key}>
                    <rect
                      x={x(i)}
                      y={yTop}
                      width={barWidth}
                      height={Math.max(0, yBottom - yTop)}
                      fill={s.color}
                    >
                      <title>{`${WEEKDAY_LABEL[r.day]} — ${s.name} : ${count} (${share.toFixed(0)} %)`}</title>
                    </rect>
                    {share >= 12 && (
                      <text x={x(i) + barWidth / 2} y={yMid + 3.5} textAnchor="middle" fill="#fff" fontSize="10">
                        {share.toFixed(0)}
                      </text>
                    )}
                  </g>
                );
              })}
              <text x={x(i) + barWidth / 2} y={H - 8} textAnchor="middle" className="rating-axis">
                <title>{`${WEEKDAY_LABEL[r.day]} — ${r.games} parties`}</title>
                {WEEKDAY_SHORT[r.day]} ({r.games})
              </text>
            </g>
          );
        })}
      </svg>
      <div className="rating-legend">
        <span className="rating-legend-item">
          <span className="rating-dot" style={{ background: OUTCOME_COLOR.win }} />
          <span>Victoires</span>
        </span>
        <span className="rating-legend-item">
          <span className="rating-dot" style={{ background: OUTCOME_COLOR.draw }} />
          <span>Nulles</span>
        </span>
        <span className="rating-legend-item">
          <span className="rating-dot" style={{ background: OUTCOME_COLOR.loss }} />
          <span>Défaites</span>
        </span>
      </div>
      <div className="activity-subtitle text-muted">En bas : défaites · au milieu : nulles · en haut : victoires</div>
    </div>
  );
};

/**
 * Panneau « Jour de la semaine » : quels jours jouez-vous, et quand
 * performez-vous ? Heure locale du navigateur, semaine commençant lundi.
 */
export const WeekdayPanel: React.FC<WeekdayPanelProps> = ({ games, me }) => {
  const stats = useMemo(
    () => computeWeekdayStats(
      games.map((g) => ({
        endTime: g.end_time,
        outcome: outcomeFor(g, me),
        accuracy: typeof g.accuracy === 'number' ? g.accuracy : null,
      })),
    ),
    [games, me],
  );

  const ratedTotal = WEEKDAY_ORDER.reduce((s, day) => s + stats.byDay[day].accN, 0);

  return (
    <div className="chesscom-stats-grid">
      <div className="panel-card">
        <div className="card-title-row">
          <h3 className="card-title">
            <Calendar size={16} className="title-icon" />
            Jour de la semaine
          </h3>
        </div>
        <div className="activity-subtitle text-muted">
          {stats.total.toLocaleString('fr-FR')} partie(s) à heure lisible
          {stats.unknown > 0 && ` · ${stats.unknown} sans horodatage (ignorée(s))`}
          {' · heure locale'}
        </div>

        {stats.total === 0 ? (
          <div className="empty-state">Aucune partie à heure lisible.</div>
        ) : (
          <>
            <h4 className="card-title-sm">Parties par jour de la semaine</h4>
            <WeekdayDonut stats={stats} />
            <h4 className="card-title-sm">Précision par jour de la semaine</h4>
            <div className="activity-subtitle text-muted">
              {ratedTotal.toLocaleString('fr-FR')} partie(s) notée(s) · axe 0–100
            </div>
            <WeekdayAccuracyChart stats={stats} />
            <h4 className="card-title-sm">Résultats par jour de la semaine</h4>
            <div className="activity-subtitle text-muted">
              Chaque barre = 100 % des parties du jour
            </div>
            <WeekdayResultsChart stats={stats} />
          </>
        )}
      </div>
    </div>
  );
};
