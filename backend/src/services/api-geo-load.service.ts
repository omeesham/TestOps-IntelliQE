/**
 * api-geo-load.service.ts
 * ───────────────────────
 * Distributed / multi-region load generation. Fires load at one endpoint from
 * several labelled "regions" at once, each with its own concurrency, optional
 * egress proxy (so traffic really originates elsewhere) and optional simulated
 * added latency. Reports per-region AND aggregate latency/throughput/errors with
 * an SLA gate. Enterprise load tools run from multiple geos; this brings the same
 * shape to IntelliQE, and scales to real datacenters by pointing each region at a
 * regional forward-proxy.
 *
 * Standalone and opt-in: runLoadTest / runLoadProfile are untouched; this reuses
 * only the shared HTTP request builder. Write methods are refused unless allowed.
 */
import { buildRequestInit, isWriteMethod, clampInt, type HttpEndpoint } from '../utils/api-http.js';

export interface GeoRegionInput {
  name: string;
  concurrency?: number;
  /** Optional forward proxy URL so this region's traffic egresses elsewhere (http(s) proxy). */
  proxyUrl?: string;
  /** Optional simulated added latency per request (ms) to model a distant region. */
  addedLatencyMs?: number;
}

export interface GeoLoadInput {
  endpoint: HttpEndpoint;
  regions: GeoRegionInput[];
  durationSec?: number;
  sla?: { p95Ms?: number; p99Ms?: number; maxErrorRatePct?: number; minThroughputRps?: number };
  allowWrites?: boolean;
}

interface Latency { min: number; p50: number; p90: number; p95: number; p99: number; max: number; avg: number }

export interface GeoRegionResult {
  name: string;
  concurrency: number;
  proxied: boolean;
  addedLatencyMs: number;
  completed: number;
  failed: number;
  non2xx: number;
  throughputRps: number;
  latency: Latency;
}

export interface GeoLoadResult {
  url: string;
  method: string;
  durationMs: number;
  regions: GeoRegionResult[];
  totals: { completed: number; failed: number; non2xx: number; throughputRps: number; errorRatePct: number; latency: Latency };
  statusCounts: Record<string, number>;
  errors: { message: string; count: number }[];
  sla: { pass: boolean; checks: { name: string; limit: number; actual: number; unit: string; pass: boolean }[] } | null;
  notes: string[];
}

const MAX_REGIONS = 8;
const MAX_CONC = 50;
const MAX_DURATION_SEC = 60;

function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]!;
}
function summarize(latencies: number[]): Latency {
  const s = [...latencies].sort((a, b) => a - b);
  const avg = s.length ? +(s.reduce((a, b) => a + b, 0) / s.length).toFixed(1) : 0;
  return { min: s[0] || 0, p50: percentile(s, 50), p90: percentile(s, 90), p95: percentile(s, 95), p99: percentile(s, 99), max: s[s.length - 1] || 0, avg };
}

/** Build an undici ProxyAgent dispatcher if a proxy is requested AND undici is available. */
async function proxyDispatcher(proxyUrl: string | undefined): Promise<any | undefined> {
  if (!proxyUrl) return undefined;
  try {
    // Non-literal specifier → stays `any` and is never statically resolved, so a
    // build without undici still type-checks (Node 18+ bundles it at runtime).
    const spec = 'undici';
    const undici: any = await import(spec);
    return new undici.ProxyAgent(proxyUrl);
  } catch { return undefined; }
}

