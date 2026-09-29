import React, { useMemo, useState } from 'react';
import { Castle } from 'lucide-react';
import { colorOf, outcomeFor, type ChesscomGame } from '../services/chesscom';
import {
  CASTLE_STATUS_LABEL,
  computeCastlingStats,
  wldTotal,
  type CastlePhase,
  type CastleStatus,
  type Wld,
} from '../utils/castling';

interface CastlingPanelProps {
  /** Parties listées (robots déjà exclus sauf option) avec SAN rejouables. */
  games: ChesscomGame[];
  /** Pseudo du compte lié (perspective V/N/D). */
  me: string;
}

type CastleView = 'phase' | 'side';

const PHASE_ORDER: CastlePhase[] = ['opening', 'middlegame', 'endgame', 'none'];
const PHASE_TITLES: Record<CastlePhase, string> = {
  opening: 'Ouverture',
  middlegame: 'Milieu de jeu',
  endgame: 'Finale',
  none: 'Pas de roque',
};
const PHASE_COLORS: Record<CastlePhase, string> = {
  opening: '#ead9b5',
  middlegame: '#b58863',
  endgame: '#7d9a7e',
  none: '#6f6a60',
};

const SIDE_GROUPS: Array<{ key: CastleStatus; title: string }> = [
  { key: 'kingside', title: 'Quand vous avez fait un petit roque (aile roi)' },
  { key: 'queenside', title: 'Quand vous avez fait un grand roque (aile dame)' },
  { key: 'none', title: 'Quand vous n’avez jamais roqué' },
];
const OPP_COLS: Array<{ key: CastleStatus; label: string; full: string }> = [
  { key: 'kingside', label: 'Adv. petit roque', full: "Quand votre adversaire a fait un petit roque" },
  { key: 'queenside', label: 'Adv. grand roque', full: "Quand votre adversaire a fait un grand roque" },
  { key: 'none', label: 'Adv. sans roque', full: "Quand votre adversaire n'a pas roqué" },
];

/** UNE seule barre empilée V/N/D (même motif que le reste de l'onglet). */
const WndBar: React.FC<{ wld: Wld; label: string; compact?: boolean }> = ({ wld, label, compact = false }) => {
  const total = wldTotal(wld);
  if (total <= 0) return <div className="empty-state">Aucune partie.</div>;
  const segs = [
    { key: 'V', name: 'Victoires', n: wld.wins, color: '#7d9a7e' },
    { key: 'N', name: 'Nulles', n: wld.draws, color: '#6f6a60' },
    { key: 'D', name: 'Défaites', n: wld.losses, color: '#c46b5a' },
  ];
  const pct = (n: number): string => {
    const p = (n / total) * 100;
    return n > 0 && p < 0.5 ? '<1' : p.toFixed(0);
  };
  return (
    <div>
      <div
        className="chesscom-wdl-bar"
        role="img"
        aria-label={`${label} : ${segs.map((s) => `${s.name} ${s.n}`).join(', ')}`}
      >
        {segs.map((s) =>
          s.n > 0 ? (
            <div
              key={s.key}
              className="chesscom-wdl-segment"
              style={{ width: `${(s.n / total) * 100}%`, background: s.color }}
              title={`${s.name} : ${s.n} (${pct(s.n)} %)`}
            >
              {s.n / total >= 0.12 ? `${pct(s.n)}%` : ''}
            </div>
          ) : null,
        )}
      </div>
      {compact ? (
        <div className="activity-subtitle text-muted">
          {segs.map((s) => `${s.n} ${s.key}`).join(' · ')}
        </div>
      ) : (
        <div className="rating-legend">
          {segs.map((s) => (
            <span key={s.key} className="rating-legend-item" title={s.name}>
              <span className="rating-dot" style={{ background: s.color }} />
              <span>{s.name}</span>
              <strong>{s.n.toLocaleString('fr-FR')}</strong>
              <span className="text-muted">{pct(s.n)} %</span>
            </span>
          ))}
        </div>
      )}
    </div>
  );
};

