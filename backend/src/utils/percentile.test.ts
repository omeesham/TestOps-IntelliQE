import { describe, it, expect } from 'vitest';
import { percentile, latencyStats } from './percentile';

describe('percentile', () => {
  it('returns 0 for no samples', () => {
    expect(percentile([], 95)).toBe(0);
  });
  it('returns the single value regardless of p', () => {
    expect(percentile([42], 50)).toBe(42);
    expect(percentile([42], 99)).toBe(42);
  });
  it('p0/p100 are the min/max', () => {
    expect(percentile([10, 20, 30, 40], 0)).toBe(10);
    expect(percentile([10, 20, 30, 40], 100)).toBe(40);
  });
  it('p50 is the median (interpolated)', () => {
    expect(percentile([1, 2, 3, 4], 50)).toBe(2.5);
    expect(percentile([1, 2, 3], 50)).toBe(2);
  });
  it('interpolates between ranks', () => {
    // 10 values 1..10; p95 rank = 0.95*9 = 8.55 → between xs[8]=9 and xs[9]=10
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 95)).toBeCloseTo(9.55, 5);
  });
  it('ignores non-finite values and sorts unsorted input', () => {
    expect(percentile([30, 10, NaN, 20, Infinity], 50)).toBe(20);
  });
});

describe('latencyStats', () => {
  it('summarizes an empty set as zeros', () => {
    expect(latencyStats([])).toEqual({ count: 0, p50: 0, p90: 0, p95: 0, p99: 0, max: 0 });
  });
  it('computes rounded percentiles + max, dropping negatives', () => {
    const s = latencyStats([100, 200, 300, 400, 500, -5]);
    expect(s.count).toBe(5);
    expect(s.p50).toBe(300);
    expect(s.max).toBe(500);
    expect(s.p90).toBeGreaterThanOrEqual(s.p50);
    expect(s.p95).toBeGreaterThanOrEqual(s.p90);
  });
});
