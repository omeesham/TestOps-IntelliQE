/**
 * ProxyServer — contract-validating / simulating proxy (Prism / Hoverfly parity).
 *
 * Opt-in and standalone. Publish a proxy at a public, unguessable URL
 * (/proxy/{token}/<any/path>). In VALIDATE mode it forwards each call to the
 * real target base and records any status/shape violations against the stored
 * contract; in SIMULATE mode it replies from the selected endpoints' stored
 * examples — so a system-under-test can run with the dependency offline.
 * Toggling disables the URL without deleting; deleting revokes it. Nothing here
 * touches the generate → execute → heal pipeline.
 */
import { useEffect, useState } from 'react';
import { X, Network, Plus, Trash2, Copy, Check, Power, AlertTriangle, Link2, Activity, ChevronDown } from 'lucide-react';
import Spinner from '@/components/feedback/Spinner';
import { useToast } from '@/components/feedback/ToastProvider';
import {
  listProxies, createProxy, setProxyEnabled, deleteProxy, listProxyEvents,
  type ApiProxy, type ProxyEvent, type ProxyMode,
} from '@/services/api';
import { CARD, STRIP, INPUT, LABEL, PRIMARY_BTN, SECONDARY_BTN } from './format';
import { MethodBadge } from './primitives';
import type { CatalogEndpoint } from './types';

