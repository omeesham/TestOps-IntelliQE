/**
 * api-test-management.service.ts
 * ──────────────────────────────
 * Formal enterprise test-management objects for the API module, as first-class
 * records that layer BESIDE the generate → execute → heal pipeline:
 *
 *   • Suite  — a named, reusable set of endpoints (built from the catalogue).
 *   • Plan   — a suite collection + the environment/coverage to run them under,
 *              with an optional pass-rate gate.
 *   • Cycle  — one dated execution of a plan. Starting a cycle reuses the
 *              existing headless runner (runHeadlessApiRun) via the async-job
 *              queue; its status/stats are reconciled lazily on read.
 *   • Assignment + progress — assign a plan (or one of its suites) to a
 *              teammate and track their status (todo / in-progress / blocked /
 *              done), rolled up per plan and per member.
 *
 * Fully additive and opt-in: its own tables, nothing in the pipeline changes.
 */
import pool from '../db.js';
import { startJob, getJob } from './async-jobs.service.js';
import { runHeadlessApiRun, type HeadlessRunResult } from './api-run.service.js';
import { normalizeEndpoints } from '../utils/endpoint-normalize.js';
import type { ImportedEndpoint } from './api-import.service.js';

// ─── types ────────────────────────────────────────────────────────────────

export interface TestSuite {
  id: string; name: string; description: string;
  endpoints: ImportedEndpoint[]; tags: string[];
  createdBy: string; createdAt: string; updatedAt: string;
}
export interface PlanGate { minPassRate?: number; maxFailed?: number }
export interface TestPlan {
  id: string; name: string; description: string;
  suiteIds: string[]; environmentId?: string; coverage: 'essential' | 'standard' | 'exhaustive';
  gate?: PlanGate | null;
  createdBy: string; createdAt: string; updatedAt: string;
}
export type CycleStatus = 'planned' | 'running' | 'completed' | 'failed' | 'aborted';
export interface TestCycle {
  id: string; planId: string; name: string; status: CycleStatus;
  runId?: string; jobId?: string;
  stats?: { total: number; passed: number; failed: number; notRun: number; passRate: number; durationMs: number } | null;
  error?: string;
  createdBy: string; createdAt: string; startedAt?: string; finishedAt?: string;
}
export type AssignmentStatus = 'todo' | 'in_progress' | 'blocked' | 'done';
const ASSIGN_STATUSES: AssignmentStatus[] = ['todo', 'in_progress', 'blocked', 'done'];
export interface Assignment {
  id: string; planId: string; suiteId?: string; assignee: string;
  status: AssignmentStatus; notes: string;
  createdBy: string; createdAt: string; updatedAt: string;
}

// ─── suites ─────────────────────────────────────────────────────────────────

