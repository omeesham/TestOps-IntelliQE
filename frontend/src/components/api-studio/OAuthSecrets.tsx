/**
 * OAuthSecrets — fetch OAuth2 access tokens and resolve managed secrets.
 *
 * Two standalone utilities for wiring real credentials into a run without
 * pasting them by hand: an OAuth2 token fetcher (the four common grants, plus
 * reusable saved configs) and a secret-manager resolver (Vault / AWS / Azure /
 * GCP) that masks by default and only reveals on an explicit second call.
 * Opt-in; nothing here touches the catalogue or the pipeline.
 */
import { useEffect, useState } from 'react';
import { KeyRound, X, AlertTriangle, Trash2, Eye, EyeOff, Save } from 'lucide-react';
import Spinner from '@/components/feedback/Spinner';
import { useToast } from '@/components/feedback/ToastProvider';
import {
  fetchOAuthToken,
  listOAuthConfigs,
  saveOAuthConfig,
  deleteOAuthConfig,
  fetchOAuthTokenFromConfig,
  resolveSecret,
  type OAuthToken,
  type OAuthConfigView,
  type SecretResult,
} from '@/services/api';
import { CopyButton } from './primitives';
import { CARD, STRIP, INPUT, LABEL, PRIMARY_BTN, SECONDARY_BTN } from './format';

type Tab = 'oauth' | 'secrets';

const TAB_ACTIVE = 'px-3 py-1.5 text-[12px] font-medium text-[#6D28D9] border-b-2 border-[#7C3AED]';
const TAB_INACTIVE = 'px-3 py-1.5 text-[12px] font-medium text-gray-500 hover:text-gray-700';

function TextField({
  label, value, onChange, type = 'text', placeholder,
}: { label: string; value: string; onChange: (v: string) => void; type?: string; placeholder?: string }) {
  return (
    <div>
      <label className={LABEL}>{label}</label>
      <input type={type} value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} className={INPUT} />
    </div>
  );
}

