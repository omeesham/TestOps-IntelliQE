/**
 * api-wiremock.service.ts
 * ───────────────────────
 * The EXTERNAL mock-server connector (API-013). IntelliQE already ships its own
 * hosted mock (api-mock.service) and a Prism/Hoverfly-parity proxy; this module
 * instead bridges the catalogue to the two de-facto standard tools teams already
 * run:
 *
 *   • WireMock — exports the catalogue as stub MAPPINGS, imports existing
 *     mappings back as endpoints, and can PUSH/sync mappings to a live WireMock
 *     admin API (/__admin/mappings) or PING it.
 *   • Prism    — exports a minimal, example-bearing OpenAPI 3.0 spec that
 *     `prism mock spec.json` serves directly, plus the command to run it.
 *
 * Stateless by design: pure format conversions reusing only the shared HTTP
 * helper for the live-sync calls. No tables, and the generate → execute → heal
 * pipeline is never involved.
 */
import { fetchFull } from '../utils/api-http.js';

export interface WmEndpointInput {
  method?: string;
  url?: string;
  path?: string;
  pathTemplate?: string;
  expectedStatus?: number;
  status?: number;
  expectedResponse?: string;
  body?: string;
  contentType?: string;
  headers?: { key?: string; value?: string }[];
  title?: string;
}

const MAX_ENDPOINTS = 500;
const BODY_LIMIT = 200_000;

function looksJson(s: string): boolean {
  const t = s.trim();
  return (t.startsWith('{') && t.endsWith('}')) || (t.startsWith('[') && t.endsWith(']'));
}

/** Pathname only (leading slash, no query/trailing slash), templates preserved. */
function pathFrom(e: WmEndpointInput): string {
  const raw = (e.pathTemplate && e.pathTemplate.trim()) || (e.path && e.path.trim()) || '';
  if (raw) return ('/' + raw.replace(/^\/+/, '')).replace(/\/+$/, '') || '/';
  try {
    const u = new URL(String(e.url || ''));
    return u.pathname.replace(/\/+$/, '') || '/';
  } catch { return '/'; }
}

/** `/users/:id` or `/users/{id}` → true (has a path variable). */
function isTemplated(path: string): boolean {
  return /\/(?::[^/]+|\{[^}]+\})/.test(path);
}

/** Turn a templated path into a WireMock urlPathPattern regex (each var → one segment). */
function toUrlPathPattern(path: string): string {
  return path.replace(/\/(?::[^/]+|\{[^}]+\})/g, '/[^/]+');
}

/** `:id` → `{id}` so the path is valid OpenAPI for Prism. */
function toOpenApiPath(path: string): string {
  return path.replace(/\/:([^/]+)/g, '/{$1}');
}

function statusOf(e: WmEndpointInput): number {
  return Number(e.status ?? e.expectedStatus) || 200;
}

function bodyOf(e: WmEndpointInput): string {
  return (e.body ?? e.expectedResponse ?? '').toString().slice(0, BODY_LIMIT);
}

function methodOf(e: WmEndpointInput): string {
  return String(e.method || 'GET').toUpperCase().replace(/[^A-Z]/g, '') || 'GET';
}

function list(raw: unknown): WmEndpointInput[] {
  return (Array.isArray(raw) ? raw : []).slice(0, MAX_ENDPOINTS) as WmEndpointInput[];
}

/* ────────────────────────────────────────────────────────────────
   WireMock mappings
   ──────────────────────────────────────────────────────────────── */

export interface WireMockMapping {
  request: { method: string; urlPath?: string; urlPathPattern?: string };
  response: { status: number; headers?: Record<string, string>; jsonBody?: unknown; body?: string };
  metadata?: { source: string };
}

