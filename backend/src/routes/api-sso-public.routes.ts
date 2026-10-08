/**
 * api-sso-public.routes.ts
 * ────────────────────────
 * PUBLIC SSO (OIDC) login face. Mounted at /api/auth/sso (in index.ts, OUTSIDE
 * authMiddleware) ALONGSIDE the untouched /api/auth/login — never replacing it.
 * A tenant with SSO disabled has no routes effect (exchange refuses). Flow:
 *
 *   GET  /:tenantId/start     → 302 to the IdP's authorize endpoint
 *   GET  /:tenantId/callback  → exchanges the code, then hands the SPA its token
 *   POST /:tenantId/exchange  → same exchange, as JSON (for a SPA-driven flow)
 *
 * The token minted is the SAME app token as password login (reuses signToken via
 * the access service). The generate → execute → heal pipeline is never involved.
 */
import express, { Router } from 'express';
import type { Request, Response } from 'express';
import { buildOidcStartUrl, exchangeOidcCode, processSamlResponse, samlSpMetadata } from '../services/api-access.service.js';

const router = Router();

function originOf(req: Request): string {
  const proto = (req.headers['x-forwarded-proto'] as string)?.split(',')[0] || req.protocol || 'http';
  return `${proto}://${req.get('host')}`;
}
function callbackUrl(req: Request, tenantId: string): string {
  return `${originOf(req)}/api/auth/sso/${encodeURIComponent(tenantId)}/callback`;
}

/** Shared "store the token in sessionStorage and continue to the app" landing page. */
function tokenLandingHtml(token: string, user: unknown): string {
  const payload = JSON.stringify({ token, user }).replace(/</g, '\\u003c');
  return `<!doctype html><html><head><meta charset="utf-8"><title>Signing in…</title></head>
<body style="font-family:system-ui;padding:2rem;color:#334155">Signing you in…
<script>
(function(){try{var d=${payload};sessionStorage.setItem('intelliqe_token',d.token);sessionStorage.setItem('intelliqe_user',JSON.stringify(d.user));}catch(e){}location.replace('/');})();
</script></body></html>`;
}

/** Kick off the OIDC redirect. `?json=1` returns { url } instead of redirecting. */
router.get('/:tenantId/start', async (req: Request, res: Response) => {
  try {
    const tenantId = String(req.params.tenantId);
    const state = Buffer.from(JSON.stringify({ t: tenantId, n: Math.random().toString(36).slice(2) })).toString('base64url');
    const url = await buildOidcStartUrl(tenantId, callbackUrl(req, tenantId), state);
    if (req.query.json === '1') { res.json({ url }); return; }
    res.redirect(302, url);
  } catch (err) { res.status(400).json({ error: (err as Error).message }); }
});

/**
 * IdP redirect target. Exchanges the code, then returns a tiny self-contained
 * page that stores the token the way the SPA expects (sessionStorage keys
 * intelliqe_token / intelliqe_user) and continues to the app — so no existing
 * frontend file has to change. Same-origin in production; use /exchange in dev.
 */
router.get('/:tenantId/callback', async (req: Request, res: Response) => {
  const tenantId = String(req.params.tenantId);
  const code = String(req.query.code || '');
  if (!code) { res.status(400).send('Missing authorization code.'); return; }
  try {
    const { token, user } = await exchangeOidcCode(tenantId, code, callbackUrl(req, tenantId));
    res.type('html').send(tokenLandingHtml(token, user));
  } catch (err) {
    res.status(400).type('html').send(`<!doctype html><meta charset="utf-8"><body style="font-family:system-ui;padding:2rem;color:#b91c1c">SSO sign-in failed: ${String((err as Error).message).replace(/</g, '&lt;')}</body>`);
  }
});

/** SPA-driven exchange — the SPA posts the code it received and stores the token itself. */
router.post('/:tenantId/exchange', async (req: Request, res: Response) => {
  try {
    const tenantId = String(req.params.tenantId);
    const code = String(req.body?.code || '');
    if (!code) { res.status(400).json({ error: 'An authorization code is required.' }); return; }
    const redirectUri = String(req.body?.redirectUri || callbackUrl(req, tenantId));
    res.json(await exchangeOidcCode(tenantId, code, redirectUri));
  } catch (err) { res.status(400).json({ error: (err as Error).message }); }
});

/**
 * SAML 2.0 ACS — the IdP POSTs a form-encoded SAMLResponse here (HTTP-POST
 * binding), so this route parses urlencoded bodies itself. On success it hands
 * the SPA the same sessionStorage landing page as the OIDC callback.
 */
router.post('/:tenantId/saml/acs', express.urlencoded({ extended: false, limit: '2mb' }), async (req: Request, res: Response) => {
  const tenantId = String(req.params.tenantId);
  const samlResponse = String((req.body as Record<string, unknown>)?.SAMLResponse || '');
  if (!samlResponse) { res.status(400).send('Missing SAMLResponse.'); return; }
  try {
    const { token, user } = await processSamlResponse(tenantId, samlResponse);
    res.type('html').send(tokenLandingHtml(token, user));
  } catch (err) {
    res.status(400).type('html').send(`<!doctype html><meta charset="utf-8"><body style="font-family:system-ui;padding:2rem;color:#b91c1c">SAML sign-in failed: ${String((err as Error).message).replace(/</g, '&lt;')}</body>`);
  }
});

/** SP metadata the IdP can consume to configure the ACS endpoint. */
router.get('/:tenantId/saml/metadata', (req: Request, res: Response) => {
  const tenantId = String(req.params.tenantId);
  const base = `${originOf(req)}/api/auth/sso/${encodeURIComponent(tenantId)}`;
  res.type('application/xml').send(samlSpMetadata(`${base}/saml/acs`, base));
});

export default router;
