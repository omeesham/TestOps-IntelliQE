import { Router } from 'express';
import type { Request, Response } from 'express';
import {
  testConnection,
  getStories,
  getStory,
  getCredsForTenant,
  saveCredsForTenant,
  deleteCredsForTenant,
  getConnectionStatus,
  toApiBase,
  extractProjectKey,
} from '../services/jira.service.js';
import { decryptField } from '../utils/crypto.js';

const router = Router();

// POST /api/jira/connect — Connect to JIRA and save credentials (tenant-scoped)
router.post('/connect', async (req: Request, res: Response) => {
  try {
    const user = req.user!;
    const { baseUrl, email, apiToken: rawApiToken } = req.body;
    // Decrypt the encrypted apiToken from the client
    const apiToken = decryptField(rawApiToken);

    if (!baseUrl || !email || !apiToken) {
      res.status(400).json({ error: 'baseUrl, email, and apiToken are required' });
      return;
    }

    // Capture the project key from whatever the user pasted (board/project URL)
    // BEFORE reducing the URL to the API base/origin.
    const projectKey = extractProjectKey(baseUrl);
    // Reduce whatever the user pasted (often a board/project URL) to the API
    // base = site origin. Saving the origin is what makes /rest/api/3 work.
    const fullUrl = toApiBase(baseUrl);
    const authHeader = `Basic ${Buffer.from(`${email}:${apiToken}`).toString('base64')}`;

    const creds = { baseUrl: fullUrl, authHeader };

    // Test connection first
    const me = await testConnection(creds);

    // Save to database (tenant-scoped)
    await saveCredsForTenant(user.tenantId, user.username, fullUrl, authHeader, me.displayName, projectKey);

    console.log(`JIRA connected: tenant=${user.tenantId}, user=${user.username}, url=${fullUrl}, project=${projectKey || '(all)'}, jiraUser=${me.displayName}`);

    res.json({ ok: true, displayName: me.displayName, projectKey: projectKey || null });
  } catch (err: any) {
    // No masking — return exactly what JIRA / the network reported.
    const status = err?.response?.status ?? null;
    const detail =
      err?.response?.data?.errorMessages?.join('; ') ||
      err?.response?.data?.message ||
      (err?.response?.data ? JSON.stringify(err.response.data) : '') ||
      err?.code ||
      err?.message ||
      'Unknown error';
    console.error('JIRA connect error:', {
      status, code: err?.code, data: err?.response?.data, message: err?.message,
    });
    res.status(status || 500).json({ error: detail, status, code: err?.code ?? null });
  }
});

// GET /api/jira/status — Check connection status (tenant-scoped)
router.get('/status', async (req: Request, res: Response) => {
  try {
    const user = req.user!;
    const status = await getConnectionStatus(user.tenantId);
    res.json({
      connected: status.connected,
      jiraUrl: status.jiraUrl,
      displayName: status.displayName,
      connectedAt: status.connectedAt,
    });
  } catch (err: any) {
    console.error('JIRA status error:', err.message);
    res.status(500).json({ error: 'Failed to check JIRA status' });
  }
});

// GET /api/jira/stories — List user stories (tenant-scoped)
router.get('/stories', async (req: Request, res: Response) => {
  try {
    const user = req.user!;
    const creds = await getCredsForTenant(user.tenantId);
    if (!creds) { res.status(400).json({ error: 'Not connected to JIRA. Connect first.' }); return; }

    const stories = await getStories(creds);
    res.json(stories);
  } catch (err: any) {
    // No masking — return exactly what JIRA (or the network layer) reported.
    const status = err?.response?.status ?? null;
    const detail =
      err?.response?.data?.errorMessages?.join('; ') ||
      err?.response?.data?.message ||
      (err?.response?.data ? JSON.stringify(err.response.data) : '') ||
      err?.code ||
      err?.message ||
      'Unknown error';
    console.error('JIRA stories error:', {
      status,
      code: err?.code,
      url: err?.config?.url,
      data: err?.response?.data,
      message: err?.message,
    });
    res.status(status || 500).json({ error: detail, status, code: err?.code ?? null });
  }
});

// GET /api/jira/story/:key — Get story details (tenant-scoped)
router.get('/story/:key', async (req: Request, res: Response) => {
  try {
    const user = req.user!;
    const { key } = req.params;

    const creds = await getCredsForTenant(user.tenantId);
    if (!creds) { res.status(400).json({ error: 'Not connected to JIRA' }); return; }

    const details = await getStory(creds, key as string);
    res.json(details);
  } catch (err: any) {
    // No masking — return the real JIRA / network error.
    const status = err?.response?.status ?? null;
    const detail =
      err?.response?.data?.errorMessages?.join('; ') ||
      err?.response?.data?.message ||
      (err?.response?.data ? JSON.stringify(err.response.data) : '') ||
      err?.code ||
      err?.message ||
      'Unknown error';
    console.error(`JIRA story detail error [${req.params.key}]:`, {
      status, code: err?.code, data: err?.response?.data, message: err?.message,
    });
    res.status(status || 500).json({ error: detail, status, code: err?.code ?? null });
  }
});

// DELETE /api/jira/disconnect — Remove JIRA connection (tenant-scoped)
router.delete('/disconnect', async (req: Request, res: Response) => {
  try {
    const user = req.user!;
    await deleteCredsForTenant(user.tenantId);
    console.log(`JIRA disconnected for tenant: ${user.tenantId}`);
    res.json({ ok: true });
  } catch (err: any) {
    console.error('JIRA disconnect error:', err.message);
    res.status(500).json({ error: 'Failed to disconnect JIRA' });
  }
});

export default router;
