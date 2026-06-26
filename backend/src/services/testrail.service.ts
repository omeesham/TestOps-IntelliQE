/**
 * testrail.service.ts
 * ───────────────────
 * TestRail is the data SOURCE; IntelliQE is the visualization layer. We
 * periodically SYNC TestRail (projects / runs / milestones) into our own
 * tenant-scoped tables, then the dashboard reads from the DB. This makes loads
 * fast and lets us build historical trends TestRail doesn't expose directly.
 *
 * Credentials live in client_configurations (integration_id='testrail'),
 * encrypted at rest — the API key never goes back to the browser.
 *
 * TestRail API: GET {baseUrl}/index.php?/api/v2/<method>, Basic auth email:apiKey.
 * Run objects already carry aggregate counts (passed/failed/blocked/retest/
 * untested + custom statuses), so a sync doesn't need per-result calls.
 */
import axios from 'axios';
import pool from '../db.js';
import { getConfigsForTenant, upsertConfig, disconnectConfig } from './configurations.service.js';
import { encryptConfigData, decryptConfigData } from '../utils/crypto.js';

const S = '"JBSTestOpsAI"';

export interface TestRailCreds { baseUrl: string; email: string; apiKey: string }

/* ───────────── credential storage (reuses client_configurations) ───────────── */

export async function getTestRailCreds(tenantId: string): Promise<TestRailCreds | null> {
  const configs = await getConfigsForTenant(tenantId);
  const cfg = configs.find((c) => c.integrationId === 'testrail');
  if (!cfg) return null;
  const d = decryptConfigData(cfg.configData || {});
  const baseUrl = String(d.baseUrl || '').trim();
  const email = String(d.email || '').trim();
  const apiKey = String(d.apiKey || '').trim();
  if (!baseUrl || !email || !apiKey) return null;
  return { baseUrl: baseUrl.replace(/\/+$/, ''), email, apiKey };
}

export async function saveTestRailCreds(tenantId: string, username: string, creds: TestRailCreds): Promise<void> {
  await upsertConfig(
    tenantId, 'testrail', 'connected',
    encryptConfigData({ baseUrl: creds.baseUrl.replace(/\/+$/, ''), email: creds.email, apiKey: creds.apiKey }),
    username,
  );
}

export async function disconnectTestRail(tenantId: string): Promise<void> {
  await disconnectConfig(tenantId, 'testrail');
  await pool.query(`DELETE FROM ${S}.testrail_runs WHERE tenant_id = $1`, [tenantId]);
  await pool.query(`DELETE FROM ${S}.testrail_projects WHERE tenant_id = $1`, [tenantId]);
  await pool.query(`DELETE FROM ${S}.testrail_milestones WHERE tenant_id = $1`, [tenantId]);
  await pool.query(`DELETE FROM ${S}.testrail_sync WHERE tenant_id = $1`, [tenantId]);
}

/* ───────────── TestRail API client ───────────── */

function authHeader(creds: TestRailCreds): string {
  return 'Basic ' + Buffer.from(`${creds.email}:${creds.apiKey}`).toString('base64');
}

async function trGet(creds: TestRailCreds, method: string): Promise<any> {
  const url = `${creds.baseUrl}/index.php?/api/v2/${method}`;
  const { data } = await axios.get(url, {
    headers: { 'Content-Type': 'application/json', Authorization: authHeader(creds) },
    timeout: 30_000,
  });
  return data;
}

/** Newer TestRail wraps lists ({projects:[…]}); older returns a bare array. */
function unwrap(data: any, key: string): any[] {
  if (Array.isArray(data)) return data;
  return Array.isArray(data?.[key]) ? data[key] : [];
}

const toIso = (sec: any): string | null => (typeof sec === 'number' && sec > 0 ? new Date(sec * 1000).toISOString() : null);

function runTotal(r: any): number {
  let t = 0;
  for (const k of ['passed_count', 'failed_count', 'blocked_count', 'retest_count', 'untested_count']) t += Number(r[k]) || 0;
  for (let i = 1; i <= 7; i++) t += Number(r[`custom_status${i}_count`]) || 0;
  return t;
}

/** Validate credentials by hitting a lightweight endpoint. Returns project count. */
export async function testTestRailConnection(creds: TestRailCreds): Promise<{ ok: true; projects: number }> {
  const projects = unwrap(await trGet(creds, 'get_projects'), 'projects');
  return { ok: true, projects: projects.length };
}

