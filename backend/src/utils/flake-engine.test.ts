/**
 * Unit tests for the reliability/determinism summariser.
 * Run with: `npm test` (vitest).
 */
import { describe, it, expect } from 'vitest';
import { summarizeReliability, type RunOutcome } from './flake-engine.js';

const pass = (names: string[], durationMs = 10): RunOutcome => ({ passed: true, durationMs, steps: names.map((name) => ({ name, ok: true })) });

describe('summarizeReliability', () => {
  it('reports a deterministic suite when every run passes identically', () => {
    const r = summarizeReliability([pass(['login', 'orders']), pass(['login', 'orders']), pass(['login', 'orders'])]);
    expect(r.runs).toBe(3);
    expect(r.passedRuns).toBe(3);
    expect(r.flakeRate).toBe(0);
    expect(r.deterministic).toBe(true);
    expect(r.flakySteps).toHaveLength(0);
    expect(r.verdict).toMatch(/Deterministic/i);
  });

  it('flags a flaky step and a non-zero flake rate', () => {
    const outcomes: RunOutcome[] = [
      { passed: true, durationMs: 10, steps: [{ name: 'login', ok: true }, { name: 'orders', ok: true }] },
      { passed: false, durationMs: 12, steps: [{ name: 'login', ok: true }, { name: 'orders', ok: false }] },
      { passed: true, durationMs: 11, steps: [{ name: 'login', ok: true }, { name: 'orders', ok: true }] },
      { passed: true, durationMs: 10, steps: [{ name: 'login', ok: true }, { name: 'orders', ok: true }] },
    ];
    const r = summarizeReliability(outcomes);
    expect(r.deterministic).toBe(false);
    expect(r.flakeRate).toBe(0.25);                 // 1 of 4 runs disagreed with the majority
    expect(r.flakySteps.map((s) => s.name)).toEqual(['orders']);
    const orders = r.steps.find((s) => s.name === 'orders')!;
    expect(orders.passRate).toBe(0.75);
    expect(r.verdict).toMatch(/Flaky/i);
  });

  it('calls a consistently-failing suite stable, not flaky', () => {
    const fail: RunOutcome = { passed: false, durationMs: 9, steps: [{ name: 'login', ok: false }] };
    const r = summarizeReliability([fail, fail, fail]);
    expect(r.flakeRate).toBe(0);
    expect(r.deterministic).toBe(true);
    expect(r.flakySteps).toHaveLength(0);
    expect(r.verdict).toMatch(/Stable but failing/i);
  });

  it('computes latency spread', () => {
    const r = summarizeReliability([pass(['a'], 10), pass(['a'], 30), pass(['a'], 20)]);
    expect(r.latency).toEqual({ minMs: 10, maxMs: 30, avgMs: 20 });
  });

  it('handles zero runs without dividing by zero', () => {
    const r = summarizeReliability([]);
    expect(r.runs).toBe(0);
    expect(r.deterministic).toBe(true);
    expect(r.flakeRate).toBe(0);
  });
});
