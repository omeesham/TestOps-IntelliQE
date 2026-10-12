/**
 * api-status-public.routes.ts
 * ───────────────────────────
 * The PUBLIC status page. Mounted at /status (in index.ts, OUTSIDE auth) so a
 * shareable uptime/SLO page is reachable without a login:
 *   GET /status/:token        → a self-contained HTML status page
 *   GET /status/:token/json   → the same data as JSON
 * The unguessable :token is the capability. Read-only; never touches the pipeline.
 */
import { Router } from 'express';
import type { Request, Response } from 'express';
import { getPublicStatus } from '../services/api-status.service.js';

const router = Router();

router.get('/:token/json', async (req: Request, res: Response) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  try {
    const r = await getPublicStatus(String(req.params.token || ''));
    if (!r) { res.status(404).json({ error: 'Unknown or disabled status page.' }); return; }
    res.json(r.view);
  } catch { res.status(500).json({ error: 'Status lookup failed.' }); }
});

router.get('/:token', async (req: Request, res: Response) => {
  try {
    const r = await getPublicStatus(String(req.params.token || ''));
    if (!r) { res.status(404).type('text/html').send('<!doctype html><title>Not found</title><p style="font-family:system-ui;padding:40px">Unknown or disabled status page.</p>'); return; }
    res.setHeader('Cache-Control', 'public, max-age=30');
    res.status(200).type('text/html').send(r.html);
  } catch { res.status(500).type('text/html').send('<!doctype html><title>Error</title><p style="font-family:system-ui;padding:40px">Status page unavailable.</p>'); }
});

export default router;
