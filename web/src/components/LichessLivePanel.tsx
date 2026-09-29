import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { LichessApiResponse, LichessMove } from '../types/chess';
import { ELO_TARGET_OPTIONS } from '../types/chess';
import { fetchLichessMoves } from '../services/lichess';
import { frenchOpeningName } from '../utils/openingsFr';
import { normalizeCastleUci } from '../utils/repertoire';
import { isAbortError } from '../utils/async';
import { tokenStore } from '../storage/preferences';
import { 
  Globe, 
  Key, 
  Search, 
  PlusCircle, 
  Play, 
  AlertTriangle, 
  Check, 
  ExternalLink,
  Layers
} from 'lucide-react';

interface LichessLivePanelProps {
  currentFen: string;
  candidateUcis: ReadonlySet<string>;
  onPlayMoveFromLichess: (move: LichessMove) => void;
  onAddMoveToRepertoire: (move: LichessMove) => void;
  onHoverMove?: (uci: string | null) => void;
}

export const LichessLivePanel: React.FC<LichessLivePanelProps> = ({
  currentFen,
  candidateUcis,
  onPlayMoveFromLichess,
  onAddMoveToRepertoire,
  onHoverMove,
}) => {
  const [token, setToken] = useState(() => tokenStore.get());
  const [dbType, setDbType] = useState<'masters' | 'lichess'>('masters');
  const [autoQuery, setAutoQuery] = useState(true);
  const [loading, setLoading] = useState(false);
  const [offline, setOffline] = useState(false);
  const [result, setResult] = useState<LichessApiResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [errorContext, setErrorContext] = useState<string | null>(null);
  const [addedUcis, setAddedUcis] = useState<Set<string>>(new Set());
  const [requestContext, setRequestContext] = useState<string | null>(null);
  // Versioning des requêtes : seule la DERNIÈRE réponse s'affiche. La
  // précédente est annulée (AbortController) et son résultat ignoré même
  // si l'annulation arrive trop tard (garde sur le n° de séquence + FEN).
  const querySeq = useRef(0);
  const queryAbort = useRef<AbortController | null>(null);
  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Annulation stable (appelée par handleQuery et le cleanup de démontage).
  const cancelPendingQuery = useCallback(() => {
    querySeq.current++;
    queryAbort.current?.abort();
    queryAbort.current = null;
    if (debounceTimer.current) {
      clearTimeout(debounceTimer.current);
      debounceTimer.current = null;
    }
  }, []);

  // Démontage : aucune réponse en vol ne doit toucher l'état.
  useEffect(() => {
    return () => cancelPendingQuery();
  }, [cancelPendingQuery]);

  const handleSaveToken = (val: string) => {
    setToken(val);
    tokenStore.set(val);
  };

  const handleQuery = useCallback(async () => {
    if (debounceTimer.current) {
      clearTimeout(debounceTimer.current);
      debounceTimer.current = null;
    }
    const id = ++querySeq.current;
    queryAbort.current?.abort();
    const ctrl = new AbortController();
    queryAbort.current = ctrl;
    // Fige le contexte : si la position ou la base change pendant le vol,
    // la réponse est obsolète et ne doit pas écraser l'affichage.
    const fenSnap = currentFen;
    const dbSnap = dbType;
    const context = `${dbSnap}:${fenSnap}`;
    // Même filtre temporel que le Builder sur la base Masters (audit A7).
    const sinceSnap =
      dbSnap === 'masters'
        ? ELO_TARGET_OPTIONS.find((o) => o.key === 'masters')?.since
        : undefined;
    setLoading(true);
    setError(null);
    setErrorContext(null);
    setRequestContext(context);
    setOffline(false);
    setResult(null);
    try {
      const data = await fetchLichessMoves(fenSnap, token, dbSnap, undefined, undefined, {
        signal: ctrl.signal,
        since: sinceSnap,
      });
      if (querySeq.current !== id || ctrl.signal.aborted) return;
      setResult(data);
      setOffline(false);
    } catch (err) {
      if (isAbortError(err) || querySeq.current !== id) return;
      setError(err instanceof Error ? err.message : String(err));
      setErrorContext(context);
      setResult(null);
      setOffline(true);
    } finally {
      if (queryAbort.current === ctrl) {
        queryAbort.current = null;
        setLoading(false);
      } else if (queryAbort.current === null && querySeq.current !== id) {
        setLoading(false);
      }
    }
  }, [currentFen, dbType, token]);

  useEffect(() => {
    if (!autoQuery) {
      cancelPendingQuery();
      return;
    }
    const timer = window.setTimeout(() => {
      debounceTimer.current = null;
      void handleQuery();
    }, 300);
    debounceTimer.current = timer;
    return () => {
      window.clearTimeout(timer);
      if (debounceTimer.current === timer) debounceTimer.current = null;
      cancelPendingQuery();
    };
  }, [autoQuery, cancelPendingQuery, currentFen, dbType, handleQuery]);

  const handleAdd = (m: LichessMove) => {
    onAddMoveToRepertoire(m);
    setAddedUcis((prev) => new Set(prev).add(normalizeCastleUci(currentFen, m.uci)));
  };

  const contextKey = `${dbType}:${currentFen}`;
  const resultForCurrentPosition = requestContext === contextKey ? result : null;
  const errorForCurrentPosition = errorContext === contextKey ? error : null;
  const totalGames = resultForCurrentPosition
    ? resultForCurrentPosition.white + resultForCurrentPosition.draws + resultForCurrentPosition.black
    : 0;
  const isCurrentLoading = loading && requestContext === contextKey;
  const isCurrentOffline = offline && errorContext === contextKey;
  const statusLabel = isCurrentLoading
    ? 'Interrogation en cours'
    : isCurrentOffline
      ? 'Hors ligne'
      : resultForCurrentPosition
        ? 'En ligne'
        : autoQuery
          ? 'Recherche automatique'
          : 'Auto désactivé';

  return (
    <div className="lichess-live-panel">
      {/* Carte Configuration Token et Base */}
      <div className="panel-card lichess-auth-card">
        <div className="card-title-row">
          <h3 className="card-title">
            <Globe size={16} className="title-icon" />
            Explorateur Lichess Live
          </h3>
          <a 
            href="https://lichess.org/account/oauth/token" 
            target="_blank" 
            rel="noopener noreferrer"
            className="link-btn"
            title="Créer un token gratuit sur Lichess"
          >
            <span>Obtenir un token</span>
            <ExternalLink size={12} />
          </a>
        </div>

        <label className="form-label" htmlFor="lichess-token">Token Lichess (requis depuis mars 2026)</label>
        <div className="token-input-row">
          <div className="input-with-icon">
            <Key size={15} className="input-icon" aria-hidden="true" />
            <input
              id="lichess-token"
              type="password"
              className="text-input"
              placeholder="Token Lichess (lip_...)"
              autoComplete="off"
              value={token}
              onChange={(e) => handleSaveToken(e.target.value)}
            />
          </div>
        </div>
        <div className="token-hint">
          Le token reste sécurisé uniquement dans votre navigateur local.
        </div>

        <div className="db-toggle-row">
          <button
            className={`db-toggle-btn ${dbType === 'masters' ? 'active' : ''}`}
            aria-pressed={dbType === 'masters'}
            onClick={() => setDbType('masters')}
          >
            <Layers size={14} />
            <span>Grands Maîtres (Masters)</span>
          </button>
          <button
            className={`db-toggle-btn ${dbType === 'lichess' ? 'active' : ''}`}
            aria-pressed={dbType === 'lichess'}
            onClick={() => setDbType('lichess')}
          >
            <Globe size={14} />
            <span>Communauté Lichess</span>
          </button>
        </div>

        <label className="live-auto-toggle">
          <input
            type="checkbox"
            checked={autoQuery}
            onChange={(event) => {
              if (!event.target.checked) {
                cancelPendingQuery();
                setLoading(false);
                setOffline(false);
                setError(null);
                setErrorContext(null);
              }
              setAutoQuery(event.target.checked);
            }}
          />
          <span>Interroger automatiquement la position</span>
        </label>

        <button 
          className="primary-btn full-width" 
          onClick={handleQuery} 
          disabled={isCurrentLoading}
        >
          <Search size={16} />
          <span>{isCurrentLoading ? 'Interrogation en cours...' : 'Interroger la position actuelle'}</span>
        </button>
        <span
          className={`lichess-status-badge ${isCurrentOffline ? 'offline' : resultForCurrentPosition ? 'online' : ''}`}
          role="status"
          aria-live="polite"
        >
          {statusLabel}
        </span>
      </div>

      {/* Affichage des Erreurs */}
      {errorForCurrentPosition && (
        <div className="panel-card error-card" role="alert">
          <div className="error-header">
            <AlertTriangle size={18} className="text-rose" />
            <h4>Erreur Lichess</h4>
          </div>
          <p className="error-text">{errorForCurrentPosition}</p>
        </div>
      )}

      {/* Résultats de l'API Lichess */}
      {resultForCurrentPosition && (
        <div className="panel-card lichess-results-card">
          <div className="results-header">
            <h3 className="card-title">
              Coups les plus joués
            </h3>
            <span className="lichess-total-games">
              {totalGames.toLocaleString('fr-FR')} parties
            </span>
            {resultForCurrentPosition.opening && (
              <span className="opening-badge">
                {resultForCurrentPosition.opening.eco && `[${resultForCurrentPosition.opening.eco}] `}
                {frenchOpeningName(resultForCurrentPosition.opening.name)}
              </span>
            )}
          </div>

          {resultForCurrentPosition.moves.length === 0 ? (
            <div className="empty-state">Aucun coup trouvé dans la base pour cette position.</div>
          ) : (
            <div className="lichess-moves-list" role="list" aria-label="Coups de la base Lichess">
              {resultForCurrentPosition.moves.map((m, idx) => {
                const parties = m.white + m.draws + m.black;
                const pct = totalGames > 0 ? Math.round((parties / totalGames) * 100) : 0;
                const pw = parties > 0 ? Math.round((m.white / parties) * 100) : 0;
                const pd = parties > 0 ? Math.round((m.draws / parties) * 100) : 0;
                const pb = parties > 0 ? Math.round((m.black / parties) * 100) : 0;
                const normalizedUci = normalizeCastleUci(currentFen, m.uci);
                const isInRepertoire = candidateUcis.has(normalizedUci);
                const isAdded = isInRepertoire || addedUcis.has(normalizedUci);

                return (
                  <div
                    key={idx}
                    className="lichess-move-row"
                    role="listitem"
                    onMouseEnter={() => onHoverMove?.(m.uci)}
                    onMouseLeave={() => onHoverMove?.(null)}
                  >
                    <div className="move-main-info">
                      <div className="san-badge-group">
                        <span className="move-rank-num">{idx + 1}</span>
                        <span className="move-san-text">{m.san}</span>
                        {m.opening?.eco && <span className="eco-tag">{m.opening.eco}</span>}
                      </div>
                      <div className="move-stats-num">
                        <strong>{parties.toLocaleString('fr-FR')}</strong> parties ({pct}%)
                      </div>
                    </div>

                    {m.opening?.name && (
                      <div className="move-opening-subname">{frenchOpeningName(m.opening.name)}</div>
                    )}

                    {/* Barre de répartition */}
                    <div className="result-bar-compact">
                      <div className="bar-white" style={{ width: `${pw}%` }}>
                        {pw > 18 && `${pw}%`}
                      </div>
                      <div className="bar-draw" style={{ width: `${pd}%` }}>
                        {pd > 18 && `${pd}%`}
                      </div>
                      <div className="bar-black" style={{ width: `${pb}%` }}>
                        {pb > 18 && `${pb}%`}
                      </div>
                    </div>

                    {/* Actions : Jouer ou Ajouter au répertoire */}
                    <div className="move-action-buttons">
                      <button 
                        className="action-btn play-action"
                        onClick={() => onPlayMoveFromLichess(m)}
                        title="Jouer ce coup sur l'échiquier"
                        aria-label={`Jouer ${m.san} sur l'échiquier`}
                      >
                        <Play size={13} />
                        <span>Jouer</span>
                      </button>
                      <button 
                        className={`action-btn add-action ${isAdded ? 'added' : ''}`}
                        onClick={() => handleAdd(m)}
                        disabled={isAdded}
                        title={isInRepertoire ? 'Ce coup est déjà dans votre répertoire' : 'Ajouter ce coup à votre répertoire'}
                        aria-label={isAdded ? `${m.san}, déjà dans votre répertoire` : `${m.san}, ajouter au répertoire`}
                      >
                        {isAdded ? (
                          <>
                            <Check size={13} />
                            <span>Ajouté !</span>
                          </>
                        ) : (
                          <>
                            <PlusCircle size={13} />
                            <span>Au répertoire</span>
                          </>
                        )}
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
};
