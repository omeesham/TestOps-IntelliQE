/**
 * FlowBuilder — a no-code multi-step API journey builder.
 *
 * The user assembles an ordered list of HTTP steps. Each step can extract values
 * from its response into named variables that later steps reference as
 * `{{name}}` (in url, header values and body). The whole flow runs server-side
 * and the per-step results come back here. Opt-in and standalone — it live-probes
 * the API, touches no pipeline.
 */
import { useEffect, useRef, useState } from 'react';
import { Workflow, X, Play, Plus, Trash2, ChevronUp, ChevronDown, ChevronRight, Save, AlertTriangle, CheckCircle2, XCircle, Check } from 'lucide-react';
import Spinner from '@/components/feedback/Spinner';
import { useToast } from '@/components/feedback/ToastProvider';
import { listApiFlows, saveApiFlow, deleteApiFlow, runApiFlow, type SavedApiFlow, type FlowStep, type FlowCheck, type FlowRunResult } from '@/services/api';
import { MethodBadge } from './primitives';
import { CARD, STRIP, INPUT, FIELD, LABEL, PRIMARY_BTN, SECONDARY_BTN, formatDuration } from './format';
import type { CatalogEndpoint } from './types';
import type { Catalog } from './hooks/useCatalog';

/* ── Local editing model ──────────────────────────────────────────────────
   Steps and checks carry UI-only fields (a stable key, the expand toggle, and
   free-text mirrors of numeric fields so a half-typed "200," survives a
   keystroke). They are converted to the API shapes at save/run time. */

type ExtractRow = NonNullable<FlowStep['extract']>[number];

interface EditExtract { _k: string; name: string; from: ExtractRow['from']; path: string }
interface EditCheck { _k: string; kind: FlowCheck['kind']; oneOf: string; path: string; value: string; text: string; ms: string }
interface EditStep {
  id: string;
  name: string;
  method: string;
  url: string;
  headers: { key: string; value: string }[];
  auth?: { type: string; value?: string; headerName?: string };
  body: string;
  extract: EditExtract[];
  checks: EditCheck[];
  open: boolean;
}

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];
const WRITE = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const isWrite = (m: string) => WRITE.has((m || '').toUpperCase());

const CHECK_LABELS: Record<FlowCheck['kind'], string> = {
  status: 'Status is one of',
  jsonPathExists: 'JSON path exists',
  jsonPathEquals: 'JSON path equals',
  bodyContains: 'Body contains',
  responseTimeUnderMs: 'Response time under (ms)',
};

const clip = (s: string, n = 48) => (s.length > n ? `${s.slice(0, n)}…` : s);
const parseNums = (s: string): number[] => s.split(',').map((x) => Number(x.trim())).filter((n) => Number.isFinite(n));

function editCheckToApi(c: EditCheck): FlowCheck {
  switch (c.kind) {
    case 'status': return { kind: 'status', oneOf: parseNums(c.oneOf) };
    case 'jsonPathExists': return { kind: 'jsonPathExists', path: c.path };
    case 'jsonPathEquals': return { kind: 'jsonPathEquals', path: c.path, value: c.value };
    case 'bodyContains': return { kind: 'bodyContains', text: c.text };
    case 'responseTimeUnderMs': return { kind: 'responseTimeUnderMs', ms: Number(c.ms) || 0 };
  }
}

function editStepToApi(s: EditStep): FlowStep {
  const step: FlowStep = { id: s.id, method: s.method, url: s.url };
  if (s.name.trim()) step.name = s.name.trim();
  const hdrs = s.headers.filter((h) => h.key.trim());
  if (hdrs.length) step.headers = hdrs;
  if (s.auth && s.auth.type && s.auth.type !== 'none') step.auth = s.auth;
  if (isWrite(s.method) && s.body.trim()) step.body = s.body;
  const ex: ExtractRow[] = s.extract
    .filter((x) => x.name.trim())
    .map((x) => ({ name: x.name.trim(), from: x.from, ...(x.path.trim() ? { path: x.path.trim() } : {}) }));
  if (ex.length) step.extract = ex;
  const ck = s.checks.map(editCheckToApi);
  if (ck.length) step.checks = ck;
  return step;
}

