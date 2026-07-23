import { useEffect, useMemo, useState } from 'react';
import { ToggleRight, Save, RotateCcw, ShieldCheck, Loader2, Layers } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useFeatureToggles, type FeatureMap } from '@/contexts/FeatureToggleContext';
import { updateFeatureToggles } from '@/services/api';
import { useToast } from '@/components/feedback/ToastProvider';
import { ROLES, groupedFeatures, FEATURE_CATALOG } from '@/config/featureCatalog';
import FeatureUnavailable from '@/components/FeatureUnavailable';

/**
 * A feature counts as ON when it is enabled for every role (missing entries
 * mean "enabled"). The dashboard exposes ONE workspace-wide switch per feature;
 * toggling writes the same value to all roles, so the stored per-role map and
 * everything that consumes it (sidebar gating, route guards) stay unchanged.
 */
function isFeatureOn(map: FeatureMap, key: string): boolean {
  return ROLES.every((r) => {
    const v = map[key]?.[r.key];
    return v === undefined ? true : v;
  });
}

function Switch({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: () => void;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={onChange}
      className={`relative inline-flex h-6 w-11 flex-shrink-0 items-center rounded-full transition-colors duration-200 focus:outline-none focus:ring-2 focus:ring-[#7C3AED] focus:ring-offset-1 ${
        checked ? 'bg-gradient-to-r from-[#7C3AED] to-[#6366F1]' : 'bg-gray-300'
      }`}
    >
      <span
        className={`inline-block h-5 w-5 transform rounded-full bg-white shadow transition-transform duration-200 ${
          checked ? 'translate-x-5' : 'translate-x-0.5'
        }`}
      />
    </button>
  );
}