function buildMapping(e: WmEndpointInput): WireMockMapping | null {
  if (!e || typeof e !== 'object') return null;
  const method = methodOf(e);
  const path = pathFrom(e);
  const status = statusOf(e);
  const rawBody = bodyOf(e);

  const request: WireMockMapping['request'] = isTemplated(path)
    ? { method, urlPathPattern: toUrlPathPattern(path) }
    : { method, urlPath: path };

  const response: WireMockMapping['response'] = { status };
  const contentType = e.contentType || (rawBody && looksJson(rawBody) ? 'application/json' : (rawBody ? 'text/plain' : ''));
  if (contentType) response.headers = { 'Content-Type': contentType };
  if (rawBody) {
    if (looksJson(rawBody)) { try { response.jsonBody = JSON.parse(rawBody); } catch { response.body = rawBody; } }
    else response.body = rawBody;
  } else {
    response.jsonBody = { mock: true, method, path };
    response.headers = { 'Content-Type': 'application/json' };
  }
  return { request, response, metadata: { source: 'intelliqe' } };
}

/** Catalogue endpoints → a WireMock `{ mappings: [...] }` document (dedup by method+path). */
export function toWireMock(raw: unknown): { mappings: WireMockMapping[] } {
  const seen = new Set<string>();
  const mappings: WireMockMapping[] = [];
  for (const e of list(raw)) {
    const m = buildMapping(e);
    if (!m) continue;
    const key = `${m.request.method} ${m.request.urlPath || m.request.urlPathPattern}`;
    if (seen.has(key)) continue;
    seen.add(key);
    mappings.push(m);
  }
  if (!mappings.length) throw new Error('Select at least one endpoint to export as WireMock mappings.');
  return { mappings };
}

/** A regex urlPathPattern → a readable `{n}`-templated path for display/import. */
function patternToPath(pattern: string): string {
  let i = 0;
  return pattern.replace(/\[\^\/\]\+|\.\*|\([^)]*\)/g, () => `{param${++i || ''}}`);
}

/** WireMock mappings JSON (a doc, a bare array, or one mapping) → catalogue endpoints. */
export function fromWireMock(raw: unknown): { endpoints: WmEndpointInput[] } {
  let doc: any = raw;
  if (typeof raw === 'string') {
    try { doc = JSON.parse(raw); } catch { throw new Error('That is not valid WireMock JSON.'); }
  }
  const items: any[] = Array.isArray(doc?.mappings) ? doc.mappings
    : Array.isArray(doc) ? doc
    : (doc && doc.request) ? [doc]
    : [];
  if (!items.length) throw new Error('No WireMock mappings found — expected a "mappings" array or a single mapping.');

  const endpoints: WmEndpointInput[] = [];
  for (const m of items.slice(0, MAX_ENDPOINTS)) {
    const req = m?.request || {};
    const resp = m?.response || {};
    const method = String(req.method || 'GET').toUpperCase().replace(/[^A-Z]/g, '') || 'GET';
    let path = String(req.urlPath || req.url || '').trim();
    if (!path && req.urlPathPattern) path = patternToPath(String(req.urlPathPattern));
    if (!path && req.urlPattern) path = patternToPath(String(req.urlPattern));
    path = ('/' + path.replace(/^\/+/, '')).split('?')[0] || '/';
    const status = Number(resp.status) || 200;
    let body = '';
    if (resp.jsonBody !== undefined) body = JSON.stringify(resp.jsonBody, null, 2);
    else if (typeof resp.body === 'string') body = resp.body;
    const headers = resp.headers && typeof resp.headers === 'object'
      ? Object.entries(resp.headers).map(([key, value]) => ({ key, value: String(value) }))
      : [];
    endpoints.push({
      method, path, url: path, pathTemplate: path,
      expectedStatus: status, status,
      expectedResponse: body, body,
      title: `${method} ${path}`,
      headers,
    });
  }
  return { endpoints };
}

/* ────────────────────────────────────────────────────────────────
   Prism — OpenAPI 3.0 with examples
   ──────────────────────────────────────────────────────────────── */

export interface PrismExport { spec: Record<string, unknown>; command: string; endpointCount: number }

