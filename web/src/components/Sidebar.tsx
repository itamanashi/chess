import React, { useEffect, useState } from 'react';
import type { RepertoireItem, StudioTab } from '../types/chess';
import { eloTargetLabel } from '../i18n';
import type { ChesscomAccount } from '../hooks/useChesscomAccount';
import type { PieceSkin } from '../storage/preferences';
import {
  BookOpen,
  Download,
  GitBranch,
  Globe,
  History,
  Library,
  RefreshCw,
  Link2,
  ShieldCheck,
  Target,
  Unlink,
  User,
  Wrench,
  X,
} from 'lucide-react';

interface SidebarProps {
  activeView: 'library' | 'studio';
  activeRepertoire: RepertoireItem | null;
  onBackToLibrary: () => void;
  /** Bibliothèque → studio sur l'onglet jeux, sans répertoire. */
  onOpenGames: () => void;
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
];

/** Compteur compact de pastille (12 345 → « 12,3 k »). */
function compactCount(n: number): string {
  if (n < 1000) return n.toLocaleString('fr-FR');
  const k = n / 1000;
  return `${k >= 100 ? Math.round(k) : (Math.round(k * 10) / 10).toLocaleString('fr-FR')} k`;
}

/**
 * Barre latérale (remplace l'ancien bandeau haut) : navigation toujours
 * visible — bibliothèque, onglets studio et « Mes parties » ne sont plus
 * cachés derrière le bouton « Étudier ». Sans répertoire actif, seuls
 * Bibliothèque et Mes parties sont accessibles (le reste est désactivé,
 * avec garde redondante dans handleChangeStudioTab).
 */
