/**
 * UnifiedCanvas — one ordered test case that crosses layers.
 *
 * Most tools verify a single layer: hit an API, or query a DB, or drive a UI.
 * Real behaviour lives in the seams between them — a POST that should land a
 * row that should then show on a page. This canvas lets the tester interleave
 * API, DB and UI steps in a single ordered list, pass values forward as
 * {{vars}}, and read back one coherent pass/fail. The flagship coherence
 * feature: opt-in, standalone, and colour-coded by layer so the shape of the
 * journey is legible at a glance (API = violet, DB = blue, UI = emerald).
 */
import { useRef, useState } from 'react';
import {
  Combine, Globe, Database, MonitorSmartphone, Plus, Trash2, X, CheckCircle2, XCircle,
  AlertTriangle, ArrowDown, ChevronUp, ChevronDown, ChevronRight, Check, Play,
} from 'lucide-react';
import Spinner from '@/components/feedback/Spinner';
import {
  runUnifiedTest,
  type UnifiedStep,
  type UnifiedStepResult,
  type UnifiedResult,
  type UnifiedStepKind,
  type UnifiedUiCheck,
} from '@/services/api';
import { MethodBadge } from './primitives';
import { CARD, STRIP, INPUT, FIELD, LABEL, PRIMARY_BTN, SECONDARY_BTN } from './format';
import type { CatalogEndpoint } from './types';

/* ── Layer identity — colour + icon per layer, defined once ── */
type LayerMeta = { label: string; Icon: typeof Globe; chip: string; bar: string };
const LAYER: Record<UnifiedStepKind, LayerMeta> = {
  api: { label: 'API', Icon: Globe, chip: 'text-[#6D28D9] bg-[#F5F3FF] border-[#DDD6FE]', bar: 'border-l-[#7C3AED]' },
  db: { label: 'DB', Icon: Database, chip: 'text-blue-700 bg-blue-50 border-blue-200', bar: 'border-l-blue-400' },
  ui: { label: 'UI', Icon: MonitorSmartphone, chip: 'text-emerald-700 bg-emerald-50 border-emerald-200', bar: 'border-l-emerald-400' },
};
const KINDS: UnifiedStepKind[] = ['api', 'db', 'ui'];

/* ── Local editing model ──────────────────────────────────────────────────
   Steps carry a stable key, an expand toggle and string mirrors of numeric
   fields (so a half-typed "20" survives a keystroke). Converted to the API
   shapes at run time. */
type StepExtract = NonNullable<UnifiedStep['extract']>[number];
type ExtractFrom = StepExtract['from'];
type CheckOp = NonNullable<NonNullable<UnifiedStep['checks']>[number]['op']>;
type UiCheckKind = UnifiedUiCheck['kind'];

interface EditExtract { _k: string; name: string; from: ExtractFrom; path: string }
interface EditCheck { _k: string; path: string; op: CheckOp; value: string }
interface EditUiCheck { _k: string; kind: UiCheckKind; selector: string; text: string; count: string }
interface EditStep {
  _k: string;
  kind: UnifiedStepKind;
  name: string;
  open: boolean;
  /* API */
  method: string;
  url: string;
  body: string;
  expectStatus: string;
  extract: EditExtract[];
  checks: EditCheck[];
  /* DB */
  query: string;
  minRows: string;
  maxRows: string;
  column: string;
  equals: string;
  /* UI */
  uiUrl: string;
  uiChecks: EditUiCheck[];
}
interface EditVar { _k: string; key: string; value: string }

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];
const WRITE = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const isWrite = (m: string) => WRITE.has((m || '').toUpperCase());
const EXTRACT_FROMS: ExtractFrom[] = ['body', 'header', 'status'];
const CHECK_OPS: CheckOp[] = ['exists', 'equals', 'contains', 'notEquals'];

