import { useState } from 'react';
import { X, Plug, Loader2, Eye, EyeOff, Send, CheckCircle, AlertCircle } from 'lucide-react';
import type { CatalogItem } from './integrationCatalog';
import { normalizeError } from '@/utils/apiError';

interface Props {
  integration: CatalogItem;
  saving: boolean;
  error: string;
  onSave: (formData: Record<string, string>) => void;
  onClose: () => void;
  /** Optional: verify connectivity with the entered values before saving. */
  onTest?: (formData: Record<string, string>) => Promise<{ ok?: boolean; sent?: boolean; error?: string; message?: string }>;
  /** Label for the test button (default "Send Test"). */
  testLabel?: string;
  /** Prefill values when editing an existing configuration (secrets excluded). */
  initialValues?: Record<string, string>;
}

export default function ConnectModal({ integration, saving, error, onSave, onClose, onTest, testLabel = 'Send Test', initialValues }: Props) {
  const [formData, setFormData] = useState<Record<string, string>>(initialValues || {});
  const [visibleFields, setVisibleFields] = useState<Set<string>>(new Set());
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);

  const toggleVisibility = (key: string) => {
    setVisibleFields(prev => {
      const next = new Set(prev);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });
  };

  const handleTest = async () => {
    if (!onTest) return;
    setTesting(true);
    setTestResult(null);
    try {
      const r = await onTest(formData);
      const ok = !!(r.ok || r.sent);
      setTestResult({ ok, message: ok ? (r.message || 'Test message sent — check your channel.') : (r.error || r.message || 'Test failed.') });
    } catch (err: any) {
      // A raw axios 500 (e.g. the dev proxy couldn't reach the backend) has no
      // JSON body, so surface a human message via normalizeError instead of the
      // cryptic "Request failed with status code 500".
      const n = normalizeError(err);
      setTestResult({ ok: false, message: n.hint ? `${n.title} — ${n.hint}` : (n.message || 'Test failed.') });
    } finally {
      setTesting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md p-6 relative">
        <button onClick={onClose} className="absolute top-4 right-4 text-gray-400 hover:text-gray-600">
          <X className="w-5 h-5" />
        </button>
        <h3 className="text-lg font-bold text-[#1E1B4B] mb-1">Connect {integration.name}</h3>
        <p className="text-xs text-[#6B7280] mb-5">{integration.category}</p>

        {error && (
          <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-lg text-xs text-red-600">{error}</div>
        )}

        <div className="space-y-4">
          {integration.fields.map((field) => (
            <div key={field.key}>
              <label className="block text-xs font-medium text-[#6B7280] mb-1">
                {field.label}
                {field.optional && <span className="ml-1 font-normal text-gray-400">(optional)</span>}
              </label>
              <div className="relative">
                <input
                  type={field.type === 'password' && !visibleFields.has(field.key) ? 'password' : 'text'}
                  placeholder={field.placeholder}
                  value={formData[field.key] || ''}
                  onChange={(e) => setFormData(prev => ({ ...prev, [field.key]: e.target.value }))}
                  autoComplete="off"
                  className="w-full px-3 py-2 border border-[#DDD6FE] rounded-lg text-sm outline-none focus:ring-2 focus:ring-[#7C3AED]/20 focus:border-[#7C3AED] pr-10"
                />
                {field.type === 'password' && (
                  <button
                    type="button"
                    onClick={() => toggleVisibility(field.key)}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-[#7C3AED] transition-colors"
                  >
                    {visibleFields.has(field.key) ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                )}
              </div>
              {field.hint && <p className="mt-1 text-[11px] text-gray-400">{field.hint}</p>}
            </div>
          ))}
        </div>

        {testResult && (
          <div className={`mt-4 flex items-center gap-2 p-3 rounded-lg text-xs border ${testResult.ok ? 'bg-emerald-50 border-emerald-200 text-emerald-700' : 'bg-red-50 border-red-200 text-red-600'}`}>
            {testResult.ok ? <CheckCircle className="w-4 h-4 flex-shrink-0" /> : <AlertCircle className="w-4 h-4 flex-shrink-0" />}
            {testResult.message}
          </div>
        )}

        <div className="flex justify-end gap-3 mt-6">
          <button onClick={onClose} className="px-4 py-2 text-sm text-[#6B7280] hover:bg-gray-100 rounded-lg transition-colors">
            Cancel
          </button>
          {onTest && (
            <button
              onClick={handleTest}
              disabled={testing || saving}
              className="flex items-center gap-2 px-4 py-2 border border-[#7C3AED] text-[#7C3AED] rounded-lg text-sm font-medium hover:bg-[#F5F3FF] transition-all disabled:opacity-50"
            >
              {testing ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
              {testing ? 'Testing…' : testLabel}
            </button>
          )}
          <button
            onClick={() => onSave(formData)}
            disabled={saving}
            className="flex items-center gap-2 px-4 py-2 bg-gradient-to-r from-[#7C3AED] to-[#6366F1] text-white rounded-lg text-sm font-medium hover:from-[#6D28D9] hover:to-[#4F46E5] shadow-md shadow-purple-500/20 transition-all disabled:opacity-50"
          >
            {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plug className="w-4 h-4" />}
            {saving ? 'Connecting...' : 'Connect'}
          </button>
        </div>
      </div>
    </div>
  );
}
