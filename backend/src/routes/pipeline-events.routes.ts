import { Router } from 'express';
import type { Request, Response } from 'express';
import pool from '../db.js';
import { getPipelineRun } from '../services/pipeline-queries.js';
import { registerSSEConnection } from '../services/sse-manager.js';

const router = Router();

// GET /:runId — SSE stream for pipeline events
router.get('/:runId', async (req: Request, res: Response) => {
  const runId = req.params.runId as string;
  const u = (req as any).user;

  // Only stream events for a run the caller's tenant owns. Role is taken from
  // the verified JWT, never a client-supplied query param.
  const run = await getPipelineRun(pool, runId);
  if (!run || (!u?.isPlatform && run.tenant_id !== u?.tenantId)) {
    res.status(404).json({ error: 'Run not found' });
    return;
  }
  const role = u?.role === 'admin' ? 'admin' : 'user';

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  // Send initial connected event
  res.write(`data: ${JSON.stringify({ type: 'connected', runId, timestamp: new Date().toISOString() })}\n\n`);

  registerSSEConnection(runId, res, role as 'user' | 'admin');

  // Keepalive every 30s
  const keepalive = setInterval(() => {
    try { res.write(`: keepalive\n\n`); } catch { clearInterval(keepalive); }
  }, 30000);

  req.on('close', () => clearInterval(keepalive));
});

export default router;
