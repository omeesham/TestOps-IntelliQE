/**
 * Toast context + hook. Kept in a hook-only module (no component exports) so
 * Fast Refresh stays happy — the <ToastProvider> component lives in ToastProvider.tsx.
 */
import { createContext, useContext } from 'react';

export interface ToastApi {
  success: (title: string, message?: string) => void;
  error:   (title: string, message?: string) => void;
  warning: (title: string, message?: string) => void;
  info:    (title: string, message?: string) => void;
  fromError: (err: unknown) => void;
}

export const ToastContext = createContext<ToastApi | null>(null);

export function useToast(): ToastApi {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used inside ToastProvider');
  return ctx;
}