export const Sidebar: React.FC<SidebarProps> = ({
  activeView,
  activeRepertoire,
  onBackToLibrary,
  onOpenGames,
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
  // Carte compte dépliée au clic sur le profil (sinon chip compact).
  const [accountOpen, setAccountOpen] = useState(false);
  // Avatar en échec (URL morte) : on retombe sur l'initiale. Comparé à
  // l'URL courante (pas de setState dans un effet) : un nouvel avatar
  // réessaie naturellement.
  const [brokenAvatar, setBrokenAvatar] = useState<string | null>(null);
  const chessUser = account.linkedUser;
  const avatar = account.profile?.avatar ?? '';
  const showPhoto = !!avatar && brokenAvatar !== avatar;

  const handleTab = (tab: StudioTab): void => {
    if (tab === 'games' && !activeRepertoire) {
      onOpenGames();
      return;
    }
    onChangeStudioTab(tab);
  };

  // Raccourcis Alt+0 (bibliothèque) … Alt+6 (onglets studio) : inactifs en
  // saisie et sur les onglets désactivés (même garde que le clic).
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (!e.altKey || e.ctrlKey || e.metaKey) return;
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (/^[0-6]$/.test(e.key)) {
        e.preventDefault();
        if (e.key === '0') {
          if (inStudio) onBackToLibrary();
          return;
        }
        const tab = STUDIO_TABS.find((t) => t.shortcut === e.key);
        if (!tab) return;
        if (tab.key !== 'games' && !activeRepertoire) return;
        handleTab(tab.key);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inStudio, activeRepertoire, onBackToLibrary, onChangeStudioTab, onOpenGames]);

  const gamesCount = account.games.length;

  return (
    <aside className="app-sidebar">
      {inStudio ? (
        <button className="side-brand" onClick={onBackToLibrary} title="Retour à la bibliothèque">
          <span className="brand-logo">♞</span>
          <span className="side-brand-text">
            <span className="side-brand-name">Repertoire Studio</span>
            <span className="side-brand-sub">Ouvertures & entraînement</span>
          </span>
        </button>
      ) : (
        <div className="side-brand" title="Chess Repertoire Studio">
          <span className="brand-logo">♞</span>
          <span className="side-brand-text">
            <span className="side-brand-name">Repertoire Studio</span>
            <span className="side-brand-sub">Ouvertures & entraînement</span>
          </span>
        </div>
      )}

      <nav className="side-nav" aria-label="Navigation principale">
        <button
          className={`side-nav-btn ${!inStudio ? 'active' : ''}`}
          onClick={inStudio ? onBackToLibrary : undefined}
          disabled={!inStudio}
          aria-label="Bibliothèque"
          title={inStudio ? 'Retour à la bibliothèque (Alt+0)' : 'Vous êtes dans la bibliothèque (Alt+0)'}
        >
          <Library size={16} />
          <span>Bibliothèque</span>
        </button>

        <div className="side-nav-label">Studio</div>

        {STUDIO_TABS.map(({ key, label, hint, shortcut, Icon }) => {
          const needsRep = key !== 'games';
          const disabled = needsRep && !activeRepertoire;
          const active = inStudio && activeStudioTab === key;
          const showBadge = key === 'games' && gamesCount > 0;
          return (
            <button
              key={key}
              className={`side-nav-btn ${active ? 'active' : ''}`}
              onClick={() => handleTab(key)}
              disabled={disabled}
              aria-label={showBadge ? `${label}, ${gamesCount.toLocaleString('fr-FR')} parties` : label}
              title={disabled ? 'Ouvrez un répertoire pour accéder à cet onglet' : `${hint} (Alt+${shortcut})`}
            >
              <Icon size={16} />
              <span>{label}</span>
              {showBadge && (
                <span className="side-nav-badge" title={`${gamesCount.toLocaleString('fr-FR')} parties chargées`}>
                  {compactCount(gamesCount)}
                </span>
              )}
            </button>
          );
        })}
      </nav>

      {activeRepertoire && (
        <div className="side-context-card" title={activeRepertoire.title}>
          <div className="side-context-title">{activeRepertoire.title}</div>
          <div className="side-context-badges">
            <span className={`rep-color-tag-sm tag-${activeRepertoire.color}`}>
              {activeRepertoire.color === 'white' ? '♔ Blancs' : '♚ Noirs'}
            </span>
            <span className="rep-elo-tag-sm">
              <ShieldCheck size={12} />
              <span>{eloTargetLabel(activeRepertoire.targetElo)}</span>
            </span>
          </div>
          {repertoireStats && (
            <div className="side-context-stats">
              <span>{repertoireStats.totalPositions.toLocaleString('fr-FR')} pos</span>
              <span aria-hidden="true">•</span>
              <span>{repertoireStats.totalLines} lignes</span>
            </div>
          )}
        </div>
      )}

      <div className="side-spacer" />

      {activeRepertoire && (
        <div className="side-actions">
          <button className="side-action-btn" onClick={onExportPgn} title="Exporter en PGN">
            <Download size={15} />
            <span className="btn-label">PGN</span>
          </button>
          <button className="side-action-btn" onClick={onExportJson} title="Exporter en JSON">
            <Download size={15} />
            <span className="btn-label">JSON</span>
          </button>
        </div>
      )}

      <label className="side-piece-skin">
        <span className="form-label">Style des pièces</span>
        <select
          className="text-input"
          value={pieceSkin}
          onChange={(event) => onPieceSkinChange(event.currentTarget.value === 'unicode' ? 'unicode' : 'cburnett')}
        >
          <option value="cburnett">Classique</option>
          <option value="unicode">Symboles</option>
        </select>
      </label>

      {!accountOpen ? (
        chessUser ? (
          <button
            className="side-profile-chip"
            onClick={() => setAccountOpen(true)}
            aria-label={chessUser ? `Compte Chess.com : ${chessUser}` : 'Lier un compte Chess.com'}
            title={`Compte Chess.com : ${chessUser} — gérer le compte`}
          >
            {showPhoto ? (
              <img
                src={avatar}
                alt={`Photo de profil de ${chessUser}`}
                className="side-profile-photo"
                onError={() => setBrokenAvatar(avatar)}
              />
            ) : (
              <span className="side-profile-avatar" aria-hidden="true">
                {chessUser[0].toUpperCase()}
              </span>
            )}
            <span className="side-profile-name">@{chessUser}</span>
            {account.syncing && (
              <span className="side-sync-dot" title="Téléchargement de l'historique en cours…" aria-label="Téléchargement en cours" />
            )}
          </button>
        ) : (
          <button
            className="side-profile-chip"
            onClick={() => setAccountOpen(true)}
            aria-label="Lier un compte Chess.com"
            title="Lier un compte Chess.com"
          >
            <span className="side-profile-avatar" aria-hidden="true">
              <User size={15} />
            </span>
            <span className="side-profile-name">Lier Chess.com</span>
            {account.syncing && (
              <span className="side-sync-dot" title="Téléchargement de l'historique en cours…" aria-label="Téléchargement en cours" />
            )}
          </button>
        )
      ) : (
        <div className="side-account-card">
          <div className="side-account-head">
            <span className="side-nav-label">Compte Chess.com</span>
            <button className="icon-btn" onClick={() => setAccountOpen(false)} title="Fermer">
              <X size={14} />
            </button>
          </div>
          {showPhoto && (
            <img src={avatar} alt={`Photo de profil de ${chessUser}`} className="side-account-photo" onError={() => setBrokenAvatar(avatar)} />
          )}
          <label className="form-label" htmlFor="chesscom-username">Pseudo Chess.com</label>
          <input
            id="chesscom-username"
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
                className="side-action-btn"
                onClick={() => void account.startSync(account.linkedUser)}
                disabled={account.syncing}
              >
                <RefreshCw size={14} />
                <span className="btn-label">{account.syncing ? 'Téléchargement…' : 'Actualiser'}</span>
              </button>
              <button
                className="side-action-btn"
                onClick={account.handleUnlink}
                disabled={account.syncing}
                title="Dissocier ce compte"
              >
                <Unlink size={14} />
                <span className="btn-label">Dissocier</span>
              </button>
            </>
          ) : (
            <button
              className="side-action-btn"
              onClick={() => void account.startSync(account.username)}
              disabled={account.syncing || !account.username.trim()}
            >
              <Link2 size={14} />
              <span className="btn-label">{account.syncing ? 'Téléchargement…' : 'Lier et télécharger'}</span>
            </button>
          )}
          {account.syncing && account.progress.total > 0 && (
            <div className="side-account-progress">
              <div className="advice-scorebar" title="Téléchargement de l'historique">
                <div
                  className="advice-scorebar-fill"
                  style={{ width: `${Math.max(2, Math.round((account.progress.done / account.progress.total) * 100))}%` }}
                />
              </div>
              <div className="side-account-progress-row">
                <span className="text-muted">
                  {account.progress.done}/{account.progress.total}
                </span>
                <button className="side-action-btn" onClick={account.cancelSync} title="Annuler">
                  <X size={13} />
                </button>
              </div>
            </div>
          )}
          {account.error && <div className="mini-error-box"><span>{account.error}</span></div>}
          <button
            className="side-action-btn"
            onClick={() => {
              setAccountOpen(false);
              handleTab('games');
            }}
            title="Ouvrir l'onglet Mes parties"
          >
            <History size={14} />
            <span className="btn-label">Voir mes parties</span>
          </button>
        </div>
      )}
    </aside>
  );
};
