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

export default router;
