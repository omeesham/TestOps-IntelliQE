import { Router } from 'express';
import type { Request, Response } from 'express';
import pool from '../db.js';
import {
  compileExecutionSummary,
  compileDataReport,
  compileAccessibilityReport,
  buildArtifactZip,
} from '../services/artifact-report.service.js';

const router = Router();

/** Helper to load all test data + test cases for a pipeline run */
async function loadRunData(runId: string) {
  const [casesRes, datasetsRes, fieldDataRes, mappingsRes, validationsRes, scriptsRes] = await Promise.all([
    pool.query(
      `SELECT tc_number AS id, title AS scenario, steps, expected AS "expectedResult", type, priority, status, feature, precondition
       FROM test_cases WHERE test_run_id IN (
         SELECT TOP 1 tr.id FROM test_runs tr
         JOIN "JBSTestOpsAI".qa_pipeline_runs pr ON pr.id = $1
         WHERE tr.tenant_id = pr.tenant_id
         AND tr.created_at >= DATEADD(MINUTE, -1, pr.created_at)
         AND tr.created_at <= DATEADD(MINUTE, 10, pr.created_at)
         ORDER BY tr.created_at DESC
       ) ORDER BY sort_order`,
      [runId]
    ).catch(() => ({ rows: [] })),
    pool.query(`SELECT * FROM "JBSTestOpsAI".test_datasets WHERE test_run_id = $1 ORDER BY dataset_id`, [runId]),
    pool.query(`SELECT * FROM "JBSTestOpsAI".test_field_data WHERE test_run_id = $1 ORDER BY field_data_id`, [runId]),
    pool.query(`SELECT * FROM "JBSTestOpsAI".test_data_mapping WHERE test_run_id = $1 ORDER BY test_case_id`, [runId]),
    pool.query(`SELECT * FROM "JBSTestOpsAI".test_data_validations WHERE test_run_id = $1 ORDER BY field`, [runId]),
    pool.query(
      `SELECT file_name, code FROM automation_scripts WHERE test_run_id = $1 ORDER BY file_name`,
      [runId]
    ).catch(() => ({ rows: [] })),
  ]);

  // Also try loading test cases from qa_artifacts if the direct query returned nothing
  let testCases = casesRes.rows;
  if (testCases.length === 0) {
    const artifactRes = await pool.query(
      `SELECT content FROM "JBSTestOpsAI".qa_artifacts WHERE run_id = $1 AND type = 'test-case' AND replaced_by IS NULL ORDER BY name`,
      [runId]
    );
    testCases = artifactRes.rows.map(r => {
      try { return JSON.parse(r.content); } catch { return null; }
    }).filter(Boolean);
  }

  return {
    testCases,
    datasets: datasetsRes.rows,
    fieldData: fieldDataRes.rows,
    mappings: mappingsRes.rows,
    validations: validationsRes.rows,
    scripts: scriptsRes.rows,
  };
}

/* ───────────────────────────────────────────
   GET /api/artifacts/:runId/report
   Compile execution summary + data report
   ─────────────────────────────────────────── */
router.get('/:runId/report', async (req: Request, res: Response) => {
  try {
    const user = req.user!;
    const runId = req.params.runId as string;

    // Verify ownership
    const tenantFilter = user.isPlatform ? '' : ' AND tenant_id = $2';
    const params: any[] = [runId];
    if (!user.isPlatform) params.push(user.tenantId);

    const runRes = await pool.query(`SELECT * FROM "JBSTestOpsAI".qa_pipeline_runs WHERE id = $1${tenantFilter}`, params);
    if (runRes.rows.length === 0) { res.status(404).json({ error: 'Pipeline run not found' }); return; }

    const run = runRes.rows[0];
    const data = await loadRunData(runId);

    const executionSummary = compileExecutionSummary(data.testCases, 0);
    const dataReport = compileDataReport(data.datasets, data.mappings, data.testCases);
    dataReport.total_field_data = data.fieldData.length;

    // Check if accessibility data exists
    let accessibilityReport = null;
    const a11yArtifact = await pool.query(
      `SELECT content FROM "JBSTestOpsAI".qa_artifacts WHERE run_id = $1 AND type = 'test-data' AND replaced_by IS NULL LIMIT 1`,
      [runId]
    );
    if (a11yArtifact.rows.length > 0) {
      try {
        const parsed = JSON.parse(a11yArtifact.rows[0].content);
        if (parsed.accessibility_data && parsed.accessibility_data.length > 0) {
          accessibilityReport = compileAccessibilityReport(parsed.accessibility_data);
        }
      } catch { /* ignore parse errors */ }
    }

    res.json({
      run: { id: run.id, feature: run.feature, module: run.module, status: run.status, created_at: run.created_at },
      executionSummary,
      dataReport,
      accessibilityReport,
    });
  } catch (err: any) {
    console.error('Generate report error:', err.message);
    res.status(500).json({ error: 'Failed to generate report' });
  }
});

/* ───────────────────────────────────────────
   GET /api/artifacts/:runId/download
   Download ZIP with all artifacts
   ─────────────────────────────────────────── */
router.get('/:runId/download', async (req: Request, res: Response) => {
  try {
    const user = req.user!;
    const runId = req.params.runId as string;

    // Verify ownership
    const tenantFilter = user.isPlatform ? '' : ' AND tenant_id = $2';
    const params: any[] = [runId];
    if (!user.isPlatform) params.push(user.tenantId);

    const runRes = await pool.query(`SELECT * FROM "JBSTestOpsAI".qa_pipeline_runs WHERE id = $1${tenantFilter}`, params);
    if (runRes.rows.length === 0) { res.status(404).json({ error: 'Pipeline run not found' }); return; }

    const data = await loadRunData(runId);
    const executionSummary = compileExecutionSummary(data.testCases, 0);
    const dataReport = compileDataReport(data.datasets, data.mappings, data.testCases);
    dataReport.total_field_data = data.fieldData.length;

    // Check for accessibility data from artifact
    let accessibilityData: unknown[] = [];
    let accessibilityReport = undefined;
    const a11yArtifact = await pool.query(
      `SELECT content FROM "JBSTestOpsAI".qa_artifacts WHERE run_id = $1 AND type = 'test-data' AND replaced_by IS NULL LIMIT 1`,
      [runId]
    );
    if (a11yArtifact.rows.length > 0) {
      try {
        const parsed = JSON.parse(a11yArtifact.rows[0].content);
        if (parsed.accessibility_data && parsed.accessibility_data.length > 0) {
          accessibilityData = parsed.accessibility_data;
          accessibilityReport = compileAccessibilityReport(parsed.accessibility_data);
        }
      } catch { /* ignore */ }
    }

    const shortId = runId.slice(0, 8);
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="qe-artifacts-${shortId}.zip"`);

    buildArtifactZip({
      testCases: data.testCases,
      datasets: data.datasets,
      fieldData: data.fieldData,
      mappings: data.mappings,
      validations: data.validations,
      accessibilityData,
      executionSummary,
      dataReport,
      accessibilityReport,
      automationScripts: data.scripts,
    }, res);
  } catch (err: any) {
    console.error('Download artifacts error:', err.message);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Failed to generate artifact ZIP' });
    }
  }
});

export default router;
