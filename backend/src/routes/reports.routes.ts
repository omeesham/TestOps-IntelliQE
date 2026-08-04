import { Router } from 'express';
import type { Request, Response } from 'express';
import pool from '../db.js';
import * as XLSX from 'xlsx';
import { listReports, readAllureResults, getReportStats, readBasicReport, statsFromResults, SAFE_RUN_ID_RE } from '../services/allure-report.service.js';
import { listBlobReports } from '../services/report-storage.service.js';

const router = Router();

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
function fmtDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return `${h ? `${h}h ` : ''}${m ? `${m}m ` : ''}${sec}s`;
}

/**
 * GET /api/reports/summary
 * Real tenant-scoped report data from test_runs + test_cases tables.
 * Platform admins see all tenants; regular users see only their tenant.
 */
router.get('/summary', async (req: Request, res: Response) => {
  try {
    const user = req.user!;
    const tenantId = user.tenantId;
    const isPlatform = user.isPlatform;

    // --- 1. Total test runs ---
    const totalRunsRes = isPlatform
      ? await pool.query(`SELECT COUNT(*)::int AS count FROM test_runs`)
      : await pool.query(`SELECT COUNT(*)::int AS count FROM test_runs WHERE tenant_id = $1`, [tenantId]);
    const totalTestRuns: number = totalRunsRes.rows[0]?.count || 0;

    // --- 2. Total test cases ---
    const totalCasesRes = isPlatform
      ? await pool.query(
          `SELECT COUNT(*)::int AS count FROM test_cases tc JOIN test_runs tr ON tc.test_run_id = tr.id`
        )
      : await pool.query(
          `SELECT COUNT(*)::int AS count FROM test_cases tc JOIN test_runs tr ON tc.test_run_id = tr.id WHERE tr.tenant_id = $1`,
          [tenantId]
        );
    const totalTestCases: number = totalCasesRes.rows[0]?.count || 0;

    // --- 3. Status distribution ---
    const statusRes = isPlatform
      ? await pool.query(
          `SELECT COALESCE(tc.status, 'unknown') AS name, COUNT(*)::int AS value
           FROM test_cases tc JOIN test_runs tr ON tc.test_run_id = tr.id
           GROUP BY tc.status ORDER BY value DESC`
        )
      : await pool.query(
          `SELECT COALESCE(tc.status, 'unknown') AS name, COUNT(*)::int AS value
           FROM test_cases tc JOIN test_runs tr ON tc.test_run_id = tr.id
           WHERE tr.tenant_id = $1
           GROUP BY tc.status ORDER BY value DESC`,
          [tenantId]
        );
    const statusDistribution = statusRes.rows;

    // --- 4. Type distribution ---
    const typeRes = isPlatform
      ? await pool.query(
          `SELECT COALESCE(tc.type, 'other') AS name, COUNT(*)::int AS value
           FROM test_cases tc JOIN test_runs tr ON tc.test_run_id = tr.id
           GROUP BY tc.type ORDER BY value DESC`
        )
      : await pool.query(
          `SELECT COALESCE(tc.type, 'other') AS name, COUNT(*)::int AS value
           FROM test_cases tc JOIN test_runs tr ON tc.test_run_id = tr.id
           WHERE tr.tenant_id = $1
           GROUP BY tc.type ORDER BY value DESC`,
          [tenantId]
        );
    const typeDistribution = typeRes.rows;

    // --- 5. Priority distribution ---
    const priorityRes = isPlatform
      ? await pool.query(
          `SELECT COALESCE(tc.priority, 'P2') AS name, COUNT(*)::int AS value
           FROM test_cases tc JOIN test_runs tr ON tc.test_run_id = tr.id
           GROUP BY tc.priority ORDER BY name`
        )
      : await pool.query(
          `SELECT COALESCE(tc.priority, 'P2') AS name, COUNT(*)::int AS value
           FROM test_cases tc JOIN test_runs tr ON tc.test_run_id = tr.id
           WHERE tr.tenant_id = $1
           GROUP BY tc.priority ORDER BY name`,
          [tenantId]
        );
    const priorityDistribution = priorityRes.rows;

    // --- 6. 14-day trends ---
    const trendsRes = isPlatform
      ? await pool.query(
          `SELECT CAST(tr.created_at AS DATE) AS date,
                  COUNT(tc.id)::int AS total,
                  SUM(CASE WHEN tc.status = 'passed' THEN 1 ELSE 0 END)::int AS passed
           FROM test_cases tc JOIN test_runs tr ON tc.test_run_id = tr.id
           WHERE tr.created_at >= DATEADD(DAY, -14, SYSUTCDATETIME())
           GROUP BY CAST(tr.created_at AS DATE) ORDER BY date`
        )
      : await pool.query(
          `SELECT CAST(tr.created_at AS DATE) AS date,
                  COUNT(tc.id)::int AS total,
                  SUM(CASE WHEN tc.status = 'passed' THEN 1 ELSE 0 END)::int AS passed
           FROM test_cases tc JOIN test_runs tr ON tc.test_run_id = tr.id
           WHERE tr.created_at >= DATEADD(DAY, -14, SYSUTCDATETIME()) AND tr.tenant_id = $1
           GROUP BY CAST(tr.created_at AS DATE) ORDER BY date`,
          [tenantId]
        );
    const trends = trendsRes.rows.map((r: any) => ({
      date: new Date(r.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
      total: r.total,
      passed: r.passed,
      passRate: r.total > 0 ? Math.round((r.passed / r.total) * 100) : 0,
    }));

    // --- 7. Recent test runs (last 10) ---
    const recentRunsRes = isPlatform
      ? await pool.query(
          `SELECT tr.id, tr.story_key, tr.story_title, tr.source, tr.created_at,
                  (SELECT COUNT(*)::int FROM test_cases WHERE test_run_id = tr.id) AS case_count
           FROM test_runs tr ORDER BY tr.created_at DESC LIMIT 10`
        )
      : await pool.query(
          `SELECT tr.id, tr.story_key, tr.story_title, tr.source, tr.created_at,
                  (SELECT COUNT(*)::int FROM test_cases WHERE test_run_id = tr.id) AS case_count
           FROM test_runs tr WHERE tr.tenant_id = $1
           ORDER BY tr.created_at DESC LIMIT 10`,
          [tenantId]
        );
    const recentRuns = recentRunsRes.rows.map((r: any) => ({
      id: r.id,
      storyKey: r.story_key,
      storyTitle: r.story_title,
      source: r.source,
      createdAt: r.created_at,
      caseCount: r.case_count,
    }));

    // --- 8. Connected data sources count ---
    const connectedRes = isPlatform
      ? await pool.query(
          `SELECT COUNT(*)::int AS count FROM client_configurations WHERE status = 'connected'`
        )
      : await pool.query(
          `SELECT COUNT(*)::int AS count FROM client_configurations WHERE tenant_id = $1 AND status = 'connected'`,
          [tenantId]
        );
    const connectedSources: number = connectedRes.rows[0]?.count || 0;

    // Calculate overall pass rate
    const passedCount = statusDistribution.find((s: any) => s.name === 'passed')?.value || 0;
    const passRate = totalTestCases > 0 ? Math.round((passedCount / totalTestCases) * 100) : 0;

    res.json({
      totalTestRuns,
      totalTestCases,
      statusDistribution,
      typeDistribution,
      priorityDistribution,
      trends,
      recentRuns,
      connectedSources,
      passRate,
    });
  } catch (err: any) {
    console.error('Reports summary error:', err.message);
    res.status(500).json({ error: 'Failed to fetch reports summary' });
  }
});

/**
 * GET /api/reports/history?page=&pageSize=&source=&type=&search=
 * Paginated history of every generated report, enriched with the originating
 * run's source/story/module (from test_runs) so the dashboard can show WHERE
 * each report came from and classify by type.
 */
router.get('/history', async (req: Request, res: Response) => {
  try {
    const user = req.user!;
    const page = Math.max(1, parseInt(String(req.query.page ?? '1'), 10) || 1);
    const pageSize = Math.min(50, Math.max(1, parseInt(String(req.query.pageSize ?? '10'), 10) || 10));
    const sourceFilter = req.query.source ? String(req.query.source).toLowerCase() : '';
    const typeFilter = req.query.type ? String(req.query.type).toLowerCase() : ''; // 'allure' | 'basic'
    const search = req.query.search ? String(req.query.search).toLowerCase() : '';

    // Local filesystem reports, unioned with any reports that live only in cloud
    // blob storage (e.g. a report built before a redeploy wiped the ephemeral
    // container FS, or on another replica). Local copies win on runId collision.
    const localReports = await listReports(user.tenantId);
    const blobReports = await listBlobReports(user.tenantId);
    const byRunId = new Map<string, typeof localReports[number]>();
    for (const r of blobReports) byRunId.set(r.runId, r);
    for (const r of localReports) byRunId.set(r.runId, r); // local overrides blob
    const reports = Array.from(byRunId.values())
      .sort((a, b) => (Date.parse(b.generatedAt) || 0) - (Date.parse(a.generatedAt) || 0));

    // Enrich with run metadata (source/story/module) for report dirs that map to
    // a saved test_runs row (UUID dirs). Ephemeral chat runs (chat-<ts>) have no
    // DB record — label their source 'chat'.
    const runMeta = new Map<string, any>();
    try {
      const { rows } = await pool.query(
        `SELECT id, story_key, story_title, source, module, submodule, username AS created_by, created_at
           FROM test_runs WHERE tenant_id = $1`,
        [user.tenantId],
      );
      for (const r of rows) runMeta.set(String(r.id).toUpperCase(), r);
    } catch { /* history still works without run metadata */ }

    let items = reports.map((r) => {
      const m = runMeta.get(r.runId.toUpperCase());
      const isChat = r.runId.startsWith('chat-');
      return {
        runId: r.runId,
        generatedAt: r.generatedAt,
        hasBasic: r.hasBasic,
        hasAllure: r.hasAllure,
        reportType: r.hasAllure ? 'allure' : 'basic',
        stats: r.stats,
        source: m?.source || (isChat ? 'chat' : 'ad-hoc'),
        story: m?.story_title || m?.story_key || null,
        storyKey: m?.story_key || null,
        module: m?.module || null,
        submodule: m?.submodule || null,
        createdBy: m?.created_by || null,
        origin: m ? 'Saved run' : (isChat ? 'Chat run' : 'Ad-hoc run'),
      };
    });

    if (sourceFilter) items = items.filter((i) => (i.source || '').toLowerCase() === sourceFilter);
    if (typeFilter) items = items.filter((i) => i.reportType === typeFilter);
    if (search) items = items.filter((i) =>
      `${i.story || ''} ${i.storyKey || ''} ${i.module || ''} ${i.runId}`.toLowerCase().includes(search));

    // Facets for the UI filters (from the full, unpaginated set).
    const sources = Array.from(new Set(reports.map((r) => {
      const m = runMeta.get(r.runId.toUpperCase());
      return m?.source || (r.runId.startsWith('chat-') ? 'chat' : 'ad-hoc');
    }))).filter(Boolean);

    const total = items.length;
    const start = (page - 1) * pageSize;
    res.json({
      items: items.slice(start, start + pageSize),
      total,
      page,
      pageSize,
      totalPages: Math.max(1, Math.ceil(total / pageSize)),
      facets: { sources },
    });
  } catch (err: any) {
    console.error('Reports history error:', err.message);
    res.status(500).json({ error: 'Failed to load report history' });
  }
});

/**
 * GET /api/reports/:runId/export?format=xlsx|pdf
 * Download a report as Excel (summary + per-test sheets) or PDF (rendered
 * summary). Per-test rows come from the Allure suite data; the summary comes
 * from the Allure statistic widget.
 */
router.get('/:runId/export', async (req: Request, res: Response) => {
  try {
    const user = req.user!;
    const runId = String(req.params.runId || '');
    const format = String(req.query.format || 'xlsx').toLowerCase();

    // Express decodes %2F after route matching — a runId with separators is a
    // path-traversal attempt, never a real report.
    if (!SAFE_RUN_ID_RE.test(runId)) {
      res.status(404).json({ error: 'No report data found for this run' });
      return;
    }

    let stats = await getReportStats(user.tenantId, runId);
    let results = await readAllureResults(user.tenantId, runId);

    // Basic reports have no Allure data — their results are embedded in the
    // Playwright HTML report itself. Without this fallback every Basic report
    // exported as 404 "No report data found". Also covers a half-built allure
    // dir whose summary widget survived but whose suites.json didn't.
    if (results.length === 0) {
      const basic = await readBasicReport(user.tenantId, runId);
      if (basic) {
        results = basic.results;
        stats = stats ?? basic.stats;
      }
    }

    // Last resort for saved runs whose report artifact is unreadable: rebuild
    // rows from the run's test cases in the DB (same source the deprecated
    // synthetic Allure path used).
    if (!stats && results.length === 0 && UUID_RE.test(runId)) {
      try {
        const { rows } = await pool.query(
          `SELECT tc.title, tc.status FROM test_cases tc
             JOIN test_runs tr ON tc.test_run_id = tr.id
            WHERE tr.id = $1 AND tr.tenant_id = $2
            ORDER BY tc.sort_order`,
          [runId, user.tenantId],
        );
        if (rows.length > 0) {
          results = rows.map((r: any) => ({
            name: r.title || 'Untitled test case',
            status: r.status === 'passed' ? 'passed'
              : r.status === 'failed' ? 'failed'
                : r.status === 'blocked' ? 'broken' : 'skipped',
            durationMs: 0,
          }));
          stats = statsFromResults(results);
        }
      } catch { /* fall through to 404 */ }
    }

    // Keep the summary header consistent with the rows when only the per-test
    // data survived (e.g. allure suites.json intact, summary widget corrupt) —
    // a null stats would otherwise render "0 passed / 0%" above passing rows.
    if (!stats && results.length > 0) stats = statsFromResults(results);

    if (!stats && results.length === 0) {
      res.status(404).json({ error: 'No report data found for this run' });
      return;
    }

    // Run metadata for the header (best-effort).
    let meta: any = null;
    if (UUID_RE.test(runId)) {
      try {
        const { rows } = await pool.query(
          `SELECT story_key, story_title, source, module, username AS created_by, created_at
             FROM test_runs WHERE id = $1 AND tenant_id = $2`,
          [runId, user.tenantId],
        );
        meta = rows[0] || null;
      } catch { /* ignore */ }
    }
    const title = meta?.story_title || meta?.story_key || (runId.startsWith('chat-') ? 'Chat run' : runId);
    const source = meta?.source || (runId.startsWith('chat-') ? 'chat' : 'ad-hoc');
    const generatedAt = new Date().toISOString();
    const safeName = String(title).replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 60) || 'report';

    if (format === 'xlsx') {
      const summaryRows = [
        ['IntelliQE Test Report'],
        ['Report', title],
        ['Run ID', runId],
        ['Source', source],
        ['Module', meta?.module || '—'],
        ['Generated by', meta?.created_by || '—'],
        ['Exported at', generatedAt],
        [],
        ['Total', stats?.total ?? results.length],
        ['Passed', stats?.passed ?? results.filter((r) => r.status === 'passed').length],
        ['Failed', stats?.failed ?? results.filter((r) => r.status === 'failed').length],
        ['Broken', stats?.broken ?? 0],
        ['Skipped', stats?.skipped ?? 0],
        ['Pass rate', `${stats?.passRate ?? 0}%`],
        ['Duration', fmtDuration(stats?.durationMs || 0)],
      ];
      const resultRows = [
        ['#', 'Test Case', 'Status', 'Duration'],
        ...results.map((r, i) => [i + 1, r.name, r.status, fmtDuration(r.durationMs)]),
      ];
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(summaryRows), 'Summary');
      XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(resultRows), 'Test Results');
      const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename="${safeName}.xlsx"`);
      res.send(buf);
      return;
    }

    if (format === 'pdf') {
      const pdf = await renderReportPdf({ title, runId, source, module: meta?.module, createdBy: meta?.created_by, generatedAt, stats, results });
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="${safeName}.pdf"`);
      res.send(pdf);
      return;
    }

    res.status(400).json({ error: "format must be 'xlsx' or 'pdf'" });
  } catch (err: any) {
    console.error('Report export error:', err.message);
    res.status(500).json({ error: `Failed to export report: ${err.message}` });
  }
});

