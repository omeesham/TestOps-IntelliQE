import { useState, useMemo } from 'react';
import { Plus, Trash2, Eye, EyeOff, Save, Loader2 } from 'lucide-react';
import { connectIntegration, disconnectIntegration } from '@/services/api';
import { encryptSensitiveFields } from '@/utils/crypto';

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
}

interface AppFormData {
  appName: string;
  baseUrl: string;
  environment: string;
  roles: Role[];
}

const INPUT_CLASS =
  'w-full px-3 py-2.5 rounded-xl border border-[#DDD6FE] bg-[#F5F3FF] text-sm outline-none focus:ring-2 focus:ring-[#7C3AED]/20 focus:border-[#7C3AED] transition-all';

function slugify(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '');
}

const EMPTY_FORM: AppFormData = {
  appName: '',
  baseUrl: '',
  environment: 'staging',
  roles: [],
};

export default function ApplicationSetupSection({ configs, onRefresh }: Props) {
  const [selectedAppId, setSelectedAppId] = useState<string | null>(null);
  const [formData, setFormData] = useState<AppFormData>({ ...EMPTY_FORM });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [visiblePasswords, setVisiblePasswords] = useState<Set<number>>(new Set());
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
    const d = cfg.configData || {};
    setFormData({
      appName: d.appName || '',
      baseUrl: d.baseUrl || '',
      environment: d.environment || 'staging',
      roles: Array.isArray(d.roles) ? d.roles.map((r: any) => ({ ...r })) : [],
    });
  };

  const startNewApp = () => {
    setSelectedAppId(null);
    setIsNewApp(true);
    setError(null);
    setVisiblePasswords(new Set());
    setFormData({ ...EMPTY_FORM, roles: [] });
  };

  // Role management
  const addRole = () => {
    setFormData((prev) => ({
      ...prev,
      roles: [...prev.roles, { roleName: '', username: '', password: '' }],
    }));
  };

  const updateRole = (index: number, field: keyof Role, value: string) => {
    setFormData((prev) => {
      const roles = [...prev.roles];
      roles[index] = { ...roles[index], [field]: value };
      return { ...prev, roles };
    });
  };

  const removeRole = (index: number) => {
    setFormData((prev) => ({
      ...prev,
      roles: prev.roles.filter((_, i) => i !== index),
    }));
    setVisiblePasswords((prev) => {
      const next = new Set<number>();
      prev.forEach((i) => {
        if (i < index) next.add(i);
        else if (i > index) next.add(i - 1);
      });
      return next;
    });
  };

  const togglePasswordVisibility = (index: number) => {
    setVisiblePasswords((prev) => {
      const next = new Set(prev);
      next.has(index) ? next.delete(index) : next.add(index);
      return next;
    });
  };

  // Save
  const handleSave = async () => {
    if (!formData.appName.trim()) {
      setError('Application name is required');
      return;
    }
    if (!formData.baseUrl.trim()) {
      setError('Base URL is required');
      return;
    }

    setSaving(true);
    setError(null);
    try {
      const slug = slugify(formData.appName);
      if (!slug) {
        throw new Error('Application name must contain at least one alphanumeric character');
      }
      const integrationId = `app-${slug}`;

      // Encrypt sensitive role passwords before sending
      const encryptedRoles = formData.roles.map((r) => encryptSensitiveFields({ ...r }));

      await connectIntegration(integrationId, {
        appName: formData.appName.trim(),
        baseUrl: formData.baseUrl.trim(),
        environment: formData.environment,
        roles: encryptedRoles,
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
  const handleDelete = async (integrationId: string) => {
    try {
      await disconnectIntegration(integrationId);
      if (selectedAppId === integrationId) {
        setSelectedAppId(null);
        setIsNewApp(false);
        setFormData({ ...EMPTY_FORM });
      }
      onRefresh();
    } catch (err: any) {
      setError(err?.response?.data?.error || err?.message || 'Failed to delete application');
    }
  };

  const showForm = isNewApp || selectedAppId !== null;

  return (
    <div className="bg-white/80 backdrop-blur-sm rounded-xl border border-[#DDD6FE]/60 p-6">
      <div className="mb-4">
        <h3 className="text-sm font-semibold text-[#1E1B4B] mb-1">Applications Under Test</h3>
        <p className="text-xs text-[#6B7280]">
          Manage your applications, environments, and test user credentials
        </p>
      </div>

      {error && (
        <div className="mb-4 p-3 bg-red-50 border border-red-200/60 rounded-lg text-xs text-red-600">
          {error}
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Left: App list */}
        <div className="space-y-3">
          <button
            onClick={startNewApp}
            className="w-full flex items-center justify-center gap-2 px-4 py-2.5 bg-gradient-to-r from-[#7C3AED] to-[#6366F1] text-white rounded-lg text-sm font-medium hover:from-[#6D28D9] hover:to-[#4F46E5] shadow-md shadow-purple-500/20 transition-all"
          >
            <Plus className="w-4 h-4" />
            Add Application
          </button>

          {appConfigs.length === 0 && !isNewApp ? (
            <div className="p-4 bg-[#F5F3FF] border border-[#DDD6FE]/60 rounded-xl text-center">
              <p className="text-xs text-[#6B7280]">
                No applications configured. Add your first application to get started.
              </p>
            </div>
          ) : (
            appConfigs.map((cfg) => {
              const d = cfg.configData || {};
              const isSelected = cfg.integrationId === selectedAppId;
              return (
                <div
                  key={cfg.integrationId}
                  className={`p-3 rounded-xl border cursor-pointer transition-all ${
                    isSelected
                      ? 'border-[#7C3AED] bg-[#F5F3FF] shadow-sm'
                      : 'border-[#DDD6FE]/60 bg-white hover:border-[#7C3AED]/40'
                  }`}
                  onClick={() => selectApp(cfg)}
                >
                  <div className="flex items-center justify-between">
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-[#1E1B4B] truncate">{d.appName || cfg.integrationId}</p>
                      <p className="text-xs text-[#6B7280] truncate">{d.baseUrl || 'No URL set'}</p>
                    </div>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        handleDelete(cfg.integrationId);
                      }}
                      className="p-1.5 text-gray-400 hover:text-red-500 hover:bg-red-50 rounded-lg transition-colors flex-shrink-0"
                      title="Delete application"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                  {d.environment && (
                    <span className="inline-block mt-1.5 px-2 py-0.5 bg-[#EDE9FE] text-[#7C3AED] text-[10px] font-medium rounded-full">
                      {d.environment}
                    </span>
                  )}
                </div>
              );
            })
          )}
        </div>

        {/* Right: Form */}
        <div className="lg:col-span-2">
          {showForm ? (
            <div className="space-y-4">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {/* App Name */}
                <div>
                  <label className="block text-sm font-medium text-[#1E1B4B] mb-1">App Name</label>
                  <input
                    type="text"
                    value={formData.appName}
                    onChange={(e) => setFormData((prev) => ({ ...prev, appName: e.target.value }))}
                    placeholder="e.g. My Web App"
                    className={INPUT_CLASS}
                  />
                </div>

                {/* Base URL */}
                <div>
                  <label className="block text-sm font-medium text-[#1E1B4B] mb-1">Base URL</label>
                  <input
                    type="text"
                    value={formData.baseUrl}
                    onChange={(e) => setFormData((prev) => ({ ...prev, baseUrl: e.target.value }))}
                    placeholder="https://app.example.com"
                    className={INPUT_CLASS}
                  />
                </div>

                {/* Environment */}
                <div className="md:col-span-2">
                  <label className="block text-sm font-medium text-[#1E1B4B] mb-1">Environment</label>
                  <select
                    value={formData.environment}
                    onChange={(e) => setFormData((prev) => ({ ...prev, environment: e.target.value }))}
                    className={INPUT_CLASS}
                  >
                    <option value="dev">Development</option>
                    <option value="qa">QA</option>
                    <option value="staging">Staging</option>
                    <option value="prod">Production</option>
                  </select>
                </div>
              </div>

              {/* Roles Section */}
              <div className="border-t border-[#EDE9FE] pt-4">
                <div className="flex items-center justify-between mb-3">
                  <label className="text-sm font-medium text-[#1E1B4B]">Test User Roles</label>
                  <button
                    onClick={addRole}
                    className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-[#7C3AED] bg-[#F5F3FF] hover:bg-[#EDE9FE] rounded-lg border border-[#DDD6FE]/60 transition-colors"
                  >
                    <Plus className="w-3.5 h-3.5" />
                    Add Role
                  </button>
                </div>

                {formData.roles.length === 0 ? (
                  <p className="text-xs text-[#6B7280] text-center py-3">
                    No roles defined. Add a role to configure test user credentials.
                  </p>
                ) : (
                  <div className="space-y-3">
                    {formData.roles.map((role, idx) => (
                      <div
                        key={idx}
                        className="p-3 bg-[#F5F3FF]/50 border border-[#DDD6FE]/40 rounded-xl"
                      >
                        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                          {/* Role Name */}
                          <div>
                            <label className="block text-xs font-medium text-[#6B7280] mb-1">
                              Role Name
                            </label>
                            <input
                              type="text"
                              value={role.roleName}
                              onChange={(e) => updateRole(idx, 'roleName', e.target.value)}
                              placeholder="e.g. Admin"
                              className={INPUT_CLASS}
                            />
                          </div>

                          {/* Username */}
                          <div>
                            <label className="block text-xs font-medium text-[#6B7280] mb-1">
                              Username
                            </label>
                            <input
                              type="text"
                              value={role.username}
                              onChange={(e) => updateRole(idx, 'username', e.target.value)}
                              placeholder="testuser@example.com"
                              className={INPUT_CLASS}
                            />
                          </div>

                          {/* Password + controls */}
                          <div>
                            <label className="block text-xs font-medium text-[#6B7280] mb-1">
                              Password
                            </label>
                            <div className="flex gap-2">
                              <div className="relative flex-1">
                                <input
                                  type={visiblePasswords.has(idx) ? 'text' : 'password'}
                                  value={role.password}
                                  onChange={(e) => updateRole(idx, 'password', e.target.value)}
                                  placeholder="Password"
                                  autoComplete="off"
                                  className={`${INPUT_CLASS} pr-9`}
                                />
                                <button
                                  type="button"
                                  onClick={() => togglePasswordVisibility(idx)}
                                  className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-[#7C3AED] transition-colors"
                                >
                                  {visiblePasswords.has(idx) ? (
                                    <EyeOff className="w-4 h-4" />
                                  ) : (
                                    <Eye className="w-4 h-4" />
                                  )}
                                </button>
                              </div>
                              <button
                                onClick={() => removeRole(idx)}
                                className="p-2.5 text-gray-400 hover:text-red-500 hover:bg-red-50 rounded-xl border border-[#DDD6FE]/60 transition-colors flex-shrink-0"
                                title="Remove role"
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

              {/* Save button */}
              <div className="flex justify-end pt-2">
                <button
                  onClick={handleSave}
                  disabled={saving}
                  className="flex items-center gap-2 px-6 py-2.5 bg-gradient-to-r from-[#7C3AED] to-[#6366F1] text-white rounded-lg text-sm font-medium hover:from-[#6D28D9] hover:to-[#4F46E5] shadow-md shadow-purple-500/20 transition-all disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
                  {saving ? 'Saving...' : 'Save Application'}
                </button>
              </div>
            </div>
          ) : (
            <div className="flex items-center justify-center h-full min-h-[200px]">
              <div className="text-center">
                <div className="w-12 h-12 bg-[#F5F3FF] rounded-xl flex items-center justify-center mx-auto mb-3 border border-[#DDD6FE]/60">
                  <Plus className="w-5 h-5 text-[#7C3AED]" />
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
