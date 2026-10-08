/**
 * AccessControl — RBAC, SSO (OIDC) and SCIM provisioning for the workspace.
 *
 * Three standalone admin panels: a role × permission matrix, an OpenID Connect
 * single-sign-on config with a discovery probe, and a SCIM base URL + bearer
 * token for directory-driven provisioning. Opt-in; nothing here touches the
 * catalogue or the pipeline.
 */
import { useState, useEffect } from 'react';
import { ShieldCheck, X, AlertTriangle, CheckCircle2, XCircle, RefreshCw, Trash2, Save } from 'lucide-react';
import Spinner from '@/components/feedback/Spinner';
import { useToast } from '@/components/feedback/ToastProvider';
import {
  getAccessPermissions,
  setRolePermissions,
  getSsoConfig,
  saveSsoConfig,
  testOidcDiscovery,
  getScimToken,
  rotateScimToken,
  revokeScimToken,
  type AccessPermissions,
  type SsoConfigView,
  type ScimTokenView,
  type PermissionDef,
} from '@/services/api';
import { CopyButton } from './primitives';
import { CARD, STRIP, INPUT, LABEL, PRIMARY_BTN, SECONDARY_BTN } from './format';

type Tab = 'roles' | 'sso' | 'scim';
type MatrixRow = { kind: 'group'; group: string } | { kind: 'perm'; perm: PermissionDef };
type Discovery = { ok: boolean; authorizationEndpoint?: string; tokenEndpoint?: string; userinfoEndpoint?: string; error?: string };

const TAB_ACTIVE = 'px-3 py-1.5 text-[12px] font-medium text-[#6D28D9] border-b-2 border-[#7C3AED]';
const TAB_INACTIVE = 'px-3 py-1.5 text-[12px] font-medium text-gray-500 hover:text-gray-700';

