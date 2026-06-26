/**
 * FeatureTogglesPage
 * ──────────────────
 * Self-service switchboard: enable/disable IntelliQE features for the whole
 * organization (per-tenant). Disabling a feature hides its sidebar entry, blocks
 * its route, and removes the corresponding chat option for everyone in the tenant.
 *
 * Additive & safe: the Feature Toggles screen itself can never be disabled.
 */
import { useMemo, useState } from 'react';
import { ToggleLeft, ToggleRight, Save, Loader2, CheckCircle, RotateCcw, AlertTriangle, ShieldCheck } from 'lucide-react';
import { FEATURE_CATALOG, ALL_FEATURE_KEYS } from '@/featureCatalog';
import { useFeatureFlags } from '@/contexts/FeatureFlagsContext';
import { saveFeatureFlags } from '@/services/api';

export default function FeatureTogglesPage() {
  const { flags, loaded, isEnabled, setFlags, reload } = useFeatureFlags();

  // Local working copy keyed by every known feature (explicit booleans).
  const initial = useMemo(
    () => Object.fromEntries(ALL_FEATURE_KEYS.map((k) => [k, isEnabled(k)])) as Record<string, boolean>,
    // Recompute when the loaded flags change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [flags, loaded],
  );
  const [pending, setPending] = useState<Record<string, boolean>>(initial);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');

  // Keep local copy in sync if the server flags load/refresh and there are no edits.
  const dirty = useMemo(() => ALL_FEATURE_KEYS.some((k) => (pending[k] ?? true) !== (initial[k] ?? true)), [pending, initial]);

  const resync = () => { setPending(initial); setError(''); setSaved(false); };

  const toggle = (key: string) => {
    setSaved(false);
    setPending((prev) => ({ ...prev, [key]: !(prev[key] ?? true) }));
  };

  const enabledCount = ALL_FEATURE_KEYS.filter((k) => pending[k] ?? true).length;

  const handleSave = async () => {
    setSaving(true);
    setError('');
    setSaved(false);
    try {
      const res = await saveFeatureFlags(pending);
      setFlags(res.flags || pending);
      setSaved(true);
    } catch (err: any) {
      setError(err?.response?.data?.error || err?.message || 'Failed to save feature toggles');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="max-w-4xl mx-auto">
      {/* Header */}
      <div className="flex items-start justify-between gap-4 mb-5">
        <div>
          <h1 className="text-xl font-bold text-[#1E3A8A] flex items-center gap-2">
            <ShieldCheck className="w-5 h-5 text-[#3366FF]" /> Feature Toggles
          </h1>
          <p className="text-sm text-[#6B7280] mt-1">
            Enable or disable IntelliQE features for your organization. Changes apply to <b>all users</b> in your
            tenant and take effect on their next page refresh.
          </p>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          <button
            onClick={() => { reload(); resync(); }}
            className="flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-[#2143A8] bg-[#EEF4FF] hover:bg-[#DCE7FF] rounded-lg border border-[#C5D6FF]/60 transition-colors"
            title="Reload from server"
          >
            <RotateCcw className="w-3.5 h-3.5" /> Reload
          </button>
          <button
            onClick={handleSave}
            disabled={saving || !dirty}
            className="flex items-center gap-2 px-5 py-2 bg-gradient-to-r from-[#3366FF] to-[#2645D6] text-white rounded-lg text-sm font-medium hover:from-[#2A55D6] hover:to-[#2645D6] shadow-md shadow-purple-500/20 transition-all disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
            {saving ? 'Saving…' : 'Save Changes'}
          </button>
        </div>
      </div>

      {/* Status row */}
      <div className="flex flex-wrap items-center gap-3 mb-4">
        <span className="text-xs font-medium text-[#6B7280]">
          {enabledCount} of {ALL_FEATURE_KEYS.length} features enabled
        </span>
        {saved && (
          <span className="inline-flex items-center gap-1 text-xs font-medium text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-full px-2.5 py-1">
            <CheckCircle className="w-3.5 h-3.5" /> Saved
          </span>
        )}
        {dirty && !saved && (
          <span className="text-xs font-medium text-amber-700 bg-amber-50 border border-amber-200 rounded-full px-2.5 py-1">Unsaved changes</span>
        )}
      </div>

      {error && (
        <div className="mb-4 flex items-center gap-2 p-3 bg-red-50 border border-red-200/60 rounded-lg text-xs text-red-600">
          <AlertTriangle className="w-4 h-4 flex-shrink-0" /> {error}
        </div>
      )}

      {!loaded ? (
        <div className="flex items-center gap-2 text-sm text-[#6B7280] p-8 justify-center">
          <Loader2 className="w-4 h-4 animate-spin text-[#3366FF]" /> Loading feature settings…
        </div>
      ) : (
        <div className="space-y-5">
          {FEATURE_CATALOG.map((grp) => (
            <div key={grp.group} className="bg-white/80 backdrop-blur-sm rounded-xl border border-[#C5D6FF]/60 p-5">
              <h3 className="text-sm font-semibold text-[#1E3A8A] mb-3">{grp.group}</h3>
              <div className="space-y-1.5">
                {grp.features.map((f) => {
                  const on = pending[f.key] ?? true;
                  return (
                    <div
                      key={f.key}
                      className="flex items-center justify-between gap-4 px-3 py-2.5 rounded-lg hover:bg-[#EEF4FF]/60 transition-colors"
                    >
                      <div className="min-w-0">
                        <p className="text-sm font-medium text-gray-800">{f.label}</p>
                        <p className="text-[11px] text-gray-400">{f.description}</p>
                      </div>
                      <button
                        onClick={() => toggle(f.key)}
                        role="switch"
                        aria-checked={on}
                        aria-label={`${on ? 'Disable' : 'Enable'} ${f.label}`}
                        className="flex-shrink-0 flex items-center gap-1.5"
                      >
                        <span className={`text-[10px] font-semibold uppercase tracking-wide ${on ? 'text-emerald-600' : 'text-gray-400'}`}>
                          {on ? 'On' : 'Off'}
                        </span>
                        {on
                          ? <ToggleRight className="w-9 h-9 text-[#3366FF]" />
                          : <ToggleLeft className="w-9 h-9 text-gray-300" />}
                      </button>
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
