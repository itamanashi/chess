import React, { useState } from 'react';
import type { RepertoireItem, BoardOrientation, EloTargetKey, StudioTab } from '../types/chess';
import { ELO_TARGET_OPTIONS } from '../types/chess';
import { eloTargetDescription, eloTargetLabel } from '../i18n';
import { indexRepertoire, downloadFile } from '../utils/repertoire';
import { ConfirmDialog } from './ConfirmDialog';
import {
  Plus,
  BookOpen,
  Target,
  Trash2,
  Download,
  Clock,
  ShieldCheck,
  ListTree
} from 'lucide-react';

interface RepertoireLibraryProps {
  repertoires: RepertoireItem[];
  onOpenRepertoire: (rep: RepertoireItem, initialTab?: StudioTab) => void;
  onCreateRepertoire: (title: string, color: BoardOrientation, targetElo: EloTargetKey) => void;
  onDeleteRepertoire: (id: string) => void;
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
  const pendingDeleteRep = pendingDeleteId ? repertoires.find((r) => r.id === pendingDeleteId) ?? null : null;

  const handleCreateSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const title = newTitle.trim() || `Répertoire ${newColor === 'white' ? 'Blancs' : 'Noirs'} (${eloTargetLabel(newTargetElo)})`;
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
        </div>

        <div className="hero-action-buttons">
          <button className="primary-btn" onClick={() => setIsModalOpen(true)}>
            <Plus size={18} />
            <span>Nouveau répertoire</span>
          </button>
        </div>
      </div>

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
            const stats = indexRepertoire(rep.root);

            return (
              <div key={rep.id} className={`repertoire-card card-${rep.color}`}>
                <div className="rep-card-top">
                  <div className="rep-badges-row">
                    <span className={`rep-color-tag tag-${rep.color}`}>
                      {rep.color === 'white' ? '♔ Répertoire Blancs' : '♚ Répertoire Noirs'}
                    </span>
                    <span className="rep-elo-tag" title={eloTargetDescription(rep.targetElo)}>
                      <ShieldCheck size={13} />
                      <span>{eloTargetLabel(rep.targetElo)}</span>
                    </span>
                  </div>

                  <h2 className="rep-title-wrap">
                    <button
                      type="button"
                      className="rep-title"
                      onClick={() => onOpenRepertoire(rep, 'tree')}
                      title="Voir l'arbre des variantes"
                    >
                      {rep.title}
                    </button>
                  </h2>
                  <p className="rep-elo-desc">{eloTargetDescription(rep.targetElo)}</p>
                </div>

                <div className="rep-metrics-row">
                  <div className="metric-box">
                    <span className="metric-val">{stats.totalPositions.toLocaleString('fr-FR')}</span>
                    <span className="metric-lbl">Positions</span>
                  </div>
                  <div className="metric-box">
                    <span className="metric-val">{stats.totalLines}</span>
                    <span className="metric-lbl">Lignes</span>
                  </div>
                  <div className="metric-box">
                    <span className="metric-val">{stats.maxDepth}</span>
                    <span className="metric-lbl">Plis max</span>
                  </div>
                </div>

                <div className="rep-date-row">
                  <Clock size={12} />
                  <span>Modifié le {new Date(rep.updatedAt).toLocaleDateString('fr-FR')}</span>
                </div>

                <div className="rep-actions-footer">
                  <button 
                    className="study-btn open-btn"
                    onClick={() => onOpenRepertoire(rep, 'builder')}
                    title="Étudier et construire ce répertoire"
                  >
                    <BookOpen size={15} />
                    <span>Étudier</span>
                  </button>

                  <button 
                    className="action-pill-btn train-btn"
                    onClick={() => onOpenRepertoire(rep, 'trainer')}
                    title="S'entraîner contre ce répertoire"
                  >
                    <Target size={15} />
                    <span>S'entraîner</span>
                  </button>

                  <div className="sub-actions">
                    <button 
                      className="mini-icon-btn" 
                      onClick={() => onOpenRepertoire(rep, 'tree')}
                      title="Voir l'arbre des variantes"
                    >
                      <ListTree size={14} />
                    </button>
                    <button 
                      className="mini-icon-btn" 
                      onClick={() => downloadFile(`${rep.title.toLowerCase().replace(/\s+/g, '_')}.json`, JSON.stringify(rep.root, null, 2), 'application/json')}
                      title="Télécharger en JSON"
                    >
                      <Download size={14} />
                    </button>
                    <button
                      className="mini-icon-btn danger"
                      onClick={() => setPendingDeleteId(rep.id)}
                      title="Supprimer le répertoire"
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                </div>
              </div>
            );
          })
        )}
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
                  placeholder={`Ex : Mon répertoire ${newColor === 'white' ? 'Blancs' : 'Noirs'} (${eloTargetLabel(newTargetElo)})`}
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
