import { useState, useEffect } from 'react';
import { Brain, Eye, EyeOff, CheckCircle, Loader2, Shield, Cpu, Zap, AlertTriangle, Key, Cloud, Lock } from 'lucide-react';
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

type AuthMethod = 'api-key' | 'claude-cli' | 'aws-bedrock' | 'gcp-vertex' | 'azure-ad' | 'oauth';

interface FormState {
  // LLM Provider
  aiProvider: string;
  authMethod: AuthMethod;
  aiModel: string;
  aiBaseUrl: string;
  aiMaxTokens: number;
  aiTemperature: number;
  // API Key auth
  aiApiKey: string;
  // Claude CLI auth
  cliPath: string;
  cliAutoDetect: boolean;
  // AWS Bedrock auth
  awsAccessKeyId: string;
  awsSecretAccessKey: string;
  awsRegion: string;
  awsSessionToken: string;
  // GCP Vertex AI auth
  gcpProjectId: string;
  gcpLocation: string;
  gcpServiceAccountKey: string;
  // Azure AD auth
  azureTenantId: string;
  azureClientId: string;
  azureClientSecret: string;
  azureResourceName: string;
  // OAuth / SSO
  oauthClientId: string;
  oauthClientSecret: string;
  oauthTokenUrl: string;
  oauthScope: string;
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
  authMethods: { value: AuthMethod; label: string; icon: React.ElementType; desc: string }[];
  defaultBaseUrl: string;
}

const AI_PROVIDERS: ProviderDef[] = [
  {
    value: 'claude', label: 'Claude (Anthropic)',
    models: ['claude-sonnet-4-20250514', 'claude-haiku-4-20250414', 'claude-opus-4-20250514'],
    defaultBaseUrl: 'https://api.anthropic.com',
    authMethods: [
      { value: 'api-key', label: 'API Key', icon: Key, desc: 'Authenticate with an Anthropic API key (sk-ant-...)' },
      { value: 'claude-cli', label: 'Claude CLI / Claude Code', icon: Lock, desc: 'Use your existing Claude CLI session — no API key needed. Runs via the claude command.' },
      { value: 'aws-bedrock', label: 'AWS Bedrock', icon: Cloud, desc: 'Access Claude via AWS Bedrock with IAM credentials' },
      { value: 'gcp-vertex', label: 'Google Vertex AI', icon: Cloud, desc: 'Access Claude via Google Cloud Vertex AI' },
    ],
  },
  {
    value: 'openai', label: 'GPT (OpenAI)',
    models: ['gpt-4o', 'gpt-4o-mini', 'gpt-4-turbo', 'o1-preview'],
    defaultBaseUrl: 'https://api.openai.com/v1',
    authMethods: [
      { value: 'api-key', label: 'API Key', icon: Key, desc: 'Authenticate with an OpenAI API key (sk-...)' },
      { value: 'azure-ad', label: 'Azure OpenAI', icon: Cloud, desc: 'Access GPT via Azure OpenAI with Azure AD credentials' },
    ],
  },
  {
    value: 'gemini', label: 'Gemini (Google)',
    models: ['gemini-2.0-flash', 'gemini-1.5-pro', 'gemini-1.5-flash'],
    defaultBaseUrl: 'https://generativelanguage.googleapis.com',
    authMethods: [
      { value: 'api-key', label: 'API Key', icon: Key, desc: 'Authenticate with a Google AI API key' },
      { value: 'gcp-vertex', label: 'GCP Vertex AI', icon: Cloud, desc: 'Use Google Cloud service account credentials' },
    ],
  },
  {
    value: 'azure-openai', label: 'Azure OpenAI',
    models: ['gpt-4o', 'gpt-4-turbo'],
    defaultBaseUrl: 'https://your-resource.openai.azure.com',
    authMethods: [
      { value: 'api-key', label: 'API Key', icon: Key, desc: 'Use Azure OpenAI resource API key' },
      { value: 'azure-ad', label: 'Azure AD / Entra ID', icon: Lock, desc: 'Authenticate with Azure AD app registration (client credentials)' },
    ],
  },
  {
    value: 'custom', label: 'Custom / Self-Hosted',
    models: ['custom-model'],
    defaultBaseUrl: 'http://localhost:11434',
    authMethods: [
      { value: 'api-key', label: 'API Key / Token', icon: Key, desc: 'Bearer token or API key for your custom endpoint' },
      { value: 'oauth', label: 'OAuth 2.0 Client Credentials', icon: Lock, desc: 'OAuth 2.0 client credentials flow for enterprise endpoints' },
    ],
  },
];

