import React, { useEffect, useRef, useState } from 'react';
import { analyzeLocalFen, isSuperseded } from '../services/localEngine';
import { scoreToWhiteWinChance } from '../utils/accuracy';
import { turnOfFen } from '../utils/repertoireTree';
import { isAbortError } from '../utils/async';

interface EvalBarProps {
  /** Position affichée (suit l'aperçu de survol comme l'échiquier). */
  fen: string;
}

/**
 * Barre d'évaluation verticale (moteur Stockfish local) : blanc en bas,
 * hauteur = Win% Blancs, score en dessous. Analyse légère (P12, ~1 s,
 * priorité basse pour ne jamais préempter un batch en cours), anti-rebond
 * et dernière valeur conservée pendant le calcul suivant.
 */
export const EvalBar: React.FC<EvalBarProps> = ({ fen }) => {
  const [whiteWin, setWhiteWin] = useState<number | null>(null);
  const [scoreLabel, setScoreLabel] = useState('…');
  const seq = useRef(0);

  useEffect(() => {
    const mySeq = ++seq.current;
    const ctrl = new AbortController();
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const moves = await analyzeLocalFen(fen, {
            multiPv: 1,
            depth: 12,
            timeoutMs: 1200,
            priority: 'background',
            signal: ctrl.signal,
          });
          if (seq.current !== mySeq || ctrl.signal.aborted) return;
          const top = moves[0];
          if (!top) return;
          const side = turnOfFen(fen);
          setWhiteWin(scoreToWhiteWinChance({ cp: top.cp, mate: top.mate }, side));
          if (typeof top.mate === 'number') {
            const whiteMates = top.mate > 0 === (side === 'w');
            setScoreLabel(`${whiteMates ? '' : '-'}M${Math.abs(top.mate)}`);
          } else {
            const whiteCp = (side === 'w' ? 1 : -1) * (top.cp ?? 0);
            setScoreLabel(`${whiteCp >= 0 ? '+' : '-'}${(Math.abs(whiteCp) / 100).toFixed(1)}`);
          }
        } catch (err) {
          if (isAbortError(err) || isSuperseded(err)) return;
          /* moteur indisponible : on garde la dernière valeur affichée */
        }
      })();
    }, 220);
    return () => {
      clearTimeout(timer);
      ctrl.abort();
    };
  }, [fen]);

  const pct = whiteWin === null ? 50 : Math.max(0, Math.min(100, whiteWin));
  return (
    <div
      className="evalbar"
      role="img"
      aria-label={whiteWin === null ? 'Évaluation en cours' : `Évaluation : ${scoreLabel} (Blancs ${pct.toFixed(0)} %)`}
      title={whiteWin === null ? 'Évaluation en cours…' : `Stockfish local : ${scoreLabel}`}
    >
      <div className="evalbar-track">
        <div className="evalbar-white" style={{ height: `${pct}%` }} />
      </div>
      <div className="evalbar-score" aria-hidden="true">
        {scoreLabel}
      </div>
    </div>
  );
};
