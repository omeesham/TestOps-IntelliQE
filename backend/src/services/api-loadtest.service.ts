/**
 * api-loadtest.service.ts
 * ───────────────────────
 * A lightweight, in-house load runner — no k6/JMeter binary. It fires a bounded
 * number of requests at one endpoint with a fixed concurrency and reports
 * latency percentiles, throughput, status mix and errors.
 *
 * Standalone and opt-in: it reuses only the shared HTTP helper, never the
 * generate/execute/heal pipeline. Write methods are refused unless the caller
 * explicitly allows them (a load run repeats the request many times).
 */
import { buildRequestInit, timedFetch, clampInt, isWriteMethod, type HttpEndpoint } from '../utils/api-http.js';

export interface LoadTestInput {
  endpoint: HttpEndpoint;
  totalRequests?: number;
  concurrency?: number;
  /** Required to load-test a write method (POST/PUT/PATCH/DELETE). */
  allowWrites?: boolean;
}

export interface LoadTestResult {
  url: string;
  method: string;
  totalRequests: number;
  concurrency: number;
  durationMs: number;
  completed: number;
  failed: number;
  non2xx: number;
  throughputRps: number;
  latency: { min: number; p50: number; p90: number; p95: number; p99: number; max: number; avg: number };
  statusCounts: Record<string, number>;
  errors: { message: string; count: number }[];
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx]!;
}

export async function runLoadTest(input: LoadTestInput): Promise<LoadTestResult> {
  const ep = input.endpoint;
  const method = (ep.method || 'GET').toUpperCase();
  if (isWriteMethod(method) && !input.allowWrites) {
    throw new Error(`Load-testing a ${method} endpoint repeats a write many times. Re-run with writes explicitly allowed if that is safe against this environment.`);
  }
  const total = clampInt(input.totalRequests, 50, 1, 500);
  const concurrency = clampInt(input.concurrency, 10, 1, 50);
  const { url, init } = buildRequestInit(ep);

  const latencies: number[] = [];
  const statusCounts: Record<string, number> = {};
  const errorMap = new Map<string, number>();
  let completed = 0;
  let failed = 0;
  let non2xx = 0;
  let dispatched = 0;

  const started = Date.now();
  async function worker(): Promise<void> {
    while (dispatched < total) {
      dispatched++;
      const r = await timedFetch(url, init);
      if (r.error) {
        failed++;
        const key = r.error.slice(0, 120);
        errorMap.set(key, (errorMap.get(key) || 0) + 1);
      } else {
        completed++;
        latencies.push(r.elapsedMs);
        const bucket = r.status !== undefined ? String(r.status) : 'unknown';
        statusCounts[bucket] = (statusCounts[bucket] || 0) + 1;
        if (!r.ok) non2xx++;
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, total) }, worker));
  const durationMs = Date.now() - started;

  latencies.sort((a, b) => a - b);
  const avg = latencies.length ? +(latencies.reduce((a, b) => a + b, 0) / latencies.length).toFixed(1) : 0;

  return {
    url,
    method,
    totalRequests: total,
    concurrency,
    durationMs,
    completed,
    failed,
    non2xx,
    throughputRps: durationMs > 0 ? +(completed / (durationMs / 1000)).toFixed(2) : 0,
    latency: {
      min: latencies[0] || 0,
      p50: percentile(latencies, 50),
      p90: percentile(latencies, 90),
      p95: percentile(latencies, 95),
      p99: percentile(latencies, 99),
      max: latencies[latencies.length - 1] || 0,
      avg,
    },
    statusCounts,
    errors: [...errorMap.entries()].map(([message, count]) => ({ message, count })).sort((a, b) => b.count - a.count).slice(0, 8),
  };
}
