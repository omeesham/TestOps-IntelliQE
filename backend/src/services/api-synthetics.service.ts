/**
 * api-synthetics.service.ts
 * ─────────────────────────
 * Synthetic monitoring + observability correlation (Datadog / Checkly parity) — the
 * depth on top of the existing read-only health/drift/coverage monitor:
 *
 *   • Scheduled synthetic checks from MULTIPLE locations — each location can route
 *     egress through its own proxy (undici ProxyAgent), so one monitor measures the
 *     API from several global / private vantage points and reports per-location
 *     latency and reachability.
 *   • Observability / trace correlation — every check carries a W3C traceparent +
 *     correlation id, and when a tracing backend (Jaeger/Zipkin/Tempo) is attached
 *     the resulting distributed trace is pulled back and summarised (reuses the
 *     trace probe).
 *   • Canary + auto-rollback SIGNAL — compare the monitored (canary) endpoint to a
 *     stable baseline; when error-rate / latency thresholds are breached, mark the
 *     run "rollback" and POST a rollback signal to a configured webhook. It only
 *     SIGNALS — it never touches infrastructure itself.
 *
 * Its own opt-in poller (`startApiSynthetics`), separate from and additive to the
 * existing monitor. Checks are GET/HEAD only (read-only, like uptime checks). The
 * generate → execute → heal pipeline is never involved.
 */
import pool from '../db.js';
import { buildHeaders, fetchFull, type HttpEndpoint } from '../utils/api-http.js';
import { runTraceProbe, type TracingBackend } from './api-trace.service.js';

const POLL_MS = 60_000;
const MAX_RESULTS_KEPT = 300;
const MAX_LOCATIONS = 8;
const CHECK_TIMEOUT_MS = 20_000;
let started = false;

export interface SyntheticLocation { name: string; proxyUrl?: string }
export interface SyntheticEndpointInput extends HttpEndpoint { expectedStatus?: number; assertText?: string }
export interface CanaryConfig {
  baselineUrl?: string;
  maxErrorRatePct?: number;     // breach when canary error rate exceeds this
  maxLatencyMs?: number;        // breach when canary avg latency exceeds this
  maxLatencyDeltaPct?: number;  // breach when canary is this % slower than baseline
  rollbackWebhookUrl?: string;  // where to POST the rollback SIGNAL (never touches infra)
}
export interface TracingConfig { type: TracingBackend; queryUrl: string }

