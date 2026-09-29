import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  addPieceStatsInto,
  addPliesToMoveAccuracy,
  analyzeMasteryGames,
  buildActivityWeeks,
  buildMasteryTheory,
  buildRatingSeries,
  classifyGameShape,
  colorOf,
  computeAccuracyStats,
  computeEndingStats,
  computeGameMoveQuality,
  computeGamePieceStats,
  computeMasteryOpenings,
  computeMasteryTrend,
  computeOpponentRatingStats,
  computeOpeningPerformances,
  computePeriodStats,
  computePhaseStats,
  computeQualityTrend,
  computeSideStats,
  detectUserForks,
  detectUserFreebies,
  detectUserHangs,
  detectUserMates,
  detectUserPins,
  emptyMoveAccuracy,
  emptyPieceStats,
  FORK_PIECE_LABELS,
  FORK_PIECE_ORDER,
  GAME_SHAPE_DESCRIPTIONS,
  GAME_SHAPE_LABELS,
  GAME_SHAPE_ORDER,
  HUNG_PIECE_LABELS,
  HUNG_PIECE_ORDER,
  isBotGame,
  MATE_DISTANCE_LABELS,
  MATE_DISTANCE_ORDER,
  MOVE_QUALITY_COLORS,
  MOVE_QUALITY_LABELS,
  MOVE_QUALITY_ORDER,
  outcomeFor,
  PHASE_LABELS,
  PIECE_COLORS,
  PIECE_GLYPHS,
  PIECE_LABELS,
  PIECE_ORDER,
  PIECE_PHASE_ORDER,
  PIN_PIECE_LABELS,
  PIN_PIECE_ORDER,
  type AccuracyPeriodRow,
  type ChesscomGame,
  type ChesscomOutcome,
  type ForkCounts,
  type ForkPiece,
  type FreebieCounts,
  type GameShape,
  type HungCounts,
  type HungPiece,
  type MasteryTrendRow,
  type MateCounts,
  type MateDistance,
  type MoveAccuracyByNumber,
  type MoveQuality,
  type MoveQualityCounts,
  type OpeningPerformanceRow,
  type OpponentRatingRow,
  type PeriodStatRow,
  type PhaseStatRow,
  type PieceStats,
  type PinCounts,
  type PinPiece,
} from '../services/chesscom';
import { chesscomMoveAccuracyStore } from '../storage/preferences';
import type { PieceKind, RepertoireItem } from '../types/chess';
import { analyzeGamePgn } from '../services/gameAnalysis';
import { analyzeGameAccuracy } from '../services/stockfish';
import { type GameReport } from '../utils/accuracy';
import { GameReportView } from './GameReportView';
import { CastlingPanel } from './CastlingPanel';
import { DaytimePanel } from './DaytimePanel';
import { WeekdayPanel } from './WeekdayPanel';
import { GeographyPanel } from './GeographyPanel';
import { frenchOpeningName } from '../utils/openingsFr';
import { MiniBoard, fenAfterSans } from './MiniBoard';
import type { ChesscomAccount } from '../hooks/useChesscomAccount';
import {
  ArrowLeft,
  Award,
  BarChart3,
  BookOpen,
  Bot,
  CalendarDays,
  Check,
  Crosshair,
  History,
  LayoutDashboard,
  List,
  Minus,
  Shapes,
  Star,
  ThumbsUp,
  Zap,
  type LucideIcon,
} from 'lucide-react';

/**
 * Onglet « Mes parties » : compte Chess.com lié (pseudo persisté, API
 * publique sans token), téléchargement de l'historique COMPLET (archives
 * mensuelles, concurrence bornée, annulable), liste filtrable, navigation
 * coup par coup sur échiquier local et statistiques d'ouvertures.
 *
 * La partie visionnée vit sur le GRAND échiquier (timeline principale,
 * lecture seule) ; ses contrôles sont rendus sous le plateau par App
 * (colonne sticky). Aucune écriture au répertoire par cette voie.
 */

type ResultFilter = 'all' | ChesscomOutcome;
type ColorFilter = 'all' | 'w' | 'b';

const PAGE_SIZE = 100;
/** Lignes affichées par table d'ouvertures avant « Tout afficher ». */
const OPENINGS_TOP_N = 10;

const OUTCOME_LABEL: Record<ChesscomOutcome, string> = {
  win: 'Victoire',
  draw: 'Nulle',
  loss: 'Défaite',
};

const OUTCOME_SHORT: Record<ChesscomOutcome, string> = {
  win: 'V',
  draw: 'N',
  loss: 'D',
};

const OUTCOME_COLOR: Record<ChesscomOutcome, string> = {
  win: '#10b981',
  draw: '#9ca3af',
  loss: '#f43f5e',
};

/** Couleurs des formes narratives (une teinte par récit). */
const SHAPE_COLORS: Record<GameShape, string> = {
  gachee: '#f43f5e',
  intense: '#8b5cf6',
  abrupte: '#f59e0b',
  tendue: '#38bdf8',
  tranquille: '#10b981',
  mouvementee: '#e879f9',
  equilibree: '#9ca3af',
};

/** Couleur UNIQUE d'une case d'activité : score interpolé rouge → ambre → vert. */
const ACTIVITY_MID_RGB: [number, number, number] = [245, 158, 11]; // #f59e0b (ambre)

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

/** Une couleur par cadence (ordre = volume décroissant, stable par rendu). */
const RATING_COLORS = ['#10b981', '#6366f1', '#f59e0b', '#f43f5e', '#9ca3af'];

