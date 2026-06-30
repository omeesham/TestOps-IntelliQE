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
  retries: 0,
  timeout: 60_000,
  reporter: [
    ['line'],
    ['json', { outputFile: './pw-summary.json' }],
    // allure-playwright v3 reads \`resultsDir\`; v2 read \`outputFolder\`. Pass both
    // (absolute) so results land in THIS run's workspace dir regardless of the
    // installed major — otherwise v3 ignores the option and dumps into the cwd's
    // default ./allure-results, leaving the dir we read below empty.
    ['allure-playwright', { resultsDir: ${JSON.stringify(resultsDir)}, outputFolder: ${JSON.stringify(resultsDir)}, detail: true, suiteTitle: false }],
  ],
  use: {
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
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
