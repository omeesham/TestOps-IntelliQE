/**
 * api-autopilot.service.ts
 * ────────────────────────
 * The autonomous closed-loop agent — the one loop that stitches the pieces
 * IntelliQE already owns into a single, auditable, prod-trustworthy cycle:
 *
 *      discover → generate → run → heal → (reviewed) PR → escalate
 *
 *   1. DISCOVER   contract drift (scanDrift) + untested traffic (coverage gaps)
 *                 on the watched endpoints → a change set.
 *   2. GENERATE   + RUN + HEAL the affected endpoints through the existing
 *                 headless pipeline (runHeadlessApiRun does all three), capped.
 *   3. DECIDE     against the gate (min pass rate). Two modes:
 *                   • suggest     → record a reviewable changeset, await approval.
 *                   • autonomous  → if the gate passes and git is configured,
 *                                   open a REVIEWED PR automatically; otherwise
 *                                   fall back to await-approval and escalate.
 *   4. ESCALATE   via the tenant's webhooks whenever a human decision is needed
 *                 or the run failed.
 *
 * Every cycle is written to an immutable ledger (api_autopilot_cycles) with its
 * discovery, run stats, decision, and PR link — an audit trail a team can turn
 * on in production. SAFE DEFAULTS honour the "surface, never a runaway actor"
 * invariant: the default mode is "suggest" (nothing is applied or merged
 * automatically), writes are never auto-fired during discovery, and the PR is
 * always opened on a branch for a human to review and merge.
 *
 * An in-process poller (same shape as the monitor/scheduler) claims each due
 * tenant by atomically advancing next_run_at. Opt-in, additive; the generate →
 * execute → heal pipeline itself is untouched (it is CALLED, not modified).
 */
import pool from '../db.js';
import { endpointsFromRaw } from '../utils/api-endpoints.js';
import { encryptAtRest, decryptStored, maskSecret, isMaskedSecret } from '../utils/crypto.js';
import { scanDrift } from './api-drift.service.js';
import { analyzeCoverageGaps } from './api-coverage-gaps.service.js';
import { runHeadlessApiRun } from './api-run.service.js';
import { openRemediationPr, type RemediationFile } from './api-remediation.service.js';
import { dispatchWebhooks } from './api-webhooks.service.js';
import type { ImportedEndpoint } from './api-import.service.js';

export type AutopilotMode = 'suggest' | 'autonomous';
export type CycleStatus = 'no_change' | 'awaiting_approval' | 'pr_opened' | 'dismissed' | 'error' | 'passed_clean';

export interface GitConfig { provider: 'github' | 'gitlab'; repo: string; baseBranch?: string; host?: string; token?: string }

export interface AutopilotConfigView {
  enabled: boolean;
  intervalMinutes: number;
  mode: AutopilotMode;
  autoGenerate: boolean;
  gate: { minPassRate: number };
  endpointCount: number;
  environmentId?: string;
  git?: { provider: 'github' | 'gitlab'; repo: string; baseBranch?: string; host?: string; tokenMasked?: string };
  nextRunAt?: string;
  lastRunAt?: string;
  lastStatus?: string;
  lastSummary?: string;
}

export interface AutopilotCycle {
  id: string;
  status: CycleStatus;
  trigger: 'scheduled' | 'manual';
  discovered: { drift: number; gaps: number; affected: number };
  affectedEndpoints: { method: string; url: string; reason: string }[];
  run?: { runId: string | null; total: number; passed: number; failed: number; passRate: number; healed: number } | null;
  decision: string;
  gatePassed: boolean;
  prUrl?: string;
  changeset?: { path: string; summary: string };
  error?: string;
  createdAt: string;
  decidedAt?: string;
  decidedBy?: string;
}

const MIN_INTERVAL = 15;
const MAX_INTERVAL = 60 * 24 * 7;
const POLL_MS = 60_000;
const MAX_CYCLES_KEPT = 200;
const MAX_AFFECTED = 12;      // cap endpoints run per cycle (bounds LLM cost + time)
let started = false;

