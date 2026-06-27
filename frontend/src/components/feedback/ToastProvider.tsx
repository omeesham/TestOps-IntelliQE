/**
 * Toast notifications — non-blocking feedback for actions whose result
 * doesn't have a dedicated UI surface (saves, deletes, copies, background
 * sync, etc.). Auto-dismiss after 5s; errors auto-dismiss after 8s.
 *
 * Usage:
 *   const toast = useToast();
 *   toast.error('Save failed', 'Please retry.');
 *   toast.success('Saved');
 *   toast.fromError(err);   // accepts NormalizedError or anything normalize() handles
 */
import { useCallback, useMemo, useRef, useState } from 'react';
import { AlertCircle, AlertTriangle, CheckCircle2, Info, X } from 'lucide-react';
import { normalizeError, type NormalizedError } from '@/utils/apiError';
import { ToastContext, type ToastApi } from './useToast';

type ToastKind = 'success' | 'error' | 'warning' | 'info';

interface ToastEntry {
  id: number;
  kind: ToastKind;
  title: string;
  message?: string;
  code?: string;
}

const TONE: Record<ToastKind, { bg: string; border: string; text: string; iconColor: string; Icon: React.ElementType }> = {
  success: { bg: 'bg-emerald-50', border: 'border-emerald-200', text: 'text-emerald-800', iconColor: 'text-emerald-500', Icon: CheckCircle2 },
  error:   { bg: 'bg-red-50',     border: 'border-red-200',     text: 'text-red-800',     iconColor: 'text-red-500',     Icon: AlertCircle },
  warning: { bg: 'bg-amber-50',   border: 'border-amber-200',   text: 'text-amber-800',   iconColor: 'text-amber-500',   Icon: AlertTriangle },
  info:    { bg: 'bg-blue-50',    border: 'border-blue-200',    text: 'text-blue-800',    iconColor: 'text-blue-500',    Icon: Info },
};

const TTL_MS: Record<ToastKind, number> = { success: 4_000, info: 5_000, warning: 6_000, error: 8_000 };

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<ToastEntry[]>([]);
  const nextId = useRef(0);

  const push = useCallback((kind: ToastKind, title: string, message?: string, code?: string) => {
    const id = (nextId.current += 1);
    setToasts((prev) => [...prev.slice(-4), { id, kind, title, message, code }]);
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, TTL_MS[kind]);
  }, []);

  const dismiss = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const api = useMemo<ToastApi>(() => ({
    success: (t, m) => push('success', t, m),
    error:   (t, m) => push('error',   t, m),
    warning: (t, m) => push('warning', t, m),
    info:    (t, m) => push('info',    t, m),
    fromError: (e) => {
      const n: NormalizedError = normalizeError(e);
      push(n.severity, n.title, n.message, n.code);
    },
  }), [push]);

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div
        aria-live="polite"
        aria-atomic="true"
        className="fixed bottom-4 right-4 z-50 flex flex-col gap-2 pointer-events-none w-full max-w-sm"
      >
        {toasts.map((t) => {
          const tone = TONE[t.kind];
          const Icon = tone.Icon;
          return (
            <div
              key={t.id}
              className={`pointer-events-auto flex items-start gap-3 ${tone.bg} border ${tone.border} rounded-lg p-3 shadow-lg animate-in fade-in slide-in-from-bottom-2`}
              role={t.kind === 'error' ? 'alert' : 'status'}
            >
              <Icon className={`w-5 h-5 ${tone.iconColor} flex-shrink-0 mt-0.5`} />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <p className={`text-sm font-semibold ${tone.text}`}>{t.title}</p>
                  {t.code && (
                    <span className="text-[10px] font-mono px-1 py-0.5 rounded bg-white/60 text-gray-600 uppercase tracking-wider">
                      {t.code}
                    </span>
                  )}
                </div>
                {t.message && <p className={`text-xs ${tone.text} opacity-90 mt-0.5`}>{t.message}</p>}
              </div>
              <button
                onClick={() => dismiss(t.id)}
                className={`${tone.iconColor} hover:opacity-70 p-0.5`}
                aria-label="Dismiss"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          );
        })}
      </div>
    </ToastContext.Provider>
  );
}
