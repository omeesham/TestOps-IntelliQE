/**
 * EnvironmentPicker — the active-environment selector, top-right of the studio.
 *
 * The Postman "environment quick look" in miniature: pick which environment a
 * run resolves its `{{vars}}` and base URL against. The choice is the whole
 * reason environments exist, so it lives in the toolbar and is always in reach.
 *
 * Presentational + a single `store.setActiveId` call — it owns no environment
 * data of its own (the shared store does), so it never falls out of sync with
 * the Environments tab.
 */
import { useEffect, useRef, useState } from 'react';
import { ChevronDown, Check, Star, Server, Settings2, CircleSlash } from 'lucide-react';
import { envColor } from '../env-colors';
import { NO_ENVIRONMENT, type ApiEnvironmentsStore } from '../hooks/useApiEnvironments';

export default function EnvironmentPicker({ store, onManage }: { store: ApiEnvironmentsStore; onManage: () => void }) {
  const { environments, activeEnvironment, noneSelected, setActiveId } = store;
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); };
  }, [open]);

  const label = noneSelected ? 'No environment' : (activeEnvironment?.name || 'No environment');
  const dot = noneSelected || !activeEnvironment ? null : envColor(activeEnvironment.color);

  const choose = (id: string | null) => { setActiveId(id); setOpen(false); };

  return (
    <div ref={ref} className="relative flex-shrink-0">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        title="Active environment — the run resolves {{variables}} and the base URL against it"
        aria-haspopup="listbox"
        aria-expanded={open}
        className="inline-flex items-center gap-1.5 px-2.5 py-2 text-[13px] font-medium text-gray-700 bg-white border border-gray-200 rounded-lg hover:bg-gray-50 hover:text-[#7C3AED] transition-colors max-w-[220px]"
      >
        {dot
          ? <span className="w-2.5 h-2.5 rounded-full flex-shrink-0 ring-1 ring-black/5" style={{ backgroundColor: dot }} />
          : <Server className="w-3.5 h-3.5 text-gray-400 flex-shrink-0" />}
        <span className="truncate min-w-0">{label}</span>
        <ChevronDown className={`w-3.5 h-3.5 flex-shrink-0 text-gray-400 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>

      {open && (
        <div role="listbox" className="absolute right-0 mt-1.5 w-[300px] bg-white rounded-xl border border-gray-100 shadow-xl z-30 overflow-hidden">
          <div className="px-3 py-2 border-b border-gray-100">
            <p className="text-[10.5px] font-semibold uppercase tracking-wide text-gray-400">Environment</p>
          </div>
          <div className="max-h-[300px] overflow-y-auto py-1">
            {/* No environment */}
            <button
              type="button"
              role="option"
              aria-selected={noneSelected}
              onClick={() => choose(NO_ENVIRONMENT)}
              className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-[#F5F3FF]"
            >
              <CircleSlash className="w-3.5 h-3.5 text-gray-400 flex-shrink-0" />
              <span className="text-[12.5px] text-gray-700 flex-1 min-w-0 truncate">No environment</span>
              {noneSelected && <Check className="w-4 h-4 text-[#7C3AED] flex-shrink-0" />}
            </button>

            {environments.length === 0 ? (
              <p className="px-3 py-2 text-[11.5px] text-gray-400">No environments yet — create one to resolve variables.</p>
            ) : environments.map((env) => {
              const active = !noneSelected && activeEnvironment?.id === env.id;
              return (
                <button
                  key={env.id}
                  type="button"
                  role="option"
                  aria-selected={active}
                  onClick={() => choose(env.id)}
                  className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-[#F5F3FF]"
                >
                  <span className="w-2.5 h-2.5 rounded-full flex-shrink-0 ring-1 ring-black/5" style={{ backgroundColor: envColor(env.color) }} />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-1.5">
                      <span className="text-[12.5px] text-gray-800 truncate">{env.name}</span>
                      {env.isDefault && <Star className="w-2.5 h-2.5 text-[#7C3AED] flex-shrink-0" fill="currentColor" />}
                    </span>
                    <span className="block text-[10.5px] text-gray-400 font-mono truncate">
                      {env.baseUrl || 'no base URL'}{env.variables.length ? ` · ${env.variables.length} var${env.variables.length === 1 ? '' : 's'}` : ''}
                    </span>
                  </span>
                  {active && <Check className="w-4 h-4 text-[#7C3AED] flex-shrink-0" />}
                </button>
              );
            })}
          </div>
          <button
            type="button"
            onClick={() => { setOpen(false); onManage(); }}
            className="w-full flex items-center gap-1.5 px-3 py-2 text-[12px] font-medium text-[#7C3AED] border-t border-gray-100 hover:bg-[#F5F3FF]"
          >
            <Settings2 className="w-3.5 h-3.5" />Manage environments
          </button>
        </div>
      )}
    </div>
  );
}
