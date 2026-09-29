/**
 * api-endpoints.ts
 * ────────────────
 * A trusted normaliser for an endpoint catalogue posted back by the client, in
 * the shape the headless run (`ImportedEndpoint`) consumes. Used where a stored
 * or replayed catalogue must be validated before it drives a run — e.g. saved
 * schedules. It only bounds and shapes fields; it does not probe or mutate.
 */
import type { ImportedEndpoint } from '../services/api-import.service.js';

export function endpointsFromRaw(raw: unknown, max = 500): ImportedEndpoint[] {
  if (!Array.isArray(raw)) return [];
  const out: ImportedEndpoint[] = [];
  for (const e of raw.slice(0, max)) {
    if (!e || typeof e !== 'object') continue;
    const ep = e as Record<string, any>;
    const url = String(ep.url || '').trim();
    if (!/^https?:\/\//i.test(url)) continue;
    const method = String(ep.method || 'GET').toUpperCase().replace(/[^A-Z]/g, '') || 'GET';
    out.push({
      title: String(ep.title || `${method} ${url}`).slice(0, 160),
      method,
      url: url.slice(0, 4000),
      headers: Array.isArray(ep.headers)
        ? ep.headers.filter((h: any) => h && String(h.key || '').trim()).slice(0, 40).map((h: any) => ({ key: String(h.key).slice(0, 200), value: String(h.value ?? '').slice(0, 2000) }))
        : [],
      auth: {
        type: (['none', 'bearer', 'basic', 'apikey'].includes(String(ep.auth?.type)) ? ep.auth.type : 'none'),
        value: ep.auth?.value ? String(ep.auth.value).slice(0, 4000) : undefined,
        headerName: ep.auth?.headerName ? String(ep.auth.headerName).slice(0, 100) : undefined,
      },
      body: typeof ep.body === 'string' ? ep.body.slice(0, 20000) : undefined,
      expectedStatus: Number.isInteger(Number(ep.expectedStatus)) ? Number(ep.expectedStatus) : undefined,
      expectedResponse: typeof ep.expectedResponse === 'string' ? ep.expectedResponse.slice(0, 20000) : undefined,
      description: typeof ep.description === 'string' ? ep.description.slice(0, 2000) : undefined,
      tags: Array.isArray(ep.tags) ? ep.tags.map(String).slice(0, 10) : undefined,
      resource: typeof ep.resource === 'string' ? ep.resource.slice(0, 80) : undefined,
      pathTemplate: typeof ep.pathTemplate === 'string' ? ep.pathTemplate.slice(0, 500) : undefined,
      pathParams: Array.isArray(ep.pathParams) ? ep.pathParams.slice(0, 20) : undefined,
      queryParams: Array.isArray(ep.queryParams) ? ep.queryParams.slice(0, 30) : undefined,
      style: ep.style,
      source: ep.source,
      deprecated: !!ep.deprecated,
      discovered: !!ep.discovered,
    });
  }
  return out;
}
