/**
 * api-dashboard.service.ts
 * ────────────────────────
 * The numbers behind the API Automation dashboard and its REST surface.
 *
 * An API run is a saved test run whose cases are tagged module 'API' (which is
 * what apiGeneratorAgent stamps on every case it designs). Execution results
 * live in the rendered reports on disk (Allure or the Playwright HTML "basic"
 * report), so this service joins the two: runs + cases from the database,
 * outcomes + durations from the report archive. On top of that it derives what
 * a reviewer actually asks the dashboard for — the pass-rate trend, which
 * scenarios are flaky (their outcome flips between runs), which endpoints are
 * slowing down, and where the imported endpoints came from.
 */
import pool from '../db.js';
import { listReports, readAllureResults, readBasicReport, type ReportStats, type ReportResultRow } from './allure-report.service.js';

export interface ApiRunSummary {
  runId: string;
  title: string;
  createdAt: string;
  createdBy: string;
  source: string;
  caseCount: number;
  /** Scenario category → count (positive/negative/security/data/edge/api/flow). */
  categories: Record<string, number>;
  endpoints: number;
  stats: ReportStats | null;
  reportUrl?: string;
  hasAllure: boolean;
}

export interface ApiOverview {
  kpis: {
    runs: number;
    runsLast30d: number;
    scenarios: number;
    endpointsCovered: number;
    avgPassRate: number | null;
    lastPassRate: number | null;
    lastRunAt: string | null;
    imports: number;
    environments: number;
  };
  trend: { runId: string; at: string; passRate: number; passed: number; failed: number; total: number; durationMs: number; title: string }[];
  categories: Record<string, number>;
  methods: Record<string, number>;
  recentRuns: ApiRunSummary[];
  anomalies: { name: string; kind: 'flaky' | 'slow' | 'new-failure'; detail: string; runs: number }[];
  slowest: { name: string; durationMs: number; runId: string }[];
  imports: { total: number; byMethod: Record<string, number>; recent: { id: string; method: string; name: string; format: string; endpointCount: number; createdAt: string; createdBy: string }[] };
}

function reportUrlFor(runId: string, hasAllure: boolean): string {
  return hasAllure ? `/api/allure/report/${runId}/allure/index.html` : `/api/allure/report/${runId}/index.html`;
}

/** Every API run for the tenant (newest first) with its case metadata. */
async function loadApiRuns(tenantId: string, limit = 200): Promise<Map<string, ApiRunSummary>> {
  const { rows } = await pool.query(
    `SELECT tr.id, tr.story_title, tr.source, tr.username, tr.created_at,
            tc.type, tc.api_meta
       FROM test_runs tr
       JOIN test_cases tc ON tc.test_run_id = tr.id
      WHERE tr.tenant_id = $1 AND tc.module = 'API'
      ORDER BY tr.created_at DESC`,
    [tenantId],
  );
  const runs = new Map<string, ApiRunSummary>();
  const endpointSets = new Map<string, Set<string>>();
  for (const r of rows) {
    const id = String(r.id).toUpperCase();
    let run = runs.get(id);
    if (!run) {
      if (runs.size >= limit) continue;
      run = {
        runId: String(r.id), title: r.story_title || 'API run', createdAt: r.created_at, createdBy: r.username || '',
        source: r.source || 'api', caseCount: 0, categories: {}, endpoints: 0, stats: null, hasAllure: false,
      };
      runs.set(id, run);
      endpointSets.set(id, new Set());
    }
    run.caseCount++;
    const t = String(r.type || 'api');
    run.categories[t] = (run.categories[t] || 0) + 1;
    const meta = typeof r.api_meta === 'string' ? safeParse(r.api_meta) : r.api_meta;
    if (meta && typeof meta === 'object' && meta.endpoint) endpointSets.get(id)!.add(`${meta.method || ''} ${meta.endpoint}`);
  }
  for (const [id, set] of endpointSets) runs.get(id)!.endpoints = set.size;
  return runs;
}

function safeParse(s: string): any {
  try { return JSON.parse(s); } catch { return null; }
}

/** Attach report stats to runs that have a rendered report. */
async function attachReports(tenantId: string, runs: Map<string, ApiRunSummary>): Promise<void> {
  const reports = await listReports(tenantId);
  for (const rep of reports) {
    const run = runs.get(rep.runId.toUpperCase());
    if (!run) continue;
    run.stats = rep.stats;
    run.hasAllure = rep.hasAllure;
    run.reportUrl = reportUrlFor(rep.runId, rep.hasAllure);
  }
}

