/**
 * LoadTest — the standalone load-test dialog.
 *
 * Fires a bounded burst of requests at one chosen endpoint and reports latency
 * percentiles, throughput, status mix and errors. Opt-in and isolated — it
 * reuses nothing from the run pipeline. Write methods need an explicit opt-in
 * because a load run repeats the request many times.
 */
import { useState } from 'react';
import { X, Loader2, Gauge, AlertTriangle, Play } from 'lucide-react';
import { runApiLoadTest, type LoadTestResult } from '@/services/api';
import { MethodBadge } from './primitives';
import { CARD, STRIP, INPUT, LABEL, PRIMARY_BTN } from './format';
import type { CatalogEndpoint } from './types';

const isWrite = (m: string) => ['POST', 'PUT', 'PATCH', 'DELETE'].includes((m || 'GET').toUpperCase());

export default function LoadTest({ endpoints, onClose }: { endpoints: CatalogEndpoint[]; onClose: () => void }) {
  const [idx, setIdx] = useState(0);
  const [total, setTotal] = useState(50);
  const [concurrency, setConcurrency] = useState(10);
  const [allowWrites, setAllowWrites] = useState(false);
  const [result, setResult] = useState<LoadTestResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const ep = endpoints[Math.min(idx, endpoints.length - 1)];
  const write = ep ? isWrite(ep.method) : false;

  const run = async () => {
    if (!ep) return;
    setLoading(true); setError(''); setResult(null);
    try {
      setResult(await runApiLoadTest({
        endpoint: { id: ep.id, method: ep.method, url: ep.url, headers: ep.headers, auth: ep.auth, body: ep.body },
        totalRequests: total, concurrency, allowWrites,
      }));
    } catch (err: any) {
      setError(err?.response?.data?.error || err?.message || 'Load test failed.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-[#1E1B4B]/30 backdrop-blur-sm p-4" onClick={onClose}>
      <div className={`${CARD} w-full max-w-2xl max-h-[85vh] flex flex-col overflow-hidden`} onClick={(e) => e.stopPropagation()}>
        <div className={`flex items-center gap-2 px-4 h-12 border-b border-[#EDE9FE] flex-shrink-0 ${STRIP}`}>
          <Gauge className="w-4 h-4 text-[#7C3AED]" />
          <h3 className="text-[13px] font-semibold text-gray-900">Load test</h3>
          <span className="text-[11px] text-gray-400">in-house concurrency runner</span>
          <button type="button" onClick={onClose} className="ml-auto p-1.5 rounded-md text-gray-400 hover:text-[#7C3AED] hover:bg-[#F5F3FF]"><X className="w-4 h-4" /></button>
        </div>

        <div className="p-4 space-y-3 overflow-y-auto min-h-0">
          {/* Config */}
          <div className="grid grid-cols-[1fr_110px_110px] gap-3 items-end">
            <div>
              <label className={LABEL}>Endpoint</label>
              <select value={idx} onChange={(e) => setIdx(Number(e.target.value))} className={INPUT}>
                {endpoints.map((e, i) => <option key={e.id} value={i}>{e.method} {e.url}</option>)}
              </select>
            </div>
            <div>
              <label className={LABEL}>Requests</label>
              <input type="number" min={1} max={500} value={total} onChange={(e) => setTotal(Math.min(500, Math.max(1, Number(e.target.value) || 1)))} className={INPUT} />
            </div>
            <div>
              <label className={LABEL}>Concurrency</label>
              <input type="number" min={1} max={50} value={concurrency} onChange={(e) => setConcurrency(Math.min(50, Math.max(1, Number(e.target.value) || 1)))} className={INPUT} />
            </div>
          </div>

          {ep && (
            <div className="flex items-center gap-2 text-[11.5px] text-gray-500">
              <MethodBadge method={ep.method} /><span className="font-mono truncate">{ep.url}</span>
            </div>
          )}

          {write && (
            <label className="flex items-start gap-2 text-[11.5px] text-amber-700 bg-amber-50 border border-amber-200 rounded-md px-2.5 py-2 cursor-pointer">
              <input type="checkbox" checked={allowWrites} onChange={(e) => setAllowWrites(e.target.checked)} className="w-3.5 h-3.5 rounded border-amber-300 text-amber-600 mt-0.5" />
              <span>This is a <b>{ep!.method}</b> endpoint — a load run repeats the write {total} times. Only allow this against a safe/staging environment.</span>
            </label>
          )}

          <div className="flex justify-end">
            <button type="button" onClick={() => void run()} disabled={loading || !ep || (write && !allowWrites)} className={PRIMARY_BTN}>
              {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Play className="w-3.5 h-3.5" />}
              {loading ? 'Running…' : `Run ${total} requests`}
            </button>
          </div>

          {error && (
            <div className="flex items-start gap-2 px-3 py-2 bg-red-50 border border-red-200 rounded-lg">
              <AlertTriangle className="w-4 h-4 text-red-500 flex-shrink-0 mt-px" /><p className="text-[12px] text-red-700 min-w-0">{error}</p>
            </div>
          )}

          {/* Result */}
          {result && (
            <div className="space-y-3">
              <div className="grid grid-cols-3 gap-2">
                <Metric label="Throughput" value={`${result.throughputRps}`} unit="req/s" />
                <Metric label="Completed" value={`${result.completed}`} unit={`of ${result.totalRequests}`} tone={result.failed ? 'warn' : 'good'} />
                <Metric label="Failed / non-2xx" value={`${result.failed} / ${result.non2xx}`} unit="reqs" tone={result.failed || result.non2xx ? 'bad' : 'good'} />
              </div>
              <div className="grid grid-cols-6 gap-2">
                {(['min', 'p50', 'p90', 'p95', 'p99', 'max'] as const).map((k) => (
                  <Metric key={k} label={k.toUpperCase()} value={`${result.latency[k]}`} unit="ms" small />
                ))}
              </div>
              <div>
                <div className="text-[10.5px] font-semibold uppercase tracking-wide text-gray-500 mb-1">Status mix</div>
                <div className="flex flex-wrap gap-1.5">
                  {Object.entries(result.statusCounts).sort().map(([code, n]) => (
                    <span key={code} className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded border font-mono text-[10.5px] ${code.startsWith('2') ? 'text-emerald-700 bg-emerald-50 border-emerald-200' : code.startsWith('4') || code.startsWith('5') ? 'text-red-700 bg-red-50 border-red-200' : 'text-gray-600 bg-gray-50 border-gray-200'}`}>{code}<span className="tabular-nums">×{n}</span></span>
                  ))}
                </div>
              </div>
              {result.errors.length > 0 && (
                <ul className="space-y-0.5">
                  {result.errors.map((e, i) => <li key={i} className="text-[11px] text-red-600 font-mono flex gap-1.5"><span className="tabular-nums">×{e.count}</span><span className="min-w-0 truncate">{e.message}</span></li>)}
                </ul>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function Metric({ label, value, unit, tone = 'neutral', small = false }: { label: string; value: string; unit?: string; tone?: 'neutral' | 'good' | 'bad' | 'warn'; small?: boolean }) {
  const color = { neutral: 'text-gray-800', good: 'text-emerald-700', bad: 'text-red-700', warn: 'text-amber-700' }[tone];
  return (
    <div className="border border-[#E9E5FB] rounded-lg px-2.5 py-2 bg-white">
      <div className="text-[9.5px] font-semibold uppercase tracking-wide text-gray-400">{label}</div>
      <div className={`${small ? 'text-[15px]' : 'text-xl'} font-semibold tabular-nums leading-none mt-0.5 ${color}`}>{value}</div>
      {unit && <div className="text-[9.5px] text-gray-400 mt-0.5">{unit}</div>}
    </div>
  );
}
