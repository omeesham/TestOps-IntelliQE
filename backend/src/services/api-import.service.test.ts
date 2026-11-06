/**
 * Unit tests for the Postman collection importer (v2.0 / v2.1).
 * Pure-function tests — no DB, no HTTP. Run with: `npm test` (vitest).
 */
import { describe, it, expect } from 'vitest';
import { parsePostmanCollection, postmanSchemaInfo, postmanOutline } from './api-import.service.js';

const V21 = 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json';
const V20 = 'https://schema.getpostman.com/json/collection/v2.0.0/collection.json';

function doc(schema: string, item: any[], extra: Record<string, any> = {}) {
  return { info: { name: 'Test API', schema }, item, ...extra };
}
function request(name: string, request: any, response?: any[]) {
  return response ? { name, request, response } : { name, request };
}

describe('postmanSchemaInfo', () => {
  it('detects v2.1', () => {
    expect(postmanSchemaInfo({ info: { schema: V21 } }).label).toBe('Postman collection v2.1');
  });
  it('detects v2.0', () => {
    expect(postmanSchemaInfo({ info: { schema: V20 } }).label).toBe('Postman collection v2.0');
  });
  it('rejects an unsupported major version (v1)', () => {
    expect(() => postmanSchemaInfo({ info: { schema: 'https://schema.getpostman.com/json/collection/v1.0.0/collection.json' } })).toThrow(/only v2\.0 and v2\.1/);
  });
  it('rejects an unsupported minor version (v2.2)', () => {
    expect(() => postmanSchemaInfo({ info: { schema: 'https://schema.getpostman.com/json/collection/v2.2.0/collection.json' } })).toThrow(/only v2\.0 and v2\.1/);
  });
  it('assumes v2.1 with a warning when no schema is declared', () => {
    const r = postmanSchemaInfo({ info: { name: 'x' } });
    expect(r.label).toBe('Postman collection v2.1');
    expect(r.warning).toMatch(/no schema version/i);
  });
});

describe('parsePostmanCollection — core parsing', () => {
  it('reads a simple request and labels the schema', () => {
    const r = parsePostmanCollection(doc(V21, [request('Get users', { method: 'GET', url: 'https://api.test/users' })]));
    expect(r.format).toBe('Postman collection v2.1');
    expect(r.endpoints).toHaveLength(1);
    expect(r.endpoints[0]!.method).toBe('GET');
    expect(r.endpoints[0]!.url).toBe('https://api.test/users');
    expect(r.summary).toEqual({ imported: 1, skipped: 0, failed: 0, total: 1 });
  });

  it('throws on an unsupported schema version', () => {
    expect(() => parsePostmanCollection(doc('https://schema.getpostman.com/json/collection/v1.0.0/collection.json', []))).toThrow(/only v2\.0 and v2\.1/);
  });

  it('preserves nested folder hierarchy as tags/resource', () => {
    const r = parsePostmanCollection(doc(V21, [
      { name: 'Auth', item: [request('Login', { method: 'POST', url: 'https://api.test/login' })] },
      { name: 'Employees', item: [{ name: 'Admin', item: [request('List', { method: 'GET', url: 'https://api.test/emp' })] }] },
    ]));
    const login = r.endpoints.find((e) => e.url.endsWith('/login'))!;
    const list = r.endpoints.find((e) => e.url.endsWith('/emp'))!;
    expect(login.tags).toEqual(['Auth']);
    expect(list.tags).toEqual(['Employees', 'Admin']);
    expect(list.resource).toBe('admin');
  });

  it('keeps every supported HTTP method', () => {
    const methods = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];
    const r = parsePostmanCollection(doc(V21, methods.map((m, i) => request(m, { method: m, url: `https://api.test/r${i}` }))));
    expect(r.endpoints.map((e) => e.method).sort()).toEqual([...methods].sort());
  });

  it('handles a structured URL object and resolves path variables', () => {
    const r = parsePostmanCollection(doc(V21, [
      request('By id', { method: 'GET', url: { raw: 'https://api.test/users/:id', host: ['api', 'test'], path: ['users', ':id'], variable: [{ key: 'id', value: '42' }] } }),
    ]));
    expect(r.endpoints[0]!.url).toBe('https://api.test/users/42');
  });

  it('drops disabled headers', () => {
    const r = parsePostmanCollection(doc(V21, [
      request('H', { method: 'GET', url: 'https://api.test/x', header: [{ key: 'X-Keep', value: '1' }, { key: 'X-Gone', value: '2', disabled: true }] }),
    ]));
    const keys = r.endpoints[0]!.headers.map((h) => h.key);
    expect(keys).toContain('X-Keep');
    expect(keys).not.toContain('X-Gone');
  });

  it('substitutes collection variables', () => {
    const r = parsePostmanCollection(doc(V21, [request('V', { method: 'GET', url: '{{baseUrl}}/ping' })], { variable: [{ key: 'baseUrl', value: 'https://api.test' }] }));
    expect(r.endpoints[0]!.url).toBe('https://api.test/ping');
  });

  it('flags unresolved variables with a warning and a placeholder host', () => {
    const r = parsePostmanCollection(doc(V21, [request('V', { method: 'GET', url: '{{baseUrl}}/ping' })]));
    expect(r.endpoints[0]!.url).toMatch(/\/ping$/);
    expect(r.warnings.join(' ')).toMatch(/collection variables with no value/i);
    expect(r.items!.find((i) => i.code === 'POSTMAN_UNRESOLVED_VAR')).toBeTruthy();
  });
});

