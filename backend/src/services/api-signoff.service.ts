/**
 * api-signoff.service.ts
 * ──────────────────────
 * Phase 3 of the requirement-first flow (checklist item 4): a feature is done
 * only when it has been tested and SIGNED OFF in a customer-similar
 * environment.
 *
 * A sign-off is an attestation against one finished run: who signed it, which
 * environment it ran in, when, and whether that run was green. The environment
 * name, its customer-similar flag and the run's pass rate are SNAPSHOT onto the
 * record — an attestation has to keep saying what was true when it was made,
 * even if the environment is later renamed, re-flagged or deleted.
 *
 * The release gate reads `latestSignoffForRun` and can refuse to let a release
 * through without a green one. Additive: its own table, reads run reports only.
 */
import pool from '../db.js';
import { getApiRunDetail } from './api-dashboard.service.js';
import { getEnvironment } from './api-environments.service.js';

export type SignoffResult = 'pass' | 'fail';

export interface Signoff {
  id: string;
  runId: string;
  runTitle: string;
  environmentId: string;
  environmentName: string;
  /** Was that environment marked customer-similar at the time of signing. */
  customerLike: boolean;
  result: SignoffResult;
  passRate: number;
  note: string;
  signedBy: string;
  signedAt: string;
}

function mapSignoff(r: any): Signoff {
  return {
    id: String(r.id),
    runId: r.run_id || '',
    runTitle: r.run_title || '',
    environmentId: r.environment_id || '',
    environmentName: r.environment_name || '',
    customerLike: r.customer_like === true || r.customer_like === 1,
    result: (r.result === 'pass' ? 'pass' : 'fail') as SignoffResult,
    passRate: Number(r.pass_rate) || 0,
    note: r.note || '',
    signedBy: r.signed_by || '',
    signedAt: r.signed_at,
  };
}

export async function listSignoffs(tenantId: string, runId?: string): Promise<Signoff[]> {
  const { rows } = runId
    ? await pool.query(`SELECT * FROM api_signoffs WHERE tenant_id = $1 AND run_id = $2 ORDER BY signed_at DESC`, [tenantId, runId])
    : await pool.query(`SELECT * FROM api_signoffs WHERE tenant_id = $1 ORDER BY signed_at DESC`, [tenantId]);
  return rows.map(mapSignoff);
}

/** The most recent sign-off for a run — what the release gate grades against. */
export async function latestSignoffForRun(tenantId: string, runId: string): Promise<Signoff | null> {
  const list = await listSignoffs(tenantId, runId);
  return list[0] || null;
}

/**
 * Sign off a finished run in a given environment.
 *
 * The result is DERIVED from the run, never supplied by the caller: a run with
 * any failed or broken case is signed off as `fail`. Recording a failing
 * sign-off is allowed — it is a real audit event — but the release gate only
 * accepts a green one, so it cannot be used to wave a bad run through.
 */
export async function createSignoff(
  tenantId: string,
  username: string,
  input: { runId: string; environmentId: string; note?: string },
): Promise<Signoff> {
  const runId = String(input?.runId || '').trim();
  if (!runId) throw new Error('A sign-off needs a finished run.');
  const run = await getApiRunDetail(tenantId, runId);
  if (!run) throw new Error('Run not found.');

  const environmentId = String(input?.environmentId || '').trim();
  if (!environmentId) throw new Error('A sign-off needs the environment the run was verified in.');
  const env = await getEnvironment(tenantId, environmentId);
  if (!env) throw new Error('Environment not found.');

  const stats = run.stats;
  const passRate = Math.max(0, Math.min(100, Math.round(stats?.passRate ?? 0)));
  const green = (stats?.failed ?? 0) === 0 && (stats?.broken ?? 0) === 0 && (stats?.total ?? 0) > 0;
  const result: SignoffResult = green ? 'pass' : 'fail';
  const note = String(input?.note || '').slice(0, 2000);

  const { rows } = await pool.query(
    `INSERT INTO api_signoffs (tenant_id, run_id, run_title, environment_id, environment_name, customer_like, result, pass_rate, note, signed_by)
       OUTPUT INSERTED.* VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [tenantId, runId, String(run.title || '').slice(0, 500), environmentId, env.name.slice(0, 200),
     env.customerLike ? 1 : 0, result, passRate, note, username],
  );
  return mapSignoff(rows[0]);
}

export async function deleteSignoff(tenantId: string, id: string): Promise<boolean> {
  const { rowCount } = await pool.query(`DELETE FROM api_signoffs WHERE tenant_id = $1 AND id = $2`, [tenantId, id]);
  return (rowCount || 0) > 0;
}
