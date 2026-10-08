/**
 * api-access.service.ts
 * ─────────────────────
 * Enterprise access control — ADDITIVE and opt-in. Nothing here changes the
 * existing authMiddleware or /api/auth/login; it adds, alongside them:
 *   - RBAC: a permission catalogue + role→permission mappings + a hasPermission
 *     helper (apps can consult it; nothing is retroactively enforced).
 *   - SSO (OIDC): store/test an OIDC provider and a token-exchange that maps an
 *     IdP user to a tenant user and issues the SAME app token (reuses signToken).
 *     SAML is stored as config (ACS flow flagged as a follow-up).
 *   - SCIM: a per-tenant token + user provisioning (create / deactivate) against
 *     the existing users table.
 * The generate → execute → heal pipeline is never involved.
 */
import { randomBytes, createHmac } from 'crypto';
import type { Request, Response, NextFunction } from 'express';
import pool from '../db.js';
import { signToken } from '../utils/jwt.js';
import { encryptField, decryptStored } from '../utils/crypto.js';

/* ────────────────────────────────────────────────────────────────
   RBAC
   ──────────────────────────────────────────────────────────────── */

export interface PermissionDef { key: string; label: string; group: string }
export const PERMISSION_CATALOG: PermissionDef[] = [
  { key: 'api.run', label: 'Run / generate tests', group: 'Core' },
  { key: 'api.import', label: 'Import APIs', group: 'Core' },
  { key: 'api.delete_endpoints', label: 'Delete endpoints', group: 'Core' },
  { key: 'api.security_scan', label: 'Security / OWASP / fuzz', group: 'Quality' },
  { key: 'api.load_test', label: 'Load / geo / cloud load', group: 'Quality' },
  { key: 'api.chaos', label: 'Chaos / fault injection', group: 'Quality' },
  { key: 'api.db_validate', label: 'Database validation', group: 'Quality' },
  { key: 'api.mock_manage', label: 'Manage mocks', group: 'Virtualization' },
  { key: 'api.virtual_manage', label: 'Manage virtual services', group: 'Virtualization' },
  { key: 'api.pact_manage', label: 'Manage Pact broker', group: 'Contracts' },
  { key: 'api.providers_manage', label: 'Manage LLM providers', group: 'Admin' },
  { key: 'api.mcp_manage', label: 'Manage MCP tokens', group: 'Admin' },
  { key: 'api.oauth_secrets', label: 'OAuth / secret managers', group: 'Admin' },
  { key: 'api.schedules_manage', label: 'Manage schedules & webhooks', group: 'Admin' },
  { key: 'api.access_manage', label: 'Manage access (RBAC/SSO/SCIM)', group: 'Admin' },
  { key: 'api.reviews_signoff', label: 'Sign off runs', group: 'Governance' },
  { key: 'api.quarantine_manage', label: 'Manage quarantine', group: 'Governance' },
];
const ALL_PERMS = PERMISSION_CATALOG.map((p) => p.key);
const DEFAULT_ROLE_PERMS: Record<string, string[]> = {
  admin: ALL_PERMS,
  qa_lead: ALL_PERMS.filter((p) => p !== 'api.access_manage'),
  qa_engineer: ['api.run', 'api.import', 'api.security_scan', 'api.load_test', 'api.chaos', 'api.db_validate', 'api.reviews_signoff', 'api.quarantine_manage'],
  viewer: [],
};

export async function getRolePermissions(tenantId: string): Promise<Record<string, string[]>> {
  const { rows } = await pool.query(`SELECT role, permission FROM api_role_permissions WHERE tenant_id = $1`, [tenantId]);
  if (!rows.length) return { ...DEFAULT_ROLE_PERMS };       // defaults until the admin customises
  const out: Record<string, string[]> = {};
  for (const r of rows) { (out[r.role] ||= []).push(r.permission); }
  // Ensure known roles appear even if they have no rows.
  for (const role of Object.keys(DEFAULT_ROLE_PERMS)) out[role] ||= [];
  return out;
}

