import { createContext, useContext } from 'react';

/**
 * Types + contexte du service UI de toasts (implémentation : Toast.tsx).
 * Fichier séparé pour respecter react-refresh (que des exports non-composants).
 */

export type ToastKind = 'success' | 'error' | 'info';

export interface ToastItem {
  id: number;
  kind: ToastKind;
  message: string;
}

export interface NotifyOptions {
  /** Surcharge la durée d'affichage (ms). */
  durationMs?: number;
}

export interface ToastApi {
  notify: (kind: ToastKind, message: string, opts?: NotifyOptions) => void;
  success: (message: string, opts?: NotifyOptions) => void;
  error: (message: string, opts?: NotifyOptions) => void;
  info: (message: string, opts?: NotifyOptions) => void;
  dismiss: (id: number) => void;
}

export const ToastContext = createContext<ToastApi | null>(null);

export function useToast(): ToastApi {
  const api = useContext(ToastContext);
  if (!api) throw new Error('useToast must be used within <ToastProvider>.');
  return api;
}
