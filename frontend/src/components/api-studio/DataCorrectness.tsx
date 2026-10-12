/**
 * DataCorrectness — distributed data-correctness after one write.
 *
 * A 2xx on a write proves the request was accepted, not that the change
 * actually landed everywhere it should. This tool fires ONE write, captures
 * values from its response into variables (e.g. the created id), optionally
 * waits for propagation, then verifies the change is visible across other API
 * reads AND direct DB SELECTs — flagging the classic eventual-consistency and
 * dual-write bugs a single call can't see. Opt-in: the write is a real request.
 */
import { useState } from 'react';
import { GitMerge, Database, Plus, Trash2, X, CheckCircle2, AlertTriangle, ArrowRight } from 'lucide-react';
import Spinner from '@/components/feedback/Spinner';
import {
  runDataCorrectness,
  type DcResult, type DcProbe, type DcWrite, type DcProbeResult,
  type DcExtract, type DcApiProbe, type DcDbProbe, type DcApiCheck,
} from '@/services/api';
import { MethodBadge } from './primitives';
import { CARD, STRIP, INPUT, FIELD, LABEL, PRIMARY_BTN, SECONDARY_BTN } from './format';
import type { CatalogEndpoint } from './types';

type CheckOp = NonNullable<DcApiCheck['op']>;
const CHECK_OPS: CheckOp[] = ['exists', 'equals', 'notEquals', 'contains'];

type ApiCheckRow = { path: string; op: CheckOp; value: string };
type ApiProbeRow = { kind: 'api'; name: string; method: string; url: string; expectStatus: string; checks: ApiCheckRow[] };
type DbProbeRow = { kind: 'db'; name: string; query: string; minRows: string; maxRows: string; column: string; equals: string };
type ProbeRow = ApiProbeRow | DbProbeRow;

const blankCheck = (): ApiCheckRow => ({ path: '', op: 'exists', value: '' });
const blankApiProbe = (n: number): ApiProbeRow => ({ kind: 'api', name: `probe-${n}`, method: 'GET', url: '', expectStatus: '', checks: [blankCheck()] });
const blankDbProbe = (n: number): DbProbeRow => ({ kind: 'db', name: `probe-${n}`, query: '', minRows: '', maxRows: '', column: '', equals: '' });

