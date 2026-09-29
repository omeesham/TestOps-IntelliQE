/**
 * Single sign-on routes — mounted at /api/auth/sso (no auth middleware).
 *
 *   GET /providers            → { microsoft: boolean }  (login page discovery)
 *   GET /microsoft            → 302 to Microsoft's authorize endpoint
 *   GET /microsoft/callback   → exchanges the code, mints an app JWT and
 *                               302s to the SPA at /auth/sso/callback#token=…
 *
 * Flow state (OAuth `state`, PKCE verifier, OIDC nonce, return path) lives
 * in a signed, HttpOnly, SameSite=Lax cookie scoped to this path, so it is
 * never visible to page scripts and never round-trips through Microsoft.
 *
 * Errors never surface a stack trace to the browser: the user is bounced
 * back to /login?sso_error=<code> and the login page maps codes to copy.
 */
import { Router, type Request, type Response } from 'express';
import bcrypt from 'bcrypt';
import crypto from 'node:crypto';
import pool from '../db.js';
import { logger } from '../utils/logger.js';
import { signToken, signScopedToken, verifyScopedToken } from '../utils/jwt.js';
import {
  SsoError,
  buildAuthorizeUrl,
  createPkcePair,
  exchangeCodeForIdToken,
  getMicrosoftSsoConfig,
  isMicrosoftSsoEnabled,
  randomToken,
  verifyIdToken,
  type MicrosoftIdentity,
  type MicrosoftSsoConfig,
} from '../services/microsoft-sso.service.js';

const router = Router();

const STATE_COOKIE = 'iq_sso_state';
const STATE_SCOPE = 'sso-state';
const STATE_TTL = '10m';
const STATE_TTL_SECONDS = 10 * 60;
const COOKIE_PATH = '/api/auth/sso';
const SPA_CALLBACK_PATH = '/auth/sso/callback';
const PROVIDER = 'microsoft';

interface SsoState {
  st: string;   // OAuth state
  cv: string;   // PKCE code_verifier
  nc: string;   // OIDC nonce
  rt?: string;  // return path inside the SPA
}

/* ─────────────────────────────────────────────────────────────
   Small helpers
   ───────────────────────────────────────────────────────────── */
function requestOrigin(req: Request): string {
  // `trust proxy` is on in index.ts, so req.protocol honours X-Forwarded-Proto.
  return `${req.protocol}://${req.get('host')}`;
}

function resolveRedirectUri(cfg: MicrosoftSsoConfig, req: Request): string {
  return cfg.redirectUri || `${requestOrigin(req)}/api/auth/sso/microsoft/callback`;
}

/** Only allow same-origin, path-only return targets (no open redirect). */
function safeReturnPath(raw: unknown): string | undefined {
  if (typeof raw !== 'string' || !raw) return undefined;
  if (!raw.startsWith('/') || raw.startsWith('//') || raw.startsWith('/\\')) return undefined;
  if (raw.startsWith('/login') || raw.startsWith(SPA_CALLBACK_PATH)) return undefined;
  return raw.length > 512 ? undefined : raw;
}

function readCookie(req: Request, name: string): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    if (part.slice(0, idx).trim() === name) return decodeURIComponent(part.slice(idx + 1).trim());
  }
  return undefined;
}

function cookieOptions(req: Request) {
  return {
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: req.protocol === 'https',
    path: COOKIE_PATH,
  };
}

function failToLogin(res: Response, code: string): void {
  res.redirect(`/login?sso_error=${encodeURIComponent(code)}`);
}

/* ─────────────────────────────────────────────────────────────
   User lookup / provisioning
   ───────────────────────────────────────────────────────────── */
interface UserRow {
  id: string;
  username: string;
  full_name: string | null;
  role: string;
  is_active: boolean;
  tenant_id: string;
  tenant_name: string;
  is_platform: boolean;
}

const USER_SELECT = `
  SELECT u.id, u.username, u.full_name, u.role, u.is_active,
         t.id AS tenant_id, t.name AS tenant_name, t.is_platform
  FROM users u
  JOIN tenants t ON t.id = u.tenant_id`;

