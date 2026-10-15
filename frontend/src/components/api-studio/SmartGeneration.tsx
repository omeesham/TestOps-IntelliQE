/**
 * SmartGeneration — white-box stateful sequences + assertion mutation grading.
 *
 * Two tools that share a modal. "Stateful generation" plans RESTler/EvoMaster-style
 * dependency sequences (a create hands an id to the reads/updates that follow),
 * from the catalogue or a pasted OpenAPI spec. "Mutation testing" grades how good
 * a test's assertions are: it mutates a sample response and reports which mutants
 * the assertions caught (killed) and which slipped through (survived).
 */
import { useState } from 'react';
import {
  Workflow, X, Plus, Trash2, Boxes, FlaskConical, Play, ArrowRight,
  AlertTriangle, CheckCircle2, Lightbulb, ChevronRight,
} from 'lucide-react';
import Spinner from '@/components/feedback/Spinner';
import {
  generateStatefulSequences,
  gradeAssertionMutations,
  type StatefulGenResult,
  type StatefulSequence,
  type GenSeqStep,
  type MutationResult,
  type MutationAssertion,
} from '@/services/api';
import { MethodBadge } from './primitives';
import { CARD, STRIP, INPUT, FIELD, LABEL, PRIMARY_BTN, SECONDARY_BTN } from './format';
import type { CatalogEndpoint } from './types';

/* ── small helpers ──────────────────────────────────────────────────────── */

function gradeCls(g: MutationResult['grade']): string {
  switch (g) {
    case 'A': return 'text-emerald-700 bg-emerald-50 border-emerald-200';
    case 'B': return 'text-green-700 bg-green-50 border-green-200';
    case 'C': return 'text-amber-700 bg-amber-50 border-amber-200';
    case 'D': return 'text-orange-700 bg-orange-50 border-orange-200';
    default: return 'text-red-700 bg-red-50 border-red-200';
  }
}

const JSONPATH_OPS: NonNullable<MutationAssertion['op']>[] = ['exists', 'equals', 'notEquals', 'contains', 'type', 'gt', 'lt'];

function tabCls(active: boolean): string {
  return `inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[12px] font-medium transition-colors ${
    active ? 'bg-[#7C3AED] text-white' : 'bg-white text-gray-600 border border-gray-200 hover:text-[#7C3AED]'
  }`;
}

function toggleCls(active: boolean): string {
  return `px-2.5 py-1 rounded-md text-[11.5px] font-medium border transition-colors ${
    active ? 'bg-[#7C3AED] text-white border-transparent' : 'bg-white text-gray-600 border-gray-200 hover:text-[#7C3AED]'
  }`;
}

/* ── component ──────────────────────────────────────────────────────────── */

