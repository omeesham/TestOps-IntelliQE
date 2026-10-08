/**
 * api-http.ts — a tiny, dependency-free HTTP helper shared by the standalone
 * "tools" (load test, security scan). It builds a request from a catalogue
 * endpoint (folding auth into headers) and issues it with a timeout.
 *
 * These tools live ALONGSIDE the generate → execute → heal pipeline and reuse
 * nothing from it; this helper keeps them from each re-deriving requests.
 */
/**
 * oauth2 config to fetch a token on demand (resolved at the CALL SITE, never
 * here — this helper stays dependency-free). When `type === 'oauth2'`, `value`
 * holds an ALREADY-resolved access token and is treated exactly like a bearer.
 */
export interface OAuth2AuthConfig {
  grant?: string; tokenUrl?: string; clientId?: string; clientSecret?: string;
  scope?: string; audience?: string; username?: string; password?: string;
  refreshToken?: string; clientAuthBasic?: boolean;
}
export interface HttpAuth { type: string; value?: string; headerName?: string; oauth2?: OAuth2AuthConfig }

/** A form-data / urlencoded field. `type:'file'` fields carry base64 content. */
export interface HttpFormField { key: string; value?: string; type?: 'text' | 'file'; filename?: string; contentType?: string; dataBase64?: string }

export interface HttpEndpoint {
  method: string;
  url: string;
  headers?: { key: string; value: string }[];
  auth?: HttpAuth;
  body?: string;
  /** How to materialize the body. Omitted/'raw'/'json' = the original behaviour (byte-identical). */
  bodyMode?: 'raw' | 'json' | 'form-data' | 'urlencoded' | 'binary';
  /** form-data / urlencoded fields (used only when bodyMode is one of those). */
  formFields?: HttpFormField[];
  /** binary mode: base64 payload + its content type. */
  bodyBase64?: string;
  bodyContentType?: string;
}

const WRITE_METHODS = ['POST', 'PUT', 'PATCH', 'DELETE'];
export function isWriteMethod(method: string): boolean {
  return WRITE_METHODS.includes((method || 'GET').toUpperCase());
}

function hasContentType(headers: Record<string, string>): boolean {
  return Object.keys(headers).some((k) => k.toLowerCase() === 'content-type');
}
function deleteContentType(headers: Record<string, string>): void {
  for (const k of Object.keys(headers)) { if (k.toLowerCase() === 'content-type') delete headers[k]; }
}

export function buildHeaders(ep: HttpEndpoint, opts: { omitAuth?: boolean } = {}): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const h of ep.headers || []) { if (h?.key) headers[h.key] = h.value ?? ''; }
  const a = ep.auth;
  if (!opts.omitAuth && a && a.type !== 'none' && a.value) {
    // oauth2 carries a pre-resolved access token → treat exactly like bearer.
    if (a.type === 'bearer' || a.type === 'oauth2') headers['Authorization'] = `Bearer ${a.value}`;
    else if (a.type === 'basic') headers['Authorization'] = `Basic ${Buffer.from(a.value).toString('base64')}`;
    else if (a.type === 'apikey') headers[a.headerName || 'X-API-Key'] = a.value;
  }
  return headers;
}

export function buildRequestInit(
  ep: HttpEndpoint,
  opts: { omitAuth?: boolean; extraHeaders?: Record<string, string>; method?: string } = {},
): { url: string; init: RequestInit } {
  const method = (opts.method || ep.method || 'GET').toUpperCase();
  const headers = { ...buildHeaders(ep, opts), ...(opts.extraHeaders || {}) };
  let body: BodyInit | undefined;

  if (isWriteMethod(method)) {
    const mode = ep.bodyMode || 'raw';
    if (mode === 'form-data') {
      const fd = new FormData();
      for (const f of ep.formFields || []) {
        if (!f?.key) continue;
        if (f.type === 'file') {
          const buf = f.dataBase64 ? Buffer.from(f.dataBase64, 'base64') : Buffer.from('');
          fd.append(f.key, new Blob([buf], f.contentType ? { type: f.contentType } : {}), f.filename || f.key);
        } else {
          fd.append(f.key, f.value ?? '');
        }
      }
      deleteContentType(headers);            // let fetch set multipart boundary
      body = fd;
    } else if (mode === 'urlencoded') {
      const params = new URLSearchParams();
      for (const f of ep.formFields || []) { if (f?.key) params.append(f.key, f.value ?? ''); }
      deleteContentType(headers);            // fetch sets application/x-www-form-urlencoded
      body = params;
    } else if (mode === 'binary') {
      if (ep.bodyBase64) {
        body = Buffer.from(ep.bodyBase64, 'base64');
        if (ep.bodyContentType && !hasContentType(headers)) headers['Content-Type'] = ep.bodyContentType;
      }
    } else if (ep.body) {
      // raw / json — the original path, unchanged.
      body = ep.body;
      if (!hasContentType(headers)) headers['Content-Type'] = 'application/json';
    }
  }

  return { url: ep.url, init: { method, headers, body } };
}

export interface TimedResult { ok: boolean; status?: number; elapsedMs: number; error?: string }
/** Issue a request, drain the body, and report status + timing only. */
export async function timedFetch(url: string, init: RequestInit, timeoutMs = 15_000): Promise<TimedResult> {
  const started = Date.now();
  try {
    const res = await fetch(url, { ...init, redirect: 'follow', signal: AbortSignal.timeout(timeoutMs) });
    try { await res.arrayBuffer(); } catch { /* body drained best-effort */ }
    return { ok: res.ok, status: res.status, elapsedMs: Date.now() - started };
  } catch (e) {
    return { ok: false, elapsedMs: Date.now() - started, error: (e as Error).message || String(e) };
  }
}

export interface FullResult { ok: boolean; status?: number; headers: Record<string, string>; bodyText: string; elapsedMs: number; error?: string }
/** Issue a request and return status, headers and a truncated body. */
export async function fetchFull(url: string, init: RequestInit, timeoutMs = 15_000, bodyLimit = 8000): Promise<FullResult> {
  const started = Date.now();
  try {
    const res = await fetch(url, { ...init, redirect: 'follow', signal: AbortSignal.timeout(timeoutMs) });
    const headers: Record<string, string> = {};
    res.headers.forEach((v, k) => { headers[k] = v; });
    let bodyText = '';
    try { bodyText = (await res.text()).slice(0, bodyLimit); } catch { /* empty body */ }
    return { ok: res.ok, status: res.status, headers, bodyText, elapsedMs: Date.now() - started };
  } catch (e) {
    return { ok: false, headers: {}, bodyText: '', elapsedMs: Date.now() - started, error: (e as Error).message || String(e) };
  }
}

export function clampInt(n: unknown, def: number, min: number, max: number): number {
  const v = typeof n === 'number' && Number.isFinite(n) ? Math.floor(n) : def;
  return Math.min(max, Math.max(min, v));
}
