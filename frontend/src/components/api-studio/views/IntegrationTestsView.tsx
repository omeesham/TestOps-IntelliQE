/**
 * IntegrationTestsView — runnable, AI-detected integration journeys.
 *
 * This is the bridge the platform was missing: the analyzer already detects the
 * create→read→update→delete lifecycle (and list→read browse) of every resource,
 * but until now those journeys only became Playwright *code*. Here they become
 * runnable flows — one click turns a detected journey into a saved, editable
 * flow that the engine executes live, carrying the id the create step mints into
 * every later step and asserting the status each should return (incl. the 404 a
 * read after a delete must give).
 *
 * Two shelves:
 *   • Suggested — journeys detected from the current catalogue (not yet saved).
 *   • Saved     — integration tests kept in the workspace, re-runnable any time.
 * Both run through the same engine and show per-step results inline.
 */
import { Fragment, useCallback, useEffect, useState } from 'react';
import {
  Workflow, Sparkles, Play, Save, Trash2, CheckCircle2, XCircle, AlertTriangle,
  Loader2, RefreshCw, ArrowRight, ShieldAlert, Boxes, Table2, Download, X,
} from 'lucide-react';
import {
  listApiFlows, saveApiFlow, deleteApiFlow, runApiFlow, runApiFlowSuite, runApiFlowDataset, suggestApiIntegrationFlows, exportFlowJUnit,
  type SavedApiFlow, type SuggestedFlow, type FlowRunResult, type FlowStep, type FlowStepResult, type StepPhase, type SuiteRunResult, type DatasetRunResult,
} from '@/services/api';
import type { CatalogEndpoint } from '../types';
import { CARD, PRIMARY_BTN, SECONDARY_BTN, BRAND_CHIP, methodColor, formatDuration, pathOf } from '../format';
import { EmptyState } from '../primitives';

interface Props {
  endpoints: CatalogEndpoint[];
  onOpenCatalogue: () => void;
  /** Dismisses the tool — it opens as an overlay from the Tools gallery. */
  onClose: () => void;
}

