/**
 * Global error handler — mounted last in index.ts so it catches anything
 * that bubbles up from route handlers (sync throws, awaited promises, and
 * `next(err)` calls).
 *
 * Behavior:
 *   - ApiError                                  → { error, code, hint, requestId, details? } with its declared status
 *   - PlaywrightRunError                         → its toResponseJson() at its httpStatus
 *   - ZodError (`error.issues`)                  → 422 VALIDATION_FAILED with field-level details
 *   - SyntaxError from body-parser (`error.type`) → 400 BAD_REQUEST
 *   - Anything else                              → 500 INTERNAL_ERROR (no stack in prod)
 *
 * Details are only included in the response when the caller is admin OR the
 * server is in development. This keeps internal paths and stack traces out
 * of regular users' browsers in production.
 */
import type { Request, Response, NextFunction } from 'express';
import { ApiError } from '../utils/api-error.js';
import { PlaywrightRunError } from '../services/playwright-runner.service.js';
import { logger } from '../utils/logger.js';

interface ZodLikeError {
  issues?: Array<{ path: (string | number)[]; message: string }>;
  name?: string;
}

export function errorHandler(
  err: unknown,
  req: Request,
  res: Response,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _next: NextFunction,
): void {
  const requestId = (req as any).requestId;
  const isDev = process.env.NODE_ENV !== 'production';
  const isAdmin = req.user?.role === 'admin';
  const includeDetails = isDev || isAdmin;

  // ── 1. ApiError (the standard) ──
  if (err instanceof ApiError) {
    logger.warn('api.error', {
      requestId, code: err.code, status: err.status, path: req.path, msg: err.message,
    });
    const body: Record<string, unknown> = {
      error: err.message,
      code: err.code,
      requestId,
    };
    if (err.hint) body.hint = err.hint;
    if ((err.expose || includeDetails) && err.details !== undefined) body.details = err.details;
    res.status(err.status).json(body);
    return;
  }

  // ── 2. Domain-specific PlaywrightRunError ──
  if (err instanceof PlaywrightRunError) {
    logger.warn('api.playwright_error', { requestId, code: err.code, status: err.httpStatus, path: req.path });
    res.status(err.httpStatus).json({ ...err.toResponseJson(includeDetails), requestId });
    return;
  }

  // ── 3. ZodError (validation) — handle by duck-typing so we don't hard-import zod here ──
  const zodish = err as ZodLikeError;
  if (zodish && Array.isArray(zodish.issues) && zodish.name === 'ZodError') {
    logger.warn('api.validation_failed', { requestId, path: req.path, issues: zodish.issues });
    res.status(422).json({
      error: 'One or more fields are invalid.',
      code: 'VALIDATION_FAILED',
      hint: 'Review the highlighted issues and try again.',
      requestId,
      details: zodish.issues,
    });
    return;
  }

  // ── 4. body-parser SyntaxError ──
  const e = err as any;
  if (e && e.type === 'entity.parse.failed') {
    res.status(400).json({
      error: 'Request body is not valid JSON.',
      code: 'BAD_REQUEST',
      hint: 'Send a properly formatted JSON body.',
      requestId,
    });
    return;
  }

  // ── 5. Unknown — never leak stack in prod ──
  const status = typeof e?.status === 'number' ? e.status : 500;
  const message = isDev ? (e?.message || 'Unexpected error') : 'Internal server error.';
  logger.error('api.unhandled', {
    requestId,
    path: req.path,
    err: e?.message || String(err),
    stack: isDev ? e?.stack : undefined,
  });
  res.status(status).json({
    error: message,
    code: 'INTERNAL_ERROR',
    hint: 'Something went wrong on our end. Try again, or contact support if it persists.',
    requestId,
    ...(includeDetails && e?.stack ? { details: String(e.stack).slice(0, 4000) } : {}),
  });
}

/** Catch unhandled 404s (no route matched). Mount BEFORE errorHandler. */
export function notFoundHandler(req: Request, res: Response): void {
  res.status(404).json({
    error: 'Route not found.',
    code: 'NOT_FOUND',
    hint: 'Check the URL and HTTP method.',
    path: req.path,
    requestId: (req as any).requestId,
  });
}
