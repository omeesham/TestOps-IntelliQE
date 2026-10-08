/**
 * PageTabs — the app's horizontal tab bar.
 *
 * The underline-tab pattern the native pages (e.g. Generated Test Cases) use,
 * extracted into one shared, accessible component so every page renders tabs
 * the same way. Built only from existing class conventions — no new tokens.
 *
 * Accessibility: a proper `tablist` / `tab` structure with `aria-selected`,
 * roving `tabIndex`, and Left/Right/Home/End keyboard navigation. Consumers
 * render the active panel themselves and should give it `role="tabpanel"`.
 */
import { useRef, type ElementType, type KeyboardEvent } from 'react';

export interface TabItem {
  id: string;
  label: string;
  icon?: ElementType;
  /** Optional count pill (e.g. number of endpoints). */
  count?: number;
}

interface PageTabsProps {
  tabs: TabItem[];
  active: string;
  onChange: (id: string) => void;
  /** Accessible name for the tablist. */
  ariaLabel?: string;
  className?: string;
}

export default function PageTabs({ tabs, active, onChange, ariaLabel = 'Sections', className = '' }: PageTabsProps) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);

  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>, index: number) => {
    let next = index;
    if (e.key === 'ArrowRight') next = (index + 1) % tabs.length;
    else if (e.key === 'ArrowLeft') next = (index - 1 + tabs.length) % tabs.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = tabs.length - 1;
    else return;
    e.preventDefault();
    const t = tabs[next];
    if (t) { onChange(t.id); refs.current[next]?.focus(); }
  };

  return (
    <div
      role="tablist"
      aria-label={ariaLabel}
      className={`inline-flex gap-1 bg-white rounded-xl border border-gray-100 shadow-sm p-1.5 overflow-x-auto scrollbar-hide ${className}`}
    >
      {tabs.map((t, i) => {
        const isActive = t.id === active;
        const Icon = t.icon;
        return (
          <button
            key={t.id}
            ref={(el) => { refs.current[i] = el; }}
            role="tab"
            id={`tab-${t.id}`}
            aria-selected={isActive}
            aria-controls={`panel-${t.id}`}
            tabIndex={isActive ? 0 : -1}
            onClick={() => onChange(t.id)}
            onKeyDown={(e) => onKeyDown(e, i)}
            className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-lg px-3.5 py-2 text-[13px] font-semibold transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-[#7C3AED]/40 ${
              isActive
                ? 'bg-gradient-to-r from-[#7C3AED] to-[#6366F1] text-white shadow-sm'
                : 'text-gray-500 hover:text-gray-800 hover:bg-gray-50'
            }`}
          >
            {Icon && <Icon className="w-4 h-4 flex-shrink-0" />}
            {t.label}
            {t.count !== undefined && (
              <span className={`ml-0.5 inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-md text-[11px] font-bold tabular-nums ${isActive ? 'bg-white/25 text-white' : 'bg-purple-50 text-[#7C3AED]'}`}>
                {t.count}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
