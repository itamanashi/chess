import React from 'react';
import { accuracyColor, type GameReport, type PhaseName } from '../utils/accuracy';

const PHASE_LABELS: Record<PhaseName, string> = {
  opening: 'Ouverture',
  middlegame: 'Milieu de jeu',
  endgame: 'Finale',
};

const ANNOTATION_ORDER = ['??', '?', '?!', '!?', '!', '!!'] as const;

interface GameReportViewProps {
  report: GameReport;
}

function fmtPct(v: number | null): string {
  return v === null ? '—' : `${v.toFixed(1)} %`;
}

function fmtAcpl(v: number | null): string {
  return v === null ? '—' : v.toFixed(0);
}

/**
 * Résumé du rapport en-croissant : précisions W/B, ACPL, compteur
 * d'annotations et précisions par phase. Les coups annotés vivent dans
 * la grille de la visionneuse (pastilles ??/?/…/!! cliquables).
 */
export const GameReportView: React.FC<GameReportViewProps> = ({ report }) => {
  return (
    <div className="game-report">
      <div className="game-report-head">
        <div className="game-report-acc">
          <span className="game-report-side">♔ Blancs</span>
          <strong style={{ color: accuracyColor(report.accuracy.white) }}>
            {fmtPct(report.accuracy.white)}
          </strong>
          <span className="text-muted game-report-sub">ACPL {fmtAcpl(report.acpl.white)}</span>
        </div>
        <div className="game-report-acc">
          <span className="game-report-side">♚ Noirs</span>
          <strong style={{ color: accuracyColor(report.accuracy.black) }}>
            {fmtPct(report.accuracy.black)}
          </strong>
          <span className="text-muted game-report-sub">ACPL {fmtAcpl(report.acpl.black)}</span>
        </div>
      </div>

      <div className="game-report-annotations" title="Coups classés par perte de Win% (best − joué)">
        {ANNOTATION_ORDER.map((a) => (
          <span key={a} className={`annotation-chip annotation-${a.replace(/!/g, 'b').replace(/\?/g, 'q')}`}>
            {a} · {report.annotations[a]}
          </span>
        ))}
      </div>

      <table className="chesscom-stats-table game-report-phases">
        <thead>
          <tr>
            <th>Phase</th>
            <th>♔ Blancs</th>
            <th>♚ Noirs</th>
          </tr>
        </thead>
        <tbody>
          {(['opening', 'middlegame', 'endgame'] as const).map((phase) => (
            <tr key={phase}>
              <td>{PHASE_LABELS[phase]}</td>
              <td style={{ color: accuracyColor(report.phases[phase].white) }}>
                {fmtPct(report.phases[phase].white)}
              </td>
              <td style={{ color: accuracyColor(report.phases[phase].black) }}>
                {fmtPct(report.phases[phase].black)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
};
