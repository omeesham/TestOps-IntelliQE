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
 *   1. Load each failing script + its test-case intent straight from the DB, and
 *      re-run it unchanged: one that now passes was intermittent, not broken.
 *   2. Ask Claude to fix the rest, giving it the actual code, the actual error, and
 *      the test's intent (see agents/healing-prompt.ts). Failures that point at the
 *      app (answer-key mismatch, or code that passed before) are left for a person,
 *      and a fix that weakens the test is rejected (see heal-guard.service.ts).
 *      Healing can be switched off, and each script gets at most MAX_HEAL_ATTEMPTS
 *      AI attempts until it passes again or a person edits it.
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
import { PlaywrightRunError, classifyPlaywrightFailureExternal, prepareRunTestData, storedAllureResultsDir, runAnswerKeyValues, runSafety } from './playwright-runner.service.js';
import { isDocumentFinding, maskDocumentValues } from './document-accuracy.service.js';
import { weakerFixReason } from './heal-guard.service.js';
import { specUsesDocumentHelper, TEST_DATA_ENV } from './test-data.service.js';
import { errorWithBlocked, prepareGuardedRun, specForRun, type SafetySettings } from './uat-safety.service.js';
import { getConfigsForTenant } from './configurations.service.js';

const execFileAsync = promisify(execFile);

/** AI repair attempts per script before a person must look; deliberately low so healing cannot hide a defect. */
const MAX_HEAL_ATTEMPTS = 2;

/** Self-healing settings from System Configuration → AI Self-Healing (on unless switched off). */
async function healSettings(tenantId: string): Promise<{ enabled: boolean; maxAttempts: number }> {
  const cfg = (await getConfigsForTenant(tenantId)).find((c) => c.integrationId === 'ai-self-healing')?.configData || {};
  const n = Number(cfg.maxHealingAttempts);
  return {
    enabled: cfg.autoHealLocators !== false,
    maxAttempts: Number.isInteger(n) && n >= 1 ? Math.min(n, MAX_HEAL_ATTEMPTS) : MAX_HEAL_ATTEMPTS,
  };
}

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
  test_data?: Record<string, unknown> | null;
  last_passed_at?: string | null;
  /** AI repair attempts since the script last passed or was edited by a person. */
  heal_attempts?: number | null;
}

/**
 * Run a set of (already-healed) specs via Playwright and return per-file
 * pass/fail. Mirrors the executeRunScripts config so behaviour matches the main
 * run, but writes one spec per healed test with a filename we control, so we can
 * map each spec result straight back to its test_case_id.
 */
