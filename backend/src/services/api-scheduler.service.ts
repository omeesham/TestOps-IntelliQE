/**
 * api-scheduler.service.ts
 * ────────────────────────
 * Recurring API runs. A saved schedule holds an endpoint set and an interval;
 * an in-process poller claims due schedules and runs each through the SAME
 * headless pipeline the UI and CLI use (`runHeadlessApiRun`). On completion it
 * records the outcome and dispatches the tenant's webhooks.
 *
 * The pipeline itself is untouched — the scheduler only decides WHEN to invoke
 * it. The poller is a single `setInterval`; each due schedule is claimed with a
 * guarded UPDATE (advancing `next_run_at` atomically) so overlapping ticks, or
 * a second server instance, never double-run the same schedule.
 */
import pool from '../db.js';
import { runHeadlessApiRun, type HeadlessRunInput } from './api-run.service.js';
import { dispatchWebhooks } from './api-webhooks.service.js';
import { endpointsFromRaw } from '../utils/api-endpoints.js';

export interface ApiSchedule {
  id: string;
  name: string;
  endpointCount: number;
  environmentId?: string;
  coverage?: string;
  intervalMinutes: number;
  execute: boolean;
  heal: boolean;
  enabled: boolean;
  createdBy?: string;
  nextRunAt?: string;
  lastRunAt?: string;
  lastRunId?: string;
  lastStatus?: string;
  lastSummary?: string;
  createdAt: string;
  updatedAt: string;
}

const MIN_INTERVAL = 15;
const MAX_INTERVAL = 60 * 24 * 30; // 30 days
const POLL_MS = 60_000;
let started = false;

function clampInterval(v: unknown): number {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return 1440;
  return Math.min(MAX_INTERVAL, Math.max(MIN_INTERVAL, n));
}

