/**
 * HybridTest — the Testsigma-style API + UI hybrid journey.
 *
 * Three ordered phases in one test: SEED sets up state through the API, VERIFY
 * opens a real browser and asserts what the user would see, and CLEANUP tears the
 * state back down through the API. A value captured in a seed step's Extract (say
 * `{name:'id', from:'body', path:'id'}`) is referenced later — in a URL, header,
 * body or the verify URL — as `{{id}}`. Opt-in and standalone: it live-fires the
 * API and drives a browser, touching nothing in the catalogue or the pipeline.
 */
import { useEffect, useState } from 'react';
import {
  FlaskConical, Database, Globe, Trash2, X, Play, Plus, Save,
  AlertTriangle, CheckCircle2, XCircle, ChevronRight, ChevronUp, ChevronDown,
} from 'lucide-react';
import Spinner from '@/components/feedback/Spinner';
import { useToast } from '@/components/feedback/ToastProvider';
import {
  listHybridTests, saveHybridTest, deleteHybridTest, runHybridTest,
  type HybridTest as HybridTestDef, type HybridUi, type UiCheck, type HybridRunResult, type FlowStep,
} from '@/services/api';
import { MethodBadge, StatusCode } from './primitives';
import { CARD, STRIP, INPUT, FIELD, LABEL, PRIMARY_BTN, SECONDARY_BTN, formatDuration, relativeTime } from './format';
import type { CatalogEndpoint } from './types';

/* ── Local editing model ──────────────────────────────────────────────────
   Seed/cleanup steps and UI checks carry UI-only fields (a stable key, the
   expand toggle, free-text mirrors of numeric fields). They convert to the API
   shapes at save/run time. Extract is fixed to `from: 'body'` here — the one
   source the hybrid journey needs. */

interface EditExtract { _k: string; name: string; path: string }
interface EditStep {
  _k: string;
  name: string;
  method: string;
  url: string;
  headers: { key: string; value: string }[];
  auth?: FlowStep['auth'];
  body: string;
  extract: EditExtract[];
  open: boolean;
}
interface EditUiCheck { _k: string; kind: UiCheck['kind']; selector: string; text: string; count: string }

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];

const UI_CHECK_LABELS: Record<UiCheck['kind'], string> = {
  textPresent: 'Text present',
  textAbsent: 'Text absent',
  selectorPresent: 'Selector present',
  selectorCount: 'Selector count',
  titleContains: 'Title contains',
  urlContains: 'URL contains',
};
const SELECTOR_KINDS = new Set<UiCheck['kind']>(['selectorPresent', 'selectorCount']);
const TEXT_KINDS = new Set<UiCheck['kind']>(['textPresent', 'textAbsent', 'titleContains', 'urlContains']);

let _seq = 0;
const nextKey = (p: string) => `${p}-${Date.now().toString(36)}-${(_seq++).toString(36)}`;
const clip = (s: string, n = 48) => (s.length > n ? `${s.slice(0, n)}…` : s);

const blankStep = (): EditStep => ({ _k: nextKey('s'), name: '', method: 'GET', url: '', headers: [], body: '', extract: [], open: true });

const seedStepFromEndpoint = (ep: CatalogEndpoint): EditStep => ({
  _k: nextKey('s'),
  name: ep.title || '',
  method: (ep.method || 'GET').toUpperCase(),
  url: ep.url || '',
  headers: (ep.headers || []).map((h) => ({ key: h.key, value: h.value })),
  auth: ep.auth ? { type: ep.auth.type, value: ep.auth.value, headerName: ep.auth.headerName, oauth2: ep.auth.oauth2 } : undefined,
  body: ep.body || '',
  extract: [],
  open: true,
});

const toEditStep = (s: FlowStep): EditStep => ({
  _k: nextKey('s'),
  name: s.name || '',
  method: (s.method || 'GET').toUpperCase(),
  url: s.url || '',
  headers: (s.headers || []).map((h) => ({ key: h.key, value: h.value })),
  auth: s.auth,
  body: s.body || '',
  extract: (s.extract || []).map((x) => ({ _k: nextKey('x'), name: x.name, path: x.path || '' })),
  open: false,
});

