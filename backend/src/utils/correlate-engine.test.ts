/**
 * Unit tests for the capture → runnable-flow dependency-correlation engine.
 * Run with: `npm test` (vitest).
 *
 * These exercise the real acceptance criteria: a value produced in one response
 * (token / id / uuid) that a later request reuses gets extracted to a {{var}} on
 * the producer and injected into the consumer — across url, header and body —
 * without false-correlating unrelated literals.
 */
import { describe, it, expect } from 'vitest';
import { buildCorrelatedFlow, isCorrelatable, occursAsToken, replaceToken, type CaptureEntry } from './correlate-engine.js';

function entry(e: Partial<CaptureEntry> & { method: string; url: string }): CaptureEntry {
  return { reqHeaders: [], ...e };
}

describe('isCorrelatable', () => {
  it('accepts identifiers and tokens', () => {
    for (const v of ['42', '1007', 'eyJhbGciOi.JhbGc.sig', 'a1b2c3d4e5f6a7b8', '550e8400-e29b-41d4-a716-446655440000', 'user@example.com', 'abc12345']) {
      expect(isCorrelatable(v)).toBe(true);
    }
  });
  it('rejects noise words and single digits', () => {
    for (const v of ['true', 'false', 'ok', 'success', 'error', '1', 'a', '']) {
      expect(isCorrelatable(v)).toBe(false);
    }
  });
});

describe('token-boundary matching', () => {
  it('matches a whole token, not a substring of a longer id', () => {
    expect(occursAsToken('/users/42/orders', '42')).toBe(true);
    expect(occursAsToken('/users/426/orders', '42')).toBe(false); // 42 is inside 426
    expect(occursAsToken('Bearer abc123def', 'abc123def')).toBe(true);
  });
  it('replaces only whole-token occurrences', () => {
    expect(replaceToken('/users/42', '42', '{{id}}')).toBe('/users/{{id}}');
    expect(replaceToken('/users/426', '42', '{{id}}')).toBe('/users/426');
    expect(replaceToken('Bearer tok', 'tok', '{{t}}')).toBe('Bearer {{t}}');
  });
});

describe('buildCorrelatedFlow — login token reused in Authorization header', () => {
  const entries: CaptureEntry[] = [
    entry({ method: 'POST', url: 'https://api.test/login', status: 200,
      reqBody: '{"user":"a","pass":"b"}',
      resBody: '{"token":"eyJhbGciOi.JhbGc.sig12345"}' }),
    entry({ method: 'GET', url: 'https://api.test/orders', status: 200,
      reqHeaders: [{ key: 'Authorization', value: 'Bearer eyJhbGciOi.JhbGc.sig12345' }],
      resBody: '{"orders":[]}' }),
  ];

  it('extracts the token on step 1 and injects {{token}} into step 2', () => {
    const flow = buildCorrelatedFlow(entries, 'Auth session');
    expect(flow.stepCount).toBe(2);
    // producer has an extract binding `token` from the body
    expect(flow.steps[0].extract).toEqual([{ name: 'token', from: 'body', path: 'token' }]);
    // consumer header no longer carries the literal secret
    const authHeader = flow.steps[1].headers!.find((h) => h.key === 'Authorization')!;
    expect(authHeader.value).toBe('Bearer {{token}}');
    expect(authHeader.value).not.toContain('sig12345');
    // a link was recorded
    expect(flow.linkCount).toBe(1);
    expect(flow.links[0]).toMatchObject({ fromStep: 0, toStep: 1, var: 'token', in: 'header', header: 'Authorization' });
  });

  it('asserts the observed status on each step', () => {
    const flow = buildCorrelatedFlow(entries, 'Auth session');
    expect(flow.steps[0].checks).toEqual([{ kind: 'status', oneOf: [200] }]);
  });
});

describe('buildCorrelatedFlow — create then read by returned id (url + body)', () => {
  const entries: CaptureEntry[] = [
    entry({ method: 'POST', url: 'https://api.test/users', status: 201,
      reqBody: '{"name":"Ada"}',
      resBody: '{"id":9281,"name":"Ada"}' }),
    entry({ method: 'GET', url: 'https://api.test/users/9281', status: 200,
      resBody: '{"id":9281,"name":"Ada"}' }),
    entry({ method: 'POST', url: 'https://api.test/audit', status: 201,
      reqBody: '{"userId":9281,"action":"view"}',
      resBody: '{"ok":true}' }),
  ];

  it('wires the created id into the later url and body', () => {
    const flow = buildCorrelatedFlow(entries, 'User session');
    expect(flow.steps[0].extract).toEqual([{ name: 'id', from: 'body', path: 'id' }]);
    expect(flow.steps[1].url).toBe('https://api.test/users/{{id}}');
    expect(flow.steps[2].body).toBe('{"userId":{{id}},"action":"view"}');
    // two consumers of the same producer id → one var reused, two links
    expect(flow.links.filter((l) => l.var === 'id')).toHaveLength(2);
  });
});

describe('buildCorrelatedFlow — no false correlation / no producer after consumer', () => {
  it('does not wire a value that only appears earlier than it is produced', () => {
    const entries: CaptureEntry[] = [
      entry({ method: 'GET', url: 'https://api.test/ping', status: 200, resBody: '{"status":"ok"}' }),
      entry({ method: 'GET', url: 'https://api.test/health', status: 200, resBody: '{"status":"ok"}' }),
    ];
    const flow = buildCorrelatedFlow(entries, 'Health');
    expect(flow.linkCount).toBe(0);
    expect(flow.steps.every((s) => (s.extract || []).length === 0)).toBe(true);
  });

  it('collapses exact-duplicate requests into one journey step', () => {
    const dup = entry({ method: 'GET', url: 'https://api.test/items', status: 200, resBody: '{"items":[]}' });
    const flow = buildCorrelatedFlow([dup, dup, dup], 'Dups');
    expect(flow.stepCount).toBe(1);
  });
});