/**
 * Per-run result cache.
 *
 * A finished run's report never changes, but the dashboard re-read every one
 * of them — hundreds of small JSON files across the last eight runs — on every
 * page load, and again for the trend, the anomalies and the slowest list. The
 * rows are cached by run so the disk is touched once per run per process, with
 * a TTL so a report rebuilt in place is still picked up.
 */
const RESULT_TTL_MS = 5 * 60_000;
const RESULT_CACHE_MAX = 200;
const resultCache = new Map<string, { at: number; rows: ReportResultRow[] }>();

async function resultsFor(tenantId: string, runId: string, hasAllure: boolean): Promise<ReportResultRow[]> {
  const key = `${tenantId}:${runId}`;
  const hit = resultCache.get(key);
  if (hit && Date.now() - hit.at < RESULT_TTL_MS) return hit.rows;

  let rows: ReportResultRow[] = [];
  if (hasAllure) rows = await readAllureResults(tenantId, runId);
  if (!rows.length) {
    const basic = await readBasicReport(tenantId, runId);
    rows = basic?.results || [];
  }
  // An empty result is not cached — the report may still be rendering.
  if (rows.length) {
    if (resultCache.size >= RESULT_CACHE_MAX) resultCache.delete(resultCache.keys().next().value as string);
    resultCache.set(key, { at: Date.now(), rows });
  }
  return rows;
}

/** Drop a run's cached results — called when its report is (re)built. */
export function invalidateApiRunCache(tenantId: string, runId: string): void {
  resultCache.delete(`${tenantId}:${runId}`);
  overviewCache.delete(tenantId);
}

/** The assembled overview, cached briefly: it is a read-only roll-up. */
const OVERVIEW_TTL_MS = 20_000;
const overviewCache = new Map<string, { at: number; data: ApiOverview }>();

/** "TC-003 — Verify GET /posts returns 200" → "Verify GET /posts returns 200" */
function scenarioKey(name: string): string {
  return name.replace(/^\s*TC-\d+\s*[—-]\s*/i, '').trim().toLowerCase();
}

