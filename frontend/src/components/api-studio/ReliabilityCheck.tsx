/**
 * ReliabilityCheck — run a saved flow N times and MEASURE determinism.
 *
 * Turns "deterministic execution" from a claim into a number: the flake rate
 * (how many runs disagreed), which steps are unstable, and the latency spread.
 * A clean 0% here is the proof a buyer or a CI gate actually trusts.
 *
 * Opt-in and standalone — it drives the existing flow runner, nothing else.
 */
import { useEffect, useState } from 'react';
import { X, Repeat, AlertTriangle, CheckCircle2, Activity, Gauge } from 'lucide-react';
import Spinner from '@/components/feedback/Spinner';
import { listApiFlows, runFlowReliability, type SavedApiFlow, type ReliabilityReport } from '@/services/api';
import { CARD, STRIP, INPUT, LABEL, PRIMARY_BTN, THEAD } from './format';

export default function ReliabilityCheck({ onClose }: { onClose: () => void }) {
  const [flows, setFlows] = useState<SavedApiFlow[]>([]);
  const [flowId, setFlowId] = useState('');
  const [runs, setRuns] = useState(5);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [report, setReport] = useState<ReliabilityReport | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const { flows: list } = await listApiFlows();
        setFlows(list);
        if (list.length) setFlowId(list[0].id);
      } catch (err: any) {
        setError(err?.response?.data?.error || 'Could not load flows.');
      } finally { setLoading(false); }
    })();
  }, []);

  const run = async () => {
    if (!flowId) return;
    setBusy(true); setError(''); setReport(null);
    try {
      const { report: r } = await runFlowReliability({ flowId, runs });
      setReport(r);
    } catch (err: any) {
      setError(err?.response?.data?.error || err?.message || 'Benchmark failed.');
    } finally { setBusy(false); }
  };

  const pct = (n: number) => `${Math.round(n * 100)}%`;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-[#1E1B4B]/45 backdrop-blur-md p-4" onClick={onClose}>
      <div className={`${CARD} w-full max-w-2xl max-h-[88vh] flex flex-col overflow-hidden`} onClick={(e) => e.stopPropagation()}>
        <div className={`flex items-center gap-2 px-4 h-12 border-b border-[#EDE9FE] flex-shrink-0 ${STRIP}`}>
          <Gauge className="w-4 h-4 text-[#7C3AED]" />
          <h3 className="text-[13px] font-semibold text-gray-900">Reliability benchmark</h3>
          <span className="text-[11px] text-gray-400">run N times · measure flake</span>
          <button type="button" onClick={onClose} className="ml-auto p-1.5 rounded-md text-gray-400 hover:text-[#7C3AED] hover:bg-[#F5F3FF]"><X className="w-4 h-4" /></button>
        </div>

        <div className="p-4 space-y-3 overflow-y-auto min-h-0">
          {loading ? (
            <div className="flex items-center justify-center py-10 text-gray-400"><Spinner className="w-5 h-5 animate-spin" /></div>
          ) : !flows.length ? (
            <div className="text-center py-8 text-[12.5px] text-gray-600">No saved flows yet. Build one (e.g. from Traffic capture → “Build runnable flow”), then benchmark it here.</div>
          ) : (
            <>
              <div className="flex items-end gap-2">
                <div className="flex-1 min-w-0">
                  <label className={LABEL}>Flow</label>
                  <select value={flowId} onChange={(e) => setFlowId(e.target.value)} className={INPUT}>
                    {flows.map((f) => <option key={f.id} value={f.id}>{f.name} · {f.steps.length} step{f.steps.length === 1 ? '' : 's'}</option>)}
                  </select>
                </div>
                <div className="w-24">
                  <label className={LABEL}>Runs</label>
                  <input type="number" min={2} max={20} value={runs} onChange={(e) => setRuns(Math.max(2, Math.min(20, Number(e.target.value) || 5)))} className={INPUT} />
                </div>
                <button type="button" onClick={() => void run()} disabled={busy} className={PRIMARY_BTN}>
                  {busy ? <Spinner className="w-3.5 h-3.5 animate-spin" /> : <Repeat className="w-3.5 h-3.5" />}
                  Run
                </button>
              </div>
              <p className="text-[11px] text-gray-400">Writes are disabled for the benchmark, so repeated runs don’t create duplicate data.</p>

              {report && (
                <div className="space-y-3">
                  {/* Verdict banner */}
                  <div className={`flex items-start gap-2 px-3 py-2.5 rounded-lg border ${report.deterministic && report.passedRuns === report.runs ? 'bg-emerald-50 border-emerald-200' : report.deterministic ? 'bg-amber-50 border-amber-200' : 'bg-red-50 border-red-200'}`}>
                    {report.deterministic && report.passedRuns === report.runs
                      ? <CheckCircle2 className="w-4 h-4 text-emerald-600 flex-shrink-0 mt-px" />
                      : <AlertTriangle className={`w-4 h-4 flex-shrink-0 mt-px ${report.deterministic ? 'text-amber-500' : 'text-red-500'}`} />}
                    <p className="text-[12.5px] text-gray-800 min-w-0">{report.verdict}</p>
                  </div>

                  {/* Stat tiles */}
                  <div className="grid grid-cols-4 gap-2">
                    {[
                      { k: 'Runs', v: String(report.runs) },
                      { k: 'Passed', v: `${report.passedRuns}/${report.runs}` },
                      { k: 'Flake rate', v: pct(report.flakeRate) },
                      { k: 'Avg latency', v: report.latency ? `${report.latency.avgMs}ms` : '—' },
                    ].map((t) => (
                      <div key={t.k} className="px-3 py-2 rounded-lg bg-[#F5F3FF] border border-[#E4E0F5]">
                        <div className="text-[10px] font-semibold uppercase tracking-wide text-gray-500">{t.k}</div>
                        <div className="text-[15px] font-bold text-gray-900 tabular-nums">{t.v}</div>
                      </div>
                    ))}
                  </div>

                  {/* Per-step reliability */}
                  <div>
                    <label className={LABEL}>Per-step pass rate</label>
                    <div className="border border-[#E9E5FB] rounded-lg overflow-hidden">
                      <table className="w-full text-[11.5px]">
                        <thead className={THEAD}><tr>
                          <th className="text-left px-2.5 py-1.5 font-semibold text-gray-600">Step</th>
                          <th className="text-right px-2.5 py-1.5 font-semibold text-gray-600">Pass rate</th>
                          <th className="text-right px-2.5 py-1.5 font-semibold text-gray-600">Stable</th>
                        </tr></thead>
                        <tbody className="divide-y divide-gray-100">
                          {report.steps.map((s) => (
                            <tr key={s.name} className={s.flaky ? 'bg-red-50/50' : ''}>
                              <td className="px-2.5 py-1.5 text-gray-700 truncate max-w-[300px]" title={s.name}>{s.name}</td>
                              <td className="px-2.5 py-1.5 text-right tabular-nums text-gray-800">{pct(s.passRate)} <span className="text-gray-400">({s.passes}/{s.runs})</span></td>
                              <td className="px-2.5 py-1.5 text-right">{s.flaky ? <span className="text-red-500 font-medium">flaky</span> : <span className="text-emerald-600">✓</span>}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>

                  {report.latency && (
                    <div className="flex items-center gap-1.5 text-[11px] text-gray-500">
                      <Activity className="w-3.5 h-3.5" />
                      Latency {report.latency.minMs}–{report.latency.maxMs}ms across {report.runs} runs (avg {report.latency.avgMs}ms).
                    </div>
                  )}
                </div>
              )}

              {error && (
                <div className="flex items-start gap-2 px-3 py-2 bg-red-50 border border-red-200 rounded-lg">
                  <AlertTriangle className="w-4 h-4 text-red-500 flex-shrink-0 mt-px" /><p className="text-[12px] text-red-700 min-w-0">{error}</p>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
