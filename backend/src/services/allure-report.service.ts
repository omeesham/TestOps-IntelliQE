import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs/promises';
import { existsSync, readdirSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import os from 'os';
import crypto from 'crypto';
import JSZip from 'jszip';
import pool from '../db.js';
import { runPlaywrightForRun } from './playwright-runner.service.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const BACKEND_ROOT = path.resolve(__dirname, '..', '..');

/**
 * Root directory for built test reports (Playwright HTML + Allure). On Azure
 * Container Apps the container filesystem is EPHEMERAL and per-replica — reports
 * written there vanish on redeploy and aren't visible to other replicas. Set
 * REPORTS_DIR to a mounted Azure Files volume (e.g. /data/reports) so reports
 * persist across deploys and are shared across replicas. Falls back to the
 * in-image path for local dev. Every reader AND writer must use this.
 */
export const REPORTS_ROOT = process.env.REPORTS_DIR || path.join(BACKEND_ROOT, 'allure-reports');

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

/* ── Locate a Java runtime for the Allure CLI ──
   allure-commandline is a thin launcher around a Java app — no JRE, no report.
   The launcher resolves Java via JAVA_HOME first, PATH second. Dev boxes and
   container images often have a JRE installed outside PATH, so probe JAVA_HOME
   and then the usual install roots (including the portable per-user
   %LOCALAPPDATA%\Java) and hand the winner to the launcher explicitly. */
let cachedJavaHome: string | null | undefined;
function findJavaHome(): string | null {
  if (cachedJavaHome !== undefined) return cachedJavaHome;
  const exe = process.platform === 'win32' ? 'java.exe' : 'java';
  const hasJava = (dir: string) => existsSync(path.join(dir, 'bin', exe));
  const candidates: string[] = [];
  if (process.env.JAVA_HOME) candidates.push(process.env.JAVA_HOME);
  const roots = process.platform === 'win32'
    ? [
        path.join(os.homedir(), 'AppData', 'Local', 'Java'),
        'C:\\Program Files\\Java',
        'C:\\Program Files\\Eclipse Adoptium',
        'C:\\Program Files\\Microsoft',
        'C:\\Program Files (x86)\\Java',
      ]
    : ['/usr/lib/jvm'];
  for (const root of roots) {
    try {
      for (const name of readdirSync(root)) candidates.push(path.join(root, name));
    } catch { /* root absent */ }
  }
  cachedJavaHome = candidates.find(hasJava) ?? null;
  return cachedJavaHome;
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

  const javaHome = findJavaHome();
  const env = javaHome
    ? { ...process.env, JAVA_HOME: javaHome, PATH: `${path.join(javaHome, 'bin')}${path.delimiter}${process.env.PATH || ''}` }
    : process.env;

  try {
    if (process.platform === 'win32') {
      await execFileAsync('cmd', ['/c', allureBin, 'generate', resultsDir, '-o', outputDir, '--clean'], {
        timeout: 120_000,
        env,
      });
    } else {
      await execFileAsync(allureBin, ['generate', resultsDir, '-o', outputDir, '--clean'], {
        timeout: 120_000,
        env,
      });
    }
  } catch (err: any) {
    // The launcher prints its real error (e.g. "JAVA_HOME is not set") on
    // STDOUT; stderr often carries only node deprecation noise. Report both.
    const detail = [err.stdout, err.stderr].map((s: any) => String(s || '').trim()).filter(Boolean).join(' | ') || err.message;
    throw new Error(`Allure generate failed: ${detail}`);
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
  const outputDir = path.join(REPORTS_ROOT, tenantId, runId);

  const { resultsDir, workspace } = await runPlaywrightForRun(tenantId, isPlatform, runId);
  try {
    // The Allure HTML lives in the `/allure` SUBFOLDER of the run dir (the run
    // root is reserved for the Playwright "Basic" report). Every reader —
    // getReportStatus, listReports (hasAllure), readAllureStats — looks in
    // <run>/allure, so writing to the run root here made a regenerated report
    // invisible in the Reports page and broke its stats/export.
    await generateAllureHtml(resultsDir, path.join(outputDir, 'allure'));
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
  const outputDir = path.join(REPORTS_ROOT, tenantId, scope);

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

/**
 * The presence of `index.html` is the source of truth for "a report exists" —
 * `report-meta.json` is only an optional sidecar that records when it was built.
 * Older builds (and any future build where the sidecar write is skipped or the
 * `allure generate --clean` step wipes it) produce a perfectly good report with
 * no meta; keying existence off the meta file made those reports invisible to
 * the Reports page. So: check index.html, then read generatedAt from the meta
 * if present, else fall back to the report file's mtime.
 */
async function readReportMeta(dir: string): Promise<{ exists: boolean; generatedAt?: string }> {
  let stat;
  try {
    stat = await fs.stat(path.join(dir, 'index.html'));
  } catch {
    return { exists: false }; // no rendered report here
  }
  let generatedAt: string | undefined;
  try {
    const meta = JSON.parse(await fs.readFile(path.join(dir, 'report-meta.json'), 'utf-8'));
    if (meta?.generatedAt) generatedAt = meta.generatedAt;
  } catch {
    /* no/invalid sidecar — fall back to the report's mtime below */
  }
  return { exists: true, generatedAt: generatedAt || new Date(stat.mtimeMs).toISOString() };
}

/* ── Find the most recently generated report across all runs for a tenant ── */
export async function getLatestReport(
  tenantId: string,
): Promise<{ exists: boolean; runId?: string; generatedAt?: string; reportUrl?: string }> {
  const baseDir = path.join(REPORTS_ROOT, tenantId);
  let entries: string[];
  try {
    entries = await fs.readdir(baseDir);
  } catch {
    return { exists: false };
  }

  let best: { runId: string; generatedAt: string; ms: number } | null = null;
  for (const runId of entries) {
    const meta = await readReportMeta(path.join(baseDir, runId));
    if (!meta.exists) continue; // skip dirs without a rendered report
    const ms = Date.parse(meta.generatedAt || '') || 0;
    if (!best || ms > best.ms) best = { runId, generatedAt: meta.generatedAt!, ms };
  }

  if (!best) return { exists: false };
  return {
    exists: true,
    runId: best.runId,
    generatedAt: best.generatedAt,
    reportUrl: `/api/allure/report/${tenantId}/${best.runId}/index.html`,
  };
}

/* ── Check if a report already exists ── */
export async function getReportStatus(
  tenantId: string,
  runId?: string,
): Promise<{ exists: boolean; generatedAt?: string; reportUrl?: string; allureReportUrl?: string }> {
  const scope = runId || 'latest';
  const outputDir = path.join(REPORTS_ROOT, tenantId, scope);

  const meta = await readReportMeta(outputDir);
  if (!meta.exists) return { exists: false };

  // The run root holds the Playwright HTML report (the "Basic Report"). The
  // Allure report, when built, lives in the `/allure` subfolder. Surface both
  // so the Reports page can show each under its own tab.
  let allureReportUrl: string | undefined;
  try {
    await fs.access(path.join(outputDir, 'allure', 'index.html'));
    allureReportUrl = `/api/allure/report/${tenantId}/${scope}/allure/index.html`;
  } catch { /* no Allure report for this run */ }

  return {
    exists: true,
    generatedAt: meta.generatedAt,
    reportUrl: `/api/allure/report/${tenantId}/${scope}/index.html`,
    allureReportUrl,
  };
}

/* ── Reports history: list every generated report for a tenant ── */
export interface ReportStats {
  passed: number;
  failed: number;
  broken: number;
  skipped: number;
  total: number;
  passRate: number;
  durationMs: number;
}
export interface ReportListItem {
  runId: string;
  generatedAt: string;
  hasBasic: boolean;
  hasAllure: boolean;
  stats: ReportStats | null;
}

/** Aggregate pass/fail counts from an Allure report's summary widget. */
async function readAllureStats(runDir: string): Promise<ReportStats | null> {
  try {
    const s = JSON.parse(await fs.readFile(path.join(runDir, 'allure', 'widgets', 'summary.json'), 'utf-8'));
    const st = s.statistic || {};
    const total = Number(st.total) || 0;
    const passed = Number(st.passed) || 0;
    return {
      passed,
      failed: Number(st.failed) || 0,
      broken: Number(st.broken) || 0,
      skipped: Number(st.skipped) || 0,
      total,
      passRate: total > 0 ? Math.round((passed / total) * 100) : 0,
      durationMs: Number(s.time?.duration) || 0,
    };
  } catch {
    return null;
  }
}

/** List every run under the tenant that has a rendered report, newest first. */
export async function listReports(tenantId: string): Promise<ReportListItem[]> {
  const baseDir = path.join(REPORTS_ROOT, tenantId);
  let entries: string[];
  try {
    entries = await fs.readdir(baseDir);
  } catch {
    return [];
  }
  const items: ReportListItem[] = [];
  for (const runId of entries) {
    const dir = path.join(baseDir, runId);
    const meta = await readReportMeta(dir);
    if (!meta.exists) continue;
    let hasAllure = false;
    try {
      await fs.access(path.join(dir, 'allure', 'index.html'));
      hasAllure = true;
    } catch { /* basic-only report */ }
    items.push({
      runId,
      generatedAt: meta.generatedAt!,
      hasBasic: true,
      hasAllure,
      // Basic-only reports carry their results inside the Playwright HTML —
      // surface those stats so the history isn't blank for them.
      stats: hasAllure ? await readAllureStats(dir) : (await readBasicReport(tenantId, runId))?.stats ?? null,
    });
  }
  items.sort((a, b) => (Date.parse(b.generatedAt) || 0) - (Date.parse(a.generatedAt) || 0));
  return items;
}

/** Flatten an Allure report's suite tree into per-test rows (for exports). */
export async function readAllureResults(
  tenantId: string,
  runId: string,
): Promise<{ name: string; status: string; durationMs: number }[]> {
  if (!SAFE_RUN_ID_RE.test(runId)) return [];
  const suitesPath = path.join(REPORTS_ROOT, tenantId, runId, 'allure', 'data', 'suites.json');
  const out: { name: string; status: string; durationMs: number }[] = [];
  try {
    const tree = JSON.parse(await fs.readFile(suitesPath, 'utf-8'));
    const walk = (n: any): void => {
      const ch = n?.children;
      if (Array.isArray(ch) && ch.length) { for (const c of ch) walk(c); }
      else if (n?.name) out.push({ name: String(n.name), status: String(n.status || 'unknown'), durationMs: Number(n?.time?.duration) || 0 });
    };
    walk(tree);
  } catch { /* no allure data — return what we have (possibly empty) */ }
  return out;
}

/** Stats for a single run (used by the export endpoints). */
export async function getReportStats(tenantId: string, runId: string): Promise<ReportStats | null> {
  if (!SAFE_RUN_ID_RE.test(runId)) return null;
  return readAllureStats(path.join(REPORTS_ROOT, tenantId, runId));
}

/* ── Basic (Playwright HTML) report parsing ── */

/**
 * Run ids / report scopes come from URL path params and are joined into
 * filesystem paths under REPORTS_ROOT/<tenantId>/. Express decodes %2F to '/'
 * AFTER route matching, so a crafted ..%2F<other-tenant>%2F<run> segment would
 * otherwise traverse into another tenant's report directory. Every function
 * that turns a caller-supplied runId into a path must reject anything that
 * isn't a plain directory-name-shaped token (no separators, no leading dot).
 */
export const SAFE_RUN_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export type ReportResultRow = { name: string; status: string; durationMs: number };

/** Aggregate ReportStats from per-test rows. Playwright counts flaky as ok, so
 *  flaky tests count toward "passed" — the pass rate then matches what the
 *  Playwright HTML report itself shows. */
export function statsFromResults(results: ReportResultRow[], durationMs?: number): ReportStats {
  const count = (s: string) => results.filter((r) => r.status === s).length;
  const passed = count('passed') + count('flaky');
  const total = results.length;
  return {
    passed,
    failed: count('failed'),
    broken: count('broken'),
    skipped: count('skipped'),
    total,
    passRate: total > 0 ? Math.round((passed / total) * 100) : 0,
    durationMs: durationMs ?? results.reduce((s, r) => s + r.durationMs, 0),
  };
}

/** Playwright test outcome → report row status. */
function mapPwOutcome(outcome: string): string {
  switch (outcome) {
    case 'expected':   return 'passed';
    case 'unexpected': return 'failed';
    case 'flaky':      return 'flaky';
    case 'skipped':    return 'skipped';
    default:           return 'unknown';
  }
}

/**
 * Per-test rows + stats for a "Basic" report — the Playwright HTML report the
 * runner writes to the run root. It has no sidecar data files: every result is
 * embedded in index.html as a base64 zip (window.playwrightReportBase64) whose
 * report.json carries the per-test outcomes. Parse it once and cache the
 * extract next to the report, so exports and history stats don't re-unzip
 * ~450KB of HTML on every request. Returns null when there is no basic report
 * or its data can't be parsed.
 */
export async function readBasicReport(
  tenantId: string,
  runId: string,
): Promise<{ stats: ReportStats; results: ReportResultRow[] } | null> {
  if (!SAFE_RUN_ID_RE.test(runId)) return null;
  const runDir = path.join(REPORTS_ROOT, tenantId, runId);
  const htmlPath = path.join(runDir, 'index.html');
  let htmlStat;
  try {
    htmlStat = await fs.stat(htmlPath);
  } catch {
    return null; // no basic report
  }

  // Sidecar cache. Freshness = the cache records the exact (mtime, size) of the
  // index.html it was derived from — a bare "cache newer than html" comparison
  // can be fooled when a parse of the OLD html finishes writing just after a
  // republish replaced it. Zero-test reports are cached too ({empty:true}), so
  // legitimately data-less reports don't get re-unzipped on every history load.
  const cachePath = path.join(runDir, 'basic-report.json');
  const derivedFromCurrentHtml = (c: any) =>
    c && c.htmlMtimeMs === htmlStat.mtimeMs && c.htmlSize === htmlStat.size;
  try {
    const cached = JSON.parse(await fs.readFile(cachePath, 'utf-8'));
    if (derivedFromCurrentHtml(cached)) {
      if (cached.empty) return null;
      if (cached.stats && Array.isArray(cached.results)) return { stats: cached.stats, results: cached.results };
    }
  } catch { /* absent/stale/corrupt cache — re-parse below */ }

  const identity = { htmlMtimeMs: htmlStat.mtimeMs, htmlSize: htmlStat.size };
  let payload: { htmlMtimeMs: number; htmlSize: number; empty?: true; stats?: ReportStats; results?: ReportResultRow[] };
  try {
    const html = await fs.readFile(htmlPath, 'utf-8');
    const m = html.match(/window\.playwrightReportBase64\s*=\s*"data:application\/zip;base64,([^"]+)"/);
    if (!m) return null; // foreign or mid-copy index.html — don't cache
    const zip = await JSZip.loadAsync(Buffer.from(m[1]!, 'base64'));
    const reportFile = zip.file('report.json');
    if (!reportFile) return null;
    const report = JSON.parse(await reportFile.async('string'));

    const results: ReportResultRow[] = [];
    for (const f of report.files || []) {
      for (const t of f.tests || []) {
        // path holds the describe-block chain; PW's own UI renders "path › title".
        const name = [...(Array.isArray(t.path) ? t.path : []), t.title].filter(Boolean).join(' › ') || 'Untitled test';
        results.push({ name, status: mapPwOutcome(String(t.outcome || '')), durationMs: Number(t.duration) || 0 });
      }
    }
    payload = results.length === 0
      ? { ...identity, empty: true } // e.g. all specs failed to load — report.errors only
      : { ...identity, stats: statsFromResults(results, Number(report.duration) || undefined), results };
  } catch {
    return null; // unreadable index.html — treat as "no data", don't cache
  }

  // Republish (rm + cp of the run dir) is not atomic — only publish a cache
  // that still describes the index.html on disk right now.
  try {
    const nowStat = await fs.stat(htmlPath);
    if (nowStat.mtimeMs === htmlStat.mtimeMs && nowStat.size === htmlStat.size) {
      await fs.writeFile(cachePath, JSON.stringify(payload));
    }
  } catch (e: any) {
    // Non-fatal, but silence here would hide e.g. a read-only/full REPORTS_DIR
    // volume making every history load re-unzip every basic report.
    console.warn(`[reports] could not write basic-report cache for ${runId}: ${e?.message}`);
  }
  return payload.empty ? null : { stats: payload.stats!, results: payload.results! };
}
