/**
 * endpoint-normalize.ts
 * ─────────────────────
 * Shared "endpoints as the client/CI sends them back" → trusted ImportedEndpoint[]
 * normaliser. Mirrors the inline `endpointsFromBody` in api-automation.routes.ts
 * so the CI trigger and the execution queue can accept the same catalogue shape
 * without importing the routes module.
 */
import type { ImportedEndpoint } from '../services/api-import.service.js';

export function normalizeEndpoints(raw: unknown, max = 500): ImportedEndpoint[] {
  if (!Array.isArray(raw)) return [];
  const out: ImportedEndpoint[] = [];
  for (const e of raw.slice(0, max)) {
    if (!e || typeof e !== 'object') continue;
    const anyE = e as Record<string, any>;
    const url = String(anyE.url || '').trim();
    if (!/^https?:\/\//i.test(url)) continue;
    const method = String(anyE.method || 'GET').toUpperCase().replace(/[^A-Z]/g, '') || 'GET';
    out.push({
      title: String(anyE.title || `${method} ${url}`).slice(0, 160),
      method,
      url: url.slice(0, 4000),
      headers: Array.isArray(anyE.headers)
        ? anyE.headers.filter((h: any) => h && String(h.key || '').trim()).slice(0, 40).map((h: any) => ({ key: String(h.key).slice(0, 200), value: String(h.value ?? '').slice(0, 2000) }))
        : [],
      auth: {
        type: (['none', 'bearer', 'basic', 'apikey'].includes(String(anyE.auth?.type)) ? anyE.auth.type : 'none'),
        value: anyE.auth?.value ? String(anyE.auth.value).slice(0, 4000) : undefined,
        headerName: anyE.auth?.headerName ? String(anyE.auth.headerName).slice(0, 100) : undefined,
      },
      body: typeof anyE.body === 'string' ? anyE.body.slice(0, 20000) : undefined,
      expectedStatus: Number.isInteger(Number(anyE.expectedStatus)) ? Number(anyE.expectedStatus) : undefined,
      expectedResponse: typeof anyE.expectedResponse === 'string' ? anyE.expectedResponse.slice(0, 20000) : undefined,
      description: typeof anyE.description === 'string' ? anyE.description.slice(0, 2000) : undefined,
      tags: Array.isArray(anyE.tags) ? anyE.tags.map(String).slice(0, 10) : undefined,
      resource: typeof anyE.resource === 'string' ? anyE.resource.slice(0, 80) : undefined,
      pathTemplate: typeof anyE.pathTemplate === 'string' ? anyE.pathTemplate.slice(0, 500) : undefined,
      pathParams: Array.isArray(anyE.pathParams) ? anyE.pathParams.slice(0, 20) : undefined,
      queryParams: Array.isArray(anyE.queryParams) ? anyE.queryParams.slice(0, 30) : undefined,
      style: anyE.style,
      source: anyE.source,
      deprecated: !!anyE.deprecated,
      discovered: !!anyE.discovered,
    });
  }
  return out;
}
