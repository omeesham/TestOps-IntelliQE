import { useState, useEffect, useCallback, useRef } from 'react';
import {
  BrainCircuit, Eye, EyeOff, Loader2, Zap, Save, Pencil, Trash2, X,
  CheckCircle2, AlertTriangle, ShieldCheck, Star, KeyRound, Link2, Cpu,
} from 'lucide-react';
import {
  getLlmConfig, getLlmModels, testLlmConnection, saveLlmConfig, deleteLlmConfig,
  type LlmProviderConfig,
} from '@/services/api';
import { useToast } from '@/components/feedback/ToastProvider';

type ProviderId = 'anthropic' | 'gemini' | 'openai';
type ConnStatus = LlmProviderConfig['status'];
type AuthMethodId = 'api_key' | 'claude_code';

/** Editable model settings kept per auth method so API Key and Claude Code stay independent. */
interface MethodDraft {
  model: string;
  agentModels: Record<string, string>;
  effort: '' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  extendedThinking: boolean;
}
const BLANK_DRAFT: MethodDraft = { model: '', agentModels: {}, effort: '', extendedThinking: false };

const PROVIDER_META: { value: ProviderId; label: string; endpoint: string; keyHint: string }[] = [
  { value: 'anthropic', label: 'Anthropic Claude', endpoint: 'https://api.anthropic.com',                  keyHint: 'sk-ant-api03-…' },
  { value: 'gemini',    label: 'Google Gemini',    endpoint: 'https://generativelanguage.googleapis.com',  keyHint: 'AIza…' },
  { value: 'openai',    label: 'OpenAI ChatGPT',   endpoint: 'https://api.openai.com/v1',                  keyHint: 'sk-…' },
];

// Selectable models per provider. Shown immediately so the model can always be
// changed; live models from a successful Test Connection are merged on top.
const PROVIDER_MODELS: Record<ProviderId, string[]> = {
  anthropic: [
    'claude-fable-5', 'claude-opus-4-8', 'claude-opus-4-7', 'claude-opus-4-6',
    'claude-opus-4-5', 'claude-sonnet-5', 'claude-sonnet-4-6', 'claude-sonnet-4-5', 'claude-haiku-4-5',
  ],
  openai: ['gpt-4o', 'gpt-4o-mini', 'gpt-4.1', 'gpt-4.1-mini', 'gpt-4-turbo', 'o3', 'o3-mini', 'o1'],
  gemini: ['gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.0-flash', 'gemini-1.5-pro', 'gemini-1.5-flash'],
};

/** Curated list for a provider, with the saved model pinned first if not already present. */
function modelsFor(provider: ProviderId, savedModel?: string | null): string[] {
  const base = PROVIDER_MODELS[provider] || [];
  return savedModel && !base.includes(savedModel) ? [savedModel, ...base] : base;
}

/**
 * Display-only label for a model id: render version numbers with dots
 * (e.g. "claude-opus-4-8" → "claude-opus-4.8"). The stored value keeps the
 * real dashed id that the provider APIs require.
 */
function formatModelLabel(id: string): string {
  return id.replace(/(\d)-(\d)/g, '$1.$2');
}

// Pipeline agents the admin can assign a model to. Keys MUST match the backend
// (services/llm.service.ts / agents). Each can run on its own model, or fall
// back to the provider's default model when left as "Use default".
const AGENT_STAGES: { key: string; label: string; hint: string }[] = [
  { key: 'requirement', label: 'Requirement Analysis', hint: 'Parse requirements into structured analysis' },
  { key: 'audit',       label: 'Edge-Case & Security Audit', hint: 'Add security / boundary scenarios' },
  { key: 'planner',     label: 'Test Planning', hint: 'Risk-based test strategy' },
  { key: 'generator',   label: 'Test Case Generation', hint: 'Author the test cases' },
  { key: 'script',      label: 'Script Generation', hint: 'Playwright automation scripts' },
  { key: 'heal',        label: 'Auto-Healing', hint: 'Fix failing tests' },
];

