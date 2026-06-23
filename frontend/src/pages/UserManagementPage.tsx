import { useState, useEffect, useCallback } from 'react';
import { Navigate } from 'react-router-dom';
import { useAuth } from '@/contexts/AuthContext';
import {
  Plus, X, Loader2, Eye, EyeOff, Trash2, UserCheck, UserX, Users, Shield, Search,
} from 'lucide-react';
import {
  listTenantUsers, listTenants, createTenantUser, updateTenantUser, deleteTenantUser, setTenantUserStatus,
} from '@/services/api';

interface TenantUser {
  id: string;
  username: string;
  email: string | null;
  full_name: string | null;
  role: string;
  is_active: boolean;
  created_at: string;
  updated_at: string;
  tenant_name: string;
  tenant_slug: string;
}

interface Tenant {
  id: string;
  name: string;
  slug: string;
  is_platform: boolean;
}

const ROLES = [
  { value: 'admin', label: 'Admin', color: 'bg-red-100 text-red-700 border-red-200' },
  { value: 'qa_engineer', label: 'QA Engineer', color: 'bg-blue-100 text-blue-700 border-blue-200' },
  { value: 'data_analyst', label: 'Data Analyst', color: 'bg-emerald-100 text-emerald-700 border-emerald-200' },
];

const inputCls = 'w-full px-4 py-3 bg-[#F5F3FF] border border-[#DDD6FE] rounded-xl text-[#1E1B4B] placeholder:text-gray-400 text-sm outline-none focus:ring-2 focus:ring-[#7C3AED]/30 focus:border-[#7C3AED] transition-all';

function getRoleBadge(role: string) {
  const r = ROLES.find(r => r.value === role);
  return r ? `px-2.5 py-0.5 rounded-lg text-sm border ${r.color}` : 'px-2.5 py-0.5 rounded-lg text-sm bg-gray-100 text-gray-600';
}

function getRoleLabel(role: string) {
  return ROLES.find(r => r.value === role)?.label || role;
}

export default function UserManagementPage() {
  const { user } = useAuth();

  // Admin guard
  if (user?.role !== 'admin') {
    return <Navigate to="/chat" replace />;
  }

  return <UserManagementContent />;
}