/** Render a clean one-page PDF summary of a report via headless Chromium. */
async function renderReportPdf(r: {
  title: string; runId: string; source: string; module?: string; createdBy?: string;
  generatedAt: string; stats: any; results: { name: string; status: string; durationMs: number }[];
}): Promise<Buffer> {
  const { chromium } = await import('playwright-core');
  const esc = (s: any) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] || c));
  const st = r.stats || { total: r.results.length, passed: 0, failed: 0, broken: 0, skipped: 0, passRate: 0, durationMs: 0 };
  const badge = (status: string) => {
    const color = status === 'passed' ? '#059669' : status === 'failed' ? '#dc2626' : status === 'broken' ? '#d97706' : '#6b7280';
    return `<span style="color:#fff;background:${color};padding:2px 8px;border-radius:10px;font-size:11px;text-transform:capitalize">${esc(status)}</span>`;
  };
  const rows = r.results.map((t, i) =>
    `<tr><td>${i + 1}</td><td>${esc(t.name)}</td><td>${badge(t.status)}</td><td>${fmtDuration(t.durationMs)}</td></tr>`).join('');
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
    body{font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;color:#1e1b4b;margin:32px;font-size:12px}
    h1{font-size:20px;margin:0 0 4px} .sub{color:#6b7280;font-size:12px;margin-bottom:16px}
    .cards{display:flex;gap:10px;margin:16px 0}
    .card{flex:1;border:1px solid #e5e7eb;border-radius:10px;padding:10px 12px}
    .card .n{font-size:22px;font-weight:700} .card .l{color:#6b7280;font-size:11px;text-transform:uppercase;letter-spacing:.04em}
    table{width:100%;border-collapse:collapse;margin-top:8px} th,td{text-align:left;padding:6px 8px;border-bottom:1px solid #eee;font-size:11px;vertical-align:top}
    th{background:#f5f3ff;color:#4c1d95} .meta{color:#6b7280;font-size:11px}
  </style></head><body>
    <h1>IntelliQE Test Report</h1>
    <div class="sub">${esc(r.title)}</div>
    <div class="meta">Source: <b>${esc(r.source)}</b> &nbsp;·&nbsp; Module: ${esc(r.module || '—')} &nbsp;·&nbsp; Run: ${esc(r.runId)} &nbsp;·&nbsp; By: ${esc(r.createdBy || '—')} &nbsp;·&nbsp; Exported: ${esc(new Date(r.generatedAt).toLocaleString())}</div>
    <div class="cards">
      <div class="card"><div class="n">${st.total}</div><div class="l">Total</div></div>
      <div class="card"><div class="n" style="color:#059669">${st.passed}</div><div class="l">Passed</div></div>
      <div class="card"><div class="n" style="color:#dc2626">${st.failed}</div><div class="l">Failed</div></div>
      <div class="card"><div class="n">${st.passRate}%</div><div class="l">Pass rate</div></div>
      <div class="card"><div class="n" style="font-size:16px">${fmtDuration(st.durationMs)}</div><div class="l">Duration</div></div>
    </div>
    <table><thead><tr><th>#</th><th>Test Case</th><th>Status</th><th>Duration</th></tr></thead><tbody>${rows || '<tr><td colspan="4" class="meta">No per-test data available.</td></tr>'}</tbody></table>
  </body></html>`;

  const browser = await chromium.launch({ headless: true });
  try {
    const p = await browser.newPage();
    await p.setContent(html, { waitUntil: 'load' });
    return await p.pdf({ format: 'A4', printBackground: true, margin: { top: '12mm', bottom: '12mm', left: '10mm', right: '10mm' } });
  } finally {
    await browser.close();
  }
}

export default router;
