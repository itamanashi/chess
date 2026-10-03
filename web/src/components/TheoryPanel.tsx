import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { BookOpen, GraduationCap } from 'lucide-react';
import type {
  MasteryOpeningRow,
  MasteryTrendRow,
  OpeningPerformanceRow,
} from '../services/chesscom';
import { MiniBoard, fenAfterSans } from './MiniBoard';
import { frenchOpeningName } from '../utils/openingsFr';

/** Lignes affichées avant « Tout afficher » (même seuil que les autres tables). */
const THEORY_TOP_N = 10;

interface TheoryPanelProps {
  perfColor: 'w' | 'b';
  onPerfColorChange: (color: 'w' | 'b') => void;
  perfRows: OpeningPerformanceRow[];
  masteryColor: 'w' | 'b';
  onMasteryColorChange: (color: 'w' | 'b') => void;
  /** Un répertoire avec des variantes existe (théorie mesurable). */
  hasTheory: boolean;
  /** Aucune partie dans le périmètre (couleur filtrée). */
  masteryEmpty: boolean;
  masteryAvgTheoryMoves: number | null;
  masteryDevFirstCount: number;
  masteryTrendRows: MasteryTrendRow[];
  trendGranularityLabel: string;
  masteryOpenings: MasteryOpeningRow[];
}

/** Barres des coups théoriques moyens par période, jusque-là joués (SVG pur). */
const MasteryTrendChart: React.FC<{ rows: MasteryTrendRow[] }> = ({ rows }) => {
  if (rows.length === 0) {
    return <div className="empty-state">Aucune donnée sur la période.</div>;
  }
  const W = 560;
  const H = 150;
  const padL = 40;
  const padR = 10;
  const padT = 10;
  const padB = 30;
  const maxAvg = Math.max(...rows.map((r) => r.avg));
  const yMax = Math.max(5, Math.ceil(maxAvg));
  const barWidth = (W - padL - padR) / rows.length;
  const x = (i: number): number => padL + i * barWidth;
  const y = (v: number): number => padT + (1 - v / yMax) * (H - padT - padB);
  const base = H - padB;
  const labelStep = Math.max(1, Math.ceil(rows.length / 8));
  const gridSteps = yMax <= 8 ? yMax : 4;
  return (
    <div>
      <svg className="rating-chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Coups théoriques moyens par période">
        {Array.from({ length: gridSteps + 1 }, (_, k) => (yMax * k) / gridSteps).map((v) => (
          <g key={v}>
            <line x1={padL} x2={W - padR} y1={y(v)} y2={y(v)} className="rating-grid" />
            <text x={padL - 5} y={y(v) + 3.5} textAnchor="end" className="rating-axis">
              {Number.isInteger(v) ? v : v.toFixed(1)}
            </text>
          </g>
        ))}
        {rows.map((r, i) => (
          <g key={r.key}>
            <rect
              x={x(i)}
              y={y(r.avg)}
              width={barWidth}
              height={Math.max(0, base - y(r.avg))}
              fill="var(--accent)"
            >
              <title>{`${r.label} : ${r.avg.toFixed(1)} coups (${r.count} partie(s))`}</title>
            </rect>
            {(i % labelStep === 0 || i === rows.length - 1) && (
              <text x={x(i) + barWidth / 2} y={H - 8} textAnchor="middle" className="rating-axis">
                {r.shortLabel}
              </text>
            )}
          </g>
        ))}
      </svg>
    </div>
  );
};

function devShareTone(share: number): string {
  if (share >= 50) return '#d8816f';
  if (share >= 30) return '#d29e6a';
  return '#8fb996';
}

/**
 * Onglet « Théorie » de Mes parties : performances par ouverture (avec
 * aperçu au survol, bonus non essentiel) + maîtrise du répertoire.
 * Carnet d'étude : listes sémantiques, chiffres tabulaires, pastilles CSS.
 */
