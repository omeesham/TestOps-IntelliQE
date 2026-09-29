/**
 * Microsoft Entra ID (Azure AD) single sign-on.
 *
 * Implements the OAuth 2.0 / OpenID Connect authorization-code flow with
 * PKCE against the Microsoft identity platform (v2.0 endpoints). No MSAL
 * dependency — the flow is small enough to do with `fetch` + `jsonwebtoken`,
 * and Node's `crypto` can import the JWK signing keys Microsoft publishes.
 *
 * Configuration (env):
 *   MS_SSO_CLIENT_ID            App registration (client) ID            — required
 *   MS_SSO_CLIENT_SECRET        Client secret                            — required
 *   MS_SSO_TENANT_ID            Entra tenant ID, or `organizations` /
 *                               `common` for multi-tenant                — default `organizations`
 *   MS_SSO_REDIRECT_URI         Absolute callback URL registered on the
 *                               app; defaults to <request origin>/api/auth/sso/microsoft/callback
 *   MS_SSO_ALLOWED_DOMAINS      Comma-separated email domains allowed to
 *                               sign in (empty = any)                    — optional
 *   MS_SSO_AUTO_PROVISION       Create a user on first sign-in           — default `true`
 *   MS_SSO_DEFAULT_TENANT_SLUG  Tenant new users are placed in           — default `jbs`
 *   MS_SSO_DEFAULT_ROLE         Role new users receive                   — default `qa_engineer`
 *
 * Security notes:
 *   - `state` + PKCE `code_verifier` + OIDC `nonce` are kept server-signed
 *     in a short-lived HttpOnly cookie, so the callback is bound to the
 *     browser that started the flow.
 *   - The ID token is verified (RS256 signature via Microsoft's JWKS,
 *     audience = client ID, issuer = login.microsoftonline.com/{tid}/v2.0,
 *     nonce) even though it arrives over the back-channel — defense in depth.
 */
import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import { logger } from '../utils/logger.js';

export interface MicrosoftSsoConfig {
  clientId: string;
  clientSecret: string;
  tenantId: string;
  redirectUri?: string;
  allowedDomains: string[];
  autoProvision: boolean;
  defaultTenantSlug: string;
  defaultRole: string;
}

export interface MicrosoftIdentity {
  /** Stable object ID of the user in the Entra tenant (`oid` claim). */
  objectId: string;
  /** Entra tenant the user signed in from (`tid` claim). */
  entraTenantId: string;
  email: string;
  displayName: string;
}

export class SsoError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'SsoError';
  }
}

const SCOPES = 'openid profile email';
const VALID_ROLES = new Set(['admin', 'qa_engineer', 'data_analyst']);

export function getMicrosoftSsoConfig(): MicrosoftSsoConfig | null {
  const clientId = process.env.MS_SSO_CLIENT_ID?.trim();
  const clientSecret = process.env.MS_SSO_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) return null;

  const role = (process.env.MS_SSO_DEFAULT_ROLE || 'qa_engineer').trim();
  return {
    clientId,
    clientSecret,
    tenantId: (process.env.MS_SSO_TENANT_ID || 'organizations').trim(),
    redirectUri: process.env.MS_SSO_REDIRECT_URI?.trim() || undefined,
    allowedDomains: (process.env.MS_SSO_ALLOWED_DOMAINS || '')
      .split(',')
      .map((d) => d.trim().toLowerCase().replace(/^@/, ''))
      .filter(Boolean),
    autoProvision: (process.env.MS_SSO_AUTO_PROVISION || 'true').toLowerCase() !== 'false',
    defaultTenantSlug: (process.env.MS_SSO_DEFAULT_TENANT_SLUG || 'jbs').trim(),
    defaultRole: VALID_ROLES.has(role) ? role : 'qa_engineer',
  };
}

export function isMicrosoftSsoEnabled(): boolean {
  return getMicrosoftSsoConfig() !== null;
}

function authority(tenantId: string): string {
  return `https://login.microsoftonline.com/${encodeURIComponent(tenantId)}`;
}

/* ─────────────────────────────────────────────────────────────
   PKCE / state helpers
   ───────────────────────────────────────────────────────────── */
