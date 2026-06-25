import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import pool from '../db.js';

const execFileAsync = promisify(execFile);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const BACKEND_ROOT = path.resolve(__dirname, '..', '..');

function sanitizeFileName(raw: string): string {
  return (raw || 'test').replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 120);
}

/**
 * Stable on-disk location where a run's real `allure-results` are kept after
 * execution, so the Reports page can build an Allure report from the SAME
 * execution the wizard ran — no slow, flaky re-run. Keyed by tenant + run.
 */
export function storedAllureResultsDir(tenantId: string, runId: string): string {
  return path.join(BACKEND_ROOT, 'allure-results-store', tenantId, runId);
}

interface PwSummary {
  stats?: { expected?: number; unexpected?: number; skipped?: number; flaky?: number };
  suites?: any[];
}

/* ──────────────────────────────────────────────────────────────────
   Structured failure type — user-friendly messages with actionable hints
   ────────────────────────────────────────────────────────────────── */
export type PlaywrightFailureCode =
  | 'NO_SCRIPTS'           // no automation scripts saved for this run
  | 'MISSING_DEPS'         // @playwright/test or allure-playwright not installed
  | 'NO_TESTS'             // scripts have no actual test() blocks
  | 'TARGET_UNREACHABLE'   // app under test cannot be reached from the worker
  | 'BROWSERS_MISSING'     // playwright browsers (chromium etc.) not installed
  | 'COMPILE_ERROR'        // generated specs have TypeScript / syntax errors
  | 'TIMEOUT'              // Playwright run exceeded the per-call timeout
  | 'WORKER_ENV'           // backend can't even spawn npx (Windows shell issue, missing PATH...)
  | 'UNKNOWN';

export class PlaywrightRunError extends Error {
  code: PlaywrightFailureCode;
  hint: string;
  details: string;
  httpStatus: number;
  logPath?: string;

  constructor(opts: {
    code: PlaywrightFailureCode;
    message: string;
    hint: string;
    details?: string;
    httpStatus?: number;
    logPath?: string;
  }) {
    super(opts.message);
    this.name = 'PlaywrightRunError';
    this.code = opts.code;
    this.hint = opts.hint;
    this.details = opts.details || '';
    this.httpStatus = opts.httpStatus ?? 500;
    this.logPath = opts.logPath;
  }

  toResponseJson(includeDetails: boolean): Record<string, unknown> {
    return {
      error: this.message,
      code: this.code,
      hint: this.hint,
      ...(includeDetails && this.details ? { details: this.details.slice(0, 4000) } : {}),
    };
  }
}

/**
 * Inspect Playwright stdout/stderr and produce a typed failure with
 * a user-friendly message + actionable hint. Catches the most common
 * root causes; falls back to UNKNOWN otherwise.
 */