const STATUS_META: Record<ConnStatus, { label: string; dot: string; text: string; bg: string; border: string }> = {
  connected:           { label: 'Connected',           dot: 'bg-emerald-500', text: 'text-emerald-700', bg: 'bg-emerald-50', border: 'border-emerald-200' },
  not_configured:      { label: 'Not Configured',      dot: 'bg-gray-400',    text: 'text-gray-600',    bg: 'bg-gray-50',    border: 'border-gray-200' },
  invalid_credentials: { label: 'Invalid Credentials', dot: 'bg-red-500',     text: 'text-red-700',     bg: 'bg-red-50',     border: 'border-red-200' },
  connection_failed:   { label: 'Connection Failed',   dot: 'bg-amber-500',   text: 'text-amber-700',   bg: 'bg-amber-50',   border: 'border-amber-200' },
};

const INPUT_CLASS =
  'w-full px-3 py-2.5 rounded-xl border border-[#DDD6FE] bg-[#F5F3FF] text-sm outline-none focus:ring-2 focus:ring-[#7C3AED]/20 focus:border-[#7C3AED] placeholder:text-gray-400 transition-all';
const LABEL_CLASS = 'block text-xs font-semibold uppercase tracking-wide text-[#6B7280] mb-1.5';

function formatDate(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }).replace(/ /g, '-');
}

function StatusBadge({ status }: { status: ConnStatus }) {
  const m = STATUS_META[status];
  return (
    <span className={`inline-flex items-center gap-2 px-3 py-1.5 rounded-full text-xs font-semibold border ${m.bg} ${m.text} ${m.border}`}>
      <span className={`w-2 h-2 rounded-full ${m.dot}`} />
      {m.label}
    </span>
  );
}

