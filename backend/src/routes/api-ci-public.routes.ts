/**
 * api-ci-public.routes.ts
 * ───────────────────────
 * PUBLIC CI face for the first-party GitHub Action. Mounted at /api/ci (in
 * index.ts, OUTSIDE auth) so a CI job can start and poll a run with only its
 * per-tenant CI token (`cit_<40hex>`) in the path — no IntelliQE login.
 *
 *   POST /api/ci/:token/runs            { endpoints, title?, coverage?, execute?, heal? } → 202 { jobId, pollUrl }
 *   GET  /api/ci/:token/runs/:jobId     → { status, stats, reportUrl }
 *
 * Inert until a tenant mints a token under the CI / GitHub Action panel.
 */
import { Router } from 'express';
import type { Request, Response } from 'express';
import { triggerCiRun, getCiRun } from '../services/api-ci.service.js';

const router = Router();

router.post('/:token/runs', (req: Request, res: Response) => {
  void (async () => {
    try {
      const result = await triggerCiRun(String(req.params.token || ''), req.body);
      res.status(result.ok ? 202 : 401).json(result);
    } catch (err) {
      res.status(200).json({ ok: false, error: (err as Error).message });
    }
  })();
});

router.get('/:token/runs/:jobId', (req: Request, res: Response) => {
  void (async () => {
    try {
      const result = await getCiRun(String(req.params.token || ''), String(req.params.jobId || ''));
      res.status(result.ok ? 200 : 404).json(result);
    } catch (err) {
      res.status(200).json({ ok: false, error: (err as Error).message });
    }
  })();
});

export default router;