export const TheoryPanel: React.FC<TheoryPanelProps> = ({
  perfColor,
  onPerfColorChange,
  perfRows,
  masteryColor,
  onMasteryColorChange,
  hasTheory,
  masteryEmpty,
  masteryAvgTheoryMoves,
  masteryDevFirstCount,
  masteryTrendRows,
  trendGranularityLabel,
  masteryOpenings,
}) => {
  const [openingsExpanded, setOpeningsExpanded] = useState(false);
  const [masteryExpanded, setMasteryExpanded] = useState(false);

  /** Aperçu de position au survol d'une ouverture (mini-planche curseur). */
  const [openingPreview, setOpeningPreview] = useState<{
    key: string;
    fen: string;
    name: string;
    moves: string;
    x: number;
    y: number;
  } | null>(null);

  const showOpeningPreview = useCallback((r: OpeningPerformanceRow, clientX: number, clientY: number): void => {
    if (r.sansPrefix.length === 0) return;
    const fen = fenAfterSans(r.sansPrefix);
    if (!fen) return;
    const POP_W = 232;
    const POP_H = 300;
    setOpeningPreview({
      key: r.key,
      fen,
      name: r.name ? frenchOpeningName(r.name) : 'Inconnue',
      moves: r.movesLabel,
      x: Math.max(8, Math.min(clientX + 16, window.innerWidth - POP_W)),
      y: Math.max(8, Math.min(clientY + 16, window.innerHeight - POP_H)),
    });
  }, []);

  const moveOpeningPreview = useCallback((key: string, clientX: number, clientY: number): void => {
    setOpeningPreview((prev) => {
      if (!prev || prev.key !== key) return prev;
      const POP_W = 232;
      const POP_H = 300;
      return {
        ...prev,
        x: Math.max(8, Math.min(clientX + 16, window.innerWidth - POP_W)),
        y: Math.max(8, Math.min(clientY + 16, window.innerHeight - POP_H)),
      };
    });
  }, []);

  // Le popover est fixe : le moindre défilement le ferait flotter seul.
  useEffect(() => {
    if (!openingPreview) return;
    const clear = (): void => setOpeningPreview(null);
    window.addEventListener('scroll', clear, true);
    return () => window.removeEventListener('scroll', clear, true);
  }, [openingPreview]);

  const visiblePerfRows = useMemo(
    () => (openingsExpanded ? perfRows : perfRows.slice(0, THEORY_TOP_N)),
    [openingsExpanded, perfRows],
  );
  const visibleMasteryRows = useMemo(
    () => (masteryExpanded ? masteryOpenings : masteryOpenings.slice(0, THEORY_TOP_N)),
    [masteryExpanded, masteryOpenings],
  );

  return (
    <div className="chesscom-stats-grid">
      <div className="panel-card">
        <div className="card-title-row">
          <h3 className="card-title">
            <BookOpen size={16} className="title-icon" aria-hidden="true" />
            Ouvertures
          </h3>
          {perfRows.length > 0 && (
            <span className="badge" title="Ouvertures distinctes jouées avec cette couleur">
              {perfRows.length.toLocaleString('fr-FR')} ouverture{perfRows.length > 1 ? 's' : ''}
            </span>
          )}
        </div>

        <div className="chesscom-filter-group" role="group" aria-label="Couleur jouée">
          <button
            className={`db-toggle-btn ${perfColor === 'w' ? 'active' : ''}`}
            onClick={() => onPerfColorChange('w')}
            aria-pressed={perfColor === 'w'}
          >
            <span>Blancs</span>
          </button>
          <button
            className={`db-toggle-btn ${perfColor === 'b' ? 'active' : ''}`}
            onClick={() => onPerfColorChange('b')}
            aria-pressed={perfColor === 'b'}
          >
            <span>Noirs</span>
          </button>
        </div>

        {perfRows.length === 0 ? (
          <div className="empty-state">Aucune partie avec cette couleur.</div>
        ) : (
          <>
            <ul className="perf-rows" aria-label={`Ouvertures jouées avec les ${perfColor === 'w' ? 'Blancs' : 'Noirs'}`}>
              {visiblePerfRows.map((r) => {
                const winPct = r.games > 0 ? (r.wins / r.games) * 100 : 0;
                const drawPct = r.games > 0 ? (r.draws / r.games) * 100 : 0;
                const lossPct = r.games > 0 ? 100 - winPct - drawPct : 0;
                const scorePct = r.games > 0 ? ((r.wins + r.draws / 2) / r.games) * 100 : 0;
                return (
                  <li
                    key={r.key}
                    className="perf-row"
                    onMouseEnter={(e) => showOpeningPreview(r, e.clientX, e.clientY)}
                    onMouseMove={(e) => moveOpeningPreview(r.key, e.clientX, e.clientY)}
                    onMouseLeave={() => setOpeningPreview(null)}
                  >
                    <div className="perf-row-head">
                      <span className="perf-name" title={r.name ? frenchOpeningName(r.name) : 'Ouverture inconnue'}>
                        {r.name ? frenchOpeningName(r.name) : <span className="text-muted">Inconnue</span>}
                      </span>
                      {r.eco !== '?' && <span className="eco-tag" translate="no">{r.eco}</span>}
                      <span className="text-muted perf-total">
                        {r.games.toLocaleString('fr-FR')} parties · {scorePct.toFixed(0)}&nbsp;%
                      </span>
                    </div>
                    <div className="perf-moves" translate="no">{r.movesLabel}</div>
                    <div
                      className="chesscom-wdl-bar"
                      role="img"
                      aria-label={`${r.name ? frenchOpeningName(r.name) : 'Ouverture inconnue'} : ${r.wins} victoire${r.wins > 1 ? 's' : ''}, ${r.draws} nulle${r.draws > 1 ? 's' : ''}, ${r.losses} défaite${r.losses > 1 ? 's' : ''}`}
                    >
                      {winPct > 0 && (
                        <div className="chesscom-wdl-segment chesscom-wdl-win" style={{ width: `${winPct}%` }}>
                          {winPct >= 12 ? `${winPct.toFixed(0)}%` : ''}
                        </div>
                      )}
                      {drawPct > 0 && (
                        <div className="chesscom-wdl-segment chesscom-wdl-draw" style={{ width: `${drawPct}%` }}>
                          {drawPct >= 12 ? `${drawPct.toFixed(0)}%` : ''}
                        </div>
                      )}
                      {lossPct > 0 && (
                        <div className="chesscom-wdl-segment chesscom-wdl-loss" style={{ width: `${lossPct}%` }}>
                          {lossPct >= 12 ? `${lossPct.toFixed(0)}%` : ''}
                        </div>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
            {!openingsExpanded && perfRows.length > THEORY_TOP_N && (
              <button
                className="primary-btn full-width"
                onClick={() => setOpeningsExpanded(true)}
                aria-expanded={false}
              >
                <span>Tout afficher ({perfRows.length} ouvertures)</span>
              </button>
            )}
          </>
        )}
        {openingPreview && (
          <div
            className="opening-preview-pop"
            style={{ left: openingPreview.x, top: openingPreview.y }}
            aria-hidden="true"
          >
            <MiniBoard fen={openingPreview.fen} orientation={perfColor} />
            <div className="opening-preview-caption">
              <strong>{openingPreview.name}</strong>
              {' · '}
              {openingPreview.moves}
            </div>
          </div>
        )}
      </div>

      <div className="panel-card">
        <div className="card-title-row">
          <h3 className="card-title">
            <GraduationCap size={16} className="title-icon" aria-hidden="true" />
            Maîtrise
          </h3>
        </div>
        <div className="chesscom-filter-group" role="group" aria-label="Couleur jouée">
          <button
            className={`db-toggle-btn ${masteryColor === 'w' ? 'active' : ''}`}
            onClick={() => onMasteryColorChange('w')}
            aria-pressed={masteryColor === 'w'}
          >
            <span>Blancs</span>
          </button>
          <button
            className={`db-toggle-btn ${masteryColor === 'b' ? 'active' : ''}`}
            onClick={() => onMasteryColorChange('b')}
            aria-pressed={masteryColor === 'b'}
          >
            <span>Noirs</span>
          </button>
        </div>
        {!hasTheory ? (
          <div className="empty-state">Créez un répertoire avec des variantes pour mesurer votre maîtrise.</div>
        ) : masteryEmpty ? (
          <div className="empty-state">Aucune partie avec cette couleur.</div>
        ) : (
          <>
            <div className="chesscom-summary">
              <span>
                En moyenne <strong>{masteryAvgTheoryMoves !== null ? masteryAvgTheoryMoves.toFixed(1) : '—'}</strong> coups
                théoriques dans les parties où vous déviez en premier ({masteryDevFirstCount.toLocaleString('fr-FR')})
              </span>
            </div>
            <div className="activity-subtitle text-muted">
              Coups théoriques {trendGranularityLabel}
            </div>
            <MasteryTrendChart rows={masteryTrendRows} />
            <div className="chesscom-stats-table-wrap">
              <table className="chesscom-stats-table theory-table">
                <thead>
                  <tr>
                    <th scope="col">Nom de l'ouverture</th>
                    <th scope="col" title="Parties dans le périmètre">Parties</th>
                    <th scope="col" title="Part de parties où vous déviez en premier de la théorie">Dévie 1er</th>
                    <th scope="col" title="Coup moyen à partir duquel vous déviez de la théorie">Coup moyen</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleMasteryRows.map((r) => (
                    <tr key={r.key}>
                      <td>
                        {r.eco !== '?' && <span className="eco-tag" translate="no">{r.eco} </span>}
                        {r.name ? frenchOpeningName(r.name) : <span className="text-muted">Inconnue</span>}
                      </td>
                      <td className="num">{r.total.toLocaleString('fr-FR')}</td>
                      <td className="num" style={{ color: devShareTone(r.devFirstShare) }}>
                        {r.devFirstShare.toFixed(0)}&nbsp;%
                      </td>
                      <td className="num">{r.avgDevMove !== null ? r.avgDevMove.toFixed(1) : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {!masteryExpanded && masteryOpenings.length > THEORY_TOP_N && (
              <button
                className="primary-btn full-width"
                onClick={() => setMasteryExpanded(true)}
                aria-expanded={false}
              >
                <span>Tout afficher ({masteryOpenings.length} ouvertures)</span>
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
};
