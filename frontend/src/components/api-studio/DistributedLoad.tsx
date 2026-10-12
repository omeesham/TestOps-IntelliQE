/**
 * DistributedLoad — sustained, staged high-RPS across registered load agents.
 *
 * Where CloudLoad fires one fixed burst, this ramps: a series of stages, each
 * raising per-agent concurrency so aggregate throughput climbs stage over
 * stage. Every stage runs against every enabled agent for its own duration, and
 * the ramp is graded as a whole against an optional SLA — the first stage that
 * breaches it is reported. With no agents registered it falls back to a single
 * local node. Opt-in and isolated: it live-fires the endpoint and touches
 * nothing in the catalogue or the pipeline; write methods require opt-in.
 */
import { useEffect, useState } from 'react';
import { Cloud, TrendingUp, Plus, Trash2, X, CheckCircle2, AlertTriangle, Gauge } from 'lucide-react';
import Spinner from '@/components/feedback/Spinner';
import { runCloudLoadProfile, listLoadAgents, type CloudLoadProfileResult, type CloudProfileStage, type LoadAgent } from '@/services/api';
import { MethodBadge } from './primitives';
import { CARD, STRIP, INPUT, FIELD, LABEL, PRIMARY_BTN } from './format';
import type { CatalogEndpoint } from './types';

type Sla = { p95Ms?: number; maxErrorRatePct?: number; minThroughputRps?: number };

const DEFAULT_STAGES: CloudProfileStage[] = [
  { concurrencyPerAgent: 10, durationSec: 10 },
  { concurrencyPerAgent: 25, durationSec: 10 },
  { concurrencyPerAgent: 50, durationSec: 10 },
];