export interface SyntheticMonitor {
  id: string;
  name: string;
  enabled: boolean;
  intervalMinutes: number;
  endpoint: SyntheticEndpointInput;
  locations: SyntheticLocation[];
  tracing?: TracingConfig | null;
  canary?: CanaryConfig | null;
  nextRunAt?: string;
  lastRunAt?: string;
  lastStatus?: string;
  createdBy?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface LocationResult { location: string; proxied: boolean; ok: boolean; status?: number; elapsedMs: number; assertPassed?: boolean; error?: string }
export interface CanaryVerdict {
  evaluated: boolean;
  healthy: boolean;
  reasons: string[];
  canary: { errorRatePct: number; latencyMs: number };
  baseline?: { ok: boolean; status?: number; latencyMs: number; error?: string };
  rollbackSignalled: boolean;
}
export interface TraceSummary { traceId: string; correlationId: string; backend?: string; spanCount: number; note?: string; assertions?: { name: string; pass: boolean; detail?: string }[] }
export type SyntheticStatus = 'up' | 'degraded' | 'down' | 'rollback';
export interface SyntheticResult {
  id: string;
  monitorId: string;
  status: SyntheticStatus;
  locations: LocationResult[];
  canary?: CanaryVerdict | null;
  trace?: TraceSummary | null;
  summary: string;
  createdAt: string;
}

/* ── JSON coercion (these column names aren't on the db.ts allowlist) ── */
function jArr(v: any): any[] { if (Array.isArray(v)) return v; if (typeof v === 'string' && v.trim().startsWith('[')) { try { const p = JSON.parse(v); if (Array.isArray(p)) return p; } catch { /* empty */ } } return []; }
function jObj(v: any): any { if (v && typeof v === 'object' && !Array.isArray(v)) return v; if (typeof v === 'string' && v.trim().startsWith('{')) { try { const p = JSON.parse(v); if (p && typeof p === 'object') return p; } catch { /* empty */ } } return {}; }

/** undici ProxyAgent, only when a proxy is requested AND undici is installed. */
async function proxyDispatcher(proxyUrl?: string): Promise<any> {
  if (!proxyUrl || !/^https?:\/\//i.test(proxyUrl)) return null;
  try { const spec = 'undici'; const undici: any = await import(spec); return new undici.ProxyAgent(proxyUrl); }
  catch { return null; }
}

function normalizeEndpoint(raw: any): SyntheticEndpointInput {
  const url = String(raw?.url || '').trim();
  if (!/^https?:\/\//i.test(url)) throw new Error('Provide an endpoint with an http(s) URL.');
  // Synthetic checks are read-only: coerce writes to GET.
  let method = String(raw?.method || 'GET').toUpperCase().replace(/[^A-Z]/g, '') || 'GET';
  if (!['GET', 'HEAD'].includes(method)) method = 'GET';
  return {
    method, url: url.slice(0, 4000),
    headers: Array.isArray(raw?.headers) ? raw.headers.filter((h: any) => h?.key).slice(0, 30).map((h: any) => ({ key: String(h.key).slice(0, 200), value: String(h.value ?? '').slice(0, 2000) })) : [],
    auth: raw?.auth && typeof raw.auth === 'object' ? { type: String(raw.auth.type || 'none'), value: raw.auth.value ? String(raw.auth.value) : undefined, headerName: raw.auth.headerName ? String(raw.auth.headerName) : undefined } : undefined,
    expectedStatus: Number.isInteger(Number(raw?.expectedStatus)) ? Number(raw.expectedStatus) : undefined,
    assertText: raw?.assertText ? String(raw.assertText).slice(0, 400) : undefined,
  };
}

function normalizeLocations(raw: any): SyntheticLocation[] {
  const arr = Array.isArray(raw) ? raw : [];
  const out: SyntheticLocation[] = [];
  for (const l of arr.slice(0, MAX_LOCATIONS)) {
    const name = String(l?.name || '').trim().slice(0, 60);
    if (!name) continue;
    out.push({ name, proxyUrl: l?.proxyUrl && /^https?:\/\//i.test(String(l.proxyUrl)) ? String(l.proxyUrl).slice(0, 2000) : undefined });
  }
  return out.length ? out : [{ name: 'default' }];
}

function normalizeCanary(raw: any): CanaryConfig | null {
  if (!raw || typeof raw !== 'object') return null;
  const c: CanaryConfig = {
    baselineUrl: raw.baselineUrl && /^https?:\/\//i.test(String(raw.baselineUrl)) ? String(raw.baselineUrl).slice(0, 4000) : undefined,
    maxErrorRatePct: Number.isFinite(Number(raw.maxErrorRatePct)) ? Math.max(0, Math.min(100, Number(raw.maxErrorRatePct))) : undefined,
    maxLatencyMs: Number.isFinite(Number(raw.maxLatencyMs)) ? Math.max(0, Number(raw.maxLatencyMs)) : undefined,
    maxLatencyDeltaPct: Number.isFinite(Number(raw.maxLatencyDeltaPct)) ? Math.max(0, Number(raw.maxLatencyDeltaPct)) : undefined,
    rollbackWebhookUrl: raw.rollbackWebhookUrl && /^https?:\/\//i.test(String(raw.rollbackWebhookUrl)) ? String(raw.rollbackWebhookUrl).slice(0, 2000) : undefined,
  };
  const any = c.baselineUrl || c.maxErrorRatePct != null || c.maxLatencyMs != null || c.maxLatencyDeltaPct != null;
  return any ? c : null;
}

function normalizeTracing(raw: any): TracingConfig | null {
  if (!raw || typeof raw !== 'object') return null;
  const type = ['jaeger', 'zipkin', 'tempo'].includes(String(raw.type)) ? (raw.type as TracingBackend) : null;
  const queryUrl = raw.queryUrl && /^https?:\/\//i.test(String(raw.queryUrl)) ? String(raw.queryUrl).slice(0, 2000) : '';
  return type && queryUrl ? { type, queryUrl } : null;
}

function rowToMonitor(r: any): SyntheticMonitor {
  return {
    id: String(r.id), name: r.name, enabled: !!r.enabled, intervalMinutes: Number(r.interval_minutes) || 15,
    endpoint: jObj(r.endpoint) as SyntheticEndpointInput,
    locations: jArr(r.locations) as SyntheticLocation[],
    tracing: r.tracing ? (jObj(r.tracing) as TracingConfig) : null,
    canary: r.canary ? (jObj(r.canary) as CanaryConfig) : null,
    nextRunAt: r.next_run_at || undefined, lastRunAt: r.last_run_at || undefined, lastStatus: r.last_status || undefined,
    createdBy: r.created_by || undefined, createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

/* ── CRUD ── */

export async function listSyntheticMonitors(tenantId: string): Promise<SyntheticMonitor[]> {
  const { rows } = await pool.query(`SELECT * FROM api_synthetic_monitors WHERE tenant_id = $1 ORDER BY updated_at DESC`, [tenantId]);
  return rows.map(rowToMonitor);
}

export async function saveSyntheticMonitor(tenantId: string, username: string, input: any): Promise<SyntheticMonitor> {
  const name = String(input?.name || '').trim().slice(0, 200);
  if (!name) throw new Error('Provide a monitor name.');
  const endpoint = normalizeEndpoint(input?.endpoint);
  const locations = normalizeLocations(input?.locations);
  const canary = normalizeCanary(input?.canary);
  const tracing = normalizeTracing(input?.tracing);
  const intervalMinutes = Math.min(1440, Math.max(1, Math.floor(Number(input?.intervalMinutes) || 15)));
  const enabled = !!input?.enabled;
  const nextRunAt = enabled ? new Date().toISOString() : null; // run on the next tick when enabled
  const id = input?.id ? String(input.id) : '';

  if (id) {
    const { rows } = await pool.query(
      `UPDATE api_synthetic_monitors
         SET name = $3, enabled = $4, interval_minutes = $5, endpoint = $6, locations = $7, tracing = $8, canary = $9,
             next_run_at = CASE WHEN $4 = 1 AND next_run_at IS NULL THEN SYSUTCDATETIME() ELSE (CASE WHEN $4 = 0 THEN NULL ELSE next_run_at END) END,
             updated_at = SYSUTCDATETIME()
       OUTPUT INSERTED.*
       WHERE tenant_id = $1 AND id = $2`,
      [tenantId, id, name, enabled, intervalMinutes, endpoint, locations, tracing, canary],
    );
    if (rows[0]) return rowToMonitor(rows[0]);
  }
  const { rows } = await pool.query(
    `INSERT INTO api_synthetic_monitors (tenant_id, name, enabled, interval_minutes, endpoint, locations, tracing, canary, next_run_at, created_by)
     OUTPUT INSERTED.*
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [tenantId, name, enabled, intervalMinutes, endpoint, locations, tracing, canary, nextRunAt, username],
  );
  return rowToMonitor(rows[0]);
}

export async function setSyntheticEnabled(tenantId: string, id: string, enabled: boolean): Promise<SyntheticMonitor | null> {
  const { rows } = await pool.query(
    `UPDATE api_synthetic_monitors SET enabled = $3, next_run_at = CASE WHEN $3 = 1 THEN SYSUTCDATETIME() ELSE NULL END, updated_at = SYSUTCDATETIME()
     OUTPUT INSERTED.* WHERE tenant_id = $1 AND id = $2`,
    [tenantId, id, !!enabled],
  );
  return rows[0] ? rowToMonitor(rows[0]) : null;
}

export async function deleteSyntheticMonitor(tenantId: string, id: string): Promise<boolean> {
  await pool.query(`DELETE FROM api_synthetic_results WHERE tenant_id = $1 AND monitor_id = $2`, [tenantId, id]);
  const { rowCount } = await pool.query(`DELETE FROM api_synthetic_monitors WHERE tenant_id = $1 AND id = $2`, [tenantId, id]);
  return rowCount > 0;
}

export async function listSyntheticResults(tenantId: string, monitorId: string, limit = 50): Promise<SyntheticResult[]> {
  const { rows } = await pool.query(
    `SELECT TOP (${Math.min(MAX_RESULTS_KEPT, Math.max(1, limit))}) * FROM api_synthetic_results WHERE tenant_id = $1 AND monitor_id = $2 ORDER BY created_at DESC`,
    [tenantId, monitorId],
  );
  return rows.map((r: any) => ({
    id: String(r.id), monitorId: String(r.monitor_id), status: (r.status || 'up') as SyntheticStatus,
    locations: jArr(r.locations) as LocationResult[], canary: r.canary ? (jObj(r.canary) as CanaryVerdict) : null,
    trace: r.trace ? (jObj(r.trace) as TraceSummary) : null, summary: r.summary || '', createdAt: r.created_at,
  }));
}

/* ── Execution ── */

function hex(n: number): string { let s = ''; const c = '0123456789abcdef'; for (let i = 0; i < n; i++) s += c[Math.floor(Math.random() * 16)]; return s; }

async function checkOneLocation(endpoint: SyntheticEndpointInput, loc: SyntheticLocation, correlationHeaders: Record<string, string>): Promise<LocationResult> {
  const dispatcher = await proxyDispatcher(loc.proxyUrl);
  try {
    const headers = { ...buildHeaders(endpoint), ...correlationHeaders };
    const init: RequestInit & { dispatcher?: any } = { method: endpoint.method, headers };
    if (dispatcher) init.dispatcher = dispatcher;
    const r = await fetchFull(endpoint.url, init, CHECK_TIMEOUT_MS, 8000);
    const statusOk = r.ok && (!endpoint.expectedStatus || r.status === endpoint.expectedStatus);
    let assertPassed: boolean | undefined;
    if (endpoint.assertText) assertPassed = (r.bodyText || '').includes(endpoint.assertText);
    return { location: loc.name, proxied: !!dispatcher, ok: !r.error && statusOk && assertPassed !== false, status: r.status, elapsedMs: r.elapsedMs, assertPassed, error: r.error };
  } catch (e) {
    return { location: loc.name, proxied: !!dispatcher, ok: false, elapsedMs: 0, error: (e as Error).message };
  } finally {
    try { dispatcher?.close?.(); } catch { /* ignore */ }
  }
}

/** Run one monitor's synthetic check across its locations (+ trace + canary). Does NOT persist. */
export async function runSyntheticCheck(monitor: Pick<SyntheticMonitor, 'endpoint' | 'locations' | 'tracing' | 'canary'>): Promise<Omit<SyntheticResult, 'id' | 'monitorId' | 'createdAt'>> {
  const endpoint = normalizeEndpoint(monitor.endpoint);
  const locations = normalizeLocations(monitor.locations);
  const traceId = hex(32); const spanId = hex(16); const correlationId = `iqe-${hex(8)}`;
  const correlationHeaders = { traceparent: `00-${traceId}-${spanId}-01`, 'X-Correlation-Id': correlationId, 'X-Request-Id': correlationId };

  const locResults: LocationResult[] = [];
  for (const loc of locations) locResults.push(await checkOneLocation(endpoint, loc, correlationHeaders));

  // Trace correlation (only when a backend is attached).
  let trace: TraceSummary | null = null;
  if (monitor.tracing?.queryUrl && monitor.tracing?.type) {
    try {
      const t = await runTraceProbe({ endpoint, tracing: monitor.tracing });
      trace = { traceId: t.traceId, correlationId: t.correlationId, backend: t.backend, spanCount: t.spanCount, note: t.note, assertions: t.assertions };
    } catch (e) { trace = { traceId, correlationId, spanCount: 0, note: `Trace probe failed: ${(e as Error).message}` }; }
  }

  // Canary evaluation.
  let canary: CanaryVerdict | null = null;
  const cfg = monitor.canary;
  if (cfg && (cfg.baselineUrl || cfg.maxErrorRatePct != null || cfg.maxLatencyMs != null)) {
    const failed = locResults.filter((l) => !l.ok).length;
    const errorRatePct = locResults.length ? Math.round((failed / locResults.length) * 100) : 0;
    const okLatencies = locResults.filter((l) => l.ok).map((l) => l.elapsedMs);
    const latencyMs = okLatencies.length ? Math.round(okLatencies.reduce((a, b) => a + b, 0) / okLatencies.length) : 0;
    let baseline: CanaryVerdict['baseline'];
    if (cfg.baselineUrl) {
      const b = await fetchFull(cfg.baselineUrl, { method: 'GET', headers: correlationHeaders }, CHECK_TIMEOUT_MS, 2000);
      baseline = { ok: !b.error && b.ok, status: b.status, latencyMs: b.elapsedMs, error: b.error };
    }
    const reasons: string[] = [];
    if (cfg.maxErrorRatePct != null && errorRatePct > cfg.maxErrorRatePct) reasons.push(`error rate ${errorRatePct}% > ${cfg.maxErrorRatePct}%`);
    if (cfg.maxLatencyMs != null && latencyMs > cfg.maxLatencyMs) reasons.push(`latency ${latencyMs}ms > ${cfg.maxLatencyMs}ms`);
    if (cfg.maxLatencyDeltaPct != null && baseline?.ok && baseline.latencyMs > 0) {
      const delta = Math.round(((latencyMs - baseline.latencyMs) / baseline.latencyMs) * 100);
      if (delta > cfg.maxLatencyDeltaPct) reasons.push(`canary ${delta}% slower than baseline (> ${cfg.maxLatencyDeltaPct}%)`);
    }
    const healthy = reasons.length === 0;
    canary = { evaluated: true, healthy, reasons, canary: { errorRatePct, latencyMs }, baseline, rollbackSignalled: false };
  }

  // Overall status.
  const reachable = locResults.filter((l) => l.status != null && !l.error);
  let status: SyntheticStatus;
  if (canary && !canary.healthy) status = 'rollback';
  else if (!reachable.length) status = 'down';
  else if (locResults.some((l) => !l.ok)) status = 'degraded';
  else status = 'up';

  const okCount = locResults.filter((l) => l.ok).length;
  const avg = locResults.length ? Math.round(locResults.reduce((a, b) => a + b.elapsedMs, 0) / locResults.length) : 0;
  const summary = `${okCount}/${locResults.length} locations OK · ~${avg}ms${canary ? ` · canary ${canary.healthy ? 'healthy' : 'BREACH'}` : ''}${trace ? ` · trace ${trace.spanCount} spans` : ''}`;
  return { status, locations: locResults, canary, trace, summary };
}

/** Fire the rollback SIGNAL webhook (opt-in URL; a notification only — never touches infra). */
async function signalRollback(url: string, payload: Record<string, unknown>): Promise<boolean> {
  try {
    const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload), signal: AbortSignal.timeout(10_000) });
    return res.ok;
  } catch { return false; }
}

/** Run one monitor row: execute → (maybe signal rollback) → persist result → update monitor. */
async function runMonitorRow(row: any): Promise<SyntheticResult> {
  const monitor = rowToMonitor(row);
  const tenantId = String(row.tenant_id);
  const outcome = await runSyntheticCheck(monitor);

  // Canary breach → emit the rollback signal (opt-in webhook).
  if (outcome.status === 'rollback' && monitor.canary?.rollbackWebhookUrl && outcome.canary) {
    const ok = await signalRollback(monitor.canary.rollbackWebhookUrl, {
      event: 'canary.rollback', monitor: monitor.name, monitorId: monitor.id,
      reasons: outcome.canary.reasons, canary: outcome.canary.canary, baseline: outcome.canary.baseline,
      at: new Date().toISOString(),
    });
    outcome.canary.rollbackSignalled = ok;
  }

  const { rows } = await pool.query(
    `INSERT INTO api_synthetic_results (tenant_id, monitor_id, status, locations, canary, trace, summary)
     OUTPUT INSERTED.id, INSERTED.created_at
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [tenantId, monitor.id, outcome.status, outcome.locations, outcome.canary, outcome.trace, outcome.summary.slice(0, 1000)],
  );
  // Trim to newest N per tenant.
  await pool.query(
    `DELETE FROM api_synthetic_results WHERE tenant_id = $1 AND id NOT IN (SELECT TOP (${MAX_RESULTS_KEPT}) id FROM api_synthetic_results WHERE tenant_id = $1 ORDER BY created_at DESC)`,
    [tenantId],
  ).catch(() => { /* best effort */ });
  await pool.query(
    `UPDATE api_synthetic_monitors SET last_run_at = SYSUTCDATETIME(), last_status = $2, updated_at = SYSUTCDATETIME() WHERE tenant_id = $1 AND id = $3`,
    [tenantId, outcome.status, monitor.id],
  ).catch(() => { /* best effort */ });

  return { id: String(rows[0].id), monitorId: monitor.id, createdAt: rows[0].created_at, ...outcome };
}

export async function runSyntheticMonitorNow(tenantId: string, monitorId: string): Promise<SyntheticResult> {
  const { rows } = await pool.query(`SELECT * FROM api_synthetic_monitors WHERE tenant_id = $1 AND id = $2`, [tenantId, monitorId]);
  if (!rows.length) throw new Error('Synthetic monitor not found.');
  return runMonitorRow(rows[0]);
}

/** Claim each due monitor by atomically advancing next_run_at, then run it. */
async function claimAndRunDue(): Promise<void> {
  const { rows: due } = await pool.query(
    `SELECT id, tenant_id FROM api_synthetic_monitors WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= SYSUTCDATETIME() ORDER BY next_run_at ASC`,
    [],
  );
  for (const d of due as any[]) {
    const claim = await pool.query(
      `UPDATE api_synthetic_monitors SET next_run_at = DATEADD(MINUTE, interval_minutes, SYSUTCDATETIME()), updated_at = SYSUTCDATETIME()
        WHERE id = $1 AND enabled = 1 AND next_run_at <= SYSUTCDATETIME()`,
      [String(d.id)],
    );
    if (claim.rowCount !== 1) continue;
    const { rows } = await pool.query(`SELECT * FROM api_synthetic_monitors WHERE id = $1`, [String(d.id)]);
    if (rows.length) await runMonitorRow(rows[0]).catch(() => { /* one bad monitor must not stop the rest */ });
  }
}

/** Start the in-process poller. Safe to call once at startup; a no-op if already running. */
export function startApiSynthetics(): void {
  if (started) return;
  started = true;
  const tick = () => { void claimAndRunDue().catch(() => { /* a bad tick must not kill the interval */ }); };
  setTimeout(tick, 25_000);
  const handle = setInterval(tick, POLL_MS);
  if (typeof handle.unref === 'function') handle.unref();
}
