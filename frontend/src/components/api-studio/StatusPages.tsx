/**
 * StatusPages — public uptime / SLO status page (Checkly parity).
 *
 * Opt-in and standalone. Pick targets (from the selected endpoints or added by
 * hand), publish a page, and share its public, unguessable URL
 * (/status/{token}) — a self-contained HTML page showing per-service uptime,
 * p95 latency and SLO verdict. "Probe now" runs every target once; a background
 * poller re-probes on a schedule. Toggling disables the URL; deleting revokes
 * it. Read-only — nothing here touches the pipeline.
 */
import { useEffect, useState } from 'react';
import { X, Gauge, Plus, Trash2, Copy, Check, Power, AlertTriangle, Link2, RefreshCw } from 'lucide-react';
import Spinner from '@/components/feedback/Spinner';
import { useToast } from '@/components/feedback/ToastProvider';
import {
  listStatusPages, saveStatusPage, setStatusEnabled, deleteStatusPage, getStatusView, probeStatusNow,
  type StatusPage as StatusPageRec, type StatusView,
} from '@/services/api';
import { CARD, STRIP, INPUT, LABEL, PRIMARY_BTN, SECONDARY_BTN } from './format';
import { pathOf } from './format';
import type { CatalogEndpoint } from './types';

const overallMeta: Record<StatusView['overall'], { label: string; color: string }> = {
  operational: { label: 'All systems operational', color: '#059669' },
  degraded: { label: 'Degraded performance', color: '#D97706' },
  down: { label: 'Major outage', color: '#DC2626' },
  'no-data': { label: 'No checks yet', color: '#6B7280' },
};