export async function setRolePermissions(tenantId: string, role: string, permissions: string[]): Promise<Record<string, string[]>> {
  const clean = [...new Set((permissions || []).filter((p) => ALL_PERMS.includes(p)))];
  await pool.query(`DELETE FROM api_role_permissions WHERE tenant_id = $1 AND role = $2`, [tenantId, role]);
  for (const perm of clean) {
    await pool.query(`INSERT INTO api_role_permissions (tenant_id, role, permission) VALUES ($1, $2, $3)`, [tenantId, role, perm]);
  }
  return getRolePermissions(tenantId);
}

export async function hasPermission(tenantId: string, role: string, permission: string): Promise<boolean> {
  const map = await getRolePermissions(tenantId);
  return (map[role] || []).includes(permission);
}

/* ────────────────────────────────────────────────────────────────
   SSO (OIDC) + SAML config
   ──────────────────────────────────────────────────────────────── */

export interface SsoConfigView { type: 'oidc' | 'saml' | 'none'; enabled: boolean; issuer: string; clientId: string; hasSecret: boolean; samlEntryPoint: string; defaultRole: string }

export async function getSsoConfig(tenantId: string): Promise<SsoConfigView> {
  const { rows } = await pool.query(`SELECT config, status FROM api_sso_config WHERE tenant_id = $1`, [tenantId]);
  if (!rows.length) return { type: 'none', enabled: false, issuer: '', clientId: '', hasSecret: false, samlEntryPoint: '', defaultRole: 'qa_engineer' };
  const c = typeof rows[0].config === 'string' ? JSON.parse(rows[0].config) : rows[0].config;
  return { type: c.type || 'oidc', enabled: rows[0].status === 'connected', issuer: c.issuer || '', clientId: c.clientId || '', hasSecret: !!c.clientSecret, samlEntryPoint: c.samlEntryPoint || '', defaultRole: c.defaultRole || 'qa_engineer' };
}

export async function saveSsoConfig(tenantId: string, input: { type?: string; enabled?: boolean; issuer?: string; clientId?: string; clientSecret?: string; samlEntryPoint?: string; samlCert?: string; defaultRole?: string }): Promise<SsoConfigView> {
  const { rows: ex } = await pool.query(`SELECT config FROM api_sso_config WHERE tenant_id = $1`, [tenantId]);
  const prev = ex.length ? (typeof ex[0].config === 'string' ? JSON.parse(ex[0].config) : ex[0].config) : {};
  const cfg: Record<string, unknown> = {
    type: input.type === 'saml' ? 'saml' : 'oidc',
    issuer: String(input.issuer ?? prev.issuer ?? '').slice(0, 500),
    clientId: String(input.clientId ?? prev.clientId ?? '').slice(0, 300),
    samlEntryPoint: String(input.samlEntryPoint ?? prev.samlEntryPoint ?? '').slice(0, 500),
    samlCert: input.samlCert ? String(input.samlCert).slice(0, 8000) : prev.samlCert,
    defaultRole: String(input.defaultRole ?? prev.defaultRole ?? 'qa_engineer').slice(0, 50),
    clientSecret: prev.clientSecret,
  };
  if (input.clientSecret && !input.clientSecret.includes('•') && !input.clientSecret.includes('*')) cfg.clientSecret = encryptField(input.clientSecret);
  const status = input.enabled ? 'connected' : 'disconnected';
  await pool.query(
    `MERGE INTO api_sso_config WITH (HOLDLOCK) AS t
      USING (SELECT $1 AS tenant_id) AS s ON t.tenant_id = s.tenant_id
      WHEN MATCHED THEN UPDATE SET config = $2, status = $3, updated_at = SYSUTCDATETIME()
      WHEN NOT MATCHED THEN INSERT (tenant_id, config, status) VALUES ($1, $2, $3);`,
    [tenantId, JSON.stringify(cfg), status],
  );
  return getSsoConfig(tenantId);
}

