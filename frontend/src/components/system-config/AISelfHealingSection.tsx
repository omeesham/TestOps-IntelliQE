import { useState, useEffect } from 'react';
import { Brain, Eye, EyeOff, CheckCircle, Loader2, Shield, Cpu, Zap, AlertTriangle, Key, Cloud } from 'lucide-react';
import { connectIntegration } from '@/services/api';

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
}

/**
 * Cloud LLMs are integrated with IntelliQE via API ONLY. There is a single
 * authentication method — an API key — and a connection is only considered valid
 * once a live round-trip to the provider's cloud API has succeeded. No CLI,
 * IAM, service-account or simulated "saved" path exists here anymore.
 */
interface FormState {
  // LLM Provider (cloud, API-only)
  aiProvider: string;
  aiModel: string;
  aiBaseUrl: string;
  aiApiKey: string;
  aiMaxTokens: number;
  aiTemperature: number;
  // Genuine connectivity proof — persisted so the verified badge survives reload
  cloudConnected: boolean;
  cloudVerifiedAt: string;
  cloudVerifiedModel: string;
  // Pipeline settings
  pipelineMode: string;
  enableWorker: boolean;
  workerSecret: string;
  // Self-Healing settings
  autoHealLocators: boolean;
  autoRetryAfterHealing: boolean;
  aiRootCauseAnalysis: boolean;
  healingConfidence: number;
  maxHealingAttempts: number;
}

interface ProviderDef {
  value: string;
  label: string;
  models: string[];
  defaultBaseUrl: string;
  /** Hint shown under the API Key field. */
  keyHint: string;
}

const AI_PROVIDERS: ProviderDef[] = [
  {
    value: 'claude', label: 'Claude (Anthropic)',
    models: ['claude-sonnet-4-20250514', 'claude-haiku-4-20250414', 'claude-opus-4-20250514'],
    defaultBaseUrl: 'https://api.anthropic.com',
    keyHint: 'Anthropic API key — starts with sk-ant-…  Create one at console.anthropic.com.',
  },
  {
    value: 'openai', label: 'GPT (OpenAI)',
    models: ['gpt-4o', 'gpt-4o-mini', 'gpt-4-turbo', 'o1-preview'],
    defaultBaseUrl: 'https://api.openai.com/v1',
    keyHint: 'OpenAI API key — starts with sk-…  Create one at platform.openai.com.',
  },
  {
    value: 'gemini', label: 'Gemini (Google)',
    models: ['gemini-2.0-flash', 'gemini-1.5-pro', 'gemini-1.5-flash'],
    defaultBaseUrl: 'https://generativelanguage.googleapis.com',
    keyHint: 'Google AI Studio API key. Create one at aistudio.google.com/apikey.',
  },
  {
    value: 'azure-openai', label: 'Azure OpenAI',
    models: ['gpt-4o', 'gpt-4-turbo'],
    defaultBaseUrl: 'https://your-resource.openai.azure.com',
    keyHint: 'Azure OpenAI resource key. Base URL must be your resource endpoint; Model is the deployment name.',
  },
  {
    value: 'custom', label: 'Custom / Self-Hosted (OpenAI-compatible)',
    models: ['custom-model'],
    defaultBaseUrl: 'https://llm.example.com/v1',
    keyHint: 'Bearer token / API key for your OpenAI-compatible cloud endpoint.',
  },
];

const PIPELINE_MODES = [
  { value: 'auto', label: 'Auto (AI when available, local fallback)', desc: 'Uses AI worker if credentials are configured; falls back to local agents otherwise.' },
  { value: 'ai-only', label: 'AI Only (Require AI worker)', desc: 'Always uses the AI pipeline worker. Fails if worker is not running.' },
  { value: 'local-only', label: 'Local Agents Only', desc: 'Uses built-in rule-based agents. No AI credentials required.' },
];

/** Fields whose change invalidates a prior live verification. */
const CONNECTIVITY_FIELDS = new Set<keyof FormState>(['aiProvider', 'aiModel', 'aiBaseUrl', 'aiApiKey']);

const INTEGRATION_ID = 'ai-self-healing';
const INPUT_CLASS = 'w-full px-3 py-2.5 rounded-xl border border-[#DDD6FE] bg-[#F5F3FF] text-sm outline-none focus:ring-2 focus:ring-[#7C3AED]/20 focus:border-[#7C3AED] placeholder:text-gray-400 transition-all';
const TOGGLE_CLASS = 'w-9 h-5 bg-gray-200 peer-focus:outline-none peer-focus:ring-2 peer-focus:ring-[#7C3AED]/20 rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[\'\'] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-[#7C3AED]';

