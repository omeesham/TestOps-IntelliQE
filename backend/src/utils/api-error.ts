/**
 * Standardized API error class + helpers.
 *
 * Use these in route handlers so every error response carries the same
 * shape — `{ error, code, hint, requestId, details? }` — and the right
 * HTTP status. The global errorHandler middleware turns thrown `ApiError`s
 * (and known third-party errors like ZodError) into uniform JSON.
 */

export type ErrorCode =
  // ── generic HTTP categories ──
  | 'BAD_REQUEST'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'VALIDATION_FAILED'
  | 'RATE_LIMITED'
  | 'INTERNAL_ERROR'
  | 'SERVICE_UNAVAILABLE'
  | 'GATEWAY_TIMEOUT'
  // ── domain-specific (extend as the app grows) ──
  | 'NO_TENANT'
  | 'INACTIVE_USER'
  | 'INTEGRATION_NOT_CONNECTED'
  | string;

export class ApiError extends Error {
  code: ErrorCode;
  hint?: string;
  status: number;
  details?: unknown;
  expose: boolean; // whether to leak `details` to non-admin callers in prod

  constructor(opts: {
    code: ErrorCode;
    message: string;
    status: number;
    hint?: string;
    details?: unknown;
    expose?: boolean;
  }) {
    super(opts.message);
    this.name = 'ApiError';
    this.code = opts.code;
    this.status = opts.status;
    this.hint = opts.hint;
    this.details = opts.details;
    this.expose = opts.expose ?? false;
  }
}

/* ── Convenience constructors ─────────────────────────────────── */
export const badRequest = (message = 'Invalid request', opts: { code?: ErrorCode; hint?: string; details?: unknown } = {}) =>
  new ApiError({ status: 400, code: opts.code || 'BAD_REQUEST', message, hint: opts.hint, details: opts.details });

export const unauthorized = (message = 'Authentication required', opts: { code?: ErrorCode; hint?: string } = {}) =>
  new ApiError({ status: 401, code: opts.code || 'UNAUTHORIZED', message, hint: opts.hint });

export const forbidden = (message = 'You don’t have permission for this action', opts: { code?: ErrorCode; hint?: string } = {}) =>
  new ApiError({ status: 403, code: opts.code || 'FORBIDDEN', message, hint: opts.hint });

export const notFound = (message = 'Resource not found', opts: { code?: ErrorCode; hint?: string } = {}) =>
  new ApiError({ status: 404, code: opts.code || 'NOT_FOUND', message, hint: opts.hint });

export const conflict = (message = 'Resource already exists', opts: { code?: ErrorCode; hint?: string } = {}) =>
  new ApiError({ status: 409, code: opts.code || 'CONFLICT', message, hint: opts.hint });

export const validationFailed = (
  message = 'One or more fields are invalid',
  opts: { hint?: string; details?: unknown } = {},
) =>
  new ApiError({ status: 422, code: 'VALIDATION_FAILED', message, hint: opts.hint, details: opts.details, expose: true });

export const tooManyRequests = (message = 'Too many requests', opts: { hint?: string } = {}) =>
  new ApiError({ status: 429, code: 'RATE_LIMITED', message, hint: opts.hint });

export const internalError = (message = 'Internal server error', opts: { details?: unknown; hint?: string } = {}) =>
  new ApiError({ status: 500, code: 'INTERNAL_ERROR', message, hint: opts.hint, details: opts.details });
