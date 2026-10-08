/**
 * api-monitor.service.ts
 * ──────────────────────
 * Always-on monitoring loop. A tenant opts a set of endpoints into continuous
 * watching; an in-process poller (the same shape as the scheduler) wakes on a
 * clock and runs READ-ONLY checks — a health probe of each read endpoint,
 * a contract-drift scan, and a traffic-coverage scan — then records any problem
 * as a timeline alert and dispatches the tenant's webhooks.
 *
 * Deliberately NON-DESTRUCTIVE and surface-only: it never fires a write
 * request, never mutates the catalogue, and never launches the generate →
 * execute → heal pipeline (recurring runs are the Scheduler's job). It only
 * watches and alerts. Own tables; reuses the health/drift/coverage services and
 * the webhook dispatcher.
 */
import pool from '../db.js';
import { endpointsFromRaw } from '../utils/api-endpoints.js';
import { buildRequestInit, timedFetch, isWriteMethod } from '../utils/api-http.js';
import { scanDrift } from './api-drift.service.js';
import { analyzeCoverageGaps } from './api-coverage-gaps.service.js';
import { dispatchWebhooks } from './api-webhooks.service.js';
import type { ImportedEndpoint } from './api-import.service.js';

export type MonitorCheck = 'health' | 'drift' | 'coverage';
const ALL_CHECKS: MonitorCheck[] = ['health', 'drift', 'coverage'];

export interface MonitorConfigView {
  enabled: boolean;
  intervalMinutes: number;
  checks: MonitorCheck[];
  endpointCount: number;
  nextRunAt?: string;
  lastRunAt?: string;
  lastStatus?: string;
  lastSummary?: string;
}

export interface MonitorEvent { id: string; checkKind: string; severity: 'info' | 'warning' | 'critical'; title: string; detail: string; signature?: string; createdAt: string }

const MIN_INTERVAL = 5;
const MAX_INTERVAL = 60 * 24 * 7; // a week
const POLL_MS = 60_000;
const MAX_EVENTS_KEPT = 300;
const HEALTH_CONC = 6;
let started = false;

function clampInterval(v: unknown): number {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return 60;
  return Math.min(MAX_INTERVAL, Math.max(MIN_INTERVAL, n));
}

function sanitizeChecks(v: unknown): MonitorCheck[] {
  if (!Array.isArray(v)) return [...ALL_CHECKS];
  const out = [...new Set(v.map(String).filter((c): c is MonitorCheck => (ALL_CHECKS as string[]).includes(c)))];
  return out.length ? out : [...ALL_CHECKS];
}

function countEndpoints(raw: any): number {
  try { const arr = typeof raw === 'string' ? JSON.parse(raw) : raw; return Array.isArray(arr) ? arr.length : 0; } catch { return 0; }
}

function rowToView(r: any): MonitorConfigView {
  return {
    enabled: r.enabled === true || r.enabled === 1,
    intervalMinutes: r.interval_minutes || 60,
    checks: sanitizeChecks((() => { try { return typeof r.checks === 'string' ? JSON.parse(r.checks) : r.checks; } catch { return null; } })()),
    endpointCount: countEndpoints(r.endpoints),
    nextRunAt: r.next_run_at || undefined,
    lastRunAt: r.last_run_at || undefined,
    lastStatus: r.last_status || undefined,
    lastSummary: r.last_summary || undefined,
  };
}

export async function getMonitorConfig(tenantId: string): Promise<MonitorConfigView> {
  const { rows } = await pool.query(`SELECT * FROM api_monitor_config WHERE tenant_id = $1`, [tenantId]);
  if (!rows.length) return { enabled: false, intervalMinutes: 60, checks: [...ALL_CHECKS], endpointCount: 0 };
  return rowToView(rows[0]);
}

export async function saveMonitorConfig(tenantId: string, input: { enabled?: boolean; intervalMinutes?: number; endpoints?: unknown; checks?: unknown }): Promise<MonitorConfigView> {
  const { rows: existing } = await pool.query(`SELECT * FROM api_monitor_config WHERE tenant_id = $1`, [tenantId]);
  const cur = existing[0];
  const endpoints = input.endpoints !== undefined ? endpointsFromRaw(input.endpoints) : null;
  const interval = input.intervalMinutes !== undefined ? clampInterval(input.intervalMinutes) : (cur?.interval_minutes || 60);
  const enabled = input.enabled !== undefined ? (input.enabled ? 1 : 0) : (cur?.enabled ? 1 : 0);
  const checks = input.checks !== undefined ? sanitizeChecks(input.checks) : sanitizeChecks(cur ? (() => { try { return JSON.parse(cur.checks); } catch { return null; } })() : null);
  const endpointsJson = endpoints ? JSON.stringify(endpoints) : (cur?.endpoints || '[]');
  // Re-arm next_run_at when enabling or changing the interval.
  const reArm = (enabled === 1 && !cur?.enabled) || (input.intervalMinutes !== undefined && interval !== cur?.interval_minutes) || !cur;

  await pool.query(
    `MERGE INTO api_monitor_config WITH (HOLDLOCK) AS t USING (SELECT $1 AS tenant_id) AS s ON t.tenant_id = s.tenant_id
      WHEN MATCHED THEN UPDATE SET enabled = $2, interval_minutes = $3, endpoints = $4, checks = $5,
        next_run_at = CASE WHEN $6 = 1 THEN DATEADD(MINUTE, $3, SYSUTCDATETIME()) ELSE next_run_at END,
        updated_at = SYSUTCDATETIME()
      WHEN NOT MATCHED THEN INSERT (tenant_id, enabled, interval_minutes, endpoints, checks, next_run_at)
        VALUES ($1, $2, $3, $4, $5, CASE WHEN $2 = 1 THEN DATEADD(MINUTE, $3, SYSUTCDATETIME()) ELSE NULL END);`,
    [tenantId, enabled, interval, endpointsJson, JSON.stringify(checks), reArm ? 1 : 0],
  );
  return getMonitorConfig(tenantId);
}

