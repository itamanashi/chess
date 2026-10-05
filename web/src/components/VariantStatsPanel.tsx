import React, { useMemo, useEffect, useState } from 'react';
import type { RepertoireItem, RepertoireMove } from '../types/chess';
import { indexRepertoire, countBranchPositions } from '../utils/repertoire';
import { formatDuration, formatEval } from '../utils/formatGames';
import { getStudyTime } from '../storage/studyTime';
import { parseNodeEvalCp } from '../utils/repCardStats';

interface VariantStatsPanelProps {
  repertoire: RepertoireItem | null;
  currentFen: string;
  registeredMoves: RepertoireMove[];
}

export const VariantStatsPanel: React.FC<VariantStatsPanelProps> = ({
  repertoire,
  registeredMoves,
}) => {
  const [studyTime, setStudyTime] = useState(0);

  useEffect(() => {
    if (repertoire) {
      setStudyTime(getStudyTime(repertoire.id));
    }
  }, [repertoire]);

  const stats = useMemo(() => {
    if (!repertoire) return null;
    const index = indexRepertoire(repertoire.root);
    const totalLines = index.totalLines;
    const maxDepth = index.maxDepth;

    let transpositions = 0;
    let totalGames = 0;
    let totalScore = 0;
    let scoredPositions = 0;

    const visit = (moves: RepertoireMove[]): void => {
      for (const m of moves) {
        totalGames += m.parties || 0;
        if (m.eval !== undefined && m.eval !== null) {
          const evalCp = parseNodeEvalCp(m.eval);
          if (evalCp !== null) {
            totalScore += evalCp;
            scoredPositions++;
          }
        }
        if (m.cloned) transpositions++;
        if (m.children?.length) visit(m.children);
      }
    };
    visit(repertoire.root.children || []);

    const avgEval = scoredPositions > 0 ? totalScore / scoredPositions : 0;
    const winrate = totalGames > 0
      ? Math.round(
          repertoire.root.children?.reduce((acc, m) => {
            const games = m.parties || 0;
            const whiteWins = m.victoires_blancs || 0;
            const blackWins = m.victoires_noirs || 0;
            const draws = m.nuls || 0;
            const ourColor = repertoire.color === 'white' ? 'w' : 'b';
            const ourWins = ourColor === 'w' ? whiteWins : blackWins;
            return acc + (ourWins + draws * 0.5) / games * games;
          }, 0) / totalGames * 100
        )
      : 0;

    const currentBranch = registeredMoves.length > 0 ? countBranchPositions(registeredMoves[0]) : 0;

    return {
      variantes: totalLines,
      transpositions,
      evalMoyenne: avgEval,
      winrate,
      profondeur: maxDepth,
      tempsEtude: studyTime,
      currentBranchPositions: currentBranch,
    };
  }, [repertoire, registeredMoves, studyTime]);

  if (!repertoire || !stats) return null;

  const { variantes, transpositions, evalMoyenne, winrate, profondeur, tempsEtude, currentBranchPositions } = stats;

  const statRows = [
    {
      left: { label: 'Variantes', value: variantes.toLocaleString('fr-FR'), color: 'var(--accent)' },
      right: { label: 'Temps d\'étude', value: formatDuration(tempsEtude), color: 'var(--info)' },
    },
    {
      left: { label: 'Transpositions', value: transpositions.toLocaleString('fr-FR'), color: 'var(--warn)' },
      right: { label: 'Éval. moyenne', value: formatEval(evalMoyenne), color: evalMoyenne >= 0 ? 'var(--success)' : 'var(--danger)' },
    },
    {
      left: { label: 'Profondeur', value: `${profondeur} plis`, color: 'var(--accent)' },
      right: { label: 'Winrate', value: `${winrate}%`, color: winrate >= 50 ? 'var(--success)' : 'var(--danger)' },
    },
  ];

  return (
    <div className="panel-card variant-stats-card">
      <div className="variant-stats-list">
        {statRows.map((row, i) => (
          <div key={i} className="variant-stat-row">
            <div className="variant-stat-pair">
              <div className="variant-stat-content">
                <span className="variant-stat-value" style={{ color: row.left.color }}>{row.left.value}</span>
                <span className="variant-stat-label">{row.left.label}</span>
              </div>
            </div>
            <div className="variant-stat-separator" aria-hidden="true">/</div>
            <div className="variant-stat-pair">
              <div className="variant-stat-content">
                <span className="variant-stat-value" style={{ color: row.right.color }}>{row.right.value}</span>
                <span className="variant-stat-label">{row.right.label}</span>
              </div>
            </div>
          </div>
        ))}
      </div>

      {registeredMoves.length > 0 && (
        <div className="current-branch-info">
          <span className="branch-label">Branche courante :</span>
          <span className="branch-value">{currentBranchPositions} positions</span>
        </div>
      )}
    </div>
  );
};