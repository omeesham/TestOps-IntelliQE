/**
 * GovernanceLint — Spectral-style API governance over the catalogue.
 *
 * Runs a chosen design-quality ruleset against the endpoint catalogue and
 * grades it, then checks the findings against an optional CI gate (max errors,
 * max warnings, min score). Heuristics over what the workspace already knows —
 * naming, methods, auth, descriptions — so a team can wire the same gate into
 * CI. A design-quality snapshot, not a live contract test.
 */
import { useEffect, useState } from 'react';
import { X, Gavel, Play, AlertTriangle, CheckCircle2, Ban } from 'lucide-react';
import Spinner from '@/components/feedback/Spinner';
import {
  listGovernanceRulesets,
  runGovernance,
  type GovReport,
  type GovFinding,
  type GovSeverity,
  type GovGateBudget,
} from '@/services/api';
import { CARD, STRIP, INPUT, LABEL, PRIMARY_BTN } from './format';
import type { CatalogEndpoint } from './types';

function gradeCls(g: string): string {
  if (g === 'A' || g === 'B') return 'text-emerald-700 bg-emerald-50 border-emerald-200';
  if (g === 'C') return 'text-amber-700 bg-amber-50 border-amber-200';
  return 'text-red-700 bg-red-50 border-red-200';
}

function sevCls(s: GovSeverity | string): string {
  if (s === 'error') return 'text-red-700 bg-red-50 border-red-200';
  if (s === 'warn') return 'text-amber-700 bg-amber-50 border-amber-200';
  return 'text-gray-600 bg-gray-50 border-gray-200';
}

