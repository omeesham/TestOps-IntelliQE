import { useState } from 'react';
import { AlertCircle, AlertTriangle, Info, X, ChevronDown, ChevronUp, RefreshCcw } from 'lucide-react';
import type { NormalizedError } from '@/utils/apiError';

interface Props {
  error: NormalizedError | null | undefined;
  onDismiss?: () => void;
  onRetry?: () => void;
  className?: string;
  compact?: boolean;
}

const TONE: Record<'error' | 'warning' | 'info', {
  bg: string; border: string; text: string; subtext: string; iconColor: string; Icon: React.ElementType; badgeBg: string;
}> = {
  error:   { bg: 'bg-red-50',    border: 'border-red-200',    text: 'text-red-800',    subtext: 'text-red-700',    iconColor: 'text-red-500',    badgeBg: 'bg-red-100 text-red-700',       Icon: AlertCircle },
  warning: { bg: 'bg-amber-50',  border: 'border-amber-200',  text: 'text-amber-800',  subtext: 'text-amber-700',  iconColor: 'text-amber-500',  badgeBg: 'bg-amber-100 text-amber-700',   Icon: AlertTriangle },
  info:    { bg: 'bg-blue-50',   border: 'border-blue-200',   text: 'text-blue-800',   subtext: 'text-blue-700',   iconColor: 'text-blue-500',    badgeBg: 'bg-blue-100 text-blue-700',     Icon: Info },
};

export default function ErrorAlert({ error, onDismiss, onRetry, className = '', compact = false }: Props) {
  const [showDetails, setShowDetails] = useState(false);
  if (!error) return null;

  const tone = TONE[error.severity] || TONE.error;
  const Icon = tone.Icon;

  if (compact) {
    return (
      <div className={`flex items-center gap-2 px-3 py-2 ${tone.bg} border ${tone.border} rounded-md text-xs ${tone.text} ${className}`}>
        <Icon className={`w-4 h-4 ${tone.iconColor} flex-shrink-0`} />
        <span className="flex-1 truncate">{error.message}</span>
        {onDismiss && (
          <button onClick={onDismiss} className={`${tone.iconColor} hover:opacity-70`} aria-label="Dismiss">
            <X className="w-3.5 h-3.5" />
          </button>
        )}
      </div>
    );
  }

  return (
    <div className={`flex items-start gap-3 p-3.5 ${tone.bg} border ${tone.border} rounded-lg ${className}`} role="alert">
      <Icon className={`w-5 h-5 ${tone.iconColor} flex-shrink-0 mt-0.5`} />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 mb-0.5">
          <p className={`text-sm font-semibold ${tone.text}`}>{error.title}</p>
          <span className={`text-[10px] font-mono px-1.5 py-0.5 rounded ${tone.badgeBg} uppercase tracking-wider`}>
            {error.code}
          </span>
        </div>
        <p className={`text-sm ${tone.subtext}`}>{error.message}</p>
        {error.hint && (
          <p className={`text-xs ${tone.subtext} mt-1.5 flex items-start gap-1`}>
            <span className="font-semibold">Hint:</span>
            <span>{error.hint}</span>
          </p>
        )}
        {(error.requestId || error.details) && (
          <div className="mt-2 flex items-center gap-3 text-[11px]">
            {error.details && (
              <button
                onClick={() => setShowDetails((v) => !v)}
                className={`${tone.subtext} hover:opacity-70 inline-flex items-center gap-1`}
              >
                {showDetails ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
                {showDetails ? 'Hide details' : 'Show details'}
              </button>
            )}
            {error.requestId && (
              <span className={`${tone.subtext} font-mono`}>
                req: <span className="select-all">{error.requestId.slice(0, 8)}</span>
              </span>
            )}
          </div>
        )}
        {showDetails && error.details && (
          <pre className={`mt-2 p-2 bg-white/60 border ${tone.border} rounded text-[11px] ${tone.subtext} max-h-48 overflow-auto whitespace-pre-wrap font-mono`}>
            {error.details}
          </pre>
        )}
      </div>
      <div className="flex items-center gap-1 flex-shrink-0">
        {onRetry && error.retryable && (
          <button
            onClick={onRetry}
            className={`px-2 py-1 text-xs font-medium ${tone.text} hover:bg-white/40 rounded inline-flex items-center gap-1`}
          >
            <RefreshCcw className="w-3 h-3" /> Retry
          </button>
        )}
        {onDismiss && (
          <button onClick={onDismiss} className={`${tone.iconColor} hover:opacity-70 p-1`} aria-label="Dismiss">
            <X className="w-4 h-4" />
          </button>
        )}
      </div>
    </div>
  );
}
