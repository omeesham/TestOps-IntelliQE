import crypto from 'crypto';
import type { Request, Response, NextFunction } from 'express';

// Never ship a guessable default in production. In dev, fall back to a local
// value so the worker still runs locally.
const WORKER_SECRET = process.env.WORKER_SECRET
  || (process.env.NODE_ENV === 'production'
      ? (() => { throw new Error('WORKER_SECRET is required in production'); })()
      : 'dev-secret');

export function workerAuthMiddleware(req: Request, res: Response, next: NextFunction): void {
  const secret = req.headers['x-worker-secret'];
  // Constant-time comparison to avoid timing attacks on the shared secret.
  const a = Buffer.from(typeof secret === 'string' ? secret : '');
  const b = Buffer.from(WORKER_SECRET);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    res.status(401).json({ error: 'Invalid worker secret' });
    return;
  }
  next();
}