describe('parsePostmanCollection — body modes', () => {
  const url = 'https://api.test/x';
  it('raw body', () => {
    const r = parsePostmanCollection(doc(V21, [request('B', { method: 'POST', url, body: { mode: 'raw', raw: '{"a":1}' } })]));
    expect(r.endpoints[0]!.body).toBe('{"a":1}');
  });
  it('urlencoded body adds a content-type header', () => {
    const r = parsePostmanCollection(doc(V21, [request('B', { method: 'POST', url, body: { mode: 'urlencoded', urlencoded: [{ key: 'a', value: '1' }] } })]));
    expect(r.endpoints[0]!.body).toBe('a=1');
    expect(r.endpoints[0]!.headers.some((h) => h.key.toLowerCase() === 'content-type')).toBe(true);
  });
  it('graphql body is JSON-encoded and tagged graphql', () => {
    const r = parsePostmanCollection(doc(V21, [request('B', { method: 'POST', url, body: { mode: 'graphql', graphql: { query: '{ me }' } } })]));
    expect(r.endpoints[0]!.style).toBe('graphql');
    expect(r.endpoints[0]!.body).toMatch(/me/);
  });
  it('file body is skipped-with-reason, endpoint still imported', () => {
    const r = parsePostmanCollection(doc(V21, [request('B', { method: 'POST', url, body: { mode: 'file', file: { src: '/tmp/x' } } })]));
    expect(r.endpoints).toHaveLength(1);
    expect(r.endpoints[0]!.body).toBeUndefined();
    expect(r.items!.find((i) => i.code === 'POSTMAN_BODY_FILE_UNSUPPORTED')).toBeTruthy();
    expect(r.warnings.join(' ')).toMatch(/file-upload body/i);
  });
});

describe('parsePostmanCollection — auth inheritance', () => {
  it('inherits collection-level auth', () => {
    const r = parsePostmanCollection(doc(V21, [request('A', { method: 'GET', url: 'https://api.test/a' })], { auth: { type: 'bearer', bearer: [{ key: 'token', value: 'TOK' }] } }));
    expect(r.endpoints[0]!.auth.type).toBe('bearer');
  });
  it('folder auth overrides collection auth; request auth overrides folder', () => {
    const r = parsePostmanCollection(doc(V21, [
      {
        name: 'F', auth: { type: 'basic', basic: [{ key: 'username', value: 'u' }, { key: 'password', value: 'p' }] },
        item: [
          request('inherit-folder', { method: 'GET', url: 'https://api.test/f1' }),
          request('override-req', { method: 'GET', url: 'https://api.test/f2', auth: { type: 'apikey', apikey: [{ key: 'key', value: 'X-Api' }, { key: 'value', value: 'K' }] } }),
        ],
      },
    ], { auth: { type: 'bearer', bearer: [{ key: 'token', value: 'TOK' }] } }));
    expect(r.endpoints.find((e) => e.url.endsWith('/f1'))!.auth.type).toBe('basic');
    expect(r.endpoints.find((e) => e.url.endsWith('/f2'))!.auth.type).toBe('apikey');
  });
});

describe('parsePostmanCollection — outcomes reconcile', () => {
  it('counts imported + skipped + failed === total, with dedupe and no-URL skips', () => {
    const r = parsePostmanCollection(doc(V21, [
      request('ok', { method: 'GET', url: 'https://api.test/a' }),
      request('dup', { method: 'GET', url: 'https://api.test/a' }),     // duplicate → skipped
      request('nourl', { method: 'GET', url: '' }),                     // no URL → skipped
    ]));
    expect(r.summary!.total).toBe(3);
    expect(r.summary!.imported + r.summary!.skipped + r.summary!.failed).toBe(r.summary!.total);
    expect(r.summary!.imported).toBe(1);
    expect(r.items!.find((i) => i.code === 'POSTMAN_DUPLICATE')).toBeTruthy();
    expect(r.items!.find((i) => i.code === 'POSTMAN_NO_URL')).toBeTruthy();
    expect(r.endpoints).toHaveLength(1);
  });

  it('never leaks a secret auth value into warnings or notice', () => {
    const secret = 'super-secret-token-value';
    const r = parsePostmanCollection(doc(V21, [request('A', { method: 'GET', url: '{{baseUrl}}/a' })], {
      auth: { type: 'bearer', bearer: [{ key: 'token', value: secret }] },
    }));
    expect(r.warnings.join(' ')).not.toContain(secret);
    expect(r.notice || '').not.toContain(secret);
  });
});

describe('postmanOutline', () => {
  it('builds a folder tree with request count and auth scopes', () => {
    const o = postmanOutline(doc(V21, [
      request('Root req', { method: 'GET', url: 'https://api.test/root' }),
      { name: 'Folder', auth: { type: 'bearer', bearer: [{ key: 'token', value: 'T' }] }, item: [request('Inner', { method: 'POST', url: 'https://api.test/in' })] },
    ], { auth: { type: 'none' } }));
    expect(o.name).toBe('Test API');
    expect(o.requestCount).toBe(2);
    expect(o.rootRequests).toHaveLength(1);
    expect(o.folders).toHaveLength(1);
    expect(o.folders[0]!.requests[0]!.url).toBe('https://api.test/in');
    // Collection scope + the folder's declared auth.
    expect(o.auth.find((a) => a.scope === 'Collection')).toBeTruthy();
    expect(o.auth.find((a) => a.scope === 'Folder' && a.type === 'bearer')).toBeTruthy();
  });
});
