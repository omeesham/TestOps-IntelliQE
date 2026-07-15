import { Router } from 'express';
import type { Request, Response } from 'express';
import {
  testConnection,
  getStories,
  getStory,
  getWorkItems,
  getTestCases,
  getCredsForTenant,
  saveCredsForTenant,
  deleteCredsForTenant,
  getConnectionStatus,
  normalizeOrg,
  buildAuthHeader,
} from '../services/azure-devops.service.js';
import { decryptField } from '../utils/crypto.js';

const router = Router();

/** Turn any Azure DevOps error into the real underlying message + status. */
function adoError(err: any): { status: number; body: any } {
  const status = err?.response?.status ?? 500;
  const detail =
    err?.response?.data?.message ||
    (typeof err?.response?.data === 'string' ? err.response.data.slice(0, 300) : '') ||
    err?.code ||
    err?.message ||
    'Unknown error';
  return { status: status || 500, body: { error: detail, status: err?.response?.status ?? null, code: err?.code ?? null } };
}

// POST /api/azure-devops/connect — validate PAT + save credentials (tenant-scoped)
router.post('/connect', async (req: Request, res: Response) => {
  try {
    const user = req.user!;
    const { orgUrl, project, pat: rawPat, areaPath } = req.body;
    const pat = decryptField(rawPat || '');

    if (!orgUrl || !project || !pat) {
      res.status(400).json({ error: 'orgUrl, project, and pat are required' });
      return;
    }

    const { baseUrl, org } = normalizeOrg(orgUrl);
    if (!baseUrl || !org) {
      res.status(400).json({ error: 'Could not parse the Organization URL. Use https://dev.azure.com/your-org' });
      return;
    }

    const authHeader = buildAuthHeader(pat);
    const creds = { baseUrl, org, project: String(project).trim(), authHeader, areaPath: areaPath || undefined };

    // Validate before persisting so we never save a connection that can't fetch.
    const proj = await testConnection(creds);

    await saveCredsForTenant(user.tenantId, user.username, orgUrl, creds.project, authHeader, proj.name, areaPath);

    console.log(`Azure DevOps connected: tenant=${user.tenantId}, user=${user.username}, org=${org}, project=${proj.name}`);
    res.json({ ok: true, org, project: proj.name });
  } catch (err: any) {
    const { status, body } = adoError(err);
    console.error('Azure DevOps connect error:', { status, code: err?.code, data: err?.response?.data, message: err?.message });
    res.status(status).json(body);
  }
});

// GET /api/azure-devops/status
router.get('/status', async (req: Request, res: Response) => {
  try {
    const status = await getConnectionStatus(req.user!.tenantId);
    res.json(status);
  } catch (err: any) {
    console.error('Azure DevOps status error:', err.message);
    res.status(500).json({ error: 'Failed to check Azure DevOps status' });
  }
});

// GET /api/azure-devops/stories — open board cards usable as requirements:
// ONLY Epic, User Story and Task work items, excluding any card in a
// Done/Closed/Removed state.
router.get('/stories', async (req: Request, res: Response) => {
  try {
    const creds = await getCredsForTenant(req.user!.tenantId);
    if (!creds) { res.status(400).json({ error: 'Not connected to Azure DevOps. Connect first.' }); return; }
    res.json(await getStories(creds));
  } catch (err: any) {
    const { status, body } = adoError(err);
    console.error('Azure DevOps stories error:', { status, data: err?.response?.data, message: err?.message });
    res.status(status).json(body);
  }
});

// GET /api/azure-devops/work-items?type=Bug — all work items (optionally one type)
router.get('/work-items', async (req: Request, res: Response) => {
  try {
    const creds = await getCredsForTenant(req.user!.tenantId);
    if (!creds) { res.status(400).json({ error: 'Not connected to Azure DevOps. Connect first.' }); return; }
    const type = typeof req.query.type === 'string' ? req.query.type : undefined;
    res.json(await getWorkItems(creds, { type }));
  } catch (err: any) {
    const { status, body } = adoError(err);
    console.error('Azure DevOps work-items error:', { status, message: err?.message });
    res.status(status).json(body);
  }
});

// GET /api/azure-devops/test-cases — authored Test Case work items (with steps)
router.get('/test-cases', async (req: Request, res: Response) => {
  try {
    const creds = await getCredsForTenant(req.user!.tenantId);
    if (!creds) { res.status(400).json({ error: 'Not connected to Azure DevOps. Connect first.' }); return; }
    res.json(await getTestCases(creds));
  } catch (err: any) {
    const { status, body } = adoError(err);
    console.error('Azure DevOps test-cases error:', { status, message: err?.message });
    res.status(status).json(body);
  }
});

// GET /api/azure-devops/story/:id — one work item's detail
router.get('/story/:id', async (req: Request, res: Response) => {
  try {
    const creds = await getCredsForTenant(req.user!.tenantId);
    if (!creds) { res.status(400).json({ error: 'Not connected to Azure DevOps' }); return; }
    res.json(await getStory(creds, req.params.id as string));
  } catch (err: any) {
    const { status, body } = adoError(err);
    console.error(`Azure DevOps story detail error [${req.params.id}]:`, { status, message: err?.message });
    res.status(status).json(body);
  }
});

// DELETE /api/azure-devops/disconnect
router.delete('/disconnect', async (req: Request, res: Response) => {
  try {
    await deleteCredsForTenant(req.user!.tenantId);
    console.log(`Azure DevOps disconnected for tenant: ${req.user!.tenantId}`);
    res.json({ ok: true });
  } catch (err: any) {
    console.error('Azure DevOps disconnect error:', err.message);
    res.status(500).json({ error: 'Failed to disconnect Azure DevOps' });
  }
});

export default router;
