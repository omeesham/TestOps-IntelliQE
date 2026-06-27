import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import type { TestOpsState, TestCase } from './state.js';

const execFileAsync = promisify(execFile);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const BACKEND_ROOT = path.resolve(__dirname, '..', '..');

function sanitizeFileName(raw: string): string {
  return (raw || 'test').replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 120);
}

interface PwSummary {
  stats?: { expected?: number; unexpected?: number; skipped?: number; flaky?: number };
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
  /** Spec file the result came from — the unique key for matching back to a
   *  test case. Human titles can collide; file names (after dedup) cannot. */
  file?: string;
  passed: boolean;
  /** Wall-clock duration of the test attempt, in milliseconds. */
  durationMs?: number;
  errorMessage?: string;
}

/** Carry the owning suite's `file` down to each spec — Playwright records the
 *  source file on the suite, not always on the spec. */
function collectSpecs(suite: PwSuite, out: { spec: PwSpec; file?: string }[], inheritedFile?: string): void {
  const file = suite.file ?? inheritedFile;
  if (Array.isArray(suite.specs)) for (const spec of suite.specs) out.push({ spec, file: spec.file ?? file });
  if (Array.isArray(suite.suites)) for (const child of suite.suites) collectSpecs(child, out, file);
}

/** Normalise a spec file path to its bare basename so it matches the file
 *  names we wrote into the temp tests dir, regardless of path separators. */
function baseName(file: string | undefined): string | undefined {
  if (!file) return undefined;
  const parts = file.split(/[\\/]/);
  return parts[parts.length - 1] || undefined;
}

function summarizeSpecs(summary: PwSummary): SpecResult[] {
  const allSpecs: { spec: PwSpec; file?: string }[] = [];
  for (const top of summary.suites || []) collectSpecs(top, allSpecs);
  const results: SpecResult[] = [];
  for (const { spec, file } of allSpecs) {
    const firstResult = spec.tests?.[0]?.results?.[0];
    const status = firstResult?.status ?? 'failed';
    const passed = status === 'passed' || status === 'expected';
    const errorMessage = passed ? undefined : firstResult?.error?.message;
    // Duration comes back in milliseconds from Playwright's JSON reporter.
    const durationMs = typeof firstResult?.duration === 'number' ? firstResult.duration : undefined;
    results.push({ scenario: spec.title || '', file: baseName(file), passed, durationMs, errorMessage });
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
  scripts: { fileName: string; code: string; testCaseId: string }[],
  targetUrl: string | undefined,
): Promise<{ specResults: SpecResult[]; summary: PwSummary | null; fileToTestCaseId: Map<string, string> }> {
  const workspace = path.join(os.tmpdir(), `jbs-pw-sync-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  const testsDir = path.join(workspace, 'tests');
  const resultsDir = path.join(workspace, 'allure-results');
  await fs.mkdir(testsDir, { recursive: true });
  await fs.mkdir(resultsDir, { recursive: true });

  // Track which written file backs which test case so results can be matched
  // by the unique spec file rather than the (possibly duplicated) title.
  const fileToTestCaseId = new Map<string, string>();
  const seen = new Set<string>();
  for (const s of scripts) {
    let base = sanitizeFileName(s.fileName || s.testCaseId);
    if (!base.endsWith('.spec.ts')) base = `${base}.spec.ts`;
    let candidate = base;
    let suffix = 1;
    while (seen.has(candidate)) {
      candidate = base.replace(/\.spec\.ts$/, `-${++suffix}.spec.ts`);
    }
    seen.add(candidate);
    fileToTestCaseId.set(candidate, s.testCaseId);
    await fs.writeFile(path.join(testsDir, candidate), s.code, 'utf-8');
  }

  const configPath = path.join(workspace, 'playwright.config.cjs');
  const baseUrlLine = targetUrl ? `    baseURL: ${JSON.stringify(targetUrl)},\n` : '';
  const configSrc = `const { defineConfig } = require('@playwright/test');
module.exports = defineConfig({
  testDir: './tests',
  fullyParallel: true,
  retries: 0,
  timeout: 60_000,
  reporter: [
    ['line'],
    ['json', { outputFile: './pw-summary.json' }],
  ],
  use: {
${baseUrlLine}    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'edge', use: { channel: '${process.env.PLAYWRIGHT_CHANNEL || 'msedge'}' } }],
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
    const raw = await fs.readFile(path.join(workspace, 'pw-summary.json'), 'utf-8');
    summary = JSON.parse(raw);
  } catch {
    summary = null;
  }

  if (!summary) {
    const tail = (stderr.slice(-800) || stdout.slice(-800)).trim();
    throw new Error(tail || 'Playwright produced no summary');
  }

  return { specResults: summarizeSpecs(summary), summary, fileToTestCaseId };
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
export async function executionAgent(state: TestOpsState): Promise<TestOpsState> {
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
    const { specResults, fileToTestCaseId } = await runPlaywrightInMemory(scripts, targetUrl);

    // Key results by the unique testCaseId derived from the spec file. Human
    // titles (tc.scenario) can collide across cases, so keying by title let a
    // later spec silently overwrite an earlier pass/fail.
    const resultByTestCaseId = new Map<string, SpecResult>();
    for (const r of specResults) {
      const testCaseId = r.file ? fileToTestCaseId.get(r.file) : undefined;
      if (testCaseId) resultByTestCaseId.set(testCaseId, r);
    }

    let passed = 0;
    let failed = 0;
    // Build the per-test details array in lock-step with the testCases
    // update so the frontend can render real durations / errors without
    // any inference or fabrication.
    const details: NonNullable<TestOpsState['executionResults']>['details'] = [];
    const updated: TestCase[] = state.testCases.map((tc) => {
      const match = resultByTestCaseId.get(tc.id);
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

    // Do NOT collapse a multi-failure run into one spec's error — picking the
    // first failing spec's message misrepresents the others. The accurate
    // per-test errors live in `details`; the run level only summarises counts.
    return {
      ...state,
      testCases: updated,
      executionResults: {
        passed,
        failed,
        failReason: failed > 0 ? `${failed} test(s) failed — see per-test details` : undefined,
        details,
      },
      failureReason: failed > 0 ? `${failed} of ${passed + failed} test(s) failed` : null,
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