export async function testOidcDiscovery(issuer: string): Promise<{ ok: boolean; authorizationEndpoint?: string; tokenEndpoint?: string; userinfoEndpoint?: string; error?: string }> {
  try {
    if (!/^https?:\/\//i.test(issuer)) throw new Error('issuer must be an absolute https URL.');
    const res = await fetch(`${issuer.replace(/\/+$/, '')}/.well-known/openid-configuration`, { signal: AbortSignal.timeout(15000) });
    if (!res.ok) throw new Error(`discovery ${res.status}`);
    const d: any = await res.json();
    return { ok: true, authorizationEndpoint: d.authorization_endpoint, tokenEndpoint: d.token_endpoint, userinfoEndpoint: d.userinfo_endpoint };
  } catch (e) { return { ok: false, error: (e as Error).message }; }
}

export async function buildOidcStartUrl(tenantId: string, redirectUri: string, state: string): Promise<string> {
  const { rows } = await pool.query(`SELECT config FROM api_sso_config WHERE tenant_id = $1`, [tenantId]);
  if (!rows.length) throw new Error('SSO is not configured.');
  const c = typeof rows[0].config === 'string' ? JSON.parse(rows[0].config) : rows[0].config;
  const disco = await testOidcDiscovery(c.issuer);
  if (!disco.ok || !disco.authorizationEndpoint) throw new Error(`OIDC discovery failed: ${disco.error || 'no authorization endpoint'}`);
  const u = new URL(disco.authorizationEndpoint);
  u.searchParams.set('client_id', c.clientId);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('scope', 'openid email profile');
  u.searchParams.set('redirect_uri', redirectUri);
  u.searchParams.set('state', state);
  return u.toString();
}

/** Exchange an OIDC authorization code → an IntelliQE app token (provisioning the user if needed). */
export async function exchangeOidcCode(tenantId: string, code: string, redirectUri: string): Promise<{ token: string; user: { username: string; role: string; displayName: string } }> {
  const { rows } = await pool.query(`SELECT config, status FROM api_sso_config WHERE tenant_id = $1`, [tenantId]);
  if (!rows.length || rows[0].status !== 'connected') throw new Error('SSO is not enabled for this tenant.');
  const c = typeof rows[0].config === 'string' ? JSON.parse(rows[0].config) : rows[0].config;
  const disco = await testOidcDiscovery(c.issuer);
  if (!disco.ok || !disco.tokenEndpoint) throw new Error(`OIDC discovery failed: ${disco.error}`);

  const form = new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: redirectUri, client_id: c.clientId });
  if (c.clientSecret) form.set('client_secret', decryptStored(c.clientSecret));
  const tr = await fetch(disco.tokenEndpoint, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form.toString(), signal: AbortSignal.timeout(20000) });
  const td: any = await tr.json().catch(() => ({}));
  if (!tr.ok || !td.access_token) throw new Error(`Token exchange failed: ${td.error_description || td.error || tr.status}`);

  let claims: any = {};
  if (disco.userinfoEndpoint) {
    const ur = await fetch(disco.userinfoEndpoint, { headers: { authorization: `Bearer ${td.access_token}` }, signal: AbortSignal.timeout(15000) });
    claims = await ur.json().catch(() => ({}));
  }
  const email = String(claims.email || '').toLowerCase();
  const username = String(claims.preferred_username || email || claims.sub || '').slice(0, 100);
  if (!username) throw new Error('The IdP returned no usable username/email.');
  const displayName = String(claims.name || username).slice(0, 200);

  const user = await findOrCreateSsoUser(tenantId, username, email, displayName, c.defaultRole || 'qa_engineer');
  const { rows: tn } = await pool.query(`SELECT id, name, is_platform FROM tenants WHERE id = $1`, [tenantId]);
  const token = signToken({ sub: user.username, uid: user.id, role: user.role, tid: tenantId, tn: tn[0]?.name, pf: tn[0]?.is_platform } as any);
  return { token, user: { username: user.username, role: user.role, displayName } };
}

