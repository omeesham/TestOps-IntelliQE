import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import os from 'os';
import crypto from 'crypto';
import pool from '../db.js';
import { executeRunScripts, storedAllureResultsDir } from './playwright-runner.service.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const BACKEND_ROOT = path.resolve(__dirname, '..', '..');

const execFileAsync = promisify(execFile);

/* ── Priority → Allure severity mapping ── */
function mapSeverity(priority: string): string {
  switch (priority?.toUpperCase()) {
    case 'P0': return 'blocker';
    case 'P1': return 'critical';
    case 'P2': return 'normal';
    case 'P3': return 'minor';
    case 'P4': return 'trivial';
    default:   return 'normal';
  }
}

/* ── DB status → Allure status mapping ── */
function mapStatus(status: string): string {
  switch (status?.toLowerCase()) {
    case 'passed':    return 'passed';
    case 'failed':    return 'failed';
    case 'generated': return 'skipped';
    case 'blocked':   return 'broken';
    default:          return 'unknown';
  }
}

/* ── Build Allure result JSON for each test case ── */
function buildAllureResult(tc: any, run: any) {
  const startMs = new Date(run.created_at).getTime();
  const stopMs = startMs + (tc.sort_order || 1) * 150;

  // Parse steps from JSONB
  let steps: any[] = [];
  if (tc.steps && Array.isArray(tc.steps)) {
    steps = tc.steps.map((step: any, idx: number) => {
      const stepText = typeof step === 'string' ? step : step.step || step.action || JSON.stringify(step);
      const isLast = idx === tc.steps.length - 1;
      const stepStatus = (tc.status === 'failed' && isLast) ? 'failed' : 'passed';
      return {
        name: stepText,
        status: stepStatus,
        stage: 'finished',
        start: startMs + idx * 10,
        stop: startMs + idx * 10 + 5,
      };
    });
  }

  return {
    uuid: crypto.randomUUID(),
    historyId: tc.id,
    name: tc.title || 'Untitled Test Case',
    fullName: `${tc.type || 'general'}.${run.story_key || 'suite'}.${tc.title || 'test'}`,
    status: mapStatus(tc.status),
    stage: 'finished',
    start: startMs,
    stop: stopMs,
    description: tc.expected || '',
    labels: [
      { name: 'suite', value: run.story_key || 'Manual Input' },
      { name: 'parentSuite', value: run.source || 'manual' },
      { name: 'subSuite', value: tc.type || 'general' },
      { name: 'severity', value: mapSeverity(tc.priority) },
      { name: 'feature', value: tc.feature || run.story_title || run.story_key || 'Tests' },
      { name: 'story', value: tc.title || 'Test Case' },
      { name: 'epic', value: run.source || 'QE' },
    ],
    parameters: [
      { name: 'Priority', value: tc.priority || 'P2' },
      { name: 'Type', value: tc.type || 'functional' },
    ],
    steps,
  };
}

/* ── Generate Allure result JSON files to a temp dir ── */
export interface ExecOutcome { status: string; durationMs?: number; error?: string }