function classifyPlaywrightFailure(stdout: string, stderr: string, logPath: string): PlaywrightRunError {
  const blob = `${stdout}\n${stderr}`.toLowerCase();
  const tail = stderr.slice(-1200) || stdout.slice(-1200);

  // Spawn-level failures — the Node process couldn't even launch npx.
  // On Windows this is usually "spawn EINVAL" with shell:false + .cmd files.
  if (
    blob.includes('spawn einval') ||
    blob.includes('spawn enoent') ||
    blob.includes('spawn eacces')
  ) {
    return new PlaywrightRunError({
      code: 'WORKER_ENV',
      httpStatus: 500,
      message: 'The Playwright runner could not be launched on the server.',
      hint: 'Confirm Node.js + npm are installed on the backend host and that npx is on PATH. On Windows, the spawn needs shell context.',
      details: tail,
      logPath,
    });
  }

  if (
    blob.includes("cannot find module 'allure-playwright'") ||
    blob.includes('cannot find module "allure-playwright"') ||
    blob.includes("cannot find module '@playwright/test'") ||
    blob.includes("cannot find package '@playwright/test'")
  ) {
    return new PlaywrightRunError({
      code: 'MISSING_DEPS',
      httpStatus: 500,
      message: 'Playwright dependencies are not installed on the server.',
      hint: 'Run `npm install` in the backend folder and restart the API server. Required: @playwright/test, allure-playwright.',
      details: tail,
      logPath,
    });
  }

  if (
    blob.includes("executable doesn't exist") ||
    blob.includes('please install') ||
    blob.includes('browsertype.launch') && blob.includes('install playwright')
  ) {
    return new PlaywrightRunError({
      code: 'BROWSERS_MISSING',
      httpStatus: 500,
      message: 'Playwright browsers are not installed.',
      hint: 'Run `npx playwright install chromium` in the backend folder.',
      details: tail,
      logPath,
    });
  }

  if (blob.includes('no tests found') || blob.match(/0 tests? (?:passed|using)/)) {
    return new PlaywrightRunError({
      code: 'NO_TESTS',
      httpStatus: 422,
      message: 'The generated automation scripts contain no runnable tests.',
      hint: 'Open the run in Automation Scripts, verify each script has `test(...)` blocks, and regenerate if needed.',
      details: tail,
      logPath,
    });
  }

  if (
    blob.includes('econnrefused') ||
    blob.includes('err_connection_refused') ||
    blob.includes('err_name_not_resolved') ||
    blob.includes('err_internet_disconnected') ||
    blob.includes('net::err_')
  ) {
    return new PlaywrightRunError({
      code: 'TARGET_UNREACHABLE',
      httpStatus: 422,
      message: 'The application under test could not be reached.',
      hint: 'Confirm the target URL is correct and reachable from the worker host. Apps behind VPN/Citrix need a worker with network access.',
      details: tail,
      logPath,
    });
  }

  if (
    blob.includes('error ts') ||
    blob.includes('syntaxerror') ||
    blob.includes("expected '") ||
    blob.includes('unexpected token')
  ) {
    return new PlaywrightRunError({
      code: 'COMPILE_ERROR',
      httpStatus: 422,
      message: 'One or more automation scripts have syntax or type errors.',
      hint: 'Open Automation Scripts, review the failing spec, edit or regenerate it, then try again.',
      details: tail,
      logPath,
    });
  }

  if (blob.includes('timeout') || blob.includes('timed out')) {
    return new PlaywrightRunError({
      code: 'TIMEOUT',
      httpStatus: 504,
      message: 'Playwright tests timed out.',
      hint: 'The target may be slow or unreachable. Try a smaller run, or check the target environment is responsive.',
      details: tail,
      logPath,
    });
  }

  return new PlaywrightRunError({
    code: 'UNKNOWN',
    httpStatus: 500,
    message: 'Playwright finished but produced no test results.',
    hint: 'Check the run log for details; common causes are misconfigured selectors or unreachable services.',
    details: tail,
    logPath,
  });
}

/**
 * Execute the stored Playwright automation scripts for a given test_run_id and
 * return the absolute path of the real `allure-results` directory produced by
 * the `allure-playwright` reporter.
 */
