import { useEffect, useMemo, useState } from 'react';
import { ToggleRight, Save, RotateCcw, ShieldCheck, Loader2 } from 'lucide-react';
import { useAuth, type UserRole } from '@/contexts/AuthContext';
import { useFeatureToggles, type FeatureMap } from '@/contexts/FeatureToggleContext';
import { updateFeatureToggles } from '@/services/api';
import { useToast } from '@/components/feedback/ToastProvider';
import { ROLES, groupedFeatures, FEATURE_CATALOG } from '@/config/featureCatalog';
import FeatureUnavailable from '@/components/FeatureUnavailable';

/** A feature is enabled unless it is explicitly set to false. */
function isOn(map: FeatureMap, key: string, role: UserRole): boolean {
  const v = map[key]?.[role];
  return v === undefined ? true : v;
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

  const toggle = (key: string, role: UserRole) => {
    setDraft((prev) => {
      const next: FeatureMap = { ...prev, [key]: { ...(prev[key] || {}) } };
      const current = isOn(prev, key, role);
      next[key][role] = !current;
      return next;
    });
  };

  const setColumn = (role: UserRole, value: boolean) => {
    setDraft((prev) => {
      const next: FeatureMap = { ...prev };
      for (const f of FEATURE_CATALOG) {
        next[f.key] = { ...(next[f.key] || {}), [role]: value };
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
        payload[f.key] = {};
        for (const r of ROLES) {
          payload[f.key][r.key] = isOn(draft, f.key, r.key);
        }
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
    <div className="max-w-5xl mx-auto">
      {/* Header */}
      <div className="flex items-start justify-between gap-4 mb-6">
        <div className="flex items-start gap-3">
          <div className="mt-0.5 flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br from-[#7C3AED] to-[#6366F1] shadow-lg shadow-purple-900/20">
            <ToggleRight className="h-5 w-5 text-white" />
          </div>
          <div>
            <h1 className="text-xl font-semibold text-gray-900">Feature Toggles</h1>
            <p className="text-sm text-gray-500 mt-0.5">
              Enable or disable features per role for your workspace. Disabled
              features are hidden from that role's navigation and pages.
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

      {/* Table */}
      <div className="overflow-x-auto rounded-2xl border border-purple-100 bg-white shadow-sm">
        <table className="w-full min-w-[640px] text-sm">
          <thead>
            <tr className="border-b border-gray-100 bg-[#F5F3FF]/60">
              <th className="px-5 py-3 text-left font-semibold text-gray-700">Feature</th>
              {ROLES.map((r) => (
                <th key={r.key} className="px-4 py-3 text-center font-semibold text-gray-700 w-40">
                  <div className="flex flex-col items-center gap-1.5">
                    <span>{r.label}</span>
                    <div className="flex items-center gap-1 text-[10px] font-normal text-gray-400">
                      <button
                        onClick={() => setColumn(r.key, true)}
                        className="hover:text-[#7C3AED] hover:underline"
                      >
                        All on
                      </button>
                      <span>·</span>
                      <button
                        onClick={() => setColumn(r.key, false)}
                        className="hover:text-[#7C3AED] hover:underline"
                      >
                        All off
                      </button>
                    </div>
                  </div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {groups.map(({ group, features: feats }) => (
              <FeatureGroup
                key={group}
                group={group}
                feats={feats}
                draft={draft}
                onToggle={toggle}
              />
            ))}
          </tbody>
        </table>
      </div>

      <div className="mt-4 flex items-center gap-2 text-xs text-gray-400">
        <ShieldCheck className="h-3.5 w-3.5" />
        <span>
          Toggles are stored per workspace and enforced in the UI. The Feature
          Toggles dashboard itself can't be disabled, so admins never get locked out.
        </span>
      </div>
    </div>
  );
}

function FeatureGroup({
  group,
  feats,
  draft,
  onToggle,
}: {
  group: string;
  feats: ReturnType<typeof groupedFeatures>[number]['features'];
  draft: FeatureMap;
  onToggle: (key: string, role: UserRole) => void;
}) {
  return (
    <>
      <tr>
        <td
          colSpan={1 + ROLES.length}
          className="px-5 pt-5 pb-1 text-[11px] font-semibold uppercase tracking-wider text-[#7C3AED]/70"
        >
          {group}
        </td>
      </tr>
      {feats.map((f) => (
        <tr key={f.key} className="border-t border-gray-50 hover:bg-[#F5F3FF]/40">
          <td className="px-5 py-3.5">
            <div className="font-medium text-gray-900">{f.name}</div>
            <div className="text-xs text-gray-500 mt-0.5">{f.description}</div>
          </td>
          {ROLES.map((r) => (
            <td key={r.key} className="px-4 py-3.5 text-center">
              <div className="flex justify-center">
                <Switch
                  checked={isOn(draft, f.key, r.key)}
                  onChange={() => onToggle(f.key, r.key)}
                  label={`${f.name} for ${r.label}`}
                />
              </div>
            </td>
          ))}
        </tr>
      ))}
    </>
  );
}

// ── helpers ────────────────────────────────────────────────────────────────

function structuredCloneMap(map: FeatureMap): FeatureMap {
  const out: FeatureMap = {};
  for (const [k, roles] of Object.entries(map)) out[k] = { ...roles };
  return out;
}

/** Compare two maps by the effective (enabled) value of every catalog cell. */
function sameMap(a: FeatureMap, b: FeatureMap): boolean {
  for (const f of FEATURE_CATALOG) {
    for (const r of ROLES) {
      if (isOn(a, f.key, r.key) !== isOn(b, f.key, r.key)) return false;
    }
  }
  return true;
}