export async function runGeoLoad(input: GeoLoadInput): Promise<GeoLoadResult> {
  const ep = input.endpoint;
  const method = (ep.method || 'GET').toUpperCase();
  if (isWriteMethod(method) && !input.allowWrites) {
    throw new Error(`Load-testing a ${method} endpoint repeats a write many times. Re-run with writes explicitly allowed if that is safe against this environment.`);
  }
  const regionsIn = (Array.isArray(input.regions) ? input.regions : []).slice(0, MAX_REGIONS);
  if (!regionsIn.length) throw new Error('Add at least one region.');
  const durationSec = clampInt(input.durationSec, 15, 1, MAX_DURATION_SEC);
  const { url, init } = buildRequestInit(ep);
  const notes: string[] = [];

  const statusCounts: Record<string, number> = {};
  const errorMap = new Map<string, number>();
  const allLatencies: number[] = [];
  const runStarted = Date.now();
  const deadline = Date.now() + durationSec * 1000;

  async function runRegion(r: GeoRegionInput): Promise<GeoRegionResult> {
    const concurrency = clampInt(r.concurrency, 10, 1, MAX_CONC);
    const added = clampInt(r.addedLatencyMs, 0, 0, 5000);
    const dispatcher = await proxyDispatcher(r.proxyUrl);
    const proxied = !!dispatcher;
    if (r.proxyUrl && !proxied) notes.push(`Region "${r.name}": proxy ignored (undici not available) — ran direct.`);
    const latencies: number[] = [];
    let completed = 0; let failed = 0; let non2xx = 0;

    async function worker(): Promise<void> {
      while (Date.now() < deadline) {
        if (added) await new Promise((res) => setTimeout(res, added));
        const started = Date.now();
        try {
          const reqInit: any = { ...init, redirect: 'follow', signal: AbortSignal.timeout(15_000) };
          if (dispatcher) reqInit.dispatcher = dispatcher;
          const res = await fetch(url, reqInit);
          try { await res.arrayBuffer(); } catch { /* drain */ }
          const elapsed = Date.now() - started;
          completed++;
          latencies.push(elapsed); allLatencies.push(elapsed);
          const bucket = String(res.status);
          statusCounts[bucket] = (statusCounts[bucket] || 0) + 1;
          if (!res.ok) non2xx++;
        } catch (e) {
          failed++;
          const key = ((e as Error).message || String(e)).slice(0, 120);
          errorMap.set(key, (errorMap.get(key) || 0) + 1);
        }
      }
    }
    const regionStarted = Date.now();
    await Promise.all(Array.from({ length: concurrency }, worker));
    const regionMs = Date.now() - regionStarted;
    try { dispatcher?.close?.(); } catch { /* ignore */ }
    return {
      name: String(r.name || 'region').slice(0, 60),
      concurrency,
      proxied,
      addedLatencyMs: added,
      completed,
      failed,
      non2xx,
      throughputRps: regionMs > 0 ? +(completed / (regionMs / 1000)).toFixed(2) : 0,
      latency: summarize(latencies),
    };
  }

  const regions = await Promise.all(regionsIn.map(runRegion));
  const durationMs = Date.now() - runStarted;

  const gCompleted = regions.reduce((a, r) => a + r.completed, 0);
  const gFailed = regions.reduce((a, r) => a + r.failed, 0);
  const gNon2xx = regions.reduce((a, r) => a + r.non2xx, 0);
  const totalReq = gCompleted + gFailed;
  const errorRatePct = totalReq > 0 ? +(((gFailed + gNon2xx) / totalReq) * 100).toFixed(2) : 0;
  const throughputRps = durationMs > 0 ? +(gCompleted / (durationMs / 1000)).toFixed(2) : 0;
  const latency = summarize(allLatencies);

  let sla: GeoLoadResult['sla'] = null;
  const t = input.sla;
  if (t && (t.p95Ms || t.p99Ms || t.maxErrorRatePct != null || t.minThroughputRps)) {
    const checks: NonNullable<GeoLoadResult['sla']>['checks'] = [];
    if (t.p95Ms) checks.push({ name: 'p95 latency', limit: t.p95Ms, actual: latency.p95, unit: 'ms', pass: latency.p95 <= t.p95Ms });
    if (t.p99Ms) checks.push({ name: 'p99 latency', limit: t.p99Ms, actual: latency.p99, unit: 'ms', pass: latency.p99 <= t.p99Ms });
    if (t.maxErrorRatePct != null) checks.push({ name: 'error rate', limit: t.maxErrorRatePct, actual: errorRatePct, unit: '%', pass: errorRatePct <= t.maxErrorRatePct });
    if (t.minThroughputRps) checks.push({ name: 'throughput', limit: t.minThroughputRps, actual: throughputRps, unit: 'rps', pass: throughputRps >= t.minThroughputRps });
    sla = { pass: checks.every((c) => c.pass), checks };
  }

  return {
    url,
    method,
    durationMs,
    regions,
    totals: { completed: gCompleted, failed: gFailed, non2xx: gNon2xx, throughputRps, errorRatePct, latency },
    statusCounts,
    errors: [...errorMap.entries()].map(([message, count]) => ({ message, count })).sort((a, b) => b.count - a.count).slice(0, 8),
    sla,
    notes,
  };
}