export default function ProxyServer({ endpoints, onClose }: { endpoints: CatalogEndpoint[]; onClose: () => void }) {
  const toast = useToast();
  const [proxies, setProxies] = useState<ApiProxy[]>([]);
  const [name, setName] = useState('');
  const [mode, setMode] = useState<ProxyMode>('validate');
  const [targetBase, setTargetBase] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState<string | null>(null);
  const [eventsFor, setEventsFor] = useState<string | null>(null);
  const [events, setEvents] = useState<ProxyEvent[]>([]);
  const [eventsLoading, setEventsLoading] = useState(false);

  const origin = typeof window !== 'undefined' ? window.location.origin : '';
  const urlFor = (p: ApiProxy) => `${origin}/proxy/${p.token}`;

  const refresh = async () => { setProxies(await listProxies()); };

  useEffect(() => {
    (async () => {
      try { await refresh(); }
      catch (err: any) { setError(err?.response?.data?.error || err?.message || 'Could not load proxies.'); }
      finally { setLoading(false); }
    })();
  }, []);

  const create = async () => {
    if (!/^https?:\/\//i.test(targetBase.trim())) { setError('Enter the real API base URL to proxy to (https://…).'); return; }
    setBusy(true); setError('');
    try {
      const p = await createProxy({
        name: name.trim(),
        mode,
        targetBase: targetBase.trim(),
        endpoints: endpoints.map((e) => ({ method: e.method, url: e.url, expectedStatus: e.expectedStatus, expectedResponse: e.expectedResponse })),
      });
      setName(''); setTargetBase('');
      await refresh();
      toast.success('Proxy published', `${p.mode} mode · ${p.routeCount} contract route${p.routeCount === 1 ? '' : 's'}`);
    } catch (err: any) {
      setError(err?.response?.data?.error || err?.message || 'Could not publish proxy.');
    } finally { setBusy(false); }
  };

  const toggle = async (p: ApiProxy) => {
    setBusy(true);
    try { await setProxyEnabled(p.id, !p.enabled); await refresh(); }
    catch (err: any) { setError(err?.response?.data?.error || err?.message || 'Toggle failed.'); }
    finally { setBusy(false); }
  };

  const remove = async (p: ApiProxy) => {
    setBusy(true);
    try { await deleteProxy(p.id); if (eventsFor === p.id) setEventsFor(null); await refresh(); }
    catch (err: any) { setError(err?.response?.data?.error || err?.message || 'Delete failed.'); }
    finally { setBusy(false); }
  };

  const copy = async (p: ApiProxy) => {
    try { await navigator.clipboard.writeText(urlFor(p)); setCopied(p.id); setTimeout(() => setCopied(null), 1500); }
    catch { /* clipboard blocked */ }
  };

  const showEvents = async (p: ApiProxy) => {
    if (eventsFor === p.id) { setEventsFor(null); return; }
    setEventsFor(p.id); setEvents([]); setEventsLoading(true);
    try { setEvents(await listProxyEvents(p.id)); }
    catch { setEvents([]); }
    finally { setEventsLoading(false); }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-[#1E1B4B]/45 backdrop-blur-md p-4" onClick={onClose}>
      <div className={`${CARD} w-full max-w-2xl max-h-[88vh] flex flex-col overflow-hidden`} onClick={(e) => e.stopPropagation()}>
        <div className={`flex items-center gap-2 px-4 h-12 border-b border-[#EDE9FE] flex-shrink-0 ${STRIP}`}>
          <Network className="w-4 h-4 text-[#7C3AED]" />
          <h3 className="text-[13px] font-semibold text-gray-900">Contract proxy</h3>
          <span className="text-[11px] text-gray-400">validate live traffic · or simulate the dependency</span>
          <button type="button" onClick={onClose} className="ml-auto p-1.5 rounded-md text-gray-400 hover:text-[#7C3AED] hover:bg-[#F5F3FF]"><X className="w-4 h-4" /></button>
        </div>

        <div className="p-4 space-y-3 overflow-y-auto min-h-0">
          {/* Create */}
          <div className="rounded-lg border border-[#E4E0F5] bg-[#FAF9FE] p-3 space-y-2">
            <label className={LABEL}>New proxy · {endpoints.length} endpoint{endpoints.length === 1 ? '' : 's'} as the contract</label>
            <div className="flex gap-1.5">
              {(['validate', 'simulate'] as ProxyMode[]).map((m) => (
                <button key={m} type="button" onClick={() => { setMode(m); setError(''); }}
                  className={`flex-1 px-3 py-1.5 text-[12px] font-semibold rounded-md border transition-colors ${mode === m ? 'bg-[#7C3AED] text-white border-transparent' : 'bg-white text-gray-600 border-gray-200 hover:border-[#C4B5FD]'}`}>
                  {m === 'validate' ? 'Validate (forward + check)' : 'Simulate (reply from examples)'}
                </button>
              ))}
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className={LABEL}>Name (optional)</label>
                <input value={name} onChange={(e) => { setName(e.target.value); setError(''); }} placeholder="Payments proxy" className={INPUT} />
              </div>
              <div>
                <label className={LABEL}>Real API base URL</label>
                <input value={targetBase} onChange={(e) => { setTargetBase(e.target.value); setError(''); }} placeholder="https://api.example.com" className={INPUT} />
              </div>
            </div>
            <div className="flex items-center justify-between">
              <p className="text-[10.5px] text-gray-400 max-w-sm">
                {mode === 'validate'
                  ? 'Forwards every call to the base URL and records status / shape violations against the contract.'
                  : 'Replies from the selected endpoints’ stored examples — the base URL is used only as a fallback.'}
              </p>
              <button type="button" onClick={() => void create()} disabled={busy} className={PRIMARY_BTN}>
                {busy ? <Spinner className="w-3.5 h-3.5 animate-spin" /> : <Plus className="w-3.5 h-3.5" />}Publish
              </button>
            </div>
          </div>

          {error && (
            <div className="flex items-start gap-2 px-3 py-2 bg-red-50 border border-red-200 rounded-lg">
              <AlertTriangle className="w-4 h-4 text-red-500 flex-shrink-0 mt-px" /><p className="text-[12px] text-red-700 min-w-0">{error}</p>
            </div>
          )}

          {loading ? (
            <div className="flex items-center justify-center py-8 text-gray-400"><Spinner className="w-5 h-5 animate-spin" /></div>
          ) : proxies.length === 0 ? (
            <div className="text-center py-6 text-[12px] text-gray-400">No proxies yet — publish one above, then point your system-under-test at the URL.</div>
          ) : (
            <div className="space-y-2">
              {proxies.map((p) => (
                <div key={p.id} className="border border-[#E9E5FB] rounded-lg p-3">
                  <div className="flex items-center gap-2">
                    <span className={`w-2 h-2 rounded-full flex-shrink-0 ${p.enabled ? 'bg-emerald-500' : 'bg-gray-300'}`} />
                    <span className="text-[12.5px] font-semibold text-gray-800 truncate">{p.name}</span>
                    <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded ${p.mode === 'simulate' ? 'text-[#6D28D9] bg-[#F5F3FF]' : 'text-sky-700 bg-sky-50'}`}>{p.mode}</span>
                    <span className="text-[10.5px] text-gray-400 truncate">→ {p.targetBase} · {p.routeCount} route{p.routeCount === 1 ? '' : 's'} · {p.hitCount} hit{p.hitCount === 1 ? '' : 's'}</span>
                    <div className="ml-auto flex items-center gap-1 flex-shrink-0">
                      <button type="button" onClick={() => void showEvents(p)} disabled={busy} className={`p-1 rounded ${eventsFor === p.id ? 'text-[#7C3AED] bg-[#F5F3FF]' : 'text-gray-400 hover:bg-gray-100'}`} title="Recent validation events"><Activity className="w-3.5 h-3.5" /></button>
                      <button type="button" onClick={() => void toggle(p)} disabled={busy} className={`p-1 rounded ${p.enabled ? 'text-emerald-600 hover:bg-emerald-50' : 'text-gray-400 hover:bg-gray-100'}`} title={p.enabled ? 'Disable' : 'Enable'}><Power className="w-3.5 h-3.5" /></button>
                      <button type="button" onClick={() => void remove(p)} disabled={busy} className="p-1 rounded text-gray-400 hover:text-red-500 hover:bg-red-50" title="Delete (revokes URL)"><Trash2 className="w-3.5 h-3.5" /></button>
                    </div>
                  </div>
                  <div className="flex items-center gap-1.5 mt-2">
                    <Link2 className="w-3.5 h-3.5 text-gray-400 flex-shrink-0" />
                    <code className="flex-1 min-w-0 truncate text-[11px] font-mono text-[#6D28D9] bg-[#F5F3FF] rounded px-2 py-1">{urlFor(p)}/&lt;your/path&gt;</code>
                    <button type="button" onClick={() => void copy(p)} className={SECONDARY_BTN}>{copied === p.id ? <><Check className="w-3.5 h-3.5" />Copied</> : <><Copy className="w-3.5 h-3.5" />Copy</>}</button>
                  </div>
                  {eventsFor === p.id && (
                    <div className="mt-2 border-t border-[#EDE9FE] pt-2">
                      <div className="flex items-center gap-1 text-[10.5px] font-semibold uppercase tracking-wide text-gray-400 mb-1"><ChevronDown className="w-3 h-3" />Recent events</div>
                      {eventsLoading ? (
                        <div className="flex items-center gap-2 py-2 text-[11px] text-gray-400"><Spinner className="w-3.5 h-3.5 animate-spin" />Loading…</div>
                      ) : events.length === 0 ? (
                        <div className="py-2 text-[11px] text-gray-400">No traffic recorded yet. Send a request to the URL above.</div>
                      ) : (
                        <div className="space-y-1 max-h-40 overflow-y-auto">
                          {events.map((ev, i) => (
                            <div key={i} className="flex items-start gap-1.5 text-[11px]">
                              <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 mt-1.5 ${ev.ok ? 'bg-emerald-500' : 'bg-red-500'}`} />
                              <MethodBadge method={ev.method} />
                              <span className="font-mono text-gray-600 truncate">{ev.path}</span>
                              <span className="text-gray-400">{ev.upstreamStatus ?? '—'}</span>
                              {ev.issues.length > 0 && <span className="text-red-600 truncate">{ev.issues.join('; ')}</span>}
                            </div>
                          ))}
                        </div>
                      )}
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
