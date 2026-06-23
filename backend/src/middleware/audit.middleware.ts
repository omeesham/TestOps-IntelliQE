/**
 * Audit middleware — auto-logs every mutating API call on routes it wraps.
 *
 * Intended to be applied to the public business-capability API surface
 * (`/api/v1/public/*`) so HIPAA-grade audit trails are guaranteed regardless
 * of whether individual route handlers remembered to call `logAudit()`.
 *
 * For internal admin routes, prefer explicit `logAudit(req, action, ...)`
 * in the handler for finer-grained details.
 */
import type { Request, Response, NextFunction } from 'express';
import { logAudit, type AuditAction } from '../utils/audit.js';
import { logger } from '../utils/logger.js';

const METHOD_TO_ACTION: Record<string, AuditAction> = {
  POST: 'create',
  PUT: 'update',
  PATCH: 'update',
  DELETE: 'delete',
  GET: 'execute', // for public business-capability GETs we still record access
};

export function auditMutations(req: Request, res: Response, next: NextFunction): void {
  // Only mutating verbs — skip GET to avoid log bloat on hot dashboards.
  // For HIPAA-strict mode, set AUDIT_INCLUDE_READS=true.
  const action = METHOD_TO_ACTION[req.method];
  if (!action) return next();
  if (req.method === 'GET' && process.env.AUDIT_INCLUDE_READS !== 'true') return next();

  // Capture the response status so we record success vs failure.
  const finishedAt = () => {
    if (!req.user?.tenantId) return; // unauthenticated — skip
    const resourceType = req.baseUrl.replace(/^\/api\/v1\/public\//, '') || req.path;
    const rawId = (req.params && (req.params.id || req.params.runId)) || null;
    const resourceId = Array.isArray(rawId) ? rawId[0] ?? null : rawId;
    void logAudit(req, action, resourceType, resourceId, {
      method: req.method,
      path: req.path,
      status: res.statusCode,
      durationMs: req.startTime ? Date.now() - req.startTime : undefined,
    });
    logger.info('api.request', {
      requestId: req.requestId,
      tenantId: req.user.tenantId,
      user: req.user.username,
      method: req.method,
      path: req.path,
      status: res.statusCode,
    });
  };
  res.on('finish', finishedAt);
  next();
}