/* ── One step result card (own collapse state for the body preview) ── */
function StepResult({ s }: { s: FlowRunResult['steps'][number] }) {
  const [open, setOpen] = useState(false);
  return (
    <div className={`${CARD} overflow-hidden`}>
      <div className="flex items-center gap-2 px-3 py-2">
        {s.ok ? <CheckCircle2 className="w-4 h-4 text-emerald-600 flex-shrink-0" /> : <XCircle className="w-4 h-4 text-red-600 flex-shrink-0" />}
        <MethodBadge method={s.method} />
        <span className="text-[12px] font-medium text-gray-800 truncate">{s.name || s.url}</span>
        <span className="ml-auto text-[11px] text-gray-400 flex-shrink-0">{s.status ?? '—'} · {s.elapsedMs}ms</span>
      </div>
      <div className="px-3 pb-2.5 space-y-1.5">
        {s.error && <p className="text-[11.5px] text-red-600">{s.error}</p>}
        {Object.keys(s.extracted).length > 0 && (
          <div className="flex flex-wrap gap-1">
            {Object.entries(s.extracted).map(([k, v]) => (
              <span key={k} className="inline-flex items-center px-1.5 py-0.5 rounded border text-[10px] font-mono bg-[#F5F3FF] border-[#DDD6FE] text-[#6D28D9]">{k} = {clip(v)}</span>
            ))}
          </div>
        )}
        {s.checks.map((c, i) => (
          <div key={i} className="flex items-start gap-1.5 text-[11.5px]">
            {c.pass ? <Check className="w-3.5 h-3.5 text-emerald-600 mt-px flex-shrink-0" /> : <X className="w-3.5 h-3.5 text-red-500 mt-px flex-shrink-0" />}
            <span className={c.pass ? 'text-gray-600' : 'text-red-600'}>{c.label}{c.detail ? <span className="text-gray-400"> · {c.detail}</span> : null}</span>
          </div>
        ))}
        {s.bodyPreview && (
          <div>
            <button type="button" onClick={() => setOpen((o) => !o)} className="text-[11px] text-gray-400 hover:text-[#7C3AED] inline-flex items-center gap-0.5">
              <ChevronRight className={`w-3 h-3 transition-transform ${open ? 'rotate-90' : ''}`} />Response body
            </button>
            {open && <pre className="mt-1 text-[10.5px] font-mono text-gray-600 bg-gray-50 rounded p-2 overflow-x-auto max-h-40">{s.bodyPreview}</pre>}
          </div>
        )}
      </div>
    </div>
  );
}

