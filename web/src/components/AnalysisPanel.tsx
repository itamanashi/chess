import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Chess } from 'chess.js';
import type { EngineMove, MoveHistoryItem } from '../types/chess';
import {
  analyzeLocalFen,
  getLocalEngineStatus,
  isSuperseded,
  onLocalEngineStatusChange,
  type LocalEngineStatus,
} from '../services/localEngine';
import { isAbortError } from '../utils/async';

const DEPTHS = [12, 16, 18, 20, 24] as const;
const VARIATION_COUNTS = [1, 2, 3, 4, 5, 6] as const;
const NO_ENGINE_MOVES: EngineMove[] = [];

interface AnalysisPanelProps {
  currentFen: string;
  history: MoveHistoryItem[];
  currentIndex: number;
  onJumpToMove: (index: number) => void;
  onShapesChange: (shapes: { orig: string; dest: string; brush: string }[] | null) => void;
  onPreviewChange: (preview: { fen: string; lastMove: [string, string] } | null) => void;
}

export const AnalysisPanel: React.FC<AnalysisPanelProps> = ({
  currentFen,
  history,
  currentIndex,
  onJumpToMove,
  onShapesChange,
  onPreviewChange,
}) => {
  const [depth, setDepth] = useState<number>(18);
  const [variationCount, setVariationCount] = useState<number>(3);
  const [result, setResult] = useState<{ fen: string; moves: EngineMove[] }>({ fen: currentFen, moves: [] });
  const [selectedLine, setSelectedLine] = useState(0);
  const [progress, setProgress] = useState<{ fen: string; depth: number }>({ fen: currentFen, depth: 0 });
  const [activeAnalysis, setActiveAnalysis] = useState<{ fen: string; controller: AbortController } | null>(null);
  const [error, setError] = useState<{ fen: string; message: string } | null>(null);
  const [engineStatus, setEngineStatus] = useState<LocalEngineStatus>(getLocalEngineStatus);
  const [previewPosition, setPreviewPosition] = useState<{ rootFen: string; fen: string } | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const runIdRef = useRef(0);
  const turn = useMemo(() => new Chess(currentFen).turn(), [currentFen]);
  const moves = result.fen === currentFen ? result.moves : NO_ENGINE_MOVES;
  const progressDepth = progress.fen === currentFen ? progress.depth : 0;
  const running = activeAnalysis?.fen === currentFen && !activeAnalysis.controller.signal.aborted;
  const visibleError = error?.fen === currentFen ? error.message : null;

  useEffect(() => onLocalEngineStatusChange(setEngineStatus), []);

  useEffect(() => {
    return () => {
      runIdRef.current += 1;
      abortRef.current?.abort();
      abortRef.current = null;
      onShapesChange(null);
      onPreviewChange(null);
    };
  }, [currentFen, onShapesChange, onPreviewChange]);

  useEffect(() => {
    if (moves.length === 0 || previewPosition?.rootFen === currentFen) {
      onShapesChange(null);
      return;
    }
    onShapesChange(
      moves.flatMap((move, index) => {
        if (move.uci.length < 4) return [];
        return [{
          orig: move.uci.slice(0, 2),
          dest: move.uci.slice(2, 4),
          brush: index === 0 ? 'green' : 'red',
        }];
      }),
    );
  }, [moves, currentFen, previewPosition, onShapesChange]);

  const startAnalysis = async () => {
    const id = ++runIdRef.current;
    const controller = new AbortController();
    abortRef.current = controller;
    setActiveAnalysis({ fen: currentFen, controller });
    setError(null);
    setResult({ fen: currentFen, moves: [] });
    setSelectedLine(0);
    setProgress({ fen: currentFen, depth: 0 });

    try {
      const result = await analyzeLocalFen(currentFen, {
        multiPv: variationCount,
        depth,
        timeoutMs: 120000,
        priority: 'interactive',
        signal: controller.signal,
        onProgress: (reachedDepth) => {
          if (runIdRef.current === id) setProgress({ fen: currentFen, depth: reachedDepth });
        },
        onPartial: (partialMoves, reachedDepth) => {
          if (runIdRef.current !== id) return;
          setResult({ fen: currentFen, moves: partialMoves });
          setProgress({ fen: currentFen, depth: reachedDepth });
        },
      });
      if (runIdRef.current !== id) return;
      setResult({ fen: currentFen, moves: result });
      if (result.length === 0) setError({ fen: currentFen, message: 'Stockfish n’a proposé aucune variante pour cette position.' });
    } catch (err) {
      if (runIdRef.current !== id || isAbortError(err) || isSuperseded(err)) return;
      setError({ fen: currentFen, message: err instanceof Error ? err.message : String(err) });
    } finally {
      if (runIdRef.current === id) {
        abortRef.current = null;
        setActiveAnalysis(null);
      }
    }
  };

  const stopAnalysis = () => {
    runIdRef.current += 1;
    abortRef.current?.abort();
    abortRef.current = null;
    setActiveAnalysis(null);
  };

  const previewLineAt = (move: EngineMove, ply: number) => {
    try {
      const board = new Chess(currentFen);
      const sans = move.pvSans.length > 0 ? move.pvSans : [move.san];
      let lastMove: [string, string] | null = null;
      for (let index = 0; index <= ply; index += 1) {
        const uci = move.pvUci?.[index] ?? (index === 0 ? move.uci : undefined);
        const played = uci && uci.length >= 4
          ? board.move({
              from: uci.slice(0, 2),
              to: uci.slice(2, 4),
              ...(uci[4] ? { promotion: uci[4] } : {}),
            })
          : board.move(sans[index]);
        if (!played) throw new Error('Coup de variante illégal.');
        lastMove = [played.from, played.to];
      }
      setSelectedLine(moves.indexOf(move));
      setPreviewPosition({ rootFen: currentFen, fen: board.fen() });
      if (lastMove) onPreviewChange({ fen: board.fen(), lastMove });
    } catch {
      setError({ fen: currentFen, message: 'Cette variante ne peut pas être rejouée sur l’échiquier.' });
    }
  };

  const statusLabel =
    engineStatus === 'ready'
      ? 'Stockfish prêt'
      : engineStatus === 'error'
        ? 'Moteur indisponible'
        : 'Stockfish local';

  return (
    <section className="analysis-panel" aria-labelledby="analysis-title">
      <header className="analysis-heading">
        <div>
          <h2 id="analysis-title">Analyse de la position</h2>
          <p className="analysis-position-note">
            {turn === 'w' ? 'Aux blancs de jouer' : 'Aux noirs de jouer'}
          </p>
        </div>
        <span className={`analysis-engine-status ${engineStatus}`} role="status">
          <span aria-hidden="true" />
          {statusLabel}
        </span>
      </header>

      <div className="analysis-controls">
        <label className="analysis-control">
          <span>Profondeur</span>
          <select
            className="text-input analysis-select"
            value={depth}
            disabled={running}
            onChange={(event) => setDepth(Number(event.target.value))}
          >
            {DEPTHS.map((value) => <option key={value} value={value}>{value} demi-coups</option>)}
          </select>
        </label>
        <label className="analysis-control">
          <span>Lignes affichées</span>
          <select
            className="text-input analysis-select"
            value={variationCount}
            disabled={running}
            onChange={(event) => setVariationCount(Number(event.target.value))}
          >
            {VARIATION_COUNTS.map((value) => (
              <option key={value} value={value}>{value} {value === 1 ? 'ligne' : 'lignes'}</option>
            ))}
          </select>
        </label>
        {running ? (
          <button className="secondary-btn analysis-run-btn" onClick={stopAnalysis}>
            Arrêter
          </button>
        ) : (
          <button className="primary-btn analysis-run-btn" onClick={() => void startAnalysis()}>
            {moves.length > 0 ? 'Relancer' : 'Analyser'}
          </button>
        )}
      </div>

      {running && (
        <p className="analysis-progress" role="status">
          Stockfish réfléchit{progressDepth > 0 ? ` · profondeur ${progressDepth}/${depth}` : '…'}
        </p>
      )}
      {visibleError && <p className="analysis-error" role="alert">{visibleError}</p>}

      <div className="analysis-lines">
        {moves.length > 0 ? (
          moves.map((move, index) => (
            <div
              className={`analysis-line ${selectedLine === index ? 'selected' : ''}`}
              key={`${move.uci}-${index}`}
            >
              <button
                className="analysis-line-summary"
                onClick={() => previewLineAt(move, 0)}
                title={`Afficher le premier coup de la ligne ${index + 1}`}
              >
                <span className="analysis-line-rank">{index + 1}</span>
                <span className="analysis-line-content">
                  <span className="analysis-line-top">
                    <span className="analysis-line-score">{move.scoreFormatted || '—'}</span>
                    <span className="analysis-line-depth">D{move.depth}</span>
                  </span>
                </span>
              </button>
              <div className="analysis-line-pv" aria-label={`Variante ${index + 1}`}>
                {(move.pvSans.length > 0 ? move.pvSans : [move.san]).map((san, ply) => (
                  <React.Fragment key={`${ply}-${san}`}>
                    {ply > 0 && ' '}
                    <button
                      className="analysis-ply-btn"
                      onClick={() => previewLineAt(move, ply)}
                      title={`Afficher la position après ${san}`}
                      aria-label={`Ligne ${index + 1}, coup ${ply + 1} : ${san}`}
                    >
                      {san}
                    </button>
                  </React.Fragment>
                ))}
              </div>
            </div>
          ))
        ) : (
          <p className="analysis-empty">
            {running
              ? 'Les variantes apparaîtront dès que Stockfish aura terminé sa première profondeur.'
              : 'Lancez l’analyse pour comparer les meilleures variantes et leurs premiers coups sur l’échiquier.'}
          </p>
        )}
      </div>
      {moves.length > 0 && <p className="analysis-arrow-hint">Cliquez sur une ligne pour son premier coup, ou sur un coup précis pour afficher cette position.</p>}

      <section className="analysis-history" aria-labelledby="analysis-history-title">
        <div className="analysis-history-heading">
          <h3 id="analysis-history-title">Historique de la partie</h3>
          <span>{Math.max(0, history.length - 1)} {history.length === 2 ? 'coup' : 'coups'}</span>
        </div>
        {history.length > 1 ? (
          <div className="analysis-history-moves">
            <button
              className={`analysis-history-move ${currentIndex === 0 ? 'active' : ''}`}
              onClick={() => onJumpToMove(0)}
              aria-current={currentIndex === 0 ? 'step' : undefined}
            >
              Début
            </button>
            {history.slice(1).map((item, offset) => {
              const historyIndex = offset + 1;
              const before = new Chess(history[historyIndex - 1].fen);
              const moveNumber = before.fen().split(' ')[5] ?? '1';
              const prefix = before.turn() === 'w' ? `${moveNumber}.` : `${moveNumber}...`;
              return (
                <button
                  key={`${historyIndex}-${item.uci}`}
                  className={`analysis-history-move ${currentIndex === historyIndex ? 'active' : ''}`}
                  onClick={() => onJumpToMove(historyIndex)}
                  aria-current={currentIndex === historyIndex ? 'step' : undefined}
                  title={`Aller au coup ${prefix} ${item.san}`}
                >
                  <span>{prefix}</span> {item.san}
                </button>
              );
            })}
          </div>
        ) : (
          <p className="analysis-history-empty">Jouez un coup sur l’échiquier pour commencer la partie.</p>
        )}
      </section>
    </section>
  );
};
