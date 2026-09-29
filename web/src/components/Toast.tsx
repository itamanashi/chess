import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, CheckCircle2, Info, X } from 'lucide-react';
import {
  ToastContext,
  type NotifyOptions,
  type ToastApi,
  type ToastItem,
  type ToastKind,
} from '../hooks/useToast';

/**
 * Service UI uniforme de feedback non bloquant.
 *
 * Remplace les `alert()` dispersés : `toast.success()` / `toast.error()` /
 * `toast.info()` affichent un toast auto-fermant en bas à droite, avec une
 * durée adaptée à la gravité. Les erreurs métier visibles restent en plus
 * affichées en ligne dans leur panneau (LichessLivePanel, RepertoireBuilder).
 */

const DEFAULT_DURATION: Record<ToastKind, number> = {
  success: 3500,
  info: 4000,
  error: 6500,
};

const MAX_STACK = 4;

let nextId = 1;

export const ToastProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());

  const dismiss = useCallback((id: number) => {
    const timer = timers.current.get(id);
    if (timer) {
      clearTimeout(timer);
      timers.current.delete(id);
    }
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  // Démontage : aucun auto-dismiss fantôme.
  useEffect(() => {
    const pending = timers.current;
    return () => {
      pending.forEach((t) => clearTimeout(t));
      pending.clear();
    };
  }, []);

  const notify = useCallback(
    (kind: ToastKind, message: string, opts?: NotifyOptions) => {
      const id = nextId++;
      const duration = opts?.durationMs ?? DEFAULT_DURATION[kind];
      setToasts((prev) => [...prev.slice(-(MAX_STACK - 1)), { id, kind, message }]);
      if (duration > 0) {
        timers.current.set(
          id,
          setTimeout(() => dismiss(id), duration),
        );
      }
    },
    [dismiss],
  );

  const api = useMemo<ToastApi>(
    () => ({
      notify,
      success: (message, opts) => notify('success', message, opts),
      error: (message, opts) => notify('error', message, opts),
      info: (message, opts) => notify('info', message, opts),
      dismiss,
    }),
    [notify, dismiss],
  );

  return (
    <ToastContext.Provider value={api}>
      {children}
      <ToastViewport toasts={toasts} onDismiss={dismiss} />
    </ToastContext.Provider>
  );
};

const KIND_ICON: Record<ToastKind, React.ReactNode> = {
  success: <CheckCircle2 size={16} />,
  error: <AlertTriangle size={16} />,
  info: <Info size={16} />,
};

const ToastViewport: React.FC<{ toasts: ToastItem[]; onDismiss: (id: number) => void }> = ({
  toasts,
  onDismiss,
}) => {
  if (toasts.length === 0) return null;
  return (
    <div className="toast-viewport" aria-live="polite">
      {toasts.map((t) => (
        <div
          key={t.id}
          className={`toast toast-${t.kind}`}
          role={t.kind === 'error' ? 'alert' : 'status'}
        >
          <span className="toast-icon">{KIND_ICON[t.kind]}</span>
          <span className="toast-message">{t.message}</span>
          <button
            className="toast-close"
            onClick={() => onDismiss(t.id)}
            aria-label="Fermer la notification"
          >
            <X size={14} />
          </button>
        </div>
      ))}
    </div>
  );
};