function toFlowStep(s: EditStep): FlowStep {
  const step: FlowStep = {};
  if (s.name.trim()) step.name = s.name.trim();
  if (s.method.trim()) step.method = s.method.trim();
  if (s.url.trim()) step.url = s.url.trim();
  const hdrs = s.headers.filter((h) => h.key.trim());
  if (hdrs.length) step.headers = hdrs.map((h) => ({ key: h.key, value: h.value }));
  if (s.auth) step.auth = s.auth;
  if (s.method.toUpperCase() !== 'GET' && s.body.trim()) step.body = s.body;
  const ex = s.extract.filter((x) => x.name.trim()).map((x) => ({ name: x.name.trim(), from: 'body' as const, path: x.path.trim() }));
  if (ex.length) step.extract = ex;
  return step;
}

const toEditUiCheck = (c: UiCheck): EditUiCheck => ({
  _k: nextKey('u'),
  kind: c.kind,
  selector: c.selector || '',
  text: c.text || '',
  count: c.count != null ? String(c.count) : '',
});

function toUiCheck(c: EditUiCheck): UiCheck {
  const out: UiCheck = { kind: c.kind };
  if (SELECTOR_KINDS.has(c.kind)) out.selector = c.selector.trim();
  if (c.kind === 'selectorCount') out.count = Number(c.count) || 0;
  if (TEXT_KINDS.has(c.kind)) out.text = c.text;
  return out;
}

