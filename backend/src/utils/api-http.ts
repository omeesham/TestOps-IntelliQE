/**
 * api-http.ts — a tiny, dependency-free HTTP helper shared by the standalone
 * "tools" (load test, security scan). It builds a request from a catalogue
 * endpoint (folding auth into headers) and issues it with a timeout.
 *
 * These tools live ALONGSIDE the generate → execute → heal pipeline and reuse
 * nothing from it; this helper keeps them from each re-deriving requests.
 */
export interface HttpAuth { type: string; value?: string; headerName?: string }
export interface HttpEndpoint {
  method: string;
  url: string;
  headers?: { key: string; value: string }[];
  auth?: HttpAuth;
  body?: string;
}

const WRITE_METHODS = ['POST', 'PUT', 'PATCH', 'DELETE'];
export function isWriteMethod(method: string): boolean {
  return WRITE_METHODS.includes((method || 'GET').toUpperCase());
}

export function buildHeaders(ep: HttpEndpoint, opts: { omitAuth?: boolean } = {}): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const h of ep.headers || []) { if (h?.key) headers[h.key] = h.value ?? ''; }
  const a = ep.auth;
  if (!opts.omitAuth && a && a.type !== 'none' && a.value) {
    if (a.type === 'bearer') headers['Authorization'] = `Bearer ${a.value}`;
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
  const body = isWriteMethod(method) && ep.body ? ep.body : undefined;
  if (body && !Object.keys(headers).some((k) => k.toLowerCase() === 'content-type')) headers['Content-Type'] = 'application/json';
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
