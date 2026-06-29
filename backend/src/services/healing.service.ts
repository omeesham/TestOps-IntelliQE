/**
 * Auto-healing service (DB-backed) — the engine behind the chat wizard's
 * "Auto-Heal" step.
 *
 * It heals the REAL failing scripts (never a regenerated suite):
 *   1. Load each failing script + its test-case intent from the DB.
 *   2. Run the shared heal ENGINE (agents/heal-engine.ts): an iterative,
 *      feedback-driven, anti-cheat, verify-before-trust loop. The engine never
 *      returns a fix as "healed" unless it actually passed a real re-run and did
 *      NOT weaken the test.
 *   3. Persist ONLY verified-passing fixes back to automation_scripts — so the
 *      saved suite is never overwritten with unverified (possibly non-compiling
 *      or assertion-gutted) AI code, and the later Allure report reflects the heal.
 *   4. Return real per-test results keyed by test_case_id (incl. a quarantine flag
 *      for tests that could not be safely healed).
 */
import fs from 'fs/promises';
import pool from '../db.js';
import { isClaudeCliAuthenticated } from '../agents/claude-runner.js';
import { hydrateAnthropicEnv } from './llm-config.service.js';
import { PlaywrightRunError, verifySpecsByKey, storedAllureResultsDir } from './playwright-runner.service.js';
import { healSpecs, type HealSpecInput } from '../agents/heal-engine.js';

const SCHEMA = process.env.DB_SCHEMA || 'JBSTestOpsAI';

/** One failing test the frontend asks us to heal. */
export interface HealFailureInput {
  testCaseId: string;
  error?: string;
}

/** Per-test heal outcome returned to the frontend (keyed by testCaseId). */
export interface HealResultDetail {
  testCaseId: string;
  tcNumber: string | null;
  scenario: string;
  /** Result of the verification re-run after the fix was applied. */
  status: 'passed' | 'failed' | 'not_run';
  durationMs?: number;
  error?: string;
  /** Human-readable description of what the healer changed (shown in the UI). */
  healFix: string;
  /** True when a verified-passing fix was applied. */
  healed: boolean;
  /** True when the test could not be safely healed and needs human review. */
  quarantined: boolean;
}

interface FailingRow {
  id: string;
  tc_number: string | null;
  test_case_id: string;
  test_case_title: string | null;
  file_name: string | null;
  code: string;
  // joined from test_cases
  title?: string | null;
  feature?: string | null;
  type?: string | null;
  precondition?: string | null;
  steps?: string[] | null;
  expected_result?: string | null;
}

/** Best-effort lookup of the target URL so the fix prompt can correct paths/protocol. */
async function resolveTargetUrl(tenantId: string): Promise<string | undefined> {
  try {
    const appRes = await pool.query(
      `SELECT config_data FROM ${SCHEMA}.client_configurations
       WHERE tenant_id = $1 AND integration_id LIKE 'app-%' AND status = 'connected'
       ORDER BY updated_at DESC LIMIT 1`,
      [tenantId],
    );
    if (appRes.rows.length > 0) {
      const cfg = appRes.rows[0].config_data || {};
      return cfg.baseUrl || cfg.targetUrl || undefined;
    }
  } catch { /* ignore — the script already carries an absolute URL */ }
  return undefined;
}

/**
 * Heal the given failing tests for a run via the shared heal engine, persist the
 * verified fixes, and report real per-test results.
 */