/** Graphique à barres pour les parties par période (jour / mois / an, SVG pur). */
const PeriodGamesChart: React.FC<{ rows: PeriodStatRow[] }> = ({ rows }) => {
  if (rows.length === 0) {
    return <div className="empty-state">Aucune donnée sur la période.</div>;
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
      <svg className="rating-chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Parties par période">
        {/* Lignes de grille horizontales */}
        {[0, 0.25, 0.5, 0.75, 1].map((pct) => {
          const val = Math.round(maxGames * pct);
          const yPos = y(val);
          return (
            <g key={pct}>
              <line x1={padL} x2={W - padR} y1={yPos} y2={yPos} className="rating-grid" />
              <text x={padL - 5} y={yPos + 3.5} textAnchor="end" className="rating-axis">
                {val}
              </text>
            </g>
          );
        })}
        {/* Barres */}
        {rows.map((r, i) => (
          <g key={r.key}>
            <rect
              x={x(i)}
              y={y(r.games)}
              width={barWidth}
              height={H - padB - y(r.games)}
              fill="#6366f1"
            >
              <title>{r.label} : {r.games} parties</title>
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

/** Courbe de précision moyenne par période (SVG pur, sans dépendance). */
const AccuracyTrendChart: React.FC<{ rows: AccuracyPeriodRow[] }> = ({ rows }) => {
  const data = rows.filter((r) => r.count > 0);
  if (data.length === 0) {
    return <div className="empty-state">Aucune partie analysée sur la période.</div>;
  }
  const W = 560;
  const H = 150;
  const padL = 40;
  const padR = 10;
  const padT = 10;
  const padB = 30;
  let minA = Math.min(...data.map((r) => r.avg));
  let maxA = Math.max(...data.map((r) => r.avg));
  if (maxA <= minA) {
    minA -= 3;
    maxA += 3;
  } else {
    minA -= 2;
    maxA += 2;
  }
  minA = Math.max(0, minA);
  maxA = Math.min(100, maxA);
  let minT = 0;
  let maxT = Math.max(1, data.length - 1);
  if (maxT <= minT) {
    minT -= 0.5;
    maxT += 0.5;
  }
  const x = (i: number): number => padL + ((i - minT) / (maxT - minT)) * (W - padL - padR);
  const y = (v: number): number => padT + (1 - (v - minA) / (maxA - minA)) * (H - padT - padB);
  const pts = data.map((r, i) => `${x(i).toFixed(1)},${y(r.avg).toFixed(1)}`).join(' ');
  const labelStep = Math.max(1, Math.ceil(data.length / 6));
  const gridVs = [minA, (minA + maxA) / 2, maxA];
  return (
    <div>
      <svg className="rating-chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Précision moyenne par période">
        {gridVs.map((v) => (
          <g key={v}>
            <line x1={padL} x2={W - padR} y1={y(v)} y2={y(v)} className="rating-grid" />
            <text x={padL - 5} y={y(v) + 3.5} textAnchor="end" className="rating-axis">
              {v.toFixed(0)}
            </text>
          </g>
        ))}
        <polyline points={pts} fill="none" stroke="#10b981" strokeWidth={2} strokeLinejoin="round" />
        {data.map((r, i) => (
          <circle key={r.key} cx={x(i)} cy={y(r.avg)} r={2.4} fill="#10b981">
            <title>{`${r.label} : ${r.avg.toFixed(1)} % (${r.count} partie(s) analysée(s))`}</title>
          </circle>
        ))}
        {data.map((r, i) =>
          i % labelStep === 0 || i === data.length - 1 ? (
            <text key={r.key} x={x(i)} y={H - 7} textAnchor="middle" className="rating-axis">
              {r.shortLabel}
            </text>
          ) : null,
        )}
      </svg>
    </div>
  );
};

/** Courbe de précision par numéro de coup : totale ou Blancs/Noirs (SVG pur). */
const MoveNumberChart: React.FC<{ agg: MoveAccuracyByNumber; mode: 'total' | 'colors' }> = ({ agg, mode }) => {
  const series = useMemo(() => {
    const toPoints = (rec: Record<string, { sum: number; n: number }>): Array<{ x: number; y: number; n: number }> =>
      Object.entries(rec)
        .map(([k, v]) => ({ x: Number(k), y: v.n > 0 ? v.sum / v.n : 0, n: v.n }))
        .filter((p) => Number.isInteger(p.x) && p.x > 0)
        .sort((a, b) => a.x - b.x);
    if (mode === 'colors') {
      return [
        { label: 'Blancs', color: '#e5e0d2', points: toPoints(agg.white) },
        { label: 'Noirs', color: '#7fa6c4', points: toPoints(agg.black) },
      ].filter((s) => s.points.length > 0);
    }
    const points = toPoints(agg.total);
    return points.length > 0 ? [{ label: 'Total', color: '#10b981', points }] : [];
  }, [agg, mode]);
  const all = series.flatMap((s) => s.points);
  if (series.length === 0 || all.length === 0) {
    return <div className="empty-state">Aucune donnée par coup. Lancez « Analyser précision » pour calculer la précision par coup.</div>;
  }
  const W = 560;
  const H = 170;
  const padL = 36;
  const padR = 10;
  const padT = 10;
  const padB = 22;
  let minX = Math.min(...all.map((p) => p.x));
  let maxX = Math.max(...all.map((p) => p.x));
  if (maxX <= minX) {
    minX -= 0.5;
    maxX += 0.5;
  }
  let minY = Math.min(...all.map((p) => p.y));
  let maxY = Math.max(...all.map((p) => p.y));
  if (maxY <= minY) {
    minY -= 3;
    maxY += 3;
  } else {
    minY -= 2;
    maxY += 2;
  }
  minY = Math.max(0, minY);
  maxY = Math.min(100, maxY);
  const x = (v: number): number => padL + ((v - minX) / (maxX - minX)) * (W - padL - padR);
  const y = (v: number): number => padT + (1 - (v - minY) / (maxY - minY)) * (H - padT - padB);
  const gridYs = [minY, (minY + maxY) / 2, maxY];
  // Repères d'axe X échantillonnés (max ~8 étiquettes).
  const xTicks: number[] = [];
  {
    const span = maxX - minX;
    const step = Math.max(1, Math.ceil(span / 8));
    const first = Math.ceil(minX / step) * step;
    for (let v = first; v <= maxX; v += step) xTicks.push(v);
  }
  return (
    <div>
      <svg className="rating-chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Précision moyenne par numéro de coup">
        {gridYs.map((v) => (
          <g key={v}>
            <line x1={padL} x2={W - padR} y1={y(v)} y2={y(v)} className="rating-grid" />
            <text x={padL - 5} y={y(v) + 3.5} textAnchor="end" className="rating-axis">
              {v.toFixed(0)}
            </text>
          </g>
        ))}
        {xTicks.map((v) => (
          <text key={v} x={x(v)} y={H - 7} textAnchor="middle" className="rating-axis">
            {v}
          </text>
        ))}
        {series.map((s) => {
          const pts = s.points.map((p) => `${x(p.x).toFixed(1)},${y(p.y).toFixed(1)}`).join(' ');
          const dotStep = Math.max(1, Math.ceil(s.points.length / 120));
          return (
            <g key={s.label}>
              <polyline points={pts} fill="none" stroke={s.color} strokeWidth={2} strokeLinejoin="round" />
              {s.points.map((p, i) =>
                i % dotStep === 0 || i === s.points.length - 1 ? (
                  <circle key={i} cx={x(p.x)} cy={y(p.y)} r={2.4} fill={s.color}>
                    <title>{`Coup ${p.x} — ${s.label} : ${p.y.toFixed(1)} % (${p.n} coup(s))`}</title>
                  </circle>
                ) : null,
              )}
            </g>
          );
        })}
      </svg>
      <div className="rating-legend">
        {series.map((s) => {
          const n = s.points.reduce((acc, p) => acc + p.n, 0);
          const avg = n > 0 ? s.points.reduce((acc, p) => acc + p.y * p.n, 0) / n : 0;
          return (
            <span key={s.label} className="rating-legend-item">
              <span className="rating-dot" style={{ background: s.color }} />
              <span>{s.label}</span>
              <strong>{avg.toFixed(1)} %</strong>
            </span>
          );
        })}
      </div>
    </div>
  );
};

/** Barres empilées des résultats par tranche Elo adverse (SVG pur). */
const OpponentRatingChart: React.FC<{ rows: OpponentRatingRow[] }> = ({ rows }) => {
  if (rows.length === 0) {
    return <div className="empty-state">Aucune partie classée.</div>;
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
    { key: 'losses', color: '#f43f5e', name: 'Défaites' },
    { key: 'draws', color: '#9ca3af', name: 'Nulles' },
    { key: 'wins', color: '#10b981', name: 'Victoires' },
  ] as const;
  return (
    <div>
      <svg className="rating-chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Résultats par classement de l'adversaire">
        {[0, 0.25, 0.5, 0.75, 1].map((pct) => {
          const val = Math.round(maxGames * pct);
          const yPos = y(val);
          return (
            <g key={pct}>
              <line x1={padL} x2={W - padR} y1={yPos} y2={yPos} className="rating-grid" />
              <text x={padL - 5} y={yPos + 3.5} textAnchor="end" className="rating-axis">
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
                <text x={x(i) + barWidth / 2} y={H - 8} textAnchor="middle" className="rating-axis">
                  {r.bucket}
                </text>
              )}
            </g>
          );
        })}
      </svg>
      <div className="rating-legend">
        <span className="rating-legend-item">
          <span className="rating-dot" style={{ background: '#10b981' }} />
          <span>Victoires</span>
        </span>
        <span className="rating-legend-item">
          <span className="rating-dot" style={{ background: '#9ca3af' }} />
          <span>Nulles</span>
        </span>
        <span className="rating-legend-item">
          <span className="rating-dot" style={{ background: '#f43f5e' }} />
          <span>Défaites</span>
        </span>
      </div>
      <div className="activity-subtitle text-muted">En bas : défaites · au milieu : nulles · en haut : victoires</div>
    </div>
  );
};

/** Libellés courts d'axe pour les formes (7 barres alignées). */
const SHAPE_SHORT_LABELS: Record<GameShape, string> = {
  gachee: 'Gâchée',
  intense: 'Intense',
  abrupte: 'Abrupte',
  tendue: 'Tendue',
  tranquille: 'Tranqu.',
  mouvementee: 'Mouvm.',
  equilibree: 'Équil.',
};

export interface ShapeResultRow {
  shape: GameShape;
  games: number;
  wins: number;
  draws: number;
  losses: number;
}

export interface ShapeAccuracyRow {
  shape: GameShape;
  /** Précision moyenne du compte lié (null si aucune partie notée). */
  avg: number | null;
  /** Parties notées dans cette forme. */
  count: number;
}

/** Barres verticales de précision moyenne par forme, axe fixe 0–100 (SVG pur). */
const ShapeAccuracyChart: React.FC<{ rows: ShapeAccuracyRow[] }> = ({ rows }) => {
  const rated = rows.filter((r) => r.avg !== null && r.count > 0);
  if (rated.length === 0) {
    return <div className="empty-state">Aucune partie notée par forme.</div>;
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
      <svg className="rating-chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Précision moyenne par forme de la partie, de 0 à 100">
        {[0, 25, 50, 75, 100].map((v) => (
          <g key={v}>
            <line x1={padL} x2={W - padR} y1={y(v)} y2={y(v)} className="rating-grid" />
            <text x={padL - 5} y={y(v) + 3.5} textAnchor="end" className="rating-axis">
              {v}
            </text>
          </g>
        ))}
        {rows.map((r, i) =>
          r.avg !== null && r.count > 0 ? (
            <g key={r.shape}>
              <rect
                x={x(i)}
                y={y(r.avg)}
                width={barWidth}
                height={Math.max(0, base - y(r.avg))}
                fill="#10b981"
              >
                <title>{`${GAME_SHAPE_LABELS[r.shape]} : ${r.avg.toFixed(1)} % (${r.count} partie(s) notée(s))`}</title>
              </rect>
              <text x={x(i) + barWidth / 2} y={y(r.avg) - 4} textAnchor="middle" className="rating-axis">
                {r.avg.toFixed(0)}
              </text>
              <text x={x(i) + barWidth / 2} y={H - 8} textAnchor="middle" className="rating-axis">
                {SHAPE_SHORT_LABELS[r.shape]}
              </text>
            </g>
          ) : (
            <g key={r.shape}>
              <text x={x(i) + barWidth / 2} y={H - 8} textAnchor="middle" className="rating-axis">
                {SHAPE_SHORT_LABELS[r.shape]}
              </text>
            </g>
          ),
        )}
      </svg>
    </div>
  );
};

/** Barres verticales alignées des résultats V/N/D par forme (SVG pur). */
const ShapeResultsChart: React.FC<{ rows: ShapeResultRow[] }> = ({ rows }) => {
  const maxGames = Math.max(0, ...rows.map((r) => r.games));
  if (rows.length === 0 || maxGames <= 0) {
    return <div className="empty-state">Aucune partie classée.</div>;
  }
  const W = 560;
  const H = 170;
  const padL = 36;
  const padR = 10;
  const padT = 10;
  const padB = 30;
  const barWidth = (W - padL - padR) / rows.length;
  const x = (i: number): number => padL + i * barWidth;
  const y = (games: number): number => padT + (1 - games / maxGames) * (H - padT - padB);
  const SEGMENTS = [
    { key: 'losses', color: OUTCOME_COLOR.loss, name: 'Défaites' },
    { key: 'draws', color: OUTCOME_COLOR.draw, name: 'Nulles' },
    { key: 'wins', color: OUTCOME_COLOR.win, name: 'Victoires' },
  ] as const;
  return (
    <div>
      <svg className="rating-chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Résultats par forme de la partie">
        {[0, 0.25, 0.5, 0.75, 1].map((pct) => {
          const val = Math.round(maxGames * pct);
          const yPos = y(val);
          return (
            <g key={pct}>
              <line x1={padL} x2={W - padR} y1={yPos} y2={yPos} className="rating-grid" />
              <text x={padL - 5} y={yPos + 3.5} textAnchor="end" className="rating-axis">
                {val}
              </text>
            </g>
          );
        })}
        {rows.map((r, i) => {
          let stacked = 0;
          return (
            <g key={r.shape}>
              <title>{`${GAME_SHAPE_LABELS[r.shape]} : ${r.games} parties (${r.wins}V / ${r.draws}N / ${r.losses}D)`}</title>
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
                    <title>{`${GAME_SHAPE_LABELS[r.shape]} — ${s.name} : ${count}`}</title>
                  </rect>
                );
              })}
              <text x={x(i) + barWidth / 2} y={H - 8} textAnchor="middle" className="rating-axis">
                {SHAPE_SHORT_LABELS[r.shape]}
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

/** Libellés courts d'axe pour les phases. */
const PHASE_SHORT_LABELS: Record<string, string> = {
  opening: 'Ouv.',
  middlegame: 'Mil.',
  endgame: 'Fin.',
};

/** Couleurs Blancs/Noirs (mêmes teintes que la précision par coup). */
const PIECE_WHITE = '#e5e0d2';
const PIECE_BLACK = '#7fa6c4';

/** Couleurs des phases (teinte = phase, clarté = couleur jouée). */
const PHASE_BAR_COLORS: Record<string, { total: string; white: string; black: string }> = {
  opening: { total: '#38bdf8', white: '#bae6fd', black: '#0284c7' },
  middlegame: { total: '#8b5cf6', white: '#c4b5fd', black: '#7c3aed' },
  endgame: { total: '#f59e0b', white: '#fcd34d', black: '#b45309' },
};

/** Une seule barre horizontale des fins en phase Ouverture/Milieu/Finale. */
const PhaseCountChart: React.FC<{ rows: PhaseStatRow[]; mode: 'total' | 'colors' }> = ({ rows, mode }) => {
  const total = rows.reduce((sum, r) => sum + r.total.games, 0);
  if (rows.length === 0 || total <= 0) {
    return <div className="empty-state">Aucune partie rejouable.</div>;
  }
  const share = (n: number): string => {
    const p = (n / total) * 100;
    return n > 0 && p < 0.5 ? '<1' : p.toFixed(0);
  };
  const segments = rows.flatMap((r) => {
    const c = PHASE_BAR_COLORS[r.phase] ?? PHASE_BAR_COLORS.opening;
    return mode === 'colors'
      ? [
        { key: `${r.phase}-w`, label: `${PHASE_LABELS[r.phase]} (Blancs)`, color: c.white, n: r.white.games },
        { key: `${r.phase}-b`, label: `${PHASE_LABELS[r.phase]} (Noirs)`, color: c.black, n: r.black.games },
      ]
      : [{ key: r.phase, label: PHASE_LABELS[r.phase], color: c.total, n: r.total.games }];
  });
  return (
    <div>
      <div
        className="chesscom-wdl-bar"
        role="img"
        aria-label={`Parties terminées par phase : ${segments.map((s) => `${s.label} ${s.n}`).join(', ')}`}
      >
        {segments.map((s) =>
          s.n > 0 ? (
            <div
              key={s.key}
              className="chesscom-wdl-segment"
              style={{ width: `${(s.n / total) * 100}%`, background: s.color }}
              title={`${s.label} : ${s.n} (${share(s.n)} %)`}
            />
          ) : null,
        )}
      </div>
      <div className="rating-legend">
        {segments.filter((s) => s.n > 0).map((s) => (
          <span key={s.key} className="rating-legend-item" title={s.label}>
            <span className="rating-dot" style={{ background: s.color }} />
            <span>{s.label}</span>
            <strong>{s.n.toLocaleString('fr-FR')}</strong>
            <span className="text-muted">{share(s.n)} %</span>
          </span>
        ))}
      </div>
    </div>
  );
};

/** Barres verticales de précision moyenne par phase, axe fixe 0–100 (SVG pur). */
const PhaseAccuracyChart: React.FC<{ rows: PhaseStatRow[]; mode: 'total' | 'colors' }> = ({ rows, mode }) => {
  const avg = (accSum: number, accN: number): number | null => (accN > 0 ? accSum / accN : null);
  const bars = rows.flatMap((r) =>
    mode === 'colors'
      ? [
        { key: `${r.phase}-w`, label: `${PHASE_LABELS[r.phase]} (Blancs)`, short: `${PHASE_SHORT_LABELS[r.phase]} Bl.`, color: PIECE_WHITE, avg: avg(r.white.accSum, r.white.accN), n: r.white.accN },
        { key: `${r.phase}-b`, label: `${PHASE_LABELS[r.phase]} (Noirs)`, short: `${PHASE_SHORT_LABELS[r.phase]} No.`, color: PIECE_BLACK, avg: avg(r.black.accSum, r.black.accN), n: r.black.accN },
      ]
      : [{ key: r.phase, label: PHASE_LABELS[r.phase], short: PHASE_SHORT_LABELS[r.phase], color: '#10b981', avg: avg(r.total.accSum, r.total.accN), n: r.total.accN }],
  );
  const W = 560;
  const H = 150;
  const padL = 40;
  const padR = 10;
  const padT = 10;
  const padB = 30;
  const barWidth = (W - padL - padR) / bars.length;
  const x = (i: number): number => padL + i * barWidth;
  const y = (v: number): number => padT + (1 - v / 100) * (H - padT - padB);
  const base = H - padB;
  return (
    <div>
      <svg className="rating-chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Précision moyenne par phase, de 0 à 100">
        {[0, 25, 50, 75, 100].map((v) => (
          <g key={v}>
            <line x1={padL} x2={W - padR} y1={y(v)} y2={y(v)} className="rating-grid" />
            <text x={padL - 5} y={y(v) + 3.5} textAnchor="end" className="rating-axis">
              {v}
            </text>
          </g>
        ))}
        {bars.map((b, i) => (
          <g key={b.key}>
            {b.avg !== null && (
              <>
                <rect x={x(i)} y={y(b.avg)} width={barWidth} height={Math.max(0, base - y(b.avg))} fill={b.color}>
                  <title>{`${b.label} : ${b.avg.toFixed(1)} % (${b.n} partie(s) notée(s))`}</title>
                </rect>
                <text x={x(i) + barWidth / 2} y={y(b.avg) - 4} textAnchor="middle" className="rating-axis">
                  {b.avg.toFixed(0)}
                </text>
              </>
            )}
            <text x={x(i) + barWidth / 2} y={H - 8} textAnchor="middle" className="rating-axis">
              {b.short}
            </text>
          </g>
        ))}
      </svg>
      {mode === 'colors' && (
        <div className="rating-legend">
          <span className="rating-legend-item">
            <span className="rating-dot" style={{ background: PIECE_WHITE }} />
            <span>Blancs</span>
          </span>
          <span className="rating-legend-item">
            <span className="rating-dot" style={{ background: PIECE_BLACK }} />
            <span>Noirs</span>
          </span>
        </div>
      )}
    </div>
  );
};

/** Barres verticales empilées V/N/D par phase (SVG pur). */
const PhaseResultsChart: React.FC<{ rows: PhaseStatRow[]; mode: 'total' | 'colors' }> = ({ rows, mode }) => {
  interface StackedBar { key: string; label: string; short: string; wins: number; draws: number; losses: number }
  const bars: StackedBar[] = rows.flatMap((r) =>
    mode === 'colors'
      ? [
        { key: `${r.phase}-w`, label: `${PHASE_LABELS[r.phase]} (Blancs)`, short: `${PHASE_SHORT_LABELS[r.phase]} Bl.`, wins: r.white.wins, draws: r.white.draws, losses: r.white.losses },
        { key: `${r.phase}-b`, label: `${PHASE_LABELS[r.phase]} (Noirs)`, short: `${PHASE_SHORT_LABELS[r.phase]} No.`, wins: r.black.wins, draws: r.black.draws, losses: r.black.losses },
      ]
      : [{ key: r.phase, label: PHASE_LABELS[r.phase], short: PHASE_SHORT_LABELS[r.phase], wins: r.total.wins, draws: r.total.draws, losses: r.total.losses }],
  );
  const maxGames = Math.max(1, ...bars.map((b) => b.wins + b.draws + b.losses));
  const W = 560;
  const H = 170;
  const padL = 36;
  const padR = 10;
  const padT = 10;
  const padB = 30;
  const barWidth = (W - padL - padR) / bars.length;
  const x = (i: number): number => padL + i * barWidth;
  const y = (games: number): number => padT + (1 - games / maxGames) * (H - padT - padB);
  const SEGMENTS = [
    { key: 'losses', color: OUTCOME_COLOR.loss, name: 'Défaites' },
    { key: 'draws', color: OUTCOME_COLOR.draw, name: 'Nulles' },
    { key: 'wins', color: OUTCOME_COLOR.win, name: 'Victoires' },
  ] as const;
  return (
    <div>
      <svg className="rating-chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Résultats par phase de fin de partie">
        {[0, 0.25, 0.5, 0.75, 1].map((pct) => {
          const val = Math.round(maxGames * pct);
          const yPos = y(val);
          return (
            <g key={pct}>
              <line x1={padL} x2={W - padR} y1={yPos} y2={yPos} className="rating-grid" />
              <text x={padL - 5} y={yPos + 3.5} textAnchor="end" className="rating-axis">
                {val}
              </text>
            </g>
          );
        })}
        {bars.map((b, i) => {
          const total = b.wins + b.draws + b.losses;
          let stacked = 0;
          return (
            <g key={b.key}>
              <title>{`${b.label} : ${total} parties (${b.wins}V / ${b.draws}N / ${b.losses}D)`}</title>
              {SEGMENTS.map((s) => {
                const count = b[s.key];
                const yTop = y(stacked + count);
                const yBottom = y(stacked);
                stacked += count;
                if (count <= 0) return null;
                return (
                  <rect key={s.key} x={x(i)} y={yTop} width={barWidth} height={Math.max(0, yBottom - yTop)} fill={s.color}>
                    <title>{`${b.label} — ${s.name} : ${count}`}</title>
                  </rect>
                );
              })}
              <text x={x(i) + barWidth / 2} y={H - 8} textAnchor="middle" className="rating-axis">
                {b.short}
              </text>
            </g>
          );
        })}
      </svg>
      <div className="rating-legend">
        {mode === 'colors' && (
          <>
            <span className="rating-legend-item">
              <span className="rating-dot" style={{ background: PIECE_WHITE }} />
              <span>Blancs</span>
            </span>
            <span className="rating-legend-item">
              <span className="rating-dot" style={{ background: PIECE_BLACK }} />
              <span>Noirs</span>
            </span>
          </>
        )}
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
              fill="#10b981"
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

/** Icônes des pièces (glyphes clairs, fond sombre). */
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
              title={`${r.label} : ${r.found} trouvée(s) / ${r.missed} manquée(s)`}
            >
              <span className="forks-piece-icon" aria-hidden="true">
                {r.glyph}
              </span>
              <span className="forks-hbar-label">{r.label}</span>
              <div
                className="chesscom-wdl-bar forks-hbar-track"
                role="img"
                aria-label={`${r.label} : ${r.found} trouvées, ${r.missed} manquées`}
              >
                {total > 0 && (
                  <>
                    {r.found > 0 && (
                      <div className="chesscom-wdl-segment" style={{ width: `${(r.found / total) * 100}%`, background: '#10b981' }} />
                    )}
                    {r.missed > 0 && (
                      <div className="chesscom-wdl-segment" style={{ width: `${(r.missed / total) * 100}%`, background: '#f43f5e' }} />
                    )}
                  </>
                )}
              </div>
              <strong className="forks-hbar-value">
                {r.found} <span className="text-muted">/ {r.missed}</span>
              </strong>
            </div>
          );
        })}
      </div>
      <div className="rating-legend">
        <span className="rating-legend-item">
          <span className="rating-dot" style={{ background: '#10b981' }} />
          <span>Trouvées</span>
        </span>
        <span className="rating-legend-item">
          <span className="rating-dot" style={{ background: '#f43f5e' }} />
          <span>Manquées</span>
        </span>
      </div>
      <div className="activity-subtitle text-muted">À gauche : trouvées · à droite : manquées</div>
    </div>
  );
};

/**
 * Symbole façon Chess.com par catégorie de qualité : !! (Brillant),
 * médaille (Génial), ★ (Meilleur), pouce (Très bien), ✓ (Bon),
 * livre (Théorique), ?! (Imprécision), ? (Erreur), ?? (Gaffe),
 * − (Gain manqué).
 */
const QualitySymbol: React.FC<{ quality: MoveQuality; size?: number }> = ({ quality, size = 15 }) => {
  const color = MOVE_QUALITY_COLORS[quality];
  const label = MOVE_QUALITY_LABELS[quality];
  if (quality === 'genial') {
    return (
      <span className="quality-symbol" title={`${label} (!)`}>
        <Award size={size} style={{ color }} aria-hidden="true" />
      </span>
    );
  }
  if (quality === 'meilleur') {
    return (
      <span className="quality-symbol" title={`${label} (étoile)`}>
        <Star size={size} style={{ color }} aria-hidden="true" />
      </span>
    );
  }
  if (quality === 'tres-bien') {
    return (
      <span className="quality-symbol" title={`${label} (pouce levé)`}>
        <ThumbsUp size={size} style={{ color }} aria-hidden="true" />
      </span>
    );
  }
  if (quality === 'bon') {
    return (
      <span className="quality-symbol" title={`${label} (coche)`}>
        <Check size={size} style={{ color }} aria-hidden="true" />
      </span>
    );
  }
  if (quality === 'theorique') {
    return (
      <span className="quality-symbol" title={`${label} (livre)`}>
        <BookOpen size={size} style={{ color }} aria-hidden="true" />
      </span>
    );
  }
  if (quality === 'gain-manque') {
    return (
      <span className="quality-symbol" title={`${label} (−)`}>
        <Minus size={size} style={{ color }} aria-hidden="true" />
      </span>
    );
  }
  const text: Record<string, string> = { brillant: '!!', imprecision: '?!', erreur: '?', gaffe: '??' };
  return (
    <span className="quality-symbol" style={{ color }} title={`${label} (${text[quality] ?? ''})`}>
      {text[quality] ?? ''}
    </span>
  );
};

/** UN seul graphe à 100 % : parts des qualités par période (SVG pur). */
const QualityTimeChart: React.FC<{
  rows: Array<{ key: string; label: string; shortLabel: string; total: Record<MoveQuality, number>; white: Record<MoveQuality, number>; black: Record<MoveQuality, number> }>;
  mode: 'total' | 'colors';
}> = ({ rows, mode }) => {
  if (rows.length === 0) {
    return <div className="empty-state">Aucune donnée sur la période.</div>;
  }
  // En couleurs : deux barres par période (Blancs / Noirs).
  const bars = rows.flatMap((r) =>
    mode === 'colors'
      ? [
        { key: `${r.key}-w`, short: `${r.shortLabel} Bl.`, counts: r.white },
        { key: `${r.key}-b`, short: `${r.shortLabel} No.`, counts: r.black },
      ]
      : [{ key: r.key, short: r.shortLabel, counts: r.total }],
  );
  const W = 560;
  const H = 170;
  const padL = 36;
  const padR = 10;
  const padT = 10;
  const padB = 30;
  const barWidth = (W - padL - padR) / bars.length;
  const x = (i: number): number => padL + i * barWidth;
  const y = (pct: number): number => padT + (1 - pct / 100) * (H - padT - padB);
  const labelStep = Math.max(1, Math.ceil(bars.length / 8));
  return (
    <div>
      <svg className="rating-chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Qualité des coups au fil du temps, en pourcent">
        {[0, 25, 50, 75, 100].map((v) => (
          <g key={v}>
            <line x1={padL} x2={W - padR} y1={y(v)} y2={y(v)} className="rating-grid" />
            <text x={padL - 5} y={y(v) + 3.5} textAnchor="end" className="rating-axis">
              {v}
            </text>
          </g>
        ))}
        {bars.map((b, i) => {
          const total = MOVE_QUALITY_ORDER.reduce((sum, c) => sum + (b.counts[c] ?? 0), 0);
          let stacked = 0;
          return (
            <g key={b.key}>
              <title>
                {total > 0
                  ? MOVE_QUALITY_ORDER.filter((c) => (b.counts[c] ?? 0) > 0)
                    .map((c) => `${MOVE_QUALITY_LABELS[c]} : ${(((b.counts[c] ?? 0) / total) * 100).toFixed(0)} %`)
                    .join(' · ')
                  : 'Aucun coup'}
              </title>
              {MOVE_QUALITY_ORDER.map((c) => {
                const n = b.counts[c] ?? 0;
                if (total <= 0 || n <= 0) return null;
                const h = (n / total) * (H - padT - padB);
                const yTop = y(stacked + (n / total) * 100);
                stacked += (n / total) * 100;
                return (
                  <rect key={c} x={x(i)} y={yTop} width={barWidth} height={Math.max(0, h)} fill={MOVE_QUALITY_COLORS[c]}>
                    <title>{`${MOVE_QUALITY_LABELS[c]} : ${n} (${((n / total) * 100).toFixed(0)} %)`}</title>
                  </rect>
                );
              })}
              {(i % labelStep === 0 || i === bars.length - 1) && (
                <text x={x(i) + barWidth / 2} y={H - 8} textAnchor="middle" className="rating-axis">
                  {b.short}
                </text>
              )}
            </g>
          );
        })}
      </svg>
    </div>
  );
};

/** Camembert (donut SVG pur) des coups joués par pièce. */
const PieceDonut: React.FC<{
  counts: Record<PieceKind, number>;
  label: string;
}> = ({ counts, label }) => {
  const total = PIECE_ORDER.reduce((s, p) => s + (counts[p] ?? 0), 0);
  if (total <= 0) return <div className="empty-state">Aucun coup.</div>;
  const size = 150;
  const c = size / 2;
  const r = 52;
  const C = 2 * Math.PI * r;
  const segs = PIECE_ORDER.reduce<Array<{ p: PieceKind; n: number; frac: number; start: number }>>((out, p) => {
    const n = counts[p] ?? 0;
    if (n <= 0) return out;
    const prev = out.length > 0 ? out[out.length - 1] : null;
    const start = prev ? prev.start + prev.frac : 0;
    return [...out, { p, n, frac: n / total, start }];
  }, []);
  return (
    <div className="piece-donut">
      <svg viewBox={`0 0 ${size} ${size}`} width={size} height={size} role="img" aria-label={`${label} : ${segs.map((s) => `${PIECE_LABELS[s.p]} ${s.n}`).join(', ')}`}>
        {segs.map((s) => (
          <circle
            key={s.p}
            cx={c}
            cy={c}
            r={r}
            fill="none"
            stroke={PIECE_COLORS[s.p]}
            strokeWidth={24}
            strokeDasharray={`${Math.max(0, s.frac * C - 1.5).toFixed(2)} ${C.toFixed(2)}`}
            strokeDashoffset={(-s.start * C).toFixed(2)}
            transform={`rotate(-90 ${c} ${c})`}
          >
            <title>{`${PIECE_LABELS[s.p]} : ${s.n.toLocaleString('fr-FR')} (${(s.frac * 100).toFixed(1)} %)`}</title>
          </circle>
        ))}
        <text x={c} y={c - 1} textAnchor="middle" className="piece-donut-total">
          {total.toLocaleString('fr-FR')}
        </text>
        <text x={c} y={c + 15} textAnchor="middle" className="piece-donut-caption">
          {label}
        </text>
      </svg>
    </div>
  );
};

/** Colonnes verticales de précision moyenne par pièce (SVG pur, axe 0–100). */
const PieceAccuracyBars: React.FC<{
  stats: PieceStats;
  mode: 'total' | 'phases';
}> = ({ stats, mode }) => {
  const groups = PIECE_ORDER.map((piece) => {
    if (mode === 'total') {
      const n = PIECE_PHASE_ORDER.reduce((s, ph) => s + (stats[ph].counts[piece] ?? 0), 0);
      const sum = PIECE_PHASE_ORDER.reduce((s, ph) => s + (stats[ph].accSum[piece] ?? 0), 0);
      return { piece, vals: [{ n, avg: n > 0 ? sum / n : null as number | null }] };
    }
    return {
      piece,
      vals: PIECE_PHASE_ORDER.map((ph) => {
        const n = stats[ph].counts[piece] ?? 0;
        return { n, avg: n > 0 ? (stats[ph].accSum[piece] ?? 0) / n : null as number | null };
      }),
    };
  });
  if (groups.every((g) => g.vals.every((v) => v.avg === null))) {
    return <div className="empty-state">Aucune précision par pièce.</div>;
  }
  const W = 560;
  const H = 190;
  const padL = 36;
  const padR = 10;
  const padT = 14;
  const padB = 30;
  const y = (v: number): number => padT + (1 - v / 100) * (H - padT - padB);
  const groupW = (W - padL - padR) / groups.length;
  // Même teinte que la pièce, intensité = phase (ouverture → finale).
  const phaseOpacity = [1, 0.55, 0.3];
  return (
    <div>
      <svg className="rating-chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Précision moyenne par pièce, de 0 à 100">
        {[0, 25, 50, 75, 100].map((v) => (
          <g key={v}>
            <line x1={padL} x2={W - padR} y1={y(v)} y2={y(v)} className="rating-grid" />
            <text x={padL - 5} y={y(v) + 3.5} textAnchor="end" className="rating-axis">
              {v}
            </text>
          </g>
        ))}
        {groups.map((g, gi) => {
          const gx = padL + gi * groupW;
          const bw = mode === 'total'
            ? Math.min(46, groupW * 0.55)
            : Math.min(22, groupW * 0.27);
          const span = bw * g.vals.length;
          return (
            <g key={g.piece}>
              {g.vals.map((v, vi) => {
                if (v.avg === null) return null;
                const bx = gx + (groupW - span) / 2 + vi * bw;
                const h = (v.avg / 100) * (H - padT - padB);
                const phaseLabel = mode === 'total' ? '' : ` — ${PHASE_LABELS[PIECE_PHASE_ORDER[vi] ?? 'opening']}`;
                return (
                  <g key={vi}>
                    <rect
                      x={bx}
                      y={y(v.avg)}
                      width={bw}
                      height={Math.max(0, h)}
                      fill={PIECE_COLORS[g.piece]}
                      fillOpacity={mode === 'total' ? 1 : phaseOpacity[vi] ?? 1}
                    >
                      <title>{`${PIECE_LABELS[g.piece]}${phaseLabel} : ${v.avg.toFixed(1)} % (${v.n.toLocaleString('fr-FR')} coup(s))`}</title>
                    </rect>
                    {mode === 'total' && (
                      <text x={bx + bw / 2} y={y(v.avg) - 4} textAnchor="middle" className="rating-axis">
                        {v.avg.toFixed(0)}
                      </text>
                    )}
                  </g>
                );
              })}
              <text x={gx + groupW / 2} y={H - 8} textAnchor="middle" className="piece-glyph-tick">
                <title>{PIECE_LABELS[g.piece]}</title>
                {PIECE_GLYPHS[g.piece]}
              </text>
            </g>
          );
        })}
      </svg>
      {mode === 'phases' && (
        <div className="rating-legend">
          {PIECE_PHASE_ORDER.map((ph, i) => (
            <span key={ph} className="rating-legend-item">
              <span className="rating-dot" style={{ background: '#e5e0d2', opacity: phaseOpacity[i] }} />
              <span>{PHASE_LABELS[ph]}</span>
            </span>
          ))}
          <span className="rating-legend-item text-muted">Teinte = pièce · intensité = phase</span>
        </div>
      )}
    </div>
  );
};

/** Courbe Elo par cadence (SVG pur, sans dépendance). */
const RatingChart: React.FC<{ games: ChesscomGame[]; username: string }> = ({ games, username }) => {
  const series = useMemo(() => buildRatingSeries(games, username), [games, username]);
  if (series.length === 0) {
    return <div className="empty-state">Aucune partie classée sur la période.</div>;
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
      <svg className="rating-chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Historique Elo par cadence">
        {gridRs.map((r) => (
          <g key={r}>
            <line x1={padL} x2={W - padR} y1={y(r)} y2={y(r)} className="rating-grid" />
            <text x={padL - 5} y={y(r) + 3.5} textAnchor="end" className="rating-axis">
              {Math.round(r)}
            </text>
          </g>
        ))}
        {monthTicks.map((t) => (
          <text key={t.label + t.x} x={t.x} y={H - 7} textAnchor="middle" className="rating-axis">
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
      <div className="rating-legend">
        {series.map((s, si) => (
          <span key={s.timeClass} className="rating-legend-item">
            <span className="rating-dot" style={{ background: RATING_COLORS[si % RATING_COLORS.length] }} />
            <span>{CLASS_LABELS[s.timeClass] ?? s.timeClass}</span>
            <strong>{s.points[s.points.length - 1].rating}</strong>
          </span>
        ))}
      </div>
    </div>
  );
};

/** Heatmap « Activity Last 3 months » (91 jours, semaines lundi-dimanche).
 *  UNE couleur par case : score V/N/D (V=1, N=0.5, D=0) interpolé
 *  rouge → ambre → vert (10V/10D = ambre, 50 %). */
const ActivityCalendar: React.FC<{ games: ChesscomGame[]; username: string }> = ({ games, username }) => {
  const weeks = useMemo(() => buildActivityWeeks(games, 91, Date.now(), username), [games, username]);
  const activeDays = useMemo(
    () => weeks.flat().filter((d) => !d.future && d.games > 0).length,
    [weeks],
  );
  return (
    <div className="activity-cal-wrap" title={`${games.length} parties sur les 3 derniers mois`}>
      <div className="activity-cal" role="img" aria-label={`${games.length} parties sur les 3 derniers mois`}>
        {weeks.map((week, wi) => (
          <div key={wi} className="activity-week">
            {week.map((d) => (
              <span
                key={d.date}
                className={`activity-cell${d.future ? ' is-future' : ''}`}
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
      <div className="activity-cal-caption text-muted">
        {games.length.toLocaleString('fr-FR')} parties · {activeDays} jours actifs
      </div>
      <div className="activity-legend text-muted" aria-hidden="true">
        <span className="activity-legend-item">
          <i style={{ background: OUTCOME_COLOR.win }} />V
        </span>
        <span className="activity-legend-item">
          <i style={{ background: OUTCOME_COLOR.draw }} />N
        </span>
        <span className="activity-legend-item">
          <i style={{ background: OUTCOME_COLOR.loss }} />D
        </span>
      </div>
    </div>
  );
};

const CLASS_LABELS: Record<string, string> = {
  bullet: 'Bullet',
  blitz: 'Blitz',
  rapid: 'Rapide',
  daily: 'Corresp.',
};

/** Libellé de granularité du regroupement temporel. */
const PERIOD_GRANULARITY_LABEL: Record<string, string> = {
  day: 'par jour',
  month: 'par mois',
  year: 'par an',
};

function formatCadence(g: ChesscomGame): string {
  const cls = CLASS_LABELS[g.time_class] ?? g.time_class ?? '?';
  const tc = g.time_control ?? '';
  if (!tc) return cls;
  if (tc.includes('/')) return `${cls} ${tc.split('/')[0]} c/j`;
  const [base, inc] = tc.split('+');
  const secs = Number(base);
  if (!Number.isFinite(secs) || secs <= 0) return `${cls} ${tc}`;
  const mins = secs >= 60 ? Math.round(secs / 60) : secs;
  const unit = secs >= 60 ? '' : 's';
  return `${cls} ${mins}${unit}${inc ? `+${inc}` : ''}`;
}

function formatDate(endTimeSec: number): string {
  if (!endTimeSec) return '—';
  try {
    return new Date(endTimeSec * 1000).toLocaleDateString('fr-FR', {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
    });
  } catch {
    return '—';
  }
}

export interface GameViewerState {
  url: string;
  sans: string[];
  ply: number;
}

/** Onglets de la vue « Mes parties » (barre en haut, contenu en grille). */
export type ChesscomStatsTab = 'parties' | 'overview' | 'precision' | 'shapes' | 'tactics' | 'theory';

const STATS_TABS: Array<{ key: ChesscomStatsTab; label: string; Icon: LucideIcon }> = [
  { key: 'parties', label: 'Parties', Icon: List },
  { key: 'overview', label: "Vue d'ensemble", Icon: LayoutDashboard },
  { key: 'precision', label: 'Précision', Icon: Crosshair },
  { key: 'shapes', label: 'Formes', Icon: Shapes },
  { key: 'tactics', label: 'Tactique', Icon: Zap },
  { key: 'theory', label: 'Théorie', Icon: BookOpen },
];

interface ChesscomPanelProps {
  /** Compte partagé (sidebar) : jeux, profil, synchro. */
  account: ChesscomAccount;
  /** Partie visionnée (état remonté : contrôles rendus sous le plateau). */
  viewer: GameViewerState | null;
  /** Ouvre la partie : grand échiquier + état viewer. */
  onOpenGame: (game: ChesscomGame) => void;
  /** Navigue au ply donné (grand échiquier + état viewer). */
  onGoToPly: (index: number) => void;
  /** Ferme la visionneuse (l'échiquier garde la position). */
  onCloseViewer: () => void;
  /** Met à jour la précision d'une partie (badge simple, compat). */
  onUpdateGameAccuracy?: (url: string, accuracy: number) => void;
  /** Stocke le résultat d'analyse complet (précisions + forme + tactique + qualité + rapport). */
  onUpdateGameAnalysis?: (url: string, patch: {
    accuracy: number | null;
    whiteAccuracy: number | null;
    blackAccuracy: number | null;
    shape?: GameShape | null;
    forks?: ForkCounts | null;
    pins?: PinCounts | null;
    mates?: MateCounts | null;
    hangs?: HungCounts | null;
    freebies?: FreebieCounts | null;
    moveQuality?: MoveQualityCounts | null;
    pieces?: PieceStats | null;
    gameReport?: GameReport | null;
  }) => void;
  /** Répertoires (théorie du panneau Maîtrise : livre fusionné). */
  repertoires: RepertoireItem[];
}

export const ChesscomPanel: React.FC<ChesscomPanelProps> = ({
  account,
  viewer,
  onOpenGame,
  onGoToPly,
  onCloseViewer,
  onUpdateGameAccuracy,
  onUpdateGameAnalysis,
  repertoires,
}) => {
  const { games, linkedUser } = account;
  const [openingsExpanded, setOpeningsExpanded] = useState(false);
  const [resultFilter, setResultFilter] = useState<ResultFilter>('all');
  const [colorFilter, setColorFilter] = useState<ColorFilter>('all');
  const [classFilter, setClassFilter] = useState<string>('all');
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const [analyzing, setAnalyzing] = useState(false);
  const [analyzeProgress, setAnalyzeProgress] = useState({ current: 0, total: 0 });
  /** Message de statut d'analyse (succès/erreur, remplace les alert()). */
  const [analyzeStatus, setAnalyzeStatus] = useState<string | null>(null);
  const batchAbort = React.useRef<AbortController | null>(null);

  // Analyse détaillée de la partie visionnée (rapport en-croissant complet).
  const [reportAnalyzing, setReportAnalyzing] = useState(false);
  const [reportProgress, setReportProgress] = useState({ done: 0, total: 0 });
  const [reportError, setReportError] = useState<string | null>(null);
  const reportAbort = React.useRef<AbortController | null>(null);

  // Onglet actif (barre en haut) : liste des parties ou groupe de stats.
  const [statsTab, setStatsTab] = useState<ChesscomStatsTab>('parties');

  // Précision par numéro de coup : agrégat persisté par compte, alimenté
  // par le batch et l'analyse détaillée. Filtre Total / par couleur.
  const [moveAccMode, setMoveAccMode] = useState<'total' | 'colors'>('total');

  // Nouveau lot de parties (synchro / dissociation) : on repart du début.
  // Ajusté pendant le rendu via l'état précédent (pattern React, sans effet).
  const [prevGames, setPrevGames] = useState(games);
  if (prevGames !== games) {
    setPrevGames(games);
    setVisibleCount(PAGE_SIZE);
  }

  const me = linkedUser;

  // Agrégat « précision par coup » : restauré du store, rechargé au
  // changement de compte. Miroir ref pour les callbacks d'analyse.
  const [moveAcc, setMoveAcc] = useState<MoveAccuracyByNumber>(() => chesscomMoveAccuracyStore.get(linkedUser));
  const moveAccRef = React.useRef(moveAcc);
  useEffect(() => {
    const restored = chesscomMoveAccuracyStore.get(linkedUser);
    moveAccRef.current = restored;
    setMoveAcc(restored);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [linkedUser]);

  // Robots exclus par défaut (parties d'entraînement : faussent les stats
  // d'ouvertures). Un seul point de filtrage : liste, résumé et tables.
  const [showBots, setShowBots] = useState(false);
  const botGamesCount = useMemo(
    () => games.filter((g) => isBotGame(g, me)).length,
    [games, me],
  );
  const listedGames = useMemo(
    () => (showBots ? games : games.filter((g) => !isBotGame(g, me))),
    [games, me, showBots],
  );

  const classOptions = useMemo(() => {
    const set = new Set<string>();
    for (const g of listedGames) if (g.time_class) set.add(g.time_class);
    return [...set].sort();
  }, [listedGames]);

  const filteredGames = useMemo(() => {
    return listedGames.filter((g) => {
      if (resultFilter !== 'all' && outcomeFor(g, me) !== resultFilter) return false;
      if (colorFilter !== 'all' && colorOf(g, me) !== colorFilter) return false;
      if (classFilter !== 'all' && g.time_class !== classFilter) return false;
      return true;
    });
  }, [listedGames, me, resultFilter, colorFilter, classFilter]);

  const summary = useMemo(() => {
    let wins = 0;
    let draws = 0;
    for (const g of listedGames) {
      const o = outcomeFor(g, me);
      if (o === 'win') wins++;
      else if (o === 'draw') draws++;
    }
    const losses = listedGames.length - wins - draws;
    const score = listedGames.length > 0 ? ((wins + draws / 2) / listedGames.length) * 100 : 0;
    return { total: listedGames.length, wins, draws, losses, score };
  }, [listedGames, me]);

  const sideRows = useMemo(() => computeSideStats(listedGames, me), [listedGames, me]);
  const ending = useMemo(() => computeEndingStats(listedGames, me), [listedGames, me]);
  const opponentRatingRows = useMemo(() => computeOpponentRatingStats(listedGames, me), [listedGames, me]);

  /** Fins de partie : trois barres (V / N / D), chacune à 100 % de son issue. */
  const endingView = useMemo(() => {
    const shareOf = (n: number, base: number): string => {
      if (base <= 0) return '0';
      const p = (n / base) * 100;
      return n > 0 && p < 0.5 ? '<1' : p.toFixed(0);
    };
    interface EndingLegendItem { key: string; label: string; fullLabel?: string; color: string; count: number }
    interface EndingLegendGroup { title: string; total: number; other: number; items: EndingLegendItem[] }
    const groups: EndingLegendGroup[] = [
      {
        title: 'Victoires',
        total: ending.wins.total,
        other: ending.wins.total - ending.wins.resign - ending.wins.mate - ending.wins.clock,
        items: [
          { key: 'v-resign', label: 'Abandon', color: '#10b981', count: ending.wins.resign },
          { key: 'v-mate', label: 'Échec et mat', color: '#059669', count: ending.wins.mate },
          { key: 'v-clock', label: 'Temps', fullLabel: "Temps expiré (l'adversaire)", color: '#6ee7b7', count: ending.wins.clock },
        ],
      },
      {
        title: 'Nulles',
        total: ending.draws.total,
        other: ending.draws.other,
        items: [
          { key: 'd-agreed', label: 'Accord', color: '#334155', count: ending.draws.agreed },
          { key: 'd-repetition', label: 'Répétition', color: '#475569', count: ending.draws.repetition },
          { key: 'd-stalemate', label: 'Pat', color: '#64748b', count: ending.draws.stalemate },
          { key: 'd-fifty', label: '50 coups', fullLabel: 'Règle des 50 coups', color: '#94a3b8', count: ending.draws.fiftyMove },
          { key: 'd-insufficient', label: 'Manque de matériel', color: '#38bdf8', count: ending.draws.insufficient },
          { key: 'd-timevsinsufficient', label: 'Temps vs matériel', fullLabel: 'Hors délai contre manque de matériel', color: '#cbd5e1', count: ending.draws.timeVsInsufficient },
        ],
      },
      {
        title: 'Défaites',
        total: ending.losses.total,
        other: ending.losses.total - ending.losses.resign - ending.losses.mate - ending.losses.clock,
        items: [
          { key: 'l-resign', label: 'Abandon', color: '#f43f5e', count: ending.losses.resign },
          { key: 'l-mate', label: 'Échec et mat', color: '#e11d48', count: ending.losses.mate },
          { key: 'l-clock', label: 'Temps', fullLabel: 'Temps expiré', color: '#fda4af', count: ending.losses.clock },
        ],
      },
    ];
    return { groups, unknown: ending.other, total: ending.total, shareOf };
  }, [ending]);
  const periodStats = useMemo(() => computePeriodStats(listedGames, me), [listedGames, me]);
  const periodRows = periodStats.rows;
  const accuracyStats = useMemo(() => computeAccuracyStats(listedGames, me), [listedGames, me]);

  /** Formes narratives : une seule barre (100 % des parties classées). */
  const shapeView = useMemo(() => {
    const counts = {} as Record<GameShape, number>;
    for (const s of GAME_SHAPE_ORDER) counts[s] = 0;
    for (const g of listedGames) {
      if (g.shape) counts[g.shape]++;
    }
    const total = GAME_SHAPE_ORDER.reduce((sum, s) => sum + counts[s], 0);
    return { counts, total };
  }, [listedGames]);

    /** Résultats V/N/D par forme (7 barres alignées, même base). */
  const shapeResults = useMemo<ShapeResultRow[]>(() => {    const rows = GAME_SHAPE_ORDER.map((shape) => ({ shape, games: 0, wins: 0, draws: 0, losses: 0 }));
    const byShape = new Map<GameShape, ShapeResultRow>(rows.map((r) => [r.shape, r]));
    for (const g of listedGames) {
      if (!g.shape) continue;
      const row = byShape.get(g.shape);
      if (!row) continue;
      row.games++;
      const o = outcomeFor(g, me);
      if (o === 'win') row.wins++;
      else if (o === 'draw') row.draws++;
      else row.losses++;
    }
    return rows;
  }, [listedGames, me]);

  /** Précision moyenne du compte lié par forme (jeux classés ET notés). */
  const shapeAccuracy = useMemo<ShapeAccuracyRow[]>(() => {
    const acc = new Map<GameShape, { sum: number; n: number }>();
    for (const g of listedGames) {
      if (!g.shape || typeof g.accuracy !== 'number' || !Number.isFinite(g.accuracy)) continue;
      const row = acc.get(g.shape) ?? { sum: 0, n: 0 };
      row.sum += g.accuracy;
      row.n++;
      acc.set(g.shape, row);
    }
    return GAME_SHAPE_ORDER.map((shape) => {
      const row = acc.get(shape);
      return { shape, avg: row && row.n > 0 ? row.sum / row.n : null, count: row?.n ?? 0 };
    });
  }, [listedGames]);
  const shapeAccuracyTotal = shapeAccuracy.reduce((sum, r) => sum + r.count, 0);

  /** Fourchettes trouvées/manquées par pièce (toutes parties analysées). */
  const forksTotal = useMemo(() => {
    const found = {} as Record<ForkPiece, number>;
    const missed = {} as Record<ForkPiece, number>;
    let games = 0;
    for (const p of FORK_PIECE_ORDER) {
      found[p] = 0;
      missed[p] = 0;
    }
    for (const g of listedGames) {
      if (!g.forks) continue;
      games++;
      for (const p of FORK_PIECE_ORDER) {
        found[p] += g.forks.found[p] ?? 0;
        missed[p] += g.forks.missed[p] ?? 0;
      }
    }
    const foundTotal = FORK_PIECE_ORDER.reduce((sum, p) => sum + found[p], 0);
    const missedTotal = FORK_PIECE_ORDER.reduce((sum, p) => sum + missed[p], 0);
    return { found, missed, games, foundTotal, missedTotal };
  }, [listedGames]);

  /** Clouages trouvés/manqués par pièce (toutes parties analysées). */
  const pinsTotal = useMemo(() => {
    const found = {} as Record<PinPiece, number>;
    const missed = {} as Record<PinPiece, number>;
    let games = 0;
    for (const p of PIN_PIECE_ORDER) {
      found[p] = 0;
      missed[p] = 0;
    }
    for (const g of listedGames) {
      if (!g.pins) continue;
      games++;
      for (const p of PIN_PIECE_ORDER) {
        found[p] += g.pins.found[p] ?? 0;
        missed[p] += g.pins.missed[p] ?? 0;
      }
    }
    const foundTotal = PIN_PIECE_ORDER.reduce((sum, p) => sum + found[p], 0);
    const missedTotal = PIN_PIECE_ORDER.reduce((sum, p) => sum + missed[p], 0);
    return { found, missed, games, foundTotal, missedTotal };
  }, [listedGames]);

  /** Mats trouvés/manqués par distance (toutes parties analysées). */
  const matesTotal = useMemo(() => {
    const found = {} as Record<MateDistance, number>;
    const missed = {} as Record<MateDistance, number>;
    let games = 0;
    for (const d of MATE_DISTANCE_ORDER) {
      found[d] = 0;
      missed[d] = 0;
    }
    for (const g of listedGames) {
      if (!g.mates) continue;
      games++;
      for (const d of MATE_DISTANCE_ORDER) {
        found[d] += g.mates.found[d] ?? 0;
        missed[d] += g.mates.missed[d] ?? 0;
      }
    }
    const foundTotal = MATE_DISTANCE_ORDER.reduce((sum, d) => sum + found[d], 0);
    const missedTotal = MATE_DISTANCE_ORDER.reduce((sum, d) => sum + missed[d], 0);
    return { found, missed, games, foundTotal, missedTotal };
  }, [listedGames]);

  /** Pièces laissées en prise, par pièce (toutes parties analysées). */
  const hangsTotal = useMemo(() => {
    const counts = {} as Record<HungPiece, number>;
    let games = 0;
    for (const p of HUNG_PIECE_ORDER) counts[p] = 0;
    for (const g of listedGames) {
      if (!g.hangs) continue;
      games++;
      for (const p of HUNG_PIECE_ORDER) counts[p] += g.hangs[p] ?? 0;
    }
    const total = HUNG_PIECE_ORDER.reduce((sum, p) => sum + counts[p], 0);
    return { counts, total, games };
  }, [listedGames]);

  /** Pièces gratuites adverses, prises ou ignorées (toutes parties analysées). */
  const freebiesTotal = useMemo(() => {
    const found = {} as Record<HungPiece, number>;
    const missed = {} as Record<HungPiece, number>;
    let games = 0;
    for (const p of HUNG_PIECE_ORDER) {
      found[p] = 0;
      missed[p] = 0;
    }
    for (const g of listedGames) {
      if (!g.freebies) continue;
      games++;
      for (const p of HUNG_PIECE_ORDER) {
        found[p] += g.freebies.found[p] ?? 0;
        missed[p] += g.freebies.missed[p] ?? 0;
      }
    }
    const foundTotal = HUNG_PIECE_ORDER.reduce((sum, p) => sum + found[p], 0);
    const missedTotal = HUNG_PIECE_ORDER.reduce((sum, p) => sum + missed[p], 0);
    return { found, missed, games, foundTotal, missedTotal };
  }, [listedGames]);

  /** Pièces : affichage Total / par phase + agrégat sur l'historique. */
  const [pieceMode, setPieceMode] = useState<'total' | 'phases'>('total');
  const pieceAgg = useMemo(() => {
    const stats = emptyPieceStats();
    let games = 0;
    let analyzed = 0;
    for (const g of listedGames) {
      if (typeof g.accuracy === 'number') analyzed++;
      if (!g.pieces) continue;
      games++;
      addPieceStatsInto(stats, g.pieces);
    }
    const byPiece = {} as Record<PieceKind, number>;
    for (const p of PIECE_ORDER) {
      byPiece[p] = PIECE_PHASE_ORDER.reduce((s, ph) => s + (stats[ph].counts[p] ?? 0), 0);
    }
    const moves = PIECE_ORDER.reduce((s, p) => s + byPiece[p], 0);
    return { stats, byPiece, games, analyzed, moves };
  }, [listedGames]);

  /** Qualité des coups : filtre Total / couleur de pièce + tendance. */
  const [qualityMode, setQualityMode] = useState<'total' | 'colors'>('total');
  const qualityTotals = useMemo(() => {
    const total = {} as Record<MoveQuality, number>;
    const white = {} as Record<MoveQuality, number>;
    const black = {} as Record<MoveQuality, number>;
    let games = 0;
    let moves = 0;
    for (const c of MOVE_QUALITY_ORDER) {
      total[c] = 0;
      white[c] = 0;
      black[c] = 0;
    }
    for (const g of listedGames) {
      if (!g.moveQuality) continue;
      games++;
      for (const c of MOVE_QUALITY_ORDER) {
        const t = g.moveQuality.total[c] ?? 0;
        const w = g.moveQuality.white[c] ?? 0;
        const b = g.moveQuality.black[c] ?? 0;
        total[c] += t;
        white[c] += w;
        black[c] += b;
        moves += t;
      }
    }
    return { total, white, black, games, moves };
  }, [listedGames]);
  const qualityTrend = useMemo(
    () => computeQualityTrend(
      listedGames
        .filter((g) => g.moveQuality && g.end_time)
        .map((g) => ({ endTime: g.end_time, quality: g.moveQuality as MoveQualityCounts })),
    ),
    [listedGames],
  );

  /** Phases de fin de partie + filtre Total / couleur jouée. */
  const [phaseMode, setPhaseMode] = useState<'total' | 'colors'>('total');
  const phaseRows = useMemo(() => computePhaseStats(listedGames, me), [listedGames, me]);
  const hasPhaseAccuracy = phaseRows.some((r) => r.total.accN > 0);

  /** Performances des ouvertures les plus jouées (Blancs / Noirs). */
  const [perfColor, setPerfColor] = useState<'w' | 'b'>('w');
  const perfRows = useMemo(() => computeOpeningPerformances(listedGames, me, perfColor, 200), [listedGames, me, perfColor]);

  /** Maîtrise : livre fusionné, déviations, tendance et table par ouverture. */
  const [masteryColor, setMasteryColor] = useState<'w' | 'b'>('w');
  const [masteryExpanded, setMasteryExpanded] = useState(false);
  const masteryTheory = useMemo(
    () => buildMasteryTheory(repertoires.map((r) => r.root)),
    [repertoires],
  );
  const masteryGames = useMemo(
    () => analyzeMasteryGames(listedGames, me, masteryTheory),
    [listedGames, me, masteryTheory],
  );
  const masteryScoped = useMemo(
    () => masteryGames.filter((g) => g.deviator !== 'out-of-scope' && g.myColor === masteryColor),
    [masteryGames, masteryColor],
  );
  const masteryDevFirst = useMemo(
    () => masteryScoped.filter((g) => g.deviator === 'me' && g.myDeviationMove !== null),
    [masteryScoped],
  );
  const masteryAvgTheoryMoves = masteryDevFirst.length > 0
    ? masteryDevFirst.reduce((sum, g) => sum + ((g.myDeviationMove as number) - 1), 0) / masteryDevFirst.length
    : null;
  const masteryTrend = useMemo(
    () => computeMasteryTrend(masteryDevFirst.map((g) => ({ endTime: g.endTime, theoryMoves: (g.myDeviationMove as number) - 1 }))),
    [masteryDevFirst],
  );
  const masteryOpenings = useMemo(
    () => computeMasteryOpenings(masteryGames, masteryColor),
    [masteryGames, masteryColor],
  );

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

  const selectedGame = useMemo(
    () => (viewer ? (games.find((g) => g.url === viewer.url) ?? null) : null),
    [games, viewer],
  );

  // Annule les analyses en vol au démontage (pas de setState fantôme).
  React.useEffect(() => {
    return () => {
      batchAbort.current?.abort();
      reportAbort.current?.abort();
    };
  }, []);

  /**
   * Analyse batch de la liste (précisions W/B par partie, moteur local).
   * Réglages P12, 1000 ms/position : sous P12 le moteur rate les sacrifices
   * (pas de Brillant détecté alors que chess.com cloud les voit) — le batch
   * reste ~2× plus léger que la visionneuse (P16), la progression est
   * honnête et l'opération est ANNULABLE. Le rapport détaillé vit dans
   * la visionneuse.
   * Chaque partie (re)construit aussi l'agrégat « précision par coup »
   * (reset en début de lot : le batch repasse sur toute la liste).
   */
  const analyzeAccuracy = useCallback(async () => {
    if (analyzing) return;

    setAnalyzing(true);
    setAnalyzeStatus(null);
    setAnalyzeProgress({ current: 0, total: listedGames.length });
    const ctrl = new AbortController();
    batchAbort.current = ctrl;
    let moveAgg = emptyMoveAccuracy();
    moveAccRef.current = moveAgg;
    setMoveAcc(moveAgg);

    try {
      let done = 0;
      let success = 0;
      for (const game of listedGames) {
        if (ctrl.signal.aborted) break;
        try {
          const r = await analyzeGameAccuracy(game.pgn, undefined, {
            depth: 12,
            timeoutMsPerMove: 1000,
            signal: ctrl.signal,
          });
          if (r.report) {
            const mine = colorOf(game, me);
            const userAcc = mine === 'w' ? r.whiteAccuracy : r.blackAccuracy;
            const myOutcome = outcomeFor(game, me);
            const shape = classifyGameShape(
              r.report.plies.map((p) => p.whiteWin),
              (mine === 'w' && myOutcome === 'win') || (mine === 'b' && myOutcome === 'loss'),
              myOutcome === 'draw',
            );
            const forks = detectUserForks(
              game.sans,
              r.report.plies.map((p) => p.bestUci),
              mine,
            );
            const pins = detectUserPins(
              game.sans,
              r.report.plies.map((p) => p.bestUci),
              mine,
            );
            const oppResult = mine === 'w' ? game.black.result : game.white.result;
            const mates = detectUserMates(
              r.report.plies,
              mine,
              myOutcome === 'win' && oppResult === 'checkmated',
            );
            const hangs = detectUserHangs(game.sans, mine);
            const freebies = detectUserFreebies(game.sans, mine);
            const moveQuality = computeGameMoveQuality(r.report.plies);
            const pieces = computeGamePieceStats(r.report.plies);
            const patch = {
              accuracy: userAcc,
              whiteAccuracy: r.whiteAccuracy,
              blackAccuracy: r.blackAccuracy,
              shape,
              forks,
              pins,
              mates,
              hangs,
              freebies,
              moveQuality,
              pieces,
            };
            if (onUpdateGameAnalysis) onUpdateGameAnalysis(game.url, patch);
            else if (onUpdateGameAccuracy && userAcc !== null) onUpdateGameAccuracy(game.url, Math.round(userAcc));
            success++;
            moveAgg = addPliesToMoveAccuracy(moveAgg, game.url, r.report.plies);
            moveAccRef.current = moveAgg;
            setMoveAcc(moveAgg);
          }
        } catch (err) {
          if (err instanceof DOMException && err.name === 'AbortError') break;
          /* partie illisible : on passe à la suivante */
        }
        done++;
        setAnalyzeProgress({ current: done, total: listedGames.length });
      }
      chesscomMoveAccuracyStore.set(me, moveAgg);
      setAnalyzeStatus(
        ctrl.signal.aborted
          ? `Analyse interrompue : ${success} partie(s) analysée(s).`
          : `Analyse terminée : ${success}/${listedGames.length} parties analysées (Stockfish local, Win% Lichess).`,
      );
    } catch (error) {
      if (ctrl.signal.aborted) {
        chesscomMoveAccuracyStore.set(me, moveAgg);
        setAnalyzeStatus('Analyse annulée.');
      } else {
        console.error('Erreur analyse:', error);
        setAnalyzeStatus(
          `Moteur indisponible : ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    } finally {
      batchAbort.current = null;
      setAnalyzing(false);
    }
  }, [listedGames, analyzing, me, onUpdateGameAccuracy, onUpdateGameAnalysis]);

  const cancelAnalyze = useCallback(() => {
    batchAbort.current?.abort();
  }, []);

  /**
   * Rapport complet de la partie visionnée (façon en-croissant : analyse à
   * rebours, MultiPV 2, annotations !!/!/!?/?!/?/??, ACPL, phases).
   */
  const analyzeViewerGame = useCallback(async () => {
    const game = viewer ? (games.find((g) => g.url === viewer.url) ?? null) : null;
    if (!game || reportAnalyzing) return;
    setReportAnalyzing(true);
    setReportError(null);
    setReportProgress({ done: 0, total: game.sans.length + 1 });
    const ctrl = new AbortController();
    reportAbort.current = ctrl;
    try {
      const result = await analyzeGamePgn(game.pgn, {
        depth: 16,
        timeoutMsPerMove: 2500,
        multiPv: 2,
        signal: ctrl.signal,
        onProgress: (done, total) => setReportProgress({ done, total }),
        priority: 'interactive',
      });
      const mine = colorOf(game, me);
      const userAcc = mine === 'w' ? result.accuracy.white : result.accuracy.black;
      const myOutcome = outcomeFor(game, me);
      const shape = classifyGameShape(
        result.plies.map((p) => p.whiteWin),
        (mine === 'w' && myOutcome === 'win') || (mine === 'b' && myOutcome === 'loss'),
        myOutcome === 'draw',
      );
      const forks = detectUserForks(
        game.sans,
        result.plies.map((p) => p.bestUci),
        mine,
      );
      const pins = detectUserPins(
        game.sans,
        result.plies.map((p) => p.bestUci),
        mine,
      );
      const oppResult = mine === 'w' ? game.black.result : game.white.result;
      const mates = detectUserMates(
        result.plies,
        mine,
        myOutcome === 'win' && oppResult === 'checkmated',
      );
      const hangs = detectUserHangs(game.sans, mine);
      const freebies = detectUserFreebies(game.sans, mine);
      const moveQuality = computeGameMoveQuality(result.plies);
      const pieces = computeGamePieceStats(result.plies);
      if (onUpdateGameAnalysis) {
        onUpdateGameAnalysis(game.url, {
          accuracy: userAcc,
          whiteAccuracy: result.accuracy.white,
          blackAccuracy: result.accuracy.black,
          shape,
          forks,
          pins,
          mates,
          hangs,
          freebies,
          moveQuality,
          pieces,
          gameReport: result,
        });
      } else if (onUpdateGameAccuracy && userAcc !== null) {
        onUpdateGameAccuracy(game.url, Math.round(userAcc));
      }
      // Alimente l'agrégat « précision par coup » (anti double-comptage par URL).
      const nextMoveAgg = addPliesToMoveAccuracy(moveAccRef.current, game.url, result.plies);
      if (nextMoveAgg !== moveAccRef.current) {
        moveAccRef.current = nextMoveAgg;
        setMoveAcc(nextMoveAgg);
        chesscomMoveAccuracyStore.set(me, nextMoveAgg);
      }
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        setReportError('Analyse annulée.');
      } else {
        console.error('Erreur rapport:', err);
        setReportError(
          `Moteur indisponible : ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    } finally {
      reportAbort.current = null;
      setReportAnalyzing(false);
    }
  }, [viewer, games, reportAnalyzing, me, onUpdateGameAccuracy, onUpdateGameAnalysis]);

  const cancelViewerAnalysis = useCallback(() => {
    reportAbort.current?.abort();
  }, []);

  const ply = viewer?.ply ?? 0;
  const viewerSans = viewer?.sans ?? [];

  const openGame = useCallback((url: string) => {
    const game = games.find((g) => g.url === url) ?? null;
    if (game) onOpenGame(game);
  }, [games, onOpenGame]);

  // Clavier : ←/→ naviguent le grand échiquier, Échap ferme la visionneuse.
  useEffect(() => {
    if (!selectedGame || !viewer) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (e.key === 'ArrowRight') onGoToPly(ply + 1);
      else if (e.key === 'ArrowLeft') onGoToPly(ply - 1);
      else if (e.key === 'Home') onGoToPly(0);
      else if (e.key === 'End') onGoToPly(viewerSans.length);
      else if (e.key === 'Escape') onCloseViewer();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selectedGame, viewer, viewerSans.length, ply, onGoToPly, onCloseViewer]);

  return (
    <div className="chesscom-panel">
      {/* Le compte vit UNIQUEMENT dans la barre latérale (clic sur le profil). */}
      {games.length === 0 && !account.syncing && (
        <div className="panel-card">
          <div className="empty-state">
            Aucune partie chargée. Liez votre compte Chess.com depuis la barre latérale (en bas).
          </div>
        </div>
      )}
      {games.length === 0 && account.syncing && (
        <div className="panel-card">
          <div className="empty-state">Téléchargement de l'historique… (progression dans la barre latérale)</div>
        </div>
      )}

      {/* Partie ouverte : seul « Rejouer la partie » reste visible
          (la liste et les stats reviennent via le bouton Liste). */}
      {games.length > 0 && !selectedGame && (
      <div className="chesscom-top-row chesscom-top-row-full">
        <div className="chesscom-tabs" role="tablist" aria-label="Sections Mes parties">
          {STATS_TABS.map(({ key, label, Icon }) => (
            <button
              key={key}
              role="tab"
              aria-selected={statsTab === key}
              className={`db-toggle-btn ${statsTab === key ? 'active' : ''}`}
              onClick={() => setStatsTab(key)}
            >
              <Icon size={14} aria-hidden="true" />
              <span>{label}</span>
            </button>
          ))}
        </div>
        {statsTab === 'parties' && (
        <div className="chesscom-left-column">
          <div className="panel-card">
            <div className="card-title-row">
              <h3 className="card-title">
                <List size={16} className="title-icon" />
                Parties ({filteredGames.length})
              </h3>
            </div>

            <div className="chesscom-summary">
              <span><strong>{summary.total.toLocaleString('fr-FR')}</strong> parties</span>
              <span aria-hidden="true">•</span>
              <span>{summary.wins}V / {summary.draws}N / {summary.losses}D</span>
              <span aria-hidden="true">•</span>
              <span>Score {summary.score.toFixed(1)} %</span>
              {account.failedArchives > 0 && (
                <span className="text-muted" title="Archives mensuelles inaccessibles : leurs parties manquent">({account.failedArchives} archive(s) ignorée(s))</span>
              )}
              {!analyzing ? (
                <button
                  className="action-btn"
                  onClick={analyzeAccuracy}
                  title="Précision en-croissant de chaque partie (Stockfish local, Win% Lichess). Long sur un gros historique — annulable à tout moment."
                >
                  Analyser précision
                </button>
              ) : (
                <button
                  className="action-btn"
                  onClick={cancelAnalyze}
                  title="Interrompre l'analyse batch (les parties déjà traitées sont conservées)"
                >
                  Annuler ({analyzeProgress.current}/{analyzeProgress.total})
                </button>
              )}
            </div>
            {analyzeStatus && (
              <div className="chesscom-analyze-status text-muted" role="status">
                {analyzeStatus}
              </div>
            )}

            {/* Filtres de la liste */}
            <div className="chesscom-filters">
              <div className="chesscom-filter-group" title="Filtrer par issue">
                {(['all', 'win', 'draw', 'loss'] as ResultFilter[]).map((r) => (
                  <button
                    key={r}
                    className={`db-toggle-btn ${resultFilter === r ? 'active' : ''}`}
                    onClick={() => { setResultFilter(r); setVisibleCount(PAGE_SIZE); }}
                  >
                    <span>{r === 'all' ? 'Toutes' : OUTCOME_LABEL[r]}</span>
                  </button>
                ))}
              </div>
              <div className="chesscom-filter-group" title="Filtrer par couleur jouée">
                {(['all', 'w', 'b'] as ColorFilter[]).map((c) => (
                  <button
                    key={c}
                    className={`db-toggle-btn ${colorFilter === c ? 'active' : ''}`}
                    onClick={() => { setColorFilter(c); setVisibleCount(PAGE_SIZE); }}
                  >
                    <span>{c === 'all' ? 'Deux couleurs' : c === 'w' ? 'Blancs' : 'Noirs'}</span>
                  </button>
                ))}
              </div>
              {classOptions.length > 1 && (
                <div className="chesscom-filter-group" title="Filtrer par cadence">
                  {['all', ...classOptions].map((c) => (
                    <button
                      key={c}
                      className={`db-toggle-btn ${classFilter === c ? 'active' : ''}`}
                      onClick={() => { setClassFilter(c); setVisibleCount(PAGE_SIZE); }}
                    >
                      <span>{c === 'all' ? 'Toutes cadences' : (CLASS_LABELS[c] ?? c)}</span>
                    </button>
                  ))}
                </div>
              )}
              {botGamesCount > 0 && (
                <div className="chesscom-filter-group" title="Parties d'entraînement contre les robots (Coach-…, Mittens) : exclues par défaut">
                  <button
                    className={`db-toggle-btn ${showBots ? 'active' : ''}`}
                    onClick={() => { setShowBots((s) => !s); setVisibleCount(PAGE_SIZE); }}
                  >
                    <Bot size={14} />
                    <span>Robots ({botGamesCount})</span>
                  </button>
                </div>
              )}
            </div>

            {filteredGames.length === 0 ? (
              <div className="empty-state">Aucune partie avec ces filtres.</div>
            ) : (
              <>
                <div className="table-scroll">
                <table className="chesscom-games-table">
                  <thead>
                    <tr>
                      <th>Résultat</th>
                      <th>Adversaire</th>
                      <th>Couleur</th>
                      <th>Cadence</th>
                      <th title="Nombre de coups (les deux camps)">Coups</th>
                      <th>Date</th>
                      <th title="Précision en-croissant (Win% Lichess) de votre camp">Précision</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredGames.slice(0, visibleCount).map((g) => {
                      const outcome = outcomeFor(g, me);
                      const mine = colorOf(g, me);
                      const opp = mine === 'w' ? g.black : g.white;
                      const myRating = mine === 'w' ? g.white.rating : g.black.rating;
                      const myAcc = g.accuracy;
                      const openThisGame = (): void => openGame(g.url);
                      return (
                        <tr
                          key={g.url}
                          onClick={openThisGame}
                          tabIndex={0}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' || e.key === ' ') {
                              e.preventDefault();
                              openThisGame();
                            }
                          }}
                          aria-label={`Rejouer contre ${opp.username} (${OUTCOME_LABEL[outcome]})`}
                        >
                          <td>
                            <span style={{ color: OUTCOME_COLOR[outcome], fontWeight: 600 }}>
                              {OUTCOME_LABEL[outcome]}
                            </span>
                          </td>
                          <td>
                            <strong>{opp.username}</strong>
                            <span className="text-muted"> ({opp.rating || '?'})</span>
                          </td>
                          <td>{mine === 'w' ? 'Blancs' : 'Noirs'} ({myRating || '?'})</td>
                          <td>{formatCadence(g)}</td>
                          <td>{g.sans.length > 0 ? Math.ceil(g.sans.length / 2) : '—'}</td>
                          <td>{formatDate(g.end_time)}</td>
                          <td>
                            {typeof myAcc === 'number' ? (
                              <span
                                title={
                                  `Vous : ${myAcc.toFixed(1)} %` +
                                  (typeof g.whiteAccuracy === 'number' ? ` · Blancs ${g.whiteAccuracy.toFixed(1)} %` : '') +
                                  (typeof g.blackAccuracy === 'number' ? ` · Noirs ${g.blackAccuracy.toFixed(1)} %` : '')
                                }
                              >
                                {myAcc.toFixed(0)}
                              </span>
                            ) : (
                              <span className="text-muted">—</span>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
                </div>
                  {visibleCount < filteredGames.length && (
                    <button
                      className="primary-btn full-width"
                      onClick={() => setVisibleCount((n) => n + PAGE_SIZE)}
                    >
                      <span>Afficher plus ({filteredGames.length - visibleCount} restantes)</span>
                    </button>
                  )}
              </>
            )}
          </div>
        </div>
        )}
        {statsTab !== 'parties' && (
        <div className="chesscom-right-column">
        {statsTab === 'overview' && (
        <div className="chesscom-stats-grid">
        <div className="panel-card">
          <div className="card-title-row">
              <h3 className="card-title">
                <CalendarDays size={16} className="title-icon text-emerald" />
                Activité
              </h3>
          </div>
          <div className="activity-subtitle text-muted">3 derniers mois</div>
          <ActivityCalendar games={listedGames} username={me} />
        </div>

        <div className="panel-card">
          <div className="card-title-row">
            <h3 className="card-title">Elo</h3>
          </div>
          <RatingChart games={listedGames} username={me} />
        </div>

        <div className="panel-card">
          <div className="card-title-row">
            <h3 className="card-title">Parties dans le temps</h3>
          </div>
          <div className="activity-subtitle text-muted">{PERIOD_GRANULARITY_LABEL[periodStats.granularity] ?? ''}</div>
          {(() => {
            const totalGames = periodRows.reduce((sum, r) => sum + r.games, 0);
            const totalWins = periodRows.reduce((sum, r) => sum + r.wins, 0);
            const totalDraws = periodRows.reduce((sum, r) => sum + r.draws, 0);
            const totalLosses = periodRows.reduce((sum, r) => sum + r.losses, 0);
            const winPct = totalGames > 0 ? (totalWins / totalGames) * 100 : 0;
            const drawPct = totalGames > 0 ? (totalDraws / totalGames) * 100 : 0;
            const lossPct = totalGames > 0 ? 100 - winPct - drawPct : 0;
            return (
              <>
                <div className="chesscom-summary">
                  <span><strong>{totalGames.toLocaleString('fr-FR')}</strong> parties totales</span>
                  <span aria-hidden="true">•</span>
                  <span style={{ color: OUTCOME_COLOR.win }}>{totalWins}V</span>
                  <span aria-hidden="true">•</span>
                  <span className="text-muted">{totalDraws}N</span>
                  <span aria-hidden="true">•</span>
                  <span style={{ color: OUTCOME_COLOR.loss }}>{totalLosses}D</span>
                </div>
                <div
                  className="chesscom-wdl-bar"
                  title={`Victoires : ${winPct.toFixed(0)} % · Nulles : ${drawPct.toFixed(0)} % · Défaites : ${lossPct.toFixed(0)} %`}
                >
                  {winPct > 0 && (
                    <div
                      className="chesscom-wdl-segment chesscom-wdl-win"
                      style={{ width: `${winPct}%` }}
                    >
                      {winPct >= 12 ? `${winPct.toFixed(0)}%` : ''}
                    </div>
                  )}
                  {drawPct > 0 && (
                    <div
                      className="chesscom-wdl-segment chesscom-wdl-draw"
                      style={{ width: `${drawPct}%` }}
                    >
                      {drawPct >= 12 ? `${drawPct.toFixed(0)}%` : ''}
                    </div>
                  )}
                  {lossPct > 0 && (
                    <div
                      className="chesscom-wdl-segment chesscom-wdl-loss"
                      style={{ width: `${lossPct}%` }}
                    >
                      {lossPct >= 12 ? `${lossPct.toFixed(0)}%` : ''}
                    </div>
                  )}
                </div>
              </>
            );
          })()}
          <PeriodGamesChart rows={periodRows} />
        </div>

        <div className="panel-card">
          <div className="card-title-row">
            <h3 className="card-title">Parties par couleur</h3>
          </div>
          <div className="chesscom-stats-table-wrap">
            <table className="chesscom-stats-table">
              <thead>
                <tr>
                  <th>Camp</th>
                  <th>Parties</th>
                  <th title="Victoires - Nulles - Défaites">V % - N % - D %</th>
                </tr>
              </thead>
              <tbody>
                {sideRows.map((r) => {
                  const winPct = r.games > 0 ? (r.wins / r.games) * 100 : 0;
                  const drawPct = r.games > 0 ? (r.draws / r.games) * 100 : 0;
                  const lossPct = r.games > 0 ? 100 - winPct - drawPct : 0;
                  return (
                    <tr key={r.side}>
                      <td>{r.side === 'w' ? '♔ White' : '♚ Black'}</td>
                      <td>{r.games}</td>
                      <td>
                        <div
                          className="chesscom-wdl-bar"
                          title={`V ${winPct.toFixed(0)} % · N ${drawPct.toFixed(0)} % · D ${lossPct.toFixed(0)} %`}
                        >
                          {winPct > 0 && (
                            <div
                              className="chesscom-wdl-segment chesscom-wdl-win"
                              style={{ width: `${winPct}%` }}
                            >
                              {winPct >= 12 ? `${winPct.toFixed(0)}%` : ''}
                            </div>
                          )}
                          {drawPct > 0 && (
                            <div
                              className="chesscom-wdl-segment chesscom-wdl-draw"
                              style={{ width: `${drawPct}%` }}
                            >
                              {drawPct >= 12 ? `${drawPct.toFixed(0)}%` : ''}
                            </div>
                          )}
                          {lossPct > 0 && (
                            <div
                              className="chesscom-wdl-segment chesscom-wdl-loss"
                              style={{ width: `${lossPct}%` }}
                            >
                              {lossPct >= 12 ? `${lossPct.toFixed(0)}%` : ''}
                            </div>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>

        <div className="panel-card">
          <div className="card-title-row">
            <h3 className="card-title">Résultats par classement de l'adversaire</h3>
          </div>
          <div className="activity-subtitle text-muted">Tranches de 100 Elo</div>
          <OpponentRatingChart rows={opponentRatingRows} />
        </div>
        <DaytimePanel games={listedGames} me={me} />
        <WeekdayPanel games={listedGames} me={me} />
        <GeographyPanel games={listedGames} me={me} />
        </div>
        )}
        {statsTab === 'precision' && (
        <div className="chesscom-stats-grid">
        <div className="panel-card">
          <div className="card-title-row">
            <h3 className="card-title">Précision moyenne</h3>
          </div>
          <div className="activity-subtitle text-muted">
            {PERIOD_GRANULARITY_LABEL[accuracyStats.granularity] ?? ''} · {accuracyStats.overallCount.toLocaleString('fr-FR')} partie(s) analysée(s)
          </div>
          {accuracyStats.overallCount === 0 ? (
            <div className="empty-state">Analysez des parties (bouton « Analyser précision » dans Parties) pour voir votre précision moyenne.</div>
          ) : (
            <>
              {accuracyStats.overallAvg !== null && (
                <div className="chesscom-summary">
                  <span>Moyenne <strong>{accuracyStats.overallAvg.toFixed(1)} %</strong></span>
                  <span aria-hidden="true">•</span>
                  <span
                    style={{ color: OUTCOME_COLOR.win }}
                    title={`Victoires : ${accuracyStats.winAvg?.toFixed(1) ?? '—'} % (${accuracyStats.winCount} partie(s))`}
                  >
                    V {accuracyStats.winAvg !== null ? `${accuracyStats.winAvg.toFixed(1)} %` : '—'}
                  </span>
                  <span
                    style={{ color: OUTCOME_COLOR.draw }}
                    title={`Nulles : ${accuracyStats.drawAvg?.toFixed(1) ?? '—'} % (${accuracyStats.drawCount} partie(s))`}
                  >
                    N {accuracyStats.drawAvg !== null ? `${accuracyStats.drawAvg.toFixed(1)} %` : '—'}
                  </span>
                  <span
                    style={{ color: OUTCOME_COLOR.loss }}
                    title={`Défaites : ${accuracyStats.lossAvg?.toFixed(1) ?? '—'} % (${accuracyStats.lossCount} partie(s))`}
                  >
                    D {accuracyStats.lossAvg !== null ? `${accuracyStats.lossAvg.toFixed(1)} %` : '—'}
                  </span>
                </div>
              )}
              <AccuracyTrendChart rows={accuracyStats.rows} />
            </>
          )}
        </div>

        <div className="panel-card">
          <div className="card-title-row">
            <h3 className="card-title">Précision par numéro de coup</h3>
          </div>
          <div className="chesscom-filter-group" role="group" aria-label="Filtre de précision par coup">
            <button
              className={`db-toggle-btn ${moveAccMode === 'total' ? 'active' : ''}`}
              onClick={() => setMoveAccMode('total')}
            >
              <span>Total</span>
            </button>
            <button
              className={`db-toggle-btn ${moveAccMode === 'colors' ? 'active' : ''}`}
              onClick={() => setMoveAccMode('colors')}
            >
              <span>Par couleur de pièce</span>
            </button>
          </div>
          <div className="activity-subtitle text-muted">
            {moveAcc.games.length.toLocaleString('fr-FR')} partie(s) analysée(s)
          </div>
          <MoveNumberChart agg={moveAcc} mode={moveAccMode} />
        </div>

        <div className="panel-card">
          <div className="card-title-row">
            <h3 className="card-title">Qualité du coup</h3>
          </div>
          <div className="chesscom-filter-group" role="group" aria-label="Filtre de qualité des coups">
            <button
              className={`db-toggle-btn ${qualityMode === 'total' ? 'active' : ''}`}
              onClick={() => setQualityMode('total')}
            >
              <span>Total</span>
            </button>
            <button
              className={`db-toggle-btn ${qualityMode === 'colors' ? 'active' : ''}`}
              onClick={() => setQualityMode('colors')}
            >
              <span>Par couleur de pièce</span>
            </button>
          </div>
          <div className="activity-subtitle text-muted">
            {qualityTotals.moves.toLocaleString('fr-FR')} coup(s) · {qualityTotals.games.toLocaleString('fr-FR')} partie(s) analysée(s)
          </div>
          {qualityTotals.moves === 0 ? (
            <div className="empty-state">Lancez « Analyser précision » pour classer vos coups par qualité.</div>
          ) : (
            <>
              {(() => {
                const whiteMoves = MOVE_QUALITY_ORDER.reduce((s, c) => s + (qualityTotals.white[c] ?? 0), 0);
                const blackMoves = MOVE_QUALITY_ORDER.reduce((s, c) => s + (qualityTotals.black[c] ?? 0), 0);
                const pct = (n: number, d: number): string => (d > 0 ? `${((n / d) * 100).toFixed(1)} %` : '—');
                const bar = (counts: Record<MoveQuality, number>, denom: number, label: string) => (
                  <div
                    key={label}
                    className="chesscom-wdl-bar"
                    role="img"
                    aria-label={`${label} : ${MOVE_QUALITY_ORDER.map((c) => `${MOVE_QUALITY_LABELS[c]} ${counts[c] ?? 0}`).join(', ')}`}
                    title={MOVE_QUALITY_ORDER.filter((c) => (counts[c] ?? 0) > 0).map((c) => `${MOVE_QUALITY_LABELS[c]} : ${pct(counts[c] ?? 0, denom)}`).join(' · ')}
                  >
                    {MOVE_QUALITY_ORDER.map((c) =>
                      (counts[c] ?? 0) > 0 && denom > 0 ? (
                        <div
                          key={c}
                          className="chesscom-wdl-segment"
                          style={{ width: `${((counts[c] ?? 0) / denom) * 100}%`, background: MOVE_QUALITY_COLORS[c] }}
                          title={`${MOVE_QUALITY_LABELS[c]} : ${(counts[c] ?? 0).toLocaleString('fr-FR')} (${pct(counts[c] ?? 0, denom)})`}
                        />
                      ) : null,
                    )}
                  </div>
                );
                return (
                  <>
                    {qualityMode === 'total'
                      ? bar(qualityTotals.total, qualityTotals.moves, 'Total')
                      : (
                        <>
                          <div className="activity-subtitle text-muted">♔ Blancs ({whiteMoves.toLocaleString('fr-FR')} coups)</div>
                          {bar(qualityTotals.white, whiteMoves, 'Blancs')}
                          <div className="activity-subtitle text-muted">♚ Noirs ({blackMoves.toLocaleString('fr-FR')} coups)</div>
                          {bar(qualityTotals.black, blackMoves, 'Noirs')}
                        </>
                      )}
                    <div className="chesscom-stats-table-wrap">
                      <table className="chesscom-stats-table">
                        <thead>
                          <tr>
                            <th>Qualité</th>
                            {qualityMode === 'total' ? (
                              <>
                                <th>Coups</th>
                                <th>% total</th>
                              </>
                            ) : (
                              <>
                                <th title="Coups des Blancs (nombre et part des coups blancs)">♔ Blancs</th>
                                <th title="Coups des Noirs (nombre et part des coups noirs)">♚ Noirs</th>
                                <th title="Tous les coups (nombre et part du total)">Total</th>
                              </>
                            )}
                          </tr>
                        </thead>
                        <tbody>
                          {MOVE_QUALITY_ORDER.map((c) => {
                            const t = qualityTotals.total[c] ?? 0;
                            const w = qualityTotals.white[c] ?? 0;
                            const b = qualityTotals.black[c] ?? 0;
                            return (
                              <tr key={c}>
                                <td>
                                  <QualitySymbol quality={c} />
                                  <span style={{ color: MOVE_QUALITY_COLORS[c], fontWeight: 600 }}>
                                    {MOVE_QUALITY_LABELS[c]}
                                  </span>
                                </td>
                                {qualityMode === 'total' ? (
                                  <>
                                    <td>{t.toLocaleString('fr-FR')}</td>
                                    <td>{pct(t, qualityTotals.moves)}</td>
                                  </>
                                ) : (
                                  <>
                                    <td>{w.toLocaleString('fr-FR')} <span className="text-muted">({pct(w, whiteMoves)})</span></td>
                                    <td>{b.toLocaleString('fr-FR')} <span className="text-muted">({pct(b, blackMoves)})</span></td>
                                    <td>{t.toLocaleString('fr-FR')} <span className="text-muted">({pct(t, qualityTotals.moves)})</span></td>
                                  </>
                                )}
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                    <h4 className="card-title-sm">Qualité des coups au fil du temps</h4>
                    <div className="activity-subtitle text-muted">
                      {PERIOD_GRANULARITY_LABEL[qualityTrend.granularity] ?? ''} · parts à 100 % par période
                    </div>
                    <QualityTimeChart rows={qualityTrend.rows} mode={qualityMode} />
                    <div className="rating-legend">
                      {MOVE_QUALITY_ORDER.filter((c) => (qualityTotals.total[c] ?? 0) > 0).map((c) => (
                        <span key={c} className="rating-legend-item" title={`${MOVE_QUALITY_LABELS[c]} : ${(qualityTotals.total[c] ?? 0).toLocaleString('fr-FR')} coups`}>
                          <QualitySymbol quality={c} size={13} />
                          <span style={{ color: MOVE_QUALITY_COLORS[c] }}>{MOVE_QUALITY_LABELS[c]}</span>
                          <strong>{(qualityTotals.total[c] ?? 0).toLocaleString('fr-FR')}</strong>
                          <span className="text-muted">{pct(qualityTotals.total[c] ?? 0, qualityTotals.moves)}</span>
                        </span>
                      ))}
                    </div>
                  </>
                );
              })()}
            </>
          )}
        </div>

        <div className="panel-card">
          <div className="card-title-row">
            <h3 className="card-title">Pièces</h3>
          </div>
          <div className="chesscom-filter-group" role="group" aria-label="Affichage par pièce">
            <button
              className={`db-toggle-btn ${pieceMode === 'total' ? 'active' : ''}`}
              onClick={() => setPieceMode('total')}
            >
              <span>Total</span>
            </button>
            <button
              className={`db-toggle-btn ${pieceMode === 'phases' ? 'active' : ''}`}
              onClick={() => setPieceMode('phases')}
            >
              <span>Par phase</span>
            </button>
          </div>
          <div className="activity-subtitle text-muted">
            {pieceAgg.moves.toLocaleString('fr-FR')} coup(s) · {pieceAgg.games.toLocaleString('fr-FR')} partie(s) avec détail par pièce
          </div>
          {pieceAgg.moves === 0 ? (
            <div className="empty-state">
              {pieceAgg.analyzed > 0
                ? 'Aucun détail par pièce : relancez « Analyser précision » (les analyses précédentes sont sans ventilation).'
                : 'Lancez « Analyser précision » pour la ventilation par pièce.'}
            </div>
          ) : (
            <>
              <h4 className="card-title-sm">Coups par pièce</h4>
              {pieceMode === 'total' ? (
                <PieceDonut counts={pieceAgg.byPiece} label="Coups" />
              ) : (
                <div className="piece-donuts">
                  {PIECE_PHASE_ORDER.map((ph) => (
                    <PieceDonut key={ph} counts={pieceAgg.stats[ph].counts} label={PHASE_LABELS[ph]} />
                  ))}
                </div>
              )}
              <div className="chesscom-stats-table-wrap">
                <table className="chesscom-stats-table">
                  <thead>
                    <tr>
                      <th>Pièce</th>
                      {pieceMode === 'total' ? (
                        <>
                          <th>Coups</th>
                          <th>%</th>
                          <th title="Précision moyenne (Win% Lichess) des coups joués par cette pièce">Précision moy.</th>
                        </>
                      ) : (
                        <>
                          <th>Coups</th>
                          <th title="Précision moyenne en ouverture (≤ 20 plis)">Ouverture</th>
                          <th title="Précision moyenne en milieu de jeu (21–60 plis)">Milieu</th>
                          <th title="Précision moyenne en finale (> 60 plis)">Finale</th>
                        </>
                      )}
                    </tr>
                  </thead>
                  <tbody>
                    {PIECE_ORDER.map((p) => {
                      const n = pieceAgg.byPiece[p] ?? 0;
                      const sum = PIECE_PHASE_ORDER.reduce((s, ph) => s + (pieceAgg.stats[ph].accSum[p] ?? 0), 0);
                      const avg = n > 0 ? sum / n : null;
                      return (
                        <tr key={p}>
                          <td>
                            <span className="piece-glyph" style={{ color: PIECE_COLORS[p] }}>{PIECE_GLYPHS[p]}</span>
                            {PIECE_LABELS[p]}
                          </td>
                          {pieceMode === 'total' ? (
                            <>
                              <td>{n.toLocaleString('fr-FR')}</td>
                              <td>{pieceAgg.moves > 0 ? `${((n / pieceAgg.moves) * 100).toFixed(1)} %` : '—'}</td>
                              <td>{avg !== null ? `${avg.toFixed(1)} %` : '—'}</td>
                            </>
                          ) : (
                            <>
                              <td>{n.toLocaleString('fr-FR')}</td>
                              {PIECE_PHASE_ORDER.map((ph) => {
                                const cn = pieceAgg.stats[ph].counts[p] ?? 0;
                                const ca = cn > 0 ? (pieceAgg.stats[ph].accSum[p] ?? 0) / cn : null;
                                return (
                                  <td key={ph} title={cn > 0 ? `${cn.toLocaleString('fr-FR')} coup(s)` : 'Aucun coup'}>
                                    {ca !== null ? `${ca.toFixed(1)} %` : '—'}
                                  </td>
                                );
                              })}
                            </>
                          )}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <h4 className="card-title-sm">Précision moyenne par pièce</h4>
              <PieceAccuracyBars stats={pieceAgg.stats} mode={pieceMode} />
              <div className="rating-legend">
                {PIECE_ORDER.filter((p) => (pieceAgg.byPiece[p] ?? 0) > 0).map((p) => (
                  <span key={p} className="rating-legend-item" title={`${PIECE_LABELS[p]} : ${(pieceAgg.byPiece[p] ?? 0).toLocaleString('fr-FR')} coup(s)`}>
                    <span className="piece-glyph" style={{ color: PIECE_COLORS[p] }}>{PIECE_GLYPHS[p]}</span>
                    <span>{PIECE_LABELS[p]}</span>
                    <strong>{(pieceAgg.byPiece[p] ?? 0).toLocaleString('fr-FR')}</strong>
                    <span className="text-muted">
                      {pieceAgg.moves > 0 ? `${(((pieceAgg.byPiece[p] ?? 0) / pieceAgg.moves) * 100).toFixed(0)} %` : '—'}
                    </span>
                  </span>
                ))}
              </div>
            </>
          )}
        </div>

        <div className="panel-card">
          <div className="card-title-row">
            <h3 className="card-title">Précision par forme de la partie</h3>
          </div>
          <div className="activity-subtitle text-muted">
            {shapeAccuracyTotal.toLocaleString('fr-FR')} partie(s) notée(s) · axe 0–100
          </div>
          {shapeAccuracyTotal === 0 ? (
            <div className="empty-state">Lancez « Analyser précision » pour noter vos parties par forme.</div>
          ) : (
            <ShapeAccuracyChart rows={shapeAccuracy} />
          )}
        </div>
        </div>
        )}
        {statsTab === 'shapes' && (
        <div className="chesscom-stats-grid">
        <div className="panel-card">
          <div className="card-title-row">
            <h3 className="card-title">Fins de partie</h3>
          </div>
          <div className="activity-subtitle text-muted">
            {endingView.total.toLocaleString('fr-FR')} partie(s)
            {endingView.unknown > 0 && ` · ${endingView.unknown} sans résultat classé`}
          </div>
          {endingView.total === 0 ? (
            <div className="empty-state">Aucune partie.</div>
          ) : (
            <>
              {endingView.groups.map((g) => (
                <div key={g.title}>
                  <h4 className="card-title-sm">
                    {g.title} ({g.total.toLocaleString('fr-FR')})
                  </h4>
                  {g.total > 0 && (
                    <div
                      className="chesscom-wdl-bar"
                      role="img"
                      aria-label={`${g.title} : ${g.items.filter((s) => s.count > 0).map((s) => `${s.fullLabel ?? s.label} ${s.count}`).join(', ')}`}
                    >
                      {g.items.map((s) =>
                        s.count > 0 ? (
                          <div
                            key={s.key}
                            className="chesscom-wdl-segment"
                            style={{ width: `${(s.count / g.total) * 100}%`, background: s.color }}
                            title={`${s.fullLabel ?? s.label} : ${s.count} (${endingView.shareOf(s.count, g.total)} %)`}
                          />
                        ) : null,
                      )}
                      {g.other > 0 && (
                        <div
                          className="chesscom-wdl-segment"
                          style={{ width: `${(g.other / g.total) * 100}%`, background: '#71717a' }}
                          title={`Autre : ${g.other} (${endingView.shareOf(g.other, g.total)} %)`}
                        />
                      )}
                    </div>
                  )}
                  <div className="rating-legend">
                    {g.items.filter((s) => s.count > 0).map((s) => (
                      <span key={s.key} className="rating-legend-item" title={s.fullLabel ?? s.label}>
                        <span className="rating-dot" style={{ background: s.color }} />
                        <span>{s.label}</span>
                        <strong>{s.count.toLocaleString('fr-FR')}</strong>
                        <span className="text-muted">{endingView.shareOf(s.count, g.total)} %</span>
                      </span>
                    ))}
                    {g.other > 0 && (
                      <span className="rating-legend-item" title="Motif inclassable ou exotique">
                        <span className="rating-dot" style={{ background: '#71717a' }} />
                        <span>Autre</span>
                        <strong>{g.other.toLocaleString('fr-FR')}</strong>
                        <span className="text-muted">{endingView.shareOf(g.other, g.total)} %</span>
                      </span>
                    )}
                  </div>
                </div>
              ))}
            </>
          )}
        </div>

        <div className="panel-card">
          <div className="card-title-row">
            <h3 className="card-title">Parties par forme de la partie</h3>
          </div>
          <div className="activity-subtitle text-muted">
            {shapeView.total.toLocaleString('fr-FR')} partie(s) classée(s)
          </div>
          {shapeView.total === 0 ? (
            <div className="empty-state">Lancez « Analyser précision » pour classer vos parties par forme.</div>
          ) : (
            <>
              <div
                className="chesscom-wdl-bar"
                role="img"
                aria-label={`Formes de partie : ${GAME_SHAPE_ORDER.map((s) => `${GAME_SHAPE_LABELS[s]} ${shapeView.counts[s]}`).join(', ')}`}
              >
                {GAME_SHAPE_ORDER.map((s) =>
                  shapeView.counts[s] > 0 ? (
                    <div
                      key={s}
                      className="chesscom-wdl-segment"
                      style={{ width: `${(shapeView.counts[s] / shapeView.total) * 100}%`, background: SHAPE_COLORS[s] }}
                      title={`${GAME_SHAPE_LABELS[s]} : ${shapeView.counts[s]} (${((shapeView.counts[s] / shapeView.total) * 100).toFixed(0)} %) — ${GAME_SHAPE_DESCRIPTIONS[s]}`}
                    />
                  ) : null,
                )}
              </div>
              <div className="rating-legend">
                {GAME_SHAPE_ORDER.filter((s) => shapeView.counts[s] > 0).map((s) => (
                  <span key={s} className="rating-legend-item" title={GAME_SHAPE_DESCRIPTIONS[s]}>
                    <span className="rating-dot" style={{ background: SHAPE_COLORS[s] }} />
                    <span>{GAME_SHAPE_LABELS[s]}</span>
                    <strong>{shapeView.counts[s].toLocaleString('fr-FR')}</strong>
                    <span className="text-muted">{((shapeView.counts[s] / shapeView.total) * 100).toFixed(0)} %</span>
                  </span>
                ))}
              </div>
            </>
          )}
        </div>

        <div className="panel-card">
          <div className="card-title-row">
            <h3 className="card-title">Résultats par forme de la partie</h3>
          </div>
          <div className="activity-subtitle text-muted">
            {shapeView.total.toLocaleString('fr-FR')} partie(s) classée(s)
          </div>
          {shapeView.total === 0 ? (
            <div className="empty-state">Lancez « Analyser précision » pour classer vos parties par forme.</div>
          ) : (
            <ShapeResultsChart rows={shapeResults} />
          )}
        </div>

        <div className="panel-card">
          <div className="card-title-row">
            <h3 className="card-title">Phases de la partie</h3>
          </div>
          <div className="chesscom-filter-group" role="group" aria-label="Filtre par couleur jouée">
            <button
              className={`db-toggle-btn ${phaseMode === 'total' ? 'active' : ''}`}
              onClick={() => setPhaseMode('total')}
            >
              <span>Total</span>
            </button>
            <button
              className={`db-toggle-btn ${phaseMode === 'colors' ? 'active' : ''}`}
              onClick={() => setPhaseMode('colors')}
            >
              <span>Par couleur de pièce</span>
            </button>
          </div>
          {phaseRows.length === 0 ? (
            <div className="empty-state">Aucune partie rejouable.</div>
          ) : (
            <>
              <h4 className="card-title-sm">Parties qui se sont terminées en…</h4>
              <PhaseCountChart rows={phaseRows} mode={phaseMode} />
              <h4 className="card-title-sm">Précision par phase de la partie</h4>
              {hasPhaseAccuracy ? (
                <PhaseAccuracyChart rows={phaseRows} mode={phaseMode} />
              ) : (
                <div className="empty-state">Lancez « Analyser précision » pour la précision par phase.</div>
              )}
              <h4 className="card-title-sm">Résultats des parties qui se sont terminées lors de…</h4>
              <PhaseResultsChart rows={phaseRows} mode={phaseMode} />
            </>
          )}
        </div>
        <CastlingPanel games={listedGames} me={me} />
        </div>
        )}
        {statsTab === 'tactics' && (
        <div className="chesscom-stats-grid">
        <div className="panel-card">
          <div className="card-title-row">
            <h3 className="card-title">Fourchettes</h3>
          </div>
          <div className="activity-subtitle text-muted">
            {forksTotal.foundTotal.toLocaleString('fr-FR')} trouvée(s) · {forksTotal.missedTotal.toLocaleString('fr-FR')} manquée(s) · {forksTotal.games.toLocaleString('fr-FR')} partie(s) analysée(s)
          </div>
          {forksTotal.games === 0 ? (
            <div className="empty-state">Lancez « Analyser précision » pour détecter vos fourchettes.</div>
          ) : (
            <TacticRowsChart
              rows={FORK_PIECE_ORDER.map((p) => ({
                key: p,
                glyph: FORK_PIECE_GLYPHS[p],
                label: FORK_PIECE_LABELS[p],
                found: forksTotal.found[p] ?? 0,
                missed: forksTotal.missed[p] ?? 0,
              }))}
            />
          )}
        </div>

        <div className="panel-card">
          <div className="card-title-row">
            <h3 className="card-title">Clouages</h3>
          </div>
          <div className="activity-subtitle text-muted">
            {pinsTotal.foundTotal.toLocaleString('fr-FR')} trouvé(s) · {pinsTotal.missedTotal.toLocaleString('fr-FR')} manqué(s) · {pinsTotal.games.toLocaleString('fr-FR')} partie(s) analysée(s)
          </div>
          {pinsTotal.games === 0 ? (
            <div className="empty-state">Lancez « Analyser précision » pour détecter vos clouages.</div>
          ) : (
            <TacticRowsChart
              rows={PIN_PIECE_ORDER.map((p) => ({
                key: p,
                glyph: PIN_PIECE_GLYPHS[p],
                label: PIN_PIECE_LABELS[p],
                found: pinsTotal.found[p] ?? 0,
                missed: pinsTotal.missed[p] ?? 0,
              }))}
            />
          )}
        </div>

        <div className="panel-card">
          <div className="card-title-row">
            <h3 className="card-title">Mats</h3>
          </div>
          <div className="activity-subtitle text-muted">
            {matesTotal.foundTotal.toLocaleString('fr-FR')} trouvé(s) · {matesTotal.missedTotal.toLocaleString('fr-FR')} manqué(s) · {matesTotal.games.toLocaleString('fr-FR')} partie(s) analysée(s)
          </div>
          {matesTotal.games === 0 ? (
            <div className="empty-state">Lancez « Analyser précision » pour détecter vos mats.</div>
          ) : (
            <TacticRowsChart
              rows={MATE_DISTANCE_ORDER.map((d) => ({
                key: String(d),
                glyph: '#',
                label: MATE_DISTANCE_LABELS[d],
                found: matesTotal.found[d] ?? 0,
                missed: matesTotal.missed[d] ?? 0,
              }))}
            />
          )}
        </div>

        <div className="panel-card">
          <div className="card-title-row">
            <h3 className="card-title">Pièces en prise</h3>
          </div>
          <div className="activity-subtitle text-muted">
            {hangsTotal.total.toLocaleString('fr-FR')} pièce(s) laissée(s) en prise · {hangsTotal.games.toLocaleString('fr-FR')} partie(s) analysée(s)
          </div>
          {hangsTotal.games === 0 ? (
            <div className="empty-state">Lancez « Analyser précision » pour détecter vos pièces en prise.</div>
          ) : (
            <div className="forks-hbars">
              {HUNG_PIECE_ORDER.map((p) => {
                const n = hangsTotal.counts[p] ?? 0;
                const pct = hangsTotal.total > 0 ? (n / hangsTotal.total) * 100 : 0;
                return (
                  <div
                    key={p}
                    className="forks-hbar-row"
                    title={`${HUNG_PIECE_LABELS[p]} : ${n} pièce(s) laissée(s) en prise (${pct.toFixed(0)} %)`}
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
                        <div className="chesscom-wdl-segment" style={{ width: `${pct}%`, background: '#f43f5e' }} />
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
            <h3 className="card-title">Pièces gratuites</h3>
          </div>
          <div className="activity-subtitle text-muted">
            Pièces que votre adversaire a laissées en prise · {freebiesTotal.foundTotal.toLocaleString('fr-FR')} prise(s) · {freebiesTotal.missedTotal.toLocaleString('fr-FR')} ignorée(s) · {freebiesTotal.games.toLocaleString('fr-FR')} partie(s) analysée(s)
          </div>
          {freebiesTotal.games === 0 ? (
            <div className="empty-state">Lancez « Analyser précision » pour détecter les pièces gratuites.</div>
          ) : (
            <TacticRowsChart
              rows={HUNG_PIECE_ORDER.map((p) => ({
                key: p,
                glyph: FORK_PIECE_GLYPHS[p],
                label: HUNG_PIECE_LABELS[p],
                found: freebiesTotal.found[p] ?? 0,
                missed: freebiesTotal.missed[p] ?? 0,
              }))}
            />
           )}
        </div>
        </div>
        )}
        {statsTab === 'theory' && (
        <div className="chesscom-stats-grid">
          <div className="panel-card">
            <div className="card-title-row">
              <h3 className="card-title">
                <BarChart3 size={16} className="title-icon text-emerald" />
                Ouvertures
              </h3>
            </div>

            <div className="chesscom-filter-group" role="group" aria-label="Couleur jouée">
              <button
                className={`db-toggle-btn ${perfColor === 'w' ? 'active' : ''}`}
                onClick={() => setPerfColor('w')}
              >
                <span>Blancs</span>
              </button>
              <button
                className={`db-toggle-btn ${perfColor === 'b' ? 'active' : ''}`}
                onClick={() => setPerfColor('b')}
              >
                <span>Noirs</span>
              </button>
            </div>

            {perfRows.length === 0 ? (
              <div className="empty-state">Aucune partie avec cette couleur.</div>
            ) : (
              <>
                <div className="perf-rows">
                  {(openingsExpanded ? perfRows : perfRows.slice(0, OPENINGS_TOP_N)).map((r) => {
                    const winPct = r.games > 0 ? (r.wins / r.games) * 100 : 0;
                    const drawPct = r.games > 0 ? (r.draws / r.games) * 100 : 0;
                    const lossPct = r.games > 0 ? 100 - winPct - drawPct : 0;
                    return (
                      <div
                        key={r.key}
                        className="perf-row"
                        tabIndex={0}
                        onMouseEnter={(e) => showOpeningPreview(r, e.clientX, e.clientY)}
                        onMouseMove={(e) => moveOpeningPreview(r.key, e.clientX, e.clientY)}
                        onMouseLeave={() => setOpeningPreview(null)}
                        onFocus={(e) => {
                          const rect = e.currentTarget.getBoundingClientRect();
                          showOpeningPreview(r, rect.right, rect.top);
                        }}
                        onBlur={() => setOpeningPreview(null)}
                        aria-label={`${r.name ? frenchOpeningName(r.name) : 'Ouverture inconnue'} — ${r.movesLabel}`}
                      >
                        <div className="perf-row-head">
                          <span className="perf-name" title={r.name ? frenchOpeningName(r.name) : 'Ouverture inconnue'}>
                            {r.name ? frenchOpeningName(r.name) : <span className="text-muted">Inconnue</span>}
                          </span>
                          {r.eco !== '?' && <span className="eco-tag">{r.eco} </span>}
                          <span className="text-muted perf-total">
                            {r.games.toLocaleString('fr-FR')} parties
                          </span>
                        </div>
                        <div className="perf-moves" title="Coups caractéristiques">{r.movesLabel}</div>
                        <div
                          className="chesscom-wdl-bar"
                          title={`V ${winPct.toFixed(0)} % · N ${drawPct.toFixed(0)} % · D ${lossPct.toFixed(0)} %`}
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
                      </div>
                    );
                  })}
                </div>
                {!openingsExpanded && perfRows.length > OPENINGS_TOP_N && (
                  <button
                    className="primary-btn full-width"
                    onClick={() => setOpeningsExpanded(true)}
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
            <h3 className="card-title">Maîtrise</h3>
          </div>
          <div className="chesscom-filter-group" role="group" aria-label="Couleur jouée">
            <button
              className={`db-toggle-btn ${masteryColor === 'w' ? 'active' : ''}`}
              onClick={() => setMasteryColor('w')}
            >
              <span>Blancs</span>
            </button>
            <button
              className={`db-toggle-btn ${masteryColor === 'b' ? 'active' : ''}`}
              onClick={() => setMasteryColor('b')}
            >
              <span>Noirs</span>
            </button>
          </div>
          {masteryTheory.size === 0 ? (
            <div className="empty-state">Créez un répertoire avec des variantes pour mesurer votre maîtrise.</div>
          ) : masteryScoped.length === 0 ? (
            <div className="empty-state">Aucune partie avec cette couleur.</div>
          ) : (
            <>
              <div className="chesscom-summary">
                <span>
                  En moyenne <strong>{masteryAvgTheoryMoves !== null ? masteryAvgTheoryMoves.toFixed(1) : '—'}</strong> coups
                  théoriques dans les parties où vous déviez en premier ({masteryDevFirst.length.toLocaleString('fr-FR')})
                </span>
              </div>
              <div className="activity-subtitle text-muted">
                Nombre par {PERIOD_GRANULARITY_LABEL[masteryTrend.granularity] ?? 'période'}
              </div>
              <MasteryTrendChart rows={masteryTrend.rows} />
              <div className="chesscom-stats-table-wrap">
                <table className="chesscom-stats-table">
                  <thead>
                    <tr>
                      <th>Nom de l'ouverture</th>
                      <th title="Parties dans le périmètre">Parties</th>
                      <th title="Part de parties où vous déviez en premier de la théorie">Dévie 1er</th>
                      <th title="Coup moyen à partir duquel vous déviez de la théorie">Coup moyen</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(masteryExpanded ? masteryOpenings : masteryOpenings.slice(0, OPENINGS_TOP_N)).map((r) => (
                      <tr key={r.key}>
                        <td>
                          {r.eco !== '?' && <span className="eco-tag">{r.eco} </span>}
                          {r.name ? frenchOpeningName(r.name) : <span className="text-muted">Inconnue</span>}
                        </td>
                        <td>{r.total.toLocaleString('fr-FR')}</td>
                        <td>{r.devFirstShare.toFixed(0)} %</td>
                        <td>{r.avgDevMove !== null ? r.avgDevMove.toFixed(1) : '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {!masteryExpanded && masteryOpenings.length > OPENINGS_TOP_N && (
                <button
                  className="primary-btn full-width"
                  onClick={() => setMasteryExpanded(true)}
                >
                  <span>Tout afficher ({masteryOpenings.length} ouvertures)</span>
                </button>
              )}
            </>
          )}
        </div>
        </div>
        )}
        </div>
        )}
      </div>
      )}

      {/* Visionneuse : navigation coup par coup */}
      {selectedGame && (
        <div className="panel-card">
          <div className="card-title-row">
              <h3 className="card-title">
                <History size={16} className="title-icon" />
                Rejouer la partie
              </h3>
            <button className="action-btn" onClick={onCloseViewer} title="Fermer (Échap)">
              <ArrowLeft size={13} />
              <span>Liste</span>
            </button>
          </div>

          {(() => {
            const mine = colorOf(selectedGame, me);
            const opp = mine === 'w' ? selectedGame.black : selectedGame.white;
            const outcome = outcomeFor(selectedGame, me);
            return (
              <div className="chesscom-viewer-meta">
                <span
                  className="chesscom-result-dot"
                  style={{ background: OUTCOME_COLOR[outcome] }}
                  title={OUTCOME_LABEL[outcome]}
                >
                  {OUTCOME_SHORT[outcome]}
                </span>
                <span>
                  <strong>{mine === 'w' ? me : opp.username}</strong>
                  {' — '}
                  <strong>{mine === 'w' ? opp.username : me}</strong>
                </span>
                <span className="text-muted">
                  {formatCadence(selectedGame)} · {formatDate(selectedGame.end_time)}
                  {selectedGame.opening ? ` · ${frenchOpeningName(selectedGame.opening)}` : ''}
                </span>
              </div>
            );
          })()}

          <div className="chesscom-viewer-hint text-muted">
            Contrôles sous le grand échiquier (il suit le défilement) — ou cliquez un coup ci-dessous.
          </div>

          {/* Rapport de précision façon en-croissant (analyse à rebours, MultiPV 2). */}
          <div className="chesscom-report-block">
            <div className="card-title-row">
              <h4 className="card-title-sm">Précision (moteur local)</h4>
              {!reportAnalyzing ? (
                <button
                  className="action-btn"
                  onClick={analyzeViewerGame}
                  disabled={viewerSans.length === 0}
                  title="Rapport complet : précisions W/B, ACPL, annotations !!/!/!?/?!/?/??, phases (P16, ~2 s/position)"
                >
                  {selectedGame.gameReport ? 'Réanalyser' : 'Analyser cette partie'}
                </button>
              ) : (
                <button className="action-btn" onClick={cancelViewerAnalysis} title="Interrompre le rapport">
                  Annuler ({reportProgress.done}/{reportProgress.total})
                </button>
              )}
            </div>
            {reportError && (
              <div className="chesscom-analyze-status text-muted" role="status">
                {reportError}
              </div>
            )}
            {selectedGame.gameReport && (
              <GameReportView report={selectedGame.gameReport} />
            )}
          </div>

          {viewerSans.length === 0 ? (
            <div className="empty-state">Coups illisibles pour cette partie (PGN non standard).</div>
          ) : (
            <div className="chesscom-moves-grid" role="group" aria-label="Coups de la partie">
              {viewerSans.map((san, i) => {
                const analyzed = selectedGame.gameReport?.plies[i];
                const ann = analyzed?.annotation ?? '';
                return (
                  <button
                    key={i}
                    className={`chesscom-move-btn ${ply === i + 1 ? 'is-current' : ''} ${ann ? `has-annotation annotation-${ann.replace(/!/g, 'b').replace(/\?/g, 'q')}` : ''}`}
                    onClick={() => onGoToPly(i + 1)}
                    title={
                      analyzed
                        ? `${san} — précision ${analyzed.accuracy.toFixed(0)} %${ann ? ` ${ann}` : ''}${analyzed.bestSan && !analyzed.isBest ? ` (idée : ${analyzed.bestSan})` : ''}`
                        : `Aller au coup ${Math.floor(i / 2) + 1}${i % 2 === 0 ? '.' : '…'}`
                    }
                  >
                    {i % 2 === 0 && <span className="text-muted">{Math.floor(i / 2) + 1}. </span>}
                    {san}
                    {ann && <span className="move-annotation">{ann}</span>}
                  </button>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
};
