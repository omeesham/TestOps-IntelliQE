import { useState, useEffect, useCallback, type ReactNode } from 'react';
import {
  BrainCircuit, Loader2, Zap, Save, Pencil, RotateCcw, X,
  CheckCircle2, AlertTriangle, ShieldCheck, Star, KeyRound, Link2, Cpu, Vault,
} from 'lucide-react';
import {
  getLlmConfig, testLlmConnection, saveLlmConfig,
  setDefaultLlmProvider, deleteLlmConfig,
  type LlmProviderConfig, type LlmCredentialInfo,
} from '@/services/api';
import { useToast } from '@/components/feedback/ToastProvider';

type ProviderId = 'anthropic' | 'gemini' | 'openai';
type ConnStatus = LlmProviderConfig['status'];

const PROVIDER_META: { value: ProviderId; label: string; endpoint: string }[] = [
  { value: 'anthropic', label: 'Anthropic Claude', endpoint: 'https://api.anthropic.com' },
  { value: 'gemini',    label: 'Google Gemini',    endpoint: 'https://generativelanguage.googleapis.com' },
  { value: 'openai',    label: 'OpenAI ChatGPT',   endpoint: 'https://api.openai.com/v1' },
];

/** Live models (newest first), with the saved model pinned in if the provider no longer lists it. */
function modelsFor(live: string[] | undefined, savedModel?: string | null): string[] {
  const base = live || [];
  return savedModel && !base.includes(savedModel) ? [savedModel, ...base] : base;
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

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-baseline gap-3 text-sm">
      <span className="w-24 flex-shrink-0 text-xs font-semibold uppercase tracking-wide text-[#6B7280]">{label}</span>
      <span className="font-mono text-[#1E1B4B] break-all">{children}</span>
    </div>
  );
}

/** Read-only view of where the provider's key comes from. The key itself is never sent to the browser. */
function KeySource({ cred }: { cred?: LlmCredentialInfo }) {
  if (!cred) return null;
  return (
    <div className="rounded-xl border border-[#DDD6FE] bg-[#FAFAFF] p-4 space-y-2">
      <div className="flex items-center gap-2 text-sm font-semibold text-[#1E1B4B]">
        <Vault className="w-4 h-4 text-[#7C3AED]" /> API Key Source
      </div>
      {cred.source === 'env' ? (
        <Row label="Env var">{cred.reference}</Row>
      ) : (
        <>
          <Row label="Key Vault">{cred.vault || 'not configured (AZURE_KEY_VAULT_URL)'}</Row>
          <Row label="Secret">{cred.reference}</Row>
        </>
      )}
      <Row label="Key">
        {cred.found ? (
          <span className="inline-flex items-center gap-1.5 font-sans text-emerald-700">
            <KeyRound className="w-3.5 h-3.5" /> Found{cred.kind === 'oauth_token' ? ' (Claude Code OAuth token)' : ''}
          </span>
        ) : (
          <span className="font-sans text-red-600">Not found</span>
        )}
      </Row>
      {cred.source === 'env' && (
        <p className="text-[11px] text-amber-700 flex items-start gap-1.5 pt-1">
          <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0 mt-px" />
          Read from an environment variable (local development). In Azure, store the key in Key Vault instead.
        </p>
      )}
      {!cred.found && cred.error && (
        <p className="text-[11px] text-red-600 flex items-start gap-1.5 pt-1">
          <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0 mt-px" /> {cred.error}
        </p>
      )}
      <p className="text-[11px] text-[#6B7280] flex items-start gap-1.5 pt-1">
        <ShieldCheck className="w-3.5 h-3.5 flex-shrink-0 mt-px" />
        Keys are managed in your Azure Key Vault and read by the app&apos;s managed identity. They are never entered here or stored in the database.
      </p>
    </div>
  );
}

