import React, { useEffect, useState } from 'react';
import type { RepertoireItem, StudioTab } from '../types/chess';
import { eloTargetLabel } from '../i18n';
import type { ChesscomAccount } from '../hooks/useChesscomAccount';
import type { PieceSkin } from '../storage/preferences';
import BrandMark from './BrandMark';
import '../styles/sidebar.apple-design.css';
import {
  BookOpen,
  ChevronRight,
  Download,
  GitBranch,
  Globe,
  History,
  Library,
  ScanSearch,
  RefreshCw,
  Link2,
  ShieldCheck,
  Target,
  Unlink,
  User,
  Wrench,
  X,
} from 'lucide-react';

/* ------------------------------------------------------------------
 * Barre latérale « apple-design » (promue officielle) : navigation,
 * contexte, compte. Principes WWDC « Designing Fluid Interfaces »
 * traduits en CSS : feedback :active immédiat (pointer-down, pas au
 * relâchement), ressorts émulés interruptibles, matériau translucide
 * hiérarchisé, groupes « réglages », type optique, reduced-motion /
 * reduced-transparency.
 * ------------------------------------------------------------------ */

export interface SidebarProps {
  activeView: 'library' | 'studio';
  activeRepertoire: RepertoireItem | null;
  onBackToLibrary: () => void;
  /** Bibliothèque → studio sur l'onglet jeux, sans répertoire. */
  onOpenGames: () => void;
  /** Bibliothèque → analyse, sans répertoire. */
  onOpenAnalysis: () => void;
  activeStudioTab: StudioTab;
  onChangeStudioTab: (tab: StudioTab) => void;
  repertoireStats?: {
    totalPositions: number;
    maxDepth: number;
    totalLines: number;
  };
  onExportJson?: () => void;
  onExportPgn?: () => void;
  /** Compte Chess.com partagé (carte compte en bas de sidebar). */
  account: ChesscomAccount;
  pieceSkin: PieceSkin;
  onPieceSkinChange: (skin: PieceSkin) => void;
}

interface TabDef {
  key: StudioTab;
  label: string;
  hint: string;
  /** Raccourci Alt+chiffre (affiché dans le title, géré au clavier). */
  shortcut: string;
  Icon: typeof Wrench;
}

const STUDIO_TABS: TabDef[] = [
  { key: 'builder', label: 'Constructeur', hint: 'Construire et explorer les réponses de l\u2019adversaire', shortcut: '1', Icon: Wrench },
  { key: 'explorer', label: 'Explorateur', hint: 'Arbre complet et statistiques de variantes', shortcut: '2', Icon: BookOpen },
  { key: 'tree', label: 'Arbre', hint: 'Arbre graphique des variantes du répertoire', shortcut: '3', Icon: GitBranch },
  { key: 'trainer', label: 'Entraînement', hint: 'S\u2019entraîner activement contre les coups adverses', shortcut: '4', Icon: Target },
  { key: 'live', label: 'Lichess Live', hint: 'Interroger Lichess Live', shortcut: '5', Icon: Globe },
  { key: 'games', label: 'Mes parties', hint: "Mes parties Chess.com : historique, navigation et statistiques d'ouvertures", shortcut: '6', Icon: History },
  { key: 'analysis', label: 'Analyse', hint: 'Analyser la position avec Stockfish et comparer les variantes', shortcut: '7', Icon: ScanSearch },
];

const PIECE_PREVIEW: Array<'king' | 'queen' | 'rook' | 'bishop' | 'knight' | 'pawn'> = [
  'king',
  'queen',
  'knight',
  'rook',
  'bishop',
  'pawn',
];
const PIECE_SKINS: Array<{ id: PieceSkin; label: string }> = [
  { id: 'cburnett', label: 'Classique' },
  { id: 'chessnut', label: 'Gravure' },
  { id: 'merida', label: 'Merida' },
  { id: 'fantasy', label: 'Fantasy' },
  { id: 'alpha', label: 'Alpha' },
  { id: 'staunty', label: 'Staunty' },
  { id: 'pirouetti', label: 'Pirouetti' },
  { id: 'tatiana', label: 'Tatiana' },
  { id: 'california', label: 'California' },
];

