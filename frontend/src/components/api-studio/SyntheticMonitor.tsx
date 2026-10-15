/**
 * SyntheticMonitor — scheduled multi-location uptime checks.
 *
 * A standalone modal with two views: a LIST of configured monitors and an
 * EDITOR for one. Each monitor is a read-only (GET/HEAD) check fanned out across
 * named locations — every location can route its egress through its own proxy,
 * so one monitor probes an API from several vantage points. Optional trace
 * correlation (Jaeger/Zipkin/Tempo) ties a check to its backend spans, and an
 * optional canary gate compares live latency/error-rate against a baseline and
 * POSTs a rollback SIGNAL to a webhook on breach — it never touches infra.
 */
import { useEffect, useState } from 'react';
import { Activity, X, Plus, Trash2, Play, Power, Globe, Radar, Zap, ChevronLeft, ChevronRight } from 'lucide-react';
import Spinner from '@/components/feedback/Spinner';
import {
  listSyntheticMonitors, saveSyntheticMonitor, setSyntheticMonitorEnabled,
  deleteSyntheticMonitor, listSyntheticResults, runSyntheticMonitor, previewSyntheticCheck,
  type SyntheticMonitor as MonitorDef, type SyntheticCheckEndpoint, type SyntheticLocation,
  type SyntheticTracingConfig, type CanaryConfig, type SyntheticResult, type SyntheticStatus,
  type SyntheticLocationResult, type CanaryVerdict, type SyntheticTraceSummary,
} from '@/services/api';
import { MethodBadge } from './primitives';
import { CARD, STRIP, INPUT, FIELD, LABEL, PRIMARY_BTN, SECONDARY_BTN, relativeTime } from './format';
import type { CatalogEndpoint } from './types';

/* A preview carries the same body as a stored result, without its identifiers. */
type CheckOutcome = Omit<SyntheticResult, 'id' | 'monitorId' | 'createdAt'>;

const STATUS_BADGE: Record<SyntheticStatus, { label: string; cls: string }> = {
  up: { label: 'Up', cls: 'text-emerald-700 bg-emerald-50 border-emerald-200' },
  degraded: { label: 'Degraded', cls: 'text-amber-700 bg-amber-50 border-amber-200' },
  down: { label: 'Down', cls: 'text-red-700 bg-red-50 border-red-200' },
  rollback: { label: 'Rollback', cls: 'text-red-700 bg-red-100 border-red-300 font-bold' },
};

function dotClass(status?: string): string {
  if (status === 'up') return 'bg-emerald-500';
  if (status === 'degraded') return 'bg-amber-500';
  if (status === 'down' || status === 'rollback') return 'bg-red-500';
  return 'bg-gray-300';
}

function blankDraft(): Partial<MonitorDef> {
  return { name: '', enabled: true, intervalMinutes: 15, endpoint: { method: 'GET', url: '' }, locations: [], tracing: null, canary: null };
}

/** Drop a canary config that carries no actual thresholds — the backend wants null. */
function cleanCanary(c: CanaryConfig | null | undefined): CanaryConfig | null {
  if (!c) return null;
  const has =
    !!c.baselineUrl?.trim() || !!c.rollbackWebhookUrl?.trim() ||
    c.maxErrorRatePct != null || c.maxLatencyMs != null || c.maxLatencyDeltaPct != null;
  return has ? c : null;
}

