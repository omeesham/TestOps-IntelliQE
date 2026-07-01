import { Router, Request, Response } from 'express';
import pool from '../db.js';
import { runClaudePrompt, isClaudeCliAuthenticated, parseJsonFromResponse } from '../agents/claude-runner.js';
import { executeRunScripts, PlaywrightRunError } from '../services/playwright-runner.service.js';
import { healRunScripts } from '../services/healing.service.js';
import { hydrateAnthropicEnv } from '../services/llm-config.service.js';
import { buildPomSpecPrompt, pomFallbackSpec, type PomCasePayload } from '../agents/pom-spec-prompt.js';

const router = Router();
const SCHEMA = process.env.DB_SCHEMA || 'JBSTestOpsAI';

/* ────────────────────────────────────────────
   GET /api/automation-scripts
   List scripts, optionally filtered by test_run_id
   ──────────────────────────────────────────── */
router.get('/', async (req: Request, res: Response) => {
  try {
    const tenantId = req.user!.tenantId;
    const { test_run_id, page = '1', limit = '10', search = '' } = req.query;
    const pageNum = Math.max(1, parseInt(page as string));
    const limitNum = Math.min(50, Math.max(1, parseInt(limit as string)));
    const offset = (pageNum - 1) * limitNum;

    let where = `WHERE s.tenant_id = $1`;
    const params: any[] = [tenantId];

    if (test_run_id) {
      params.push(test_run_id);
      where += ` AND s.test_run_id = $${params.length}`;
    }
    if (search) {
      params.push(`%${search}%`);
      where += ` AND (s.file_name ILIKE $${params.length} OR s.test_case_title ILIKE $${params.length} OR s.tc_number ILIKE $${params.length})`;
    }

    const countRes = await pool.query(`SELECT COUNT(*) AS count FROM ${SCHEMA}.automation_scripts s ${where}`, params);
    const total = parseInt(countRes.rows[0].count);

    const dataRes = await pool.query(`
      SELECT s.*,
        r.story_key, r.story_title
      FROM ${SCHEMA}.automation_scripts s
      LEFT JOIN ${SCHEMA}.test_runs r ON r.id = s.test_run_id
      ${where}
      ORDER BY s.created_at DESC
      LIMIT $${params.length + 1} OFFSET $${params.length + 2}
    `, [...params, limitNum, offset]);

    res.json({
      scripts: dataRes.rows,
      pagination: { page: pageNum, limit: limitNum, total, totalPages: Math.ceil(total / limitNum) },
    });
  } catch (err: any) {
    console.error('List scripts error:', err);
    res.status(500).json({ error: err.message });
  }
});

/* ────────────────────────────────────────────
   GET /api/automation-scripts/:id
   Get single script with full code
   ──────────────────────────────────────────── */
