/**
 * generators.ts — client-side artifact generators.
 *
 * Pure functions that turn the catalogue into portable artifacts: a connector
 * manifest, an OpenAPI 3 spec, a zero-dependency mock server, and a Pact
 * contract. None call the network or touch the pipeline — they read the
 * catalogue and hand back a string to download.
 */
import { pathOf } from './format';
import type { CatalogEndpoint } from './types';

/** Parse JSON when it parses; otherwise hand back the raw string. */
function tryParse(text: string | undefined): unknown {
  if (!text) return undefined;
  try { return JSON.parse(text); } catch { return text; }
}

function originOf(url: string): string {
  try { return new URL(url).origin; } catch { return ''; }
}

/** Trigger a browser download of a text artifact. */
export function downloadText(filename: string, content: string, type = 'application/json'): void {
  const blob = new Blob([content], { type });
  const href = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = href; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(href);
}

/** The portable connector manifest (round-trips the Import → Connector method). */
export function toConnectorManifest(endpoints: CatalogEndpoint[]): string {
  const first = endpoints[0];
  return JSON.stringify({
    name: 'IntelliQE catalogue export',
    baseUrl: first ? originOf(first.url) : '',
    endpoints: endpoints.map((e) => ({
      name: e.title, method: e.method, url: e.url,
      headers: e.headers.length ? e.headers : undefined,
      auth: e.auth.type !== 'none' ? { type: e.auth.type, headerName: e.auth.headerName } : undefined,
      body: e.body, expectedStatus: e.expectedStatus, description: e.description,
    })),
  }, null, 2);
}

/** A minimal OpenAPI 3.0 document assembled from the catalogue. */
export function toOpenApi(endpoints: CatalogEndpoint[]): string {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const e of endpoints) {
    const p = (pathOf(e.url).replace(/\/+$/, '') || '/');
    const method = (e.method || 'GET').toLowerCase();
    paths[p] = paths[p] || {};
    const example = tryParse(e.expectedResponse);
    const reqExample = tryParse(e.body);
    paths[p][method] = {
      summary: e.title || undefined,
      description: e.description || undefined,
      ...(reqExample !== undefined ? { requestBody: { content: { 'application/json': { example: reqExample } } } } : {}),
      responses: {
        [String(e.expectedStatus || 200)]: {
          description: 'Successful response',
          ...(example !== undefined ? { content: { 'application/json': { example } } } : {}),
        },
      },
    };
  }
  const servers = [...new Set(endpoints.map((e) => originOf(e.url)).filter(Boolean))].map((url) => ({ url }));
  return JSON.stringify({ openapi: '3.0.3', info: { title: 'IntelliQE export', version: '1.0.0' }, servers, paths }, null, 2);
}

/** A runnable, zero-dependency Node mock server that serves the example bodies. */
export function toMockServer(endpoints: CatalogEndpoint[]): string {
  const routes = endpoints.map((e) => ({
    method: (e.method || 'GET').toUpperCase(),
    path: pathOf(e.url) || '/',
    status: e.expectedStatus || 200,
    body: e.expectedResponse || '',
  }));
  return `#!/usr/bin/env node
/* Auto-generated mock server — zero dependencies.  Run:  node mock-server.mjs  */
import http from 'node:http';

const PORT = process.env.PORT || 4010;
const routes = ${JSON.stringify(routes, null, 2)};

function samePath(tmpl, actual) {
  const a = tmpl.split('/').filter(Boolean);
  const b = actual.split('/').filter(Boolean);
  if (a.length !== b.length) return false;
  return a.every((seg, i) => seg.startsWith('{') || seg === b[i]);
}
function match(method, url) {
  const path = (url || '/').split('?')[0];
  return routes.find((r) => r.method === method && samePath(r.path, path));
}

http.createServer((req, res) => {
  const r = match(req.method, req.url);
  const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' };
  if (req.method === 'OPTIONS') { res.writeHead(204, cors); res.end(); return; }
  if (!r) { res.writeHead(404, { 'content-type': 'application/json', ...cors }); res.end(JSON.stringify({ error: 'No mock for ' + req.method + ' ' + req.url })); return; }
  res.writeHead(r.status, { 'content-type': 'application/json', ...cors });
  res.end(r.body || JSON.stringify({ mock: true }));
}).listen(PORT, () => console.log('Mock API listening on http://localhost:' + PORT));
`;
}

/** A Pact v2 contract file (consumer-driven contract testing). */
export function toPactContract(endpoints: CatalogEndpoint[], consumer = 'IntelliQE', provider = 'API'): string {
  const interactions = endpoints.map((e) => {
    const reqBody = tryParse(e.body);
    const resBody = tryParse(e.expectedResponse);
    return {
      description: e.title || `${(e.method || 'GET').toUpperCase()} ${pathOf(e.url)}`,
      request: {
        method: (e.method || 'GET').toUpperCase(),
        path: pathOf(e.url),
        ...(e.headers.length ? { headers: Object.fromEntries(e.headers.map((h) => [h.key, h.value])) } : {}),
        ...(reqBody !== undefined ? { body: reqBody } : {}),
      },
      response: {
        status: e.expectedStatus || 200,
        ...(resBody !== undefined ? { body: resBody } : {}),
      },
    };
  });
  return JSON.stringify({
    consumer: { name: consumer },
    provider: { name: provider },
    interactions,
    metadata: { pactSpecification: { version: '2.0.0' }, generatedBy: 'IntelliQE' },
  }, null, 2);
}
