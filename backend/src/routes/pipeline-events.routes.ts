import { Router } from 'express';
import type { Request, Response } from 'express';
import { registerSSEConnection } from '../services/sse-manager.js';

const router = Router();

// GET /:runId — SSE stream for pipeline events
router.get('/:runId', (req: Request, res: Response) => {
  const runId = req.params.runId as string;
  const role = (req.query.role === 'admin') ? 'admin' : 'user';

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
