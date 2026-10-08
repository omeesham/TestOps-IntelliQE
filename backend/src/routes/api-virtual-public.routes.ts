/**
 * api-virtual-public.routes.ts
 * ────────────────────────────
 * PUBLIC face of stateful service virtualization. Mounted at /vs (in index.ts,
 * OUTSIDE auth) so a system-under-test can call the virtual service with no
 * IntelliQE login — the unguessable :token is the capability.
 *
 *   ANY /vs/:token[/...]  → matched against the service's rules; applies latency
 *                           + fault injection + state mutation; replays the
 *                           templated response.
 */
import { Router } from 'express';
import type { Request, Response } from 'express';
import { resolveVirtual } from '../services/api-virtual.service.js';

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

  const query: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.query || {})) query[k] = Array.isArray(v) ? String(v[0]) : String(v);

  const resolution = await resolveVirtual(token, {
    method: req.method,
    path: '/' + sub,
    query,
    headers: req.headers as Record<string, string>,
    body,
  });
  if (!resolution) { res.status(404).json({ error: 'Unknown virtual-service token.' }); return; }

  const send = () => {
    // Fault injection — model the adverse conditions a real dependency exhibits.
    if (resolution.fault === 'abort') { try { req.socket.destroy(); } catch { /* ignore */ } return; }
    if (resolution.fault === 'timeout') { /* never respond — the client hits its own timeout */ return; }
    if (resolution.fault === 'server-500') { res.status(500).type('application/json').send(JSON.stringify({ error: 'injected server error' })); return; }
    for (const [k, v] of Object.entries(resolution.headers)) { try { res.setHeader(k, v); } catch { /* ignore reserved */ } }
    res.setHeader('X-Virtual-Matched', resolution.matched ? '1' : '0');
    if (resolution.fault === 'malformed') { res.status(resolution.status).type('application/json').send((resolution.body || '{}').slice(0, Math.max(1, Math.floor((resolution.body || '{}').length / 2)))); return; }
    res.status(resolution.status).send(resolution.body);
  };

  if (resolution.delayMs > 0) setTimeout(send, Math.min(30000, resolution.delayMs));
  else send();
}

router.all('/:token/*splat', (req: Request, res: Response) => { void handle(req, res); });
router.all('/:token', (req: Request, res: Response) => { void handle(req, res); });

export default router;