const UI_CHECK_LABELS: Record<UiCheckKind, string> = {
  textPresent: 'Text present',
  textAbsent: 'Text absent',
  selectorPresent: 'Selector present',
  selectorCount: 'Selector count',
  titleContains: 'Title contains',
  urlContains: 'URL contains',
};
const UI_CHECK_KINDS = Object.keys(UI_CHECK_LABELS) as UiCheckKind[];
const uiNeedsSelector = (k: UiCheckKind) => k === 'selectorPresent' || k === 'selectorCount';
const uiNeedsText = (k: UiCheckKind) => k === 'textPresent' || k === 'textAbsent' || k === 'titleContains' || k === 'urlContains';

const clip = (s: string, n = 48) => (s.length > n ? `${s.slice(0, n)}…` : s);
const toInt = (s: string): number | undefined => {
  const n = parseInt(s.trim(), 10);
  return Number.isFinite(n) ? n : undefined;
};
function errMsg(e: unknown, fallback: string): string {
  const x = e as { response?: { data?: { error?: string } }; message?: string } | null;
  return x?.response?.data?.error || x?.message || fallback;
}

/* ── Edit → API conversion ── */
function toApiStep(s: EditStep): UnifiedStep {
  const base: UnifiedStep = { id: s._k, kind: s.kind };
  if (s.name.trim()) base.name = s.name.trim();

  if (s.kind === 'api') {
    base.method = s.method;
    base.url = s.url;
    if (isWrite(s.method) && s.body.trim()) base.body = s.body;
    const es = toInt(s.expectStatus);
    if (es !== undefined) base.expectStatus = es;
    const ex: StepExtract[] = s.extract
      .filter((x) => x.name.trim())
      .map((x) => ({ name: x.name.trim(), from: x.from, ...(x.path.trim() ? { path: x.path.trim() } : {}) }));
    if (ex.length) base.extract = ex;
    const ck = s.checks
      .filter((c) => c.path.trim())
      .map((c) => ({ path: c.path.trim(), op: c.op, ...(c.op !== 'exists' && c.value.trim() ? { value: c.value.trim() } : {}) }));
    if (ck.length) base.checks = ck;
  } else if (s.kind === 'db') {
    base.query = s.query;
    const expect: NonNullable<UnifiedStep['expect']> = {};
    const min = toInt(s.minRows);
    const max = toInt(s.maxRows);
    if (min !== undefined) expect.minRows = min;
    if (max !== undefined) expect.maxRows = max;
    if (s.column.trim()) expect.column = s.column.trim();
    if (s.equals.trim()) expect.equals = s.equals.trim();
    if (Object.keys(expect).length) base.expect = expect;
  } else {
    base.uiUrl = s.uiUrl;
    const uc: UnifiedUiCheck[] = s.uiChecks.map((c) => ({
      kind: c.kind,
      ...(uiNeedsSelector(c.kind) && c.selector.trim() ? { selector: c.selector.trim() } : {}),
      ...(uiNeedsText(c.kind) && c.text.trim() ? { text: c.text } : {}),
      ...(c.kind === 'selectorCount' ? { count: toInt(c.count) ?? 0 } : {}),
    }));
    if (uc.length) base.uiChecks = uc;
  }
  return base;
}