export default function LlmConfigurationSection() {
  const toast = useToast();
  const [providers, setProviders] = useState<LlmProviderConfig[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');

  const [selected, setSelected] = useState<ProviderId>('anthropic');
  const [mode, setMode] = useState<'view' | 'edit'>('edit');

  const [apiKey, setApiKey] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [model, setModel] = useState('');
  const [agentModels, setAgentModels] = useState<Record<string, string>>({});
  const [showKey, setShowKey] = useState(false);

  // Anthropic auth method: 'api_key' (API credits) or 'claude_code' (subscription).
  const [authMethod, setAuthMethod] = useState<'api_key' | 'claude_code'>('api_key');
  const [oauthToken, setOauthToken] = useState('');
  const [showToken, setShowToken] = useState(false);

  // Reasoning effort + extended ("ultra") thinking (Anthropic). Empty effort = provider default.
  const [effort, setEffort] = useState<'' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'>('');
  const [extendedThinking, setExtendedThinking] = useState(false);

  // Model settings held separately per auth method so switching API Key ⇄ Claude
  // Code never bleeds one config's models into the other.
  const [methodDrafts, setMethodDrafts] = useState<Record<AuthMethodId, MethodDraft>>({
    api_key: { ...BLANK_DRAFT },
    claude_code: { ...BLANK_DRAFT },
  });

  // Set/clear a per-agent model override (empty value = use the default model).
  const setAgentModel = (stage: string, value: string) =>
    setAgentModels((prev) => {
      const next = { ...prev };
      if (value) next[stage] = value;
      else delete next[stage];
      return next;
    });

  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; status: ConnStatus; message: string } | null>(null);
  const [models, setModels] = useState<string[]>([]);

  const [saving, setSaving] = useState(false);
  const [busyAction, setBusyAction] = useState(false);

  const current = providers.find((p) => p.provider === selected);
  const meta = PROVIDER_META.find((p) => p.value === selected)!;
  const liveStatus: ConnStatus = testResult ? testResult.status : (current?.status ?? 'not_configured');
  const isAnthropic = selected === 'anthropic';
  const isClaudeCode = isAnthropic && authMethod === 'claude_code';
  const keyChanged = apiKey.trim().length > 0;
  const tokenChanged = oauthToken.trim().length > 0;
  // Enough to run a Test: a new credential entered, or one already saved.
  const canTest = isClaudeCode ? (tokenChanged || !!current?.configured) : (keyChanged || !!current?.configured);
  // Save is enabled whenever there's something savable — a credential entered
  // (new provider) or an already-configured provider being edited. A passing
  // Test Connection also enables it (it implies a credential is present) but is
  // NOT required, so any simple change keeps Save available in both auth methods.
  const canSave = canTest || !!testResult?.ok;

  /** Reset the editor fields for a provider (used on load + provider switch). */
  const resetEditor = useCallback((p?: LlmProviderConfig) => {
    const provider = (p?.provider ?? 'anthropic') as ProviderId;
    const method: AuthMethodId = provider === 'anthropic' && p?.authMethod === 'claude_code' ? 'claude_code' : 'api_key';
    const list = modelsFor(provider, p?.model);
    setApiKey('');
    setShowKey(false);
    setOauthToken('');
    setShowToken(false);
    setAuthMethod(method);
    setBaseUrl(p?.baseUrl || PROVIDER_META.find((m) => m.value === provider)?.endpoint || '');

    // Build a per-method draft so API Key and Claude Code keep independent model
    // settings. Prefer the server's settingsByMethod; fall back to the top-level
    // values for the active method (legacy configs) and blanks for the other.
    const draftFrom = (m: AuthMethodId): MethodDraft => {
      const s = p?.settingsByMethod?.[m];
      if (s) return {
        model: s.model || '',
        agentModels: s.agentModels && typeof s.agentModels === 'object' ? { ...s.agentModels } : {},
        effort: (s.effort as MethodDraft['effort']) || '',
        extendedThinking: !!s.extendedThinking,
      };
      if (m === method) return {
        model: p?.model || '',
        agentModels: p?.agentModels && typeof p.agentModels === 'object' ? { ...p.agentModels } : {},
        effort: (p?.effort as MethodDraft['effort']) || '',
        extendedThinking: !!p?.extendedThinking,
      };
      return { ...BLANK_DRAFT };
    };
    const drafts: Record<AuthMethodId, MethodDraft> = { api_key: draftFrom('api_key'), claude_code: draftFrom('claude_code') };
    setMethodDrafts(drafts);

    // Show the active method's draft (Default Model placeholder shows until chosen).
    const active = drafts[method];
    setModel(active.model);
    setAgentModels(active.agentModels);
    setEffort(active.effort);
    setExtendedThinking(active.extendedThinking);
    setModels(list);
    setTestResult(null);
  }, []);

  // Pull the provider's LIVE model list (auto-includes newly released models)
  // and merge it on top of the curated fallback. A ref guards against a stale
  // response overwriting a newer provider selection.
  const modelReqProvider = useRef<ProviderId>('anthropic');
  const refreshModels = useCallback(async (provider: ProviderId) => {
    modelReqProvider.current = provider;
    try {
      const { models: live } = await getLlmModels(provider);
      if (modelReqProvider.current !== provider) return; // superseded by a newer switch
      if (Array.isArray(live) && live.length) {
        setModels((prev) => [...new Set([...live, ...prev])]);
      }
    } catch { /* keep the curated fallback already in place */ }
  }, []);

  const load = useCallback(async (keepSelection?: ProviderId) => {
    setLoading(true);
    setLoadError('');
    try {
      const data = await getLlmConfig();
      setProviders(data.providers);
      const next: ProviderId =
        keepSelection ||
        (data.defaultProvider as ProviderId) ||
        (data.providers.find((p) => p.configured)?.provider as ProviderId) ||
        'anthropic';
      setSelected(next);
      const cur = data.providers.find((p) => p.provider === next);
      setMode(cur?.configured ? 'view' : 'edit');
      resetEditor(cur);
      void refreshModels(next);
    } catch (err: any) {
      setLoadError(err?.response?.data?.error || err.message || 'Failed to load LLM configuration.');
    } finally {
      setLoading(false);
    }
  }, [resetEditor, refreshModels]);

  useEffect(() => { void load(); }, [load]);

  const selectProvider = (p: ProviderId) => {
    setSelected(p);
    const cur = providers.find((x) => x.provider === p);
    setMode(cur?.configured ? 'view' : 'edit');
    resetEditor(cur);
    void refreshModels(p);
  };

  const enterEdit = () => {
    setMode('edit');
    resetEditor(current);
  };

  // Discard unsaved edits: configured providers return to the read-only view;
  // new (unconfigured) providers simply have their entered values cleared.
  const handleCancel = () => {
    if (current?.configured) setMode('view');
    resetEditor(current);
  };

  // Switch auth method while keeping each method's model settings independent:
  // stash the current method's edits, then load the target method's own draft.
  const switchAuthMethod = (next: AuthMethodId) => {
    if (next === authMethod) return;
    setMethodDrafts((prev) => ({ ...prev, [authMethod]: { model, agentModels, effort, extendedThinking } }));
    const draft = methodDrafts[next] || { ...BLANK_DRAFT };
    setModel(draft.model);
    setAgentModels(draft.agentModels);
    setEffort(draft.effort);
    setExtendedThinking(draft.extendedThinking);
    setAuthMethod(next);
    setTestResult(null);
  };

  const handleTest = async (testMode?: 'api' | 'cli') => {
    setTesting(true);
    setTestResult(null);
    try {
      const res = await testLlmConnection(selected, {
        apiKey: !isClaudeCode && keyChanged ? apiKey.trim() : undefined,
        oauthToken: isClaudeCode && tokenChanged ? oauthToken.trim() : undefined,
        authMethod: isAnthropic ? authMethod : undefined,
        mode: isClaudeCode ? (testMode || 'api') : undefined,
        baseUrl: baseUrl.trim() || meta.endpoint,
      });
      const label = isClaudeCode ? (testMode === 'cli' ? 'CLI: ' : 'API: ') : '';
      setTestResult({ ok: res.ok, status: (res.status as ConnStatus) || (res.ok ? 'connected' : 'connection_failed'), message: label + res.message });
      if (res.ok) {
        // Merge live models on top of the curated list (live first, deduped).
        // Do NOT auto-select — the Default Model stays on "Select Model" until the
        // admin explicitly chooses one (a saved model, if any, is preserved).
        const merged = [...new Set([...(res.models || []), ...modelsFor(selected, model)])];
        setModels(merged);
      }
    } catch (err: any) {
      const label = isClaudeCode ? (testMode === 'cli' ? 'CLI: ' : 'API: ') : '';
      setTestResult({ ok: false, status: 'connection_failed', message: label + (err?.response?.data?.message || err.message || 'Connection test failed.') });
    } finally {
      setTesting(false);
    }
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      await saveLlmConfig(selected, {
        apiKey: !isClaudeCode && keyChanged ? apiKey.trim() : undefined,
        oauthToken: isClaudeCode && tokenChanged ? oauthToken.trim() : undefined,
        authMethod: isAnthropic ? authMethod : undefined,
        effort: isAnthropic && effort ? effort : undefined,
        extendedThinking: isAnthropic ? extendedThinking : undefined,
        baseUrl: baseUrl.trim() || meta.endpoint,
        model: model || null,
        agentModels,
      });
      await load(selected);
      toast.success('Configuration saved', `${meta.label} settings have been updated.`);
    } catch (err: any) {
      toast.error('Save failed', err?.response?.data?.error || 'Failed to save configuration.');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!window.confirm(`Delete the ${meta.label} configuration? This removes the stored API key.`)) return;
    setBusyAction(true);
    try {
      await deleteLlmConfig(selected);
      await load(selected);
      toast.success('Configuration deleted', `${meta.label} configuration has been removed.`);
    } catch (err: any) {
      setLoadError(err?.response?.data?.error || 'Failed to delete configuration.');
    } finally {
      setBusyAction(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="w-7 h-7 text-[#7C3AED] animate-spin" />
        <span className="ml-3 text-sm text-[#6B7280]">Loading LLM configuration…</span>
      </div>
    );
  }

  return (
    <div className="max-w-3xl space-y-5">
      {/* ── Header ── */}
      <div className="flex items-start gap-3">
        <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-[#7C3AED] to-[#6366F1] flex items-center justify-center shadow-md shadow-purple-500/20">
          <BrainCircuit className="w-5 h-5 text-white" />
        </div>
        <div>
          <h2 className="text-lg font-semibold text-[#1E1B4B]">LLM Configuration</h2>
          <p className="text-sm text-[#6B7280] mt-0.5">
            Connect a Large Language Model provider. This configuration powers every AI capability —
            Planner, Test Generator, Healer, Test Data Generator, and more.
          </p>
        </div>
      </div>

      {loadError && (
        <div className="flex items-center gap-2 px-4 py-3 rounded-xl bg-red-50 border border-red-200 text-sm text-red-700">
          <AlertTriangle className="w-4 h-4 flex-shrink-0" /> {loadError}
        </div>
      )}

      {/* ── Provider + Status ── */}
      <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-5">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-5 items-end">
          <div>
            <label className={LABEL_CLASS}>LLM Provider</label>
            <select value={selected} onChange={(e) => selectProvider(e.target.value as ProviderId)} className={INPUT_CLASS}>
              {PROVIDER_META.map((p) => {
                const cfg = providers.find((x) => x.provider === p.value);
                return (
                  <option key={p.value} value={p.value}>
                    {p.label}{cfg?.isDefault ? '  ·  Default' : cfg?.configured ? '  ·  Configured' : ''}
                  </option>
                );
              })}
            </select>
          </div>
          <div>
            <label className={LABEL_CLASS}>Connection Status</label>
            <div className="flex items-center gap-3 h-[42px]">
              <StatusBadge status={liveStatus} />
              {current?.isDefault && (
                <span className="inline-flex items-center gap-1 text-xs font-medium text-[#7C3AED]">
                  <Star className="w-3.5 h-3.5 fill-[#7C3AED]" /> Default
                </span>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* ── Configuration Details ── */}
      <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-5">
        <h3 className="text-sm font-semibold text-[#1E1B4B] mb-4 flex items-center gap-2">
          <ShieldCheck className="w-4 h-4 text-[#7C3AED]" /> Configuration Details
        </h3>
        <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-4">
          <div>
            <dt className={LABEL_CLASS}>Last Updated</dt>
            <dd className="text-sm text-[#1E1B4B]" data-testid="llm-last-updated">{formatDate(current?.updatedAt ?? null)}</dd>
          </div>
          <div>
            <dt className={LABEL_CLASS}>Updated By</dt>
            <dd className="text-sm text-[#1E1B4B]" data-testid="llm-updated-by">{current?.updatedBy || '—'}</dd>
          </div>
        </dl>
      </div>

      {/* ── Configuration ── */}
      <div className="bg-white rounded-2xl border border-gray-100 shadow-sm overflow-hidden">
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-gray-100 bg-gray-50/50">
          <h3 className="text-sm font-semibold text-[#1E1B4B] flex items-center gap-2">
            <Cpu className="w-4 h-4 text-[#7C3AED]" /> Configuration
          </h3>
          {mode === 'view' && current?.configured && (
            <div className="flex items-center gap-2">
              <button onClick={enterEdit} className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-[#7C3AED] border border-[#DDD6FE] rounded-lg hover:bg-[#F5F3FF] transition-colors">
                <Pencil className="w-3.5 h-3.5" /> Edit
              </button>
              <button onClick={handleDelete} disabled={busyAction} className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-red-600 border border-red-200 rounded-lg hover:bg-red-50 transition-colors disabled:opacity-50">
                <Trash2 className="w-3.5 h-3.5" /> Delete
              </button>
            </div>
          )}
        </div>

        <div className="p-5 space-y-4">
          {mode === 'view' && current?.configured ? (
            /* ── Read-only summary ── */
            <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-4">
              {isAnthropic && (
                <div>
                  <dt className={LABEL_CLASS}>Auth Method</dt>
                  <dd className="text-sm font-medium text-[#1E1B4B]">
                    {current.authMethod === 'claude_code' ? 'Claude Code (subscription)' : 'API Key (credits)'}
                  </dd>
                </div>
              )}
              <div>
                <dt className={LABEL_CLASS}>{current.authMethod === 'claude_code' ? 'OAuth Token' : 'API Key'}</dt>
                <dd className="flex items-center gap-2 text-sm font-mono text-[#1E1B4B]">
                  <KeyRound className="w-4 h-4 text-[#A5B4FC]" />
                  {current.authMethod === 'claude_code'
                    ? (current.maskedToken || 'local Claude CLI')
                    : (current.maskedKey || '••••••')}
                </dd>
              </div>
              <div>
                <dt className={LABEL_CLASS}>Endpoint</dt>
                <dd className="flex items-center gap-2 text-sm text-[#1E1B4B] truncate">
                  <Link2 className="w-4 h-4 text-[#A5B4FC] flex-shrink-0" /> <span className="truncate">{current.baseUrl}</span>
                </dd>
              </div>
              <div>
                <dt className={LABEL_CLASS}>Default Model</dt>
                <dd className="text-sm font-medium text-[#1E1B4B]">{current.model ? formatModelLabel(current.model) : '—'}</dd>
              </div>
              {isAnthropic && (
                <div>
                  <dt className={LABEL_CLASS}>Effort / Thinking</dt>
                  <dd className="text-sm font-medium text-[#1E1B4B]">
                    {(current.effort || 'high')}{current.extendedThinking ? ' · ultra think on' : ''}
                  </dd>
                </div>
              )}
              <div className="sm:col-span-2">
                <dt className={LABEL_CLASS}>Per-Agent Models</dt>
                <dd className="text-sm text-[#1E1B4B]">
                  {AGENT_STAGES.some((s) => current.agentModels?.[s.key]) ? (
                    <ul className="space-y-1 mt-0.5">
                      {AGENT_STAGES.map((s) => (
                        <li key={s.key} className="flex items-center justify-between gap-3">
                          <span className="text-[#6B7280]">{s.label}</span>
                          <span className="font-medium">
                            {current.agentModels?.[s.key]
                              ? formatModelLabel(current.agentModels[s.key]!)
                              : `default (${current.model ? formatModelLabel(current.model) : '—'})`}
                          </span>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <span className="text-[#6B7280]">All agents use the default model</span>
                  )}
                </dd>
              </div>
            </dl>
          ) : (
            /* ── Editable form ── */
            <>
              {/* Authentication method — Anthropic supports a subscription path
                  (Claude Code) as a fallback for when API credits run out. */}
              {isAnthropic && (
                <div>
                  <label className={LABEL_CLASS}>Authentication Method</label>
                  <div className="grid grid-cols-2 gap-2">
                    {([
                      { v: 'api_key', label: 'API Key', hint: 'Uses API credits' },
                      { v: 'claude_code', label: 'Claude Code', hint: 'Uses your Claude subscription' },
                    ] as const).map((opt) => (
                      <button
                        key={opt.v}
                        type="button"
                        onClick={() => switchAuthMethod(opt.v)}
                        className={`flex flex-col items-start px-3 py-2.5 rounded-xl border text-left transition-all ${
                          authMethod === opt.v
                            ? 'border-[#7C3AED] bg-[#F5F3FF] ring-2 ring-[#7C3AED]/20'
                            : 'border-[#DDD6FE] bg-white hover:bg-[#F5F3FF]'
                        }`}
                      >
                        <span className="text-sm font-semibold text-[#1E1B4B]">{opt.label}</span>
                        <span className="text-[11px] text-[#6B7280]">{opt.hint}</span>
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {isClaudeCode ? (
                <div>
                  <label className={LABEL_CLASS}>Claude Code OAuth Token</label>
                  <div className="relative">
                    <input
                      type={showToken ? 'text' : 'password'}
                      value={oauthToken}
                      onChange={(e) => {
                        const v = e.target.value;
                        setTestResult(null);
                        // Pasted an API key here? Switch to API Key mode so it's sent correctly.
                        if (/^sk-ant-api/i.test(v.trim())) { switchAuthMethod('api_key'); setApiKey(v); setOauthToken(''); }
                        else setOauthToken(v);
                      }}
                      placeholder={current?.maskedToken ? `Saved — ${current.maskedToken} (leave blank to keep)` : 'sk-ant-oat…'}
                      autoComplete="off"
                      className={`${INPUT_CLASS} pr-10 font-mono`}
                    />
                    <button type="button" onClick={() => setShowToken((v) => !v)} className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-[#7C3AED] transition-colors">
                      {showToken ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                    </button>
                  </div>
                  <p className="text-[11px] text-[#6B7280] mt-1 flex items-center gap-1">
                    <ShieldCheck className="w-3 h-3" /> Run <code className="px-1 bg-[#F5F3FF] rounded">claude setup-token</code> in a terminal, then paste the token. Uses your Claude subscription, not API credits. Encrypted at rest.
                  </p>
                </div>
              ) : (
                <div>
                  <label className={LABEL_CLASS}>API Key</label>
                  <div className="relative">
                    <input
                      type={showKey ? 'text' : 'password'}
                      value={apiKey}
                      onChange={(e) => {
                        const v = e.target.value;
                        setTestResult(null);
                        // Pasted a Claude Code OAuth token here? Switch to Claude Code mode.
                        if (isAnthropic && /^sk-ant-oat/i.test(v.trim())) { switchAuthMethod('claude_code'); setOauthToken(v); setApiKey(''); }
                        else setApiKey(v);
                      }}
                      placeholder={current?.configured ? `Saved — ${current.maskedKey} (leave blank to keep)` : meta.keyHint}
                      autoComplete="off"
                      className={`${INPUT_CLASS} pr-10 font-mono`}
                    />
                    <button type="button" onClick={() => setShowKey((v) => !v)} className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-[#7C3AED] transition-colors">
                      {showKey ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                    </button>
                  </div>
                  <p className="text-[11px] text-[#6B7280] mt-1 flex items-center gap-1">
                    <ShieldCheck className="w-3 h-3" /> Encrypted at rest. The stored key is never shown in plain text.
                  </p>
                </div>
              )}

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <label className={LABEL_CLASS}>API Endpoint</label>
                  <input
                    type="text"
                    value={baseUrl}
                    onChange={(e) => { setBaseUrl(e.target.value); setTestResult(null); }}
                    placeholder={meta.endpoint}
                    className={INPUT_CLASS}
                  />
                </div>
                <div>
                  <label className={LABEL_CLASS}>Default Model</label>
                  <select
                    data-testid="llm-default-model"
                    value={model}
                    onChange={(e) => setModel(e.target.value)}
                    className={INPUT_CLASS}
                  >
                    <option value="">SELECT MODEL</option>
                    {models.map((m) => <option key={m} value={m}>{formatModelLabel(m)}</option>)}
                  </select>
                </div>
              </div>

              {/* Reasoning effort + extended ("ultra") thinking — Anthropic only */}
              {isAnthropic && (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4 pt-1">
                  <div>
                    <label className={LABEL_CLASS}>Reasoning Effort</label>
                    <select
                      value={effort}
                      onChange={(e) => setEffort(e.target.value as any)}
                      className={INPUT_CLASS}
                    >
                      <option value="">Provider default (high)</option>
                      <option value="low">Low — fastest, cheapest</option>
                      <option value="medium">Medium — balanced</option>
                      <option value="high">High — recommended</option>
                      <option value="xhigh">X-High — Opus 4.7/4.8 only</option>
                      <option value="max">Max — most thorough</option>
                    </select>
                    <p className="text-[11px] text-[#6B7280] mt-1">
                      Applied per model — automatically skipped for models that don't support it (e.g. Haiku 4.5).
                    </p>
                  </div>
                  <div>
                    <label className={LABEL_CLASS}>Extended Thinking</label>
                    <label className="flex items-center gap-2.5 mt-1.5 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={extendedThinking}
                        onChange={(e) => setExtendedThinking(e.target.checked)}
                        className="w-4 h-4 rounded border-[#DDD6FE] text-[#7C3AED] focus:ring-[#7C3AED]/20"
                      />
                      <span className="text-sm text-[#1E1B4B]">Enable “ultra think” (adaptive thinking)</span>
                    </label>
                    <p className="text-[11px] text-[#6B7280] mt-1">
                      Lets the model reason more deeply before answering. Used only on models that support adaptive thinking (Opus 4.6+, Sonnet 4.6, Fable 5).
                    </p>
                  </div>
                </div>
              )}

              {/* Per-agent model overrides */}
              <div className="pt-1">
                <label className={LABEL_CLASS}>Per-Agent Models</label>
                <p className="text-[11px] text-[#6B7280] -mt-1 mb-2.5">
                  Pick a model for each pipeline agent, or leave as <span className="font-medium">Use default</span> to use the Default Model above.
                  Lighter models (e.g. Haiku) make the early stages faster; stronger models improve generation quality.
                </p>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  {AGENT_STAGES.map((stage) => (
                    <div key={stage.key} className="flex flex-col">
                      <label className="text-xs font-semibold text-[#1E1B4B]">{stage.label}</label>
                      <span className="text-[10px] text-[#9CA3AF] mb-1">{stage.hint}</span>
                      <select
                        value={agentModels[stage.key] || ''}
                        onChange={(e) => setAgentModel(stage.key, e.target.value)}
                        className={INPUT_CLASS}
                      >
                        <option value="">SELECT MODEL</option>
                        {models.map((m) => <option key={m} value={m}>{formatModelLabel(m)}</option>)}
                      </select>
                    </div>
                  ))}
                </div>
              </div>

              {/* Actions */}
              <div className="flex flex-wrap items-center gap-3 pt-3 mt-1 border-t border-gray-100">
                {isClaudeCode ? (
                  <button
                    onClick={() => handleTest('cli')}
                    disabled={testing}
                    title="Run the local `claude` CLI (passes your token via CLAUDE_CODE_OAUTH_TOKEN)"
                    data-testid="llm-test-cli"
                    className="inline-flex items-center gap-2 px-4 py-2 border border-[#7C3AED] text-[#7C3AED] rounded-lg text-sm font-medium hover:bg-[#F5F3FF] transition-all disabled:opacity-50"
                  >
                    {testing ? <Loader2 className="w-4 h-4 animate-spin" /> : <Zap className="w-4 h-4" />}
                    {testing ? 'Testing…' : 'Test CLI Connection'}
                  </button>
                ) : (
                  <button
                    onClick={() => handleTest()}
                    disabled={testing || !canTest}
                    data-testid="llm-test-api"
                    className="inline-flex items-center gap-2 px-4 py-2 border border-[#7C3AED] text-[#7C3AED] rounded-lg text-sm font-medium hover:bg-[#F5F3FF] transition-all disabled:opacity-50"
                  >
                    {testing ? <Loader2 className="w-4 h-4 animate-spin" /> : <Zap className="w-4 h-4" />}
                    {testing ? 'Testing…' : 'Test API Connection'}
                  </button>
                )}
                <button
                  onClick={handleSave}
                  disabled={saving || !canSave}
                  title={!canSave ? 'Enter an API key or Claude Code token to enable Save' : undefined}
                  data-testid="llm-save-config"
                  className="inline-flex items-center gap-2 px-5 py-2 bg-gradient-to-r from-[#7C3AED] to-[#6366F1] text-white rounded-lg text-sm font-medium hover:from-[#6D28D9] hover:to-[#4F46E5] shadow-md shadow-purple-500/20 transition-all disabled:opacity-50"
                >
                  {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
                  {saving ? 'Saving…' : 'Save Configuration'}
                </button>
                <button
                  onClick={handleCancel}
                  disabled={saving}
                  data-testid="llm-cancel-config"
                  className="ml-auto inline-flex items-center gap-1.5 px-4 py-2 text-sm font-medium text-[#6B7280] border border-gray-200 rounded-lg hover:bg-gray-50 hover:text-[#1E1B4B] transition-colors disabled:opacity-50"
                >
                  <X className="w-4 h-4" /> Cancel
                </button>
              </div>

              {testResult && (
                <div className={`flex items-start gap-2 px-3 py-2.5 rounded-xl border text-sm ${testResult.ok ? 'bg-emerald-50 border-emerald-200 text-emerald-700' : 'bg-red-50 border-red-200 text-red-700'}`}>
                  {testResult.ok ? <CheckCircle2 className="w-4 h-4 flex-shrink-0 mt-0.5" /> : <AlertTriangle className="w-4 h-4 flex-shrink-0 mt-0.5" />}
                  <span className="whitespace-pre-wrap break-words font-mono text-[12px] leading-relaxed">{testResult.message}</span>
                </div>
              )}
            </>
          )}
        </div>
      </div>

    </div>
  );
}
