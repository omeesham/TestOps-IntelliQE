import { useState, useMemo } from 'react';
import { Plus, Trash2, Eye, EyeOff, Save, Loader2, X } from 'lucide-react';
import { connectIntegration, disconnectIntegration } from '@/services/api';
import { encryptSensitiveFields } from '@/utils/crypto';
import TestFilesSection from './TestFilesSection';

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

interface Role {
  roleName: string;
  username: string;
  password: string;
  /** Local key for the row (not saved). */
  key: string;
}

interface Environment {
  id: string;
  name: string;
  baseUrl: string;
  roles: Role[];
}

interface AppFormData {
  appName: string;
  environments: Environment[];
}

const INPUT_CLASS =
  'w-full px-3 py-2.5 rounded-xl border border-[#C5D6FF] bg-[#EEF4FF] text-sm outline-none focus:ring-2 focus:ring-[#3366FF]/20 focus:border-[#3366FF] transition-all';

const ENV_PRESETS = ['QA', 'UAT', 'Staging', 'Development', 'Production'];

function slugify(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '');
}

const newKey = () => Math.random().toString(36).slice(2, 10);
const newEnvironment = (name: string): Environment => ({ id: `env-${newKey()}`, name, baseUrl: '', roles: [] });

type Raw = Record<string, unknown>;
const str = (v: unknown) => (typeof v === 'string' ? v : '');

function toRoles(v: unknown): Role[] {
  return Array.isArray(v)
    ? v.filter((r): r is Raw => !!r && typeof r === 'object')
      .map((r) => ({ roleName: str(r.roleName), username: str(r.username), password: str(r.password), key: newKey() }))
    : [];
}

/** Environments of a saved app; apps saved before environments read as one "Default" environment. */
function environmentsFromConfig(d: Raw): Environment[] {
  if (Array.isArray(d.environments) && d.environments.length > 0) {
    return (d.environments as Raw[]).map((e, i) => ({
      id: String(e.id || `env-${i + 1}`),
      name: String(e.name || `Environment ${i + 1}`),
      baseUrl: String(e.baseUrl || ''),
      roles: toRoles(e.roles),
    }));
  }
  return [{ id: 'default', name: str(d.environment) || 'Default', baseUrl: str(d.baseUrl), roles: toRoles(d.roles) }];
}

const EMPTY_FORM = (): AppFormData => ({ appName: '', environments: [newEnvironment('QA')] });

