/**
 * EndpointsView — the catalogue.
 *
 * Left: every endpoint the imports produced, grouped by resource, filterable,
 * selectable, editable. Right: what the platform understood about them and
 * the strategy that will steer generation. The one call to action is
 * "Design scenarios", which starts the run for the selected endpoints.
 */
import { useMemo, useState } from 'react';
import { Search, Trash2, Pencil, Loader2, Layers, Plus, Download, ChevronDown, ChevronRight, Globe, Sparkles, ShieldCheck, Gauge, ShieldAlert, ScrollText, Target, Wrench, GitCompare, Table2, Clock, Wand2, GitPullRequestArrow, Radio } from 'lucide-react';
import { useToast } from '@/components/feedback/ToastProvider';
import { MethodBadge, StatusCode, EmptyState } from '../primitives';
import { PRIMARY_BTN, SECONDARY_BTN, INPUT, FIELD, CARD, BRAND_CHIP, MUTED_CHIP, STRIP, THEAD, IMPORT_METHOD_LABELS, pathOf, hostOf } from '../format';
import EndpointEditor from '../EndpointEditor';
import ContractCheck from '../ContractCheck';
import LoadTest from '../LoadTest';
import SecurityScan from '../SecurityScan';
import GovernanceCheck from '../GovernanceCheck';
import Coverage from '../Coverage';
import BaselineDiff from '../BaselineDiff';
import DataDriven from '../DataDriven';
import RunAutomation from '../RunAutomation';
import NlAuthor from '../NlAuthor';
import ContractDrift from '../ContractDrift';
import AsyncProbe from '../AsyncProbe';
import { toConnectorManifest, toOpenApi, toMockServer, toPactContract, downloadText } from '../generators';
import InsightsPanel from './InsightsPanel';
import StrategyBar from './StrategyBar';
import type { Catalog } from '../hooks/useCatalog';
import type { CatalogEndpoint, Scenario, StrategyLayerId } from '../types';

interface Props {
  catalog: Catalog;
  running: boolean;
  onDesign: () => void;
  onImport: () => void;
  /** The current run's designed scenarios — read-only, for coverage. */
  scenarios?: Scenario[];
}

