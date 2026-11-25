/**
 * Unit tests for the workspace-globals scope (api-global-variables.service).
 *
 * Covers the pure merge `withGlobals` and, through it, the resolution precedence
 * that the run paths rely on: globals are the broadest scope, and an environment
 * variable of the same name WINS. No DB — `withGlobals` is pure; the end-to-end
 * resolution is checked against the real `applyEnvironment` from the environments
 * service so a merged env resolves `{{vars}}` exactly as a run would.
 */
import { describe, it, expect } from 'vitest';
import { withGlobals } from './api-global-variables.service.js';
import { applyEnvironment, type ApiEnvironment, type EnvVariable } from './api-environments.service.js';

function env(variables: EnvVariable[], baseUrl = 'https://api.acme.com'): ApiEnvironment {
  return {
    id: 'e1', name: 'staging', baseUrl, variables,
    isDefault: false, customerLike: false, createdAt: '', updatedAt: '',
  };
}
const g = (key: string, value: string, secret = false): EnvVariable => ({ key, value, secret });

describe('withGlobals precedence', () => {
  it('adds a global the environment does not define', () => {
    const merged = withGlobals(env([g('token', 'env-tok')]), [g('clientId', 'global-cid')]);
    const map = Object.fromEntries(merged.variables.map((v) => [v.key, v.value]));
    expect(map.clientId).toBe('global-cid');
    expect(map.token).toBe('env-tok');
  });

  it('lets an environment variable OVERRIDE a global of the same name (narrower wins)', () => {
    const merged = withGlobals(env([g('token', 'env-wins')]), [g('token', 'global-loses')]);
    const tokens = merged.variables.filter((v) => v.key === 'token');
    expect(tokens).toHaveLength(1);              // de-duped, not two entries
    expect(tokens[0]!.value).toBe('env-wins');   // environment value kept
  });

  it('is a no-op when there are no globals, and never mutates the input env', () => {
    const base = env([g('token', 'env-tok')]);
    const snapshot = JSON.stringify(base);
    const merged = withGlobals(base, []);
    expect(merged).toBe(base);                   // same ref when nothing to merge
    withGlobals(base, [g('x', '1')]);
    expect(JSON.stringify(base)).toBe(snapshot); // original untouched
  });

  it('does not change baseUrl / default / auth — only widens the variable list', () => {
    const merged = withGlobals(env([g('token', 't')], 'https://api.acme.com'), [g('clientId', 'c')]);
    expect(merged.baseUrl).toBe('https://api.acme.com');
    expect(merged.isDefault).toBe(false);
  });
});

describe('end-to-end resolution through applyEnvironment', () => {
  it('resolves a {{global}} that the environment never defines', () => {
    const merged = withGlobals(env([g('token', 'tok')]), [g('clientId', 'CID-123')]);
    const out = applyEnvironment(
      { url: 'https://api.acme.com/orders', headers: [{ key: 'X-Client', value: '{{clientId}}' }], body: '{"t":"{{token}}"}' },
      merged,
    );
    expect(out.headers[0]!.value).toBe('CID-123');
    expect(out.body).toBe('{"t":"tok"}');
  });

  it('a {{token}} defined in BOTH scopes resolves to the environment value', () => {
    const merged = withGlobals(env([g('token', 'ENV')]), [g('token', 'GLOBAL')]);
    const out = applyEnvironment(
      { url: 'https://api.acme.com/x', headers: [{ key: 'X-Tok', value: '{{token}}' }] },
      merged,
    );
    expect(out.headers[0]!.value).toBe('ENV');
  });
});