export async function healRunScripts(
  tenantId: string,
  isPlatform: boolean,
  runId: string,
  failures: HealFailureInput[],
): Promise<{ details: HealResultDetail[]; healedCount: number; stillFailing: number; quarantined: number }> {
  if (!runId) throw new Error('runId is required to heal tests');

  const requestedIds = (failures || []).map((f) => f.testCaseId).filter(Boolean);
  const errorById = new Map<string, string>();
  for (const f of failures || []) {
    if (f.testCaseId) errorById.set(f.testCaseId, f.error || '');
  }

  // Load the failing scripts + their test-case intent. Scripts are the source of
  // truth for the code; test_cases supplies the intent the heal must preserve.
  const tenantClause = isPlatform ? '' : ' AND s.tenant_id = $2';
  const baseParams: any[] = isPlatform ? [runId] : [runId, tenantId];

  let idFilter = '';
  if (requestedIds.length > 0) {
    const placeholders = requestedIds.map((_, i) => `$${baseParams.length + i + 1}`).join(', ');
    idFilter = ` AND s.test_case_id IN (${placeholders})`;
  } else {
    idFilter = ` AND s.last_run_result = 'failed'`;
  }

  const { rows } = await pool.query<FailingRow>(
    // NOTE: the test_cases column is `expected` (not `expected_result`); alias it
    // so the rest of this file can keep using `expected_result`.
    `SELECT s.id, s.tc_number, s.test_case_id, s.test_case_title, s.file_name, s.code,
            tc.title, tc.feature, tc.type, tc.precondition, tc.steps, tc.expected AS expected_result
     FROM ${SCHEMA}.automation_scripts s
     LEFT JOIN ${SCHEMA}.test_cases tc ON tc.id = s.test_case_id
     WHERE s.test_run_id = $1${tenantClause} AND s.framework = 'playwright'
       AND s.code IS NOT NULL AND s.code <> ''${idFilter}`,
    [...baseParams, ...requestedIds],
  );

  if (rows.length === 0) {
    throw new PlaywrightRunError({
      code: 'NO_SCRIPTS',
      httpStatus: 404,
      message: 'No failing automation scripts were found to heal for this run.',
      hint: 'Execute the suite first so the failing scripts exist, then auto-heal.',
    });
  }

  const targetUrl = await resolveTargetUrl(tenantId);
  // Ensure the Anthropic key from LLM Configuration is loaded before the gate.
  await hydrateAnthropicEnv(tenantId);
  const canUseAi = isClaudeCliAuthenticated();

  const rowByTc = new Map<string, FailingRow>();
  for (const r of rows) rowByTc.set(r.test_case_id, r);

  const inputs: HealSpecInput[] = rows.map((r) => ({
    id: r.test_case_id,
    fileName: r.file_name || `${r.tc_number || 'test'}.spec.ts`,
    code: r.code,
    intent: {
      title: r.title || r.test_case_title || r.tc_number || 'Test',
      feature: r.feature || undefined,
      type: r.type || undefined,
      precondition: r.precondition || undefined,
      steps: Array.isArray(r.steps) ? r.steps : undefined,
      expectedResult: r.expected_result || undefined,
    },
    initialError: errorById.get(r.test_case_id) || 'Test failed during execution (no error message was captured).',
  }));

  // The engine runs the full iterative + anti-cheat + verify-before-trust loop.
  const outcomes = await healSpecs(inputs, verifySpecsByKey, { canUseAi, targetUrl });

  // ── Persist ONLY verified-passing fixes. Never overwrite a runnable (but
  // failing) script with unverified code. ──
  for (const [tcId, o] of outcomes) {
    if (!o.healed) continue;
    const row = rowByTc.get(tcId);
    if (!row) continue;
    try {
      await pool.query(
        `UPDATE ${SCHEMA}.automation_scripts
         SET code = $1, version = version + 1, status = 'healed', updated_at = NOW()
         WHERE id = $2`,
        [o.finalCode, row.id],
      );
    } catch (e: any) {
      console.warn('[healing] failed to persist healed script:', e?.message);
    }
  }

  // ── Assemble per-test results + log telemetry. ──
  const details: HealResultDetail[] = rows.map((r) => {
    const o = outcomes.get(r.test_case_id);
    if (o && (o.healed || o.attempts.length > 0)) {
      console.log(`[healing] ${r.tc_number || r.test_case_id} [${o.category}]: healed=${o.healed} attempts=${o.attempts.length} quarantined=${o.quarantined}`);
    }
    return {
      testCaseId: r.test_case_id,
      tcNumber: r.tc_number,
      scenario: r.title || r.test_case_title || '',
      status: o?.finalStatus || 'failed',
      durationMs: o?.durationMs,
      error: o?.healed ? undefined : (o?.finalError || errorById.get(r.test_case_id)),
      healFix: o?.summary || 'No heal outcome was produced.',
      healed: o?.healed || false,
      quarantined: o?.quarantined || false,
    };
  });

  // Stamp last-run for every test we produced a verdict for.
  for (const d of details) {
    try {
      await pool.query(
        `UPDATE ${SCHEMA}.automation_scripts
         SET last_run_at = $1, last_run_result = $2, updated_at = NOW()
         WHERE test_run_id = $3 AND test_case_id = $4`,
        [new Date().toISOString(), d.status, runId, d.testCaseId],
      );
    } catch { /* best-effort */ }
  }

  const healedCount = details.filter((d) => d.healed && d.status === 'passed').length;
  const stillFailing = details.filter((d) => d.status !== 'passed').length;
  const quarantined = details.filter((d) => d.quarantined).length;

  // The stored Allure snapshot reflects the pre-heal failures; healing changed the
  // saved scripts, so drop it — the next report build re-runs the fixed scripts.
  if (healedCount > 0) {
    await fs.rm(storedAllureResultsDir(tenantId, runId), { recursive: true, force: true }).catch(() => {});
  }

  return { details, healedCount, stillFailing, quarantined };
}
