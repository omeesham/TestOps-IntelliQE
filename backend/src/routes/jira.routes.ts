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
} from '../services/jira.service.js';
import { decryptField } from '../utils/crypto.js';

const router = Router();

/**
 * Pull the project key out of a pasted JIRA URL so story fetching can be
 * scoped to that project. Handles the common shapes:
 *   .../projects/IQ/boards/447   .../browse/IQ-1   ?projectKey=IQ
 * Returns undefined when no project is identifiable (callers then fall back
 * to a site-wide query).
 */
function extractProjectKey(raw?: string): string | undefined {
  if (!raw) return undefined;
  const patterns = [
    /\/projects\/([A-Za-z][A-Za-z0-9_]+)/, // /jira/software/c/projects/IQ/...
    /\/browse\/([A-Za-z][A-Za-z0-9_]+)-\d+/, // /browse/IQ-1
    /[?&]projectKey=([A-Za-z][A-Za-z0-9_]+)/i, // ?projectKey=IQ
  ];
  for (const re of patterns) {
    const m = raw.match(re);
    if (m && m[1]) return m[1].toUpperCase();
  }
  return undefined;
}

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

    // Users frequently paste the full board URL
    // (e.g. https://site.atlassian.net/jira/software/c/projects/IQ/boards/447).
    // The REST API lives at the SITE ORIGIN, so strip any path/query/fragment
    // and keep only scheme + host — otherwise every `${baseUrl}/rest/api/3/...`
    // call hits an invalid path (and Atlassian's 200 SPA fallback hides it).
    let fullUrl: string;
    try {
      const candidate = /^https?:\/\//i.test(baseUrl.trim()) ? baseUrl.trim() : `https://${baseUrl.trim()}`;
      const u = new URL(candidate);
      fullUrl = `${u.protocol}//${u.host}`;
    } catch {
      res.status(400).json({ error: 'Invalid JIRA URL — use your site address, e.g. https://your-domain.atlassian.net' });
      return;
    }
    const authHeader = `Basic ${Buffer.from(`${email}:${apiToken}`).toString('base64')}`;

    // The site origin is the API base, but the project context (e.g. IQ from
    // .../projects/IQ/boards/447) is what scopes story fetching. Capture it so
    // the wizard lists only this project's issues, not every project on the site.
    const projectKey = extractProjectKey(baseUrl);

    const creds = { baseUrl: fullUrl, authHeader };

    // Test connection first
    const me = await testConnection(creds);

    // Save to database (tenant-scoped)
    await saveCredsForTenant(user.tenantId, user.username, fullUrl, authHeader, me.displayName, projectKey);

    console.log(`JIRA connected: tenant=${user.tenantId}, user=${user.username}, url=${fullUrl}, project=${projectKey || '(all)'}, jiraUser=${me.displayName}`);

    res.json({ ok: true, displayName: me.displayName, projectKey: projectKey || null });
  } catch (err: any) {
    let safeMsg = 'Failed to connect to JIRA';
    const status = err?.response?.status;
    if (status === 401 || status === 403) {
      safeMsg = 'Authentication failed — check your email and API token';
    } else if (err?.response?.data?.errorMessages?.[0]) {
      safeMsg = err.response.data.errorMessages[0];
    } else if (err?.response?.data?.message) {
      safeMsg = err.response.data.message;
    } else if (err?.code === 'ENOTFOUND' || err?.code === 'ERR_BAD_REQUEST') {
      safeMsg = `Cannot reach JIRA server — check the URL (${err.code})`;
    } else if (err?.code) {
      safeMsg = `Connection error: ${err.code}`;
    } else if (err?.message && !err?.message.includes('apiToken') && !err?.message.includes('auth')) {
      safeMsg = err.message;
    }
    console.error(`JIRA connect error: ${safeMsg}`);
    res.status(status === 401 || status === 403 ? status : 500).json({ error: safeMsg });
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
    const status = err?.response?.status;
    let safeMsg = 'Failed to fetch stories';
    if (status === 401 || status === 403) {
      safeMsg = 'JIRA authentication expired — please reconnect';
    } else if (err?.response?.data?.errorMessages?.[0]) {
      safeMsg = err.response.data.errorMessages[0];
    } else if (err?.code === 'ENOTFOUND') {
      safeMsg = 'Cannot reach JIRA server';
    } else if (err?.message && !err?.message.includes('auth')) {
      safeMsg = `JIRA error: ${err.message}`;
    }
    console.error('JIRA stories error:', safeMsg);
    res.status(status || 500).json({ error: safeMsg });
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
    console.error(`JIRA story detail error [${req.params.key}]:`, err.message || 'Unknown error');
    res.status(500).json({ error: 'Failed to fetch story details' });
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