/** Camembert SVG pur (même technique que le donut des pièces). */
const ShareDonut: React.FC<{
  segments: Array<{ label: string; count: number; color: string }>;
  caption: string;
}> = ({ segments, caption }) => {
  const total = segments.reduce((s, x) => s + x.count, 0);
  if (total <= 0) return <div className="empty-state">Aucune partie.</div>;
  const size = 150;
  const c = size / 2;
  const r = 52;
  const C = 2 * Math.PI * r;
  let start = 0;
  return (
    <div className="stat-donut">
      <svg viewBox={`0 0 ${size} ${size}`} width={size} height={size} role="img" aria-label={`${caption} : ${segments.map((s) => `${s.label} ${s.count}`).join(', ')}`}>
        {segments.map((s) => {
          if (s.count <= 0) return null;
          const frac = s.count / total;
          const el = (
            <circle
              key={s.label}
              cx={c}
              cy={c}
              r={r}
              fill="none"
              stroke={s.color}
              strokeWidth={24}
              strokeDasharray={`${Math.max(0, frac * C - 1.5).toFixed(2)} ${C.toFixed(2)}`}
              strokeDashoffset={(-start * C).toFixed(2)}
              transform={`rotate(-90 ${c} ${c})`}
            >
              <title>{`${s.label} : ${s.count.toLocaleString('fr-FR')} (${(frac * 100).toFixed(1)} %)`}</title>
            </circle>
          );
          start += frac;
          return el;
        })}
        <text x={c} y={c - 1} textAnchor="middle" className="stat-donut-total">
          {total.toLocaleString('fr-FR')}
        </text>
        <text x={c} y={c + 15} textAnchor="middle" className="stat-donut-caption">
          {caption}
        </text>
      </svg>
      <div className="rating-legend">
        {segments.filter((s) => s.count > 0).map((s) => (
          <span key={s.label} className="rating-legend-item" title={s.label}>
            <span className="rating-dot" style={{ background: s.color }} />
            <span>{s.label}</span>
            <strong>{s.count.toLocaleString('fr-FR')}</strong>
            <span className="text-muted">{((s.count / total) * 100).toFixed(0)} %</span>
          </span>
        ))}
      </div>
    </div>
  );
};

/**
 * Panneau « Roque » : roque détecté depuis les SAN (aucun moteur requis,
 * donc calculé sur tout l'historique). Deux affichages : par phase de
 * votre roque (camembert + barre V/N/D), ou matrice
 * mon-roque × roque-adverse (3×3 barres V/N/D).
 */
export const CastlingPanel: React.FC<CastlingPanelProps> = ({ games, me }) => {
  const [view, setView] = useState<CastleView>('phase');

  const stats = useMemo(
    () => computeCastlingStats(
      games.map((g) => ({ sans: g.sans, myColor: colorOf(g, me), outcome: outcomeFor(g, me) })),
    ),
    [games, me],
  );

  return (
    <div className="chesscom-stats-grid">
      <div className="panel-card">
        <div className="card-title-row">
          <h3 className="card-title">
            <Castle size={16} className="title-icon" />
            Roque
          </h3>
        </div>
        <div className="activity-subtitle text-muted">
          {stats.total.toLocaleString('fr-FR')} partie(s) à coups lisibles
          {stats.unknown > 0 && ` · ${stats.unknown} sans coups lisibles (ignorée(s))`}
        </div>

        <div className="chesscom-filter-group" role="group" aria-label="Affichage">
          <button
            className={`db-toggle-btn ${view === 'phase' ? 'active' : ''}`}
            onClick={() => setView('phase')}
          >
            <span>Par phase</span>
          </button>
          <button
            className={`db-toggle-btn ${view === 'side' ? 'active' : ''}`}
            onClick={() => setView('side')}
          >
            <span>Aile roi ou dame</span>
          </button>
        </div>

        {stats.total === 0 ? (
          <div className="empty-state">Aucune partie à coups lisibles.</div>
        ) : view === 'phase' ? (
          <>
            <h4 className="card-title-sm">Parties où vous avez roqué lors de…</h4>
            <div className="activity-subtitle text-muted">
              Phase de votre roque (pli ≤ 20 / ≤ 60, comme le rapport de précision).
            </div>
            <ShareDonut
              caption="Parties"
              segments={PHASE_ORDER.map((p) => ({
                label: PHASE_TITLES[p],
                count: wldTotal(stats.byPhase[p]),
                color: PHASE_COLORS[p],
              }))}
            />
            {PHASE_ORDER.map((p) => (
              <div key={p}>
                <h4 className="card-title-sm">
                  {PHASE_TITLES[p]} ({wldTotal(stats.byPhase[p]).toLocaleString('fr-FR')})
                </h4>
                <WndBar wld={stats.byPhase[p]} label={PHASE_TITLES[p]} />
              </div>
            ))}
          </>
        ) : (
          <>
            {SIDE_GROUPS.map((g) => (
              <div key={g.key}>
                <h4 className="card-title-sm">
                  {g.title} ({(['kingside', 'queenside', 'none'] as CastleStatus[]).reduce((s, o) => s + wldTotal(stats.matrix[g.key][o]), 0).toLocaleString('fr-FR')})
                </h4>
                <div className="castle-matrix-row">
                  {OPP_COLS.map((o) => (
                    <div key={o.key} className="castle-matrix-cell" title={o.full}>
                      <div className="castle-matrix-label">{o.label}</div>
                      <WndBar wld={stats.matrix[g.key][o.key]} label={o.full} compact />
                    </div>
                  ))}
                </div>
              </div>
            ))}
            <div className="activity-subtitle text-muted">
              Légende des statuts : {(['kingside', 'queenside', 'none'] as CastleStatus[]).map((s) => CASTLE_STATUS_LABEL[s]).join(' · ')}.
            </div>
          </>
        )}
      </div>
    </div>
  );
};
