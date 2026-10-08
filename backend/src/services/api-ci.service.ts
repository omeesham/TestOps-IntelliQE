/**
 * api-ci.service.ts
 * ─────────────────
 * First-party CI trigger — a per-tenant CI token (`cit_<40hex>`) lets a GitHub
 * Action (or any CI) start a headless API-automation run and poll it, with no
 * interactive login. The token is the capability; it resolves to a tenant and
 * launches the SAME `runHeadlessApiRun` pipeline the UI uses, then the CI job
 * gates the build on the run's pass rate.
 *
 * The public face is routes/api-ci-public.routes.ts (mounted OUTSIDE auth at
 * /api/ci). Inert until an admin mints a token under the CI / GitHub Action
 * panel. Never launches anything until a valid token calls it.
 */
import { randomBytes } from 'crypto';
import pool from '../db.js';
import { startJob, getJob } from './async-jobs.service.js';
import { runHeadlessApiRun } from './api-run.service.js';
import { normalizeEndpoints } from '../utils/endpoint-normalize.js';

export interface CiConfigView { enabled: boolean; hasToken: boolean; tokenMasked: string; triggerPath: string }

async function getRow(tenantId: string): Promise<any | null> {
  const { rows } = await pool.query(`SELECT * FROM api_ci_config WHERE tenant_id = $1`, [tenantId]);
  return rows[0] || null;
}

export async function getCiConfig(tenantId: string): Promise<CiConfigView> {
  const r = await getRow(tenantId);
  const token: string = r?.token || '';
  return {
    enabled: r ? (r.enabled === true || r.enabled === 1) : false,
    hasToken: !!token,
    tokenMasked: token ? `${token.slice(0, 8)}…${token.slice(-4)}` : '',
    triggerPath: '/api/ci',
  };
}

export async function rotateCiToken(tenantId: string, username: string): Promise<{ token: string }> {
  const token = 'cit_' + randomBytes(20).toString('hex');
  const upd = await pool.query(`UPDATE api_ci_config SET token = $2, enabled = 1, updated_at = SYSUTCDATETIME() WHERE tenant_id = $1`, [tenantId, token]);
  if (!upd.rowCount) await pool.query(`INSERT INTO api_ci_config (tenant_id, token, enabled, created_by) VALUES ($1, $2, 1, $3)`, [tenantId, token, username]);
  return { token };
}

export async function setCiEnabled(tenantId: string, enabled: boolean): Promise<CiConfigView> {
  const upd = await pool.query(`UPDATE api_ci_config SET enabled = $2, updated_at = SYSUTCDATETIME() WHERE tenant_id = $1`, [tenantId, enabled ? 1 : 0]);
  if (!upd.rowCount) await pool.query(`INSERT INTO api_ci_config (tenant_id, token, enabled) VALUES ($1, NULL, $2)`, [tenantId, enabled ? 1 : 0]);
  return getCiConfig(tenantId);
}

async function resolveCiToken(token: string): Promise<{ tenantId: string; createdBy: string } | null> {
  if (!/^cit_[a-f0-9]{40}$/.test(token || '')) return null;
  const { rows } = await pool.query(`SELECT tenant_id, created_by, enabled FROM api_ci_config WHERE token = $1`, [token]);
  const r = rows[0];
  if (!r || !(r.enabled === true || r.enabled === 1)) return null;
  return { tenantId: String(r.tenant_id), createdBy: r.created_by || 'ci' };
}

export interface CiTriggerResult { ok: boolean; jobId?: string; status?: string; pollUrl?: string; error?: string }

export async function triggerCiRun(token: string, body: any): Promise<CiTriggerResult> {
  const who = await resolveCiToken(token);
  if (!who) return { ok: false, error: 'Invalid or disabled CI token.' };
  const endpoints = normalizeEndpoints(body?.endpoints);
  if (!endpoints.length) return { ok: false, error: 'Supply an "endpoints" array (absolute http(s) URLs).' };
  const coverage = ['essential', 'standard', 'exhaustive'].includes(String(body?.coverage)) ? body.coverage : undefined;
  const input = {
    endpoints,
    title: String(body?.title || 'CI run').slice(0, 160),
    coverage,
    execute: body?.execute !== false,
    heal: body?.heal === true,
  };
  const jobId = startJob(who.tenantId, (id) => runHeadlessApiRun(who.tenantId, who.createdBy, input, id));
  return { ok: true, jobId, status: 'running', pollUrl: `/api/ci/${token}/runs/${jobId}` };
}

export interface CiRunStatus {
  ok: boolean;
  status?: 'running' | 'completed' | 'failed';
  runId?: string | null;
  stats?: { total: number; passed: number; failed: number; passRate: number } | null;
  reportUrl?: string | null;
  error?: string;
}

export async function getCiRun(token: string, jobId: string): Promise<CiRunStatus> {
  const who = await resolveCiToken(token);
  if (!who) return { ok: false, error: 'Invalid CI token.' };
  const job = getJob(who.tenantId, jobId);
  if (!job) return { ok: false, error: 'Job not found (it may have expired or the server restarted).' };
  const res: any = job.result || {};
  const s = res.stats;
  return {
    ok: true,
    status: job.status,
    runId: res.runId ?? null,
    stats: s ? { total: s.total, passed: s.passed, failed: s.failed, passRate: s.passRate } : null,
    reportUrl: res.reportUrl ?? null,
    error: job.error,
  };
}
