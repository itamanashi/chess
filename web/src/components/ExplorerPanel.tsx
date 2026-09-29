import React from 'react';
import type { RepertoireMove, MoveHistoryItem } from '../types/chess';
import {
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  Play,
  RotateCw,
} from 'lucide-react';

interface ExplorerPanelProps {
  currentFen: string;
  candidateMoves: RepertoireMove[];
  history: MoveHistoryItem[];
  currentIndex: number;
  onSelectCandidateMove: (move: RepertoireMove) => void;
  onHoverMove?: (uci: string | null) => void;
  onJumpToMove: (index: number) => void;
  onGoStart: () => void;
  onGoBack: () => void;
  onGoForward: () => void;
  onGoEnd: () => void;
  onPlayMainLine: () => void;
  onFlipBoard: () => void;
  isInRepertoire: boolean;
  isMainLinePlaying: boolean;
}

export const ExplorerPanel: React.FC<ExplorerPanelProps> = ({
  candidateMoves,
  history,
  currentIndex,
  onSelectCandidateMove,
  onHoverMove,
  onJumpToMove,
  onGoStart,
  onGoBack,
  onGoForward,
  onGoEnd,
  onPlayMainLine,
  onFlipBoard,
  isInRepertoire,
  isMainLinePlaying,
}) => {
  // Calcul du total des parties pour les pourcentages relatifs
  const totalParties = candidateMoves.reduce((acc, m) => acc + (m.parties || 0), 0) || 1;

  return (
    <div className="explorer-panel">
      {/* Barre de contrôles de navigation rapide */}
      <div className="navigation-toolbar">
        <button 
          className="nav-btn" 
          onClick={onGoStart} 
          disabled={currentIndex <= 0} 
          title="Position initiale"
        >
          <ChevronsLeft size={18} />
        </button>
        <button 
          className="nav-btn" 
          onClick={onGoBack} 
          disabled={currentIndex <= 0} 
          title="Coup précédent (Flèche gauche)"
        >
          <ChevronLeft size={18} />
        </button>
        <button 
          className="nav-btn" 
          onClick={onGoForward} 
          disabled={currentIndex >= history.length - 1} 
          title="Coup suivant (Flèche droite)"
        >
          <ChevronRight size={18} />
        </button>
        <button 
          className="nav-btn" 
          onClick={onGoEnd} 
          disabled={currentIndex >= history.length - 1} 
          title="Dernier coup joué"
        >
          <ChevronsRight size={18} />
        </button>
        <button 
          className={`nav-btn ${isMainLinePlaying ? 'active-pulse' : ''}`}
          onClick={onPlayMainLine} 
          disabled={candidateMoves.length === 0}
          title={candidateMoves.length === 0 ? 'Fin de ligne : aucun coup à rejouer' : 'Rejouer la suite principale'}
        >
          <Play size={16} />
          <span>Principale</span>
        </button>
        <button className="nav-btn" onClick={onFlipBoard} title="Inverser l'échiquier">
          <RotateCw size={16} />
        </button>
      </div>

      {/* Historique des coups au format notation échiquéenne */}
      {/* (statut répertoire + copies FEN/PGN : bandeau global sous l'échiquier) */}
      <div className="panel-card history-card">
        <div className="card-title-row">
          <h3 className="card-title">Notation des coups</h3>
        </div>

        <div className="moves-history-grid">
          {history.length <= 1 ? (
            <div className="empty-history">Position initiale — jouez un coup sur l'échiquier ou cliquez une variante ci-dessous.</div>
          ) : (
            history.slice(1).map((item, idx) => {
              const moveNum = Math.floor(idx / 2) + 1;
              const isWhite = idx % 2 === 0;
              const isCurrent = idx + 1 === currentIndex;

              return (
                <React.Fragment key={idx}>
                  {isWhite && <span className="move-number">{moveNum}.</span>}
                  <button
                    className={`move-pill ${isCurrent ? 'active' : ''}`}
                    onClick={() => onJumpToMove(idx + 1)}
                  >
                    {item.san}
                  </button>
                </React.Fragment>
              );
            })
          )}
        </div>
      </div>

      {/* Liste des coups candidats du répertoire */}
      <div className="panel-card candidates-card">
        <h3 className="card-title">
          Suites au Répertoire ({candidateMoves.length})
        </h3>

        {candidateMoves.length === 0 ? (
          <div className="empty-candidates">
            {isInRepertoire 
              ? "Vous avez atteint la fin de cette branche de votre répertoire." 
              : "Cette position n'est pas dans votre répertoire. Vous pouvez explorer les coups avec Lichess Live !"}
          </div>
        ) : (
          <div className="candidates-list">
            {candidateMoves.map((m, i) => {
              const parties = m.parties || 0;
              const partShare = Math.round((parties / totalParties) * 100);
              const pw = parties > 0 ? Math.round((m.victoires_blancs / parties) * 100) : 0;
              const pd = parties > 0 ? Math.round((m.nuls / parties) * 100) : 0;
              const pb = parties > 0 ? Math.round((m.victoires_noirs / parties) * 100) : 0;

              return (
                <button
                  key={i}
                  className="candidate-item"
                  onClick={() => onSelectCandidateMove(m)}
                  onMouseEnter={() => onHoverMove?.(m.uci)}
                  onMouseLeave={() => onHoverMove?.(null)}
                  onFocus={() => onHoverMove?.(m.uci)}
                  onBlur={() => onHoverMove?.(null)}
                >
                  <div className="candidate-top">
                    <div className="candidate-san-group">
                      <span className="candidate-rank">{i + 1}</span>
                      <span className="candidate-san">{m.san}</span>
                      {m.eco && <span className="eco-badge">{m.eco}</span>}
                    </div>
                    <div className="candidate-stats-meta">
                      <span className="parties-count">
                        {parties.toLocaleString('fr-FR')} parties
                      </span>
                      <span className="share-pct">({partShare}%)</span>
                    </div>
                  </div>

                  {m.ouverture && (
                    <div className="candidate-opening">{m.ouverture}</div>
                  )}

                  {/* Barre de répartition des résultats (Blancs / Nuls / Noirs) */}
                  <div className="result-bar" title={`Blancs: ${pw}% | Nuls: ${pd}% | Noirs: ${pb}%`}>
                    <div className="bar-white" style={{ width: `${pw}%` }}>
                      {pw > 15 && `${pw}%`}
                    </div>
                    <div className="bar-draw" style={{ width: `${pd}%` }}>
                      {pd > 15 && `${pd}%`}
                    </div>
                    <div className="bar-black" style={{ width: `${pb}%` }}>
                      {pb > 15 && `${pb}%`}
                    </div>
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
};