async function findOrCreateSsoUser(tenantId: string, username: string, email: string, fullName: string, defaultRole: string): Promise<{ id: string; username: string; role: string }> {
  const { rows } = await pool.query(`SELECT id, username, role FROM users WHERE username = $1 OR (email IS NOT NULL AND email = $2)`, [username, email || '\u0000']);
  if (rows.length) return { id: String(rows[0].id), username: rows[0].username, role: rows[0].role };
  // Provision a new SSO-only user with an unusable random password (login is via SSO).
  const randomHash = `__sso__${randomBytes(24).toString('hex')}`;
  const { rows: ins } = await pool.query(
    `INSERT INTO users (tenant_id, username, password_hash, email, full_name, role, is_active)
     OUTPUT INSERTED.id, INSERTED.username, INSERTED.role VALUES ($1, $2, $3, $4, $5, $6, 1)`,
    [tenantId, username, randomHash, email || null, fullName, defaultRole],
  );
  return { id: String(ins[0].id), username: ins[0].username, role: ins[0].role };
}

/* ────────────────────────────────────────────────────────────────
   SCIM provisioning
   ──────────────────────────────────────────────────────────────── */

export async function getScimToken(tenantId: string): Promise<{ hasToken: boolean; token?: string; baseUrl: string }> {
  const { rows } = await pool.query(`SELECT token FROM api_scim_tokens WHERE tenant_id = $1`, [tenantId]);
  return { hasToken: rows.length > 0, token: rows[0]?.token, baseUrl: '/scim/v2' };
}
export async function rotateScimToken(tenantId: string): Promise<{ token: string }> {
  const token = `scim_${randomBytes(20).toString('hex')}`;
  await pool.query(
    `MERGE INTO api_scim_tokens WITH (HOLDLOCK) AS t USING (SELECT $1 AS tenant_id) AS s ON t.tenant_id = s.tenant_id
      WHEN MATCHED THEN UPDATE SET token = $2, created_at = SYSUTCDATETIME()
      WHEN NOT MATCHED THEN INSERT (tenant_id, token) VALUES ($1, $2);`,
    [tenantId, token],
  );
  return { token };
}
export async function revokeScimToken(tenantId: string): Promise<boolean> {
  const { rowCount } = await pool.query(`DELETE FROM api_scim_tokens WHERE tenant_id = $1`, [tenantId]);
  return rowCount > 0;
}
export async function resolveScimToken(token: string): Promise<string | null> {
  if (!token || !/^scim_[a-f0-9]{40}$/.test(token)) return null;
  const { rows } = await pool.query(`SELECT tenant_id FROM api_scim_tokens WHERE token = $1`, [token]);
  return rows.length ? String(rows[0].tenant_id) : null;
}

