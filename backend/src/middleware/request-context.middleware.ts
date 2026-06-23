/**
 * Request-context middleware.
 *
 * Stamps every request with:
 *   - `req.requestId`  — a UUID propagated to logs, audit_log, and SSE.
 *                        Re-used from the incoming `X-Request-Id` header if
 *                        one is supplied (useful for tracing across services).
 *   - `req.startTime`  — high-res start time for latency measurement.
 *
 * Adds the request id to the response as `X-Request-Id` so callers can
 * correlate client-side errors with server logs.
 */
import { randomUUID } from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      requestId?: string;
      startTime?: number;
    }
  }
}

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

export function requestContext(req: Request, res: Response, next: NextFunction): void {
  const incoming = (req.headers['x-request-id'] || '') as string;
  const requestId = UUID_RE.test(incoming) ? incoming : randomUUID();
  req.requestId = requestId;
  req.startTime = Date.now();
  res.setHeader('X-Request-Id', requestId);
  next();
}