async function fetchAllRuns(creds: TestRailCreds, projectId: number): Promise<any[]> {
  const out: any[] = [];
  const limit = 250;
  for (let offset = 0; offset < 5000; offset += limit) {
    const data = await trGet(creds, `get_runs/${projectId}&limit=${limit}&offset=${offset}`);
    const page = unwrap(data, 'runs');
    out.push(...page);
    if (page.length < limit) break;
  }
  return out;
}

/* ───────────── sync ───────────── */

export interface SyncResult { projects: number; runs: number; milestones: number; lastSyncedAt: string }

export async function syncTestRail(tenantId: string): Promise<SyncResult> {
  const creds = await getTestRailCreds(tenantId);
  if (!creds) throw new Error('TestRail is not connected. Connect first.');

  // Pull everything first (so a fetch error doesn't wipe existing data).
  const projects = unwrap(await trGet(creds, 'get_projects'), 'projects');
  const runs: any[] = [];
  const milestones: any[] = [];
  for (const p of projects) {
    const pid = Number(p.id);
    for (const r of await fetchAllRuns(creds, pid)) runs.push({ ...r, _pid: pid });
    for (const m of unwrap(await trGet(creds, `get_milestones/${pid}`), 'milestones')) milestones.push({ ...m, _pid: pid });
  }

  // Full refresh for this tenant.
  await pool.query(`DELETE FROM ${S}.testrail_projects WHERE tenant_id = $1`, [tenantId]);
  await pool.query(`DELETE FROM ${S}.testrail_runs WHERE tenant_id = $1`, [tenantId]);
  await pool.query(`DELETE FROM ${S}.testrail_milestones WHERE tenant_id = $1`, [tenantId]);

  for (const p of projects) {
    await pool.query(
      `INSERT INTO ${S}.testrail_projects (tenant_id, project_id, name, is_completed)
       VALUES ($1, $2, $3, $4)`,
      [tenantId, Number(p.id), String(p.name || `Project ${p.id}`), p.is_completed ? 1 : 0],
    );
  }
  for (const r of runs) {
    await pool.query(
      `INSERT INTO ${S}.testrail_runs
        (tenant_id, project_id, run_id, name, milestone_id, is_completed, created_on,
         passed_count, failed_count, blocked_count, retest_count, untested_count, total_count)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [
        tenantId, r._pid, Number(r.id), String(r.name || `Run ${r.id}`),
        r.milestone_id != null ? Number(r.milestone_id) : null,
        r.is_completed ? 1 : 0, toIso(r.created_on),
        Number(r.passed_count) || 0, Number(r.failed_count) || 0, Number(r.blocked_count) || 0,
        Number(r.retest_count) || 0, Number(r.untested_count) || 0, runTotal(r),
      ],
    );
  }
  for (const m of milestones) {
    await pool.query(
      `INSERT INTO ${S}.testrail_milestones
        (tenant_id, project_id, milestone_id, name, is_completed, started_on, due_on)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [tenantId, m._pid, Number(m.id), String(m.name || `Milestone ${m.id}`), m.is_completed ? 1 : 0, toIso(m.started_on), toIso(m.due_on)],
    );
  }

  const lastSyncedAt = new Date().toISOString();
  await pool.query(
    `MERGE INTO ${S}.testrail_sync WITH (HOLDLOCK) AS t
     USING (SELECT $1 AS tenant_id) AS s ON t.tenant_id = s.tenant_id
     WHEN MATCHED THEN UPDATE SET last_synced_at = $2, status = 'ok', message = NULL, projects_count = $3, runs_count = $4
     WHEN NOT MATCHED THEN INSERT (tenant_id, last_synced_at, status, message, projects_count, runs_count)
       VALUES ($1, $2, 'ok', NULL, $3, $4);`,
    [tenantId, lastSyncedAt, projects.length, runs.length],
  );

  return { projects: projects.length, runs: runs.length, milestones: milestones.length, lastSyncedAt };
}

/* ───────────── status + dashboard (read from synced DB) ───────────── */

