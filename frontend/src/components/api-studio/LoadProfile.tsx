/**
 * LoadProfile — staged / ramp-up load testing with an SLA gate.
 *
 * Opt-in and standalone. Unlike the single-burst Load test, this runs a series
 * of time-boxed stages (increasing concurrency = ramp-up) and can *fail a gate*
 * against latency / error-rate / throughput SLAs — the shape a CI performance
 * check needs. It live-fires the endpoint and changes nothing in the catalogue
 * or the pipeline. Write methods require explicit opt-in.
 */
import { useMemo, useState } from 'react';
import { X, Activity, Play, Plus, Trash2, AlertTriangle, CheckCircle2, XCircle } from 'lucide-react';
import Spinner from '@/components/feedback/Spinner';
import { runApiLoadProfile, type LoadProfileResult, type LoadStageInput, type SlaThresholds } from '@/services/api';
import { MethodBadge } from './primitives';
import { CARD, STRIP, INPUT, LABEL, PRIMARY_BTN } from './format';
import type { CatalogEndpoint } from './types';

const PRESETS: { label: string; stages: LoadStageInput[] }[] = [
  { label: 'Ramp 5 → 10 → 20', stages: [{ concurrency: 5, durationSec: 10 }, { concurrency: 10, durationSec: 10 }, { concurrency: 20, durationSec: 10 }] },
  { label: 'Soak 10 × 45s', stages: [{ concurrency: 10, durationSec: 45 }] },
  { label: 'Spike 2 → 40', stages: [{ concurrency: 2, durationSec: 8 }, { concurrency: 40, durationSec: 12 }, { concurrency: 2, durationSec: 8 }] },
];

const isWrite = (m: string) => /^(POST|PUT|PATCH|DELETE)$/i.test(m);

