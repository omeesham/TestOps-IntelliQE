/**
 * Unit tests for suite-level auth/login chaining (api-auth-setup.service).
 * `fetch` is stubbed — no real network. Run with: `npm test` (vitest).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { mintAuthToken, injectAuthToken } from './api-auth-setup.service.js';
import type { ApiEnvironment } from './api-environments.service.js';

function env(partial: Partial<ApiEnvironment>): ApiEnvironment {
  return {
    id: Math.random().toString(36).slice(2), // unique id ⇒ no cross-test cache hits
    name: 'test', baseUrl: 'https://api.example.com', variables: [],
    isDefault: false, customerLike: false, createdAt: '', updatedAt: '',
    ...partial,
  } as ApiEnvironment;
}

function stubFetch(status: number, body: unknown) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  vi.stubGlobal('fetch', vi.fn(async () => ({
    ok: status >= 200 && status < 300, status,
    headers: new Map<string, string>(),
    text: async () => text,
  })));
}

afterEach(() => vi.unstubAllGlobals());

describe('injectAuthToken', () => {
  it('adds the minted token as a variable', () => {
    const out = injectAuthToken(env({ variables: [{ key: 'other', value: 'x', secret: false }] }), { token: 'abc', varName: 'token' });
    expect(out?.variables).toContainEqual({ key: 'token', value: 'abc', secret: false });
    expect(out?.variables.find((v) => v.key === 'other')?.value).toBe('x');
  });
  it('replaces an existing value for the same variable', () => {
    const out = injectAuthToken(env({ variables: [{ key: 'token', value: 'stale', secret: true }] }), { token: 'fresh', varName: 'token' });
    expect(out?.variables.filter((v) => v.key === 'token')).toHaveLength(1);
    expect(out?.variables.find((v) => v.key === 'token')?.value).toBe('fresh');
  });
  it('is a no-op without a token', () => {
    const e = env({});
    expect(injectAuthToken(e, {})).toBe(e);
  });
});

describe('mintAuthToken', () => {
  const setup = (over: Record<string, unknown> = {}) => ({
    enabled: true,
    request: { method: 'POST', url: '{{baseUrl}}/auth/login', headers: [], body: '{"u":"{{username}}"}' },
    tokenPath: '$.token', varName: 'token', ...over,
  });

  it('no-ops when there is no enabled setup', async () => {
    expect(await mintAuthToken(env({}))).toEqual({});
    expect(await mintAuthToken(env({ authSetup: setup({ enabled: false }) as any }))).toEqual({});
  });

  it('extracts the token via JSONPath and resolves {{vars}} in the request', async () => {
    stubFetch(200, { token: 'JWT123' });
    const r = await mintAuthToken(env({ authSetup: setup() as any, variables: [{ key: 'username', value: 'kminchelle', secret: false }] }));
    expect(r.token).toBe('JWT123');
    expect(r.varName).toBe('token');
    const call = (fetch as any).mock.calls[0];
    expect(call[0]).toBe('https://api.example.com/auth/login'); // {{baseUrl}} resolved
    expect(String(call[1].body)).toContain('kminchelle');       // {{username}} resolved
  });

  it('reads a nested token path', async () => {
    stubFetch(200, { data: { accessToken: 'nested-tok' } });
    const r = await mintAuthToken(env({ authSetup: setup({ tokenPath: '$.data.accessToken' }) as any }));
    expect(r.token).toBe('nested-tok');
  });

  it('reports a diagnostic on a failed login', async () => {
    stubFetch(401, { message: 'bad creds' });
    const r = await mintAuthToken(env({ authSetup: setup() as any }));
    expect(r.token).toBeUndefined();
    expect(r.diagnostic).toMatch(/401/);
  });

  it('reports a diagnostic when the token path is absent', async () => {
    stubFetch(200, { somethingElse: 'x' });
    const r = await mintAuthToken(env({ authSetup: setup() as any }));
    expect(r.token).toBeUndefined();
    expect(r.diagnostic).toMatch(/no token/i);
  });
});