export async function getApiOverview(tenantId: string, opts: { fresh?: boolean } = {}): Promise<ApiOverview> {
  if (!opts.fresh) {
    const hit = overviewCache.get(tenantId);
    if (hit && Date.now() - hit.at < OVERVIEW_TTL_MS) return hit.data;
  }
  const runs = await loadApiRuns(tenantId);
  await attachReports(tenantId, runs);
  const ordered = [...runs.values()].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  const withStats = ordered.filter((r) => r.stats);

  const now = Date.now();
  const runsLast30d = ordered.filter((r) => now - Date.parse(r.createdAt) < 30 * 24 * 3600 * 1000).length;
  const scenarios = ordered.reduce((s, r) => s + r.caseCount, 0);
  const endpointsCovered = ordered.reduce((s, r) => s + r.endpoints, 0);
  const recentStats = withStats.slice(0, 10);
  const avgPassRate = recentStats.length ? Math.round(recentStats.reduce((s, r) => s + (r.stats!.passRate || 0), 0) / recentStats.length) : null;

  const categories: Record<string, number> = {};
  for (const r of ordered.slice(0, 25)) for (const [k, v] of Object.entries(r.categories)) categories[k] = (categories[k] || 0) + v;

  const methods: Record<string, number> = {};
  try {
    const { rows } = await pool.query(
      `SELECT TOP 2000 tc.api_meta FROM test_cases tc JOIN test_runs tr ON tc.test_run_id = tr.id
        WHERE tr.tenant_id = $1 AND tc.module = 'API' AND tc.api_meta IS NOT NULL ORDER BY tc.created_at DESC`,
      [tenantId],
    );
    for (const r of rows) {
      const meta = typeof r.api_meta === 'string' ? safeParse(r.api_meta) : r.api_meta;
      const m = String(meta?.method || '').toUpperCase();
      if (m) methods[m] = (methods[m] || 0) + 1;
    }
  } catch { /* the breakdown is decorative */ }

  // Trend — oldest → newest so the chart reads left to right.
  const trend = withStats.slice(0, 20).reverse().map((r) => ({
    runId: r.runId, at: r.createdAt, title: r.title,
    passRate: r.stats!.passRate, passed: r.stats!.passed, failed: r.stats!.failed, total: r.stats!.total, durationMs: r.stats!.durationMs,
  }));

  // Anomalies — compare per-scenario outcomes across the last runs.
  const anomalies: ApiOverview['anomalies'] = [];
  const slowest: ApiOverview['slowest'] = [];
  const history = withStats.slice(0, 8);
  if (history.length) {
    const perRun = await Promise.all(history.map((r) => resultsFor(tenantId, r.runId, r.hasAllure)));
    const byScenario = new Map<string, { name: string; outcomes: string[]; durations: number[] }>();
    perRun.forEach((rows, idx) => {
      for (const row of rows) {
        const key = scenarioKey(row.name);
        if (!key) continue;
        const entry = byScenario.get(key) || { name: row.name, outcomes: [], durations: [] };
        entry.outcomes[idx] = row.status;
        entry.durations[idx] = row.durationMs;
        byScenario.set(key, entry);
      }
    });
    for (const entry of byScenario.values()) {
      const seen = entry.outcomes.filter(Boolean);
      if (seen.length < 2) continue;
      const passes = seen.filter((s) => s === 'passed' || s === 'flaky').length;
      const fails = seen.filter((s) => s === 'failed' || s === 'broken').length;
      if (passes > 0 && fails > 0) {
        anomalies.push({ name: entry.name, kind: 'flaky', detail: `Passed ${passes}× and failed ${fails}× across the last ${seen.length} runs.`, runs: seen.length });
      } else if ((entry.outcomes[0] === 'failed' || entry.outcomes[0] === 'broken') && seen.slice(1).every((s) => s === 'passed' || s === 'flaky')) {
        anomalies.push({ name: entry.name, kind: 'new-failure', detail: `Failed in the latest run after passing in the previous ${seen.length - 1}.`, runs: seen.length });
      }
      const latest = entry.durations[0];
      const earlier = entry.durations.slice(1).filter((d) => typeof d === 'number' && d > 0);
      if (typeof latest === 'number' && earlier.length >= 2) {
        const median = [...earlier].sort((a, b) => a - b)[Math.floor(earlier.length / 2)]!;
        if (median > 0 && latest > median * 2 && latest > 1500) {
          anomalies.push({ name: entry.name, kind: 'slow', detail: `Took ${(latest / 1000).toFixed(1)}s in the latest run vs a ${(median / 1000).toFixed(1)}s median before.`, runs: seen.length });
        }
      }
    }
    anomalies.sort((a, b) => (a.kind === 'new-failure' ? -1 : 1) - (b.kind === 'new-failure' ? -1 : 1));
    const latestRows = perRun[0] || [];
    for (const row of [...latestRows].sort((a, b) => b.durationMs - a.durationMs).slice(0, 5)) {
      slowest.push({ name: row.name, durationMs: row.durationMs, runId: history[0]!.runId });
    }
  }

  // Imports + environments
  let importsTotal = 0;
  const byMethod: Record<string, number> = {};
  let recentImports: ApiOverview['imports']['recent'] = [];
  try {
    const { rows } = await pool.query(
      `SELECT TOP 200 id, method, name, format, endpoint_count, created_at, created_by FROM api_import_sources WHERE tenant_id = $1 ORDER BY created_at DESC`,
      [tenantId],
    );
    importsTotal = rows.length;
    for (const r of rows) byMethod[r.method] = (byMethod[r.method] || 0) + 1;
    recentImports = rows.slice(0, 8).map((r: any) => ({ id: String(r.id), method: r.method, name: r.name || '', format: r.format || '', endpointCount: Number(r.endpoint_count) || 0, createdAt: r.created_at, createdBy: r.created_by || '' }));
  } catch { /* table may not exist on a very old schema */ }
  let environments = 0;
  try {
    const { rows } = await pool.query(`SELECT COUNT(*)::int AS n FROM api_environments WHERE tenant_id = $1`, [tenantId]);
    environments = Number(rows[0]?.n) || 0;
  } catch { /* ignore */ }

  const overview: ApiOverview = {
    kpis: {
      runs: ordered.length,
      runsLast30d,
      scenarios,
      endpointsCovered,
      avgPassRate,
      lastPassRate: withStats[0]?.stats?.passRate ?? null,
      lastRunAt: ordered[0]?.createdAt || null,
      imports: importsTotal,
      environments,
    },
    trend,
    categories,
    methods,
    recentRuns: ordered.slice(0, 10),
    anomalies: anomalies.slice(0, 12),
    slowest,
    imports: { total: importsTotal, byMethod, recent: recentImports },
  };
  overviewCache.set(tenantId, { at: Date.now(), data: overview });
  return overview;
}

export async function listApiRuns(tenantId: string, page = 1, pageSize = 20): Promise<{ items: ApiRunSummary[]; total: number; page: number; pageSize: number }> {
  const runs = await loadApiRuns(tenantId, 500);
  await attachReports(tenantId, runs);
  const ordered = [...runs.values()].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  const start = (page - 1) * pageSize;
  return { items: ordered.slice(start, start + pageSize), total: ordered.length, page, pageSize };
}