export default function FeatureTogglesPage() {
  const { user } = useAuth();
  const { features, refresh } = useFeatureToggles();
  const toast = useToast();

  // Editable draft, seeded from the server map. Missing entries mean "enabled".
  const [draft, setDraft] = useState<FeatureMap>(() => structuredCloneMap(features));
  const [saving, setSaving] = useState(false);

  const dirty = useMemo(() => !sameMap(draft, features), [draft, features]);
  const groups = useMemo(() => groupedFeatures(), []);
  const enabledCount = useMemo(
    () => FEATURE_CATALOG.filter((f) => isFeatureOn(draft, f.key)).length,
    [draft],
  );
  const allOn = enabledCount === FEATURE_CATALOG.length;

  // Re-seed the draft when the server map arrives/changes (e.g. the initial
  // fetch resolves after this page mounts, or after a save+refresh). Only
  // reseed when the draft still matches the old server state, so in-progress
  // edits are never clobbered.
  useEffect(() => {
    setDraft((prev) => (sameMap(prev, features) ? prev : structuredCloneMap(features)));
  }, [features]);

  // If a non-admin reaches this page directly, guard defensively.
  // (Declared after all hooks to respect the Rules of Hooks.)
  if (user?.role !== 'admin') {
    return <FeatureUnavailable name="Feature Toggles" />;
  }

  /** Flip one feature for the whole workspace (all roles at once). */
  const toggleFeature = (key: string) => {
    setDraft((prev) => {
      const value = !isFeatureOn(prev, key);
      const next: FeatureMap = { ...prev, [key]: { ...(prev[key] || {}) } };
      for (const r of ROLES) next[key][r.key] = value;
      return next;
    });
  };

  /** Master switch: turn every IntelliQE feature on or off in one click. */
  const setAll = (value: boolean) => {
    setDraft((prev) => {
      const next: FeatureMap = { ...prev };
      for (const f of FEATURE_CATALOG) {
        next[f.key] = { ...(next[f.key] || {}) };
        for (const r of ROLES) next[f.key][r.key] = value;
      }
      return next;
    });
  };

  const reset = () => setDraft(structuredCloneMap(features));

  const save = async () => {
    setSaving(true);
    try {
      // Persist explicit booleans for every catalog feature × role so the
      // saved map is complete and unambiguous.
      const payload: Record<string, Record<string, boolean>> = {};
      for (const f of FEATURE_CATALOG) {
        const value = isFeatureOn(draft, f.key);
        payload[f.key] = {};
        for (const r of ROLES) payload[f.key][r.key] = value;
      }
      await updateFeatureToggles(payload);
      await refresh();
      toast.success('Feature toggles saved', 'Changes apply the next time each page loads.');
    } catch (err: any) {
      toast.error('Failed to save', err?.response?.data?.error || 'Please try again.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="max-w-3xl mx-auto">
      {/* Header */}
      <div className="flex items-start justify-between gap-4 mb-6">
        <div className="flex items-start gap-3">
          <div className="mt-0.5 flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br from-[#7C3AED] to-[#6366F1] shadow-lg shadow-purple-900/20">
            <ToggleRight className="h-5 w-5 text-white" />
          </div>
          <div>
            <h1 className="text-xl font-semibold text-gray-900">Feature Toggles</h1>
            <p className="text-sm text-gray-500 mt-0.5">
              Turn IntelliQE features on or off for your workspace. Disabled
              features are hidden from navigation and pages.
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={reset}
            disabled={!dirty || saving}
            className="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm font-medium text-gray-600 hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <RotateCcw className="h-4 w-4" /> Reset
          </button>
          <button
            onClick={save}
            disabled={!dirty || saving}
            className="inline-flex items-center gap-1.5 rounded-lg bg-gradient-to-r from-[#7C3AED] to-[#6366F1] px-4 py-2 text-sm font-medium text-white shadow-sm hover:opacity-95 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
            {saving ? 'Saving…' : 'Save changes'}
          </button>
        </div>
      </div>

      {/* Master switch — all of IntelliQE in one toggle */}
      <div className="mb-4 flex items-center justify-between gap-4 rounded-2xl border border-purple-100 bg-white px-5 py-4 shadow-sm">
        <div className="flex items-center gap-3 min-w-0">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-[#F5F3FF]">
            <Layers className="h-4.5 w-4.5 text-[#7C3AED]" />
          </div>
          <div className="min-w-0">
            <div className="font-semibold text-gray-900">All features</div>
            <div className="text-xs text-gray-500 mt-0.5">
              {enabledCount} of {FEATURE_CATALOG.length} features enabled
            </div>
          </div>
        </div>
        <Switch checked={allOn} onChange={() => setAll(!allOn)} label="All IntelliQE features" />
      </div>

      {/* Feature list */}
      <div className="rounded-2xl border border-purple-100 bg-white shadow-sm divide-y divide-gray-50">
        {groups.map(({ group, features: feats }) => (
          <div key={group} className="px-5 py-4">
            <div className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-[#7C3AED]/70">
              {group}
            </div>
            {feats.map((f) => (
              <div
                key={f.key}
                className="flex items-center justify-between gap-4 py-3 border-t border-gray-50 first-of-type:border-t-0"
              >
                <div className="min-w-0">
                  <div className="font-medium text-gray-900">{f.name}</div>
                  <div className="text-xs text-gray-500 mt-0.5">{f.description}</div>
                </div>
                <Switch
                  checked={isFeatureOn(draft, f.key)}
                  onChange={() => toggleFeature(f.key)}
                  label={f.name}
                />
              </div>
            ))}
          </div>
        ))}
      </div>

      <div className="mt-4 flex items-center gap-2 text-xs text-gray-400">
        <ShieldCheck className="h-3.5 w-3.5" />
        <span>
          Toggles apply to the whole workspace and are enforced in the UI. The
          Feature Toggles dashboard itself can't be disabled, so admins never
          get locked out.
        </span>
      </div>
    </div>
  );
}

// ── helpers ────────────────────────────────────────────────────────────────

function structuredCloneMap(map: FeatureMap): FeatureMap {
  const out: FeatureMap = {};
  for (const [k, roles] of Object.entries(map)) out[k] = { ...roles };
  return out;
}

/** Compare two maps by the effective workspace-wide value of every feature. */
function sameMap(a: FeatureMap, b: FeatureMap): boolean {
  for (const f of FEATURE_CATALOG) {
    if (isFeatureOn(a, f.key) !== isFeatureOn(b, f.key)) return false;
  }
  return true;
}
