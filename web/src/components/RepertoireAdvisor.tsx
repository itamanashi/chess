import React from 'react';
import type { LichessMove } from '../types/chess';
import { adoptPayloadForMove, type ScoredMove } from '../services/repertoireScore';
import type { StabilityVerdict } from '../services/evalStability';
import type { TrapPotentialReport } from '../services/trapPotential';
import { formatAdvCp } from '../utils/engineAdvantage';
import { frenchOpeningName } from '../utils/openingsFr';
import {
  CONFIDENCE_LABELS,
  TRAP_DEFENSE_NOT_PLAYED,
  confidenceTitle,
  edgeDeltaLine,
  stabilitySummary,
  trapTooltip,
  trapVerdictLabel,
} from '../i18n';
import {
  Star,
  Cpu,
  Plus,
  CheckCircle2,
  AlertTriangle,
} from 'lucide-react';

interface RepertoireAdvisorProps {
  moves: ScoredMove[];
  onAdopt: (m: LichessMove) => void;
  onHoverMove?: (uci: string | null) => void;
  isAdopted: (uci: string) => boolean;
  /** Analyse "piège" par UCI conseillée (optionnel, rempli sur demande). */
  trapByUci?: Record<string, TrapPotentialReport>;
}

function confidenceClass(c: ScoredMove['confidence']): string {
  if (c === 'high') return 'conf-high';
  if (c === 'medium') return 'conf-mid';
  return 'conf-low';
}

function stabilityClass(v: StabilityVerdict): string {
  if (v === 'stable') return 'st-ok';
  if (v === 'watch') return 'st-watch';
  if (v === 'unstable') return 'st-bad';
  return 'st-flip';
}

function trendArrow(t: NonNullable<ScoredMove['stability']>['trend']): string {
  if (t === 'up') return '↗';
  if (t === 'down') return '↘';
  return '→';
}

/** Compact trap-potential block (theory vs practice at N plies). */
const TrapBadge: React.FC<{ report: TrapPotentialReport }> = ({ report: trap }) => {
  if (trap.verdict === 'unknown' || trap.safetyLeafAdvCp === null || trap.expectedLeafAdvCp === null) {
    return (
      <div className="trap-line" title={trapTooltip(trap.horizonPlies)}>
        <span className="trap-badge trap-unknown">{trapVerdictLabel('unknown')}</span>
        {trap.note && <span className="trap-note">{trap.note}</span>}
      </div>
    );
  }
  const delta = (trap.trapDeltaCp ?? trap.expectedLeafAdvCp - trap.safetyLeafAdvCp) as number;
  return (
    <div className="trap-line" title={trapTooltip(trap.horizonPlies)}>
      <span className={`trap-badge trap-${trap.verdict}`}>{trapVerdictLabel(trap.verdict)}</span>
      <span className="trap-numbers">
        <span className="trap-kv"><span className="trap-key">Sécurité</span><span>{formatAdvCp(trap.safetyLeafAdvCp)}</span></span>
        <span className="trap-kv"><span className="trap-key">Pratique</span><span>{formatAdvCp(trap.expectedLeafAdvCp)}</span></span>
        <span className="trap-kv"><span className="trap-key">Δ</span><span>{formatAdvCp(delta)}</span></span>
        <span className="trap-kv"><span className="trap-key">Défense</span><span>
          {trap.bestDefenseProbability === null
            ? TRAP_DEFENSE_NOT_PLAYED
            : `${trap.bestDefenseProbability.toFixed(0)} %`}
        </span></span>
      </span>
      {trap.note && <span className="trap-note">{trap.note}</span>}
      <span className="trap-replies">
        {trap.replies.slice(0, 3).map((r) => (
          <span key={r.uci} className="trap-reply" title={`${r.games.toLocaleString('fr-FR')} parties`}>
            {r.san} {r.probabilityPct.toFixed(0)} % (
            {r.leafAdvCp === null ? '?' : formatAdvCp(r.leafAdvCp)})
            {r.isBestDefense ? ' • défense' : ''}
          </span>
        ))}
      </span>
    </div>
  );
};

