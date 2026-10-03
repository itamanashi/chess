import React from 'react';
import { Crown, Gift, Pin, ShieldAlert, Zap } from 'lucide-react';
import {
  FORK_PIECE_LABELS,
  FORK_PIECE_ORDER,
  HUNG_PIECE_LABELS,
  HUNG_PIECE_ORDER,
  MATE_DISTANCE_LABELS,
  MATE_DISTANCE_ORDER,
  PIN_PIECE_LABELS,
  PIN_PIECE_ORDER,
  type ForkPiece,
  type HungPiece,
  type MateDistance,
  type PinPiece,
} from '../services/chesscom';

/** Icônes des pièces (glyphes du domaine, fond sombre). */
const FORK_PIECE_GLYPHS: Record<ForkPiece, string> = {
  p: '♙',
  n: '♘',
  b: '♗',
  r: '♖',
  q: '♕',
  k: '♔',
};

const PIN_PIECE_GLYPHS: Record<PinPiece, string> = {
  b: '♗',
  r: '♖',
  q: '♕',
};

export interface TacticRowDatum {
  key: string;
  glyph: string;
  label: string;
  found: number;
  missed: number;
}

interface FoundMissed<T extends string | number> {
  found: Record<T, number>;
  missed: Record<T, number>;
  games: number;
}

interface TacticsPanelProps {
  forks: FoundMissed<ForkPiece>;
  pins: FoundMissed<PinPiece>;
  mates: FoundMissed<MateDistance>;
  hangs: { counts: Record<HungPiece, number>; total: number; games: number };
  freebies: FoundMissed<HungPiece>;
}

/** « 1 trouvée » / « 3 trouvées » (le français n'aime pas les « (s) »). */
function qty(n: number, one: string, many: string): string {
  return `${n.toLocaleString('fr-FR')} ${n > 1 ? many : one}`;
}

/** Lignes horizontales Trouvées (vert) / Manquées (rouge) par pièce tactique. */
const TacticRowsChart: React.FC<{ rows: TacticRowDatum[] }> = ({ rows }) => {
  return (
    <div>
      <div className="forks-hbars">
        {rows.map((r) => {
          const total = r.found + r.missed;
          return (
            <div
              key={r.key}
              className="forks-hbar-row"
              title={`${r.label} : ${qty(r.found, 'trouvée', 'trouvées')} / ${qty(r.missed, 'manquée', 'manquées')}`}
            >
              <span className="forks-piece-icon" aria-hidden="true">
                {r.glyph}
              </span>
              <span className="forks-hbar-label">{r.label}</span>
              <div
                className="chesscom-wdl-bar forks-hbar-track"
                role="img"
                aria-label={`${r.label} : ${qty(r.found, 'trouvée', 'trouvées')}, ${qty(r.missed, 'manquée', 'manquées')}`}
              >
                {total > 0 && (
                  <>
                    {r.found > 0 && (
                      <div className="chesscom-wdl-segment" style={{ width: `${(r.found / total) * 100}%`, background: 'var(--success)' }} />
                    )}
                    {r.missed > 0 && (
                      <div className="chesscom-wdl-segment" style={{ width: `${(r.missed / total) * 100}%`, background: '#d8816f' }} />
                    )}
                  </>
                )}
              </div>
              <strong className="forks-hbar-value">
                {r.found.toLocaleString('fr-FR')} <span className="text-muted">/ {r.missed.toLocaleString('fr-FR')}</span>
              </strong>
            </div>
          );
        })}
      </div>
      <div className="rating-legend">
        <span className="rating-legend-item">
          <span className="rating-dot" style={{ background: 'var(--success)' }} />
          <span>Trouvées</span>
        </span>
        <span className="rating-legend-item">
          <span className="rating-dot" style={{ background: '#d8816f' }} />
          <span>Manquées</span>
        </span>
      </div>
      <div className="activity-subtitle text-muted">À gauche : trouvées · à droite : manquées</div>
    </div>
  );
};

/**
 * Onglet « Tactique » de Mes parties : fourchettes, clouages, mats,
 * pièces en prise et pièces gratuites. Lecture seule : aucune
 * interaction clavier requise, les barres exposent leur texte aux
 * lecteurs d'écran via `role="img"`.
 */