export async function runPlaywrightForRun(
  tenantId: string,
  isPlatform: boolean,
  runId: string,
): Promise<{ resultsDir: string; workspace: string; summary: PwSummary | null }> {
  if (!runId) throw new Error('runId is required to execute Playwright tests');

  const query = isPlatform
    ? `SELECT id, tc_number, test_case_id, test_case_title, file_name, code
       FROM "JBSTestOpsAI".automation_scripts
       WHERE test_run_id = $1 AND framework = 'playwright' AND code IS NOT NULL AND code <> ''`
    : `SELECT id, tc_number, test_case_id, test_case_title, file_name, code
       FROM "JBSTestOpsAI".automation_scripts
       WHERE test_run_id = $1 AND tenant_id = $2 AND framework = 'playwright' AND code IS NOT NULL AND code <> ''`;
  const params = isPlatform ? [runId] : [runId, tenantId];
  const { rows } = await pool.query(query, params);

  if (rows.length === 0) {
    throw new PlaywrightRunError({
      code: 'NO_SCRIPTS',
      httpStatus: 404,
      message: 'No automation scripts have been generated for this run yet.',
      hint: 'Open Generated Test Cases, pick this run, and click "Generate Scripts". Once scripts exist you can build the Allure report.',
    });
  }

  const workspace = path.join(os.tmpdir(), `jbs-pw-${runId}-${Date.now()}`);
  const testsDir = path.join(workspace, 'tests');
  const resultsDir = path.join(workspace, 'allure-results');
  await fs.mkdir(testsDir, { recursive: true });
  await fs.mkdir(resultsDir, { recursive: true });

  // Write each stored spec to the tests dir
  const written: { scriptId: string; specFile: string }[] = [];
  for (const row of rows) {
    const base = sanitizeFileName(row.file_name || row.tc_number || row.test_case_id || row.id);
    const name = base.endsWith('.spec.ts') ? base : `${base}.spec.ts`;
    const specFile = path.join(testsDir, name);
    await fs.writeFile(specFile, row.code, 'utf-8');
    written.push({ scriptId: row.id, specFile });
  }

  // Minimal Playwright config. The config lives in a temp workspace
  // (no local node_modules), so we write it as CommonJS (.cjs) and set
  // NODE_PATH so `require()` finds @playwright/test, allure-playwright,
  // and any spec-level imports from backend/node_modules. ESM would not
  // honor NODE_PATH and would force absolute file:// URLs everywhere.
  const configPath = path.join(workspace, 'playwright.config.cjs');
  const configSrc = `const { defineConfig } = require('@playwright/test');
module.exports = defineConfig({
  testDir: './tests',
  fullyParallel: true,
  // Cap concurrency — launching one Edge per test (a full suite) at once
  // starves CPU/memory on a single host and makes tests time out. 2 workers
  // keeps the run stable while still parallelising.
  workers: ${Number(process.env.PLAYWRIGHT_WORKERS) || 2},
  retries: 0,
  timeout: 45_000,
  reporter: [
    ['line'],
    ['json', { outputFile: './pw-summary.json' }],
    ['allure-playwright', { resultsDir: ${JSON.stringify(resultsDir)}, detail: true, suiteTitle: false }],
  ],
  use: {
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
  },
  projects: [{ name: 'edge', use: { channel: '${process.env.PLAYWRIGHT_CHANNEL || 'msedge'}' } }],
});
`;
  await fs.writeFile(configPath, configSrc, 'utf-8');

  // Run Playwright from the backend root so it can resolve @playwright/test and allure-playwright
  // from backend/node_modules. Failing tests still return exit code 1 — that's a real result,
  // not a fatal error. Only spawn failures should abort.
  const logPath = path.join(workspace, 'pw-run.log');
  const env = {
    ...process.env,
    CI: '1',
    PLAYWRIGHT_JSON_OUTPUT_NAME: path.join(workspace, 'pw-summary.json'),
    // Let Node fall back to backend/node_modules when resolving reporters or
    // any other module the spec files import.
    NODE_PATH: path.join(BACKEND_ROOT, 'node_modules'),
  };

  let stdout = '';
  let stderr = '';
  // On Windows, spawning `npx.cmd` with `shell: false` raises EINVAL because
  // .cmd files require a shell context. Use the shell on Windows so the cmd
  // file can resolve. POSIX systems run `npx` directly, no shell needed.
  const isWindows = process.platform === 'win32';
  try {
    const result = await execFileAsync(
      isWindows ? 'npx.cmd' : 'npx',
      ['playwright', 'test', '--config', configPath],
      { cwd: BACKEND_ROOT, env, timeout: 600_000, maxBuffer: 50 * 1024 * 1024, shell: isWindows },
    );
    stdout = result.stdout;
    stderr = result.stderr;
  } catch (err: any) {
    // Non-zero exit (test failures) is expected; only rethrow if allure-results is empty
    stdout = err.stdout || '';
    stderr = err.stderr || err.message || '';
  }
  await fs.writeFile(logPath, `STDOUT:\n${stdout}\n\nSTDERR:\n${stderr}`, 'utf-8').catch(() => {});

  // Sanity check — if the reporter produced nothing, classify the failure
  // by inspecting stdout/stderr and throw a typed PlaywrightRunError.
  const resultFiles = await fs.readdir(resultsDir).catch(() => [] as string[]);
  if (resultFiles.length === 0) {
    throw classifyPlaywrightFailure(stdout, stderr, logPath);
  }

  // Read summary for DB updates
  let summary: PwSummary | null = null;
  try {
    const raw = await fs.readFile(path.join(workspace, 'pw-summary.json'), 'utf-8');
    summary = JSON.parse(raw);
  } catch {
    summary = null;
  }

  // Best-effort: mark automation_scripts as last-run
  const nowIso = new Date().toISOString();
  const overallResult =
    summary?.stats?.unexpected && summary.stats.unexpected > 0 ? 'failed' : 'passed';
  try {
    await pool.query(
      `UPDATE "JBSTestOpsAI".automation_scripts
       SET last_run_at = $1, last_run_result = $2, updated_at = NOW()
       WHERE test_run_id = $3${isPlatform ? '' : ' AND tenant_id = $4'}`,
      isPlatform ? [nowIso, overallResult, runId] : [nowIso, overallResult, runId, tenantId],
    );
  } catch (e: any) {
    console.warn('[playwright-runner] failed to update automation_scripts last_run:', e.message);
  }

  return { resultsDir, workspace, summary };
}

