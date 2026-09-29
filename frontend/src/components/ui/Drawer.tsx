/**
 * Right-hand slide-over panel for forms that belong to a page rather than to
 * a separate screen. Closes on Escape and on a click outside the panel.
 */
import { useEffect } from 'react';
import { X } from 'lucide-react';

interface Props {
  open: boolean;
  onClose: () => void;
  title: string;
  subtitle?: string;
  icon?: React.ElementType;
  /** Pinned to the bottom of the panel, e.g. Cancel / Save. */
  footer?: React.ReactNode;
  children: React.ReactNode;
  widthClass?: string;
}

export default function Drawer({ open, onClose, title, subtitle, icon: Icon, footer, children, widthClass = 'max-w-xl' }: Props) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div className="fixed inset-y-0 right-0 left-0 z-40 flex justify-end" role="dialog" aria-modal="true" aria-label={title}>
      <button type="button" aria-label="Close" onClick={onClose} className="absolute inset-0 w-full h-full bg-[#1E1B4B]/40 backdrop-blur-[2px] cursor-default !rounded-none" style={{ transform: 'none', filter: 'none' }} />
      <div className={`relative w-full ${widthClass} h-full bg-white shadow-2xl flex flex-col animate-slideInRight`}>
        <div className="flex items-start gap-3 px-6 py-4 border-b border-gray-100 bg-gradient-to-r from-violet-50/70 to-indigo-50/40">
          {Icon && (
            <div className="w-9 h-9 rounded-lg bg-gradient-to-br from-violet-500 to-indigo-600 flex items-center justify-center flex-shrink-0 shadow-md shadow-purple-500/20">
              <Icon className="w-4 h-4 text-white" />
            </div>
          )}
          <div className="flex-1 min-w-0">
            <h2 className="text-base font-semibold text-[#1E1B4B]">{title}</h2>
            {subtitle && <p className="text-xs text-gray-500 mt-0.5">{subtitle}</p>}
          </div>
          <button type="button" onClick={onClose} className="p-1.5 text-gray-400 hover:text-gray-700 hover:bg-white rounded-lg" title="Close"><X className="w-4 h-4" /></button>
        </div>
        <div className="flex-1 overflow-y-auto px-6 py-5">{children}</div>
        {footer && <div className="px-6 py-3 border-t border-gray-100 bg-gray-50/60 flex items-center justify-end gap-2">{footer}</div>}
      </div>
    </div>
  );
}
