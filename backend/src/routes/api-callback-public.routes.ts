/**
 * api-callback-public.routes.ts
 * ─────────────────────────────
 * PUBLIC face of async-callback verification. Mounted at /hook (in index.ts,
 * OUTSIDE auth) so a third-party service can POST its webhook/callback here
 * without an IntelliQE login — the unguessable :token is the capability.
 *
 *   ANY /hook/:token[/...]  → recorded as a callback event for that listener
 *
 * It records and acknowledges; it never reads tenant context or the pipeline.
 */
import { Router } from 'express';
import type { Request, Response } from 'express';
import { recordCallback } from '../services/api-callback.service.js';

const router = Router();

async function handle(req: Request, res: Response): Promise<void> {
  const token = String(req.params.token || '');
  const splat = (req.params as Record<string, unknown>).splat;
  const sub = Array.isArray(splat) ? splat.join('/') : (splat != null ? String(splat) : '');
  let body = '';
  try {
    if (typeof req.body === 'string') body = req.body;
    else if (req.body && typeof req.body === 'object' && Object.keys(req.body).length) body = JSON.stringify(req.body);
  } catch { /* ignore */ }
  try {
    const ok = await recordCallback(token, {
      method: req.method,
      path: '/' + sub,
      query: req.originalUrl.includes('?') ? req.originalUrl.slice(req.originalUrl.indexOf('?') + 1) : '',
      headers: req.headers as Record<string, unknown>,
      body,
    });
    if (!ok) { res.status(404).json({ error: 'Unknown callback token.' }); return; }
    res.status(200).json({ received: true });
  } catch {
    res.status(200).json({ received: true }); // never fail the caller's webhook
  }
}

router.all('/:token/*splat', (req: Request, res: Response) => { void handle(req, res); });
router.all('/:token', (req: Request, res: Response) => { void handle(req, res); });

export default router;