export default function IntegrationTestsView({ endpoints, onOpenCatalogue, onClose }: Props) {
  const [saved, setSaved] = useState<SavedApiFlow[]>([]);
  const [suggestions, setSuggestions] = useState<SuggestedFlow[] | null>(null);
  const [loadingSaved, setLoadingSaved] = useState(true);
  const [suggesting, setSuggesting] = useState(false);
  const [allowWrites, setAllowWrites] = useState(false);
  const [busy, setBusy] = useState<string>('');          // key of the flow currently acting
  const [results, setResults] = useState<Record<string, FlowRunResult>>({});
  const [error, setError] = useState('');
  const [suiteSel, setSuiteSel] = useState<Set<string>>(new Set());  // saved flow ids in the suite
  const [suiteRunning, setSuiteRunning] = useState(false);
  const [suiteResult, setSuiteResult] = useState<SuiteRunResult | null>(null);
  const [setupId, setSetupId] = useState('');       // saved flow run once before the suite
  const [teardownId, setTeardownId] = useState('');  // saved flow run once after, always
  const [dataId, setDataId] = useState('');          // saved flow to drive with a dataset
  const [dataText, setDataText] = useState('');      // dataset rows as a JSON array of objects
  const [dataRunning, setDataRunning] = useState(false);
  const [dataResult, setDataResult] = useState<DatasetRunResult | null>(null);

  const loadSaved = useCallback(async () => {
    setLoadingSaved(true);
    try { setSaved((await listApiFlows()).flows); } catch (e) { setError(msg(e)); } finally { setLoadingSaved(false); }
  }, []);

  useEffect(() => { void loadSaved(); }, [loadSaved]);

  const suggest = async () => {
    setSuggesting(true); setError('');
    try { setSuggestions((await suggestApiIntegrationFlows(endpoints)).flows); }
    catch (e) { setError(msg(e)); }
    finally { setSuggesting(false); }
  };

  const run = async (key: string, steps: FlowStep[], variables: Record<string, string>) => {
    setBusy(key); setError('');
    try {
      const r = await runApiFlow({ steps, variables, allowWrites });
      setResults((prev) => ({ ...prev, [key]: r }));
    } catch (e) { setError(msg(e)); }
    finally { setBusy(''); }
  };

  const save = async (flow: SuggestedFlow) => {
    setBusy(`save:${flow.name}`); setError('');
    try {
      await saveApiFlow({ name: flow.name, steps: flow.steps, variables: flow.variables });
      setSuggestions((prev) => (prev ? prev.filter((f) => f !== flow) : prev));
      await loadSaved();
    } catch (e) { setError(msg(e)); }
    finally { setBusy(''); }
  };

  const remove = async (id: string) => {
    setBusy(`del:${id}`); setError('');
    try { await deleteApiFlow(id); await loadSaved(); setSuiteSel((prev) => { const n = new Set(prev); n.delete(id); return n; }); }
    catch (e) { setError(msg(e)); }
    finally { setBusy(''); }
  };

  const toggleSuite = (id: string) => setSuiteSel((prev) => {
    const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n;
  });

  const asInput = (f: SavedApiFlow) => ({ name: f.name, steps: f.steps, variables: f.variables });
  // Main flows = selected, in display order, minus whatever is the setup/teardown.
  const mainChosen = saved.filter((f) => suiteSel.has(f.id) && f.id !== setupId && f.id !== teardownId);
  const suiteCount = mainChosen.length + (setupId ? 1 : 0) + (teardownId ? 1 : 0);
  const canRunSuite = mainChosen.length >= 1 && suiteCount >= 2;

  // Run setup once, the selected flows in order (sharing variables), then teardown once.
  const runSuite = async () => {
    if (!canRunSuite) return;
    const setup = setupId ? saved.find((f) => f.id === setupId) : undefined;
    const teardown = teardownId ? saved.find((f) => f.id === teardownId) : undefined;
    setSuiteRunning(true); setError(''); setSuiteResult(null);
    try {
      const r = await runApiFlowSuite({
        flows: mainChosen.map(asInput),
        setup: setup ? asInput(setup) : undefined,
        teardown: teardown ? asInput(teardown) : undefined,
        allowWrites,
      });
      setSuiteResult(r);
    } catch (e) { setError(msg(e)); }
    finally { setSuiteRunning(false); }
  };

  // Parse the dataset textarea — a JSON array of row objects, OR CSV/TSV with a
  // header row (auto-detected). Returns null (with an error set) when unusable.
  const parseDataset = (): Record<string, string>[] | null => {
    const text = dataText.trim();
    if (!text) { setError('Add some dataset rows first.'); return null; }
    if (text[0] === '[' || text[0] === '{') {
      let parsed: unknown;
      try { parsed = JSON.parse(text); }
      catch { setError('That looks like JSON but does not parse — an array of row objects, e.g. [{ "id": "1" }].'); return null; }
      const rows = Array.isArray(parsed) ? parsed : [parsed];
      if (!rows.length) { setError('The JSON dataset is empty.'); return null; }
      if (!rows.every((r) => r && typeof r === 'object' && !Array.isArray(r))) { setError('Each dataset row must be a JSON object of variable → value.'); return null; }
      return rows as Record<string, string>[];
    }
    const rows = parseDelimitedDataset(text);
    if (!rows || !rows.length) { setError('Could not read the CSV/TSV — it needs a header row plus at least one data row.'); return null; }
    return rows;
  };

  // A non-mutating preview of the pasted dataset (never sets state — safe in render).
  const datasetPreview: { fmt: string; rows: number; cols: number } | null = (() => {
    const text = dataText.trim();
    if (!text) return null;
    try {
      if (text[0] === '[' || text[0] === '{') {
        const p = JSON.parse(text);
        const rows = Array.isArray(p) ? p : [p];
        if (!rows.length || !rows.every((r) => r && typeof r === 'object' && !Array.isArray(r))) return null;
        return { fmt: 'JSON', rows: rows.length, cols: Object.keys(rows[0] || {}).length };
      }
      const rows = parseDelimitedDataset(text);
      if (!rows || !rows.length) return null;
      const nl = text.indexOf('\n');
      const isTsv = (nl === -1 ? text : text.slice(0, nl)).includes('\t');
      return { fmt: isTsv ? 'TSV' : 'CSV', rows: rows.length, cols: Object.keys(rows[0] || {}).length };
    } catch { return null; }
  })();

  const dataFlow = dataId ? saved.find((f) => f.id === dataId) : undefined;
  const runDataset = async () => {
    if (!dataFlow) return;
    setError('');
    const rows = parseDataset();
    if (!rows) return;
    setDataRunning(true); setDataResult(null);
    try {
      const r = await runApiFlowDataset({ steps: dataFlow.steps, variables: dataFlow.variables, dataset: rows, allowWrites });
      setDataResult(r);
    } catch (e) { setError(msg(e)); }
    finally { setDataRunning(false); }
  };

  // Convert an in-hand run result to JUnit XML and download it (no re-run).
  const downloadJUnit = async (kind: 'flow' | 'suite' | 'dataset', name: string, result: unknown) => {
    setError('');
    try {
      const xml = await exportFlowJUnit({ kind, name, result });
      const url = URL.createObjectURL(new Blob([xml], { type: 'application/xml' }));
      const a = document.createElement('a');
      a.href = url; a.download = `${(name || kind).replace(/[^\w.-]+/g, '_').slice(0, 60)}-junit.xml`;
      document.body.appendChild(a); a.click(); a.remove();
      URL.revokeObjectURL(url);
    } catch (e) { setError(msg(e)); }
  };

  const anyWrites = (suggestions || []).some((f) => f.hasWrites) || saved.some((f) => f.steps.some((s) => isWrite(s.method)));

  return (
    <div className="h-full overflow-y-auto px-6 pb-10">
      {/* ── Header ── */}
      <div className="flex items-start gap-3 py-4">
        <span className="w-9 h-9 rounded-xl bg-gradient-to-br from-[#7C3AED] to-[#6366F1] flex items-center justify-center flex-shrink-0">
          <Workflow className="w-5 h-5 text-white" />
        </span>
        <div className="min-w-0">
          <h2 className="text-base font-semibold text-gray-900">Integration Tests</h2>
          <p className="text-[13px] text-gray-500 mt-0.5">Multi-step journeys that chain requests — carrying real values from one step to the next — and assert what each step returns.</p>
        </div>
        <div className="ml-auto flex items-center gap-2 flex-shrink-0">
          <button type="button" onClick={suggest} disabled={suggesting || !endpoints.length} className={PRIMARY_BTN} title={endpoints.length ? 'Detect integration journeys from the imported endpoints' : 'Import endpoints first'}>
            {suggesting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Sparkles className="w-3.5 h-3.5" />}
            Suggest from catalogue
          </button>
          <button type="button" onClick={onClose} aria-label="Close" title="Close" className="p-1.5 rounded-md text-gray-400 hover:text-[#7C3AED] hover:bg-[#F5F3FF]"><X className="w-4 h-4" /></button>
        </div>
      </div>

      {/* ── Write toggle (these journeys create/update/delete data) ── */}
      {anyWrites && (
        <label className={`${CARD} flex items-start gap-2.5 px-3.5 py-2.5 mb-4 cursor-pointer`}>
          <input type="checkbox" checked={allowWrites} onChange={(e) => setAllowWrites(e.target.checked)} className="mt-0.5 accent-[#7C3AED]" />
          <span className="min-w-0">
            <span className="flex items-center gap-1.5 text-[13px] font-semibold text-gray-800"><ShieldAlert className="w-3.5 h-3.5 text-amber-500" />Allow write steps (POST / PUT / PATCH / DELETE)</span>
            <span className="block text-[12px] text-gray-500 mt-0.5">Integration journeys mutate data. Point the run at a disposable environment, then enable this to let the write steps execute. Left off, the engine refuses writes.</span>
          </span>
        </label>
      )}

      {error && (
        <div className="flex items-start gap-2 px-3 py-2 rounded-xl bg-red-50 border border-red-200 mb-4">
          <AlertTriangle className="w-4 h-4 text-red-500 flex-shrink-0 mt-px" />
          <p className="text-sm text-red-700 min-w-0">{error}</p>
          <button type="button" onClick={() => setError('')} className="ml-auto text-red-400 hover:text-red-600 flex-shrink-0 text-xs">Dismiss</button>
        </div>
      )}

      {/* ── Suggested journeys ── */}
      {suggestions && (
        <section className="mb-6">
          <h3 className="text-[11px] font-semibold uppercase tracking-wide text-gray-500 mb-2">Suggested journeys {suggestions.length ? `· ${suggestions.length}` : ''}</h3>
          {suggestions.length === 0 ? (
            <div className={`${CARD} px-4 py-5 text-[13px] text-gray-500`}>
              No chainable journeys found. Integration flows are detected from resources with a create (or a list) plus a read / update / delete — import an API with full CRUD and try again.
            </div>
          ) : (
            <div className="space-y-3">
              {suggestions.map((f, i) => (
                <FlowCard
                  key={`sug-${i}`}
                  title={f.name}
                  description={f.description}
                  resource={f.resource}
                  steps={f.steps}
                  badge="Suggested"
                  result={results[`sug-${i}`]}
                  running={busy === `sug-${i}`}
                  onRun={() => run(`sug-${i}`, f.steps, f.variables)}
                  saving={busy === `save:${f.name}`}
                  onSave={() => save(f)}
                />
              ))}
            </div>
          )}
        </section>
      )}

      {/* ── Saved integration tests ── */}
      <section>
        <div className="flex items-center gap-2 mb-2">
          <h3 className="text-[11px] font-semibold uppercase tracking-wide text-gray-500">Saved integration tests {saved.length ? `· ${saved.length}` : ''}</h3>
          <button type="button" onClick={() => void loadSaved()} className="text-gray-400 hover:text-[#7C3AED]" title="Refresh"><RefreshCw className={`w-3.5 h-3.5 ${loadingSaved ? 'animate-spin' : ''}`} /></button>
          {saved.length > 1 && (
            <div className="ml-auto flex items-center gap-2">
              {mainChosen.length > 0 && <span className="text-[11px] text-gray-400">{mainChosen.length} selected</span>}
              <button type="button" onClick={() => void runSuite()} disabled={!canRunSuite || suiteRunning} className={PRIMARY_BTN} title="Run setup (once), the selected flows in order sharing captured variables, then teardown (once)">
                {suiteRunning ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Boxes className="w-3.5 h-3.5" />}Run{suiteCount >= 2 ? ` ${suiteCount}` : ''} as suite
              </button>
            </div>
          )}
        </div>
        {saved.length > 1 && (
          <>
            <p className="text-[12px] text-gray-500 mb-2">Tick two or more flows to run them in order as a <span className="font-medium">suite</span> — variables captured in one flow (a token, an id) become fixtures the next flows reuse. Optionally pick a <span className="font-medium">setup</span> flow (runs once first, seeds the suite) and a <span className="font-medium">teardown</span> flow (runs once at the end, always).</p>
            <div className="flex flex-wrap items-center gap-2 mb-3 text-[12px]">
              <label className="flex items-center gap-1.5 text-gray-500">Setup
                <select value={setupId} onChange={(e) => setSetupId(e.target.value)} className="px-2 py-1 rounded-md border border-[#E4E0F5] bg-[#FCFBFF] text-gray-700 outline-none focus:border-[#A5B4FC]">
                  <option value="">— none —</option>
                  {saved.filter((f) => f.id !== teardownId).map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
                </select>
              </label>
              <label className="flex items-center gap-1.5 text-gray-500">Teardown
                <select value={teardownId} onChange={(e) => setTeardownId(e.target.value)} className="px-2 py-1 rounded-md border border-[#E4E0F5] bg-[#FCFBFF] text-gray-700 outline-none focus:border-[#A5B4FC]">
                  <option value="">— none —</option>
                  {saved.filter((f) => f.id !== setupId).map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
                </select>
              </label>
            </div>
          </>
        )}
        {suiteResult && <SuiteResultPanel result={suiteResult} onClose={() => setSuiteResult(null)} onDownload={() => void downloadJUnit('suite', 'Integration suite', suiteResult)} />}
        {loadingSaved && !saved.length ? (
          <div className="flex items-center gap-2 text-[13px] text-gray-400 px-1 py-4"><Loader2 className="w-4 h-4 animate-spin" />Loading…</div>
        ) : saved.length === 0 ? (
          <EmptyState
            icon={Workflow}
            title="No integration tests yet"
            hint={endpoints.length ? 'Click “Suggest from catalogue” to detect journeys, then Save the ones you want to keep and re-run.' : 'Import an API first, then suggest and save integration journeys here.'}
          />
        ) : (
          <div className="space-y-3">
            {saved.map((f) => (
              <FlowCard
                key={f.id}
                title={f.name}
                resource=""
                steps={f.steps}
                badge="Saved"
                result={results[f.id]}
                running={busy === f.id}
                onRun={() => run(f.id, f.steps, f.variables)}
                deleting={busy === `del:${f.id}`}
                onDelete={() => remove(f.id)}
                selectable={saved.length > 1}
                selected={suiteSel.has(f.id)}
                onToggleSelect={() => toggleSuite(f.id)}
              />
            ))}
          </div>
        )}
        {!endpoints.length && !saved.length && (
          <div className="mt-3">
            <button type="button" onClick={onOpenCatalogue} className={SECONDARY_BTN}>Open the catalogue<ArrowRight className="w-3.5 h-3.5" /></button>
          </div>
        )}
      </section>

      {/* ── Data-driven run (one flow × a dataset of rows) ── */}
      {saved.length > 0 && (
        <section className="mt-6">
          <h3 className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-gray-500 mb-2"><Table2 className="w-3.5 h-3.5" />Data-driven run</h3>
          <div className={`${CARD} p-4`}>
            <p className="text-[12px] text-gray-500 mb-3">Run one saved flow once per <span className="font-medium">dataset row</span> — each row's values seed that run's <span className="font-mono text-[11px]">{'{{variables}}'}</span>, turning a single flow into a test matrix. Paste <span className="font-medium">JSON</span> rows or a <span className="font-medium">CSV/TSV</span> table (header row = variable names). Rows are independent (captures don't leak between rows).</p>
            <div className="flex flex-wrap items-center gap-2 mb-3 text-[12px]">
              <label className="flex items-center gap-1.5 text-gray-500">Flow
                <select value={dataId} onChange={(e) => { setDataId(e.target.value); setDataResult(null); }} className="px-2 py-1 rounded-md border border-[#E4E0F5] bg-[#FCFBFF] text-gray-700 outline-none focus:border-[#A5B4FC]">
                  <option value="">— pick a saved flow —</option>
                  {saved.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
                </select>
              </label>
              <button type="button" onClick={() => void runDataset()} disabled={!dataFlow || !dataText.trim() || dataRunning} className={`${PRIMARY_BTN} ml-auto`} title="Run the chosen flow once per dataset row">
                {dataRunning ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Play className="w-3.5 h-3.5" />}Run across dataset
              </button>
            </div>
            <textarea
              value={dataText}
              onChange={(e) => setDataText(e.target.value)}
              spellCheck={false}
              rows={5}
              placeholder={'id,role\n1,admin\n2,viewer\n\n— or JSON —\n[{ "id": "1", "role": "admin" }]'}
              className="w-full px-3 py-2 rounded-lg border border-[#E4E0F5] bg-[#FCFBFF] text-[12px] font-mono text-gray-700 outline-none focus:border-[#A5B4FC] resize-y"
            />
            <div className="flex items-center gap-2 mt-1.5">
              <p className="text-[11px] text-gray-400">JSON rows or CSV/TSV (header = variable names). Each column/key becomes a variable, overriding the flow's own. Up to 200 rows.</p>
              {datasetPreview && <span className="ml-auto text-[11px] font-medium text-emerald-600 flex-shrink-0">{datasetPreview.fmt} · {datasetPreview.rows} row{datasetPreview.rows === 1 ? '' : 's'} × {datasetPreview.cols} col{datasetPreview.cols === 1 ? '' : 's'}</span>}
            </div>
            {dataResult && <DatasetResultPanel result={dataResult} onClose={() => setDataResult(null)} onDownload={() => void downloadJUnit('dataset', dataFlow?.name || 'Data-driven run', dataResult)} />}
          </div>
        </section>
      )}
    </div>
  );
}

/* ────────────────────────────────────────────────────────────────
   One flow card — steps + optional run result, shared by both shelves.
   ──────────────────────────────────────────────────────────────── */
function FlowCard(props: {
  title: string;
  description?: string;
  resource: string;
  steps: FlowStep[];
  badge: 'Suggested' | 'Saved';
  result?: FlowRunResult;
  running: boolean;
  onRun: () => void;
  onSave?: () => void;
  saving?: boolean;
  onDelete?: () => void;
  deleting?: boolean;
  selectable?: boolean;
  selected?: boolean;
  onToggleSelect?: () => void;
}) {
  const { title, description, steps, badge, result, running, onRun, onSave, saving, onDelete, deleting, selectable, selected, onToggleSelect } = props;
  return (
    <div className={`${CARD} overflow-hidden ${selected ? 'ring-2 ring-[#C4B5FD]' : ''}`}>
      <div className="flex items-start gap-3 px-4 py-3">
        {selectable && (
          <input type="checkbox" checked={!!selected} onChange={onToggleSelect} className="mt-1 accent-[#7C3AED] flex-shrink-0" title="Include in the suite run" aria-label="Include in suite" />
        )}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-[14px] font-semibold text-gray-900 truncate">{title}</span>
            <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded border ${BRAND_CHIP}`}>{badge}</span>
            <span className="text-[11px] text-gray-400">{steps.length} steps</span>
          </div>
          {description && <p className="text-[12px] text-gray-500 mt-0.5">{description}</p>}
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          {onSave && (
            <button type="button" onClick={onSave} disabled={saving} className={SECONDARY_BTN} title="Save as a re-runnable integration test">
              {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}Save
            </button>
          )}
          {onDelete && (
            <button type="button" onClick={onDelete} disabled={deleting} className={SECONDARY_BTN} title="Delete this integration test">
              {deleting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Trash2 className="w-3.5 h-3.5" />}
            </button>
          )}
          <button type="button" onClick={onRun} disabled={running} className={PRIMARY_BTN} title="Run the journey end to end">
            {running ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Play className="w-3.5 h-3.5" />}Run
          </button>
        </div>
      </div>

      {/* Steps — grouped by lifecycle phase. When a result exists we render it
          directly (so a teardown that ran after a main failure still shows). */}
      <div className="border-t border-gray-100">
        {(() => {
          const rows: { name?: string; badge?: string; url?: string; phase: StepPhase; poll?: { attempts: number; until?: string }; r?: FlowStepResult }[] = result
            ? result.steps.map((rr) => ({ name: rr.name, badge: rr.method, url: rr.url, phase: (rr.phase || 'main'), r: rr }))
            : steps.map((s) => {
                // A control-flow step (e.g. a retry/poll wrapper the bridge adds for
                // eventual consistency) shows its inner request + a poll badge.
                if (s.type && s.type !== 'request') {
                  const inner = s.type === 'retry' ? s.steps?.[0] : undefined;
                  return {
                    name: s.name,
                    badge: inner?.method || s.type.toUpperCase(),
                    url: inner?.url,
                    phase: (s.phase || 'main'),
                    poll: s.type === 'retry' ? { attempts: s.retry?.attempts || 1, until: s.retry?.until?.expr } : undefined,
                  };
                }
                return { name: s.name, badge: s.method, url: s.url, phase: (s.phase || 'main') };
              });
          const phases = new Set(rows.map((x) => x.phase));
          const showHeaders = phases.has('setup') || phases.has('teardown');
          return rows.map((row, i) => {
            const r = row.r;
            const header = showHeaders && (i === 0 || rows[i - 1]!.phase !== row.phase) ? <PhaseHeader phase={row.phase} /> : null;
            return (
              <Fragment key={i}>
                {header}
                <div className="flex items-center gap-2.5 px-4 py-2 text-[12px] border-t border-gray-50 first:border-t-0">
                  <span className="text-gray-300 w-4 text-right flex-shrink-0">{i + 1}</span>
                  {result ? (r?.ok ? <CheckCircle2 className="w-4 h-4 text-emerald-500 flex-shrink-0" /> : <XCircle className="w-4 h-4 text-rose-500 flex-shrink-0" />) : <span className="w-4 flex-shrink-0" />}
                  <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded border flex-shrink-0 ${methodColor(row.badge || 'GET')}`}>{(row.badge || 'GET').toUpperCase()}</span>
                  <span className="font-medium text-gray-700 flex-shrink-0">{row.name || '—'}</span>
                  {row.poll && <span className="text-[10px] px-1.5 py-0.5 rounded bg-indigo-50 text-indigo-600 flex-shrink-0" title={row.poll.until ? `polls until ${row.poll.until} (eventual consistency)` : 'retries until it passes'}>poll ×{row.poll.attempts}</span>}
                  <span className="text-gray-400 truncate font-mono text-[11px]">{pathOf(row.url || '')}</span>
                  <span className="ml-auto flex items-center gap-2 flex-shrink-0">
                    {r && <span className="text-gray-400">{r.status ?? '—'} · {formatDuration(r.elapsedMs)}</span>}
                    {r && r.checks.some((c) => !c.pass) && <span className="text-rose-600 font-medium">{r.checks.filter((c) => !c.pass).length} check{r.checks.filter((c) => !c.pass).length === 1 ? '' : 's'} failed</span>}
                    {r && Object.keys(r.extracted).length > 0 && <span className="text-[11px] text-[#7C3AED]">↳ {Object.entries(r.extracted).map(([k, v]) => `${k}=${String(v).slice(0, 16)}`).join(', ')}</span>}
                  </span>
                </div>
              </Fragment>
            );
          });
        })()}
      </div>

      {result && (
        <div className={`px-4 py-2 text-[12px] font-medium border-t ${result.passed ? 'bg-emerald-50 text-emerald-700 border-emerald-100' : 'bg-rose-50 text-rose-700 border-rose-100'}`}>
          {result.passed ? 'Journey passed' : 'Journey failed'} · {result.stepsRun}/{result.stepsTotal} steps · {formatDuration(result.durationMs)}
        </div>
      )}
    </div>
  );
}

