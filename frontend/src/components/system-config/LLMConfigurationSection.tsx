import { useEffect, useMemo, useState } from 'react';
import {
  Sparkles, ShieldCheck, ShieldAlert, CheckCircle2, XCircle, AlertTriangle, Clock,
  Circle, Eye, EyeOff, Zap, Save, Trash2, Star, RefreshCw, Lock, History as HistoryIcon,
  Loader2, ChevronRight, Server,
} from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import {
  connectIntegration, disconnectIntegration, testLLMConnection, listLLMModels,
} from '@/services/api';
import {
  LLM_PROVIDERS, getProvider, providerRowId, LLM_SETTINGS_ID,
  type LLMEnvironment, type LLMProviderDef,
} from './llmProviders';

interface DbConfig {
  integrationId: string;
  status: string;
  configData: Record<string, any>;
  connectedBy: string | null;
  connectedAt: string | null;
  lastSyncAt: string | null;
}

interface Props {
  configs: DbConfig[];
  onRefresh: () => void;
}

type ConnStatus =
  | 'connected' | 'configured' | 'disabled' | 'not-configured'
  | 'invalid-key' | 'failed' | 'timeout';

interface HistoryEntry {
  at: string;
  by: string;
  action: string;
  provider: string;
  env: string;
}

interface ProviderForm {
  apiKey: string;
  endpoint: string;
  model: string;
  orgId: string;
  projectId: string;
  enabled: boolean;
}

const KEEP_SECRET = '__KEEP_EXISTING__';

const STATUS_META: Record<ConnStatus, { label: string; cls: string; dot: string; Icon: React.ElementType }> = {
  connected:        { label: 'Connected',         cls: 'bg-emerald-50 text-emerald-700 border-emerald-200', dot: 'bg-emerald-500', Icon: CheckCircle2 },
  configured:       { label: 'Configured',        cls: 'bg-indigo-50 text-indigo-700 border-indigo-200',    dot: 'bg-indigo-500',  Icon: ShieldCheck },
  disabled:         { label: 'Disabled',          cls: 'bg-gray-100 text-gray-500 border-gray-200',         dot: 'bg-gray-400',    Icon: Circle },
  'not-configured': { label: 'Not Configured',    cls: 'bg-gray-50 text-gray-500 border-gray-200',          dot: 'bg-gray-300',    Icon: Circle },
  'invalid-key':    { label: 'Invalid API Key',   cls: 'bg-red-50 text-red-700 border-red-200',             dot: 'bg-red-500',     Icon: XCircle },
  failed:           { label: 'Connection Failed', cls: 'bg-red-50 text-red-700 border-red-200',             dot: 'bg-red-500',     Icon: AlertTriangle },
  timeout:          { label: 'Timeout',           cls: 'bg-amber-50 text-amber-700 border-amber-200',       dot: 'bg-amber-500',   Icon: Clock },
};

const INPUT_CLASS =
  'w-full px-3 py-2.5 rounded-xl border border-[#E5E7EB] bg-white text-sm text-[#1E1B4B] outline-none focus:ring-2 focus:ring-[#7C3AED]/20 focus:border-[#7C3AED] placeholder:text-gray-400 transition-all disabled:bg-gray-50 disabled:text-gray-400';

/* ── Module-level presentational helpers (stable identity → no focus loss) ── */

function ProviderAvatar({ provider, size = 40 }: { provider: LLMProviderDef; size?: number }) {
  return (
    <div
      className="rounded-xl flex items-center justify-center font-semibold text-white flex-shrink-0"
      style={{ width: size, height: size, backgroundColor: provider.accent, fontSize: size * 0.36 }}
    >
      {provider.initials}
    </div>
  );
}

