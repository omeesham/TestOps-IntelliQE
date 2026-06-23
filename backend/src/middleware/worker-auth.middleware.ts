import type { Request, Response, NextFunction } from 'express';

const WORKER_SECRET = process.env.WORKER_SECRET || 'dev-secret';

export function workerAuthMiddleware(req: Request, res: Response, next: NextFunction): void {
  const secret = req.headers['x-worker-secret'];
  if (secret !== WORKER_SECRET) {
    res.status(401).json({ error: 'Invalid worker secret' });
    return;
  }
  next();
}