/* ────────────────────────────────────────────────────────────────
   Suite result — per-flow outcomes + the shared fixtures threaded through.
   ──────────────────────────────────────────────────────────────── */
function SuiteResultPanel({ result, onClose, onDownload }: { result: SuiteRunResult; onClose: () => void; onDownload: () => void }) {
  const vars = Object.entries(result.variables || {});
  return (
    <div className={`${CARD} overflow-hidden mb-3`}>
      <div className={`flex items-center gap-2 px-4 py-2.5 border-b ${result.passed ? 'bg-emerald-50 border-emerald-100' : 'bg-rose-50 border-rose-100'}`}>
        <Boxes className={`w-4 h-4 ${result.passed ? 'text-emerald-600' : 'text-rose-600'}`} />
        <span className={`text-[13px] font-semibold ${result.passed ? 'text-emerald-700' : 'text-rose-700'}`}>Suite {result.passed ? 'passed' : 'failed'}</span>
        <span className="text-[12px] text-gray-500">{result.flowsRun}/{result.flowsTotal} flows · {formatDuration(result.durationMs)}</span>
        <button type="button" onClick={onDownload} className="ml-auto inline-flex items-center gap-1 text-[11px] text-gray-500 hover:text-[#7C3AED]" title="Download this run as JUnit XML for CI"><Download className="w-3.5 h-3.5" />JUnit</button>
        <button type="button" onClick={onClose} className="text-gray-400 hover:text-gray-600 text-xs">Dismiss</button>
      </div>
      <div className="divide-y divide-gray-50">
        {result.flows.map((f, i) => (
          <div key={i} className="flex items-center gap-2.5 px-4 py-2 text-[12px]">
            <span className="text-gray-300 w-4 text-right flex-shrink-0">{i + 1}</span>
            {f.passed ? <CheckCircle2 className="w-4 h-4 text-emerald-500 flex-shrink-0" /> : <XCircle className="w-4 h-4 text-rose-500 flex-shrink-0" />}
            <span className="font-medium text-gray-700 truncate">{f.name}</span>
            {f.role === 'setup' && <span className="text-[9px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded bg-sky-50 text-sky-600 flex-shrink-0">Setup</span>}
            {f.role === 'teardown' && <span className="text-[9px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded bg-amber-50 text-amber-600 flex-shrink-0">Teardown</span>}
            <span className="ml-auto text-gray-400 flex-shrink-0">{f.run.stepsRun}/{f.run.stepsTotal} steps · {formatDuration(f.run.durationMs)}</span>
          </div>
        ))}
      </div>
      {vars.length > 0 && (
        <div className="px-4 py-2.5 bg-gray-50/60 border-t border-gray-100">
          <div className="text-[10px] font-semibold uppercase tracking-wide text-gray-400 mb-1">Shared fixtures (threaded through the suite)</div>
          <div className="flex flex-wrap gap-1.5">
            {vars.map(([k, v]) => (
              <span key={k} className="text-[11px] font-mono px-1.5 py-0.5 rounded bg-white border border-gray-200 text-gray-600">{k}=<span className="text-[#7C3AED]">{String(v).slice(0, 24)}</span></span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/** Per-row result grid for a data-driven run. */
function DatasetResultPanel({ result, onClose, onDownload }: { result: DatasetRunResult; onClose: () => void; onDownload: () => void }) {
  const rowLabel = (row: Record<string, string>) => {
    const entries = Object.entries(row);
    if (!entries.length) return '(empty row)';
    return entries.map(([k, v]) => `${k}=${String(v).slice(0, 16)}`).join('  ');
  };
  return (
    <div className={`${CARD} overflow-hidden mt-3`}>
      <div className={`flex items-center gap-2 px-4 py-2.5 border-b ${result.passed ? 'bg-emerald-50 border-emerald-100' : 'bg-rose-50 border-rose-100'}`}>
        <Table2 className={`w-4 h-4 ${result.passed ? 'text-emerald-600' : 'text-rose-600'}`} />
        <span className={`text-[13px] font-semibold ${result.passed ? 'text-emerald-700' : 'text-rose-700'}`}>{result.rowsPassed}/{result.rowsRun} rows passed</span>
        <span className="text-[12px] text-gray-500">{result.rowsRun < result.rowsTotal ? `· stopped after ${result.rowsRun}/${result.rowsTotal} · ` : '· '}{formatDuration(result.durationMs)}</span>
        <button type="button" onClick={onDownload} className="ml-auto inline-flex items-center gap-1 text-[11px] text-gray-500 hover:text-[#7C3AED]" title="Download this run as JUnit XML for CI"><Download className="w-3.5 h-3.5" />JUnit</button>
        <button type="button" onClick={onClose} className="text-gray-400 hover:text-gray-600 text-xs">Dismiss</button>
      </div>
      <div className="divide-y divide-gray-50 max-h-80 overflow-y-auto">
        {result.rows.map((r) => (
          <div key={r.index} className="flex items-center gap-2.5 px-4 py-2 text-[12px]">
            <span className="text-gray-300 w-5 text-right flex-shrink-0">{r.index + 1}</span>
            {r.passed ? <CheckCircle2 className="w-4 h-4 text-emerald-500 flex-shrink-0" /> : <XCircle className="w-4 h-4 text-rose-500 flex-shrink-0" />}
            <span className="font-mono text-gray-600 truncate">{rowLabel(r.row)}</span>
            <span className="ml-auto text-gray-400 flex-shrink-0">{r.run.stepsRun}/{r.run.stepsTotal} steps · {formatDuration(r.run.durationMs)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/** A small labelled divider marking the start of a lifecycle phase. */
function PhaseHeader({ phase }: { phase: StepPhase }) {
  const meta = phase === 'setup'
    ? { label: 'Setup', cls: 'text-sky-600' }
    : phase === 'teardown'
      ? { label: 'Teardown · always runs', cls: 'text-amber-600' }
      : { label: 'Steps', cls: 'text-gray-400' };
  return <div className={`px-4 pt-2 pb-1 text-[10px] font-semibold uppercase tracking-wide bg-gray-50/60 ${meta.cls}`}>{meta.label}</div>;
}

function isWrite(method?: string): boolean {
  return ['POST', 'PUT', 'PATCH', 'DELETE'].includes((method || '').toUpperCase());
}

/** Parse delimited text into a grid, honouring quoted fields ("a,b", "he said ""hi"""). */
function parseCsvGrid(text: string, delim: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else quoted = false; }
      else field += c;
    } else if (c === '"') { quoted = true; }
    else if (c === delim) { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c !== '\r') { field += c; }
  }
  row.push(field); rows.push(row);
  return rows;
}

/** CSV/TSV (header row + data rows) → row objects. Delimiter auto-detected (tab vs comma). Null if unusable. */
function parseDelimitedDataset(text: string): Record<string, string>[] | null {
  const nl = text.indexOf('\n');
  const header = nl === -1 ? text : text.slice(0, nl);
  const delim = header.includes('\t') ? '\t' : ',';
  const grid = parseCsvGrid(text, delim).filter((r) => r.some((c) => c.trim() !== ''));
  if (grid.length < 2) return null;
  const headers = grid[0]!.map((h) => h.trim());
  if (!headers.some((h) => h)) return null;
  return grid.slice(1).map((cells) => {
    const obj: Record<string, string> = {};
    headers.forEach((h, i) => { if (h) obj[h] = (cells[i] ?? '').trim(); });
    return obj;
  });
}

function msg(e: unknown): string {
  const anyE = e as { response?: { data?: { error?: string } }; message?: string };
  return anyE?.response?.data?.error || anyE?.message || 'Something went wrong.';
}