/* ── Small presentational helpers ── */
function LayerBadge({ kind }: { kind: UnifiedStepKind }) {
  const m = LAYER[kind];
  return (
    <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded border text-[10px] font-bold tracking-tight ${m.chip}`}>
      <m.Icon className="w-3 h-3" />{m.label}
    </span>
  );
}

function VarChips({ vars }: { vars: Record<string, string> }) {
  const keys = Object.keys(vars);
  if (!keys.length) return null;
  return (
    <div className="flex flex-wrap gap-1">
      {keys.map((k) => (
        <span key={k} className="inline-flex items-center px-1.5 py-0.5 rounded border text-[10px] font-mono bg-[#F5F3FF] border-[#DDD6FE] text-[#6D28D9]">{k} = {clip(vars[k])}</span>
      ))}
    </div>
  );
}

/* ── One step result card ── */
function StepResultCard({ r }: { r: UnifiedStepResult }) {
  const m = LAYER[r.kind];
  return (
    <div className={`${CARD} overflow-hidden border-l-4 ${m.bar}`}>
      <div className="flex items-center gap-2 px-3 py-2">
        <span className="text-[11px] font-mono text-gray-400 w-5 text-center flex-shrink-0">{r.index + 1}</span>
        {r.ok ? <CheckCircle2 className="w-4 h-4 text-emerald-600 flex-shrink-0" /> : <XCircle className="w-4 h-4 text-red-600 flex-shrink-0" />}
        <LayerBadge kind={r.kind} />
        <span className="text-[12px] font-medium text-gray-800 truncate">{r.name || LAYER[r.kind].label}</span>
        <span className="ml-auto text-[11px] text-gray-400 flex-shrink-0">{r.status ?? '—'}</span>
      </div>
      <div className="px-3 pb-2.5 space-y-1.5">
        {r.detail && <p className={`text-[11.5px] ${r.ok ? 'text-gray-500' : 'text-red-600'}`}>{r.detail}</p>}
        {r.extracted && Object.keys(r.extracted).length > 0 && <VarChips vars={r.extracted} />}
        {r.checks.map((c, i) => (
          <div key={i} className="flex items-start gap-1.5 text-[11.5px]">
            {c.pass ? <Check className="w-3.5 h-3.5 text-emerald-600 mt-px flex-shrink-0" /> : <X className="w-3.5 h-3.5 text-red-500 mt-px flex-shrink-0" />}
            <span className={c.pass ? 'text-gray-600' : 'text-red-600'}>{c.label}{c.detail ? <span className="text-gray-400"> · {c.detail}</span> : null}</span>
          </div>
        ))}
        {r.screenshotBase64 && (
          <img src={`data:image/png;base64,${r.screenshotBase64}`} alt="UI step screenshot" className="mt-1 rounded border border-gray-200 max-h-48 w-auto" />
        )}
      </div>
    </div>
  );
}

export default function UnifiedCanvas({ endpoints, onClose }: { endpoints: CatalogEndpoint[]; onClose: () => void }) {
  const counter = useRef(0);
  const nextId = (p: string) => `${p}-${Date.now().toString(36)}-${(counter.current++).toString(36)}`;

  const blankStep = (kind: UnifiedStepKind): EditStep => ({
    _k: nextId('s'), kind, name: '', open: true,
    method: 'GET', url: '', body: '', expectStatus: '', extract: [], checks: [],
    query: '', minRows: '', maxRows: '', column: '', equals: '',
    uiUrl: '', uiChecks: [],
  });

  const [steps, setSteps] = useState<EditStep[]>(() => [blankStep('api')]);
  const [vars, setVars] = useState<EditVar[]>([]);
  const [allowWrites, setAllowWrites] = useState(false);
  const [result, setResult] = useState<UnifiedResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const hasWrites = steps.some((s) => s.kind === 'api' && isWrite(s.method));

  /* ── Step mutations ── */
  const patch = (k: string, p: Partial<EditStep>) => setSteps((prev) => prev.map((s) => (s._k === k ? { ...s, ...p } : s)));
  const addStep = (kind: UnifiedStepKind) => setSteps((prev) => [...prev, blankStep(kind)]);
  const removeStep = (k: string) => setSteps((prev) => prev.filter((s) => s._k !== k));
  const move = (i: number, dir: -1 | 1) => setSteps((prev) => {
    const j = i + dir;
    if (j < 0 || j >= prev.length) return prev;
    const next = prev.slice();
    [next[i], next[j]] = [next[j], next[i]];
    return next;
  });

  /* ── Sub-editor mutations (API extract / checks, UI checks) ── */
  const addExtract = (s: EditStep) => patch(s._k, { extract: [...s.extract, { _k: nextId('x'), name: '', from: 'body', path: '' }] });
  const setExtract = (s: EditStep, k: string, p: Partial<EditExtract>) => patch(s._k, { extract: s.extract.map((x) => (x._k === k ? { ...x, ...p } : x)) });
  const delExtract = (s: EditStep, k: string) => patch(s._k, { extract: s.extract.filter((x) => x._k !== k) });
  const addCheck = (s: EditStep) => patch(s._k, { checks: [...s.checks, { _k: nextId('c'), path: '', op: 'exists', value: '' }] });
  const setCheck = (s: EditStep, k: string, p: Partial<EditCheck>) => patch(s._k, { checks: s.checks.map((c) => (c._k === k ? { ...c, ...p } : c)) });
  const delCheck = (s: EditStep, k: string) => patch(s._k, { checks: s.checks.filter((c) => c._k !== k) });
  const addUiCheck = (s: EditStep) => patch(s._k, { uiChecks: [...s.uiChecks, { _k: nextId('u'), kind: 'textPresent', selector: '', text: '', count: '' }] });
  const setUiCheck = (s: EditStep, k: string, p: Partial<EditUiCheck>) => patch(s._k, { uiChecks: s.uiChecks.map((c) => (c._k === k ? { ...c, ...p } : c)) });
  const delUiCheck = (s: EditStep, k: string) => patch(s._k, { uiChecks: s.uiChecks.filter((c) => c._k !== k) });

  /* ── Shared variables ── */
  const addVar = () => setVars((prev) => [...prev, { _k: nextId('v'), key: '', value: '' }]);
  const setVar = (k: string, p: Partial<EditVar>) => setVars((prev) => prev.map((v) => (v._k === k ? { ...v, ...p } : v)));
  const delVar = (k: string) => setVars((prev) => prev.filter((v) => v._k !== k));

  const run = async () => {
    if (!steps.length) { setError('Add at least one step.'); return; }
    if (hasWrites && !allowWrites) { setError('This test has write-method API steps. Tick “Allow writes” to run it.'); return; }
    setLoading(true); setError(''); setResult(null);
    try {
      const bag: Record<string, string> = {};
      vars.filter((v) => v.key.trim()).forEach((v) => { bag[v.key.trim()] = v.value; });
      setResult(await runUnifiedTest({
        steps: steps.map(toApiStep),
        variables: Object.keys(bag).length ? bag : undefined,
        allowWrites,
      }));
    } catch (e) {
      setError(errMsg(e, 'Unified test run failed.'));
    } finally { setLoading(false); }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-[#1E1B4B]/30 backdrop-blur-sm p-4" onClick={onClose}>
      <div className={`${CARD} w-full max-w-3xl max-h-[88vh] flex flex-col overflow-hidden`} onClick={(e) => e.stopPropagation()}>
        <div className={`flex items-center gap-2 px-4 h-12 border-b border-[#EDE9FE] flex-shrink-0 ${STRIP}`}>
          <Combine className="w-4 h-4 text-[#7C3AED]" />
          <h3 className="text-[13px] font-semibold text-gray-900">Unified cross-layer test</h3>
          <span className="text-[11px] text-gray-400">{steps.length} step{steps.length === 1 ? '' : 's'} · API + DB + UI in one case</span>
          <button type="button" onClick={onClose} className="ml-auto p-1.5 rounded-md text-gray-400 hover:text-[#7C3AED] hover:bg-[#F5F3FF]"><X className="w-4 h-4" /></button>
        </div>

        <div className="p-4 space-y-3 overflow-y-auto min-h-0">
          {/* Initial variables */}
          <div>
            <div className="flex items-center justify-between mb-1">
              <span className={`${LABEL} mb-0`}>Initial variables (optional · usable as <code className="font-mono text-[#6D28D9] normal-case">{'{{name}}'}</code>)</span>
              <button type="button" onClick={addVar} className="text-[11px] text-[#7C3AED] hover:underline inline-flex items-center gap-0.5"><Plus className="w-3 h-3" />Add</button>
            </div>
            {vars.length === 0 ? (
              <p className="text-[11px] text-gray-400">Seed a value here, or capture one with an API-step extract — later steps reference it in any url, body or query.</p>
            ) : (
              <div className="space-y-1.5">
                {vars.map((v) => (
                  <div key={v._k} className="flex gap-1.5 items-center">
                    <input value={v.key} onChange={(e) => setVar(v._k, { key: e.target.value })} placeholder="name" className={`${FIELD} w-32 flex-shrink-0`} />
                    <input value={v.value} onChange={(e) => setVar(v._k, { value: e.target.value })} placeholder="value" className={`${FIELD} flex-1 min-w-0`} />
                    <button type="button" onClick={() => delVar(v._k)} className="p-1 text-gray-400 hover:text-red-500 flex-shrink-0"><Trash2 className="w-3.5 h-3.5" /></button>
                  </div>
                ))}
              </div>
            )}
          </div>

          {error && <div className="flex items-start gap-2 px-3 py-2 bg-red-50 border border-red-200 rounded-lg"><AlertTriangle className="w-4 h-4 text-red-500 flex-shrink-0 mt-px" /><p className="text-[12px] text-red-700">{error}</p></div>}

          {/* The canvas */}
          <div>
            {steps.map((s, i) => {
              const m = LAYER[s.kind];
              return (
                <div key={s._k}>
                  <div className={`${CARD} overflow-hidden border-l-4 ${m.bar}`}>
                    {/* Step header */}
                    <div className="flex items-center gap-2 px-3 h-11">
                      <span className="text-[11px] font-mono text-gray-400 w-5 text-center flex-shrink-0">{i + 1}</span>
                      {/* Kind selector */}
                      <div className="inline-flex rounded-md border border-gray-200 overflow-hidden flex-shrink-0">
                        {KINDS.map((k) => {
                          const km = LAYER[k];
                          const active = s.kind === k;
                          return (
                            <button key={k} type="button" onClick={() => patch(s._k, { kind: k })}
                              className={`inline-flex items-center gap-1 px-2 py-1 text-[10.5px] font-semibold border-r border-gray-200 last:border-r-0 transition-colors ${active ? km.chip : 'text-gray-400 bg-white hover:text-gray-600'}`}>
                              <km.Icon className="w-3 h-3" />{km.label}
                            </button>
                          );
                        })}
                      </div>
                      {s.kind === 'api' && <MethodBadge method={s.method} />}
                      <input value={s.name} onChange={(e) => patch(s._k, { name: e.target.value })} placeholder="Step name" className={`${FIELD} w-32 flex-shrink-0`} />
                      <span className="text-[11.5px] font-mono text-gray-500 truncate flex-1 min-w-0">
                        {s.kind === 'api' ? (s.url || <span className="text-gray-300">no URL yet</span>)
                          : s.kind === 'db' ? (s.query ? clip(s.query, 40) : <span className="text-gray-300">no query yet</span>)
                          : (s.uiUrl || <span className="text-gray-300">no page URL yet</span>)}
                      </span>
                      <button type="button" onClick={() => move(i, -1)} disabled={i === 0} className="p-1 rounded text-gray-400 hover:text-[#7C3AED] disabled:opacity-30"><ChevronUp className="w-3.5 h-3.5" /></button>
                      <button type="button" onClick={() => move(i, 1)} disabled={i === steps.length - 1} className="p-1 rounded text-gray-400 hover:text-[#7C3AED] disabled:opacity-30"><ChevronDown className="w-3.5 h-3.5" /></button>
                      <button type="button" onClick={() => patch(s._k, { open: !s.open })} className="p-1 rounded text-gray-400 hover:text-[#7C3AED]" title={s.open ? 'Collapse' : 'Edit'}><ChevronRight className={`w-3.5 h-3.5 transition-transform ${s.open ? 'rotate-90' : ''}`} /></button>
                      <button type="button" onClick={() => removeStep(s._k)} disabled={steps.length <= 1} className="p-1 rounded text-gray-400 hover:text-red-500 disabled:opacity-30"><Trash2 className="w-3.5 h-3.5" /></button>
                    </div>

                    {/* Step body */}
                    {s.open && (
                      <div className="px-3 pb-3 pt-2 space-y-3 border-t border-gray-100 bg-gray-50/40">
                        {s.kind === 'api' && (
                          <>
                            <div className="flex gap-2">
                              <div>
                                <label className={LABEL}>Method</label>
                                <select value={s.method} onChange={(e) => patch(s._k, { method: e.target.value })} className={FIELD}>
                                  {METHODS.map((mm) => <option key={mm} value={mm}>{mm}</option>)}
                                </select>
                              </div>
                              <div>
                                <label className={LABEL}>Expect status</label>
                                <input value={s.expectStatus} onChange={(e) => patch(s._k, { expectStatus: e.target.value })} placeholder="any" inputMode="numeric" className={`${FIELD} w-20`} />
                              </div>
                              <div className="flex-1 min-w-0">
                                <label className={LABEL}>URL</label>
                                <input value={s.url} onChange={(e) => patch(s._k, { url: e.target.value })} placeholder="{{baseUrl}}/v1/users/{{id}}" className={INPUT} />
                              </div>
                            </div>
                            {endpoints.length > 0 && (
                              <select value="" onChange={(e) => { const ep = endpoints.find((x) => x.id === e.target.value); if (ep) patch(s._k, { method: ep.method || 'GET', url: ep.url || '', body: ep.body || s.body }); }} className={`${FIELD} w-full`}>
                                <option value="">Prefill from endpoint…</option>
                                {endpoints.map((ep) => <option key={ep.id} value={ep.id}>{ep.method} {ep.url}</option>)}
                              </select>
                            )}
                            {isWrite(s.method) && (
                              <div>
                                <label className={LABEL}>Body</label>
                                <textarea value={s.body} onChange={(e) => patch(s._k, { body: e.target.value })} rows={3} placeholder={'{ "name": "{{name}}" }'} className={`${INPUT} font-mono resize-y`} />
                              </div>
                            )}
                            {/* Extract */}
                            <div>
                              <div className="flex items-center justify-between mb-1">
                                <span className={`${LABEL} mb-0`}>Extract → variables</span>
                                <button type="button" onClick={() => addExtract(s)} className="text-[11px] text-[#7C3AED] hover:underline inline-flex items-center gap-0.5"><Plus className="w-3 h-3" />Add</button>
                              </div>
                              {s.extract.length === 0 && <p className="text-[11px] text-gray-400">Capture a value from this response for later steps.</p>}
                              <div className="space-y-1.5">
                                {s.extract.map((x) => (
                                  <div key={x._k} className="flex gap-1.5 items-center">
                                    <input value={x.name} onChange={(e) => setExtract(s, x._k, { name: e.target.value })} placeholder="name" className={`${FIELD} w-28 flex-shrink-0`} />
                                    <select value={x.from} onChange={(e) => setExtract(s, x._k, { from: e.target.value as ExtractFrom })} className={`${FIELD} flex-shrink-0`}>
                                      {EXTRACT_FROMS.map((f) => <option key={f} value={f}>{f}</option>)}
                                    </select>
                                    <input value={x.path} onChange={(e) => setExtract(s, x._k, { path: e.target.value })} placeholder={x.from === 'header' ? 'Header-Name' : x.from === 'status' ? 'whole status' : 'data.0.id'} disabled={x.from === 'status'} className={`${FIELD} flex-1 min-w-0`} />
                                    <button type="button" onClick={() => delExtract(s, x._k)} className="p-1 text-gray-400 hover:text-red-500 flex-shrink-0"><Trash2 className="w-3.5 h-3.5" /></button>
                                  </div>
                                ))}
                              </div>
                            </div>
                            {/* Checks */}
                            <div>
                              <div className="flex items-center justify-between mb-1">
                                <span className={`${LABEL} mb-0`}>Checks</span>
                                <button type="button" onClick={() => addCheck(s)} className="text-[11px] text-[#7C3AED] hover:underline inline-flex items-center gap-0.5"><Plus className="w-3 h-3" />Add</button>
                              </div>
                              {s.checks.length === 0 && <p className="text-[11px] text-gray-400">Assert something about the response body.</p>}
                              <div className="space-y-1.5">
                                {s.checks.map((c) => (
                                  <div key={c._k} className="flex gap-1.5 items-center">
                                    <input value={c.path} onChange={(e) => setCheck(s, c._k, { path: e.target.value })} placeholder="data.0.id" className={`${FIELD} flex-1 min-w-0`} />
                                    <select value={c.op} onChange={(e) => setCheck(s, c._k, { op: e.target.value as CheckOp })} className={`${FIELD} flex-shrink-0`}>
                                      {CHECK_OPS.map((o) => <option key={o} value={o}>{o}</option>)}
                                    </select>
                                    {c.op !== 'exists' && <input value={c.value} onChange={(e) => setCheck(s, c._k, { value: e.target.value })} placeholder="expected value" className={`${FIELD} w-32 flex-shrink-0`} />}
                                    <button type="button" onClick={() => delCheck(s, c._k)} className="p-1 text-gray-400 hover:text-red-500 flex-shrink-0"><Trash2 className="w-3.5 h-3.5" /></button>
                                  </div>
                                ))}
                              </div>
                            </div>
                          </>
                        )}

                        {s.kind === 'db' && (
                          <>
                            <div>
                              <label className={LABEL}>SELECT query (may use {'{{vars}}'})</label>
                              <textarea value={s.query} onChange={(e) => patch(s._k, { query: e.target.value })} rows={3} placeholder={'SELECT id, status FROM orders WHERE id = {{orderId}}'} className={`${INPUT} font-mono resize-y`} />
                            </div>
                            <div>
                              <label className={LABEL}>Expect</label>
                              <div className="flex flex-wrap gap-1.5 items-center">
                                <input value={s.minRows} onChange={(e) => patch(s._k, { minRows: e.target.value })} placeholder="min rows" inputMode="numeric" className={`${FIELD} w-24`} />
                                <input value={s.maxRows} onChange={(e) => patch(s._k, { maxRows: e.target.value })} placeholder="max rows" inputMode="numeric" className={`${FIELD} w-24`} />
                                <input value={s.column} onChange={(e) => patch(s._k, { column: e.target.value })} placeholder="column" className={`${FIELD} w-32`} />
                                <input value={s.equals} onChange={(e) => patch(s._k, { equals: e.target.value })} placeholder="equals (first row)" className={`${FIELD} flex-1 min-w-0`} />
                              </div>
                              <p className="text-[11px] text-gray-400 mt-1">Read-only SELECT. Leave a field blank to skip that assertion.</p>
                            </div>
                          </>
                        )}

                        {s.kind === 'ui' && (
                          <>
                            <div>
                              <label className={LABEL}>Page URL (may use {'{{vars}}'})</label>
                              <input value={s.uiUrl} onChange={(e) => patch(s._k, { uiUrl: e.target.value })} placeholder="{{appBaseUrl}}/orders/{{orderId}}" className={INPUT} />
                            </div>
                            <div>
                              <div className="flex items-center justify-between mb-1">
                                <span className={`${LABEL} mb-0`}>UI checks</span>
                                <button type="button" onClick={() => addUiCheck(s)} className="text-[11px] text-[#7C3AED] hover:underline inline-flex items-center gap-0.5"><Plus className="w-3 h-3" />Add</button>
                              </div>
                              {s.uiChecks.length === 0 && <p className="text-[11px] text-gray-400">Assert what the rendered page should show after the earlier steps ran.</p>}
                              <div className="space-y-1.5">
                                {s.uiChecks.map((c) => (
                                  <div key={c._k} className="flex gap-1.5 items-center">
                                    <select value={c.kind} onChange={(e) => setUiCheck(s, c._k, { kind: e.target.value as UiCheckKind })} className={`${FIELD} flex-shrink-0`}>
                                      {UI_CHECK_KINDS.map((k) => <option key={k} value={k}>{UI_CHECK_LABELS[k]}</option>)}
                                    </select>
                                    {uiNeedsSelector(c.kind) && <input value={c.selector} onChange={(e) => setUiCheck(s, c._k, { selector: e.target.value })} placeholder=".order-status" className={`${FIELD} flex-1 min-w-0 font-mono`} />}
                                    {uiNeedsText(c.kind) && <input value={c.text} onChange={(e) => setUiCheck(s, c._k, { text: e.target.value })} placeholder={c.kind === 'urlContains' ? '/confirmed' : 'expected text'} className={`${FIELD} flex-1 min-w-0`} />}
                                    {c.kind === 'selectorCount' && <input value={c.count} onChange={(e) => setUiCheck(s, c._k, { count: e.target.value })} placeholder="count" inputMode="numeric" className={`${FIELD} w-20 flex-shrink-0`} />}
                                    <button type="button" onClick={() => delUiCheck(s, c._k)} className="p-1 text-gray-400 hover:text-red-500 flex-shrink-0"><Trash2 className="w-3.5 h-3.5" /></button>
                                  </div>
                                ))}
                              </div>
                            </div>
                          </>
                        )}
                      </div>
                    )}
                  </div>
                  {i < steps.length - 1 && (
                    <div className="flex justify-center py-1"><ArrowDown className="w-3.5 h-3.5 text-gray-300" /></div>
                  )}
                </div>
              );
            })}
          </div>

          {/* Add-step row */}
          <div className="flex flex-wrap items-center gap-2">
            {KINDS.map((k) => (
              <button key={k} type="button" onClick={() => addStep(k)} className={SECONDARY_BTN}>
                <Plus className="w-3.5 h-3.5" />{LAYER[k].label}
              </button>
            ))}
          </div>

          {/* Controls */}
          <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
            <label className={`flex items-center gap-1.5 text-[12px] ${hasWrites ? 'text-gray-700' : 'text-gray-400'} cursor-pointer`}>
              <input type="checkbox" checked={allowWrites} onChange={(e) => setAllowWrites(e.target.checked)} className="rounded border-gray-300 text-[#7C3AED] focus:ring-[#A5B4FC]" />
              Allow writes{hasWrites && <span className="text-amber-600"> · required, this test has write API steps</span>}
            </label>
            <button type="button" onClick={() => void run()} disabled={loading} className={PRIMARY_BTN}>
              {loading ? <Spinner className="w-3.5 h-3.5 animate-spin" /> : <Play className="w-3.5 h-3.5" />}Run test
            </button>
          </div>

          {/* Result */}
          {loading && (
            <div className="flex items-center justify-center gap-2 py-10 text-[12px] text-gray-500"><Spinner className="w-4 h-4 animate-spin text-[#7C3AED]" />Running {steps.length} step{steps.length === 1 ? '' : 's'} across layers…</div>
          )}
          {!loading && result && (
            <div className="space-y-2 pt-1">
              <div className={`flex items-center gap-2 px-3 py-2.5 rounded-lg border ${result.passed ? 'bg-emerald-50 border-emerald-200' : 'bg-red-50 border-red-200'}`}>
                {result.passed ? <CheckCircle2 className="w-5 h-5 text-emerald-600" /> : <XCircle className="w-5 h-5 text-red-600" />}
                <div className={`text-[13px] font-semibold ${result.passed ? 'text-emerald-700' : 'text-red-700'}`}>{result.passed ? 'Test passed' : 'Test failed'}</div>
                <span className="ml-auto text-[11px] text-gray-500">{result.stepsRun}/{result.stepsTotal} steps · {Math.round(result.durationMs)}ms</span>
              </div>
              <VarChips vars={result.variables} />
              {result.steps.map((r) => <StepResultCard key={r.index} r={r} />)}
              {result.notes.length > 0 && (
                <ul className="space-y-0.5 pt-1">
                  {result.notes.map((n, i) => <li key={i} className="text-[11px] text-gray-400">· {n}</li>)}
                </ul>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