export default function DataCorrectness({ endpoints, onClose }: { endpoints: CatalogEndpoint[]; onClose: () => void }) {
  const [prefillId, setPrefillId] = useState('');
  const [writeMethod, setWriteMethod] = useState('POST');
  const [writeUrl, setWriteUrl] = useState('');
  const [writeBody, setWriteBody] = useState('');
  const [writeHeaders, setWriteHeaders] = useState<{ key: string; value: string }[]>([]);
  const [writeAuth, setWriteAuth] = useState<unknown>(undefined);
  const [extracts, setExtracts] = useState<DcExtract[]>([{ name: 'id', from: 'body', path: 'id' }]);
  const [probes, setProbes] = useState<ProbeRow[]>([blankApiProbe(1)]);
  const [allowWrites, setAllowWrites] = useState(false);
  const [waitMs, setWaitMs] = useState('');
  const [result, setResult] = useState<DcResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  /* ── Write prefill from a catalogue endpoint ── */
  const prefill = (id: string) => {
    setPrefillId(id);
    const ep = endpoints.find((e) => e.id === id);
    if (!ep) return;
    setWriteMethod(ep.method || 'POST');
    setWriteUrl(ep.url);
    setWriteBody(ep.body || '');
    setWriteHeaders(ep.headers || []);
    setWriteAuth(ep.auth);
  };

  /* ── Extract rows ── */
  const setExtract = (i: number, patch: Partial<DcExtract>) => setExtracts((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const addExtract = () => setExtracts((rs) => [...rs, { name: '', from: 'body', path: '' }]);
  const delExtract = (i: number) => setExtracts((rs) => rs.filter((_, j) => j !== i));

  /* ── Probe rows ── */
  const patchApi = (i: number, patch: Partial<ApiProbeRow>) => setProbes((ps) => ps.map((p, j) => (j === i && p.kind === 'api' ? { ...p, ...patch } : p)));
  const patchDb = (i: number, patch: Partial<DbProbeRow>) => setProbes((ps) => ps.map((p, j) => (j === i && p.kind === 'db' ? { ...p, ...patch } : p)));
  const addProbe = () => setProbes((ps) => [...ps, blankApiProbe(ps.length + 1)]);
  const delProbe = (i: number) => setProbes((ps) => ps.filter((_, j) => j !== i));
  const toggleKind = (i: number, kind: 'api' | 'db') => setProbes((ps) => ps.map((p, j) => {
    if (j !== i || p.kind === kind) return p;
    const fresh = kind === 'api' ? blankApiProbe(i + 1) : blankDbProbe(i + 1);
    return { ...fresh, name: p.name };
  }));
  const setCheck = (pi: number, ci: number, patch: Partial<ApiCheckRow>) =>
    setProbes((ps) => ps.map((p, j) => (j === pi && p.kind === 'api' ? { ...p, checks: p.checks.map((c, k) => (k === ci ? { ...c, ...patch } : c)) } : p)));
  const addCheck = (pi: number) => setProbes((ps) => ps.map((p, j) => (j === pi && p.kind === 'api' ? { ...p, checks: [...p.checks, blankCheck()] } : p)));
  const delCheck = (pi: number, ci: number) => setProbes((ps) => ps.map((p, j) => (j === pi && p.kind === 'api' ? { ...p, checks: p.checks.filter((_, k) => k !== ci) } : p)));

  /* ── Build the request payload ── */
  const buildWrite = (): DcWrite => {
    const w: DcWrite = { method: writeMethod.trim() || 'POST', url: writeUrl.trim() };
    if (writeHeaders.length) w.headers = writeHeaders;
    if (writeAuth !== undefined) w.auth = writeAuth;
    if (writeBody.trim()) w.body = writeBody;
    const ex = extracts
      .filter((r) => r.name.trim())
      .map((r): DcExtract => ({ name: r.name.trim(), from: r.from, path: r.path?.trim() || undefined }));
    if (ex.length) w.extract = ex;
    return w;
  };

  const buildProbes = (): DcProbe[] => probes
    .map((p): DcProbe | null => {
      if (p.kind === 'api') {
        if (!p.url.trim()) return null;
        const probe: DcApiProbe = { kind: 'api', url: p.url.trim(), method: p.method.trim() || 'GET' };
        if (p.name.trim()) probe.name = p.name.trim();
        if (p.expectStatus.trim() && Number.isFinite(Number(p.expectStatus))) probe.expectStatus = Number(p.expectStatus);
        const checks = p.checks
          .filter((c) => c.path.trim())
          .map((c): DcApiCheck => {
            const chk: DcApiCheck = { path: c.path.trim(), op: c.op };
            if (c.op !== 'exists') chk.value = c.value;
            return chk;
          });
        if (checks.length) probe.checks = checks;
        return probe;
      }
      if (!p.query.trim()) return null;
      const probe: DcDbProbe = { kind: 'db', query: p.query.trim() };
      if (p.name.trim()) probe.name = p.name.trim();
      const expect: NonNullable<DcDbProbe['expect']> = {};
      if (p.minRows.trim() && Number.isFinite(Number(p.minRows))) expect.minRows = Number(p.minRows);
      if (p.maxRows.trim() && Number.isFinite(Number(p.maxRows))) expect.maxRows = Number(p.maxRows);
      if (p.column.trim()) expect.column = p.column.trim();
      if (p.equals.trim()) expect.equals = p.equals;
      if (Object.keys(expect).length) probe.expect = expect;
      return probe;
    })
    .filter((p): p is DcProbe => p !== null);

  const run = async () => {
    setLoading(true); setError(''); setResult(null);
    try {
      const wait = waitMs.trim();
      const res = await runDataCorrectness({
        write: buildWrite(),
        probes: buildProbes(),
        waitMs: wait && Number.isFinite(Number(wait)) ? Number(wait) : undefined,
        allowWrites,
      });
      setResult(res);
    } catch (err: any) {
      setError(err?.response?.data?.error || err?.message || 'Data-correctness verification failed.');
    } finally { setLoading(false); }
  };

  const canRun = allowWrites && !!writeUrl.trim() && !loading;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-[#1E1B4B]/30 backdrop-blur-sm p-4" onClick={onClose}>
      <div className={`${CARD} w-full max-w-3xl max-h-[88vh] flex flex-col overflow-hidden`} onClick={(e) => e.stopPropagation()}>
        <div className={`flex items-center gap-2 px-4 h-12 border-b border-[#EDE9FE] flex-shrink-0 ${STRIP}`}>
          <GitMerge className="w-4 h-4 text-[#7C3AED]" />
          <h3 className="text-[13px] font-semibold text-gray-900">Distributed data-correctness</h3>
          <span className="text-[11px] text-gray-400">1 write · {probes.length} probe{probes.length === 1 ? '' : 's'}</span>
          <button type="button" onClick={onClose} className="ml-auto p-1.5 rounded-md text-gray-400 hover:text-[#7C3AED] hover:bg-[#F5F3FF]"><X className="w-4 h-4" /></button>
        </div>

        <div className="flex-1 overflow-y-auto min-h-0">
          {/* ── WRITE ── */}
          <div className="px-4 py-3 border-b border-[#EDE9FE] space-y-2.5">
            <div className="flex items-center justify-between">
              <span className={LABEL + ' mb-0'}>Write — the single mutation under test</span>
              <select
                value={prefillId}
                onChange={(e) => prefill(e.target.value)}
                className={`${FIELD} w-48 flex-shrink-0`}
                title="Prefill method, URL, headers and auth from a catalogue endpoint"
              >
                <option value="">Prefill from endpoint…</option>
                {endpoints.map((e) => {
                  const label = `${e.method} ${e.url}`;
                  return <option key={e.id} value={e.id} title={label}>{label.length > 70 ? `${label.slice(0, 69)}…` : label}</option>;
                })}
              </select>
            </div>
            <div className="flex items-center gap-1.5">
              <input value={writeMethod} onChange={(e) => setWriteMethod(e.target.value)} placeholder="POST" className={`${FIELD} w-24 flex-shrink-0 font-mono uppercase`} />
              <input value={writeUrl} onChange={(e) => setWriteUrl(e.target.value)} placeholder="https://api.example.com/orders" className={`${INPUT} font-mono`} />
            </div>
            <textarea value={writeBody} onChange={(e) => setWriteBody(e.target.value)} placeholder='{ "item": "widget", "qty": 2 }' rows={3} className={`${INPUT} font-mono resize-y`} />

            {/* Extract */}
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <span className="text-[10.5px] font-semibold text-gray-500">Extract variables from the response (reusable as <span className="font-mono text-[#6D28D9]">{'{{name}}'}</span> in probes)</span>
                <button type="button" onClick={addExtract} className="inline-flex items-center gap-1 text-[11px] font-semibold text-[#6D28D9] hover:text-[#5B21B6]"><Plus className="w-3.5 h-3.5" />Add</button>
              </div>
              {extracts.map((r, i) => (
                <div key={i} className="flex items-center gap-1.5">
                  <input value={r.name} onChange={(e) => setExtract(i, { name: e.target.value })} placeholder="id" className={`${FIELD} w-28 flex-shrink-0 font-mono`} />
                  <select value={r.from} onChange={(e) => setExtract(i, { from: e.target.value as DcExtract['from'] })} className={`${FIELD} w-24 flex-shrink-0`}>
                    <option value="body">body</option>
                    <option value="header">header</option>
                    <option value="status">status</option>
                  </select>
                  {r.from !== 'status' && (
                    <input value={r.path ?? ''} onChange={(e) => setExtract(i, { path: e.target.value })} placeholder={r.from === 'header' ? 'Location' : 'data.id'} className={`${FIELD} flex-1 min-w-0 font-mono`} />
                  )}
                  <button type="button" onClick={() => delExtract(i)} className="p-1 rounded text-gray-300 hover:text-red-500 flex-shrink-0"><Trash2 className="w-3.5 h-3.5" /></button>
                </div>
              ))}
            </div>
          </div>

          {/* ── PROBES ── */}
          <div className="px-4 py-3 border-b border-[#EDE9FE] space-y-2.5">
            <div className="flex items-center justify-between">
              <span className={LABEL + ' mb-0'}>Propagation probes — verify the write landed</span>
              <button type="button" onClick={addProbe} className={SECONDARY_BTN + ' !py-1 !text-[11px]'}><Plus className="w-3.5 h-3.5" />Add probe</button>
            </div>
            {probes.map((p, i) => (
              <div key={i} className="rounded-lg border border-[#EDE9FE] p-2.5 space-y-2">
                <div className="flex items-center gap-1.5">
                  <div className="inline-flex rounded-md border border-[#E4E0F5] overflow-hidden flex-shrink-0">
                    {(['api', 'db'] as const).map((k) => (
                      <button
                        key={k}
                        type="button"
                        onClick={() => toggleKind(i, k)}
                        className={`px-2 py-1 text-[10.5px] font-semibold uppercase ${p.kind === k ? 'bg-[#F5F3FF] text-[#6D28D9]' : 'bg-white text-gray-400 hover:text-[#7C3AED]'}`}
                      >
                        {k === 'db' ? <span className="inline-flex items-center gap-1"><Database className="w-3 h-3" />DB</span> : 'API'}
                      </button>
                    ))}
                  </div>
                  <input
                    value={p.name}
                    onChange={(e) => (p.kind === 'api' ? patchApi(i, { name: e.target.value }) : patchDb(i, { name: e.target.value }))}
                    placeholder="probe name"
                    className={`${FIELD} w-40 flex-shrink-0`}
                  />
                  <span className="flex-1" />
                  <button type="button" onClick={() => delProbe(i)} className="p-1 rounded text-gray-300 hover:text-red-500 flex-shrink-0"><Trash2 className="w-3.5 h-3.5" /></button>
                </div>

                {p.kind === 'api' ? (
                  <>
                    <div className="flex items-center gap-1.5">
                      <input value={p.method} onChange={(e) => patchApi(i, { method: e.target.value })} placeholder="GET" className={`${FIELD} w-20 flex-shrink-0 font-mono uppercase`} />
                      <input value={p.url} onChange={(e) => patchApi(i, { url: e.target.value })} placeholder="https://api.example.com/orders/{{id}}" className={`${INPUT} font-mono`} />
                      <input value={p.expectStatus} onChange={(e) => patchApi(i, { expectStatus: e.target.value })} placeholder="200" className={`${FIELD} w-16 flex-shrink-0 font-mono`} inputMode="numeric" />
                    </div>
                    <div className="space-y-1.5">
                      <div className="flex items-center justify-between">
                        <span className="text-[10.5px] font-medium text-gray-400">Response checks</span>
                        <button type="button" onClick={() => addCheck(i)} className="inline-flex items-center gap-1 text-[11px] font-semibold text-[#6D28D9] hover:text-[#5B21B6]"><Plus className="w-3.5 h-3.5" />Check</button>
                      </div>
                      {p.checks.map((c, ci) => (
                        <div key={ci} className="flex items-center gap-1.5">
                          <input value={c.path} onChange={(e) => setCheck(i, ci, { path: e.target.value })} placeholder="data.status" className={`${FIELD} flex-1 min-w-0 font-mono`} />
                          <select value={c.op} onChange={(e) => setCheck(i, ci, { op: e.target.value as CheckOp })} className={`${FIELD} w-24 flex-shrink-0`}>
                            {CHECK_OPS.map((op) => <option key={op} value={op}>{op}</option>)}
                          </select>
                          {c.op !== 'exists' && <input value={c.value} onChange={(e) => setCheck(i, ci, { value: e.target.value })} placeholder="value" className={`${FIELD} w-28 flex-shrink-0`} />}
                          <button type="button" onClick={() => delCheck(i, ci)} disabled={p.checks.length <= 1} className="p-1 rounded text-gray-300 hover:text-red-500 disabled:opacity-30 flex-shrink-0"><Trash2 className="w-3.5 h-3.5" /></button>
                        </div>
                      ))}
                    </div>
                  </>
                ) : (
                  <>
                    <textarea value={p.query} onChange={(e) => patchDb(i, { query: e.target.value })} placeholder="SELECT status FROM orders WHERE id = {{id}}" rows={2} className={`${INPUT} font-mono resize-y`} />
                    <div className="flex flex-wrap items-center gap-1.5">
                      <input value={p.minRows} onChange={(e) => patchDb(i, { minRows: e.target.value })} placeholder="min rows" className={`${FIELD} w-24 flex-shrink-0`} inputMode="numeric" />
                      <input value={p.maxRows} onChange={(e) => patchDb(i, { maxRows: e.target.value })} placeholder="max rows" className={`${FIELD} w-24 flex-shrink-0`} inputMode="numeric" />
                      <input value={p.column} onChange={(e) => patchDb(i, { column: e.target.value })} placeholder="column" className={`${FIELD} w-32 flex-shrink-0 font-mono`} />
                      <input value={p.equals} onChange={(e) => patchDb(i, { equals: e.target.value })} placeholder="equals value" className={`${FIELD} flex-1 min-w-[6rem]`} />
                    </div>
                  </>
                )}
              </div>
            ))}
          </div>

          {/* ── Controls ── */}
          <div className="px-4 py-3 flex flex-wrap items-center gap-x-4 gap-y-2">
            <label className="flex items-center gap-1.5 text-[11px] text-gray-500 cursor-pointer">
              <input type="checkbox" checked={allowWrites} onChange={(e) => setAllowWrites(e.target.checked)} className="rounded border-gray-300" />
              Allow the write to fire (sends a real {writeMethod.toUpperCase() || 'POST'} request)
            </label>
            <label className="flex items-center gap-1.5 text-[11px] text-gray-500">
              Wait for propagation
              <input value={waitMs} onChange={(e) => setWaitMs(e.target.value)} placeholder="0" className={`${FIELD} w-20`} inputMode="numeric" />
              ms
            </label>
            <button type="button" onClick={() => void run()} disabled={!canRun} className={PRIMARY_BTN + ' ml-auto'}>
              {loading ? <Spinner className="w-3.5 h-3.5 animate-spin" /> : <ArrowRight className="w-3.5 h-3.5" />}Verify propagation
            </button>
          </div>

          {/* ── RESULT ── */}
          {loading ? (
            <div className="flex items-center justify-center gap-2 py-16 text-[12px] text-gray-500"><Spinner className="w-4 h-4 animate-spin text-[#7C3AED]" />Firing the write and probing {probes.length} target{probes.length === 1 ? '' : 's'}…</div>
          ) : error ? (
            <div className="flex items-start gap-2 m-4 px-4 py-2.5 bg-red-50 border border-red-200 rounded-lg"><AlertTriangle className="w-4 h-4 text-red-500 flex-shrink-0 mt-px" /><p className="text-[12px] text-red-700 min-w-0">{error}</p></div>
          ) : result ? (
            <Result result={result} />
          ) : (
            <div className="flex flex-col items-center justify-center gap-2 py-14 px-6 text-center border-t border-[#EDE9FE]">
              <GitMerge className="w-7 h-7 text-gray-300" />
              <p className="text-[12.5px] text-gray-500 max-w-md">Define one write, capture the ids it returns, then add API and DB probes. Enable the write and <span className="text-gray-700 font-medium">Verify propagation</span> to confirm the change is visible everywhere it should be.</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/* ── Result rendering ─────────────────────────────────────────────────────── */

function Result({ result }: { result: DcResult }) {
  const { write } = result;
  return (
    <div className="border-t border-[#EDE9FE]">
      {/* Verdict */}
      <div className={`m-4 px-4 py-3 rounded-lg border flex items-center gap-2.5 ${result.propagated ? 'bg-emerald-50 border-emerald-200' : 'bg-red-50 border-red-200'}`}>
        {result.propagated ? <CheckCircle2 className="w-5 h-5 text-emerald-600 flex-shrink-0" /> : <AlertTriangle className="w-5 h-5 text-red-500 flex-shrink-0" />}
        <div className="min-w-0">
          <p className={`text-[14px] font-bold tracking-tight ${result.propagated ? 'text-emerald-800' : 'text-red-800'}`}>{result.propagated ? 'PROPAGATED' : 'NOT PROPAGATED'}</p>
          <p className="text-[11.5px] text-gray-600 tabular-nums">{result.summary.passed}/{result.summary.probes} probe{result.summary.probes === 1 ? '' : 's'} passed{result.summary.failed > 0 ? ` · ${result.summary.failed} failed` : ''} · waited {result.waitedMs}ms</p>
        </div>
      </div>

      {/* Write */}
      <div className="mx-4 mb-4">
        <div className="flex items-center gap-1.5 mb-1.5"><ArrowRight className="w-3.5 h-3.5 text-[#7C3AED]" /><span className="text-[11px] font-semibold text-gray-600 uppercase tracking-wide">Write</span></div>
        <div className="rounded-lg border border-gray-100 px-3 py-2.5">
          <div className="flex items-center gap-2">
            <MethodBadge method={write.method} />
            <span className="text-[11.5px] font-mono text-gray-700 min-w-0 flex-1 truncate" title={write.url}>{write.url}</span>
            {typeof write.status === 'number' && <StatusBadge code={write.status} />}
            {write.ok ? <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500 flex-shrink-0" /> : <AlertTriangle className="w-3.5 h-3.5 text-red-400 flex-shrink-0" />}
          </div>
          {write.error && <p className="mt-1 text-[11px] text-red-600 leading-relaxed">{write.error}</p>}
          {Object.keys(write.extracted).length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {Object.entries(write.extracted).map(([k, v]) => (
                <span key={k} className="inline-flex items-center gap-1 text-[10px] font-mono px-1.5 py-0.5 rounded bg-[#F5F3FF] border border-[#DDD6FE] text-[#6D28D9]">
                  <span className="font-semibold">{`{{${k}}}`}</span>
                  <span className="text-gray-500 truncate max-w-[160px]" title={v}>{v}</span>
                </span>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Probes */}
      {result.probes.length > 0 && (
        <div className="mx-4 mb-4">
          <div className="flex items-center gap-1.5 mb-1.5"><GitMerge className="w-3.5 h-3.5 text-[#7C3AED]" /><span className="text-[11px] font-semibold text-gray-600 uppercase tracking-wide">Probes</span></div>
          <div className="divide-y divide-gray-100 border border-gray-100 rounded-lg overflow-hidden">
            {result.probes.map((p, i) => <ProbeRowView key={i} p={p} />)}
          </div>
        </div>
      )}

      {/* Notes */}
      {result.notes.length > 0 && (
        <div className="mx-4 mb-4 space-y-0.5">
          {result.notes.map((n, i) => <p key={i} className="text-[10.5px] text-gray-400 leading-relaxed">{n}</p>)}
        </div>
      )}
    </div>
  );
}

function ProbeRowView({ p }: { p: DcProbeResult }) {
  return (
    <div className="px-3 py-2.5">
      <div className="flex items-center gap-2">
        <KindBadge kind={p.kind} />
        <span className="text-[11.5px] font-semibold text-gray-700 flex-shrink-0">{p.name}</span>
        {typeof p.status === 'number' && <StatusBadge code={p.status} />}
        <span className="text-[11px] font-mono text-gray-400 min-w-0 flex-1 truncate" title={p.target}>{p.target}</span>
        <span className={`text-[9px] font-bold uppercase px-1.5 py-0.5 rounded border flex-shrink-0 ${p.passed ? 'text-emerald-700 bg-emerald-50 border-emerald-200' : 'text-red-700 bg-red-50 border-red-200'}`}>{p.passed ? 'pass' : 'fail'}</span>
      </div>
      <p className="mt-1 text-[11px] text-gray-600 leading-relaxed">{p.detail}</p>
      {p.checks.length > 0 && (
        <div className="mt-1.5 space-y-1">
          {p.checks.map((c, i) => (
            <div key={i} className="flex items-start gap-1.5 text-[11px]">
              {c.pass ? <CheckCircle2 className="w-3 h-3 text-emerald-500 mt-px flex-shrink-0" /> : <AlertTriangle className="w-3 h-3 text-red-400 mt-px flex-shrink-0" />}
              <span className="text-gray-600 min-w-0"><span className="font-medium">{c.label}</span>{c.detail ? <span className="text-gray-400"> — {c.detail}</span> : null}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function KindBadge({ kind }: { kind: 'api' | 'db' }) {
  const base = 'inline-flex items-center gap-1 text-[9px] font-bold uppercase px-1.5 py-0.5 rounded border flex-shrink-0 text-[#6D28D9] bg-[#F5F3FF] border-[#DDD6FE]';
  return kind === 'db'
    ? <span className={base}><Database className="w-2.5 h-2.5" />DB</span>
    : <span className={base}>API</span>;
}

function StatusBadge({ code }: { code: number }) {
  const first = String(code)[0];
  const cls =
    first === '2' ? 'text-emerald-700 bg-emerald-50 border-emerald-200'
    : first === '4' ? 'text-amber-700 bg-amber-50 border-amber-200'
    : first === '5' ? 'text-red-700 bg-red-50 border-red-200'
    : 'text-[#6B7280] bg-gray-50 border-gray-200';
  return <span className={`inline-flex items-center whitespace-nowrap px-1.5 py-0.5 rounded border font-mono text-[10.5px] font-semibold flex-shrink-0 ${cls}`}>{code}</span>;
}
