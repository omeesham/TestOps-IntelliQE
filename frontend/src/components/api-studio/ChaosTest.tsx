/**
 * ChaosTest — fault-injection / resilience probe for one endpoint.
 *
 * Opt-in and standalone. Runs a battery of fault experiments against the chosen
 * endpoint plus a burst, then grades how gracefully the service degrades. It
 * live-fires the endpoint and changes nothing in the catalogue or the pipeline;
 * write-method experiments are skipped unless writes are explicitly allowed.
 */
import { useState } from 'react';
import { Zap, X, Play, AlertTriangle } from 'lucide-react';
import Spinner from '@/components/feedback/Spinner';
import { runChaosProbe, type ChaosReport } from '@/services/api';
import { MethodBadge, StatusCode } from './primitives';
import { CARD, STRIP, INPUT, LABEL, PRIMARY_BTN } from './format';
import type { CatalogEndpoint } from './types';

function gradeClass(g: string): string {
  if (g === 'A' || g === 'B') return 'text-emerald-700 bg-emerald-50 border-emerald-200';
  if (g === 'C') return 'text-amber-700 bg-amber-50 border-amber-200';
  return 'text-red-700 bg-red-50 border-red-200';
}

function outcomeChipClass(o: string): string {
  if (o === 'resilient') return 'text-emerald-700 bg-emerald-50 border-emerald-200';
  if (o === 'fragile') return 'text-red-700 bg-red-50 border-red-200';
  return 'text-gray-600 bg-gray-50 border-gray-200';
}

const CHIP = 'inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md border bg-gray-50 border-gray-200 text-gray-700 font-mono tabular-nums';