/** Minimal SCIM 2.0 user ops against the existing users table. */
export async function scimListUsers(tenantId: string): Promise<any> {
  const { rows } = await pool.query(`SELECT id, username, email, full_name, is_active FROM users WHERE tenant_id = $1`, [tenantId]);
  return {
    schemas: ['urn:ietf:params:scim:api:messages:2.0:ListResponse'],
    totalResults: rows.length,
    Resources: rows.map(scimUser),
  };
}
function scimUser(r: any): any {
  return { schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'], id: String(r.id), userName: r.username, active: r.is_active === true || r.is_active === 1, displayName: r.full_name || r.username, emails: r.email ? [{ value: r.email, primary: true }] : [] };
}
export async function scimCreateUser(tenantId: string, body: any): Promise<any> {
  const username = String(body?.userName || '').slice(0, 100);
  if (!username) throw new Error('userName is required');
  const email = String(body?.emails?.[0]?.value || '').slice(0, 300) || null;
  const fullName = String(body?.displayName || body?.name?.formatted || username).slice(0, 200);
  const randomHash = `__scim__${randomBytes(24).toString('hex')}`;
  const { rows } = await pool.query(
    `INSERT INTO users (tenant_id, username, password_hash, email, full_name, role, is_active)
     OUTPUT INSERTED.id, INSERTED.username, INSERTED.email, INSERTED.full_name, INSERTED.is_active
     VALUES ($1, $2, $3, $4, $5, 'qa_engineer', $6)`,
    [tenantId, username, randomHash, email, fullName, body?.active === false ? 0 : 1],
  );
  return scimUser(rows[0]);
}
export async function scimSetActive(tenantId: string, id: string, active: boolean): Promise<any> {
  const { rows } = await pool.query(`UPDATE users SET is_active = $3 OUTPUT INSERTED.id, INSERTED.username, INSERTED.email, INSERTED.full_name, INSERTED.is_active WHERE tenant_id = $1 AND id = $2`, [tenantId, id, active ? 1 : 0]);
  if (!rows.length) throw new Error('User not found');
  return scimUser(rows[0]);
}

/* ════════════════════════════════════════════════════════════════
   Identity hardening — ADDITIVE and GUARDED. Every piece here is a
   no-op until a tenant explicitly opts in: with no api_security_settings
   row and no per-user mfa_secret, password login is byte-identical.
   ════════════════════════════════════════════════════════════════ */

export interface PasswordPolicy { minLength: number; requireUpper: boolean; requireNumber: boolean; requireSymbol: boolean }
export interface SecuritySettings { ssoEnforced: boolean; mfaRequired: boolean; passwordPolicy: PasswordPolicy }
const DEFAULT_SECURITY: SecuritySettings = { ssoEnforced: false, mfaRequired: false, passwordPolicy: { minLength: 0, requireUpper: false, requireNumber: false, requireSymbol: false } };

export async function getSecuritySettings(tenantId: string): Promise<SecuritySettings> {
  try {
    const { rows } = await pool.query(`SELECT settings FROM api_security_settings WHERE tenant_id = $1`, [tenantId]);
    if (!rows.length) return { ...DEFAULT_SECURITY };
    const s = typeof rows[0].settings === 'string' ? JSON.parse(rows[0].settings) : (rows[0].settings || {});
    return {
      ssoEnforced: !!s.ssoEnforced,
      mfaRequired: !!s.mfaRequired,
      passwordPolicy: {
        minLength: Math.max(0, Math.min(128, Number(s?.passwordPolicy?.minLength) || 0)),
        requireUpper: !!s?.passwordPolicy?.requireUpper,
        requireNumber: !!s?.passwordPolicy?.requireNumber,
        requireSymbol: !!s?.passwordPolicy?.requireSymbol,
      },
    };
  } catch {
    return { ...DEFAULT_SECURITY };   // table missing / any error ⇒ defaults so login never breaks
  }
}

export async function saveSecuritySettings(tenantId: string, input: Partial<SecuritySettings>): Promise<SecuritySettings> {
  const cur = await getSecuritySettings(tenantId);
  const next: SecuritySettings = {
    ssoEnforced: input.ssoEnforced != null ? !!input.ssoEnforced : cur.ssoEnforced,
    mfaRequired: input.mfaRequired != null ? !!input.mfaRequired : cur.mfaRequired,
    passwordPolicy: { ...cur.passwordPolicy, ...(input.passwordPolicy || {}) },
  };
  await pool.query(
    `MERGE INTO api_security_settings WITH (HOLDLOCK) AS t USING (SELECT $1 AS tenant_id) AS s ON t.tenant_id = s.tenant_id
      WHEN MATCHED THEN UPDATE SET settings = $2, updated_at = SYSUTCDATETIME()
      WHEN NOT MATCHED THEN INSERT (tenant_id, settings) VALUES ($1, $2);`,
    [tenantId, JSON.stringify(next)],
  );
  return next;
}

/** Validate a password against a policy. Returns an error message, or null if OK. */
export function validatePassword(policy: PasswordPolicy, password: string): string | null {
  const p = String(password || '');
  if (policy.minLength && p.length < policy.minLength) return `Password must be at least ${policy.minLength} characters.`;
  if (policy.requireUpper && !/[A-Z]/.test(p)) return 'Password must include an uppercase letter.';
  if (policy.requireNumber && !/[0-9]/.test(p)) return 'Password must include a number.';
  if (policy.requireSymbol && !/[^A-Za-z0-9]/.test(p)) return 'Password must include a symbol.';
  return null;
}

/* ── TOTP (RFC 6238) — no external dependency ── */
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function base32Encode(buf: Buffer): string {
  let bits = 0, value = 0, out = '';
  for (const b of buf) { value = (value << 8) | b; bits += 8; while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; } }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}