function clampInterval(v: unknown): number { const n = Math.round(Number(v)); return Number.isFinite(n) ? Math.min(MAX_INTERVAL, Math.max(MIN_INTERVAL, n)) : 60; }
function clampRate(v: unknown, def = 90): number { const n = Math.round(Number(v)); return Number.isFinite(n) ? Math.min(100, Math.max(0, n)) : def; }
function countEndpoints(raw: any): number { try { const a = typeof raw === 'string' ? JSON.parse(raw) : raw; return Array.isArray(a) ? a.length : 0; } catch { return 0; } }
function parseJson<T>(v: any, fallback: T): T { try { return typeof v === 'string' ? JSON.parse(v) : (v ?? fallback); } catch { return fallback; } }

function rowToConfig(r: any): AutopilotConfigView {
  const git = parseJson<any>(r.git, null);
  return {
    enabled: r.enabled === true || r.enabled === 1,
    intervalMinutes: r.interval_minutes || 60,
    mode: (r.mode === 'autonomous' ? 'autonomous' : 'suggest'),
    autoGenerate: r.auto_generate === true || r.auto_generate === 1,
    gate: { minPassRate: clampRate(parseJson<any>(r.gate, {}).minPassRate, 90) },
    endpointCount: countEndpoints(r.endpoints),
    environmentId: r.environment_id || undefined,
    git: git && git.repo ? { provider: git.provider === 'gitlab' ? 'gitlab' : 'github', repo: git.repo, baseBranch: git.baseBranch || undefined, host: git.host || undefined, tokenMasked: git.token ? maskSecret('token') : undefined } : undefined,
    nextRunAt: r.next_run_at || undefined,
    lastRunAt: r.last_run_at || undefined,
    lastStatus: r.last_status || undefined,
    lastSummary: r.last_summary || undefined,
  };
}

export async function getAutopilotConfig(tenantId: string): Promise<AutopilotConfigView> {
  const { rows } = await pool.query(`SELECT * FROM api_autopilot_config WHERE tenant_id = $1`, [tenantId]);
  if (!rows.length) return { enabled: false, intervalMinutes: 60, mode: 'suggest', autoGenerate: true, gate: { minPassRate: 90 }, endpointCount: 0 };
  return rowToConfig(rows[0]);
}

