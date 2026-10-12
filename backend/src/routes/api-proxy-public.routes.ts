/**
 * api-proxy-public.routes.ts
 * ──────────────────────────
 * The PUBLIC face of the contract-validating / simulating proxy. Mounted at
 * /proxy (in index.ts, OUTSIDE auth) so a system-under-test can point at
 *   ANY /proxy/:token/<any/path>
 * In validate mode it forwards to the real target and checks the live response
 * against the stored contract; in simulate mode it replies from stored examples.
 * The unguessable :token is the capability; no login, no tenant context read
 * beyond the row the token resolves. Never touches the pipeline.
 */
import { Router } from 'express';
import type { Request, Response } from 'express';
import { serveProxy } from '../services/api-proxy.service.js';

const router = Router();

function cors(res: Response): void {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS,HEAD');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('X-IntelliQE-Proxy', '1');
}

function bodyString(req: Request): string | undefined {
  const b = (req as any).body;
  if (b == null) return undefined;
  if (typeof b === 'string') return b || undefined;
  if (Buffer.isBuffer(b)) return b.toString('utf8') || undefined;
  if (typeof b === 'object') { try { return Object.keys(b).length ? JSON.stringify(b) : undefined; } catch { return undefined; } }
  return undefined;
}

router.options('/:token/*splat', (_req: Request, res: Response) => { cors(res); res.status(204).end(); });
router.options('/:token', (_req: Request, res: Response) => { cors(res); res.status(204).end(); });

async function handle(req: Request, res: Response): Promise<void> {
  cors(res);
  const token = String(req.params.token || '');
  const splat = (req.params as Record<string, unknown>).splat;
  const sub = Array.isArray(splat) ? splat.join('/') : (splat != null ? String(splat) : '');
  const query = (req.originalUrl.split('?')[1] || '');
  try {
    const hit = await serveProxy(token, req.method, '/' + sub, query, bodyString(req));
    if (hit === null) { res.status(404).json({ error: 'Unknown or disabled proxy.' }); return; }
    res.setHeader('X-IntelliQE-Validation', hit.validation);
    res.status(hit.status).type(hit.contentType).send(hit.body);
  } catch {
    res.status(500).json({ error: 'Proxy failed.' });
  }
}

router.all('/:token/*splat', (req: Request, res: Response) => { void handle(req, res); });
router.all('/:token', (req: Request, res: Response) => { void handle(req, res); });

export default router;
