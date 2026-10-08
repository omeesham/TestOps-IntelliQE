/**
 * api-agent-public.routes.ts
 * ──────────────────────────
 * PUBLIC event-ingest face for the AI coworker's opt-in autonomy. Mounted at
 * /agent-event (in index.ts, OUTSIDE auth) so a GitHub PR webhook or a Jira
 * sprint webhook can POST to /agent-event/:token with no IntelliQE login — the
 * unguessable per-tenant token is the capability. The event is recorded and,
 * when the tenant enabled a matching trigger, flagged as a suggested action for
 * the UI to surface. It never launches a pipeline run on its own.
 *
 * Inert until a tenant mints a token under the AI Coworker → Autonomy tab.
 */
import { Router } from 'express';
import type { Request, Response } from 'express';
import { ingestEvent } from '../services/api-orchestrator.service.js';

const router = Router();

async function handle(req: Request, res: Response): Promise<void> {
  const token = String(req.params.token || '');
  try {
    const result = await ingestEvent(token, req.body);
    if (!result.received) { res.status(404).json({ error: 'Unknown agent-event token.' }); return; }
    res.json(result);
  } catch (err) {
    res.status(200).json({ received: false, error: (err as Error).message });   // never fail a webhook hard
  }
}

router.post('/:token', (req: Request, res: Response) => { void handle(req, res); });
router.post('/:token/*splat', (req: Request, res: Response) => { void handle(req, res); });

export default router;
