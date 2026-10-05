import React from 'react';
import { Bot, History, List } from 'lucide-react';
import {
  colorOf,
  outcomeFor,
  type ChesscomGame,
  type ChesscomOutcome,
} from '../services/chesscom';
import { accuracyColor } from '../utils/accuracy';

export type GamesResultFilter = 'all' | ChesscomOutcome;
export type GamesColorFilter = 'all' | 'w' | 'b';

export interface GamesSummary {
  total: number;
  wins: number;
  draws: number;
  losses: number;
  score: number;
}

interface GamesPanelProps {
  me: string;
  summary: GamesSummary;
  failedArchives: number;
  analyzing: boolean;
  analyzeProgress: { current: number; total: number };
  analyzeStatus: string | null;
  onAnalyze: () => void;
  onCancelAnalyze: () => void;
  resultFilter: GamesResultFilter;
  onResultFilter: (filter: GamesResultFilter) => void;
  colorFilter: GamesColorFilter;
  onColorFilter: (filter: GamesColorFilter) => void;
  classFilter: string;
  onClassFilter: (filter: string) => void;
  classOptions: string[];
  showBots: boolean;
  onToggleBots: () => void;
  botGamesCount: number;
  /** Parties déjà filtrées (robots exclus sauf option). */
  games: ChesscomGame[];
  visibleCount: number;
  onShowMore: () => void;
  onOpenGame: (url: string) => void;
  /** Rappel pagination au changement de filtre. */
  onFilterApplied: () => void;
  outcomeLabel: Record<ChesscomOutcome, string>;
  outcomeColor: Record<ChesscomOutcome, string>;
  classLabels: Record<string, string>;
  formatCadence: (game: ChesscomGame) => string;
  formatDate: (endTimeSec: number) => string;
}

/** « 1 partie » / « 3 parties » (pas de « (s) »). */
function qty(n: number, one: string, many: string): string {
  return `${n.toLocaleString('fr-FR')} ${n > 1 ? many : one}`;
}

/**
 * Onglet « Parties » de Mes parties : résumé, analyse batch, filtres et
 * table des parties. La ligne entière reste cliquable à la souris, mais
 * l'ouverture au clavier passe par un vrai bouton « Rejouer » (pas de
 * `tr` focusable : une centaine de stops de tab en trop sinon).
 */
