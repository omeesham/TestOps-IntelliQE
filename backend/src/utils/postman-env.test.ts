/**
 * Unit tests for Postman environment parsing + variable merge/precedence.
 * Run with: `npm test` (vitest).
 */
import { describe, it, expect } from 'vitest';
import { parsePostmanEnvironment, collectionVariables, mergePostmanVariables, isSecretVariable } from './postman-env.js';

describe('isSecretVariable', () => {
  it('flags Postman type:secret', () => {
    expect(isSecretVariable('anything', 'secret')).toBe(true);
  });
  it('flags credential-like key names', () => {
    for (const k of ['password', 'apiKey', 'api_key', 'access_token', 'clientSecret', 'authToken', 'bearer']) {
      expect(isSecretVariable(k)).toBe(true);
    }
  });
  it('leaves ordinary keys non-secret', () => {
    for (const k of ['baseUrl', 'host', 'userId', 'page']) {
      expect(isSecretVariable(k)).toBe(false);
    }
  });
});

describe('parsePostmanEnvironment', () => {
  it('parses name + enabled values and marks secrets', () => {
    const r = parsePostmanEnvironment({
      name: 'QA',
      values: [
        { key: 'baseUrl', value: 'https://qa.test', enabled: true },
        { key: 'token', value: 'abc', type: 'secret', enabled: true },
      ],
    });
    expect(r.name).toBe('QA');
    expect(r.variables).toHaveLength(2);
    expect(r.variables.find((v) => v.key === 'token')!.secret).toBe(true);
    expect(r.variables.find((v) => v.key === 'baseUrl')!.secret).toBe(false);
  });

  it('excludes disabled variables', () => {
    const r = parsePostmanEnvironment({ name: 'E', values: [{ key: 'a', value: '1', enabled: false }, { key: 'b', value: '2' }] });
    expect(r.variables.map((v) => v.key)).toEqual(['b']);
  });

  it('throws when the document is not an environment export', () => {
    expect(() => parsePostmanEnvironment({ info: {}, item: [] })).toThrow(/not a Postman environment export/i);
  });
});

describe('collectionVariables', () => {
  it('reads enabled collection variables and detects secrets by name', () => {
    const vars = collectionVariables({ variable: [{ key: 'baseUrl', value: 'u' }, { key: 'apiKey', value: 'k' }, { key: 'off', value: 'x', disabled: true }] });
    expect(vars.map((v) => v.key)).toEqual(['baseUrl', 'apiKey']);
    expect(vars.find((v) => v.key === 'apiKey')!.secret).toBe(true);
  });
});

describe('mergePostmanVariables — environment precedence', () => {
  it('environment value overrides a collection value and reports the conflict', () => {
    const merged = mergePostmanVariables(
      [{ key: 'baseUrl', value: 'https://dev', secret: false }, { key: 'only', value: 'c', secret: false }],
      [{ key: 'baseUrl', value: 'https://qa', secret: false }],
    );
    const baseUrl = merged.find((v) => v.key === 'baseUrl')!;
    expect(baseUrl.value).toBe('https://qa');
    expect(baseUrl.source).toBe('environment');
    expect(baseUrl.conflict).toBe(true);
    expect(merged.find((v) => v.key === 'only')!.source).toBe('collection');
  });

  it('keeps a key secret if it was secret in either scope', () => {
    const merged = mergePostmanVariables(
      [{ key: 'token', value: 'c', secret: true }],
      [{ key: 'token', value: 'e', secret: false }],
    );
    expect(merged.find((v) => v.key === 'token')!.secret).toBe(true);
  });

  it('works with no environment variables', () => {
    const merged = mergePostmanVariables([{ key: 'a', value: '1', secret: false }]);
    expect(merged).toHaveLength(1);
    expect(merged[0]!.source).toBe('collection');
  });
});
