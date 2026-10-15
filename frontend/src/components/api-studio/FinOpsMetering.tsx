/**
 * FinOpsMetering — AI-cost metering for a pipeline run.
 *
 * Estimates the token spend of a generate → execute → heal run against a
 * per-model rate card and a chosen complexity / healing budget, then checks it
 * against an optional hard cap (USD and/or tokens) per run. A planning snapshot
 * so an enterprise can meter and budget LLM spend — editable rates, no live call.
 */
import { useEffect, useState } from 'react';
import { X, Wallet, Play, AlertTriangle, CheckCircle2, Ban } from 'lucide-react';
import Spinner from '@/components/feedback/Spinner';
import { listModelRates, estimateRunCost, type ModelRate, type FinOpsEstimate } from '@/services/api';
import { CARD, STRIP, INPUT, LABEL, PRIMARY_BTN } from './format';
import type { CatalogEndpoint } from './types';

export default function FinOpsMetering({ endpoints, onClose }: { endpoints: CatalogEndpoint[]; onClose: () => void }) {
  const [rates, setRates] = useState<ModelRate[]>([]);
  const [model, setModel] = useState('');
  const [complexity, setComplexity] = useState(1);
  const [iterations, setIterations] = useState(1);
  const [epCount, setEpCount] = useState(endpoints.length || 1);
  const [capUsd, setCapUsd] = useState<string>('');
  const [capTokens, setCapTokens] = useState<string>('');
  const [result, setResult] = useState<FinOpsEstimate | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    (async () => {
      try {
        const { rates: list } = await listModelRates();
        setRates(list);
        setModel(list[0]?.id || '');
      } catch (e: any) {
        setError(e?.response?.data?.error || e?.message || 'Could not load the rate card.');
      } finally { setLoading(false); }
    })();
  }, []);

  const run = async () => {
    setBusy(true); setError(''); setResult(null);
    try {
      setResult(await estimateRunCost({
        model, endpoints: epCount, complexity, iterations,
        capUsd: capUsd.trim() === '' ? null : Number(capUsd),
        capTokens: capTokens.trim() === '' ? null : Number(capTokens),
      }));
    } catch (e: any) {
      setError(e?.response?.data?.error || e?.message || 'Estimate failed.');
    } finally { setBusy(false); }
  };

  const verdictChip = (v: FinOpsEstimate['verdict']) => {
    if (v === 'within-budget') return { cls: 'text-emerald-700 bg-emerald-50 border-emerald-200', Icon: CheckCircle2, label: 'Within budget' };
    if (v === 'over-budget') return { cls: 'text-red-700 bg-red-50 border-red-200', Icon: Ban, label: 'Over budget — would be capped' };
    return { cls: 'text-amber-700 bg-amber-50 border-amber-200', Icon: AlertTriangle, label: 'Uncapped — no spend gate' };
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-[#1E1B4B]/45 backdrop-blur-md p-4" onClick={onClose}>
      <div className={`${CARD} w-full max-w-3xl max-h-[88vh] flex flex-col overflow-hidden`} onClick={(e) => e.stopPropagation()}>
        <div className={`flex items-center gap-2 px-4 h-12 border-b border-[#EDE9FE] flex-shrink-0 ${STRIP}`}>
          <Wallet className="w-4 h-4 text-[#7C3AED]" />
          <h3 className="text-[13px] font-semibold text-gray-900">AI cost / FinOps metering</h3>
          <span className="text-[11px] text-gray-400">estimate &amp; cap token spend per run</span>
          <button type="button" onClick={onClose} className="ml-auto p-1.5 rounded-md text-gray-400 hover:text-[#7C3AED] hover:bg-[#F5F3FF]"><X className="w-4 h-4" /></button>
        </div>

        <div className="p-4 space-y-3 overflow-y-auto min-h-0">
          {error && (
            <div className="flex items-start gap-2 px-3 py-2 bg-red-50 border border-red-200 rounded-lg">
              <AlertTriangle className="w-4 h-4 text-red-500 flex-shrink-0 mt-px" /><p className="text-[12px] text-red-700 min-w-0 whitespace-pre-wrap break-words">{error}</p>
            </div>
          )}

          {loading ? (
            <div className="flex items-center justify-center py-8 text-gray-400"><Spinner className="w-5 h-5 animate-spin" /></div>
          ) : (
            <>
              <div className="grid grid-cols-2 gap-3">
                <div className="col-span-2">
                  <label className={LABEL}>Model</label>
                  <select value={model} onChange={(e) => { setModel(e.target.value); setResult(null); }} className={INPUT}>
                    {rates.map((r) => <option key={r.id} value={r.id}>{r.label} — ${r.inputPerM}/${r.outputPerM} per 1M in/out</option>)}
                  </select>
                </div>
                <div>
                  <label className={LABEL}>Endpoints in the run</label>
                  <input type="number" min={0} max={5000} value={epCount} onChange={(e) => setEpCount(Math.max(0, Number(e.target.value) || 0))} className={INPUT} />
                </div>
                <div>
                  <label className={LABEL}>Healing passes</label>
                  <input type="number" min={1} max={10} value={iterations} onChange={(e) => setIterations(Math.max(1, Number(e.target.value) || 1))} className={INPUT} />
                </div>
                <div className="col-span-2">
                  <label className={LABEL}>Thoroughness — {complexity.toFixed(2)}×</label>
                  <input type="range" min={0.5} max={2} step={0.25} value={complexity} onChange={(e) => setComplexity(Number(e.target.value))} className="w-full accent-[#7C3AED]" />
                  <div className="flex justify-between text-[10px] text-gray-400"><span>lean</span><span>standard</span><span>thorough</span></div>
                </div>
                <div>
                  <label className={LABEL}>Cap — USD / run (optional)</label>
                  <input type="number" min={0} step="0.01" placeholder="no cap" value={capUsd} onChange={(e) => setCapUsd(e.target.value)} className={INPUT} />
                </div>
                <div>
                  <label className={LABEL}>Cap — tokens / run (optional)</label>
                  <input type="number" min={0} placeholder="no cap" value={capTokens} onChange={(e) => setCapTokens(e.target.value)} className={INPUT} />
                </div>
              </div>

              <div className="flex items-center justify-end gap-2">
                {busy && <span className="text-[11px] text-gray-400">estimating…</span>}
                <button type="button" onClick={() => void run()} disabled={busy || !model} className={PRIMARY_BTN}>
                  {busy ? <Spinner className="w-3.5 h-3.5 animate-spin" /> : <Play className="w-3.5 h-3.5" />}
                  {busy ? 'Estimating…' : 'Estimate run cost'}
                </button>
              </div>

              {result && (() => { const v = verdictChip(result.verdict); return (
                <div className="space-y-3">
                  <div className="flex flex-wrap items-center gap-3">
                    <div className="flex flex-col">
                      <span className="text-2xl font-bold text-gray-900 tabular-nums">${result.costUsd.toFixed(2)}</span>
                      <span className="text-[11px] text-gray-400 tabular-nums">{result.totalTokens.toLocaleString()} tokens · {result.model.label}</span>
                    </div>
                    <span className={`ml-auto inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg border text-[11.5px] font-medium ${v.cls}`}>
                      <v.Icon className="w-3.5 h-3.5" />{v.label}
                    </span>
                  </div>

                  {(result.cap.usd != null || result.cap.tokens != null) && (
                    <div className="flex flex-wrap gap-2 text-[11px]">
                      {result.cap.usd != null && <span className="px-2 py-0.5 rounded border border-gray-200 bg-gray-50 text-gray-600 tabular-nums">cap ${result.cap.usd.toFixed(2)} · {result.within ? `$${(result.remaining.usd ?? 0).toFixed(2)} left` : `$${result.overspend.usd.toFixed(2)} over`}</span>}
                      {result.cap.tokens != null && <span className="px-2 py-0.5 rounded border border-gray-200 bg-gray-50 text-gray-600 tabular-nums">cap {result.cap.tokens.toLocaleString()} tok · {result.within ? `${(result.remaining.tokens ?? 0).toLocaleString()} left` : `${result.overspend.tokens.toLocaleString()} over`}</span>}
                    </div>
                  )}

                  <div className="overflow-hidden rounded-lg border border-[#E9E5FB]">
                    <table className="w-full text-[11.5px]">
                      <thead className="bg-gray-50 text-gray-500">
                        <tr><th className="text-left font-medium px-3 py-1.5">Stage</th><th className="text-right font-medium px-3 py-1.5">Input</th><th className="text-right font-medium px-3 py-1.5">Output</th><th className="text-right font-medium px-3 py-1.5">Cost</th></tr>
                      </thead>
                      <tbody>
                        {result.stages.map((s) => (
                          <tr key={s.id} className="border-t border-gray-100">
                            <td className="px-3 py-1.5 text-gray-700">{s.label}</td>
                            <td className="px-3 py-1.5 text-right tabular-nums text-gray-500">{s.inputTokens.toLocaleString()}</td>
                            <td className="px-3 py-1.5 text-right tabular-nums text-gray-500">{s.outputTokens.toLocaleString()}</td>
                            <td className="px-3 py-1.5 text-right tabular-nums text-gray-700">${s.costUsd.toFixed(4)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>

                  {result.notes.length > 0 && (
                    <ul className="space-y-1">
                      {result.notes.map((n, i) => <li key={i} className="text-[11px] text-gray-500 flex gap-1.5"><span className="text-[#7C3AED]">•</span><span className="min-w-0">{n}</span></li>)}
                    </ul>
                  )}
                </div>
              ); })()}

              <p className="text-[10px] text-gray-400">Estimates from an editable rate card — list prices drift; confirm your contract rate.</p>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
