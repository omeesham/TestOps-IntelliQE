/**
 * CoverageGuided — coverage-guided test generation.
 *
 * Probes the catalogue's endpoints to learn what the API actually returns —
 * which status classes, which response fields, which branches are already
 * exercised — then names the gaps (missing error paths, untested params,
 * unverified auth, missing boundaries) and drafts tests that close them.
 * Optionally folds in an external coverage report (lcov / istanbul json-summary)
 * to tie uncovered source files back to endpoints. Non-destructive: write verbs
 * are skipped unless explicitly enabled. Opt-in and isolated from the pipeline.
 */
import { useState } from 'react';
import { X, Radar, Target, AlertTriangle, CheckCircle2, Sparkles, FileCode2 } from 'lucide-react';
import Spinner from '@/components/feedback/Spinner';
import { runCoverageGuided, type CovGuideResult, type CovUncovered, type CovGenerated, type CovSignal } from '@/services/api';
import { MethodBadge } from './primitives';
import { CARD, STRIP, INPUT, FIELD, LABEL, PRIMARY_BTN } from './format';
import type { CatalogEndpoint } from './types';

const KIND_LABELS: Record<CovUncovered['kind'], string> = {
  'missing-error-path': 'error path',
  'missing-success-path': 'success path',
  'untested-param': 'untested param',
  'unverified-auth': 'unverified auth',
  'no-boundary': 'no boundary',
};

