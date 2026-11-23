/**
 * Unit tests for the SLA / availability evaluator.
 * Run with: `npm test` (vitest).
 */
import { describe, it, expect } from 'vitest';
import { evaluateHealthSla, type HealthSample } from './sla-eval.js';

const s = (url: string, ok: boolean, elapsedMs: number, status = 200): HealthSample => ({ method: 'GET', url, ok, status, elapsedMs });

describe('evaluateHealthSla', () => {
  it('computes availability from reachable samples', () => {
    const r = evaluateHealthSla([s('/a', true, 100), s('/b', false, 0), s('/c', true, 200), s('/d', true, 150)]);
    expect(r.total).toBe(4);
    expect(r.reachable).toBe(3);
    expect(r.availabilityPct).toBe(75);
    expect(r.avgMs).toBe(150);
    expect(r.slowest).toMatchObject({ url: '/c', elapsedMs: 200 });
  });

  it('flags latency-SLA breaches among reachable endpoints', () => {
    const r = evaluateHealthSla([s('/fast', true, 120), s('/slow', true, 900), s('/down', false, 0)], { maxResponseMs: 500 });
    expect(r.breaches).toHaveLength(1);
    expect(r.breaches[0]).toMatchObject({ url: '/slow', elapsedMs: 900, limitMs: 500 });
  });

  it('raises no breach without a threshold', () => {
    const r = evaluateHealthSla([s('/slow', true, 5000)]);
    expect(r.breaches).toHaveLength(0);
  });

  it('is 100% available with no samples', () => {
    const r = evaluateHealthSla([]);
    expect(r.availabilityPct).toBe(100);
    expect(r.reachable).toBe(0);
  });

  it('does not count an unreachable endpoint as an SLA breach', () => {
    const r = evaluateHealthSla([s('/down', false, 0)], { maxResponseMs: 1 });
    expect(r.breaches).toHaveLength(0); // unreachable is an availability problem, not a latency breach
  });
});
