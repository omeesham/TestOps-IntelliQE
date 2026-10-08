/**
 * api-release-gate.service.ts
 * ───────────────────────────
 * Agentic release gate — a go / no-go deploy decision computed from a finished
 * run. A policy sets thresholds (min pass rate, max failed/broken, min
 * confidence, no-new-failures, no high-severity failures); evaluation reads the
 * run's stats + the dashboard's anomaly signals, derives a 0–100 confidence
 * score, and returns the verdict with a per-check breakdown and the reasons any
 * check blocked.
 *
 * Additive and opt-in: its own policy table; reads existing run reports only,
 * never mutates a run and never touches the pipeline.
 */
import pool from '../db.js';
import { getApiRunDetail, getApiOverview } from './api-dashboard.service.js';

export interface GatePolicy {
  id: string;
  name: string;
  minPassRate: number;
  maxFailed: number;
  maxBroken: number;
  minConfidence: number;
  requireNoNewFailures: boolean;
  blockOnHighSeverityFail: boolean;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

function mapPolicy(r: any): GatePolicy {
  return {
    id: String(r.id), name: r.name,
    minPassRate: Number(r.min_pass_rate), maxFailed: Number(r.max_failed), maxBroken: Number(r.max_broken),
    minConfidence: Number(r.min_confidence),
    requireNoNewFailures: r.require_no_new_failures === true || r.require_no_new_failures === 1,
    blockOnHighSeverityFail: r.block_high_sev === true || r.block_high_sev === 1,
    createdBy: r.created_by || '', createdAt: r.created_at, updatedAt: r.updated_at,
  };
}
function clampPct(n: unknown, def: number): number {
  const v = Math.round(Number(n));
  return Number.isFinite(v) ? Math.max(0, Math.min(100, v)) : def;
}
function clampCount(n: unknown, def: number): number {
  const v = Math.round(Number(n));
  return Number.isFinite(v) ? Math.max(0, Math.min(100000, v)) : def;
}

export async function listGatePolicies(tenantId: string): Promise<GatePolicy[]> {
  const { rows } = await pool.query(`SELECT * FROM api_release_gates WHERE tenant_id = $1 ORDER BY updated_at DESC`, [tenantId]);
  return rows.map(mapPolicy);
}
export async function saveGatePolicy(tenantId: string, username: string, input: any): Promise<GatePolicy> {
  const name = String(input?.name || '').trim().slice(0, 200) || 'Release gate';
  const minPassRate = clampPct(input?.minPassRate, 80);
  const maxFailed = clampCount(input?.maxFailed, 0);
  const maxBroken = clampCount(input?.maxBroken, 0);
  const minConfidence = clampPct(input?.minConfidence, 70);
  const noNew = input?.requireNoNewFailures ? 1 : 0;
  const blockHigh = input?.blockOnHighSeverityFail ? 1 : 0;
  if (input?.id) {
    const { rows } = await pool.query(
      `UPDATE api_release_gates SET name = $3, min_pass_rate = $4, max_failed = $5, max_broken = $6, min_confidence = $7, require_no_new_failures = $8, block_high_sev = $9, updated_at = SYSUTCDATETIME() OUTPUT INSERTED.* WHERE tenant_id = $1 AND id = $2`,
      [tenantId, input.id, name, minPassRate, maxFailed, maxBroken, minConfidence, noNew, blockHigh],
    );
    if (!rows.length) throw new Error('Release gate not found.');
    return mapPolicy(rows[0]);
  }
  const { rows } = await pool.query(
    `INSERT INTO api_release_gates (tenant_id, name, min_pass_rate, max_failed, max_broken, min_confidence, require_no_new_failures, block_high_sev, created_by) OUTPUT INSERTED.* VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [tenantId, name, minPassRate, maxFailed, maxBroken, minConfidence, noNew, blockHigh, username],
  );
  return mapPolicy(rows[0]);
}
export async function deleteGatePolicy(tenantId: string, id: string): Promise<boolean> {
  const { rowCount } = await pool.query(`DELETE FROM api_release_gates WHERE tenant_id = $1 AND id = $2`, [tenantId, id]);
  return rowCount > 0;
}

export interface GateCheck { label: string; pass: boolean; actual: number | string; threshold: number | string }
export interface GateResult {
  decision: 'go' | 'no-go';
  score: number;
  runId: string;
  title: string;
  stats: { total: number; passed: number; failed: number; broken: number; passRate: number } | null;
  checks: GateCheck[];
  reasons: string[];
  anomalies: { flaky: number; slow: number; newFailure: number };
}

export async function evaluateGate(
  tenantId: string,
  input: { runId: string; policyId?: string; thresholds?: Partial<GatePolicy> },
): Promise<GateResult> {
  const run = await getApiRunDetail(tenantId, String(input?.runId || ''));
  if (!run) throw new Error('Run not found.');

  let policy: GatePolicy | null = null;
  if (input?.policyId) policy = (await listGatePolicies(tenantId)).find((p) => p.id === input.policyId) || null;
  const t = {
    minPassRate: 80, maxFailed: 0, maxBroken: 0, minConfidence: 70, requireNoNewFailures: false, blockOnHighSeverityFail: false,
    ...(policy ? { minPassRate: policy.minPassRate, maxFailed: policy.maxFailed, maxBroken: policy.maxBroken, minConfidence: policy.minConfidence, requireNoNewFailures: policy.requireNoNewFailures, blockOnHighSeverityFail: policy.blockOnHighSeverityFail } : {}),
    ...(input?.thresholds || {}),
  };

  const stats = run.stats;
  const passRate = stats?.passRate ?? 0;
  const failed = stats?.failed ?? 0;
  const broken = stats?.broken ?? 0;

  const highSevFails = (run.cases || []).filter((c) => c.status === 'failed' && /high|critical|p1|blocker|sev-?1/i.test(String(c.priority || ''))).length;

  const overview = await getApiOverview(tenantId).catch(() => null);
  const anomalies = { flaky: 0, slow: 0, newFailure: 0 };
  for (const a of overview?.anomalies || []) {
    if (a.kind === 'flaky') anomalies.flaky++;
    else if (a.kind === 'slow') anomalies.slow++;
    else if (a.kind === 'new-failure') anomalies.newFailure++;
  }

  // Confidence score (0–100): pass rate penalised by broken specs, flakiness,
  // high-severity failures and newly-regressed tests.
  let score = passRate - broken * 3 - anomalies.flaky * 2 - highSevFails * 5 - anomalies.newFailure * 4;
  score = Math.max(0, Math.min(100, Math.round(score)));

  const checks: GateCheck[] = [
    { label: 'Pass rate at or above minimum', pass: passRate >= t.minPassRate, actual: `${passRate}%`, threshold: `${t.minPassRate}%` },
    { label: 'Failed at or below maximum', pass: failed <= t.maxFailed, actual: failed, threshold: t.maxFailed },
    { label: 'Broken at or below maximum', pass: broken <= t.maxBroken, actual: broken, threshold: t.maxBroken },
    { label: 'Confidence at or above minimum', pass: score >= t.minConfidence, actual: score, threshold: t.minConfidence },
  ];
  if (t.requireNoNewFailures) checks.push({ label: 'No newly-failing tests', pass: anomalies.newFailure === 0, actual: anomalies.newFailure, threshold: 0 });
  if (t.blockOnHighSeverityFail) checks.push({ label: 'No high-severity failures', pass: highSevFails === 0, actual: highSevFails, threshold: 0 });

  const blocked = checks.filter((c) => !c.pass);
  return {
    decision: blocked.length === 0 ? 'go' : 'no-go',
    score,
    runId: run.runId,
    title: run.title,
    stats: stats ? { total: stats.total, passed: stats.passed, failed: stats.failed, broken: stats.broken, passRate: stats.passRate } : null,
    checks,
    reasons: blocked.map((c) => `${c.label}: ${c.actual} (needs ${c.threshold})`),
    anomalies,
  };
}
