import { Router } from 'express';
import type { Request, Response } from 'express';
import pool from '../db.js';

const router = Router();

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
 * GET /api/reports/coverage?from=&to=
 * Test-case coverage dashboard data. Unlike /summary (which keys pass/fail off
 * the lifecycle status), this uses the REAL execution outcome stored on
 * automation_scripts.last_run_result. Tenant-scoped; optional date range on the
 * run's created_at. Returns KPIs, distributions, a trend, and a per-run table.
 */
router.get('/coverage', async (req: Request, res: Response) => {
  try {
    const user = req.user!;
    const isPlatform = user.isPlatform;
    const tenantId = user.tenantId;
    const from = typeof req.query.from === 'string' && req.query.from ? req.query.from : null;
    const to = typeof req.query.to === 'string' && req.query.to ? req.query.to : null;

    // Shared WHERE + params (tenant + date range on the run's created_at).
    const params: any[] = [];
    const conds: string[] = [];
    if (!isPlatform) { params.push(tenantId); conds.push(`tr.tenant_id = $${params.length}`); }
    if (from) { params.push(from); conds.push(`tr.created_at >= $${params.length}`); }
    if (to) { params.push(to); conds.push(`tr.created_at <= $${params.length}`); }
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';

    // Every test case, joined to its run (tenant/date) + its automation script (outcome).
    const BASE = `FROM test_cases tc
      JOIN test_runs tr ON tc.test_run_id = tr.id
      LEFT JOIN automation_scripts s ON s.test_run_id = tr.id AND s.test_case_id = tc.id`;
    const PASSED = `SUM(CASE WHEN s.last_run_result = 'passed' THEN 1 ELSE 0 END)`;
    const FAILED = `SUM(CASE WHEN s.last_run_result = 'failed' THEN 1 ELSE 0 END)`;

    // 1. KPIs
    const kpi = (await pool.query(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN s.id IS NOT NULL THEN 1 ELSE 0 END) AS scripted,
              ${PASSED} AS passed,
              ${FAILED} AS failed
       ${BASE} ${where}`, params)).rows[0] || {};
    const total = Number(kpi.total) || 0;
    const scripted = Number(kpi.scripted) || 0;
    const passed = Number(kpi.passed) || 0;
    const failed = Number(kpi.failed) || 0;
    const executed = passed + failed;
    const notRun = Math.max(0, total - executed);

    const totalRuns = Number((await pool.query(
      `SELECT COUNT(DISTINCT tr.id) AS runs ${BASE} ${where}`, params)).rows[0]?.runs) || 0;

    // 2. Distributions (type / priority / feature)
    const dist = async (col: string, top?: number) => (await pool.query(
      `SELECT ${top ? `TOP ${top}` : ''} COALESCE(NULLIF(LTRIM(RTRIM(${col})), ''), 'Unspecified') AS name, COUNT(*) AS value
       ${BASE} ${where} GROUP BY COALESCE(NULLIF(LTRIM(RTRIM(${col})), ''), 'Unspecified') ORDER BY value DESC`,
      params)).rows.map((r: any) => ({ name: String(r.name), value: Number(r.value) || 0 }));
    const byType = await dist('tc.type');
    const byPriority = await dist('tc.priority');
    const byFeature = await dist('tc.feature', 8);

    // 3. Trend — day buckets for short ranges, month buckets for long/all-time.
    let granularity: 'day' | 'month' = 'day';
    if (!from) granularity = 'month';
    else if (to) {
      const span = (new Date(to).getTime() - new Date(from).getTime()) / 86_400_000;
      granularity = span > 92 ? 'month' : 'day';
    }
    const bucketExpr = granularity === 'month'
      ? `CONVERT(varchar(7), tr.created_at, 126)`        // 'YYYY-MM'
      : `CONVERT(varchar(10), tr.created_at, 23)`;       // 'YYYY-MM-DD'
    const trend = (await pool.query(
      `SELECT ${bucketExpr} AS bucket, COUNT(*) AS total, ${PASSED} AS passed, ${FAILED} AS failed
       ${BASE} ${where} GROUP BY ${bucketExpr} ORDER BY bucket`, params)).rows.map((r: any) => ({
      bucket: String(r.bucket),
      total: Number(r.total) || 0,
      passed: Number(r.passed) || 0,
      failed: Number(r.failed) || 0,
    }));

    // 4. Per-run coverage (most recent 50 in range)
    const runs = (await pool.query(
      `SELECT TOP 50 tr.id, tr.story_key, tr.story_title, tr.source, tr.platform, tr.created_at,
              COUNT(tc.id) AS total, ${PASSED} AS passed, ${FAILED} AS failed
       ${BASE} ${where}
       GROUP BY tr.id, tr.story_key, tr.story_title, tr.source, tr.platform, tr.created_at
       ORDER BY tr.created_at DESC`, params)).rows.map((r: any) => {
      const t = Number(r.total) || 0, p = Number(r.passed) || 0, f = Number(r.failed) || 0;
      return {
        id: r.id, storyKey: r.story_key, storyTitle: r.story_title, source: r.source,
        platform: r.platform || null, createdAt: r.created_at,
        total: t, passed: p, failed: f, notRun: Math.max(0, t - p - f),
      };
    });

    res.json({
      range: { from, to, granularity },
      summary: {
        total, scripted, executed, passed, failed, notRun, totalRuns,
        automationCoverage: total > 0 ? Math.round((scripted / total) * 100) : 0,
        passRate: executed > 0 ? Math.round((passed / executed) * 100) : 0,
      },
      byStatus: [
        { name: 'Passed', value: passed },
        { name: 'Failed', value: failed },
        { name: 'Not run', value: notRun },
      ],
      byType,
      byPriority,
      byFeature,
      trend,
      runs,
    });
  } catch (err: any) {
    console.error('Coverage report error:', err.message);
    res.status(500).json({ error: 'Failed to fetch coverage report' });
  }
});

export default router;
