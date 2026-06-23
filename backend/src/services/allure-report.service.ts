import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import os from 'os';
import crypto from 'crypto';
import pool from '../db.js';
import { runPlaywrightForRun } from './playwright-runner.service.js';

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
export async function generateAllureResults(
  tenantId: string,
  isPlatform: boolean,
  runId?: string,
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
    const result = buildAllureResult(row, run);
    await fs.writeFile(
      path.join(resultsDir, `${result.uuid}-result.json`),
      JSON.stringify(result, null, 2),
    );
  }

  return resultsDir;
}

/* ── Find the allure CLI binary ── */
function getAllureBin(): string {
  if (process.platform === 'win32') {
    return path.join(BACKEND_ROOT, 'node_modules', '.bin', 'allure.cmd');
  }
  return path.join(BACKEND_ROOT, 'node_modules', '.bin', 'allure');
}

/* ── Generate Allure HTML from result files ── */
export async function generateAllureHtml(resultsDir: string, outputDir: string): Promise<void> {
  const allureBin = getAllureBin();

  // Check that allure binary exists
  try {
    await fs.access(allureBin);
  } catch {
    throw new Error('allure-commandline binary not found. Run: npm install allure-commandline');
  }

  await fs.mkdir(outputDir, { recursive: true });

  try {
    if (process.platform === 'win32') {
      await execFileAsync('cmd', ['/c', allureBin, 'generate', resultsDir, '-o', outputDir, '--clean'], {
        timeout: 120_000,
      });
    } else {
      await execFileAsync(allureBin, ['generate', resultsDir, '-o', outputDir, '--clean'], {
        timeout: 120_000,
      });
    }
  } catch (err: any) {
    throw new Error(`Allure generate failed: ${err.stderr || err.message}`);
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

  const { resultsDir, workspace } = await runPlaywrightForRun(tenantId, isPlatform, runId);
  try {
    await generateAllureHtml(resultsDir, outputDir);
    const meta = {
      generatedAt: new Date().toISOString(),
      runId,
      tenantId,
      real: true,
    };
    await fs.writeFile(path.join(outputDir, 'report-meta.json'), JSON.stringify(meta, null, 2));
    return { outputDir, generatedAt: meta.generatedAt };
  } finally {
    await fs.rm(workspace, { recursive: true, force: true }).catch(() => {});
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