export const GamesPanel: React.FC<GamesPanelProps> = ({
  me,
  summary,
  failedArchives,
  analyzing,
  analyzeProgress,
  analyzeStatus,
  onAnalyze,
  onCancelAnalyze,
  resultFilter,
  onResultFilter,
  colorFilter,
  onColorFilter,
  classFilter,
  onClassFilter,
  classOptions,
  showBots,
  onToggleBots,
  botGamesCount,
  games,
  visibleCount,
  onShowMore,
  onOpenGame,
  onFilterApplied,
  outcomeLabel,
  outcomeColor,
  classLabels,
  formatCadence,
  formatDate,
}) => {
  const remaining = games.length - visibleCount;

  return (
    <div className="chesscom-left-column games-apple">
      <div className="panel-card">
        <div className="card-title-row">
          <h3 className="card-title">
            <List size={16} className="title-icon" aria-hidden="true" />
            Parties ({games.length.toLocaleString('fr-FR')})
          </h3>
        </div>

        <div className="chesscom-summary">
          <span><strong>{summary.total.toLocaleString('fr-FR')}</strong> parties</span>
          <span aria-hidden="true">•</span>
          <span>{summary.wins}V / {summary.draws}N / {summary.losses}D</span>
          <span aria-hidden="true">•</span>
          <span>Score {summary.score.toFixed(1)} %</span>
          {failedArchives > 0 && (
            <span className="text-muted" title="Archives mensuelles inaccessibles : leurs parties manquent">
              ({qty(failedArchives, 'archive ignorée', 'archives ignorées')})
            </span>
          )}
          {!analyzing ? (
            <button
              className="action-btn"
              onClick={onAnalyze}
              title="Précision en-croissant de chaque partie (Stockfish local, Win% Lichess). Long sur un gros historique — annulable à tout moment."
            >
              Analyser précision
            </button>
          ) : (
            <button
              className="action-btn"
              onClick={onCancelAnalyze}
              title="Interrompre l'analyse batch (les parties déjà traitées sont conservées)"
            >
              Annuler ({analyzeProgress.current}/{analyzeProgress.total})
            </button>
          )}
        </div>
        {analyzeStatus && (
          <div className="chesscom-analyze-status text-muted" role="status">
            {analyzeStatus}
          </div>
        )}

        {/* Filtres de la liste */}
        <div className="chesscom-filters">
          <div className="chesscom-filter-group" role="group" aria-label="Filtrer par issue">
            {(['all', 'win', 'draw', 'loss'] as GamesResultFilter[]).map((r) => (
              <button
                key={r}
                className={`db-toggle-btn ${resultFilter === r ? 'active' : ''}`}
                onClick={() => { onResultFilter(r); onFilterApplied(); }}
                aria-pressed={resultFilter === r}
              >
                <span>{r === 'all' ? 'Toutes' : outcomeLabel[r]}</span>
              </button>
            ))}
          </div>
          <div className="chesscom-filter-group" role="group" aria-label="Filtrer par couleur jouée">
            {(['all', 'w', 'b'] as GamesColorFilter[]).map((c) => (
              <button
                key={c}
                className={`db-toggle-btn ${colorFilter === c ? 'active' : ''}`}
                onClick={() => { onColorFilter(c); onFilterApplied(); }}
                aria-pressed={colorFilter === c}
              >
                <span>{c === 'all' ? 'Deux couleurs' : c === 'w' ? 'Blancs' : 'Noirs'}</span>
              </button>
            ))}
          </div>
          {classOptions.length > 1 && (
            <div className="chesscom-filter-group" role="group" aria-label="Filtrer par cadence">
              {['all', ...classOptions].map((c) => (
                <button
                  key={c}
                  className={`db-toggle-btn ${classFilter === c ? 'active' : ''}`}
                  onClick={() => { onClassFilter(c); onFilterApplied(); }}
                  aria-pressed={classFilter === c}
                >
                  <span>{c === 'all' ? 'Toutes cadences' : (classLabels[c] ?? c)}</span>
                </button>
              ))}
            </div>
          )}
          {botGamesCount > 0 && (
            <div className="chesscom-filter-group" role="group" aria-label="Parties d'entraînement contre les robots (exclues par défaut)">
              <button
                className={`db-toggle-btn ${showBots ? 'active' : ''}`}
                onClick={() => { onToggleBots(); onFilterApplied(); }}
                aria-pressed={showBots}
                title="Parties d'entraînement contre les robots (Coach-…, Mittens) : exclues par défaut"
              >
                <Bot size={14} aria-hidden="true" />
                <span>Robots ({botGamesCount})</span>
              </button>
            </div>
          )}
        </div>

        {games.length === 0 ? (
          <div className="empty-state">Aucune partie avec ces filtres.</div>
        ) : (
          <>
            <div className="table-scroll">
              <table className="chesscom-games-table">
                <thead>
                  <tr>
                    <th scope="col">Résultat</th>
                    <th scope="col">Adversaire</th>
                    <th scope="col">Couleur</th>
                    <th scope="col">Cadence</th>
                    <th scope="col" title="Nombre de coups (les deux camps)">Coups</th>
                    <th scope="col">Date</th>
                    <th scope="col" title="Précision en-croissant (Win% Lichess) de votre camp">Précision</th>
                    <th scope="col">
                      <span className="text-muted">Rejouer</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {games.slice(0, visibleCount).map((g) => {
                    const outcome = outcomeFor(g, me);
                    const mine = colorOf(g, me);
                    const opp = mine === 'w' ? g.black : g.white;
                    const myRating = mine === 'w' ? g.white.rating : g.black.rating;
                    const myAcc = g.accuracy;
                    return (
                      <tr key={g.url} onClick={() => onOpenGame(g.url)}>
                        <td>
                          <span className="ga-result">
                            <span
                              className="ga-dot"
                              aria-hidden="true"
                              style={{ '--ga-c': outcomeColor[outcome] } as React.CSSProperties}
                            />
                            <span style={{ color: outcomeColor[outcome], fontWeight: 600 }}>
                              {outcomeLabel[outcome]}
                            </span>
                          </span>
                        </td>
                        <td>
                          <strong>{opp.username}</strong>
                          <span className="text-muted"> ({opp.rating || '?'})</span>
                        </td>
                        <td>{mine === 'w' ? 'Blancs' : 'Noirs'} ({myRating || '?'})</td>
                        <td>{formatCadence(g)}</td>
                        <td className="num">{g.sans.length > 0 ? Math.ceil(g.sans.length / 2) : '—'}</td>
                        <td>{formatDate(g.end_time)}</td>
                        <td className="num">
                          {typeof myAcc === 'number' ? (
                            <span
                              style={{ color: accuracyColor(myAcc) }}
                              title={
                                `Vous : ${myAcc.toFixed(1)} %` +
                                (typeof g.whiteAccuracy === 'number' ? ` · Blancs ${g.whiteAccuracy.toFixed(1)} %` : '') +
                                (typeof g.blackAccuracy === 'number' ? ` · Noirs ${g.blackAccuracy.toFixed(1)} %` : '')
                              }
                            >
                              {myAcc.toFixed(0)}&nbsp;%
                            </span>
                          ) : (
                            <span className="text-muted">—</span>
                          )}
                        </td>
                        <td>
                          <button
                            className="action-btn btn-sm"
                            onClick={(e) => { e.stopPropagation(); onOpenGame(g.url); }}
                            aria-label={`Rejouer contre ${opp.username} (${outcomeLabel[outcome]})`}
                          >
                            <History size={13} aria-hidden="true" />
                            <span>Rejouer</span>
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {remaining > 0 && (
              <button className="primary-btn full-width" onClick={onShowMore}>
                <span>Afficher plus ({qty(remaining, 'restante', 'restantes')})</span>
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
};