export default function CoverageGuided({ endpoints, onClose }: { endpoints: CatalogEndpoint[]; onClose: () => void }) {
  const [allowWrites, setAllowWrites] = useState(false);
  const [maxGenerate, setMaxGenerate] = useState(20);
  const [externalCoverage, setExternalCoverage] = useState('');
  const [showExternal, setShowExternal] = useState(false);
  const [result, setResult] = useState<CovGuideResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const run = async () => {
    setLoading(true); setError(''); setResult(null);
    try {
      setResult(await runCoverageGuided({
        endpoints: endpoints.map((e) => ({ id: e.id, title: e.title, method: e.method, url: e.url, headers: e.headers, body: e.body, auth: e.auth, queryParams: e.queryParams })),
        allowWrites,
        maxGenerate,
        externalCoverage: externalCoverage.trim() || undefined,
      }));
    } catch (err: any) {
      setError(err?.response?.data?.error || err?.message || 'Coverage-guided generation failed.');
    } finally { setLoading(false); }
  };

  const s = result?.summary;
  const ext = result?.external;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-[#1E1B4B]/45 backdrop-blur-md p-4" onClick={onClose}>
      <div className={`${CARD} w-full max-w-3xl max-h-[88vh] flex flex-col overflow-hidden`} onClick={(e) => e.stopPropagation()}>
        <div className={`flex items-center gap-2 px-4 h-12 border-b border-[#EDE9FE] flex-shrink-0 ${STRIP}`}>
          <Radar className="w-4 h-4 text-[#7C3AED]" />
          <h3 className="text-[13px] font-semibold text-gray-900">Coverage-guided generation</h3>
          <span className="text-[11px] text-gray-400">{endpoints.length} endpoint{endpoints.length === 1 ? '' : 's'}</span>
          <button type="button" onClick={onClose} className="ml-auto p-1.5 rounded-md text-gray-400 hover:text-[#7C3AED] hover:bg-[#F5F3FF]"><X className="w-4 h-4" /></button>
        </div>

        {/* Controls */}
        <div className="px-4 py-3 border-b border-[#EDE9FE] flex-shrink-0 space-y-2">
          <div className="flex items-center gap-3">
            <label className="flex items-center gap-1.5 text-[11px] text-gray-500 cursor-pointer">
              <input type="checkbox" checked={allowWrites} onChange={(e) => setAllowWrites(e.target.checked)} className="rounded border-gray-300" />
              Probe write methods (sends real requests)
            </label>
            <label className="flex items-center gap-1.5 text-[11px] text-gray-500 ml-auto">
              <span className={LABEL + ' mb-0'}>Max generated</span>
              <input type="number" min={1} max={200} value={maxGenerate} onChange={(e) => setMaxGenerate(Math.max(1, Number(e.target.value) || 1))} className={`${FIELD} w-20 flex-shrink-0`} />
            </label>
            <button type="button" onClick={() => void run()} disabled={loading} className={PRIMARY_BTN}>
              {loading ? <Spinner className="w-3.5 h-3.5 animate-spin" /> : <Target className="w-3.5 h-3.5" />}Run
            </button>
          </div>
          <div>
            <button type="button" onClick={() => setShowExternal((o) => !o)} className="text-[11px] font-medium text-[#6D28D9] hover:text-[#5B21B6]">
              {showExternal ? '− Hide' : '+ Add'} external coverage report (optional)
            </button>
            {showExternal && (
              <div className="mt-1.5">
                <span className={LABEL}>External coverage report (optional: lcov.info or istanbul json-summary)</span>
                <textarea
                  value={externalCoverage}
                  onChange={(e) => setExternalCoverage(e.target.value)}
                  rows={4}
                  placeholder="Paste lcov.info or istanbul coverage-summary.json…"
                  className={`${INPUT} font-mono text-[11px] resize-y`}
                />
              </div>
            )}
          </div>
        </div>

        {s && (
          <div className="flex flex-wrap items-center gap-3 px-4 py-2.5 border-b border-[#EDE9FE] flex-shrink-0">
            <div className="flex items-baseline gap-1.5">
              <span className="text-[22px] font-bold tabular-nums text-[#6D28D9] leading-none">{s.responseCoveragePct}%</span>
              <span className="text-[10.5px] text-gray-400">response coverage</span>
            </div>
            <Stat label="probes" value={s.probes} />
            <Stat label="uncovered" value={s.branchesIdentified} />
            <Stat label="generated" value={s.generated} />
            <span className={`ml-auto inline-flex items-center gap-1 px-2 py-0.5 rounded-md border text-[10px] font-semibold ${s.usedLlm ? 'text-[#6D28D9] bg-[#F5F3FF] border-[#DDD6FE]' : 'text-gray-500 bg-gray-50 border-gray-200'}`}>
              <Sparkles className="w-3 h-3" />{s.usedLlm ? 'AI' : 'template'}
            </span>
          </div>
        )}

        <div className="flex-1 overflow-y-auto min-h-0">
          {loading ? (
            <div className="flex items-center justify-center gap-2 py-16 text-[12px] text-gray-500"><Spinner className="w-4 h-4 animate-spin text-[#7C3AED]" />Probing {endpoints.length} endpoint{endpoints.length === 1 ? '' : 's'} and mapping coverage…</div>
          ) : error ? (
            <div className="flex items-start gap-2 m-4 px-4 py-2.5 bg-red-50 border border-red-200 rounded-lg"><AlertTriangle className="w-4 h-4 text-red-500 flex-shrink-0 mt-px" /><p className="text-[12px] text-red-700 min-w-0">{error}</p></div>
          ) : result ? (
            <div>
              {ext && (
                <div className="px-4 py-3 border-b border-gray-100">
                  <div className="flex items-center gap-2 mb-2">
                    <FileCode2 className="w-3.5 h-3.5 text-[#7C3AED]" />
                    <span className="text-[11px] font-semibold text-gray-700 uppercase tracking-wide">External coverage</span>
                    <span className="text-[10px] text-gray-400">{ext.source} · {ext.totalFiles} file{ext.totalFiles === 1 ? '' : 's'}</span>
                  </div>
                  <div className="flex flex-wrap gap-3 mb-2">
                    {ext.linesPct !== undefined && <Stat label="lines" value={`${ext.linesPct}%`} />}
                    {ext.branchesPct !== undefined && <Stat label="branches" value={`${ext.branchesPct}%`} />}
                    {ext.functionsPct !== undefined && <Stat label="functions" value={`${ext.functionsPct}%`} />}
                  </div>
                  {ext.uncoveredFiles.length > 0 && (
                    <div className="space-y-1">
                      <span className="text-[10.5px] font-medium text-gray-500">Least-covered files</span>
                      {ext.uncoveredFiles.slice(0, 8).map((f, i) => (
                        <div key={i} className="flex items-center gap-2 text-[11px]">
                          <span className="font-mono text-gray-700 min-w-0 truncate flex-1" title={f.file}>{f.file}</span>
                          {f.uncoveredLines !== undefined && <span className="text-gray-400 flex-shrink-0 tabular-nums">{f.uncoveredLines} uncovered</span>}
                          {f.branchesPct !== undefined && <span className="text-gray-400 flex-shrink-0 tabular-nums">{f.branchesPct}% br</span>}
                        </div>
                      ))}
                    </div>
                  )}
                  {ext.mappedEndpoints.length > 0 && (
                    <div className="mt-2 space-y-1">
                      <span className="text-[10.5px] font-medium text-gray-500">Mapped to endpoints</span>
                      {ext.mappedEndpoints.slice(0, 8).map((m, i) => (
                        <div key={i} className="flex items-center gap-1.5 text-[11px] text-gray-600">
                          <span className="font-mono text-gray-500 min-w-0 truncate" title={m.file}>{m.file}</span>
                          <span className="text-gray-300">→</span>
                          <span className="font-mono text-gray-700 min-w-0 truncate" title={m.endpoint}>{m.endpoint}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {/* Uncovered branches */}
              {result.uncovered.length > 0 && (
                <div>
                  <div className="px-4 pt-3 pb-1 text-[11px] font-semibold text-gray-700 uppercase tracking-wide">Uncovered branches ({result.uncovered.length})</div>
                  <div className="divide-y divide-gray-100">{result.uncovered.map((u, i) => <UncoveredRow key={i} u={u} />)}</div>
                </div>
              )}

              {/* Generated tests */}
              {result.generated.length > 0 && (
                <div className="border-t border-gray-100">
                  <div className="px-4 pt-3 pb-1 text-[11px] font-semibold text-gray-700 uppercase tracking-wide">Generated tests ({result.generated.length})</div>
                  <div className="divide-y divide-gray-100">{result.generated.map((g, i) => <GeneratedRow key={i} g={g} />)}</div>
                </div>
              )}

              {result.uncovered.length === 0 && result.generated.length === 0 && (
                <div className="flex items-center gap-2 m-4 px-4 py-3 bg-emerald-50 border border-emerald-200 rounded-lg text-[12px] text-emerald-800"><CheckCircle2 className="w-4 h-4 text-emerald-600" />No coverage gaps flagged — the probed responses exercised every branch the scan could identify.</div>
              )}

              {/* Signals */}
              {result.signals.length > 0 && (
                <details className="px-4 py-3 border-t border-gray-100">
                  <summary className="cursor-pointer text-[11px] font-medium text-gray-500 hover:text-[#7C3AED]">Signals ({result.signals.length})</summary>
                  <div className="mt-2 divide-y divide-gray-50">{result.signals.map((sig, i) => <SignalRow key={i} sig={sig} />)}</div>
                </details>
              )}

              {/* Notes */}
              {result.notes.length > 0 && (
                <div className="px-4 py-3 border-t border-gray-100 space-y-0.5">
                  {result.notes.map((n, i) => <p key={i} className="text-[10.5px] text-gray-400 leading-relaxed">{n}</p>)}
                </div>
              )}
            </div>
          ) : (
            <div className="flex flex-col items-center justify-center gap-2 py-16 px-6 text-center">
              <Radar className="w-7 h-7 text-gray-300" />
              <p className="text-[12.5px] text-gray-500 max-w-sm">Probe the catalogue to learn which status classes and response fields it already returns, then let the scan draft tests for the branches nobody has hit yet. Press <span className="text-gray-700 font-medium">Run</span> to start.</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number | string }) {
  return (
    <span className="inline-flex items-baseline gap-1 text-[11px] text-gray-500">
      <span className="text-[13px] font-semibold tabular-nums text-gray-800">{value}</span>
      {label}
    </span>
  );
}

function UncoveredRow({ u }: { u: CovUncovered }) {
  return (
    <div className="px-4 py-2.5">
      <div className="flex items-center gap-2">
        <span className="text-[9px] font-bold uppercase px-1.5 py-0.5 rounded border flex-shrink-0 text-amber-700 bg-amber-50 border-amber-200">{KIND_LABELS[u.kind]}</span>
        <MethodBadge method={u.method} />
        <span className="text-[11.5px] font-mono text-gray-700 min-w-0 flex-1 truncate" title={u.url}>{u.signature}</span>
      </div>
      <p className="mt-1 ml-1 text-[11px] text-gray-600 leading-relaxed">{u.detail}</p>
      <p className="mt-0.5 ml-1 text-[11px] text-gray-400 leading-relaxed">{u.suggestion}</p>
    </div>
  );
}

function GeneratedRow({ g }: { g: CovGenerated }) {
  return (
    <div className="px-4 py-2.5">
      <div className="flex items-center gap-2">
        <MethodBadge method={g.method} />
        <span className="text-[11.5px] font-medium text-gray-700 min-w-0 flex-1 truncate" title={g.url}>{g.title}</span>
        {g.expectedStatusClass && <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-[#F5F3FF] border border-[#DDD6FE] text-[#6D28D9] flex-shrink-0">{g.expectedStatusClass}</span>}
      </div>
      <p className="mt-1 ml-1 text-[11px] text-gray-600 leading-relaxed">{g.rationale}</p>
      <p className="mt-0.5 ml-1 text-[11px] text-gray-400 leading-relaxed">targets: {g.targets}</p>
      {g.queryParams && g.queryParams.length > 0 && (
        <div className="mt-1 ml-1 flex flex-wrap gap-1.5">
          {g.queryParams.map((p, i) => (
            <span key={i} className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-gray-50 border border-gray-200 text-gray-600">{p.name}={p.value}</span>
          ))}
        </div>
      )}
    </div>
  );
}

function SignalRow({ sig }: { sig: CovSignal }) {
  return (
    <div className="py-2">
      <div className="flex items-center gap-2">
        <MethodBadge method={sig.method} />
        <span className="text-[11px] font-mono text-gray-700 min-w-0 flex-1 truncate" title={sig.url}>{sig.signature}</span>
        {sig.branchComplete && <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500 flex-shrink-0" />}
      </div>
      <div className="mt-1 ml-1 flex flex-wrap items-center gap-2 text-[10.5px] text-gray-500">
        <span>{sig.statusClassesSeen.join(', ') || 'no responses'}</span>
        <span className="text-gray-300">·</span>
        <span>{sig.fieldsSeen.length} field{sig.fieldsSeen.length === 1 ? '' : 's'}</span>
        <span className="text-gray-300">·</span>
        <span>{sig.probes} probe{sig.probes === 1 ? '' : 's'}</span>
      </div>
    </div>
  );
}
