/**
 * api-spec.ts
 * ───────────
 * Validation + normalisation for the API Automation payload the client sends.
 *
 * The API Studio posts the same endpoint definition to three stages —
 * generation, execution and healing — and each needs it in the same trusted
 * shape: an absolute http(s) URL, a derived origin to use as the run target,
 * bounded strings, and an auth block reduced to a known scheme. Keeping that in
 * one place is what stops the three call-sites from drifting apart.
 */
import type { ApiSpec } from '../agents/state.js';

/**
 * Turn a raw client payload into an ApiSpec, or null when there is no usable
 * spec (no object, or the URL is not a valid absolute http(s) URL). Callers
 * turn null into a 400 only when a spec was actually submitted — an absent
 * `apiSpec` simply means "this is not an API run".
 *
 * `baseUrl` (scheme + host) is derived here and used as the execution target,
 * so API runs never depend on a configured web application.
 */
export function sanitizeApiSpec(raw: any): ApiSpec | null {
  if (!raw || typeof raw !== 'object') return null;
  const url = typeof raw.url === 'string' ? raw.url.trim() : '';
  if (!url) return null;
  let baseUrl: string;
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    baseUrl = u.origin;
  } catch {
    return null;
  }

  const method = String(raw.method || 'GET').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 10) || 'GET';

  const headers = Array.isArray(raw.headers)
    ? raw.headers
        .filter((h: any) => h && typeof h === 'object' && String(h.key || '').trim())
        .slice(0, 40)
        .map((h: any) => ({ key: String(h.key).trim().slice(0, 200), value: String(h.value ?? '').slice(0, 2000) }))
    : undefined;

  const authTypeRaw = String(raw?.auth?.type || 'none').toLowerCase();
  type AuthType = NonNullable<ApiSpec['auth']>['type'];
  const authType: AuthType = (['none', 'bearer', 'basic', 'apikey'] as const).includes(authTypeRaw as any)
    ? (authTypeRaw as AuthType)
    : 'none';
  const headerNameRaw = String(raw?.auth?.headerName ?? '').trim().replace(/[^A-Za-z0-9-_]/g, '').slice(0, 100);
  const auth: NonNullable<ApiSpec['auth']> = {
    type: authType,
    value: authType === 'none' ? undefined : String(raw?.auth?.value ?? '').slice(0, 4000) || undefined,
    headerName: authType === 'apikey' && headerNameRaw ? headerNameRaw : undefined,
  };

  const statusNum = Number(raw.expectedStatus);
  const expectedStatus = Number.isInteger(statusNum) && statusNum >= 100 && statusNum <= 599
    ? statusNum
    : undefined;

  const coverageRaw = String(raw.coverage || '').toLowerCase();
  const coverage: ApiSpec['coverage'] = (['essential', 'standard', 'exhaustive'] as const).includes(coverageRaw as any)
    ? (coverageRaw as ApiSpec['coverage'])
    : undefined;

  return {
    method,
    url,
    baseUrl,
    headers,
    auth,
    body: typeof raw.body === 'string' ? raw.body.slice(0, 20000) : undefined,
    expectedStatus,
    expectedResponse: typeof raw.expectedResponse === 'string' ? raw.expectedResponse.slice(0, 20000) : undefined,
    coverage,
  };
}