export async function getTestRailStatus(tenantId: string) {
  const creds = await getTestRailCreds(tenantId);
  const sync = (await pool.query(`SELECT last_synced_at, status, projects_count, runs_count FROM ${S}.testrail_sync WHERE tenant_id = $1`, [tenantId])).rows[0];
  return {
    connected: !!creds,
    baseUrl: creds?.baseUrl || null,
    email: creds?.email || null,
    lastSyncedAt: sync?.last_synced_at || null,
    syncStatus: sync?.status || null,
    projectsCount: Number(sync?.projects_count) || 0,
    runsCount: Number(sync?.runs_count) || 0,
  };
}

export async function getTestRailDashboard(tenantId: string, projectId?: number) {
  const projects = (await pool.query(
    `SELECT project_id AS id, name, is_completed FROM ${S}.testrail_projects WHERE tenant_id = $1 ORDER BY name`, [tenantId],
  )).rows.map((r: any) => ({ id: Number(r.id), name: r.name, isCompleted: !!r.is_completed }));

  const params: any[] = [tenantId];
  let runWhere = `WHERE tenant_id = $1`;
  if (projectId) { params.push(projectId); runWhere += ` AND project_id = $2`; }

  const sums = (await pool.query(
    `SELECT
       COUNT(*) AS runs,
       SUM(passed_count) AS passed, SUM(failed_count) AS failed, SUM(blocked_count) AS blocked,
       SUM(retest_count) AS retest, SUM(untested_count) AS untested, SUM(total_count) AS total
     FROM ${S}.testrail_runs ${runWhere}`, params)).rows[0] || {};
  const passed = Number(sums.passed) || 0, failed = Number(sums.failed) || 0, blocked = Number(sums.blocked) || 0;
  const retest = Number(sums.retest) || 0, untested = Number(sums.untested) || 0, total = Number(sums.total) || 0;
  const executed = passed + failed + blocked + retest;

  const perRun = (await pool.query(
    `SELECT TOP 12 run_id AS id, name, passed_count AS passed, failed_count AS failed,
            blocked_count AS blocked, untested_count AS untested, total_count AS total, created_on
     FROM ${S}.testrail_runs ${runWhere} ORDER BY created_on DESC`, params)).rows.map((r: any) => ({
    id: Number(r.id), name: r.name, passed: Number(r.passed) || 0, failed: Number(r.failed) || 0,
    blocked: Number(r.blocked) || 0, untested: Number(r.untested) || 0, total: Number(r.total) || 0, createdOn: r.created_on,
  }));

  const trend = (await pool.query(
    `SELECT CONVERT(varchar(7), created_on, 126) AS bucket,
            SUM(passed_count) AS passed, SUM(failed_count) AS failed, SUM(blocked_count) AS blocked
     FROM ${S}.testrail_runs ${runWhere} AND created_on IS NOT NULL
     GROUP BY CONVERT(varchar(7), created_on, 126) ORDER BY bucket`,
    params)).rows.map((r: any) => ({ bucket: String(r.bucket), passed: Number(r.passed) || 0, failed: Number(r.failed) || 0, blocked: Number(r.blocked) || 0 }));

  const msParams: any[] = [tenantId];
  let msWhere = `WHERE tenant_id = $1`;
  if (projectId) { msParams.push(projectId); msWhere += ` AND project_id = $2`; }
  const milestones = (await pool.query(
    `SELECT milestone_id AS id, name, is_completed, started_on, due_on FROM ${S}.testrail_milestones ${msWhere} ORDER BY due_on DESC`,
    msParams)).rows.map((r: any) => ({ id: Number(r.id), name: r.name, isCompleted: !!r.is_completed, startedOn: r.started_on, dueOn: r.due_on }));

  const sync = (await pool.query(`SELECT last_synced_at FROM ${S}.testrail_sync WHERE tenant_id = $1`, [tenantId])).rows[0];

  return {
    projects,
    lastSyncedAt: sync?.last_synced_at || null,
    summary: {
      runs: Number(sums.runs) || 0, total, passed, failed, blocked, retest, untested, executed,
      passRate: executed > 0 ? Math.round((passed / executed) * 100) : 0,
    },
    byStatus: [
      { name: 'Passed', value: passed },
      { name: 'Failed', value: failed },
      { name: 'Blocked', value: blocked },
      { name: 'Retest', value: retest },
      { name: 'Untested', value: untested },
    ],
    perRun,
    trend,
    milestones,
  };
}