const PIPELINE_MODES = [
  { value: 'auto', label: 'Auto (AI when available, local fallback)', desc: 'Uses AI worker if credentials are configured; falls back to local agents otherwise.' },
  { value: 'ai-only', label: 'AI Only (Require AI worker)', desc: 'Always uses the AI pipeline worker. Fails if worker is not running.' },
  { value: 'local-only', label: 'Local Agents Only', desc: 'Uses built-in rule-based agents. No AI credentials required.' },
];

const AWS_REGIONS = [
  'us-east-1', 'us-east-2', 'us-west-2', 'eu-west-1', 'eu-west-2', 'eu-central-1',
  'ap-southeast-1', 'ap-southeast-2', 'ap-northeast-1', 'ap-south-1',
];

const GCP_LOCATIONS = [
  'us-central1', 'us-east4', 'us-west1', 'europe-west1', 'europe-west4',
  'asia-southeast1', 'asia-northeast1',
];

const INTEGRATION_ID = 'ai-self-healing';
const INPUT_CLASS = 'w-full px-3 py-2.5 rounded-xl border border-[#DDD6FE] bg-[#F5F3FF] text-sm outline-none focus:ring-2 focus:ring-[#7C3AED]/20 focus:border-[#7C3AED] placeholder:text-gray-400 transition-all';
const TOGGLE_CLASS = 'w-9 h-5 bg-gray-200 peer-focus:outline-none peer-focus:ring-2 peer-focus:ring-[#7C3AED]/20 rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[\'\'] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-[#7C3AED]';

