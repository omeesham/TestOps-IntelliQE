/**
 * Recurring website audits.
 *
 * A schedule says "audit this site every day at 03:00 UTC" (or weekly on a
 * given weekday). A single in-process ticker wakes every minute, claims any
 * schedule whose `next_run_at` has passed, and starts the audit through the
 * same `startScan` the UI uses — so scheduled runs are ordinary audits with
 * `created_by = 'schedule'` and show up in the same list, trend and report.
 *
 * Claiming moves `next_run_at` forward before the scan starts, so two API
 * instances sharing one database cannot both fire the same schedule. If the
 * audit cannot start (another audit for the tenant is still running, or the
 * concurrency cap is hit) the schedule is retried a few minutes later rather
 * than skipping a whole day.
 */
import pool from '../../db.js';
import { encryptAtRest, decryptStored } from '../../utils/crypto.js';
import { normaliseStartUrl } from './ada-engine.js';
import { startScan, DEFAULT_OPTIONS } from './ada-scan.service.js';
import { loadStandard } from './ada-standard.service.js';

export type ScheduleFrequency = 'daily' | 'weekly';

export interface AdaSchedule {
  id: string;
  tenant_id: string;
  target_url: string;
  frequency: ScheduleFrequency;
  run_hour_utc: number;
  /** 0 = Sunday … 6 = Saturday. Only for weekly. */
  run_weekday: number | null;
  options: { maxPages?: number; checkExternalLinks?: boolean; username?: string; hasPassword?: boolean; ux?: boolean; devices?: string[]; designStandardId?: string };
  enabled: boolean;
  next_run_at: string | null;
  last_run_at: string | null;
  last_scan_id: string | null;
  last_error: string | null;
  created_by: string | null;
  created_at: string;
}

export interface ScheduleInput {
  url: string;
  frequency: ScheduleFrequency;
  runHourUtc: number;
  runWeekday?: number | null;
  maxPages?: number;
  checkExternalLinks?: boolean;
  username?: string;
  password?: string;
  /** UX checks: on by default, with the recommended devices. */
  ux?: boolean;
  devices?: string[];
  designStandardId?: string;
}

const TICK_MS = 60_000;
const RETRY_MS = 5 * 60_000;
const SCHEDULE_ACTOR = 'schedule';

/** Next occurrence strictly after `from`. */
export function computeNextRun(frequency: ScheduleFrequency, hourUtc: number, weekday: number | null, from = new Date()): Date {
  const next = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate(), hourUtc, 0, 0, 0));
  if (frequency === 'weekly') {
    const wd = weekday ?? 1;
    while (next.getUTCDay() !== wd || next <= from) next.setUTCDate(next.getUTCDate() + 1);
    return next;
  }
  if (next <= from) next.setUTCDate(next.getUTCDate() + 1);
  return next;
}

/* ───────────────────────────── storage ───────────────────────────── */

interface StoredOptions { maxPages?: number; checkExternalLinks?: boolean; username?: string; password?: string; ux?: boolean; devices?: string[]; designStandardId?: string }

function parseOptions(raw: unknown): StoredOptions {
  if (raw && typeof raw === 'object') return raw as StoredOptions;
  if (typeof raw === 'string') { try { return JSON.parse(raw) as StoredOptions; } catch { return {}; } }
  return {};
}

/** Public shape: the password never leaves the server. */
function toPublic(row: Record<string, unknown>): AdaSchedule {
  const o = parseOptions(row.options);
  return {
    id: String(row.id),
    tenant_id: String(row.tenant_id),
    target_url: String(row.target_url),
    frequency: row.frequency as ScheduleFrequency,
    run_hour_utc: Number(row.run_hour_utc),
    run_weekday: row.run_weekday === null || row.run_weekday === undefined ? null : Number(row.run_weekday),
    options: { maxPages: o.maxPages, checkExternalLinks: o.checkExternalLinks, username: o.username, hasPassword: !!o.password, ux: o.ux !== false, devices: o.devices, designStandardId: o.designStandardId },
    enabled: !!row.enabled,
    next_run_at: (row.next_run_at as string) || null,
    last_run_at: (row.last_run_at as string) || null,
    last_scan_id: (row.last_scan_id as string) || null,
    last_error: (row.last_error as string) || null,
    created_by: (row.created_by as string) || null,
    created_at: String(row.created_at),
  };
}

