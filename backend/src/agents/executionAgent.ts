import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import type { TestOpsState, TestCase, PageObjectFile } from './state.js';
import { collectClientDeliverableBundle } from '../services/client-deliverable.service.js';

const execFileAsync = promisify(execFile);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const BACKEND_ROOT = path.resolve(__dirname, '..', '..');

function sanitizeFileName(raw: string): string {
  return (raw || 'test').replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 120);
}

/**
 * Extract the (relative, extensionless) page-object import specifiers a spec
 * references, e.g. `../../src/pages/auth/login.page`. Used to detect a spec that
 * imports a page object which was never written (a POM desync) before it can
 * fail the whole Playwright collection with "Cannot find module".
 */
function pageImportsOf(code: string): string[] {
  const out: string[] = [];
  const re = /import\s+[^'"]*from\s+['"]([^'"]*\/pages\/[^'"]*?\.page)['"]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(code || '')) !== null) out.push(m[1]!);
  return out;
}

/**
 * A self-consistent spec that LOADS (imports only @playwright/test) and fails
 * HONESTLY, used when a spec's page-object import can't be resolved. This keeps
 * one broken import from zeroing the entire suite, and gives the healer a real
 * failure to regenerate against instead of a silent collection abort.
 */
function missingPomStub(testCaseId: string, missing: string[]): string {
  const list = missing.map((m) => m.split('/').pop()).join(', ');
  return `import { test, expect } from '@playwright/test';\n\n` +
    `test(${JSON.stringify(`${testCaseId} — page object missing`)}, async () => {\n` +
    `  // The generated spec imported a page object that was not produced: ${list}.\n` +
    `  // This is a generation/heal POM desync — regenerate scripts for this case.\n` +
    `  expect(false, ${JSON.stringify(`Missing page object(s): ${list}. Regenerate this test's scripts.`)}).toBe(true);\n` +
    `});\n`;
}

interface PwSummary {
  stats?: { expected?: number; unexpected?: number; skipped?: number; flaky?: number };
  /** Top-level load/compile errors (populated when specs fail to even load). */
  errors?: { message?: string; location?: { file?: string; line?: number } }[];
  suites?: PwSuite[];
}

interface PwSuite {
  title?: string;
  file?: string;
  specs?: PwSpec[];
  suites?: PwSuite[];
}

interface PwSpec {
  title?: string;
  file?: string;
  // Playwright records `duration` (in milliseconds) per attempt.
  tests?: { results?: { status?: string; duration?: number; error?: { message?: string } }[] }[];
}

interface SpecResult {
  scenario: string;
  /** Test case id resolved from the spec's file name (deterministic mapping). */
  testCaseId?: string;
  passed: boolean;
  /** Wall-clock duration of the test attempt, in milliseconds. */
  durationMs?: number;
  errorMessage?: string;
}

function collectSpecs(suite: PwSuite, out: PwSpec[]): void {
  if (Array.isArray(suite.specs)) out.push(...suite.specs);
  if (Array.isArray(suite.suites)) for (const child of suite.suites) collectSpecs(child, out);
}

/**
 * Map each Playwright spec result back to its originating test case.
 *
 * We write one file per test case named after its id (see runPlaywrightInMemory),
 * so the file's basename is the source of truth — far more reliable than matching
 * on the free-form `test('<title>')` string, which Claude may rephrase.
 * `fileToTcId` maps a written file basename → test case id.
 */
function summarizeSpecs(summary: PwSummary, fileToTcId: Map<string, string>): SpecResult[] {
  const allSpecs: PwSpec[] = [];
  for (const top of summary.suites || []) collectSpecs(top, allSpecs);
  const results: SpecResult[] = [];
  for (const spec of allSpecs) {
    const firstResult = spec.tests?.[0]?.results?.[0];
    const status = firstResult?.status ?? 'failed';
    const passed = status === 'passed' || status === 'expected';
    // Playwright embeds ANSI color codes in error messages; strip them so the
    // UI renders readable text instead of raw escape sequences (\x1b[31m…).
    const errorMessage = passed ? undefined : stripAnsi(firstResult?.error?.message || '') || undefined;
    // Duration comes back in milliseconds from Playwright's JSON reporter.
    const durationMs = typeof firstResult?.duration === 'number' ? firstResult.duration : undefined;
    const fileBase = spec.file ? path.basename(spec.file) : '';
    results.push({
      scenario: spec.title || '',
      testCaseId: fileToTcId.get(fileBase),
      passed,
      durationMs,
      errorMessage,
    });
  }
  return results;
}

/**
 * Run the in-memory automation scripts against the provided target URL via
 * Playwright. Returns per-spec pass/fail so the agent can update test-case
 * status accurately.
 *
 * Critically: spec failures (exit code 1) are NOT errors here — they are
 * real test outcomes. We only throw when Playwright itself couldn't run
 * (missing browsers, unreachable target, spawn failure, ...). Those are
 * surfaced to the caller so the UI can show a real diagnostic instead of
 * "0 passed, 0 failed".
 */
async function runPlaywrightInMemory(
  scripts: { fileName: string; code: string; testCaseId: string; path?: string }[],
  pageObjects: PageObjectFile[],
  targetUrl: string | undefined,
  htmlReportDir?: string,
  allureResultsDir?: string,
): Promise<{ specResults: SpecResult[]; summary: PwSummary | null }> {
  const workspace = path.join(os.tmpdir(), `jbs-pw-sync-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  const testsDir = path.join(workspace, 'tests');
  const resultsDir = path.join(workspace, 'allure-results');
  await fs.mkdir(testsDir, { recursive: true });
  await fs.mkdir(resultsDir, { recursive: true });

  // Helper: write a file at a repo-relative path inside the workspace.
  const writeRel = async (rel: string, content: string) => {
    const abs = path.join(workspace, rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content, 'utf-8');
  };

  // 1. Lay down the POM scaffold support files (base.page.ts, fixtures, utils,
  // types, data) so the generated page objects/specs resolve their imports.
  // Skip the package's own tests/ (we write generated specs) and root config /
  // package.json (we synthesize the config; deps resolve via NODE_PATH).
  try {
    const bundle = await collectClientDeliverableBundle();
    for (const f of bundle) {
      if (f.path.startsWith('tests/')) continue;
      if (f.path === 'playwright.config.ts' || f.path === 'package.json' || f.path === 'tsconfig.json') continue;
      await writeRel(f.path, f.content);
    }
  } catch (e) {
    console.warn('[executionAgent] scaffold bundle unavailable:', (e as Error).message);
  }

  // 2. Generated page objects at their declared repo-relative paths.
  for (const po of pageObjects) {
    if (po?.path && typeof po.code === 'string') await writeRel(po.path, po.code);
  }

  // 3. Generated specs. Results map back by file BASENAME → testCaseId, so we
  // dedup basenames globally (cross-module collisions get a -N suffix) while
  // preserving each spec's POM directory (tests/<module>/...).
  const seen = new Set<string>();
  const fileToTcId = new Map<string, string>();
  // Basename → the actual workspace-relative path the spec was written to
  // (e.g. "verify-login.spec.ts" → "tests/auth/verify-login.spec.ts"). The
  // quarantine step keys offenders by basename but must delete the REAL path,
  // which lives in a module subdirectory — not directly under tests/.
  const fileToRel = new Map<string, string>();
  for (const s of scripts) {
    const declared = s.path || `tests/${sanitizeFileName(s.fileName || s.testCaseId)}`;
    const dir = path.posix.dirname(declared.replace(/\\/g, '/'));
    let base = sanitizeFileName(path.posix.basename(declared));
    if (!base.endsWith('.spec.ts')) base = `${base}.spec.ts`;
    let candidate = base;
    let suffix = 1;
    while (seen.has(candidate)) {
      candidate = base.replace(/\.spec\.ts$/, `-${++suffix}.spec.ts`);
    }
    seen.add(candidate);
    fileToTcId.set(candidate, s.testCaseId);
    const specRel = `${dir === '.' ? 'tests' : dir}/${candidate}`;
    fileToRel.set(candidate, specRel);

    // Consistency guard: a spec that imports a page object which was NOT written
    // (a POM desync from healing/regeneration) throws "Cannot find module" at
    // COLLECTION time — which aborts the ENTIRE run, so one missing shared page
    // object zeros every test. Detect unresolved page-object imports and replace
    // just that spec with a self-consistent one that LOADS and fails honestly,
    // so the rest of the suite still runs and the healer gets a real signal.
    const specDirAbs = path.dirname(path.join(workspace, specRel));
    const unresolved = pageImportsOf(s.code).filter((imp) => !existsSync(path.resolve(specDirAbs, `${imp}.ts`)));
    const code = unresolved.length === 0
      ? s.code
      : missingPomStub(s.testCaseId, unresolved);
    await writeRel(specRel, code);
  }

  const configPath = path.join(workspace, 'playwright.config.cjs');
  const baseUrlLine = targetUrl ? `    baseURL: ${JSON.stringify(targetUrl)},\n` : '';
  // Persist a full Playwright HTML report when a destination is given, so it can
  // be served (and linked from notifications). `open:'never'` keeps CI headless.
  const htmlReporterLine = htmlReportDir
    ? `    ['html', { outputFolder: ${JSON.stringify(htmlReportDir)}, open: 'never' }],\n`
    : '';
  // allure-results for the Reports page. Written to a caller-supplied dir so the
  // route can run `allure generate` against it after the run.
  // allure-playwright v3 reads `resultsDir`; v2 read `outputFolder`. Pass both
  // (absolute) so results land in the caller's dir regardless of the installed
  // major — otherwise v3 ignores `outputFolder`, writes to the default
  // ./allure-results, and buildAllureReport finds an empty dir → no report.
  const allureReporterLine = allureResultsDir
    ? `    ['allure-playwright', { resultsDir: ${JSON.stringify(allureResultsDir)}, outputFolder: ${JSON.stringify(allureResultsDir)}, detail: true, suiteTitle: false }],\n`
    : '';
  // JUnit XML for TestRail / TestLink result-sync (authoring-standards §11). Additive:
  // it sits alongside the existing line/json/html/allure reporters and changes no
  // pass/fail behaviour. Written next to the persistent HTML report when one is given
  // (so it is archived with the run), otherwise into the ephemeral workspace.
  const junitOutput = htmlReportDir ? path.join(htmlReportDir, 'junit.xml') : './junit.xml';
  const junitReporterLine = `    ['junit', { outputFile: ${JSON.stringify(junitOutput)} }],\n`;
  const configSrc = `const { defineConfig } = require('@playwright/test');
module.exports = defineConfig({
  testDir: './tests',
  fullyParallel: true,
  retries: 0,
  timeout: 90_000,
  // Real apps (especially SPAs) render asynchronously and can be
  // slow over the network from a container. The default 5s expect timeout is too
  // short and surfaces as "element not found" on the very first assertion. Give
  // visibility/action/navigation generous ceilings so genuinely-correct selectors
  // aren't failed purely for being slow to appear.
  expect: { timeout: 20_000 },
  reporter: [
    ['line'],
    ['json', { outputFile: './pw-summary.json' }],
${htmlReporterLine}${allureReporterLine}${junitReporterLine}  ],
  use: {
${baseUrlLine}    actionTimeout: 20_000,
    navigationTimeout: 45_000,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
});
`;
  await fs.writeFile(configPath, configSrc, 'utf-8');

  const env = {
    ...process.env,
    CI: '1',
    PLAYWRIGHT_JSON_OUTPUT_NAME: path.join(workspace, 'pw-summary.json'),
    NODE_PATH: path.join(BACKEND_ROOT, 'node_modules'),
  };

  const isWindows = process.platform === 'win32';
  const summaryPath = path.join(workspace, 'pw-summary.json');

  // Spawn Playwright once. Spec failures (exit 1) are real results, not errors —
  // only a missing summary (couldn't even run) is fatal.
  async function runOnce(): Promise<{ summary: PwSummary | null; stdout: string; stderr: string }> {
    let stdout = '';
    let stderr = '';
    try {
      const result = await execFileAsync(
        isWindows ? 'npx.cmd' : 'npx',
        ['playwright', 'test', '--config', configPath],
        { cwd: BACKEND_ROOT, env, timeout: 600_000, maxBuffer: 50 * 1024 * 1024, shell: isWindows },
      );
      stdout = result.stdout;
      stderr = result.stderr;
    } catch (err: any) {
      stdout = err.stdout || '';
      stderr = err.stderr || err.message || '';
    }
    let summary: PwSummary | null = null;
    try {
      summary = JSON.parse(await fs.readFile(summaryPath, 'utf-8'));
    } catch {
      summary = null;
    }
    return { summary, stdout, stderr };
  }

  // `remaining` tracks the spec files still on disk (basename). When a generated
  // spec fails to LOAD (syntax error, bad import, no test block), Playwright
  // aborts collection for the ENTIRE run — so a single broken file zeroes out
  // all the others. We pinpoint the offenders from summary.errors, quarantine
  // them, and re-run the rest, recording each quarantined spec as a real
  // failure (so the healing stage can fix it) rather than letting it sink the
  // whole suite.
  const remaining = new Set<string>(fileToTcId.keys());
  const quarantined: { base: string; message: string }[] = [];

  let summary: PwSummary | null = null;
  let specResults: SpecResult[] = [];
  for (let attempt = 0; attempt <= scripts.length; attempt++) {
    const run = await runOnce();
    summary = run.summary;
    if (!summary) {
      const tail = (run.stderr.slice(-800) || run.stdout.slice(-800)).trim();
      throw new Error(tail || 'Playwright produced no summary');
    }
    specResults = summarizeSpecs(summary, fileToTcId);
    if (specResults.length > 0) break; // collection succeeded — real results in hand

    // Zero specs collected: identify which remaining files failed to load.
    const offenders = collectLoadErrorFiles(summary, run.stdout, run.stderr, remaining);
    if (offenders.size === 0) {
      // Couldn't pinpoint a culprit — surface the raw diagnostic.
      const loadErr = summary.errors?.find((e) => e?.message)?.message;
      const detail = stripAnsi(loadErr || run.stderr.slice(-800) || run.stdout.slice(-800))
        .replace(/\s+/g, ' ').trim().slice(0, 600);
      throw new Error(
        `Playwright collected 0 runnable tests from ${scripts.length} generated script(s) — the specs failed to load. ${detail || 'Check the generated scripts for syntax errors or missing test() blocks.'}`,
      );
    }
    // Quarantine the broken files and retry with what's left.
    for (const [base, message] of offenders) {
      quarantined.push({ base, message });
      remaining.delete(base);
      // Delete the spec at its REAL location (module subdir), not
      // testsDir/<basename> — specs live at tests/<module>/<file>.spec.ts, so
      // deleting by basename alone silently no-ops and the broken file stays,
      // defeating the whole quarantine/retry mechanism.
      const rel = fileToRel.get(base);
      if (rel) await fs.rm(path.join(workspace, rel), { force: true }).catch(() => {});
    }
    if (remaining.size === 0) break; // every spec was broken — nothing left to run
  }

  // Record each quarantined spec as a real failure against its test case, so it
  // shows up honestly (not "not_run") and feeds the healing loop.
  for (const q of quarantined) {
    specResults.push({
      scenario: '',
      testCaseId: fileToTcId.get(q.base),
      passed: false,
      errorMessage: q.message,
    });
  }

  return { specResults, summary };
}

/** Strip ANSI color codes Playwright embeds in error messages. */
function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return (s || '').replace(/\[[0-9;]*m/g, '');
}

/**
 * From a zero-spec Playwright run, map each load/compile error back to the
 * generated spec file that caused it (by basename), so it can be quarantined.
 * Returns basename → first-line error message for files still in `remaining`.
 */
function collectLoadErrorFiles(
  summary: PwSummary,
  stdout: string,
  stderr: string,
  remaining: Set<string>,
): Map<string, string> {
  const out = new Map<string, string>();
  const errs = summary.errors && summary.errors.length
    ? summary.errors
    : [{ message: stderr || stdout }];
  for (const e of errs) {
    const msg = stripAnsi(e?.message || '');
    // Prefer the structured location; fall back to scanning the message for any
    // remaining spec basename (the path is embedded in the SyntaxError text).
    let base = e?.location?.file ? path.basename(e.location.file) : undefined;
    if (!base || !remaining.has(base)) {
      base = [...remaining].find((b) => msg.includes(b));
    }
    if (base && remaining.has(base) && !out.has(base)) {
      const firstLine = msg.split('\n').map((l) => l.trim()).find(Boolean) || 'Spec failed to load';
      out.set(base, firstLine.slice(0, 300));
    }
  }
  return out;
}

/**
 * Execution Agent — runs the generated Playwright scripts against the
 * target application and reports real outcomes.
 *
 *  - With appContext.targetUrl + scripts: invoke Playwright, map each
 *    spec's pass/fail back onto the originating test case, and report
 *    real counts. A failure here is a real test failure, surfaced to the
 *    healing stage.
 *  - Without a target URL or scripts: mark cases as `automated` and leave
 *    `executionResults` null with an explanatory failureReason. The UI
 *    then knows nothing was actually run — no fabricated "0 failed" pass.
 */
export async function executionAgent(
  state: TestOpsState,
  opts?: { htmlReportDir?: string; allureResultsDir?: string },
): Promise<TestOpsState> {
  const targetUrl = state.appContext?.targetUrl;
  const scripts = state.automationScripts || [];

  if (!targetUrl || scripts.length === 0) {
    const reason = !targetUrl
      ? 'No target URL provided — scripts generated but not executed.'
      : 'No automation scripts were produced — nothing to execute.';
    const updated = state.testCases.map((tc) => ({
      ...tc,
      status: tc.status === 'generated' ? 'automated' as const : tc.status,
    }));
    return {
      ...state,
      testCases: updated,
      executionResults: null,
      failureReason: reason,
    };
  }

  try {
    const { specResults } = await runPlaywrightInMemory(scripts, state.pageObjects || [], targetUrl, opts?.htmlReportDir, opts?.allureResultsDir);

    // Primary lookup is by test case id (from the spec file name); scenario
    // title is only a fallback for results we couldn't map by file.
    const resultByTcId = new Map<string, SpecResult>();
    const resultByScenario = new Map<string, SpecResult>();
    for (const r of specResults) {
      if (r.testCaseId) resultByTcId.set(r.testCaseId, r);
      if (r.scenario) resultByScenario.set(r.scenario, r);
    }

    let passed = 0;
    let failed = 0;
    // Build the per-test details array in lock-step with the testCases
    // update so the frontend can render real durations / errors without
    // any inference or fabrication.
    const details: NonNullable<TestOpsState['executionResults']>['details'] = [];
    const updated: TestCase[] = state.testCases.map((tc) => {
      const match = resultByTcId.get(tc.id) || resultByScenario.get(tc.scenario);
      if (!match) {
        // Test case had no matching Playwright spec — script generation
        // skipped it (e.g., API-only test). Mark honestly as not_run.
        details.push({
          testCaseId: tc.id,
          scenario: tc.scenario,
          status: 'not_run',
        });
        return tc.status === 'generated' ? { ...tc, status: 'automated' as const } : tc;
      }
      if (match.passed) {
        passed++;
        details.push({
          testCaseId: tc.id,
          scenario: tc.scenario,
          status: 'passed',
          durationMs: match.durationMs,
        });
        return { ...tc, status: 'passed' as const };
      }
      failed++;
      details.push({
        testCaseId: tc.id,
        scenario: tc.scenario,
        status: 'failed',
        durationMs: match.durationMs,
        error: match.errorMessage,
      });
      return { ...tc, status: 'failed' as const };
    });

    return {
      ...state,
      testCases: updated,
      executionResults: {
        passed,
        failed,
        failReason: specResults.find((r) => !r.passed)?.errorMessage,
        details,
      },
      failureReason: failed > 0 ? (specResults.find((r) => !r.passed)?.errorMessage || 'Some tests failed') : null,
    };
  } catch (err) {
    const message = (err as Error).message || 'Playwright execution failed';
    const updated = state.testCases.map((tc) => ({
      ...tc,
      status: tc.status === 'generated' ? 'automated' as const : tc.status,
    }));
    return {
      ...state,
      testCases: updated,
      executionResults: null,
      failureReason: `Execution could not run: ${message}`,
    };
  }
}