export default function ChaosTest({ endpoints, onClose }: { endpoints: CatalogEndpoint[]; onClose: () => void }) {
  const [idx, setIdx] = useState(0);
  const [requests, setRequests] = useState(20);
  const [concurrency, setConcurrency] = useState(8);
  const [timeoutMs, setTimeoutMs] = useState(10000);
  const [allowWrites, setAllowWrites] = useState(false);
  const [result, setResult] = useState<ChaosReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const ep = endpoints.length ? endpoints[Math.min(idx, endpoints.length - 1)] : undefined;

  const run = async () => {
    if (!ep) return;
    setLoading(true); setError(''); setResult(null);
    try {
      setResult(await runChaosProbe({
        endpoint: { method: ep.method, url: ep.url, headers: ep.headers, auth: ep.auth, body: ep.body },
        requests,
        concurrency,
        allowWrites,
        timeoutMs,
      }));
    } catch (e: any) {
      setError(e?.response?.data?.error || e?.message || 'Chaos probe failed.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-[#1E1B4B]/30 backdrop-blur-sm p-4" onClick={onClose}>
      <div className={`${CARD} w-full max-w-2xl max-h-[88vh] flex flex-col overflow-hidden`} onClick={(e) => e.stopPropagation()}>
        <div className={`flex items-center gap-2 px-4 h-12 border-b border-[#EDE9FE] flex-shrink-0 ${STRIP}`}>
          <Zap className="w-4 h-4 text-[#7C3AED]" />
          <h3 className="text-[13px] font-semibold text-gray-900">Chaos / resilience</h3>
          <span className="text-[11px] text-gray-400">fault injection — grades graceful degradation</span>
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

          {/* Burst knobs */}
          <div className="flex flex-wrap items-center gap-4">
            <label className="flex items-center gap-2 text-[11.5px] text-gray-600">
              <span className="font-semibold">Requests</span>
              <input type="number" min={1} max={1000} value={requests} onChange={(e) => setRequests(Math.max(1, Number(e.target.value)))} className={`${INPUT} w-20 py-1`} />
            </label>
            <label className="flex items-center gap-2 text-[11.5px] text-gray-600">
              <span className="font-semibold">Concurrency</span>
              <input type="number" min={1} max={100} value={concurrency} onChange={(e) => setConcurrency(Math.max(1, Number(e.target.value)))} className={`${INPUT} w-20 py-1`} />
            </label>
            <label className="flex items-center gap-2 text-[11.5px] text-gray-600">
              <span className="font-semibold">Timeout</span>
              <input type="number" min={0} value={timeoutMs} onChange={(e) => setTimeoutMs(Math.max(0, Number(e.target.value)))} className={`${INPUT} w-24 py-1`} /> ms
            </label>
          </div>

          <div>
            <label className="flex items-center gap-2 text-[11.5px] text-gray-600">
              <input type="checkbox" checked={allowWrites} onChange={(e) => setAllowWrites(e.target.checked)} className="w-3.5 h-3.5" />
              Allow writes
            </label>
            <p className="text-[10px] text-gray-400 mt-1">write-method experiments are skipped unless enabled</p>
          </div>

          <div className="flex items-center justify-end gap-2">
            {loading && <span className="text-[11px] text-gray-400">injecting faults…</span>}
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
              {/* Grade */}
              <div className="flex items-center gap-3">
                <span className={`inline-flex items-center justify-center w-11 h-11 rounded-lg border text-[20px] font-bold ${gradeClass(result.grade)}`}>{result.grade}</span>
                <div className="min-w-0">
                  <div className="text-[13px] font-semibold text-gray-800 tabular-nums">{result.resilienceScore}<span className="text-gray-400 font-normal">/100</span> resilience</div>
                  <div className="text-[11px] text-gray-500 tabular-nums">{result.summary.resilient} resilient · {result.summary.fragile} fragile · {result.summary.skipped} skipped</div>
                </div>
              </div>

              {/* Burst stats */}
              <div className="flex flex-wrap items-center gap-2 text-[11.5px]">
                <span className={CHIP}>{result.burst.requests} req</span>
                <span className={CHIP}>conc {result.burst.concurrency}</span>
                <span className={CHIP}>{result.burst.completed} done</span>
                <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md border font-mono tabular-nums ${result.burst.serverErrors > 0 ? 'text-red-700 bg-red-50 border-red-200' : 'bg-gray-50 border-gray-200 text-gray-700'}`}>{result.burst.serverErrors} 5xx</span>
                <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md border font-mono tabular-nums ${result.burst.failures > 0 ? 'text-red-700 bg-red-50 border-red-200' : 'bg-gray-50 border-gray-200 text-gray-700'}`}>{result.burst.failures} fail</span>
                <span className={CHIP}>avg {result.burst.avgMs}ms</span>
                <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md border text-[10.5px] font-mono ${outcomeChipClass(result.burst.outcome)}`}>burst {result.burst.outcome}</span>
              </div>

              {/* Experiments */}
              <div className="border border-[#E9E5FB] rounded-lg overflow-hidden">
                <table className="w-full text-[11.5px]">
                  <thead>
                    <tr className="bg-[#FAF9FE] text-gray-500 text-left">
                      <th className="font-semibold px-2.5 py-1.5">Experiment</th>
                      <th className="font-semibold px-2.5 py-1.5">outcome</th>
                      <th className="font-semibold px-2.5 py-1.5 text-center">status</th>
                      <th className="font-semibold px-2.5 py-1.5 text-right">elapsed</th>
                      <th className="font-semibold px-2.5 py-1.5">detail</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {result.experiments.map((x) => (
                      <tr key={x.name}>
                        <td className="px-2.5 py-1.5 text-gray-700">
                          <div className="font-medium">{x.name}</div>
                          {x.description && <div className="text-[10.5px] text-gray-400">{x.description}</div>}
                        </td>
                        <td className="px-2.5 py-1.5">
                          <span className={`inline-flex items-center px-1.5 py-0.5 rounded border text-[10px] font-medium ${outcomeChipClass(x.outcome)}`}>{x.outcome}</span>
                        </td>
                        <td className="px-2.5 py-1.5 text-center">{x.status !== undefined ? <StatusCode code={x.status} /> : <span className="text-gray-300">—</span>}</td>
                        <td className="px-2.5 py-1.5 text-right font-mono tabular-nums">{x.elapsedMs}ms</td>
                        <td className="px-2.5 py-1.5 text-gray-500">{x.detail}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <div className="text-[11px] text-gray-400 tabular-nums">{result.method} {result.url}</div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