export async function listMonitorEvents(tenantId: string, limit = 100): Promise<MonitorEvent[]> {
  const { rows } = await pool.query(
    `SELECT TOP (${Math.min(MAX_EVENTS_KEPT, Math.max(1, limit))}) * FROM api_monitor_events WHERE tenant_id = $1 ORDER BY created_at DESC`,
    [tenantId],
  );
  return rows.map((r: any) => ({ id: String(r.id), checkKind: r.check_kind || '', severity: r.severity || 'info', title: r.title || '', detail: r.detail || '', signature: r.signature || undefined, createdAt: r.created_at }));
}

interface RaisedAlert { checkKind: string; severity: 'info' | 'warning' | 'critical'; title: string; detail: string; signature?: string }

/** Run the enabled checks for one monitor config row. Read-only; returns alerts. */
async function runChecks(row: any): Promise<RaisedAlert[]> {
  const endpoints: ImportedEndpoint[] = endpointsFromRaw((() => { try { return typeof row.endpoints === 'string' ? JSON.parse(row.endpoints) : row.endpoints; } catch { return []; } })());
  const checks = sanitizeChecks((() => { try { return typeof row.checks === 'string' ? JSON.parse(row.checks) : row.checks; } catch { return null; } })());
  const alerts: RaisedAlert[] = [];
  if (!endpoints.length) return alerts;

  // 1) HEALTH — probe read-only endpoints; never fire a write.
  if (checks.includes('health')) {
    const probeable = endpoints.filter((e) => !isWriteMethod(e.method)).slice(0, 60);
    for (let i = 0; i < probeable.length; i += HEALTH_CONC) {
      const batch = probeable.slice(i, i + HEALTH_CONC);
      const results = await Promise.all(batch.map(async (e) => {
        const { url, init } = buildRequestInit(e as any);
        const r = await timedFetch(url, init, 15_000);
        return { e, r };
      }));
      for (const { e, r } of results) {
        const sig = `${e.method} ${e.url}`;
        if (!r.ok && r.error) alerts.push({ checkKind: 'health', severity: 'critical', title: `Unreachable: ${e.method} ${e.url}`, detail: r.error.slice(0, 400), signature: sig });
        else if (r.status && r.status >= 500) alerts.push({ checkKind: 'health', severity: 'critical', title: `${r.status} server error: ${e.method} ${e.url}`, detail: `Responded ${r.status} in ${r.elapsedMs}ms`, signature: sig });
        else if (e.expectedStatus && r.status && r.status !== e.expectedStatus) alerts.push({ checkKind: 'health', severity: 'warning', title: `Status ${r.status} ≠ expected ${e.expectedStatus}: ${e.method} ${e.url}`, detail: `Responded ${r.status} in ${r.elapsedMs}ms`, signature: sig });
      }
    }
  }

  // 2) DRIFT — live contract vs stored expectation.
  if (checks.includes('drift')) {
    try {
      const drift = await scanDrift(endpoints);
      for (const d of drift.results) {
        if (d.statusDrift && d.suggestedStatus != null) alerts.push({ checkKind: 'drift', severity: 'warning', title: `Contract drift: ${d.method} ${d.url}`, detail: `Status ${d.storedStatus ?? '—'} → ${d.suggestedStatus}`, signature: `${d.method} ${d.url}` });
        else if (d.shapeDrift) alerts.push({ checkKind: 'drift', severity: 'warning', title: `Response shape drifted: ${d.method} ${d.url}`, detail: d.changes.slice(0, 4).map((c: any) => `${c.kind} ${c.path}`).join(', ').slice(0, 400), signature: `${d.method} ${d.url}` });
      }
    } catch { /* drift needs reachable endpoints; absence is not an alert */ }
  }

  // 3) COVERAGE — recorded traffic with no test.
  if (checks.includes('coverage')) {
    try {
      const tested = endpoints.map((e) => ({ title: e.title || `${e.method} ${e.url}`, method: e.method, url: e.url, headers: e.headers || [], auth: (e.auth as any) || { type: 'none' } }));
      const cov = await analyzeCoverageGaps(row.tenant_id, tested as any);
      if (cov.gaps.length) alerts.push({ checkKind: 'coverage', severity: 'info', title: `${cov.gaps.length} untested endpoint${cov.gaps.length === 1 ? '' : 's'} in traffic`, detail: `Coverage ${cov.summary.coveragePct}% — ${cov.gaps.slice(0, 5).map((g: any) => `${g.method} ${g.url}`).join(', ')}`.slice(0, 400) });
    } catch { /* coverage needs capture sessions; absence is not an alert */ }
  }

  return alerts;
}