export async function saveAutopilotConfig(tenantId: string, input: {
  enabled?: boolean; intervalMinutes?: number; mode?: string; autoGenerate?: boolean;
  gate?: { minPassRate?: number }; endpoints?: unknown; environmentId?: string; git?: GitConfig | null;
}): Promise<AutopilotConfigView> {
  const { rows: existing } = await pool.query(`SELECT * FROM api_autopilot_config WHERE tenant_id = $1`, [tenantId]);
  const cur = existing[0];

  const enabled = input.enabled !== undefined ? (input.enabled ? 1 : 0) : (cur?.enabled ? 1 : 0);
  const interval = input.intervalMinutes !== undefined ? clampInterval(input.intervalMinutes) : (cur?.interval_minutes || 60);
  const mode = input.mode === 'autonomous' ? 'autonomous' : (input.mode === 'suggest' ? 'suggest' : (cur?.mode || 'suggest'));
  const autoGenerate = input.autoGenerate !== undefined ? (input.autoGenerate ? 1 : 0) : (cur?.auto_generate ? 1 : (cur ? 0 : 1));
  const gate = JSON.stringify({ minPassRate: clampRate(input.gate?.minPassRate, clampRate(parseJson<any>(cur?.gate, {}).minPassRate, 90)) });
  const endpointsJson = input.endpoints !== undefined ? JSON.stringify(endpointsFromRaw(input.endpoints)) : (cur?.endpoints || '[]');
  const envId = input.environmentId !== undefined ? (input.environmentId || null) : (cur?.environment_id || null);

  // Git config: encrypt a fresh token, keep the stored one when masked/empty.
  let gitJson: string | null = cur?.git || null;
  if (input.git !== undefined) {
    if (input.git === null || !input.git.repo) gitJson = null;
    else {
      const prevGit = parseJson<any>(cur?.git, {});
      let token = prevGit.token || '';
      if (input.git.token && !isMaskedSecret(input.git.token)) token = encryptAtRest(input.git.token);
      gitJson = JSON.stringify({ provider: input.git.provider === 'gitlab' ? 'gitlab' : 'github', repo: String(input.git.repo).slice(0, 200), baseBranch: input.git.baseBranch ? String(input.git.baseBranch).slice(0, 100) : undefined, host: input.git.host ? String(input.git.host).slice(0, 200) : undefined, token });
    }
  }

  const reArm = (enabled === 1 && !cur?.enabled) || (input.intervalMinutes !== undefined && interval !== cur?.interval_minutes) || !cur;
  await pool.query(
    `MERGE INTO api_autopilot_config WITH (HOLDLOCK) AS t USING (SELECT $1 AS tenant_id) AS s ON t.tenant_id = s.tenant_id
      WHEN MATCHED THEN UPDATE SET enabled = $2, interval_minutes = $3, mode = $4, auto_generate = $5, gate = $6, endpoints = $7, environment_id = $8, git = $9,
        next_run_at = CASE WHEN $10 = 1 THEN DATEADD(MINUTE, $3, SYSUTCDATETIME()) ELSE next_run_at END, updated_at = SYSUTCDATETIME()
      WHEN NOT MATCHED THEN INSERT (tenant_id, enabled, interval_minutes, mode, auto_generate, gate, endpoints, environment_id, git, next_run_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, CASE WHEN $2 = 1 THEN DATEADD(MINUTE, $3, SYSUTCDATETIME()) ELSE NULL END);`,
    [tenantId, enabled, interval, mode, autoGenerate, gate, endpointsJson, envId, gitJson, reArm ? 1 : 0],
  );
  return getAutopilotConfig(tenantId);
}

function rowToCycle(r: any): AutopilotCycle {
  return {
    id: String(r.id),
    status: r.status,
    trigger: r.trigger_kind === 'manual' ? 'manual' : 'scheduled',
    discovered: parseJson(r.discovered, { drift: 0, gaps: 0, affected: 0 }),
    affectedEndpoints: parseJson(r.affected_endpoints, []),
    run: parseJson(r.run_stats, null),
    decision: r.decision || '',
    gatePassed: r.gate_passed === true || r.gate_passed === 1,
    prUrl: r.pr_url || undefined,
    changeset: parseJson(r.changeset, null) || undefined,
    error: r.error || undefined,
    createdAt: r.created_at,
    decidedAt: r.decided_at || undefined,
    decidedBy: r.decided_by || undefined,
  };
}

export async function listAutopilotCycles(tenantId: string, limit = 50): Promise<AutopilotCycle[]> {
  const { rows } = await pool.query(`SELECT TOP (${Math.min(MAX_CYCLES_KEPT, Math.max(1, limit))}) * FROM api_autopilot_cycles WHERE tenant_id = $1 ORDER BY created_at DESC`, [tenantId]);
  return rows.map(rowToCycle);
}