function validate(input: ScheduleInput): { url: string; frequency: ScheduleFrequency; hour: number; weekday: number | null } {
  const url = normaliseStartUrl(input.url);
  const frequency: ScheduleFrequency = input.frequency === 'weekly' ? 'weekly' : 'daily';
  const hour = Math.min(23, Math.max(0, Math.round(Number(input.runHourUtc) || 0)));
  const weekday = frequency === 'weekly' ? Math.min(6, Math.max(0, Math.round(Number(input.runWeekday ?? 1)))) : null;
  return { url, frequency, hour, weekday };
}

export async function listSchedules(tenantId: string): Promise<AdaSchedule[]> {
  const { rows } = await pool.query(`SELECT * FROM ada_schedules WHERE tenant_id = $1 ORDER BY created_at DESC`, [tenantId]);
  return rows.map(toPublic);
}

export async function createSchedule(tenantId: string, createdBy: string, input: ScheduleInput): Promise<AdaSchedule> {
  const v = validate(input);
  const options: StoredOptions = {
    maxPages: input.maxPages ? Math.min(500, Math.max(5, Math.round(input.maxPages))) : DEFAULT_OPTIONS.maxPages,
    checkExternalLinks: input.checkExternalLinks !== false,
    username: input.username?.trim() || undefined,
    password: input.password ? encryptAtRest(input.password) : undefined,
    ux: input.ux !== false,
    devices: Array.isArray(input.devices) && input.devices.length ? input.devices.map(String).slice(0, 8) : undefined,
    designStandardId: input.designStandardId || undefined,
  };
  const { rows } = await pool.query(
    `INSERT INTO ada_schedules (tenant_id, target_url, frequency, run_hour_utc, run_weekday, options, enabled, next_run_at, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, 1, $7, $8) RETURNING *`,
    [tenantId, v.url, v.frequency, v.hour, v.weekday, JSON.stringify(options), computeNextRun(v.frequency, v.hour, v.weekday).toISOString(), createdBy],
  );
  return toPublic(rows[0]);
}

export async function updateSchedule(tenantId: string, id: string, patch: Partial<ScheduleInput> & { enabled?: boolean }): Promise<AdaSchedule | null> {
  const { rows } = await pool.query(`SELECT * FROM ada_schedules WHERE id = $1 AND tenant_id = $2`, [id, tenantId]);
  if (rows.length === 0) return null;
  const cur = rows[0];
  const merged = validate({
    url: patch.url ?? cur.target_url,
    frequency: patch.frequency ?? cur.frequency,
    runHourUtc: patch.runHourUtc ?? cur.run_hour_utc,
    runWeekday: patch.runWeekday !== undefined ? patch.runWeekday : cur.run_weekday,
  });
  const stored = parseOptions(cur.options);
  const options: StoredOptions = {
    maxPages: patch.maxPages !== undefined ? Math.min(500, Math.max(5, Math.round(patch.maxPages))) : stored.maxPages,
    checkExternalLinks: patch.checkExternalLinks !== undefined ? patch.checkExternalLinks : stored.checkExternalLinks,
    username: patch.username !== undefined ? (patch.username.trim() || undefined) : stored.username,
    password: patch.password !== undefined ? (patch.password ? encryptAtRest(patch.password) : undefined) : stored.password,
    ux: patch.ux !== undefined ? patch.ux : stored.ux,
    devices: patch.devices !== undefined ? patch.devices.map(String).slice(0, 8) : stored.devices,
    designStandardId: patch.designStandardId !== undefined ? (patch.designStandardId || undefined) : stored.designStandardId,
  };
  const enabled = patch.enabled !== undefined ? !!patch.enabled : !!cur.enabled;
  const timingChanged = merged.frequency !== cur.frequency || merged.hour !== Number(cur.run_hour_utc) || merged.weekday !== (cur.run_weekday ?? null);
  const nextRun = enabled && (timingChanged || !cur.enabled || !cur.next_run_at)
    ? computeNextRun(merged.frequency, merged.hour, merged.weekday).toISOString()
    : cur.next_run_at;
  const upd = await pool.query(
    `UPDATE ada_schedules
        SET target_url = $3, frequency = $4, run_hour_utc = $5, run_weekday = $6, options = $7, enabled = $8, next_run_at = $9, updated_at = now()
      WHERE id = $1 AND tenant_id = $2`,
    [id, tenantId, merged.url, merged.frequency, merged.hour, merged.weekday, JSON.stringify(options), enabled ? 1 : 0, nextRun],
  );
  if (!upd.rowCount) return null;
  const again = await pool.query(`SELECT * FROM ada_schedules WHERE id = $1 AND tenant_id = $2`, [id, tenantId]);
  return again.rows[0] ? toPublic(again.rows[0]) : null;
}

