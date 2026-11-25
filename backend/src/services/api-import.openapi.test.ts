/**
 * Unit tests for the OpenAPI / Swagger importer (parseOpenApiDocument +
 * extractOpenApiServers). Pure-function tests — no DB, no HTTP.
 * Run with: `npm test` (vitest).
 */
import { describe, it, expect } from 'vitest';
import { parseOpenApiDocument, extractOpenApiServers } from './api-import.service.js';

const PLACEHOLDER = 'https://api.example.com';

function oas3(paths: any, extra: Record<string, any> = {}) {
  return { openapi: '3.0.0', info: { title: 'Orders API', version: '1.2.0' }, paths, ...extra };
}

describe('parseOpenApiDocument — OpenAPI v3', () => {
  const doc = oas3(
    {
      '/orders/{id}': {
        get: {
          operationId: 'getOrder',
          tags: ['Orders'],
          parameters: [
            { name: 'id', in: 'path', required: true, schema: { type: 'integer', example: 42 } },
            { name: 'expand', in: 'query', required: true, schema: { type: 'string', example: 'items' } },
            { name: 'verbose', in: 'query', required: false, schema: { type: 'boolean' } },
          ],
          responses: { '200': { description: 'ok', content: { 'application/json': { example: { id: 42 } } } } },
        },
      },
      '/orders': {
        post: {
          operationId: 'createOrder',
          tags: ['Orders'],
          requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { sku: { type: 'string' } } }, example: { sku: 'A1' } } } },
          responses: { '201': { description: 'created' } },
          security: [{ apiKeyHeader: [] }],
        },
      },
    },
    {
      servers: [{ url: 'https://api.acme.com/v1' }],
      security: [{ bearerAuth: [] }],
      components: {
        securitySchemes: {
          bearerAuth: { type: 'http', scheme: 'bearer' },
          apiKeyHeader: { type: 'apiKey', in: 'header', name: 'X-Key' },
        },
      },
    },
  );
  const r = parseOpenApiDocument(doc);
  const get = r.endpoints.find((e) => e.operationId === 'getOrder')!;
  const post = r.endpoints.find((e) => e.operationId === 'createOrder')!;

  it('labels the format and reads every operation', () => {
    expect(r.format).toBe('OpenAPI 3.0.0');
    expect(r.parser).toBe('openapi');
    expect(r.endpoints).toHaveLength(2);
  });

  it('builds the URL from the server base and substitutes path params', () => {
    expect(get.method).toBe('GET');
    expect(get.url).toContain('https://api.acme.com/v1/orders/42');
    expect(get.pathTemplate).toBe('/orders/{id}');
    expect(get.pathParams).toEqual([{ name: 'id', example: '42', required: true }]);
  });

  it('puts a required query param in the URL but not an optional one', () => {
    expect(get.url).toContain('expand=items');
    expect(get.url).not.toContain('verbose');
    expect(get.queryParams!.map((q) => q.name)).toEqual(['expand', 'verbose']);
  });

  it('carries operationId, tags and resource', () => {
    expect(get.tags).toEqual(['Orders']);
    expect(get.resource).toBe('orders');
  });

  it('reads the request body and adds Content-Type + Accept headers', () => {
    expect(post.method).toBe('POST');
    expect(post.body).toContain('A1');
    expect(post.headers.some((h) => h.key.toLowerCase() === 'content-type')).toBe(true);
    expect(get.headers.some((h) => h.key.toLowerCase() === 'accept')).toBe(true);
  });

  it('derives expectedStatus from the first documented 2xx response', () => {
    expect(get.expectedStatus).toBe(200);
    expect(post.expectedStatus).toBe(201);
  });

  it('maps a global http-bearer scheme to bearer auth', () => {
    expect(get.auth.type).toBe('bearer');
  });

  it('lets an operation-level apiKey (header) scheme override the global security', () => {
    expect(post.auth.type).toBe('apikey');
    expect((post.auth as any).headerName).toBe('X-Key');
    // `in` is only set explicitly for query keys; a header key is the implied default.
    expect((post.auth as any).in).not.toBe('query');
  });
});

describe('parseOpenApiDocument — apiKey in query', () => {
  it('captures the query location and param name', () => {
    const r = parseOpenApiDocument(oas3(
      { '/x': { get: { responses: { '200': {} } } } },
      {
        servers: [{ url: 'https://api.acme.com' }],
        security: [{ qk: [] }],
        components: { securitySchemes: { qk: { type: 'apiKey', in: 'query', name: 'api_key' } } },
      },
    ));
    expect(r.endpoints[0]!.auth.type).toBe('apikey');
    expect((r.endpoints[0]!.auth as any).in).toBe('query');
    expect((r.endpoints[0]!.auth as any).headerName).toBe('api_key');
  });
});

describe('parseOpenApiDocument — Swagger v2', () => {
  it('builds the base URL from host + schemes + basePath', () => {
    const r = parseOpenApiDocument({
      swagger: '2.0', info: { title: 'Legacy', version: '1.0' },
      host: 'legacy.test', schemes: ['https'], basePath: '/api',
      paths: { '/ping': { get: { responses: { '200': { description: 'ok' } } } } },
    });
    expect(r.format).toBe('Swagger 2.0');
    expect(r.endpoints[0]!.url).toBe('https://legacy.test/api/ping');
    expect(r.endpoints[0]!.expectedStatus).toBe(200);
  });
});

describe('parseOpenApiDocument — missing / relative servers warn and use a placeholder', () => {
  it('warns on a relative server and uses the placeholder host', () => {
    const r = parseOpenApiDocument(oas3({ '/x': { get: { responses: { '200': {} } } } }, { servers: [{ url: '/v2' }] }));
    expect(r.warnings.join(' ')).toMatch(/relative server/i);
    expect(r.endpoints[0]!.url).toBe(`${PLACEHOLDER}/v2/x`);
  });
  it('warns when no server is declared', () => {
    const r = parseOpenApiDocument(oas3({ '/x': { get: { responses: { '200': {} } } } }));
    expect(r.warnings.join(' ')).toMatch(/no server|placeholder/i);
    expect(r.endpoints[0]!.url).toContain(PLACEHOLDER);
  });
});

describe('extractOpenApiServers', () => {
  it('expands server variables and keeps every absolute target', () => {
    const servers = extractOpenApiServers({
      servers: [
        { url: 'https://{region}.acme.com/v1', variables: { region: { default: 'eu' } }, description: 'Production server' },
        { url: 'https://staging.acme.com/v1', description: 'Staging' },
        { url: '/relative' },
      ],
    }, false);
    expect(servers.map((s) => s.url)).toEqual(['https://eu.acme.com/v1', 'https://staging.acme.com/v1']);
    expect(servers[0]!.name).toBe('Production');
  });
});
