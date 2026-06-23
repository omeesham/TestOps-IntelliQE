/**
 * sharepoint.routes.ts
 * ────────────────────
 *   GET  /api/sharepoint/status                — connection status
 *   GET  /api/sharepoint/documents             — list documents in the site's default library
 *   GET  /api/sharepoint/document/:id          — fetch + extract text from a single file
 *
 * Auth happens server-side via @azure/identity ClientSecretCredential.
 * The user never sees the access token; the client just gets back the
 * extracted text ready to feed into the test-generation pipeline.
 */
import { Router } from 'express';
import type { Request, Response } from 'express';
import {
  getCredsForTenant,
  getConnectionStatus,
  listDocuments,
  getDocument,
} from '../services/sharepoint.service.js';

const router = Router();

router.get('/status', async (req: Request, res: Response) => {
  try {
    const user = req.user!;
    const s = await getConnectionStatus(user.tenantId);
    res.json(s);
  } catch (err: any) {
    console.error('SharePoint status error:', err.message);
    res.status(500).json({ error: 'Failed to check SharePoint status' });
  }
});

router.get('/documents', async (req: Request, res: Response) => {
  try {
    const user = req.user!;
    const creds = await getCredsForTenant(user.tenantId);
    if (!creds) {
      res.status(400).json({
        error: 'Not connected to SharePoint. Connect it in System Configuration (siteUrl, tenantId, clientId, clientSecret).',
      });
      return;
    }
    const docs = await listDocuments(creds);
    res.json(docs);
  } catch (err: any) {
    const safe = mapSharePointError(err, 'Failed to list SharePoint documents');
    console.error('SharePoint documents error:', safe.message);
    res.status(safe.status).json({ error: safe.message });
  }
});

router.get('/document/:id', async (req: Request, res: Response) => {
  try {
    const user = req.user!;
    const creds = await getCredsForTenant(user.tenantId);
    if (!creds) {
      res.status(400).json({ error: 'Not connected to SharePoint' });
      return;
    }
    const doc = await getDocument(creds, req.params.id as string);
    res.json(doc);
  } catch (err: any) {
    const safe = mapSharePointError(err, 'Failed to fetch SharePoint document');
    console.error(`SharePoint document error [${req.params.id}]:`, safe.message);
    res.status(safe.status).json({ error: safe.message });
  }
});

/**
 * Translate raw Graph SDK / @azure/identity errors into clean
 * HTTP statuses + user-friendly messages. Auth failures get 401,
 * permission failures get 403, anything else stays 500.
 */
function mapSharePointError(err: any, fallback: string): { status: number; message: string } {
  const code = err?.statusCode || err?.code || err?.response?.status;
  const body = err?.body || err?.response?.data;
  let msg: string = body?.error?.message || err?.message || fallback;
  let status = 500;
  if (code === 401 || /unauthor|invalid_client|invalid_grant/i.test(String(msg))) {
    status = 401;
    msg = 'SharePoint authentication failed — verify tenantId, clientId, clientSecret, and that admin consent has been granted for Sites.Read.All and Files.Read.All.';
  } else if (code === 403 || /forbidden|insufficient/i.test(String(msg))) {
    status = 403;
    msg = 'SharePoint authorisation failed — the app does not have permission to read this site. Ask your tenant admin to grant the required Graph permissions.';
  } else if (code === 404) {
    status = 404;
    msg = 'SharePoint resource not found — check the site URL and item id.';
  } else if (typeof code === 'number' && code >= 400 && code < 500) {
    status = code;
  }
  return { status, message: msg };
}

export default router;
