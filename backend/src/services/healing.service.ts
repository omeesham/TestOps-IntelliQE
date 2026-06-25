/**
 * Auto-healing service (DB-backed) — the engine behind the chat wizard's
 * "Auto-Heal" step.
 *
 * The previous wizard heal path called POST /execute, which re-ran the ENTIRE
 * generation pipeline from a "Heal failing tests: ..." string. That produced a
 * brand-new suite with brand-new test-case ids, so nothing could be mapped back
 * to the real failing tests — every test surfaced "Backend did not return a fix".
 *
 * This service heals the REAL failing scripts instead:
 *   1. Load each failing script + its test-case intent straight from the DB.
 *   2. Ask Claude to fix it, giving it the actual code, the actual error, and
 *      the test's intent (see agents/healing-prompt.ts).
 *   3. RE-RUN the targeted scripts via Playwright (in a throwaway workspace) to
 *      get a real pass/fail verdict for each, keyed by test_case_id so the
 *      frontend can map results 1:1.
 *   4. Persist ONLY the fixes that actually passed back to automation_scripts —
 *      so the later Allure report reflects them, and the saved suite is never
 *      overwritten with unverified (possibly non-compiling) AI code.
 */
import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import pool from '../db.js';
import { runClaudePrompt, isClaudeCliAuthenticated, parseJsonFromResponse } from '../agents/claude-runner.js';
import { buildHealingPrompt, type HealingFix } from '../agents/healing-prompt.js';
import { PlaywrightRunError, classifyPlaywrightFailureExternal, storedAllureResultsDir } from './playwright-runner.service.js';

const execFileAsync = promisify(execFile);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const BACKEND_ROOT = path.resolve(__dirname, '..', '..');
const SCHEMA = process.env.DB_SCHEMA || 'JBSTestOpsAI';

function sanitizeFileName(raw: string): string {
  return (raw || 'test').replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 120);
}

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
  /** True when Claude produced a code change we applied. */
  healed: boolean;
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
 * Run a set of (already-healed) specs via Playwright and return per-file
 * pass/fail. Mirrors the executeRunScripts config so behaviour matches the main
 * run, but writes one spec per healed test with a filename we control, so we can
 * map each spec result straight back to its test_case_id.
 */