export default function LlmConfigurationSection() {
  const toast = useToast();
  const [providers, setProviders] = useState<LlmProviderConfig[]>([]);
  const [defaultProvider, setDefaultProvider] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');

  const [selected, setSelected] = useState<ProviderId>('anthropic');
  const [mode, setMode] = useState<'view' | 'edit'>('edit');

  const [baseUrl, setBaseUrl] = useState('');
  const [model, setModel] = useState('');
  const [agentModels, setAgentModels] = useState<Record<string, string>>({});

  // Reasoning effort + extended ("ultra") thinking (Anthropic). Empty effort = provider default.
  const [effort, setEffort] = useState<'' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'>('');
  const [extendedThinking, setExtendedThinking] = useState(false);

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
  const [testedCred, setTestedCred] = useState<LlmCredentialInfo | undefined>(undefined);
  const [models, setModels] = useState<string[]>([]);

  const [saving, setSaving] = useState(false);
  const [savedFlash, setSavedFlash] = useState(false);
  const [busyAction, setBusyAction] = useState(false);

  const current = providers.find((p) => p.provider === selected);
  const meta = PROVIDER_META.find((p) => p.value === selected)!;
  const liveStatus: ConnStatus = testResult ? testResult.status : (current?.status ?? 'not_configured');
  const credential = testedCred ?? current?.credential;
  const isAnthropic = selected === 'anthropic';
  const hasSettings = !!current?.model;
  const canSave = !!credential?.found && !!model;

  /** Reset the editor fields for a provider (used on load + provider switch). */
  const resetEditor = useCallback((p?: LlmProviderConfig) => {
    const provider = (p?.provider ?? 'anthropic') as ProviderId;
    const list = modelsFor(p?.models, p?.model);
    setEffort((p?.effort as any) || '');
    setExtendedThinking(!!p?.extendedThinking);
    setBaseUrl(p?.baseUrl || PROVIDER_META.find((m) => m.value === provider)?.endpoint || '');
    setModel(p?.model || list[0] || '');
    setAgentModels(p?.agentModels && typeof p.agentModels === 'object' ? { ...p.agentModels } : {});
    setModels(list);
    setTestResult(null);
    setTestedCred(undefined);
  }, []);

  const load = useCallback(async (keepSelection?: ProviderId) => {
    setLoading(true);
    setLoadError('');
    try {
      const data = await getLlmConfig();
      setProviders(data.providers);
      setDefaultProvider(data.defaultProvider);
      const next: ProviderId =
        keepSelection ||
        (data.defaultProvider as ProviderId) ||
        (data.providers.find((p) => p.configured)?.provider as ProviderId) ||
        'anthropic';
      setSelected(next);
      const cur = data.providers.find((p) => p.provider === next);
      setMode(cur?.model ? 'view' : 'edit');
      resetEditor(cur);
    } catch (err: any) {
      setLoadError(err?.response?.data?.error || err.message || 'Failed to load LLM configuration.');
    } finally {
      setLoading(false);
    }
  }, [resetEditor]);

  useEffect(() => { void load(); }, [load]);

  const selectProvider = (p: ProviderId) => {
    setSelected(p);
    const cur = providers.find((x) => x.provider === p);
    setMode(cur?.model ? 'view' : 'edit');
    resetEditor(cur);
  };

  const enterEdit = () => {
    setMode('edit');
    resetEditor(current);
  };

  const cancelEdit = () => {
    if (hasSettings) { setMode('view'); resetEditor(current); }
  };

  const handleTest = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const res = await testLlmConnection(selected, { baseUrl: baseUrl.trim() || meta.endpoint });
      setTestedCred(res.credential);
      setTestResult({ ok: res.ok, status: (res.status as ConnStatus) || (res.ok ? 'connected' : 'connection_failed'), message: res.message });
      if (res.ok) {
        const list = modelsFor(res.models, model);
        setModels(list);
        if (!model || !list.includes(model)) setModel(list[0] || '');
      }
    } catch (err: any) {
      const d = err?.response?.data;
      if (d?.credential) setTestedCred(d.credential);
      setTestResult({ ok: false, status: (d?.status as ConnStatus) || 'connection_failed', message: d?.message || err.message || 'Connection test failed.' });
    } finally {
      setTesting(false);
    }
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      await saveLlmConfig(selected, {
        effort: isAnthropic && effort ? effort : undefined,
        extendedThinking: isAnthropic ? extendedThinking : undefined,
        baseUrl: baseUrl.trim() || meta.endpoint,
        model: model || null,
        agentModels,
      });
      setSavedFlash(true);
      setTimeout(() => setSavedFlash(false), 3000);
      toast.success('Saved successfully');
      await load(selected);
    } catch (err: any) {
      setTestResult({ ok: false, status: 'connection_failed', message: err?.response?.data?.error || 'Failed to save configuration.' });
    } finally {
      setSaving(false);
    }
  };

  const handleSetDefault = async () => {
    setBusyAction(true);
    try {
      await setDefaultLlmProvider(selected);
      toast.success('Default updated');
      await load(selected);
    } catch (err: any) {
      setLoadError(err?.response?.data?.error || 'Failed to set default provider.');
    } finally {
      setBusyAction(false);
    }
  };

  const handleReset = async () => {
    if (!window.confirm(`Reset the ${meta.label} model settings? The API key in Key Vault is not affected.`)) return;
    setBusyAction(true);
    try {
      await deleteLlmConfig(selected);
      toast.success('Settings reset');
      await load(selected);
    } catch (err: any) {
      setLoadError(err?.response?.data?.error || 'Failed to reset configuration.');
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

  const activeProvider = providers.find((p) => p.provider === defaultProvider);

  const testButton = (
    <button
      onClick={handleTest}
      disabled={testing}
      title="Re-read the key from Key Vault and check it against the provider"
      className="inline-flex items-center gap-2 px-4 py-2 border border-[#7C3AED] text-[#7C3AED] rounded-lg text-sm font-medium hover:bg-[#F5F3FF] transition-all disabled:opacity-50"
    >
      {testing ? <Loader2 className="w-4 h-4 animate-spin" /> : <Zap className="w-4 h-4" />}
      {testing ? 'Testing…' : 'Test Connection'}
    </button>
  );

  const testBanner = testResult && (
    <div className={`flex items-start gap-2 px-3 py-2.5 rounded-xl border text-sm ${testResult.ok ? 'bg-emerald-50 border-emerald-200 text-emerald-700' : 'bg-red-50 border-red-200 text-red-700'}`}>
      {testResult.ok ? <CheckCircle2 className="w-4 h-4 flex-shrink-0 mt-0.5" /> : <AlertTriangle className="w-4 h-4 flex-shrink-0 mt-0.5" />}
      <span className="whitespace-pre-wrap break-words font-mono text-[12px] leading-relaxed">{testResult.message}</span>
    </div>
  );

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
            Choose the models that power every AI capability — Planner, Test Generator, Healer, Test Data Generator, and more.
            API keys are read from Azure Key Vault.
          </p>
        </div>
      </div>

      {loadError && (
        <div className="flex items-center gap-2 px-4 py-3 rounded-xl bg-red-50 border border-red-200 text-sm text-red-700">
          <AlertTriangle className="w-4 h-4 flex-shrink-0" /> {loadError}
        </div>
      )}

      {/* ── Provider + Status ── */}
      <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-5 space-y-4">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-5 items-end">
          <div>
            <label className={LABEL_CLASS}>LLM Provider</label>
            <select value={selected} onChange={(e) => selectProvider(e.target.value as ProviderId)} className={INPUT_CLASS}>
              {PROVIDER_META.map((p) => {
                const cfg = providers.find((x) => x.provider === p.value);
                return (
                  <option key={p.value} value={p.value}>
                    {p.label}{cfg?.isDefault ? '  ·  Default' : cfg?.configured ? '  ·  Key found' : ''}
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

        <KeySource cred={credential} />

        <div className="flex flex-wrap items-center gap-4">{testButton}</div>
        {testBanner}
      </div>

      {/* ── Model settings ── */}
      <div className="bg-white rounded-2xl border border-gray-100 shadow-sm overflow-hidden">
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-gray-100 bg-gray-50/50">
          <h3 className="text-sm font-semibold text-[#1E1B4B] flex items-center gap-2">
            <Cpu className="w-4 h-4 text-[#7C3AED]" /> Model Settings
          </h3>
          {mode === 'view' && hasSettings && (
            <div className="flex items-center gap-2">
              <button onClick={enterEdit} className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-[#7C3AED] border border-[#DDD6FE] rounded-lg hover:bg-[#F5F3FF] transition-colors">
                <Pencil className="w-3.5 h-3.5" /> Edit
              </button>
              <button onClick={handleReset} disabled={busyAction} className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-red-600 border border-red-200 rounded-lg hover:bg-red-50 transition-colors disabled:opacity-50">
                <RotateCcw className="w-3.5 h-3.5" /> Reset
              </button>
            </div>
          )}
        </div>

        <div className="p-5 space-y-4">
          {mode === 'view' && hasSettings && current ? (
            /* ── Read-only summary ── */
            <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-4">
              <div>
                <dt className={LABEL_CLASS}>Endpoint</dt>
                <dd className="flex items-center gap-2 text-sm text-[#1E1B4B] truncate">
                  <Link2 className="w-4 h-4 text-[#A5B4FC] flex-shrink-0" /> <span className="truncate">{current.baseUrl}</span>
                </dd>
              </div>
              <div>
                <dt className={LABEL_CLASS}>Default Model</dt>
                <dd className="text-sm font-medium text-[#1E1B4B]">{current.model || '—'}</dd>
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
                            {current.agentModels?.[s.key] || `default (${current.model || '—'})`}
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
              {models.length === 0 && (
                <div className="flex items-start gap-2 px-3 py-2.5 rounded-xl border border-amber-200 bg-amber-50 text-xs text-amber-800">
                  <AlertTriangle className="w-4 h-4 flex-shrink-0" />
                  Models are loaded live from the provider. Add the API key to Key Vault, then click Test Connection.
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
                    value={model}
                    onChange={(e) => setModel(e.target.value)}
                    disabled={models.length === 0}
                    className={`${INPUT_CLASS} disabled:opacity-60`}
                  >
                    {models.length === 0
                      ? <option value="">No models loaded</option>
                      : models.map((m) => <option key={m} value={m}>{m}</option>)}
                  </select>
                  <p className="text-[11px] text-[#6B7280] mt-1">Newest models are listed first.</p>
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
                      <option value="xhigh">X-High — most capable models only</option>
                      <option value="max">Max — most thorough</option>
                    </select>
                    <p className="text-[11px] text-[#6B7280] mt-1">
                      Applied per model — automatically skipped for models that don&apos;t support it.
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
                      Lets the model reason more deeply before answering. Used only on models that support adaptive thinking.
                    </p>
                  </div>
                </div>
              )}

              {/* Per-agent model overrides */}
              <div className="pt-1">
                <label className={LABEL_CLASS}>Per-Agent Models</label>
                <p className="text-[11px] text-[#6B7280] -mt-1 mb-2.5">
                  Pick a model for each pipeline agent, or leave as <span className="font-medium">Use default</span> to use the Default Model above.
                  Lighter models make the early stages faster; stronger models improve generation quality.
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
                        <option value="">Use default{model ? ` (${model})` : ''}</option>
                        {models.map((m) => <option key={m} value={m}>{m}</option>)}
                      </select>
                    </div>
                  ))}
                </div>
              </div>

              {/* Actions */}
              <div className="flex flex-wrap items-center gap-4 pt-3 mt-1 border-t border-gray-100">
                <button
                  onClick={handleSave}
                  disabled={saving || !canSave}
                  title={!canSave ? 'The API key must be available in Key Vault and a model chosen' : undefined}
                  className="inline-flex items-center gap-2 px-5 py-2 bg-gradient-to-r from-[#7C3AED] to-[#6366F1] text-white rounded-lg text-sm font-medium hover:from-[#6D28D9] hover:to-[#4F46E5] shadow-md shadow-purple-500/20 transition-all disabled:opacity-50"
                >
                  {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
                  {saving ? 'Saving…' : 'Save Settings'}
                </button>
                {hasSettings && (
                  <button onClick={cancelEdit} className="inline-flex items-center gap-1.5 px-3 py-2 text-sm font-medium text-[#6B7280] hover:text-[#1E1B4B] transition-colors">
                    <X className="w-4 h-4" /> Cancel
                  </button>
                )}
                {savedFlash && (
                  <span className="inline-flex items-center gap-1.5 text-xs text-emerald-600 font-medium">
                    <CheckCircle2 className="w-4 h-4" /> Saved
                  </span>
                )}
              </div>
            </>
          )}
        </div>
      </div>

      {/* ── Configuration Details ── */}
      <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-5">
        <h3 className="text-sm font-semibold text-[#1E1B4B] mb-4 flex items-center gap-2">
          <ShieldCheck className="w-4 h-4 text-[#7C3AED]" /> Configuration Details
        </h3>
        <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-4">
          <div className="flex items-center justify-between sm:block">
            <dt className={LABEL_CLASS}>Default Provider</dt>
            <dd className="text-sm">
              {current?.isDefault ? (
                <span className="inline-flex items-center gap-1.5 font-medium text-emerald-600">
                  <CheckCircle2 className="w-4 h-4" /> Yes
                </span>
              ) : current?.configured && hasSettings ? (
                <button onClick={handleSetDefault} disabled={busyAction} className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-[#7C3AED] border border-[#DDD6FE] rounded-lg hover:bg-[#F5F3FF] transition-colors disabled:opacity-50">
                  {busyAction ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Star className="w-3.5 h-3.5" />} Set as Default
                </button>
              ) : (
                <span className="text-sm text-[#6B7280]">—</span>
              )}
            </dd>
          </div>
          <div>
            <dt className={LABEL_CLASS}>Selected Model</dt>
            <dd className="text-sm font-medium text-[#1E1B4B]">{current?.model || '—'}</dd>
          </div>
          <div>
            <dt className={LABEL_CLASS}>Last Updated</dt>
            <dd className="text-sm text-[#1E1B4B]">{formatDate(current?.updatedAt ?? null)}</dd>
          </div>
          <div>
            <dt className={LABEL_CLASS}>Updated By</dt>
            <dd className="text-sm text-[#1E1B4B]">{current?.updatedBy || '—'}</dd>
          </div>
        </dl>

        <div className="mt-4 pt-4 border-t border-gray-100 text-xs text-[#6B7280] flex items-center gap-1.5">
          <Star className="w-3.5 h-3.5 text-[#A5B4FC]" />
          Active platform provider:&nbsp;
          <span className="font-medium text-[#1E1B4B]">
            {activeProvider ? `${activeProvider.label} (${activeProvider.model || 'no model'})` : 'None selected'}
          </span>
        </div>
      </div>
    </div>
  );
}