export default function FlowBuilder({ catalog, onClose }: { catalog: Catalog; onClose: () => void }) {
  const toast = useToast();
  const counter = useRef(0);
  const nextId = (p: string) => `${p}-${Date.now().toString(36)}-${(counter.current++).toString(36)}`;

  const [name, setName] = useState('');
  const [steps, setSteps] = useState<EditStep[]>([]);
  const [saved, setSaved] = useState<SavedApiFlow[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [seedSel, setSeedSel] = useState('');
  const [allowWrites, setAllowWrites] = useState(false);
  const [result, setResult] = useState<FlowRunResult | null>(null);
  const [running, setRunning] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const hasWrites = steps.some((s) => isWrite(s.method));

  /* ── Builders ── */
  const blankStep = (): EditStep => ({ id: nextId('s'), name: '', method: 'GET', url: '', headers: [], body: '', extract: [], checks: [], open: true });
  const seedStep = (ep: CatalogEndpoint): EditStep => ({
    id: nextId('s'),
    name: ep.title || '',
    method: ep.method || 'GET',
    url: ep.url || '',
    headers: (ep.headers || []).map((h) => ({ key: h.key, value: h.value })),
    auth: ep.auth ? { type: ep.auth.type, value: ep.auth.value, headerName: ep.auth.headerName } : undefined,
    body: ep.body || '',
    extract: [],
    checks: [],
    open: true,
  });
  const apiStepToEdit = (s: FlowStep): EditStep => ({
    id: s.id || nextId('s'),
    name: s.name || '',
    method: s.method || 'GET',
    url: s.url || '',
    headers: (s.headers || []).map((h) => ({ key: h.key, value: h.value })),
    auth: s.auth,
    body: s.body || '',
    extract: (s.extract || []).map((x) => ({ _k: nextId('k'), name: x.name, from: x.from, path: x.path || '' })),
    checks: (s.checks || []).map((c) => ({
      _k: nextId('k'),
      kind: c.kind,
      oneOf: (c.oneOf || []).join(', '),
      path: c.path || '',
      value: c.value != null ? String(c.value) : '',
      text: c.text || '',
      ms: c.ms != null ? String(c.ms) : '',
    })),
    open: false,
  });

  /* ── Step mutations ── */
  const patchStep = (id: string, patch: Partial<EditStep>) => setSteps((prev) => prev.map((s) => (s.id === id ? { ...s, ...patch } : s)));
  const removeStep = (id: string) => setSteps((prev) => prev.filter((s) => s.id !== id));
  const move = (i: number, dir: -1 | 1) => setSteps((prev) => {
    const j = i + dir;
    if (j < 0 || j >= prev.length) return prev;
    const next = prev.slice();
    [next[i], next[j]] = [next[j], next[i]];
    return next;
  });
  const addExtract = (s: EditStep) => patchStep(s.id, { extract: [...s.extract, { _k: nextId('k'), name: '', from: 'body', path: '' }] });
  const setExtract = (s: EditStep, k: string, patch: Partial<EditExtract>) => patchStep(s.id, { extract: s.extract.map((x) => (x._k === k ? { ...x, ...patch } : x)) });
  const delExtract = (s: EditStep, k: string) => patchStep(s.id, { extract: s.extract.filter((x) => x._k !== k) });
  const addCheck = (s: EditStep) => patchStep(s.id, { checks: [...s.checks, { _k: nextId('k'), kind: 'status', oneOf: '200', path: '', value: '', text: '', ms: '' }] });
  const setCheck = (s: EditStep, k: string, patch: Partial<EditCheck>) => patchStep(s.id, { checks: s.checks.map((c) => (c._k === k ? { ...c, ...patch } : c)) });
  const delCheck = (s: EditStep, k: string) => patchStep(s.id, { checks: s.checks.filter((c) => c._k !== k) });

  /* ── Saved flows ── */
  const refresh = async () => {
    try { const { flows } = await listApiFlows(); setSaved(flows); } catch { /* a missing list should not block the builder */ }
  };
  useEffect(() => { void refresh(); }, []);

  const loadFlow = (id: string) => {
    setSelectedId(id);
    const f = saved.find((x) => x.id === id);
    if (!f) return;
    setName(f.name);
    setSteps(f.steps.map(apiStepToEdit));
    setResult(null);
    setError('');
  };

  const removeFlow = async (id: string) => {
    try {
      await deleteApiFlow(id);
      if (selectedId === id) setSelectedId('');
      await refresh();
      toast.success('Flow deleted');
    } catch (e: any) {
      toast.error('Delete failed', e?.response?.data?.error || e?.message || 'Could not delete the flow.');
    }
  };

  const save = async () => {
    if (!name.trim()) { setError('Give the flow a name before saving.'); return; }
    if (!steps.length) { setError('Add at least one step before saving.'); return; }
    setSaving(true); setError('');
    try {
      const { flow } = await saveApiFlow({ id: selectedId || undefined, name: name.trim(), steps: steps.map(editStepToApi) });
      setSelectedId(flow.id);
      toast.success('Flow saved', `“${flow.name}” saved with ${flow.steps.length} step${flow.steps.length === 1 ? '' : 's'}.`);
      await refresh();
    } catch (e: any) {
      const msg = e?.response?.data?.error || e?.message || 'Save failed.';
      setError(msg);
      toast.error('Save failed', msg);
    } finally { setSaving(false); }
  };

  const run = async () => {
    const apiSteps = steps.map(editStepToApi).filter((s) => (s.url || '').trim());
    if (!apiSteps.length) { setError('Add at least one step with a URL.'); return; }
    if (apiSteps.some((s) => isWrite(s.method || '')) && !allowWrites) {
      setError('This flow includes write-method steps. Tick “Allow writes” to run it.');
      return;
    }
    setRunning(true); setError(''); setResult(null);
    try {
      setResult(await runApiFlow({ steps: apiSteps, allowWrites }));
    } catch (e: any) {
      setError(e?.response?.data?.error || e?.message || 'Flow run failed.');
    } finally { setRunning(false); }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-[#1E1B4B]/30 backdrop-blur-sm p-4" onClick={onClose}>
      <div className={`${CARD} w-full max-w-3xl max-h-[85vh] flex flex-col overflow-hidden`} onClick={(e) => e.stopPropagation()}>
        <div className={`flex items-center gap-2 px-4 h-12 border-b border-[#EDE9FE] flex-shrink-0 ${STRIP}`}>
          <Workflow className="w-4 h-4 text-[#7C3AED]" />
          <h3 className="text-[13px] font-semibold text-gray-900">Flow builder</h3>
          <span className="text-[11px] text-gray-400">assemble a multi-step journey</span>
          <button type="button" onClick={onClose} className="ml-auto p-1.5 rounded-md text-gray-400 hover:text-[#7C3AED] hover:bg-[#F5F3FF]"><X className="w-4 h-4" /></button>
        </div>

        <div className="p-4 space-y-3 overflow-y-auto min-h-0">
          {/* Toolbar */}
          <div className="flex flex-wrap items-center gap-2">
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Flow name" className={`${FIELD} flex-1 min-w-[140px]`} />
            {saved.length > 0 && (
              <>
                <select value={selectedId} onChange={(e) => { const v = e.target.value; if (v) loadFlow(v); else setSelectedId(''); }} className={FIELD}>
                  <option value="">Saved flows…</option>
                  {saved.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
                </select>
                {selectedId && <button type="button" onClick={() => void removeFlow(selectedId)} className="p-2 rounded-lg text-gray-400 hover:text-red-500 border border-gray-200" title="Delete saved flow"><Trash2 className="w-3.5 h-3.5" /></button>}
              </>
            )}
            <button type="button" onClick={() => void save()} disabled={saving || !steps.length} className={SECONDARY_BTN}>{saving ? <Spinner className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}Save</button>
            <button type="button" onClick={() => void run()} disabled={running || !steps.length} className={PRIMARY_BTN}>{running ? <Spinner className="w-3.5 h-3.5 animate-spin" /> : <Play className="w-3.5 h-3.5" />}{running ? 'Running…' : 'Run'}</button>
          </div>

          <div className="flex items-center justify-between gap-2">
            <label className={`flex items-center gap-1.5 text-[12px] ${hasWrites ? 'text-gray-700' : 'text-gray-400'}`}>
              <input type="checkbox" checked={allowWrites} onChange={(e) => setAllowWrites(e.target.checked)} className="rounded border-gray-300 text-[#7C3AED] focus:ring-[#A5B4FC]" />
              Allow writes{hasWrites && <span className="text-amber-600"> · required, this flow has write steps</span>}
            </label>
          </div>

          <p className="text-[11px] text-gray-400">Reference an extracted value anywhere in a later step's URL, header values or body with <code className="font-mono text-[#6D28D9]">{'{{variableName}}'}</code>.</p>

          {error && <div className="flex items-start gap-2 px-3 py-2 bg-red-50 border border-red-200 rounded-lg"><AlertTriangle className="w-4 h-4 text-red-500 flex-shrink-0 mt-px" /><p className="text-[12px] text-red-700">{error}</p></div>}

          {/* Steps */}
          {steps.length === 0 && (
            <div className="text-[12px] text-gray-400 border border-dashed border-gray-200 rounded-lg p-6 text-center">No steps yet. Add a blank step or seed one from your catalogue.</div>
          )}

          <div className="space-y-2">
            {steps.map((s, i) => (
              <div key={s.id} className={`${CARD} overflow-hidden`}>
                <div className="flex items-center gap-2 px-3 h-11">
                  <span className="text-[11px] font-mono text-gray-400 w-5 text-center flex-shrink-0">{i + 1}</span>
                  <MethodBadge method={s.method} />
                  <input value={s.name} onChange={(e) => patchStep(s.id, { name: e.target.value })} placeholder="Step name" className={`${FIELD} w-32 flex-shrink-0`} />
                  <span className="text-[11.5px] font-mono text-gray-500 truncate flex-1 min-w-0">{s.url || <span className="text-gray-300">no URL yet</span>}</span>
                  <button type="button" onClick={() => move(i, -1)} disabled={i === 0} className="p-1 rounded text-gray-400 hover:text-[#7C3AED] disabled:opacity-30"><ChevronUp className="w-3.5 h-3.5" /></button>
                  <button type="button" onClick={() => move(i, 1)} disabled={i === steps.length - 1} className="p-1 rounded text-gray-400 hover:text-[#7C3AED] disabled:opacity-30"><ChevronDown className="w-3.5 h-3.5" /></button>
                  <button type="button" onClick={() => patchStep(s.id, { open: !s.open })} className="p-1 rounded text-gray-400 hover:text-[#7C3AED]" title={s.open ? 'Collapse' : 'Edit'}><ChevronRight className={`w-3.5 h-3.5 transition-transform ${s.open ? 'rotate-90' : ''}`} /></button>
                  <button type="button" onClick={() => removeStep(s.id)} className="p-1 rounded text-gray-400 hover:text-red-500"><Trash2 className="w-3.5 h-3.5" /></button>
                </div>

                {s.open && (
                  <div className="px-3 pb-3 pt-2 space-y-3 border-t border-gray-100 bg-gray-50/40">
                    <div className="flex gap-2">
                      <div>
                        <label className={LABEL}>Method</label>
                        <select value={s.method} onChange={(e) => patchStep(s.id, { method: e.target.value })} className={FIELD}>
                          {METHODS.map((m) => <option key={m} value={m}>{m}</option>)}
                        </select>
                      </div>
                      <div className="flex-1 min-w-0">
                        <label className={LABEL}>URL</label>
                        <input value={s.url} onChange={(e) => patchStep(s.id, { url: e.target.value })} placeholder="{{baseUrl}}/v1/users/{{id}}" className={INPUT} />
                      </div>
                    </div>

                    {isWrite(s.method) && (
                      <div>
                        <label className={LABEL}>Body</label>
                        <textarea value={s.body} onChange={(e) => patchStep(s.id, { body: e.target.value })} rows={3} placeholder={'{ "name": "{{name}}" }'} className={`${INPUT} font-mono resize-y`} />
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
                            <select value={x.from} onChange={(e) => setExtract(s, x._k, { from: e.target.value as ExtractRow['from'] })} className={`${FIELD} flex-shrink-0`}>
                              <option value="body">body</option>
                              <option value="header">header</option>
                              <option value="status">status</option>
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
                      {s.checks.length === 0 && <p className="text-[11px] text-gray-400">Assert something about the response.</p>}
                      <div className="space-y-1.5">
                        {s.checks.map((c) => (
                          <div key={c._k} className="flex gap-1.5 items-center">
                            <select value={c.kind} onChange={(e) => setCheck(s, c._k, { kind: e.target.value as FlowCheck['kind'] })} className={`${FIELD} flex-shrink-0`}>
                              {(Object.keys(CHECK_LABELS) as FlowCheck['kind'][]).map((k) => <option key={k} value={k}>{CHECK_LABELS[k]}</option>)}
                            </select>
                            {c.kind === 'status' && <input value={c.oneOf} onChange={(e) => setCheck(s, c._k, { oneOf: e.target.value })} placeholder="200, 201" className={`${FIELD} flex-1 min-w-0`} />}
                            {(c.kind === 'jsonPathExists' || c.kind === 'jsonPathEquals') && <input value={c.path} onChange={(e) => setCheck(s, c._k, { path: e.target.value })} placeholder="data.0.id" className={`${FIELD} flex-1 min-w-0`} />}
                            {c.kind === 'jsonPathEquals' && <input value={c.value} onChange={(e) => setCheck(s, c._k, { value: e.target.value })} placeholder="expected value" className={`${FIELD} w-32 flex-shrink-0`} />}
                            {c.kind === 'bodyContains' && <input value={c.text} onChange={(e) => setCheck(s, c._k, { text: e.target.value })} placeholder="substring" className={`${FIELD} flex-1 min-w-0`} />}
                            {c.kind === 'responseTimeUnderMs' && <input value={c.ms} onChange={(e) => setCheck(s, c._k, { ms: e.target.value })} placeholder="300" inputMode="numeric" className={`${FIELD} w-24 flex-shrink-0`} />}
                            <button type="button" onClick={() => delCheck(s, c._k)} className="p-1 text-gray-400 hover:text-red-500 flex-shrink-0"><Trash2 className="w-3.5 h-3.5" /></button>
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>

          {/* Add step */}
          <div className="flex items-center gap-2">
            <button type="button" onClick={() => setSteps((prev) => [...prev, blankStep()])} className={SECONDARY_BTN}><Plus className="w-3.5 h-3.5" />Add step</button>
            {catalog.endpoints.length > 0 && (
              <select value={seedSel} onChange={(e) => { const id = e.target.value; const ep = catalog.endpoints.find((x) => x.id === id); if (ep) setSteps((prev) => [...prev, seedStep(ep)]); setSeedSel(''); }} className={FIELD}>
                <option value="">From endpoint…</option>
                {catalog.endpoints.map((ep) => <option key={ep.id} value={ep.id}>{ep.method} {ep.url}</option>)}
              </select>
            )}
          </div>

          {/* Results */}
          {result && (
            <div className="space-y-2 pt-1">
              <div className={`flex items-center gap-2 px-3 py-2.5 rounded-lg border ${result.passed ? 'bg-emerald-50 border-emerald-200' : 'bg-red-50 border-red-200'}`}>
                {result.passed ? <CheckCircle2 className="w-5 h-5 text-emerald-600" /> : <XCircle className="w-5 h-5 text-red-600" />}
                <div className={`text-[13px] font-semibold ${result.passed ? 'text-emerald-700' : 'text-red-700'}`}>{result.passed ? 'Flow passed' : 'Flow failed'}</div>
                <span className="ml-auto text-[11px] text-gray-500">{result.stepsRun}/{result.stepsTotal} steps · {formatDuration(result.durationMs)}</span>
              </div>
              {Object.keys(result.variables).length > 0 && (
                <div className="flex flex-wrap gap-1">
                  {Object.entries(result.variables).map(([k, v]) => (
                    <span key={k} className="inline-flex items-center px-1.5 py-0.5 rounded border text-[10px] font-mono bg-[#F5F3FF] border-[#DDD6FE] text-[#6D28D9]">{k} = {clip(v)}</span>
                  ))}
                </div>
              )}
              {result.steps.map((st) => <StepResult key={st.index} s={st} />)}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
