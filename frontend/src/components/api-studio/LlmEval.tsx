/**
 * LlmEval — LLM / AI-endpoint eval harness (Promptfoo / DeepEval parity).
 *
 * Opt-in and standalone. Build a dataset of prompts (input + optional expected),
 * point it at an AI endpoint, pick metrics (status, contains, regex, json-has,
 * latency, and an LLM-judge "semantic" metric), and run — the harness scores
 * each row, grades the suite, and keeps a pass-rate history so you can catch
 * regressions. Datasets persist per tenant. Nothing here touches the
 * generate → execute → heal pipeline.
 */
import { useEffect, useState } from 'react';
import { X, FlaskConical, Plus, Trash2, Play, AlertTriangle, CheckCircle2, XCircle } from 'lucide-react';
import Spinner from '@/components/feedback/Spinner';
import { useToast } from '@/components/feedback/ToastProvider';
import {
  listEvalMetrics, listEvalDatasets, saveEvalDataset, deleteEvalDataset, runEval,
  type EvalMetricDef, type EvalMetricId, type EvalDataset, type EvalRunSummary, type EvalRow,
} from '@/services/api';
import { CARD, STRIP, INPUT, LABEL, PRIMARY_BTN, SECONDARY_BTN } from './format';

const GRADE_COLOR: Record<string, string> = { A: '#059669', B: '#65A30D', C: '#D97706', D: '#EA580C', F: '#DC2626' };
const METHODS = ['POST', 'GET', 'PUT', 'PATCH'];

