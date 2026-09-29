import React, { useEffect } from 'react';
import { AlertTriangle } from 'lucide-react';

/**
 * Confirmation destructive dans le langage visuel de l'app.
 * Remplace le `confirm()` natif (3 usages) : même vocabulaire que les
 * toasts, pas de rupture de style au moment critique.
 */
interface ConfirmDialogProps {
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
}

export const ConfirmDialog: React.FC<ConfirmDialogProps> = ({
  title,
  message,
  confirmLabel = 'Supprimer',
  cancelLabel = 'Annuler',
  onConfirm,
  onCancel,
}) => {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onCancel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);

  return (
    <div className="confirm-backdrop" onClick={onCancel} role="presentation">
      <div
        className="promotion-modal"
        role="alertdialog"
        aria-modal="true"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="confirm-title">
          <AlertTriangle size={16} aria-hidden="true" />
          <span>{title}</span>
        </h2>
        <p className="confirm-message">{message}</p>
        <div className="confirm-actions">
          <button className="secondary-btn" onClick={onCancel} autoFocus>
            {cancelLabel}
          </button>
          <button className="secondary-btn btn-danger" onClick={onConfirm}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
};
