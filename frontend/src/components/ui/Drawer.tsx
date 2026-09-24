/**
 * Drawer — a right-anchored slide-over panel.
 *
 * The app had no drawer pattern; this is the shared one, built from the native
 * modal conventions (same overlay + float shadow) but sliding in from the edge.
 * Used for side content like the activity log that shouldn't take over the
 * screen as a centered modal would.
 *
 * Accessibility: `role="dialog"` + `aria-modal`, Escape to close, click-outside
 * to close, and focus moved into the panel on open / restored on close.
 */
import { useEffect, useRef, type ReactNode } from 'react';

interface DrawerProps {
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  /** Panel width utility class (default a comfortable side panel). */
  widthClass?: string;
  ariaLabel?: string;
}

export default function Drawer({ open, onClose, children, widthClass = 'w-[340px] max-w-[92vw]', ariaLabel = 'Panel' }: DrawerProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const restoreRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) return;
    restoreRef.current = document.activeElement as HTMLElement | null;
    // Move focus into the panel so keyboard users land inside the drawer.
    const t = window.setTimeout(() => panelRef.current?.focus(), 0);
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => {
      window.clearTimeout(t);
      document.removeEventListener('keydown', onKey);
      restoreRef.current?.focus?.();
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm animate-[fadeIn_0.15s_ease-out]" onClick={onClose} aria-hidden="true" />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={ariaLabel}
        tabIndex={-1}
        className={`relative h-full ${widthClass} bg-white shadow-2xl flex flex-col min-h-0 outline-none animate-[slideInRight_0.2s_ease-out]`}
      >
        {children}
      </div>
    </div>
  );
}
