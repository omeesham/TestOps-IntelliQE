/**
 * LlmProviders — opt-in multi-LLM provider override.
 *
 * By default every generation stage runs on Anthropic. This dialog lets a
 * tenant point the whole generate → heal pipeline at another provider instead
 * — OpenAI, an OpenAI-compatible server, Azure OpenAI or Google Gemini — and
 * test the connection before (or after) saving. Disabling or removing the
 * override reverts to the default Anthropic configuration. Standalone and
 * opt-in: nothing changes until the override is enabled with a key on file.
 */
import { useEffect, useState } from 'react';
import { X, Plug, AlertTriangle, CheckCircle2, XCircle, Trash2 } from 'lucide-react';
import Spinner from '@/components/feedback/Spinner';
import { useToast } from '@/components/feedback/ToastProvider';
import {
  getLlmProviderConfig, saveLlmProviderConfig, deleteLlmProviderConfig, testLlmProvider,
  type ApiLlmProviderConfig,
} from '@/services/api';
import { CARD, STRIP, INPUT, LABEL, PRIMARY_BTN, SECONDARY_BTN } from './format';

type TestOutcome = Awaited<ReturnType<typeof testLlmProvider>>;

const PROVIDERS: { id: string; label: string }[] = [
  { id: 'openai', label: 'OpenAI' },
  { id: 'openai-compatible', label: 'OpenAI-compatible server' },
  { id: 'azure-openai', label: 'Azure OpenAI' },
  { id: 'gemini', label: 'Google Gemini' },
];

/** Per-provider model placeholder — a sensible default name to type. */
const MODEL_PLACEHOLDER: Record<string, string> = {
  'openai': 'gpt-4o-mini',
  'openai-compatible': 'openai/gpt-4o-mini',
  'azure-openai': 'gpt-4o (deployment name)',
  'gemini': 'gemini-1.5-flash',
};

/** Per-provider base-URL field: label, whether it is required, placeholder. */
function baseUrlMeta(provider: string): { label: string; required: boolean; placeholder: string } {
  switch (provider) {
    case 'azure-openai':
      return { label: 'Deployment URL', required: true, placeholder: 'https://my-resource.openai.azure.com/openai/deployments/…' };
    case 'openai-compatible':
      return { label: 'Base URL', required: true, placeholder: 'https://openrouter.ai/api/v1' };
    case 'gemini':
      return { label: 'Base URL', required: false, placeholder: 'https://generativelanguage.googleapis.com (optional)' };
    default:
      return { label: 'Base URL', required: false, placeholder: 'https://api.openai.com/v1 (optional)' };
  }
}

