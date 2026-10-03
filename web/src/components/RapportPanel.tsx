import React, { useMemo } from 'react';
import {
  BookOpen,
  Crown,
  Crosshair,
  FileText,
  Gift,
  Info,
  ShieldAlert,
  Target,
  TrendingUp,
  TriangleAlert,
  Trophy,
  Zap,
  type LucideIcon,
} from 'lucide-react';
import {
  GAME_SHAPE_DESCRIPTIONS,
  GAME_SHAPE_LABELS,
} from '../services/chesscom';
import {
  RAPPORT_PRIORITY_COLOR,
  RAPPORT_PRIORITY_LABEL,
  buildRapport,
  type RapportIconKind,
  type RapportInput,
} from '../services/rapport';
import { frenchOpeningName } from '../utils/openingsFr';

const ICONS: Record<RapportIconKind, LucideIcon> = {
  precision: Crosshair,
  hangs: ShieldAlert,
  mates: Crown,
  freebies: Gift,
  forks: Zap,
  defense: ShieldAlert,
  winrate: TrendingUp,
  theory: BookOpen,
  blunders: TriangleAlert,
  mate: Crown,
  tactic: Zap,
  score: Trophy,
  info: Info,
};

const LEVEL_COLOR: Record<string, string> = {
  success: '#8fb996',
  warn: '#d29e6a',
  danger: '#d8816f',
  neutral: '#8e887c',
};

/** Petite jauge circulaire SVG (score / précision), accessible. */
const Gauge: React.FC<{ value: number; label: string; color: string; legend: string; size?: number }> = ({
  value, label, color, legend, size = 112,
}) => {
  const r = size / 2 - 10;
  const circ = 2 * Math.PI * r;
  const dash = circ * (Math.max(0, Math.min(100, value)) / 100);
  const c = size / 2;
  return (
    <div className="rapport-gauge-wrap">
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img" aria-label={`${label} : ${value.toFixed(0)} %`}>
        <circle cx={c} cy={c} r={r} fill="none" stroke="var(--bg-raised)" strokeWidth="10" />
        <circle
          cx={c} cy={c} r={r} fill="none"
          stroke={color} strokeWidth="10"
          strokeDasharray={`${dash} ${circ - dash}`}
          strokeLinecap="round"
          transform={`rotate(-90 ${c} ${c})`}
        />
        <text x={c} y={c - 4} textAnchor="middle" fill="var(--text)" fontSize="15" fontWeight="700">
          {value.toFixed(0)}&nbsp;%
        </text>
        <text x={c} y={c + 12} textAnchor="middle" fill="var(--text-3)" fontSize="9">
          {label.toUpperCase()}
        </text>
      </svg>
      <div className="rapport-gauge-legend text-muted">{legend}</div>
    </div>
  );
};

interface RapportPanelProps {
  input: RapportInput;
}

/**
 * Onglet « Rapport » de Mes parties : synthèse sobre (carnet d'étude),
 * sans emoji — pastilles CSS + icônes Lucide. La logique vit dans
 * `services/rapport.ts`, ce panneau ne fait que présenter.
 */
