/**
 * percentile.ts — latency percentile math for reporting/analytics.
 * Linear-interpolation percentiles (the "p95" everyone means), plus a bundled
 * LatencyStats summary used by the API dashboard.
 */

/** Linear-interpolation percentile (p in [0,100]) over numeric samples. Empty ⇒ 0. */
export function percentile(values: number[], p: number): number {
  const xs = values.filter((v) => typeof v === 'number' && Number.isFinite(v)).sort((a, b) => a - b);
  if (xs.length === 0) return 0;
  if (xs.length === 1) return xs[0]!;
  const clamped = Math.min(100, Math.max(0, p));
  const rank = (clamped / 100) * (xs.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  if (lo === hi) return xs[lo]!;
  return xs[lo]! + (xs[hi]! - xs[lo]!) * (rank - lo);
}

export interface LatencyStats { count: number; p50: number; p90: number; p95: number; p99: number; max: number }

/** p50/p90/p95/p99 + max over non-negative samples, rounded to whole units (ms). */
export function latencyStats(values: number[]): LatencyStats {
  const xs = values.filter((v) => typeof v === 'number' && Number.isFinite(v) && v >= 0);
  const r = (n: number) => Math.round(n);
  return {
    count: xs.length,
    p50: r(percentile(xs, 50)),
    p90: r(percentile(xs, 90)),
    p95: r(percentile(xs, 95)),
    p99: r(percentile(xs, 99)),
    max: xs.length ? r(Math.max(...xs)) : 0,
  };
}
