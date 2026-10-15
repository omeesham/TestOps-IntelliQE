/**
 * SeqFuzz — stateful CRUD-chain fuzzing.
 *
 * Builds short resource chains (POST → GET/PUT/DELETE) from the catalogue,
 * captures the id the create hands back, and threads it through the rest of the
 * chain while fuzzing the identifier and stripping auth along the way. Read-only
 * by default — it only exercises writes when the operator explicitly allows them
 * against a disposable/test environment. No model cost.
 */
import { useState } from 'react';
import { X, GitFork, Play, AlertTriangle } from 'lucide-react';
import Spinner from '@/components/feedback/Spinner';
import { runSeqFuzz, type SeqFuzzReport, type SeqFuzzSequence, type SeqStep, type SeqStepFinding } from '@/services/api';
import { MethodBadge } from './primitives';
import { CARD, STRIP, INPUT, LABEL, PRIMARY_BTN } from './format';
import type { CatalogEndpoint } from './types';

function gradeCls(g: string): string {
  if (g === 'A' || g === 'B') return 'text-emerald-700 bg-emerald-50 border-emerald-200';
  if (g === 'C') return 'text-amber-700 bg-amber-50 border-amber-200';
  return 'text-red-700 bg-red-50 border-red-200';
}

function findingCls(f: SeqStepFinding): string {
  if (f === 'server-error' || f === 'auth-bypass' || f === 'unexpected-2xx') return 'text-red-700 bg-red-50 border-red-200';
  if (f === 'bad-request-handled' || f === 'ok') return 'text-emerald-700 bg-emerald-50 border-emerald-200';
  if (f === 'error') return 'text-amber-700 bg-amber-50 border-amber-200';
  return 'text-gray-600 bg-gray-50 border-gray-200';
}

