/**
 * SemanticHeal — intent-aware self-healing proposals for failing API tests.
 *
 * The engineer lists the failing cases (method, url, the status they expected
 * and the error/assertion that fired); the orchestrator classifies each one —
 * a real regression, a benign contract evolution, flakiness, an environment or
 * auth blip — and proposes a fix with a confidence and a plain rationale. It is
 * advisory only: nothing here mutates a test. Write requests are never re-fired
 * unless the engineer explicitly opts in.
 */
import { useState } from 'react';
import { HeartPulse, X, AlertTriangle, Plus, Wand2 } from 'lucide-react';
import Spinner from '@/components/feedback/Spinner';
import { useToast } from '@/components/feedback/ToastProvider';
import { CARD, STRIP, INPUT, FIELD, LABEL, PRIMARY_BTN, SECONDARY_BTN } from './format';
import { MethodBadge, StatusCode } from './primitives';
import type { CatalogEndpoint } from './types';
import { proposeHeal, type HealResult, type HealProposal } from '@/services/api';

const CHIP = 'inline-flex items-center px-1.5 py-0.5 rounded border text-[10px] font-medium';
const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];

/** One failing case the engineer wants healed — strings so the inputs stay controlled. */
type FailingCase = { method: string; url: string; expectedStatus: string; error: string };

const emptyCase = (): FailingCase => ({ method: 'GET', url: '', expectedStatus: '', error: '' });