export default function StatusPages({ endpoints, onClose }: { endpoints: CatalogEndpoint[]; onClose: () => void }) {
  const toast = useToast();
  const [pages, setPages] = useState<StatusPageRec[]>([]);
  const [name, setName] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState<string | null>(null);
  const [viewFor, setViewFor] = useState<string | null>(null);
  const [view, setView] = useState<StatusView | null>(null);

  const origin = typeof window !== 'undefined' ? window.location.origin : '';
  const urlFor = (p: StatusPageRec) => `${origin}/status/${p.token}`;

  const refresh = async () => { setPages(await listStatusPages()); };

  useEffect(() => {
    (async () => {
      try { await refresh(); }
      catch (err: any) { setError(err?.response?.data?.error || err?.message || 'Could not load status pages.'); }
      finally { setLoading(false); }
    })();
  }, []);

  const create = async () => {
    const targets = endpoints.map((e) => ({ name: e.title || pathOf(e.url), method: e.method, url: e.url }));
    if (!targets.length) { setError('Select at least one endpoint to monitor.'); return; }
    setBusy(true); setError('');
    try {
      const p = await saveStatusPage({ name: name.trim() || 'Status', targets });
      setName('');
      await refresh();
      toast.success('Status page published', `${p.targets.length} target${p.targets.length === 1 ? '' : 's'} monitored`);
    } catch (err: any) {
      setError(err?.response?.data?.error || err?.message || 'Could not publish status page.');
    } finally { setBusy(false); }
  };

  const toggle = async (p: StatusPageRec) => {
    setBusy(true);
    try { await setStatusEnabled(p.id, !p.enabled); await refresh(); }
    catch (err: any) { setError(err?.response?.data?.error || err?.message || 'Toggle failed.'); }
    finally { setBusy(false); }
  };

  const remove = async (p: StatusPageRec) => {
    setBusy(true);
    try { await deleteStatusPage(p.id); if (viewFor === p.id) setViewFor(null); await refresh(); }
    catch (err: any) { setError(err?.response?.data?.error || err?.message || 'Delete failed.'); }
    finally { setBusy(false); }
  };

  const copy = async (p: StatusPageRec) => {
    try { await navigator.clipboard.writeText(urlFor(p)); setCopied(p.id); setTimeout(() => setCopied(null), 1500); }
    catch { /* clipboard blocked */ }
  };

  const probe = async (p: StatusPageRec) => {
    setBusy(true); setViewFor(p.id); setView(null);
    try {
      await probeStatusNow(p.id);
      setView(await getStatusView(p.id));
      await refresh();
    } catch (err: any) {
      setError(err?.response?.data?.error || err?.message || 'Probe failed.');
    } finally { setBusy(false); }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-[#1E1B4B]/45 backdrop-blur-md p-4" onClick={onClose}>
      <div className={`${CARD} w-full max-w-2xl max-h-[88vh] flex flex-col overflow-hidden`} onClick={(e) => e.stopPropagation()}>
        <div className={`flex items-center gap-2 px-4 h-12 border-b border-[#EDE9FE] flex-shrink-0 ${STRIP}`}>
          <Gauge className="w-4 h-4 text-[#7C3AED]" />
          <h3 className="text-[13px] font-semibold text-gray-900">Public status page</h3>
          <span className="text-[11px] text-gray-400">shareable uptime + SLO for your APIs</span>
          <button type="button" onClick={onClose} className="ml-auto p-1.5 rounded-md text-gray-400 hover:text-[#7C3AED] hover:bg-[#F5F3FF]"><X className="w-4 h-4" /></button>
        </div>

        <div className="p-4 space-y-3 overflow-y-auto min-h-0">
          {/* Create */}
          <div className="rounded-lg border border-[#E4E0F5] bg-[#FAF9FE] p-3">
            <label className={LABEL}>New page · monitors {endpoints.length} selected endpoint{endpoints.length === 1 ? '' : 's'}</label>
            <div className="flex items-end gap-2">
              <div className="flex-1 min-w-0">
                <input value={name} onChange={(e) => { setName(e.target.value); setError(''); }} placeholder="Status page name (optional)" className={INPUT} />
              </div>
              <button type="button" onClick={() => void create()} disabled={busy || !endpoints.length} className={PRIMARY_BTN}>
                {busy ? <Spinner className="w-3.5 h-3.5 animate-spin" /> : <Plus className="w-3.5 h-3.5" />}Publish
              </button>
            </div>
            <p className="text-[10.5px] text-gray-400 mt-1.5">Each endpoint becomes a monitored service. The page re-probes on a schedule; use “Probe now” for an instant check. The URL is public but unguessable — disable or delete to revoke.</p>
          </div>

          {error && (
            <div className="flex items-start gap-2 px-3 py-2 bg-red-50 border border-red-200 rounded-lg">
              <AlertTriangle className="w-4 h-4 text-red-500 flex-shrink-0 mt-px" /><p className="text-[12px] text-red-700 min-w-0">{error}</p>
            </div>
          )}

          {loading ? (
            <div className="flex items-center justify-center py-8 text-gray-400"><Spinner className="w-5 h-5 animate-spin" /></div>
          ) : pages.length === 0 ? (
            <div className="text-center py-6 text-[12px] text-gray-400">No status pages yet — publish one above.</div>
          ) : (
            <div className="space-y-2">
              {pages.map((p) => (
                <div key={p.id} className="border border-[#E9E5FB] rounded-lg p-3">
                  <div className="flex items-center gap-2">
                    <span className={`w-2 h-2 rounded-full flex-shrink-0 ${p.enabled ? 'bg-emerald-500' : 'bg-gray-300'}`} />
                    <span className="text-[12.5px] font-semibold text-gray-800 truncate">{p.name}</span>
                    <span className="text-[10.5px] text-gray-400">{p.targets.length} target{p.targets.length === 1 ? '' : 's'} · SLO {p.slo.uptimePct}% · p95 ≤ {p.slo.p95Ms}ms</span>
                    <div className="ml-auto flex items-center gap-1 flex-shrink-0">
                      <button type="button" onClick={() => void probe(p)} disabled={busy} className="p-1 rounded text-gray-400 hover:text-[#7C3AED] hover:bg-[#F5F3FF]" title="Probe now"><RefreshCw className="w-3.5 h-3.5" /></button>
                      <button type="button" onClick={() => void toggle(p)} disabled={busy} className={`p-1 rounded ${p.enabled ? 'text-emerald-600 hover:bg-emerald-50' : 'text-gray-400 hover:bg-gray-100'}`} title={p.enabled ? 'Disable' : 'Enable'}><Power className="w-3.5 h-3.5" /></button>
                      <button type="button" onClick={() => void remove(p)} disabled={busy} className="p-1 rounded text-gray-400 hover:text-red-500 hover:bg-red-50" title="Delete (revokes URL)"><Trash2 className="w-3.5 h-3.5" /></button>
                    </div>
                  </div>
                  <div className="flex items-center gap-1.5 mt-2">
                    <Link2 className="w-3.5 h-3.5 text-gray-400 flex-shrink-0" />
                    <a href={urlFor(p)} target="_blank" rel="noreferrer" className="flex-1 min-w-0 truncate text-[11px] font-mono text-[#6D28D9] bg-[#F5F3FF] rounded px-2 py-1 hover:underline">{urlFor(p)}</a>
                    <button type="button" onClick={() => void copy(p)} className={SECONDARY_BTN}>{copied === p.id ? <><Check className="w-3.5 h-3.5" />Copied</> : <><Copy className="w-3.5 h-3.5" />Copy</>}</button>
                  </div>
                  {viewFor === p.id && (
                    <div className="mt-2 border-t border-[#EDE9FE] pt-2">
                      {busy && !view ? (
                        <div className="flex items-center gap-2 py-2 text-[11px] text-gray-400"><Spinner className="w-3.5 h-3.5 animate-spin" />Probing…</div>
                      ) : view ? (
                        <>
                          <div className="flex items-center gap-2 mb-2">
                            <span className="w-2.5 h-2.5 rounded-full flex-shrink-0" style={{ background: overallMeta[view.overall].color }} />
                            <span className="text-[12px] font-semibold" style={{ color: overallMeta[view.overall].color }}>{overallMeta[view.overall].label}</span>
                          </div>
                          <div className="space-y-1">
                            {view.targets.map((t, i) => (
                              <div key={i} className="flex items-center gap-2 text-[11px]">
                                <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${t.samples === 0 ? 'bg-gray-300' : t.lastOk ? (t.sloMet ? 'bg-emerald-500' : 'bg-amber-500') : 'bg-red-500'}`} />
                                <span className="font-semibold text-gray-700 truncate flex-1 min-w-0">{t.name}</span>
                                <span className="text-gray-500 tabular-nums">{t.uptimePct}% up</span>
                                <span className="text-gray-400 tabular-nums">p95 {t.p95Ms}ms</span>
                                <span className="text-gray-300 tabular-nums">{t.samples} chk</span>
                              </div>
                            ))}
                          </div>
                        </>
                      ) : null}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