function getDefaults(): FormState {
  return {
    aiProvider: 'claude',
    aiModel: 'claude-sonnet-4-20250514', aiBaseUrl: 'https://api.anthropic.com',
    aiApiKey: '', aiMaxTokens: 4096, aiTemperature: 0.3,
    cloudConnected: false, cloudVerifiedAt: '', cloudVerifiedModel: '',
    pipelineMode: 'auto', enableWorker: false, workerSecret: 'dev-secret',
    autoHealLocators: true, autoRetryAfterHealing: true, aiRootCauseAnalysis: false,
    healingConfidence: 75, maxHealingAttempts: 3,
  };
}

interface TestResult {
  ok: boolean;
  message: string;
  provider?: string;
  model?: string;
  latencyMs?: number;
  requestId?: string | null;
  verifiedAt?: string;
}

export default function AISelfHealingSection({ configs }: Props) {
  const existing = configs.find((c) => c.integrationId === INTEGRATION_ID);

  const [form, setForm] = useState<FormState>(() => {
    if (existing?.configData) return { ...getDefaults(), ...existing.configData };
    return getDefaults();
  });

  const [visibleSecrets, setVisibleSecrets] = useState<Record<string, boolean>>({});
  const [saving, setSaving] = useState(false);
  const [saveSuccess, setSaveSuccess] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<TestResult | null>(null);

  useEffect(() => {
    if (existing?.configData) setForm({ ...getDefaults(), ...existing.configData });
  }, [existing?.configData]);

  const toggleSecret = (key: string) => setVisibleSecrets(prev => ({ ...prev, [key]: !prev[key] }));

  const selectedProvider = AI_PROVIDERS.find(p => p.value === form.aiProvider) || AI_PROVIDERS[0];

  /**
   * Update a single field. Any edit to a connectivity-relevant field invalidates
   * the prior live verification — the user must re-run "Test Connection" before
   * the config can be saved again. This is what keeps the verified badge honest.
   */
  const setField = (field: keyof FormState, value: any) => {
    setForm(prev => {
      const next: FormState = { ...prev, [field]: value };
      if (CONNECTIVITY_FIELDS.has(field)) {
        next.cloudConnected = false;
        next.cloudVerifiedAt = '';
        next.cloudVerifiedModel = '';
      }
      return next;
    });
    if (CONNECTIVITY_FIELDS.has(field)) setTestResult(null);
  };

  const handleProviderChange = (providerValue: string) => {
    const provider = AI_PROVIDERS.find(p => p.value === providerValue) || AI_PROVIDERS[0];
    setForm(prev => ({
      ...prev,
      aiProvider: providerValue,
      aiModel: provider.models[0],
      aiBaseUrl: provider.defaultBaseUrl,
      cloudConnected: false, cloudVerifiedAt: '', cloudVerifiedModel: '',
    }));
    setTestResult(null);
  };

  /** Genuine, live cloud API connectivity check (never simulated). */
  const handleTestConnection = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const res = await fetch('/api/pipeline-admin/test-ai-connection', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${sessionStorage.getItem('intelliqe_token')}`,
        },
        body: JSON.stringify({
          provider: form.aiProvider,
          authMethod: 'api-key',
          apiKey: form.aiApiKey,
          model: form.aiModel,
          baseUrl: form.aiBaseUrl,
        }),
      });
      const data = await res.json();
      if (res.ok && data.ok) {
        setTestResult({
          ok: true,
          message: data.message || 'Live cloud API connection verified.',
          provider: data.provider, model: data.model, latencyMs: data.latencyMs,
          requestId: data.requestId, verifiedAt: data.verifiedAt,
        });
        // Record the genuine verification on the form so it persists on Save.
        setForm(prev => ({
          ...prev,
          cloudConnected: true,
          cloudVerifiedAt: data.verifiedAt || new Date().toISOString(),
          cloudVerifiedModel: data.model || prev.aiModel,
        }));
      } else {
        setTestResult({ ok: false, message: data.error || 'Connection test failed.' });
        setForm(prev => ({ ...prev, cloudConnected: false, cloudVerifiedAt: '', cloudVerifiedModel: '' }));
      }
    } catch (err: any) {
      setTestResult({ ok: false, message: err?.message || 'Could not reach the server to run the connection test.' });
      setForm(prev => ({ ...prev, cloudConnected: false, cloudVerifiedAt: '', cloudVerifiedModel: '' }));
    } finally {
      setTesting(false);
    }
  };

  const handleSave = async () => {
    // Guard: a cloud config cannot be saved until it has been genuinely verified.
    if (!form.cloudConnected) {
      setTestResult({ ok: false, message: 'Run "Test Connection" and get a live confirmation before saving.' });
      return;
    }
    setSaving(true);
    setSaveSuccess(false);
    try {
      // Always persist the enforced auth method so downstream code stays API-only.
      await connectIntegration(INTEGRATION_ID, { ...form, authMethod: 'api-key' });
      setSaveSuccess(true);
      setTimeout(() => setSaveSuccess(false), 3000);
    } catch (err: any) {
      console.error('Failed to save AI config:', err);
    } finally {
      setSaving(false);
    }
  };

  const hasCredentials = () => !!form.aiApiKey && (form.aiProvider !== 'custom' || !!form.aiBaseUrl);

  return (
    <div className="space-y-6">
      {/* ── LLM Provider (cloud, API only) ── */}
      <div>
        <div className="flex items-center gap-2 mb-1">
          <Brain className="w-4 h-4 text-[#7C3AED]" />
          <h3 className="text-sm font-semibold text-[#1E1B4B]">LLM Provider Configuration</h3>
        </div>
        <p className="text-xs text-[#6B7280] mb-4 ml-6">
          Cloud LLMs connect to IntelliQE <strong>via API only</strong>. Provide your provider, model and API key,
          then verify a live connection before saving.
        </p>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
          <div>
            <label className="block text-sm font-medium text-[#1E1B4B] mb-1">AI Provider</label>
            <select value={form.aiProvider} onChange={(e) => handleProviderChange(e.target.value)} className={INPUT_CLASS}>
              {AI_PROVIDERS.map(p => <option key={p.value} value={p.value}>{p.label}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium text-[#1E1B4B] mb-1">Model{form.aiProvider === 'azure-openai' ? ' / Deployment' : ''}</label>
            {form.aiProvider === 'azure-openai' || form.aiProvider === 'custom' ? (
              <input
                type="text" value={form.aiModel}
                onChange={(e) => setField('aiModel', e.target.value)}
                placeholder={form.aiProvider === 'azure-openai' ? 'your-deployment-name' : 'custom-model'}
                className={INPUT_CLASS}
              />
            ) : (
              <select value={form.aiModel} onChange={(e) => setField('aiModel', e.target.value)} className={INPUT_CLASS}>
                {selectedProvider.models.map(m => <option key={m} value={m}>{m}</option>)}
              </select>
            )}
          </div>
        </div>

        {/* ── Cloud API Connection (the ONLY integration path) ── */}
        <div className="rounded-2xl border border-[#DDD6FE] bg-gradient-to-br from-[#FAFAFE] to-[#F5F3FF] p-4">
          <div className="flex items-center gap-2 mb-3">
            <Cloud className="w-4 h-4 text-[#7C3AED]" />
            <span className="text-sm font-semibold text-[#1E1B4B]">Cloud API Connection</span>
            <span className="ml-1 text-[10px] font-medium px-2 py-0.5 rounded-full bg-[#EDE9FE] text-[#7C3AED] flex items-center gap-1">
              <Key className="w-3 h-3" /> API only
            </span>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {/* API Key */}
            <div>
              <label className="block text-sm font-medium text-[#1E1B4B] mb-1">API Key</label>
              <div className="relative">
                <input
                  type={visibleSecrets.aiApiKey ? 'text' : 'password'}
                  value={form.aiApiKey}
                  onChange={(e) => setField('aiApiKey', e.target.value)}
                  placeholder={form.aiProvider === 'claude' ? 'sk-ant-api03-…' : 'sk-…'}
                  autoComplete="off"
                  className={`${INPUT_CLASS} pr-10`}
                />
                <button type="button" onClick={() => toggleSecret('aiApiKey')} className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-[#7C3AED] transition-colors">
                  {visibleSecrets.aiApiKey ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
            </div>
            {/* Base URL */}
            <div>
              <label className="block text-sm font-medium text-[#1E1B4B] mb-1">Base URL</label>
              <input
                type="text" value={form.aiBaseUrl}
                onChange={(e) => setField('aiBaseUrl', e.target.value)}
                placeholder={selectedProvider.defaultBaseUrl}
                className={INPUT_CLASS}
              />
            </div>
          </div>
          <p className="text-[11px] text-[#6B7280] mt-2">{selectedProvider.keyHint}</p>
        </div>

        {/* Model Settings */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mt-4">
          <div>
            <label className="block text-sm font-medium text-[#1E1B4B] mb-1">Max Tokens</label>
            <input type="number" value={form.aiMaxTokens} onChange={(e) => setForm(prev => ({ ...prev, aiMaxTokens: parseInt(e.target.value) || 4096 }))} min={256} max={200000} className={INPUT_CLASS} />
          </div>
          <div>
            <label className="block text-sm font-medium text-[#1E1B4B] mb-1">Temperature: {form.aiTemperature}</label>
            <input type="range" min="0" max="1" step="0.1" value={form.aiTemperature} onChange={(e) => setForm(prev => ({ ...prev, aiTemperature: parseFloat(e.target.value) }))} className="w-full h-2 bg-[#EDE9FE] rounded-lg appearance-none cursor-pointer accent-[#7C3AED]" />
            <div className="flex justify-between text-[10px] text-[#6B7280] mt-0.5">
              <span>Precise (0)</span><span>Creative (1)</span>
            </div>
          </div>
        </div>

        {/* Test Connection + genuine verification status */}
        <div className="mt-4">
          <div className="flex items-center gap-3 flex-wrap">
            <button
              onClick={handleTestConnection}
              disabled={testing || !hasCredentials()}
              className="px-4 py-2 border border-[#7C3AED] text-[#7C3AED] rounded-lg text-sm font-medium hover:bg-[#F5F3FF] transition-all disabled:opacity-50 flex items-center gap-2"
            >
              {testing ? <Loader2 className="w-4 h-4 animate-spin" /> : <Zap className="w-4 h-4" />}
              {testing ? 'Verifying live connection…' : 'Test Connection'}
            </button>

            {/* Persistent verified badge — shown whenever the saved/last config is verified */}
            {form.cloudConnected && (
              <span className="flex items-center gap-1.5 text-xs font-semibold text-emerald-600 bg-emerald-50 border border-emerald-200 px-2.5 py-1 rounded-full">
                <CheckCircle className="w-3.5 h-3.5" /> Cloud connected via API
              </span>
            )}
          </div>

          {/* Live result panel — proves the connection is genuine, not simulated */}
          {testResult && (
            <div className={`mt-3 rounded-xl border p-3 text-xs ${testResult.ok ? 'border-emerald-200 bg-emerald-50' : 'border-red-200 bg-red-50'}`}>
              <div className={`flex items-center gap-1.5 font-semibold ${testResult.ok ? 'text-emerald-700' : 'text-red-600'}`}>
                {testResult.ok ? <CheckCircle className="w-4 h-4" /> : <AlertTriangle className="w-4 h-4" />}
                {testResult.ok ? 'Cloud connected via API — verified live' : 'Connection failed'}
              </div>
              <p className={`mt-1 ${testResult.ok ? 'text-emerald-800' : 'text-red-700'}`}>{testResult.message}</p>
              {testResult.ok && (
                <div className="mt-2 grid grid-cols-2 sm:grid-cols-4 gap-2 text-[11px] text-emerald-900/80">
                  {testResult.model != null && <div><span className="text-emerald-700/60">Model</span><br /><code>{testResult.model}</code></div>}
                  {testResult.latencyMs != null && <div><span className="text-emerald-700/60">Latency</span><br /><code>{testResult.latencyMs} ms</code></div>}
                  {testResult.requestId && <div className="truncate"><span className="text-emerald-700/60">Request ID</span><br /><code>{testResult.requestId}</code></div>}
                  {testResult.verifiedAt && <div><span className="text-emerald-700/60">Verified</span><br /><code>{new Date(testResult.verifiedAt).toLocaleTimeString()}</code></div>}
                </div>
              )}
            </div>
          )}

          {!testResult && !form.cloudConnected && (
            <p className="mt-2 text-[11px] text-[#6B7280]">Run a live test to confirm the cloud is reachable over its API before saving.</p>
          )}
        </div>
      </div>

      {/* ── Pipeline Mode ── */}
      <div className="border-t border-[#EDE9FE] pt-6">
        <div className="flex items-center gap-2 mb-4">
          <Cpu className="w-4 h-4 text-[#7C3AED]" />
          <h3 className="text-sm font-semibold text-[#1E1B4B]">Pipeline Orchestration</h3>
        </div>
        <div className="space-y-3">
          {PIPELINE_MODES.map(mode => (
            <label key={mode.value} className={`flex items-start gap-3 p-3 rounded-xl border cursor-pointer transition-all ${form.pipelineMode === mode.value ? 'border-[#7C3AED] bg-[#F5F3FF]' : 'border-[#E5E7EB] hover:border-[#DDD6FE]'}`}>
              <input type="radio" name="pipelineMode" value={mode.value} checked={form.pipelineMode === mode.value} onChange={() => setForm(prev => ({ ...prev, pipelineMode: mode.value }))} className="mt-0.5 accent-[#7C3AED]" />
              <div>
                <span className="text-sm font-medium text-[#1E1B4B]">{mode.label}</span>
                <p className="text-xs text-[#6B7280] mt-0.5">{mode.desc}</p>
              </div>
            </label>
          ))}
        </div>

        <div className="mt-4 grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="flex items-center justify-between col-span-full">
            <div>
              <span className="text-sm text-[#1E1B4B]">Enable AI Worker Process</span>
              <p className="text-xs text-[#6B7280]">Starts a background worker to process pipeline tasks with AI</p>
            </div>
            <label className="relative inline-flex items-center cursor-pointer">
              <input type="checkbox" checked={form.enableWorker} onChange={(e) => setForm(prev => ({ ...prev, enableWorker: e.target.checked }))} className="sr-only peer" />
              <div className={TOGGLE_CLASS} />
            </label>
          </div>
          {form.enableWorker && (
            <div>
              <label className="block text-sm font-medium text-[#1E1B4B] mb-1">Worker Secret</label>
              <div className="relative">
                <input
                  type={visibleSecrets.workerSecret ? 'text' : 'password'}
                  value={form.workerSecret}
                  onChange={(e) => setForm(prev => ({ ...prev, workerSecret: e.target.value }))}
                  placeholder="dev-secret"
                  autoComplete="off"
                  className={`${INPUT_CLASS} pr-10`}
                />
                <button type="button" onClick={() => toggleSecret('workerSecret')} className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-[#7C3AED] transition-colors">
                  {visibleSecrets.workerSecret ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* ── Self-Healing ── */}
      <div className="border-t border-[#EDE9FE] pt-6">
        <div className="flex items-center gap-2 mb-4">
          <Shield className="w-4 h-4 text-[#7C3AED]" />
          <h3 className="text-sm font-semibold text-[#1E1B4B]">Self-Healing</h3>
        </div>
        <div className="space-y-4">
          {([
            ['autoHealLocators', 'Enable auto-healing for broken locators'],
            ['autoRetryAfterHealing', 'Auto-retry failed tests after healing'],
            ['aiRootCauseAnalysis', 'Enable AI root cause analysis'],
          ] as const).map(([key, label]) => (
            <div key={key} className="flex items-center justify-between">
              <span className="text-sm text-[#1E1B4B]">{label}</span>
              <label className="relative inline-flex items-center cursor-pointer">
                <input type="checkbox" checked={form[key] as boolean} onChange={(e) => setForm(prev => ({ ...prev, [key]: e.target.checked }))} className="sr-only peer" />
                <div className={TOGGLE_CLASS} />
              </label>
            </div>
          ))}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-[#1E1B4B] mb-1">Healing Confidence: {form.healingConfidence}%</label>
              <input type="range" min="0" max="100" step="1" value={form.healingConfidence} onChange={(e) => setForm(prev => ({ ...prev, healingConfidence: parseInt(e.target.value, 10) }))} className="w-full h-2 bg-[#EDE9FE] rounded-lg appearance-none cursor-pointer accent-[#7C3AED]" />
              <div className="flex justify-between text-[10px] text-[#6B7280] mt-0.5"><span>0%</span><span>50%</span><span>100%</span></div>
            </div>
            <div>
              <label className="block text-sm font-medium text-[#1E1B4B] mb-1">Max Healing Attempts</label>
              <input type="number" value={form.maxHealingAttempts} onChange={(e) => setForm(prev => ({ ...prev, maxHealingAttempts: parseInt(e.target.value) || 3 }))} min={1} max={10} className={INPUT_CLASS} />
            </div>
          </div>
        </div>
      </div>

      {/* Save */}
      <div className="flex items-center justify-end gap-3 pt-2">
        {!form.cloudConnected && (
          <span className="flex items-center gap-1.5 text-xs text-amber-600 font-medium">
            <AlertTriangle className="w-4 h-4" /> Verify the cloud API connection to enable saving
          </span>
        )}
        {saveSuccess && (
          <span className="flex items-center gap-1.5 text-xs text-emerald-600 font-medium">
            <CheckCircle className="w-4 h-4" /> Settings saved
          </span>
        )}
        <button
          onClick={handleSave} disabled={saving || !form.cloudConnected}
          className="px-6 py-2.5 bg-gradient-to-r from-[#7C3AED] to-[#6366F1] text-white rounded-lg text-sm font-medium hover:from-[#6D28D9] hover:to-[#4F46E5] shadow-md shadow-purple-500/20 transition-all disabled:opacity-50 flex items-center gap-2"
        >
          {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle className="w-4 h-4" />}
          {saving ? 'Saving...' : 'Save Settings'}
        </button>
      </div>
    </div>
  );
}