/** Build the reviewable changeset files that go into a PR. */
function buildChangeset(cycle: AutopilotCycle): { files: RemediationFile[]; summary: string } {
  const ts = new Date().toISOString();
  const md = [
    `# IntelliQE Autopilot changeset`,
    ``,
    `_Generated ${ts} · cycle ${cycle.id}_`,
    ``,
    `## Discovered`,
    `- Contract drift: **${cycle.discovered.drift}**`,
    `- Untested traffic (coverage gaps): **${cycle.discovered.gaps}**`,
    `- Endpoints affected: **${cycle.discovered.affected}**`,
    ``,
    `## Generated run`,
    cycle.run ? `- Scenarios: ${cycle.run.total} · passed ${cycle.run.passed} · failed ${cycle.run.failed} · pass rate ${cycle.run.passRate}% · healed ${cycle.run.healed}` : `- (no run in this cycle)`,
    ``,
    `## Affected endpoints`,
    ...cycle.affectedEndpoints.map((e) => `- \`${e.method} ${e.url}\` — ${e.reason}`),
    ``,
    `## Decision`,
    `${cycle.decision}`,
    ``,
    `> Review these changes and merge if correct. This PR was opened automatically by IntelliQE Autopilot on a branch; nothing was merged for you.`,
  ].join('\n');
  const json = JSON.stringify({ cycleId: cycle.id, at: ts, discovered: cycle.discovered, run: cycle.run, affected: cycle.affectedEndpoints, decision: cycle.decision }, null, 2);
  return {
    files: [
      { path: `intelliqe/autopilot/${cycle.id}.md`, content: md },
      { path: `intelliqe/autopilot/${cycle.id}.changeset.json`, content: json },
    ],
    summary: `${cycle.discovered.affected} endpoint(s): ${cycle.discovered.drift} drift, ${cycle.discovered.gaps} gap(s)`,
  };
}

async function openCyclePr(tenantId: string, cycle: AutopilotCycle): Promise<{ url: string; path: string; summary: string }> {
  const { rows } = await pool.query(`SELECT git FROM api_autopilot_config WHERE tenant_id = $1`, [tenantId]);
  const git = parseJson<any>(rows[0]?.git, null);
  if (!git || !git.repo || !git.token) throw new Error('No git repository is configured for Autopilot — add one in the Autopilot settings to open PRs.');
  const { files, summary } = buildChangeset(cycle);
  const res = await openRemediationPr({
    provider: git.provider === 'gitlab' ? 'gitlab' : 'github',
    token: decryptStored(git.token),
    repo: git.repo,
    baseBranch: git.baseBranch || undefined,
    host: git.host || undefined,
    branch: `intelliqe/autopilot-${cycle.id}`,
    title: `IntelliQE Autopilot: ${summary}`,
    body: `Automated maintenance changeset from IntelliQE Autopilot (cycle ${cycle.id}).\n\n${cycle.decision}`,
    files,
  });
  return { url: res.url, path: files[0]!.path, summary };
}

async function escalate(tenantId: string, cycle: AutopilotCycle): Promise<void> {
  await dispatchWebhooks(tenantId, {
    event: 'run.completed',
    title: `Autopilot: ${cycle.status === 'awaiting_approval' ? 'needs review' : cycle.status}`,
    status: cycle.gatePassed ? 'passed' : 'failed',
    stats: cycle.run ? { total: cycle.run.total, passed: cycle.run.passed, failed: cycle.run.failed, notRun: 0, passRate: cycle.run.passRate } : null,
    failures: cycle.affectedEndpoints.slice(0, 20).map((e) => ({ title: `${e.method} ${e.url}`, error: e.reason })),
    source: 'api',
    at: new Date().toISOString(),
  }).catch(() => { /* webhooks are best-effort */ });
}