function rowToSchedule(row: any): ApiSchedule {
  let count = 0;
  try { const arr = typeof row.endpoints === 'string' ? JSON.parse(row.endpoints) : row.endpoints; count = Array.isArray(arr) ? arr.length : 0; } catch { /* corrupt → 0 */ }
  return {
    id: String(row.id),
    name: row.name,
    endpointCount: count,
    environmentId: row.environment_id || undefined,
    coverage: row.coverage || undefined,
    intervalMinutes: row.interval_minutes,
    execute: !!row.execute,
    heal: !!row.heal,
    enabled: !!row.enabled,
    createdBy: row.created_by || undefined,
    nextRunAt: row.next_run_at || undefined,
    lastRunAt: row.last_run_at || undefined,
    lastRunId: row.last_run_id || undefined,
    lastStatus: row.last_status || undefined,
    lastSummary: row.last_summary || undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function listSchedules(tenantId: string): Promise<ApiSchedule[]> {
  const { rows } = await pool.query(
    `SELECT id, tenant_id, name, endpoints, environment_id, coverage, interval_minutes, execute, heal, enabled,
            created_by, next_run_at, last_run_at, last_run_id, last_status, last_summary, created_at, updated_at
       FROM api_schedules WHERE tenant_id = $1 ORDER BY created_at DESC`,
    [tenantId],
  );
  return rows.map(rowToSchedule);
}

export async function createSchedule(tenantId: string, createdBy: string, input: any): Promise<ApiSchedule> {
  const name = String(input?.name || '').trim().slice(0, 200);
  if (!name) throw new Error('A schedule needs a name.');
  const endpoints = endpointsFromRaw(input?.endpoints);
  if (endpoints.length === 0) throw new Error('A schedule needs at least one endpoint with an absolute http(s) URL.');
  const interval = clampInterval(input?.intervalMinutes);
  const enabled = input?.enabled === false ? 0 : 1;
  // First run one interval from now (opt-in: nothing fires the instant it's saved).
  const { rows } = await pool.query(
    `INSERT INTO api_schedules (tenant_id, name, endpoints, environment_id, coverage, interval_minutes, execute, heal, enabled, created_by, next_run_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, DATEADD(MINUTE, $11, SYSUTCDATETIME())) RETURNING *`,
    [tenantId, name, JSON.stringify(endpoints), input?.environmentId ? String(input.environmentId).slice(0, 80) : null,
     ['essential', 'standard', 'exhaustive'].includes(String(input?.coverage)) ? String(input.coverage) : null,
     interval, input?.execute === false ? 0 : 1, input?.heal === false ? 0 : 1, enabled, createdBy, enabled ? interval : MAX_INTERVAL],
  );
  return rowToSchedule(rows[0]);
}

export async function updateSchedule(tenantId: string, id: string, input: any): Promise<ApiSchedule | null> {
  const { rows: existing } = await pool.query(`SELECT * FROM api_schedules WHERE tenant_id = $1 AND id = $2`, [tenantId, id]);
  if (!existing.length) return null;
  const cur = existing[0];
  const name = input?.name !== undefined ? String(input.name).trim().slice(0, 200) : cur.name;
  if (!name) throw new Error('A schedule needs a name.');
  const endpoints = input?.endpoints !== undefined ? endpointsFromRaw(input.endpoints) : null;
  if (endpoints && endpoints.length === 0) throw new Error('A schedule needs at least one endpoint with an absolute http(s) URL.');
  const interval = input?.intervalMinutes !== undefined ? clampInterval(input.intervalMinutes) : cur.interval_minutes;
  const enabled = input?.enabled !== undefined ? (input.enabled ? 1 : 0) : cur.enabled;
  // Re-enabling (or changing the interval) re-arms next_run_at from now.
  const reArm = (input?.enabled === true && !cur.enabled) || (input?.intervalMinutes !== undefined && interval !== cur.interval_minutes);
  const { rows } = await pool.query(
    `UPDATE api_schedules
        SET name = $1, endpoints = $2, environment_id = $3, coverage = $4, interval_minutes = $5,
            execute = $6, heal = $7, enabled = $8,
            next_run_at = CASE WHEN $9 = 1 THEN DATEADD(MINUTE, $5, SYSUTCDATETIME()) ELSE next_run_at END,
            updated_at = SYSUTCDATETIME()
      WHERE tenant_id = $10 AND id = $11 RETURNING *`,
    [name, endpoints ? JSON.stringify(endpoints) : cur.endpoints,
     input?.environmentId !== undefined ? (input.environmentId ? String(input.environmentId).slice(0, 80) : null) : cur.environment_id,
     input?.coverage !== undefined ? (['essential', 'standard', 'exhaustive'].includes(String(input.coverage)) ? String(input.coverage) : null) : cur.coverage,
     interval, input?.execute !== undefined ? (input.execute ? 1 : 0) : cur.execute,
     input?.heal !== undefined ? (input.heal ? 1 : 0) : cur.heal, enabled, reArm ? 1 : 0, tenantId, id],
  );
  return rowToSchedule(rows[0]);
}

export async function deleteSchedule(tenantId: string, id: string): Promise<boolean> {
  const { rowCount } = await pool.query(`DELETE FROM api_schedules WHERE tenant_id = $1 AND id = $2`, [tenantId, id]);
  return rowCount > 0;
}

/** Build the headless-run input from a stored schedule row. */
function inputFromRow(row: any): HeadlessRunInput {
  let endpoints: any[] = [];
  try { const arr = typeof row.endpoints === 'string' ? JSON.parse(row.endpoints) : row.endpoints; endpoints = Array.isArray(arr) ? arr : []; } catch { /* corrupt → empty */ }
  return {
    endpoints,
    title: `${row.name} (scheduled)`,
    coverage: ['essential', 'standard', 'exhaustive'].includes(row.coverage) ? row.coverage : undefined,
    environmentId: row.environment_id || undefined,
    execute: !!row.execute,
    heal: !!row.heal,
  };
}

/** Run one schedule now: invoke the headless pipeline, record the outcome, notify. */
async function runSchedule(row: any): Promise<void> {
  const tenantId = String(row.tenant_id);
  const createdBy = row.created_by || 'scheduler';
  try {
    const result = await runHeadlessApiRun(tenantId, createdBy, inputFromRow(row));
    const status: 'passed' | 'failed' = result.stats ? (result.stats.failed === 0 && result.stats.notRun === 0 ? 'passed' : 'failed') : (result.executed ? 'failed' : 'passed');
    const summary = result.stats ? `${result.stats.passRate}% pass (${result.stats.passed}/${result.stats.total})` : `${result.scenarios.total} scenarios designed`;
    await pool.query(
      `UPDATE api_schedules SET last_run_at = SYSUTCDATETIME(), last_run_id = $1, last_status = $2, last_summary = $3, updated_at = SYSUTCDATETIME() WHERE id = $4`,
      [result.runId, status, summary.slice(0, 4000), String(row.id)],
    );
    if (result.executed) {
      await dispatchWebhooks(tenantId, {
        event: 'run.completed', title: result.title, runId: result.runId, reportUrl: result.reportUrl,
        status, stats: result.stats, failures: result.failures?.map((f) => ({ title: f.title, error: f.error })) || [],
        source: 'scheduler', at: new Date().toISOString(),
      });
    }
  } catch (err) {
    await pool.query(
      `UPDATE api_schedules SET last_run_at = SYSUTCDATETIME(), last_status = 'error', last_summary = $1, updated_at = SYSUTCDATETIME() WHERE id = $2`,
      [(err as Error).message?.slice(0, 4000) || 'Run failed', String(row.id)],
    ).catch(() => { /* best effort */ });
  }
}

/**
 * Claim one due schedule by atomically advancing its next_run_at. The guard
 * (`next_run_at <= now`) means only the caller whose UPDATE affects the row
 * wins the claim; everyone else sees rowCount 0 and moves on.
 */
async function claimAndRunDue(): Promise<void> {
  const { rows: due } = await pool.query(
    `SELECT id FROM api_schedules WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= SYSUTCDATETIME() ORDER BY next_run_at ASC`,
    [],
  );
  for (const d of due as any[]) {
    const claim = await pool.query(
      `UPDATE api_schedules
          SET next_run_at = DATEADD(MINUTE, interval_minutes, SYSUTCDATETIME()), updated_at = SYSUTCDATETIME()
        WHERE id = $1 AND enabled = 1 AND next_run_at <= SYSUTCDATETIME()`,
      [String(d.id)],
    );
    if (claim.rowCount !== 1) continue; // someone else claimed it
    const { rows } = await pool.query(`SELECT * FROM api_schedules WHERE id = $1`, [String(d.id)]);
    if (rows.length) await runSchedule(rows[0]);
  }
}

/** Run a schedule immediately (the "Run now" button), off the interval. */
export async function runScheduleNow(tenantId: string, id: string): Promise<boolean> {
  const { rows } = await pool.query(`SELECT * FROM api_schedules WHERE tenant_id = $1 AND id = $2`, [tenantId, id]);
  if (!rows.length) return false;
  // Detached — return to the caller immediately; the run records its own outcome.
  void runSchedule(rows[0]);
  return true;
}

/** Start the in-process poller. Safe to call once at startup; a no-op if already running. */
export function startApiScheduler(): void {
  if (started) return;
  started = true;
  const tick = () => { void claimAndRunDue().catch(() => { /* a bad tick must not kill the interval */ }); };
  // A small initial delay lets the app finish booting before the first sweep.
  setTimeout(tick, 15_000);
  const handle = setInterval(tick, POLL_MS);
  if (typeof handle.unref === 'function') handle.unref();
}
