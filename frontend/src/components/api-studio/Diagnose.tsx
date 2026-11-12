/**
 * Diagnose — AI root-cause triage for one failed scenario.
 *
 * Opt-in and standalone: asks the model why a test failed and shows a detailed
 * plain-English root cause (evidence, impact, ordered fix steps, prevention), a
 * repro curl, and — on demand — runs the semantic heal agent to propose a
 * concrete resolution (a patch) for the failing test. It touches no pipeline
 * state; the heal is advisory and nothing is applied without review.
 */
import { useEffect, useState } from 'react';
import { X, Sparkles, AlertTriangle, Wrench, Terminal, HeartPulse, CheckCircle2, ListChecks, Search, Target, ShieldCheck } from 'lucide-react';
import Spinner from '@/components/feedback/Spinner';
import { diagnoseApiFailure, proposeHeal, type Diagnosis, type HealProposal } from '@/services/api';
import { CopyButton } from './primitives';
import { CARD, STRIP, INSET, BRAND_CHIP, PRIMARY_BTN } from './format';

export interface FailurePayload {
  title?: string; method: string; url: string; error: string;
  expectedStatus?: number; requestBody?: string;
}

function toneClass(key: string): string {
  const k = (key || '').toLowerCase();
  if (k === 'regression' || k === 'critical') return 'text-red-700 bg-red-50 border-red-200';
  if (k === 'contract-evolution' || k === 'high') return 'text-emerald-700 bg-emerald-50 border-emerald-200';
  if (k === 'flaky' || k === 'medium') return 'text-amber-700 bg-amber-50 border-amber-200';
  if (k === 'environment' || k === 'auth' || k === 'low') return 'text-blue-700 bg-blue-50 border-blue-200';
  return 'text-gray-600 bg-gray-50 border-gray-200';
}