/** A fetched access token: masked monospace box, reveal toggle, copy. */
function TokenBox({ token }: { token: OAuthToken }) {
  const [reveal, setReveal] = useState(false);
  return (
    <div className="rounded-lg border border-[#E4E0F5] bg-[#FAF9FE] p-3 space-y-2">
      <div className="flex flex-wrap items-center gap-2 text-[11.5px] text-gray-600">
        <span className="inline-flex items-center px-2 py-0.5 rounded border bg-white border-gray-200 font-mono">{token.tokenType || 'Bearer'}</span>
        {token.expiresIn !== undefined && <span className="text-gray-400 tabular-nums">expires in {token.expiresIn}s</span>}
        {token.scope && <span className="text-gray-400 truncate min-w-0">scope: {token.scope}</span>}
      </div>
      <div className="flex items-center gap-1.5">
        <code className="flex-1 min-w-0 truncate text-[11px] font-mono text-[#6D28D9] bg-[#F5F3FF] border border-[#DDD6FE] rounded px-2 py-1.5">
          {reveal ? token.accessToken : '•'.repeat(Math.min(44, Math.max(8, token.accessToken.length)))}
        </code>
        <button type="button" onClick={() => setReveal((r) => !r)} className="p-2 rounded-lg text-gray-400 hover:text-[#7C3AED] hover:bg-[#F5F3FF]" title={reveal ? 'Hide' : 'Reveal'}>
          {reveal ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
        </button>
        <CopyButton text={token.accessToken} />
      </div>
    </div>
  );
}

export default function OAuthSecrets({ onClose }: { onClose: () => void }) {
  const toast = useToast();
  const [tab, setTab] = useState<Tab>('oauth');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  // ── OAuth2 ──
  const [grant, setGrant] = useState('client_credentials');
  const [tokenUrl, setTokenUrl] = useState('');
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [scope, setScope] = useState('');
  const [audience, setAudience] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [refreshToken, setRefreshToken] = useState('');
  const [code, setCode] = useState('');
  const [redirectUri, setRedirectUri] = useState('');
  const [clientAuthBasic, setClientAuthBasic] = useState(false);
  const [configName, setConfigName] = useState('');
  const [token, setToken] = useState<OAuthToken | null>(null);
  const [configs, setConfigs] = useState<OAuthConfigView[]>([]);
  const [configToken, setConfigToken] = useState<OAuthToken | null>(null);

  // ── Secret managers ──
  const [provider, setProvider] = useState('vault');
  const [ref, setRef] = useState('');
  const [secretKey, setSecretKey] = useState('');
  const [vaultAddr, setVaultAddr] = useState('');
  const [vaultToken, setVaultToken] = useState('');
  const [region, setRegion] = useState('');
  const [accessKeyId, setAccessKeyId] = useState('');
  const [secretAccessKey, setSecretAccessKey] = useState('');
  const [vaultUrl, setVaultUrl] = useState('');
  const [projectId, setProjectId] = useState('');
  const [secret, setSecret] = useState<SecretResult | null>(null);

  const loadConfigs = async () => {
    const { configs: list } = await listOAuthConfigs();
    setConfigs(list);
  };

  useEffect(() => {
    void loadConfigs().catch((e: any) => setError(e?.response?.data?.error || e?.message || 'Could not load saved configs.'));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const fetchToken = async () => {
    setBusy(true); setError(''); setToken(null);
    try {
      const t = await fetchOAuthToken({ grant, tokenUrl, clientId, clientSecret, scope, audience, username, password, refreshToken, code, redirectUri, clientAuthBasic });
      setToken(t);
      toast.success('Token fetched');
    } catch (e: any) {
      setError(e?.response?.data?.error || e?.message || 'Could not fetch a token.');
    } finally { setBusy(false); }
  };

  const save = async () => {
    setBusy(true); setError('');
    try {
      await saveOAuthConfig({ name: configName.trim(), grant, tokenUrl, clientId, clientSecret, scope, audience, clientAuthBasic });
      setConfigName('');
      await loadConfigs();
      toast.success('Config saved');
    } catch (e: any) {
      setError(e?.response?.data?.error || e?.message || 'Could not save the config.');
    } finally { setBusy(false); }
  };

  const tokenFromConfig = async (id: string) => {
    setBusy(true); setError(''); setConfigToken(null);
    try {
      setConfigToken(await fetchOAuthTokenFromConfig(id));
      toast.success('Token fetched');
    } catch (e: any) {
      setError(e?.response?.data?.error || e?.message || 'Could not fetch a token from this config.');
    } finally { setBusy(false); }
  };

  const removeConfig = async (id: string) => {
    setBusy(true); setError('');
    try {
      await deleteOAuthConfig(id);
      await loadConfigs();
      toast.success('Config deleted');
    } catch (e: any) {
      setError(e?.response?.data?.error || e?.message || 'Could not delete the config.');
    } finally { setBusy(false); }
  };

  const secretInput = (reveal?: boolean) => {
    const base: any = { provider, ref: ref.trim(), key: secretKey.trim() || undefined };
    if (reveal) base.reveal = true;
    if (provider === 'vault') { base.vaultAddr = vaultAddr.trim() || undefined; base.vaultToken = vaultToken || undefined; }
    else if (provider === 'aws') { base.region = region.trim() || undefined; base.accessKeyId = accessKeyId.trim() || undefined; base.secretAccessKey = secretAccessKey || undefined; }
    else if (provider === 'azure') { base.vaultUrl = vaultUrl.trim() || undefined; }
    else if (provider === 'gcp') { base.projectId = projectId.trim() || undefined; }
    return base;
  };

  const resolve = async (reveal?: boolean) => {
    setBusy(true); setError(''); setSecret(null);
    try {
      setSecret(await resolveSecret(secretInput(reveal)));
    } catch (e: any) {
      setError(e?.response?.data?.error || e?.message || 'Could not resolve the secret.');
    } finally { setBusy(false); }
  };

  const switchTab = (t: Tab) => { setTab(t); setError(''); };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-[#1E1B4B]/30 backdrop-blur-sm p-4" onClick={onClose}>
      <div className={`${CARD} w-full max-w-3xl max-h-[88vh] flex flex-col overflow-hidden`} onClick={(e) => e.stopPropagation()}>
        <div className={`flex items-center gap-2 px-4 h-12 border-b border-[#EDE9FE] flex-shrink-0 ${STRIP}`}>
          <KeyRound className="w-4 h-4 text-[#7C3AED]" />
          <h3 className="text-[13px] font-semibold text-gray-900">OAuth &amp; secrets</h3>
          <span className="text-[11px] text-gray-400">fetch OAuth2 tokens · resolve managed secrets</span>
          <button type="button" onClick={onClose} className="ml-auto p-1.5 rounded-md text-gray-400 hover:text-[#7C3AED] hover:bg-[#F5F3FF]"><X className="w-4 h-4" /></button>
        </div>

        <div className="flex items-center gap-1 px-3 border-b border-[#EDE9FE] flex-shrink-0">
          <button type="button" onClick={() => switchTab('oauth')} className={tab === 'oauth' ? TAB_ACTIVE : TAB_INACTIVE}>OAuth2</button>
          <button type="button" onClick={() => switchTab('secrets')} className={tab === 'secrets' ? TAB_ACTIVE : TAB_INACTIVE}>Secret managers</button>
        </div>

        <div className="p-4 space-y-3 overflow-y-auto min-h-0">
          {error && (
            <div className="flex items-start gap-2 px-3 py-2 bg-red-50 border border-red-200 rounded-lg">
              <AlertTriangle className="w-4 h-4 text-red-500 flex-shrink-0 mt-px" /><p className="text-[12px] text-red-700 min-w-0 whitespace-pre-wrap break-words">{error}</p>
            </div>
          )}

          {tab === 'oauth' && (
            <>
              <div>
                <label className={LABEL}>Grant</label>
                <select value={grant} onChange={(e) => setGrant(e.target.value)} className={INPUT}>
                  <option value="client_credentials">client_credentials</option>
                  <option value="password">password</option>
                  <option value="refresh_token">refresh_token</option>
                  <option value="authorization_code">authorization_code</option>
                </select>
              </div>

              <TextField label="Token URL" value={tokenUrl} onChange={setTokenUrl} placeholder="https://auth.example.com/oauth/token" />
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <TextField label="Client ID" value={clientId} onChange={setClientId} />
                <TextField label="Client secret" value={clientSecret} onChange={setClientSecret} type="password" />
                <TextField label="Scope" value={scope} onChange={setScope} placeholder="read write" />
                <TextField label="Audience" value={audience} onChange={setAudience} />
              </div>

              {grant === 'password' && (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <TextField label="Username" value={username} onChange={setUsername} />
                  <TextField label="Password" value={password} onChange={setPassword} type="password" />
                </div>
              )}
              {grant === 'refresh_token' && (
                <TextField label="Refresh token" value={refreshToken} onChange={setRefreshToken} type="password" />
              )}
              {grant === 'authorization_code' && (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <TextField label="Code" value={code} onChange={setCode} />
                  <TextField label="Redirect URI" value={redirectUri} onChange={setRedirectUri} />
                </div>
              )}

              <label className="flex items-center gap-2 text-[11.5px] text-gray-600">
                <input type="checkbox" checked={clientAuthBasic} onChange={(e) => setClientAuthBasic(e.target.checked)} className="w-3.5 h-3.5" />
                Send client creds in a Basic header
              </label>

              <div className="flex items-center justify-end">
                <button type="button" onClick={() => void fetchToken()} disabled={busy} className={PRIMARY_BTN}>
                  {busy ? <Spinner className="w-3.5 h-3.5 animate-spin" /> : <KeyRound className="w-3.5 h-3.5" />}
                  Fetch token
                </button>
              </div>

              {token && <TokenBox token={token} />}

              {/* Save as config */}
              <div className="rounded-lg border border-[#E4E0F5] bg-[#FAF9FE] p-3">
                <label className={LABEL}>Save as config</label>
                <div className="flex items-end gap-2">
                  <input value={configName} onChange={(e) => setConfigName(e.target.value)} placeholder="Config name" className={INPUT} />
                  <button type="button" onClick={() => void save()} disabled={busy || !configName.trim()} className={SECONDARY_BTN}>
                    {busy ? <Spinner className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}Save
                  </button>
                </div>
              </div>

              {/* Saved configs */}
              <div>
                <label className={LABEL}>Saved configs</label>
                {configs.length === 0 ? (
                  <p className="text-[12px] text-gray-400">No saved configs yet.</p>
                ) : (
                  <div className="space-y-1.5">
                    {configs.map((c) => (
                      <div key={c.id} className="flex items-center gap-2 rounded-lg border border-[#E9E5FB] px-3 py-2 text-[11.5px]">
                        <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${c.hasSecret ? 'bg-emerald-500' : 'bg-gray-300'}`} title={c.hasSecret ? 'Has a stored secret' : 'No stored secret'} />
                        <span className="font-medium text-gray-700 truncate">{c.name}</span>
                        <span className="text-gray-400">{c.grant}</span>
                        <span className="text-gray-400 font-mono truncate min-w-0">{c.clientId}</span>
                        <div className="ml-auto flex items-center gap-1.5 flex-shrink-0">
                          <button type="button" onClick={() => void tokenFromConfig(c.id)} disabled={busy} className={SECONDARY_BTN}>
                            <KeyRound className="w-3.5 h-3.5" />Get token
                          </button>
                          <button type="button" onClick={() => void removeConfig(c.id)} disabled={busy} className="p-2 rounded-lg text-gray-400 hover:text-red-500 hover:bg-red-50 disabled:opacity-40" title="Delete config"><Trash2 className="w-4 h-4" /></button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
                {configToken && <div className="mt-2"><TokenBox token={configToken} /></div>}
              </div>
            </>
          )}

          {tab === 'secrets' && (
            <>
              <div>
                <label className={LABEL}>Provider</label>
                <select value={provider} onChange={(e) => { setProvider(e.target.value); setSecret(null); }} className={INPUT}>
                  <option value="vault">HashiCorp Vault</option>
                  <option value="aws">AWS Secrets Manager</option>
                  <option value="azure">Azure Key Vault</option>
                  <option value="gcp">GCP Secret Manager</option>
                </select>
              </div>

              <div>
                <label className={LABEL}>Reference</label>
                <input value={ref} onChange={(e) => setRef(e.target.value)} className={INPUT} />
                <p className="text-[10px] text-gray-400 mt-1">vault: KV path · aws: secret id · azure: secret name · gcp: resource id</p>
              </div>

              <TextField label="Key (optional — extract a key from a JSON secret)" value={secretKey} onChange={setSecretKey} />

              {provider === 'vault' && (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <TextField label="Vault address" value={vaultAddr} onChange={setVaultAddr} placeholder="https://vault.example.com" />
                  <TextField label="Vault token" value={vaultToken} onChange={setVaultToken} type="password" />
                </div>
              )}
              {provider === 'aws' && (
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                  <TextField label="Region" value={region} onChange={setRegion} placeholder="us-east-1" />
                  <TextField label="Access key id" value={accessKeyId} onChange={setAccessKeyId} />
                  <TextField label="Secret access key" value={secretAccessKey} onChange={setSecretAccessKey} type="password" />
                </div>
              )}
              {provider === 'azure' && (
                <TextField label="Vault URL" value={vaultUrl} onChange={setVaultUrl} placeholder="https://my-vault.vault.azure.net" />
              )}
              {provider === 'gcp' && (
                <TextField label="Project id" value={projectId} onChange={setProjectId} />
              )}

              <div className="flex items-center justify-end gap-2">
                <button type="button" onClick={() => void resolve(false)} disabled={busy || !ref.trim()} className={SECONDARY_BTN}>
                  {busy ? <Spinner className="w-3.5 h-3.5 animate-spin" /> : <Eye className="w-3.5 h-3.5" />}Resolve (masked)
                </button>
                <button type="button" onClick={() => void resolve(true)} disabled={busy || !ref.trim()} className={PRIMARY_BTN}>
                  <Eye className="w-3.5 h-3.5" />Reveal
                </button>
              </div>

              {secret && (
                secret.ok ? (
                  <div className="rounded-lg border border-[#E4E0F5] bg-[#FAF9FE] p-3">
                    <label className={LABEL}>Resolved value</label>
                    <div className="flex items-center gap-1.5">
                      <code className="flex-1 min-w-0 truncate text-[11px] font-mono text-[#6D28D9] bg-[#F5F3FF] border border-[#DDD6FE] rounded px-2 py-1.5">{secret.value ?? secret.valueMasked ?? ''}</code>
                      <CopyButton text={secret.value ?? secret.valueMasked ?? ''} />
                    </div>
                  </div>
                ) : (
                  <div className="flex items-start gap-2 px-3 py-2 bg-red-50 border border-red-200 rounded-lg">
                    <AlertTriangle className="w-4 h-4 text-red-500 flex-shrink-0 mt-px" /><p className="text-[12px] text-red-700 min-w-0 whitespace-pre-wrap break-words">{secret.error || 'Could not resolve the secret.'}</p>
                  </div>
                )
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
