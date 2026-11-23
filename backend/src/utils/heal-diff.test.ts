/**
 * Unit tests for the self-heal before→after diff builder.
 * Run with: `npm test` (vitest).
 */
import { describe, it, expect } from 'vitest';
import { buildHealDiff } from './heal-diff.js';

describe('buildHealDiff', () => {
  it('reports a status change', () => {
    const d = buildHealDiff({ status: 200 }, { status: 201 });
    expect(d.statusChanged).toBe(true);
    expect(d.status).toEqual({ before: 200, after: 201 });
    expect(d.summary).toContain('200 → 201');
  });

  it('does not flag an unchanged status', () => {
    const d = buildHealDiff({ status: 200, response: '{}' }, { status: 200, response: '{}' });
    expect(d.statusChanged).toBe(false);
    expect(d.responseChanged).toBe(false);
    expect(d.summary).toBe('no change');
  });

  it('produces a line diff of the response body', () => {
    const before = '{"name":"Ada","role":"user"}';
    const after = '{"name":"Ada","role":"admin"}';
    const d = buildHealDiff({ status: 200, response: before }, { status: 200, response: after });
    expect(d.responseChanged).toBe(true);
    expect(d.added).toBeGreaterThan(0);
    expect(d.removed).toBeGreaterThan(0);
    // the removed line carries the old role, the added line the new
    expect(d.responseDiff.some((l) => l.kind === 'del' && l.text.includes('user'))).toBe(true);
    expect(d.responseDiff.some((l) => l.kind === 'add' && l.text.includes('admin'))).toBe(true);
    // unchanged lines are preserved as context
    expect(d.responseDiff.some((l) => l.kind === 'same' && l.text.includes('Ada'))).toBe(true);
  });

  it('treats an added field as pure additions with context retained', () => {
    const d = buildHealDiff({ response: '{\n  "a": 1\n}' }, { response: '{\n  "a": 1,\n  "b": 2\n}' });
    expect(d.added).toBeGreaterThan(0);
    expect(d.responseDiff.filter((l) => l.kind === 'same').length).toBeGreaterThan(0);
  });
});
