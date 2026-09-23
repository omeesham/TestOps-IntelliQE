/**
 * Coverage — API test-coverage measurement.
 *
 * Read-only and client-side: it matches the designed scenarios back onto the
 * catalogue to answer "which endpoints are actually tested, and how?" — overall
 * coverage, the category mix, and the explicit list of untested endpoints.
 * Nothing here calls the network or touches the pipeline.
 */
import { useMemo } from 'react';
import { X, Target, CheckCircle2, CircleDashed } from 'lucide-react';
import { MethodBadge } from './primitives';
import { CARD, STRIP, BRAND_CHIP, pathOf, categoryMeta } from './format';
import type { CatalogEndpoint, Scenario } from './types';

interface EndpointCoverage { endpoint: CatalogEndpoint; scenarios: number; categories: string[] }

function coverageOf(endpoints: CatalogEndpoint[], scenarios: Scenario[]): { rows: EndpointCoverage[]; categoryCounts: Record<string, number> } {
  const categoryCounts: Record<string, number> = {};
  for (const s of scenarios) { const t = (s.type || 'other').toLowerCase(); categoryCounts[t] = (categoryCounts[t] || 0) + 1; }

  const rows = endpoints.map((e) => {
    const epPath = pathOf(e.url);
    const method = (e.method || 'GET').toUpperCase();
    const matched = scenarios.filter((s) => {
      const sm = (s.api?.method || '').toUpperCase();
      if (sm && sm !== method) return false;
      const sp = s.api?.endpoint ? pathOf(s.api.endpoint) : '';
      if (!sp) return false;
      return sp === epPath || sp.includes(epPath) || epPath.includes(sp);
    });
    const categories = [...new Set(matched.map((s) => (s.type || 'other').toLowerCase()))];
    return { endpoint: e, scenarios: matched.length, categories };
  });
  return { rows, categoryCounts };
}

export default function Coverage({ endpoints, scenarios, onClose }: { endpoints: CatalogEndpoint[]; scenarios: Scenario[]; onClose: () => void }) {
  const { rows, categoryCounts } = useMemo(() => coverageOf(endpoints, scenarios), [endpoints, scenarios]);
  const covered = rows.filter((r) => r.scenarios > 0).length;
  const total = rows.length;
  const pct = total ? Math.round((covered / total) * 100) : 0;
  const uncovered = rows.filter((r) => r.scenarios === 0);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-[#1E1B4B]/30 backdrop-blur-sm p-4" onClick={onClose}>
      <div className={`${CARD} w-full max-w-2xl max-h-[85vh] flex flex-col overflow-hidden`} onClick={(e) => e.stopPropagation()}>
        <div className={`flex items-center gap-2 px-4 h-12 border-b border-[#EDE9FE] flex-shrink-0 ${STRIP}`}>
          <Target className="w-4 h-4 text-[#7C3AED]" />
          <h3 className="text-[13px] font-semibold text-gray-900">Test coverage</h3>
          <span className="text-[11px] text-gray-400">designed scenarios mapped onto the catalogue</span>
          <button type="button" onClick={onClose} className="ml-auto p-1.5 rounded-md text-gray-400 hover:text-[#7C3AED] hover:bg-[#F5F3FF]"><X className="w-4 h-4" /></button>
        </div>

        {scenarios.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-2 py-16 text-center px-8">
            <CircleDashed className="w-8 h-8 text-gray-300" />
            <p className="text-[12.5px] text-gray-600 font-medium">No scenarios designed yet</p>
            <p className="text-[11.5px] text-gray-400">Design scenarios for your endpoints and coverage appears here — which endpoints are tested, by which categories.</p>
          </div>
        ) : (
          <div className="flex-1 overflow-y-auto min-h-0">
            {/* Headline */}
            <div className="px-4 py-3 border-b border-[#EDE9FE]">
              <div className="flex items-end gap-3">
                <div className={`text-4xl font-semibold tabular-nums leading-none ${pct >= 80 ? 'text-emerald-600' : pct >= 50 ? 'text-[#7C3AED]' : 'text-amber-600'}`}>{pct}%</div>
                <div className="text-[12px] text-gray-500 pb-1"><span className="font-semibold text-gray-800 tabular-nums">{covered}</span> of {total} endpoints covered by {scenarios.length} scenario{scenarios.length === 1 ? '' : 's'}</div>
              </div>
              <div className="flex h-2 rounded-full overflow-hidden bg-gray-200 mt-3">
                <div className="bg-gradient-to-r from-emerald-400 to-emerald-500" style={{ width: `${pct}%` }} />
              </div>
              <div className="mt-3 flex flex-wrap gap-1.5">
                {Object.entries(categoryCounts).sort((a, b) => b[1] - a[1]).map(([cat, n]) => {
                  const meta = categoryMeta(cat);
                  return <span key={cat} className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded border text-[10px] font-semibold ${meta.cls}`}>{meta.label}<span className="tabular-nums font-mono">{n}</span></span>;
                })}
              </div>
            </div>

            {/* Uncovered gap */}
            {uncovered.length > 0 && (
              <div className="px-4 py-2.5 border-b border-[#EDE9FE]">
                <h4 className="text-[11px] font-semibold text-gray-700 uppercase tracking-wide mb-1.5">Untested · {uncovered.length}</h4>
                <div className="space-y-1">
                  {uncovered.map((r) => (
                    <div key={r.endpoint.id} className="flex items-center gap-2 text-[11.5px]">
                      <CircleDashed className="w-3 h-3 text-amber-500 flex-shrink-0" />
                      <MethodBadge method={r.endpoint.method} />
                      <span className="font-mono text-gray-700 truncate">{pathOf(r.endpoint.url)}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Covered detail */}
            <div className="divide-y divide-gray-50">
              {rows.filter((r) => r.scenarios > 0).map((r) => (
                <div key={r.endpoint.id} className="px-4 py-2 flex items-center gap-2">
                  <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500 flex-shrink-0" />
                  <MethodBadge method={r.endpoint.method} />
                  <span className="font-mono text-[11.5px] text-gray-700 min-w-0 flex-1 truncate">{pathOf(r.endpoint.url)}</span>
                  <span className={`text-[9.5px] font-semibold px-1.5 py-0.5 rounded border flex-shrink-0 ${BRAND_CHIP}`}>{r.scenarios} scenario{r.scenarios === 1 ? '' : 's'}</span>
                  <span className="text-[10px] text-gray-400 flex-shrink-0 hidden sm:block">{r.categories.map((c) => categoryMeta(c).label).join(' · ')}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