/* ── The seed / cleanup step editor (shared by both API phases) ──────────── */
function StepList({ steps, onChange, endpoints, emptyHint }: {
  steps: EditStep[];
  onChange: (next: EditStep[]) => void;
  endpoints: CatalogEndpoint[];
  emptyHint: string;
}) {
  const [seedSel, setSeedSel] = useState('');
  const patch = (k: string, p: Partial<EditStep>) => onChange(steps.map((s) => (s._k === k ? { ...s, ...p } : s)));
  const remove = (k: string) => onChange(steps.filter((s) => s._k !== k));
  const move = (i: number, dir: -1 | 1) => {
    const j = i + dir;
    if (j < 0 || j >= steps.length) return;
    const next = steps.slice();
    [next[i], next[j]] = [next[j], next[i]];
    onChange(next);
  };
  const addHeader = (s: EditStep) => patch(s._k, { headers: [...s.headers, { key: '', value: '' }] });
  const setHeader = (s: EditStep, i: number, hp: Partial<{ key: string; value: string }>) => patch(s._k, { headers: s.headers.map((h, j) => (j === i ? { ...h, ...hp } : h)) });
  const delHeader = (s: EditStep, i: number) => patch(s._k, { headers: s.headers.filter((_, j) => j !== i) });
  const addExtract = (s: EditStep) => patch(s._k, { extract: [...s.extract, { _k: nextKey('x'), name: '', path: '' }] });
  const setExtract = (s: EditStep, k: string, xp: Partial<EditExtract>) => patch(s._k, { extract: s.extract.map((x) => (x._k === k ? { ...x, ...xp } : x)) });
  const delExtract = (s: EditStep, k: string) => patch(s._k, { extract: s.extract.filter((x) => x._k !== k) });

  return (
    <div className="space-y-2">
      {steps.length === 0 && <p className="text-[11px] text-gray-400">{emptyHint}</p>}
      {steps.map((s, i) => (
        <div key={s._k} className="border border-gray-100 rounded-lg overflow-hidden bg-white">
          <div className="flex items-center gap-2 px-2.5 h-10">
            <span className="text-[11px] font-mono text-gray-400 w-4 text-center flex-shrink-0">{i + 1}</span>
            <MethodBadge method={s.method} />
            <input value={s.name} onChange={(e) => patch(s._k, { name: e.target.value })} placeholder="step name" className={`${FIELD} w-28 flex-shrink-0 py-1`} />
            <span className="text-[11.5px] font-mono text-gray-500 truncate flex-1 min-w-0">{s.url || <span className="text-gray-300">no URL yet</span>}</span>
            <button type="button" onClick={() => move(i, -1)} disabled={i === 0} className="p-1 rounded text-gray-400 hover:text-[#7C3AED] disabled:opacity-30"><ChevronUp className="w-3.5 h-3.5" /></button>
            <button type="button" onClick={() => move(i, 1)} disabled={i === steps.length - 1} className="p-1 rounded text-gray-400 hover:text-[#7C3AED] disabled:opacity-30"><ChevronDown className="w-3.5 h-3.5" /></button>
            <button type="button" onClick={() => patch(s._k, { open: !s.open })} className="p-1 rounded text-gray-400 hover:text-[#7C3AED]" title={s.open ? 'Collapse' : 'Edit'}><ChevronRight className={`w-3.5 h-3.5 transition-transform ${s.open ? 'rotate-90' : ''}`} /></button>
            <button type="button" onClick={() => remove(s._k)} className="p-1 rounded text-gray-400 hover:text-red-500"><Trash2 className="w-3.5 h-3.5" /></button>
          </div>

          {s.open && (
            <div className="px-2.5 pb-2.5 pt-2 space-y-2.5 border-t border-gray-100 bg-gray-50/40">
              <div className="flex gap-2">
                <div>
                  <label className={LABEL}>Method</label>
                  <select value={s.method} onChange={(e) => patch(s._k, { method: e.target.value })} className={FIELD}>
                    {METHODS.map((m) => <option key={m} value={m}>{m}</option>)}
                  </select>
                </div>
                <div className="flex-1 min-w-0">
                  <label className={LABEL}>URL</label>
                  <input value={s.url} onChange={(e) => patch(s._k, { url: e.target.value })} placeholder="{{baseUrl}}/v1/orders/{{id}}" className={INPUT} />
                </div>
              </div>

              {/* Headers */}
              <div>
                <div className="flex items-center justify-between mb-1">
                  <span className={`${LABEL} mb-0`}>Headers</span>
                  <button type="button" onClick={() => addHeader(s)} className="text-[11px] text-[#7C3AED] hover:underline inline-flex items-center gap-0.5"><Plus className="w-3 h-3" />Add</button>
                </div>
                {s.headers.length === 0 && <p className="text-[11px] text-gray-400">No headers.</p>}
                <div className="space-y-1.5">
                  {s.headers.map((h, j) => (
                    <div key={j} className="flex gap-1.5 items-center">
                      <input value={h.key} onChange={(e) => setHeader(s, j, { key: e.target.value })} placeholder="Header-Name" className={`${FIELD} w-40 flex-shrink-0`} />
                      <input value={h.value} onChange={(e) => setHeader(s, j, { value: e.target.value })} placeholder="value" className={`${FIELD} flex-1 min-w-0`} />
                      <button type="button" onClick={() => delHeader(s, j)} className="p-1 text-gray-400 hover:text-red-500 flex-shrink-0"><Trash2 className="w-3.5 h-3.5" /></button>
                    </div>
                  ))}
                </div>
              </div>

              {/* Body */}
              {s.method.toUpperCase() !== 'GET' && (
                <div>
                  <label className={LABEL}>Body</label>
                  <textarea value={s.body} onChange={(e) => patch(s._k, { body: e.target.value })} rows={3} placeholder={'{ "name": "{{name}}" }'} className={`${INPUT} font-mono resize-y`} />
                </div>
              )}

              {/* Extract → variables */}
              <div>
                <div className="flex items-center justify-between mb-1">
                  <span className={`${LABEL} mb-0`}>Extract → variables</span>
                  <button type="button" onClick={() => addExtract(s)} className="text-[11px] text-[#7C3AED] hover:underline inline-flex items-center gap-0.5"><Plus className="w-3 h-3" />Add</button>
                </div>
                {s.extract.length === 0 && <p className="text-[11px] text-gray-400">Capture a value from this response's JSON body for later steps and the verify URL.</p>}
                <div className="space-y-1.5">
                  {s.extract.map((x) => (
                    <div key={x._k} className="flex gap-1.5 items-center">
                      <input value={x.name} onChange={(e) => setExtract(s, x._k, { name: e.target.value })} placeholder="id" className={`${FIELD} w-28 flex-shrink-0`} />
                      <span className="text-[11px] text-gray-400 font-mono flex-shrink-0">body</span>
                      <input value={x.path} onChange={(e) => setExtract(s, x._k, { path: e.target.value })} placeholder="data.0.id" className={`${FIELD} flex-1 min-w-0`} />
                      <button type="button" onClick={() => delExtract(s, x._k)} className="p-1 text-gray-400 hover:text-red-500 flex-shrink-0"><Trash2 className="w-3.5 h-3.5" /></button>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}
        </div>
      ))}

      <div className="flex items-center gap-2">
        <button type="button" onClick={() => onChange([...steps, blankStep()])} className={SECONDARY_BTN}><Plus className="w-3.5 h-3.5" />Add step</button>
        {endpoints.length > 0 && (
          <select
            value={seedSel}
            onChange={(e) => { const id = e.target.value; const ep = endpoints.find((x) => x.id === id); if (ep) onChange([...steps, seedStepFromEndpoint(ep)]); setSeedSel(''); }}
            className={FIELD}
          >
            <option value="">＋ from endpoint…</option>
            {endpoints.map((ep) => <option key={ep.id} value={ep.id}>{ep.method} {ep.url}</option>)}
          </select>
        )}
      </div>
    </div>
  );
}

/* ── One API phase's result rows (seed & cleanup share this) ─────────────── */
function StepRows({ run }: { run: HybridRunResult['seed'] }) {
  if (!run || !run.steps?.length) return <p className="text-[11px] text-gray-400">No steps ran.</p>;
  return (
    <div className="space-y-1">
      {run.steps.map((st) => (
        <div key={st.index} className="flex items-center gap-2 text-[11.5px]">
          {st.ok ? <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600 flex-shrink-0" /> : <XCircle className="w-3.5 h-3.5 text-red-600 flex-shrink-0" />}
          <MethodBadge method={st.method} />
          <span className="text-gray-700 truncate flex-1 min-w-0">{st.name || st.url}</span>
          {st.error && <span className="text-red-500 truncate max-w-[40%]">{st.error}</span>}
          <StatusCode code={st.status ?? ''} />
          <span className="text-gray-400 tabular-nums flex-shrink-0">{st.elapsedMs}ms</span>
        </div>
      ))}
    </div>
  );
}

const STEP_NUM = 'inline-flex items-center justify-center w-4 h-4 rounded-full bg-[#EDE9FE] text-[#6D28D9] text-[10px] font-bold flex-shrink-0';

export default function HybridTest({ endpoints, onClose }: { endpoints: CatalogEndpoint[]; onClose: () => void }) {
  const toast = useToast();

  const [name, setName] = useState('');
  const [seed, setSeed] = useState<EditStep[]>([]);
  const [cleanup, setCleanup] = useState<EditStep[]>([]);
  const [uiUrl, setUiUrl] = useState('');
  const [engine, setEngine] = useState<'chromium' | 'firefox' | 'webkit'>('chromium');
  const [uiChecks, setUiChecks] = useState<EditUiCheck[]>([]);

  const [saved, setSaved] = useState<HybridTestDef[]>([]);
  const [selectedId, setSelectedId] = useState('');

  const [result, setResult] = useState<HybridRunResult | null>(null);
  const [running, setRunning] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const refresh = async () => {
    try { setSaved(await listHybridTests()); } catch { /* a missing list should not block the builder */ }
  };
  useEffect(() => { void refresh(); }, []);

  const buildUi = (): HybridUi => ({ url: uiUrl.trim(), engine, checks: uiChecks.map(toUiCheck) });

  const load = (t: HybridTestDef) => {
    setSelectedId(t.id);
    setName(t.name);
    setSeed((t.seed || []).map(toEditStep));
    setCleanup((t.cleanup || []).map(toEditStep));
    setUiUrl(t.ui?.url || '');
    setEngine(t.ui?.engine || 'chromium');
    setUiChecks((t.ui?.checks || []).map(toEditUiCheck));
    setResult(null);
    setError('');
  };

  const addUiCheck = () => setUiChecks((p) => [...p, { _k: nextKey('u'), kind: 'textPresent', selector: '', text: '', count: '' }]);
  const setUiCheck = (k: string, p: Partial<EditUiCheck>) => setUiChecks((prev) => prev.map((c) => (c._k === k ? { ...c, ...p } : c)));
  const delUiCheck = (k: string) => setUiChecks((prev) => prev.filter((c) => c._k !== k));

  const save = async () => {
    if (!name.trim()) { setError('Give the hybrid test a name before saving.'); return; }
    setSaving(true); setError('');
    try {
      const t = await saveHybridTest({
        id: selectedId || undefined,
        name: name.trim(),
        seed: seed.map(toFlowStep),
        ui: buildUi(),
        cleanup: cleanup.map(toFlowStep),
      });
      setSelectedId(t.id);
      toast.success('Hybrid test saved', `“${t.name}” saved.`);
      await refresh();
    } catch (e: any) {
      const msg = e?.response?.data?.error || e?.message || 'Request failed.';
      setError(msg);
      toast.error('Save failed', msg);
    } finally { setSaving(false); }
  };

  const remove = async (id: string) => {
    try {
      await deleteHybridTest(id);
      if (selectedId === id) setSelectedId('');
      await refresh();
      toast.success('Hybrid test deleted');
    } catch (e: any) {
      toast.error('Delete failed', e?.response?.data?.error || e?.message || 'Request failed.');
    }
  };

  const run = async () => {
    if (!uiUrl.trim()) { setError('Enter a URL to verify in the browser.'); return; }
    setRunning(true); setError(''); setResult(null);
    try {
      const seedSteps = seed.map(toFlowStep).filter((s) => (s.url || '').trim());
      const cleanupSteps = cleanup.map(toFlowStep).filter((s) => (s.url || '').trim());
      setResult(await runHybridTest({ seed: seedSteps, ui: buildUi(), cleanup: cleanupSteps, allowWrites: true }));
    } catch (e: any) {
      setError(e?.response?.data?.error || e?.message || 'Request failed.');
    } finally { setRunning(false); }
  };

  const r = result;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-[#1E1B4B]/30 backdrop-blur-sm p-4" onClick={onClose}>
      <div className={`${CARD} w-full max-w-3xl max-h-[88vh] flex flex-col overflow-hidden`} onClick={(e) => e.stopPropagation()}>
        <div className={`flex items-center gap-2 px-4 h-12 border-b border-[#EDE9FE] flex-shrink-0 ${STRIP}`}>
          <FlaskConical className="w-4 h-4 text-[#7C3AED]" />
          <h3 className="text-[13px] font-semibold text-gray-900">API + UI hybrid test</h3>
          <span className="text-[11px] text-gray-400">seed via API · verify in a browser · clean up via API</span>
          <button type="button" onClick={onClose} className="ml-auto p-1.5 rounded-md text-gray-400 hover:text-[#7C3AED] hover:bg-[#F5F3FF]"><X className="w-4 h-4" /></button>
        </div>

        <div className="p-4 space-y-3 overflow-y-auto min-h-0">
          {/* Toolbar */}
          <div className="flex flex-wrap items-center gap-2">
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Hybrid test name" className={`${FIELD} flex-1 min-w-[140px]`} />
            <button type="button" onClick={() => void save()} disabled={saving} className={SECONDARY_BTN}>{saving ? <Spinner className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}Save</button>
            <button type="button" onClick={() => void run()} disabled={running || !uiUrl.trim()} className={PRIMARY_BTN}>{running ? <Spinner className="w-3.5 h-3.5 animate-spin" /> : <Play className="w-3.5 h-3.5" />}{running ? 'Running…' : 'Run hybrid test'}</button>
          </div>

          {/* Saved tests */}
          {saved.length > 0 && (
            <div className="border border-gray-100 rounded-lg divide-y divide-gray-100 overflow-hidden">
              {saved.map((t) => (
                <div key={t.id} className={`flex items-center gap-2 px-3 py-1.5 ${selectedId === t.id ? 'bg-[#F5F3FF]' : ''}`}>
                  <button type="button" onClick={() => load(t)} className="flex-1 min-w-0 text-left flex items-baseline gap-2">
                    <span className="text-[12px] font-medium text-gray-800 truncate">{t.name}</span>
                    <span className="text-[10.5px] text-gray-400 whitespace-nowrap flex-shrink-0">{(t.seed?.length || 0)} seed · {(t.ui?.checks?.length || 0)} checks · {(t.cleanup?.length || 0)} cleanup · {relativeTime(t.updatedAt)}</span>
                  </button>
                  <button type="button" onClick={() => void remove(t.id)} className="p-1 rounded text-gray-400 hover:text-red-500 flex-shrink-0" title="Delete saved test"><Trash2 className="w-3.5 h-3.5" /></button>
                </div>
              ))}
            </div>
          )}

          <p className="text-[11px] text-gray-400">Capture a value in a seed step's <span className="font-semibold">Extract</span>, then reference it anywhere later — a URL, header value, body or the verify URL — as <code className="font-mono text-[#6D28D9]">{'{{name}}'}</code>.</p>

          {error && (
            <div className="flex items-start gap-2 px-3 py-2 bg-red-50 border border-red-200 rounded-lg">
              <AlertTriangle className="w-4 h-4 text-red-500 flex-shrink-0 mt-px" /><p className="text-[12px] text-red-700 min-w-0 whitespace-pre-wrap break-words">{error}</p>
            </div>
          )}

          {/* 1 · SEED */}
          <div className={`${CARD} overflow-hidden`}>
            <div className={`flex items-center gap-2 px-3 h-10 border-b border-gray-100 ${STRIP}`}>
              <span className={STEP_NUM}>1</span>
              <Database className="w-4 h-4 text-[#7C3AED]" />
              <h4 className="text-[12px] font-semibold text-gray-800">Seed — set up state through the API</h4>
            </div>
            <div className="p-3">
              <StepList steps={seed} onChange={setSeed} endpoints={endpoints} emptyHint="No seed steps yet. Add one, or seed from an endpoint — e.g. POST to create the record your UI should show, and extract its id." />
            </div>
          </div>

          {/* 2 · VERIFY */}
          <div className={`${CARD} overflow-hidden`}>
            <div className={`flex items-center gap-2 px-3 h-10 border-b border-gray-100 ${STRIP}`}>
              <span className={STEP_NUM}>2</span>
              <Globe className="w-4 h-4 text-[#7C3AED]" />
              <h4 className="text-[12px] font-semibold text-gray-800">Verify — open a browser and assert</h4>
            </div>
            <div className="p-3 space-y-2.5">
              <div className="flex gap-2">
                <div className="flex-1 min-w-0">
                  <label className={LABEL}>URL to open</label>
                  <input value={uiUrl} onChange={(e) => setUiUrl(e.target.value)} placeholder="https://app.example.com/orders/{{id}}" className={INPUT} />
                </div>
                <div>
                  <label className={LABEL}>Engine</label>
                  <select value={engine} onChange={(e) => setEngine(e.target.value as 'chromium' | 'firefox' | 'webkit')} className={FIELD}>
                    <option value="chromium">chromium</option>
                    <option value="firefox">firefox</option>
                    <option value="webkit">webkit</option>
                  </select>
                </div>
              </div>

              <div>
                <div className="flex items-center justify-between mb-1">
                  <span className={`${LABEL} mb-0`}>Checks</span>
                  <button type="button" onClick={addUiCheck} className="text-[11px] text-[#7C3AED] hover:underline inline-flex items-center gap-0.5"><Plus className="w-3 h-3" />Add check</button>
                </div>
                {uiChecks.length === 0 && <p className="text-[11px] text-gray-400">Add a check to assert the page shows (or hides) something after the seed.</p>}
                <div className="space-y-1.5">
                  {uiChecks.map((c) => (
                    <div key={c._k} className="flex gap-1.5 items-center">
                      <select value={c.kind} onChange={(e) => setUiCheck(c._k, { kind: e.target.value as UiCheck['kind'] })} className={`${FIELD} flex-shrink-0`}>
                        {(Object.keys(UI_CHECK_LABELS) as UiCheck['kind'][]).map((k) => <option key={k} value={k}>{UI_CHECK_LABELS[k]}</option>)}
                      </select>
                      {SELECTOR_KINDS.has(c.kind) && <input value={c.selector} onChange={(e) => setUiCheck(c._k, { selector: e.target.value })} placeholder=".order-status" className={`${FIELD} flex-1 min-w-0 font-mono`} />}
                      {c.kind === 'selectorCount' && <input value={c.count} onChange={(e) => setUiCheck(c._k, { count: e.target.value })} placeholder="count" inputMode="numeric" className={`${FIELD} w-20 flex-shrink-0`} />}
                      {TEXT_KINDS.has(c.kind) && <input value={c.text} onChange={(e) => setUiCheck(c._k, { text: e.target.value })} placeholder={c.kind === 'urlContains' ? '/orders/' : c.kind === 'titleContains' ? 'Orders' : 'Shipped'} className={`${FIELD} flex-1 min-w-0`} />}
                      <button type="button" onClick={() => delUiCheck(c._k)} className="p-1 text-gray-400 hover:text-red-500 flex-shrink-0"><Trash2 className="w-3.5 h-3.5" /></button>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>

          {/* 3 · CLEANUP */}
          <div className={`${CARD} overflow-hidden`}>
            <div className={`flex items-center gap-2 px-3 h-10 border-b border-gray-100 ${STRIP}`}>
              <span className={STEP_NUM}>3</span>
              <Trash2 className="w-4 h-4 text-[#7C3AED]" />
              <h4 className="text-[12px] font-semibold text-gray-800">Cleanup — tear state back down through the API</h4>
            </div>
            <div className="p-3">
              <StepList steps={cleanup} onChange={setCleanup} endpoints={endpoints} emptyHint="No cleanup steps yet. Add one — e.g. DELETE the record you created — referencing the {{variables}} captured during seed." />
            </div>
          </div>

          {/* Result */}
          {r && (
            <div className="space-y-3 pt-1">
              <div className={`flex items-center gap-2 px-3 py-2.5 rounded-lg border ${r.passed ? 'bg-[#F0FDF4] border-[#BBF7D0]' : 'bg-red-50 border-red-200'}`}>
                {r.passed ? <CheckCircle2 className="w-5 h-5 text-[#15803D]" /> : <XCircle className="w-5 h-5 text-red-600" />}
                <span className={`text-[13px] font-semibold ${r.passed ? 'text-[#15803D]' : 'text-red-700'}`}>{r.passed ? 'Hybrid test passed' : 'Hybrid test failed'}</span>
                <span className="ml-auto text-[11px] text-gray-500 tabular-nums">{formatDuration(r.durationMs)}</span>
              </div>

              {Object.keys(r.variables || {}).length > 0 && (
                <div className="flex flex-wrap gap-1">
                  {Object.entries(r.variables).map(([k, v]) => (
                    <span key={k} className="inline-flex items-center px-1.5 py-0.5 rounded border text-[10px] font-mono bg-[#F5F3FF] border-[#DDD6FE] text-[#6D28D9]">{k} = {clip(String(v))}</span>
                  ))}
                </div>
              )}

              {/* Seed */}
              <div>
                <div className="flex items-center gap-1.5 mb-1">
                  <Database className="w-3.5 h-3.5 text-[#7C3AED]" />
                  <span className="text-[11px] font-semibold uppercase tracking-wide text-gray-500">Seed</span>
                  <span className="ml-auto text-[10.5px] text-gray-400 tabular-nums">{r.seed.stepsRun}/{r.seed.stepsTotal} · {formatDuration(r.seed.durationMs)}</span>
                </div>
                <StepRows run={r.seed} />
              </div>

              {/* Verify */}
              <div>
                <div className="flex items-center gap-1.5 mb-1">
                  <Globe className="w-3.5 h-3.5 text-[#7C3AED]" />
                  <span className="text-[11px] font-semibold uppercase tracking-wide text-gray-500">Verify</span>
                  {r.ui.finalUrl && <span className="ml-auto text-[10.5px] text-gray-400 font-mono truncate max-w-[55%]">{r.ui.finalUrl}</span>}
                </div>
                {r.ui.error ? (
                  <p className="text-[11.5px] text-red-600">{r.ui.error}</p>
                ) : (
                  <div className="space-y-1.5">
                    {r.ui.title && <p className="text-[11px] text-gray-500">Title: <span className="text-gray-700">{clip(r.ui.title, 80)}</span></p>}
                    {r.ui.checks.length === 0 && <p className="text-[11px] text-gray-400">Page reached — no checks were configured.</p>}
                    {r.ui.checks.map((c, i) => (
                      <div key={i} className="flex items-start gap-1.5 text-[11.5px]">
                        {c.pass ? <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600 mt-px flex-shrink-0" /> : <XCircle className="w-3.5 h-3.5 text-red-500 mt-px flex-shrink-0" />}
                        <span className={c.pass ? 'text-gray-600' : 'text-red-600'}>{c.label}{c.detail ? <span className="text-gray-400"> · {c.detail}</span> : null}</span>
                      </div>
                    ))}
                    {r.ui.screenshotBase64 && <img src={`data:image/png;base64,${r.ui.screenshotBase64}`} alt="Verification screenshot" className="rounded border max-w-full" />}
                  </div>
                )}
              </div>

              {/* Cleanup */}
              <div>
                <div className="flex items-center gap-1.5 mb-1">
                  <Trash2 className="w-3.5 h-3.5 text-[#7C3AED]" />
                  <span className="text-[11px] font-semibold uppercase tracking-wide text-gray-500">Cleanup</span>
                  <span className="ml-auto text-[10.5px] text-gray-400 tabular-nums">{r.cleanup.stepsRun}/{r.cleanup.stepsTotal} · {formatDuration(r.cleanup.durationMs)}</span>
                </div>
                <StepRows run={r.cleanup} />
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
