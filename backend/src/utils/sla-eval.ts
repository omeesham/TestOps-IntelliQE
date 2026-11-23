/**
 * sla-eval.ts
 * ───────────
 * Pure SLA / availability evaluation for the monitoring loop. Given the health
 * probes of one monitor run, it computes availability (how many endpoints were
 * reachable) and the latency-SLA breaches (endpoints slower than the threshold).
 * The always-on monitor alerted only on unreachable/5xx/status-mismatch before;
 * this adds the latency SLA and the availability number operators actually track.
 * No DB, no network — directly unit-testable.
 */

export interface HealthSample {
  method: string;
  url: string;
  ok: boolean;          // reachable AND not a transport error
  status?: number;
  elapsedMs: number;
}

export interface SlaThresholds {
  /** Warn when a reachable endpoint responds slower than this. */
  maxResponseMs?: number;
}

export interface SlaBreach { method: string; url: string; elapsedMs: number; limitMs: number }

export interface SlaReport {
  total: number;
  reachable: number;
  availabilityPct: number;     // reachable / total, 0..100
  slowest?: { method: string; url: string; elapsedMs: number };
  avgMs: number;               // over reachable samples
  breaches: SlaBreach[];       // reachable endpoints slower than maxResponseMs
}

function round(n: number, dp = 1): number { const f = 10 ** dp; return Math.round(n * f) / f; }

export function evaluateHealthSla(samples: HealthSample[], thresholds: SlaThresholds = {}): SlaReport {
  const total = samples.length;
  const reachableSamples = samples.filter((s) => s.ok);
  const reachable = reachableSamples.length;
  const availabilityPct = total ? round((reachable / total) * 100) : 100;

  let slowest: SlaReport['slowest'];
  let sum = 0;
  for (const s of reachableSamples) {
    sum += s.elapsedMs;
    if (!slowest || s.elapsedMs > slowest.elapsedMs) slowest = { method: s.method, url: s.url, elapsedMs: s.elapsedMs };
  }
  const avgMs = reachable ? Math.round(sum / reachable) : 0;

  const limitMs = Number(thresholds.maxResponseMs) || 0;
  const breaches: SlaBreach[] = limitMs > 0
    ? reachableSamples.filter((s) => s.elapsedMs > limitMs).map((s) => ({ method: s.method, url: s.url, elapsedMs: s.elapsedMs, limitMs }))
    : [];

  return { total, reachable, availabilityPct, slowest, avgMs, breaches };
}
