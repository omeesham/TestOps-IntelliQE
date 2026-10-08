/**
 * web-tools.routes.ts
 * ───────────────────
 * The Web Lab's route group — /api/web-tools. Standalone, opt-in browser tools
 * that each launch their own short-lived Playwright browser:
 *
 *   POST /accessibility     axe-core WCAG scan of a URL
 *   POST /visual/capture    screenshots across engines + viewports
 *   GET  /visual/baselines  list stored visual baselines
 *   POST /visual/baseline   capture/overwrite a baseline
 *   POST /visual/compare    diff a fresh capture vs the baseline (pixel diff)
 *   DELETE /visual/baselines/:id
 *   GET  /responsive/devices   available device presets
 *   POST /responsive/capture   screenshots across device descriptors
 *   POST /performance       Core Web Vitals + resource timing
 *
 * None of these touch the generate → execute → heal pipeline.
 */
import { Router } from 'express';
import type { Request, Response } from 'express';
import { runAccessibilityScan } from '../services/web-a11y.service.js';
import {
  captureScreens, listVisualBaselines, captureVisualBaseline, compareVisual, deleteVisualBaseline, VIEWPORTS,
} from '../services/web-visual.service.js';
import { listDevicePresets, captureDevices } from '../services/web-responsive.service.js';
import { capturePerformance } from '../services/web-perf.service.js';

const router = Router();

function fail(res: Response, err: unknown, status = 400): void {
  res.status(status).json({ error: (err as Error)?.message || 'Request failed' });
}

/* ── Accessibility (WCAG / axe-core) ── */
router.post('/accessibility', async (req: Request, res: Response) => {
  try { res.json(await runAccessibilityScan(req.body || {})); }
  catch (err) { fail(res, err); }
});

/* ── Visual + cross-browser ── */
router.get('/visual/viewports', (_req: Request, res: Response) => {
  res.json({ viewports: Object.values(VIEWPORTS) });
});
router.post('/visual/capture', async (req: Request, res: Response) => {
  try { res.json(await captureScreens(req.body || {})); }
  catch (err) { fail(res, err); }
});
router.get('/visual/baselines', async (req: Request, res: Response) => {
  try { res.json({ baselines: await listVisualBaselines(req.user!.tenantId) }); }
  catch (err) { fail(res, err, 500); }
});
router.post('/visual/baseline', async (req: Request, res: Response) => {
  try { res.status(201).json({ baseline: await captureVisualBaseline(req.user!.tenantId, req.user!.username, req.body || {}) }); }
  catch (err) { fail(res, err); }
});
router.post('/visual/compare', async (req: Request, res: Response) => {
  try { res.json(await compareVisual(req.user!.tenantId, req.body || {})); }
  catch (err) { fail(res, err); }
});
router.delete('/visual/baselines/:id', async (req: Request, res: Response) => {
  try {
    const ok = await deleteVisualBaseline(req.user!.tenantId, String(req.params.id));
    if (!ok) { res.status(404).json({ error: 'Baseline not found.' }); return; }
    res.json({ ok: true });
  } catch (err) { fail(res, err); }
});

/* ── Responsive / device preview ── */
router.get('/responsive/devices', async (_req: Request, res: Response) => {
  try { res.json({ devices: await listDevicePresets() }); }
  catch (err) { fail(res, err, 500); }
});
router.post('/responsive/capture', async (req: Request, res: Response) => {
  try { res.json(await captureDevices(req.body || {})); }
  catch (err) { fail(res, err); }
});

/* ── Web performance (Core Web Vitals) ── */
router.post('/performance', async (req: Request, res: Response) => {
  try { res.json(await capturePerformance(req.body || {})); }
  catch (err) { fail(res, err); }
});

export default router;
