import React, { useMemo } from 'react';
import { Clock } from 'lucide-react';
import { outcomeFor, type ChesscomGame } from '../services/chesscom';
import {
  DAY_SLOT_LABEL,
  DAY_SLOT_ORDER,
  DAY_SLOT_RANGE,
  DAY_SLOT_SHORT,
  computeDaytimeStats,
  daytimeAccuracy,
  type DaytimeStats,
} from '../utils/daytime';

interface DaytimePanelProps {
  /** Parties listées (robots déjà exclus sauf option). */
  games: ChesscomGame[];
  /** Pseudo du compte lié (perspective V/N/D + précision). */
  me: string;
}

const OUTCOME_COLOR = { win: '#8fb996', draw: '#8e887c', loss: '#d8816f' } as const;

/** 4 barres verticales de précision moyenne, côte à côte, axe fixe 0–100. */
const DaytimeAccuracyChart: React.FC<{ stats: DaytimeStats }> = ({ stats }) => {
  const rows = DAY_SLOT_ORDER.map((slot) => ({
    slot,
    avg: daytimeAccuracy(stats.bySlot[slot]),
    n: stats.bySlot[slot].accN,
  }));
  if (rows.every((r) => r.avg === null)) {
    return <div className="empty-state">Lancez « Analyser précision » pour la précision par moment de la journée.</div>;
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
      <svg className="rating-chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Précision moyenne par moment de la journée, de 0 à 100">
        {[0, 25, 50, 75, 100].map((v) => (
          <g key={v}>
            <line x1={padL} x2={W - padR} y1={y(v)} y2={y(v)} className="rating-grid" />
            <text x={padL - 5} y={y(v) + 3.5} textAnchor="end" className="rating-axis">
              {v}
            </text>
          </g>
        ))}
        {rows.map((r, i) =>
          r.avg !== null ? (
            <g key={r.slot}>
              <rect
                x={x(i)}
                y={y(r.avg)}
                width={barWidth}
                height={Math.max(0, base - y(r.avg))}
                fill="var(--accent)"
              >
                <title>{`${DAY_SLOT_LABEL[r.slot]} (${DAY_SLOT_RANGE[r.slot]}) : ${r.avg.toFixed(1)} % (${r.n} partie(s) notée(s))`}</title>
              </rect>
              <text x={x(i) + barWidth / 2} y={y(r.avg) - 4} textAnchor="middle" className="rating-axis">
                {r.avg.toFixed(0)}
              </text>
              <text x={x(i) + barWidth / 2} y={H - 8} textAnchor="middle" className="rating-axis">
                <title>{`${DAY_SLOT_LABEL[r.slot]} : ${DAY_SLOT_RANGE[r.slot]}`}</title>
                {DAY_SLOT_SHORT[r.slot]}
              </text>
            </g>
          ) : (
            <g key={r.slot}>
              <text x={x(i) + barWidth / 2} y={H - 8} textAnchor="middle" className="rating-axis">
                <title>{`${DAY_SLOT_LABEL[r.slot]} : ${DAY_SLOT_RANGE[r.slot]}`}</title>
                {DAY_SLOT_SHORT[r.slot]}
              </text>
            </g>
          ),
        )}
      </svg>
    </div>
  );
};

/** 4 barres verticales V/N/D à 100 %, côte à côte (une par moment). */
const DaytimeResultsChart: React.FC<{ stats: DaytimeStats }> = ({ stats }) => {
  const rows = DAY_SLOT_ORDER.map((slot) => ({ slot, ...stats.bySlot[slot] }));
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
      <svg className="rating-chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Résultats en pourcent par moment de la journée">
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
              <text key={r.slot} x={x(i) + barWidth / 2} y={H - 8} textAnchor="middle" className="rating-axis">
                <title>{`${DAY_SLOT_LABEL[r.slot]} : ${DAY_SLOT_RANGE[r.slot]} — aucune partie`}</title>
                {DAY_SLOT_SHORT[r.slot]}
              </text>
            );
          }
          let stacked = 0;
          return (
            <g key={r.slot}>
              <title>{`${DAY_SLOT_LABEL[r.slot]} (${DAY_SLOT_RANGE[r.slot]}) : ${r.games} parties (${r.wins}V / ${r.draws}N / ${r.losses}D)`}</title>
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
                      <title>{`${DAY_SLOT_LABEL[r.slot]} — ${s.name} : ${count} (${share.toFixed(0)} %)`}</title>
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
                <title>{`${DAY_SLOT_LABEL[r.slot]} : ${DAY_SLOT_RANGE[r.slot]} — ${r.games} parties`}</title>
                {DAY_SLOT_SHORT[r.slot]} ({r.games})
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
 * Panneau « Heure du jour » : à quels moments jouez-vous, et quand
 * performez-vous ? Heure locale du navigateur, 4 tranches fixes
 * (Matin 6h–12h, Après-midi 12h–18h, Soir 18h–0h, Nuit 0h–6h).
 */
export const DaytimePanel: React.FC<DaytimePanelProps> = ({ games, me }) => {
  const stats = useMemo(
    () => computeDaytimeStats(
      games.map((g) => ({
        endTime: g.end_time,
        outcome: outcomeFor(g, me),
        accuracy: typeof g.accuracy === 'number' ? g.accuracy : null,
      })),
    ),
    [games, me],
  );

  const ratedTotal = DAY_SLOT_ORDER.reduce((s, slot) => s + stats.bySlot[slot].accN, 0);

  return (
    <div className="chesscom-stats-grid">
      <div className="panel-card">
        <div className="card-title-row">
          <h3 className="card-title">
            <Clock size={16} className="title-icon" />
            Heure du jour
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
            <h4 className="card-title-sm">Précision par moment de la journée</h4>
            <div className="activity-subtitle text-muted">
              {ratedTotal.toLocaleString('fr-FR')} partie(s) notée(s) · axe 0–100
            </div>
            <DaytimeAccuracyChart stats={stats} />
            <h4 className="card-title-sm">Résultats par moment de la journée</h4>
            <div className="activity-subtitle text-muted">
              Tranches locales : {DAY_SLOT_ORDER.map((s) => `${DAY_SLOT_LABEL[s]} ${DAY_SLOT_RANGE[s]}`).join(' · ')}
            </div>
            <DaytimeResultsChart stats={stats} />
          </>
        )}
      </div>
    </div>
  );
};
