/**
 * Unit tests for the Bruno importer (parseBrunoCollection / parseBruno).
 * Pure-function tests. Run with: `npm test` (vitest).
 */
import { describe, it, expect } from 'vitest';
import { parseBrunoCollection, parseBruno } from './api-import.service.js';

// Collection-level defaults (a collection.bru chunk: no method block) followed by
// two request documents. Each block closes with `}` on its own line.
const COLLECTION = `auth:bearer {
  token: {{token}}
}

headers {
  X-Tenant: acme
}

vars {
  baseUrl: https://api.acme.com
  token: SECRET
}

meta {
  name: Get user
  type: http
}

get {
  url: {{baseUrl}}/users/:id
}

params:path {
  id: 42
}

headers {
  Accept: application/json
  ~X-Debug: 1
}

body:json {
  {"a":1}
}

tests {
  expect(res.status).to.equal(200)
}

meta {
  name: Create user
  type: http
}

post {
  url: {{baseUrl}}/users
}

auth:basic {
  username: admin
  password: pw
}

body:json {
  {"name":"x"}
}
`;

describe('parseBrunoCollection', () => {
  const r = parseBrunoCollection(COLLECTION);
  const get = r.endpoints.find((e) => e.method === 'GET')!;
  const post = r.endpoints.find((e) => e.method === 'POST')!;

  it('labels a multi-request document as a Bruno collection and reads every request', () => {
    expect(r.format).toBe('Bruno collection');
    expect(r.parser).toBe('bruno');
    expect(r.endpoints).toHaveLength(2);
  });

  it('resolves collection variables and substitutes :path params', () => {
    expect(get.url).toBe('https://api.acme.com/users/42');
  });

  it('inherits collection-level bearer auth when a request declares none', () => {
    expect(get.auth.type).toBe('bearer');
  });

  it('lets a request-level auth block override the collection auth', () => {
    expect(post.auth.type).toBe('basic');
  });

  it('merges collection headers and drops disabled (~) headers', () => {
    const keys = get.headers.map((h) => h.key);
    expect(keys).toContain('X-Tenant');
    expect(keys).toContain('Accept');
    expect(keys).not.toContain('X-Debug');
  });

  it('de-indents the request body', () => {
    expect(get.body).toBe('{"a":1}');
    expect(post.body).toContain('"name":"x"');
  });

  it('records a tests/script block as a skipped item, not a dropped one', () => {
    expect(r.items!.some((i) => i.code === 'BRUNO_TESTS_SKIPPED' && i.outcome === 'skipped')).toBe(true);
    expect(r.warnings.join(' ')).toMatch(/script\/tests\/assert/i);
  });

  it('reconciles imported + skipped + failed === total', () => {
    expect(r.summary!.imported).toBe(2);
    expect(r.summary!.imported + r.summary!.skipped + r.summary!.failed).toBe(r.summary!.total);
  });
});

describe('parseBruno — single request with unresolved variables', () => {
  it('substitutes a placeholder host and warns', () => {
    const r = parseBruno(`meta {
  name: Ping
}

get {
  url: {{baseUrl}}/ping
}
`);
    expect(r.endpoints).toHaveLength(1);
    expect(r.endpoints[0]!.url).toContain('api.example.com');
    expect(r.warnings.join(' ')).toMatch(/\{\{variables\}\}|no value/i);
  });
});
