/**
 * api-cloud-load.service.ts
 * ─────────────────────────
 * Cloud-scale distributed load. Fans a load run out across registered remote
 * "load agents" (lightweight workers the user deploys in other regions/clouds),
 * aggregating their results — so throughput isn't capped by this one node. Each
 * agent is a tiny HTTP endpoint that accepts a load spec and returns stats.
 * With no agents configured it falls back to a bounded LOCAL burst, so the tool
 * always works.
 *
 * Agent contract (documented in the UI):
 *   POST {agentUrl}  { endpoint, concurrency, durationSec, allowWrites }
 *   → { completed, failed, non2xx, throughputRps, latency:{p50,p95,p99,avg,max} }
 *
 * Standalone and opt-in: its own table; the pipeline is never involved.
 */
import pool from '../db.js';
import { buildRequestInit, isWriteMethod, clampInt, type HttpEndpoint } from '../utils/api-http.js';

export interface LoadAgent { id: string; name: string; url: string; region: string; enabled: boolean; createdAt: string }

function mapAgent(r: any): LoadAgent {
  return { id: String(r.id), name: r.name, url: r.url, region: r.region || '', enabled: r.enabled === true || r.enabled === 1, createdAt: r.created_at };
}

export async function listLoadAgents(tenantId: string): Promise<LoadAgent[]> {
  const { rows } = await pool.query(`SELECT * FROM api_load_agents WHERE tenant_id = $1 ORDER BY created_at DESC`, [tenantId]);
  return rows.map(mapAgent);
}
export async function saveLoadAgent(tenantId: string, input: { id?: string; name?: string; url: string; region?: string; enabled?: boolean }): Promise<LoadAgent> {
  if (!/^https?:\/\//i.test(input.url || '')) throw new Error('Agent url must be an absolute http(s) URL.');
  const name = String(input.name || '').trim().slice(0, 200) || input.region || 'agent';
  const region = String(input.region || '').slice(0, 80);
  const enabled = input.enabled === false ? 0 : 1;
  if (input.id) {
    const { rows } = await pool.query(`UPDATE api_load_agents SET name = $3, url = $4, region = $5, enabled = $6, updated_at = SYSUTCDATETIME() OUTPUT INSERTED.* WHERE tenant_id = $1 AND id = $2`, [tenantId, input.id, name, input.url, region, enabled]);
    if (!rows.length) throw new Error('Agent not found.');
    return mapAgent(rows[0]);
  }
  const { rows } = await pool.query(`INSERT INTO api_load_agents (tenant_id, name, url, region, enabled) OUTPUT INSERTED.* VALUES ($1, $2, $3, $4, $5)`, [tenantId, name, input.url, region, enabled]);
  return mapAgent(rows[0]);
}
export async function deleteLoadAgent(tenantId: string, id: string): Promise<boolean> {
  const { rowCount } = await pool.query(`DELETE FROM api_load_agents WHERE tenant_id = $1 AND id = $2`, [tenantId, id]);
  return rowCount > 0;
}

interface Latency { min: number; p50: number; p90: number; p95: number; p99: number; max: number; avg: number }
function percentile(s: number[], p: number): number { return s.length ? s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]! : 0; }
function summarize(l: number[]): Latency {
  const s = [...l].sort((a, b) => a - b);
  return { min: s[0] || 0, p50: percentile(s, 50), p90: percentile(s, 90), p95: percentile(s, 95), p99: percentile(s, 99), max: s[s.length - 1] || 0, avg: s.length ? +(s.reduce((a, b) => a + b, 0) / s.length).toFixed(1) : 0 };
}

export interface CloudLoadInput {
  endpoint: HttpEndpoint;
  durationSec?: number;
  concurrencyPerAgent?: number;
  allowWrites?: boolean;
  sla?: { p95Ms?: number; maxErrorRatePct?: number; minThroughputRps?: number };
}
export interface CloudNodeResult { node: string; region: string; remote: boolean; completed: number; failed: number; non2xx: number; throughputRps: number; latency: Latency; error?: string }
export interface CloudLoadResult {
  url: string; method: string; durationMs: number;
  nodes: CloudNodeResult[];
  totals: { completed: number; failed: number; non2xx: number; throughputRps: number; errorRatePct: number; latency: Latency };
  sla: { pass: boolean; checks: { name: string; limit: number; actual: number; unit: string; pass: boolean }[] } | null;
  note: string;
}

