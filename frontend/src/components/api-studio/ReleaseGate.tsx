/**
 * ReleaseGate — agentic release gate (score a finished run → go / no-go).
 *
 * A go/no-go deploy gate for a finished API run. Two areas:
 *  • Evaluate — pick a finished run, grade it against either a saved policy or
 *    inline thresholds, and get a GO / NO-GO verdict with a confidence score,
 *    a per-check breakdown, the blocking reasons and anomaly counts.
 *  • Policies — manage reusable gate policies (create / edit / delete) that the
 *    Evaluate area can then reference.
 *
 * Opt-in and standalone: it only scores an already-finished run and persists
 * reusable policies — it never executes a run or touches the pipeline.
 */
import { useEffect, useState } from 'react';
import { X, ShieldCheck, Play, Trash2, Pencil, Save, AlertTriangle, CheckCircle2, XCircle } from 'lucide-react';
import Spinner from '@/components/feedback/Spinner';
import { useToast } from '@/components/feedback/ToastProvider';
import { listGatePolicies, saveGatePolicy, deleteGatePolicy, evaluateReleaseGate, listApiRuns, type GatePolicy, type GateResult } from '@/services/api';
import { CARD, STRIP, INPUT, LABEL, PRIMARY_BTN, SECONDARY_BTN, THEAD, relativeTime } from './format';

type Tab = 'evaluate' | 'policies';

/** The tunable part of a policy — shared by the inline thresholds and the policy form. */
type Thresholds = {
  minPassRate: number;
  maxFailed: number;
  maxBroken: number;
  minConfidence: number;
  requireNoNewFailures: boolean;
  blockOnHighSeverityFail: boolean;
};

type PolicyForm = Thresholds & { name: string };

const DEFAULT_THRESHOLDS: Thresholds = {
  minPassRate: 90,
  maxFailed: 0,
  maxBroken: 0,
  minConfidence: 70,
  requireNoNewFailures: true,
  blockOnHighSeverityFail: true,
};

const BLANK_POLICY: PolicyForm = { name: '', ...DEFAULT_THRESHOLDS };

const TAB_ACTIVE = 'px-3 py-1.5 text-[12px] font-medium text-[#6D28D9] border-b-2 border-[#7C3AED]';
const TAB_INACTIVE = 'px-3 py-1.5 text-[12px] font-medium text-gray-500 hover:text-gray-700';

/** A labelled, non-negative number input — mirrors GeoLoad's SLA fields. */
function NumField({ label, value, onChange, max }: { label: string; value: number; onChange: (n: number) => void; max?: number }) {
  return (
    <label className="text-[11px] text-gray-600">{label}
      <input
        type="number"
        min={0}
        max={max}
        value={value}
        onChange={(e) => onChange(e.target.value.trim() === '' ? 0 : Math.max(0, Number(e.target.value)))}
        className={`${INPUT} py-1 mt-0.5 tabular-nums`}
      />
    </label>
  );
}

/** The four numeric thresholds + two toggles — reused by Evaluate (inline) and the policy form. */
function ThresholdFields({ value, onChange }: { value: Thresholds; onChange: (patch: Partial<Thresholds>) => void }) {
  return (
    <>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        <NumField label="min pass rate (%)" value={value.minPassRate} max={100} onChange={(n) => onChange({ minPassRate: n })} />
        <NumField label="max failed" value={value.maxFailed} onChange={(n) => onChange({ maxFailed: n })} />
        <NumField label="max broken" value={value.maxBroken} onChange={(n) => onChange({ maxBroken: n })} />
        <NumField label="min confidence" value={value.minConfidence} max={100} onChange={(n) => onChange({ minConfidence: n })} />
      </div>
      <div className="flex flex-wrap items-center gap-4">
        <label className="flex items-center gap-2 text-[11.5px] text-gray-600">
          <input type="checkbox" checked={value.requireNoNewFailures} onChange={(e) => onChange({ requireNoNewFailures: e.target.checked })} className="w-3.5 h-3.5" />
          Require no new failures
        </label>
        <label className="flex items-center gap-2 text-[11.5px] text-gray-600">
          <input type="checkbox" checked={value.blockOnHighSeverityFail} onChange={(e) => onChange({ blockOnHighSeverityFail: e.target.checked })} className="w-3.5 h-3.5" />
          Block on high-severity fail
        </label>
      </div>
    </>
  );
}

