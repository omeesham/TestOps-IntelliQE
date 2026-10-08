/**
 * TrafficCapture — record real API traffic, then turn it into tests.
 *
 * Opt-in and standalone. A capture *session* accumulates the API calls your
 * app, a proxy, or a browser actually makes; "Build endpoints" runs the HAR
 * parser over them and merges deduped, noise-filtered endpoints into the
 * catalogue — which feeds the same generator every other import feeds.
 *
 * Three ways to record into a session:
 *   • Drop or paste a HAR recording (DevTools → Save all as HAR).
 *   • Run the recorder proxy snippet against the session (streams live traffic).
 *   • POST request/response JSON to the session's ingest URL from any tool.
 *
 * Nothing here touches the generation/execute/heal pipeline.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { X, Antenna, Plus, Trash2, RefreshCw, Upload, Terminal, Copy, Check, AlertTriangle, Layers, CircleStop } from 'lucide-react';
import Spinner from '@/components/feedback/Spinner';
import { useToast } from '@/components/feedback/ToastProvider';
import {
  listCaptureSessions, createCaptureSession, getCaptureSession, ingestCaptureEntries,
  captureToEndpoints, closeCaptureSession, deleteCaptureSession, type CaptureSession,
} from '@/services/api';
import { CARD, STRIP, INPUT, LABEL, PRIMARY_BTN, SECONDARY_BTN } from './format';
import { MethodBadge } from './primitives';
import type { Catalog } from './hooks/useCatalog';

/** The recorder proxy — a zero-dependency Node script that forwards traffic to
 *  your API and streams each request/response into the capture session. */
function recorderSnippet(origin: string, sessionId: string): string {
  return `// intelliqe-recorder.mjs — run:  node intelliqe-recorder.mjs
// Then point your app/tests at http://localhost:8888 instead of the real API.
import http from 'node:http';
const TARGET = 'https://api.your-service.com';   // ← your real API base URL
const INGEST = '${origin}/api/api-automation/capture/sessions/${sessionId}/ingest';
const TOKEN  = '<PASTE YOUR INTELLIQE TOKEN>';    // sessionStorage 'intelliqe_token'

http.createServer((creq, cres) => {
  const chunks = [];
  creq.on('data', (c) => chunks.push(c));
  creq.on('end', async () => {
    const reqBody = Buffer.concat(chunks).toString('utf8');
    const url = TARGET + creq.url;
    const headers = { ...creq.headers }; delete headers.host;
    let resBody = '', status = 0, mime = '';
    try {
      const r = await fetch(url, { method: creq.method, headers, body: /^(GET|HEAD)$/.test(creq.method) ? undefined : reqBody });
      status = r.status; mime = r.headers.get('content-type') || '';
      resBody = await r.text();
      cres.writeHead(status, { 'content-type': mime }); cres.end(resBody);
    } catch (e) { cres.writeHead(502); cres.end(String(e)); }
    fetch(INGEST, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + TOKEN },
      body: JSON.stringify({ entries: [{ method: creq.method, url, status, mime,
        requestHeaders: Object.entries(headers).map(([key, value]) => ({ key, value: String(value) })),
        requestBody: reqBody, responseBody: resBody }] }),
    }).catch(() => {});
  });
}).listen(8888, () => console.log('Recording → http://localhost:8888  (session ${sessionId.slice(0, 8)}…)'));`;
}

