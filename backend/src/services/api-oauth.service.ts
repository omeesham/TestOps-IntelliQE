/**
 * api-oauth.service.ts
 * ────────────────────
 * OAuth2/OIDC token automation + external secret-manager resolution. Acquire a
 * token via the standard grants (client_credentials, password, refresh_token,
 * authorization_code), optionally saving reusable named configs, and resolve a
 * secret from HashiCorp Vault / AWS Secrets Manager / Azure Key Vault / GCP
 * Secret Manager — so the resolved value can be pasted into an environment
 * variable instead of a static credential sitting in the catalogue.
 *
 * Standalone and opt-in: cloud SDKs are OPTIONAL dependencies loaded dynamically
 * (clean "not installed" when absent); Vault uses plain fetch. Secrets are
 * encrypted at rest with the shared crypto helper. The pipeline is never involved.
 */
import pool from '../db.js';
import { encryptField, decryptStored, maskSecret } from '../utils/crypto.js';
import type { HttpAuth } from '../utils/api-http.js';

async function optional(moduleName: string): Promise<any> {
  try { const spec = moduleName; return await import(spec); }
  catch { throw new Error(`The "${moduleName}" package is not installed on this server. Run: npm install ${moduleName}`); }
}

/* ────────────────────────────────────────────────────────────────
   OAuth2 token acquisition
   ──────────────────────────────────────────────────────────────── */

export type OAuthGrant = 'client_credentials' | 'password' | 'refresh_token' | 'authorization_code';

export interface OAuthRequest {
  grant: OAuthGrant;
  tokenUrl: string;
  clientId?: string;
  clientSecret?: string;
  scope?: string;
  audience?: string;
  username?: string;
  password?: string;
  refreshToken?: string;
  code?: string;
  redirectUri?: string;
  /** Send client creds in an HTTP Basic header instead of the body. */
  clientAuthBasic?: boolean;
}

export interface OAuthToken { accessToken: string; tokenType: string; expiresIn?: number; refreshToken?: string; scope?: string; raw: Record<string, unknown> }