async function reRunHealedSpecs(
  specs: { testCaseId: string; fileName: string; code: string }[],
): Promise<Map<string, { status: 'passed' | 'failed' | 'not_run'; durationMs?: number; error?: string }>> {
  const out = new Map<string, { status: 'passed' | 'failed' | 'not_run'; durationMs?: number; error?: string }>();
  for (const s of specs) out.set(s.testCaseId, { status: 'not_run' });
  if (specs.length === 0) return out;

  const workspace = path.join(os.tmpdir(), `jbs-pwheal-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  const testsDir = path.join(workspace, 'tests');
  await fs.mkdir(testsDir, { recursive: true });

  // Map a deterministic, unique on-disk filename → testCaseId.
  const fileToTc = new Map<string, string>();
  let i = 0;
  for (const s of specs) {
    const name = `heal-${i++}-${sanitizeFileName(s.testCaseId).slice(0, 24)}.spec.ts`;
    await fs.writeFile(path.join(testsDir, name), s.code, 'utf-8');
    fileToTc.set(name.toLowerCase().replace(/\.spec\.ts$/, ''), s.testCaseId);
  }

  const configPath = path.join(workspace, 'playwright.config.cjs');
  const channel = process.env.PLAYWRIGHT_CHANNEL || 'msedge';
  const workers = Number(process.env.PLAYWRIGHT_WORKERS) || 2;
  await fs.writeFile(configPath, `const { defineConfig } = require('@playwright/test');
module.exports = defineConfig({
  testDir: './tests', fullyParallel: true, workers: ${workers}, retries: 0, timeout: 45_000,
  reporter: [['line'], ['json', { outputFile: './pw-summary.json' }]],
  use: { actionTimeout: 15_000, navigationTimeout: 30_000, trace: 'off', screenshot: 'off' },
  projects: [{ name: 'edge', use: { channel: '${channel}' } }],
});
`, 'utf-8');

  const env = {
    ...process.env,
    CI: '1',
    PLAYWRIGHT_JSON_OUTPUT_NAME: path.join(workspace, 'pw-summary.json'),
    NODE_PATH: path.join(BACKEND_ROOT, 'node_modules'),
  };
  const isWindows = process.platform === 'win32';
  let stdout = '';
  let stderr = '';
  try {
    const r = await execFileAsync(
      isWindows ? 'npx.cmd' : 'npx',
      ['playwright', 'test', '--config', configPath],
      { cwd: BACKEND_ROOT, env, timeout: 600_000, maxBuffer: 50 * 1024 * 1024, shell: isWindows },
    );
    stdout = r.stdout;
    stderr = r.stderr;
  } catch (err: any) {
    // Non-zero exit = real test failures, not a fatal error. Capture and parse.
    stdout = err.stdout || '';
    stderr = err.stderr || err.message || '';
  }

  let summary: any = null;
  try {
    summary = JSON.parse(await fs.readFile(path.join(workspace, 'pw-summary.json'), 'utf-8'));
  } catch {
    summary = null;
  }
  if (!summary) {
    // Playwright could not run at all (missing browsers, spawn failure, ...).
    // Surface a typed error so the route returns an actionable message.
    const logPath = path.join(workspace, 'pw-run.log');
    await fs.writeFile(logPath, `STDOUT:\n${stdout}\n\nSTDERR:\n${stderr}`, 'utf-8').catch(() => {});
    throw classifyPlaywrightFailureExternal(stdout, stderr, logPath);
  }

  const specsOut: any[] = [];
  const walk = (s: any) => {
    if (Array.isArray(s?.specs)) specsOut.push(...s.specs);
    if (Array.isArray(s?.suites)) s.suites.forEach(walk);
  };
  (summary.suites || []).forEach(walk);

  const baseName = (f: string) => (f || '').split(/[\\/]/).pop()!.toLowerCase().replace(/\.spec\.ts$/, '');
  for (const spec of specsOut) {
    const tcId = fileToTc.get(baseName(spec?.file || ''));
    if (!tcId) continue;
    const first = spec?.tests?.[0]?.results?.[0];
    const st: string | undefined = first?.status;
    const passed = st === 'passed' || st === 'expected';
    out.set(tcId, {
      status: passed ? 'passed' : st ? 'failed' : 'not_run',
      durationMs: typeof first?.duration === 'number' ? first.duration : undefined,
      error: passed ? undefined : first?.error?.message,
    });
  }

  // Best-effort cleanup of the temp workspace.
  fs.rm(workspace, { recursive: true, force: true }).catch(() => {});
  return out;
}

/**
 * Heal the given failing tests for a run: AI-fix each failing script, persist the
 * fix, then re-run the healed subset and report real per-test results.
 */
export async function healRunScripts(
  tenantId: string,
  isPlatform: boolean,
  runId: string,
  failures: HealFailureInput[],
): Promise<{ details: HealResultDetail[]; healedCount: number; stillFailing: number }> {
  if (!runId) throw new Error('runId is required to heal tests');

  // Resolve the failing test-case ids. If the frontend supplied none, fall back
  // to every script whose last run failed.
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
  const canUseAi = isClaudeCliAuthenticated();

  // ── 1. AI-fix each failing script (in parallel — the set is small). ──
  const healed = await Promise.all(
    rows.map(async (row): Promise<{ row: FailingRow; newCode: string; healFix: string; healed: boolean }> => {
      const realError = errorById.get(row.test_case_id) || 'Test failed during execution (no error message was captured).';

      if (!canUseAi) {
        return { row, newCode: row.code, healFix: 'AI engine not connected — could not generate a fix.', healed: false };
      }

      try {
        const prompt = buildHealingPrompt({
          title: row.title || row.test_case_title || row.tc_number || 'Test',
          feature: row.feature || undefined,
          type: row.type || undefined,
          precondition: row.precondition || undefined,
          steps: Array.isArray(row.steps) ? row.steps : undefined,
          expectedResult: row.expected_result || undefined,
          fileName: row.file_name || `${row.tc_number || 'test'}.spec.ts`,
          code: row.code,
          error: realError,
          targetUrl,
        });

        // 16k matches the generator's per-spec budget — a full corrected POM
        // spec plus the JSON wrapper must never truncate, or the fix is lost.
        const raw = await runClaudePrompt(prompt, { maxTokens: 16000 });
        const fix = parseJsonFromResponse<HealingFix>(raw);
        const newCode = (fix?.code || '').trim();

        // Only accept a real, non-trivial change. If Claude echoed the same code
        // or returned nothing usable, treat it as "no fix produced".
        if (!newCode || newCode === row.code.trim()) {
          return { row, newCode: row.code, healFix: fix?.diagnosis || 'AI did not produce a different script.', healed: false };
        }
        const summary = [fix?.diagnosis, fix?.fix].filter(Boolean).join(' → ') || 'Applied an AI fix to the failing script.';
        return { row, newCode, healFix: summary, healed: true };
      } catch (err: any) {
        return { row, newCode: row.code, healFix: `Heal attempt failed: ${err?.message || 'unknown error'}.`, healed: false };
      }
    }),
  );

  // ── 2. Re-run every targeted script (healed or not) to get a real verdict.
  // We run BEFORE persisting so a fix is verified in a throwaway workspace first
  // — the saved suite is never overwritten with unverified (possibly
  // non-compiling) AI code. ──
  const reRun = await reRunHealedSpecs(
    healed.map((h) => ({
      testCaseId: h.row.test_case_id,
      fileName: h.row.file_name || `${h.row.tc_number || 'test'}.spec.ts`,
      code: h.newCode,
    })),
  );

  // ── 3. Persist ONLY fixes that actually PASSED the re-run. This guarantees we
  // never replace a runnable (but failing) script with code that does not work,
  // which would otherwise break the later full-suite Allure report run. ──
  for (const h of healed) {
    if (!h.healed) continue;
    if (reRun.get(h.row.test_case_id)?.status !== 'passed') continue;
    try {
      await pool.query(
        `UPDATE ${SCHEMA}.automation_scripts
         SET code = $1, version = version + 1, status = 'healed', updated_at = NOW()
         WHERE id = $2`,
        [h.newCode, h.row.id],
      );
    } catch (e: any) {
      console.warn('[healing] failed to persist healed script:', e?.message);
    }
  }

  // ── 4. Assemble per-test results + stamp last-run on the scripts. ──
  const details: HealResultDetail[] = healed.map((h) => {
    const verdict = reRun.get(h.row.test_case_id) || { status: 'not_run' as const };
    // Make the fix message honest about what actually happened on the re-run:
    //  - code changed + now passes → describe the AI fix.
    //  - no code change but now passes → it was a transient failure that cleared.
    //  - still failing → say so, alongside what was attempted.
    let healFix = h.healFix;
    if (verdict.status === 'passed') {
      healFix = h.healed
        ? h.healFix
        : 'Re-ran and passed — the original failure was transient (no code change needed).';
    } else if (verdict.status === 'failed') {
      healFix = h.healed
        ? `${h.healFix} (still failing after re-run)`
        : `Could not auto-fix: ${h.healFix}`;
    }
    // For any non-passing test the DB still holds the ORIGINAL code (we persist
    // only verified-passing fixes), so report the ORIGINAL error — it stays in
    // sync with the saved script and feeds a coherent error to the next attempt.
    const originalError = errorById.get(h.row.test_case_id) || '';
    const reportedError = verdict.status === 'passed' ? undefined : (originalError || verdict.error);
    return {
      testCaseId: h.row.test_case_id,
      tcNumber: h.row.tc_number,
      scenario: h.row.title || h.row.test_case_title || '',
      status: verdict.status,
      durationMs: verdict.durationMs,
      error: reportedError,
      healFix,
      healed: h.healed,
    };
  });

  for (const d of details) {
    if (d.status === 'not_run') continue;
    try {
      await pool.query(
        `UPDATE ${SCHEMA}.automation_scripts
         SET last_run_at = $1, last_run_result = $2, updated_at = NOW()
         WHERE test_run_id = $3 AND test_case_id = $4`,
        [new Date().toISOString(), d.status, runId, d.testCaseId],
      );
    } catch { /* best-effort */ }
  }

  const healedCount = details.filter((d) => d.status === 'passed').length;
  const stillFailing = details.filter((d) => d.status !== 'passed').length;

  // The stored Allure snapshot was captured during the ORIGINAL execution, so it
  // still shows the pre-heal failures — which is why a downloaded report could
  // show more failures than the wizard after healing. We just updated the saved
  // scripts for the healed tests, making that snapshot stale, so drop it: the next
  // report build re-runs the saved (now-fixed) scripts and reflects the heal.
  if (healedCount > 0) {
    await fs.rm(storedAllureResultsDir(tenantId, runId), { recursive: true, force: true }).catch(() => {});
  }

  return { details, healedCount, stillFailing };
}