router.get('/:id', async (req: Request, res: Response) => {
  try {
    const tenantId = req.user!.tenantId;
    const { id } = req.params;
    const result = await pool.query(
      `SELECT s.*, r.story_key, r.story_title
       FROM ${SCHEMA}.automation_scripts s
       LEFT JOIN ${SCHEMA}.test_runs r ON r.id = s.test_run_id
       WHERE s.id = $1 AND s.tenant_id = $2`,
      [id, tenantId]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Script not found' });
    res.json({ script: result.rows[0] });
  } catch (err: any) {
    console.error('Get script error:', err);
    res.status(500).json({ error: err.message });
  }
});

/* ────────────────────────────────────────────
   PUT /api/automation-scripts/:id
   Update script code (admin edit)
   ──────────────────────────────────────────── */
router.put('/:id', async (req: Request, res: Response) => {
  try {
    const tenantId = req.user!.tenantId;
    const { id } = req.params;
    const { code, file_name, status } = req.body;

    const updates: string[] = [];
    const vals: any[] = [];
    let idx = 1;

    if (code !== undefined) { updates.push(`code = $${idx++}`); vals.push(code); updates.push(`version = version + 1`); }
    if (file_name !== undefined) { updates.push(`file_name = $${idx++}`); vals.push(file_name); }
    if (status !== undefined) { updates.push(`status = $${idx++}`); vals.push(status); }
    updates.push(`updated_at = NOW()`);

    if (vals.length === 0) return res.status(400).json({ error: 'No updates provided' });

    vals.push(id, tenantId);
    const result = await pool.query(
      `UPDATE ${SCHEMA}.automation_scripts SET ${updates.join(', ')} WHERE id = $${idx++} AND tenant_id = $${idx} RETURNING *`,
      vals
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Script not found' });
    res.json({ script: result.rows[0] });
  } catch (err: any) {
    console.error('Update script error:', err);
    res.status(500).json({ error: err.message });
  }
});

/* ────────────────────────────────────────────
   DELETE /api/automation-scripts/:id
   ──────────────────────────────────────────── */
router.delete('/:id', async (req: Request, res: Response) => {
  try {
    const tenantId = req.user!.tenantId;
    const { id } = req.params;
    await pool.query(`DELETE FROM ${SCHEMA}.automation_scripts WHERE id = $1 AND tenant_id = $2`, [id, tenantId]);
    res.json({ ok: true });
  } catch (err: any) {
    console.error('Delete script error:', err);
    res.status(500).json({ error: err.message });
  }
});

/* ────────────────────────────────────────────
   POST /api/automation-scripts/generate/:testRunId
   Generate scripts for all reviewed test cases in a run
   ──────────────────────────────────────────── */
router.post('/generate/:testRunId', async (req: Request, res: Response) => {
  try {
    const tenantId = req.user!.tenantId;
    const username = req.user!.username || 'system';
    const { testRunId } = req.params;

    // Get test run info
    const runRes = await pool.query(
      `SELECT * FROM ${SCHEMA}.test_runs WHERE id = $1 AND tenant_id = $2`, [testRunId, tenantId]
    );
    if (runRes.rows.length === 0) return res.status(404).json({ error: 'Test run not found' });
    const run = runRes.rows[0];

    // `regenerate: true` forces fresh generation (clears prior scripts). Otherwise,
    // if scripts already exist for this run, return them directly rather than
    // re-invoking Claude — those are real, previously-generated artifacts, so
    // returning them is caching, not simulation.
    const regenerate = req.body?.regenerate === true;
    if (regenerate) {
      await pool.query(
        `DELETE FROM ${SCHEMA}.automation_scripts WHERE test_run_id = $1 AND tenant_id = $2`,
        [testRunId, tenantId]
      );
    } else {
      const existingScripts = await pool.query(
        `SELECT * FROM ${SCHEMA}.automation_scripts WHERE test_run_id = $1 AND tenant_id = $2
         ORDER BY tc_number, created_at`, [testRunId, tenantId]
      );
      if (existingScripts.rows.length > 0) {
        return res.json({ ok: true, generated: 0, total: existingScripts.rows.length, scripts: existingScripts.rows, cached: true });
      }
    }

    // Get test cases eligible for scripting (generated by the wizard, or reviewed/
    // approved; 'scripted' included so a partially-completed run can resume).
    const casesRes = await pool.query(
      `SELECT * FROM ${SCHEMA}.test_cases WHERE test_run_id = $1 AND status IN ('generated', 'reviewed', 'approved', 'scripted')
       ORDER BY sort_order, created_at`, [testRunId]
    );
    if (casesRes.rows.length === 0) {
      return res.status(400).json({ error: 'No test cases found for this run. Generate and save test cases first.' });
    }

    const testCases = casesRes.rows;

    // Get app context for target URL
    let appContext: any = null;
    try {
      const appRes = await pool.query(
        `SELECT config_data FROM ${SCHEMA}.client_configurations
         WHERE tenant_id = $1 AND integration_id LIKE 'app-%' AND status = 'connected'
         ORDER BY updated_at DESC LIMIT 1`, [tenantId]
      );
      if (appRes.rows.length > 0) appContext = appRes.rows[0].config_data;
    } catch { /* ignore */ }

    const targetUrl = appContext?.baseUrl || appContext?.targetUrl || 'https://example.com';
    const appName = appContext?.name || run.story_title || 'Application';

    // Generate scripts via the Anthropic API (key from LLM Configuration), with a
    // template fallback if the AI is unavailable or returns nothing usable.
    await hydrateAnthropicEnv(tenantId);
    const scripts: Array<{ testCaseId: string; tcNumber: string; title: string; fileName: string; code: string }> = [];

    if (isClaudeCliAuthenticated()) {
      // Generate in small batches so each Claude call returns COMPLETE output.
      // POM specs are verbose (a page-object class per spec), so a single call
      // for all cases would overflow the token limit and truncate the JSON,
      // forcing the template fallback. 4 per call keeps every response whole.
      const BATCH_SIZE = 4;

      const batches: any[][] = [];
      for (let start = 0; start < testCases.length; start += BATCH_SIZE) {
        batches.push(testCases.slice(start, start + BATCH_SIZE));
      }
      // Each batch is an independent Claude call — run them CONCURRENTLY (the
      // async runner no longer blocks) so a 15-case run takes ~one call's
      // wall-time instead of 4 serial calls. Concurrency is capped below.
      const runBatch = async (batch: any[]) => {
        const cases: PomCasePayload[] = batch.map((tc: any) => ({
          testCaseId: tc.id,
          tcNumber: tc.tc_number,
          title: tc.title,
          feature: tc.feature || '',
          precondition: tc.precondition || '',
          steps: tc.steps || [],
          testSteps: tc.test_steps || [],
          testData: tc.test_data || {},
          expectedResult: tc.expected_result || tc.expected || '',
          type: tc.type,
          priority: tc.priority,
        }));

        // Single shared POM convention — identical to the pipeline's scriptAgent.
        const prompt = buildPomSpecPrompt(cases, {
          appName,
          targetUrl,
          story: `${run.story_key || ''} - ${run.story_title || ''}`.trim(),
        });

        try {
          const raw = await runClaudePrompt(prompt, { maxTokens: 16000 });
          const parsed = parseJsonFromResponse(raw);
          if (Array.isArray(parsed)) {
            for (const item of parsed) {
              const tc = batch.find((t: any) => t.id === item.testCaseId)
                || testCases.find((t: any) => t.id === item.testCaseId);
              if (!item?.code) continue;
              scripts.push({
                testCaseId: item.testCaseId,
                tcNumber: tc?.tc_number || '',
                title: tc?.title || '',
                fileName: item.fileName || `test-${scripts.length + 1}.spec.ts`,
                code: item.code,
              });
            }
          }
        } catch (err: any) {
          console.error('Claude script generation failed for a batch:', err.message);
        }
      };
      // Run batches in parallel, capped so a very large run doesn't spawn dozens
      // of CLI processes at once. Tunable via SCRIPT_GEN_CONCURRENCY.
      const MAX_CONCURRENT = Number(process.env.SCRIPT_GEN_CONCURRENCY) || 4;
      for (let i = 0; i < batches.length; i += MAX_CONCURRENT) {
        await Promise.all(batches.slice(i, i + MAX_CONCURRENT).map(runBatch));
      }
    }

    // Fallback: generate self-contained POM template specs if Claude didn't
    // produce results. Uses the SAME pomFallbackSpec as the pipeline so the
    // template output is identical and still POM-compliant (a Page Object class
    // + a runnable test), never flat raw-page.* code.
    if (scripts.length === 0) {
      for (const tc of testCases) {
        const fb = pomFallbackSpec(
          {
            testCaseId: tc.id,
            tcNumber: tc.tc_number,
            title: tc.title,
            feature: tc.feature || '',
            precondition: tc.precondition || '',
            steps: tc.steps || [],
            testSteps: tc.test_steps || [],
            expectedResult: tc.expected_result || tc.expected || '',
          },
          targetUrl,
        );
        scripts.push({
          testCaseId: tc.id,
          tcNumber: tc.tc_number,
          title: tc.title,
          fileName: fb.fileName,
          code: fb.code,
        });
      }
    }

    // Save to DB
    const savedScripts: any[] = [];
    for (const script of scripts) {
      // ON CONFLICT DO NOTHING + RETURNING * → conditional INSERT...SELECT that
      // emits the row only when no existing (test_run_id, test_case_id) row exists.
      const insertRes = await pool.query(`
        INSERT INTO ${SCHEMA}.automation_scripts
          (tenant_id, test_run_id, test_case_id, tc_number, test_case_title, file_name, language, framework, code, status, created_by)
        OUTPUT INSERTED.*
        SELECT $1, $2, $3, $4, $5, $6, 'typescript', 'playwright', $7, 'generated', $8
        WHERE NOT EXISTS (
          SELECT 1 FROM ${SCHEMA}.automation_scripts
          WHERE test_run_id = $2 AND test_case_id = $3
        )
      `, [tenantId, testRunId, script.testCaseId, script.tcNumber, script.title, script.fileName, script.code, username]);

      if (insertRes.rows.length > 0) {
        savedScripts.push(insertRes.rows[0]);
      }
    }

    // Update test case status to 'scripted'
    await pool.query(
      `UPDATE ${SCHEMA}.test_cases SET status = 'scripted'
       WHERE test_run_id = $1 AND status IN ('generated', 'reviewed', 'approved')`, [testRunId]
    );

    // Return ALL scripts for the run (newly inserted + any that already existed),
    // so re-running on the same run still returns the full set rather than an
    // empty array that the UI would read as "no scripts".
    const allScriptsRes = await pool.query(
      `SELECT * FROM ${SCHEMA}.automation_scripts WHERE test_run_id = $1 AND tenant_id = $2
       ORDER BY tc_number, created_at`, [testRunId, tenantId]
    );

    res.json({
      ok: true,
      generated: savedScripts.length,
      total: testCases.length,
      scripts: allScriptsRes.rows,
    });
  } catch (err: any) {
    console.error('Generate scripts error:', err);
    res.status(500).json({ error: err.message });
  }
});

/* ────────────────────────────────────────────
   GET /api/automation-scripts/by-run/:testRunId
   Get all scripts for a test run
   ──────────────────────────────────────────── */
router.get('/by-run/:testRunId', async (req: Request, res: Response) => {
  try {
    const tenantId = req.user!.tenantId;
    const { testRunId } = req.params;
    const result = await pool.query(
      `SELECT s.*, r.story_key, r.story_title
       FROM ${SCHEMA}.automation_scripts s
       LEFT JOIN ${SCHEMA}.test_runs r ON r.id = s.test_run_id
       WHERE s.test_run_id = $1 AND s.tenant_id = $2
       ORDER BY s.tc_number, s.created_at`,
      [testRunId, tenantId]
    );
    res.json({ scripts: result.rows });
  } catch (err: any) {
    console.error('Get scripts by run error:', err);
    res.status(500).json({ error: err.message });
  }
});

/* ────────────────────────────────────────────
   POST /api/automation-scripts/execute/:testRunId
   Actually RUN the saved Playwright scripts for a run and return real,
   per-test pass/fail results mapped back to their test cases. This replaces
   the old wizard path that re-ran the generation pipeline and executed nothing.
   ──────────────────────────────────────────── */
router.post('/execute/:testRunId', async (req: Request, res: Response) => {
  const tenantId = req.user!.tenantId;
  const isPlatform = req.user!.isPlatform;
  const testRunId = String(req.params.testRunId);
  try {
    const { details, passed, failed } = await executeRunScripts(tenantId, isPlatform, testRunId);
    res.json({
      runId: testRunId,
      executionDetails: details,
      summary: { totalTests: details.length, passed, failed, executed: true },
    });
  } catch (err: any) {
    if (err instanceof PlaywrightRunError) {
      res.status(err.httpStatus || 500).json(err.toResponseJson(true));
      return;
    }
    console.error('Script execution error:', err.message);
    res.status(500).json({ error: err.message || 'Execution failed' });
  }
});

/* ────────────────────────────────────────────
   POST /api/automation-scripts/heal/:testRunId
   Auto-heal the REAL failing scripts for a run: AI-fix each failing script
   (using its actual code + actual error + test intent), persist the fix, then
   re-run the healed subset and return real per-test results keyed by
   test_case_id. Body: { failures: [{ testCaseId, error }] }.
   ──────────────────────────────────────────── */
router.post('/heal/:testRunId', async (req: Request, res: Response) => {
  const tenantId = req.user!.tenantId;
  const isPlatform = req.user!.isPlatform;
  const testRunId = String(req.params.testRunId);
  const failures = Array.isArray(req.body?.failures) ? req.body.failures : [];
  try {
    const { details, healedCount, stillFailing, quarantined } = await healRunScripts(tenantId, isPlatform, testRunId, failures);
    res.json({
      runId: testRunId,
      // Same shape as /execute so the frontend maps results by testCaseId the same way.
      executionDetails: details,
      summary: { totalTests: details.length, healed: healedCount, stillFailing, quarantined, executed: true },
    });
  } catch (err: any) {
    if (err instanceof PlaywrightRunError) {
      res.status(err.httpStatus || 500).json(err.toResponseJson(true));
      return;
    }
    console.error('Script healing error:', err.message);
    res.status(500).json({ error: err.message || 'Healing failed' });
  }
});

export default router;