function StatusBadge({ status }: { status: ConnStatus }) {
  const m = STATUS_META[status];
  const { Icon } = m;
  return (
    <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full border text-xs font-medium ${m.cls}`}>
      <Icon className="w-3.5 h-3.5" />
      {m.label}
    </span>
  );
}

function StatusDot({ status }: { status: ConnStatus }) {
  return <span className={`w-2 h-2 rounded-full ${STATUS_META[status].dot}`} />;
}

function Toggle({ checked, onChange, disabled }: { checked: boolean; onChange: () => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={onChange}
      className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors disabled:opacity-40 ${checked ? 'bg-[#7C3AED]' : 'bg-gray-300'}`}
    >
      <span className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ${checked ? 'translate-x-4' : 'translate-x-0.5'}`} />
    </button>
  );
}

function Field({ label, required, help, children }: { label: string; required?: boolean; help?: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-sm font-medium text-[#1E1B4B] mb-1">
        {label}{required && <span className="text-red-500 ml-0.5">*</span>}
      </label>
      {children}
      {help && <p className="text-[11px] text-[#6B7280] mt-1">{help}</p>}
    </div>
  );
}

/* ── Date helpers ── */
function formatDateTime(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '—';
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  let h = d.getHours();
  const ampm = h >= 12 ? 'PM' : 'AM';
  h = h % 12 || 12;
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${String(d.getDate()).padStart(2, '0')}-${months[d.getMonth()]}-${d.getFullYear()} ${String(h).padStart(2, '0')}:${mm} ${ampm}`;
}