export async function fetchOAuthToken(req: OAuthRequest): Promise<OAuthToken> {
  if (!/^https?:\/\//i.test(req.tokenUrl || '')) throw new Error('tokenUrl must be an absolute http(s) URL.');
  const form = new URLSearchParams();
  form.set('grant_type', req.grant);
  if (req.scope) form.set('scope', req.scope);
  if (req.audience) form.set('audience', req.audience);
  if (req.grant === 'password') { form.set('username', req.username || ''); form.set('password', req.password || ''); }
  if (req.grant === 'refresh_token') form.set('refresh_token', req.refreshToken || '');
  if (req.grant === 'authorization_code') { form.set('code', req.code || ''); if (req.redirectUri) form.set('redirect_uri', req.redirectUri); }

  const headers: Record<string, string> = { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' };
  if (req.clientAuthBasic && req.clientId) headers.authorization = `Basic ${Buffer.from(`${req.clientId}:${req.clientSecret || ''}`).toString('base64')}`;
  else { if (req.clientId) form.set('client_id', req.clientId); if (req.clientSecret) form.set('client_secret', req.clientSecret); }

  const res = await fetch(req.tokenUrl, { method: 'POST', headers, body: form.toString(), signal: AbortSignal.timeout(30_000) });
  const text = await res.text();
  let data: any; try { data = JSON.parse(text); } catch { data = { raw: text }; }
  if (!res.ok) throw new Error(`Token endpoint error (${res.status}): ${data?.error_description || data?.error || text.slice(0, 200)}`);
  const accessToken = data.access_token;
  if (!accessToken) throw new Error('Token endpoint returned no access_token.');
  return { accessToken, tokenType: data.token_type || 'Bearer', expiresIn: data.expires_in, refreshToken: data.refresh_token, scope: data.scope, raw: data };
}

/**
 * Resolve an `oauth2` request-auth into a bearer-ready auth by fetching a token.
 * No-op for any other auth type, or when a token value is already present. This
 * lives here (not in api-http) so the HTTP helper stays dependency-free.
 */
export async function resolveHttpAuth(auth?: HttpAuth): Promise<HttpAuth | undefined> {
  if (!auth || auth.type !== 'oauth2' || auth.value || !auth.oauth2) return auth;
  const cfg = auth.oauth2;
  const tok = await fetchOAuthToken({
    grant: (cfg.grant as OAuthGrant) || 'client_credentials',
    tokenUrl: cfg.tokenUrl || '',
    clientId: cfg.clientId,
    clientSecret: cfg.clientSecret,
    scope: cfg.scope,
    audience: cfg.audience,
    username: cfg.username,
    password: cfg.password,
    refreshToken: cfg.refreshToken,
    clientAuthBasic: cfg.clientAuthBasic,
  });
  return { type: 'oauth2', value: tok.accessToken };
}

/* ── Saved OAuth configs (client secret encrypted) ── */

export interface OAuthConfig { id: string; name: string; grant: OAuthGrant; tokenUrl: string; clientId: string; scope: string; hasSecret: boolean; createdAt: string }

function mapConfig(r: any): OAuthConfig {
  const cfg = typeof r.config === 'string' ? JSON.parse(r.config) : (r.config || {});
  return { id: String(r.id), name: r.name, grant: cfg.grant || 'client_credentials', tokenUrl: cfg.tokenUrl || '', clientId: cfg.clientId || '', scope: cfg.scope || '', hasSecret: !!cfg.clientSecret, createdAt: r.created_at };
}

export async function listOAuthConfigs(tenantId: string): Promise<OAuthConfig[]> {
  const { rows } = await pool.query(`SELECT * FROM api_oauth_configs WHERE tenant_id = $1 ORDER BY created_at DESC`, [tenantId]);
  return rows.map(mapConfig);
}

export async function saveOAuthConfig(tenantId: string, username: string, input: OAuthRequest & { id?: string; name?: string }): Promise<OAuthConfig> {
  const name = String(input.name || '').trim().slice(0, 200) || 'OAuth config';
  const cfg: Record<string, unknown> = { grant: input.grant, tokenUrl: input.tokenUrl, clientId: input.clientId || '', scope: input.scope || '', audience: input.audience || '', username: input.username || '', redirectUri: input.redirectUri || '', clientAuthBasic: !!input.clientAuthBasic };
  if (input.clientSecret && !input.clientSecret.includes('•') && !input.clientSecret.includes('*')) cfg.clientSecret = encryptField(input.clientSecret);
  if (input.refreshToken) cfg.refreshToken = encryptField(input.refreshToken);
  if (input.password) cfg.password = encryptField(input.password);
  if (input.id) {
    // Preserve any encrypted fields the caller didn't resend.
    const { rows: ex } = await pool.query(`SELECT config FROM api_oauth_configs WHERE tenant_id = $1 AND id = $2`, [tenantId, input.id]);
    if (ex.length) { const prev = typeof ex[0].config === 'string' ? JSON.parse(ex[0].config) : ex[0].config; for (const k of ['clientSecret', 'refreshToken', 'password']) if (!cfg[k] && prev[k]) cfg[k] = prev[k]; }
    const { rows } = await pool.query(`UPDATE api_oauth_configs SET name = $3, config = $4, updated_at = SYSUTCDATETIME() OUTPUT INSERTED.* WHERE tenant_id = $1 AND id = $2`, [tenantId, input.id, name, JSON.stringify(cfg)]);
    if (!rows.length) throw new Error('OAuth config not found.');
    return mapConfig(rows[0]);
  }
  const { rows } = await pool.query(`INSERT INTO api_oauth_configs (tenant_id, name, config, created_by) OUTPUT INSERTED.* VALUES ($1, $2, $3, $4)`, [tenantId, name, JSON.stringify(cfg), username || '']);
  return mapConfig(rows[0]);
}

export async function deleteOAuthConfig(tenantId: string, id: string): Promise<boolean> {
  const { rowCount } = await pool.query(`DELETE FROM api_oauth_configs WHERE tenant_id = $1 AND id = $2`, [tenantId, id]);
  return rowCount > 0;
}

/** Fetch a token using a saved config (decrypting its secret). */
export async function fetchTokenFromConfig(tenantId: string, id: string): Promise<OAuthToken> {
  const { rows } = await pool.query(`SELECT config FROM api_oauth_configs WHERE tenant_id = $1 AND id = $2`, [tenantId, id]);
  if (!rows.length) throw new Error('OAuth config not found.');
  const cfg = typeof rows[0].config === 'string' ? JSON.parse(rows[0].config) : rows[0].config;
  return fetchOAuthToken({
    grant: cfg.grant, tokenUrl: cfg.tokenUrl, clientId: cfg.clientId, scope: cfg.scope, audience: cfg.audience,
    username: cfg.username, redirectUri: cfg.redirectUri, clientAuthBasic: cfg.clientAuthBasic,
    clientSecret: cfg.clientSecret ? decryptStored(cfg.clientSecret) : undefined,
    refreshToken: cfg.refreshToken ? decryptStored(cfg.refreshToken) : undefined,
    password: cfg.password ? decryptStored(cfg.password) : undefined,
  });
}

/* ────────────────────────────────────────────────────────────────
   Secret-manager resolution
   ──────────────────────────────────────────────────────────────── */

export type SecretProvider = 'vault' | 'aws' | 'azure' | 'gcp';
export interface SecretRequest {
  provider: SecretProvider;
  /** vault: KV path (e.g. secret/data/app). aws: secret id. azure: secret name. gcp: resource name or id. */
  ref: string;
  /** A key inside a JSON/KV secret to extract. */
  key?: string;
  // vault
  vaultAddr?: string;
  vaultToken?: string;
  // aws
  region?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  // azure
  vaultUrl?: string;
  // gcp
  projectId?: string;
}

export interface SecretResult { ok: boolean; valueMasked?: string; value?: string; error?: string }

export async function resolveSecret(req: SecretRequest, reveal = false): Promise<SecretResult> {
  try {
    let value = '';
    if (req.provider === 'vault') {
      if (!req.vaultAddr || !req.vaultToken) throw new Error('Vault needs vaultAddr and vaultToken.');
      const url = `${req.vaultAddr.replace(/\/+$/, '')}/v1/${req.ref.replace(/^\/+/, '')}`;
      const res = await fetch(url, { headers: { 'X-Vault-Token': req.vaultToken }, signal: AbortSignal.timeout(20_000) });
      const data: any = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(`Vault error (${res.status}): ${data?.errors?.join(', ') || res.statusText}`);
      const kv = data?.data?.data ?? data?.data ?? {};         // KV v2 nests under data.data
      value = req.key ? String(kv[req.key] ?? '') : JSON.stringify(kv);
    } else if (req.provider === 'aws') {
      const sdk = await optional('@aws-sdk/client-secrets-manager');
      const client = new sdk.SecretsManagerClient({ region: req.region || 'us-east-1', ...(req.accessKeyId ? { credentials: { accessKeyId: req.accessKeyId, secretAccessKey: req.secretAccessKey || '' } } : {}) });
      const out = await client.send(new sdk.GetSecretValueCommand({ SecretId: req.ref }));
      const raw = out.SecretString || '';
      value = req.key ? String((JSON.parse(raw || '{}'))[req.key] ?? '') : raw;
    } else if (req.provider === 'azure') {
      if (!req.vaultUrl) throw new Error('Azure Key Vault needs vaultUrl.');
      const secrets = await optional('@azure/keyvault-secrets');
      const identity = await optional('@azure/identity');
      const client = new secrets.SecretClient(req.vaultUrl, new identity.DefaultAzureCredential());
      const s = await client.getSecret(req.ref);
      value = s.value || '';
      if (req.key) { try { value = String(JSON.parse(value)[req.key] ?? ''); } catch { /* not JSON */ } }
    } else if (req.provider === 'gcp') {
      const sm = await optional('@google-cloud/secret-manager');
      const client = new sm.SecretManagerServiceClient();
      const name = req.ref.includes('/') ? req.ref : `projects/${req.projectId}/secrets/${req.ref}/versions/latest`;
      const [resp] = await client.accessSecretVersion({ name });
      value = resp?.payload?.data?.toString() || '';
      if (req.key) { try { value = String(JSON.parse(value)[req.key] ?? ''); } catch { /* not JSON */ } }
    } else {
      throw new Error(`Unknown secret provider: ${req.provider}`);
    }
    return { ok: true, valueMasked: maskSecret(value), ...(reveal ? { value } : {}) };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}