/* ──────────────────────────────────────────────────────────────────
   Execute a run's saved scripts and return per-test results.
   Unlike runPlaywrightForRun (which is geared to producing an Allure
   report and throws when allure-results is empty), this relies on the
   JSON reporter's pw-summary.json — so real pass/fail results survive
   even if the Allure reporter writes nothing. Used by the chat wizard's
   "Execute Test Suite" step.
   ────────────────────────────────────────────────────────────────── */
export interface RunSpecResult {
  testCaseId: string | null;
  tcNumber: string | null;
  scenario: string;
  status: 'passed' | 'failed' | 'not_run';
  durationMs?: number;
  error?: string;
}

export async function executeRunScripts(
  tenantId: string,
  isPlatform: boolean,
  runId: string,
): Promise<{ details: RunSpecResult[]; passed: number; failed: number }> {
  if (!runId) throw new Error('runId is required to execute Playwright tests');

  const query = isPlatform
    ? `SELECT id, tc_number, test_case_id, test_case_title, file_name, code
       FROM "JBSTestOpsAI".automation_scripts
       WHERE test_run_id = $1 AND framework = 'playwright' AND code IS NOT NULL AND code <> ''`
    : `SELECT id, tc_number, test_case_id, test_case_title, file_name, code
       FROM "JBSTestOpsAI".automation_scripts
       WHERE test_run_id = $1 AND tenant_id = $2 AND framework = 'playwright' AND code IS NOT NULL AND code <> ''`;
  const { rows } = await pool.query(query, isPlatform ? [runId] : [runId, tenantId]);
  if (rows.length === 0) {
    throw new PlaywrightRunError({
      code: 'NO_SCRIPTS', httpStatus: 404,
      message: 'No automation scripts have been generated for this run yet.',
      hint: 'Generate scripts for this run before executing.',
    });
  }

  const workspace = path.join(os.tmpdir(), `jbs-pwexec-${runId}-${Date.now()}`);
  const testsDir = path.join(workspace, 'tests');
  await fs.mkdir(testsDir, { recursive: true });

  // Write each spec (no BOM via Node fs) and map its final file name → DB row.
  const byFile = new Map<string, any>();
  const seen = new Set<string>();
  for (const row of rows) {
    let base = sanitizeFileName(row.file_name || row.tc_number || row.test_case_id || row.id);
    if (!base.endsWith('.spec.ts')) base = `${base}.spec.ts`;
    let candidate = base;
    let n = 1;
    while (seen.has(candidate)) candidate = base.replace(/\.spec\.ts$/, `-${++n}.spec.ts`);
    seen.add(candidate);
    await fs.writeFile(path.join(testsDir, candidate), row.code, 'utf-8');
    byFile.set(candidate.toLowerCase().replace(/\.spec\.ts$/, ''), row);
  }

  const configPath = path.join(workspace, 'playwright.config.cjs');
  const channel = process.env.PLAYWRIGHT_CHANNEL || 'msedge';
  const workers = Number(process.env.PLAYWRIGHT_WORKERS) || 2;
  // allure-playwright resolves outputFolder relative to CWD (BACKEND_ROOT), not
  // the config dir — so use an ABSOLUTE path into the workspace, otherwise the
  // results leak to backend/allure-results and the persist below finds nothing.
  const allureResultsDir = path.join(workspace, 'allure-results');
  await fs.writeFile(configPath, `const { defineConfig } = require('@playwright/test');
module.exports = defineConfig({
  testDir: './tests', fullyParallel: true, workers: ${workers}, retries: 0, timeout: 45_000,
  reporter: [['line'], ['json', { outputFile: './pw-summary.json' }], ['allure-playwright', { resultsDir: ${JSON.stringify(allureResultsDir)}, detail: true, suiteTitle: false }]],
  use: { actionTimeout: 15_000, navigationTimeout: 30_000, trace: 'off', screenshot: 'off' },
  projects: [{ name: 'edge', use: { channel: '${channel}' } }],
});
`, 'utf-8');

  const env = {
    ...process.env, CI: '1',
    PLAYWRIGHT_JSON_OUTPUT_NAME: path.join(workspace, 'pw-summary.json'),
    NODE_PATH: path.join(BACKEND_ROOT, 'node_modules'),
  };
  const isWindows = process.platform === 'win32';
  let stdout = '', stderr = '';
  try {
    const r = await execFileAsync(isWindows ? 'npx.cmd' : 'npx',
      ['playwright', 'test', '--config', configPath],
      { cwd: BACKEND_ROOT, env, timeout: 600_000, maxBuffer: 50 * 1024 * 1024, shell: isWindows });
    stdout = r.stdout; stderr = r.stderr;
  } catch (err: any) {
    stdout = err.stdout || ''; stderr = err.stderr || err.message || '';
  }

  let summary: PwSummary | null = null;
  try {
    summary = JSON.parse(await fs.readFile(path.join(workspace, 'pw-summary.json'), 'utf-8'));
  } catch { summary = null; }
  if (!summary) {
    const logPath = path.join(workspace, 'pw-run.log');
    await fs.writeFile(logPath, `STDOUT:\n${stdout}\n\nSTDERR:\n${stderr}`, 'utf-8').catch(() => {});
    throw classifyPlaywrightFailure(stdout, stderr, logPath);
  }

  // Persist the real allure-results for this run so the Reports page can build
  // the Allure report from this SAME execution (no slow re-run). Best-effort —
  // a copy failure must never fail the execution itself.
  try {
    const srcAllure = path.join(workspace, 'allure-results');
    const files = await fs.readdir(srcAllure).catch(() => [] as string[]);
    if (files.length > 0) {
      const dest = storedAllureResultsDir(tenantId, runId);
      await fs.rm(dest, { recursive: true, force: true }).catch(() => {});
      await fs.mkdir(dest, { recursive: true });
      await fs.cp(srcAllure, dest, { recursive: true });
    }
  } catch (e: any) {
    console.warn('[playwright-runner] failed to persist allure-results:', e?.message);
  }

  // Flatten suites → specs and attribute each spec back to its test case by file.
  const specs: any[] = [];
  const walk = (s: any) => {
    if (Array.isArray(s?.specs)) specs.push(...s.specs);
    if (Array.isArray(s?.suites)) s.suites.forEach(walk);
  };
  (summary.suites || []).forEach(walk);

  const baseName = (f: string) => (f || '').split(/[\\/]/).pop()!.toLowerCase().replace(/\.spec\.ts$/, '');
  const details: RunSpecResult[] = specs.map((spec) => {
    const first = spec?.tests?.[0]?.results?.[0];
    const st: string | undefined = first?.status;
    const passed = st === 'passed' || st === 'expected';
    const row = byFile.get(baseName(spec?.file || ''));
    return {
      testCaseId: row?.test_case_id || null,
      tcNumber: row?.tc_number || null,
      scenario: spec?.title || row?.test_case_title || '',
      status: passed ? 'passed' : st ? 'failed' : 'not_run',
      durationMs: typeof first?.duration === 'number' ? first.duration : undefined,
      error: passed ? undefined : first?.error?.message,
    };
  });

  const passed = details.filter((d) => d.status === 'passed').length;
  const failed = details.filter((d) => d.status === 'failed').length;

  // Best-effort last-run stamp.
  try {
    await pool.query(
      `UPDATE "JBSTestOpsAI".automation_scripts SET last_run_at = $1, last_run_result = $2, updated_at = NOW()
       WHERE test_run_id = $3${isPlatform ? '' : ' AND tenant_id = $4'}`,
      isPlatform ? [new Date().toISOString(), failed > 0 ? 'failed' : 'passed', runId]
                 : [new Date().toISOString(), failed > 0 ? 'failed' : 'passed', runId, tenantId],
    );
  } catch { /* ignore */ }

  return { details, passed, failed };
}
