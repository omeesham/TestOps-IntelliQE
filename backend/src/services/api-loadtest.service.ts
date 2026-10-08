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

/** Latency percentile block from an unsorted sample. */
function summarizeLatency(latencies: number[]): LoadTestResult['latency'] {
  const s = [...latencies].sort((a, b) => a - b);
  const avg = s.length ? +(s.reduce((a, b) => a + b, 0) / s.length).toFixed(1) : 0;
  return { min: s[0] || 0, p50: percentile(s, 50), p90: percentile(s, 90), p95: percentile(s, 95), p99: percentile(s, 99), max: s[s.length - 1] || 0, avg };
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

/* ────────────────────────────────────────────────────────────────
   Staged load profile + SLA gating
   A time-boxed, multi-stage load run: each stage holds a concurrency for a
   duration (ramp-up by increasing concurrency across stages). Latency,
   throughput and error rate are aggregated per stage and overall, then
   checked against optional SLA thresholds so a run can *fail a gate* (e.g.
   p95 < 400ms, error rate < 1%). Additive and standalone — it reuses only
   the HTTP helper and never touches the pipeline. runLoadTest is unchanged.
   ──────────────────────────────────────────────────────────────── */

const MAX_STAGES = 10;
const MAX_STAGE_CONCURRENCY = 50;
const MAX_STAGE_SEC = 60;
const MAX_TOTAL_SEC = 120;
const HARD_REQUEST_CAP = 50_000;

export interface LoadStageInput { durationSec: number; concurrency: number }
export interface SlaThresholds { p95Ms?: number; p99Ms?: number; maxErrorRatePct?: number; minThroughputRps?: number }
export interface LoadProfileInput {
  endpoint: HttpEndpoint;
  stages: LoadStageInput[];
  sla?: SlaThresholds;
  /** Required to load-test a write method (POST/PUT/PATCH/DELETE). */
  allowWrites?: boolean;
}

export interface LoadStageResult {
  index: number;
  concurrency: number;
  durationMs: number;
  completed: number;
  failed: number;
  non2xx: number;
  throughputRps: number;
  latency: LoadTestResult['latency'];
}
export interface SlaCheck { name: string; limit: number; actual: number; unit: string; pass: boolean }
export interface LoadProfileResult {
  url: string;
  method: string;
  stages: LoadStageResult[];
  totals: {
    completed: number; failed: number; non2xx: number; durationMs: number;
    throughputRps: number; errorRatePct: number; latency: LoadTestResult['latency'];
  };
  statusCounts: Record<string, number>;
  errors: { message: string; count: number }[];
  sla: { pass: boolean; checks: SlaCheck[] } | null;
}

/** Normalise + clamp a requested profile into something safe to execute. */
function sanitizeStages(raw: unknown): LoadStageInput[] {
  const arr = Array.isArray(raw) ? raw : [];
  const stages: LoadStageInput[] = [];
  let budget = MAX_TOTAL_SEC;
  for (const s of arr.slice(0, MAX_STAGES)) {
    const concurrency = clampInt((s as any)?.concurrency, 10, 1, MAX_STAGE_CONCURRENCY);
    let durationSec = clampInt((s as any)?.durationSec, 10, 1, MAX_STAGE_SEC);
    if (budget <= 0) break;
    durationSec = Math.min(durationSec, budget);
    budget -= durationSec;
    stages.push({ concurrency, durationSec });
  }
  if (!stages.length) stages.push({ concurrency: 10, durationSec: 10 });
  return stages;
}

export async function runLoadProfile(input: LoadProfileInput): Promise<LoadProfileResult> {
  const ep = input.endpoint;
  const method = (ep.method || 'GET').toUpperCase();
  if (isWriteMethod(method) && !input.allowWrites) {
    throw new Error(`Load-testing a ${method} endpoint repeats a write many times. Re-run with writes explicitly allowed if that is safe against this environment.`);
  }
  const stages = sanitizeStages(input.stages);
  const { url, init } = buildRequestInit(ep);

  const statusCounts: Record<string, number> = {};
  const errorMap = new Map<string, number>();
  const allLatencies: number[] = [];
  let gCompleted = 0; let gFailed = 0; let gNon2xx = 0; let gDispatched = 0;
  const stageResults: LoadStageResult[] = [];
  const runStarted = Date.now();

  for (let i = 0; i < stages.length; i++) {
    const stage = stages[i]!;
    const deadline = Date.now() + stage.durationSec * 1000;
    const latencies: number[] = [];
    let completed = 0; let failed = 0; let non2xx = 0;
    const stageStarted = Date.now();

    async function worker(): Promise<void> {
      while (Date.now() < deadline && gDispatched < HARD_REQUEST_CAP) {
        gDispatched++;
        const r = await timedFetch(url, init);
        if (r.error) {
          failed++; gFailed++;
          const key = r.error.slice(0, 120);
          errorMap.set(key, (errorMap.get(key) || 0) + 1);
        } else {
          completed++; gCompleted++;
          latencies.push(r.elapsedMs); allLatencies.push(r.elapsedMs);
          const bucket = r.status !== undefined ? String(r.status) : 'unknown';
          statusCounts[bucket] = (statusCounts[bucket] || 0) + 1;
          if (!r.ok) { non2xx++; gNon2xx++; }
        }
      }
    }
    await Promise.all(Array.from({ length: stage.concurrency }, worker));
    const durationMs = Date.now() - stageStarted;
    stageResults.push({
      index: i,
      concurrency: stage.concurrency,
      durationMs,
      completed,
      failed,
      non2xx,
      throughputRps: durationMs > 0 ? +(completed / (durationMs / 1000)).toFixed(2) : 0,
      latency: summarizeLatency(latencies),
    });
  }

  const totalDuration = Date.now() - runStarted;
  const totalReq = gCompleted + gFailed;
  const errorRatePct = totalReq > 0 ? +(((gFailed + gNon2xx) / totalReq) * 100).toFixed(2) : 0;
  const latency = summarizeLatency(allLatencies);
  const throughputRps = totalDuration > 0 ? +(gCompleted / (totalDuration / 1000)).toFixed(2) : 0;

  // SLA gate — only the thresholds the caller set are checked.
  let sla: LoadProfileResult['sla'] = null;
  const t = input.sla;
  if (t && (t.p95Ms || t.p99Ms || t.maxErrorRatePct != null || t.minThroughputRps)) {
    const checks: SlaCheck[] = [];
    if (t.p95Ms) checks.push({ name: 'p95 latency', limit: t.p95Ms, actual: latency.p95, unit: 'ms', pass: latency.p95 <= t.p95Ms });
    if (t.p99Ms) checks.push({ name: 'p99 latency', limit: t.p99Ms, actual: latency.p99, unit: 'ms', pass: latency.p99 <= t.p99Ms });
    if (t.maxErrorRatePct != null) checks.push({ name: 'error rate', limit: t.maxErrorRatePct, actual: errorRatePct, unit: '%', pass: errorRatePct <= t.maxErrorRatePct });
    if (t.minThroughputRps) checks.push({ name: 'throughput', limit: t.minThroughputRps, actual: throughputRps, unit: 'rps', pass: throughputRps >= t.minThroughputRps });
    sla = { pass: checks.every((c) => c.pass), checks };
  }

  return {
    url,
    method,
    stages: stageResults,
    totals: { completed: gCompleted, failed: gFailed, non2xx: gNon2xx, durationMs: totalDuration, throughputRps, errorRatePct, latency },
    statusCounts,
    errors: [...errorMap.entries()].map(([message, count]) => ({ message, count })).sort((a, b) => b.count - a.count).slice(0, 8),
    sla,
  };
}
