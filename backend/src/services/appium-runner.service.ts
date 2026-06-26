/**
 * appium-runner.service.ts
 * ────────────────────────
 * Execution for Mobile Application Automation (Appium / WebdriverIO specs).
 *
 * Two modes, chosen automatically — and it NEVER fakes a result:
 *
 *  1. REAL RUN — when an Appium server + a target device are configured AND the
 *     WebdriverIO toolchain is installed, this spins up a throwaway WebdriverIO
 *     workspace, runs the run's `framework='appium'` specs against the device via
 *     `@wdio/cli`, and maps real pass/fail/skip back to each test case. Mirrors
 *     playwright-runner.service.ts (temp workspace → config → spawn → parse).
 *
 *  2. HONEST NOT-RUN — when Appium/device aren't configured or the WebdriverIO
 *     packages aren't installed (e.g. this dev host), every spec is reported as
 *     `not_run` with a clear reason. Scripts are still generated and ready.
 *
 * Activate a real run with these env vars (on a host that has a device/emulator
 * + Appium 2 running, and the deps installed — see REQUIRED_WDIO_DEPS):
 *   APPIUM_SERVER_URL   e.g. http://127.0.0.1:4723
 *   APPIUM_DEVICE       device name, e.g. "Pixel_7_API_34" (or set ANDROID_UDID/IOS_UDID)
 *   ANDROID_UDID / IOS_UDID   (optional) specific device udid
 *   APPIUM_APP          (optional) absolute path to the .apk/.ipa to install;
 *                       if omitted, the app is assumed pre-installed (uses
 *                       appPackage/appActivity or bundleId from the saved build).
 */
import { execFile } from 'child_process';
import { promisify } from 'util';
import { createRequire } from 'module';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import pool from '../db.js';
import type { RunSpecResult } from './playwright-runner.service.js';

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const BACKEND_ROOT = path.resolve(__dirname, '..', '..');

const SCHEMA = '"JBSTestOpsAI"';

/** Packages the host needs for a real device run (install on your mobile CI). */
export const REQUIRED_WDIO_DEPS = '@wdio/cli @wdio/local-runner @wdio/mocha-framework @wdio/json-reporter webdriverio';

function sanitizeFileName(raw: string): string {
  return (raw || 'test').replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 120);
}

/** True only when an Appium endpoint AND a target device are explicitly configured. */
export function appiumExecutionConfigured(): boolean {
  return Boolean(
    process.env.APPIUM_SERVER_URL &&
    (process.env.APPIUM_DEVICE || process.env.ANDROID_UDID || process.env.IOS_UDID),
  );
}

/** True when the WebdriverIO toolchain is resolvable from the backend. */
function wdioToolchainAvailable(): { ok: boolean; cliBin?: string } {
  try {
    const cliBin = require.resolve('@wdio/cli/bin/wdio.js');
    require.resolve('@wdio/json-reporter'); // result mapping depends on this reporter
    return { ok: true, cliBin };
  } catch {
    return { ok: false };
  }
}

export interface MobileRunResult {
  details: RunSpecResult[];
  passed: number;
  failed: number;
  notRun: number;
  executed: boolean;
  reason?: string;
}

interface ScriptRow {
  id: string;
  tc_number: string | null;
  test_case_id: string;
  test_case_title: string | null;
  file_name: string | null;
  code: string;
}

/** Parse APPIUM_SERVER_URL into WebdriverIO connection fields (Appium 2 base path '/'). */
function parseAppiumUrl(raw: string): { protocol: string; hostname: string; port: number; basePath: string } {
  try {
    const u = new URL(raw);
    return {
      protocol: u.protocol.replace(':', '') || 'http',
      hostname: u.hostname || '127.0.0.1',
      port: u.port ? Number(u.port) : (u.protocol === 'https:' ? 443 : 4723),
      basePath: u.pathname && u.pathname !== '' ? u.pathname : '/',
    };
  } catch {
    return { protocol: 'http', hostname: '127.0.0.1', port: 4723, basePath: '/' };
  }
}

function buildCapabilities(platform: 'android' | 'ios', meta: any): Record<string, any> {
  const deviceName = process.env.APPIUM_DEVICE || (platform === 'ios' ? 'iPhone' : 'Android Emulator');
  const udid = platform === 'ios' ? process.env.IOS_UDID : process.env.ANDROID_UDID;
  const appPath = process.env.APPIUM_APP; // optional path to the .apk/.ipa to (re)install

  const caps: Record<string, any> = {
    platformName: platform === 'ios' ? 'iOS' : 'Android',
    'appium:automationName': platform === 'ios' ? 'XCUITest' : 'UiAutomator2',
    'appium:deviceName': deviceName,
    'appium:newCommandTimeout': 120,
  };
  if (udid) caps['appium:udid'] = udid;
  if (appPath) {
    caps['appium:app'] = appPath;
  } else if (platform === 'android') {
    if (meta?.packageName) caps['appium:appPackage'] = meta.packageName;
    if (meta?.mainActivity) caps['appium:appActivity'] = meta.mainActivity;
  } else if (meta?.bundleId) {
    caps['appium:bundleId'] = meta.bundleId;
  }
  return caps;
}