export default function AccessControl({ onClose }: { onClose: () => void }) {
  const toast = useToast();
  const [tab, setTab] = useState<Tab>('roles');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  // ── Roles ──
  const [perms, setPerms] = useState<AccessPermissions | null>(null);
  const [roles, setRoles] = useState<Record<string, string[]>>({});
  const [savingRole, setSavingRole] = useState('');

  // ── SSO ──
  const [ssoType, setSsoType] = useState('oidc');
  const [issuer, setIssuer] = useState('');
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [defaultRole, setDefaultRole] = useState('viewer');
  const [enabled, setEnabled] = useState(false);
  const [hasSecret, setHasSecret] = useState(false);
  const [discovery, setDiscovery] = useState<Discovery | null>(null);

  // ── SCIM ──
  const [scim, setScim] = useState<ScimTokenView | null>(null);
  const [mintedToken, setMintedToken] = useState('');

  const origin = typeof window !== 'undefined' ? window.location.origin : '';

  const applySso = (s: SsoConfigView) => {
    setSsoType(s.type === 'saml' ? 'saml' : 'oidc');
    setIssuer(s.issuer); setClientId(s.clientId); setDefaultRole(s.defaultRole || 'viewer');
    setEnabled(s.enabled); setHasSecret(s.hasSecret);
  };

  useEffect(() => {
    (async () => {
      try {
        const [p, s, sc] = await Promise.all([getAccessPermissions(), getSsoConfig(), getScimToken()]);
        setPerms(p); setRoles(p.roles); applySso(s); setScim(sc);
      } catch (e: any) {
        setError(e?.response?.data?.error || e?.message || 'Could not load access settings.');
      } finally { setLoading(false); }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const roleKeys = Object.keys(roles);

  const matrixRows: MatrixRow[] = (() => {
    const order: string[] = [];
    const byGroup: Record<string, PermissionDef[]> = {};
    for (const p of perms?.catalog || []) {
      if (!byGroup[p.group]) { byGroup[p.group] = []; order.push(p.group); }
      byGroup[p.group].push(p);
    }
    const out: MatrixRow[] = [];
    order.forEach((g) => { out.push({ kind: 'group', group: g }); byGroup[g].forEach((perm) => out.push({ kind: 'perm', perm })); });
    return out;
  })();

  const toggle = (role: string, key: string) => {
    setRoles((prev) => {
      const set = new Set(prev[role] || []);
      if (set.has(key)) set.delete(key); else set.add(key);
      return { ...prev, [role]: Array.from(set) };
    });
  };

  const saveRole = async (role: string) => {
    setSavingRole(role); setError('');
    try {
      const { roles: next } = await setRolePermissions(role, roles[role] || []);
      setRoles(next);
      toast.success(`Saved ${role}`);
    } catch (e: any) {
      setError(e?.response?.data?.error || e?.message || 'Could not save role permissions.');
    } finally { setSavingRole(''); }
  };

  const testDiscovery = async () => {
    setBusy(true); setError(''); setDiscovery(null);
    try {
      setDiscovery(await testOidcDiscovery(issuer.trim()));
    } catch (e: any) {
      setError(e?.response?.data?.error || e?.message || 'Discovery failed.');
    } finally { setBusy(false); }
  };

  const saveSso = async () => {
    setBusy(true); setError('');
    try {
      const saved = await saveSsoConfig({ type: ssoType, issuer: issuer.trim(), clientId: clientId.trim(), clientSecret: clientSecret || undefined, defaultRole, enabled });
      applySso(saved); setClientSecret('');
      toast.success('SSO saved');
    } catch (e: any) {
      setError(e?.response?.data?.error || e?.message || 'Could not save SSO config.');
    } finally { setBusy(false); }
  };

  const mint = async () => {
    setBusy(true); setError('');
    try {
      const { token } = await rotateScimToken();
      setMintedToken(token);
      setScim((prev) => (prev ? { ...prev, hasToken: true } : prev));
      toast.success('SCIM token minted');
    } catch (e: any) {
      setError(e?.response?.data?.error || e?.message || 'Could not mint a SCIM token.');
    } finally { setBusy(false); }
  };

  const revoke = async () => {
    setBusy(true); setError('');
    try {
      await revokeScimToken();
      setMintedToken('');
      setScim((prev) => (prev ? { ...prev, hasToken: false } : prev));
      toast.success('SCIM token revoked');
    } catch (e: any) {
      setError(e?.response?.data?.error || e?.message || 'Could not revoke the SCIM token.');
    } finally { setBusy(false); }
  };

  const switchTab = (t: Tab) => { setTab(t); setError(''); };
  const scimUrl = scim ? `${origin}${scim.baseUrl}` : '';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-[#1E1B4B]/30 backdrop-blur-sm p-4" onClick={onClose}>
      <div className={`${CARD} w-full max-w-3xl max-h-[88vh] flex flex-col overflow-hidden`} onClick={(e) => e.stopPropagation()}>
        <div className={`flex items-center gap-2 px-4 h-12 border-b border-[#EDE9FE] flex-shrink-0 ${STRIP}`}>
          <ShieldCheck className="w-4 h-4 text-[#7C3AED]" />
          <h3 className="text-[13px] font-semibold text-gray-900">Access control</h3>
          <span className="text-[11px] text-gray-400">RBAC · SSO (OIDC) · SCIM</span>
          <button type="button" onClick={onClose} className="ml-auto p-1.5 rounded-md text-gray-400 hover:text-[#7C3AED] hover:bg-[#F5F3FF]"><X className="w-4 h-4" /></button>
        </div>

        <div className="flex items-center gap-1 px-3 border-b border-[#EDE9FE] flex-shrink-0">
          <button type="button" onClick={() => switchTab('roles')} className={tab === 'roles' ? TAB_ACTIVE : TAB_INACTIVE}>Roles</button>
          <button type="button" onClick={() => switchTab('sso')} className={tab === 'sso' ? TAB_ACTIVE : TAB_INACTIVE}>SSO</button>
          <button type="button" onClick={() => switchTab('scim')} className={tab === 'scim' ? TAB_ACTIVE : TAB_INACTIVE}>SCIM</button>
        </div>

        <div className="p-4 space-y-3 overflow-y-auto min-h-0">
          {error && (
            <div className="flex items-start gap-2 px-3 py-2 bg-red-50 border border-red-200 rounded-lg">
              <AlertTriangle className="w-4 h-4 text-red-500 flex-shrink-0 mt-px" /><p className="text-[12px] text-red-700 min-w-0 whitespace-pre-wrap break-words">{error}</p>
            </div>
          )}

          {loading ? (
            <div className="flex items-center justify-center py-10 text-gray-400"><Spinner className="w-5 h-5 animate-spin" /></div>
          ) : (
            <>
              {tab === 'roles' && (
                roleKeys.length === 0 ? (
                  <p className="text-[12px] text-gray-400">No roles configured.</p>
                ) : (
                  <div className="border border-[#E9E5FB] rounded-lg overflow-x-auto">
                    <table className="w-full text-[11.5px]">
                      <thead>
                        <tr className="bg-[#FAF9FE] text-gray-500 text-left">
                          <th className="font-semibold px-3 py-2">Permission</th>
                          {roleKeys.map((role) => (
                            <th key={role} className="font-semibold px-3 py-2 text-center whitespace-nowrap">
                              <div className="flex flex-col items-center gap-1">
                                <span className="text-gray-700">{role}</span>
                                <button type="button" onClick={() => void saveRole(role)} disabled={savingRole === role} className="inline-flex items-center gap-1 px-2 py-0.5 text-[10.5px] font-medium text-[#6D28D9] bg-white border border-[#DDD6FE] rounded hover:bg-[#F5F3FF] disabled:opacity-40">
                                  {savingRole === role ? <Spinner className="w-3 h-3 animate-spin" /> : <Save className="w-3 h-3" />}Save
                                </button>
                              </div>
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-gray-100">
                        {matrixRows.map((r, i) => (
                          r.kind === 'group' ? (
                            <tr key={`g-${r.group}`} className="bg-[#FCFBFF]">
                              <td colSpan={roleKeys.length + 1} className="px-3 py-1.5 text-[10.5px] font-semibold uppercase tracking-wide text-gray-500">{r.group}</td>
                            </tr>
                          ) : (
                            <tr key={`p-${r.perm.key}-${i}`}>
                              <td className="px-3 py-1.5 text-gray-700">{r.perm.label}</td>
                              {roleKeys.map((role) => (
                                <td key={role} className="px-3 py-1.5 text-center">
                                  <input type="checkbox" className="w-3.5 h-3.5" checked={(roles[role] || []).includes(r.perm.key)} onChange={() => toggle(role, r.perm.key)} />
                                </td>
                              ))}
                            </tr>
                          )
                        ))}
                      </tbody>
                    </table>
                  </div>
                )
              )}

              {tab === 'sso' && (
                <>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div>
                      <label className={LABEL}>Type</label>
                      <select value={ssoType} onChange={(e) => setSsoType(e.target.value)} className={INPUT}>
                        <option value="oidc">OIDC</option>
                        <option value="saml">SAML</option>
                      </select>
                    </div>
                    <div>
                      <label className={LABEL}>Default role</label>
                      <select value={defaultRole} onChange={(e) => setDefaultRole(e.target.value)} className={INPUT}>
                        <option value="admin">admin</option>
                        <option value="qa_lead">qa_lead</option>
                        <option value="qa_engineer">qa_engineer</option>
                        <option value="viewer">viewer</option>
                      </select>
                    </div>
                  </div>

                  <div>
                    <label className={LABEL}>Issuer</label>
                    <input value={issuer} onChange={(e) => setIssuer(e.target.value)} placeholder="https://issuer.example.com" className={INPUT} />
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div>
                      <label className={LABEL}>Client ID</label>
                      <input value={clientId} onChange={(e) => setClientId(e.target.value)} className={INPUT} />
                    </div>
                    <div>
                      <label className={LABEL}>Client secret</label>
                      <input type="password" value={clientSecret} onChange={(e) => setClientSecret(e.target.value)} placeholder={hasSecret ? '•••• leave blank to keep' : ''} className={INPUT} />
                    </div>
                  </div>

                  <label className="flex items-center gap-2 text-[11.5px] text-gray-600">
                    <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} className="w-3.5 h-3.5" />
                    Enabled
                  </label>

                  <div className="flex items-center justify-end gap-2">
                    <button type="button" onClick={() => void testDiscovery()} disabled={busy || !issuer.trim()} className={SECONDARY_BTN}>
                      {busy ? <Spinner className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}Test discovery
                    </button>
                    <button type="button" onClick={() => void saveSso()} disabled={busy} className={PRIMARY_BTN}>
                      <Save className="w-3.5 h-3.5" />Save
                    </button>
                  </div>

                  {discovery && (
                    <div className={`rounded-lg border px-3 py-2.5 ${discovery.ok ? 'bg-emerald-50 border-emerald-200' : 'bg-red-50 border-red-200'}`}>
                      <div className="flex items-center gap-2 mb-1.5">
                        {discovery.ok ? <CheckCircle2 className="w-4 h-4 text-emerald-600" /> : <XCircle className="w-4 h-4 text-red-600" />}
                        <span className={`text-[12.5px] font-semibold ${discovery.ok ? 'text-emerald-700' : 'text-red-700'}`}>Discovery {discovery.ok ? 'ok' : 'failed'}</span>
                      </div>
                      {discovery.ok ? (
                        <div className="space-y-0.5 text-[11px] font-mono text-gray-600 break-all">
                          <div>authorization: {discovery.authorizationEndpoint || '—'}</div>
                          <div>token: {discovery.tokenEndpoint || '—'}</div>
                          <div>userinfo: {discovery.userinfoEndpoint || '—'}</div>
                        </div>
                      ) : (
                        <p className="text-[11.5px] text-red-700 whitespace-pre-wrap break-words">{discovery.error || 'Could not reach the issuer.'}</p>
                      )}
                    </div>
                  )}

                  <p className="text-[10.5px] text-gray-400">Login URL: {origin}/api/auth/sso/&lt;tenantId&gt;/start</p>
                </>
              )}

              {tab === 'scim' && (
                <>
                  <div>
                    <label className={LABEL}>SCIM base URL</label>
                    <div className="flex items-center gap-1.5">
                      <code className="flex-1 min-w-0 truncate text-[11px] font-mono text-[#6D28D9] bg-[#F5F3FF] border border-[#DDD6FE] rounded px-2 py-1.5">{scimUrl}</code>
                      <CopyButton text={scimUrl} />
                    </div>
                  </div>

                  <p className="text-[11.5px] text-gray-600">
                    {scim?.hasToken ? 'A SCIM token is currently active.' : 'No SCIM token is active yet.'}
                  </p>

                  <div className="flex items-center gap-2">
                    <button type="button" onClick={() => void mint()} disabled={busy} className={PRIMARY_BTN}>
                      {busy ? <Spinner className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}Mint / rotate token
                    </button>
                    <button type="button" onClick={() => void revoke()} disabled={busy || !scim?.hasToken} className={SECONDARY_BTN}>
                      <Trash2 className="w-3.5 h-3.5" />Revoke
                    </button>
                  </div>

                  {mintedToken && (
                    <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 space-y-2">
                      <div className="flex items-start gap-2">
                        <AlertTriangle className="w-4 h-4 text-amber-500 flex-shrink-0 mt-px" />
                        <p className="text-[11.5px] text-amber-700 min-w-0">Store it now — this token is shown only once.</p>
                      </div>
                      <div className="flex items-center gap-1.5">
                        <code className="flex-1 min-w-0 truncate text-[11px] font-mono text-[#6D28D9] bg-white border border-[#DDD6FE] rounded px-2 py-1.5">{mintedToken}</code>
                        <CopyButton text={mintedToken} />
                      </div>
                    </div>
                  )}
                </>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