function base32Decode(s: string): Buffer {
  const clean = String(s || '').toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0, value = 0; const out: number[] = [];
  for (const ch of clean) { const idx = B32.indexOf(ch); if (idx < 0) continue; value = (value << 5) | idx; bits += 5; if (bits >= 8) { out.push((value >>> (bits - 8)) & 0xff); bits -= 8; } }
  return Buffer.from(out);
}
function hotp(secret: Buffer, counter: number): string {
  const buf = Buffer.alloc(8);
  buf.writeUInt32BE(Math.floor(counter / 0x100000000), 0);
  buf.writeUInt32BE(counter >>> 0, 4);
  const h = createHmac('sha1', secret).update(buf).digest();
  const offset = h[h.length - 1]! & 0xf;
  const bin = ((h[offset]! & 0x7f) << 24) | ((h[offset + 1]! & 0xff) << 16) | ((h[offset + 2]! & 0xff) << 8) | (h[offset + 3]! & 0xff);
  return String(bin % 1_000_000).padStart(6, '0');
}
export function generateTotpSecret(): string { return base32Encode(randomBytes(20)); }
export function verifyTotp(secretB32: string, code: string, window = 1): boolean {
  const c = String(code || '').replace(/\D/g, '');
  if (c.length !== 6) return false;
  const secret = base32Decode(secretB32);
  if (!secret.length) return false;
  const step = Math.floor(Date.now() / 30000);
  for (let w = -window; w <= window; w++) { if (hotp(secret, step + w) === c) return true; }
  return false;
}
export function otpauthUrl(secretB32: string, account: string, issuer = 'IntelliQE'): string {
  const label = encodeURIComponent(`${issuer}:${account}`);
  const params = new URLSearchParams({ secret: secretB32, issuer, algorithm: 'SHA1', digits: '6', period: '30' });
  return `otpauth://totp/${label}?${params.toString()}`;
}

/* ── Per-user MFA enrolment (mfa_secret column, encrypted at rest) ── */
export async function getUserMfaSecret(userId: string): Promise<string | null> {
  try {
    const { rows } = await pool.query(`SELECT mfa_secret FROM users WHERE id = $1`, [userId]);
    const v = rows[0]?.mfa_secret;
    return v ? decryptStored(v) : null;
  } catch { return null; }   // column missing ⇒ no MFA (login unchanged)
}
export function beginMfaEnrollment(account: string): { secret: string; otpauthUrl: string } {
  const secret = generateTotpSecret();
  return { secret, otpauthUrl: otpauthUrl(secret, account || 'user') };
}
export async function confirmMfaEnrollment(userId: string, secret: string, code: string): Promise<boolean> {
  if (!verifyTotp(secret, code)) return false;
  await pool.query(`UPDATE users SET mfa_secret = $2 WHERE id = $1`, [userId, encryptField(secret)]);
  return true;
}
export async function disableMfa(userId: string): Promise<boolean> {
  const { rowCount } = await pool.query(`UPDATE users SET mfa_secret = NULL WHERE id = $1`, [userId]);
  return rowCount > 0;
}
export async function userHasMfa(userId: string): Promise<boolean> {
  try { const { rows } = await pool.query(`SELECT mfa_secret FROM users WHERE id = $1`, [userId]); return !!rows[0]?.mfa_secret; }
  catch { return false; }
}

