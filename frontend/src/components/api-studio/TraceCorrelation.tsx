/**
 * TraceCorrelation — verify that a request produced the spans you expect in a
 * distributed tracing backend (Jaeger / Zipkin / Tempo).
 *
 * Opt-in and standalone. Fires the chosen endpoint with a correlation id, then
 * queries the backend for the resulting trace and asserts over its spans. It
 * live-fires the endpoint and changes nothing in the catalogue or the pipeline.
 */
import { useState } from 'react';
import { Spline, X, Play, AlertTriangle, CheckCircle2, XCircle } from 'lucide-react';
import Spinner from '@/components/feedback/Spinner';
import { runTraceProbe, type TraceResult } from '@/services/api';
import { MethodBadge, StatusCode, CopyButton } from './primitives';
import { CARD, STRIP, INPUT, LABEL, PRIMARY_BTN } from './format';
import type { CatalogEndpoint } from './types';

type Backend = 'jaeger' | 'zipkin' | 'tempo';

export default function TraceCorrelation({ endpoints, onClose }: { endpoints: CatalogEndpoint[]; onClose: () => void }) {
  const [idx, setIdx] = useState(0);
  const [backend, setBackend] = useState<Backend>('jaeger');
  const [queryUrl, setQueryUrl] = useState('');
  const [expectSpansText, setExpectSpansText] = useState('');
  const [minSpans, setMinSpans] = useState(1);
  const [waitMs, setWaitMs] = useState(2000);
  const [result, setResult] = useState<TraceResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const ep = endpoints.length ? endpoints[Math.min(idx, endpoints.length - 1)] : undefined;

  const run = async () => {
    if (!ep) return;
    setLoading(true); setError(''); setResult(null);
    try {
      const expectSpans = expectSpansText.split(',').map((s) => s.trim()).filter(Boolean);
      setResult(await runTraceProbe({
        endpoint: { method: ep.method, url: ep.url, headers: ep.headers, auth: ep.auth, body: ep.body },
        tracing: queryUrl.trim() ? { type: backend, queryUrl: queryUrl.trim() } : undefined,
        expectSpans,
        minSpans,
        waitMs,
      }));
    } catch (e: any) {
      setError(e?.response?.data?.error || e?.message || 'Trace probe failed.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-[#1E1B4B]/30 backdrop-blur-sm p-4" onClick={onClose}>
      <div className={`${CARD} w-full max-w-2xl max-h-[88vh] flex flex-col overflow-hidden`} onClick={(e) => e.stopPropagation()}>
        <div className={`flex items-center gap-2 px-4 h-12 border-b border-[#EDE9FE] flex-shrink-0 ${STRIP}`}>
          <Spline className="w-4 h-4 text-[#7C3AED]" />
          <h3 className="text-[13px] font-semibold text-gray-900">Trace correlation</h3>
          <span className="text-[11px] text-gray-400">verify spans in Jaeger / Zipkin / Tempo</span>
          <button type="button" onClick={onClose} className="ml-auto p-1.5 rounded-md text-gray-400 hover:text-[#7C3AED] hover:bg-[#F5F3FF]"><X className="w-4 h-4" /></button>
        </div>

        <div className="p-4 space-y-3 overflow-y-auto min-h-0">
          <div>
            <label className={LABEL}>Endpoint</label>
            <select value={idx} onChange={(e) => { setIdx(Number(e.target.value)); setResult(null); }} className={INPUT} disabled={!endpoints.length}>
              {endpoints.length === 0 && <option>No endpoints in the catalogue</option>}
              {endpoints.map((e, i) => <option key={e.id} value={i}>{e.method} {e.url}</option>)}
            </select>
          </div>
          {ep && (
            <div className="flex items-center gap-2 text-[11.5px] text-gray-500">
              <MethodBadge method={ep.method} /><span className="font-mono truncate">{ep.url}</span>
            </div>
          )}

          {/* Backend + query url */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
            <div>
              <label className={LABEL}>Backend</label>
              <select value={backend} onChange={(e) => setBackend(e.target.value as Backend)} className={INPUT}>
                <option value="jaeger">Jaeger</option>
                <option value="zipkin">Zipkin</option>
                <option value="tempo">Tempo</option>
              </select>
            </div>
            <div className="sm:col-span-2">
              <label className={LABEL}>Query URL</label>
              <input value={queryUrl} onChange={(e) => setQueryUrl(e.target.value)} placeholder="http://localhost:16686" className={`${INPUT} font-mono text-[11px]`} />
            </div>
          </div>

          <div>
            <label className={LABEL}>Expected spans — comma-separated, blank to skip</label>
            <input value={expectSpansText} onChange={(e) => setExpectSpansText(e.target.value)} placeholder="auth, db.query, cache.get" className={INPUT} />
          </div>

          <div className="flex flex-wrap items-center gap-4">
            <label className="flex items-center gap-2 text-[11.5px] text-gray-600">
              <span className="font-semibold">Min spans</span>
              <input type="number" min={0} value={minSpans} onChange={(e) => setMinSpans(Math.max(0, Number(e.target.value)))} className={`${INPUT} w-20 py-1`} />
            </label>
            <label className="flex items-center gap-2 text-[11.5px] text-gray-600">
              <span className="font-semibold">Wait</span>
              <input type="number" min={0} value={waitMs} onChange={(e) => setWaitMs(Math.max(0, Number(e.target.value)))} className={`${INPUT} w-24 py-1`} /> ms
            </label>
          </div>

          <div className="flex items-center justify-end gap-2">
            {loading && <span className="text-[11px] text-gray-400">querying trace…</span>}
            <button type="button" onClick={() => void run()} disabled={loading || !ep} className={PRIMARY_BTN}>
              {loading ? <Spinner className="w-3.5 h-3.5 animate-spin" /> : <Play className="w-3.5 h-3.5" />}
              {loading ? 'Running…' : 'Run'}
            </button>
          </div>

          {error && (
            <div className="flex items-start gap-2 px-3 py-2 bg-red-50 border border-red-200 rounded-lg">
              <AlertTriangle className="w-4 h-4 text-red-500 flex-shrink-0 mt-px" /><p className="text-[12px] text-red-700 min-w-0 whitespace-pre-wrap break-words">{error}</p>
            </div>
          )}

          {result && (
            <div className="space-y-3">
              {/* Ids */}
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[11.5px]">
                <div className="flex items-center gap-1.5">
                  <span className="text-gray-400">trace</span>
                  <span className="font-mono text-gray-700 truncate max-w-[180px]">{result.traceId || '—'}</span>
                  {result.traceId && <CopyButton text={result.traceId} label="" />}
                </div>
                <div className="flex items-center gap-1.5">
                  <span className="text-gray-400">corr</span>
                  <span className="font-mono text-gray-700 truncate max-w-[180px]">{result.correlationId || '—'}</span>
                  {result.correlationId && <CopyButton text={result.correlationId} label="" />}
                </div>
              </div>

              {/* Request */}
              <div className="flex flex-wrap items-center gap-2 text-[11.5px]">
                <StatusCode code={result.request.status ?? ''} />
                <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md border bg-gray-50 border-gray-200 text-gray-700 font-mono tabular-nums">{result.request.elapsedMs}ms</span>
                {result.request.error && <span className="text-[11px] text-red-600 min-w-0 truncate">{result.request.error}</span>}
                {result.backend && <span className="ml-auto text-[11px] text-gray-400">{result.backend}</span>}
              </div>

              {/* Assertions */}
              {result.assertions.length > 0 && (
                <div className="space-y-1">
                  {result.assertions.map((a) => (
                    <div key={a.name} className="flex items-start gap-1.5 text-[11.5px]">
                      {a.pass ? <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600 flex-shrink-0 mt-px" /> : <XCircle className="w-3.5 h-3.5 text-red-600 flex-shrink-0 mt-px" />}
                      <span className={a.pass ? 'text-gray-700' : 'text-red-700'}>{a.name}</span>
                      {a.detail && <span className="text-gray-400">— {a.detail}</span>}
                    </div>
                  ))}
                </div>
              )}

              {/* Spans */}
              <div className="border border-[#E9E5FB] rounded-lg overflow-hidden">
                <table className="w-full text-[11.5px]">
                  <thead>
                    <tr className="bg-[#FAF9FE] text-gray-500 text-left">
                      <th className="font-semibold px-2.5 py-1.5">Span</th>
                      <th className="font-semibold px-2.5 py-1.5">service</th>
                      <th className="font-semibold px-2.5 py-1.5 text-right">duration</th>
                      <th className="font-semibold px-2.5 py-1.5 text-center">error</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {result.spans.map((s, i) => (
                      <tr key={`${s.name}-${i}`}>
                        <td className="px-2.5 py-1.5 text-gray-700 font-mono">{s.name}</td>
                        <td className="px-2.5 py-1.5 text-gray-500">{s.service}</td>
                        <td className="px-2.5 py-1.5 text-right font-mono tabular-nums">{s.durationMs}ms</td>
                        <td className="px-2.5 py-1.5 text-center">
                          {s.error
                            ? <span className="inline-flex items-center px-1.5 py-0.5 rounded border text-[10px] font-medium text-red-700 bg-red-50 border-red-200">error</span>
                            : <span className="text-gray-300">—</span>}
                        </td>
                      </tr>
                    ))}
                    {result.spans.length === 0 && (
                      <tr><td colSpan={4} className="px-2.5 py-3 text-center text-gray-400">No spans returned</td></tr>
                    )}
                  </tbody>
                </table>
              </div>

              <div className="flex items-center justify-between text-[11px] text-gray-400 tabular-nums">
                <span>{result.spanCount} span{result.spanCount === 1 ? '' : 's'}</span>
              </div>

              {result.note && <p className="text-[10.5px] text-gray-400">{result.note}</p>}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