export default function SeqFuzz({ endpoints, onClose }: { endpoints: CatalogEndpoint[]; onClose: () => void }) {
  const [allowWrites, setAllowWrites] = useState(false);
  const [maxResources, setMaxResources] = useState(6);
  const [result, setResult] = useState<SeqFuzzReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const run = async () => {
    setBusy(true); setError(''); setResult(null);
    try {
      setResult(await runSeqFuzz(endpoints, { allowWrites, maxResources }));
    } catch (e: any) {
      setError(e?.response?.data?.error || e?.message || 'Sequence fuzz failed.');
    } finally { setBusy(false); }
  };

  const issueEntries = result ? Object.entries(result.summary.issues).filter(([, n]) => n > 0) : [];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-[#1E1B4B]/45 backdrop-blur-md p-4" onClick={onClose}>
      <div className={`${CARD} w-full max-w-3xl max-h-[88vh] flex flex-col overflow-hidden`} onClick={(e) => e.stopPropagation()}>
        <div className={`flex items-center gap-2 px-4 h-12 border-b border-[#EDE9FE] flex-shrink-0 ${STRIP}`}>
          <GitFork className="w-4 h-4 text-[#7C3AED]" />
          <h3 className="text-[13px] font-semibold text-gray-900">Sequence fuzzing</h3>
          <span className="text-[11px] text-gray-400">Stateful CRUD-chain fuzzing</span>
          <button type="button" onClick={onClose} className="ml-auto p-1.5 rounded-md text-gray-400 hover:text-[#7C3AED] hover:bg-[#F5F3FF]"><X className="w-4 h-4" /></button>
        </div>

        <div className="p-4 space-y-3 overflow-y-auto min-h-0">
          {error && (
            <div className="flex items-start gap-2 px-3 py-2 bg-red-50 border border-red-200 rounded-lg">
              <AlertTriangle className="w-4 h-4 text-red-500 flex-shrink-0 mt-px" /><p className="text-[12px] text-red-700 min-w-0 whitespace-pre-wrap break-words">{error}</p>
            </div>
          )}

          <div className="space-y-2">
            <label className="flex items-start gap-2 text-[12px] text-gray-700">
              <input type="checkbox" checked={allowWrites} onChange={(e) => { setAllowWrites(e.target.checked); setResult(null); }} className="w-3.5 h-3.5 mt-0.5" />
              <span className="min-w-0">Allow writes (POST/PUT/DELETE) — run only against a disposable/test environment</span>
            </label>
            {allowWrites && (
              <div className="flex items-start gap-1.5 text-[11px] text-amber-700">
                <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0 mt-px" />
                <span className="min-w-0">Writes are live. This will create, modify and delete real resources on the target — only proceed against a disposable/test environment.</span>
              </div>
            )}
          </div>

          <div className="max-w-[12rem]">
            <label className={LABEL}>Max resources</label>
            <input type="number" min={1} max={12} value={maxResources} onChange={(e) => setMaxResources(Math.min(12, Math.max(1, Number(e.target.value) || 1)))} className={INPUT} />
          </div>

          <div className="flex items-center justify-end gap-2">
            {busy && <span className="text-[11px] text-gray-400">fuzzing live… (this can take up to ~60s)</span>}
            <button type="button" onClick={() => void run()} disabled={busy} className={PRIMARY_BTN}>
              {busy ? <Spinner className="w-3.5 h-3.5 animate-spin" /> : <Play className="w-3.5 h-3.5" />}
              {busy ? 'Running…' : 'Run sequence fuzz'}
            </button>
          </div>

          {result && (
            <div className="space-y-3">
              <div className="flex flex-wrap items-center gap-3">
                <span className={`inline-flex items-center justify-center w-12 h-12 rounded-xl border text-2xl font-bold ${gradeCls(result.grade)}`}>{result.grade}</span>
                <div className="text-[12px] text-gray-600 tabular-nums">
                  {result.summary.sequencesBuilt} sequence{result.summary.sequencesBuilt === 1 ? '' : 's'} built · {result.summary.sequencesRan} ran · {result.summary.stepsRun} step{result.summary.stepsRun === 1 ? '' : 's'}
                </div>
                {issueEntries.length > 0 && (
                  <div className="ml-auto flex flex-wrap gap-1.5">
                    {issueEntries.map(([k, n]) => (
                      <span key={k} className="inline-flex items-center gap-1 px-2 py-0.5 rounded border text-[10.5px] font-mono tabular-nums text-red-700 bg-red-50 border-red-200">{k}:{n}</span>
                    ))}
                  </div>
                )}
              </div>

              {result.note && <p className="text-[11px] text-gray-400 whitespace-pre-wrap break-words">{result.note}</p>}

              <div className="space-y-2">
                {result.sequences.map((seq, i) => <SequenceCard key={i} seq={seq} />)}
              </div>
            </div>
          )}

          <p className="text-[10px] text-gray-400">Read-only by default — chains POST→GET/PUT/DELETE and fuzzes identifiers + auth along them.</p>
        </div>
      </div>
    </div>
  );
}

function SequenceCard({ seq }: { seq: SeqFuzzSequence }) {
  return (
    <div className="rounded-lg border border-[#E9E5FB] bg-[#FCFBFF] p-3">
      <div className="flex flex-wrap items-center gap-2 mb-2">
        <span className="font-mono text-[12px] font-semibold text-gray-800 min-w-0">{seq.resource}</span>
        <span className="text-[10.5px] text-gray-400">id captured: {seq.idCaptured ? <span className="font-mono text-gray-600">{seq.idCaptured}</span> : '—'}</span>
      </div>
      <div className="space-y-1.5">
        {seq.steps.map((step, i) => <StepRow key={i} step={step} />)}
      </div>
      {seq.issues.length > 0 && (
        <ul className="mt-2 space-y-0.5">
          {seq.issues.map((iss, i) => <li key={i} className="text-[10.5px] text-red-700 min-w-0 whitespace-pre-wrap break-words">{iss}</li>)}
        </ul>
      )}
    </div>
  );
}

function StepRow({ step }: { step: SeqStep }) {
  return (
    <div className="flex flex-wrap items-baseline gap-2">
      <MethodBadge method={step.method} />
      <span className={`inline-flex items-center px-1.5 py-0.5 rounded border text-[10px] font-medium ${findingCls(step.finding)}`}>{step.finding}</span>
      <span className="text-[12px] text-gray-800 min-w-0">{step.label}</span>
      {step.status !== undefined && <span className="font-mono text-[10.5px] text-gray-500 tabular-nums">{step.status}</span>}
      {step.note && <span className="text-[10.5px] text-gray-400 min-w-0 w-full whitespace-pre-wrap break-words">{step.note}</span>}
    </div>
  );
}