/** Compteur compact de pastille (12 345 → « 12,3 k ») : identique à l'original. */
function compactCount(n: number): string {
  if (n < 1000) return n.toLocaleString('fr-FR');
  const k = n / 1000;
  return `${k >= 100 ? Math.round(k) : (Math.round(k * 10) / 10).toLocaleString('fr-FR')} k`;
}

export const Sidebar: React.FC<SidebarProps> = ({
  activeView,
  activeRepertoire,
  onBackToLibrary,
  onOpenGames,
  onOpenAnalysis,
  activeStudioTab,
  onChangeStudioTab,
  repertoireStats,
  onExportJson,
  onExportPgn,
  account,
  pieceSkin,
  onPieceSkinChange,
}) => {
  const inStudio = activeView === 'studio';
  const [accountOpen, setAccountOpen] = useState(false);
  const [pieceSkinsOpen, setPieceSkinsOpen] = useState(false);
  const [brokenAvatar, setBrokenAvatar] = useState<string | null>(null);
  const chessUser = account.linkedUser;
  const avatar = account.profile?.avatar ?? '';
  const showPhoto = !!avatar && brokenAvatar !== avatar;

  const handleTab = (tab: StudioTab): void => {
    if (tab === 'games' && !activeRepertoire) {
      onOpenGames();
      return;
    }
    if (tab === 'analysis' && !activeRepertoire) {
      onOpenAnalysis();
      return;
    }
    onChangeStudioTab(tab);
  };

  // Raccourcis Alt+0 … Alt+7 : identiques à l'original (mêmes gardes).
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (!e.altKey || e.ctrlKey || e.metaKey) return;
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (/^[0-7]$/.test(e.key)) {
        e.preventDefault();
        if (e.key === '0') {
          if (inStudio) onBackToLibrary();
          return;
        }
        const tab = STUDIO_TABS.find((t) => t.shortcut === e.key);
        if (!tab) return;
        if (tab.key !== 'games' && tab.key !== 'analysis' && !activeRepertoire) return;
        handleTab(tab.key);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inStudio, activeRepertoire, onBackToLibrary, onChangeStudioTab, onOpenGames, onOpenAnalysis]);

  const gamesCount = account.games.length;
  const skinLabel = PIECE_SKINS.find(({ id }) => id === pieceSkin)?.label ?? 'Classique';

  return (
    <aside className="asa-sidebar" aria-label="Barre latérale">
      {inStudio ? (
        <button type="button" className="asa-brand" onClick={onBackToLibrary} title="Retour à la bibliothèque">
          <span className="asa-brand-mark" aria-hidden="true"><BrandMark /></span>
          <span className="asa-brand-text">
            <span className="asa-brand-name">Repertoire Studio</span>
            <span className="asa-brand-sub">Ouvertures & entraînement</span>
          </span>
          <ChevronRight size={15} className="asa-brand-chevron" aria-hidden="true" />
        </button>
      ) : (
        <div className="asa-brand" title="Chess Repertoire Studio">
          <span className="asa-brand-mark" aria-hidden="true"><BrandMark /></span>
          <span className="asa-brand-text">
            <span className="asa-brand-name">Repertoire Studio</span>
            <span className="asa-brand-sub">Ouvertures & entraînement</span>
          </span>
        </div>
      )}

      <nav className="asa-group" aria-label="Navigation principale">
        <button
          type="button"
          className={`asa-cell ${!inStudio ? 'is-active' : ''}`}
          onClick={inStudio ? onBackToLibrary : undefined}
          disabled={!inStudio}
          aria-label="Bibliothèque"
          title={inStudio ? 'Retour à la bibliothèque (Alt+0)' : 'Vous êtes dans la bibliothèque (Alt+0)'}
        >
          <Library size={17} aria-hidden="true" />
          <span className="asa-cell-label">Bibliothèque</span>
        </button>
      </nav>

      <div className="asa-kicker" aria-hidden="true">Studio</div>

      <nav className="asa-group" aria-label="Onglets du studio">
        {STUDIO_TABS.map(({ key, label, hint, shortcut, Icon }) => {
          const needsRep = key !== 'games' && key !== 'analysis';
          const disabled = needsRep && !activeRepertoire;
          const active = inStudio && activeStudioTab === key;
          const showBadge = key === 'games' && gamesCount > 0;
          return (
            <button
              key={key}
              type="button"
              className={`asa-cell ${active ? 'is-active' : ''}`}
              onClick={() => handleTab(key)}
              disabled={disabled}
              aria-label={showBadge ? `${label}, ${gamesCount.toLocaleString('fr-FR')} parties` : label}
              title={disabled ? 'Ouvrez un répertoire pour accéder à cet onglet' : `${hint} (Alt+${shortcut})`}
            >
              <Icon size={17} aria-hidden="true" />
              <span className="asa-cell-label">{label}</span>
              {showBadge && (
                <span className="asa-badge" title={`${gamesCount.toLocaleString('fr-FR')} parties chargées`}>
                  {compactCount(gamesCount)}
                </span>
              )}
            </button>
          );
        })}
      </nav>

      {activeRepertoire && (
        <div className="asa-group asa-context" title={activeRepertoire.title}>
          <div className="asa-context-title">{activeRepertoire.title}</div>
          <div className="asa-context-badges">
            <span className={`rep-color-tag-sm tag-${activeRepertoire.color}`}>
              {activeRepertoire.color === 'white' ? '♔ Blancs' : '♚ Noirs'}
            </span>
            <span className="rep-elo-tag-sm">
              <ShieldCheck size={12} />
              <span>{eloTargetLabel(activeRepertoire.targetElo)}</span>
            </span>
          </div>
          {repertoireStats && (
            <div className="asa-context-stats">
              <span>{repertoireStats.totalPositions.toLocaleString('fr-FR')} pos</span>
              <span aria-hidden="true">•</span>
              <span>{repertoireStats.totalLines} lignes</span>
            </div>
          )}
        </div>
      )}

      <div className="asa-spacer" />

      {activeRepertoire && (
        <div className="asa-exports">
          <button type="button" className="asa-btn" onClick={onExportPgn} title="Exporter en PGN">
            <Download size={15} aria-hidden="true" />
            <span>PGN</span>
          </button>
          <button type="button" className="asa-btn" onClick={onExportJson} title="Exporter en JSON">
            <Download size={15} aria-hidden="true" />
            <span>JSON</span>
          </button>
        </div>
      )}

      <section className="asa-group asa-disclosure" aria-labelledby="asa-piece-skin-title">
        <button
          type="button"
          className="asa-cell"
          aria-expanded={pieceSkinsOpen}
          aria-controls="asa-piece-skin-options"
          onClick={() => setPieceSkinsOpen((open) => !open)}
        >
          <span className="asa-cell-label" id="asa-piece-skin-title">Style des pièces</span>
          {!pieceSkinsOpen && <span className="asa-cell-value">{skinLabel}</span>}
          <ChevronRight
            size={15}
            aria-hidden="true"
            className={`asa-chevron ${pieceSkinsOpen ? 'is-open' : ''}`}
          />
        </button>
        <div
          id="asa-piece-skin-options"
          className={`asa-skin-options ${pieceSkinsOpen ? 'is-open' : ''}`}
          hidden={!pieceSkinsOpen}
        >
          {PIECE_SKINS.map(({ id, label }) => (
            <label key={id} className={`asa-skin-option ${pieceSkin === id ? 'is-selected' : ''}`}>
              <input
                type="radio"
                name="asa-piece-skin"
                value={id}
                checked={pieceSkin === id}
                onChange={() => onPieceSkinChange(id)}
              />
              <span className="piece-skin-preview cg-wrap" data-piece-skin={id} aria-hidden="true">
                {PIECE_PREVIEW.map((type, index) => (
                  <span key={type} className={`piece-skin-preview-square ${index % 2 === 0 ? 'is-light' : 'is-dark'}`}>
                    <span className={`cg-piece ${index < 3 ? 'white' : 'black'} ${type}`} />
                  </span>
                ))}
              </span>
              <span className="asa-skin-name">{label}</span>
            </label>
          ))}
        </div>
      </section>

      {!accountOpen ? (
        <button
          type="button"
          className="asa-profile"
          onClick={() => setAccountOpen(true)}
          aria-label={chessUser ? `Compte Chess.com : ${chessUser}` : 'Lier un compte Chess.com'}
          title={chessUser ? `Compte Chess.com : ${chessUser} — gérer le compte` : 'Lier un compte Chess.com'}
        >
          {chessUser ? (
            showPhoto ? (
              <img
                src={avatar}
                alt={`Photo de profil de ${chessUser}`}
                className="asa-avatar"
                onError={() => setBrokenAvatar(avatar)}
              />
            ) : (
              <span className="asa-avatar asa-avatar-fallback" aria-hidden="true">
                {chessUser[0].toUpperCase()}
              </span>
            )
          ) : (
            <span className="asa-avatar asa-avatar-fallback" aria-hidden="true">
              <User size={15} />
            </span>
          )}
          <span className="asa-cell-label">{chessUser ? `@${chessUser}` : 'Lier Chess.com'}</span>
          {account.syncing && (
            <span className="side-sync-dot" title="Téléchargement de l'historique en cours…" aria-label="Téléchargement en cours" />
          )}
          <ChevronRight size={15} className="asa-chevron" aria-hidden="true" />
        </button>
      ) : (
        <div className="asa-group asa-account">
          <div className="asa-account-head">
            <span className="asa-kicker">Compte Chess.com</span>
            <button type="button" className="asa-icon-btn" onClick={() => setAccountOpen(false)} title="Fermer">
              <X size={14} />
            </button>
          </div>
          {showPhoto && (
            <img src={avatar} alt={`Photo de profil de ${chessUser}`} className="asa-account-photo" onError={() => setBrokenAvatar(avatar)} />
          )}
          <label className="form-label" htmlFor="asa-chesscom-username">Pseudo Chess.com</label>
          <input
            id="asa-chesscom-username"
            type="text"
            className="text-input"
            placeholder="Pseudo (ex. hikaru)"
            autoComplete="username"
            value={account.username}
            disabled={account.syncing}
            onChange={(e) => account.setUsername(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void account.startSync(account.username);
            }}
          />
          {chessUser && account.linkedUser === account.username.trim().toLowerCase() && account.username.trim() !== '' ? (
            <>
              <button
                type="button"
                className="asa-btn"
                onClick={() => void account.startSync(account.linkedUser)}
                disabled={account.syncing}
              >
                <RefreshCw size={14} aria-hidden="true" />
                <span>{account.syncing ? 'Téléchargement…' : 'Actualiser'}</span>
              </button>
              <button
                type="button"
                className="asa-btn"
                onClick={account.handleUnlink}
                disabled={account.syncing}
                title="Dissocier ce compte"
              >
                <Unlink size={14} aria-hidden="true" />
                <span>Dissocier</span>
              </button>
            </>
          ) : (
            <button
              type="button"
              className="asa-btn"
              onClick={() => void account.startSync(account.username)}
              disabled={account.syncing || !account.username.trim()}
            >
              <Link2 size={14} aria-hidden="true" />
              <span>{account.syncing ? 'Téléchargement…' : 'Lier et télécharger'}</span>
            </button>
          )}
          {account.syncing && account.progress.total > 0 && (
            <div className="asa-progress">
              <div className="advice-scorebar" title="Téléchargement de l'historique">
                <div
                  className="advice-scorebar-fill"
                  style={{ width: `${Math.max(2, Math.round((account.progress.done / account.progress.total) * 100))}%` }}
                />
              </div>
              <div className="asa-progress-row">
                <span className="text-muted">
                  {account.progress.done}/{account.progress.total}
                </span>
                <button type="button" className="asa-icon-btn" onClick={account.cancelSync} title="Annuler">
                  <X size={13} />
                </button>
              </div>
            </div>
          )}
          {account.error && <div className="mini-error-box"><span>{account.error}</span></div>}
          <button
            type="button"
            className="asa-btn"
            onClick={() => {
              setAccountOpen(false);
              handleTab('games');
            }}
            title="Ouvrir l'onglet Mes parties"
          >
            <History size={14} aria-hidden="true" />
            <span>Voir mes parties</span>
          </button>
        </div>
      )}
    </aside>
  );
};