/** Normalise a title/test name for matching json-reporter results to script rows. */
function norm(s: string): string {
  return (s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

export async function executeRunScriptsMobile(
  tenantId: string,
  isPlatform: boolean,
  runId: string,
): Promise<MobileRunResult> {
  if (!runId) throw new Error('runId is required to execute mobile tests');

  // Load the run's platform + saved build metadata (for capabilities).
  const runQ = isPlatform
    ? `SELECT platform, mobile_context FROM ${SCHEMA}.test_runs WHERE id = $1`
    : `SELECT platform, mobile_context FROM ${SCHEMA}.test_runs WHERE id = $1 AND tenant_id = $2`;
  const runRows = (await pool.query(runQ, isPlatform ? [runId] : [runId, tenantId])).rows;
  const platform: 'android' | 'ios' | null =
    runRows[0]?.platform === 'android' || runRows[0]?.platform === 'ios' ? runRows[0].platform : null;
  const meta = runRows[0]?.mobile_context && typeof runRows[0].mobile_context === 'object' ? runRows[0].mobile_context : {};

  const scriptQ = isPlatform
    ? `SELECT id, tc_number, test_case_id, test_case_title, file_name, code
       FROM ${SCHEMA}.automation_scripts
       WHERE test_run_id = $1 AND framework = 'appium' AND code IS NOT NULL AND code <> ''`
    : `SELECT id, tc_number, test_case_id, test_case_title, file_name, code
       FROM ${SCHEMA}.automation_scripts
       WHERE test_run_id = $1 AND tenant_id = $2 AND framework = 'appium' AND code IS NOT NULL AND code <> ''`;
  const rows = (await pool.query(scriptQ, isPlatform ? [runId] : [runId, tenantId])).rows as ScriptRow[];

  if (rows.length === 0) {
    return { details: [], passed: 0, failed: 0, notRun: 0, executed: false, reason: 'No Appium scripts have been generated for this run yet.' };
  }

  const notRunAll = (reason: string): MobileRunResult => ({
    details: rows.map((r) => ({
      testCaseId: r.test_case_id,
      tcNumber: r.tc_number,
      scenario: r.test_case_title || r.file_name || 'Mobile test',
      status: 'not_run' as const,
      error: reason,
    })),
    passed: 0,
    failed: 0,
    notRun: rows.length,
    executed: false,
    reason,
  });

  // ── Gating: only run for real when fully set up; else honest not_run. ──
  if (!platform) return notRunAll('This run is not a mobile run.');
  if (!appiumExecutionConfigured()) {
    return notRunAll('Mobile execution needs an Appium server and a connected device/emulator. Scripts are generated and ready — set APPIUM_SERVER_URL + a device id (APPIUM_DEVICE / ANDROID_UDID / IOS_UDID) on a host with the device to run them.');
  }
  const tool = wdioToolchainAvailable();
  if (!tool.ok) {
    return notRunAll(`Appium is configured but the WebdriverIO runner isn't installed on this server. Install: npm i -D ${REQUIRED_WDIO_DEPS}. Scripts are generated and ready.`);
  }

  // ── REAL RUN ──
  await pool.query(
    `UPDATE ${SCHEMA}.automation_scripts SET last_run_at = SYSUTCDATETIME() WHERE test_run_id = $1 AND framework = 'appium'`,
    [runId],
  );

  const workspace = path.join(os.tmpdir(), `jbs-appium-${runId}-${Date.now()}`);
  const testsDir = path.join(workspace, 'tests');
  const resultsDir = path.join(workspace, 'results');
  await fs.mkdir(testsDir, { recursive: true });
  await fs.mkdir(resultsDir, { recursive: true });

  // Write each spec; map its file name back to the DB row.
  const byTitle = new Map<string, ScriptRow>();
  const seen = new Set<string>();
  for (const row of rows) {
    let base = sanitizeFileName(row.file_name || row.tc_number || row.test_case_id || row.id);
    base = base.replace(/\.(e2e|spec)\.(ts|js)$/i, '');
    let candidate = `${base}.e2e.ts`;
    let n = 1;
    while (seen.has(candidate)) candidate = `${base}-${++n}.e2e.ts`;
    seen.add(candidate);
    await fs.writeFile(path.join(testsDir, candidate), row.code, 'utf-8');
    if (row.test_case_title) byTitle.set(norm(row.test_case_title), row);
    if (row.tc_number) byTitle.set(norm(row.tc_number), row);
  }

  const conn = parseAppiumUrl(process.env.APPIUM_SERVER_URL!);
  const caps = buildCapabilities(platform, meta);

  // CommonJS config so it loads without ESM/TS gymnastics; specs are TS and run
  // via wdio's built-in tsx/ts support (backend ships tsx).
  const confPath = path.join(workspace, 'wdio.conf.cjs');
  await fs.writeFile(confPath, `const path = require('path');
exports.config = {
  runner: 'local',
  protocol: ${JSON.stringify(conn.protocol)},
  hostname: ${JSON.stringify(conn.hostname)},
  port: ${conn.port},
  path: ${JSON.stringify(conn.basePath)},
  specs: [path.join(__dirname, 'tests', '**', '*.e2e.@(ts|js)')],
  maxInstances: 1,
  capabilities: [${JSON.stringify(caps)}],
  logLevel: 'error',
  bail: 0,
  // Fail fast on infra problems instead of hanging — we report not_run on error.
  connectionRetryTimeout: 120000,
  connectionRetryCount: 0,
  waitforTimeout: 15000,
  framework: 'mocha',
  reporters: ['spec', ['json', { outputDir: ${JSON.stringify(resultsDir)}, stdout: false }]],
  mochaOpts: { ui: 'bdd', timeout: 120000 },
  autoCompileOpts: { autoCompile: true, tsNodeOpts: { transpileOnly: true } },
};
`, 'utf-8');

  const env = {
    ...process.env,
    NODE_PATH: path.join(BACKEND_ROOT, 'node_modules'),
  };

  let ran = false;
  try {
    // `wdio run <conf>`; non-zero exit just means some tests failed — we read the
    // JSON reporter for the real per-test verdicts, so don't treat that as fatal.
    await execFileAsync('node', [tool.cliBin!, 'run', confPath], {
      cwd: workspace,
      env,
      timeout: 15 * 60 * 1000,
      maxBuffer: 64 * 1024 * 1024,
      windowsHide: true,
    }).catch((e: any) => {
      // A non-zero exit (failed tests) resolves here with stdout captured; only a
      // spawn/connection failure has no usable result file (handled below).
      if (e && (e.stdout || e.stderr)) return;
      throw e;
    });
    ran = true;
  } catch (err: any) {
    await fs.rm(workspace, { recursive: true, force: true }).catch(() => {});
    // Infra failure (Appium unreachable, device offline, runner crash) → honest
    // not_run with the reason. We never report a fake pass/fail.
    const msg = String(err?.message || err || 'WebdriverIO run failed to start');
    return notRunAll(`Mobile run could not start against the configured device: ${msg.slice(0, 300)}`);
  }

  // ── Parse @wdio/json-reporter output → per-test verdicts ──
  const titleState = new Map<string, 'passed' | 'failed' | 'skipped'>();
  try {
    const files = (await fs.readdir(resultsDir)).filter((f) => f.endsWith('.json'));
    for (const f of files) {
      const data = JSON.parse(await fs.readFile(path.join(resultsDir, f), 'utf-8'));
      const suites = Array.isArray(data?.suites) ? data.suites : [];
      for (const suite of suites) {
        const sName = norm(suite?.name || '');
        for (const t of (Array.isArray(suite?.tests) ? suite.tests : [])) {
          const st: 'passed' | 'failed' | 'skipped' =
            t?.state === 'passed' ? 'passed' : t?.state === 'failed' ? 'failed' : 'skipped';
          for (const key of [norm(t?.name || ''), sName]) {
            if (!key) continue;
            const prev = titleState.get(key);
            // failed dominates, then passed, then skipped
            if (!prev || st === 'failed' || (st === 'passed' && prev === 'skipped')) titleState.set(key, st);
          }
        }
      }
    }
  } catch { /* fall through — unmatched rows become not_run */ }

  await fs.rm(workspace, { recursive: true, force: true }).catch(() => {});

  // Map verdicts back to each script row.
  let passed = 0, failed = 0, notRun = 0;
  const details: RunSpecResult[] = rows.map((r) => {
    const title = norm(r.test_case_title || '');
    const tc = norm(r.tc_number || '');
    // Match by tc-number-bearing test name first, then by title/suite name.
    let verdict: 'passed' | 'failed' | 'skipped' | undefined;
    for (const [k, v] of titleState) {
      if ((tc && k.includes(tc)) || (title && (k === title || k.includes(title)))) { verdict = (verdict === 'failed' || v === 'failed') ? 'failed' : v; }
    }
    if (verdict === 'passed') { passed++; return { testCaseId: r.test_case_id, tcNumber: r.tc_number, scenario: r.test_case_title || r.file_name || '', status: 'passed' }; }
    if (verdict === 'failed') { failed++; return { testCaseId: r.test_case_id, tcNumber: r.tc_number, scenario: r.test_case_title || r.file_name || '', status: 'failed', error: 'Test failed on device (see Appium/WebdriverIO logs).' }; }
    notRun++;
    return { testCaseId: r.test_case_id, tcNumber: r.tc_number, scenario: r.test_case_title || r.file_name || '', status: 'not_run', error: ran ? 'No result recorded for this spec.' : undefined };
  });

  // Persist last_run_result per row by verdict.
  for (const d of details) {
    await pool.query(
      `UPDATE ${SCHEMA}.automation_scripts SET last_run_result = $3 WHERE test_run_id = $1 AND test_case_id = $2 AND framework = 'appium'`,
      [runId, d.testCaseId, d.status],
    ).catch(() => {});
  }

  return { details, passed, failed, notRun, executed: true };
}