function getDefaults(): FormState {
  return {
    aiProvider: 'claude', authMethod: 'api-key',
    aiModel: 'claude-sonnet-4-20250514', aiBaseUrl: 'https://api.anthropic.com',
    aiMaxTokens: 4096, aiTemperature: 0.3,
    aiApiKey: '',
    cliPath: '', cliAutoDetect: true,
    awsAccessKeyId: '', awsSecretAccessKey: '', awsRegion: 'us-east-1', awsSessionToken: '',
    gcpProjectId: '', gcpLocation: 'us-central1', gcpServiceAccountKey: '',
    azureTenantId: '', azureClientId: '', azureClientSecret: '', azureResourceName: '',
    oauthClientId: '', oauthClientSecret: '', oauthTokenUrl: '', oauthScope: '',
    pipelineMode: 'auto', enableWorker: false, workerSecret: 'dev-secret',
    autoHealLocators: true, autoRetryAfterHealing: true, aiRootCauseAnalysis: false,
    healingConfidence: 75, maxHealingAttempts: 3,
  };
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
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);

  useEffect(() => {
    if (existing?.configData) setForm({ ...getDefaults(), ...existing.configData });
  }, [existing?.configData]);

  const toggleSecret = (key: string) => setVisibleSecrets(prev => ({ ...prev, [key]: !prev[key] }));

  const selectedProvider = AI_PROVIDERS.find(p => p.value === form.aiProvider) || AI_PROVIDERS[0];

  const handleProviderChange = (providerValue: string) => {
    const provider = AI_PROVIDERS.find(p => p.value === providerValue) || AI_PROVIDERS[0];
    setForm(prev => ({
      ...prev,
      aiProvider: providerValue,
      aiModel: provider.models[0],
      aiBaseUrl: provider.defaultBaseUrl,
      authMethod: provider.authMethods[0].value,
    }));
    setTestResult(null);
  };

  const handleAuthMethodChange = (method: AuthMethod) => {
    setForm(prev => {
      const updates: Partial<FormState> = { authMethod: method };
      // Auto-set base URL based on auth method
      if (method === 'aws-bedrock') updates.aiBaseUrl = `https://bedrock-runtime.${prev.awsRegion || 'us-east-1'}.amazonaws.com`;
      else if (method === 'gcp-vertex') updates.aiBaseUrl = `https://${prev.gcpLocation || 'us-central1'}-aiplatform.googleapis.com`;
      else if (method === 'azure-ad') updates.aiBaseUrl = `https://${prev.azureResourceName || 'your-resource'}.openai.azure.com`;
      else updates.aiBaseUrl = selectedProvider.defaultBaseUrl;
      return { ...prev, ...updates };
    });
    setTestResult(null);
  };

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
          provider: form.aiProvider, authMethod: form.authMethod,
          apiKey: form.aiApiKey, model: form.aiModel, baseUrl: form.aiBaseUrl,
          awsAccessKeyId: form.awsAccessKeyId, awsSecretAccessKey: form.awsSecretAccessKey,
          awsRegion: form.awsRegion, awsSessionToken: form.awsSessionToken,
          gcpProjectId: form.gcpProjectId, gcpLocation: form.gcpLocation,
          azureTenantId: form.azureTenantId, azureClientId: form.azureClientId,
          azureClientSecret: form.azureClientSecret, azureResourceName: form.azureResourceName,
          oauthClientId: form.oauthClientId, oauthClientSecret: form.oauthClientSecret,
          oauthTokenUrl: form.oauthTokenUrl, oauthScope: form.oauthScope,
        }),
      });
      const data = await res.json();
      if (res.ok) {
        setTestResult({ ok: true, message: data.message || 'Connection successful!' });
      } else {
        setTestResult({ ok: false, message: data.error || 'Connection test failed.' });
      }
    } catch (err: any) {
      setTestResult({ ok: false, message: err.message || 'Network error' });
    } finally {
      setTesting(false);
    }
  };

  const handleSave = async () => {
    setSaving(true);
    setSaveSuccess(false);
    try {
      await connectIntegration(INTEGRATION_ID, { ...form });
      setSaveSuccess(true);
      setTimeout(() => setSaveSuccess(false), 3000);
    } catch (err: any) {
      console.error('Failed to save AI config:', err);
    } finally {
      setSaving(false);
    }
  };

  // Reusable password input
  const SecretInput = ({ label, field, placeholder }: { label: string; field: keyof FormState; placeholder: string }) => (
    <div>
      <label className="block text-sm font-medium text-[#1E1B4B] mb-1">{label}</label>
      <div className="relative">
        <input
          type={visibleSecrets[field] ? 'text' : 'password'}
          value={form[field] as string}
          onChange={(e) => setForm(prev => ({ ...prev, [field]: e.target.value }))}
          placeholder={placeholder}
          autoComplete="off"
          className={`${INPUT_CLASS} pr-10`}
        />
        <button type="button" onClick={() => toggleSecret(field)} className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-[#7C3AED] transition-colors">
          {visibleSecrets[field] ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
        </button>
      </div>
    </div>
  );

  const TextInput = ({ label, field, placeholder }: { label: string; field: keyof FormState; placeholder: string }) => (
    <div>
      <label className="block text-sm font-medium text-[#1E1B4B] mb-1">{label}</label>
      <input
        type="text"
        value={form[field] as string}
        onChange={(e) => setForm(prev => ({ ...prev, [field]: e.target.value }))}
        placeholder={placeholder}
        className={INPUT_CLASS}
      />
    </div>
  );

  const SelectInput = ({ label, field, options }: { label: string; field: keyof FormState; options: string[] }) => (
    <div>
      <label className="block text-sm font-medium text-[#1E1B4B] mb-1">{label}</label>
      <select
        value={form[field] as string}
        onChange={(e) => setForm(prev => ({ ...prev, [field]: e.target.value }))}
        className={INPUT_CLASS}
      >
        {options.map(o => <option key={o} value={o}>{o}</option>)}
      </select>
    </div>
  );

  // Auth-specific credential fields
  const renderAuthFields = () => {
    switch (form.authMethod) {
      case 'api-key':
        return (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <SecretInput label="API Key" field="aiApiKey" placeholder={form.aiProvider === 'claude' ? 'sk-ant-api03-...' : 'sk-...'} />
            <TextInput label="Base URL" field="aiBaseUrl" placeholder={selectedProvider.defaultBaseUrl} />
          </div>
        );

      case 'claude-cli':
        return (
          <div className="space-y-4">
            <div className="p-3 bg-green-50 border border-green-200 rounded-xl text-xs text-green-800">
              Uses your locally installed <strong>Claude CLI / Claude Code</strong> session. If you're already logged in via <code>claude</code> command, no additional credentials are needed. The pipeline worker will invoke Claude through the CLI.
            </div>
            <div className="flex items-center justify-between">
              <div>
                <span className="text-sm text-[#1E1B4B]">Auto-detect CLI path</span>
                <p className="text-xs text-[#6B7280]">Automatically find the <code>claude</code> command on your system PATH</p>
              </div>
              <label className="relative inline-flex items-center cursor-pointer">
                <input type="checkbox" checked={form.cliAutoDetect} onChange={(e) => setForm(prev => ({ ...prev, cliAutoDetect: e.target.checked }))} className="sr-only peer" />
                <div className={TOGGLE_CLASS} />
              </label>
            </div>
            {!form.cliAutoDetect && (
              <TextInput label="Claude CLI Path" field="cliPath" placeholder="C:\\Users\\you\\.claude\\claude.exe or /usr/local/bin/claude" />
            )}
            <div className="p-3 bg-[#F5F3FF] border border-[#DDD6FE] rounded-xl text-xs text-[#1E1B4B] space-y-1.5">
              <p className="font-semibold">How to set up Claude CLI:</p>
              <ol className="list-decimal ml-4 space-y-1 text-[#6B7280]">
                <li>Install Claude Code: <code className="bg-white px-1 rounded">npm install -g @anthropic-ai/claude-code</code></li>
                <li>Login: <code className="bg-white px-1 rounded">claude login</code></li>
                <li>Verify: <code className="bg-white px-1 rounded">claude --version</code></li>
                <li>Come back here and click <strong>Test Connection</strong></li>
              </ol>
            </div>
          </div>
        );

      case 'aws-bedrock':
        return (
          <div className="space-y-4">
            <div className="p-3 bg-amber-50 border border-amber-200 rounded-xl text-xs text-amber-800">
              Access Claude through AWS Bedrock using your IAM credentials. Ensure the Bedrock model access is enabled in your AWS account.
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <TextInput label="AWS Access Key ID" field="awsAccessKeyId" placeholder="AKIAIOSFODNN7EXAMPLE" />
              <SecretInput label="AWS Secret Access Key" field="awsSecretAccessKey" placeholder="wJalrXUtnFEMI/K7MDENG/..." />
              <SelectInput label="AWS Region" field="awsRegion" options={AWS_REGIONS} />
              <SecretInput label="Session Token (optional)" field="awsSessionToken" placeholder="For temporary credentials / SSO" />
            </div>
          </div>
        );

      case 'gcp-vertex':
        return (
          <div className="space-y-4">
            <div className="p-3 bg-blue-50 border border-blue-200 rounded-xl text-xs text-blue-800">
              Access Claude or Gemini via Google Cloud Vertex AI. Provide your GCP project credentials.
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <TextInput label="GCP Project ID" field="gcpProjectId" placeholder="my-project-123456" />
              <SelectInput label="Location" field="gcpLocation" options={GCP_LOCATIONS} />
            </div>
            <div>
              <label className="block text-sm font-medium text-[#1E1B4B] mb-1">Service Account Key (JSON)</label>
              <textarea
                value={form.gcpServiceAccountKey}
                onChange={(e) => setForm(prev => ({ ...prev, gcpServiceAccountKey: e.target.value }))}
                placeholder='Paste your service account JSON key here, or leave empty to use Application Default Credentials (ADC)'
                rows={4}
                className={`${INPUT_CLASS} font-mono text-xs`}
              />
              <p className="text-[10px] text-[#6B7280] mt-1">Leave empty if running on GCP with default credentials or using <code>gcloud auth</code></p>
            </div>
          </div>
        );

      case 'azure-ad':
        return (
          <div className="space-y-4">
            <div className="p-3 bg-blue-50 border border-blue-200 rounded-xl text-xs text-blue-800">
              Authenticate with Azure AD (Entra ID) using an App Registration. This uses the client credentials flow.
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <TextInput label="Azure Resource Name" field="azureResourceName" placeholder="my-openai-resource" />
              <TextInput label="Tenant ID" field="azureTenantId" placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" />
              <TextInput label="Client ID (App ID)" field="azureClientId" placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" />
              <SecretInput label="Client Secret" field="azureClientSecret" placeholder="Your app registration secret" />
            </div>
          </div>
        );

      case 'oauth':
        return (
          <div className="space-y-4">
            <div className="p-3 bg-purple-50 border border-purple-200 rounded-xl text-xs text-purple-800">
              OAuth 2.0 Client Credentials flow for enterprise / self-hosted LLM endpoints.
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <TextInput label="Token URL" field="oauthTokenUrl" placeholder="https://auth.example.com/oauth/token" />
              <TextInput label="Scope" field="oauthScope" placeholder="llm:invoke (optional)" />
              <TextInput label="Client ID" field="oauthClientId" placeholder="your-client-id" />
              <SecretInput label="Client Secret" field="oauthClientSecret" placeholder="your-client-secret" />
              <TextInput label="LLM Base URL" field="aiBaseUrl" placeholder="https://llm.example.com/v1" />
            </div>
          </div>
        );

      default:
        return null;
    }
  };

  const hasCredentials = () => {
    switch (form.authMethod) {
      case 'api-key': return !!form.aiApiKey;
      case 'claude-cli': return true; // CLI auth is always ready if selected
      case 'aws-bedrock': return !!form.awsAccessKeyId && !!form.awsSecretAccessKey;
      case 'gcp-vertex': return !!form.gcpProjectId;
      case 'azure-ad': return !!form.azureClientId && !!form.azureClientSecret && !!form.azureTenantId;
      case 'oauth': return !!form.oauthClientId && !!form.oauthClientSecret && !!form.oauthTokenUrl;
      default: return false;
    }
  };

  return (
    <div className="space-y-6">
      {/* ── LLM Provider ── */}
      <div>
        <div className="flex items-center gap-2 mb-4">
          <Brain className="w-4 h-4 text-[#7C3AED]" />
          <h3 className="text-sm font-semibold text-[#1E1B4B]">LLM Provider Configuration</h3>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
          <div>
            <label className="block text-sm font-medium text-[#1E1B4B] mb-1">AI Provider</label>
            <select value={form.aiProvider} onChange={(e) => handleProviderChange(e.target.value)} className={INPUT_CLASS}>
              {AI_PROVIDERS.map(p => <option key={p.value} value={p.value}>{p.label}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium text-[#1E1B4B] mb-1">Model</label>
            <select value={form.aiModel} onChange={(e) => setForm(prev => ({ ...prev, aiModel: e.target.value }))} className={INPUT_CLASS}>
              {selectedProvider.models.map(m => <option key={m} value={m}>{m}</option>)}
            </select>
          </div>
        </div>

        {/* Auth Method Selection */}
        <div className="mb-4">
          <label className="block text-sm font-medium text-[#1E1B4B] mb-2">Authentication Method</label>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
            {selectedProvider.authMethods.map(am => {
              const Icon = am.icon;
              return (
                <label
                  key={am.value}
                  className={`flex items-start gap-2.5 p-3 rounded-xl border cursor-pointer transition-all ${
                    form.authMethod === am.value
                      ? 'border-[#7C3AED] bg-[#F5F3FF] ring-1 ring-[#7C3AED]/30'
                      : 'border-[#E5E7EB] hover:border-[#DDD6FE] hover:bg-[#FAFAFE]'
                  }`}
                >
                  <input
                    type="radio" name="authMethod" value={am.value}
                    checked={form.authMethod === am.value}
                    onChange={() => handleAuthMethodChange(am.value)}
                    className="mt-0.5 accent-[#7C3AED]"
                  />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5">
                      <Icon className="w-3.5 h-3.5 text-[#7C3AED]" />
                      <span className="text-sm font-medium text-[#1E1B4B]">{am.label}</span>
                    </div>
                    <p className="text-[11px] text-[#6B7280] mt-0.5 leading-snug">{am.desc}</p>
                  </div>
                </label>
              );
            })}
          </div>
        </div>

        {/* Auth Credential Fields */}
        {renderAuthFields()}

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

        {/* Test Connection */}
        <div className="mt-4 flex items-center gap-3">
          <button
            onClick={handleTestConnection}
            disabled={testing || !hasCredentials()}
            className="px-4 py-2 border border-[#7C3AED] text-[#7C3AED] rounded-lg text-sm font-medium hover:bg-[#F5F3FF] transition-all disabled:opacity-50 flex items-center gap-2"
          >
            {testing ? <Loader2 className="w-4 h-4 animate-spin" /> : <Zap className="w-4 h-4" />}
            {testing ? 'Testing...' : 'Test Connection'}
          </button>
          {testResult && (
            <span className={`flex items-center gap-1.5 text-xs font-medium ${testResult.ok ? 'text-emerald-600' : 'text-red-500'}`}>
              {testResult.ok ? <CheckCircle className="w-4 h-4" /> : <AlertTriangle className="w-4 h-4" />}
              {testResult.message}
            </span>
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
          {form.enableWorker && <SecretInput label="Worker Secret" field="workerSecret" placeholder="dev-secret" />}
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
        {saveSuccess && (
          <span className="flex items-center gap-1.5 text-xs text-emerald-600 font-medium">
            <CheckCircle className="w-4 h-4" /> Settings saved
          </span>
        )}
        <button
          onClick={handleSave} disabled={saving}
          className="px-6 py-2.5 bg-gradient-to-r from-[#7C3AED] to-[#6366F1] text-white rounded-lg text-sm font-medium hover:from-[#6D28D9] hover:to-[#4F46E5] shadow-md shadow-purple-500/20 transition-all disabled:opacity-50 flex items-center gap-2"
        >
          {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle className="w-4 h-4" />}
          {saving ? 'Saving...' : 'Save Settings'}
        </button>
      </div>
    </div>
  );
}