export interface ApiRunDetail extends ApiRunSummary {
  cases: {
    id: string; title: string; type: string; priority: string; feature: string;
    api: any; status: string; durationMs?: number; error?: string;
  }[];
}

export async function getApiRunDetail(tenantId: string, runId: string): Promise<ApiRunDetail | null> {
  const { rows } = await pool.query(
    `SELECT tr.id, tr.story_title, tr.source, tr.username, tr.created_at,
            tc.tc_number, tc.title, tc.type, tc.priority, tc.feature, tc.api_meta, tc.status, tc.sort_order
       FROM test_runs tr JOIN test_cases tc ON tc.test_run_id = tr.id
      WHERE tr.tenant_id = $1 AND tr.id = $2 AND tc.module = 'API'
      ORDER BY tc.sort_order ASC`,
    [tenantId, runId],
  );
  if (!rows.length) return null;
  const first = rows[0];
  const run: ApiRunSummary = {
    runId: String(first.id), title: first.story_title || 'API run', createdAt: first.created_at, createdBy: first.username || '',
    source: first.source || 'api', caseCount: rows.length, categories: {}, endpoints: 0, stats: null, hasAllure: false,
  };
  const reports = await listReports(tenantId);
  const rep = reports.find((r) => r.runId.toUpperCase() === String(first.id).toUpperCase());
  if (rep) { run.stats = rep.stats; run.hasAllure = rep.hasAllure; run.reportUrl = reportUrlFor(rep.runId, rep.hasAllure); }
  const results = rep ? await resultsFor(tenantId, rep.runId, rep.hasAllure) : [];
  const byKey = new Map(results.map((r) => [scenarioKey(r.name), r]));
  const byTc = new Map<string, ReportResultRow>();
  for (const r of results) { const m = /^\s*(TC-\d+)/i.exec(r.name); if (m) byTc.set(m[1]!.toUpperCase(), r); }
  const endpoints = new Set<string>();
  const cases = rows.map((r: any) => {
    const meta = typeof r.api_meta === 'string' ? safeParse(r.api_meta) : r.api_meta;
    if (meta?.endpoint) endpoints.add(`${meta.method || ''} ${meta.endpoint}`);
    run.categories[String(r.type || 'api')] = (run.categories[String(r.type || 'api')] || 0) + 1;
    const res = byTc.get(String(r.tc_number).toUpperCase()) || byKey.get(scenarioKey(r.title));
    return {
      id: r.tc_number, title: r.title, type: r.type, priority: r.priority, feature: r.feature, api: meta || null,
      status: res ? (res.status === 'flaky' ? 'passed' : res.status) : (r.status || 'not_run'),
      durationMs: res?.durationMs,
    };
  });
  run.endpoints = endpoints.size;
  return { ...run, cases };
}

export async function recordImport(tenantId: string, username: string, input: { method: string; name: string; format: string; parser: string; endpointCount: number; warnings?: string[] }): Promise<void> {
  // A new import changes the roll-up's import counts — drop the cached copy.
  overviewCache.delete(tenantId);
  try {
    await pool.query(
      `INSERT INTO api_import_sources (tenant_id, method, name, format, parser, endpoint_count, warnings, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [tenantId, input.method.slice(0, 30), input.name.slice(0, 500), input.format.slice(0, 120), input.parser.slice(0, 30), input.endpointCount, input.warnings?.length ? JSON.stringify(input.warnings) : null, username],
    );
  } catch (err) {
    console.warn('[api-dashboard] could not record import:', (err as Error).message);
  }
}

export async function listImports(tenantId: string, limit = 50): Promise<{ id: string; method: string; name: string; format: string; parser: string; endpointCount: number; warnings: string[]; createdAt: string; createdBy: string }[]> {
  const { rows } = await pool.query(
    `SELECT TOP ${Math.min(200, Math.max(1, limit))} * FROM api_import_sources WHERE tenant_id = $1 ORDER BY created_at DESC`,
    [tenantId],
  );
  return rows.map((r: any) => ({
    id: String(r.id), method: r.method, name: r.name || '', format: r.format || '', parser: r.parser || '',
    endpointCount: Number(r.endpoint_count) || 0,
    warnings: (() => { try { return r.warnings ? (typeof r.warnings === 'string' ? JSON.parse(r.warnings) : r.warnings) : []; } catch { return []; } })(),
    createdAt: r.created_at, createdBy: r.created_by || '',
  }));
}