export default function SyntheticMonitor({ endpoints, onClose }: { endpoints: CatalogEndpoint[]; onClose: () => void }) {
  const [view, setView] = useState<'list' | 'editor'>('list');
  const [monitors, setMonitors] = useState<MonitorDef[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string>('');

  // List-row interaction.
  const [busyId, setBusyId] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [rowResults, setRowResults] = useState<Record<string, SyntheticResult[]>>({});

  // Editor.
  const [draft, setDraft] = useState<Partial<MonitorDef>>(blankDraft());
  const [editingId, setEditingId] = useState<string | null>(null);
  const [tracingOpen, setTracingOpen] = useState<boolean>(false);
  const [canaryOpen, setCanaryOpen] = useState<boolean>(false);
  const [saving, setSaving] = useState<boolean>(false);
  const [previewing, setPreviewing] = useState<boolean>(false);
  const [previewResult, setPreviewResult] = useState<CheckOutcome | null>(null);

  const refresh = async () => {
    const { monitors: list } = await listSyntheticMonitors();
    setMonitors(list);
  };

  useEffect(() => {
    (async () => {
      try { setLoading(true); setError(''); await refresh(); }
      catch (err: any) { setError(err?.response?.data?.error || err?.message || 'Request failed.'); }
      finally { setLoading(false); }
    })();
  }, []);

  /* ── List actions ───────────────────────────────────────────── */

  const toggleEnabled = async (m: MonitorDef) => {
    try {
      setBusyId(m.id); setError('');
      const updated = await setSyntheticMonitorEnabled(m.id, !m.enabled);
      setMonitors((list) => list.map((x) => (x.id === m.id ? updated : x)));
    } catch (err: any) { setError(err?.response?.data?.error || err?.message || 'Request failed.'); }
    finally { setBusyId(null); }
  };

  const runNow = async (id: string) => {
    try {
      setBusyId(id); setError('');
      const res = await runSyntheticMonitor(id);
      setRowResults((r) => ({ ...r, [id]: [res, ...(r[id] || [])] }));
      setExpandedId(id);
      await refresh();
    } catch (err: any) { setError(err?.response?.data?.error || err?.message || 'Request failed.'); }
    finally { setBusyId(null); }
  };

  const loadResults = async (id: string) => {
    if (expandedId === id) { setExpandedId(null); return; }
    try {
      setBusyId(id); setError('');
      const { results } = await listSyntheticResults(id, 10);
      setRowResults((r) => ({ ...r, [id]: results }));
      setExpandedId(id);
    } catch (err: any) { setError(err?.response?.data?.error || err?.message || 'Request failed.'); }
    finally { setBusyId(null); }
  };

  const remove = async (id: string) => {
    try {
      setBusyId(id); setError('');
      await deleteSyntheticMonitor(id);
      setMonitors((list) => list.filter((x) => x.id !== id));
      if (expandedId === id) setExpandedId(null);
    } catch (err: any) { setError(err?.response?.data?.error || err?.message || 'Request failed.'); }
    finally { setBusyId(null); }
  };

  /* ── Editor plumbing ────────────────────────────────────────── */

  const openEditor = (m?: MonitorDef) => {
    if (m) {
      setEditingId(m.id);
      setDraft({
        name: m.name, enabled: m.enabled, intervalMinutes: m.intervalMinutes,
        endpoint: { ...m.endpoint }, locations: m.locations.map((l) => ({ ...l })),
        tracing: m.tracing ? { ...m.tracing } : null,
        canary: m.canary ? { ...m.canary } : null,
      });
      setTracingOpen(!!m.tracing); setCanaryOpen(!!m.canary);
    } else {
      setEditingId(null); setDraft(blankDraft()); setTracingOpen(false); setCanaryOpen(false);
    }
    setPreviewResult(null); setError(''); setView('editor');
  };

  const patchEndpoint = (p: Partial<SyntheticCheckEndpoint>) =>
    setDraft((d) => ({ ...d, endpoint: { method: 'GET', url: '', ...(d.endpoint || {}), ...p } }));

  const patchCanary = (p: Partial<CanaryConfig>) =>
    setDraft((d) => ({ ...d, canary: { ...(d.canary || {}), ...p } }));

  const setLocation = (i: number, p: Partial<SyntheticLocation>) =>
    setDraft((d) => ({ ...d, locations: (d.locations || []).map((l, j) => (j === i ? { ...l, ...p } : l)) }));

  const addLocation = () => setDraft((d) => ({ ...d, locations: [...(d.locations || []), { name: '' }] }));
  const removeLocation = (i: number) => setDraft((d) => ({ ...d, locations: (d.locations || []).filter((_, j) => j !== i) }));

  const applyCatalogEndpoint = (url: string) => {
    const ep = endpoints.find((x) => x.url === url);
    if (!ep) return;
    const m = /^(GET|HEAD)$/i.test(ep.method) ? ep.method.toUpperCase() : 'GET';
    patchEndpoint({
      method: m, url: ep.url, headers: ep.headers,
      auth: { type: ep.auth.type, value: ep.auth.value, headerName: ep.auth.headerName },
      expectedStatus: ep.expectedStatus,
    });
  };

  const setTracingType = (t: 'none' | SyntheticTracingConfig['type']) => {
    if (t === 'none') setDraft((d) => ({ ...d, tracing: null }));
    else setDraft((d) => ({ ...d, tracing: { type: t, queryUrl: d.tracing?.queryUrl ?? '' } }));
  };

  const buildCheck = (): { endpoint: SyntheticCheckEndpoint; locations: SyntheticLocation[]; tracing: SyntheticTracingConfig | null; canary: CanaryConfig | null } => ({
    endpoint: {
      method: draft.endpoint?.method || 'GET',
      url: (draft.endpoint?.url || '').trim(),
      headers: draft.endpoint?.headers,
      auth: draft.endpoint?.auth,
      expectedStatus: draft.endpoint?.expectedStatus,
      assertText: draft.endpoint?.assertText?.trim() || undefined,
    },
    locations: (draft.locations || []).filter((l) => l.name.trim()),
    tracing: draft.tracing ?? null,
    canary: cleanCanary(draft.canary),
  });

  const save = async () => {
    if (!(draft.endpoint?.url || '').trim()) { setError('A target URL is required.'); return; }
    try {
      setSaving(true); setError('');
      const check = buildCheck();
      await saveSyntheticMonitor({
        ...(editingId ? { id: editingId } : {}),
        name: draft.name?.trim() || 'Untitled monitor',
        enabled: draft.enabled ?? true,
        intervalMinutes: Math.min(1440, Math.max(1, draft.intervalMinutes ?? 15)),
        endpoint: check.endpoint, locations: check.locations,
        tracing: check.tracing, canary: check.canary,
      });
      await refresh();
      setView('list');
    } catch (err: any) { setError(err?.response?.data?.error || err?.message || 'Request failed.'); }
    finally { setSaving(false); }
  };

  const preview = async () => {
    if (!(draft.endpoint?.url || '').trim()) { setError('A target URL is required.'); return; }
    try {
      setPreviewing(true); setError(''); setPreviewResult(null);
      setPreviewResult(await previewSyntheticCheck(buildCheck()));
    } catch (err: any) { setError(err?.response?.data?.error || err?.message || 'Request failed.'); }
    finally { setPreviewing(false); }
  };

  /* ── Render ─────────────────────────────────────────────────── */

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-[#1E1B4B]/45 backdrop-blur-md p-4" onClick={onClose}>
      <div className={`${CARD} w-full max-w-3xl max-h-[88vh] flex flex-col overflow-hidden`} onClick={(e) => e.stopPropagation()}>
        <div className={`flex items-center gap-2 px-4 h-12 border-b border-[#EDE9FE] flex-shrink-0 ${STRIP}`}>
          <Activity className="w-4 h-4 text-[#7C3AED]" />
          <h3 className="text-[13px] font-semibold text-gray-900">Synthetic monitoring</h3>
          <span className="text-[11px] text-gray-400">Multi-location · trace correlation · canary</span>
          <button type="button" onClick={onClose} className="ml-auto p-1.5 rounded-md text-gray-400 hover:text-[#7C3AED] hover:bg-[#F5F3FF]"><X className="w-4 h-4" /></button>
        </div>

        <div className="flex-1 overflow-y-auto min-h-0 p-4 space-y-3">
          {error && <div className="flex items-start gap-2 px-3 py-2 bg-red-50 border border-red-200 rounded-lg text-[12px] text-red-700">{error}</div>}

          {view === 'list' ? (
            <>
              <div className="flex items-center justify-between">
                <span className="text-[11px] text-gray-400">{monitors.length} monitor{monitors.length === 1 ? '' : 's'}</span>
                <button type="button" className={PRIMARY_BTN} onClick={() => openEditor()}><Plus className="w-3.5 h-3.5" />New monitor</button>
              </div>

              {loading ? (
                <div className="flex items-center justify-center gap-2 py-16 text-[12px] text-gray-500"><Spinner className="w-4 h-4 animate-spin text-[#7C3AED]" />Loading monitors…</div>
              ) : monitors.length === 0 ? (
                <div className="flex flex-col items-center justify-center gap-3 py-14 px-6 text-center">
                  <Globe className="w-7 h-7 text-gray-300" />
                  <p className="text-[12.5px] text-gray-500 max-w-sm">No synthetic monitors yet. Create one to probe an endpoint on a schedule from one or more locations.</p>
                  <button type="button" className={PRIMARY_BTN} onClick={() => openEditor()}><Plus className="w-3.5 h-3.5" />New monitor</button>
                </div>
              ) : (
                <div className="space-y-2">
                  {monitors.map((m) => (
                    <div key={m.id} className="rounded-lg border border-gray-100">
                      <div className="flex items-center gap-2 px-3 py-2.5">
                        <span className={`w-2 h-2 rounded-full flex-shrink-0 ${dotClass(m.lastStatus)}`} title={m.lastStatus || 'never run'} />
                        <button type="button" onClick={() => openEditor(m)} className="flex-1 min-w-0 text-left group">
                          <div className="flex items-center gap-2">
                            <span className="text-[12.5px] font-medium text-gray-800 truncate group-hover:text-[#6D28D9]">{m.name}</span>
                            {!m.enabled && <span className="text-[9.5px] font-semibold px-1.5 py-0.5 rounded border text-gray-500 bg-gray-50 border-gray-200 flex-shrink-0">paused</span>}
                          </div>
                          <div className="flex items-center gap-1.5 mt-0.5 min-w-0">
                            <MethodBadge method={m.endpoint.method} />
                            <span className="text-[10.5px] text-gray-400 truncate" title={m.endpoint.url}>{m.endpoint.url}</span>
                          </div>
                        </button>
                        <span className="text-[10.5px] text-gray-400 tabular-nums flex-shrink-0 hidden sm:inline">every {m.intervalMinutes}m</span>
                        <span className="text-[10.5px] text-gray-400 tabular-nums flex-shrink-0 hidden sm:inline">{m.locations.length} loc</span>
                        <span className="text-[10.5px] text-gray-400 flex-shrink-0 hidden md:inline">{m.lastRunAt ? relativeTime(m.lastRunAt) : 'never'}</span>
                        <div className="flex items-center gap-0.5 flex-shrink-0">
                          <button type="button" title={m.enabled ? 'Pause' : 'Enable'} disabled={busyId === m.id} onClick={() => void toggleEnabled(m)}
                            className={`p-1.5 rounded-md hover:bg-[#F5F3FF] disabled:opacity-40 ${m.enabled ? 'text-[#7C3AED]' : 'text-gray-400'}`}><Power className="w-3.5 h-3.5" /></button>
                          <button type="button" title="Run now" disabled={busyId === m.id} onClick={() => void runNow(m.id)}
                            className="p-1.5 rounded-md text-gray-400 hover:text-[#7C3AED] hover:bg-[#F5F3FF] disabled:opacity-40">
                            {busyId === m.id ? <Spinner className="w-3.5 h-3.5 animate-spin" /> : <Play className="w-3.5 h-3.5" />}
                          </button>
                          <button type="button" title="Recent results" disabled={busyId === m.id} onClick={() => void loadResults(m.id)}
                            className={`px-1.5 py-1 rounded-md text-[10.5px] font-medium hover:bg-[#F5F3FF] disabled:opacity-40 ${expandedId === m.id ? 'text-[#6D28D9]' : 'text-gray-400 hover:text-[#7C3AED]'}`}>Results</button>
                          <button type="button" title="Delete" disabled={busyId === m.id} onClick={() => void remove(m.id)}
                            className="p-1.5 rounded-md text-gray-400 hover:text-red-500 hover:bg-red-50 disabled:opacity-40"><Trash2 className="w-3.5 h-3.5" /></button>
                        </div>
                      </div>
                      {expandedId === m.id && (
                        <div className="px-3 pb-3 pt-1 border-t border-gray-100 space-y-2">
                          {(rowResults[m.id] || []).length === 0 ? (
                            <p className="text-[11px] text-gray-400 py-2">No results recorded yet.</p>
                          ) : (
                            (rowResults[m.id] || []).map((r) => <ResultCard key={r.id} r={r} at={r.createdAt} />)
                          )}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </>
          ) : (
            <div className="space-y-3">
              <button type="button" onClick={() => setView('list')} className="inline-flex items-center gap-1 text-[11px] font-medium text-[#6D28D9] hover:underline">
                <ChevronLeft className="w-3.5 h-3.5" />Back to monitors
              </button>

              <div>
                <label className={LABEL}>Name</label>
                <input className={INPUT} value={draft.name || ''} placeholder="Checkout API — global uptime" onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))} />
              </div>

              {/* Target endpoint */}
              <div className="space-y-2">
                <label className={LABEL}>Target endpoint</label>
                {endpoints.length > 0 && (
                  <select className={INPUT} value={endpoints.some((x) => x.url === draft.endpoint?.url) ? draft.endpoint?.url : ''} onChange={(e) => applyCatalogEndpoint(e.target.value)}>
                    <option value="">Pick from catalogue…</option>
                    {endpoints.map((ep) => <option key={ep.id} value={ep.url}>{ep.method} · {ep.title || ep.url}</option>)}
                  </select>
                )}
                <div className="flex items-center gap-2">
                  <select className={FIELD} value={draft.endpoint?.method || 'GET'} onChange={(e) => patchEndpoint({ method: e.target.value })}>
                    <option value="GET">GET</option>
                    <option value="HEAD">HEAD</option>
                  </select>
                  <input className={INPUT} value={draft.endpoint?.url || ''} placeholder="https://api.example.com/health" onChange={(e) => patchEndpoint({ url: e.target.value })} />
                </div>
                <p className="text-[10px] text-gray-400">Read-only checks — GET/HEAD only.</p>
                <input className={INPUT} value={draft.endpoint?.assertText || ''} placeholder='Body must contain… (e.g. "ok")' onChange={(e) => patchEndpoint({ assertText: e.target.value })} />
              </div>

              {/* Schedule */}
              <div className="flex items-end gap-4">
                <div>
                  <label className={LABEL}>Interval (minutes)</label>
                  <input type="number" min={1} max={1440} className={`${FIELD} w-32 tabular-nums`} value={draft.intervalMinutes ?? 15}
                    onChange={(e) => setDraft((d) => ({ ...d, intervalMinutes: e.target.value === '' ? 15 : Number(e.target.value) }))} />
                </div>
                <label className="flex items-center gap-2 text-[12px] text-gray-700 pb-1.5 select-none cursor-pointer">
                  <input type="checkbox" className="accent-[#7C3AED]" checked={draft.enabled ?? true} onChange={(e) => setDraft((d) => ({ ...d, enabled: e.target.checked }))} />
                  Enabled
                </label>
              </div>

              {/* Locations */}
              <div className="space-y-2">
                <div className="flex items-center gap-2">
                  <Globe className="w-3.5 h-3.5 text-[#7C3AED]" />
                  <span className="text-[11px] font-semibold uppercase tracking-wide text-gray-600">Locations</span>
                  <button type="button" onClick={addLocation} className="ml-auto inline-flex items-center gap-1 text-[11px] font-medium text-[#6D28D9] hover:underline"><Plus className="w-3.5 h-3.5" />Add</button>
                </div>
                {(draft.locations || []).length === 0 ? (
                  <p className="text-[11px] text-gray-400">No locations — the backend runs one default vantage point.</p>
                ) : (
                  (draft.locations || []).map((l, i) => (
                    <div key={i} className="flex items-center gap-2">
                      <input className={`${FIELD} w-40`} value={l.name} placeholder="us-east" onChange={(e) => setLocation(i, { name: e.target.value })} />
                      <input className={INPUT} value={l.proxyUrl || ''} placeholder="proxy URL (optional)" onChange={(e) => setLocation(i, { proxyUrl: e.target.value })} />
                      <button type="button" onClick={() => removeLocation(i)} className="p-1.5 rounded-md text-gray-400 hover:text-red-500 hover:bg-red-50 flex-shrink-0"><Trash2 className="w-3.5 h-3.5" /></button>
                    </div>
                  ))
                )}
                <p className="text-[10px] text-gray-400">Each location can route egress through its own proxy (global/private vantage points).</p>
              </div>

              {/* Tracing */}
              <Collapsible icon={Radar} title="Trace correlation" hint={draft.tracing ? draft.tracing.type : 'off'} open={tracingOpen} onToggle={() => setTracingOpen((o) => !o)}>
                <div>
                  <label className={LABEL}>Backend</label>
                  <select className={INPUT} value={draft.tracing?.type ?? 'none'} onChange={(e) => setTracingType(e.target.value as 'none' | SyntheticTracingConfig['type'])}>
                    <option value="none">None</option>
                    <option value="jaeger">Jaeger</option>
                    <option value="zipkin">Zipkin</option>
                    <option value="tempo">Tempo</option>
                  </select>
                </div>
                {draft.tracing && (
                  <div>
                    <label className={LABEL}>Query URL</label>
                    <input className={INPUT} value={draft.tracing.queryUrl} placeholder="http://jaeger:16686" onChange={(e) => setDraft((d) => ({ ...d, tracing: d.tracing ? { ...d.tracing, queryUrl: e.target.value } : null }))} />
                  </div>
                )}
              </Collapsible>

              {/* Canary */}
              <Collapsible icon={Zap} title="Canary / rollback" hint={cleanCanary(draft.canary) ? 'armed' : 'off'} open={canaryOpen} onToggle={() => setCanaryOpen((o) => !o)}>
                <div>
                  <label className={LABEL}>Baseline URL</label>
                  <input className={INPUT} value={draft.canary?.baselineUrl || ''} placeholder="https://api.example.com/health (stable)" onChange={(e) => patchCanary({ baselineUrl: e.target.value })} />
                </div>
                <div className="grid grid-cols-3 gap-2">
                  <div>
                    <label className={LABEL}>Max error %</label>
                    <input type="number" className={`${INPUT} tabular-nums`} value={draft.canary?.maxErrorRatePct ?? ''} onChange={(e) => patchCanary({ maxErrorRatePct: e.target.value === '' ? undefined : Number(e.target.value) })} />
                  </div>
                  <div>
                    <label className={LABEL}>Max latency ms</label>
                    <input type="number" className={`${INPUT} tabular-nums`} value={draft.canary?.maxLatencyMs ?? ''} onChange={(e) => patchCanary({ maxLatencyMs: e.target.value === '' ? undefined : Number(e.target.value) })} />
                  </div>
                  <div>
                    <label className={LABEL}>Max Δ latency %</label>
                    <input type="number" className={`${INPUT} tabular-nums`} value={draft.canary?.maxLatencyDeltaPct ?? ''} onChange={(e) => patchCanary({ maxLatencyDeltaPct: e.target.value === '' ? undefined : Number(e.target.value) })} />
                  </div>
                </div>
                <div>
                  <label className={LABEL}>Rollback webhook URL</label>
                  <input className={INPUT} value={draft.canary?.rollbackWebhookUrl || ''} placeholder="https://hooks.example.com/rollback" onChange={(e) => patchCanary({ rollbackWebhookUrl: e.target.value })} />
                </div>
                <p className="text-[10px] text-gray-400">On breach, POSTs a rollback SIGNAL to the webhook — it never touches infrastructure.</p>
              </Collapsible>

              {/* Preview result */}
              {previewResult && (
                <div className="space-y-2">
                  <span className="text-[10.5px] font-semibold uppercase tracking-wide text-gray-400">Preview (not saved)</span>
                  <ResultCard r={previewResult} />
                </div>
              )}

              {/* Actions */}
              <div className="flex items-center gap-2 pt-1">
                <button type="button" className={SECONDARY_BTN} disabled={previewing || saving} onClick={() => void preview()}>
                  {previewing ? <Spinner className="w-3.5 h-3.5 animate-spin" /> : <Play className="w-3.5 h-3.5" />}Preview
                </button>
                <button type="button" className={PRIMARY_BTN} disabled={saving || previewing} onClick={() => void save()}>
                  {saving ? <Spinner className="w-3.5 h-3.5 animate-spin" /> : <Activity className="w-3.5 h-3.5" />}Save monitor
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/* ── Collapsible section ──────────────────────────────────────── */

function Collapsible({ icon: Icon, title, hint, open, onToggle, children }: { icon: React.ElementType; title: string; hint?: string; open: boolean; onToggle: () => void; children: React.ReactNode }) {
  return (
    <div className="border border-[#EDE9FE] rounded-lg overflow-hidden">
      <button type="button" onClick={onToggle} className="w-full flex items-center gap-2 px-3 py-2 bg-[#FBFAFF] hover:bg-[#F5F3FF]">
        <ChevronRight className={`w-3.5 h-3.5 text-gray-400 transition-transform ${open ? 'rotate-90' : ''}`} />
        <Icon className="w-3.5 h-3.5 text-[#7C3AED]" />
        <span className="text-[11px] font-semibold uppercase tracking-wide text-gray-600">{title}</span>
        {hint && <span className="ml-auto text-[10px] text-gray-400">{hint}</span>}
      </button>
      {open && <div className="px-3 py-3 space-y-2 border-t border-[#EDE9FE]">{children}</div>}
    </div>
  );
}

/* ── Result card (preview · run · stored) ─────────────────────── */

function ResultCard({ r, at }: { r: CheckOutcome; at?: string }) {
  const badge = STATUS_BADGE[r.status] || STATUS_BADGE.down;
  return (
    <div className="rounded-lg border border-gray-100 bg-white overflow-hidden">
      <div className="flex items-center gap-2 px-3 py-2 bg-gray-50/60 border-b border-gray-100">
        <span className={`inline-flex items-center px-2 py-0.5 rounded-full border text-[10.5px] font-semibold ${badge.cls}`}>{badge.label}</span>
        <span className="text-[11.5px] text-gray-600 min-w-0 truncate">{r.summary}</span>
        {at && <span className="ml-auto text-[10px] text-gray-400 flex-shrink-0">{relativeTime(at)}</span>}
      </div>

      {r.locations.length > 0 && (
        <div className="divide-y divide-gray-50">
          {r.locations.map((loc, i) => <LocationRow key={i} loc={loc} />)}
        </div>
      )}

      {r.canary && <CanaryBlock v={r.canary} />}
      {r.trace && <TraceBlock t={r.trace} />}
    </div>
  );
}

function LocationRow({ loc }: { loc: SyntheticLocationResult }) {
  return (
    <div className="flex items-center gap-2 px-3 py-1.5 text-[11px]">
      <span className="font-medium text-gray-700 min-w-0 truncate max-w-[130px]">{loc.location}</span>
      {loc.proxied && <span className="text-[9px] font-semibold px-1 py-0.5 rounded border text-[#6D28D9] bg-[#F5F3FF] border-[#DDD6FE] flex-shrink-0">proxied</span>}
      {loc.status != null && <span className="font-mono text-[10.5px] text-gray-500 tabular-nums flex-shrink-0">{loc.status}</span>}
      <span className="font-mono text-[10.5px] text-gray-400 tabular-nums flex-shrink-0">{loc.elapsedMs}ms</span>
      <span className={`text-[10px] font-semibold flex-shrink-0 ${loc.ok ? 'text-emerald-600' : 'text-red-600'}`}>{loc.ok ? 'OK' : 'FAIL'}</span>
      {loc.assertPassed != null && <span className={`text-[10px] flex-shrink-0 ${loc.assertPassed ? 'text-emerald-600' : 'text-red-600'}`}>assert {loc.assertPassed ? '✓' : '✗'}</span>}
      {loc.error && <span className="text-[10px] text-red-500 min-w-0 truncate ml-auto" title={loc.error}>{loc.error}</span>}
    </div>
  );
}

function CanaryBlock({ v }: { v: CanaryVerdict }) {
  return (
    <div className="px-3 py-2 border-t border-gray-100 space-y-1">
      <div className="flex items-center gap-2">
        <Zap className="w-3 h-3 text-[#7C3AED]" />
        <span className="text-[10px] font-semibold uppercase tracking-wide text-gray-500">Canary</span>
        <span className={`text-[9.5px] font-semibold px-1.5 py-0.5 rounded border flex-shrink-0 ${v.healthy ? 'text-emerald-700 bg-emerald-50 border-emerald-200' : 'text-red-700 bg-red-50 border-red-200'}`}>{v.healthy ? 'healthy' : 'BREACH'}</span>
        {v.rollbackSignalled && <span className="text-[9.5px] font-semibold px-1.5 py-0.5 rounded border text-red-700 bg-red-100 border-red-300 flex-shrink-0">rollback signalled</span>}
      </div>
      <div className="flex items-center gap-3 text-[10.5px] text-gray-500 tabular-nums">
        <span>err {v.canary.errorRatePct}%</span>
        <span>latency {v.canary.latencyMs}ms</span>
        {v.baseline && <span>baseline {v.baseline.latencyMs}ms{v.baseline.ok ? '' : ' (down)'}</span>}
      </div>
      {v.reasons.length > 0 && (
        <ul className="space-y-0.5">
          {v.reasons.map((reason, i) => <li key={i} className="text-[10.5px] text-red-600">· {reason}</li>)}
        </ul>
      )}
    </div>
  );
}

function TraceBlock({ t }: { t: SyntheticTraceSummary }) {
  return (
    <div className="px-3 py-2 border-t border-gray-100 space-y-1">
      <div className="flex items-center gap-2 flex-wrap">
        <Radar className="w-3 h-3 text-[#7C3AED]" />
        <span className="text-[10px] font-semibold uppercase tracking-wide text-gray-500">Trace</span>
        {t.backend && <span className="text-[10.5px] text-gray-500">{t.backend}</span>}
        <span className="text-[10.5px] text-gray-400 tabular-nums">{t.spanCount} span{t.spanCount === 1 ? '' : 's'}</span>
      </div>
      {t.note && <p className="text-[10.5px] text-gray-400">{t.note}</p>}
      {t.assertions && t.assertions.length > 0 && (
        <ul className="space-y-0.5">
          {t.assertions.map((a, i) => (
            <li key={i} className="flex items-center gap-1.5 text-[10.5px]">
              <span className={`font-semibold ${a.pass ? 'text-emerald-600' : 'text-red-600'}`}>{a.pass ? '✓' : '✗'}</span>
              <span className="text-gray-600">{a.name}</span>
              {a.detail && <span className="text-gray-400 truncate">— {a.detail}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
