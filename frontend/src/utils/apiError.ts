/**
 * Centralized API error normalization.
 *
 * Every place in the app that catches an axios / fetch / generic error should
 * pass it through `normalizeError()` to get a consistent shape suitable for
 * UI display. The output mirrors the backend's structured-error contract:
 *   { code, message, hint, requestId, details }
 *
 * On top of that we derive:
 *   - `title`    — short human label for the error category (for headlines)
 *   - `severity` — error | warning | info
 *   - `retryable` — true if the user could reasonably retry the same action
 */
import type { AxiosError } from 'axios';

export type ErrorSeverity = 'error' | 'warning' | 'info';

export interface NormalizedError {
  code: string;
  title: string;
  message: string;
  hint?: string;
  severity: ErrorSeverity;
  retryable: boolean;
  requestId?: string;
  status?: number;
  details?: string;
}

/* ──────────────────────────────────────────────────────────────────
   Title + hint catalog — keyed by code, falls back to status code.
   Keep titles SHORT (4 words max) so they fit on one line in toasts.
   ────────────────────────────────────────────────────────────────── */
const CATALOG: Record<string, { title: string; hint?: string; severity?: ErrorSeverity; retryable?: boolean }> = {
  // ── Network / transport ──
  NETWORK_DOWN:        { title: 'Cannot reach server',        hint: 'Check your internet connection and try again.', retryable: true },
  TIMEOUT:             { title: 'Request timed out',          hint: 'The server is taking too long. Try again in a moment.', retryable: true },
  REQUEST_CANCELLED:   { title: 'Request cancelled',          severity: 'info', retryable: true },

  // ── HTTP status-code generic fallbacks ──
  HTTP_400: { title: 'Invalid request',         hint: 'Some fields look incorrect. Review and try again.' },
  HTTP_401: { title: 'Session expired',         hint: 'Please log in again to continue.' },
  HTTP_403: { title: 'Access denied',           hint: 'You don’t have permission for this action. Contact your admin.' },
  HTTP_404: { title: 'Not found',               hint: 'The item you’re looking for doesn’t exist or has been removed.' },
  HTTP_409: { title: 'Conflict',                hint: 'This conflicts with an existing record (duplicate?). Review and try again.' },
  HTTP_422: { title: 'Validation failed',       hint: 'One or more fields are invalid. Review the highlighted issues.' },
  HTTP_429: { title: 'Too many requests',       hint: 'You’ve hit a rate limit. Wait a moment before trying again.', severity: 'warning', retryable: true },
  HTTP_500: { title: 'Server error',            hint: 'Something went wrong on our end. Please try again.', retryable: true },
  HTTP_502: { title: 'Bad gateway',             hint: 'The server is temporarily unreachable.', retryable: true },
  HTTP_503: { title: 'Service unavailable',     hint: 'The service is briefly offline. Please try again shortly.', retryable: true },
  HTTP_504: { title: 'Gateway timeout',         hint: 'The server took too long to respond.', retryable: true },

  // ── Domain-specific (Playwright/Allure) — keep aligned with backend codes ──
  NO_SCRIPTS:         { title: 'No automation scripts' },
  MISSING_DEPS:       { title: 'Playwright not installed' },
  BROWSERS_MISSING:   { title: 'Browsers missing' },
  NO_TESTS:           { title: 'No runnable tests' },
  TARGET_UNREACHABLE: { title: 'App unreachable' },
  COMPILE_ERROR:      { title: 'Script syntax error' },
  WORKER_ENV:         { title: 'Runner not available' },
  NO_RUN:             { title: 'No run selected', severity: 'warning' },

  // ── Generic fallback ──
  UNKNOWN: { title: 'Something went wrong', hint: 'An unexpected error occurred. If it persists, contact support.', retryable: true },
};

/**
 * Normalize any thrown value into a UI-friendly error.
 * Accepts: AxiosError, native Error, plain object with .message, or string.
 */
export function normalizeError(err: unknown): NormalizedError {
  // Already normalized?
  if (err && typeof err === 'object' && 'code' in err && 'title' in err && 'severity' in err) {
    return err as NormalizedError;
  }

  // Axios-style error
  const ax = err as AxiosError<any> | undefined;
  if (ax && typeof ax === 'object' && 'isAxiosError' in ax && ax.isAxiosError) {
    // Network / transport failure (no response received)
    if (!ax.response) {
      if (ax.code === 'ECONNABORTED' || /timeout/i.test(ax.message || '')) {
        return fromCatalog('TIMEOUT', { details: ax.message });
      }
      if (ax.code === 'ERR_CANCELED' || ax.code === 'ERR_CANCELLED') {
        return fromCatalog('REQUEST_CANCELLED');
      }
      // ERR_NETWORK / Failed to fetch / connection refused
      return fromCatalog('NETWORK_DOWN', { details: ax.message });
    }

    // Response was received — server-side error
    const status = ax.response.status;
    const data = ax.response.data || {};
    const serverCode: string | undefined = typeof data.code === 'string' ? data.code : undefined;
    const serverMessage: string | undefined =
      typeof data.error === 'string' ? data.error :
      typeof data.message === 'string' ? data.message :
      undefined;
    const serverHint: string | undefined = typeof data.hint === 'string' ? data.hint : undefined;
    const requestId: string | undefined =
      typeof data.requestId === 'string' ? data.requestId : (ax.response.headers?.['x-request-id'] as string | undefined);
    const details: string | undefined = typeof data.details === 'string' ? data.details : undefined;

    // Prefer the backend's code if we have a catalog entry for it.
    const code = serverCode && CATALOG[serverCode] ? serverCode : `HTTP_${status}`;
    return fromCatalog(code, {
      message: serverMessage,
      hint: serverHint,
      requestId,
      status,
      details,
    });
  }

  // Plain Error
  if (err instanceof Error) {
    return fromCatalog('UNKNOWN', { message: err.message, details: err.stack });
  }

  // String
  if (typeof err === 'string') {
    return fromCatalog('UNKNOWN', { message: err });
  }

  return fromCatalog('UNKNOWN');
}

function fromCatalog(
  code: string,
  overrides: Partial<NormalizedError> & { message?: string } = {},
): NormalizedError {
  const cat = CATALOG[code] || CATALOG.UNKNOWN;
  return {
    code,
    title: cat.title,
    message: overrides.message ?? cat.title,
    hint: overrides.hint ?? cat.hint,
    severity: overrides.severity ?? cat.severity ?? 'error',
    retryable: overrides.retryable ?? cat.retryable ?? false,
    requestId: overrides.requestId,
    status: overrides.status,
    details: overrides.details,
  };
}

/** Convenience: shorthand to construct an error in catch blocks. */
export function asNormalized(err: unknown): NormalizedError {
  return normalizeError(err);
}