export default function LlmProviders({ onClose }: { onClose: () => void }) {
  const toast = useToast();

  const [provider, setProvider] = useState('openai');
  const [model, setModel] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [enabled, setEnabled] = useState(false);
  const [hasKey, setHasKey] = useState(false);
  const [keyMasked, setKeyMasked] = useState('');

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [error, setError] = useState('');
  const [test, setTest] = useState<TestOutcome | null>(null);

  const active = enabled && hasKey;
  const urlMeta = baseUrlMeta(provider);

  const applyConfig = (cfg: ApiLlmProviderConfig) => {
    setProvider(cfg.provider || 'openai');
    setModel(cfg.model || '');
    setBaseUrl(cfg.baseUrl || '');
    setEnabled(!!cfg.enabled);
    setHasKey(!!cfg.hasKey);
    setKeyMasked(cfg.keyMasked || '');
    setApiKey('');
  };

  useEffect(() => {
    (async () => {
      try {
        const cfg = await getLlmProviderConfig();
        applyConfig(cfg);
      } catch (e: any) {
        setError(e?.response?.data?.error || e?.message || 'Could not load provider configuration.');
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const runTest = async () => {
    setTesting(true); setTest(null); setError('');
    try {
      const r = await testLlmProvider({ provider, model, baseUrl, apiKey: apiKey || undefined });
      setTest(r);
    } catch (e: any) {
      setError(e?.response?.data?.error || e?.message || 'Could not test the provider.');
    } finally {
      setTesting(false);
    }
  };

  const save = async () => {
    setSaving(true); setError('');
    try {
      const cfg = await saveLlmProviderConfig({ enabled, provider, model, baseUrl, apiKey: apiKey || undefined });
      applyConfig(cfg);
      toast.success('Provider saved', enabled ? 'Generation will run through this provider.' : 'Saved — override is disabled.');
    } catch (e: any) {
      setError(e?.response?.data?.error || e?.message || 'Could not save the provider.');
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    setRemoving(true); setError('');
    try {
      await deleteLlmProviderConfig();
      const cfg = await getLlmProviderConfig();
      applyConfig(cfg);
      setTest(null);
      toast.success('Provider removed', 'Reverted to the default Anthropic configuration.');
    } catch (e: any) {
      setError(e?.response?.data?.error || e?.message || 'Could not remove the provider.');
    } finally {
      setRemoving(false);
    }
  };

  const busy = saving || testing || removing;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-[#1E1B4B]/30 backdrop-blur-sm p-4" onClick={onClose}>
      <div className={`${CARD} w-full max-w-xl max-h-[85vh] flex flex-col overflow-hidden`} onClick={(e) => e.stopPropagation()}>
        <div className={`flex items-center gap-2 px-4 h-12 border-b border-[#EDE9FE] flex-shrink-0 ${STRIP}`}>
          <Plug className="w-4 h-4 text-[#7C3AED]" />
          <h3 className="text-[13px] font-semibold text-gray-900">LLM providers</h3>
          <span className="text-[11px] text-gray-400">use OpenAI, Azure, Gemini or a compatible server</span>
          {active && (
            <span className="ml-auto inline-flex items-center gap-1 px-1.5 py-0.5 rounded border text-[10.5px] font-semibold text-emerald-700 bg-emerald-50 border-emerald-200">
              <CheckCircle2 className="w-3 h-3" />Active
            </span>
          )}
          <button type="button" onClick={onClose} className="ml-auto p-1.5 rounded-md text-gray-400 hover:text-[#7C3AED] hover:bg-[#F5F3FF]"><X className="w-4 h-4" /></button>
        </div>

        <div className="p-4 space-y-3 overflow-y-auto min-h-0">
          {error && (
            <div className="flex items-start gap-2 px-3 py-2 bg-red-50 border border-red-200 rounded-lg">
              <AlertTriangle className="w-4 h-4 text-red-500 flex-shrink-0 mt-px" /><p className="text-[12px] text-red-700 min-w-0">{error}</p>
            </div>
          )}

          {loading ? (
            <div className="flex items-center justify-center py-10 text-gray-400"><Spinner className="w-5 h-5 animate-spin" /></div>
          ) : (
            <>
              <div>
                <label className={LABEL}>Provider</label>
                <select value={provider} onChange={(e) => { setProvider(e.target.value); setTest(null); }} className={INPUT}>
                  {PROVIDERS.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
                </select>
              </div>

              <div>
                <label className={LABEL}>Model</label>
                <input value={model} onChange={(e) => setModel(e.target.value)} placeholder={MODEL_PLACEHOLDER[provider] || 'model name'} className={INPUT} />
              </div>

              <div>
                <label className={LABEL}>{urlMeta.label}{urlMeta.required && <span className="text-red-500"> *</span>}</label>
                <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder={urlMeta.placeholder} className={INPUT} />
              </div>

              <div>
                <label className={LABEL}>API key</label>
                <input
                  type="password"
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  placeholder={hasKey ? keyMasked : 'sk-…'}
                  autoComplete="new-password"
                  className={INPUT}
                />
                {hasKey && <p className="text-[10.5px] text-gray-400 mt-1">Leave blank to keep the saved key.</p>}
              </div>

              <label className="flex items-start gap-2 cursor-pointer select-none rounded-lg border border-[#E4E0F5] bg-[#FAF9FE] px-3 py-2">
                <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} className="w-3.5 h-3.5 rounded border-[#C4B5FD] text-[#7C3AED] mt-0.5" />
                <span className="text-[12px] text-gray-700">Enabled — when on, this provider overrides Anthropic for all generation.</span>
              </label>

              <div className="flex items-start gap-2 px-3 py-2 rounded-lg bg-[#F5F3FF] border border-[#DDD6FE]">
                <Plug className="w-4 h-4 text-[#7C3AED] flex-shrink-0 mt-px" />
                <p className="text-[11.5px] text-[#4C1D95] min-w-0">When enabled, the whole generate → heal pipeline runs through this provider. Disable or remove it to revert to the default Anthropic configuration.</p>
              </div>

              {test && (
                <div className={`flex items-start gap-2 px-3 py-2 rounded-lg border ${test.ok ? 'bg-emerald-50 border-emerald-200' : 'bg-red-50 border-red-200'}`}>
                  {test.ok ? <CheckCircle2 className="w-4 h-4 text-emerald-500 flex-shrink-0 mt-px" /> : <XCircle className="w-4 h-4 text-red-500 flex-shrink-0 mt-px" />}
                  <p className={`text-[12px] min-w-0 ${test.ok ? 'text-emerald-700' : 'text-red-700'}`}>
                    {test.ok ? (test.reply ? `Connected — ${test.reply}` : 'Connection succeeded.') : (test.error || 'Connection failed.')}
                    <span className="text-gray-400"> · {test.elapsedMs}ms</span>
                  </p>
                </div>
              )}

              <div className="flex items-center gap-2 pt-1">
                <button type="button" onClick={() => void runTest()} disabled={busy} className={SECONDARY_BTN}>
                  {testing ? <Spinner className="w-3.5 h-3.5 animate-spin" /> : <Plug className="w-3.5 h-3.5" />}Test
                </button>
                <button type="button" onClick={() => void save()} disabled={busy} className={`${PRIMARY_BTN} ml-auto`}>
                  {saving ? <Spinner className="w-3.5 h-3.5 animate-spin" /> : <CheckCircle2 className="w-3.5 h-3.5" />}Save
                </button>
                {(hasKey || enabled) && (
                  <button type="button" onClick={() => void remove()} disabled={busy} className="inline-flex items-center gap-1.5 px-2.5 py-2 text-[12px] font-medium text-red-500 rounded-lg hover:bg-red-50 disabled:opacity-40 transition-colors">
                    {removing ? <Spinner className="w-3.5 h-3.5 animate-spin" /> : <Trash2 className="w-3.5 h-3.5" />}Remove
                  </button>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
