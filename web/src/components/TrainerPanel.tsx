import React from 'react';
import type { BoardOrientation, TrainingStats, RepertoireMove } from '../types/chess';
import { 
  Trophy, 
  Flame, 
  CheckCircle, 
  XCircle, 
  RotateCcw, 
  Eye, 
  Sparkles,
  HelpCircle,
  Loader2
} from 'lucide-react';
import { getAccuracy } from '../utils/accuracy';

interface TrainerPanelProps {
  colorToTrain: BoardOrientation;
  candidateMoves?: RepertoireMove[];
  isMyTurn: boolean;
  lastTrainedMoveSuccess: boolean | null;
  expectedMoveSan?: string;
  userPlayedSan?: string;
  stats: TrainingStats;
  onResetStats: () => void;
  onRestartLine: () => void;
  onShowHint: () => void;
  hintRevealed: boolean;
  isLineFinished: boolean;
  /** Enchaînement auto armé : la fin de ligne bascule seule sur une
   *  nouvelle variante (pas d'écran « Ligne terminée », juste un flash). */
  autoRestartPending?: boolean;
}

export const TrainerPanel: React.FC<TrainerPanelProps> = ({
  colorToTrain,
  isMyTurn,
  lastTrainedMoveSuccess,
  expectedMoveSan,
  userPlayedSan,
  stats,
  onResetStats,
  onRestartLine,
  onShowHint,
  hintRevealed,
  isLineFinished,
  autoRestartPending = false,
}) => {
  const totalAttempts = stats.correctMoves + stats.wrongMoves;
  const simpleAccuracy = totalAttempts > 0 ? Math.round((stats.correctMoves / totalAttempts) * 100) : 100;
  
  // Precision based on engine evaluation change (en-croissant style)
  let precisionAnalysis = 0;
  if (stats.prevScore && stats.nextScore) {
    precisionAnalysis = getAccuracy(stats.prevScore, stats.nextScore, colorToTrain === 'white' ? 'white' : 'black');
  } else if (totalAttempts > 0) {
    // Fallback to simple accuracy if no engine scores available
    precisionAnalysis = simpleAccuracy;
  }

  return (
    <div className="trainer-panel">
      {/* En-tête avec sélection de couleur et statistiques rapides */}
      <div className="panel-card trainer-header-card">
        <div className="card-title-row">
          <h3 className="card-title">
            <Sparkles size={16} className="title-icon" />
            Entraînement du répertoire
          </h3>
          <button className="icon-btn" onClick={onResetStats} title="Réinitialiser les scores">
            <RotateCcw size={13} />
            <span>Scores</span>
          </button>
        </div>

        {/* Couleur fixée par le répertoire (sélecteur inerte supprimé) */}
        <div className="color-selector-row">
          <span className="selector-label">
            Je m'entraîne avec les : <strong>{colorToTrain === 'white' ? '♔ Blancs' : '♚ Noirs'}</strong>
          </span>
        </div>

        {/* Barre de stats et streaks */}
        <div className="stats-dashboard-grid">
          <div className="stat-card">
            <div className="stat-icon-wrapper text-emerald">
              <CheckCircle size={18} />
            </div>
            <div className="stat-content">
              <span className="stat-value">{stats.correctMoves}</span>
              <span className="stat-label">Réussis</span>
            </div>
          </div>

          <div className="stat-card">
            <div className="stat-icon-wrapper text-rose">
              <XCircle size={18} />
            </div>
            <div className="stat-content">
              <span className="stat-value">{stats.wrongMoves}</span>
              <span className="stat-label">Erreurs</span>
            </div>
          </div>

          <div className="stat-card">
            <div className="stat-icon-wrapper text-amber">
              <Flame size={18} />
            </div>
            <div className="stat-content">
              <span className="stat-value">{stats.currentStreak}</span>
              <span className="stat-label">Série (Max: {stats.bestStreak})</span>
            </div>
          </div>

          <div className="stat-card">
            <div className="stat-icon-wrapper text-info">
              <RotateCcw size={14} />
            </div>
            <div className="stat-content">
              <span className="stat-value">{precisionAnalysis}%</span>
              <span className="stat-label">Précision eval</span>
            </div>
          </div>
        </div>
      </div>

      {/* État actuel de l'entraînement / Prompt d'action */}
      <div className="panel-card trainer-action-card">
        {isLineFinished ? (
          autoRestartPending ? (
            <div className="trainer-banner banner-success">
              <Loader2 size={24} className="banner-icon text-emerald spin" />
              <div className="banner-text">
                <h4>Ligne réussie !</h4>
                <p>Nouvelle variante…</p>
              </div>
            </div>
          ) : (
            <div className="trainer-banner banner-finished">
              <Trophy size={24} className="banner-icon text-amber" />
              <div className="banner-text">
                <h4>Ligne terminée</h4>
                <p>Tous les coups prévus dans cette branche ont été joués.</p>
              </div>
              <button className="primary-btn" onClick={onRestartLine}>
                Nouvelle variante
              </button>
            </div>
          )
        ) : lastTrainedMoveSuccess === false ? (
          <div className="trainer-banner banner-error">
            <XCircle size={24} className="banner-icon text-rose" />
            <div className="banner-text">
              <h4>Coup hors répertoire</h4>
              <p>
                Vous avez joué <strong>{userPlayedSan || 'un coup'}</strong> qui ne figure pas dans votre répertoire.
                La correction est indiquée par la <strong>flèche verte</strong> sur l'échiquier.
              </p>
              {hintRevealed ? (
                <div className="revealed-solution">
                  Le coup théorique attendu était : <span className="highlight-san">{expectedMoveSan}</span>
                </div>
              ) : (
                <p className="hint-prompt">Rejouez le coup indiqué par la flèche, ou demandez son nom.</p>
              )}
            </div>
            <div className="banner-actions">
              {!hintRevealed && (
                <button className="secondary-btn" onClick={onShowHint}>
                  <Eye size={15} />
                  <span>Voir le coup</span>
                </button>
              )}
              <button className="primary-btn" onClick={onRestartLine}>
                <RotateCcw size={15} />
                <span>Recommencer la ligne</span>
              </button>
            </div>
          </div>
        ) : lastTrainedMoveSuccess === true ? (
          <div className="trainer-banner banner-success">
            <CheckCircle size={24} className="banner-icon text-emerald" />
            <div className="banner-text">
              <h4>Coup correct</h4>
              <p>Coup théorique joué. L'adversaire réplique…</p>
            </div>
          </div>
        ) : (
          <div className={`trainer-banner ${isMyTurn ? 'banner-my-turn' : 'banner-waiting'}`}>
            <div className="banner-indicator-dot" />
            <div className="banner-text">
              {isMyTurn ? (
                <>
                  <h4>À votre tour ({colorToTrain === 'white' ? 'Blancs' : 'Noirs'})</h4>
                  <p>Jouez votre coup de répertoire sur l'échiquier.</p>
                </>
              ) : (
                <>
                  <h4>Réponse de l'adversaire...</h4>
                  <p>L'ordinateur réplique par tirage pondéré (fréquence réelle).</p>
                </>
              )}
            </div>
            {isMyTurn && (
              <button className="secondary-btn btn-sm" onClick={onShowHint} title="Indice">
                <HelpCircle size={14} />
                <span>{hintRevealed ? expectedMoveSan : 'Indice'}</span>
              </button>
            )}
          </div>
        )}
      </div>

      {/* Guide d'entraînement */}
      <div className="panel-card help-card">
        <h4 className="card-title-sm">Comment marche l'entraînement ?</h4>
        <ul className="trainer-instructions">
          <li>L'ordinateur joue automatiquement les réponses adverses de votre répertoire.</li>
          <li>À chaque tour, vous devez jouer le coup mémorisé pour votre camp.</li>
          <li>Les variantes sont répétées pour ancrer les schémas dans votre mémoire à long terme.</li>
          <li>La variante suivante démarre automatiquement en fin de ligne.</li>
        </ul>
      </div>
    </div>
  );
};