async function findOrProvisionUser(cfg: MicrosoftSsoConfig, who: MicrosoftIdentity): Promise<UserRow> {
  // 1. Previously linked identity (stable oid).
  let { rows } = await pool.query(
    `${USER_SELECT} WHERE u.sso_provider = $1 AND u.sso_subject = $2`,
    [PROVIDER, who.objectId],
  );
  if (rows.length > 0) return rows[0] as UserRow;

  // 2. Existing password account with a matching email/username → link it.
  ({ rows } = await pool.query(
    `${USER_SELECT} WHERE LOWER(u.email) = $1 OR LOWER(u.username) = $1`,
    [who.email],
  ));
  if (rows.length > 0) {
    const row = rows[0] as UserRow;
    await pool.query(
      `UPDATE users SET sso_provider = $1, sso_subject = $2, updated_at = now() WHERE id = $3`,
      [PROVIDER, who.objectId, row.id],
    );
    logger.info('Linked Microsoft identity to existing user', { userId: row.id, username: row.username });
    return row;
  }

  // 3. First sign-in → provision (if allowed).
  if (!cfg.autoProvision) throw new SsoError('no_account', 'No IntelliQE account for this Microsoft user');

  const tenant = await pool.query(`SELECT id FROM tenants WHERE slug = $1`, [cfg.defaultTenantSlug]);
  if (tenant.rows.length === 0) {
    logger.error('SSO default tenant not found', { slug: cfg.defaultTenantSlug });
    throw new SsoError('provision_failed', 'Default tenant for SSO users is missing');
  }

  // password_hash is NOT NULL; store a hash of random bytes nobody knows so
  // the password form can never authenticate this account.
  const unusable = await bcrypt.hash(crypto.randomBytes(32).toString('hex'), 10);
  const inserted = await pool.query(
    `INSERT INTO users (tenant_id, username, password_hash, email, full_name, role, sso_provider, sso_subject)
     OUTPUT INSERTED.id
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [tenant.rows[0].id, who.email, unusable, who.email, who.displayName, cfg.defaultRole, PROVIDER, who.objectId],
  );
  logger.info('Provisioned user via Microsoft SSO', { userId: inserted.rows[0].id, username: who.email, role: cfg.defaultRole });

  ({ rows } = await pool.query(`${USER_SELECT} WHERE u.id = $1`, [inserted.rows[0].id]));
  return rows[0] as UserRow;
}

/* ─────────────────────────────────────────────────────────────
   Routes
   ───────────────────────────────────────────────────────────── */
router.get('/providers', (_req, res) => {
  res.json({ microsoft: isMicrosoftSsoEnabled() });
});

router.get('/microsoft', (req: Request, res: Response) => {
  const cfg = getMicrosoftSsoConfig();
  if (!cfg) {
    failToLogin(res, 'not_configured');
    return;
  }

  const { verifier, challenge } = createPkcePair();
  const state: SsoState = {
    st: randomToken(),
    cv: verifier,
    nc: randomToken(),
    rt: safeReturnPath(req.query.returnTo),
  };

  res.cookie(STATE_COOKIE, signScopedToken(STATE_SCOPE, state, STATE_TTL), {
    ...cookieOptions(req),
    maxAge: STATE_TTL_SECONDS * 1000,
  });

  const loginHint = typeof req.query.login_hint === 'string' ? req.query.login_hint.slice(0, 200) : undefined;
  res.redirect(
    buildAuthorizeUrl(cfg, {
      redirectUri: resolveRedirectUri(cfg, req),
      state: state.st,
      nonce: state.nc,
      codeChallenge: challenge,
      loginHint,
    }),
  );
});

router.get('/microsoft/callback', async (req: Request, res: Response) => {
  const cfg = getMicrosoftSsoConfig();
  if (!cfg) {
    failToLogin(res, 'not_configured');
    return;
  }

  // Always drop the one-shot state cookie, whatever happens next.
  const cookieRaw = readCookie(req, STATE_COOKIE);
  res.clearCookie(STATE_COOKIE, cookieOptions(req));

  try {
    if (typeof req.query.error === 'string') {
      logger.warn('Microsoft SSO returned an error', {
        error: req.query.error,
        description: req.query.error_description,
      });
      failToLogin(res, req.query.error === 'access_denied' ? 'cancelled' : 'provider_error');
      return;
    }

    let state: SsoState | undefined;
    if (cookieRaw) {
      try { state = verifyScopedToken<SsoState>(STATE_SCOPE, cookieRaw); } catch { /* expired / tampered */ }
    }
    const code = typeof req.query.code === 'string' ? req.query.code : '';
    const returnedState = typeof req.query.state === 'string' ? req.query.state : '';
    if (!state || !code || !returnedState || returnedState !== state.st) {
      failToLogin(res, 'state_mismatch');
      return;
    }

    const idToken = await exchangeCodeForIdToken(cfg, {
      code,
      redirectUri: resolveRedirectUri(cfg, req),
      codeVerifier: state.cv,
    });
    const identity = await verifyIdToken(cfg, idToken, state.nc);
    const user = await findOrProvisionUser(cfg, identity);

    if (!user.is_active) {
      failToLogin(res, 'account_inactive');
      return;
    }

    const token = signToken({
      sub: user.username,
      uid: user.id,
      role: user.role,
      tid: user.tenant_id,
      tn: user.tenant_name,
      pf: user.is_platform,
    });
    logger.info('Microsoft SSO login', { userId: user.id, username: user.username, tenantId: user.tenant_id });

    // Token travels in the URL fragment: never sent to the server, never in
    // access logs or Referer headers. The SPA reads it once and clears it.
    const fragment = new URLSearchParams({ token });
    if (state.rt) fragment.set('returnTo', state.rt);
    res.redirect(`${SPA_CALLBACK_PATH}#${fragment.toString()}`);
  } catch (err) {
    if (err instanceof SsoError) {
      logger.warn('Microsoft SSO rejected', { code: err.code, reason: err.message });
      failToLogin(res, err.code);
      return;
    }
    logger.error('Microsoft SSO callback failed', { err: (err as Error).message });
    failToLogin(res, 'unknown');
  }
});

export default router;