export const RepertoireAdvisor: React.FC<RepertoireAdvisorProps> = ({
  moves,
  onAdopt,
  onHoverMove,
  isAdopted,
  trapByUci,
}) => {
  if (moves.length === 0) {
    return (
      <div className="mini-error-box">
        <span>Aucune donnée (ni moteur, ni statistiques) pour conseiller un coup ici.</span>
      </div>
    );
  }

  const winner = moves[0];
  const engineBest = moves.find((m) => m.isEngineBest) ?? null;
  const showDivergence = engineBest && engineBest.uci !== winner.uci;

  const adoptPayload = (m: ScoredMove): LichessMove => adoptPayloadForMove(m);

  return (
    <div className="advice-list">
      {showDivergence && (
        <div className="advice-divergence">
          <span>
            Moteur : <strong>{engineBest.san}</strong> ({engineBest.scoreFormatted})
            {' → '}
            Conseil répertoire : <strong>{winner.san}</strong> — le rendement pratique l'emporte sur l'écart moteur.
          </span>
        </div>
      )}

      {moves.slice(0, 5).map((m, i) => {
        const adopted = isAdopted(m.uci);
        return (
          <div
            key={m.uci}
            className={`advice-card ${i === 0 ? 'is-recommended' : ''}`}
            onMouseEnter={() => onHoverMove?.(m.uci)}
            onMouseLeave={() => onHoverMove?.(null)}
          >
            <div className="advice-top">
              <span className="candidate-rank-small">{i + 1}</span>
              <span className="candidate-san-bold">{m.san}</span>
              <span className="advice-score" title="Score composite répertoire / 100">
                {m.finalScore}
                <span className="advice-score-den">/100</span>
              </span>
            </div>
            <div className="advice-tags">
              {i === 0 && (
                <span className="best-move-tag">
                  <Star size={10} /> Recommandé
                </span>
              )}
              {m.isEngineBest && (
                <span className="engine-choice-tag">
                  <Cpu size={10} /> Moteur
                </span>
              )}
              <span className={`confidence-chip ${confidenceClass(m.confidence)}`} title={confidenceTitle(m.confidence)}>
                Confiance {CONFIDENCE_LABELS[m.confidence].toLowerCase()}
              </span>
            </div>

            <div className="advice-meta">
              {m.hasEngine ? (
                <span>Éval {m.scoreFormatted} (prof. {m.depth})</span>
              ) : (
                <span className="text-muted">Sans éval moteur</span>
              )}
              <span aria-hidden="true">•</span>
              {m.hasStats ? (
                <span
                  className="advice-vnd"
                  title={`${m.games.toLocaleString('fr-FR')} parties — Victoires ${m.winPct.toFixed(1)} % / Nulles ${m.drawPct.toFixed(1)} % / Défaites ${m.lossPct.toFixed(1)} %`}
                >
                  <span className="advice-vnd-bar" aria-hidden="true">
                    <i className="chesscom-wdl-win" style={{ width: `${m.winPct}%` }} />
                    <i className="chesscom-wdl-draw" style={{ width: `${m.drawPct}%` }} />
                    <i className="chesscom-wdl-loss" style={{ width: `${m.lossPct}%` }} />
                  </span>
                  <span>{m.games.toLocaleString('fr-FR')} parties · V {m.winPct.toFixed(0)} / N {m.drawPct.toFixed(0)} / D {m.lossPct.toFixed(0)}</span>
                </span>
              ) : (
                <span className="text-muted">Jamais joué à ce niveau</span>
              )}
              {m.opponentEdge !== null && (
                <>
                  <span aria-hidden="true">•</span>
                  <span title="Espérance statistique des réponses adverses moins attente moteur">
                    {edgeDeltaLine(m.opponentEdge * 100)}
                  </span>
                </>
              )}
            </div>

            {m.openingName && <div className="candidate-op-name">{frenchOpeningName(m.openingName)}</div>}

            <div className="advice-scorebar" title={`Score répertoire : ${m.finalScore}/100`}>
              <div className="advice-scorebar-fill" style={{ width: `${Math.max(2, Math.min(100, m.finalScore))}%` }} />
            </div>

            {m.stability && m.stability.verdict !== 'stable' && (
              <div
                className={`stability-line ${stabilityClass(m.stability.verdict)}`}
                title={`Amplitude ${m.stability.swingCp} cp, dérive récente ${m.stability.recentDriftCp} cp, ${m.stability.reversals} renversement(s) sur ${m.stability.points} profondeurs`}
              >
                {trendArrow(m.stability.trend)}{' '}
                {stabilitySummary({
                  verdict: m.stability.verdict,
                  range: m.stability.rangeFormatted,
                  minDepth: m.stability.minDepth,
                  maxDepth: m.stability.maxDepth,
                  swingCp: m.stability.swingCp,
                  driverKind: m.stability.driverKind,
                  driverCp: m.stability.driverCp,
                })}
              </div>
            )}

            <p className="advice-why">{m.justification}</p>

            {trapByUci?.[m.uci] && (
              <TrapBadge report={trapByUci[m.uci]} />
            )}

            {m.warnings.map((w, k) => (
              <p key={k} className="advice-warning">
                <AlertTriangle size={12} /> {w}
              </p>
            ))}

            <div className="engine-card-footer">
              <span className="engine-source-label">
                {m.hasStats && m.hasEngine ? 'Moteur + pratique' : m.hasEngine ? 'Moteur seul' : 'Pratique seule'}
              </span>
              <button
                className={`adopt-btn ${adopted ? 'already-adopted' : ''}`}
                onClick={() => onAdopt(adoptPayload(m))}
                disabled={adopted}
              >
                {adopted ? (
                  <>
                    <CheckCircle2 size={13} />
                    <span>Déjà au répertoire</span>
                  </>
                ) : (
                  <>
                    <Plus size={13} />
                    <span>Adopter ce coup</span>
                  </>
                )}
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
};