export async function deleteSchedule(tenantId: string, id: string): Promise<boolean> {
  const r = await pool.query(`DELETE FROM ada_schedules WHERE id = $1 AND tenant_id = $2`, [id, tenantId]);
  return !!r.rowCount;
}

/** Start the schedule's audit right now (does not move the regular next run). */
export async function runScheduleNow(tenantId: string, id: string, actor: string): Promise<string> {
  const { rows } = await pool.query(`SELECT * FROM ada_schedules WHERE id = $1 AND tenant_id = $2`, [id, tenantId]);
  if (rows.length === 0) throw new Error('Schedule not found');
  return launch(rows[0], actor);
}

/* ───────────────────────────── the ticker ───────────────────────────── */

async function launch(row: Record<string, unknown>, actor: string): Promise<string> {
  const o = parseOptions(row.options);
  // A standard that was deleted since the schedule was made simply means "not scored" — the audit still runs.
  const std = o.designStandardId ? await loadStandard(String(row.tenant_id), o.designStandardId).catch(() => null) : null;
  const scanId = await startScan(String(row.tenant_id), actor, {
    url: String(row.target_url),
    username: o.username,
    password: o.password ? decryptStored(o.password) : undefined,
    maxPages: o.maxPages || DEFAULT_OPTIONS.maxPages,
    maxDepth: DEFAULT_OPTIONS.maxDepth,
    useSitemap: true,
    checkExternalLinks: o.checkExternalLinks !== false,
    crawlDelayMs: DEFAULT_OPTIONS.crawlDelayMs,
    uxEnabled: o.ux !== false,
    devices: o.devices && o.devices.length ? o.devices : DEFAULT_OPTIONS.devices,
    uxPagesPerDevice: DEFAULT_OPTIONS.uxPagesPerDevice,
    designStandard: std ? { id: std.id, name: std.name, standard: std.standard } : null,
  });
  await pool.query(`UPDATE ada_schedules SET last_run_at = now(), last_scan_id = $2, last_error = NULL, updated_at = now() WHERE id = $1`, [row.id, scanId]);
  return scanId;
}

let ticking = false;

export async function tickSchedules(now = new Date()): Promise<void> {
  if (ticking) return;
  ticking = true;
  try {
    const { rows } = await pool.query(`SELECT * FROM ada_schedules WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= $1`, [now.toISOString()]);
    for (const row of rows) {
      const next = computeNextRun(row.frequency, Number(row.run_hour_utc), row.run_weekday ?? null, now).toISOString();
      // Claim: only the instance that moves next_run_at forward runs the audit.
      const claim = await pool.query(`UPDATE ada_schedules SET next_run_at = $3, updated_at = now() WHERE id = $1 AND next_run_at = $2`, [row.id, row.next_run_at, next]);
      if (!claim.rowCount) continue;
      try {
        await launch(row, SCHEDULE_ACTOR);
      } catch (err) {
        // Busy (another audit running / concurrency cap) or bad target — retry soon, never skip a day silently.
        const msg = (err as Error).message || String(err);
        const retry = new Date(now.getTime() + RETRY_MS).toISOString();
        await pool.query(`UPDATE ada_schedules SET next_run_at = $2, last_error = $3, updated_at = now() WHERE id = $1`, [row.id, retry, msg.slice(0, 500)]).catch(() => { /* best effort */ });
        console.warn(`[ada-schedule] ${row.target_url}: could not start (${msg}) — retrying at ${retry}`);
      }
    }
  } catch (err) {
    console.warn('[ada-schedule] tick failed:', (err as Error).message);
  } finally {
    ticking = false;
  }
}

/** Start the once-a-minute ticker. Safe to call once per process. */
export function startAdaScheduler(): void {
  if (process.env.ADA_SCHEDULER === 'false') { console.log('[ada-schedule] disabled by ADA_SCHEDULER=false'); return; }
  const timer = setInterval(() => { void tickSchedules(); }, TICK_MS);
  timer.unref();
  void tickSchedules();
  console.log('[ada-schedule] recurring audits enabled (checks every minute)');
}