function b64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function createPkcePair(): { verifier: string; challenge: string } {
  const verifier = b64url(crypto.randomBytes(48));
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

export function randomToken(bytes = 24): string {
  return b64url(crypto.randomBytes(bytes));
}

export function buildAuthorizeUrl(
  cfg: MicrosoftSsoConfig,
  params: { redirectUri: string; state: string; nonce: string; codeChallenge: string; loginHint?: string },
): string {
  const url = new URL(`${authority(cfg.tenantId)}/oauth2/v2.0/authorize`);
  url.searchParams.set('client_id', cfg.clientId);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('response_mode', 'query');
  url.searchParams.set('redirect_uri', params.redirectUri);
  url.searchParams.set('scope', SCOPES);
  url.searchParams.set('state', params.state);
  url.searchParams.set('nonce', params.nonce);
  url.searchParams.set('code_challenge', params.codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('prompt', 'select_account');
  if (params.loginHint) url.searchParams.set('login_hint', params.loginHint);
  return url.toString();
}

/* ─────────────────────────────────────────────────────────────
   Token exchange
   ───────────────────────────────────────────────────────────── */
export async function exchangeCodeForIdToken(
  cfg: MicrosoftSsoConfig,
  params: { code: string; redirectUri: string; codeVerifier: string },
): Promise<string> {
  const body = new URLSearchParams({
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
    grant_type: 'authorization_code',
    code: params.code,
    redirect_uri: params.redirectUri,
    code_verifier: params.codeVerifier,
    scope: SCOPES,
  });

  const resp = await fetch(`${authority(cfg.tenantId)}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });

  const json: any = await resp.json().catch(() => ({}));
  if (!resp.ok || !json.id_token) {
    logger.warn('Microsoft SSO token exchange failed', {
      status: resp.status,
      error: json.error,
      description: json.error_description,
    });
    throw new SsoError('token_exchange_failed', json.error_description || 'Token exchange failed');
  }
  return json.id_token as string;
}

/* ─────────────────────────────────────────────────────────────
   ID token verification (JWKS cached per authority)
   ───────────────────────────────────────────────────────────── */
interface JwksCache { fetchedAt: number; keys: Map<string, crypto.KeyObject> }
const jwksCache = new Map<string, JwksCache>();
const JWKS_TTL_MS = 60 * 60 * 1000;

async function loadJwks(tenantId: string, force = false): Promise<Map<string, crypto.KeyObject>> {
  const cached = jwksCache.get(tenantId);
  if (cached && !force && Date.now() - cached.fetchedAt < JWKS_TTL_MS) return cached.keys;

  const resp = await fetch(`${authority(tenantId)}/discovery/v2.0/keys`);
  if (!resp.ok) throw new SsoError('jwks_unavailable', `Could not fetch Microsoft signing keys (${resp.status})`);
  const json: any = await resp.json();
  const keys = new Map<string, crypto.KeyObject>();
  for (const jwk of json.keys || []) {
    if (!jwk.kid) continue;
    try {
      keys.set(jwk.kid, crypto.createPublicKey({ key: jwk, format: 'jwk' }));
    } catch (err) {
      logger.warn('Skipping unparseable JWK', { kid: jwk.kid, err: (err as Error).message });
    }
  }
  jwksCache.set(tenantId, { fetchedAt: Date.now(), keys });
  return keys;
}

export async function verifyIdToken(
  cfg: MicrosoftSsoConfig,
  idToken: string,
  expectedNonce: string,
): Promise<MicrosoftIdentity> {
  const decoded = jwt.decode(idToken, { complete: true });
  if (!decoded || typeof decoded === 'string' || !decoded.header.kid) {
    throw new SsoError('invalid_id_token', 'Malformed ID token');
  }
  const kid = decoded.header.kid;

  let keys = await loadJwks(cfg.tenantId);
  let key = keys.get(kid);
  if (!key) {
    // Key rotation — refresh once before giving up.
    keys = await loadJwks(cfg.tenantId, true);
    key = keys.get(kid);
  }
  if (!key) throw new SsoError('invalid_id_token', 'ID token signed with an unknown key');

  let claims: jwt.JwtPayload;
  try {
    claims = jwt.verify(idToken, key, { algorithms: ['RS256'], audience: cfg.clientId }) as jwt.JwtPayload;
  } catch (err) {
    throw new SsoError('invalid_id_token', `ID token rejected: ${(err as Error).message}`);
  }

  const tid = typeof claims.tid === 'string' ? claims.tid : '';
  const expectedIssuer = `https://login.microsoftonline.com/${tid}/v2.0`;
  if (!tid || claims.iss !== expectedIssuer) {
    throw new SsoError('invalid_id_token', 'ID token issuer mismatch');
  }
  // When pinned to a single Entra tenant, refuse tokens from any other tenant.
  const pinned = !['common', 'organizations', 'consumers'].includes(cfg.tenantId.toLowerCase());
  if (pinned && tid.toLowerCase() !== cfg.tenantId.toLowerCase()) {
    throw new SsoError('tenant_not_allowed', 'Account belongs to a different Microsoft tenant');
  }
  if (claims.nonce !== expectedNonce) {
    throw new SsoError('invalid_id_token', 'ID token nonce mismatch');
  }

  const objectId = typeof claims.oid === 'string' ? claims.oid : '';
  if (!objectId) throw new SsoError('invalid_id_token', 'ID token missing oid claim');

  const email = String(claims.email || claims.preferred_username || '').trim().toLowerCase();
  if (!email || !email.includes('@')) {
    throw new SsoError('no_email', 'Microsoft account has no email/UPN we can use as a username');
  }
  if (cfg.allowedDomains.length > 0) {
    const domain = email.slice(email.lastIndexOf('@') + 1);
    if (!cfg.allowedDomains.includes(domain)) {
      throw new SsoError('domain_not_allowed', `Sign-in from ${domain} is not permitted`);
    }
  }

  return {
    objectId,
    entraTenantId: tid,
    email,
    displayName: String(claims.name || email).trim(),
  };
}
