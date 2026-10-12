/**
 * MutationLive — assertion strength scored by live mutation grading.
 *
 * A green suite proves nothing if its assertions are too loose to notice a
 * broken response. The tester picks an endpoint and writes assertions about its
 * response; the tool fetches the LIVE response, injects a battery of faults
 * (mutants) into copies of it, and checks how many of those mutants the
 * assertions would CATCH. A high mutation score means the assertions actually
 * pin the contract down; survivors are the gaps. Opt-in, read-only probing.
 */
import { useState } from 'react';
import { FlaskConical, Plus, Trash2, X, AlertTriangle, CheckCircle2, ShieldCheck } from 'lucide-react';
import Spinner from '@/components/feedback/Spinner';
import { gradeAssertionsLive, type MutationAssertion, type MutationResult, type MutationMutant } from '@/services/api';
import { MethodBadge } from './primitives';
import { CARD, STRIP, INPUT, FIELD, LABEL, PRIMARY_BTN } from './format';
import type { CatalogEndpoint } from './types';

type AssertKind = MutationAssertion['kind'];
type AssertOp = NonNullable<MutationAssertion['op']>;
type AssertRow = { kind: AssertKind; path: string; op: AssertOp; value: string };

const OPS: AssertOp[] = ['exists', 'equals', 'notEquals', 'contains', 'type', 'gt', 'lt'];

const statusRow = (value: string): AssertRow => ({ kind: 'status', path: '', op: 'exists', value });
const jsonpathRow = (): AssertRow => ({ kind: 'jsonpath', path: '', op: 'exists', value: '' });

type LiveResult = MutationResult & { sample: { status?: number; bodyPreview: string } };

const GRADE_CLS: Record<MutationResult['grade'], string> = {
  A: 'text-emerald-700 bg-emerald-50 border-emerald-200',
  B: 'text-emerald-700 bg-emerald-50 border-emerald-200',
  C: 'text-amber-700 bg-amber-50 border-amber-200',
  D: 'text-amber-700 bg-amber-50 border-amber-200',
  F: 'text-red-700 bg-red-50 border-red-200',
};