/** Catalogue endpoints → a minimal OpenAPI 3.0 doc whose example responses Prism serves. */
export function toPrism(raw: unknown, title?: string): PrismExport {
  const paths: Record<string, any> = {};
  let count = 0;
  for (const e of list(raw)) {
    if (!e || typeof e !== 'object') continue;
    const method = methodOf(e).toLowerCase();
    const oaPath = toOpenApiPath(pathFrom(e));
    const status = String(statusOf(e));
    const rawBody = bodyOf(e);
    let example: unknown = rawBody || { mock: true };
    if (rawBody && looksJson(rawBody)) { try { example = JSON.parse(rawBody); } catch { example = rawBody; } }

    const params = Array.from(oaPath.matchAll(/\{([^}]+)\}/g)).map((mm) => ({
      name: mm[1], in: 'path', required: true, schema: { type: 'string' },
    }));

    paths[oaPath] = paths[oaPath] || {};
    paths[oaPath][method] = {
      summary: e.title || `${method.toUpperCase()} ${oaPath}`,
      ...(params.length ? { parameters: params } : {}),
      responses: {
        [status]: {
          description: 'Mocked response',
          content: { 'application/json': { example } },
        },
      },
    };
    count++;
  }
  if (!count) throw new Error('Select at least one endpoint to export as a Prism spec.');
  const spec = {
    openapi: '3.0.3',
    info: { title: (title && title.trim()) || 'IntelliQE Mock API', version: '1.0.0' },
    paths,
  };
  return { spec, command: 'prism mock intelliqe-mock.json', endpointCount: count };
}

/* ────────────────────────────────────────────────────────────────
   Live WireMock admin sync (outbound HTTP)
   ──────────────────────────────────────────────────────────────── */

function adminBase(baseUrl: string): string {
  if (!/^https?:\/\//i.test(baseUrl || '')) throw new Error('WireMock base URL must be an absolute http(s) URL.');
  return baseUrl.replace(/\/+$/, '');
}

export interface PushResult { method: string; path: string; ok: boolean; status?: number; error?: string }

/** Push catalogue endpoints to a live WireMock as stub mappings. `reset` clears existing stubs first. */
export async function pushToWireMock(baseUrl: string, endpoints: unknown, reset: boolean): Promise<{ pushed: number; failed: number; reset: boolean; results: PushResult[] }> {
  const base = adminBase(baseUrl);
  const { mappings } = toWireMock(endpoints);

  if (reset) {
    const r = await fetchFull(`${base}/__admin/mappings`, { method: 'DELETE' });
    if (!r.ok && r.status !== 200) throw new Error(`Could not reset WireMock (${r.error || r.status}). Is the admin API reachable at ${base}?`);
  }

  const results: PushResult[] = [];
  for (const m of mappings) {
    const path = m.request.urlPath || m.request.urlPathPattern || '/';
    try {
      const r = await fetchFull(`${base}/__admin/mappings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(m),
      });
      results.push({ method: m.request.method, path, ok: r.ok || r.status === 201, status: r.status, error: r.ok ? undefined : (r.error || `HTTP ${r.status}`) });
    } catch (e) {
      results.push({ method: m.request.method, path, ok: false, error: (e as Error).message });
    }
  }
  const pushed = results.filter((r) => r.ok).length;
  return { pushed, failed: results.length - pushed, reset: !!reset, results };
}

/** Check a WireMock admin API is reachable and report how many stubs it holds. */
export async function pingWireMock(baseUrl: string): Promise<{ ok: boolean; count?: number; error?: string }> {
  const base = adminBase(baseUrl);
  const r = await fetchFull(`${base}/__admin/mappings`, { method: 'GET' });
  if (!r.ok) return { ok: false, error: r.error || `HTTP ${r.status}` };
  let count: number | undefined;
  try { const d = JSON.parse(r.bodyText); count = Array.isArray(d?.mappings) ? d.mappings.length : (typeof d?.meta?.total === 'number' ? d.meta.total : undefined); } catch { /* ignore */ }
  return { ok: true, count };
}
