import React, { useEffect, useMemo, useState } from 'react';
import type { RepertoireItem, RepertoireMove, RepertoireRoot, BoardOrientation, EloTargetKey, StudioTab } from '../types/chess';
import { ELO_TARGET_OPTIONS } from '../types/chess';
import { eloTargetDescription, eloTargetLabel } from '../i18n';
import { downloadFile } from '../utils/repertoire';
import { formatDuration, formatEval } from '../utils/formatGames';
import { computeRepCardStats } from '../utils/repCardStats';
import { getStudyTime } from '../storage/studyTime';
import { loadTrainerReviews } from '../storage/trainerReviews';
import { ConfirmDialog } from './ConfirmDialog';
import { MiniBoard } from './MiniBoard';
import {
  Plus,
  BookOpen,
  ChevronRight,
  MoreVertical,
  Target,
  Trash2,
  Download,
  ListTree
} from 'lucide-react';

interface RepertoireLibraryProps {
  repertoires: RepertoireItem[];
  onOpenRepertoire: (rep: RepertoireItem, initialTab?: StudioTab) => void;
  onCreateRepertoire: (title: string, color: BoardOrientation, targetElo: EloTargetKey) => void;
  onDeleteRepertoire: (id: string) => void;
}

/**
 * Lignes complètes (position initiale → feuille), les plus jouées d'abord,
 * plafonnées : l'aperçu animé rejoue une ligne entière comme une vraie
 * partie, puis repart du début pour la ligne suivante.
 */
function repertoireLineFens(root: RepertoireRoot, maxLines = 8, maxPlies = 40): string[] {
  const lines: string[][] = [];
  const walk = (moves: RepertoireMove[] | undefined, current: string[]): void => {
    if (lines.length >= maxLines) return;
    if (!moves || moves.length === 0) {
      if (current.length > 1) lines.push(current);
      return;
    }
    const ordered = [...moves].sort((a, b) => (b.parties || 0) - (a.parties || 0));
    for (const m of ordered) {
      if (lines.length >= maxLines) return;
      const next = [...current, m.fen];
      if (!m.children || m.children.length === 0 || next.length - 1 >= maxPlies) {
        lines.push(next);
      } else {
        walk(m.children, next);
      }
    }
  };
  walk(root.children || [], [root.fen]);
  const flat = lines.flat();
  return flat.length > 0 ? flat : [root.fen];
}

/**
 * Aperçu animé : fait défiler tout l'arbre (~1 position/s, en boucle).
 * Statique si une seule position ou mouvement réduit demandé.
 */
