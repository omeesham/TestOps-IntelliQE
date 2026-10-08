/**
 * api-testintel.service.ts
 * ────────────────────────
 * Test intelligence: (1) FLAKY detection — replays recent runs and flags tests
 * that both pass and fail across runs with the same inputs; (2) QUARANTINE — a
 * list of flaky tests to exclude from the pass/fail gate; (3) TEST-IMPACT
 * ANALYSIS — given changed endpoints, selects just the tests that exercise them
 * instead of the whole suite.
 *
 * Standalone and opt-in: flaky detection REUSES the dashboard run loaders
 * (read-only); quarantine has its own table; impact analysis is pure. The
 * generate → execute → heal pipeline is never involved.
 */
import pool from '../db.js';
import { listApiRuns, resultsFor } from './api-dashboard.service.js';
import { requestSignature } from './api-coverage-gaps.service.js';

/* ── Flaky detection ── */

export interface FlakyTest { name: string; appearances: number; passed: number; failed: number; flips: number; flakiness: number; lastStatuses: string[] }
export interface FlakyReport { runsAnalyzed: number; totalTests: number; flaky: FlakyTest[]; summary: { flaky: number; stable: number } }

const FAIL_STATES = new Set(['failed', 'broken']);
const PASS_STATES = new Set(['passed', 'ok', 'success']);

export async function detectFlaky(tenantId: string, runLimit = 20): Promise<FlakyReport> {
  const { items } = await listApiRuns(tenantId, 1, Math.min(100, Math.max(2, runLimit)));
  // oldest → newest so "flips" reads chronologically.
  const runs = [...items].reverse();
  const history = new Map<string, string[]>();      // test name → ordered statuses

  for (const run of runs) {
    let rows: { name: string; status: string }[] = [];
    try { rows = await resultsFor(tenantId, run.runId, run.hasAllure); } catch { rows = []; }
    for (const r of rows) {
      const st = String(r.status || '').toLowerCase();
      if (!PASS_STATES.has(st) && !FAIL_STATES.has(st)) continue;    // ignore skipped/unknown
      const arr = history.get(r.name) || [];
      arr.push(PASS_STATES.has(st) ? 'pass' : 'fail');
      history.set(r.name, arr);
    }
  }

  const flaky: FlakyTest[] = [];
  for (const [name, statuses] of history) {
    const passed = statuses.filter((s) => s === 'pass').length;
    const failed = statuses.length - passed;
    let flips = 0;
    for (let i = 1; i < statuses.length; i++) if (statuses[i] !== statuses[i - 1]) flips++;
    // Flaky = it both passed and failed across runs (not consistently broken).
    if (passed > 0 && failed > 0) {
      flaky.push({ name, appearances: statuses.length, passed, failed, flips, flakiness: +(flips / Math.max(1, statuses.length - 1)).toFixed(2), lastStatuses: statuses.slice(-8) });
    }
  }
  flaky.sort((a, b) => b.flakiness - a.flakiness || b.flips - a.flips);
  return { runsAnalyzed: runs.length, totalTests: history.size, flaky, summary: { flaky: flaky.length, stable: history.size - flaky.length } };
}

/* ── Quarantine ── */

export interface QuarantineItem { id: string; testKey: string; reason: string; createdBy: string; createdAt: string }

export async function listQuarantine(tenantId: string): Promise<QuarantineItem[]> {
  const { rows } = await pool.query(`SELECT * FROM api_quarantine WHERE tenant_id = $1 ORDER BY created_at DESC`, [tenantId]);
  return rows.map((r: any) => ({ id: String(r.id), testKey: r.test_key, reason: r.reason || '', createdBy: r.created_by || '', createdAt: r.created_at }));
}

export async function addQuarantine(tenantId: string, username: string, testKey: unknown, reason: unknown): Promise<QuarantineItem> {
  const key = String(testKey || '').trim().slice(0, 500);
  if (!key) throw new Error('A quarantine entry needs a test key/name.');
  const { rows } = await pool.query(
    `INSERT INTO api_quarantine (tenant_id, test_key, reason, created_by) OUTPUT INSERTED.* VALUES ($1, $2, $3, $4)`,
    [tenantId, key, String(reason || '').slice(0, 500), username || ''],
  );
  return { id: String(rows[0].id), testKey: rows[0].test_key, reason: rows[0].reason || '', createdBy: rows[0].created_by || '', createdAt: rows[0].created_at };
}

export async function removeQuarantine(tenantId: string, id: string): Promise<boolean> {
  const { rowCount } = await pool.query(`DELETE FROM api_quarantine WHERE tenant_id = $1 AND id = $2`, [tenantId, id]);
  return rowCount > 0;
}

/* ── Test-impact analysis ── */

export interface ImpactInput {
  /** The endpoints that changed (method optional; url or path). */
  changed: { method?: string; url: string }[];
  /** The candidate tests/endpoints to select from. */
  candidates: { id?: string; title?: string; method: string; url: string }[];
}
export interface ImpactResult {
  changedSignatures: string[];
  impacted: { id?: string; title?: string; method: string; url: string; signature: string }[];
  notImpacted: number;
  summary: { candidates: number; impacted: number; selectedPct: number };
}

export function analyzeImpact(input: ImpactInput): ImpactResult {
  const changedSigs = new Set((input.changed || []).map((c) => requestSignature(c.method || 'GET', c.url)));
  // Also index by path-only (ignore method) so a changed resource matches all its verbs.
  const changedPaths = new Set([...changedSigs].map((s) => s.split(' ').slice(1).join(' ')));

  const impacted: ImpactResult['impacted'] = [];
  for (const c of input.candidates || []) {
    const sig = requestSignature(c.method, c.url);
    const path = sig.split(' ').slice(1).join(' ');
    if (changedSigs.has(sig) || changedPaths.has(path)) impacted.push({ id: c.id, title: c.title, method: c.method, url: c.url, signature: sig });
  }
  const candidates = (input.candidates || []).length;
  return {
    changedSignatures: [...changedSigs],
    impacted,
    notImpacted: candidates - impacted.length,
    summary: { candidates, impacted: impacted.length, selectedPct: candidates ? Math.round((impacted.length / candidates) * 100) : 0 },
  };
}