/** A small anomaly chip — amber when it has a non-zero count, muted otherwise. */
function AnomalyChip({ label, count }: { label: string; count: number }) {
  const hot = count > 0;
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded border text-[10.5px] font-mono tabular-nums ${hot ? 'text-amber-700 bg-amber-50 border-amber-200' : 'text-gray-500 bg-gray-50 border-gray-200'}`}>
      {count} {label}
    </span>
  );
}

export default function ReleaseGate({ onClose }: { onClose: () => void }) {
  const toast = useToast();
  const [tab, setTab] = useState<Tab>('evaluate');
  const [error, setError] = useState('');

  // ── Evaluate ──
  const [runs, setRuns] = useState<any[]>([]);
  const [runId, setRunId] = useState('');
  const [policies, setPolicies] = useState<GatePolicy[]>([]);
  const [policyId, setPolicyId] = useState(''); // '' → use inline thresholds
  const [thresholds, setThresholds] = useState<Thresholds>(DEFAULT_THRESHOLDS);
  const [result, setResult] = useState<GateResult | null>(null);
  const [evaluating, setEvaluating] = useState(false);

  // ── Policies ──
  const [form, setForm] = useState<PolicyForm>(BLANK_POLICY);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [savingPolicy, setSavingPolicy] = useState(false);

  useEffect(() => {
    void (async () => {
      try {
        const [runsRes, pols] = await Promise.all([listApiRuns(1, 20), listGatePolicies()]);
        const items = Array.isArray(runsRes?.items) ? runsRes.items : [];
        setRuns(items);
        if (items.length) setRunId(String(items[0].runId ?? items[0].id ?? ''));
        setPolicies(pols);
      } catch (e: any) {
        setError(e?.response?.data?.error || e?.message || 'Request failed.');
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const refreshPolicies = async () => { setPolicies(await listGatePolicies()); };

  const evaluate = async () => {
    if (!runId) return;
    setEvaluating(true); setError(''); setResult(null);
    try {
      const input: { runId: string; policyId?: string; thresholds?: Partial<GatePolicy> } = { runId };
      if (policyId) input.policyId = policyId;
      else input.thresholds = thresholds;
      setResult(await evaluateReleaseGate(input));
    } catch (e: any) {
      setError(e?.response?.data?.error || e?.message || 'Request failed.');
    } finally {
      setEvaluating(false);
    }
  };

  const savePolicy = async () => {
    if (!form.name.trim()) return;
    setSavingPolicy(true); setError('');
    try {
      await saveGatePolicy({
        id: editingId ?? undefined,
        name: form.name.trim(),
        minPassRate: form.minPassRate,
        maxFailed: form.maxFailed,
        maxBroken: form.maxBroken,
        minConfidence: form.minConfidence,
        requireNoNewFailures: form.requireNoNewFailures,
        blockOnHighSeverityFail: form.blockOnHighSeverityFail,
      });
      toast.success(editingId ? 'Policy updated' : 'Policy created');
      setForm(BLANK_POLICY); setEditingId(null);
      await refreshPolicies();
    } catch (e: any) {
      setError(e?.response?.data?.error || e?.message || 'Request failed.');
    } finally {
      setSavingPolicy(false);
    }
  };

  const editPolicy = (p: GatePolicy) => {
    setEditingId(p.id);
    setForm({
      name: p.name,
      minPassRate: p.minPassRate,
      maxFailed: p.maxFailed,
      maxBroken: p.maxBroken,
      minConfidence: p.minConfidence,
      requireNoNewFailures: p.requireNoNewFailures,
      blockOnHighSeverityFail: p.blockOnHighSeverityFail,
    });
  };

  const removePolicy = async (id: string) => {
    setError('');
    try {
      await deleteGatePolicy(id);
      toast.success('Policy deleted');
      if (editingId === id) { setEditingId(null); setForm(BLANK_POLICY); }
      if (policyId === id) setPolicyId('');
      await refreshPolicies();
    } catch (e: any) {
      setError(e?.response?.data?.error || e?.message || 'Request failed.');
    }
  };

  const switchTab = (t: Tab) => { setTab(t); setError(''); };
  const verdictIsGo = result?.decision === 'go';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-[#1E1B4B]/30 backdrop-blur-sm p-4" onClick={onClose}>
      <div className={`${CARD} w-full max-w-2xl max-h-[88vh] flex flex-col overflow-hidden`} onClick={(e) => e.stopPropagation()}>
        <div className={`flex items-center gap-2 px-4 h-12 border-b border-[#EDE9FE] flex-shrink-0 ${STRIP}`}>
          <ShieldCheck className="w-4 h-4 text-[#7C3AED]" />
          <h3 className="text-[13px] font-semibold text-gray-900">Agentic release gate</h3>
          <span className="text-[11px] text-gray-400">score a finished run → go / no-go</span>
          <button type="button" onClick={onClose} className="ml-auto p-1.5 rounded-md text-gray-400 hover:text-[#7C3AED] hover:bg-[#F5F3FF]"><X className="w-4 h-4" /></button>
        </div>

        <div className="flex items-center gap-1 px-3 border-b border-[#EDE9FE] flex-shrink-0">
          <button type="button" onClick={() => switchTab('evaluate')} className={tab === 'evaluate' ? TAB_ACTIVE : TAB_INACTIVE}>Evaluate</button>
          <button type="button" onClick={() => switchTab('policies')} className={tab === 'policies' ? TAB_ACTIVE : TAB_INACTIVE}>Policies</button>
        </div>

        <div className="p-4 space-y-3 overflow-y-auto min-h-0">
          {error && (
            <div className="flex items-start gap-2 px-3 py-2 bg-red-50 border border-red-200 rounded-lg">
              <AlertTriangle className="w-4 h-4 text-red-500 flex-shrink-0 mt-px" /><p className="text-[12px] text-red-700 min-w-0 whitespace-pre-wrap break-words">{error}</p>
            </div>
          )}

          {tab === 'evaluate' && (
            <>
              <div>
                <label className={LABEL}>Finished run</label>
                <select value={runId} onChange={(e) => { setRunId(e.target.value); setResult(null); }} className={INPUT} disabled={!runs.length}>
                  {runs.length === 0 && <option value="">No finished runs yet</option>}
                  {runs.map((r, i) => (
                    <option key={r.runId ?? r.id ?? i} value={String(r.runId ?? r.id ?? '')}>
                      {(r.title || r.runId || 'Run')} — {r.stats?.passRate ?? '–'}%
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className={LABEL}>Policy</label>
                <select value={policyId} onChange={(e) => { setPolicyId(e.target.value); setResult(null); }} className={INPUT}>
                  <option value="">Use inline thresholds</option>
                  {policies.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
              </div>

              {!policyId && (
                <div>
                  <label className={LABEL}>Inline thresholds — leave a policy unselected to grade against these</label>
                  <div className="space-y-2">
                    <ThresholdFields value={thresholds} onChange={(patch) => setThresholds((p) => ({ ...p, ...patch }))} />
                  </div>
                </div>
              )}

              <div className="flex items-center justify-end">
                <button type="button" onClick={() => void evaluate()} disabled={evaluating || !runId} className={PRIMARY_BTN}>
                  {evaluating ? <Spinner className="w-3.5 h-3.5" /> : <Play className="w-3.5 h-3.5" />}
                  {evaluating ? 'Evaluating…' : 'Evaluate gate'}
                </button>
              </div>

              {result && (
                <div className="space-y-3">
                  {/* Verdict banner */}
                  <div className={`rounded-lg border px-4 py-3 ${verdictIsGo ? 'bg-emerald-50 border-emerald-200' : 'bg-red-50 border-red-200'}`}>
                    <div className="flex items-center gap-2">
                      {verdictIsGo
                        ? <CheckCircle2 className="w-5 h-5" style={{ color: '#15803D' }} />
                        : <XCircle className="w-5 h-5" style={{ color: '#C32C2C' }} />}
                      <span className="text-[15px] font-bold" style={{ color: verdictIsGo ? '#15803D' : '#C32C2C' }}>
                        {verdictIsGo ? 'GO — safe to deploy' : 'NO-GO — blocked'}
                      </span>
                      <span className="ml-auto text-[12px] text-gray-500">
                        confidence <span className="font-bold tabular-nums" style={{ color: verdictIsGo ? '#15803D' : '#C32C2C' }}>{result.score}</span><span className="tabular-nums">/100</span>
                      </span>
                    </div>
                    {result.title && <div className="mt-1 text-[11px] text-gray-500 truncate">{result.title}</div>}
                  </div>

                  {/* Stats */}
                  {result.stats && (
                    <div className="flex flex-wrap items-center gap-2 text-[11.5px]">
                      <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md border bg-gray-50 border-gray-200 text-gray-700 font-mono tabular-nums">{result.stats.passRate}% pass</span>
                      <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md border bg-emerald-50 border-emerald-200 text-emerald-700 font-mono tabular-nums">{result.stats.passed} passed</span>
                      <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md border font-mono tabular-nums ${result.stats.failed ? 'text-red-700 bg-red-50 border-red-200' : 'text-gray-700 bg-gray-50 border-gray-200'}`}>{result.stats.failed} failed</span>
                      <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md border font-mono tabular-nums ${result.stats.broken ? 'text-amber-700 bg-amber-50 border-amber-200' : 'text-gray-700 bg-gray-50 border-gray-200'}`}>{result.stats.broken} broken</span>
                      <span className="ml-auto text-[11px] text-gray-400 tabular-nums">{result.stats.total} total</span>
                    </div>
                  )}

                  {/* Checks */}
                  {result.checks.length > 0 && (
                    <div className="border border-[#E9E5FB] rounded-lg overflow-hidden">
                      <table className="w-full text-[11.5px]">
                        <thead className={THEAD}>
                          <tr className="text-gray-500 text-left">
                            <th className="font-semibold px-2.5 py-1.5">Check</th>
                            <th className="font-semibold px-2.5 py-1.5 text-right">actual</th>
                            <th className="font-semibold px-2.5 py-1.5 text-right">threshold</th>
                            <th className="font-semibold px-2.5 py-1.5 text-right">result</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-gray-100">
                          {result.checks.map((c, i) => (
                            <tr key={i}>
                              <td className="px-2.5 py-1.5 text-gray-700">{c.label}</td>
                              <td className="px-2.5 py-1.5 text-right font-mono tabular-nums">{c.actual}</td>
                              <td className="px-2.5 py-1.5 text-right font-mono tabular-nums text-gray-500">{c.threshold}</td>
                              <td className="px-2.5 py-1.5 text-right">
                                <span className={`inline-flex items-center gap-1 font-semibold ${c.pass ? 'text-emerald-600' : 'text-red-600'}`}>
                                  {c.pass ? <CheckCircle2 className="w-3.5 h-3.5" /> : <XCircle className="w-3.5 h-3.5" />}{c.pass ? 'PASS' : 'FAIL'}
                                </span>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}

                  {/* Blocked by */}
                  {result.reasons.length > 0 && (
                    <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2">
                      <div className="flex items-center gap-1.5 mb-1">
                        <AlertTriangle className="w-3.5 h-3.5 text-red-500" />
                        <span className="text-[11.5px] font-semibold text-red-700">Blocked by</span>
                      </div>
                      <ul className="list-disc pl-5 space-y-0.5 text-[11.5px] text-red-700">
                        {result.reasons.map((r, i) => <li key={i} className="break-words">{r}</li>)}
                      </ul>
                    </div>
                  )}

                  {/* Anomalies */}
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="text-[10.5px] uppercase tracking-wide text-gray-400 mr-0.5">anomalies</span>
                    <AnomalyChip label="flaky" count={result.anomalies.flaky} />
                    <AnomalyChip label="slow" count={result.anomalies.slow} />
                    <AnomalyChip label="new failures" count={result.anomalies.newFailure} />
                  </div>
                </div>
              )}
            </>
          )}

          {tab === 'policies' && (
            <>
              {/* Existing policies */}
              <div>
                <label className={LABEL}>Saved policies</label>
                {policies.length === 0 ? (
                  <p className="text-[12px] text-gray-400">No policies yet — create one below.</p>
                ) : (
                  <div className="space-y-1.5">
                    {policies.map((p) => (
                      <div key={p.id} className="flex items-center gap-2 rounded-lg border border-[#E9E5FB] px-3 py-2 text-[11.5px]">
                        <span className="font-medium text-gray-700 truncate">{p.name}</span>
                        <span className="text-gray-400 font-mono tabular-nums truncate min-w-0">≥{p.minPassRate}% · ≤{p.maxFailed}f · ≤{p.maxBroken}b · ≥{p.minConfidence}c</span>
                        {p.updatedAt && <span className="text-gray-300 tabular-nums flex-shrink-0">{relativeTime(p.updatedAt)}</span>}
                        <div className="ml-auto flex items-center gap-1.5 flex-shrink-0">
                          <button type="button" onClick={() => editPolicy(p)} className="p-2 rounded-lg text-gray-400 hover:text-[#7C3AED] hover:bg-[#F5F3FF]" title="Edit policy"><Pencil className="w-4 h-4" /></button>
                          <button type="button" onClick={() => void removePolicy(p.id)} className="p-2 rounded-lg text-gray-400 hover:text-red-500 hover:bg-red-50" title="Delete policy"><Trash2 className="w-4 h-4" /></button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Create / edit form */}
              <div className="rounded-lg border border-[#E4E0F5] bg-[#FAF9FE] p-3 space-y-3">
                <label className={LABEL}>{editingId ? 'Edit policy' : 'New policy'}</label>
                <input value={form.name} onChange={(e) => setForm((p) => ({ ...p, name: e.target.value }))} placeholder="Policy name" className={INPUT} />
                <ThresholdFields value={form} onChange={(patch) => setForm((p) => ({ ...p, ...patch }))} />
                <div className="flex items-center justify-end gap-2">
                  {editingId && (
                    <button type="button" onClick={() => { setEditingId(null); setForm(BLANK_POLICY); }} className={SECONDARY_BTN}>Cancel</button>
                  )}
                  <button type="button" onClick={() => void savePolicy()} disabled={savingPolicy || !form.name.trim()} className={PRIMARY_BTN}>
                    {savingPolicy ? <Spinner className="w-3.5 h-3.5" /> : <Save className="w-3.5 h-3.5" />}
                    {editingId ? 'Update policy' : 'Create policy'}
                  </button>
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