function timeAgo(iso: string): string {
  const d = new Date(iso).getTime();
  if (isNaN(d)) return '';
  const s = Math.floor((Date.now() - d) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

/* ───────────────────────────────────────────────────────────── */

export default function LLMConfigurationSection({ configs, onRefresh }: Props) {
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin';
  const actor = user?.displayName || user?.username || 'admin';

  const settingsRow = configs.find((c) => c.integrationId === LLM_SETTINGS_ID);
  const settings = settingsRow?.configData || {};
  const defaults: Record<string, string> = settings.defaults || {};
  const history: HistoryEntry[] = Array.isArray(settings.history) ? settings.history : [];

  // Environment is fixed (the picker was removed); kept as a stable storage key.
  const env: LLMEnvironment = settings.activeEnvironment || 'production';
  const defaultProviderId = defaults[env] || '';

  const [selectedId, setSelectedId] = useState<string>(defaultProviderId || 'anthropic');
  const selectedProvider = getProvider(selectedId)!;

  const rowFor = (pid: string) => configs.find((c) => c.integrationId === providerRowId(pid, env));
  const selectedRow = rowFor(selectedId);
  const hasKey = !!selectedRow?.configData?.apiKey;

  const [liveStatus, setLiveStatus] = useState<Record<string, { status: ConnStatus; message?: string }>>({});
  const [form, setForm] = useState<ProviderForm>(() => initForm(selectedProvider, selectedRow));
  const [keyDirty, setKeyDirty] = useState(false);
  const [showKey, setShowKey] = useState(false);
  const [models, setModels] = useState<string[]>(selectedProvider.fallbackModels);
  const [modelSource, setModelSource] = useState<'live' | 'fallback'>('fallback');
  const [loadingModels, setLoadingModels] = useState(false);
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [savedFlash, setSavedFlash] = useState(false);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [busyProvider, setBusyProvider] = useState<string | null>(null);

  // Re-seed the form whenever the selected provider, environment, or the saved
  // row's last write changes. Keyed on lastSyncAt so a post-save refresh syncs
  // the "saved" state without clobbering an in-progress edit on other rows.
  useEffect(() => {
    setForm(initForm(selectedProvider, selectedRow));
    setKeyDirty(false);
    setShowKey(false);
    setValidationError(null);
    setModels(selectedProvider.fallbackModels);
    setModelSource('fallback');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId, env, selectedRow?.lastSyncAt]);

  function baseStatus(pid: string): ConnStatus {
    const p = getProvider(pid)!;
    const row = rowFor(pid);
    const cfg = row?.configData || {};
    const configured = p.keyless ? !!row : !!cfg.apiKey;
    if (!row || !configured) return 'not-configured';
    if (cfg.enabled === false) return 'disabled';
    return 'configured';
  }
  const statusOf = (pid: string): ConnStatus => liveStatus[pid]?.status ?? baseStatus(pid);

  const configuredProviders = useMemo(
    () => LLM_PROVIDERS.filter((p) => ['configured', 'disabled'].includes(baseStatus(p.id))),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [configs, env],
  );

  /* ── Persistence helpers ── */

  async function saveSettings(patch: Record<string, any>, action?: string, provider?: string) {
    const nextHistory = action
      ? [{ at: new Date().toISOString(), by: actor, action, provider: provider || '', env }, ...history].slice(0, 25)
      : history;
    await connectIntegration(LLM_SETTINGS_ID, {
      ...settings,
      activeEnvironment: env,
      defaults,
      ...patch,
      history: nextHistory,
    });
  }

  function buildKeyField(): string {
    if (selectedProvider.keyless) return '';
    if (keyDirty && form.apiKey) return form.apiKey;
    return hasKey ? KEEP_SECRET : '';
  }

  async function handleSave() {
    setValidationError(null);
    if (!selectedProvider.keyless && !form.apiKey && !hasKey) {
      setValidationError(`${selectedProvider.apiKeyLabel} is required to save this provider.`);
      return;
    }
    for (const f of selectedProvider.fields) {
      if (f.required && !(form as any)[f.key]) {
        setValidationError(`${f.label} is required.`);
        return;
      }
    }
    setSaving(true);
    try {
      await connectIntegration(providerRowId(selectedId, env), {
        provider: selectedId,
        environment: env,
        apiKey: buildKeyField(),
        endpoint: form.endpoint,
        model: form.model,
        orgId: form.orgId,
        projectId: form.projectId,
        enabled: form.enabled,
      });
      // First configured provider for this environment becomes the default.
      const patch = !defaults[env] ? { defaults: { ...defaults, [env]: selectedId } } : {};
      await saveSettings(patch, 'Saved configuration', selectedId);
      setSavedFlash(true);
      setTimeout(() => setSavedFlash(false), 2500);
      onRefresh();
    } catch {
      setValidationError('Failed to save configuration. Please try again.');
    } finally {
      setSaving(false);
    }
  }

  async function handleRemove() {
    if (!selectedRow) return;
    setRemoving(true);
    try {
      await disconnectIntegration(providerRowId(selectedId, env));
      const nextDefaults = { ...defaults };
      if (nextDefaults[env] === selectedId) nextDefaults[env] = '';
      await saveSettings({ defaults: nextDefaults }, 'Removed configuration', selectedId);
      setLiveStatus((s) => { const n = { ...s }; delete n[selectedId]; return n; });
      onRefresh();
    } finally {
      setRemoving(false);
    }
  }

  async function handleSetDefault(pid: string) {
    if (!isAdmin) return;
    setBusyProvider(pid);
    try {
      await saveSettings({ defaults: { ...defaults, [env]: pid } }, 'Set as default', pid);
      onRefresh();
    } finally {
      setBusyProvider(null);
    }
  }

  async function handleToggleEnabled(pid: string) {
    const row = rowFor(pid);
    if (!row) return; // can't enable an unconfigured provider
    setBusyProvider(pid);
    try {
      await connectIntegration(providerRowId(pid, env), {
        ...row.configData,
        apiKey: KEEP_SECRET, // preserve stored key
        enabled: !(row.configData.enabled !== false),
      });
      await saveSettings({}, (row.configData.enabled !== false) ? 'Disabled provider' : 'Enabled provider', pid);
      onRefresh();
    } finally {
      setBusyProvider(null);
    }
  }

  async function handleTest() {
    setTesting(true);
    setValidationError(null);
    const payload: Parameters<typeof testLLMConnection>[0] = {
      provider: selectedId,
      model: form.model,
      baseUrl: form.endpoint,
      orgId: form.orgId,
      projectId: form.projectId,
    };
    if (keyDirty && form.apiKey) payload.apiKey = form.apiKey;
    else (payload as any).integrationId = providerRowId(selectedId, env);
    const res = await testLLMConnection(payload);
    setLiveStatus((s) => ({ ...s, [selectedId]: { status: res.status, message: res.message || res.error } }));
    setTesting(false);
    if (res.ok) handleFetchModels();
  }

  async function handleFetchModels() {
    setLoadingModels(true);
    const payload: Parameters<typeof listLLMModels>[0] = { provider: selectedId, baseUrl: form.endpoint };
    if (keyDirty && form.apiKey) payload.apiKey = form.apiKey;
    else payload.integrationId = providerRowId(selectedId, env);
    const { models: list, source } = await listLLMModels(payload);
    if (list.length) {
      setModels(list);
      setModelSource(source);
      setForm((f) => ({ ...f, model: list.includes(f.model) ? f.model : list[0] }));
    }
    setLoadingModels(false);
  }

  /* ── Non-admin gate ── */
  if (!isAdmin) {
    return (
      <div className="max-w-lg mx-auto py-16 text-center">
        <div className="w-14 h-14 rounded-2xl bg-[#F5F3FF] flex items-center justify-center mx-auto mb-4">
          <Lock className="w-7 h-7 text-[#7C3AED]" />
        </div>
        <h3 className="text-lg font-semibold text-[#1E1B4B]">Administrator access required</h3>
        <p className="text-sm text-[#6B7280] mt-2">
          LLM provider credentials and defaults can only be viewed and managed by platform administrators.
          Contact your administrator to make changes.
        </p>
      </div>
    );
  }

  const selectedStatus = statusOf(selectedId);
  const liveMsg = liveStatus[selectedId]?.message;
  const defaultProvider = defaultProviderId ? getProvider(defaultProviderId) : undefined;
  const defaultStatus = defaultProviderId ? statusOf(defaultProviderId) : 'not-configured';

  return (
    <div className="space-y-5">
      {/* ── Header ── */}
      <div className="flex items-center gap-3">
        <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-[#7C3AED] to-[#6366F1] flex items-center justify-center shadow-sm">
          <Sparkles className="w-5 h-5 text-white" />
        </div>
        <h2 className="text-lg font-semibold text-[#1E1B4B] leading-tight">LLM Configuration</h2>
      </div>

      {/* ── Default Provider + Status summary ── */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div className="rounded-2xl border border-[#EDE9FE] bg-gradient-to-br from-[#FAFAFE] to-white p-5">
          <div className="flex items-center gap-2 mb-3">
            <Star className="w-4 h-4 text-[#7C3AED]" />
            <h3 className="text-sm font-semibold text-[#1E1B4B]">Default Provider</h3>
          </div>
          <select
            value={defaultProviderId}
            onChange={(e) => handleSetDefault(e.target.value)}
            className={INPUT_CLASS}
          >
            <option value="">— Select default LLM —</option>
            {configuredProviders.map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
          <p className="text-[11px] text-[#6B7280] mt-2">
            The platform-wide engine all AI agents use by default.
          </p>
        </div>

        <div className="rounded-2xl border border-[#EDE9FE] bg-white p-5">
          <div className="flex items-center gap-2 mb-3">
            <Server className="w-4 h-4 text-[#7C3AED]" />
            <h3 className="text-sm font-semibold text-[#1E1B4B]">Provider Status</h3>
          </div>
          {defaultProvider ? (
            <div className="flex items-center gap-3">
              <ProviderAvatar provider={defaultProvider} />
              <div className="min-w-0">
                <p className="text-sm font-semibold text-[#1E1B4B] truncate">{defaultProvider.name}</p>
                <p className="text-xs text-[#6B7280] truncate">{defaultProvider.tagline}</p>
              </div>
              <div className="ml-auto"><StatusBadge status={defaultStatus} /></div>
            </div>
          ) : (
            <div className="flex items-center gap-2 text-sm text-[#6B7280]">
              <AlertTriangle className="w-4 h-4 text-amber-500" />
              No default provider selected. Configure one below.
            </div>
          )}
        </div>
      </div>

      {/* ── Available Providers ── */}
      <div className="rounded-2xl border border-[#EDE9FE] bg-white p-5">
        <div className="flex items-center gap-2 mb-4">
          <h3 className="text-sm font-semibold text-[#1E1B4B]">Available Providers</h3>
          <span className="text-xs text-[#6B7280]">· {configuredProviders.length} configured</span>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-3">
          {LLM_PROVIDERS.map((p) => {
            const status = statusOf(p.id);
            const isSelected = p.id === selectedId;
            const isDefault = defaults[env] === p.id;
            const configured = ['configured', 'disabled', 'connected'].includes(baseStatus(p.id)) || baseStatus(p.id) === 'connected';
            const row = rowFor(p.id);
            return (
              <button
                key={p.id}
                onClick={() => setSelectedId(p.id)}
                className={`text-left rounded-xl border p-3 transition-all ${
                  isSelected
                    ? 'border-[#7C3AED] ring-1 ring-[#7C3AED]/30 bg-[#FAFAFE]'
                    : 'border-[#E5E7EB] hover:border-[#DDD6FE] hover:bg-[#FAFAFE]'
                }`}
              >
                <div className="flex items-start gap-3">
                  <ProviderAvatar provider={p} size={36} />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <span className="text-sm font-semibold text-[#1E1B4B] truncate">{p.name}</span>
                      {isDefault && <Star className="w-3.5 h-3.5 text-[#7C3AED] fill-[#7C3AED] flex-shrink-0" />}
                    </div>
                    <p className="text-[11px] text-[#6B7280] line-clamp-2 leading-snug mt-0.5">{p.tagline}</p>
                  </div>
                  {p.status === 'coming-soon' && (
                    <span className="text-[9px] font-semibold uppercase tracking-wide text-[#6B7280] bg-gray-100 px-1.5 py-0.5 rounded flex-shrink-0">
                      Soon
                    </span>
                  )}
                </div>
                <div className="flex items-center justify-between mt-3 pt-2 border-t border-[#F1F0FB]">
                  <span className="inline-flex items-center gap-1.5 text-xs">
                    <StatusDot status={status} />
                    <span className="text-[#6B7280]">{STATUS_META[status].label}</span>
                  </span>
                  <span
                    role="button"
                    tabIndex={0}
                    onClick={(e) => { e.stopPropagation(); if (row) handleToggleEnabled(p.id); }}
                    onKeyDown={(e) => { if (e.key === 'Enter') { e.stopPropagation(); if (row) handleToggleEnabled(p.id); } }}
                    className="flex items-center gap-1.5"
                    title={row ? 'Enable / disable provider' : 'Configure the provider to enable it'}
                  >
                    {busyProvider === p.id
                      ? <Loader2 className="w-4 h-4 animate-spin text-[#7C3AED]" />
                      : <Toggle checked={!!row && row.configData.enabled !== false} onChange={() => {}} disabled={!row} />}
                  </span>
                </div>
              </button>
            );
          })}
        </div>
      </div>

      {/* ── Configuration card (selected provider) ── */}
      <div className="rounded-2xl border border-[#EDE9FE] bg-white overflow-hidden">
        <div className="flex flex-wrap items-center gap-3 px-5 py-4 border-b border-[#F1F0FB] bg-[#FAFAFE]">
          <ProviderAvatar provider={selectedProvider} />
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h3 className="text-sm font-semibold text-[#1E1B4B]">{selectedProvider.name}</h3>
              {selectedProvider.docsUrl && (
                <a href={selectedProvider.docsUrl} target="_blank" rel="noreferrer"
                   className="text-[11px] text-[#7C3AED] hover:underline inline-flex items-center">
                  Docs <ChevronRight className="w-3 h-3" />
                </a>
              )}
            </div>
            <p className="text-[11px] text-[#6B7280]">Provider configuration</p>
          </div>
          <div className="ml-auto flex items-center gap-2">
            <StatusBadge status={selectedStatus} />
            {defaults[env] !== selectedId && (
              <button
                onClick={() => handleSetDefault(selectedId)}
                disabled={baseStatus(selectedId) === 'not-configured'}
                className="px-2.5 py-1.5 rounded-lg text-xs font-medium text-[#7C3AED] border border-[#DDD6FE] hover:bg-[#F5F3FF] transition-all disabled:opacity-40 inline-flex items-center gap-1"
              >
                <Star className="w-3.5 h-3.5" /> Set default
              </button>
            )}
          </div>
        </div>

        <div className="p-5 space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {/* API Key */}
            <Field label={selectedProvider.apiKeyLabel} required={!selectedProvider.keyless} help={selectedProvider.apiKeyHelp}>
              <div className="relative">
                <input
                  type={showKey ? 'text' : 'password'}
                  value={form.apiKey}
                  disabled={selectedProvider.keyless}
                  onChange={(e) => { setForm((f) => ({ ...f, apiKey: e.target.value })); setKeyDirty(true); }}
                  placeholder={selectedProvider.keyless
                    ? 'Not required for self-hosted'
                    : (hasKey ? '•••••••••••••• — saved (leave blank to keep)' : selectedProvider.apiKeyPlaceholder)}
                  autoComplete="off"
                  className={`${INPUT_CLASS} pr-10`}
                />
                {!selectedProvider.keyless && (
                  <button type="button" onClick={() => setShowKey((v) => !v)}
                          className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-[#7C3AED]">
                    {showKey ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                )}
              </div>
              {hasKey && !keyDirty && !selectedProvider.keyless && (
                <p className="text-[11px] text-emerald-600 mt-1 inline-flex items-center gap-1">
                  <ShieldCheck className="w-3.5 h-3.5" /> Stored &amp; encrypted at rest (AES-256)
                </p>
              )}
            </Field>

            {/* Endpoint */}
            <Field label="API Endpoint" help="Override only for gateways or private deployments.">
              <input
                type="text"
                value={form.endpoint}
                onChange={(e) => setForm((f) => ({ ...f, endpoint: e.target.value }))}
                placeholder={selectedProvider.defaultEndpoint}
                className={INPUT_CLASS}
              />
            </Field>

            {/* Provider-specific extra fields */}
            {selectedProvider.fields.map((f) => (
              <Field key={f.key} label={f.label} required={f.required} help={f.help}>
                <input
                  type="text"
                  value={(form as any)[f.key]}
                  onChange={(e) => setForm((prev) => ({ ...prev, [f.key]: e.target.value }))}
                  placeholder={f.placeholder}
                  className={INPUT_CLASS}
                />
              </Field>
            ))}

            {/* Model */}
            <Field label="Model" help={modelSource === 'live' ? 'Retrieved live from the provider.' : 'Default list — test the connection to load live models.'}>
              <div className="flex gap-2">
                <select
                  value={form.model}
                  onChange={(e) => setForm((f) => ({ ...f, model: e.target.value }))}
                  className={INPUT_CLASS}
                >
                  {models.map((m) => <option key={m} value={m}>{m}</option>)}
                  {form.model && !models.includes(form.model) && <option value={form.model}>{form.model}</option>}
                </select>
                <button
                  type="button"
                  onClick={handleFetchModels}
                  disabled={loadingModels}
                  title="Fetch available models"
                  className="px-3 rounded-xl border border-[#DDD6FE] text-[#7C3AED] hover:bg-[#F5F3FF] transition-all disabled:opacity-50 flex-shrink-0"
                >
                  {loadingModels ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
                </button>
              </div>
            </Field>
          </div>

          {/* Enabled toggle */}
          <div className="flex items-center justify-between rounded-xl border border-[#F1F0FB] bg-[#FAFAFE] px-4 py-3">
            <div>
              <span className="text-sm font-medium text-[#1E1B4B]">Enable provider</span>
              <p className="text-[11px] text-[#6B7280]">Disabled providers stay configured but are not used by agents.</p>
            </div>
            <Toggle checked={form.enabled} onChange={() => setForm((f) => ({ ...f, enabled: !f.enabled }))} />
          </div>

          {/* Validation / connection status */}
          {validationError && (
            <div className="flex items-center gap-2 text-xs text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
              <AlertTriangle className="w-4 h-4 flex-shrink-0" /> {validationError}
            </div>
          )}
          {liveStatus[selectedId] && (
            <div className={`flex items-center gap-2 text-xs rounded-lg px-3 py-2 border ${STATUS_META[selectedStatus].cls}`}>
              {(() => { const I = STATUS_META[selectedStatus].Icon; return <I className="w-4 h-4 flex-shrink-0" />; })()}
              <span className="font-medium">{STATUS_META[selectedStatus].label}</span>
              {liveMsg && <span className="opacity-80">— {liveMsg}</span>}
            </div>
          )}

          {/* Actions */}
          <div className="flex flex-wrap items-center gap-2 pt-1">
            <button
              onClick={handleTest}
              disabled={testing || selectedProvider.status !== 'available'}
              title={selectedProvider.status !== 'available' ? 'Live validation available once this provider is enabled on your plan' : undefined}
              className="px-4 py-2 rounded-lg text-sm font-medium border border-[#7C3AED] text-[#7C3AED] hover:bg-[#F5F3FF] transition-all disabled:opacity-50 inline-flex items-center gap-2"
            >
              {testing ? <Loader2 className="w-4 h-4 animate-spin" /> : <Zap className="w-4 h-4" />}
              {testing ? 'Testing…' : 'Test Connection'}
            </button>
            <button
              onClick={handleSave}
              disabled={saving}
              className="px-5 py-2 rounded-lg text-sm font-medium text-white bg-gradient-to-r from-[#7C3AED] to-[#6366F1] hover:from-[#6D28D9] hover:to-[#4F46E5] shadow-sm transition-all disabled:opacity-50 inline-flex items-center gap-2"
            >
              {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
              {saving ? 'Saving…' : 'Save Configuration'}
            </button>
            {selectedRow && (
              <button
                onClick={handleRemove}
                disabled={removing}
                className="px-3 py-2 rounded-lg text-sm font-medium text-red-600 border border-red-200 hover:bg-red-50 transition-all disabled:opacity-50 inline-flex items-center gap-2"
              >
                {removing ? <Loader2 className="w-4 h-4 animate-spin" /> : <Trash2 className="w-4 h-4" />}
                Remove
              </button>
            )}
            {savedFlash && (
              <span className="text-xs text-emerald-600 font-medium inline-flex items-center gap-1">
                <CheckCircle2 className="w-4 h-4" /> Configuration saved
              </span>
            )}
            <span className="ml-auto text-[11px] text-[#9CA3AF] inline-flex items-center gap-1">
              <Lock className="w-3 h-3" /> Credentials encrypted at rest
            </span>
          </div>
        </div>
      </div>

      {/* ── Audit Information ── */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div className="rounded-2xl border border-[#EDE9FE] bg-white p-5">
          <div className="flex items-center gap-2 mb-4">
            <ShieldAlert className="w-4 h-4 text-[#7C3AED]" />
            <h3 className="text-sm font-semibold text-[#1E1B4B]">Audit Information</h3>
          </div>
          <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-3 text-sm">
            <div>
              <dt className="text-[11px] uppercase tracking-wide text-[#9CA3AF]">Last Updated</dt>
              <dd className="text-[#1E1B4B] font-medium">{formatDateTime(selectedRow?.lastSyncAt || selectedRow?.connectedAt || null)}</dd>
            </div>
            <div>
              <dt className="text-[11px] uppercase tracking-wide text-[#9CA3AF]">Updated By</dt>
              <dd className="text-[#1E1B4B] font-medium">{selectedRow?.connectedBy || '—'}</dd>
            </div>
            <div>
              <dt className="text-[11px] uppercase tracking-wide text-[#9CA3AF]">Status</dt>
              <dd className="mt-0.5"><StatusBadge status={selectedStatus} /></dd>
            </div>
          </dl>
        </div>

        {/* ── Configuration History ── */}
        <div className="rounded-2xl border border-[#EDE9FE] bg-white p-5">
          <div className="flex items-center gap-2 mb-4">
            <HistoryIcon className="w-4 h-4 text-[#7C3AED]" />
            <h3 className="text-sm font-semibold text-[#1E1B4B]">Configuration History</h3>
          </div>
          {history.length === 0 ? (
            <p className="text-sm text-[#9CA3AF]">No configuration changes recorded yet.</p>
          ) : (
            <ul className="space-y-2.5 max-h-56 overflow-y-auto pr-1">
              {history.slice(0, 12).map((h, i) => {
                const p = getProvider(h.provider);
                return (
                  <li key={i} className="flex items-start gap-2.5 text-sm">
                    <span className="mt-1.5 w-1.5 h-1.5 rounded-full bg-[#7C3AED] flex-shrink-0" />
                    <div className="min-w-0 flex-1">
                      <p className="text-[#1E1B4B]">
                        <span className="font-medium">{h.action}</span>
                        {p && <span className="text-[#6B7280]"> · {p.name}</span>}
                      </p>
                      <p className="text-[11px] text-[#9CA3AF]">{h.by} · {timeAgo(h.at)}</p>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}

/* Build initial form state for a provider from its saved row (if any). */
function initForm(provider: LLMProviderDef, row?: DbConfig): ProviderForm {
  const cfg = row?.configData || {};
  return {
    apiKey: '',
    endpoint: cfg.endpoint || provider.defaultEndpoint,
    model: cfg.model || provider.fallbackModels[0] || '',
    orgId: cfg.orgId || '',
    projectId: cfg.projectId || '',
    enabled: cfg.enabled !== undefined ? !!cfg.enabled : true,
  };
}
