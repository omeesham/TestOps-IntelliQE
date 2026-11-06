/**
 * Unit tests for translating Postman scripts → flow checks / extracts.
 * Run with: `npm test` (vitest).
 */
import { describe, it, expect } from 'vitest';
import { parsePostmanScripts } from './postman-script-parser.js';

/** Build a Postman `event[]` with a single test (or pre-request) script. */
function evt(exec: string[], listen: 'test' | 'prerequest' = 'test') {
  return [{ listen, script: { type: 'text/javascript', exec } }];
}

describe('parsePostmanScripts — assertions → checks', () => {
  it('maps pm.response.to.have.status(n)', () => {
    const r = parsePostmanScripts(evt(['pm.response.to.have.status(201);']));
    expect(r.checks).toContainEqual({ kind: 'status', oneOf: [201] });
  });

  it('maps pm.expect(pm.response.code).to.eql(n)', () => {
    const r = parsePostmanScripts(evt(['pm.expect(pm.response.code).to.eql(200);']));
    expect(r.checks).toContainEqual({ kind: 'status', oneOf: [200] });
  });

  it('maps to.be.ok to a non-error status check', () => {
    const r = parsePostmanScripts(evt(['pm.response.to.be.ok;']));
    expect(r.checks).toContainEqual({ kind: 'status' });
  });

  it('maps response-time below', () => {
    const r = parsePostmanScripts(evt(['pm.expect(pm.response.responseTime).to.be.below(500);']));
    expect(r.checks).toContainEqual({ kind: 'responseTimeUnderMs', ms: 500 });
  });

  it('maps header exists and header equals (statement form)', () => {
    const exists = parsePostmanScripts(evt(['pm.response.to.have.header("Content-Type");']));
    expect(exists.checks).toContainEqual({ kind: 'header', name: 'Content-Type', op: 'exists' });
    const equals = parsePostmanScripts(evt(['pm.response.to.have.header("X-Env", "prod");']));
    expect(equals.checks).toContainEqual({ kind: 'header', name: 'X-Env', op: 'equals', value: 'prod' });
  });

  it('maps headers.get(...).to.include(...) to a contains check', () => {
    const r = parsePostmanScripts(evt(['pm.expect(pm.response.headers.get("Content-Type")).to.include("json");']));
    expect(r.checks).toContainEqual({ kind: 'header', name: 'Content-Type', op: 'contains', value: 'json' });
  });

  it('maps body text include → bodyContains', () => {
    const r = parsePostmanScripts(evt(['pm.expect(pm.response.text()).to.include("created");']));
    expect(r.checks).toContainEqual({ kind: 'bodyContains', text: 'created' });
  });

  it('maps jsonPath equals + exists via a response alias', () => {
    const r = parsePostmanScripts(evt([
      'var jsonData = pm.response.json();',
      'pm.expect(jsonData.id).to.eql(5);',
      'pm.expect(jsonData.name).to.exist;',
    ]));
    expect(r.checks).toContainEqual({ kind: 'jsonPathEquals', path: 'id', value: '5' });
    expect(r.checks).toContainEqual({ kind: 'jsonPathExists', path: 'name' });
  });

  it('maps to.have.property with and without a value', () => {
    const r = parsePostmanScripts(evt([
      'const d = pm.response.json();',
      'pm.expect(d.data).to.have.property("token");',
      'pm.expect(d).to.have.property("status", "ok");',
    ]));
    expect(r.checks).toContainEqual({ kind: 'jsonPathExists', path: 'data.token' });
    expect(r.checks).toContainEqual({ kind: 'jsonPathEquals', path: 'status', value: 'ok' });
  });

  it('handles pm.response.json() inline (no alias) and nested/array paths', () => {
    const r = parsePostmanScripts(evt(['pm.expect(pm.response.json().data[0].id).to.eql(1);']));
    expect(r.checks).toContainEqual({ kind: 'jsonPathEquals', path: 'data.0.id', value: '1' });
  });

  it('deduplicates identical assertions', () => {
    const r = parsePostmanScripts(evt([
      'pm.response.to.have.status(200);',
      'pm.expect(pm.response.code).to.eql(200);',
    ]));
    expect(r.checks.filter((c) => c.kind === 'status')).toHaveLength(1);
  });
});

describe('parsePostmanScripts — captures → extracts', () => {
  it('captures a body value from a response alias', () => {
    const r = parsePostmanScripts(evt([
      'var jsonData = pm.response.json();',
      'pm.environment.set("token", jsonData.token);',
    ]));
    expect(r.extracts).toContainEqual({ name: 'token', from: 'body', path: 'token' });
  });

  it('captures a nested body value from pm.response.json() inline', () => {
    const r = parsePostmanScripts(evt(['pm.collectionVariables.set("id", pm.response.json().data.id);']));
    expect(r.extracts).toContainEqual({ name: 'id', from: 'body', path: 'data.id' });
  });

  it('captures a response header', () => {
    const r = parsePostmanScripts(evt(['pm.globals.set("loc", pm.response.headers.get("Location"));']));
    expect(r.extracts).toContainEqual({ name: 'loc', from: 'header', path: 'Location' });
  });

  it('captures the status code', () => {
    const r = parsePostmanScripts(evt(['pm.variables.set("code", pm.response.code);']));
    expect(r.extracts).toContainEqual({ name: 'code', from: 'status' });
  });

  it('treats a literal set() as a seed variable, not an extract', () => {
    const r = parsePostmanScripts(evt(['pm.environment.set("env", "prod");'], 'prerequest'));
    expect(r.variables).toEqual({ env: 'prod' });
    expect(r.extracts).toHaveLength(0);
  });

  it('supports the legacy postman.setEnvironmentVariable API', () => {
    const r = parsePostmanScripts(evt([
      'var d = pm.response.json();',
      'postman.setEnvironmentVariable("userId", d.user.id);',
    ]));
    expect(r.extracts).toContainEqual({ name: 'userId', from: 'body', path: 'user.id' });
  });
});

describe('parsePostmanScripts — robustness', () => {
  it('returns nothing for an item with no events', () => {
    const r = parsePostmanScripts(undefined);
    expect(r).toEqual({ checks: [], extracts: [], variables: {}, warnings: [] });
  });

  it('warns (but does not throw) when a script has assertions it cannot convert', () => {
    const r = parsePostmanScripts(evt(['tests["Status code is 200"] = responseCode.code === 200;']));
    expect(r.checks).toHaveLength(0);
    expect(r.warnings.length).toBeGreaterThan(0);
  });

  it('does not guess a computed capture value', () => {
    const r = parsePostmanScripts(evt(['pm.environment.set("ts", Date.now());']));
    expect(r.extracts).toHaveLength(0);
    expect(r.variables.ts).toBeUndefined();
  });
});