const AnimatedBoard: React.FC<{ fens: string[]; orientation: 'w' | 'b' }> = ({ fens, orientation }) => {
  const [idx, setIdx] = useState(0);
  useEffect(() => {
    if (fens.length < 2) return;
    if (typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
    const id = window.setInterval(() => {
      setIdx((i) => (i + 1) % fens.length);
    }, 1100);
    return () => window.clearInterval(id);
  }, [fens]);
  return <MiniBoard fen={fens[Math.min(idx, fens.length - 1)] ?? fens[0]} orientation={orientation} />;
};

/**
 * Titre affiché : sans le suffixe auto « (Niveau Elo) » — les anciens
 * répertoires créés avec l'ancien gabarit l'ont stocké dans leur titre,
 * on le retire à l'affichage (données intactes).
 */
function displayRepTitle(rep: RepertoireItem): string {
  const suffix = ` (${eloTargetLabel(rep.targetElo)})`;
  return rep.title.endsWith(suffix) ? rep.title.slice(0, -suffix.length) : rep.title;
}

/**
 * Libellé sobre de dernière étude (« Étudié hier », « Étudié le 12 sept. »).
 */
function formatLastStudy(at: number | null): string {
  if (at === null || !Number.isFinite(at) || at <= 0) return 'Pas encore étudié';
  const diff = Date.now() - at;
  if (diff < 0) return 'Pas encore étudié';
  const days = Math.floor(diff / 86400000);
  if (days <= 0) return "Étudié aujourd'hui";
  if (days === 1) return 'Étudié hier';
  if (days < 30) return `Étudié il y a ${days} j`;
  return `Étudié le ${new Date(at).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' })}`;
}
/**
 * Elo court pour le titre : le libellé sans la parenthèse de niveau
 * (« 400 - 1000 Elo (Débutants) » → « 400 - 1000 Elo »).
 */
function eloShort(key: EloTargetKey): string {
  return eloTargetLabel(key).replace(/\s*\(.*?\)\s*$/, '').trim() || key;
}

export const RepertoireLibrary: React.FC<RepertoireLibraryProps> = ({
  repertoires,
  onOpenRepertoire,
  onCreateRepertoire,
  onDeleteRepertoire,
}) => {
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [newColor, setNewColor] = useState<BoardOrientation>('black');
  const [newTargetElo, setNewTargetElo] = useState<EloTargetKey>('all_700');
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);
  const pendingDeleteRep = pendingDeleteId ? repertoires.find((r) => r.id === pendingDeleteId) ?? null : null;
  // Lignes complètes par répertoire (stable entre rendus : l'animation
  // ne redémarre pas à chaque ouverture de menu).
  const walkFens = useMemo(() => {
    const m = new Map<string, string[]>();
    for (const r of repertoires) m.set(r.id, repertoireLineFens(r.root));
    return m;
  }, [repertoires]);

  // Totaux réels pour la preuve du hero (mêmes sources que les cartes).
  const totals = useMemo(() => {
    const reviews = loadTrainerReviews();
    let variantes = 0;
    let studyMs = 0;
    for (const r of repertoires) {
      variantes += computeRepCardStats(r.root, r.color, r.id, reviews).variantes;
      studyMs += getStudyTime(r.id);
    }
    return { variantes, studyMs };
  }, [repertoires]);

  const handleCreateSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const title = newTitle.trim() || `Répertoire ${newColor === 'white' ? 'Blancs' : 'Noirs'}`;
    onCreateRepertoire(title, newColor, newTargetElo);
    setNewTitle('');
    setIsModalOpen(false);
  };

  return (
    <div className="library-view-container">
      <div className="library-hero-section">
        <div className="hero-content">
          <span className="hero-kicker">Carnet d'ouvertures</span>
          <h1>Bibliothèque</h1>
          <p className="hero-description">
            Retrouvez vos lignes par couleur et par niveau, puis reprenez l'étude là où vous l'avez laissée.
          </p>
          {repertoires.length > 0 && (
            <p className="hero-proof">
              <strong>{repertoires.length} {repertoires.length === 1 ? 'répertoire' : 'répertoires'}</strong>
              <span aria-hidden="true"> · </span>
              {totals.variantes.toLocaleString('fr-FR')} variantes
              <span aria-hidden="true"> · </span>
              {formatDuration(totals.studyMs)} d'étude
            </p>
          )}
        </div>

        <div className="hero-action-buttons">
          <button className="primary-btn" onClick={() => setIsModalOpen(true)}>
            <Plus size={18} />
            <span>Nouveau répertoire</span>
          </button>
        </div>
      </div>

<div className="repertoires-section">
        <div className="library-section-header">
          <h2>Vos répertoires</h2>
          <span className="library-count">
            {repertoires.length} {repertoires.length === 1 ? 'répertoire' : 'répertoires'}
          </span>
        </div>

        <div className="repertoires-grid">
        {repertoires.length === 0 ? (
          <div className="empty-library-card">
            <div className="empty-icon-wrap">♞</div>
            <h3>Aucun répertoire pour le moment</h3>
            <p>Créez votre premier répertoire pour commencer à explorer et enregistrer vos coups favoris.</p>
            <button className="primary-btn" onClick={() => setIsModalOpen(true)}>
              <Plus size={16} />
              <span>Créer mon premier répertoire</span>
            </button>
          </div>
        ) : (
          repertoires.map((rep) => {
            const reviews = loadTrainerReviews();
            const cardStats = computeRepCardStats(rep.root, rep.color, rep.id, reviews);
            const studyTime = getStudyTime(rep.id);
            const menuOpen = openMenuId === rep.id;
            const fens = walkFens.get(rep.id) ?? [rep.root.fen];

            const statsPairs = [
              { leftLabel: 'Variantes :', leftValue: cardStats.variantes.toLocaleString('fr-FR'), rightLabel: "Temps d'étude :", rightValue: formatDuration(studyTime) },
              { leftLabel: 'Transpositions :', leftValue: cardStats.transpositions.toLocaleString('fr-FR'), rightLabel: 'Éval. moyenne :', rightValue: formatEval(cardStats.evalMoyenne) },
              { leftLabel: 'Profondeur moy. :', leftValue: cardStats.profondeur.toLocaleString('fr-FR', { maximumFractionDigits: 1 }), rightLabel: 'Winrate :', rightValue: cardStats.winrate !== null ? Math.round(cardStats.winrate * 100) + '%' : '—' },
            ];

            return (
              <div key={rep.id} className={`repertoire-card card-${rep.color}`}>
                <div className="rep-card-top">
                  <div className="rep-title-row">
                    <h3 className="rep-title-wrap">
                      <button
                        type="button"
                        className="rep-title"
                        onClick={() => onOpenRepertoire(rep, 'tree')}
                        title="Voir l'arbre des variantes"
                      >
                        {displayRepTitle(rep)}
                        <span className="rep-title-elo">{eloShort(rep.targetElo)}</span>
                      </button>
                    </h3>
                    <button
                      type="button"
                      className="mini-icon-btn rep-menu-btn"
                      aria-haspopup="menu"
                      aria-expanded={menuOpen}
                      aria-label={`Actions pour ${displayRepTitle(rep)}`}
                      title="Plus d'actions"
                      onClick={() => setOpenMenuId(menuOpen ? null : rep.id)}
                    >
                      <MoreVertical size={16} />
                    </button>
                  </div>
                  {menuOpen && (
                    <>
                      <button
                        type="button"
                        className="rep-menu-backdrop"
                        aria-label="Fermer le menu"
                        onClick={() => setOpenMenuId(null)}
                      />
                      <div
                        className="rep-menu"
                        role="menu"
                        aria-label={`Actions pour ${rep.title}`}
                        onKeyDown={(e) => {
                          if (e.key === 'Escape') setOpenMenuId(null);
                        }}
                      >
                        <button
                          type="button"
                          role="menuitem"
                          className="rep-menu-item"
                          onClick={() => {
                            setOpenMenuId(null);
                            onOpenRepertoire(rep, 'tree');
                          }}
                        >
                          <ListTree size={14} aria-hidden="true" />
                          <span>Voir l'arbre des variantes</span>
                        </button>
                        <button
                          type="button"
                          role="menuitem"
                          className="rep-menu-item"
                          onClick={() => {
                            setOpenMenuId(null);
                            downloadFile(`${rep.title.toLowerCase().replace(/\s+/g, '_')}.json`, JSON.stringify(rep.root, null, 2), 'application/json');
                          }}
                        >
                          <Download size={14} aria-hidden="true" />
                          <span>Télécharger en JSON</span>
                        </button>
                        <button
                          type="button"
                          role="menuitem"
                          className="rep-menu-item danger"
                          onClick={() => {
                            setOpenMenuId(null);
                            setPendingDeleteId(rep.id);
                          }}
                        >
                          <Trash2 size={14} aria-hidden="true" />
                          <span>Supprimer le répertoire</span>
                        </button>
                      </div>
                    </>
                  )}

                </div>

                <div className="rep-card-body">
                  <button
                    type="button"
                    className="rep-board-btn"
                    onClick={() => onOpenRepertoire(rep, 'tree')}
                    title="Voir l'arbre des variantes"
                    aria-label={`Voir l'arbre des variantes de ${displayRepTitle(rep)}`}
                  >
                    <AnimatedBoard key={`${rep.id}:${fens.length}`} fens={fens} orientation={rep.color === 'white' ? 'w' : 'b'} />
                  </button>
                  <div className="rep-simple-stats">
                    <div className="rep-progress">
                      <span className="rep-progress-top">
                        <span className="simple-stat-label">Progression</span>
                        <span className="simple-stat-val">
                          {cardStats.learned.toLocaleString('fr-FR')}/{cardStats.totalPositions.toLocaleString('fr-FR')}
                          {cardStats.totalPositions > 0 && (
                            <> · {Math.round((cardStats.learned / cardStats.totalPositions) * 100)} %</>
                          )}
                        </span>
                      </span>
                      {cardStats.totalPositions > 0 && (
                        <span
                          className="rep-progress-track"
                          role="img"
                          aria-label={`Progression : ${cardStats.learned} positions apprises sur ${cardStats.totalPositions}`}
                        >
                          <span
                            className="rep-progress-fill"
                            aria-hidden="true"
                            style={{ width: `${Math.min(100, Math.round((cardStats.learned / cardStats.totalPositions) * 100))}%` }}
                          />
                        </span>
                      )}
                      <span className="rep-progress-sub">{formatLastStudy(cardStats.derniereEtude)}</span>
                    </div>
                    {statsPairs.map((pair, i) => (
                      <div key={i} className="simple-stat-row">
                        <span className="simple-stat-left"><span className="simple-stat-label">{pair.leftLabel}</span><span className="simple-stat-val">{pair.leftValue}</span></span>
                        <span className="simple-stat-right"><span className="simple-stat-label">{pair.rightLabel}</span><span className="simple-stat-val">{pair.rightValue}</span></span>
                      </div>
                    ))}
                  </div>
                </div>

                <div className="rep-actions-footer">
                  <button 
                    className="study-btn rep-study-btn"
                    onClick={() => onOpenRepertoire(rep, 'builder')}
                    title="Étudier et construire ce répertoire"
                  >
                    <span className="rep-study-icon" aria-hidden="true">
                      <BookOpen size={15} />
                    </span>
                    <span>Étudier</span>
                    <ChevronRight size={15} className="rep-study-go" aria-hidden="true" />
                  </button>

                  <button 
                    type="button"
                    className="action-pill-btn train-btn"
                    onClick={() => onOpenRepertoire(rep, 'trainer')}
                    title="S'entraîner contre ce répertoire"
                  >
                    <Target size={15} />
                    <span>S'entraîner</span>
                  </button>
                </div>
              </div>
            );
          })
        )}
      </div>
      </div>

      {/* Modal Création Nouveau Répertoire */}
      {isModalOpen && (
        <div className="modal-backdrop" onClick={() => setIsModalOpen(false)}>
          <div
            className="modal-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="new-rep-title"
            tabIndex={-1}
            ref={(el) => el?.focus()}
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              if (e.key === 'Escape') setIsModalOpen(false);
            }}
          >
            <div className="modal-header">
              <h2 id="new-rep-title">Nouveau répertoire d'ouvertures</h2>
              <button className="modal-close-btn" onClick={() => setIsModalOpen(false)} aria-label="Fermer">×</button>
            </div>

            <form onSubmit={handleCreateSubmit} className="modal-form">
              {/* Choix de la couleur */}
              <div className="form-group">
                <span className="form-label" id="new-rep-color">Camp à jouer (votre couleur)</span>
                <div className="color-cards-selector" role="group" aria-labelledby="new-rep-color">
                  <button
                    type="button"
                    className={`color-card-pick ${newColor === 'white' ? 'selected' : ''}`}
                    aria-pressed={newColor === 'white'}
                    onClick={() => setNewColor('white')}
                  >
                    <span className="color-card-icon" aria-hidden="true">♔</span>
                    <span className="color-card-title">Blancs</span>
                    <span className="color-card-sub">Vous jouez le premier coup (1. e4, 1. d4…)</span>
                  </button>

                  <button
                    type="button"
                    className={`color-card-pick ${newColor === 'black' ? 'selected' : ''}`}
                    aria-pressed={newColor === 'black'}
                    onClick={() => setNewColor('black')}
                  >
                    <span className="color-card-icon" aria-hidden="true">♚</span>
                    <span className="color-card-title">Noirs</span>
                    <span className="color-card-sub">Vous préparez vos défenses face aux Blancs</span>
                  </button>
                </div>
              </div>

              {/* Choix de l'Elo cible de l'adversaire */}
              <div className="form-group">
                <span className="form-label" id="new-rep-elo">Niveau Elo de vos adversaires</span>
                <div className="elo-options-list" role="radiogroup" aria-labelledby="new-rep-elo">
                  {ELO_TARGET_OPTIONS.map((opt) => (
                    <label 
                      key={opt.key} 
                      className={`elo-option-item ${newTargetElo === opt.key ? 'selected' : ''}`}
                    >
                      <input
                        type="radio"
                        name="targetElo"
                        value={opt.key}
                        checked={newTargetElo === opt.key}
                        onChange={() => setNewTargetElo(opt.key)}
                      />
                      <div className="elo-option-info">
                        <span className="elo-option-title">{eloTargetLabel(opt.key)}</span>
                        <span className="elo-option-desc">{eloTargetDescription(opt.key)}</span>
                      </div>
                    </label>
                  ))}
                </div>
              </div>

              {/* Titre du répertoire */}
              <div className="form-group">
                <label className="form-label" htmlFor="new-rep-name">Nom du répertoire (optionnel)</label>
                <input
                  id="new-rep-name"
                  type="text"
                  className="text-input"
                   placeholder={`Ex : Mon répertoire ${newColor === 'white' ? 'Blancs' : 'Noirs'}`}
                  value={newTitle}
                  onChange={(e) => setNewTitle(e.target.value)}
                />
              </div>

              <div className="modal-actions">
                <button type="button" className="secondary-btn" onClick={() => setIsModalOpen(false)}>
                  Annuler
                </button>
                <button type="submit" className="primary-btn">
                  Créer le répertoire
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {pendingDeleteRep && (
        <ConfirmDialog
          title="Supprimer ce répertoire ?"
          message={`Supprimer définitivement « ${pendingDeleteRep.title} » et toutes ses variantes ?`}
          onConfirm={() => {
            onDeleteRepertoire(pendingDeleteRep.id);
            setPendingDeleteId(null);
          }}
          onCancel={() => setPendingDeleteId(null)}
        />
      )}
    </div>
  );
};