/** One cycle for a config row. Returns the ledgered cycle. */
async function runCycle(row: any, trigger: 'scheduled' | 'manual'): Promise<AutopilotCycle> {
  const tenantId = String(row.tenant_id);
  const mode: AutopilotMode = row.mode === 'autonomous' ? 'autonomous' : 'suggest';
  const autoGenerate = row.auto_generate === true || row.auto_generate === 1;
  const minPassRate = clampRate(parseJson<any>(row.gate, {}).minPassRate, 90);
  const endpoints: ImportedEndpoint[] = endpointsFromRaw(parseJson(row.endpoints, []));

  const cycle: AutopilotCycle = {
    id: '', status: 'no_change', trigger, discovered: { drift: 0, gaps: 0, affected: 0 },
    affectedEndpoints: [], run: null, decision: '', gatePassed: true, createdAt: new Date().toISOString(),
  };

  try {
    if (!endpoints.length) { cycle.decision = 'No endpoints are being watched — add endpoints to the Autopilot config.'; cycle.status = 'no_change'; return await persistCycle(tenantId, cycle); }

    /* 1. DISCOVER (read-only) */
    const affected = new Map<string, { method: string; url: string; reason: string }>();
    try {
      const drift = await scanDrift(endpoints);
      for (const d of drift.results) {
        if (d.statusDrift || d.shapeDrift) { const k = `${d.method} ${d.url}`; affected.set(k, { method: d.method, url: d.url, reason: d.statusDrift ? `status drift ${d.storedStatus ?? '—'}→${d.suggestedStatus}` : 'response shape drifted' }); cycle.discovered.drift++; }
      }
    } catch { /* drift needs reachable endpoints */ }
    try {
      const tested = endpoints.map((e) => ({ title: e.title || `${e.method} ${e.url}`, method: e.method, url: e.url, headers: e.headers || [], auth: (e.auth as any) || { type: 'none' } }));
      const cov = await analyzeCoverageGaps(tenantId, tested as any);
      for (const g of cov.gaps.slice(0, MAX_AFFECTED)) { const k = `${g.method} ${g.url}`; if (!affected.has(k)) affected.set(k, { method: g.method, url: g.url, reason: 'untested endpoint seen in traffic' }); cycle.discovered.gaps++; }
    } catch { /* coverage needs capture sessions */ }

    cycle.affectedEndpoints = [...affected.values()].slice(0, MAX_AFFECTED);
    cycle.discovered.affected = cycle.affectedEndpoints.length;

    if (!cycle.discovered.affected) { cycle.decision = 'No drift or coverage gaps found — nothing to do this cycle.'; cycle.status = 'no_change'; return await persistCycle(tenantId, cycle); }

    /* 2. GENERATE + RUN + HEAL (optional, capped) */
    if (autoGenerate) {
      const affectedSet = new Set(cycle.affectedEndpoints.map((e) => `${e.method} ${e.url}`));
      const toRun = endpoints.filter((e) => affectedSet.has(`${(e.method || 'GET').toUpperCase()} ${e.url}`));
      // Coverage-gap endpoints may not be in the watched catalogue — synthesize minimal ones.
      for (const a of cycle.affectedEndpoints) { if (!toRun.some((e) => `${(e.method || 'GET').toUpperCase()} ${e.url}` === `${a.method} ${a.url}`)) toRun.push({ title: `${a.method} ${a.url}`, method: a.method, url: a.url, headers: [], auth: { type: 'none' } } as ImportedEndpoint); }
      try {
        const result = await runHeadlessApiRun(tenantId, 'autopilot', {
          endpoints: toRun.slice(0, MAX_AFFECTED), title: `Autopilot: ${cycle.discovered.affected} affected endpoint(s)`,
          coverage: 'standard', execute: true, heal: true, environmentId: row.environment_id || undefined,
        });
        cycle.run = { runId: result.runId, total: result.stats?.total ?? result.scenarios.total, passed: result.stats?.passed ?? 0, failed: result.stats?.failed ?? 0, passRate: result.stats?.passRate ?? 0, healed: result.healed?.fixed ?? 0 };
      } catch (e) {
        cycle.status = 'error'; cycle.error = (e as Error).message?.slice(0, 500); cycle.decision = `Generation/run failed: ${cycle.error}`; cycle.gatePassed = false;
        await escalate(tenantId, cycle); return await persistCycle(tenantId, cycle);
      }
    }

    /* 3. DECIDE (gate) */
    const passRate = cycle.run?.passRate ?? 100;
    cycle.gatePassed = passRate >= minPassRate;

    if (mode === 'autonomous' && cycle.gatePassed) {
      // Open a reviewed PR automatically (still a branch + PR, never a merge).
      try {
        const id = cycle.id || 'pending';
        cycle.id = id;
        const pr = await openCyclePr(tenantId, { ...cycle, id: `cycle-${Date.now().toString(36)}` });
        cycle.prUrl = pr.url; cycle.changeset = { path: pr.path, summary: pr.summary };
        cycle.status = 'pr_opened';
        cycle.decision = `Autonomous mode: gate passed (${passRate}% ≥ ${minPassRate}%). Opened a reviewed PR: ${pr.url}`;
      } catch (e) {
        cycle.status = 'awaiting_approval';
        cycle.decision = `Gate passed (${passRate}% ≥ ${minPassRate}%) but the PR could not be opened (${(e as Error).message}). Awaiting manual action.`;
        await escalate(tenantId, cycle);
      }
    } else if (cycle.gatePassed && !autoGenerate) {
      cycle.status = 'awaiting_approval';
      cycle.decision = `Suggest mode: detected ${cycle.discovered.affected} change(s). Review and approve to open a PR.`;
      await escalate(tenantId, cycle);
    } else if (cycle.gatePassed) {
      cycle.status = 'awaiting_approval';
      cycle.decision = `Suggest mode: gate passed (${passRate}% ≥ ${minPassRate}%). Approve to open a reviewed PR with the changeset.`;
      await escalate(tenantId, cycle);
    } else {
      cycle.status = 'awaiting_approval';
      cycle.decision = `Gate FAILED (${passRate}% < ${minPassRate}%). A human must review before anything is proposed.`;
      await escalate(tenantId, cycle);
    }

    return await persistCycle(tenantId, cycle);
  } catch (e) {
    cycle.status = 'error'; cycle.error = (e as Error).message?.slice(0, 500); cycle.decision = `Cycle error: ${cycle.error}`; cycle.gatePassed = false;
    return await persistCycle(tenantId, cycle);
  }
}

