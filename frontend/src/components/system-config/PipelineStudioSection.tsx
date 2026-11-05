/**
 * Pipeline Studio — admin editor for the AI agent pipeline.
 *
 * Surfaces the configuration the backend already persists (qa_pipeline_definitions,
 * loaded/saved via /api/pipeline-admin/pipeline-definition). An admin can tune each
 * agent/stage's model, budget, turn/time limits, retries, approval mode and MCP
 * scope, toggle it on/off, adjust the global run budget and convergence guards,
 * check worker connectivity, and test the AI runner — then Save, which the server
 * versions (so a prior version is always recoverable).
 *
 * This is purely additive: it reads and writes through existing endpoints and
 * never touches the orchestrator or the pipeline engine. Editing an agent's
 * actual prompt/instructions is intentionally out of scope for V1.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Workflow, Save, RotateCcw, Zap, ShieldCheck, AlertTriangle, CheckCircle2,
  Plug, PlugZap, Loader2, DollarSign, Settings2, FileText, Eraser,
} from 'lucide-react';
import {
  getPipelineDefinition, savePipelineDefinition, testAiConnection, getWorkerStatus, getAgentPrompt,
} from '@/services/api';
import { useToast } from '@/components/feedback/ToastProvider';

/* ── Loose shapes (the frontend has no PipelineDefinition type; the backend owns it) ── */
interface Stage {
  id: string;
  name: string;
  agent?: string;
  agentFile?: string;
  promptOverride?: string;
  model: string;
  enabled: boolean;
  maxTurns?: number;
  budgetCap?: number;
  retries?: number;
  timeoutSeconds?: number;
  approvalMode?: string;
  mcpConfig?: string | null;
  description?: string;
  next?: Record<string, string>;
  routing?: { condition?: string; rules?: Array<{ when: string; then: string }> };
  [k: string]: any;
}
interface Definition {
  version?: string;
  defaults?: { budgetPerRunUsd?: number; autoInvoke?: boolean; agentRunner?: string; [k: string]: any };
  models?: { available?: string[]; costPerMTokenInput?: Record<string, number>; costPerMTokenOutput?: Record<string, number> };
  stages: Stage[];
  terminalStates?: string[];
  convergenceGuards?: { enabled?: boolean; maxIterations?: { enabled?: boolean; limit?: number; action?: string }; [k: string]: any };
  [k: string]: any;
}

const MCP_OPTIONS = [
  { value: '', label: 'None' },
  { value: 'browser-only', label: 'Browser only' },
  { value: 'browser-and-test', label: 'Browser + test' },
];
const APPROVAL_OPTIONS = [
  { value: 'auto', label: 'Automatic' },
  { value: 'manual', label: 'Manual approval' },
];

const CARD = 'bg-white rounded-xl border border-gray-200 p-4';
const LABEL = 'block text-xs font-semibold text-[#6B7280] uppercase tracking-wide mb-1';
const INPUT =
  'w-full px-3 py-2 rounded-lg border border-gray-200 text-sm text-[#1E1B4B] focus:outline-none focus:ring-2 focus:ring-[#7C3AED]/30 focus:border-[#7C3AED]';

