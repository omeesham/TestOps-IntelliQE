/**
 * api-mock-public.routes.ts
 * ─────────────────────────
 * The PUBLIC face of the hosted mock server. Mounted at /mock (in index.ts,
 * OUTSIDE the auth middleware) so a system-under-test can call a published mock
 * without an IntelliQE login — the unguessable :mockId is the capability.
 *
 *   ANY /mock/:mockId/<any/path>  → the stored example status + body
 *
 * Read-only: it looks up one row by mock id and replays a canned response. It
 * never reads tenant context or touches the generation/execute/heal pipeline.
 */
import { Router } from 'express';
import type { Request, Response } from 'express';
import { serveMock } from '../services/api-mock.service.js';

const router = Router();

/** Permissive CORS — a mock exists to be called from anywhere during testing. */
function cors(res: Response): void {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS,HEAD');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('X-IntelliQE-Mock', '1');
}

router.options('/:mockId/*splat', (_req: Request, res: Response) => { cors(res); res.status(204).end(); });
router.options('/:mockId', (_req: Request, res: Response) => { cors(res); res.status(204).end(); });

async function handle(req: Request, res: Response): Promise<void> {
  cors(res);
  const mockId = String(req.params.mockId || '');
  // Everything after /mock/:mockId is the path the mock matches on. Express 5 /
  // path-to-regexp v8 expose the named wildcard as `splat` — an array of path
  // segments (or a string on some versions); normalise both to a path.
  const splat = (req.params as Record<string, unknown>).splat;
  const sub = Array.isArray(splat) ? splat.join('/') : (splat != null ? String(splat) : '');
  try {
    const hit = await serveMock(mockId, req.method, '/' + sub);
    if (hit === null) { res.status(404).json({ error: 'Unknown or disabled mock.' }); return; }
    if ('notFound' in hit) {
      res.status(404).json({ error: `No mock route for ${req.method} /${sub}`, available: hit.routes });
      return;
    }
    res.status(hit.status).type(hit.contentType).send(hit.body);
  } catch {
    res.status(500).json({ error: 'Mock lookup failed.' });
  }
}

router.all('/:mockId/*splat', (req: Request, res: Response) => { void handle(req, res); });
router.all('/:mockId', (req: Request, res: Response) => { void handle(req, res); });

export default router;
