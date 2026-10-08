/**
 * api-scim-public.routes.ts
 * ─────────────────────────
 * PUBLIC SCIM 2.0 provisioning face. Mounted at /scim/v2 (in index.ts, OUTSIDE
 * the app's authMiddleware) so an identity provider (Okta, Entra ID, OneLogin…)
 * can create / deactivate users with its own SCIM bearer token — never an
 * IntelliQE login. The bearer resolves to a tenant via resolveScimToken; every
 * op is scoped to that tenant and only ever touches the existing users table.
 *
 * Additive and opt-in: a tenant has no SCIM token until an admin mints one under
 * Access Control, so this surface is inert by default. The generate → execute →
 * heal pipeline is never involved.
 */
import { Router } from 'express';
import type { Request, Response } from 'express';
import { resolveScimToken, scimListUsers, scimCreateUser, scimSetActive } from '../services/api-access.service.js';

const router = Router();

async function tenantFromBearer(req: Request): Promise<string | null> {
  const m = /^Bearer\s+(.+)$/i.exec(String(req.headers.authorization || ''));
  return m ? resolveScimToken(m[1]!.trim()) : null;
}
function scimError(res: Response, status: number, detail: string): void {
  res.status(status).json({ schemas: ['urn:ietf:params:scim:api:messages:2.0:Error'], status: String(status), detail });
}

/** Discovery documents some IdPs probe before provisioning. */
router.get('/ServiceProviderConfig', (_req: Request, res: Response) => {
  res.json({
    schemas: ['urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig'],
    patch: { supported: true }, bulk: { supported: false }, filter: { supported: true, maxResults: 200 },
    changePassword: { supported: false }, sort: { supported: false }, etag: { supported: false },
    authenticationSchemes: [{ type: 'oauthbearertoken', name: 'OAuth Bearer Token', description: 'SCIM token minted in IntelliQE Access Control.' }],
  });
});

router.get('/Users', async (req: Request, res: Response) => {
  try {
    const tenantId = await tenantFromBearer(req);
    if (!tenantId) { scimError(res, 401, 'Invalid or missing SCIM token.'); return; }
    const list = await scimListUsers(tenantId);
    // Minimal "userName eq" filter support (what Okta/Entra send before create).
    const filter = String(req.query.filter || '');
    const eq = /userName\s+eq\s+"([^"]+)"/i.exec(filter);
    if (eq) {
      const want = eq[1]!.toLowerCase();
      const match = (list.Resources || []).filter((u: any) => String(u.userName || '').toLowerCase() === want);
      res.json({ schemas: ['urn:ietf:params:scim:api:messages:2.0:ListResponse'], totalResults: match.length, Resources: match });
      return;
    }
    res.json(list);
  } catch (err) { scimError(res, 500, (err as Error).message); }
});

router.get('/Users/:id', async (req: Request, res: Response) => {
  try {
    const tenantId = await tenantFromBearer(req);
    if (!tenantId) { scimError(res, 401, 'Invalid or missing SCIM token.'); return; }
    const list = await scimListUsers(tenantId);
    const user = (list.Resources || []).find((u: any) => String(u.id) === String(req.params.id));
    if (!user) { scimError(res, 404, 'User not found.'); return; }
    res.json(user);
  } catch (err) { scimError(res, 500, (err as Error).message); }
});

router.post('/Users', async (req: Request, res: Response) => {
  try {
    const tenantId = await tenantFromBearer(req);
    if (!tenantId) { scimError(res, 401, 'Invalid or missing SCIM token.'); return; }
    res.status(201).json(await scimCreateUser(tenantId, req.body || {}));
  } catch (err) { scimError(res, 400, (err as Error).message); }
});

/** PATCH — IdPs send a replace of `active` to (de)activate a user. */
router.patch('/Users/:id', async (req: Request, res: Response) => {
  try {
    const tenantId = await tenantFromBearer(req);
    if (!tenantId) { scimError(res, 401, 'Invalid or missing SCIM token.'); return; }
    const ops = Array.isArray(req.body?.Operations) ? req.body.Operations : [];
    let active: boolean | undefined;
    for (const op of ops) {
      const path = String(op?.path || '').toLowerCase();
      if (path === 'active') active = op?.value === true || op?.value === 'true' || op?.value === 'True';
      else if (op?.value && typeof op.value === 'object' && 'active' in op.value) active = !!op.value.active;
    }
    if (active === undefined) { scimError(res, 400, 'Only the `active` attribute is supported via PATCH.'); return; }
    res.json(await scimSetActive(tenantId, String(req.params.id), active));
  } catch (err) { scimError(res, 400, (err as Error).message); }
});

/** PUT — full replace; we honour `active`, leaving identity attributes intact. */
router.put('/Users/:id', async (req: Request, res: Response) => {
  try {
    const tenantId = await tenantFromBearer(req);
    if (!tenantId) { scimError(res, 401, 'Invalid or missing SCIM token.'); return; }
    res.json(await scimSetActive(tenantId, String(req.params.id), req.body?.active !== false));
  } catch (err) { scimError(res, 400, (err as Error).message); }
});

router.delete('/Users/:id', async (req: Request, res: Response) => {
  try {
    const tenantId = await tenantFromBearer(req);
    if (!tenantId) { scimError(res, 401, 'Invalid or missing SCIM token.'); return; }
    await scimSetActive(tenantId, String(req.params.id), false);   // soft-deactivate
    res.status(204).send();
  } catch (err) { scimError(res, 400, (err as Error).message); }
});

export default router;