export default function DistributedLoad({ endpoints, onClose }: { endpoints: CatalogEndpoint[]; onClose: () => void }) {
  const [idx, setIdx] = useState(0);
  const [agents, setAgents] = useState<LoadAgent[]>([]);
  const [stages, setStages] = useState<CloudProfileStage[]>(DEFAULT_STAGES.map((s) => ({ ...s })));
  const [sla, setSla] = useState<Sla>({});
  const [allowWrites, setAllowWrites] = useState(false);
  const [result, setResult] = useState<CloudLoadProfileResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const ep = endpoints.length ? endpoints[Math.min(idx, endpoints.length - 1)] : undefined;
  const enabledAgents = agents.filter((a) => a.enabled).length;
  const slaNum = (v: string): number | undefined => (v.trim() === '' ? undefined : Math.max(0, Number(v)));

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const { agents: list } = await listLoadAgents();
        if (alive) setAgents(list);
      } catch { /* agents are optional — the ramp runs on a single local node */ }
    })();
    return () => { alive = false; };
  }, []);

  const setStage = (i: number, patch: Partial<CloudProfileStage>) => setStages((rows) => rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const addStage = () => setStages((rows) => {
    const last = rows[rows.length - 1];
    const next = last ? Math.round(last.concurrencyPerAgent * 2) : 10;
    return [...rows, { concurrencyPerAgent: Math.max(1, next), durationSec: last?.durationSec ?? 10 }];
  });
  const delStage = (i: number) => setStages((rows) => rows.filter((_, j) => j !== i));

  const run = async () => {
    if (!ep) return;
    setLoading(true); setError(''); setResult(null);
    try {
      const slaInput: Sla = {};
      (Object.keys(sla) as (keyof Sla)[]).forEach((k) => { if (sla[k] !== undefined) slaInput[k] = sla[k]; });
      setResult(await runCloudLoadProfile({
        endpoint: { method: ep.method, url: ep.url, headers: ep.headers, auth: ep.auth, body: ep.body },
        stages: stages.map((s) => ({ concurrencyPerAgent: Math.max(1, s.concurrencyPerAgent), durationSec: Math.max(1, s.durationSec) })),
        allowWrites,
        sla: Object.keys(slaInput).length ? slaInput : undefined,
      }));
    } catch (e: any) {
      setError(e?.response?.data?.error || e?.message || 'Distributed load ramp failed.');
    } finally {
      setLoading(false);
    }
  };

  const o = result?.overall;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-[#1E1B4B]/30 backdrop-blur-sm p-4" onClick={onClose}>
      <div className={`${CARD} w-full max-w-3xl max-h-[88vh] flex flex-col overflow-hidden`} onClick={(e) => e.stopPropagation()}>
        <div className={`flex items-center gap-2 px-4 h-12 border-b border-[#EDE9FE] flex-shrink-0 ${STRIP}`}>
          <TrendingUp className="w-4 h-4 text-[#7C3AED]" />
          <h3 className="text-[13px] font-semibold text-gray-900">Distributed load ramp</h3>
          <span className="text-[11px] text-gray-400">staged high-RPS across load agents</span>
          <button type="button" onClick={onClose} className="ml-auto p-1.5 rounded-md text-gray-400 hover:text-[#7C3AED] hover:bg-[#F5F3FF]"><X className="w-4 h-4" /></button>
        </div>

        <div className="p-4 space-y-3 overflow-y-auto min-h-0">
          {/* Agents */}
          <div className="flex items-center gap-2 text-[11.5px] text-gray-600">
            <Cloud className="w-4 h-4 text-[#7C3AED] flex-shrink-0" />
            {agents.length > 0 ? (
              <span><span className="font-semibold text-gray-700 tabular-nums">{agents.length}</span> agent{agents.length === 1 ? '' : 's'} registered{enabledAgents !== agents.length ? ` (${enabledAgents} enabled)` : ''} — the ramp fans out to each.</span>
            ) : (
              <span className="text-gray-400">No agents registered — the ramp runs on a single local node. Register remote agents in the <span className="font-medium text-gray-500">Cloud load</span> tool to fan out.</span>
            )}
          </div>

          {/* Endpoint */}
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

          {/* Stages */}
          <div>
            <div className="flex items-center justify-between mb-1">
              <label className={LABEL + ' mb-0'}>Ramp stages</label>
              <button type="button" onClick={addStage} className="inline-flex items-center gap-1 text-[11px] font-semibold text-[#6D28D9] hover:text-[#5B21B6]"><Plus className="w-3.5 h-3.5" />Add stage</button>
            </div>
            <div className="space-y-1.5">
              {stages.map((s, i) => (
                <div key={i} className="flex items-center gap-2 text-[11.5px] text-gray-600">
                  <span className="w-12 flex-shrink-0 text-[10.5px] font-semibold text-gray-400 tabular-nums">#{i + 1}</span>
                  <label className="flex items-center gap-1.5">
                    <span className="text-gray-500">conc / agent</span>
                    <input type="number" min={1} max={500} value={s.concurrencyPerAgent} onChange={(e) => setStage(i, { concurrencyPerAgent: Math.max(1, Number(e.target.value)) })} className={`${FIELD} w-20`} />
                  </label>
                  <label className="flex items-center gap-1.5">
                    <span className="text-gray-500">duration</span>
                    <input type="number" min={1} max={300} value={s.durationSec} onChange={(e) => setStage(i, { durationSec: Math.max(1, Number(e.target.value)) })} className={`${FIELD} w-20`} /> sec
                  </label>
                  {agents.length > 0 && <span className="text-[10.5px] text-gray-400 tabular-nums">≈ {s.concurrencyPerAgent * Math.max(1, enabledAgents)} aggregate</span>}
                  <button type="button" onClick={() => delStage(i)} disabled={stages.length <= 1} className="ml-auto p-1 rounded text-gray-300 hover:text-red-500 disabled:opacity-30 flex-shrink-0"><Trash2 className="w-3.5 h-3.5" /></button>
                </div>
              ))}
            </div>
            <p className="text-[10px] text-gray-400 mt-1.5">Each stage raises per-agent concurrency, so aggregate RPS climbs stage over stage.</p>
          </div>

          {/* SLA */}
          <div>
            <label className={LABEL}>SLA gate — leave a field blank to skip that check</label>
            <div className="grid grid-cols-3 gap-2">
              <label className="text-[11px] text-gray-600">p95 ≤ (ms)
                <input type="number" min={0} value={sla.p95Ms ?? ''} onChange={(e) => setSla((p) => ({ ...p, p95Ms: slaNum(e.target.value) }))} className={`${INPUT} py-1 mt-0.5`} />
              </label>
              <label className="text-[11px] text-gray-600">error ≤ (%)
                <input type="number" min={0} value={sla.maxErrorRatePct ?? ''} onChange={(e) => setSla((p) => ({ ...p, maxErrorRatePct: slaNum(e.target.value) }))} className={`${INPUT} py-1 mt-0.5`} />
              </label>
              <label className="text-[11px] text-gray-600">tput ≥ (rps)
                <input type="number" min={0} value={sla.minThroughputRps ?? ''} onChange={(e) => setSla((p) => ({ ...p, minThroughputRps: slaNum(e.target.value) }))} className={`${INPUT} py-1 mt-0.5`} />
              </label>
            </div>
          </div>

          <div className="flex items-center justify-between gap-2">
            <label className="flex items-center gap-1.5 text-[11px] text-gray-500 cursor-pointer">
              <input type="checkbox" checked={allowWrites} onChange={(e) => setAllowWrites(e.target.checked)} className="w-3.5 h-3.5 rounded border-gray-300" />
              Allow writes (each stage repeats the request many times)
            </label>
            <button type="button" onClick={() => void run()} disabled={loading || !ep} className={PRIMARY_BTN}>
              {loading ? <Spinner className="w-3.5 h-3.5 animate-spin" /> : <TrendingUp className="w-3.5 h-3.5" />}
              {loading ? 'Ramping…' : 'Run ramp'}
            </button>
          </div>

          {loading && (
            <div className="flex items-center justify-center gap-2 py-10 text-[12px] text-gray-500">
              <Spinner className="w-4 h-4 animate-spin text-[#7C3AED]" />
              Driving {stages.length} stage{stages.length === 1 ? '' : 's'} across {enabledAgents || 1} node{(enabledAgents || 1) === 1 ? '' : 's'} — this can take a while…
            </div>
          )}

          {error && (
            <div className="flex items-start gap-2 px-3 py-2 bg-red-50 border border-red-200 rounded-lg">
              <AlertTriangle className="w-4 h-4 text-red-500 flex-shrink-0 mt-px" /><p className="text-[12px] text-red-700 min-w-0 whitespace-pre-wrap break-words">{error}</p>
            </div>
          )}

          {!loading && !error && !result && (
            <div className="flex flex-col items-center justify-center gap-2 py-10 px-6 text-center">
              <Gauge className="w-7 h-7 text-gray-300" />
              <p className="text-[12.5px] text-gray-500 max-w-sm">Define the ramp stages, then <span className="text-gray-700 font-medium">Run ramp</span>. Each stage holds its load for its full duration before the next raises concurrency.</p>
            </div>
          )}

          {result && o && (
            <div className="space-y-3">
              {/* SLA verdict */}
              {result.sla && (
                <div className={`rounded-lg border px-3 py-2.5 ${result.sla.pass ? 'bg-emerald-50 border-emerald-200' : 'bg-red-50 border-red-200'}`}>
                  <div className="flex items-center gap-2 mb-1.5">
                    {result.sla.pass ? <CheckCircle2 className="w-4 h-4 text-emerald-600" /> : <AlertTriangle className="w-4 h-4 text-red-600" />}
                    <span className={`text-[12.5px] font-semibold ${result.sla.pass ? 'text-emerald-700' : 'text-red-700'}`}>
                      SLA gate {result.sla.pass ? 'passed across every stage' : `failed at stage #${result.sla.atStage}`}
                    </span>
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {result.sla.checks.map((c) => (
                      <span key={c.name} className={`inline-flex items-center gap-1 px-2 py-0.5 rounded border text-[10.5px] font-mono ${c.pass ? 'text-emerald-700 bg-white border-emerald-200' : 'text-red-700 bg-white border-red-200'}`}>
                        {c.pass ? <CheckCircle2 className="w-3 h-3" /> : <AlertTriangle className="w-3 h-3" />}{c.name} {c.actual}{c.unit} / {c.limit}{c.unit}
                      </span>
                    ))}
                  </div>
                </div>
              )}

              {/* Overall rollup */}
              <div className="flex flex-wrap items-center gap-2 text-[11.5px]">
                <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md border bg-gray-50 border-gray-200 text-gray-700 font-mono tabular-nums">peak {o.peakThroughputRps} rps</span>
                <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md border font-mono tabular-nums ${o.errorRatePct > 0 ? 'text-red-700 bg-red-50 border-red-200' : 'text-emerald-700 bg-emerald-50 border-emerald-200'}`}>{o.errorRatePct}% errors</span>
                <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md border bg-gray-50 border-gray-200 text-gray-700 font-mono tabular-nums">worst p95 {o.worstP95}ms</span>
                <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md border bg-gray-50 border-gray-200 text-gray-700 font-mono tabular-nums">worst p99 {o.worstP99}ms</span>
                <span className="ml-auto text-[11px] text-gray-400 tabular-nums">{o.completed} ok · {o.failed} failed · {o.non2xx} non-2xx · {result.agentsUsed} node{result.agentsUsed === 1 ? '' : 's'}</span>
              </div>

              {/* Per-stage */}
              <div className="border border-[#E9E5FB] rounded-lg overflow-hidden">
                <table className="w-full text-[11.5px]">
                  <thead>
                    <tr className="bg-[#FAF9FE] text-gray-500 text-left">
                      <th className="font-semibold px-2.5 py-1.5">Stage</th>
                      <th className="font-semibold px-2.5 py-1.5 text-right">conc / agent</th>
                      <th className="font-semibold px-2.5 py-1.5 text-right">duration</th>
                      <th className="font-semibold px-2.5 py-1.5 text-right">rps</th>
                      <th className="font-semibold px-2.5 py-1.5 text-right">p95</th>
                      <th className="font-semibold px-2.5 py-1.5 text-right">error</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {result.stages.map((st) => {
                      const t = st.result.totals;
                      return (
                        <tr key={st.stage}>
                          <td className="px-2.5 py-1.5 text-gray-700 tabular-nums">#{st.stage}</td>
                          <td className="px-2.5 py-1.5 text-right font-mono tabular-nums">{st.concurrencyPerAgent}</td>
                          <td className="px-2.5 py-1.5 text-right font-mono tabular-nums">{st.durationSec}s</td>
                          <td className="px-2.5 py-1.5 text-right font-mono tabular-nums">{t.throughputRps}</td>
                          <td className="px-2.5 py-1.5 text-right font-mono tabular-nums">{t.latency.p95}ms</td>
                          <td className={`px-2.5 py-1.5 text-right font-mono tabular-nums ${t.errorRatePct > 0 ? 'text-red-500' : 'text-gray-500'}`}>{t.errorRatePct}%</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              {result.note && <p className="text-[10.5px] text-gray-400">{result.note}</p>}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