export default function TrafficCapture({ catalog, onClose, onBuilt }: { catalog: Catalog; onClose: () => void; onBuilt?: () => void }) {
  const toast = useToast();
  const [sessions, setSessions] = useState<CaptureSession[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [active, setActive] = useState<CaptureSession | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [harText, setHarText] = useState('');
  const [showSnippet, setShowSnippet] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);

  const origin = typeof window !== 'undefined' ? window.location.origin : '';

  const refreshList = useCallback(async () => {
    const { sessions: list } = await listCaptureSessions();
    setSessions(list);
    return list;
  }, []);

  const loadActive = useCallback(async (id: string) => {
    try { const { session } = await getCaptureSession(id); setActive(session); }
    catch { /* a deleted session — ignore */ }
  }, []);

  useEffect(() => {
    (async () => {
      try {
        const list = await refreshList();
        if (list.length) { setActiveId(list[0].id); }
      } catch (err: any) {
        setError(err?.response?.data?.error || err?.message || 'Could not load capture sessions.');
      } finally { setLoading(false); }
    })();
  }, [refreshList]);

  useEffect(() => { if (activeId) void loadActive(activeId); else setActive(null); }, [activeId, loadActive]);

  const newSession = async () => {
    setBusy(true); setError('');
    try {
      const { session } = await createCaptureSession();
      await refreshList();
      setActiveId(session.id);
    } catch (err: any) {
      setError(err?.response?.data?.error || err?.message || 'Could not create a session.');
    } finally { setBusy(false); }
  };

  const ingest = async (payload: unknown) => {
    if (!activeId) return;
    setBusy(true); setError('');
    try {
      const res = await ingestCaptureEntries(activeId, payload);
      await Promise.all([refreshList(), loadActive(activeId)]);
      toast.success('Traffic recorded', `${res.accepted} request${res.accepted === 1 ? '' : 's'} added${res.skipped ? ` · ${res.skipped} skipped` : ''}${res.capped ? ' · session full' : ''}.`);
      setHarText('');
    } catch (err: any) {
      setError(err?.response?.data?.error || err?.message || 'Ingest failed.');
    } finally { setBusy(false); }
  };

  const ingestHarText = () => {
    const t = harText.trim();
    if (!t) { setError('Paste a HAR recording or request/response JSON first.'); return; }
    let parsed: unknown;
    try { parsed = JSON.parse(t); } catch { setError('That is not valid JSON. Paste a HAR export or a JSON array of requests.'); return; }
    void ingest(parsed);
  };

  const onFiles = async (files: FileList | null) => {
    if (!files?.length) return;
    try {
      const text = await files[0].text();
      const parsed = JSON.parse(text);
      await ingest(parsed);
    } catch {
      setError('Could not read that file — it must be a .har or JSON export.');
    }
    if (fileRef.current) fileRef.current.value = '';
  };

  const build = async () => {
    if (!activeId) return;
    setBusy(true); setError('');
    try {
      const res = await captureToEndpoints(activeId);
      const r = catalog.addEndpoints(res.endpoints, { method: 'capture', name: active?.name || 'Captured traffic', format: res.format, parser: res.parser, profile: res.profile });
      toast.success('Endpoints built from traffic', `${r.added} added to the catalogue${r.duplicates ? ` · ${r.duplicates} duplicate${r.duplicates === 1 ? '' : 's'}` : ''}.`);
      onBuilt?.();
      onClose();
    } catch (err: any) {
      setError(err?.response?.data?.error || err?.message || 'Could not build endpoints.');
    } finally { setBusy(false); }
  };

  const closeActive = async () => {
    if (!activeId) return;
    setBusy(true);
    try { await closeCaptureSession(activeId); await Promise.all([refreshList(), loadActive(activeId)]); }
    finally { setBusy(false); }
  };

  const removeActive = async () => {
    if (!activeId) return;
    setBusy(true); setError('');
    try {
      await deleteCaptureSession(activeId);
      const list = await refreshList();
      setActiveId(list[0]?.id ?? null);
    } finally { setBusy(false); }
  };

  const copySnippet = async () => {
    if (!activeId) return;
    try { await navigator.clipboard.writeText(recorderSnippet(origin, activeId)); setCopied(true); setTimeout(() => setCopied(false), 1500); }
    catch { /* clipboard blocked — the textarea is still selectable */ }
  };

  const count = active?.entryCount ?? 0;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-[#1E1B4B]/30 backdrop-blur-sm p-4" onClick={onClose}>
      <div className={`${CARD} w-full max-w-3xl max-h-[88vh] flex flex-col overflow-hidden`} onClick={(e) => e.stopPropagation()}>
        <div className={`flex items-center gap-2 px-4 h-12 border-b border-[#EDE9FE] flex-shrink-0 ${STRIP}`}>
          <Antenna className="w-4 h-4 text-[#7C3AED]" />
          <h3 className="text-[13px] font-semibold text-gray-900">Traffic capture</h3>
          <span className="text-[11px] text-gray-400">record real API calls → tests</span>
          <button type="button" onClick={onClose} className="ml-auto p-1.5 rounded-md text-gray-400 hover:text-[#7C3AED] hover:bg-[#F5F3FF]"><X className="w-4 h-4" /></button>
        </div>

        <div className="p-4 space-y-3 overflow-y-auto min-h-0">
          {loading ? (
            <div className="flex items-center justify-center py-10 text-gray-400"><Spinner className="w-5 h-5 animate-spin" /></div>
          ) : (
            <>
              {/* Session picker */}
              <div className="flex items-end gap-2">
                <div className="flex-1 min-w-0">
                  <label className={LABEL}>Capture session</label>
                  <select value={activeId ?? ''} onChange={(e) => setActiveId(e.target.value || null)} className={INPUT} disabled={!sessions.length}>
                    {!sessions.length && <option value="">No sessions yet</option>}
                    {sessions.map((s) => <option key={s.id} value={s.id}>{s.name} · {s.entryCount} req{s.status === 'closed' ? ' · closed' : ''}</option>)}
                  </select>
                </div>
                <button type="button" onClick={() => void newSession()} disabled={busy} className={SECONDARY_BTN} title="Start a new capture session"><Plus className="w-3.5 h-3.5" />New</button>
                {activeId && <button type="button" onClick={() => void loadActive(activeId)} disabled={busy} className={SECONDARY_BTN} title="Refresh"><RefreshCw className="w-3.5 h-3.5" /></button>}
              </div>

              {!sessions.length && (
                <div className="text-center py-8">
                  <Antenna className="w-8 h-8 text-[#C4B5FD] mx-auto mb-2" />
                  <p className="text-[12.5px] text-gray-600 font-medium">Start a session, then record traffic into it.</p>
                  <p className="text-[11px] text-gray-400 mt-1">Drop a HAR export, or run the recorder proxy against your API.</p>
                </div>
              )}

              {active && (
                <>
                  <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-[#F5F3FF] border border-[#E4E0F5]">
                    <span className={`inline-flex items-center gap-1.5 text-[11.5px] font-semibold ${active.status === 'closed' ? 'text-gray-500' : 'text-emerald-700'}`}>
                      <span className={`w-2 h-2 rounded-full ${active.status === 'closed' ? 'bg-gray-400' : 'bg-emerald-500 animate-pulse'}`} />
                      {active.status === 'closed' ? 'Closed' : 'Recording'}
                    </span>
                    <span className="text-[12px] text-gray-700 font-mono tabular-nums">{count} request{count === 1 ? '' : 's'} captured</span>
                    <div className="ml-auto flex items-center gap-1.5">
                      {active.status !== 'closed' && <button type="button" onClick={() => void closeActive()} disabled={busy} className="inline-flex items-center gap-1 text-[11px] text-gray-500 hover:text-gray-800"><CircleStop className="w-3.5 h-3.5" />Stop</button>}
                      <button type="button" onClick={() => void removeActive()} disabled={busy} className="inline-flex items-center gap-1 text-[11px] text-gray-400 hover:text-red-500"><Trash2 className="w-3.5 h-3.5" />Delete</button>
                    </div>
                  </div>

                  {/* Record: HAR drop / paste */}
                  <div>
                    <label className={LABEL}>Record traffic</label>
                    <textarea
                      value={harText}
                      onChange={(e) => { setHarText(e.target.value); setError(''); }}
                      rows={4}
                      spellCheck={false}
                      disabled={active.status === 'closed'}
                      placeholder={'Paste a HAR export (DevTools → Save all as HAR), or a JSON array:\n[ { "method": "GET", "url": "https://api…/users", "status": 200, "responseBody": "{…}" } ]'}
                      className={`${INPUT} font-mono text-[11px] leading-relaxed resize-y`}
                    />
                    <div className="flex items-center gap-2 mt-1.5">
                      <button type="button" onClick={ingestHarText} disabled={busy || active.status === 'closed'} className={SECONDARY_BTN}><Upload className="w-3.5 h-3.5" />Add from paste</button>
                      <button type="button" onClick={() => fileRef.current?.click()} disabled={busy || active.status === 'closed'} className={SECONDARY_BTN}><Upload className="w-3.5 h-3.5" />Upload .har</button>
                      <input ref={fileRef} type="file" accept=".har,.json,application/json" className="hidden" onChange={(e) => void onFiles(e.target.files)} />
                      <button type="button" onClick={() => setShowSnippet((s) => !s)} className="ml-auto inline-flex items-center gap-1 text-[11px] text-[#6D28D9] hover:underline"><Terminal className="w-3.5 h-3.5" />{showSnippet ? 'Hide' : 'Recorder proxy'}</button>
                    </div>
                  </div>

                  {showSnippet && (
                    <div className="rounded-lg border border-[#E4E0F5] overflow-hidden">
                      <div className="flex items-center gap-2 px-3 py-1.5 bg-[#FAF9FE] border-b border-[#EDE9FE]">
                        <Terminal className="w-3.5 h-3.5 text-[#7C3AED]" />
                        <span className="text-[11px] font-medium text-gray-700">Recorder proxy — forwards to your API and streams traffic here</span>
                        <button type="button" onClick={() => void copySnippet()} className="ml-auto inline-flex items-center gap-1 text-[11px] text-[#6D28D9] hover:underline">{copied ? <><Check className="w-3.5 h-3.5" />Copied</> : <><Copy className="w-3.5 h-3.5" />Copy</>}</button>
                      </div>
                      <pre className="p-3 text-[10.5px] leading-relaxed font-mono text-gray-700 bg-white overflow-x-auto max-h-56">{recorderSnippet(origin, activeId!)}</pre>
                    </div>
                  )}

                  {/* Captured sample */}
                  {active.sample && active.sample.length > 0 && (
                    <div>
                      <label className={LABEL}>Latest captured</label>
                      <div className="border border-[#E9E5FB] rounded-lg divide-y divide-gray-100 max-h-40 overflow-y-auto">
                        {active.sample.map((e, i) => (
                          <div key={i} className="flex items-center gap-2 px-2.5 py-1.5 text-[11px]">
                            <MethodBadge method={e.method} />
                            <span className="font-mono text-gray-700 truncate flex-1 min-w-0" title={e.url}>{(() => { try { return new URL(e.url).pathname; } catch { return e.url; } })()}</span>
                            {e.status ? <span className={`font-mono tabular-nums ${e.status < 400 ? 'text-emerald-600' : 'text-red-500'}`}>{e.status}</span> : null}
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </>
              )}

              {error && (
                <div className="flex items-start gap-2 px-3 py-2 bg-red-50 border border-red-200 rounded-lg">
                  <AlertTriangle className="w-4 h-4 text-red-500 flex-shrink-0 mt-px" /><p className="text-[12px] text-red-700 min-w-0">{error}</p>
                </div>
              )}
            </>
          )}
        </div>

        {active && (
          <div className="flex items-center gap-2 px-4 h-14 border-t border-[#EDE9FE] flex-shrink-0 bg-white">
            <p className="text-[11px] text-gray-400">Builds deduped, noise-filtered endpoints from {count} captured request{count === 1 ? '' : 's'}.</p>
            <button type="button" onClick={() => void build()} disabled={busy || count === 0} className={`${PRIMARY_BTN} ml-auto`}>
              {busy ? <Spinner className="w-3.5 h-3.5 animate-spin" /> : <Layers className="w-3.5 h-3.5" />}
              Build endpoints ({count})
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
