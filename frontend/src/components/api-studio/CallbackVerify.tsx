/**
 * CallbackVerify — async webhook / callback verification.
 *
 * Opt-in and standalone. Create a disposable public capture URL, use it as the
 * callback target when you trigger the API, then refresh to see the callbacks
 * it received and assert the payload contains what you expect. Capture is
 * public (/hook/:token); management is tenant-authenticated. Touches no pipeline.
 */
import { useEffect, useRef, useState } from 'react';
import { X, Webhook, Plus, Trash2, Copy, Check, RefreshCw, AlertTriangle, Search } from 'lucide-react';
import Spinner from '@/components/feedback/Spinner';
import {
  listCallbackListeners, createCallbackListener, deleteCallbackListener, getCallbackEvents,
  type CallbackListener, type CallbackEvent,
} from '@/services/api';
import { CARD, STRIP, INPUT, LABEL, SECONDARY_BTN } from './format';
import { MethodBadge } from './primitives';

export default function CallbackVerify({ onClose }: { onClose: () => void }) {
  const [listeners, setListeners] = useState<CallbackListener[]>([]);
  const [activeToken, setActiveToken] = useState<string | null>(null);
  const [events, setEvents] = useState<CallbackEvent[]>([]);
  const [name, setName] = useState('');
  const [match, setMatch] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState('');
  const origin = typeof window !== 'undefined' ? window.location.origin : '';
  const pollRef = useRef<number | null>(null);

  const urlFor = (token: string) => `${origin}/hook/${token}`;

  const refreshListeners = async () => { const { listeners: l } = await listCallbackListeners(); setListeners(l); return l; };
  const refreshEvents = async (token: string) => { try { setEvents((await getCallbackEvents(token)).events); } catch { /* ignore */ } };

  useEffect(() => {
    (async () => {
      try { const l = await refreshListeners(); if (l.length) setActiveToken(l[0].token); }
      catch (e: any) { setError(e?.response?.data?.error || e?.message || 'Could not load listeners.'); }
      finally { setLoading(false); }
    })();
  }, []);

  // Light auto-poll while a listener is open (callbacks arrive asynchronously).
  useEffect(() => {
    if (!activeToken) return;
    void refreshEvents(activeToken);
    pollRef.current = window.setInterval(() => void refreshEvents(activeToken), 4000);
    return () => { if (pollRef.current) window.clearInterval(pollRef.current); };
  }, [activeToken]);

  const create = async () => {
    setBusy(true); setError('');
    try { const { listener } = await createCallbackListener(name.trim()); setName(''); await refreshListeners(); setActiveToken(listener.token); }
    catch (e: any) { setError(e?.response?.data?.error || e?.message || 'Could not create listener.'); }
    finally { setBusy(false); }
  };
  const remove = async (id: string) => {
    setBusy(true);
    try { await deleteCallbackListener(id); const l = await refreshListeners(); setActiveToken(l[0]?.token ?? null); setEvents([]); }
    finally { setBusy(false); }
  };
  const copy = async (token: string) => { try { await navigator.clipboard.writeText(urlFor(token)); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* ignore */ } };

  const active = listeners.find((l) => l.token === activeToken) || null;
  const needle = match.trim().toLowerCase();
  const matchHits = needle ? events.filter((e) => (e.body || '').toLowerCase().includes(needle)).length : 0;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-[#1E1B4B]/30 backdrop-blur-sm p-4" onClick={onClose}>
      <div className={`${CARD} w-full max-w-2xl max-h-[88vh] flex flex-col overflow-hidden`} onClick={(e) => e.stopPropagation()}>
        <div className={`flex items-center gap-2 px-4 h-12 border-b border-[#EDE9FE] flex-shrink-0 ${STRIP}`}>
          <Webhook className="w-4 h-4 text-[#7C3AED]" />
          <h3 className="text-[13px] font-semibold text-gray-900">Callback verification</h3>
          <span className="text-[11px] text-gray-400">capture async webhooks → assert payload</span>
          <button type="button" onClick={onClose} className="ml-auto p-1.5 rounded-md text-gray-400 hover:text-[#7C3AED] hover:bg-[#F5F3FF]"><X className="w-4 h-4" /></button>
        </div>

        <div className="p-4 space-y-3 overflow-y-auto min-h-0">
          {loading ? <div className="flex items-center justify-center py-8 text-gray-400"><Spinner className="w-5 h-5 animate-spin" /></div> : (
            <>
              <div className="flex items-end gap-2">
                <div className="flex-1 min-w-0">
                  <label className={LABEL}>Listener</label>
                  <select value={activeToken ?? ''} onChange={(e) => setActiveToken(e.target.value || null)} className={INPUT} disabled={!listeners.length}>
                    {!listeners.length && <option value="">No listeners yet</option>}
                    {listeners.map((l) => <option key={l.id} value={l.token}>{l.name} · {l.eventCount} received</option>)}
                  </select>
                </div>
                <input value={name} onChange={(e) => setName(e.target.value)} placeholder="New listener name" className={`${INPUT} w-40`} />
                <button type="button" onClick={() => void create()} disabled={busy} className={SECONDARY_BTN}><Plus className="w-3.5 h-3.5" />Create</button>
              </div>

              {error && <div className="flex items-start gap-2 px-3 py-2 bg-red-50 border border-red-200 rounded-lg"><AlertTriangle className="w-4 h-4 text-red-500 flex-shrink-0 mt-px" /><p className="text-[12px] text-red-700">{error}</p></div>}

              {active && (
                <>
                  <div className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-[#F5F3FF] border border-[#E4E0F5]">
                    <code className="flex-1 min-w-0 truncate text-[11px] font-mono text-[#6D28D9]">{urlFor(active.token)}</code>
                    <button type="button" onClick={() => void copy(active.token)} className="inline-flex items-center gap-1 text-[11px] text-[#6D28D9] hover:underline">{copied ? <><Check className="w-3.5 h-3.5" />Copied</> : <><Copy className="w-3.5 h-3.5" />Copy</>}</button>
                    <button type="button" onClick={() => void refreshEvents(active.token)} className="p-1 text-gray-400 hover:text-[#7C3AED]" title="Refresh"><RefreshCw className="w-3.5 h-3.5" /></button>
                    <button type="button" onClick={() => void remove(active.id)} disabled={busy} className="p-1 text-gray-400 hover:text-red-500" title="Delete (revokes URL)"><Trash2 className="w-3.5 h-3.5" /></button>
                  </div>
                  <p className="text-[10.5px] text-gray-400">Use this URL as the callback/webhook target, trigger your API, then watch for the request below (auto-refreshes). Deleting revokes the URL.</p>

                  <div className="relative">
                    <Search className="w-3.5 h-3.5 text-gray-300 absolute left-2 top-1/2 -translate-y-1/2" />
                    <input value={match} onChange={(e) => setMatch(e.target.value)} placeholder="Assert body contains…" className={`${INPUT} pl-7`} />
                    {needle && <span className={`absolute right-2 top-1/2 -translate-y-1/2 text-[11px] font-semibold ${matchHits ? 'text-emerald-600' : 'text-red-500'}`}>{matchHits ? `✓ ${matchHits} match` : 'no match'}</span>}
                  </div>

                  <div>
                    <label className={LABEL}>Received callbacks ({events.length})</label>
                    {events.length === 0 ? (
                      <p className="text-[12px] text-gray-400 py-3 text-center">Waiting for the first callback…</p>
                    ) : (
                      <div className="space-y-1.5 max-h-72 overflow-y-auto">
                        {events.map((ev) => {
                          const hit = needle && (ev.body || '').toLowerCase().includes(needle);
                          return (
                            <div key={ev.id} className={`border rounded-lg p-2 ${hit ? 'border-emerald-300 bg-emerald-50/40' : 'border-gray-100'}`}>
                              <div className="flex items-center gap-2 text-[11px]">
                                <MethodBadge method={ev.method} />
                                <span className="font-mono text-gray-600 truncate flex-1 min-w-0">{ev.path}{ev.query ? `?${ev.query}` : ''}</span>
                                <span className="text-gray-400">{new Date(ev.receivedAt).toLocaleTimeString()}</span>
                              </div>
                              {ev.body && <pre className="mt-1 text-[10.5px] font-mono text-gray-600 bg-gray-50 rounded p-1.5 overflow-x-auto max-h-28">{ev.body}</pre>}
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                </>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