function num(v: string, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

export default function PipelineStudioSection() {
  const toast = useToast();
  const [def, setDef] = useState<Definition | null>(null);
  const [original, setOriginal] = useState<string>(''); // JSON snapshot for dirty/diff
  const [selectedId, setSelectedId] = useState<string>('');
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [loadingPrompt, setLoadingPrompt] = useState(false);
  const [worker, setWorker] = useState<{ connected: boolean; lastHeartbeat: string | null } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError('');
    try {
      const d = (await getPipelineDefinition()) as Definition;
      const stages = Array.isArray(d?.stages) ? d.stages : [];
      setDef(d);
      setOriginal(JSON.stringify(d));
      setSelectedId((prev) => (prev && stages.some((s) => s.id === prev) ? prev : stages[0]?.id || ''));
    } catch (err: any) {
      setLoadError(err?.response?.data?.error || err?.message || 'Failed to load the pipeline definition.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  // Best-effort worker connectivity — never blocks the editor.
  useEffect(() => {
    let alive = true;
    getWorkerStatus().then((w: any) => { if (alive) setWorker({ connected: !!w?.connected, lastHeartbeat: w?.lastHeartbeat || null }); }).catch(() => {});
    return () => { alive = false; };
  }, []);

  const models = def?.models?.available?.length ? def!.models!.available! : ['haiku', 'sonnet', 'opus'];
  const dirty = !!def && JSON.stringify(def) !== original;
  const selected = useMemo(() => def?.stages.find((s) => s.id === selectedId) || null, [def, selectedId]);

  const patchStage = useCallback((id: string, patch: Partial<Stage>) => {
    setDef((prev) => (prev ? { ...prev, stages: prev.stages.map((s) => (s.id === id ? { ...s, ...patch } : s)) } : prev));
  }, []);
  const patchDefaults = useCallback((patch: Record<string, any>) => {
    setDef((prev) => (prev ? { ...prev, defaults: { ...(prev.defaults || {}), ...patch } } : prev));
  }, []);
  const patchGuards = useCallback((patch: Record<string, any>) => {
    setDef((prev) => (prev ? { ...prev, convergenceGuards: { ...(prev.convergenceGuards || {}), ...patch } } : prev));
  }, []);

  /* ── Validation ── */
  const errors = useMemo(() => {
    if (!def) return [] as string[];
    const out: string[] = [];
    const ids = new Set(def.stages.map((s) => s.id));
    const terminals = new Set(def.terminalStates || []);
    if (!def.stages.some((s) => s.enabled)) out.push('At least one stage must be enabled.');
    for (const s of def.stages) {
      if (!models.includes(s.model)) out.push(`${s.name}: model "${s.model}" is not in the available list.`);
      if ((s.budgetCap ?? 0) <= 0) out.push(`${s.name}: budget cap must be greater than 0.`);
      if ((s.maxTurns ?? 0) <= 0) out.push(`${s.name}: max turns must be greater than 0.`);
      if ((s.timeoutSeconds ?? 0) <= 0) out.push(`${s.name}: timeout must be greater than 0.`);
      if ((s.retries ?? 0) < 0) out.push(`${s.name}: retries cannot be negative.`);
      const targets = [
        ...Object.values(s.next || {}),
        ...((s.routing?.rules || []).map((r) => r.then)),
      ].filter(Boolean) as string[];
      for (const t of targets) {
        if (!ids.has(t) && !terminals.has(t)) out.push(`${s.name}: routing target "${t}" is not a known stage or terminal state.`);
      }
    }
    const run = def.defaults?.budgetPerRunUsd;
    if (run != null && run <= 0) out.push('Run budget must be greater than 0.');
    return out;
  }, [def, models]);

  const save = useCallback(async () => {
    if (!def || errors.length) return;
    setSaving(true);
    try {
      await savePipelineDefinition(def);
      setOriginal(JSON.stringify(def));
      toast.success('Pipeline saved — a new version was recorded.');
    } catch (err: any) {
      toast.fromError(err);
    } finally {
      setSaving(false);
    }
  }, [def, errors.length, toast]);

  const reset = useCallback(() => {
    if (original) { setDef(JSON.parse(original)); toast.success('Reverted unsaved changes.'); }
  }, [original, toast]);

  const runTest = useCallback(async () => {
    setTesting(true);
    try {
      const res = await testAiConnection({ authMethod: 'claude-cli' });
      if (res?.ok) toast.success(res.message || 'Runner reachable.');
      else toast.fromError({ message: res?.message || 'Runner not reachable.' });
    } catch (err: any) {
      toast.fromError(err);
    } finally {
      setTesting(false);
    }
  }, [toast]);

  // Seed the override editor with the agent's current on-disk instructions, so
  // the user edits from the real prompt rather than a blank box. Does not save.
  const loadDefaultPrompt = useCallback(async () => {
    if (!selected?.agentFile) return;
    setLoadingPrompt(true);
    try {
      const { content } = await getAgentPrompt(selected.agentFile);
      patchStage(selected.id, { promptOverride: content });
      toast.success('Loaded the default instructions — edit and Save to apply.');
    } catch (err: any) {
      toast.fromError(err);
    } finally {
      setLoadingPrompt(false);
    }
  }, [selected, patchStage, toast]);

  /* ── Render ── */
  if (loading) {
    return (
      <div className="flex items-center gap-2 text-sm text-[#6B7280] py-10 justify-center">
        <Loader2 className="w-4 h-4 animate-spin" /> Loading pipeline…
      </div>
    );
  }
  if (loadError || !def) {
    return (
      <div className="max-w-lg mx-auto py-8 text-center">
        <AlertTriangle className="w-8 h-8 text-amber-500 mx-auto mb-2" />
        <p className="text-sm text-[#1E1B4B] mb-3">{loadError || 'No pipeline definition found.'}</p>
        <button onClick={() => void load()} className="px-4 py-2 rounded-lg bg-[#7C3AED] text-white text-sm font-medium hover:bg-[#6D28D9]">Retry</button>
      </div>
    );
  }

  const costIn = def.models?.costPerMTokenInput || {};
  const costOut = def.models?.costPerMTokenOutput || {};

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2">
          <div className="w-9 h-9 rounded-lg bg-gradient-to-br from-[#7C3AED] to-[#6366F1] flex items-center justify-center">
            <Workflow className="w-5 h-5 text-white" />
          </div>
          <div>
            <h2 className="text-base font-semibold text-[#1E1B4B]">Pipeline Studio</h2>
            <p className="text-xs text-[#6B7280]">Tune each AI agent's model, budget and limits. Saving records a new version.</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {worker && (
            <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium ${worker.connected ? 'bg-green-50 text-green-700' : 'bg-gray-100 text-gray-500'}`}>
              {worker.connected ? <PlugZap className="w-3.5 h-3.5" /> : <Plug className="w-3.5 h-3.5" />}
              {worker.connected ? 'Worker connected' : 'Worker offline'}
            </span>
          )}
          <button onClick={runTest} disabled={testing} className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-gray-200 text-sm font-medium text-[#1E1B4B] hover:bg-gray-50 disabled:opacity-50">
            {testing ? <Loader2 className="w-4 h-4 animate-spin" /> : <Zap className="w-4 h-4" />} Test runner
          </button>
          <button onClick={reset} disabled={!dirty || saving} className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-gray-200 text-sm font-medium text-[#1E1B4B] hover:bg-gray-50 disabled:opacity-40">
            <RotateCcw className="w-4 h-4" /> Reset
          </button>
          <button onClick={save} disabled={!dirty || saving || errors.length > 0} className="inline-flex items-center gap-1.5 px-4 py-1.5 rounded-lg bg-[#7C3AED] text-white text-sm font-semibold hover:bg-[#6D28D9] disabled:opacity-40">
            {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />} Save
          </button>
        </div>
      </div>

      {/* Validation banner */}
      {errors.length > 0 && (
        <div className="rounded-xl border border-amber-200 bg-amber-50 p-3">
          <div className="flex items-center gap-2 text-sm font-medium text-amber-800 mb-1">
            <AlertTriangle className="w-4 h-4" /> Fix {errors.length} issue{errors.length > 1 ? 's' : ''} before saving
          </div>
          <ul className="list-disc list-inside text-xs text-amber-700 space-y-0.5">
            {errors.slice(0, 6).map((e, i) => <li key={i}>{e}</li>)}
          </ul>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-[260px_1fr] gap-4">
        {/* Stage list */}
        <div className="space-y-1.5">
          {def.stages.map((s, i) => {
            const active = s.id === selectedId;
            return (
              <button
                key={s.id}
                onClick={() => setSelectedId(s.id)}
                className={`w-full text-left px-3 py-2.5 rounded-xl border transition-all ${active ? 'border-[#7C3AED] bg-[#F5F3FF]' : 'border-gray-200 bg-white hover:bg-gray-50'}`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="flex items-center gap-2 min-w-0">
                    <span className="text-[10px] font-mono text-[#9CA3AF] w-4">{i + 1}</span>
                    <span className="text-sm font-medium text-[#1E1B4B] truncate">{s.name}</span>
                  </span>
                  <span className={`w-2 h-2 rounded-full flex-shrink-0 ${s.enabled ? 'bg-green-500' : 'bg-gray-300'}`} title={s.enabled ? 'Enabled' : 'Disabled'} />
                </div>
                <div className="flex items-center gap-1.5 mt-1 pl-6">
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-[#EDE9FE] text-[#6D28D9] font-medium capitalize">{s.model}</span>
                  <span className="text-[10px] text-[#9CA3AF]">${(s.budgetCap ?? 0).toFixed(2)}</span>
                </div>
              </button>
            );
          })}
        </div>

        {/* Stage editor */}
        {selected && (
          <div className="space-y-4">
            {/* Information */}
            <div className={CARD}>
              <h3 className="text-sm font-semibold text-[#1E1B4B] mb-3 flex items-center gap-2"><Settings2 className="w-4 h-4 text-[#7C3AED]" /> {selected.name}</h3>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className={LABEL}>Stage ID</label>
                  <input className={`${INPUT} bg-gray-50 text-[#6B7280]`} value={selected.id} disabled />
                </div>
                <div>
                  <label className={LABEL}>Model</label>
                  <select className={INPUT} value={selected.model} onChange={(e) => patchStage(selected.id, { model: e.target.value })}>
                    {models.map((m) => (
                      <option key={m} value={m}>
                        {m}{costIn[m] != null ? ` — $${costIn[m]}/$${costOut[m] ?? '?'} per Mtok` : ''}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
              <div className="mt-3">
                <label className={LABEL}>Description</label>
                <textarea className={`${INPUT} resize-none`} rows={2} value={selected.description || ''} onChange={(e) => patchStage(selected.id, { description: e.target.value })} />
              </div>
              <label className="mt-3 inline-flex items-center gap-2 cursor-pointer">
                <input type="checkbox" className="rounded border-gray-300 text-[#7C3AED] focus:ring-[#7C3AED]" checked={!!selected.enabled} onChange={(e) => patchStage(selected.id, { enabled: e.target.checked })} />
                <span className="text-sm text-[#1E1B4B]">Stage enabled</span>
              </label>
            </div>

            {/* Configuration */}
            <div className={CARD}>
              <h3 className="text-sm font-semibold text-[#1E1B4B] mb-3">Execution limits</h3>
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                <div>
                  <label className={LABEL}>Budget cap ($)</label>
                  <input type="number" step="0.01" min="0" className={INPUT} value={selected.budgetCap ?? 0} onChange={(e) => patchStage(selected.id, { budgetCap: num(e.target.value, 0) })} />
                </div>
                <div>
                  <label className={LABEL}>Max turns</label>
                  <input type="number" min="1" className={INPUT} value={selected.maxTurns ?? 0} onChange={(e) => patchStage(selected.id, { maxTurns: num(e.target.value, 0) })} />
                </div>
                <div>
                  <label className={LABEL}>Timeout (s)</label>
                  <input type="number" min="1" className={INPUT} value={selected.timeoutSeconds ?? 0} onChange={(e) => patchStage(selected.id, { timeoutSeconds: num(e.target.value, 0) })} />
                </div>
                <div>
                  <label className={LABEL}>Retries</label>
                  <input type="number" min="0" className={INPUT} value={selected.retries ?? 0} onChange={(e) => patchStage(selected.id, { retries: num(e.target.value, 0) })} />
                </div>
                <div>
                  <label className={LABEL}>Approval</label>
                  <select className={INPUT} value={selected.approvalMode || 'auto'} onChange={(e) => patchStage(selected.id, { approvalMode: e.target.value })}>
                    {APPROVAL_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                  </select>
                </div>
                <div>
                  <label className={LABEL}>MCP tools</label>
                  <select className={INPUT} value={selected.mcpConfig || ''} onChange={(e) => patchStage(selected.id, { mcpConfig: e.target.value || null })}>
                    {MCP_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                  </select>
                </div>
              </div>
            </div>

            {/* Instructions (override) */}
            <div className={CARD}>
              <div className="flex items-center justify-between gap-2 mb-2">
                <h3 className="text-sm font-semibold text-[#1E1B4B] flex items-center gap-2">
                  <FileText className="w-4 h-4 text-[#7C3AED]" /> Agent instructions
                  {selected.promptOverride && selected.promptOverride.trim()
                    ? <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-100 text-amber-700 font-medium">Custom override</span>
                    : <span className="text-[10px] px-1.5 py-0.5 rounded bg-gray-100 text-gray-500 font-medium">Using default file</span>}
                </h3>
                <div className="flex items-center gap-2">
                  {!(selected.promptOverride && selected.promptOverride.trim()) ? (
                    <button onClick={loadDefaultPrompt} disabled={loadingPrompt} className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg border border-gray-200 text-xs font-medium text-[#1E1B4B] hover:bg-gray-50 disabled:opacity-50">
                      {loadingPrompt ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <FileText className="w-3.5 h-3.5" />} Load default to edit
                    </button>
                  ) : (
                    <button onClick={() => patchStage(selected.id, { promptOverride: '' })} className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg border border-gray-200 text-xs font-medium text-[#1E1B4B] hover:bg-gray-50">
                      <Eraser className="w-3.5 h-3.5" /> Clear override
                    </button>
                  )}
                </div>
              </div>
              <textarea
                className={`${INPUT} font-mono text-xs leading-relaxed resize-y`}
                rows={10}
                value={selected.promptOverride || ''}
                placeholder={`No override — this stage uses its built-in instructions (${selected.agentFile || 'agent file'}). Click "Load default to edit" to start from the current prompt, or type here to override.`}
                onChange={(e) => patchStage(selected.id, { promptOverride: e.target.value })}
              />
              <p className="text-xs text-[#9CA3AF] mt-1">Source: {selected.agentFile || '—'} · an override replaces the file for this stage when the pipeline runs.</p>
            </div>
          </div>
        )}
      </div>

      {/* Global pipeline settings */}
      <div className={CARD}>
        <h3 className="text-sm font-semibold text-[#1E1B4B] mb-3 flex items-center gap-2"><ShieldCheck className="w-4 h-4 text-[#7C3AED]" /> Pipeline guardrails</h3>
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
          <div>
            <label className={LABEL}><DollarSign className="w-3 h-3 inline -mt-0.5" /> Run budget ($)</label>
            <input type="number" step="0.1" min="0" className={INPUT} value={def.defaults?.budgetPerRunUsd ?? 0} onChange={(e) => patchDefaults({ budgetPerRunUsd: num(e.target.value, 0) })} />
          </div>
          <div>
            <label className={LABEL}>Max healing iterations</label>
            <input type="number" min="1" className={INPUT} value={def.convergenceGuards?.maxIterations?.limit ?? 3} onChange={(e) => patchGuards({ maxIterations: { ...(def.convergenceGuards?.maxIterations || {}), enabled: true, limit: num(e.target.value, 3) } })} />
          </div>
          <div className="flex items-end">
            <label className="inline-flex items-center gap-2 cursor-pointer pb-2">
              <input type="checkbox" className="rounded border-gray-300 text-[#7C3AED] focus:ring-[#7C3AED]" checked={!!def.defaults?.autoInvoke} onChange={(e) => patchDefaults({ autoInvoke: e.target.checked })} />
              <span className="text-sm text-[#1E1B4B]">Auto-invoke stages</span>
            </label>
          </div>
        </div>
        {!dirty && (
          <p className="mt-3 text-xs text-green-700 flex items-center gap-1.5"><CheckCircle2 className="w-3.5 h-3.5" /> All changes saved{def.version ? ` (version ${def.version})` : ''}.</p>
        )}
      </div>
    </div>
  );
}