export default function SmartGeneration({ endpoints, onClose }: { endpoints: CatalogEndpoint[]; onClose: () => void }) {
  const [tab, setTab] = useState<'stateful' | 'mutation'>('stateful');

  /* Tab 1 — stateful generation */
  const [source, setSource] = useState<'catalogue' | 'spec'>('catalogue');
  const [spec, setSpec] = useState<string>('');
  const [baseUrl, setBaseUrl] = useState<string>('');
  const [maxSequences, setMaxSequences] = useState<number>(20);
  const [genBusy, setGenBusy] = useState<boolean>(false);
  const [genError, setGenError] = useState<string>('');
  const [genResult, setGenResult] = useState<StatefulGenResult | null>(null);

  /* Tab 2 — mutation testing */
  const [status, setStatus] = useState<number>(200);
  const [body, setBody] = useState<string>('');
  const [assertions, setAssertions] = useState<MutationAssertion[]>([{ kind: 'status', value: 200 }]);
  const [mutBusy, setMutBusy] = useState<boolean>(false);
  const [mutError, setMutError] = useState<string>('');
  const [mutResult, setMutResult] = useState<MutationResult | null>(null);
  const [showMutants, setShowMutants] = useState<boolean>(false);

  const generate = async () => {
    setGenBusy(true); setGenError(''); setGenResult(null);
    try {
      const useSpec = source === 'spec' && spec.trim().length > 0;
      const input = useSpec
        ? { spec, baseUrl: baseUrl.trim() || undefined, maxSequences }
        : {
            endpoints: endpoints.map((e) => ({ method: e.method, url: e.url, title: e.title })),
            baseUrl: baseUrl.trim() || undefined,
            maxSequences,
          };
      setGenResult(await generateStatefulSequences(input));
    } catch (err: any) {
      setGenError(err?.response?.data?.error || err?.message || 'Sequence generation failed.');
    } finally { setGenBusy(false); }
  };

  const grade = async () => {
    setMutBusy(true); setMutError(''); setMutResult(null); setShowMutants(false);
    try {
      setMutResult(await gradeAssertionMutations({ status, body }, assertions));
    } catch (err: any) {
      setMutError(err?.response?.data?.error || err?.message || 'Assertion grading failed.');
    } finally { setMutBusy(false); }
  };

  const updateAssertion = (i: number, patch: Partial<MutationAssertion>) =>
    setAssertions((prev) => prev.map((a, idx) => (idx === i ? { ...a, ...patch } : a)));

  const onKindChange = (i: number, kind: MutationAssertion['kind']) => {
    const next: MutationAssertion =
      kind === 'status' ? { kind, value: status }
      : kind === 'jsonpath' ? { kind, path: '', op: 'exists' }
      : { kind, value: '' };
    setAssertions((prev) => prev.map((a, idx) => (idx === i ? next : a)));
  };

  const addAssertion = () => setAssertions((prev) => [...prev, { kind: 'jsonpath', path: '', op: 'exists' }]);
  const removeAssertion = (i: number) => setAssertions((prev) => prev.filter((_, idx) => idx !== i));

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-[#1E1B4B]/45 backdrop-blur-md p-4" onClick={onClose}>
      <div className={`${CARD} w-full max-w-3xl max-h-[88vh] flex flex-col overflow-hidden`} onClick={(e) => e.stopPropagation()}>
        <div className={`flex items-center gap-2 px-4 h-12 border-b border-[#EDE9FE] flex-shrink-0 ${STRIP}`}>
          <Workflow className="w-4 h-4 text-[#7C3AED]" />
          <h3 className="text-[13px] font-semibold text-gray-900">Smart generation</h3>
          <span className="text-[11px] text-gray-400">Stateful white-box sequences · mutation testing</span>
          <button type="button" onClick={onClose} className="ml-auto p-1.5 rounded-md text-gray-400 hover:text-[#7C3AED] hover:bg-[#F5F3FF]"><X className="w-4 h-4" /></button>
        </div>

        <div className="p-4 space-y-3 overflow-y-auto min-h-0">
          <div className="flex gap-1.5">
            <button type="button" onClick={() => setTab('stateful')} className={tabCls(tab === 'stateful')}>
              <Boxes className="w-3.5 h-3.5" /> Stateful generation
            </button>
            <button type="button" onClick={() => setTab('mutation')} className={tabCls(tab === 'mutation')}>
              <FlaskConical className="w-3.5 h-3.5" /> Mutation testing
            </button>
          </div>

          {tab === 'stateful' ? (
            <StatefulTab
              endpoints={endpoints}
              source={source} setSource={setSource}
              spec={spec} setSpec={setSpec}
              baseUrl={baseUrl} setBaseUrl={setBaseUrl}
              maxSequences={maxSequences} setMaxSequences={setMaxSequences}
              busy={genBusy} error={genError} result={genResult}
              onGenerate={() => void generate()}
            />
          ) : (
            <MutationTab
              status={status} setStatus={setStatus}
              body={body} setBody={setBody}
              assertions={assertions}
              onKindChange={onKindChange} updateAssertion={updateAssertion}
              addAssertion={addAssertion} removeAssertion={removeAssertion}
              busy={mutBusy} error={mutError} result={mutResult}
              showMutants={showMutants} setShowMutants={setShowMutants}
              onGrade={() => void grade()}
            />
          )}
        </div>
      </div>
    </div>
  );
}