export default function ApplicationSetupSection({ configs, onRefresh }: Props) {
  const [selectedAppId, setSelectedAppId] = useState<string | null>(null);
  const [formData, setFormData] = useState<AppFormData>(EMPTY_FORM);
  const [activeEnv, setActiveEnv] = useState(0);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [visiblePasswords, setVisiblePasswords] = useState<Set<string>>(new Set());
  const [isNewApp, setIsNewApp] = useState(false);

  // Filter app configs
  const appConfigs = useMemo(
    () => configs.filter((c) => c.integrationId.startsWith('app-')),
    [configs],
  );

  const selectApp = (cfg: DbConfig) => {
    setSelectedAppId(cfg.integrationId);
    setIsNewApp(false);
    setError(null);
    setVisiblePasswords(new Set());
    setActiveEnv(0);
    const d = cfg.configData || {};
    setFormData({ appName: d.appName || '', environments: environmentsFromConfig(d) });
  };

  const startNewApp = () => {
    setSelectedAppId(null);
    setIsNewApp(true);
    setError(null);
    setVisiblePasswords(new Set());
    setActiveEnv(0);
    setFormData(EMPTY_FORM());
  };

  // Environment management
  const env = formData.environments[activeEnv];
  const updateEnv = (patch: Partial<Environment>) => {
    setFormData((prev) => ({
      ...prev,
      environments: prev.environments.map((e, i) => (i === activeEnv ? { ...e, ...patch } : e)),
    }));
  };
  const addEnvironment = () => {
    const used = new Set(formData.environments.map((e) => e.name.toLowerCase()));
    const name = ENV_PRESETS.find((p) => !used.has(p.toLowerCase())) || `Environment ${formData.environments.length + 1}`;
    setFormData((prev) => ({ ...prev, environments: [...prev.environments, newEnvironment(name)] }));
    setActiveEnv(formData.environments.length);
  };
  const removeEnvironment = (index: number) => {
    if (formData.environments.length <= 1) return;
    setFormData((prev) => ({ ...prev, environments: prev.environments.filter((_, i) => i !== index) }));
    setActiveEnv((cur) => Math.max(0, cur >= index ? cur - 1 : cur));
  };

  // Role management (active environment)
  const addRole = () => updateEnv({ roles: [...env.roles, { roleName: '', username: '', password: '', key: newKey() }] });
  const updateRole = (key: string, field: 'roleName' | 'username' | 'password', value: string) =>
    updateEnv({ roles: env.roles.map((r) => (r.key === key ? { ...r, [field]: value } : r)) });
  const removeRole = (key: string) => updateEnv({ roles: env.roles.filter((r) => r.key !== key) });
  const togglePasswordVisibility = (key: string) => {
    setVisiblePasswords((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  };

  const validate = (integrationId: string): string | null => {
    if (!formData.appName.trim()) return 'Application name is required';
    if (!integrationId.slice(4)) return 'Application name must contain at least one letter or digit';
    if (isNewApp && appConfigs.some((c) => c.integrationId === integrationId)) {
      return `An application named "${formData.appName.trim()}" already exists. Open it and add an environment instead.`;
    }
    const names = new Set<string>();
    for (const e of formData.environments) {
      const name = e.name.trim();
      if (!name) return 'Every environment needs a name';
      if (names.has(name.toLowerCase())) return `Two environments are named "${name}"`;
      names.add(name.toLowerCase());
      if (!e.baseUrl.trim()) return `Environment "${name}" needs a URL`;
    }
    return null;
  };

  // Save
  const handleSave = async () => {
    // Editing keeps the application's id, so renaming never creates a second app.
    const integrationId = selectedAppId && !isNewApp ? selectedAppId : `app-${slugify(formData.appName)}`;
    const problem = validate(integrationId);
    if (problem) {
      setError(problem);
      return;
    }

    setSaving(true);
    setError(null);
    try {
      // Encrypt sensitive role passwords before sending; a saved password comes
      // back masked and is kept by the server.
      const environments = formData.environments.map((e) => ({
        id: e.id,
        name: e.name.trim(),
        baseUrl: e.baseUrl.trim(),
        roles: e.roles.map(({ roleName, username, password }) => encryptSensitiveFields({ roleName, username, password })),
      }));
      const first = environments[0];
      await connectIntegration(integrationId, {
        appName: formData.appName.trim(),
        environments,
        // Mirror of the first environment, for readers of the single-URL format.
        baseUrl: first.baseUrl,
        environment: first.name,
        roles: first.roles,
      });

      setSelectedAppId(integrationId);
      setIsNewApp(false);
      onRefresh();
    } catch (err: any) {
      setError(err?.response?.data?.error || err?.message || 'Failed to save application');
    } finally {
      setSaving(false);
    }
  };

  // Delete
  const handleDelete = async (integrationId: string, appName: string) => {
    if (!window.confirm(`Delete "${appName}" and all its environments?`)) return;
    try {
      await disconnectIntegration(integrationId);
      if (selectedAppId === integrationId) {
        setSelectedAppId(null);
        setIsNewApp(false);
        setFormData(EMPTY_FORM());
      }
      onRefresh();
    } catch (err: any) {
      setError(err?.response?.data?.error || err?.message || 'Failed to delete application');
    }
  };

  const showForm = isNewApp || selectedAppId !== null;

  return (
    <div className="bg-white/80 backdrop-blur-sm rounded-xl border border-[#C5D6FF]/60 p-6">
      <div className="mb-4">
        <h3 className="text-sm font-semibold text-[#1E3A8A] mb-1">Applications Under Test</h3>
        <p className="text-xs text-[#6B7280]">
          Manage your applications, their environments (QA, UAT…) and the test users for each
        </p>
      </div>

      {error && (
        <div className="mb-4 p-3 bg-red-50 border border-red-200/60 rounded-lg text-xs text-red-600" role="alert">
          {error}
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Left: App list */}
        <div className="space-y-3">
          <button
            onClick={startNewApp}
            className="w-full flex items-center justify-center gap-2 px-4 py-2.5 bg-gradient-to-r from-[#3366FF] to-[#2645D6] text-white rounded-lg text-sm font-medium hover:from-[#2A55D6] hover:to-[#2645D6] shadow-md shadow-purple-500/20 transition-all"
          >
            <Plus className="w-4 h-4" />
            Add Application
          </button>

          {appConfigs.length === 0 && !isNewApp ? (
            <div className="p-4 bg-[#EEF4FF] border border-[#C5D6FF]/60 rounded-xl text-center">
              <p className="text-xs text-[#6B7280]">
                No applications configured. Add your first application to get started.
              </p>
            </div>
          ) : (
            appConfigs.map((cfg) => {
              const d = cfg.configData || {};
              const envs = environmentsFromConfig(d);
              const isSelected = cfg.integrationId === selectedAppId;
              return (
                <div
                  key={cfg.integrationId}
                  className={`p-3 rounded-xl border cursor-pointer transition-all ${
                    isSelected
                      ? 'border-[#3366FF] bg-[#EEF4FF] shadow-sm'
                      : 'border-[#C5D6FF]/60 bg-white hover:border-[#3366FF]/40'
                  }`}
                  onClick={() => selectApp(cfg)}
                >
                  <div className="flex items-center justify-between">
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-[#1E3A8A] truncate">{d.appName || cfg.integrationId}</p>
                      <p className="text-xs text-[#6B7280] truncate">{envs[0]?.baseUrl || 'No URL set'}</p>
                    </div>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        handleDelete(cfg.integrationId, d.appName || cfg.integrationId);
                      }}
                      className="p-1.5 text-gray-400 hover:text-red-500 hover:bg-red-50 rounded-lg transition-colors flex-shrink-0"
                      title="Delete application"
                      aria-label={`Delete ${d.appName || cfg.integrationId}`}
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                  <div className="flex flex-wrap gap-1 mt-1.5">
                    {envs.map((e) => (
                      <span key={e.id} className="inline-block px-2 py-0.5 bg-[#DCE7FF] text-[#2143A8] text-[10px] font-medium rounded-full">
                        {e.name}
                      </span>
                    ))}
                  </div>
                </div>
              );
            })
          )}
        </div>

        {/* Right: Form */}
        <div className="lg:col-span-2">
          {showForm && env ? (
            <div className="space-y-4">
              {/* App Name */}
              <div>
                <label htmlFor="app-name" className="block text-sm font-medium text-[#1E3A8A] mb-1">App Name</label>
                <input
                  id="app-name"
                  type="text"
                  value={formData.appName}
                  onChange={(e) => setFormData((prev) => ({ ...prev, appName: e.target.value }))}
                  placeholder="e.g. My Web App"
                  className={INPUT_CLASS}
                />
              </div>

              {/* Environment tabs */}
              <div>
                <p className="text-sm font-medium text-[#1E3A8A] mb-1.5">Environments</p>
                <div className="flex flex-wrap items-center gap-1.5" role="tablist" aria-label="Environments">
                  {formData.environments.map((e, i) => (
                    <span
                      key={e.id}
                      className={`inline-flex items-center gap-1 rounded-lg border text-xs font-medium ${
                        i === activeEnv ? 'border-[#3366FF] bg-[#EEF4FF] text-[#1E3A8A]' : 'border-[#C5D6FF]/60 bg-white text-[#6B7280]'
                      }`}
                    >
                      <button type="button" role="tab" aria-selected={i === activeEnv} onClick={() => setActiveEnv(i)} className="px-2.5 py-1.5">
                        {e.name || 'Unnamed'}
                      </button>
                      {formData.environments.length > 1 && (
                        <button
                          type="button"
                          onClick={() => removeEnvironment(i)}
                          className="pr-2 text-gray-400 hover:text-red-500"
                          aria-label={`Remove environment ${e.name || 'Unnamed'}`}
                          title="Remove environment"
                        >
                          <X className="w-3 h-3" />
                        </button>
                      )}
                    </span>
                  ))}
                  <button
                    type="button"
                    onClick={addEnvironment}
                    className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium text-[#2143A8] bg-[#EEF4FF] hover:bg-[#DCE7FF] rounded-lg border border-[#C5D6FF]/60 transition-colors"
                  >
                    <Plus className="w-3.5 h-3.5" />
                    Add environment
                  </button>
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <label htmlFor="env-name" className="block text-sm font-medium text-[#1E3A8A] mb-1">Environment name</label>
                  <input
                    id="env-name"
                    type="text"
                    list="env-presets"
                    value={env.name}
                    onChange={(e) => updateEnv({ name: e.target.value })}
                    placeholder="e.g. QA"
                    className={INPUT_CLASS}
                  />
                  <datalist id="env-presets">
                    {ENV_PRESETS.map((p) => <option key={p} value={p} />)}
                  </datalist>
                </div>
                <div>
                  <label htmlFor="env-url" className="block text-sm font-medium text-[#1E3A8A] mb-1">Base URL</label>
                  <input
                    id="env-url"
                    type="text"
                    value={env.baseUrl}
                    onChange={(e) => updateEnv({ baseUrl: e.target.value })}
                    placeholder="https://qa.app.example.com"
                    className={INPUT_CLASS}
                  />
                </div>
              </div>

              {/* Roles Section */}
              <div className="border-t border-[#DCE7FF] pt-4">
                <div className="flex items-center justify-between mb-3">
                  <p className="text-sm font-medium text-[#1E3A8A]">Test users for {env.name || 'this environment'}</p>
                  <button
                    onClick={addRole}
                    className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-[#2143A8] bg-[#EEF4FF] hover:bg-[#DCE7FF] rounded-lg border border-[#C5D6FF]/60 transition-colors"
                  >
                    <Plus className="w-3.5 h-3.5" />
                    Add Role
                  </button>
                </div>

                {env.roles.length === 0 ? (
                  <p className="text-xs text-[#6B7280] text-center py-3">
                    No roles defined. Add a role to configure test user credentials.
                  </p>
                ) : (
                  <div className="space-y-3">
                    {env.roles.map((role) => (
                      <div
                        key={role.key}
                        className="p-3 bg-[#EEF4FF]/50 border border-[#C5D6FF]/40 rounded-xl"
                      >
                        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                          <div>
                            <label className="block text-xs font-medium text-[#6B7280] mb-1">Role Name</label>
                            <input
                              type="text"
                              value={role.roleName}
                              onChange={(e) => updateRole(role.key, 'roleName', e.target.value)}
                              placeholder="e.g. Admin"
                              className={INPUT_CLASS}
                            />
                          </div>
                          <div>
                            <label className="block text-xs font-medium text-[#6B7280] mb-1">Username</label>
                            <input
                              type="text"
                              value={role.username}
                              onChange={(e) => updateRole(role.key, 'username', e.target.value)}
                              placeholder="testuser@example.com"
                              className={INPUT_CLASS}
                            />
                          </div>
                          <div>
                            <label className="block text-xs font-medium text-[#6B7280] mb-1">Password</label>
                            <div className="flex gap-2">
                              <div className="relative flex-1">
                                <input
                                  type={visiblePasswords.has(role.key) ? 'text' : 'password'}
                                  value={role.password}
                                  onChange={(e) => updateRole(role.key, 'password', e.target.value)}
                                  onFocus={(e) => { if (role.password.includes('•')) e.target.select(); }}
                                  title={role.password.includes('•') ? 'Saved password. Type to replace it.' : undefined}
                                  placeholder="Password"
                                  autoComplete="off"
                                  className={`${INPUT_CLASS} pr-9`}
                                />
                                <button
                                  type="button"
                                  onClick={() => togglePasswordVisibility(role.key)}
                                  aria-label={visiblePasswords.has(role.key) ? 'Hide password' : 'Show password'}
                                  className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-[#2143A8] transition-colors"
                                >
                                  {visiblePasswords.has(role.key) ? (
                                    <EyeOff className="w-4 h-4" />
                                  ) : (
                                    <Eye className="w-4 h-4" />
                                  )}
                                </button>
                              </div>
                              <button
                                onClick={() => removeRole(role.key)}
                                className="p-2.5 text-gray-400 hover:text-red-500 hover:bg-red-50 rounded-xl border border-[#C5D6FF]/60 transition-colors flex-shrink-0"
                                title="Remove role"
                                aria-label="Remove role"
                              >
                                <Trash2 className="w-4 h-4" />
                              </button>
                            </div>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Test files: only for a saved application */}
              {selectedAppId && !isNewApp && <TestFilesSection appId={selectedAppId} />}

              {/* Save button */}
              <div className="flex justify-end pt-2">
                <button
                  onClick={handleSave}
                  disabled={saving}
                  className="flex items-center gap-2 px-6 py-2.5 bg-gradient-to-r from-[#3366FF] to-[#2645D6] text-white rounded-lg text-sm font-medium hover:from-[#2A55D6] hover:to-[#2645D6] shadow-md shadow-purple-500/20 transition-all disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
                  {saving ? 'Saving...' : 'Save Application'}
                </button>
              </div>
            </div>
          ) : (
            <div className="flex items-center justify-center h-full min-h-[200px]">
              <div className="text-center">
                <div className="w-12 h-12 bg-[#EEF4FF] rounded-xl flex items-center justify-center mx-auto mb-3 border border-[#C5D6FF]/60">
                  <Plus className="w-5 h-5 text-[#2143A8]" />
                </div>
                <p className="text-sm text-[#6B7280]">
                  Select an application from the list or add a new one
                </p>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