/* ── RBAC enforcement middleware factory (apply to routes opt-in) ── */
export function requirePermission(permission: string) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const u = req.user;
    if (!u) { res.status(401).json({ error: 'Unauthorized' }); return; }
    try {
      if (u.isPlatform || u.role === 'admin') { next(); return; }   // platform/admin bypass
      const ok = await hasPermission(u.tenantId, u.role, permission);
      if (!ok) { res.status(403).json({ error: `Your role (${u.role}) lacks the "${permission}" permission.` }); return; }
      next();
    } catch { next(); }   // fail-open on lookup error → never hard-break a route
  };
}

/* ── SAML 2.0 ACS (pragmatic assertion parse; see note) ──
   NOTE: this extracts the NameID/attributes and (when a cert is configured)
   checks the response is signed, but does NOT perform full XML-DSig signature
   validation — production should add that (e.g. an xml-crypto dependency). It is
   enough to complete the SP-side login flow in trusted/test setups. */
export interface SamlAcsResult { token: string; user: { username: string; role: string; displayName: string } }

function samlExtractTag(xml: string, tag: string): string | undefined {
  const m = new RegExp(`<(?:[\\w-]+:)?${tag}\\b[^>]*>([\\s\\S]*?)</(?:[\\w-]+:)?${tag}>`, 'i').exec(xml);
  return m ? m[1]!.trim() : undefined;
}
function samlExtractAttr(xml: string, name: string): string | undefined {
  const m = new RegExp(`<(?:[\\w-]+:)?Attribute\\b[^>]*Name="${name}"[^>]*>([\\s\\S]*?)</(?:[\\w-]+:)?Attribute>`, 'i').exec(xml);
  if (!m) return undefined;
  return samlExtractTag(m[1]!, 'AttributeValue');
}

export async function processSamlResponse(tenantId: string, samlResponseB64: string): Promise<SamlAcsResult> {
  const { rows } = await pool.query(`SELECT config, status FROM api_sso_config WHERE tenant_id = $1`, [tenantId]);
  if (!rows.length || rows[0].status !== 'connected') throw new Error('SSO is not enabled for this tenant.');
  const c = typeof rows[0].config === 'string' ? JSON.parse(rows[0].config) : rows[0].config;
  const xml = Buffer.from(String(samlResponseB64 || '').replace(/\s/g, ''), 'base64').toString('utf-8');
  if (!/Assertion/i.test(xml)) throw new Error('No SAML assertion found in the response.');
  if (c.samlCert && !/<(?:[\w-]+:)?Signature\b/i.test(xml)) throw new Error('A signing certificate is configured but the SAML response is not signed.');

  const nameId = samlExtractTag(xml, 'NameID');
  const email = samlExtractAttr(xml, 'email') || samlExtractAttr(xml, 'mail') || samlExtractAttr(xml, 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress') || (nameId && nameId.includes('@') ? nameId : undefined);
  const username = String(email || nameId || '').slice(0, 100);
  if (!username) throw new Error('The SAML assertion carried no NameID or email.');
  const fullName = samlExtractAttr(xml, 'displayName') || samlExtractAttr(xml, 'name') || username;

  const user = await findOrCreateSsoUser(tenantId, username, String(email || ''), fullName, c.defaultRole || 'qa_engineer');
  const { rows: tn } = await pool.query(`SELECT id, name, is_platform FROM tenants WHERE id = $1`, [tenantId]);
  const token = signToken({ sub: user.username, uid: user.id, role: user.role, tid: tenantId, tn: tn[0]?.name, pf: tn[0]?.is_platform } as any);
  return { token, user: { username: user.username, role: user.role, displayName: fullName } };
}

export function samlSpMetadata(acsUrl: string, entityId: string): string {
  return `<?xml version="1.0"?>
<EntityDescriptor xmlns="urn:oasis:names:tc:SAML:2.0:metadata" entityID="${entityId}">
  <SPSSODescriptor protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol" AuthnRequestsSigned="false" WantAssertionsSigned="true">
    <NameIDFormat>urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress</NameIDFormat>
    <AssertionConsumerService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST" Location="${acsUrl}" index="0" isDefault="true"/>
  </SPSSODescriptor>
</EntityDescriptor>`;
}