export default function LoadProfile({ endpoints, onClose }: { endpoints: CatalogEndpoint[]; onClose: () => void }) {
  const [idx, setIdx] = useState(0);
  const [stages, setStages] = useState<LoadStageInput[]>(PRESETS[0].stages);
  const [sla, setSla] = useState<SlaThresholds>({ p95Ms: 400, maxErrorRatePct: 1 });
  const [allowWrites, setAllowWrites] = useState(false);
  const [report, setReport] = useState<LoadProfileResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const ep = endpoints[Math.min(idx, endpoints.length - 1)];
  const totalSec = useMemo(() => stages.reduce((s, st) => s + (Number(st.durationSec) || 0), 0), [stages]);
  const writeBlocked = ep && isWrite(ep.method) && !allowWrites;

  const setStage = (i: number, patch: Partial<LoadStageInput>) => setStages((prev) => prev.map((s, j) => (j === i ? { ...s, ...patch } : s)));
  const addStage = () => setStages((prev) => [...prev, { concurrency: 10, durationSec: 10 }].slice(0, 10));
  const removeStage = (i: number) => setStages((prev) => (prev.length > 1 ? prev.filter((_, j) => j !== i) : prev));
  const slaNum = (v: string): number | undefined => (v.trim() === '' ? undefined : Math.max(0, Number(v)));

  const run = async () => {
    if (!ep) return;
    setLoading(true); setError(''); setReport(null);
    try {
      setReport(await runApiLoadProfile({
        endpoint: { id: ep.id, title: ep.title, method: ep.method, url: ep.url, headers: ep.headers, auth: ep.auth, body: ep.body },
        stages,
        sla,
        allowWrites,
      }));
    } catch (err: any) {
      setError(err?.response?.data?.error || err?.message || 'Load profile failed.');
    } finally {
      setLoading(false);
    }
  };

  const t = report?.totals;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-[#1E1B4B]/30 backdrop-blur-sm p-4" onClick={onClose}>
      <div className={`${CARD} w-full max-w-3xl max-h-[88vh] flex flex-col overflow-hidden`} onClick={(e) => e.stopPropagation()}>
        <div className={`flex items-center gap-2 px-4 h-12 border-b border-[#EDE9FE] flex-shrink-0 ${STRIP}`}>
          <Activity className="w-4 h-4 text-[#7C3AED]" />
          <h3 className="text-[13px] font-semibold text-gray-900">Load profile &amp; SLA gate</h3>
          <span className="text-[11px] text-gray-400">ramp-up stages · pass/fail thresholds</span>
          <button type="button" onClick={onClose} className="ml-auto p-1.5 rounded-md text-gray-400 hover:text-[#7C3AED] hover:bg-[#F5F3FF]"><X className="w-4 h-4" /></button>
        </div>

        <div className="p-4 space-y-3 overflow-y-auto min-h-0">
          <div>
            <label className={LABEL}>Endpoint</label>
            <select value={idx} onChange={(e) => { setIdx(Number(e.target.value)); setReport(null); }} className={INPUT}>
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
              <label className={LABEL}>Stages — concurrency held for a duration (ramp by increasing it)</label>
              <span className="text-[10.5px] text-gray-400 tabular-nums">~{totalSec}s total</span>
            </div>
            <div className="flex flex-wrap gap-1.5 mb-2">
              {PRESETS.map((p) => (
                <button key={p.label} type="button" onClick={() => setStages(p.stages)} className="px-2 py-0.5 rounded-full border border-[#E4E0F5] text-[10.5px] text-[#6D28D9] hover:bg-[#F5F3FF]">{p.label}</button>
              ))}
            </div>
            <div className="space-y-1.5">
              {stages.map((s, i) => (
                <div key={i} className="flex items-center gap-2">
                  <span className="text-[11px] text-gray-400 w-12">Stage {i + 1}</span>
                  <label className="flex items-center gap-1 text-[11px] text-gray-600">
                    <input type="number" min={1} max={50} value={s.concurrency} onChange={(e) => setStage(i, { concurrency: Math.max(1, Number(e.target.value)) })} className={`${INPUT} w-20 py-1`} /> conc.
                  </label>
                  <label className="flex items-center gap-1 text-[11px] text-gray-600">
                    <input type="number" min={1} max={60} value={s.durationSec} onChange={(e) => setStage(i, { durationSec: Math.max(1, Number(e.target.value)) })} className={`${INPUT} w-20 py-1`} /> sec
                  </label>
                  <button type="button" onClick={() => removeStage(i)} disabled={stages.length <= 1} className="p-1 rounded text-gray-400 hover:text-red-500 disabled:opacity-30"><Trash2 className="w-3.5 h-3.5" /></button>
                </div>
              ))}
            </div>
            <button type="button" onClick={addStage} disabled={stages.length >= 10} className="mt-1.5 inline-flex items-center gap-1 text-[11px] text-[#6D28D9] hover:underline disabled:opacity-40"><Plus className="w-3.5 h-3.5" />Add stage</button>
            <p className="text-[10px] text-gray-400 mt-1">Capped at 10 stages, 50 concurrency, 60s per stage and 120s total.</p>
          </div>

          {/* SLA thresholds */}
          <div>
            <label className={LABEL}>SLA gate — leave a field blank to skip that check</label>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
              <label className="text-[11px] text-gray-600">p95 ≤ (ms)
                <input type="number" min={0} value={sla.p95Ms ?? ''} onChange={(e) => setSla((p) => ({ ...p, p95Ms: slaNum(e.target.value) }))} className={`${INPUT} py-1 mt-0.5`} />
              </label>
              <label className="text-[11px] text-gray-600">p99 ≤ (ms)
                <input type="number" min={0} value={sla.p99Ms ?? ''} onChange={(e) => setSla((p) => ({ ...p, p99Ms: slaNum(e.target.value) }))} className={`${INPUT} py-1 mt-0.5`} />
              </label>
              <label className="text-[11px] text-gray-600">error ≤ (%)
                <input type="number" min={0} value={sla.maxErrorRatePct ?? ''} onChange={(e) => setSla((p) => ({ ...p, maxErrorRatePct: slaNum(e.target.value) }))} className={`${INPUT} py-1 mt-0.5`} />
              </label>
              <label className="text-[11px] text-gray-600">throughput ≥ (rps)
                <input type="number" min={0} value={sla.minThroughputRps ?? ''} onChange={(e) => setSla((p) => ({ ...p, minThroughputRps: slaNum(e.target.value) }))} className={`${INPUT} py-1 mt-0.5`} />
              </label>
            </div>
          </div>

          {ep && isWrite(ep.method) && (
            <label className="flex items-center gap-2 text-[11.5px] text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
              <input type="checkbox" checked={allowWrites} onChange={(e) => setAllowWrites(e.target.checked)} className="w-3.5 h-3.5" />
              This is a <span className="font-semibold">{ep.method}</span> endpoint — allow repeated writes against this environment.
            </label>
          )}

          <div className="flex justify-end">
            <button type="button" onClick={() => void run()} disabled={loading || !ep || writeBlocked} className={PRIMARY_BTN}>
              {loading ? <Spinner className="w-3.5 h-3.5 animate-spin" /> : <Play className="w-3.5 h-3.5" />}
              {loading ? `Running ~${totalSec}s…` : 'Run profile'}
            </button>
          </div>

          {error && (
            <div className="flex items-start gap-2 px-3 py-2 bg-red-50 border border-red-200 rounded-lg">
              <AlertTriangle className="w-4 h-4 text-red-500 flex-shrink-0 mt-px" /><p className="text-[12px] text-red-700 min-w-0">{error}</p>
            </div>
          )}

          {report && t && (
            <div className="space-y-3">
              {/* SLA verdict */}
              {report.sla && (
                <div className={`rounded-lg border px-3 py-2.5 ${report.sla.pass ? 'bg-emerald-50 border-emerald-200' : 'bg-red-50 border-red-200'}`}>
                  <div className="flex items-center gap-2 mb-1.5">
                    {report.sla.pass ? <CheckCircle2 className="w-4 h-4 text-emerald-600" /> : <XCircle className="w-4 h-4 text-red-600" />}
                    <span className={`text-[12.5px] font-semibold ${report.sla.pass ? 'text-emerald-700' : 'text-red-700'}`}>SLA gate {report.sla.pass ? 'passed' : 'failed'}</span>
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {report.sla.checks.map((c) => (
                      <span key={c.name} className={`inline-flex items-center gap-1 px-2 py-0.5 rounded border text-[10.5px] font-mono ${c.pass ? 'text-emerald-700 bg-white border-emerald-200' : 'text-red-700 bg-white border-red-200'}`}>
                        {c.pass ? <CheckCircle2 className="w-3 h-3" /> : <XCircle className="w-3 h-3" />}{c.name} {c.actual}{c.unit} / {c.limit}{c.unit}
                      </span>
                    ))}
                  </div>
                </div>
              )}

              {/* Totals */}
              <div className="flex flex-wrap items-center gap-2 text-[11.5px]">
                <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md border bg-gray-50 border-gray-200 text-gray-700 font-mono tabular-nums">p95 {t.latency.p95}ms</span>
                <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md border bg-gray-50 border-gray-200 text-gray-700 font-mono tabular-nums">p99 {t.latency.p99}ms</span>
                <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md border bg-gray-50 border-gray-200 text-gray-700 font-mono tabular-nums">{t.throughputRps} rps</span>
                <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md border font-mono tabular-nums ${t.errorRatePct > 0 ? 'text-red-700 bg-red-50 border-red-200' : 'text-emerald-700 bg-emerald-50 border-emerald-200'}`}>{t.errorRatePct}% errors</span>
                <span className="ml-auto text-[11px] text-gray-400 tabular-nums">{t.completed} ok · {t.failed} failed · {t.non2xx} non-2xx</span>
              </div>

              {/* Per-stage */}
              <div className="border border-[#E9E5FB] rounded-lg overflow-hidden">
                <table className="w-full text-[11.5px]">
                  <thead>
                    <tr className="bg-[#FAF9FE] text-gray-500 text-left">
                      <th className="font-semibold px-2.5 py-1.5">Stage</th>
                      <th className="font-semibold px-2.5 py-1.5 text-right">conc.</th>
                      <th className="font-semibold px-2.5 py-1.5 text-right">reqs</th>
                      <th className="font-semibold px-2.5 py-1.5 text-right">p95</th>
                      <th className="font-semibold px-2.5 py-1.5 text-right">p99</th>
                      <th className="font-semibold px-2.5 py-1.5 text-right">rps</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {report.stages.map((s) => (
                      <tr key={s.index}>
                        <td className="px-2.5 py-1.5 text-gray-500">#{s.index + 1}</td>
                        <td className="px-2.5 py-1.5 text-right font-mono tabular-nums">{s.concurrency}</td>
                        <td className="px-2.5 py-1.5 text-right font-mono tabular-nums">{s.completed}{s.failed ? <span className="text-red-500"> +{s.failed}✗</span> : ''}</td>
                        <td className="px-2.5 py-1.5 text-right font-mono tabular-nums">{s.latency.p95}ms</td>
                        <td className="px-2.5 py-1.5 text-right font-mono tabular-nums">{s.latency.p99}ms</td>
                        <td className="px-2.5 py-1.5 text-right font-mono tabular-nums">{s.throughputRps}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {report.errors.length > 0 && (
                <div className="text-[11px] text-gray-500">
                  {report.errors.map((e) => <div key={e.message} className="truncate"><span className="font-mono text-red-500">{e.count}×</span> {e.message}</div>)}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