export default function LlmEval({ onClose }: { onClose: () => void }) {
  const toast = useToast();
  const [metrics, setMetrics] = useState<EvalMetricDef[]>([]);
  const [datasets, setDatasets] = useState<EvalDataset[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  // create form
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [method, setMethod] = useState('POST');
  const [bodyTemplate, setBodyTemplate] = useState('{"input":"{{input}}"}');
  const [rows, setRows] = useState<EvalRow[]>([{ input: '', expected: '' }]);
  const [picked, setPicked] = useState<Set<EvalMetricId>>(new Set(['status', 'non-empty']));

  // run results
  const [running, setRunning] = useState<string | null>(null);
  const [result, setResult] = useState<EvalRunSummary | null>(null);

  const refresh = async () => { setDatasets(await listEvalDatasets()); };

  useEffect(() => {
    (async () => {
      try { const [m] = await Promise.all([listEvalMetrics(), refresh()]); setMetrics(m); }
      catch (err: any) { setError(err?.response?.data?.error || err?.message || 'Could not load eval data.'); }
      finally { setLoading(false); }
    })();
  }, []);

  const toggleMetric = (id: EvalMetricId) => {
    setPicked((prev) => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });
  };

  const create = async () => {
    if (!/^https?:\/\//i.test(url.trim())) { setError('The dataset target needs an absolute http(s) URL.'); return; }
    const cleanRows = rows.map((r) => ({ input: r.input.trim(), expected: (r.expected || '').trim() || undefined })).filter((r) => r.input);
    if (!cleanRows.length) { setError('Add at least one row with an input prompt.'); return; }
    if (picked.size === 0) { setError('Pick at least one metric.'); return; }
    setBusy(true); setError('');
    try {
      await saveEvalDataset({
        name: name.trim() || 'Dataset',
        target: { url: url.trim(), method, bodyTemplate },
        rows: cleanRows,
        metrics: Array.from(picked),
      });
      setName(''); setUrl(''); setRows([{ input: '', expected: '' }]);
      await refresh();
      toast.success('Dataset saved', `${cleanRows.length} row${cleanRows.length === 1 ? '' : 's'} · ${picked.size} metric${picked.size === 1 ? '' : 's'}`);
    } catch (err: any) {
      setError(err?.response?.data?.error || err?.message || 'Could not save dataset.');
    } finally { setBusy(false); }
  };

  const run = async (ds: EvalDataset) => {
    setRunning(ds.id); setResult(null); setError('');
    try {
      const summary = await runEval({ datasetId: ds.id });
      setResult(summary);
      toast.success('Eval complete', `${summary.passRate}% pass · grade ${summary.grade}`);
    } catch (err: any) {
      setError(err?.response?.data?.error || err?.message || 'Eval run failed.');
    } finally { setRunning(null); }
  };

  const remove = async (ds: EvalDataset) => {
    setBusy(true);
    try { await deleteEvalDataset(ds.id); if (result?.datasetId === ds.id) setResult(null); await refresh(); }
    catch (err: any) { setError(err?.response?.data?.error || err?.message || 'Delete failed.'); }
    finally { setBusy(false); }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-[#1E1B4B]/45 backdrop-blur-md p-4" onClick={onClose}>
      <div className={`${CARD} w-full max-w-2xl max-h-[90vh] flex flex-col overflow-hidden`} onClick={(e) => e.stopPropagation()}>
        <div className={`flex items-center gap-2 px-4 h-12 border-b border-[#EDE9FE] flex-shrink-0 ${STRIP}`}>
          <FlaskConical className="w-4 h-4 text-[#7C3AED]" />
          <h3 className="text-[13px] font-semibold text-gray-900">LLM eval harness</h3>
          <span className="text-[11px] text-gray-400">score AI endpoints against a prompt dataset</span>
          <button type="button" onClick={onClose} className="ml-auto p-1.5 rounded-md text-gray-400 hover:text-[#7C3AED] hover:bg-[#F5F3FF]"><X className="w-4 h-4" /></button>
        </div>

        <div className="p-4 space-y-3 overflow-y-auto min-h-0">
          {/* Create dataset */}
          <div className="rounded-lg border border-[#E4E0F5] bg-[#FAF9FE] p-3 space-y-2">
            <label className={LABEL}>New dataset</label>
            <div className="grid grid-cols-[1fr_auto] gap-2">
              <input value={name} onChange={(e) => { setName(e.target.value); setError(''); }} placeholder="Dataset name" className={INPUT} />
              <select value={method} onChange={(e) => setMethod(e.target.value)} className={INPUT.replace('w-full', 'w-24')}>
                {METHODS.map((m) => <option key={m} value={m}>{m}</option>)}
              </select>
            </div>
            <input value={url} onChange={(e) => { setUrl(e.target.value); setError(''); }} placeholder="https://your-ai-endpoint/chat" className={INPUT} />
            {method !== 'GET' && (
              <div>
                <label className={LABEL}>Request body template · <code className="text-[#6D28D9]">{'{{input}}'}</code> is substituted per row</label>
                <textarea value={bodyTemplate} onChange={(e) => setBodyTemplate(e.target.value)} rows={2} className={`${INPUT} font-mono text-[11px] resize-y`} />
              </div>
            )}

            {/* rows */}
            <div>
              <label className={LABEL}>Rows · input prompt + optional expected</label>
              <div className="space-y-1.5">
                {rows.map((r, i) => (
                  <div key={i} className="flex items-center gap-1.5">
                    <input value={r.input} onChange={(e) => setRows((p) => p.map((x, j) => j === i ? { ...x, input: e.target.value } : x))} placeholder="input prompt" className={`${INPUT} flex-1`} />
                    <input value={r.expected || ''} onChange={(e) => setRows((p) => p.map((x, j) => j === i ? { ...x, expected: e.target.value } : x))} placeholder="expected (optional)" className={`${INPUT} flex-1`} />
                    <button type="button" onClick={() => setRows((p) => p.length > 1 ? p.filter((_, j) => j !== i) : p)} className="p-1 rounded text-gray-400 hover:text-red-500 hover:bg-red-50 flex-shrink-0" title="Remove row"><Trash2 className="w-3.5 h-3.5" /></button>
                  </div>
                ))}
              </div>
              <button type="button" onClick={() => setRows((p) => [...p, { input: '', expected: '' }])} className="mt-1.5 inline-flex items-center gap-1 text-[11px] font-medium text-[#7C3AED] hover:underline"><Plus className="w-3 h-3" />Add row</button>
            </div>

            {/* metrics */}
            <div>
              <label className={LABEL}>Metrics</label>
              <div className="flex flex-wrap gap-1.5">
                {metrics.map((m) => (
                  <button key={m.id} type="button" onClick={() => toggleMetric(m.id)}
                    className={`px-2 py-1 text-[11px] font-medium rounded-md border transition-colors ${picked.has(m.id) ? 'bg-[#7C3AED] text-white border-transparent' : 'bg-white text-gray-600 border-gray-200 hover:border-[#C4B5FD]'}`}
                    title={m.needsExpected ? 'Needs an expected value per row' : ''}>
                    {m.label}{m.needsExpected ? ' *' : ''}
                  </button>
                ))}
              </div>
              <p className="text-[10px] text-gray-400 mt-1">* metric compares against each row’s expected value. “Semantic” uses the tenant LLM as a judge.</p>
            </div>

            <div className="flex justify-end">
              <button type="button" onClick={() => void create()} disabled={busy} className={PRIMARY_BTN}>
                {busy ? <Spinner className="w-3.5 h-3.5 animate-spin" /> : <Plus className="w-3.5 h-3.5" />}Save dataset
              </button>
            </div>
          </div>

          {error && (
            <div className="flex items-start gap-2 px-3 py-2 bg-red-50 border border-red-200 rounded-lg">
              <AlertTriangle className="w-4 h-4 text-red-500 flex-shrink-0 mt-px" /><p className="text-[12px] text-red-700 min-w-0">{error}</p>
            </div>
          )}

          {/* datasets */}
          {loading ? (
            <div className="flex items-center justify-center py-8 text-gray-400"><Spinner className="w-5 h-5 animate-spin" /></div>
          ) : datasets.length === 0 ? (
            <div className="text-center py-6 text-[12px] text-gray-400">No datasets yet — build one above.</div>
          ) : (
            <div className="space-y-2">
              {datasets.map((ds) => (
                <div key={ds.id} className="border border-[#E9E5FB] rounded-lg p-3">
                  <div className="flex items-center gap-2">
                    <span className="text-[12.5px] font-semibold text-gray-800 truncate">{ds.name}</span>
                    <span className="text-[10.5px] text-gray-400 truncate">{ds.rows.length} row{ds.rows.length === 1 ? '' : 's'} · {ds.metrics.length} metric{ds.metrics.length === 1 ? '' : 's'} · {ds.target.method} {ds.target.url}</span>
                    <div className="ml-auto flex items-center gap-1 flex-shrink-0">
                      <button type="button" onClick={() => void run(ds)} disabled={running !== null || busy} className={SECONDARY_BTN}>
                        {running === ds.id ? <Spinner className="w-3.5 h-3.5 animate-spin" /> : <Play className="w-3.5 h-3.5" />}Run
                      </button>
                      <button type="button" onClick={() => void remove(ds)} disabled={busy || running !== null} className="p-1 rounded text-gray-400 hover:text-red-500 hover:bg-red-50" title="Delete dataset"><Trash2 className="w-3.5 h-3.5" /></button>
                    </div>
                  </div>

                  {result && result.datasetId === ds.id && (
                    <div className="mt-2 border-t border-[#EDE9FE] pt-2">
                      <div className="flex items-center gap-3 mb-2">
                        <span className="inline-flex items-center justify-center w-8 h-8 rounded-lg text-white text-[15px] font-bold" style={{ background: GRADE_COLOR[result.grade] }}>{result.grade}</span>
                        <div className="text-[11px] text-gray-600">
                          <div><b className="text-gray-900">{result.passRate}%</b> pass · score {result.score}/100</div>
                          <div className="text-gray-400">{result.rowsRun} row{result.rowsRun === 1 ? '' : 's'} · avg {result.avgLatencyMs}ms</div>
                        </div>
                        <div className="ml-auto flex flex-wrap gap-1 justify-end max-w-[55%]">
                          {result.perMetric.map((pm) => (
                            <span key={pm.metric} className="text-[10px] px-1.5 py-0.5 rounded bg-gray-50 border border-gray-200 text-gray-600">{pm.metric} {pm.passRate}%</span>
                          ))}
                        </div>
                      </div>
                      <div className="space-y-1 max-h-44 overflow-y-auto">
                        {result.rows.map((r, i) => (
                          <div key={i} className="flex items-start gap-1.5 text-[11px]">
                            {r.passed ? <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500 flex-shrink-0 mt-px" /> : <XCircle className="w-3.5 h-3.5 text-red-500 flex-shrink-0 mt-px" />}
                            <span className="font-mono text-gray-600 truncate flex-1 min-w-0" title={r.input}>{r.input}</span>
                            <span className="text-gray-400 flex-shrink-0">{r.status ?? '—'} · {r.latencyMs}ms</span>
                          </div>
                        ))}
                      </div>
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