/** Run one monitor row: checks → record alerts → update status → notify. */
async function runMonitor(row: any): Promise<void> {
  const tenantId = String(row.tenant_id);
  try {
    const alerts = await runChecks(row);
    const critical = alerts.filter((a) => a.severity === 'critical').length;
    const warnings = alerts.filter((a) => a.severity === 'warning').length;
    const status = critical ? 'critical' : warnings ? 'warning' : 'healthy';
    const summary = alerts.length ? `${critical} critical · ${warnings} warning · ${alerts.length - critical - warnings} info` : 'All checks healthy';

    for (const a of alerts.slice(0, 50)) {
      await pool.query(
        `INSERT INTO api_monitor_events (tenant_id, check_kind, severity, title, detail, signature) VALUES ($1, $2, $3, $4, $5, $6)`,
        [tenantId, a.checkKind, a.severity, a.title.slice(0, 300), a.detail.slice(0, 1000), a.signature ? a.signature.slice(0, 300) : null],
      ).catch(() => { /* best effort */ });
    }
    // Keep only the newest events per tenant.
    await pool.query(
      `DELETE FROM api_monitor_events WHERE tenant_id = $1 AND id NOT IN (SELECT TOP (${MAX_EVENTS_KEPT}) id FROM api_monitor_events WHERE tenant_id = $1 ORDER BY created_at DESC)`,
      [tenantId],
    ).catch(() => { /* best effort */ });

    await pool.query(
      `UPDATE api_monitor_config SET last_run_at = SYSUTCDATETIME(), last_status = $1, last_summary = $2, updated_at = SYSUTCDATETIME() WHERE tenant_id = $3`,
      [status, summary.slice(0, 1000), tenantId],
    );

    if (critical || warnings) {
      await dispatchWebhooks(tenantId, {
        event: 'run.completed', title: `Monitor: ${status}`, status: critical ? 'failed' : 'passed',
        failures: alerts.filter((a) => a.severity !== 'info').slice(0, 20).map((a) => ({ title: a.title, error: a.detail })),
        source: 'monitor', at: new Date().toISOString(),
      } as any).catch(() => { /* webhooks are best-effort */ });
    }
  } catch (err) {
    await pool.query(
      `UPDATE api_monitor_config SET last_run_at = SYSUTCDATETIME(), last_status = 'error', last_summary = $1, updated_at = SYSUTCDATETIME() WHERE tenant_id = $2`,
      [((err as Error).message || 'Monitor run failed').slice(0, 1000), tenantId],
    ).catch(() => { /* best effort */ });
  }
}

/** Claim each due monitor by atomically advancing next_run_at, then run it. */
async function claimAndRunDue(): Promise<void> {
  const { rows: due } = await pool.query(
    `SELECT tenant_id FROM api_monitor_config WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= SYSUTCDATETIME() ORDER BY next_run_at ASC`,
    [],
  );
  for (const d of due as any[]) {
    const claim = await pool.query(
      `UPDATE api_monitor_config SET next_run_at = DATEADD(MINUTE, interval_minutes, SYSUTCDATETIME()), updated_at = SYSUTCDATETIME()
        WHERE tenant_id = $1 AND enabled = 1 AND next_run_at <= SYSUTCDATETIME()`,
      [String(d.tenant_id)],
    );
    if (claim.rowCount !== 1) continue;
    const { rows } = await pool.query(`SELECT * FROM api_monitor_config WHERE tenant_id = $1`, [String(d.tenant_id)]);
    if (rows.length) await runMonitor(rows[0]);
  }
}

/** Run a tenant's monitor immediately (the "Run now" button), off the clock. */
export async function runMonitorNow(tenantId: string): Promise<MonitorConfigView> {
  const { rows } = await pool.query(`SELECT * FROM api_monitor_config WHERE tenant_id = $1`, [tenantId]);
  if (!rows.length) throw new Error('Monitoring is not configured yet.');
  await runMonitor(rows[0]);
  return getMonitorConfig(tenantId);
}

/** Start the in-process poller. Safe to call once at startup; a no-op if already running. */
export function startApiMonitor(): void {
  if (started) return;
  started = true;
  const tick = () => { void claimAndRunDue().catch(() => { /* a bad tick must not kill the interval */ }); };
  setTimeout(tick, 20_000);
  const handle = setInterval(tick, POLL_MS);
  if (typeof handle.unref === 'function') handle.unref();
}