function toSuite(r: any): TestSuite {
  return {
    id: String(r.id), name: r.name || '', description: r.description || '',
    endpoints: Array.isArray(r.endpoints) ? r.endpoints : [],
    tags: Array.isArray(r.tags) ? r.tags : [],
    createdBy: r.created_by || '', createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

export async function listSuites(tenantId: string): Promise<TestSuite[]> {
  const { rows } = await pool.query(`SELECT * FROM api_test_suites WHERE tenant_id = $1 ORDER BY updated_at DESC`, [tenantId]);
  return rows.map(toSuite);
}
export async function saveSuite(tenantId: string, username: string, input: any): Promise<TestSuite> {
  const name = String(input?.name || '').trim().slice(0, 200) || 'Suite';
  const description = String(input?.description || '').slice(0, 4000);
  const endpoints = normalizeEndpoints(input?.endpoints, 500);
  const tags = Array.isArray(input?.tags) ? input.tags.map((t: unknown) => String(t).slice(0, 60)).slice(0, 30) : [];
  if (input?.id) {
    const { rows } = await pool.query(
      `UPDATE api_test_suites SET name = $3, description = $4, endpoints = $5, tags = $6, updated_at = SYSUTCDATETIME()
         OUTPUT INSERTED.* WHERE tenant_id = $1 AND id = $2`,
      [tenantId, input.id, name, description, endpoints, tags],
    );
    if (!rows.length) throw new Error('Suite not found.');
    return toSuite(rows[0]);
  }
  const { rows } = await pool.query(
    `INSERT INTO api_test_suites (tenant_id, name, description, endpoints, tags, created_by)
       OUTPUT INSERTED.* VALUES ($1, $2, $3, $4, $5, $6)`,
    [tenantId, name, description, endpoints, tags, username],
  );
  return toSuite(rows[0]);
}
export async function deleteSuite(tenantId: string, id: string): Promise<boolean> {
  const { rowCount } = await pool.query(`DELETE FROM api_test_suites WHERE tenant_id = $1 AND id = $2`, [tenantId, id]);
  return rowCount > 0;
}

// ─── plans ────────────────────────────────────────────────────────────────

const COVERAGES = new Set(['essential', 'standard', 'exhaustive']);
function toPlan(r: any): TestPlan {
  return {
    id: String(r.id), name: r.name || '', description: r.description || '',
    suiteIds: Array.isArray(r.suite_ids) ? r.suite_ids.map(String) : [],
    environmentId: r.environment_id || undefined,
    coverage: (COVERAGES.has(r.coverage) ? r.coverage : 'standard') as TestPlan['coverage'],
    gate: r.gate && typeof r.gate === 'object' ? r.gate : null,
    createdBy: r.created_by || '', createdAt: r.created_at, updatedAt: r.updated_at,
  };
}
export async function listPlans(tenantId: string): Promise<TestPlan[]> {
  const { rows } = await pool.query(`SELECT * FROM api_test_plans WHERE tenant_id = $1 ORDER BY updated_at DESC`, [tenantId]);
  return rows.map(toPlan);
}
export async function savePlan(tenantId: string, username: string, input: any): Promise<TestPlan> {
  const name = String(input?.name || '').trim().slice(0, 200) || 'Plan';
  const description = String(input?.description || '').slice(0, 4000);
  const suiteIds = Array.isArray(input?.suiteIds) ? input.suiteIds.map((s: unknown) => String(s)).slice(0, 100) : [];
  const environmentId = input?.environmentId ? String(input.environmentId).slice(0, 80) : null;
  const coverage = COVERAGES.has(input?.coverage) ? input.coverage : 'standard';
  const gate: PlanGate | null = input?.gate && typeof input.gate === 'object'
    ? { minPassRate: numOrUndef(input.gate.minPassRate), maxFailed: numOrUndef(input.gate.maxFailed) }
    : null;
  if (input?.id) {
    const { rows } = await pool.query(
      `UPDATE api_test_plans SET name = $3, description = $4, suite_ids = $5, environment_id = $6, coverage = $7, gate = $8, updated_at = SYSUTCDATETIME()
         OUTPUT INSERTED.* WHERE tenant_id = $1 AND id = $2`,
      [tenantId, input.id, name, description, suiteIds, environmentId, coverage, gate],
    );
    if (!rows.length) throw new Error('Plan not found.');
    return toPlan(rows[0]);
  }
  const { rows } = await pool.query(
    `INSERT INTO api_test_plans (tenant_id, name, description, suite_ids, environment_id, coverage, gate, created_by)
       OUTPUT INSERTED.* VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [tenantId, name, description, suiteIds, environmentId, coverage, gate, username],
  );
  return toPlan(rows[0]);
}
export async function deletePlan(tenantId: string, id: string): Promise<boolean> {
  const { rowCount } = await pool.query(`DELETE FROM api_test_plans WHERE tenant_id = $1 AND id = $2`, [tenantId, id]);
  return rowCount > 0;
}
function numOrUndef(v: unknown): number | undefined {
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

/** Union of every endpoint across a plan's suites (de-duplicated by method+url). */
async function planEndpoints(tenantId: string, plan: TestPlan): Promise<ImportedEndpoint[]> {
  if (!plan.suiteIds.length) return [];
  const suites = await listSuites(tenantId);
  const byId = new Map(suites.map((s) => [s.id, s]));
  const seen = new Set<string>();
  const out: ImportedEndpoint[] = [];
  for (const sid of plan.suiteIds) {
    const suite = byId.get(sid);
    if (!suite) continue;
    for (const ep of suite.endpoints) {
      const key = `${(ep.method || 'GET').toUpperCase()} ${ep.url || ''}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(ep);
    }
  }
  return out;
}

// ─── cycles ───────────────────────────────────────────────────────────────

function toCycle(r: any): TestCycle {
  return {
    id: String(r.id), planId: String(r.plan_id), name: r.name || '', status: (r.status || 'planned') as CycleStatus,
    runId: r.run_id || undefined, jobId: r.job_id || undefined,
    stats: r.stats && typeof r.stats === 'object' ? r.stats : null,
    error: r.error || undefined,
    createdBy: r.created_by || '', createdAt: r.created_at, startedAt: r.started_at || undefined, finishedAt: r.finished_at || undefined,
  };
}

/** Reconcile a running cycle against its async job (lazy — on read). */
async function reconcileCycle(tenantId: string, c: TestCycle): Promise<TestCycle> {
  if (c.status !== 'running' || !c.jobId) return c;
  const job = getJob(tenantId, c.jobId);
  if (!job) return c; // job cache evicted — leave as running
  if (job.status === 'completed') {
    const res = job.result as HeadlessRunResult | undefined;
    const stats = res?.stats || null;
    const { rows } = await pool.query(
      `UPDATE api_test_cycles SET status = 'completed', run_id = $3, stats = $4, finished_at = SYSUTCDATETIME()
         OUTPUT INSERTED.* WHERE tenant_id = $1 AND id = $2`,
      [tenantId, c.id, res?.runId || null, stats],
    );
    return rows.length ? toCycle(rows[0]) : c;
  }
  if (job.status === 'failed') {
    const { rows } = await pool.query(
      `UPDATE api_test_cycles SET status = 'failed', error = $3, finished_at = SYSUTCDATETIME()
         OUTPUT INSERTED.* WHERE tenant_id = $1 AND id = $2`,
      [tenantId, c.id, String(job.error || 'Run failed.').slice(0, 2000)],
    );
    return rows.length ? toCycle(rows[0]) : c;
  }
  return c;
}

export async function listCycles(tenantId: string, planId?: string): Promise<TestCycle[]> {
  const { rows } = planId
    ? await pool.query(`SELECT * FROM api_test_cycles WHERE tenant_id = $1 AND plan_id = $2 ORDER BY created_at DESC`, [tenantId, planId])
    : await pool.query(`SELECT * FROM api_test_cycles WHERE tenant_id = $1 ORDER BY created_at DESC`, [tenantId]);
  const cycles = rows.map(toCycle);
  return Promise.all(cycles.map((c) => reconcileCycle(tenantId, c)));
}

export async function startCycle(tenantId: string, username: string, input: any): Promise<TestCycle> {
  const planId = String(input?.planId || '');
  if (!planId) throw new Error('A plan is required to start a cycle.');
  const { rows: planRows } = await pool.query(`SELECT * FROM api_test_plans WHERE tenant_id = $1 AND id = $2`, [tenantId, planId]);
  if (!planRows.length) throw new Error('Plan not found.');
  const plan = toPlan(planRows[0]);
  const endpoints = await planEndpoints(tenantId, plan);
  if (!endpoints.length) throw new Error('This plan has no endpoints — add suites with endpoints first.');

  const name = String(input?.name || '').trim().slice(0, 200) || `${plan.name} — ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`;
  const execute = input?.execute !== false;

  const { rows } = await pool.query(
    `INSERT INTO api_test_cycles (tenant_id, plan_id, name, status, created_by, started_at)
       OUTPUT INSERTED.* VALUES ($1, $2, $3, 'running', $4, SYSUTCDATETIME())`,
    [tenantId, planId, name, username],
  );
  const cycle = toCycle(rows[0]);

  const jobId = startJob(tenantId, (jid) =>
    runHeadlessApiRun(tenantId, username, {
      endpoints,
      title: name,
      coverage: plan.coverage,
      environmentId: plan.environmentId,
      execute,
      heal: true,
    }, jid),
  );
  await pool.query(`UPDATE api_test_cycles SET job_id = $3 WHERE tenant_id = $1 AND id = $2`, [tenantId, cycle.id, jobId]);
  return { ...cycle, jobId };
}

export async function deleteCycle(tenantId: string, id: string): Promise<boolean> {
  const { rowCount } = await pool.query(`DELETE FROM api_test_cycles WHERE tenant_id = $1 AND id = $2`, [tenantId, id]);
  return rowCount > 0;
}

// ─── assignments + progress ─────────────────────────────────────────────────

function toAssignment(r: any): Assignment {
  return {
    id: String(r.id), planId: String(r.plan_id), suiteId: r.suite_id ? String(r.suite_id) : undefined,
    assignee: r.assignee || '', status: (ASSIGN_STATUSES.includes(r.status) ? r.status : 'todo') as AssignmentStatus,
    notes: r.notes || '', createdBy: r.created_by || '', createdAt: r.created_at, updatedAt: r.updated_at,
  };
}
export async function listAssignments(tenantId: string, planId?: string): Promise<Assignment[]> {
  const { rows } = planId
    ? await pool.query(`SELECT * FROM api_test_assignments WHERE tenant_id = $1 AND plan_id = $2 ORDER BY created_at DESC`, [tenantId, planId])
    : await pool.query(`SELECT * FROM api_test_assignments WHERE tenant_id = $1 ORDER BY created_at DESC`, [tenantId]);
  return rows.map(toAssignment);
}
export async function saveAssignment(tenantId: string, username: string, input: any): Promise<Assignment> {
  const planId = String(input?.planId || '');
  if (!planId) throw new Error('A plan is required for an assignment.');
  const assignee = String(input?.assignee || '').trim().slice(0, 100);
  if (!assignee) throw new Error('Choose a teammate to assign.');
  const suiteId = input?.suiteId ? String(input.suiteId) : null;
  const status = ASSIGN_STATUSES.includes(input?.status) ? input.status : 'todo';
  const notes = String(input?.notes || '').slice(0, 2000);
  if (input?.id) {
    const { rows } = await pool.query(
      `UPDATE api_test_assignments SET plan_id = $3, suite_id = $4, assignee = $5, status = $6, notes = $7, updated_at = SYSUTCDATETIME()
         OUTPUT INSERTED.* WHERE tenant_id = $1 AND id = $2`,
      [tenantId, input.id, planId, suiteId, assignee, status, notes],
    );
    if (!rows.length) throw new Error('Assignment not found.');
    return toAssignment(rows[0]);
  }
  const { rows } = await pool.query(
    `INSERT INTO api_test_assignments (tenant_id, plan_id, suite_id, assignee, status, notes, created_by)
       OUTPUT INSERTED.* VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [tenantId, planId, suiteId, assignee, status, notes, username],
  );
  return toAssignment(rows[0]);
}
export async function setAssignmentStatus(tenantId: string, id: string, status: unknown): Promise<Assignment> {
  const s = ASSIGN_STATUSES.includes(String(status) as AssignmentStatus) ? (String(status) as AssignmentStatus) : null;
  if (!s) throw new Error('Invalid status.');
  const { rows } = await pool.query(
    `UPDATE api_test_assignments SET status = $3, updated_at = SYSUTCDATETIME() OUTPUT INSERTED.* WHERE tenant_id = $1 AND id = $2`,
    [tenantId, id, s],
  );
  if (!rows.length) throw new Error('Assignment not found.');
  return toAssignment(rows[0]);
}
export async function deleteAssignment(tenantId: string, id: string): Promise<boolean> {
  const { rowCount } = await pool.query(`DELETE FROM api_test_assignments WHERE tenant_id = $1 AND id = $2`, [tenantId, id]);
  return rowCount > 0;
}

export interface TenantMember { username: string; fullName: string; email: string; role: string }
export async function listTenantMembers(tenantId: string): Promise<TenantMember[]> {
  const { rows } = await pool.query(
    `SELECT username, full_name, email, role FROM users WHERE tenant_id = $1 AND is_active = 1 ORDER BY username`,
    [tenantId],
  );
  return rows.map((r: any) => ({ username: r.username || '', fullName: r.full_name || '', email: r.email || '', role: r.role || '' }));
}

export interface PlanProgress {
  planId: string; total: number;
  byStatus: Record<AssignmentStatus, number>;
  byAssignee: { assignee: string; total: number; done: number; byStatus: Record<AssignmentStatus, number> }[];
  donePct: number;
}
export async function getPlanProgress(tenantId: string, planId: string): Promise<PlanProgress> {
  const assignments = await listAssignments(tenantId, planId);
  const byStatus: Record<AssignmentStatus, number> = { todo: 0, in_progress: 0, blocked: 0, done: 0 };
  const perAssignee = new Map<string, { total: number; done: number; byStatus: Record<AssignmentStatus, number> }>();
  for (const a of assignments) {
    byStatus[a.status]++;
    let m = perAssignee.get(a.assignee);
    if (!m) { m = { total: 0, done: 0, byStatus: { todo: 0, in_progress: 0, blocked: 0, done: 0 } }; perAssignee.set(a.assignee, m); }
    m.total++; m.byStatus[a.status]++;
    if (a.status === 'done') m.done++;
  }
  const total = assignments.length;
  return {
    planId, total, byStatus,
    byAssignee: [...perAssignee.entries()].map(([assignee, m]) => ({ assignee, ...m })),
    donePct: total ? Math.round((byStatus.done / total) * 100) : 0,
  };
}
