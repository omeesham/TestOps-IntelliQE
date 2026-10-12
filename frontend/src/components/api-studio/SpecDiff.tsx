/**
 * SpecDiff — spec-vs-spec breaking-change gate.
 *
 * Paste the OLD and NEW OpenAPI document (JSON or YAML); the gate reports every
 * change and whether any is BREAKING for existing consumers, so a CI step can
 * block the merge before it ships. Distinct from runtime drift detection — this
 * compares two static contracts. Opt-in and standalone.
 */
import { useState } from 'react';
import { X, GitCompare, AlertTriangle, CheckCircle2, ShieldX } from 'lucide-react';
import Spinner from '@/components/feedback/Spinner';
import { runApiSpecDiff, type SpecDiffResult, type SpecChange } from '@/services/api';
import { CARD, STRIP, FIELD, LABEL, PRIMARY_BTN } from './format';

export default function SpecDiff({ onClose }: { onClose: () => void }) {
  const [oldSpec, setOldSpec] = useState('');
  const [newSpec, setNewSpec] = useState('');
  const [failOnBreaking, setFailOnBreaking] = useState(true);
  const [result, setResult] = useState<SpecDiffResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const run = async () => {
    setLoading(true); setError(''); setResult(null);
    try {
      setResult(await runApiSpecDiff(oldSpec, newSpec, failOnBreaking));
    } catch (err: any) {
      setError(err?.response?.data?.error || err?.message || 'Spec diff failed.');
    } finally { setLoading(false); }
  };

  const breaking = (result?.changes || []).filter((c) => c.breaking);
  const nonBreaking = (result?.changes || []).filter((c) => !c.breaking);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-[#1E1B4B]/30 backdrop-blur-sm p-4" onClick={onClose}>
      <div className={`${CARD} w-full max-w-3xl max-h-[88vh] flex flex-col overflow-hidden`} onClick={(e) => e.stopPropagation()}>
        <div className={`flex items-center gap-2 px-4 h-12 border-b border-[#EDE9FE] flex-shrink-0 ${STRIP}`}>
          <GitCompare className="w-4 h-4 text-[#7C3AED]" />
          <h3 className="text-[13px] font-semibold text-gray-900">Breaking-change gate</h3>
          <span className="text-[11px] text-gray-400">OpenAPI vs OpenAPI · JSON or YAML</span>
          <button type="button" onClick={onClose} className="ml-auto p-1.5 rounded-md text-gray-400 hover:text-[#7C3AED] hover:bg-[#F5F3FF]"><X className="w-4 h-4" /></button>
        </div>

        {!result && (
          <div className="flex-1 overflow-y-auto min-h-0 p-4 space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className={LABEL}>Old spec (baseline / main)</label>
                <textarea value={oldSpec} onChange={(e) => setOldSpec(e.target.value)} placeholder="Paste the current OpenAPI document…" spellCheck={false} className={`${FIELD} w-full h-56 font-mono text-[11px] resize-none`} />
              </div>
              <div>
                <label className={LABEL}>New spec (the change / PR)</label>
                <textarea value={newSpec} onChange={(e) => setNewSpec(e.target.value)} placeholder="Paste the proposed OpenAPI document…" spellCheck={false} className={`${FIELD} w-full h-56 font-mono text-[11px] resize-none`} />
              </div>
            </div>
            {error && <div className="flex items-start gap-2 px-4 py-2.5 bg-red-50 border border-red-200 rounded-lg"><AlertTriangle className="w-4 h-4 text-red-500 flex-shrink-0 mt-px" /><p className="text-[12px] text-red-700 min-w-0">{error}</p></div>}
            <div className="flex items-center justify-between">
              <label className="flex items-center gap-1.5 text-[11px] text-gray-500 cursor-pointer">
                <input type="checkbox" checked={failOnBreaking} onChange={(e) => setFailOnBreaking(e.target.checked)} className="rounded border-gray-300" />
                Fail the gate on any breaking change
              </label>
              <button type="button" onClick={() => void run()} disabled={loading || !oldSpec.trim() || !newSpec.trim()} className={PRIMARY_BTN}>
                {loading ? <Spinner className="w-3.5 h-3.5 animate-spin" /> : <GitCompare className="w-3.5 h-3.5" />}Diff specs
              </button>
            </div>
          </div>
        )}

        {result && (
          <>
            <div className={`flex items-center gap-2 px-4 py-3 border-b border-[#EDE9FE] flex-shrink-0 ${result.gate.passed ? 'bg-emerald-50' : 'bg-red-50'}`}>
              {result.gate.passed ? <CheckCircle2 className="w-5 h-5 text-emerald-600 flex-shrink-0" /> : <ShieldX className="w-5 h-5 text-red-600 flex-shrink-0" />}
              <div className="min-w-0">
                <p className={`text-[13px] font-semibold ${result.gate.passed ? 'text-emerald-800' : 'text-red-800'}`}>{result.gate.passed ? 'GO — safe to merge' : 'NO-GO — breaking changes'}</p>
                <p className="text-[11px] text-gray-600">{result.gate.reason}</p>
              </div>
              <button type="button" onClick={() => setResult(null)} className="ml-auto text-[11px] font-semibold text-[#6D28D9] hover:text-[#5B21B6]">Edit specs</button>
            </div>
            <div className="flex flex-wrap items-center gap-2 px-4 py-2.5 border-b border-[#EDE9FE] flex-shrink-0">
              <Pill label="Breaking" value={result.summary.breaking} tone={result.summary.breaking ? 'bad' : 'muted'} />
              <Pill label="Non-breaking" value={result.summary.nonBreaking} tone="warn" />
              <Pill label="Additions" value={result.summary.additions} tone="good" />
              <span className="ml-auto text-[11px] text-gray-400 truncate">{result.oldInfo.title || 'old'} {result.oldInfo.version || ''} → {result.newInfo.title || 'new'} {result.newInfo.version || ''}</span>
            </div>
            <div className="flex-1 overflow-y-auto min-h-0">
              {result.changes.length === 0 ? (
                <div className="flex items-center gap-2 m-4 px-4 py-3 bg-emerald-50 border border-emerald-200 rounded-lg text-[12px] text-emerald-800"><CheckCircle2 className="w-4 h-4 text-emerald-600" />No differences detected between the two specs.</div>
              ) : (
                <>
                  {breaking.length > 0 && <div className="divide-y divide-gray-100">{breaking.map((c, i) => <ChangeRow key={`b${i}`} c={c} />)}</div>}
                  {nonBreaking.length > 0 && (
                    <details className="px-4 py-3 border-t border-gray-100" open={breaking.length === 0}>
                      <summary className="cursor-pointer text-[11px] font-medium text-gray-500 hover:text-[#7C3AED]">{nonBreaking.length} non-breaking change{nonBreaking.length === 1 ? '' : 's'}</summary>
                      <div className="mt-2 divide-y divide-gray-50">{nonBreaking.map((c, i) => <ChangeRow key={`n${i}`} c={c} />)}</div>
                    </details>
                  )}
                </>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function Pill({ label, value, tone }: { label: string; value: number; tone: 'bad' | 'warn' | 'good' | 'muted' }) {
  const cls = {
    bad: value ? 'text-red-700 bg-red-50 border-red-200' : 'text-gray-400 bg-gray-50 border-gray-200',
    warn: value ? 'text-amber-700 bg-amber-50 border-amber-200' : 'text-gray-400 bg-gray-50 border-gray-200',
    good: value ? 'text-emerald-700 bg-emerald-50 border-emerald-200' : 'text-gray-400 bg-gray-50 border-gray-200',
    muted: 'text-gray-500 bg-gray-50 border-gray-200',
  }[tone];
  return <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md border text-[11.5px] font-semibold tabular-nums ${cls}`}>{value} {label}</span>;
}

function ChangeRow({ c }: { c: SpecChange }) {
  return (
    <div className="px-4 py-2.5">
      <div className="flex items-center gap-2">
        <span className={`text-[9px] font-bold uppercase px-1.5 py-0.5 rounded border flex-shrink-0 ${c.breaking ? 'text-red-700 bg-red-50 border-red-200' : 'text-gray-600 bg-gray-100 border-gray-300'}`}>{c.breaking ? 'breaking' : 'ok'}</span>
        <span className="text-[10.5px] font-mono text-gray-500 flex-shrink-0">{c.kind}</span>
        <span className="text-[11.5px] font-mono text-gray-800 min-w-0 flex-1 truncate" title={c.location}>{c.location}</span>
      </div>
      <p className="mt-1 ml-1 text-[11px] text-gray-600 leading-relaxed">{c.detail}</p>
    </div>
  );
}
