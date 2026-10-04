import React, { useMemo } from 'react';
import {
  BookOpen,
  Crown,
  Crosshair,
  FileText,
  Gift,
  Info,
  Minus,
  ShieldAlert,
  Star,
  Target,
  TrendingDown,
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
  type RapportDelta,
  type RapportGameRef,
  type RapportGlobalTrend,
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

/** Petite sparkline SVG (paquets de 5 parties, ordre chronologique). */
const Spark: React.FC<{ values: number[]; color: string; label: string }> = ({ values, color, label }) => {
  if (values.length < 2) {
    return <span className="text-muted rapport-spark-empty">—</span>;
  }
  const w = 120;
  const h = 36;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const step = w / (values.length - 1);
  const pts = values
    .map((v, i) => `${(i * step).toFixed(1)},${(h - 4 - ((v - min) / span) * (h - 8)).toFixed(1)}`)
    .join(' ');
  const last = values[values.length - 1];
  const first = values[0];
  const dotColor = last >= first ? '#8fb996' : '#d8816f';
  return (
    <svg
      width={w} height={h} viewBox={`0 0 ${w} ${h}`}
      role="img" aria-label={`${label} : ${values.map((v) => v.toFixed(0)).join(', ')}`}
      className="rapport-spark"
    >
      <polyline points={pts} fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx={w} cy={h - 4 - ((last - min) / span) * (h - 8)} r="3" fill={dotColor} />
    </svg>
  );
};

/** Pastille globale d'évolution (progression / régression / stable / historique court). */
const TREND_META: Record<RapportGlobalTrend, { label: string; color: string; Icon: LucideIcon }> = {
  progression: { label: 'En progression', color: '#8fb996', Icon: TrendingUp },
  'régression': { label: 'En régression', color: '#d8816f', Icon: TrendingDown },
  stable: { label: 'Stable', color: '#8e887c', Icon: Minus },
  insuffisant: { label: 'Historique court', color: '#d29e6a', Icon: Info },
};

/** Valeur récente d'un delta, formatée selon l'indicateur. */
function formatDeltaRecent(d: RapportDelta): string {
  if (d.recent === null) return '—';
  switch (d.key) {
    case 'acpl':
      return `${Math.round(d.recent)} cp`;
    case 'pieces-prise':
      return `${d.recent.toFixed(1).replace('.', ',')} /partie`;
    case 'theorie':
      return `${d.recent.toFixed(1).replace('.', ',')} coups`;
    default:
      return `${d.recent.toFixed(1).replace('.', ',')} %`;
  }
}

function deltaToneColor(d: RapportDelta): string {
  if (d.favorable === true) return '#8fb996';
  if (d.favorable === false) return '#d8816f';
  return '#8e887c';
}

/** Couleur d'une précision (mêmes seuils que le rapport global). */
function accuracyTone(acc: number): string {
  if (acc >= 80) return '#8fb996';
  if (acc >= 65) return '#d29e6a';
  return '#d8816f';
}

const GAME_RESULT_META: Record<RapportGameRef['result'], { label: string; color: string }> = {
  win: { label: 'Victoire', color: '#8fb996' },
  draw: { label: 'Nulle', color: '#8e887c' },
  loss: { label: 'Défaite', color: '#d8816f' },
};

/** Ligne « partie marquante » façon Game Review (adversaire, issue, précision, Revoir). */
const GameRow: React.FC<{ tag: string; game: RapportGameRef; onOpen?: (url: string) => void }> = ({
  tag, game, onOpen,
}) => {
  const meta = GAME_RESULT_META[game.result];
  return (
    <div className="rapport-game-row">
      <div className="rapport-game-main">
        <span className="rapport-game-tag text-muted">{tag}</span>
        <span className="rapport-game-opp">
          contre <strong>{game.opponent}</strong>
          {game.opponentRating !== null && <span className="text-muted"> ({game.opponentRating})</span>}
          {game.dateLabel && <span className="text-muted"> · {game.dateLabel}</span>}
        </span>
      </div>
      <span className="rapport-game-result" style={{ color: meta.color }}>
        <span className="rapport-quality-dot" style={{ background: meta.color }} aria-hidden="true" />
        {meta.label}
      </span>
      <span className="rapport-game-acc" style={{ color: accuracyTone(game.accuracy) }}>
        {game.accuracy.toFixed(1).replace('.', ',')}&nbsp;%
      </span>
      {onOpen && (
        <button type="button" className="action-btn btn-sm" onClick={() => onOpen(game.url)}>
          Revoir
        </button>
      )}
    </div>
  );
};

interface RapportPanelProps {
  input: RapportInput;
  /** Ouvre la partie en visionneuse (boutons « Revoir »). Absent = lecture seule. */
  onOpenGame?: (url: string) => void;
}

/**
 * Onglet « Rapport » de Mes parties : synthèse sobre (carnet d'étude),
 * sans emoji — pastilles CSS + icônes Lucide. La logique vit dans
 * `services/rapport.ts`, ce panneau ne fait que présenter.
 */
export const RapportPanel: React.FC<RapportPanelProps> = ({ input, onOpenGame }) => {
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

  const fr1 = (v: number): string => v.toFixed(1).replace('.', ',');
  const blunderRate = input.totalMoves > 0 ? (input.blunder / input.totalMoves) * 100 : null;
  const hangsPerGame = input.analyzedCount > 0 ? input.hangs / input.analyzedCount : null;

  /** Chiffres à retenir (pastilles de synthèse du rapport). */
  const keyFigures: Array<{ label: string; value: string; color: string }> = [
    { label: 'Score', value: `${fr1(input.score)} %`, color: data.gaugeColor },
    ...(input.overallAcc !== null
      ? [{ label: 'Précision', value: `${fr1(input.overallAcc)} %`, color: data.accColor }]
      : []),
    ...(input.acplOverall !== null
      ? [{ label: 'ACPL', value: `${Math.round(input.acplOverall)} cp`, color: data.acplColor }]
      : []),
    ...(blunderRate !== null
      ? [{
        label: 'Bévues',
        value: `${fr1(blunderRate)} %`,
        color: blunderRate > 4 ? '#d8816f' : blunderRate >= 2 ? '#d29e6a' : '#8fb996',
      }]
      : []),
    ...(hangsPerGame !== null
      ? [{
        label: 'Prises /partie',
        value: hangsPerGame.toFixed(1).replace('.', ','),
        color: hangsPerGame >= 0.5 ? '#d8816f' : hangsPerGame > 0 ? '#d29e6a' : '#8fb996',
      }]
      : []),
  ];

  /** Phrase-verdict : niveau, score, précision/ACPL, niveau estimé, tendance. */
  const verdictBody = [
    `Score ${fr1(input.score)} % sur ${input.totalGames} partie${input.totalGames > 1 ? 's' : ''} (${input.wins}V · ${input.draws}N · ${input.losses}D).`,
    ...(data.hasAcc && input.overallAcc !== null
      ? [`Précision ${fr1(input.overallAcc)} %${input.acplOverall !== null ? ` et ACPL ${Math.round(input.acplOverall)} cp` : ''} sur ${input.analyzedCount} partie${input.analyzedCount > 1 ? 's' : ''} analysée${input.analyzedCount > 1 ? 's' : ''}.`]
      : []),
    ...(data.estimatedLevel !== null
      ? [`Vous avez joué comme un joueur estimé à ≈ ${data.estimatedLevel} Elo.`]
      : []),
    ...(data.evolution && data.evolution.sufficient
      ? [`Tendance ${data.evolution.global} sur les ${data.evolution.window} dernières parties.`]
      : []),
  ].join(' ');

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
          {data.evolution && (() => {
            const meta = TREND_META[data.evolution.global];
            const TrendIcon = meta.Icon;
            return (
              <span
                className="rapport-trend-badge"
                style={{ borderColor: `${meta.color}60`, color: meta.color, background: `${meta.color}14` }}
                title={`${data.evolution.recentGames} récentes contre ${data.evolution.previousGames} précédentes`}
              >
                <TrendIcon size={13} aria-hidden="true" />
                {meta.label}
              </span>
            );
          })()}
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
        {input.analyzedCount > 0 && (
          <div className="rapport-stat-card" role="listitem">
            <div className="rapport-stat-label text-muted">ACPL moyen</div>
            <div className="rapport-stat-value" style={{ color: data.acplColor }}>
              {input.acplOverall !== null ? Math.round(input.acplOverall) : '—'}
            </div>
            <div className="rapport-stat-sub text-muted">
              {input.acplCount > 0
                ? `${input.acplCount} partie${input.acplCount > 1 ? 's' : ''} · centipions`
                : 'Relancez « Analyser précision »'}
            </div>
          </div>
        )}
      </div>

      {/* Évolution : période récente vs précédente */}
      {data.evolution && (
        <div className="panel-card rapport-evolution">
          <div className="card-title-row">
            <h4 className="card-title-sm">
              {(() => {
                const meta = TREND_META[data.evolution.global];
                const TrendIcon = meta.Icon;
                return <TrendIcon size={14} className="title-icon" aria-hidden="true" />;
              })()} Évolution
            </h4>
            <span className="text-muted" style={{ fontSize: 'var(--fs-small)' }}>
              {data.evolution.recentGames} récentes vs {data.evolution.previousGames} précédentes
            </span>
          </div>
          <div
            className="rapport-evo-grid"
            role="list"
            aria-label="Indicateurs de progression et régression"
          >
            {data.evolution.deltas.map((d) => {
              const tone = deltaToneColor(d);
              return (
                <div
                  key={d.key}
                  className="rapport-evo-card"
                  role="listitem"
                  title={d.previous !== null ? `Précédent : ${formatDeltaRecent({ ...d, recent: d.previous })}` : 'Période précédente insuffisante'}
                >
                  <div className="rapport-evo-label text-muted">{d.label}</div>
                  <div className="rapport-evo-value">{formatDeltaRecent(d)}</div>
                  <span className="rapport-evo-delta" style={{ background: `${tone}1f`, color: tone }}>
                    {d.text}
                  </span>
                </div>
              );
            })}
          </div>
          {data.evolution.sufficient && (
            <div className="rapport-sparks" aria-label="Tendances graphiques">
              <div className="rapport-spark-item">
                <span className="rapport-spark-label text-muted">Score</span>
                <Spark values={data.evolution.recentSparkScore} color={data.gaugeColor} label="Tendance du score" />
              </div>
              <div className="rapport-spark-item">
                <span className="rapport-spark-label text-muted">Précision</span>
                <Spark values={data.evolution.recentSparkAcc} color={data.accColor} label="Tendance de la précision" />
              </div>
            </div>
          )}
          <div className="rapport-section">
            <h5 className="rapport-section-sub">Analyse de l&apos;évolution</h5>
            {data.evolution.narrative.map((p, i) => (
              <p key={i} className="rapport-paragraph">{p}</p>
            ))}
          </div>
        </div>
      )}

      {/* Analyse : synthèse rédigée, cœur du rapport */}
      <div className="panel-card rapport-narrative rapport-analyse">
        <div className="card-title-row">
          <h4 className="card-title-sm rapport-analyse-title">
            <FileText size={16} className="title-icon" aria-hidden="true" /> Analyse
          </h4>
          <span className="text-muted" style={{ fontSize: 'var(--fs-small)' }}>
            {input.analyzedCount}/{input.totalGames} analysée{input.totalGames > 1 ? 's' : ''}
          </span>
        </div>
        <div className="rapport-verdict" style={{ borderColor: `${levelColor}55` }}>
          <span className="rapport-verdict-level" style={{ color: levelColor }}>{data.level.label}</span>
          <p className="rapport-verdict-text">{verdictBody}</p>
        </div>
        {keyFigures.length > 0 && (
          <div className="rapport-keyfigures" role="list" aria-label="Chiffres à retenir">
            {keyFigures.map((c) => (
              <span key={c.label} className="rapport-chip" role="listitem">
                <span className="rapport-chip-label text-muted">{c.label}</span>
                <strong className="rapport-chip-value" style={{ color: c.color }}>{c.value}</strong>
              </span>
            ))}
          </div>
        )}
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
              {input.accWhite !== null && input.accBlack !== null && input.accWhiteCount > 0 && input.accBlackCount > 0 && (
                <span>
                  {' '}Vous êtes plus précis avec <strong>{input.accWhite >= input.accBlack ? 'les Blancs' : 'les Noirs'}</strong>{' '}
                  ({fr1(Math.max(input.accWhite, input.accBlack))}&nbsp;%) qu’avec{' '}
                  <strong>{input.accWhite >= input.accBlack ? 'les Noirs' : 'les Blancs'}</strong>{' '}
                  ({fr1(Math.min(input.accWhite, input.accBlack))}&nbsp;%).
                </span>
              )}
            </p>
            {input.acplOverall !== null && (
              <p className="rapport-paragraph">
                Votre ACPL moyen est de <strong style={{ color: data.acplColor }}>{Math.round(input.acplOverall)} centipions</strong>{' '}
                ({input.acplCount} partie{input.acplCount > 1 ? 's' : ''}) : sous 40 cp, votre jeu est très propre ; au-delà de 80 cp, chaque partie contient en moyenne une erreur décisive.
              </p>
            )}
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
        {data.evolution && (
          <div className="rapport-section">
            <h5 className="rapport-section-sub">En bref : l&apos;évolution</h5>
            <p className="rapport-paragraph">
              {data.evolution.sufficient
                ? `Sur les ${data.evolution.window} dernières parties, la tendance est « ${data.evolution.global} » — détail indicateur par indicateur dans la section Évolution ci-dessus.`
                : `L'historique est encore trop court pour comparer deux périodes — l'analyse ci-dessus porte sur l'ensemble des parties.`}
            </p>
          </div>
        )}
      </div>

      {/* Parties marquantes : meilleure / à revoir, façon Game Review */}
      {(input.bestGame ?? input.worstGame) && (
        <div className="panel-card">
          <div className="card-title-row">
            <h4 className="card-title-sm">
              <Star size={14} className="title-icon" aria-hidden="true" /> Parties marquantes
            </h4>
            <span className="text-muted" style={{ fontSize: 'var(--fs-small)' }}>
              Précision max / min
            </span>
          </div>
          <div className="rapport-games">
            {input.bestGame && (
              <GameRow tag="Meilleure partie" game={input.bestGame} onOpen={onOpenGame} />
            )}
            {input.worstGame && (
              <GameRow tag="À revoir" game={input.worstGame} onOpen={onOpenGame} />
            )}
          </div>
        </div>
      )}

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
          <div
            className="rapport-moves-table"
            role="table"
            aria-label="Classification des coups façon chess.com"
          >
            {data.qualitySegments.filter((s) => s.count > 0).map((s) => (
              <div key={s.key} className="rapport-move-row" role="row">
                {s.glyph ? (
                  <span
                    className="rapport-move-glyph"
                    style={{ color: s.color, borderColor: `${s.color}55` }}
                    aria-hidden="true"
                  >
                    {s.glyph}
                  </span>
                ) : (
                  <span className="rapport-quality-dot" style={{ background: s.color }} aria-hidden="true" />
                )}
                <span className="rapport-move-label">{s.label}</span>
                <span className="rapport-move-bar" aria-hidden="true">
                  <span style={{ width: `${s.pct}%`, background: s.color }} />
                </span>
                <span className="rapport-move-count">
                  <strong>{s.count}</strong>
                  <span className="text-muted">({s.pct.toFixed(0)}&nbsp;%)</span>
                </span>
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
                    {ax.evolutionNote && (
                      <div className="rapport-axe-evo">{ax.evolutionNote}</div>
                    )}
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
