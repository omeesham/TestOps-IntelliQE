import { useState, useEffect } from 'react';
import { CheckCircle, Loader2 } from 'lucide-react';
import { connectIntegration, getConfigurations } from '@/services/api';

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

interface FormData {
  defaultEnvironment: string;
  defaultBrowser: string;
  maxParallelWorkers: number;
  testTimeoutMs: number;
}

const INPUT_CLASS =
  'w-full px-3 py-2.5 rounded-xl border border-[#C9DCFF] bg-[#EFF5FF] text-sm outline-none focus:ring-2 focus:ring-[#155dfc]/20 focus:border-[#155dfc] transition-all';

export default function GeneralSettingsSection({ configs }: Props) {
  const [formData, setFormData] = useState<FormData>({
    defaultEnvironment: 'staging',
    defaultBrowser: 'chromium',
    maxParallelWorkers: 10,
    testTimeoutMs: 30000,
  });
  const [saving, setSaving] = useState(false);
  const [showSuccess, setShowSuccess] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // On mount: populate form from existing config
  useEffect(() => {
    const existing = configs.find((c) => c.integrationId === 'general-settings');
    if (existing?.configData) {
      const d = existing.configData;
      setFormData({
        defaultEnvironment: d.defaultEnvironment || 'staging',
        defaultBrowser: d.defaultBrowser || 'chromium',
        maxParallelWorkers: d.maxParallelWorkers ?? 10,
        testTimeoutMs: d.testTimeoutMs ?? 30000,
      });
    }
  }, [configs]);

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    setShowSuccess(false);
    try {
      await connectIntegration('general-settings', {
        defaultEnvironment: formData.defaultEnvironment,
        defaultBrowser: formData.defaultBrowser,
        maxParallelWorkers: formData.maxParallelWorkers,
        testTimeoutMs: formData.testTimeoutMs,
      });
      setShowSuccess(true);
      setTimeout(() => setShowSuccess(false), 3000);
    } catch (err: any) {
      setError(err?.response?.data?.error || err?.message || 'Failed to save settings');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="bg-white/80 backdrop-blur-sm rounded-xl border border-[#C9DCFF]/60 p-6 space-y-6">
      <div>
        <h3 className="text-sm font-semibold text-[#1E1B4B] mb-1">General Settings</h3>
        <p className="text-xs text-[#6B7280]">Configure default execution parameters for your test pipeline</p>
      </div>

      {error && (
        <div className="p-3 bg-red-50 border border-red-200/60 rounded-lg text-xs text-red-600">
          {error}
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* Default Environment */}
        <div>
          <label className="block text-sm font-medium text-[#1E1B4B] mb-1">Default Environment</label>
          <select
            value={formData.defaultEnvironment}
            onChange={(e) => setFormData((prev) => ({ ...prev, defaultEnvironment: e.target.value }))}
            className={INPUT_CLASS}
          >
            <option value="dev">Development</option>
            <option value="qa">QA</option>
            <option value="staging">Staging</option>
            <option value="prod">Production</option>
          </select>
        </div>

        {/* Default Browser */}
        <div>
          <label className="block text-sm font-medium text-[#1E1B4B] mb-1">Default Browser</label>
          <select
            value={formData.defaultBrowser}
            onChange={(e) => setFormData((prev) => ({ ...prev, defaultBrowser: e.target.value }))}
            className={INPUT_CLASS}
          >
            <option value="chromium">Chromium</option>
            <option value="firefox">Firefox</option>
            <option value="webkit">WebKit</option>
          </select>
        </div>

        {/* Max Parallel Workers */}
        <div>
          <label className="block text-sm font-medium text-[#1E1B4B] mb-1">Max Parallel Workers</label>
          <input
            type="number"
            min={1}
            max={100}
            value={formData.maxParallelWorkers}
            onChange={(e) =>
              setFormData((prev) => ({ ...prev, maxParallelWorkers: parseInt(e.target.value, 10) || 1 }))
            }
            className={INPUT_CLASS}
          />
        </div>

        {/* Test Timeout */}
        <div>
          <label className="block text-sm font-medium text-[#1E1B4B] mb-1">Test Timeout (ms)</label>
          <input
            type="number"
            min={1000}
            step={1000}
            value={formData.testTimeoutMs}
            onChange={(e) =>
              setFormData((prev) => ({ ...prev, testTimeoutMs: parseInt(e.target.value, 10) || 30000 }))
            }
            className={INPUT_CLASS}
          />
        </div>
      </div>

      {/* Save row */}
      <div className="flex items-center justify-end gap-3 pt-2">
        {showSuccess && (
          <span className="flex items-center gap-1.5 text-xs text-emerald-600 font-medium">
            <CheckCircle className="w-4 h-4" /> Settings saved
          </span>
        )}
        <button
          onClick={handleSave}
          disabled={saving}
          className="px-6 py-2.5 bg-[#155dfc] text-white rounded-lg text-sm font-medium hover:bg-[#124fd6] shadow-md shadow-blue-500/20 transition-all disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
        >
          {saving && <Loader2 className="w-4 h-4 animate-spin" />}
          {saving ? 'Saving...' : 'Save Settings'}
        </button>
      </div>
    </div>
  );
}
