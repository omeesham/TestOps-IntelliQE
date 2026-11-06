/**
 * Integration tests for postmanToFlow — proves that a collection's test /
 * pre-request scripts are carried across as runnable checks + extracts (the
 * login→use-token chaining), on top of the request-shape conversion.
 * Run with: `npm test` (vitest).
 */
import { describe, it, expect } from 'vitest';
import { postmanToFlow } from './postman-import.js';

const loginUseCollection = {
  info: { name: 'Auth flow', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' },
  variable: [{ key: 'baseUrl', value: 'https://api.example.com' }],
  item: [
    {
      name: 'Login',
      request: {
        method: 'POST',
        url: { raw: '{{baseUrl}}/login' },
        body: { mode: 'raw', raw: '{"user":"a","pass":"b"}' },
      },
      event: [{
        listen: 'test',
        script: { exec: [
          'pm.response.to.have.status(200);',
          'var jsonData = pm.response.json();',
          'pm.expect(jsonData.token).to.exist;',
          'pm.environment.set("token", jsonData.token);',
        ] },
      }],
    },
    {
      name: 'Get profile',
      request: {
        method: 'GET',
        url: { raw: '{{baseUrl}}/me' },
        header: [{ key: 'Authorization', value: 'Bearer {{token}}' }],
      },
      event: [{
        listen: 'test',
        script: { exec: [
          'pm.response.to.have.status(200);',
          'pm.expect(pm.response.responseTime).to.be.below(800);',
        ] },
      }],
    },
  ],
};

describe('postmanToFlow — scripts become checks + extracts', () => {
  const { steps, variables } = postmanToFlow(loginUseCollection);

  it('keeps both requests as ordered steps', () => {
    expect(steps.map((s) => s.name)).toEqual(['Login', 'Get profile']);
  });

  it('captures the token on the login step and asserts it', () => {
    const login = steps[0]!;
    expect(login.extract).toContainEqual({ name: 'token', from: 'body', path: 'token' });
    expect(login.checks).toContainEqual({ kind: 'status', oneOf: [200] });
    expect(login.checks).toContainEqual({ kind: 'jsonPathExists', path: 'token' });
  });

  it('chains the captured token into the next step and keeps its own checks', () => {
    const profile = steps[1]!;
    // The header still references {{token}} verbatim — resolved at run time from the capture.
    expect(profile.headers).toContainEqual({ key: 'Authorization', value: 'Bearer {{token}}' });
    expect(profile.checks).toContainEqual({ kind: 'status', oneOf: [200] });
    expect(profile.checks).toContainEqual({ kind: 'responseTimeUnderMs', ms: 800 });
  });

  it('still returns collection variables as seeds', () => {
    expect(variables.baseUrl).toBe('https://api.example.com');
  });

  it('leaves a scriptless collection unchanged (no checks/extracts added)', () => {
    const plain = postmanToFlow({
      info: { name: 'plain', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' },
      item: [{ name: 'Ping', request: { method: 'GET', url: 'https://api.example.com/ping' } }],
    });
    expect(plain.steps).toHaveLength(1);
    expect(plain.steps[0]!.checks).toBeUndefined();
    expect(plain.steps[0]!.extract).toBeUndefined();
  });
});
