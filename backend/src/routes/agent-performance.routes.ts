/**
 * Agent Performance API — powers the Task-Manager-style monitor of the AI
 * pipeline agents.
 *
 *   GET  /api/agent-performance/stats   → aggregated per-agent stats snapshot
 *   GET  /api/agent-performance/events  → live SSE stream (agent_start / agent_run)
 *   POST /api/agent-performance/reset   → clear this tenant's captured runs
 *
 * All data is tenant-scoped and derived from the in-memory agent-metrics
 * service — no DB, no added latency to pipeline runs.
 */
import { Router } from 'express';
import type { Request, Response } from 'express';
import { registerSSEConnection } from '../services/sse-manager.js';
import { getAgentStats, clearAgentStats, agentPerfChannel } from '../services/agent-metrics.service.js';

const router = Router();

// GET /stats — aggregated snapshot for the current tenant.
router.get('/stats', (req: Request, res: Response) => {
  try {
    res.json(getAgentStats(req.user!.tenantId));
  } catch (err: any) {
    console.error('Agent performance stats error:', err.message);
    res.status(500).json({ error: 'Failed to load agent performance' });
  }
});

// GET /events — live SSE stream, channel derived from the caller's tenant.
router.get('/events', (req: Request, res: Response) => {
  const user = req.user!;

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  res.write(`data: ${JSON.stringify({ type: 'connected', timestamp: new Date().toISOString() })}\n\n`);
  registerSSEConnection(agentPerfChannel(user.tenantId), res);

  const keepalive = setInterval(() => {
    try { res.write(`: keepalive\n\n`); } catch { clearInterval(keepalive); }
  }, 30000);
  req.on('close', () => clearInterval(keepalive));
});

// POST /reset — clear captured runs for this tenant.
router.post('/reset', (req: Request, res: Response) => {
  try {
    clearAgentStats(req.user!.tenantId);
    res.json({ ok: true });
  } catch (err: any) {
    console.error('Agent performance reset error:', err.message);
    res.status(500).json({ error: 'Failed to reset agent performance' });
  }
});

export default router;