export const RapportPanel: React.FC<RapportPanelProps> = ({ input }) => {
  const data = useMemo(() => buildRapport(input), [input]);
  const dateStr = useMemo(
    () => new Date().toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' }),
    [],
  );
  const sortedAxes = useMemo(() => {
    const order = { high: 0, medium: 1, low: 2 } as const;
    return [...data.axes].sort((a, b) => order[a.priority] - order[b.priority]);
  }, [data.axes]);

  const topShapeLabel = GAME_SHAPE_LABELS[input.topShape];
  const topShapeDesc = GAME_SHAPE_DESCRIPTIONS[input.topShape];
  const levelColor = LEVEL_COLOR[data.level.tone] ?? LEVEL_COLOR.neutral;

  return (
    <div className="chesscom-stats-grid rapport-grid">
      {/* Titre + niveau + jauges */}
      <div className="panel-card rapport-hero">
        <div className="rapport-hero-left">
          <div className="rapport-hero-title-block">
            <FileText size={18} className="rapport-hero-icon" aria-hidden="true" />
            <div>
              <h3 className="rapport-hero-title">Rapport de progression</h3>
              <div className="rapport-hero-meta text-muted">
                {input.me} · {input.totalGames.toLocaleString('fr-FR')} partie{input.totalGames > 1 ? 's' : ''}
                {input.botGamesCount > 0 && ` (${input.botGamesCount} bots exclus)`}
                {' · '}{dateStr}
              </div>
            </div>
          </div>
          <span className="rapport-level-badge" style={{ borderColor: levelColor, color: levelColor }}>
            {data.level.label}
          </span>
          <p className="rapport-level-desc text-muted">{data.level.desc}</p>
        </div>
        <div className="rapport-gauges">
          <Gauge
            value={input.score}
            label="Score"
            color={data.gaugeColor}
            legend={`${input.wins}V · ${input.draws}N · ${input.losses}D`}
          />
          {data.hasAcc && input.overallAcc !== null && (
            <Gauge
              value={input.overallAcc}
              label="Précision"
              color={data.accColor}
              legend={`${input.analyzedCount} partie${input.analyzedCount > 1 ? 's' : ''}`}
              size={96}
            />
          )}
        </div>
      </div>

      {/* Chiffres clés */}
      <div className="rapport-stat-cards" role="list" aria-label="Chiffres clés">
        <div className="rapport-stat-card" role="listitem">
          <div className="rapport-stat-label text-muted">Blancs</div>
          <div className="rapport-stat-value" style={{ color: data.whiteWinPct >= 50 ? '#8fb996' : '#d8816f' }}>
            {data.whiteWinPct.toFixed(0)}&nbsp;%
          </div>
          <div className="rapport-stat-sub text-muted">{input.whiteGames} parties</div>
        </div>
        <div className="rapport-stat-card" role="listitem">
          <div className="rapport-stat-label text-muted">Noirs</div>
          <div className="rapport-stat-value" style={{ color: data.blackWinPct >= 50 ? '#8fb996' : '#d8816f' }}>
            {data.blackWinPct.toFixed(0)}&nbsp;%
          </div>
          <div className="rapport-stat-sub text-muted">{input.blackGames} parties</div>
        </div>
        {data.hasAcc && (
          <>
            <div className="rapport-stat-card" role="listitem">
              <div className="rapport-stat-label text-muted">Précision victoires</div>
              <div className="rapport-stat-value" style={{ color: '#8fb996' }}>
                {input.accWin !== null ? `${input.accWin.toFixed(1)} %` : '—'}
              </div>
              <div className="rapport-stat-sub text-muted">{input.accWinCount} partie{input.accWinCount > 1 ? 's' : ''}</div>
            </div>
            <div className="rapport-stat-card" role="listitem">
              <div className="rapport-stat-label text-muted">Précision défaites</div>
              <div className="rapport-stat-value" style={{ color: '#d8816f' }}>
                {input.accLoss !== null ? `${input.accLoss.toFixed(1)} %` : '—'}
              </div>
              <div className="rapport-stat-sub text-muted">{input.accLossCount} partie{input.accLossCount > 1 ? 's' : ''}</div>
            </div>
            {input.accDraw !== null && input.accDrawCount > 0 && (
              <div className="rapport-stat-card" role="listitem">
                <div className="rapport-stat-label text-muted">Précision nulles</div>
                <div className="rapport-stat-value" style={{ color: '#d29e6a' }}>
                  {input.accDraw.toFixed(1)}&nbsp;%
                </div>
                <div className="rapport-stat-sub text-muted">{input.accDrawCount} partie{input.accDrawCount > 1 ? 's' : ''}</div>
              </div>
            )}
          </>
        )}
        {input.theoryAvg !== null && (
          <div className="rapport-stat-card" role="listitem">
            <div className="rapport-stat-label text-muted">Théorie (coups moy.)</div>
            <div className="rapport-stat-value" style={{ color: input.theoryAvg >= 8 ? '#8fb996' : '#d29e6a' }}>
              {input.theoryAvg.toFixed(1)}
            </div>
            <div className="rapport-stat-sub text-muted">avant déviation</div>
          </div>
        )}
      </div>

      {/* Qualité des coups */}
      {input.totalMoves > 0 && (
        <div className="panel-card">
          <div className="card-title-row">
            <h4 className="card-title-sm">
              <Crosshair size={14} className="title-icon" aria-hidden="true" /> Qualité des coups
            </h4>
            <span className="text-muted" style={{ fontSize: 'var(--fs-small)' }}>
              {input.totalMoves.toLocaleString('fr-FR')} coups analysés
            </span>
          </div>
          <div
            className="rapport-quality-bar"
            role="img"
            aria-label={`Qualité : ${data.qualitySegments.filter((s) => s.count > 0).map((s) => `${s.label} ${s.count}`).join(', ')}`}
          >
            {data.qualitySegments.map((s) => (
              s.count > 0 ? (
                <div
                  key={s.key}
                  className="rapport-qbar-seg"
                  style={{ width: `${s.pct}%`, background: s.color }}
                  title={`${s.label} : ${s.count}`}
                />
              ) : null
            ))}
          </div>
          <div className="rapport-quality-legend">
            {data.qualitySegments.filter((s) => s.count > 0).map((s) => (
              <div key={s.key} className="rapport-quality-legend-item">
                <span className="rapport-quality-dot" style={{ background: s.color }} aria-hidden="true" />
                <span className="text-muted">{s.label}</span>
                <strong>{s.count}</strong>
                <span className="text-muted">({s.pct.toFixed(0)}&nbsp;%)</span>
              </div>
            ))}
          </div>
          <p className="rapport-paragraph" style={{ marginTop: 'var(--sp-2)' }}>
            <strong style={{ color: '#8fb996' }}>{data.goodMoves}</strong> coup{data.goodMoves > 1 ? 's' : ''} de
            qualité ({(data.goodMoves / input.totalMoves * 100).toFixed(0)}&nbsp;%) contre{' '}
            <strong style={{ color: '#d8816f' }}>{data.badMoves}</strong> coup{data.badMoves > 1 ? 's' : ''}{' '}
            négatif{data.badMoves > 1 ? 's' : ''} ({(data.badMoves / input.totalMoves * 100).toFixed(0)}&nbsp;%).
          </p>
        </div>
      )}

      {/* Bilan tactique */}
      {input.analyzedCount > 0 && (
        <div className="panel-card">
          <div className="card-title-row">
            <h4 className="card-title-sm">
              <Zap size={14} className="title-icon" aria-hidden="true" /> Bilan tactique
            </h4>
            <span className="text-muted" style={{ fontSize: 'var(--fs-small)' }}>
              {input.analyzedCount} partie{input.analyzedCount > 1 ? 's' : ''} analysée{input.analyzedCount > 1 ? 's' : ''}
            </span>
          </div>
          <div className="rapport-tactic-grid">
            {data.tacticRows.map((row) => {
              const Icon = row.key === 'mates' ? Crown : row.key === 'forks' ? Zap : row.key === 'hangs' ? ShieldAlert : Gift;
              const barColor = row.rate === null
                ? '#8e887c'
                : row.invert
                  ? row.missed > 0 ? '#d8816f' : '#8fb996'
                  : row.rate >= 70 ? '#8fb996' : row.rate >= 40 ? '#d29e6a' : '#d8816f';
              return (
                <div key={row.key} className="rapport-tactic-row">
                  <span className="rapport-tactic-icon"><Icon size={15} aria-hidden="true" /></span>
                  <div className="rapport-tactic-info">
                    <div className="rapport-tactic-label">{row.label}</div>
                    {row.rate !== null ? (
                      <div className="rapport-tactic-bar-wrap">
                        <div
                          className="rapport-tactic-bar"
                          role="img"
                          aria-label={`${row.label} : ${row.found} sur ${row.found + row.missed}`}
                        >
                          <div className="rapport-tactic-fill" style={{ width: `${row.invert ? 100 - (row.rate ?? 0) : row.rate}%`, background: barColor }} />
                        </div>
                        <span className="rapport-tactic-rate text-muted">{(row.invert ? 100 - (row.rate ?? 0) : row.rate ?? 0).toFixed(0)}&nbsp;%</span>
                      </div>
                    ) : (
                      <span className="text-muted" style={{ fontSize: 'var(--fs-small)' }}>Aucun cas détecté</span>
                    )}
                  </div>
                  <div className="rapport-tactic-counts text-muted">
                    {row.found + row.missed > 0 ? (
                      row.invert
                        ? <span style={{ color: row.missed > 0 ? '#d8816f' : '#8fb996' }}>{row.missed}</span>
                        : <><span style={{ color: '#8fb996' }}>{row.found}</span> / {row.found + row.missed}</>
                    ) : '—'}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Analyse */}
      <div className="panel-card rapport-narrative">
        <h4 className="card-title-sm">
          <FileText size={14} className="title-icon" aria-hidden="true" /> Analyse
        </h4>
        <div className="rapport-section">
          <h5 className="rapport-section-sub">Bilan général</h5>
          <p className="rapport-paragraph">
            Sur la période, <strong>{input.me}</strong> a joué{' '}
            <strong>{input.totalGames.toLocaleString('fr-FR')}</strong> partie{input.totalGames > 1 ? 's' : ''}
            {input.botGamesCount > 0 ? ' (robots exclus)' : ''} avec un score de{' '}
            <strong style={{ color: data.gaugeColor }}>{input.score.toFixed(1)}&nbsp;%</strong>{' '}
            ({input.wins}V · {input.draws}N · {input.losses}D).{' '}
            {input.totalGames >= 10 && (
              <>Vous performez mieux avec <strong>{data.betterColor}</strong> qu&apos;avec <strong>{data.worseColor}</strong>.</>
            )}
          </p>
          {input.topShapePct > 20 && (
            <p className="rapport-paragraph">
              Votre forme dominante est <strong>{topShapeLabel}</strong> ({input.topShapePct.toFixed(0)}&nbsp;% des parties).
              {' '}{topShapeDesc}
            </p>
          )}
        </div>
        {data.hasAcc && input.overallAcc !== null && (
          <div className="rapport-section">
            <h5 className="rapport-section-sub">Précision et qualité de jeu</h5>
            <p className="rapport-paragraph">
              Sur <strong>{input.analyzedCount}</strong> partie{input.analyzedCount > 1 ? 's' : ''} analysées au moteur,
              votre précision moyenne est de <strong style={{ color: data.accColor }}>{input.overallAcc.toFixed(1)}&nbsp;%</strong>.{' '}
              {input.accWin !== null && input.accLoss !== null && (
                <>L&apos;écart entre victoires ({input.accWin.toFixed(1)}&nbsp;%) et défaites ({input.accLoss.toFixed(1)}&nbsp;%) est de{' '}
                <strong>{Math.abs(input.accWin - input.accLoss).toFixed(1)} points</strong>.</>
              )}
            </p>
          </div>
        )}
        {(input.bestOpening ?? input.worstOpening) && (
          <div className="rapport-section">
            <h5 className="rapport-section-sub">Ouvertures</h5>
            <p className="rapport-paragraph">
              {input.bestOpening && (
                <>Votre meilleure ouverture (3 parties min.) est{' '}
                <strong style={{ color: '#8fb996' }}>{frenchOpeningName(input.bestOpening.name || 'Inconnue')}</strong>{' '}
                {input.bestOpening.eco !== '?' ? `(${input.bestOpening.eco}) ` : ''}avec{' '}
                <strong>{((input.bestOpening.wins / input.bestOpening.games) * 100).toFixed(0)}&nbsp;%</strong> de
                victoires sur {input.bestOpening.games} parties.</>
              )}{' '}
              {input.worstOpening && input.worstOpening !== input.bestOpening && (
                <>À l&apos;inverse, <strong style={{ color: '#d8816f' }}>{frenchOpeningName(input.worstOpening.name || 'Inconnue')}</strong>{' '}
                ne récolte que <strong>{((input.worstOpening.wins / input.worstOpening.games) * 100).toFixed(0)}&nbsp;%</strong> de
                victoires — piste à retravailler.</>
              )}
            </p>
            {input.theoryAvg !== null && (
              <p className="rapport-paragraph">
                Vous quittez votre répertoire théorique au coup <strong>{input.theoryAvg.toFixed(1)}</strong> en moyenne
                ({input.theoryCount} partie{input.theoryCount > 1 ? 's' : ''} concernée{input.theoryCount > 1 ? 's' : ''}).
              </p>
            )}
          </div>
        )}
      </div>

      {/* Points forts */}
      {data.strengths.length > 0 && (
        <div className="panel-card">
          <h4 className="card-title-sm">
            <Trophy size={14} className="title-icon" aria-hidden="true" /> Points forts
          </h4>
          <div className="rapport-strengths">
            {data.strengths.map((s) => {
              const Icon = ICONS[s.icon] ?? Info;
              return (
                <div key={s.title} className="rapport-strength-item">
                  <span className="rapport-strength-icon"><Icon size={15} aria-hidden="true" /></span>
                  <div>
                    <div className="rapport-strength-title">{s.title}</div>
                    <div className="rapport-strength-detail text-muted">{s.detail}</div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Plan de progression */}
      <div className="panel-card">
        <h4 className="card-title-sm">
          <Target size={14} className="title-icon" aria-hidden="true" /> Plan de progression
        </h4>
        {sortedAxes.length === 0 ? (
          <p className="rapport-paragraph text-muted">Aucun axe critique détecté. Continuez à analyser vos parties régulièrement.</p>
        ) : (
          <div className="rapport-axes">
            {sortedAxes.map((ax) => {
              const Icon = ICONS[ax.icon] ?? Info;
              const color = RAPPORT_PRIORITY_COLOR[ax.priority];
              return (
                <div key={ax.title} className="rapport-axe" style={{ borderColor: `${color}30` }}>
                  <div className="rapport-axe-left">
                    <span className="rapport-tactic-icon"><Icon size={15} aria-hidden="true" /></span>
                    <span className="rapport-axe-priority-dot" style={{ background: color }} title={RAPPORT_PRIORITY_LABEL[ax.priority]} />
                  </div>
                  <div className="rapport-axe-content">
                    <div className="rapport-axe-header">
                      <span className="rapport-axe-title">{ax.title}</span>
                      {ax.metric && <span className="rapport-axe-metric" style={{ color }}>{ax.metric}</span>}
                    </div>
                    <div className="rapport-axe-detail text-muted">{ax.detail}</div>
                  </div>
                  <span className="rapport-axe-badge" style={{ background: `${color}20`, color }}>
                    {RAPPORT_PRIORITY_LABEL[ax.priority]}
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Source */}
      <div className="rapport-footer text-muted">
        Rapport généré automatiquement · Stockfish local (profondeur 12–16) · données Chess.com.
        {input.analyzedCount < input.totalGames && (
          <> — <strong>{input.analyzedCount}/{input.totalGames}</strong> partie{input.totalGames > 1 ? 's' : ''} analysée{input.analyzedCount > 1 ? 's' : ''} : lancez «&nbsp;Analyser précision&nbsp;» pour un rapport exhaustif.</>
        )}
      </div>
    </div>
  );
};
