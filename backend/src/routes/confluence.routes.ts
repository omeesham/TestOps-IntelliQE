/**
 * confluence.routes.ts
 * ────────────────────
 * Tenant-scoped Confluence integration. Mirrors jira.routes.ts:
 *   GET  /api/confluence/status       — is the integration connected for this tenant?
 *   GET  /api/confluence/pages        — list recent pages (optional ?spaceKey=...)
 *   GET  /api/confluence/page/:id     — fetch a single page as plain-text body
 *
 * Credentials are read from `client_configurations` via the service
 * layer. The frontend's ChatPage uses these endpoints when the user
 * picks Confluence as the requirement source.
 */
import { Router } from 'express';
import type { Request, Response } from 'express';
import {
  getCredsForTenant,
  getConnectionStatus,
  listPages,
  getPage,
} from '../services/confluence.service.js';

const router = Router();

router.get('/status', async (req: Request, res: Response) => {
  try {
    const user = req.user!;
    const s = await getConnectionStatus(user.tenantId);
    res.json(s);
  } catch (err: any) {
    console.error('Confluence status error:', err.message);
    res.status(500).json({ error: 'Failed to check Confluence status' });
  }
});

router.get('/pages', async (req: Request, res: Response) => {
  try {
    const user = req.user!;
    const creds = await getCredsForTenant(user.tenantId);
    if (!creds) {
      res.status(400).json({ error: 'Not connected to Confluence. Connect it in System Configuration first.' });
      return;
    }
    const spaceKey = (req.query.spaceKey as string | undefined)?.trim() || undefined;
    const pages = await listPages(creds, spaceKey);
    res.json(pages);
  } catch (err: any) {
    const status = err?.response?.status;
    let safe = 'Failed to fetch Confluence pages';
    if (status === 401 || status === 403) {
      safe = 'Confluence authentication failed — please reconnect with a valid API token';
    } else if (err?.code === 'ENOTFOUND') {
      safe = 'Cannot reach Confluence server — check the URL';
    } else if (err?.response?.data?.message) {
      safe = err.response.data.message;
    } else if (err?.message) {
      safe = `Confluence error: ${err.message}`;
    }
    console.error('Confluence pages error:', safe);
    res.status(status || 500).json({ error: safe });
  }
});

router.get('/page/:id', async (req: Request, res: Response) => {
  try {
    const user = req.user!;
    const creds = await getCredsForTenant(user.tenantId);
    if (!creds) {
      res.status(400).json({ error: 'Not connected to Confluence' });
      return;
    }
    const page = await getPage(creds, req.params.id as string);
    res.json(page);
  } catch (err: any) {
    const status = err?.response?.status;
    let safe = 'Failed to fetch Confluence page';
    if (status === 404) {
      safe = 'Page not found — it may have been deleted or you may not have access';
    } else if (status === 401 || status === 403) {
      safe = 'Confluence authentication failed — please reconnect';
    } else if (err?.response?.data?.message) {
      safe = err.response.data.message;
    }
    console.error(`Confluence page error [${req.params.id}]:`, safe);
    res.status(status || 500).json({ error: safe });
  }
});

export default router;