export default function EndpointsView({ catalog, running, onDesign, onImport, scenarios = [] }: Props) {
  const { endpoints, selected, profile } = catalog;
  const toast = useToast();
  const [q, setQ] = useState('');
  const [methodFilter, setMethodFilter] = useState('all');
  const [resourceFocus, setResourceFocus] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [editing, setEditing] = useState<CatalogEndpoint | null>(null);
  const [contractOpen, setContractOpen] = useState(false);
  const [loadOpen, setLoadOpen] = useState(false);
  const [securityOpen, setSecurityOpen] = useState(false);
  const [governanceOpen, setGovernanceOpen] = useState(false);
  const [coverageOpen, setCoverageOpen] = useState(false);
  const [baselineOpen, setBaselineOpen] = useState(false);
  const [dataDrivenOpen, setDataDrivenOpen] = useState(false);
  const [automationOpen, setAutomationOpen] = useState(false);
  const [nlOpen, setNlOpen] = useState(false);
  const [driftOpen, setDriftOpen] = useState(false);
  const [asyncOpen, setAsyncOpen] = useState(false);
  const [toolsOpen, setToolsOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);

  const methods = useMemo(() => [...new Set(endpoints.map((e) => e.method))].sort(), [endpoints]);

  const visible = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return endpoints.filter((e) => {
      if (methodFilter !== 'all' && e.method !== methodFilter) return false;
      if (resourceFocus && (e.resource || '') !== resourceFocus) return false;
      if (!needle) return true;
      return e.url.toLowerCase().includes(needle) || e.title.toLowerCase().includes(needle) || (e.resource || '').toLowerCase().includes(needle) || (e.tags || []).some((t) => t.toLowerCase().includes(needle));
    });
  }, [endpoints, q, methodFilter, resourceFocus]);

  /** Group by host → resource so a 300-endpoint catalogue still reads. */
  const groups = useMemo(() => {
    const map = new Map<string, CatalogEndpoint[]>();
    for (const e of visible) {
      const key = `${hostOf(e.url)} · ${e.resource || 'other'}`;
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(e);
    }
    return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [visible]);

  const allVisibleSelected = visible.length > 0 && visible.every((e) => selected.has(e.id));
  const selectedCount = selected.size;

  /** Generate a portable artifact from the selected endpoints (or all). */
  const exportAs = (kind: 'connector' | 'openapi' | 'mock' | 'pact') => {
    const list = selected.size > 0 ? endpoints.filter((e) => selected.has(e.id)) : endpoints;
    setExportOpen(false);
    if (kind === 'connector') downloadText('api-connector.json', toConnectorManifest(list));
    else if (kind === 'openapi') downloadText('openapi.json', toOpenApi(list));
    else if (kind === 'mock') downloadText('mock-server.mjs', toMockServer(list), 'text/javascript');
    else if (kind === 'pact') downloadText('pact-contract.json', toPactContract(list));
  };

  if (endpoints.length === 0) {
    return (
      <div className="h-full flex flex-col">
        <EmptyState icon={Layers} title="The catalogue is empty" hint="Import an OpenAPI spec, a Postman collection, a cURL command, a docs page, an SDK — or build a request by hand. Every endpoint lands here for review before anything is designed." />
        <div className="flex justify-center -mt-10 pb-10"><button type="button" onClick={onImport} className={PRIMARY_BTN}><Plus className="w-3.5 h-3.5" />Import APIs</button></div>
      </div>
    );
  }

  return (
    <div className="h-full flex min-h-0">
      {/* ── Table ── */}
      <div className="@container flex-1 min-w-0 flex flex-col min-h-0">
        {/* The filters shrink, the actions never do, and nothing leaves the column.
            Sizes come from @container queries because the constraint is this
            column’s width — the nav rail and the insights panel take their cut
            first, so a viewport breakpoint would report room that is not here. */}
        <div className={`relative z-10 flex items-center gap-2 px-4 h-11 min-w-0 overflow-hidden border-b border-gray-100 flex-shrink-0 ${STRIP}`}>
          <div className="flex items-center gap-2 min-w-0 flex-1 overflow-hidden">
            <label className="flex items-center gap-1.5 text-[11px] text-gray-600 cursor-pointer select-none flex-shrink-0">
              <input type="checkbox" checked={allVisibleSelected} onChange={() => catalog.selectMany(visible.map((e) => e.id), !allVisibleSelected)} className="w-3.5 h-3.5 rounded border-gray-300 text-[#7C3AED] focus:ring-[#A5B4FC] focus:ring-offset-0" />
              <span className="font-medium tabular-nums whitespace-nowrap">{selectedCount}/{endpoints.length}<span className="hidden @[560px]:inline"> selected</span></span>
            </label>
            <div className="relative min-w-0 flex-1 max-w-[260px] hidden @[420px]:block">
              <Search className="w-3.5 h-3.5 text-gray-300 absolute left-2 top-1/2 -translate-y-1/2 pointer-events-none" />
              <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter…" title="Filter by path, name or tag" className={`${INPUT} pl-7 py-1`} />
            </div>
            <select value={methodFilter} onChange={(e) => setMethodFilter(e.target.value)} className={`${FIELD} w-auto py-1 flex-shrink-0 hidden @[680px]:block`}>
              <option value="all">All methods</option>
              {methods.map((m) => <option key={m} value={m}>{m}</option>)}
            </select>
            {resourceFocus && (
              <button type="button" onClick={() => setResourceFocus(null)} title="Clear the resource filter" className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full border text-[11px] min-w-0 max-w-[140px] flex-shrink ${BRAND_CHIP}`}><span className="truncate">{resourceFocus}</span> ×</button>
            )}
          </div>
          <div className="flex items-center gap-1.5 flex-shrink-0">
            {selectedCount > 0 && (
              <button type="button" onClick={() => catalog.removeEndpoints([...selected])} disabled={running} className={SECONDARY_BTN} title="Remove the selected endpoints from the catalogue"><Trash2 className="w-3.5 h-3.5" /><span className="hidden @[1000px]:inline">Remove</span></button>
            )}
            <div className="relative">
              <button type="button" onClick={() => setToolsOpen((o) => !o)} className={SECONDARY_BTN} title="Quality tools — validate, scan, load-test, lint, coverage"><Wrench className="w-3.5 h-3.5" /><span className="hidden @[1000px]:inline">Tools</span><ChevronDown className="w-3 h-3" /></button>
              {toolsOpen && (
                <>
                  <div className="fixed inset-0 z-40" onClick={() => setToolsOpen(false)} />
                  <div className="absolute right-0 mt-1 z-50 w-60 bg-white border border-[#E4E0F5] rounded-lg py-1 shadow-[0_14px_32px_-12px_rgba(76,29,149,0.5)]">
                    {([
                      { icon: Wand2, label: 'Author in plain English', desc: 'Describe tests → a run strategy', open: () => setNlOpen(true) },
                      { icon: ShieldCheck, label: 'Contract validation', desc: 'Live-check status, JSON & schema', open: () => setContractOpen(true) },
                      { icon: GitPullRequestArrow, label: 'Contract drift', desc: 'Adopt live changes into the catalogue', open: () => setDriftOpen(true) },
                      { icon: ShieldAlert, label: 'Security scan', desc: 'Broken auth, injection, headers, CORS', open: () => setSecurityOpen(true) },
                      { icon: Gauge, label: 'Load test', desc: 'Latency, throughput, status mix', open: () => setLoadOpen(true) },
                      { icon: ScrollText, label: 'Governance lint', desc: 'API design smells', open: () => setGovernanceOpen(true) },
                      { icon: Target, label: 'Test coverage', desc: 'Which endpoints are tested', open: () => setCoverageOpen(true) },
                      { icon: GitCompare, label: 'Regression baselines', desc: 'Snapshot responses & diff for drift', open: () => setBaselineOpen(true) },
                      { icon: Table2, label: 'Data-driven testing', desc: 'Run one endpoint over a data table', open: () => setDataDrivenOpen(true) },
                      { icon: Radio, label: 'Async & streaming', desc: 'Test WebSocket and SSE endpoints', open: () => setAsyncOpen(true) },
                      { icon: Clock, label: 'Schedules & webhooks', desc: 'Recurring runs and Slack/Teams alerts', open: () => setAutomationOpen(true) },
                    ]).map((t) => (
                      <button key={t.label} type="button" onClick={() => { setToolsOpen(false); t.open(); }} className="w-full flex items-start gap-2.5 px-3 py-2 text-left hover:bg-[#F5F3FF] transition-colors">
                        <t.icon className="w-4 h-4 text-[#7C3AED] flex-shrink-0 mt-0.5" />
                        <span className="min-w-0">
                          <span className="block text-[12px] font-medium text-gray-800">{t.label}</span>
                          <span className="block text-[10.5px] text-gray-400">{t.desc}</span>
                        </span>
                      </button>
                    ))}
                    <div className="mx-2 my-1 border-t border-gray-100" />
                    <p className="px-3 py-1 text-[10px] text-gray-400">Runs on {selectedCount > 0 ? `${selectedCount} selected` : 'all'} endpoint{selectedCount === 1 ? '' : 's'}</p>
                  </div>
                </>
              )}
            </div>
            <div className="relative">
              <button type="button" onClick={() => setExportOpen((o) => !o)} className={SECONDARY_BTN} title="Export the catalogue as a portable artifact"><Download className="w-3.5 h-3.5" /><span className="hidden @[1000px]:inline">Export</span><ChevronDown className="w-3 h-3" /></button>
              {exportOpen && (
                <>
                  <div className="fixed inset-0 z-40" onClick={() => setExportOpen(false)} />
                  <div className="absolute right-0 mt-1 z-50 w-56 bg-white border border-[#E4E0F5] rounded-lg py-1 shadow-[0_14px_32px_-12px_rgba(76,29,149,0.5)]">
                    {([
                      { k: 'openapi' as const, label: 'OpenAPI 3 spec', desc: 'openapi.json' },
                      { k: 'connector' as const, label: 'Connector manifest', desc: 'round-trips into Import' },
                      { k: 'mock' as const, label: 'Mock server', desc: 'runnable, zero-dependency Node' },
                      { k: 'pact' as const, label: 'Pact contract', desc: 'consumer-driven contract (v2)' },
                    ]).map((it) => (
                      <button key={it.k} type="button" onClick={() => exportAs(it.k)} className="w-full flex flex-col items-start px-3 py-1.5 text-left hover:bg-[#F5F3FF] transition-colors">
                        <span className="text-[12px] font-medium text-gray-800">{it.label}</span>
                        <span className="text-[10.5px] text-gray-400">{it.desc}</span>
                      </button>
                    ))}
                  </div>
                </>
              )}
            </div>
            <button type="button" onClick={onImport} className={SECONDARY_BTN} title="Import more APIs"><Plus className="w-3.5 h-3.5" /><span className="hidden @[1000px]:inline">Import</span></button>
            <button type="button" onClick={onDesign} disabled={running || selectedCount === 0} title={`Design scenarios for ${selectedCount} selected endpoint${selectedCount === 1 ? '' : 's'}`} className={`${PRIMARY_BTN} whitespace-nowrap`}>
              {running ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Sparkles className="w-3.5 h-3.5" />}
              {running ? 'Designing…' : <>Design<span className="hidden @[820px]:inline"> scenarios</span> ({selectedCount})</>}
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-auto min-w-0 min-h-0 bg-white">
          {visible.length === 0 ? (
            <EmptyState icon={Search} title="No endpoints match" hint="Clear the filter or pick another resource." />
          ) : (
            <table className="w-full text-[12px]">
              <thead className={`sticky top-0 backdrop-blur text-[10.5px] uppercase tracking-wide text-gray-500 z-10 ${THEAD}`}>
                <tr>
                  <th className="w-8" />
                  <th className="text-left px-2 py-1.5 font-semibold w-[76px]">Method</th>
                  <th className="text-left px-2 py-1.5 font-semibold">Endpoint</th>
                  <th className="text-left px-2 py-1.5 font-semibold w-[90px]">Auth</th>
                  <th className="text-left px-2 py-1.5 font-semibold w-[70px]">Expect</th>
                  <th className="text-left px-2 py-1.5 font-semibold w-[110px] hidden @[900px]:table-cell">Source</th>
                  <th className="w-[64px]" />
                </tr>
              </thead>
              <tbody>
                {groups.map(([key, list]) => {
                  const isCollapsed = !!collapsed[key];
                  const groupSelected = list.every((e) => selected.has(e.id));
                  return (
                    <GroupRows key={key} label={key} list={list} collapsed={isCollapsed} groupSelected={groupSelected}
                      onToggleCollapse={() => setCollapsed((c) => ({ ...c, [key]: !isCollapsed }))}
                      onToggleGroup={() => catalog.selectMany(list.map((e) => e.id), !groupSelected)}
                      selected={selected} running={running}
                      onToggle={catalog.toggle} onEdit={setEditing} onRemove={(id) => catalog.removeEndpoints([id])}
                    />
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      </div>

      {/* ── Intelligence & strategy ── */}
      <aside className="relative z-20 w-[340px] flex-shrink-0 border-l border-gray-100 bg-gray-50/60 overflow-y-auto min-h-0 p-3 space-y-3">
        <StrategyBar strategy={catalog.strategy} profile={profile} onCoverage={(c) => catalog.setStrategy({ coverage: c })} onToggleLayer={catalog.toggleLayer} onAdopt={catalog.adoptRecommendation} />
        <InsightsPanel profile={profile} analyzing={catalog.analyzing} error={catalog.analysisError} endpoints={endpoints} onDeepAnalyze={() => void catalog.analyze(true)} onFocusResource={setResourceFocus} />
        {catalog.imports.length > 0 && (
          <div className={`${CARD} p-3.5`}>
            <h3 className="text-[11px] font-semibold text-gray-700 uppercase tracking-wide mb-2">Imports this session</h3>
            <ul className="space-y-1">
              {catalog.imports.slice(0, 8).map((im) => (
                <li key={im.id} className="flex items-center gap-2 text-[11px]">
                  <span className={`inline-flex px-1.5 py-0.5 rounded border text-[9.5px] font-semibold ${MUTED_CHIP}`}>{IMPORT_METHOD_LABELS[im.method] || im.method}</span>
                  <span className="truncate text-gray-700 flex-1 min-w-0" title={im.name}>{im.name}</span>
                  <span className="font-mono text-gray-400 tabular-nums">{im.count}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </aside>

      {editing && (
        <EndpointEditor
          initial={editing}
          onClose={() => setEditing(null)}
          onSave={(patch) => { catalog.updateEndpoint(editing.id, patch); setEditing(null); }}
        />
      )}

      {contractOpen && (
        <ContractCheck
          endpoints={selectedCount > 0 ? endpoints.filter((e) => selected.has(e.id)) : endpoints}
          onClose={() => setContractOpen(false)}
        />
      )}
      {securityOpen && (
        <SecurityScan
          endpoints={selectedCount > 0 ? endpoints.filter((e) => selected.has(e.id)) : endpoints}
          onClose={() => setSecurityOpen(false)}
        />
      )}
      {loadOpen && (
        <LoadTest
          endpoints={selectedCount > 0 ? endpoints.filter((e) => selected.has(e.id)) : endpoints}
          onClose={() => setLoadOpen(false)}
        />
      )}
      {governanceOpen && (
        <GovernanceCheck
          endpoints={selectedCount > 0 ? endpoints.filter((e) => selected.has(e.id)) : endpoints}
          onClose={() => setGovernanceOpen(false)}
        />
      )}
      {coverageOpen && (
        <Coverage
          endpoints={selectedCount > 0 ? endpoints.filter((e) => selected.has(e.id)) : endpoints}
          scenarios={scenarios}
          onClose={() => setCoverageOpen(false)}
        />
      )}
      {baselineOpen && (
        <BaselineDiff
          endpoints={selectedCount > 0 ? endpoints.filter((e) => selected.has(e.id)) : endpoints}
          onClose={() => setBaselineOpen(false)}
        />
      )}
      {dataDrivenOpen && (
        <DataDriven
          endpoints={selectedCount > 0 ? endpoints.filter((e) => selected.has(e.id)) : endpoints}
          onClose={() => setDataDrivenOpen(false)}
        />
      )}
      {automationOpen && (
        <RunAutomation
          endpoints={selectedCount > 0 ? endpoints.filter((e) => selected.has(e.id)) : endpoints}
          onClose={() => setAutomationOpen(false)}
        />
      )}
      {nlOpen && (
        <NlAuthor
          endpoints={selectedCount > 0 ? endpoints.filter((e) => selected.has(e.id)) : endpoints}
          onApply={(brief) => {
            catalog.setStrategy({ coverage: brief.coverage, layers: brief.layers as StrategyLayerId[], requirements: brief.requirements });
            toast.success('Strategy updated', `${brief.coverage} coverage · ${brief.layers.length} layer${brief.layers.length === 1 ? '' : 's'} · brief applied`);
          }}
          onClose={() => setNlOpen(false)}
        />
      )}
      {driftOpen && (
        <ContractDrift
          endpoints={selectedCount > 0 ? endpoints.filter((e) => selected.has(e.id)) : endpoints}
          onAdopt={(id, patch) => { catalog.updateEndpoint(id, patch); toast.success('Catalogue updated', 'Adopted the live contract for this endpoint.'); }}
          onClose={() => setDriftOpen(false)}
        />
      )}
      {asyncOpen && (
        <AsyncProbe
          initialUrl={(selectedCount > 0 ? endpoints.find((e) => selected.has(e.id)) : endpoints[0])?.url || ''}
          onClose={() => setAsyncOpen(false)}
        />
      )}
    </div>
  );
}

function GroupRows({ label, list, collapsed, groupSelected, onToggleCollapse, onToggleGroup, selected, running, onToggle, onEdit, onRemove }: {
  label: string; list: CatalogEndpoint[]; collapsed: boolean; groupSelected: boolean; onToggleCollapse: () => void; onToggleGroup: () => void;
  selected: Set<string>; running: boolean; onToggle: (id: string) => void; onEdit: (e: CatalogEndpoint) => void; onRemove: (id: string) => void;
}) {
  return (
    <>
      <tr className="bg-gray-50 border-y border-gray-100">
        <td className="px-2 py-1"><input type="checkbox" checked={groupSelected} onChange={onToggleGroup} className="w-3.5 h-3.5 rounded border-gray-300 text-[#7C3AED] focus:ring-[#A5B4FC] focus:ring-offset-0" /></td>
        <td colSpan={7} className="px-2 py-1">
          <button type="button" onClick={onToggleCollapse} className="inline-flex items-center gap-1.5 text-[11px] font-semibold text-gray-700 hover:text-[#7C3AED]">
            {collapsed ? <ChevronRight className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
            <Globe className="w-3 h-3 text-gray-400" />{label}
            <span className="font-mono font-normal text-gray-400 tabular-nums">{list.length}</span>
          </button>
        </td>
      </tr>
      {!collapsed && list.map((e) => {
        const on = selected.has(e.id);
        return (
          <tr key={e.id} className={`border-b border-gray-50 hover:bg-[#FAFAFE] hover:shadow-[inset_3px_0_0_0_#C4B5FD] transition-[background,box-shadow] group ${on ? '' : 'opacity-60'}`}>
            <td className="px-2 py-1.5 align-top"><input type="checkbox" checked={on} onChange={() => onToggle(e.id)} className="w-3.5 h-3.5 rounded border-gray-300 text-[#7C3AED] focus:ring-[#A5B4FC] focus:ring-offset-0" /></td>
            <td className="px-2 py-1.5 align-top"><MethodBadge method={e.method} /></td>
            <td className="px-2 py-1.5 align-top max-w-0 w-full">
              <div className="font-mono text-[11.5px] text-gray-800 truncate" title={e.url}>{pathOf(e.url)}</div>
              <div className="text-[10.5px] text-gray-500 truncate">
                {e.title}{e.deprecated && <span className="ml-1 text-amber-600">· deprecated</span>}{e.discovered && <span className="ml-1 text-[#7C3AED]">· discovered</span>}
                {e.style && e.style !== 'rest' && <span className="ml-1 uppercase text-gray-400">· {e.style}</span>}
              </div>
            </td>
            <td className="px-2 py-1.5 align-top text-[11px] text-gray-500">{e.auth.type === 'none' ? <span className="text-gray-300">—</span> : e.auth.type === 'apikey' ? `key · ${e.auth.headerName || 'X-API-Key'}` : e.auth.type}</td>
            <td className="px-2 py-1.5 align-top"><StatusCode code={e.expectedStatus || ''} /></td>
            <td className="px-2 py-1.5 align-top text-[10.5px] text-gray-500 truncate max-w-[110px] hidden @[900px]:table-cell" title={e.source?.name}>{e.source ? IMPORT_METHOD_LABELS[e.source.method] || e.source.method : ''}</td>
            <td className="px-2 py-1.5 align-top">
              <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                <button type="button" onClick={() => onEdit(e)} disabled={running} className="p-1 rounded text-gray-400 hover:text-[#7C3AED] hover:bg-[#F5F3FF]" title="Edit"><Pencil className="w-3.5 h-3.5" /></button>
                <button type="button" onClick={() => onRemove(e.id)} disabled={running} className="p-1 rounded text-gray-400 hover:text-red-500 hover:bg-red-50" title="Remove"><Trash2 className="w-3.5 h-3.5" /></button>
              </div>
            </td>
          </tr>
        );
      })}
    </>
  );
}
