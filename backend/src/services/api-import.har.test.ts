/**
 * Unit tests for the HAR importer (parseHar + harDomains). Pure-function tests.
 * Run with: `npm test` (vitest).
 */
import { describe, it, expect } from 'vitest';
import { parseHar, harDomains } from './api-import.service.js';

function entry(method: string, url: string, opts: { reqHeaders?: any[]; body?: string; status?: number; mime?: string; resText?: string } = {}) {
  return {
    request: { method, url, headers: opts.reqHeaders ?? [], ...(opts.body ? { postData: { text: opts.body } } : {}) },
    response: { status: opts.status ?? 200, content: { mimeType: opts.mime ?? 'application/json', ...(opts.resText ? { text: opts.resText } : {}) } },
  };
}
const TOKEN = 'eyJhbGciOiJIUzI1NiTESTtoken0123456789abcdef';

describe('parseHar', () => {
  const doc = { log: { entries: [
    entry('GET', 'https://api.acme.com/api/users', {
      reqHeaders: [{ name: 'Authorization', value: `Bearer ${TOKEN}` }, { name: 'Accept', value: 'application/json' }, { name: 'User-Agent', value: 'Mozilla' }],
      resText: '{"ok":true}',
    }),
    // A static asset (image) — must be filtered out as non-API traffic.
    entry('GET', 'https://cdn.acme.com/logo.png', { mime: 'image/png' }),
    entry('POST', 'https://api.acme.com/api/orders', {
      reqHeaders: [{ name: 'Content-Type', value: 'application/json' }],
      body: '{"sku":"A1"}', status: 201, resText: '{}',
    }),
  ] } };
  const r = parseHar(doc);

  it('labels the format and keeps only API traffic (skips assets)', () => {
    expect(r.format).toBe('HAR 1.2');
    expect(r.parser).toBe('har');
    expect(r.endpoints).toHaveLength(2);
  });

  it('recovers method, URL, body and status', () => {
    const post = r.endpoints.find((e) => e.method === 'POST')!;
    expect(post.url).toBe('https://api.acme.com/api/orders');
    expect(post.body).toBe('{"sku":"A1"}');
    expect(post.expectedStatus).toBe(201);
  });

  it('lifts a bearer token into auth and moves the secret to the environment', () => {
    const get = r.endpoints.find((e) => e.method === 'GET')!;
    expect(get.auth.type).toBe('bearer');
    // The raw token must never remain on the endpoint.
    expect(JSON.stringify(get)).not.toContain(TOKEN);
    expect(r.envVars && r.envVars.length).toBeGreaterThan(0);
  });

  it('drops request-noise headers (user-agent, authorization)', () => {
    const get = r.endpoints.find((e) => e.method === 'GET')!;
    const keys = get.headers.map((h) => h.key.toLowerCase());
    expect(keys).not.toContain('user-agent');
    expect(keys).not.toContain('authorization');
  });
});

describe('harDomains', () => {
  const doc = { log: { entries: [
    entry('GET', 'https://api.acme.com/api/a'),
    entry('GET', 'https://api.acme.com/api/b'),
    entry('GET', 'https://cdn.acme.com/x.png', { mime: 'image/png' }),
  ] } };

  it('counts API vs total requests per host, API hosts first', () => {
    const rows = harDomains(doc);
    const api = rows.find((d) => d.host === 'api.acme.com')!;
    const cdn = rows.find((d) => d.host === 'cdn.acme.com')!;
    expect(api.apiRequestCount).toBe(2);
    expect(cdn.apiRequestCount).toBe(0);
    expect(rows[0]!.host).toBe('api.acme.com');
  });

  it('a domain filter restricts which hosts are imported', () => {
    const multi = { log: { entries: [
      entry('GET', 'https://api.acme.com/api/a'),
      entry('GET', 'https://other.test/api/z'),
    ] } };
    const r = parseHar(multi, 'rec', { domains: ['api.acme.com'] });
    expect(r.endpoints).toHaveLength(1);
    expect(r.endpoints[0]!.url).toContain('api.acme.com');
  });
});
