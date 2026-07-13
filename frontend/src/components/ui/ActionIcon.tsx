/**
 * ActionIcon — the standard colorful icon button for table/action rows.
 *
 * One consistent look app-wide, using industry-standard action colors:
 *   view = blue · edit = indigo · copy = slate · download = sky
 *   excel = green · pdf = red · delete = red · success/approve = emerald
 * Each renders as a tinted "chip" (soft colored background + saturated icon)
 * that fills solid on hover — visible at a glance, clearly clickable.
 */
import type { ReactNode } from 'react';

export type ActionTone =
  | 'view' | 'edit' | 'copy' | 'download' | 'excel' | 'pdf' | 'delete' | 'success' | 'warn' | 'neutral';

const TONES: Record<ActionTone, string> = {
  view:     'bg-blue-100 text-blue-600 hover:bg-blue-600 hover:text-white',
  edit:     'bg-indigo-100 text-indigo-600 hover:bg-indigo-600 hover:text-white',
  copy:     'bg-slate-100 text-slate-600 hover:bg-slate-600 hover:text-white',
  download: 'bg-sky-100 text-sky-600 hover:bg-sky-600 hover:text-white',
  excel:    'bg-emerald-100 text-emerald-600 hover:bg-emerald-600 hover:text-white',
  pdf:      'bg-red-100 text-red-600 hover:bg-red-600 hover:text-white',
  delete:   'bg-red-100 text-red-500 hover:bg-red-600 hover:text-white',
  success:  'bg-emerald-100 text-emerald-600 hover:bg-emerald-600 hover:text-white',
  warn:     'bg-amber-100 text-amber-600 hover:bg-amber-500 hover:text-white',
  neutral:  'bg-gray-100 text-gray-500 hover:bg-gray-600 hover:text-white',
};

export default function ActionIcon({
  tone,
  title,
  onClick,
  disabled,
  children,
}: {
  tone: ActionTone;
  title: string;
  onClick?: (e: React.MouseEvent<HTMLButtonElement>) => void;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      aria-label={title}
      className={`inline-flex items-center justify-center w-8 h-8 rounded-lg shadow-sm transition-all duration-150 hover:shadow-md hover:scale-105 active:scale-95 disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:scale-100 ${TONES[tone]}`}
    >
      {children}
    </button>
  );
}
