/**
 * Unit tests for two importer fixes surfaced by the API Test Kit:
 *   1. Custom-connector manifests that use the `actions` key (Power Platform /
 *      portable-connector convention) instead of `endpoints`, incl. per-action
 *      auth (true/false/object), global-auth mapping, and query-default params.
 *   2. dedupeEndpoints no longer collapsing distinct GraphQL operations (which
 *      all POST to the same endpoint URL) into a single endpoint.
 * Pure-function tests — no DB, no HTTP.
 */
import { describe, it, expect } from 'vitest';
import { parseConnectorManifest, dedupeEndpoints } from './api-import.service.js';

describe('parseConnectorManifest — actions key', () => {
  it('reads endpoints from an `actions` array (not just `endpoints`)', () => {
    const r = parseConnectorManifest({
      name: 'Demo', baseUrl: 'https://api.demo.com',
      actions: [
        { id: 'list', method: 'GET', path: '/items' },
        { id: 'get', method: 'GET', path: '/items/{id}', pathParams: [{ name: 'id' }] },
      ],
    });
    expect(r.endpoints).toHaveLength(2);
    expect(r.endpoints.map((e) => `${e.method} ${e.url}`)).toEqual([
      'GET https://api.demo.com/items',
      'GET https://api.demo.com/items/{id}',
    ]);
  });

  it('applies the global auth block, honouring per-action auth true/false', () => {
    const r = parseConnectorManifest({
      baseUrl: 'https://api.demo.com',
      auth: { type: 'bearer_login', header: { name: 'Authorization', format: 'Bearer {{token}}' } },
      actions: [
        { id: 'me', method: 'GET', path: '/me', auth: true },
        { id: 'public', method: 'GET', path: '/public', auth: false },
        { id: 'default', method: 'GET', path: '/default' },
      ],
    });
    const byPath = Object.fromEntries(r.endpoints.map((e) => [new URL(e.url).pathname, e.auth.type]));
    expect(byPath['/me']).toBe('bearer');      // auth: true  -> global (bearer)
    expect(byPath['/public']).toBe('none');     // auth: false -> none
    expect(byPath['/default']).toBe('bearer');  // absent      -> global (bearer)
  });

  it('maps api_key / basic / oauth2 global auth blocks', () => {
    const apikey = parseConnectorManifest({
      baseUrl: 'https://a.com', auth: { type: 'api_key', in: 'header', name: 'x-api-key', value: 'K' },
      actions: [{ method: 'GET', path: '/x' }],
    }).endpoints[0]!;
    expect(apikey.auth.type).toBe('apikey');
    expect((apikey.auth as any).headerName).toBe('x-api-key');

    const basic = parseConnectorManifest({
      baseUrl: 'https://a.com', auth: { type: 'basic', username: 'admin', password: 'pw' },
      actions: [{ method: 'GET', path: '/x' }],
    }).endpoints[0]!;
    expect(basic.auth.type).toBe('basic');
    expect(basic.auth.value).toBe('admin:pw');

    const oauth = parseConnectorManifest({
      baseUrl: 'https://a.com', auth: { type: 'oauth2', grantType: 'client_credentials', tokenUrl: 'https://a.com/token', clientId: 'm2m', clientSecret: 's', scopes: ['api'] },
      actions: [{ method: 'GET', path: '/x', auth: true }],
    }).endpoints[0]!;
    expect(oauth.auth.type).toBe('bearer'); // oauth2 resolves to a declared Bearer
  });

  it('materialises query params that carry a default onto the URL', () => {
    const r = parseConnectorManifest({
      baseUrl: 'https://a.com',
      actions: [{ method: 'GET', path: '/items', query: [{ name: 'limit', default: 10 }, { name: 'q' /* no default */ }] }],
    });
    expect(r.endpoints[0]!.url).toBe('https://a.com/items?limit=10');
  });

  it('still reads the native `endpoints` key', () => {
    const r = parseConnectorManifest({ baseUrl: 'https://a.com', endpoints: [{ method: 'POST', path: '/p' }] });
    expect(r.endpoints).toHaveLength(1);
    expect(r.endpoints[0]!.method).toBe('POST');
  });
});

describe('dedupeEndpoints — GraphQL operations', () => {
  const gql = (op: string): any => ({
    title: op, method: 'POST', url: 'https://gql.example/graphql', headers: [],
    auth: { type: 'none' }, style: 'graphql', operationId: op,
    body: JSON.stringify({ query: `query { ${op} }` }),
  });

  it('keeps distinct GraphQL operations that share method + URL', () => {
    const out = dedupeEndpoints([gql('countries'), gql('country'), gql('continents')]);
    expect(out).toHaveLength(3);
    expect(out.map((e) => e.operationId)).toEqual(['countries', 'country', 'continents']);
  });

  it('still collapses a genuinely duplicated GraphQL operation', () => {
    const out = dedupeEndpoints([gql('countries'), gql('countries')]);
    expect(out).toHaveLength(1);
  });

  it('still dedupes REST endpoints on method + URL', () => {
    const rest = (): any => ({ title: 't', method: 'GET', url: 'https://api/x', headers: [], auth: { type: 'none' }, style: 'rest' });
    expect(dedupeEndpoints([rest(), rest()])).toHaveLength(1);
  });
});