export async function generateAllureResults(
  tenantId: string,
  isPlatform: boolean,
  runId?: string,
  /** Optional per-test outcomes keyed by test_case id. When given, they OVERRIDE
   *  the DB status so the report reflects the exact pass/fail the wizard showed. */
  execResults?: Map<string, ExecOutcome>,
): Promise<string> {
  // Query test cases with their runs
  let query: string;
  let params: any[];

  if (runId) {
    query = `
      SELECT tc.id, tc.title, tc.expected, tc.type, tc.priority, tc.status,
             tc.steps, tc.sort_order, tc.feature,
             tr.id AS run_id, tr.story_key, tr.story_title, tr.source, tr.created_at
      FROM test_cases tc
      JOIN test_runs tr ON tc.test_run_id = tr.id
      WHERE tr.id = $1${isPlatform ? '' : ' AND tr.tenant_id = $2'}
      ORDER BY tc.sort_order`;
    params = isPlatform ? [runId] : [runId, tenantId];
  } else {
    // Latest runs — last 20 runs
    query = isPlatform
      ? `SELECT tc.id, tc.title, tc.expected, tc.type, tc.priority, tc.status,
                tc.steps, tc.sort_order,
                tr.id AS run_id, tr.story_key, tr.story_title, tr.source, tr.created_at
         FROM test_cases tc
         JOIN test_runs tr ON tc.test_run_id = tr.id
         WHERE tr.id IN (SELECT id FROM test_runs ORDER BY created_at DESC LIMIT 20)
         ORDER BY tr.created_at DESC, tc.sort_order`
      : `SELECT tc.id, tc.title, tc.expected, tc.type, tc.priority, tc.status,
                tc.steps, tc.sort_order,
                tr.id AS run_id, tr.story_key, tr.story_title, tr.source, tr.created_at
         FROM test_cases tc
         JOIN test_runs tr ON tc.test_run_id = tr.id
         WHERE tr.tenant_id = $1
           AND tr.id IN (SELECT id FROM test_runs WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT 20)
         ORDER BY tr.created_at DESC, tc.sort_order`;
    params = isPlatform ? [] : [tenantId];
  }

  const { rows } = await pool.query(query, params);

  if (rows.length === 0) {
    throw new Error('No test cases found to generate report');
  }

  // Write result files to a temp directory
  const resultsDir = path.join(os.tmpdir(), `allure-results-${tenantId}-${Date.now()}`);
  await fs.mkdir(resultsDir, { recursive: true });

  // Group rows by run for context
  const runMap = new Map<string, any>();
  for (const row of rows) {
    if (!runMap.has(row.run_id)) {
      runMap.set(row.run_id, {
        id: row.run_id,
        story_key: row.story_key,
        story_title: row.story_title,
        source: row.source,
        created_at: row.created_at,
      });
    }
  }

  for (const row of rows) {
    const run = runMap.get(row.run_id)!;
    const result: any = buildAllureResult(row, run);
    // Override with the real in-app execution outcome when provided, so the
    // downloadable report matches the wizard's Test Execution Report exactly.
    const exec = execResults?.get(row.id);
    if (exec) {
      const st = exec.status === 'passed' ? 'passed'
        : exec.status === 'failed' ? 'failed'
        : exec.status === 'not_run' ? 'skipped' : 'unknown';
      result.status = st;
      if (typeof exec.durationMs === 'number' && exec.durationMs >= 0) {
        result.stop = result.start + exec.durationMs;
      }
      result.statusDetails = exec.error ? { message: String(exec.error).slice(0, 4000) } : {};
      if (Array.isArray(result.steps) && result.steps.length) {
        const last = result.steps.length - 1;
        result.steps = result.steps.map((s: any, i: number) => ({
          ...s,
          status: st === 'failed' ? (i === last ? 'failed' : 'passed') : st === 'passed' ? 'passed' : s.status,
        }));
      }
    }
    await fs.writeFile(
      path.join(resultsDir, `${result.uuid}-result.json`),
      JSON.stringify(result, null, 2),
    );
  }

  return resultsDir;
}

/**
 * Build the Allure report deterministically from the in-app execution results
 * (the wizard's Test Execution Report). This is the single source of truth, so
 * the downloadable report ALWAYS matches what the user saw — no stale snapshot,
 * no flaky re-run.
 */
export async function getOrGenerateReportFromExecution(
  tenantId: string,
  isPlatform: boolean,
  runId: string,
  execResults: Map<string, ExecOutcome>,
): Promise<{ outputDir: string; generatedAt: string }> {
  if (!runId) throw new Error('runId is required');
  const outputDir = path.join(BACKEND_ROOT, 'allure-reports', tenantId, runId);
  const resultsDir = await generateAllureResults(tenantId, isPlatform, runId, execResults);
  try {
    await generateAllureHtml(resultsDir, outputDir);
    const meta = { generatedAt: new Date().toISOString(), runId, tenantId, real: true, fromExecution: true };
    await fs.writeFile(path.join(outputDir, 'report-meta.json'), JSON.stringify(meta, null, 2));
    return { outputDir, generatedAt: meta.generatedAt };
  } finally {
    await fs.rm(resultsDir, { recursive: true, force: true }).catch(() => {});
  }
}

/* ── Node-based Allure 3 CLI (no Java) ── */
function getAllureNodeCli(): string {
  // The `allure` v3 package ships a pure-JS Node CLI at <pkg>/cli.js — no Java,
  // unlike the legacy allure-commandline 2.x. We invoke it directly via `node`.
  return path.join(BACKEND_ROOT, 'node_modules', 'allure', 'cli.js');
}

async function dirHasFiles(dir: string): Promise<boolean> {
  try {
    const files = await fs.readdir(dir);
    return files.length > 0;
  } catch {
    return false;
  }
}