function UserManagementContent() {
  const { user } = useAuth();
  const isPlatform = user?.isPlatform === true;

  const [users, setUsers] = useState<TenantUser[]>([]);
  const [tenants, setTenants] = useState<Tenant[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);

  // Modal state
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [editingUser, setEditingUser] = useState<TenantUser | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<TenantUser | null>(null);

  // Create / edit form
  const [form, setForm] = useState({ username: '', email: '', fullName: '', role: 'qa_engineer', password: '', confirmPassword: '', tenantId: '', isInactive: false });
  const [showPassword, setShowPassword] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const fetchUsers = useCallback(async () => {
    setLoading(true);
    try {
      const data = await listTenantUsers();
      setUsers(data.users || []);
    } catch (err) {
      console.error('Failed to load users:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchUsers();
    if (isPlatform) {
      listTenants().then(d => setTenants(d.tenants || [])).catch(() => {});
    }
  }, []);

  const filteredUsers = search
    ? users.filter(u =>
        u.username.toLowerCase().includes(search.toLowerCase()) ||
        (u.full_name || '').toLowerCase().includes(search.toLowerCase()) ||
        (u.email || '').toLowerCase().includes(search.toLowerCase()) ||
        u.tenant_name.toLowerCase().includes(search.toLowerCase())
      )
    : users;

  const totalPages = Math.max(1, Math.ceil(filteredUsers.length / pageSize));
  const currentPage = Math.min(page, totalPages);
  const pagedUsers = filteredUsers.slice((currentPage - 1) * pageSize, currentPage * pageSize);

  useEffect(() => { setPage(1); }, [search, pageSize]);

  // Stats
  const totalUsers = users.length;
  const activeUsers = users.filter(u => u.is_active).length;
  const adminCount = users.filter(u => u.role === 'admin').length;
  const qaCount = users.filter(u => u.role === 'qa_engineer').length;
  const analystCount = users.filter(u => u.role === 'data_analyst').length;

  const handleCreate = async () => {
    setError('');
    if (!form.username || !form.password || !form.role) {
      setError('Username, password, and role are required.');
      return;
    }
    if (form.password !== form.confirmPassword) {
      setError('Passwords do not match.');
      return;
    }
    setSaving(true);
    try {
      await createTenantUser({
        username: form.username,
        password: form.password,
        email: form.email,
        fullName: form.fullName,
        role: form.role,
        tenantId: isPlatform && form.tenantId ? form.tenantId : undefined,
      });
      setShowCreateModal(false);
      setForm({ username: '', email: '', fullName: '', role: 'qa_engineer', password: '', confirmPassword: '', tenantId: '', isInactive: false });
      fetchUsers();
    } catch (err: any) {
      setError(err?.response?.data?.error || 'Failed to create user.');
    } finally {
      setSaving(false);
    }
  };

  const handleUpdate = async () => {
    if (!editingUser) return;
    setError('');
    if (form.password || form.confirmPassword) {
      if (form.password !== form.confirmPassword) {
        setError('Passwords do not match.');
        return;
      }
      if (form.password.length < 4) {
        setError('Password must be at least 4 characters.');
        return;
      }
    }
    setSaving(true);
    try {
      await updateTenantUser(editingUser.id, {
        fullName: form.fullName,
        email: form.email,
        role: form.role,
        isActive: !form.isInactive,
        ...(form.password ? { password: form.password } : {}),
      });
      setEditingUser(null);
      fetchUsers();
    } catch (err: any) {
      setError(err?.response?.data?.error || 'Failed to update user.');
    } finally {
      setSaving(false);
    }
  };

  const handleToggleStatus = async (u: TenantUser) => {
    try {
      await setTenantUserStatus(u.id, !u.is_active);
      fetchUsers();
    } catch (err: any) {
      alert(err?.response?.data?.error || 'Failed to update status.');
    }
  };

  const handleDelete = async () => {
    if (!confirmDelete) return;
    try {
      await deleteTenantUser(confirmDelete.id);
      setConfirmDelete(null);
      fetchUsers();
    } catch (err: any) {
      alert(err?.response?.data?.error || 'Failed to delete user.');
    }
  };

  const openEdit = (u: TenantUser) => {
    setEditingUser(u);
    setForm({
      username: u.username,
      email: u.email || '',
      fullName: u.full_name || '',
      role: u.role,
      password: '',
      confirmPassword: '',
      tenantId: '',
      isInactive: !u.is_active,
    });
    setError('');
  };

  const closeModal = () => {
    setShowCreateModal(false);
    setEditingUser(null);
    setError('');
    setForm({ username: '', email: '', fullName: '', role: 'qa_engineer', password: '', confirmPassword: '', tenantId: '', isInactive: false });
  };

  return (
    <div className="-m-6 p-4 space-y-3">
      {/* Toolbar: New User (left) + Search (right) */}
      <div className="flex items-center gap-3">
        <button
          onClick={() => { setShowCreateModal(true); setError(''); setForm({ username: '', email: '', fullName: '', role: 'qa_engineer', password: '', confirmPassword: '', tenantId: '', isInactive: false }); }}
          className="flex items-center gap-2 px-4 py-2 bg-gradient-to-r from-[#7C3AED] to-[#6366F1] hover:from-[#6D28D9] hover:to-[#4F46E5] text-white rounded-lg text-sm font-semibold shadow-md shadow-purple-500/25 transition-all whitespace-nowrap"
        >
          <Plus className="w-4 h-4" /> New User
        </button>
        <div className="relative ml-auto w-72">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
          <input
            type="text"
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search by username, name, email, or tenant..."
            className="w-full pl-10 pr-4 py-2 bg-white border border-gray-200 rounded-lg text-sm outline-none focus:ring-2 focus:ring-[#7C3AED]/20 focus:border-[#7C3AED]"
          />
        </div>
      </div>

      {/* Users Table */}
      <div className="bg-white rounded-2xl border border-gray-100 shadow-sm overflow-x-auto">
        {loading ? (
          <div className="flex items-center justify-center py-16 text-gray-400">
            <Loader2 className="w-5 h-5 animate-spin mr-2" /> Loading users...
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-gray-50 border-b border-gray-100">
                <th className="text-left px-3 py-1.5 text-xs font-semibold text-gray-500 uppercase tracking-wider">Username</th>
                <th className="text-left px-3 py-1.5 text-xs font-semibold text-gray-500 uppercase tracking-wider">Full Name</th>
                <th className="text-left px-3 py-1.5 text-xs font-semibold text-gray-500 uppercase tracking-wider whitespace-nowrap">Role</th>
                <th className="text-left px-3 py-1.5 text-xs font-semibold text-gray-500 uppercase tracking-wider whitespace-nowrap">Status</th>
                {isPlatform && <th className="text-left px-3 py-1.5 text-xs font-semibold text-gray-500 uppercase tracking-wider">Tenant</th>}
                <th className="text-left px-3 py-1.5 text-xs font-semibold text-gray-500 uppercase tracking-wider whitespace-nowrap">Last Updated</th>
                <th className="px-3 py-1.5 sticky right-0 bg-gray-50"></th>
              </tr>
            </thead>
            <tbody>
              {pagedUsers.map(u => (
                <tr key={u.id} className="border-b border-gray-50 hover:bg-gray-50/50">
                  <td className="px-3 py-1.5 truncate">
                    <button onClick={() => openEdit(u)} className="text-[#7C3AED] hover:underline hover:text-[#6D28D9] transition-colors">
                      {u.username}
                    </button>
                  </td>
                  <td className="px-3 py-1.5 text-gray-700 truncate">{u.full_name || '-'}</td>
                  <td className="px-3 py-1.5">
                    <span className={getRoleBadge(u.role)}>{getRoleLabel(u.role)}</span>
                  </td>
                  <td className="px-3 py-1.5">
                    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-lg text-sm border ${
                      u.is_active
                        ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
                        : 'bg-gray-100 text-gray-500 border-gray-200'
                    }`}>
                      {u.is_active ? 'Active' : 'Inactive'}
                    </span>
                  </td>
                  {isPlatform && <td className="px-3 py-1.5 text-gray-700 truncate">{u.tenant_name}</td>}
                  <td className="px-3 py-1.5 text-gray-700 whitespace-nowrap">
                    {new Date(u.updated_at).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })}
                  </td>
                  <td className="px-3 py-1.5 text-center sticky right-0 bg-white">
                    <div className="flex items-center justify-center gap-1">
                      <button
                        onClick={() => handleToggleStatus(u)}
                        className={`p-1.5 rounded-lg transition-colors ${
                          u.is_active ? 'hover:bg-amber-50 text-amber-500' : 'hover:bg-emerald-50 text-emerald-500'
                        }`}
                        title={u.is_active ? 'Deactivate' : 'Activate'}
                      >
                        {u.is_active ? <UserX className="w-4 h-4" /> : <UserCheck className="w-4 h-4" />}
                      </button>
                      <button
                        onClick={() => setConfirmDelete(u)}
                        className="p-1.5 rounded-lg hover:bg-red-50 text-red-400 transition-colors"
                        title="Delete"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
              {filteredUsers.length === 0 && (
                <tr>
                  <td colSpan={isPlatform ? 7 : 6} className="px-3 py-12 text-center text-gray-400">
                    {search ? 'No users match your search.' : 'No users found.'}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        )}
        {!loading && filteredUsers.length > 0 && (
          <div className="flex items-center justify-between px-4 py-1.5 border-t border-gray-100 bg-gray-50/50 text-xs">
            <div className="flex items-center gap-1.5 text-gray-600">
              <span>Rows:</span>
              <select
                value={pageSize}
                onChange={e => setPageSize(Number(e.target.value))}
                className="px-1.5 py-0.5 bg-white border border-gray-200 rounded text-xs outline-none focus:ring-1 focus:ring-[#7C3AED]/20 focus:border-[#7C3AED]"
              >
                {[10, 25, 50, 100].map(n => <option key={n} value={n}>{n}</option>)}
              </select>
              <span className="ml-2 text-gray-500">
                {(currentPage - 1) * pageSize + 1}–{Math.min(currentPage * pageSize, filteredUsers.length)} of {filteredUsers.length}
              </span>
            </div>
            <div className="flex items-center gap-1">
              <button
                onClick={() => setPage(p => Math.max(1, p - 1))}
                disabled={currentPage === 1}
                className="px-2 py-0.5 rounded font-medium text-gray-600 hover:bg-white border border-gray-200 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              >
                Prev
              </button>
              <span className="px-2 text-gray-600">
                Page <span className="font-semibold text-[#7C3AED]">{currentPage}</span> of {totalPages}
              </span>
              <button
                onClick={() => setPage(p => Math.min(totalPages, p + 1))}
                disabled={currentPage === totalPages}
                className="px-2 py-0.5 rounded font-medium text-gray-600 hover:bg-white border border-gray-200 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              >
                Next
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Create / Edit Modal */}
      {(showCreateModal || editingUser) && (
        <div className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-center justify-center p-4" onClick={closeModal}>
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between p-5 border-b border-gray-100">
              <h3 className="text-lg font-bold text-gray-900">
                {editingUser ? `Edit User — ${editingUser.username}` : 'Create New User'}
              </h3>
              <button onClick={closeModal} className="p-1.5 rounded-lg hover:bg-gray-100 text-gray-400">
                <X className="w-5 h-5" />
              </button>
            </div>

            <form className="p-5 space-y-4" autoComplete="off" onSubmit={e => e.preventDefault()}>
              {/* Hidden decoys to absorb Chrome autofill */}
              <input type="text" name="fakeusernameremembered" autoComplete="username" style={{ display: 'none' }} />
              <input type="password" name="fakepasswordremembered" autoComplete="current-password" style={{ display: 'none' }} />

              {error && (
                <div className="p-3 bg-red-50 border border-red-200 rounded-xl text-sm text-red-700">{error}</div>
              )}

              <div>
                <label className="block text-xs font-semibold text-gray-600 mb-1.5">Username {!editingUser && '*'}</label>
                <input
                  type="text"
                  name="user_name_iq"
                  autoComplete="off"
                  value={form.username}
                  onChange={e => setForm({ ...form, username: e.target.value })}
                  placeholder="Enter username"
                  disabled={!!editingUser}
                  className={inputCls + (editingUser ? ' opacity-70 cursor-not-allowed' : '')}
                />
              </div>

              {!editingUser && (
                <div>
                  <label className="block text-xs font-semibold text-gray-600 mb-1.5">Full Name</label>
                  <input type="text" name="full_name_iq" autoComplete="off" value={form.fullName} onChange={e => setForm({ ...form, fullName: e.target.value })} placeholder="Enter full name" className={inputCls} />
                </div>
              )}

              <div>
                <label className="block text-xs font-semibold text-gray-600 mb-1.5">Email</label>
                <input type="text" name="email_iq" autoComplete="off" value={form.email} onChange={e => setForm({ ...form, email: e.target.value })} placeholder="Enter email" className={inputCls} />
              </div>

              <div>
                <label className="block text-xs font-semibold text-gray-600 mb-1.5">Role *</label>
                <div className="relative">
                  <select
                    value={form.role}
                    onChange={e => setForm({ ...form, role: e.target.value })}
                    className={inputCls + ' appearance-none pr-10 cursor-pointer'}
                  >
                    {ROLES.map(r => <option key={r.value} value={r.value}>{r.label}</option>)}
                  </select>
                  <svg className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[#7C3AED] pointer-events-none" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" d="M19 9l-7 7-7-7" />
                  </svg>
                </div>
              </div>

              <div>
                <label className="block text-xs font-semibold text-gray-600 mb-1.5">
                  Password {!editingUser && '*'}{editingUser && <span className="font-normal text-gray-400"> (leave blank to keep current)</span>}
                </label>
                <div className="relative">
                  <input
                    type={showPassword ? 'text' : 'password'}
                    name="new_pwd_iq"
                    autoComplete="new-password"
                    value={form.password}
                    onChange={e => setForm({ ...form, password: e.target.value })}
                    placeholder="Enter password"
                    className={inputCls + ' pr-11'}
                  />
                  <button type="button" onClick={() => setShowPassword(!showPassword)}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600">
                    {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                </div>
              </div>

              <div>
                <label className="block text-xs font-semibold text-gray-600 mb-1.5">Confirm Password</label>
                <input
                  type={showPassword ? 'text' : 'password'}
                  name="confirm_pwd_iq"
                  autoComplete="new-password"
                  value={form.confirmPassword}
                  onChange={e => setForm({ ...form, confirmPassword: e.target.value })}
                  placeholder="Re-enter password"
                  className={inputCls}
                />
              </div>

              {editingUser && (
                <label className="flex items-center gap-2 cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={form.isInactive}
                    onChange={e => setForm({ ...form, isInactive: e.target.checked })}
                    className="w-4 h-4 rounded border-gray-300 text-[#7C3AED] focus:ring-[#7C3AED]/30"
                  />
                  <span className="text-sm text-gray-700">Mark as inactive</span>
                  <span className="text-xs text-gray-400">(admin can reactivate later)</span>
                </label>
              )}

              {!editingUser && isPlatform && tenants.length > 0 && (
                <div>
                  <label className="block text-xs font-semibold text-gray-600 mb-1.5">Tenant</label>
                  <select value={form.tenantId} onChange={e => setForm({ ...form, tenantId: e.target.value })} className={inputCls}>
                    <option value="">Current tenant</option>
                    {tenants.map(t => <option key={t.id} value={t.id}>{t.name}{t.is_platform ? ' (Platform)' : ''}</option>)}
                  </select>
                </div>
              )}
            </form>

            <div className="flex items-center justify-end gap-3 p-5 border-t border-gray-100">
              {editingUser && (
                <button
                  onClick={() => { setConfirmDelete(editingUser); setEditingUser(null); }}
                  className="mr-auto flex items-center gap-1.5 px-4 py-2.5 text-red-600 bg-red-50 border border-red-200 rounded-xl text-sm font-medium hover:bg-red-100 transition-colors"
                >
                  <Trash2 className="w-3.5 h-3.5" /> Delete
                </button>
              )}
              <button onClick={closeModal} className="px-4 py-2.5 text-gray-600 bg-gray-100 rounded-xl text-sm font-medium hover:bg-gray-200 transition-colors">
                Cancel
              </button>
              <button
                onClick={editingUser ? handleUpdate : handleCreate}
                disabled={saving}
                className="flex items-center gap-2 px-5 py-2.5 bg-gradient-to-r from-[#7C3AED] to-[#6366F1] hover:from-[#6D28D9] hover:to-[#4F46E5] disabled:from-[#C4B5FD] disabled:to-[#C7D2FE] text-white rounded-xl text-sm font-semibold transition-all shadow-lg shadow-purple-500/25"
              >
                {saving && <Loader2 className="w-4 h-4 animate-spin" />}
                {editingUser ? 'Save Changes' : 'Create User'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Delete Confirmation Modal */}
      {confirmDelete && (
        <div className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-center justify-center p-4" onClick={() => setConfirmDelete(null)}>
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-sm p-6" onClick={e => e.stopPropagation()}>
            <div className="flex items-center gap-3 mb-4">
              <div className="w-10 h-10 rounded-full bg-red-100 flex items-center justify-center">
                <Trash2 className="w-5 h-5 text-red-600" />
              </div>
              <div>
                <h3 className="font-bold text-gray-900">Delete User</h3>
                <p className="text-sm text-gray-500">This cannot be undone.</p>
              </div>
            </div>
            <p className="text-sm text-gray-700 mb-5">
              Are you sure you want to delete <span className="font-semibold text-[#7C3AED]">{confirmDelete.username}</span>? All their data will be removed.
            </p>
            <div className="flex items-center justify-end gap-3">
              <button onClick={() => setConfirmDelete(null)} className="px-4 py-2 text-gray-600 bg-gray-100 rounded-xl text-sm font-medium hover:bg-gray-200">
                Cancel
              </button>
              <button onClick={handleDelete} className="px-4 py-2 text-white bg-red-600 hover:bg-red-700 rounded-xl text-sm font-semibold transition-colors">
                Delete
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function StatCard({ label, value, accent }: { label: string; value: number; accent?: string }) {
  const colors: Record<string, string> = {
    emerald: 'text-emerald-600',
    red: 'text-red-600',
    blue: 'text-blue-600',
  };
  return (
    <div className="bg-white rounded-xl border border-gray-100 shadow-sm p-4">
      <p className="text-[10px] text-gray-500 uppercase tracking-wider mb-1">{label}</p>
      <p className={`text-2xl font-bold ${accent ? colors[accent] || 'text-gray-900' : 'text-gray-900'}`}>{value}</p>
    </div>
  );
}