async function reRunHealedSpecs(
  tenantId: string,
  runId: string,
  specs: { testCaseId: string; fileName: string; code: string }[],
  guard: { safety?: SafetySettings; appUrl?: string },
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
    await fs.writeFile(path.join(testsDir, name), specForRun(s.code, s.fileName, guard.safety), 'utf-8');
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

  const testDataDir = await prepareRunTestData(tenantId, runId, workspace, specs.map((s) => s.code));
  const env = {
    ...process.env,
    CI: '1',
    PLAYWRIGHT_JSON_OUTPUT_NAME: path.join(workspace, 'pw-summary.json'),
    NODE_PATH: path.join(BACKEND_ROOT, 'node_modules'),
    ...(testDataDir ? { [TEST_DATA_ENV]: testDataDir } : {}),
    ...(await prepareGuardedRun(workspace, guard.safety, guard.appUrl)),
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
    // A spec can hold several tests (one per test document): keep the first failure.
    if (out.get(tcId)?.status === 'failed') continue;
    out.set(tcId, {
      status: passed ? 'passed' : st ? 'failed' : 'not_run',
      durationMs: typeof first?.duration === 'number' ? first.duration : undefined,
      error: passed ? undefined : errorWithBlocked(first),
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
    `SELECT s.id, s.tc_number, s.test_case_id, s.test_case_title, s.file_name, s.code, s.last_passed_at, s.heal_attempts,
            tc.title, tc.feature, tc.type, tc.precondition, tc.steps, tc.expected AS expected_result, tc.test_data
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

  const settings = await healSettings(tenantId);
  if (!settings.enabled) {
    throw new PlaywrightRunError({
      code: 'HEALING_OFF',
      httpStatus: 409,
      message: 'Self-healing is turned off.',
      hint: 'Turn it on in System Configuration → AI Self-Healing, or review the failing scripts by hand.',
    });
  }
  const canUseAi = isClaudeCliAuthenticated();
  const specOf = (row: FailingRow, code: string) => ({
    testCaseId: row.test_case_id,
    fileName: row.file_name || `${row.tc_number || 'test'}.spec.ts`,
    code,
  });
  const guard = await runSafety(tenantId, runId, rows.map((r) => r.code));
  // Only this run's own app URL: another app's URL would send the fix to the wrong site.
  const targetUrl = guard.appUrl;
  // Document data (worker names, customers, hours) never goes to the AI.
  const keyValues = rows.some((r) => specUsesDocumentHelper(r.code)) ? await runAnswerKeyValues(tenantId, runId) : [];

  // ── 1. Re-run the failing scripts unchanged: one that now passes failed by
  // chance, and changing it would fix nothing. ──
  const plainRun = await reRunHealedSpecs(tenantId, runId, rows.map((r) => specOf(r, r.code)), guard);

  // ── 2. AI-fix each script that still fails and is safe to heal (in parallel — the set is small). ──
  const healed = await Promise.all(
    rows.map(async (row): Promise<{ row: FailingRow; newCode: string; healFix: string; healed: boolean; attempted?: boolean }> => {
      const realError = errorById.get(row.test_case_id) || 'Test failed during execution (no error message was captured).';

      if (plainRun.get(row.test_case_id)?.status === 'passed') {
        return { row, newCode: row.code, healFix: 'Re-ran unchanged and passed — the failure was intermittent, so the script was left as is.', healed: false };
      }
      // A value that differs from the answer key is a finding about the app; changing the script would hide it.
      if (isDocumentFinding(realError)) {
        return { row, newCode: row.code, healFix: 'Not auto-healed: the screen shows values that differ from the answer key — a finding about the app, not a script fault.', healed: false };
      }
      // This exact code passed before, so the app changed: a person decides whether that is a defect.
      if (row.last_passed_at) {
        return { row, newCode: row.code, healFix: 'Not auto-healed: this script passed before without changes, so the app has likely changed. Check whether it is a defect or an intended change.', healed: false };
      }
      if ((row.heal_attempts || 0) >= settings.maxAttempts) {
        return { row, newCode: row.code, healFix: `Not auto-healed: this script already had ${settings.maxAttempts} repair attempt(s), the limit. A person should review it.`, healed: false };
      }
      if (!canUseAi) {
        return { row, newCode: row.code, healFix: 'Could not auto-fix: AI engine not connected.', healed: false };
      }

      // Every AI attempt below counts toward the limit, accepted or not.
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
          error: specUsesDocumentHelper(row.code) ? maskDocumentValues(realError, keyValues) : realError,
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
          return { row, newCode: row.code, healFix: `Could not auto-fix: ${fix?.diagnosis || 'AI did not produce a different script.'}`, healed: false, attempted: true };
        }
        const caseText = [row.title, row.precondition, ...(Array.isArray(row.steps) ? row.steps : []), row.expected_result, JSON.stringify(row.test_data || {})].join('\n');
        const weaker = weakerFixReason(row.code, newCode, caseText, realError);
        if (weaker) {
          return { row, newCode: row.code, healFix: `Not auto-healed: the AI fix was rejected because ${weaker}. ${fix?.diagnosis || ''}`.trim(), healed: false, attempted: true };
        }
        const summary = [fix?.diagnosis, fix?.fix].filter(Boolean).join(' → ') || 'Applied an AI fix to the failing script.';
        return { row, newCode, healFix: summary, healed: true, attempted: true };
      } catch (err: any) {
        return { row, newCode: row.code, healFix: `Could not auto-fix: heal attempt failed: ${err?.message || 'unknown error'}.`, healed: false, attempted: true };
      }
    }),
  );

  // ── 3. Re-run the fixed scripts to get a real verdict. We run BEFORE persisting
  // so a fix is verified in a throwaway workspace first — the saved suite is never
  // overwritten with unverified (possibly non-compiling) AI code. ──
  const fixes = healed.filter((h) => h.healed);
  const fixRun = await reRunHealedSpecs(
    tenantId,
    runId,
    fixes.map((h) => specOf(h.row, h.newCode)),
    await runSafety(tenantId, runId, fixes.map((h) => h.newCode)),
  );
  const verdictOf = (h: (typeof healed)[number]) =>
    (h.healed ? fixRun : plainRun).get(h.row.test_case_id) || { status: 'not_run' as const };

  // ── 4. Persist ONLY fixes that actually PASSED the re-run. This guarantees we
  // never replace a runnable (but failing) script with code that does not work,
  // which would otherwise break the later full-suite Allure report run. ──
  for (const h of fixes) {
    if (verdictOf(h).status !== 'passed') continue;
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

  // ── 5. Assemble per-test results + stamp last-run on the scripts. ──
  const details: HealResultDetail[] = healed.map((h) => {
    const verdict = verdictOf(h);
    // An applied fix that still fails says so; every other message already states the outcome.
    const healFix = h.healed && verdict.status === 'failed' ? `${h.healFix} (still failing after re-run)` : h.healFix;
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

  for (const h of healed.filter((x) => x.attempted)) {
    try {
      await pool.query(`UPDATE ${SCHEMA}.automation_scripts SET heal_attempts = heal_attempts + 1 WHERE id = $1`, [h.row.id]);
    } catch { /* best-effort */ }
  }

  for (const d of details) {
    if (d.status === 'not_run') continue;
    try {
      await pool.query(
        `UPDATE ${SCHEMA}.automation_scripts
         SET last_run_at = $1, last_run_result = $2, updated_at = NOW(),
             last_passed_at = CASE WHEN $2 = 'passed' THEN $1 ELSE last_passed_at END,
             heal_attempts = CASE WHEN $2 = 'passed' THEN 0 ELSE heal_attempts END
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
