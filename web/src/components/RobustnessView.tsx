import React from 'react';
import type { BranchRobustness, RobustnessReport } from '../services/branchRobustness';
import { formatOurEval, globalBranchScore, GLOBAL_WEIGHTS } from '../services/branchRobustness';
import type { EloTier } from '../services/repertoireScore';
import { robustnessCoverageLine } from '../i18n';
import { ShieldCheck, AlertTriangle } from 'lucide-react';

export interface RobustMoveComponents {
  uci: string;
  theoreticalScore: number; // 0..1 (moteur + stabilité)
  practicalScore: number; // 0..1 (taux rétréci)
  finalScore: number; // /100 (score du coup, avec prime de pertinence)
}

interface RobustnessViewProps {
  results: BranchRobustness[];
  /** Métadonnées du run (couverture, coups sautés, durée) — optionnel. */
  report?: RobustnessReport | null;
  /** Composantes du score du coup (onglet Conseil) par UCI. */
  components: RobustMoveComponents[];
  tier: EloTier;
  onHoverMove?: (uci: string | null) => void;
}

function pct(x: number): string {
  return `${Math.round(x * 100)}`;
}

export const RobustnessView: React.FC<RobustnessViewProps> = ({
  results,
  report,
  components,
  tier,
  onHoverMove,
}) => {
  if (results.length === 0) {
    return (
      <div className="mini-error-box">
        <span>Pas assez de données (stats ou moteur) pour juger la robustesse ici.</span>
      </div>
    );
  }

  const w = GLOBAL_WEIGHTS[tier];
  const compByUci = new Map(components.map((c) => [c.uci, c]));

  const ranked = [...results]
    .map((r) => {
      const comp = compByUci.get(r.candidateUci) ?? {
        theoreticalScore: 0.5,
        practicalScore: 0.5,
        finalScore: 50,
      };
      return {
        r,
        comp,
        global: globalBranchScore(comp, r.robustness, tier),
      };
    })
    .sort((a, b) => b.global - a.global);

  return (
    <div className="robust-list">
      <div className="robust-weights-note">
        Global = Théorie {Math.round((w.theory / (w.theory + w.practical + w.robustness)) * 100)} % +
        Pratique {Math.round((w.practical / (w.theory + w.practical + w.robustness)) * 100)} % +
        Robustesse {Math.round((w.robustness / (w.theory + w.practical + w.robustness)) * 100)} %
        ({tier === 'low' ? 'palier débutant' : tier === 'mid' ? 'palier intermédiaire' : 'palier avancé'})
      </div>
      {report && (
        <div
          className="robust-coverage-note"
          title={
            report.skipped.length > 0
              ? `Non analysés : ${report.skipped.map((s) => s.san).join(', ')}`
              : report.issues.length > 0
                ? `${report.issues.length} incident(s) réseau/moteur pendant l'analyse`
                : 'Analyse complète, sans incident'
          }
        >
          {robustnessCoverageLine(report.analyzedCandidates, report.requestedCandidates, report.repliesAnalyzed)}
          {report.cancelled ? ' · interrompue' : ''}
          {report.suppressedIssueCount > 0 ? ` · +${report.suppressedIssueCount} incident(s)` : ''}
        </div>
      )}
      {ranked.map(({ r, comp, global }, idx) => {
        const worstReply = r.replies.reduce((a, b) => (a.replyScore <= b.replyScore ? a : b));
        return (
          <div
            key={r.candidateUci}
            className="panel-card robust-card"
            onMouseEnter={() => onHoverMove?.(r.candidateUci)}
            onMouseLeave={() => onHoverMove?.(null)}
          >
            <div className="card-title-row">
              <h3 className="card-title">
                <ShieldCheck size={15} className="text-accent" />
                {idx + 1}. {r.candidateSan}
              </h3>
              <span className="robust-global" title="Théorie + Pratique + Robustesse (poids selon palier Elo)">
                Score global {global}
              </span>
            </div>

            <div className="robust-triptic">
              <span title="Force théorique (moteur + stabilité)"><span className="triptic-num">1</span> Théorie <strong>{pct(comp.theoreticalScore)}</strong></span>
              <span title="Résultats pratiques corrigés"><span className="triptic-num">2</span> Pratique <strong>{pct(comp.practicalScore)}</strong></span>
              <span title="Moyenne − pénalité des mauvaises branches (× fréquence)"><span className="triptic-num">3</span> Robustesse <strong>{pct(r.robustness)}</strong></span>
            </div>

            <div className="advice-meta">
              <span>Score coup : <strong>{comp.finalScore}</strong></span>
              <span aria-hidden="true">•</span>
              <span>
                Robustesse : <strong>{pct(r.robustness)}</strong> (moy. {pct(r.weightedAvg)}
                {r.shortfall > 0.005 ? ` − pénalité ${pct(r.shortfall)}` : ''}, pire {pct(r.worst)} à {pct(r.worstShare)} des réponses)
              </span>
              <span aria-hidden="true">•</span>
              <span>Couvre {r.coveragePct.toFixed(0)} % des réponses adverses</span>
            </div>
            <div className="advice-scorebar" title={`Robustesse : ${pct(r.robustness)}/100`}>
              <div className="advice-scorebar-fill" style={{ width: `${Math.max(2, Math.min(100, r.robustness * 100))}%` }} />
            </div>

            {r.danger && (
              <p className="advice-warning">
                <AlertTriangle size={12} />
                <span>
                  Ligne à risque : {worstReply.replySan} ({worstReply.sharePct.toFixed(0)} % des réponses, score {pct(worstReply.replyScore)}) plombe la moyenne. À connaître par cœur.
                </span>
              </p>
            )}

            <div className="robust-replies">
              {r.replies.map((a) => (
                <div key={a.replyUci} className="robust-reply-row">
                  <span className="robust-reply-san">
                    {a.replySan} <span className="parties-small">{a.sharePct.toFixed(0)} %</span>
                  </span>
                  <span className="robust-reply-detail">
                    nous : {a.ourBestSan} {formatOurEval(a.ourCp, a.ourMate)}
                    {a.ourGames > 0
                      ? ` • ${(a.ourOutcomeStats * 100).toFixed(0)} % (${a.ourGames.toLocaleString('fr-FR')} p.)`
                      : a.statsAvailable
                        ? ' • sans stats'
                        : ' • stats indisponibles'}
                    {!a.engineAvailable ? ' • moteur indisponible' : ''}
                    {' → '}
                    <strong>{pct(a.replyScore)}</strong>
                  </span>
                </div>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
};