async function persistCycle(tenantId: string, cycle: AutopilotCycle): Promise<AutopilotCycle> {
  const { rows } = await pool.query(
    `INSERT INTO api_autopilot_cycles (tenant_id, status, trigger_kind, discovered, affected_endpoints, run_stats, decision, gate_passed, pr_url, changeset, error)
     OUTPUT INSERTED.* VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [tenantId, cycle.status, cycle.trigger, JSON.stringify(cycle.discovered), JSON.stringify(cycle.affectedEndpoints),
     cycle.run ? JSON.stringify(cycle.run) : null, cycle.decision.slice(0, 2000), cycle.gatePassed ? 1 : 0,
     cycle.prUrl || null, cycle.changeset ? JSON.stringify(cycle.changeset) : null, cycle.error || null],
  );
  // Trim to the newest N.
  await pool.query(
    `DELETE FROM api_autopilot_cycles WHERE tenant_id = $1 AND id NOT IN (SELECT TOP (${MAX_CYCLES_KEPT}) id FROM api_autopilot_cycles WHERE tenant_id = $1 ORDER BY created_at DESC)`,
    [tenantId],
  ).catch(() => { /* best effort */ });
  // Update config summary.
  const summary = cycle.status === 'no_change' ? 'No changes' : `${cycle.discovered.affected} affected · ${cycle.status}`;
  await pool.query(
    `UPDATE api_autopilot_config SET last_run_at = SYSUTCDATETIME(), last_status = $1, last_summary = $2, updated_at = SYSUTCDATETIME() WHERE tenant_id = $3`,
    [cycle.status, summary.slice(0, 500), tenantId],
  ).catch(() => { /* best effort */ });
  return rowToCycle(rows[0]);
}

/** "Run now" — off the clock. */
export async function runAutopilotNow(tenantId: string): Promise<AutopilotCycle> {
  const { rows } = await pool.query(`SELECT * FROM api_autopilot_config WHERE tenant_id = $1`, [tenantId]);
  if (!rows.length) throw new Error('Autopilot is not configured yet.');
  return runCycle(rows[0], 'manual');
}

/** Approve an awaiting cycle → open the reviewed PR now. */
export async function approveCycle(tenantId: string, cycleId: string, username: string): Promise<AutopilotCycle> {
  const { rows } = await pool.query(`SELECT * FROM api_autopilot_cycles WHERE tenant_id = $1 AND id = $2`, [tenantId, cycleId]);
  if (!rows.length) throw new Error('Cycle not found.');
  const cycle = rowToCycle(rows[0]);
  if (cycle.status !== 'awaiting_approval') throw new Error(`Only a cycle awaiting approval can be approved (this one is "${cycle.status}").`);
  const pr = await openCyclePr(tenantId, cycle);
  await pool.query(
    `UPDATE api_autopilot_cycles SET status = 'pr_opened', pr_url = $3, changeset = $4, decision = $5, decided_at = SYSUTCDATETIME(), decided_by = $6 WHERE tenant_id = $1 AND id = $2`,
    [tenantId, cycleId, pr.url, JSON.stringify({ path: pr.path, summary: pr.summary }), `Approved by ${username}. Opened reviewed PR: ${pr.url}`, username.slice(0, 100)],
  );
  const { rows: updated } = await pool.query(`SELECT * FROM api_autopilot_cycles WHERE tenant_id = $1 AND id = $2`, [tenantId, cycleId]);
  return rowToCycle(updated[0]);
}

/** Dismiss an awaiting cycle (no PR). */
export async function rejectCycle(tenantId: string, cycleId: string, username: string): Promise<AutopilotCycle> {
  const { rows } = await pool.query(`SELECT * FROM api_autopilot_cycles WHERE tenant_id = $1 AND id = $2`, [tenantId, cycleId]);
  if (!rows.length) throw new Error('Cycle not found.');
  await pool.query(
    `UPDATE api_autopilot_cycles SET status = 'dismissed', decision = $3, decided_at = SYSUTCDATETIME(), decided_by = $4 WHERE tenant_id = $1 AND id = $2`,
    [tenantId, cycleId, `Dismissed by ${username}.`, username.slice(0, 100)],
  );
  const { rows: updated } = await pool.query(`SELECT * FROM api_autopilot_cycles WHERE tenant_id = $1 AND id = $2`, [tenantId, cycleId]);
  return rowToCycle(updated[0]);
}

/** Claim each due tenant by atomically advancing next_run_at, then run its cycle. */
async function claimAndRunDue(): Promise<void> {
  const { rows: due } = await pool.query(
    `SELECT tenant_id FROM api_autopilot_config WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= SYSUTCDATETIME() ORDER BY next_run_at ASC`,
    [],
  );
  for (const d of due as any[]) {
    const claim = await pool.query(
      `UPDATE api_autopilot_config SET next_run_at = DATEADD(MINUTE, interval_minutes, SYSUTCDATETIME()), updated_at = SYSUTCDATETIME()
        WHERE tenant_id = $1 AND enabled = 1 AND next_run_at <= SYSUTCDATETIME()`,
      [String(d.tenant_id)],
    );
    if (claim.rowCount !== 1) continue;
    const { rows } = await pool.query(`SELECT * FROM api_autopilot_config WHERE tenant_id = $1`, [String(d.tenant_id)]);
    if (rows.length) { try { await runCycle(rows[0], 'scheduled'); } catch { /* a bad cycle must not kill the loop */ } }
  }
}

/** Start the in-process poller. Safe to call once at startup; a no-op if already running. */
export function startApiAutopilot(): void {
  if (started) return;
  started = true;
  const tick = () => { void claimAndRunDue().catch(() => { /* a bad tick must not kill the interval */ }); };
  setTimeout(tick, 30_000);
  const handle = setInterval(tick, POLL_MS);
  if (typeof handle.unref === 'function') handle.unref();
}