/* ══════════════ Tab 1 — Stateful generation ══════════════ */

function StatefulTab({
  endpoints, source, setSource, spec, setSpec, baseUrl, setBaseUrl,
  maxSequences, setMaxSequences, busy, error, result, onGenerate,
}: {
  endpoints: CatalogEndpoint[];
  source: 'catalogue' | 'spec';
  setSource: (v: 'catalogue' | 'spec') => void;
  spec: string; setSpec: (v: string) => void;
  baseUrl: string; setBaseUrl: (v: string) => void;
  maxSequences: number; setMaxSequences: (v: number) => void;
  busy: boolean; error: string; result: StatefulGenResult | null;
  onGenerate: () => void;
}) {
  return (
    <div className="space-y-3">
      {error && (
        <div className="flex items-start gap-2 px-3 py-2 bg-red-50 border border-red-200 rounded-lg">
          <AlertTriangle className="w-4 h-4 text-red-500 flex-shrink-0 mt-px" />
          <p className="text-[12px] text-red-700 min-w-0 whitespace-pre-wrap break-words">{error}</p>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-1.5">
        <button type="button" onClick={() => setSource('catalogue')} className={toggleCls(source === 'catalogue')}>
          From catalogue ({endpoints.length})
        </button>
        <button type="button" onClick={() => setSource('spec')} className={toggleCls(source === 'spec')}>
          From OpenAPI spec
        </button>
      </div>

      {source === 'spec' && (
        <div>
          <label className={LABEL}>OpenAPI / Swagger spec</label>
          <textarea
            value={spec}
            onChange={(e) => setSpec(e.target.value)}
            rows={6}
            placeholder="Paste an OpenAPI JSON or YAML spec…"
            className={`${INPUT} font-mono text-[11.5px] resize-y`}
          />
        </div>
      )}

      <div className="flex flex-wrap items-end gap-3">
        <div className="flex-1 min-w-[12rem]">
          <label className={LABEL}>Base URL (optional)</label>
          <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://api.example.com" className={INPUT} />
        </div>
        <div className="w-28">
          <label className={LABEL}>Max sequences</label>
          <input
            type="number" min={1} max={100} value={maxSequences}
            onChange={(e) => setMaxSequences(Math.min(100, Math.max(1, Number(e.target.value) || 1)))}
            className={INPUT}
          />
        </div>
        <button type="button" onClick={onGenerate} disabled={busy} className={PRIMARY_BTN}>
          {busy ? <Spinner className="w-3.5 h-3.5" /> : <Workflow className="w-3.5 h-3.5" />}
          {busy ? 'Planning…' : 'Generate sequences'}
        </button>
      </div>

      {result && (
        <div className="space-y-3">
          <div className="text-[12px] font-medium text-gray-700 tabular-nums">
            {result.operations} operations · {result.resources.length} resources · {result.sequences.length} sequences
          </div>

          {result.dependencies.length > 0 && (
            <div className="rounded-lg border border-[#E9E5FB] bg-[#FCFBFF] p-3 space-y-1.5">
              <h4 className="text-[11px] font-semibold uppercase tracking-wide text-gray-500">Resource dependencies</h4>
              {result.dependencies.map((d, i) => (
                <div key={i} className="flex flex-wrap items-center gap-1.5 text-[11px] text-gray-600">
                  <span className="font-mono text-gray-800">{d.producer}</span>
                  <ArrowRight className="w-3 h-3 text-[#7C3AED]" />
                  <span className="px-1.5 py-0.5 rounded bg-[#F5F3FF] border border-[#DDD6FE] text-[10px] font-mono text-[#6D28D9]">via {d.via}</span>
                  <ArrowRight className="w-3 h-3 text-[#7C3AED]" />
                  <span className="font-mono text-gray-800">{d.consumer}</span>
                </div>
              ))}
            </div>
          )}

          <div className="space-y-2">
            {result.sequences.map((seq) => <SequenceCard key={seq.id} seq={seq} />)}
          </div>

          {result.notes.length > 0 && (
            <ul className="space-y-0.5">
              {result.notes.map((n, i) => <li key={i} className="text-[10.5px] text-gray-400 whitespace-pre-wrap break-words">{n}</li>)}
            </ul>
          )}
        </div>
      )}

      <p className="text-[10px] text-gray-400">White-box sequencing — threads ids a create returns through the reads, updates and deletes that depend on them.</p>
    </div>
  );
}

function SequenceCard({ seq }: { seq: StatefulSequence }) {
  return (
    <div className="rounded-lg border border-[#E9E5FB] bg-[#FCFBFF] p-3">
      <div className="flex flex-wrap items-baseline gap-2 mb-2">
        <span className="text-[12px] font-semibold text-gray-800 min-w-0">{seq.name}</span>
        <span className="font-mono text-[10.5px] text-[#6D28D9] px-1.5 py-0.5 rounded bg-[#F5F3FF] border border-[#DDD6FE]">{seq.target}</span>
      </div>
      <div className="space-y-1.5">
        {seq.steps.map((step, i) => <StepRow key={i} step={step} />)}
      </div>
      {seq.note && <p className="mt-2 text-[10.5px] text-gray-400 whitespace-pre-wrap break-words">{seq.note}</p>}
    </div>
  );
}

function StepRow({ step }: { step: GenSeqStep }) {
  return (
    <div className="flex flex-wrap items-baseline gap-2">
      <span className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-white border border-[#DDD6FE] text-[10px] font-mono font-semibold text-[#6D28D9] tabular-nums flex-shrink-0">{step.order}</span>
      <MethodBadge method={step.method} />
      <span className="font-mono text-[11.5px] text-gray-800 min-w-0">{step.path}</span>
      {step.name && <span className="text-[10.5px] text-gray-400 min-w-0">{step.name}</span>}
      {(step.extracts.length > 0 || step.injects.length > 0) && (
        <span className="flex flex-wrap items-center gap-1 w-full">
          {step.extracts.map((x, i) => (
            <span key={`x${i}`} className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded border text-[10px] font-mono text-emerald-700 bg-emerald-50 border-emerald-200">
              {x.var} ⇐ {x.field}
            </span>
          ))}
          {step.injects.map((inj, i) => (
            <span key={`i${i}`} className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded border text-[10px] font-mono text-[#6D28D9] bg-[#F5F3FF] border-[#DDD6FE]">
              {inj.param} ⇐ {`{{${inj.var}}}`}
            </span>
          ))}
        </span>
      )}
    </div>
  );
}

/* ══════════════ Tab 2 — Mutation testing ══════════════ */

function MutationTab({
  status, setStatus, body, setBody, assertions, onKindChange, updateAssertion,
  addAssertion, removeAssertion, busy, error, result, showMutants, setShowMutants, onGrade,
}: {
  status: number; setStatus: (v: number) => void;
  body: string; setBody: (v: string) => void;
  assertions: MutationAssertion[];
  onKindChange: (i: number, kind: MutationAssertion['kind']) => void;
  updateAssertion: (i: number, patch: Partial<MutationAssertion>) => void;
  addAssertion: () => void;
  removeAssertion: (i: number) => void;
  busy: boolean; error: string; result: MutationResult | null;
  showMutants: boolean; setShowMutants: (fn: (s: boolean) => boolean) => void;
  onGrade: () => void;
}) {
  return (
    <div className="space-y-3">
      {error && (
        <div className="flex items-start gap-2 px-3 py-2 bg-red-50 border border-red-200 rounded-lg">
          <AlertTriangle className="w-4 h-4 text-red-500 flex-shrink-0 mt-px" />
          <p className="text-[12px] text-red-700 min-w-0 whitespace-pre-wrap break-words">{error}</p>
        </div>
      )}

      <div className="flex flex-wrap items-end gap-3">
        <div className="w-28">
          <label className={LABEL}>Sample status</label>
          <input type="number" min={100} max={599} value={status} onChange={(e) => setStatus(Number(e.target.value) || 0)} className={INPUT} />
        </div>
      </div>
      <div>
        <label className={LABEL}>Sample response body</label>
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          rows={5}
          placeholder={'{\n  "id": 1,\n  "status": "active"\n}'}
          className={`${INPUT} font-mono text-[11.5px] resize-y`}
        />
      </div>

      <div className="space-y-1.5">
        <div className="flex items-center gap-2">
          <label className={`${LABEL} mb-0`}>Assertions</label>
          <button type="button" onClick={addAssertion} className="inline-flex items-center gap-1 px-2 py-0.5 text-[11px] font-medium rounded border border-gray-200 text-gray-600 hover:text-[#7C3AED] hover:border-[#DDD6FE]">
            <Plus className="w-3 h-3" /> Add
          </button>
        </div>
        {assertions.length === 0 && <p className="text-[11px] text-gray-400">No assertions — add at least one to grade.</p>}
        {assertions.map((a, i) => (
          <div key={i} className="flex flex-wrap items-center gap-1.5">
            <select value={a.kind} onChange={(e) => onKindChange(i, e.target.value as MutationAssertion['kind'])} className={`${FIELD} w-auto`}>
              <option value="status">status</option>
              <option value="jsonpath">jsonpath</option>
              <option value="bodyContains">bodyContains</option>
              <option value="bodyNotContains">bodyNotContains</option>
            </select>

            {a.kind === 'status' && (
              <input
                type="number" min={100} max={599}
                value={typeof a.value === 'number' ? a.value : Number(a.value) || ''}
                onChange={(e) => updateAssertion(i, { value: Number(e.target.value) || 0 })}
                placeholder="code" className={`${FIELD} w-24`}
              />
            )}

            {a.kind === 'jsonpath' && (
              <>
                <input value={a.path || ''} onChange={(e) => updateAssertion(i, { path: e.target.value })} placeholder="$.data.id" className={`${FIELD} flex-1 min-w-[8rem]`} />
                <select value={a.op || 'exists'} onChange={(e) => updateAssertion(i, { op: e.target.value as NonNullable<MutationAssertion['op']> })} className={`${FIELD} w-auto`}>
                  {JSONPATH_OPS.map((o) => <option key={o} value={o}>{o}</option>)}
                </select>
                {a.op !== 'exists' && (
                  <input value={a.value === undefined ? '' : String(a.value)} onChange={(e) => updateAssertion(i, { value: e.target.value })} placeholder="value" className={`${FIELD} w-28`} />
                )}
              </>
            )}

            {(a.kind === 'bodyContains' || a.kind === 'bodyNotContains') && (
              <input value={a.value === undefined ? '' : String(a.value)} onChange={(e) => updateAssertion(i, { value: e.target.value })} placeholder="substring" className={`${FIELD} flex-1 min-w-[8rem]`} />
            )}

            <button type="button" onClick={() => removeAssertion(i)} className="p-1.5 rounded-md text-gray-400 hover:text-red-600 hover:bg-red-50"><Trash2 className="w-3.5 h-3.5" /></button>
          </div>
        ))}
      </div>

      <div className="flex items-center justify-end gap-2">
        {busy && <span className="text-[11px] text-gray-400">grading mutants…</span>}
        <button type="button" onClick={onGrade} disabled={busy || assertions.length === 0} className={PRIMARY_BTN}>
          {busy ? <Spinner className="w-3.5 h-3.5" /> : <Play className="w-3.5 h-3.5" />}
          {busy ? 'Grading…' : 'Grade assertions'}
        </button>
      </div>

      {result && (
        result.gradable ? (
          <div className="space-y-3">
            <div className={`${CARD} p-4 flex items-center gap-4`}>
              <span className={`inline-flex items-center justify-center w-14 h-14 rounded-xl border text-3xl font-bold ${gradeCls(result.grade)}`}>{result.grade}</span>
              <div className="min-w-0">
                <div className="text-2xl font-bold text-gray-900 tabular-nums">{result.mutationScore}%</div>
                <div className="flex items-center gap-1 text-[12px] text-gray-500 tabular-nums">
                  <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500 flex-shrink-0" />
                  {result.killed} / {result.total} mutants killed · {result.survived} survived
                </div>
              </div>
            </div>

            {result.suggestions.length > 0 && (
              <div className="space-y-1">
                {result.suggestions.map((s, i) => (
                  <div key={i} className="flex items-start gap-2 text-[12px] text-gray-700">
                    <Lightbulb className="w-3.5 h-3.5 text-amber-500 flex-shrink-0 mt-px" />
                    <span className="min-w-0 whitespace-pre-wrap break-words">{s}</span>
                  </div>
                ))}
              </div>
            )}

            {result.survivors.length > 0 && (
              <div className="space-y-1.5">
                <h4 className="text-[11px] font-semibold uppercase tracking-wide text-gray-500">Gaps — mutations no assertion caught</h4>
                {result.survivors.map((m) => (
                  <div key={m.id} className="flex flex-wrap items-baseline gap-2 px-2.5 py-1.5 rounded-md border border-amber-200 bg-amber-50/60">
                    <span className="font-mono text-[10px] font-semibold text-amber-800 px-1.5 py-0.5 rounded bg-amber-100">{m.operator}</span>
                    <span className="font-mono text-[11px] text-gray-700">{m.target}</span>
                    <span className="text-[11px] text-gray-600 min-w-0 w-full whitespace-pre-wrap break-words">{m.description}</span>
                  </div>
                ))}
              </div>
            )}

            {result.mutants.length > 0 && (
              <div>
                <button type="button" onClick={() => setShowMutants((s) => !s)} className={SECONDARY_BTN}>
                  <ChevronRight className={`w-3.5 h-3.5 transition-transform ${showMutants ? 'rotate-90' : ''}`} />
                  {showMutants ? 'Hide' : 'Show'} all mutants ({result.mutants.length})
                </button>
                {showMutants && (
                  <div className="mt-2 space-y-1">
                    {result.mutants.map((m) => (
                      <div key={m.id} className="flex flex-wrap items-baseline gap-2 text-[11px]">
                        <span className={`inline-flex items-center px-1.5 py-0.5 rounded border text-[10px] font-medium ${m.survived ? 'text-amber-700 bg-amber-50 border-amber-200' : 'text-emerald-700 bg-emerald-50 border-emerald-200'}`}>
                          {m.survived ? 'survived' : 'killed'}
                        </span>
                        <span className="font-mono text-[10px] text-gray-500">{m.operator}</span>
                        <span className="font-mono text-gray-700 min-w-0">{m.target}</span>
                        {m.killedBy.length > 0 && (
                          <span className="flex flex-wrap gap-1">
                            {m.killedBy.map((k, ki) => (
                              <span key={ki} className="px-1.5 py-0.5 rounded bg-[#F5F3FF] border border-[#DDD6FE] text-[#6D28D9] text-[10px] font-mono">{k}</span>
                            ))}
                          </span>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {result.notes.length > 0 && (
              <ul className="space-y-0.5">
                {result.notes.map((n, i) => <li key={i} className="text-[10.5px] text-gray-400 whitespace-pre-wrap break-words">{n}</li>)}
              </ul>
            )}
          </div>
        ) : (
          <div className="px-3 py-2 bg-amber-50 border border-amber-200 rounded-lg">
            <div className="flex items-start gap-2">
              <AlertTriangle className="w-4 h-4 text-amber-500 flex-shrink-0 mt-px" />
              <div className="min-w-0">
                <p className="text-[12px] font-medium text-amber-800">Assertions fail on the real response — fix them first</p>
                <ul className="mt-1 space-y-0.5">
                  {result.failingOnOriginal.map((f) => (
                    <li key={f.index} className="text-[11px] text-amber-700 min-w-0 whitespace-pre-wrap break-words">#{f.index + 1}: {f.summary}</li>
                  ))}
                </ul>
              </div>
            </div>
          </div>
        )
      )}

      <p className="text-[10px] text-gray-400">Mutation testing grades assertion strength — it perturbs the sample response and counts how many mutants the assertions catch.</p>
    </div>
  );
}
