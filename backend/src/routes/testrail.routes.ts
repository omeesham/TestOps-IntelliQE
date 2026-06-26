import { Router } from 'express';
import type { Request, Response } from 'express';
import { decryptField } from '../utils/crypto.js';
import {
  testTestRailConnection, saveTestRailCreds, getTestRailCreds, disconnectTestRail,
  syncTestRail, getTestRailStatus, getTestRailDashboard, type TestRailCreds,
} from '../services/testrail.service.js';

const router = Router();

function normalizeBaseUrl(raw: string): string {
  const candidate = /^https?:\/\//i.test(raw.trim()) ? raw.trim() : `https://${raw.trim()}`;
  const u = new URL(candidate);
  return `${u.protocol}//${u.host}`;
}

function safeError(err: any, fallback: string): { status: number; message: string } {
  const status = err?.response?.status;
  if (status === 401 || status === 403) return { status, message: 'Authentication failed — check your TestRail email and API key.' };
  if (err?.code === 'ENOTFOUND' || err?.code === 'ECONNREFUSED') return { status: 502, message: 'Cannot reach the TestRail instance — check the URL.' };
  return { status: status || 500, message: err?.response?.data?.error || err?.message || fallback };
}

// POST /api/testrail/connect — validate + store credentials, then do a first sync.
router.post('/connect', async (req: Request, res: Response) => {
  try {
    const user = req.user!;
    const { baseUrl, email, apiKey: rawKey } = req.body;
    const apiKey = decryptField(rawKey || '');
    if (!baseUrl || !email || !apiKey) {
      res.status(400).json({ error: 'baseUrl, email, and apiKey are required' });
      return;
    }
    let normalized: string;
    try { normalized = normalizeBaseUrl(baseUrl); }
    catch { res.status(400).json({ error: 'Invalid TestRail URL — use your instance address, e.g. https://yourcompany.testrail.io' }); return; }

    const creds: TestRailCreds = { baseUrl: normalized, email: String(email).trim(), apiKey };
    const check = await testTestRailConnection(creds);
    await saveTestRailCreds(user.tenantId, user.username, creds);

    // First sync so the dashboard has data immediately (best-effort).
    let synced: any = null;
    try { synced = await syncTestRail(user.tenantId); } catch (e: any) { console.error('TestRail first-sync failed:', e?.message); }

    console.log(`TestRail connected: tenant=${user.tenantId}, url=${normalized}, projects=${check.projects}`);
    res.json({ ok: true, baseUrl: normalized, projects: check.projects, synced });
  } catch (err: any) {
    const { status, message } = safeError(err, 'Failed to connect to TestRail');
    console.error('TestRail connect error:', message);
    res.status(status).json({ error: message });
  }
});

// GET /api/testrail/status
router.get('/status', async (req: Request, res: Response) => {
  try {
    res.json(await getTestRailStatus(req.user!.tenantId));
  } catch (err: any) {
    console.error('TestRail status error:', err.message);
    res.status(500).json({ error: 'Failed to read TestRail status' });
  }
});

// POST /api/testrail/sync — pull fresh data from TestRail into IntelliQE's DB.
router.post('/sync', async (req: Request, res: Response) => {
  try {
    const creds = await getTestRailCreds(req.user!.tenantId);
    if (!creds) { res.status(400).json({ error: 'TestRail is not connected. Connect first.' }); return; }
    const result = await syncTestRail(req.user!.tenantId);
    res.json({ ok: true, ...result });
  } catch (err: any) {
    const { status, message } = safeError(err, 'TestRail sync failed');
    console.error('TestRail sync error:', message);
    res.status(status).json({ error: message });
  }
});

// GET /api/testrail/dashboard?projectId= — read the synced data for visualization.
router.get('/dashboard', async (req: Request, res: Response) => {
  try {
    const projectId = req.query.projectId ? Number(req.query.projectId) : undefined;
    res.json(await getTestRailDashboard(req.user!.tenantId, Number.isFinite(projectId) ? projectId : undefined));
  } catch (err: any) {
    console.error('TestRail dashboard error:', err.message);
    res.status(500).json({ error: 'Failed to load TestRail dashboard' });
  }
});

// DELETE /api/testrail/disconnect
router.delete('/disconnect', async (req: Request, res: Response) => {
  try {
    await disconnectTestRail(req.user!.tenantId);
    res.json({ ok: true });
  } catch (err: any) {
    console.error('TestRail disconnect error:', err.message);
    res.status(500).json({ error: 'Failed to disconnect TestRail' });
  }
});

export default router;