/* ── Generate Allure HTML from result files (Node CLI, single self-contained file) ── */
export async function generateAllureHtml(resultsDir: string, outputDir: string): Promise<void> {
  const cli = getAllureNodeCli();
  try {
    await fs.access(cli);
  } catch {
    throw new Error('Allure 3 Node CLI not found. Run `npm install` in the backend folder (package: allure).');
  }

  // Start clean so no stale artifacts linger, then let the CLI recreate it.
  await fs.rm(outputDir, { recursive: true, force: true }).catch(() => {});
  await fs.mkdir(outputDir, { recursive: true });

  // Throwaway Allure config enabling the Awesome plugin's single-file output →
  // one self-contained index.html that both embeds in an iframe and downloads
  // as a standalone file. No Java required.
  const cfgDir = path.join(os.tmpdir(), `allurerc-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`);
  await fs.mkdir(cfgDir, { recursive: true });
  const cfgPath = path.join(cfgDir, 'allurerc.mjs');
  await fs.writeFile(
    cfgPath,
    `export default {\n  name: "JBSIntelliQE Test Report",\n  plugins: {\n    awesome: {\n      options: { singleFile: true },\n    },\n  },\n};\n`,
    'utf-8',
  );

  try {
    // node <cli> generate <resultsDir> --output <outputDir> --config <allurerc.mjs>
    await execFileAsync(
      process.execPath,
      [cli, 'generate', resultsDir, '--output', outputDir, '--config', cfgPath],
      { timeout: 120_000, maxBuffer: 50 * 1024 * 1024 },
    );
  } catch (err: any) {
    throw new Error(`Allure report generation failed: ${err.stderr || err.message}`);
  } finally {
    await fs.rm(cfgDir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Orchestrate REAL Allure report generation: actually execute the Playwright
 * scripts stored in automation_scripts for this run, capture real
 * allure-results, and build the HTML report.
 */
export async function getOrGenerateRealReport(
  tenantId: string,
  isPlatform: boolean,
  runId: string,
): Promise<{ outputDir: string; generatedAt: string }> {
  if (!runId) throw new Error('runId is required');
  const outputDir = path.join(BACKEND_ROOT, 'allure-reports', tenantId, runId);

  // 1) Prefer the real allure-results captured when the wizard executed this run.
  let resultsDir = storedAllureResultsDir(tenantId, runId);
  let haveResults = await dirHasFiles(resultsDir);

  // 2) Otherwise run the saved scripts now via the reliable Edge runner — which
  //    also persists allure-results to the store as a side effect.
  if (!haveResults) {
    try {
      await executeRunScripts(tenantId, isPlatform, runId);
      haveResults = await dirHasFiles(resultsDir);
    } catch (err) {
      // No scripts, unreachable target, etc. Fall through to the synthetic path
      // so the user still gets a report built from saved test-case status.
      console.warn('[allure] execution path unavailable, using DB status:', (err as Error).message);
    }
  }

  // 3) Last resort — synthesize allure-results from DB test_cases status so the
  //    report is never blank. Statuses are real; durations are nominal.
  let synthDir: string | null = null;
  if (!haveResults) {
    synthDir = await generateAllureResults(tenantId, isPlatform, runId);
    resultsDir = synthDir;
  }

  try {
    await generateAllureHtml(resultsDir, outputDir);
    const meta = {
      generatedAt: new Date().toISOString(),
      runId,
      tenantId,
      real: !synthDir,
    };
    await fs.writeFile(path.join(outputDir, 'report-meta.json'), JSON.stringify(meta, null, 2));
    return { outputDir, generatedAt: meta.generatedAt };
  } finally {
    if (synthDir) await fs.rm(synthDir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * @deprecated Synthetic path — builds Allure JSON from DB test_cases status
 * rather than real execution. Kept for backward compatibility only; the UI no
 * longer calls it.
 */
export async function getOrGenerateReport(
  tenantId: string,
  isPlatform: boolean,
  runId?: string,
): Promise<{ outputDir: string; generatedAt: string }> {
  const scope = runId || 'latest';
  const backendRoot = BACKEND_ROOT;
  const outputDir = path.join(backendRoot, 'allure-reports', tenantId, scope);

  // Generate allure results
  const resultsDir = await generateAllureResults(tenantId, isPlatform, runId);

  try {
    // Generate HTML report
    await generateAllureHtml(resultsDir, outputDir);

    // Write metadata
    const meta = { generatedAt: new Date().toISOString(), runId: runId || null, tenantId };
    await fs.writeFile(path.join(outputDir, 'report-meta.json'), JSON.stringify(meta, null, 2));

    return { outputDir, generatedAt: meta.generatedAt };
  } finally {
    // Cleanup temp results dir
    await fs.rm(resultsDir, { recursive: true, force: true }).catch(() => {});
  }
}

/* ── Check if a report already exists ── */
export async function getReportStatus(
  tenantId: string,
  runId?: string,
): Promise<{ exists: boolean; generatedAt?: string; reportUrl?: string }> {
  const scope = runId || 'latest';
  const backendRoot = BACKEND_ROOT;
  const outputDir = path.join(backendRoot, 'allure-reports', tenantId, scope);
  const metaPath = path.join(outputDir, 'report-meta.json');

  try {
    const raw = await fs.readFile(metaPath, 'utf-8');
    const meta = JSON.parse(raw);
    return {
      exists: true,
      generatedAt: meta.generatedAt,
      reportUrl: `/api/allure/report/${tenantId}/${scope}/index.html`,
    };
  } catch {
    return { exists: false };
  }
}