export const TacticsPanel: React.FC<TacticsPanelProps> = ({
  forks,
  pins,
  mates,
  hangs,
  freebies,
}) => {
  const forksFound = FORK_PIECE_ORDER.reduce((s, p) => s + (forks.found[p] ?? 0), 0);
  const forksMissed = FORK_PIECE_ORDER.reduce((s, p) => s + (forks.missed[p] ?? 0), 0);
  const pinsFound = PIN_PIECE_ORDER.reduce((s, p) => s + (pins.found[p] ?? 0), 0);
  const pinsMissed = PIN_PIECE_ORDER.reduce((s, p) => s + (pins.missed[p] ?? 0), 0);
  const matesFound = MATE_DISTANCE_ORDER.reduce((s, d) => s + (mates.found[d] ?? 0), 0);
  const matesMissed = MATE_DISTANCE_ORDER.reduce((s, d) => s + (mates.missed[d] ?? 0), 0);
  const freebiesFound = HUNG_PIECE_ORDER.reduce((s, p) => s + (freebies.found[p] ?? 0), 0);
  const freebiesMissed = HUNG_PIECE_ORDER.reduce((s, p) => s + (freebies.missed[p] ?? 0), 0);

  return (
    <div className="chesscom-stats-grid">
      <div className="panel-card">
        <div className="card-title-row">
          <h3 className="card-title">
            <Zap size={16} className="title-icon" aria-hidden="true" />
            Fourchettes
          </h3>
        </div>
        <div className="activity-subtitle text-muted">
          {qty(forksFound, 'trouvée', 'trouvées')} · {qty(forksMissed, 'manquée', 'manquées')} · {qty(forks.games, 'partie analysée', 'parties analysées')}
        </div>
        {forks.games === 0 ? (
          <div className="empty-state">Lancez « Analyser précision » pour détecter vos fourchettes.</div>
        ) : (
          <TacticRowsChart
            rows={FORK_PIECE_ORDER.map((p) => ({
              key: p,
              glyph: FORK_PIECE_GLYPHS[p],
              label: FORK_PIECE_LABELS[p],
              found: forks.found[p] ?? 0,
              missed: forks.missed[p] ?? 0,
            }))}
          />
        )}
      </div>

      <div className="panel-card">
        <div className="card-title-row">
          <h3 className="card-title">
            <Pin size={16} className="title-icon" aria-hidden="true" />
            Clouages
          </h3>
        </div>
        <div className="activity-subtitle text-muted">
          {qty(pinsFound, 'trouvé', 'trouvés')} · {qty(pinsMissed, 'manqué', 'manqués')} · {qty(pins.games, 'partie analysée', 'parties analysées')}
        </div>
        {pins.games === 0 ? (
          <div className="empty-state">Lancez « Analyser précision » pour détecter vos clouages.</div>
        ) : (
          <TacticRowsChart
            rows={PIN_PIECE_ORDER.map((p) => ({
              key: p,
              glyph: PIN_PIECE_GLYPHS[p],
              label: PIN_PIECE_LABELS[p],
              found: pins.found[p] ?? 0,
              missed: pins.missed[p] ?? 0,
            }))}
          />
        )}
      </div>

      <div className="panel-card">
        <div className="card-title-row">
          <h3 className="card-title">
            <Crown size={16} className="title-icon" aria-hidden="true" />
            Mats
          </h3>
        </div>
        <div className="activity-subtitle text-muted">
          {qty(matesFound, 'trouvé', 'trouvés')} · {qty(matesMissed, 'manqué', 'manqués')} · {qty(mates.games, 'partie analysée', 'parties analysées')}
        </div>
        {mates.games === 0 ? (
          <div className="empty-state">Lancez « Analyser précision » pour détecter vos mats.</div>
        ) : (
          <TacticRowsChart
            rows={MATE_DISTANCE_ORDER.map((d) => ({
              key: String(d),
              glyph: '#',
              label: MATE_DISTANCE_LABELS[d],
              found: mates.found[d] ?? 0,
              missed: mates.missed[d] ?? 0,
            }))}
          />
        )}
      </div>

      <div className="panel-card">
        <div className="card-title-row">
          <h3 className="card-title">
            <ShieldAlert size={16} className="title-icon" aria-hidden="true" />
            Pièces en prise
          </h3>
        </div>
        <div className="activity-subtitle text-muted">
          {qty(hangs.total, 'pièce laissée en prise', 'pièces laissées en prise')} · {qty(hangs.games, 'partie analysée', 'parties analysées')}
        </div>
        {hangs.games === 0 ? (
          <div className="empty-state">Lancez « Analyser précision » pour détecter vos pièces en prise.</div>
        ) : (
          <div className="forks-hbars">
            {HUNG_PIECE_ORDER.map((p) => {
              const n = hangs.counts[p] ?? 0;
              const pct = hangs.total > 0 ? (n / hangs.total) * 100 : 0;
              return (
                <div
                  key={p}
                  className="forks-hbar-row"
                  title={`${HUNG_PIECE_LABELS[p]} : ${qty(n, 'pièce laissée en prise', 'pièces laissées en prise')} (${pct.toFixed(0)} %)`}
                >
                  <span className="forks-piece-icon" aria-hidden="true">
                    {FORK_PIECE_GLYPHS[p]}
                  </span>
                  <span className="forks-hbar-label">{HUNG_PIECE_LABELS[p]}</span>
                  <div
                    className="chesscom-wdl-bar forks-hbar-track"
                    role="img"
                    aria-label={`${HUNG_PIECE_LABELS[p]} : ${pct.toFixed(0)} % des pièces en prise`}
                  >
                    {n > 0 && (
                      <div className="chesscom-wdl-segment" style={{ width: `${pct}%`, background: '#d8816f' }} />
                    )}
                  </div>
                  <strong className="forks-hbar-value">
                    {pct.toFixed(0)} % <span className="text-muted">({n.toLocaleString('fr-FR')})</span>
                  </strong>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div className="panel-card">
        <div className="card-title-row">
          <h3 className="card-title">
            <Gift size={16} className="title-icon" aria-hidden="true" />
            Pièces gratuites
          </h3>
        </div>
        <div className="activity-subtitle text-muted">
          Pièces que votre adversaire a laissées en prise · {qty(freebiesFound, 'prise', 'prises')} · {qty(freebiesMissed, 'ignorée', 'ignorées')} · {qty(freebies.games, 'partie analysée', 'parties analysées')}
        </div>
        {freebies.games === 0 ? (
          <div className="empty-state">Lancez « Analyser précision » pour détecter les pièces gratuites.</div>
        ) : (
          <TacticRowsChart
            rows={HUNG_PIECE_ORDER.map((p) => ({
              key: p,
              glyph: FORK_PIECE_GLYPHS[p],
              label: HUNG_PIECE_LABELS[p],
              found: freebies.found[p] ?? 0,
              missed: freebies.missed[p] ?? 0,
            }))}
          />
        )}
      </div>
    </div>
  );
};