export default function Diagnose({ failure, onClose }: { failure: FailurePayload; onClose: () => void }) {
  const [diag, setDiag] = useState<Diagnosis | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  // Heal agent — on-demand, advisory. Proposes a concrete fix for this failure.
  const [heal, setHeal] = useState<HealProposal | null>(null);
  const [healLoading, setHealLoading] = useState(false);
  const [healError, setHealError] = useState('');
  const [healed, setHealed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const d = await diagnoseApiFailure(failure);
        if (!cancelled) setDiag(d);
      } catch (err: any) {
        if (!cancelled) setError(err?.response?.data?.error || err?.message || 'Diagnosis failed.');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const runHeal = async () => {
    setHealLoading(true); setHealError(''); setHealed(false);
    try {
      const res = await proposeHeal({ failures: [{
        title: failure.title, method: failure.method, url: failure.url,
        error: failure.error, expectedStatus: failure.expectedStatus, body: failure.requestBody,
      }] });
      const p = res?.proposals?.[0] || null;
      setHeal(p);
      setHealed(true);
      if (!p) setHealError('The heal agent returned no proposal for this failure.');
    } catch (err: any) {
      setHealError(err?.response?.data?.error || err?.message || 'The heal agent could not resolve this failure.');
    } finally {
      setHealLoading(false);
    }
  };

  const confCls = diag ? toneClass(diag.confidence) : '';
  const hasFixSteps = !!diag?.fixSteps?.length;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-[#1E1B4B]/45 backdrop-blur-md p-4" onClick={onClose}>
      <div className={`${CARD} w-full max-w-xl max-h-[85vh] flex flex-col overflow-hidden`} onClick={(e) => e.stopPropagation()}>
        <div className={`flex items-center gap-2 px-4 h-12 border-b border-[#EDE9FE] flex-shrink-0 ${STRIP}`}>
          <Sparkles className="w-4 h-4 text-[#7C3AED]" />
          <h3 className="text-[13px] font-semibold text-gray-900">Root-cause analysis</h3>
          <button type="button" onClick={onClose} className="ml-auto p-1.5 rounded-md text-gray-400 hover:text-[#7C3AED] hover:bg-[#F5F3FF]"><X className="w-4 h-4" /></button>
        </div>

        <div className="p-4 space-y-3 overflow-y-auto min-h-0">
          <div className="flex items-center gap-2 text-[11.5px] text-gray-500 min-w-0">
            <span className="font-mono font-semibold text-[#6D28D9]">{failure.method.toUpperCase()}</span>
            <span className="font-mono truncate">{failure.url || failure.title}</span>
          </div>

          {loading ? (
            <div className="flex items-center justify-center gap-2 py-10 text-[12px] text-gray-500"><Spinner className="w-4 h-4 animate-spin text-[#7C3AED]" />Analysing the failure…</div>
          ) : error ? (
            <div className="flex items-start gap-2 px-3 py-2 bg-red-50 border border-red-200 rounded-lg"><AlertTriangle className="w-4 h-4 text-red-500 flex-shrink-0 mt-px" /><p className="text-[12px] text-red-700 min-w-0">{error}</p></div>
          ) : diag ? (
            <>
              <div className="flex items-center gap-2 flex-wrap">
                <span className={`text-[10px] font-semibold uppercase px-1.5 py-0.5 rounded border ${BRAND_CHIP}`}>{diag.category}</span>
                <span className={`text-[10px] font-semibold uppercase px-1.5 py-0.5 rounded border ${confCls}`}>{diag.confidence} confidence</span>
              </div>

              {diag.summary && diag.summary !== diag.rootCause && (
                <p className="text-[13px] font-semibold text-gray-900 leading-snug">{diag.summary}</p>
              )}

              <div>
                <div className="text-[10.5px] font-semibold uppercase tracking-wide text-gray-500 mb-1">Root cause</div>
                <p className="text-[12.5px] text-gray-800 leading-relaxed whitespace-pre-wrap">{diag.rootCause}</p>
              </div>

              {!!diag.evidence?.length && (
                <div>
                  <div className="flex items-center gap-1.5 mb-1"><Search className="w-3.5 h-3.5 text-gray-400" /><span className="text-[10.5px] font-semibold uppercase tracking-wide text-gray-500">Evidence</span></div>
                  <ul className="space-y-1">
                    {diag.evidence.map((e, i) => (
                      <li key={i} className="flex items-start gap-1.5 text-[12px] text-gray-700 leading-relaxed">
                        <span className="text-[#7C3AED] mt-px flex-shrink-0">•</span><span className="min-w-0">{e}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {diag.impact && (
                <div className="flex items-start gap-2 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
                  <Target className="w-3.5 h-3.5 text-amber-600 flex-shrink-0 mt-0.5" />
                  <div><div className="text-[10.5px] font-semibold uppercase tracking-wide text-amber-700 mb-0.5">Impact</div><p className="text-[12px] text-amber-900 leading-relaxed">{diag.impact}</p></div>
                </div>
              )}

              {/* Ordered fix steps, falling back to the single suggested fix. */}
              {hasFixSteps ? (
                <div className="bg-[#F5F3FF] border border-[#DDD6FE] rounded-lg px-3 py-2.5">
                  <div className="flex items-center gap-1.5 mb-1.5"><ListChecks className="w-3.5 h-3.5 text-[#7C3AED]" /><span className="text-[10.5px] font-semibold uppercase tracking-wide text-[#6D28D9]">How to fix</span></div>
                  <ol className="space-y-1.5">
                    {diag.fixSteps!.map((s, i) => (
                      <li key={i} className="flex items-start gap-2 text-[12px] text-[#4C1D95] leading-relaxed">
                        <span className="flex-shrink-0 w-4 h-4 rounded-full bg-[#7C3AED] text-white text-[9px] font-bold flex items-center justify-center mt-px tabular-nums">{i + 1}</span>
                        <span className="min-w-0">{s}</span>
                      </li>
                    ))}
                  </ol>
                </div>
              ) : diag.suggestedFix && (
                <div className="flex items-start gap-2 bg-[#F5F3FF] border border-[#DDD6FE] rounded-lg px-3 py-2">
                  <Wrench className="w-3.5 h-3.5 text-[#7C3AED] flex-shrink-0 mt-0.5" />
                  <div><div className="text-[10.5px] font-semibold uppercase tracking-wide text-[#6D28D9] mb-0.5">Suggested fix</div><p className="text-[12px] text-[#4C1D95] leading-relaxed">{diag.suggestedFix}</p></div>
                </div>
              )}

              {diag.prevention && (
                <div className="flex items-start gap-2 bg-emerald-50 border border-emerald-200 rounded-lg px-3 py-2">
                  <ShieldCheck className="w-3.5 h-3.5 text-emerald-600 flex-shrink-0 mt-0.5" />
                  <div><div className="text-[10.5px] font-semibold uppercase tracking-wide text-emerald-700 mb-0.5">Prevent recurrence</div><p className="text-[12px] text-emerald-900 leading-relaxed">{diag.prevention}</p></div>
                </div>
              )}

              <div>
                <div className="flex items-center gap-1.5 mb-1"><Terminal className="w-3.5 h-3.5 text-gray-400" /><span className="text-[10.5px] font-semibold uppercase tracking-wide text-gray-500">Reproduce</span><CopyButton text={diag.reproCurl} className="ml-auto" /></div>
                <pre className={`font-mono text-[11px] text-gray-700 bg-[#FCFBFF] border border-[#E4E0F5] rounded-md p-2.5 whitespace-pre-wrap ${INSET}`}>{diag.reproCurl}</pre>
              </div>

              {/* IQE-041.1 — the Healer only suggests; it never changes a script or re-runs a test on its own. */}
              <div className="flex items-start gap-1.5 px-2.5 py-1.5 bg-amber-50 border border-amber-200 rounded-md">
                <AlertTriangle className="w-3.5 h-3.5 text-amber-500 flex-shrink-0 mt-px" />
                <p className="text-[11.5px] text-amber-800">{diag.revalidateNote || 'Please check all the API details and revalidate.'}</p>
              </div>

              {/* ── Heal agent — propose a concrete resolution for this failure ── */}
              <div className="border-t border-[#EDE9FE] pt-3 space-y-2.5">
                {!healed && (
                  <div className="flex items-center gap-2">
                    <button type="button" onClick={() => void runHeal()} disabled={healLoading} className={PRIMARY_BTN}>
                      {healLoading ? <Spinner className="w-3.5 h-3.5 animate-spin" /> : <HeartPulse className="w-3.5 h-3.5" />}
                      {healLoading ? 'Healing…' : 'Resolve with heal agent'}
                    </button>
                    <span className="text-[10.5px] text-gray-400">runs the self-heal agent on this failure</span>
                  </div>
                )}

                {healError && (
                  <div className="flex items-start gap-2 px-3 py-2 bg-red-50 border border-red-200 rounded-lg"><AlertTriangle className="w-4 h-4 text-red-500 flex-shrink-0 mt-px" /><p className="text-[12px] text-red-700 min-w-0">{healError}</p></div>
                )}

                {heal && (
                  <div className={`${CARD} p-3 space-y-2`}>
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <HeartPulse className="w-3.5 h-3.5 text-[#7C3AED]" />
                      <span className="text-[11px] font-semibold text-gray-900">Heal agent proposal</span>
                      <span className={`text-[10px] font-semibold uppercase px-1.5 py-0.5 rounded border ${toneClass(heal.classification)}`}>{heal.classification}</span>
                      <span className={`text-[10px] font-semibold uppercase px-1.5 py-0.5 rounded border ${toneClass(heal.confidence)}`}>{heal.confidence} confidence</span>
                      {heal.shouldHeal
                        ? <span className="text-[10px] font-semibold uppercase px-1.5 py-0.5 rounded border text-emerald-700 bg-emerald-50 border-emerald-200 inline-flex items-center gap-1"><CheckCircle2 className="w-3 h-3" />Safe to adopt</span>
                        : <span className="text-[10px] font-semibold uppercase px-1.5 py-0.5 rounded border text-gray-600 bg-gray-50 border-gray-200">Review only</span>}
                    </div>
                    {heal.summary && <p className="text-[12.5px] font-medium text-gray-800 leading-relaxed">{heal.summary}</p>}
                    {heal.rationale && <p className="text-[11.5px] text-gray-500 leading-relaxed">{heal.rationale}</p>}
                    {heal.observed && (heal.observed.status !== undefined || heal.observed.reachable === false) && (
                      <p className="text-[11px] text-gray-400">observed {heal.observed.status !== undefined ? `status ${heal.observed.status}` : ''}{heal.observed.reachable === false ? ' · unreachable' : ''}</p>
                    )}
                    {heal.patch && (heal.patch.expectedStatus !== undefined || heal.patch.expectedResponse) && (
                      <div className="bg-[#F5F3FF] border border-[#DDD6FE] rounded-md px-2.5 py-2 space-y-1">
                        <div className="text-[10px] font-semibold uppercase tracking-wide text-[#6D28D9]">Proposed patch</div>
                        {heal.patch.expectedStatus !== undefined && <p className="text-[11.5px] text-[#4C1D95]">Expected status → <span className="font-mono font-semibold">{heal.patch.expectedStatus}</span></p>}
                        {heal.patch.expectedResponse && <pre className="font-mono text-[10.5px] text-[#4C1D95] whitespace-pre-wrap break-words max-h-24 overflow-y-auto">{heal.patch.expectedResponse}</pre>}
                      </div>
                    )}
                    <p className="text-[10px] text-gray-400 italic">Advisory — adopt it in the guided failure → fix workflow to open a reviewable PR. Regressions are never auto-healed.</p>
                  </div>
                )}
              </div>

              <p className="text-[10.5px] text-gray-400">To file this, use the Bug Tracker — the repro above is ready to paste.</p>
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}