export default function MutationLive({ endpoints, onClose }: { endpoints: CatalogEndpoint[]; onClose: () => void }) {
  const [activeId, setActiveId] = useState<string>(endpoints[0]?.id ?? '');
  const [rows, setRows] = useState<AssertRow[]>([statusRow('200'), jsonpathRow()]);
  const [result, setResult] = useState<LiveResult | null>(null);
  const [showBody, setShowBody] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const active = endpoints.find((e) => e.id === activeId) || null;

  const setRow = (i: number, patch: Partial<AssertRow>) => setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const addRow = () => setRows((rs) => [...rs, jsonpathRow()]);
  const delRow = (i: number) => setRows((rs) => rs.filter((_, j) => j !== i));

  const buildAssertions = (): MutationAssertion[] =>
    rows.map((r) => {
      if (r.kind === 'jsonpath') {
        const a: MutationAssertion = { kind: 'jsonpath', path: r.path, op: r.op };
        if (r.op !== 'exists') a.value = r.value;
        return a;
      }
      // status / bodyContains / bodyNotContains — a single expected value
      return { kind: r.kind, value: r.value };
    });

  const run = async () => {
    if (!active) return;
    setLoading(true); setError(''); setResult(null); setShowBody(false);
    try {
      const res = await gradeAssertionsLive(
        { method: active.method, url: active.url, headers: active.headers, auth: active.auth, body: active.body },
        buildAssertions(),
      );
      setResult(res);
    } catch (err: any) {
      setError(err?.response?.data?.error || err?.message || 'Live mutation grading failed.');
    } finally { setLoading(false); }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-[#1E1B4B]/30 backdrop-blur-sm p-4" onClick={onClose}>
      <div className={`${CARD} w-full max-w-3xl max-h-[88vh] flex flex-col overflow-hidden`} onClick={(e) => e.stopPropagation()}>
        <div className={`flex items-center gap-2 px-4 h-12 border-b border-[#EDE9FE] flex-shrink-0 ${STRIP}`}>
          <FlaskConical className="w-4 h-4 text-[#7C3AED]" />
          <h3 className="text-[13px] font-semibold text-gray-900">Assertion strength — live mutation grading</h3>
          <span className="text-[11px] text-gray-400">{rows.length} assertion{rows.length === 1 ? '' : 's'}</span>
          <button type="button" onClick={onClose} className="ml-auto p-1.5 rounded-md text-gray-400 hover:text-[#7C3AED] hover:bg-[#F5F3FF]"><X className="w-4 h-4" /></button>
        </div>

        {/* Endpoint + assertions */}
        <div className="px-4 py-3 border-b border-[#EDE9FE] flex-shrink-0 space-y-3">
          <div>
            <span className={LABEL}>Endpoint (its live response is graded)</span>
            <div className="flex items-center gap-2">
              {active && <MethodBadge method={active.method} />}
              <select value={activeId} onChange={(e) => { setActiveId(e.target.value); setResult(null); setError(''); }} className={INPUT}>
                {endpoints.length === 0 && <option value="">No endpoints in the catalogue</option>}
                {endpoints.map((e) => {
                  const label = `${e.method} ${e.url}`;
                  return <option key={e.id} value={e.id} title={label}>{label.length > 80 ? `${label.slice(0, 79)}…` : label}</option>;
                })}
              </select>
            </div>
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <span className={LABEL + ' mb-0'}>Assertions about the response</span>
              <button type="button" onClick={addRow} className="inline-flex items-center gap-1 text-[11px] font-semibold text-[#6D28D9] hover:text-[#5B21B6]"><Plus className="w-3.5 h-3.5" />Add assertion</button>
            </div>
            {rows.map((r, i) => (
              <div key={i} className="flex items-center gap-1.5">
                <select
                  value={r.kind}
                  onChange={(e) => setRow(i, { kind: e.target.value as AssertKind })}
                  className={`${FIELD} w-36 flex-shrink-0`}
                >
                  <option value="status">status</option>
                  <option value="jsonpath">jsonpath</option>
                  <option value="bodyContains">body contains</option>
                  <option value="bodyNotContains">body not contains</option>
                </select>

                {r.kind === 'jsonpath' && (
                  <>
                    <input value={r.path} onChange={(e) => setRow(i, { path: e.target.value })} placeholder="data.0.id" className={`${FIELD} flex-1 min-w-0 font-mono`} />
                    <select value={r.op} onChange={(e) => setRow(i, { op: e.target.value as AssertOp })} className={`${FIELD} w-24 flex-shrink-0`}>
                      {OPS.map((op) => <option key={op} value={op}>{op}</option>)}
                    </select>
                    {r.op !== 'exists' && <input value={r.value} onChange={(e) => setRow(i, { value: e.target.value })} placeholder="value" className={`${FIELD} w-28 flex-shrink-0`} />}
                  </>
                )}

                {r.kind === 'status' && (
                  <input value={r.value} onChange={(e) => setRow(i, { value: e.target.value })} placeholder="expected code" className={`${FIELD} w-32 flex-shrink-0`} inputMode="numeric" />
                )}

                {(r.kind === 'bodyContains' || r.kind === 'bodyNotContains') && (
                  <input value={r.value} onChange={(e) => setRow(i, { value: e.target.value })} placeholder="text to look for" className={`${FIELD} flex-1 min-w-0`} />
                )}

                <button type="button" onClick={() => delRow(i)} disabled={rows.length <= 1} className="p-1 rounded text-gray-300 hover:text-red-500 disabled:opacity-30 flex-shrink-0"><Trash2 className="w-3.5 h-3.5" /></button>
              </div>
            ))}
            <div className="flex items-center justify-end pt-1">
              <button type="button" onClick={() => void run()} disabled={loading || !active || rows.length === 0} className={PRIMARY_BTN}>
                {loading ? <Spinner className="w-3.5 h-3.5" /> : <ShieldCheck className="w-3.5 h-3.5" />}Grade
              </button>
            </div>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto min-h-0">
          {loading ? (
            <div className="flex items-center justify-center gap-2 py-16 text-[12px] text-gray-500"><Spinner className="w-4 h-4 text-[#7C3AED]" />Fetching the live response and injecting mutants…</div>
          ) : error ? (
            <div className="flex items-start gap-2 m-4 px-4 py-2.5 bg-red-50 border border-red-200 rounded-lg"><AlertTriangle className="w-4 h-4 text-red-500 flex-shrink-0 mt-px" /><p className="text-[12px] text-red-700 min-w-0">{error}</p></div>
          ) : result ? (
            <Results result={result} showBody={showBody} onToggleBody={() => setShowBody((b) => !b)} />
          ) : (
            <div className="flex flex-col items-center justify-center gap-2 py-16 px-6 text-center">
              <FlaskConical className="w-7 h-7 text-gray-300" />
              <p className="text-[12.5px] text-gray-500 max-w-sm">Describe what a correct response looks like, then <span className="text-gray-700 font-medium">Grade</span>. The tool fetches the live response, mutates it, and scores how many faults your assertions would catch.</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function Results({ result, showBody, onToggleBody }: { result: LiveResult; showBody: boolean; onToggleBody: () => void }) {
  const { sample } = result;
  const statusCls = sample.status
    ? String(sample.status)[0] === '2' ? 'text-emerald-700 bg-emerald-50 border-emerald-200'
      : String(sample.status)[0] === '4' ? 'text-amber-700 bg-amber-50 border-amber-200'
      : String(sample.status)[0] === '5' ? 'text-red-700 bg-red-50 border-red-200'
      : 'text-[#6B7280] bg-gray-50 border-gray-200'
    : 'text-[#6B7280] bg-gray-50 border-gray-200';

  return (
    <div className="p-4 space-y-4">
      {/* Sample */}
      <div>
        <div className="flex items-center gap-2">
          <span className="text-[11px] font-semibold text-gray-500 uppercase tracking-wide">Live response</span>
          <span className={`inline-flex items-center whitespace-nowrap px-1.5 py-0.5 rounded border font-mono text-[11px] font-semibold ${statusCls}`}>{sample.status ?? '—'}</span>
          <button type="button" onClick={onToggleBody} className="ml-auto text-[11px] font-medium text-[#6D28D9] hover:text-[#5B21B6]">{showBody ? 'Hide body' : 'Show body'}</button>
        </div>
        {showBody && (
          <pre className="mt-2 max-h-48 overflow-auto rounded-md bg-[#FCFBFF] border border-[#E4E0F5] p-2.5 font-mono text-[11px] leading-[1.5] text-gray-700 whitespace-pre-wrap break-words">{sample.bodyPreview || '(empty body)'}</pre>
        )}
      </div>

      {result.gradable === false ? (
        <div className="space-y-3">
          <div className="flex items-start gap-2 px-4 py-2.5 bg-amber-50 border border-amber-200 rounded-lg">
            <AlertTriangle className="w-4 h-4 text-amber-500 flex-shrink-0 mt-px" />
            <div className="min-w-0 text-[12px] text-amber-800">
              <p className="font-semibold">These assertions don't hold on the real response — nothing can be graded until they pass.</p>
              <ul className="mt-1.5 space-y-1">
                {result.failingOnOriginal.map((f) => (
                  <li key={f.index} className="flex gap-1.5"><span className="font-mono text-amber-600 flex-shrink-0">#{f.index + 1}</span><span className="min-w-0">{f.summary}</span></li>
                ))}
              </ul>
            </div>
          </div>
          <Suggestions suggestions={result.suggestions} />
          <Notes notes={result.notes} />
        </div>
      ) : (
        <div className="space-y-4">
          {/* Grade */}
          <div className="flex items-center gap-3 flex-wrap">
            <span className={`inline-flex items-center justify-center w-14 h-14 rounded-xl border text-3xl font-black ${GRADE_CLS[result.grade]}`}>{result.grade}</span>
            <div className="min-w-0">
              <div className="text-[18px] font-bold text-gray-900 tabular-nums">{result.mutationScore}%<span className="ml-1.5 text-[12px] font-medium text-gray-400">mutation score</span></div>
              <div className="text-[12px] text-gray-600 tabular-nums">
                <span className="text-emerald-700 font-semibold">{result.killed} killed</span>
                <span className="text-gray-300"> / </span>
                <span>{result.total} mutants</span>
                {result.survived > 0 && <span className="text-amber-700 font-semibold"> · {result.survived} survived</span>}
              </div>
            </div>
          </div>

          {/* Survivors — the gaps */}
          {result.survivors.length > 0 ? (
            <div>
              <div className="flex items-center gap-1.5 mb-1.5"><AlertTriangle className="w-3.5 h-3.5 text-amber-500" /><span className="text-[11px] font-semibold text-gray-600 uppercase tracking-wide">Faults your assertions missed</span></div>
              <div className="divide-y divide-gray-100 border border-gray-100 rounded-lg overflow-hidden">
                {result.survivors.map((m) => <MutantRow key={m.id} m={m} />)}
              </div>
            </div>
          ) : (
            <div className="flex items-center gap-2 px-4 py-3 bg-emerald-50 border border-emerald-200 rounded-lg text-[12px] text-emerald-800"><CheckCircle2 className="w-4 h-4 text-emerald-600 flex-shrink-0" />Every injected fault was caught — these assertions pin the response down tightly.</div>
          )}

          <Suggestions suggestions={result.suggestions} />

          {result.mutants.length > 0 && (
            <details className="border border-gray-100 rounded-lg overflow-hidden">
              <summary className="cursor-pointer px-3 py-2 text-[11px] font-medium text-gray-500 hover:text-[#7C3AED] bg-gray-50/60">All {result.mutants.length} mutant{result.mutants.length === 1 ? '' : 's'}</summary>
              <div className="divide-y divide-gray-50">{result.mutants.map((m) => <MutantRow key={m.id} m={m} showKillers />)}</div>
            </details>
          )}

          <Notes notes={result.notes} />
        </div>
      )}
    </div>
  );
}

function MutantRow({ m, showKillers = false }: { m: MutationMutant; showKillers?: boolean }) {
  return (
    <div className="px-3 py-2">
      <div className="flex items-center gap-2">
        <span className="text-[9px] font-bold uppercase px-1.5 py-0.5 rounded border flex-shrink-0 text-[#6D28D9] bg-[#F5F3FF] border-[#DDD6FE]">{m.operator}</span>
        <span className="text-[11px] font-mono text-gray-600 flex-shrink-0 truncate max-w-[180px]" title={m.target}>{m.target}</span>
        {m.survived
          ? <span className="ml-auto text-[9.5px] font-semibold text-amber-600 flex-shrink-0">survived</span>
          : <CheckCircle2 className="ml-auto w-3.5 h-3.5 text-emerald-500 flex-shrink-0" />}
      </div>
      <p className="mt-1 text-[11px] text-gray-600 leading-relaxed">{m.description}</p>
      {showKillers && m.killedBy.length > 0 && (
        <p className="mt-0.5 text-[10px] text-gray-400">caught by: {m.killedBy.join(', ')}</p>
      )}
    </div>
  );
}

function Suggestions({ suggestions }: { suggestions: string[] }) {
  if (!suggestions || suggestions.length === 0) return null;
  return (
    <div>
      <div className="flex items-center gap-1.5 mb-1.5"><ShieldCheck className="w-3.5 h-3.5 text-[#7C3AED]" /><span className="text-[11px] font-semibold text-gray-600 uppercase tracking-wide">Assertions to add</span></div>
      <ul className="space-y-1">
        {suggestions.map((s, i) => (
          <li key={i} className="flex gap-1.5 text-[12px] text-gray-700"><span className="text-[#A78BFA] flex-shrink-0">•</span><span className="min-w-0">{s}</span></li>
        ))}
      </ul>
    </div>
  );
}

function Notes({ notes }: { notes: string[] }) {
  if (!notes || notes.length === 0) return null;
  return (
    <div className="space-y-0.5 pt-1">
      {notes.map((n, i) => <p key={i} className="text-[10.5px] text-gray-400 leading-relaxed">{n}</p>)}
    </div>
  );
}