export default function GovernanceLint({ endpoints, onClose }: { endpoints: CatalogEndpoint[]; onClose: () => void }) {
  const [rulesets, setRulesets] = useState<{ id: string; label: string }[]>([]);
  const [ruleCount, setRuleCount] = useState(0);
  const [ruleset, setRuleset] = useState('');
  const [maxErrors, setMaxErrors] = useState<string>('');
  const [maxWarnings, setMaxWarnings] = useState<string>('');
  const [minScore, setMinScore] = useState<string>('');
  const [result, setResult] = useState<GovReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    (async () => {
      try {
        const { rulesets: list, rules } = await listGovernanceRulesets();
        setRulesets(list);
        setRuleCount(rules.length);
        setRuleset(list[0]?.id || '');
      } catch (e: any) {
        setError(e?.response?.data?.error || e?.message || 'Could not load governance rulesets.');
      } finally { setLoading(false); }
    })();
  }, []);

  const run = async () => {
    if (!ruleset) return;
    setBusy(true); setError(''); setResult(null);
    try {
      const gate: GovGateBudget = {};
      if (maxErrors.trim() !== '') gate.maxErrors = Number(maxErrors);
      if (maxWarnings.trim() !== '') gate.maxWarnings = Number(maxWarnings);
      if (minScore.trim() !== '') gate.minScore = Number(minScore);
      setResult(await runGovernance(endpoints, {
        ruleset,
        gate: Object.keys(gate).length ? gate : undefined,
      }));
    } catch (e: any) {
      setError(e?.response?.data?.error || e?.message || 'Governance lint failed.');
    } finally { setBusy(false); }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-[#1E1B4B]/45 backdrop-blur-md p-4" onClick={onClose}>
      <div className={`${CARD} w-full max-w-3xl max-h-[88vh] flex flex-col overflow-hidden`} onClick={(e) => e.stopPropagation()}>
        <div className={`flex items-center gap-2 px-4 h-12 border-b border-[#EDE9FE] flex-shrink-0 ${STRIP}`}>
          <Gavel className="w-4 h-4 text-[#7C3AED]" />
          <h3 className="text-[13px] font-semibold text-gray-900">API governance</h3>
          <span className="text-[11px] text-gray-400">Spectral-style rulesets · CI gate</span>
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
              <div>
                <label className={LABEL}>Ruleset</label>
                <select value={ruleset} onChange={(e) => { setRuleset(e.target.value); setResult(null); }} className={INPUT} disabled={!rulesets.length}>
                  {rulesets.length === 0 && <option>No rulesets available</option>}
                  {rulesets.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}
                </select>
                <p className="text-[10px] text-gray-400 mt-1">{ruleCount} built-in rules</p>
              </div>

              <div className="grid grid-cols-3 gap-3">
                <div>
                  <label className={LABEL}>Max errors</label>
                  <input type="number" min={0} placeholder="no budget" value={maxErrors} onChange={(e) => setMaxErrors(e.target.value)} className={INPUT} />
                </div>
                <div>
                  <label className={LABEL}>Max warnings</label>
                  <input type="number" min={0} placeholder="no budget" value={maxWarnings} onChange={(e) => setMaxWarnings(e.target.value)} className={INPUT} />
                </div>
                <div>
                  <label className={LABEL}>Min score</label>
                  <input type="number" min={0} max={100} placeholder="no budget" value={minScore} onChange={(e) => setMinScore(e.target.value)} className={INPUT} />
                </div>
              </div>

              <div className="flex items-center justify-end gap-2">
                {busy && <span className="text-[11px] text-gray-400">linting {endpoints.length} endpoints…</span>}
                <button type="button" onClick={() => void run()} disabled={busy || !ruleset} className={PRIMARY_BTN}>
                  {busy ? <Spinner className="w-3.5 h-3.5 animate-spin" /> : <Play className="w-3.5 h-3.5" />}
                  {busy ? 'Running…' : 'Run lint'}
                </button>
              </div>

              {result && (
                <div className="space-y-3">
                  {/* Grade + score + ruleset */}
                  <div className="flex flex-wrap items-center gap-3">
                    <span className={`inline-flex items-center justify-center w-12 h-12 rounded-xl border text-2xl font-bold ${gradeCls(result.grade)}`}>{result.grade}</span>
                    <div>
                      <div className="text-[13px] font-semibold text-gray-900">{result.ruleset}</div>
                      <div className="text-[11px] text-gray-400 tabular-nums">score {result.score} · evaluated {result.evaluated} endpoints</div>
                    </div>
                    <div className="ml-auto flex flex-wrap gap-1.5">
                      <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded border text-[10.5px] font-mono tabular-nums ${sevCls('error')}`}>{result.summary.error ?? 0} error</span>
                      <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded border text-[10.5px] font-mono tabular-nums ${sevCls('warn')}`}>{result.summary.warn ?? 0} warn</span>
                      <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded border text-[10.5px] font-mono tabular-nums ${sevCls('info')}`}>{result.summary.info ?? 0} info</span>
                    </div>
                  </div>

                  {/* CI gate */}
                  <div>
                    <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg border text-[11.5px] font-medium ${result.gate.passed ? 'text-emerald-700 bg-emerald-50 border-emerald-200' : 'text-red-700 bg-red-50 border-red-200'}`}>
                      {result.gate.passed ? <CheckCircle2 className="w-3.5 h-3.5" /> : <Ban className="w-3.5 h-3.5" />}
                      {result.gate.passed ? 'Gate passed' : 'Gate failed'}
                    </span>
                    {!result.gate.passed && result.gate.reasons.length > 0 && (
                      <ul className="mt-1.5 space-y-1">
                        {result.gate.reasons.map((r, i) => <li key={i} className="text-[11px] text-red-600 flex gap-1.5"><span>•</span><span className="min-w-0">{r}</span></li>)}
                      </ul>
                    )}
                  </div>

                  {/* Findings */}
                  <div className="space-y-2">
                    {result.findings.map((f: GovFinding, i) => (
                      <div key={i} className="rounded-lg border border-[#E9E5FB] bg-[#FCFBFF] p-3">
                        <div className="flex items-center gap-2 mb-1">
                          <span className={`inline-flex items-center px-2 py-0.5 rounded border text-[10.5px] font-medium ${sevCls(f.severity)}`}>{f.severity}</span>
                          <span className="text-[12px] font-semibold text-gray-800 min-w-0 flex-1 whitespace-pre-wrap break-words">{f.message}</span>
                        </div>
                        {f.endpoint && <p className="text-[11px] text-gray-400 font-mono whitespace-pre-wrap break-words">{f.endpoint}</p>}
                        {f.hint && <p className="text-[10.5px] text-gray-400 mt-1 whitespace-pre-wrap break-words">{f.hint}</p>}
                      </div>
                    ))}
                  </div>
                </div>
              )}

              <p className="text-[10px] text-gray-400">Design-quality heuristics over your catalogue — configure rulesets and gate for CI.</p>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
