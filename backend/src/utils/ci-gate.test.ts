/**
 * Unit tests for the CI gate helpers.
 * Run with: `npm test` (vitest).
 */
import { describe, it, expect } from 'vitest';
import { summarizeCiRun, exitCodeFor } from './ci-gate.js';

describe('summarizeCiRun', () => {
  it('summarises a passing flow and ignores WAIT markers', () => {
    const result = { passed: true, durationMs: 120, steps: [
      { name: 'login', method: 'POST', ok: true },
      { name: 'wait', method: 'WAIT', ok: true },
      { name: 'orders', method: 'GET', ok: true },
    ] };
    const s = summarizeCiRun('flow', result);
    expect(s.total).toBe(2);
    expect(s.passed).toBe(2);
    expect(s.failed).toBe(0);
    expect(s.ok).toBe(true);
    expect(s.line).toMatch(/^PASS · 2\/2 steps passed/);
    expect(exitCodeFor(s)).toBe(0);
  });

  it('fails the gate when a step failed', () => {
    const result = { passed: false, durationMs: 90, steps: [
      { name: 'login', method: 'POST', ok: true },
      { name: 'orders', method: 'GET', ok: false },
    ] };
    const s = summarizeCiRun('flow', result);
    expect(s.failed).toBe(1);
    expect(s.ok).toBe(false);
    expect(s.line).toMatch(/^FAIL/);
    expect(exitCodeFor(s)).toBe(1);
  });

  it('summarises a suite by flow pass counts', () => {
    const result = { passed: false, durationMs: 300, flows: [{ passed: true }, { passed: false }, { passed: true }] };
    const s = summarizeCiRun('suite', result);
    expect(s.total).toBe(3);
    expect(s.passed).toBe(2);
    expect(s.ok).toBe(false);
    expect(s.line).toContain('2/3 flows passed');
  });

  it('summarises a dataset by rows', () => {
    const result = { passed: true, rowsTotal: 4, rowsPassed: 4, durationMs: 50 };
    const s = summarizeCiRun('dataset', result);
    expect(s.total).toBe(4);
    expect(s.passed).toBe(4);
    expect(s.ok).toBe(true);
    expect(s.line).toContain('4/4 rows passed');
  });

  it('exitCodeFor accepts a bare boolean', () => {
    expect(exitCodeFor(true)).toBe(0);
    expect(exitCodeFor(false)).toBe(1);
  });
});