/** Local bounded burst — the fallback node when no remote agents are configured. */
async function localBurst(ep: HttpEndpoint, durationSec: number, concurrency: number): Promise<CloudNodeResult> {
  const { url, init } = buildRequestInit(ep);
  const deadline = Date.now() + durationSec * 1000;
  const latencies: number[] = [];
  let completed = 0, failed = 0, non2xx = 0;
  const started = Date.now();
  const worker = async () => {
    while (Date.now() < deadline) {
      const t = Date.now();
      try {
        const res = await fetch(url, { ...init, redirect: 'follow', signal: AbortSignal.timeout(15000) });
        try { await res.arrayBuffer(); } catch { /* drain */ }
        completed++; latencies.push(Date.now() - t); if (!res.ok) non2xx++;
      } catch { failed++; }
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
  const ms = Date.now() - started;
  return { node: 'local', region: 'this-node', remote: false, completed, failed, non2xx, throughputRps: ms > 0 ? +(completed / (ms / 1000)).toFixed(2) : 0, latency: summarize(latencies) };
}

async function callAgent(agent: LoadAgent, spec: unknown): Promise<CloudNodeResult> {
  try {
    const res = await fetch(agent.url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(spec), signal: AbortSignal.timeout(180_000) });
    if (!res.ok) throw new Error(`agent HTTP ${res.status}`);
    const d: any = await res.json();
    return {
      node: agent.name, region: agent.region || d.region || '', remote: true,
      completed: Number(d.completed) || 0, failed: Number(d.failed) || 0, non2xx: Number(d.non2xx) || 0,
      throughputRps: Number(d.throughputRps) || 0,
      latency: d.latency && typeof d.latency === 'object' ? { min: +d.latency.min || 0, p50: +d.latency.p50 || 0, p90: +d.latency.p90 || 0, p95: +d.latency.p95 || 0, p99: +d.latency.p99 || 0, max: +d.latency.max || 0, avg: +d.latency.avg || 0 } : summarize([]),
    };
  } catch (e) {
    return { node: agent.name, region: agent.region || '', remote: true, completed: 0, failed: 0, non2xx: 0, throughputRps: 0, latency: summarize([]), error: (e as Error).message };
  }
}

export async function runCloudLoad(tenantId: string, input: CloudLoadInput): Promise<CloudLoadResult> {
  const ep = input.endpoint;
  const method = (ep.method || 'GET').toUpperCase();
  if (isWriteMethod(method) && !input.allowWrites) throw new Error(`Load-testing a ${method} endpoint repeats a write many times. Allow writes explicitly if that is safe.`);
  const durationSec = clampInt(input.durationSec, 20, 1, 120);
  const concurrency = clampInt(input.concurrencyPerAgent, 20, 1, 200);
  const agents = (await listLoadAgents(tenantId)).filter((a) => a.enabled);

  const started = Date.now();
  let nodes: CloudNodeResult[];
  let note: string;
  if (agents.length) {
    const spec = { endpoint: ep, concurrency, durationSec, allowWrites: !!input.allowWrites };
    nodes = await Promise.all(agents.map((a) => callAgent(a, spec)));
    note = `Fanned out across ${agents.length} remote agent${agents.length === 1 ? '' : 's'}.`;
  } else {
    nodes = [await localBurst(ep, durationSec, concurrency)];
    note = 'No remote load agents configured — ran a single local burst. Register agents in other regions to scale out.';
  }
  const durationMs = Date.now() - started;

  const completed = nodes.reduce((a, n) => a + n.completed, 0);
  const failed = nodes.reduce((a, n) => a + n.failed, 0);
  const non2xx = nodes.reduce((a, n) => a + n.non2xx, 0);
  const total = completed + failed;
  const errorRatePct = total > 0 ? +(((failed + non2xx) / total) * 100).toFixed(2) : 0;
  const throughputRps = nodes.reduce((a, n) => a + n.throughputRps, 0);
  // Aggregate latency as the worst p95/p99 across nodes (a conservative view).
  const agg: Latency = {
    min: Math.min(...nodes.map((n) => n.latency.min || Infinity)) || 0,
    p50: Math.max(...nodes.map((n) => n.latency.p50)),
    p90: Math.max(...nodes.map((n) => n.latency.p90)),
    p95: Math.max(...nodes.map((n) => n.latency.p95)),
    p99: Math.max(...nodes.map((n) => n.latency.p99)),
    max: Math.max(...nodes.map((n) => n.latency.max)),
    avg: +(nodes.reduce((a, n) => a + n.latency.avg, 0) / Math.max(1, nodes.length)).toFixed(1),
  };

  let sla: CloudLoadResult['sla'] = null;
  const t = input.sla;
  if (t && (t.p95Ms || t.maxErrorRatePct != null || t.minThroughputRps)) {
    const checks: NonNullable<CloudLoadResult['sla']>['checks'] = [];
    if (t.p95Ms) checks.push({ name: 'p95 latency', limit: t.p95Ms, actual: agg.p95, unit: 'ms', pass: agg.p95 <= t.p95Ms });
    if (t.maxErrorRatePct != null) checks.push({ name: 'error rate', limit: t.maxErrorRatePct, actual: errorRatePct, unit: '%', pass: errorRatePct <= t.maxErrorRatePct });
    if (t.minThroughputRps) checks.push({ name: 'throughput', limit: t.minThroughputRps, actual: throughputRps, unit: 'rps', pass: throughputRps >= t.minThroughputRps });
    sla = { pass: checks.every((c) => c.pass), checks };
  }

  return { url: buildRequestInit(ep).url, method, durationMs, nodes, totals: { completed, failed, non2xx, throughputRps, errorRatePct, latency: agg }, sla, note };
}
