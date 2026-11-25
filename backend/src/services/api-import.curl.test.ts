/**
 * Unit tests for the cURL importer (parseCurlCommands). Pure-function tests.
 * Run with: `npm test` (vitest).
 */
import { describe, it, expect } from 'vitest';
import { parseCurlCommands } from './api-import.service.js';

const LONG_TOKEN = 'eyJhbGciOiJIUzI1NiISVERYLONGtoken0123456789abcdef';

describe('parseCurlCommands', () => {
  it('parses method, URL, headers and body from a multi-line command', () => {
    const r = parseCurlCommands(`curl -X POST 'https://api.acme.com/orders' \\
  -H 'Content-Type: application/json' \\
  -H 'Authorization: Bearer ${LONG_TOKEN}' \\
  -d '{"sku":"A1"}'`);
    expect(r.format).toBe('cURL');
    expect(r.parser).toBe('curl');
    expect(r.endpoints).toHaveLength(1);
    const ep = r.endpoints[0]!;
    expect(ep.method).toBe('POST');
    expect(ep.url).toBe('https://api.acme.com/orders');
    expect(ep.body).toBe('{"sku":"A1"}');
    expect(ep.headers.some((h) => h.key.toLowerCase() === 'content-type')).toBe(true);
  });

  it('lifts an Authorization: Bearer header into auth and moves the secret out', () => {
    const r = parseCurlCommands(`curl 'https://api.acme.com/x' -H 'Authorization: Bearer ${LONG_TOKEN}'`);
    const ep = r.endpoints[0]!;
    expect(ep.auth.type).toBe('bearer');
    expect(ep.headers.some((h) => h.key.toLowerCase() === 'authorization')).toBe(false);
    expect(JSON.stringify(ep)).not.toContain(LONG_TOKEN);
    expect(r.envVars && r.envVars.length).toBeGreaterThan(0);
  });

  it('maps -u to basic auth and infers GET with no body', () => {
    const r = parseCurlCommands(`curl https://api.acme.com/users -u admin:pw`);
    expect(r.endpoints[0]!.method).toBe('GET');
    expect(r.endpoints[0]!.auth.type).toBe('basic');
  });

  it('maps an X-API-Key header to apikey auth', () => {
    const r = parseCurlCommands(`curl https://api.acme.com/x -H 'X-API-Key: abc123def456ghi789'`);
    expect(r.endpoints[0]!.auth.type).toBe('apikey');
    expect((r.endpoints[0]!.auth as any).headerName).toBe('X-API-Key');
  });

  it('enumerates un-importable options in a warning instead of dropping silently', () => {
    const r = parseCurlCommands(`curl https://api.acme.com/y -o out.json --max-time 30`);
    expect(r.endpoints).toHaveLength(1);
    expect(r.warnings.join(' ')).toMatch(/unsupported cURL option/i);
    expect(r.warnings.join(' ')).toMatch(/--max-time|writes the response/i);
  });

  it('parses several curl commands into several endpoints', () => {
    const r = parseCurlCommands(`curl https://api.acme.com/a
curl -X DELETE https://api.acme.com/b`);
    expect(r.endpoints).toHaveLength(2);
    expect(r.endpoints.map((e) => e.method).sort()).toEqual(['DELETE', 'GET']);
  });

  it('warns when a command has no absolute URL', () => {
    const r = parseCurlCommands(`curl -X GET -H 'Accept: application/json'`);
    expect(r.endpoints).toHaveLength(0);
    expect(r.warnings.join(' ')).toMatch(/no URL|no cURL command/i);
  });
});