/** Map a classification or confidence into the app's standard chip tone. */
function toneClass(key: string): string {
  const k = (key || '').toLowerCase();
  if (k === 'regression' || k === 'critical') return 'text-red-700 bg-red-50 border-red-200';
  if (k === 'contract-evolution' || k === 'healthy') return 'text-emerald-700 bg-emerald-50 border-emerald-200';
  if (k === 'flaky' || k === 'warning' || k === 'high') return 'text-amber-700 bg-amber-50 border-amber-200';
  if (k === 'environment' || k === 'auth' || k === 'info' || k === 'medium') return 'text-blue-700 bg-blue-50 border-blue-200';
  return 'text-gray-600 bg-gray-50 border-gray-200';
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

export default function SemanticHeal({ endpoints, onClose }: { endpoints: CatalogEndpoint[]; onClose: () => void }) {
  const toast = useToast();
  const [cases, setCases] = useState<FailingCase[]>([emptyCase()]);
  const [allowWrites, setAllowWrites] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<HealResult | null>(null);

  const updateCase = (i: number, patch: Partial<FailingCase>) =>
    setCases((cs) => cs.map((c, idx) => (idx === i ? { ...c, ...patch } : c)));
  const addCase = () => setCases((cs) => [...cs, emptyCase()]);
  const removeCase = (i: number) => setCases((cs) => (cs.length === 1 ? [emptyCase()] : cs.filter((_, idx) => idx !== i)));

  const prefill = () => {
    const rows = endpoints.slice(0, 5).map((e) => ({ method: e.method, url: e.url, expectedStatus: '', error: '' }));
    if (!rows.length) { toast.error('No catalogue endpoints to prefill from.'); return; }
    setCases(rows);
  };

  const propose = async () => {
    setLoading(true); setError(''); setResult(null);
    try {
      const res = await proposeHeal({
        failures: cases.filter((c) => c.url.trim()).map((c) => ({
          method: c.method,
          url: c.url.trim(),
          error: c.error,
          expectedStatus: c.expectedStatus ? Number(c.expectedStatus) : undefined,
        })),
        allowWrites,
      });
      setResult(res);
      toast.success(`${res.proposals.length} proposal${res.proposals.length === 1 ? '' : 's'}`);
    } catch (err: any) {
      setError(err?.response?.data?.error || err?.message || 'Could not propose fixes.');
    } finally {
      setLoading(false);
    }
  };

  const canPropose = !loading && cases.some((c) => c.url.trim());

  const stats = result ? [
    { label: 'analyzed', value: result.summary.analyzed, tone: 'text-gray-600 bg-gray-50 border-gray-200' },
    { label: 'healable', value: result.summary.healable, tone: 'text-emerald-700 bg-emerald-50 border-emerald-200' },
    { label: 'regressions', value: result.summary.regressions, tone: 'text-red-700 bg-red-50 border-red-200' },
    { label: 'flaky', value: result.summary.flaky, tone: 'text-amber-700 bg-amber-50 border-amber-200' },
    { label: 'skipped', value: result.summary.skipped, tone: 'text-gray-600 bg-gray-50 border-gray-200' },
  ] : [];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-[#1E1B4B]/30 backdrop-blur-sm p-4" onClick={onClose}>
      <div className={`${CARD} w-full max-w-2xl max-h-[85vh] flex flex-col overflow-hidden`} onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className={`flex items-center gap-2 px-4 h-12 border-b border-[#EDE9FE] flex-shrink-0 ${STRIP}`}>
          <HeartPulse className="w-4 h-4 text-[#7C3AED]" />
          <h3 className="text-[13px] font-semibold text-gray-900">Semantic self-healing</h3>
          <span className="text-[11px] text-gray-400">Intent-aware fix proposals for failing tests</span>
          <button type="button" onClick={onClose} className="ml-auto p-1.5 rounded-md text-gray-400 hover:text-[#7C3AED] hover:bg-[#F5F3FF]"><X className="w-4 h-4" /></button>
        </div>

        {/* Body */}
        <div className="flex-1 min-h-0 overflow-y-auto p-4 space-y-4">
          {error && (
            <div className="flex items-start gap-2 px-3 py-2 bg-red-50 border border-red-200 rounded-lg">
              <AlertTriangle className="w-4 h-4 text-red-500 flex-shrink-0 mt-px" />
              <p className="text-[12px] text-red-700 min-w-0 whitespace-pre-wrap break-words">{error}</p>
            </div>
          )}

          {/* Failing cases editor */}
          <div className="space-y-2">
            <label className={LABEL}>Failing cases</label>
            {cases.map((c, i) => (
              <div key={i} className="rounded-lg border border-[#E4E0F5] bg-[#FAF9FE] p-3 space-y-2">
                <div className="flex items-center gap-2">
                  <select
                    value={c.method}
                    onChange={(e) => updateCase(i, { method: e.target.value })}
                    className={`${FIELD} w-24`}
                  >
                    {METHODS.map((m) => <option key={m} value={m}>{m}</option>)}
                  </select>
                  <input
                    value={c.url}
                    onChange={(e) => updateCase(i, { url: e.target.value })}
                    list="heal-urls"
                    placeholder="https://api.example.com/path"
                    className={INPUT}
                  />
                  <input
                    type="number"
                    value={c.expectedStatus}
                    onChange={(e) => updateCase(i, { expectedStatus: e.target.value })}
                    placeholder="200"
                    className={`${FIELD} w-20 flex-shrink-0`}
                  />
                  <button
                    type="button"
                    onClick={() => removeCase(i)}
                    aria-label="Remove case"
                    className="p-1.5 rounded-md text-gray-400 hover:text-red-500 hover:bg-red-50 flex-shrink-0"
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                </div>
                <textarea
                  value={c.error}
                  onChange={(e) => updateCase(i, { error: e.target.value })}
                  placeholder="Error or failed assertion — e.g. expected 200 but got 404"
                  className={`${INPUT} min-h-[52px] resize-y`}
                />
              </div>
            ))}
            <datalist id="heal-urls">
              {endpoints.map((e) => <option key={e.id} value={e.url} />)}
            </datalist>
            <div className="flex items-center gap-2">
              <button type="button" onClick={addCase} className={SECONDARY_BTN}><Plus className="w-3.5 h-3.5" />Add case</button>
              <button type="button" onClick={prefill} className={SECONDARY_BTN}><Wand2 className="w-3.5 h-3.5" />Prefill from catalogue</button>
            </div>
          </div>

          {/* Live writes opt-in */}
          <div className="rounded-lg border border-[#E4E0F5] bg-[#FAF9FE] p-3 space-y-1">
            <label className="flex items-center gap-2 text-[12px] text-gray-700">
              <input type="checkbox" checked={allowWrites} onChange={(e) => setAllowWrites(e.target.checked)} className="w-3.5 h-3.5" />
              <span className="font-medium">Re-run write requests live (may change data)</span>
            </label>
            <p className="text-[10.5px] text-gray-400">Write requests (POST/PUT/PATCH/DELETE) are not re-fired unless this is on.</p>
          </div>

          <div className="flex justify-end">
            <button type="button" onClick={() => void propose()} disabled={!canPropose} className={PRIMARY_BTN}>
              {loading ? <Spinner className="w-3.5 h-3.5 animate-spin" /> : <HeartPulse className="w-3.5 h-3.5" />}Propose fixes
            </button>
          </div>

          {/* Results */}
          {result && (
            <div className="space-y-3">
              <div className="flex flex-wrap gap-2">
                {stats.map((s) => (
                  <span key={s.label} className={`${CHIP} ${s.tone}`}>
                    <span className="font-semibold tabular-nums mr-1">{s.value}</span>{s.label}
                  </span>
                ))}
              </div>

              {result.proposals.map((p: HealProposal, i: number) => (
                <div key={p.endpointId || `${p.url}-${i}`} className={`${CARD} p-3 space-y-2`}>
                  <div className="flex items-center gap-2 min-w-0">
                    <MethodBadge method={p.method} />
                    <span className="text-[12px] font-mono text-gray-700 truncate min-w-0 flex-1">{p.url}</span>
                  </div>
                  <div className="flex items-center gap-1.5 flex-wrap">
                    <span className={`${CHIP} ${toneClass(p.classification)}`}>{p.classification}</span>
                    <span className={`${CHIP} ${toneClass(p.confidence)}`}>{p.confidence} confidence</span>
                    {p.shouldHeal
                      ? <span className={`${CHIP} text-emerald-700 bg-emerald-50 border-emerald-200`}>Safe to adopt</span>
                      : <span className={`${CHIP} text-gray-600 bg-gray-50 border-gray-200`}>Review only</span>}
                  </div>
                  <p className="text-[12.5px] font-medium text-gray-800">{p.summary}</p>
                  <p className="text-[11.5px] text-gray-500">{p.rationale}</p>

                  {p.observed && (
                    <div className="space-y-1">
                      <div className="flex items-center gap-1.5 text-[11.5px] text-gray-500">
                        <span>Observed</span>
                        {p.observed.status !== undefined && <StatusCode code={p.observed.status} />}
                        {!p.observed.reachable && <span className="text-[10px] text-gray-400 italic">unreachable</span>}
                      </div>
                      {p.observed.bodySnippet && (
                        <pre className="font-mono text-[11px] text-gray-700 bg-[#FAF9FE] border border-[#E4E0F5] rounded p-2 whitespace-pre-wrap break-words max-h-32 overflow-auto">{truncate(p.observed.bodySnippet, 400)}</pre>
                      )}
                    </div>
                  )}

                  {p.patch && (
                    <div className="rounded-lg border border-[#E4E0F5] bg-white p-2 space-y-1">
                      <div className="text-[10.5px] font-semibold uppercase tracking-wide text-gray-500">Proposed change</div>
                      {p.patch.expectedStatus !== undefined && (
                        <div className="flex items-center gap-1.5 text-[11.5px] text-gray-600">
                          <span>Expected status</span><StatusCode code={p.patch.expectedStatus} />
                        </div>
                      )}
                      {p.patch.expectedResponse && (
                        <pre className="font-mono text-[11px] text-gray-700 bg-[#FAF9FE] border border-[#E4E0F5] rounded p-2 whitespace-pre-wrap break-words max-h-32 overflow-auto">{truncate(p.patch.expectedResponse, 600)}</pre>
                      )}
                    </div>
                  )}

                  {p.note && <p className="text-[11px] text-gray-400 italic">{p.note}</p>}
                </div>
              ))}

              <p className="text-[10.5px] text-gray-400 italic">Proposals are advisory — review before adopting. Regressions are never auto-healed.</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
