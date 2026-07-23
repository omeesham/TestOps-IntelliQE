import { Router } from 'express';
import type { Request, Response } from 'express';
import pool from '../db.js';

const router = Router();

const TAG_VOCAB = ['POSITIVE', 'NEGATIVE', 'E2E', 'UI', 'API', 'SMOKE', 'REGRESSION'];
function normaliseTags(input: unknown): string[] {
  if (!input) return [];
  const arr = Array.isArray(input) ? input : String(input).split(/[\s,;|\[\]]+/);
  return Array.from(new Set(arr.map((t) => String(t).toUpperCase().trim()).filter((t) => TAG_VOCAB.includes(t))));
}

/* ───────────────────────────────────────────
   POST /api/test-cases/save
   Save generated test cases to DB
   ─────────────────────────────────────────── */
router.post('/save', async (req: Request, res: Response) => {
  try {
    const user = req.user!;
    const { storyKey, storyTitle, source, columns, testCases, module, submodule } = req.body;
    if (!Array.isArray(testCases) || testCases.length === 0) {
      res.status(400).json({ error: 'testCases[] are required' });
      return;
    }

    // Create test_run record with tenant_id
    const runResult = await pool.query(
      `INSERT INTO test_runs (username, story_key, story_title, source, columns, tenant_id, module, submodule)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
      [user.username, storyKey || null, storyTitle || null, source || null, JSON.stringify(columns || []), user.tenantId, module || null, submodule || null]
    );
    const testRunId: string = runResult.rows[0].id;

    // Insert test cases
    for (let i = 0; i < testCases.length; i++) {
      const tc = testCases[i];
      const tags = normaliseTags(tc.tags);
      await pool.query(
        `INSERT INTO test_cases
         (test_run_id, tc_number, title, steps, expected, priority, type, feature, precondition, status, sort_order, module, submodule, tags,
          description, test_steps, test_data, severity, traceability_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)`,
        [
          testRunId,
          tc.id || `TC-${String(i + 1).padStart(3, '0')}`,
          // Title first, fall back to scenario, then legacy `title` key — keeps backward compat
          tc.title || tc.scenario || '',
          JSON.stringify(tc.steps || []),
          tc.expectedResult || tc.expected || '',
          tc.priority || 'P1',
          tc.type || 'positive',
          tc.feature || '',
          tc.precondition || '',
          tc.status || 'generated',
          i,
          tc.module || module || null,
          tc.submodule || submodule || null,
          tags,
          // New IEEE-829 fields — null-safe so the row still saves if the LLM omits them
          tc.description || null,
          JSON.stringify(tc.testSteps || []),
          JSON.stringify(tc.testData || {}),
          tc.severity || null,
          tc.traceabilityId || null,
        ]
      );
    }

    console.log(`Saved ${testCases.length} test cases for tenant=${user.tenantId}, user=${user.username}, runId=${testRunId}`);
    res.json({ ok: true, testRunId, count: testCases.length });
  } catch (err: any) {
    console.error('Save test cases error:', err.message);
    res.status(500).json({ error: 'Failed to save test cases' });
  }
});

/* ───────────────────────────────────────────
   GET /api/test-cases
   List all test runs for the current user's tenant
   ─────────────────────────────────────────── */
router.get('/', async (req: Request, res: Response) => {
  try {
    const user = req.user!;
    const page = Math.max(1, parseInt(req.query.page as string) || 1);
    const limit = Math.min(50, Math.max(5, parseInt(req.query.limit as string) || 10));
    const offset = (page - 1) * limit;
    const search = (req.query.search as string || '').trim();

    let where = `WHERE r.tenant_id = $1`;
    const params: any[] = [user.tenantId];

    // Filter by current user only (unless admin)
    if (req.query.mine === 'true') {
      params.push(user.username);
      where += ` AND r.username = $${params.length}`;
    }

    if (search) {
      params.push(`%${search}%`);
      where += ` AND (r.story_key ILIKE $${params.length} OR r.story_title ILIKE $${params.length} OR r.source ILIKE $${params.length} OR r.username ILIKE $${params.length})`;
    }

    const moduleFilter = (req.query.module as string || '').trim();
    if (moduleFilter) {
      params.push(moduleFilter);
      where += ` AND r.module = $${params.length}`;
    }
    const submoduleFilter = (req.query.submodule as string || '').trim();
    if (submoduleFilter) {
      params.push(submoduleFilter);
      where += ` AND r.submodule = $${params.length}`;
    }
    // tags: accept ?tag=POSITIVE&tag=UI (array) or ?tag=POSITIVE (single)
    const rawTags = req.query.tag;
    const tags = (Array.isArray(rawTags) ? rawTags : rawTags ? [rawTags] : [])
      .map((t) => String(t).toUpperCase().trim())
      .filter(Boolean);
    if (tags.length > 0) {
      params.push(tags);
      // Match either the JSON `tags` array (overlap) OR the case `type` — the
      // generator records POSITIVE/NEGATIVE/E2E as type, not as a tag, so a
      // tags-only match would return nothing for those chips.
      where += ` AND EXISTS (SELECT 1 FROM test_cases tc WHERE tc.test_run_id = r.id
        AND (EXISTS (SELECT 1 FROM OPENJSON(tc.tags) jt JOIN OPENJSON($${params.length}) pt ON jt.value = pt.value)
             OR UPPER(tc.type) IN (SELECT value FROM OPENJSON($${params.length}))))`;
    }

    // Count total
    const countRes = await pool.query(`SELECT COUNT(*) AS count FROM test_runs r ${where}`, params);
    const total = parseInt(countRes.rows[0].count);

    // Fetch runs with test case count (::int casts so pg returns numbers, not strings)
    const runsRes = await pool.query(`
      SELECT r.*,
        (SELECT COUNT(*)::int FROM test_cases tc WHERE tc.test_run_id = r.id) AS test_case_count,
        (SELECT COUNT(*)::int FROM test_cases tc WHERE tc.test_run_id = r.id AND tc.status = 'generated') AS generated_count,
        (SELECT COUNT(*)::int FROM test_cases tc WHERE tc.test_run_id = r.id AND tc.status IN ('approved','reviewed')) AS approved_count,
        (SELECT COUNT(*)::int FROM test_cases tc WHERE tc.test_run_id = r.id AND tc.status = 'scripted') AS scripted_count
      FROM test_runs r ${where}
      ORDER BY r.created_at DESC
      LIMIT $${params.length + 1} OFFSET $${params.length + 2}
    `, [...params, limit, offset]);

    res.json({
      runs: runsRes.rows,
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    });
  } catch (err: any) {
    console.error('List test runs error:', err.message);
    res.status(500).json({ error: 'Failed to list test runs' });
  }
});

/* ───────────────────────────────────────────
   GET /api/test-cases/facets
   Return distinct modules / submodules / tags available for this tenant,
   used to populate the filter dropdowns on the frontend.
   ─────────────────────────────────────────── */
router.get('/facets', async (req: Request, res: Response) => {
  try {
    const user = req.user!;
    const modulesRes = await pool.query(
      `SELECT DISTINCT module FROM "JBSTestOpsAI".test_runs
        WHERE tenant_id = $1 AND module IS NOT NULL AND module <> ''
        ORDER BY module`,
      [user.tenantId]
    );
    const submodulesRes = await pool.query(
      `SELECT DISTINCT module, submodule FROM "JBSTestOpsAI".test_runs
        WHERE tenant_id = $1 AND submodule IS NOT NULL AND submodule <> ''
        ORDER BY module, submodule`,
      [user.tenantId]
    );
    // tags is stored as a JSON array string in Azure SQL — UNNEST is Postgres-only
    // and 500s here. Use OPENJSON (the T-SQL equivalent), and keep it NON-FATAL so
    // a bad/empty tags value never blanks the whole Generated Test Cases page.
    let tags: string[] = [];
    try {
      const tagsRes = await pool.query(
        `SELECT DISTINCT jt.value AS tag
           FROM "JBSTestOpsAI".test_cases tc
           JOIN "JBSTestOpsAI".test_runs r ON r.id = tc.test_run_id
           CROSS APPLY OPENJSON(tc.tags) jt
          WHERE r.tenant_id = $1 AND tc.tags IS NOT NULL AND tc.tags <> ''
          ORDER BY tag`,
        [user.tenantId]
      );
      tags = tagsRes.rows.map((r) => r.tag).filter(Boolean);
    } catch (e: any) {
      console.warn('[facets] tags query failed (non-fatal):', e.message);
    }
    res.json({
      modules: modulesRes.rows.map((r) => r.module),
      submodules: submodulesRes.rows.map((r) => ({ module: r.module, name: r.submodule })),
      tags,
    });
  } catch (err: any) {
    console.error('Facets error:', err.message);
    res.status(500).json({ error: 'Failed to fetch facets' });
  }
});

/* ───────────────────────────────────────────
   PUT /api/test-cases/:testRunId/cases/:caseId
   Update a single test case
   ─────────────────────────────────────────── */
router.put('/:testRunId/cases/:caseId', async (req: Request, res: Response) => {
  try {
    const user = req.user!;
    const { testRunId, caseId } = req.params;
    const { title, steps, expected, priority, type, feature, precondition, status, tags } = req.body;

    // Verify ownership
    const runRes = await pool.query(`SELECT id FROM test_runs WHERE id = $1 AND tenant_id = $2`, [testRunId, user.tenantId]);
    if (runRes.rows.length === 0) { res.status(404).json({ error: 'Test run not found' }); return; }

    const updates: string[] = [];
    const vals: any[] = [];
    let idx = 1;

    if (title !== undefined)        { updates.push(`title = $${idx++}`); vals.push(title); }
    if (steps !== undefined)        { updates.push(`steps = $${idx++}`); vals.push(JSON.stringify(steps)); }
    if (expected !== undefined)     { updates.push(`expected = $${idx++}`); vals.push(expected); }
    if (priority !== undefined)     { updates.push(`priority = $${idx++}`); vals.push(priority); }
    if (type !== undefined)         { updates.push(`type = $${idx++}`); vals.push(type); }
    if (feature !== undefined)      { updates.push(`feature = $${idx++}`); vals.push(feature); }
    if (precondition !== undefined) { updates.push(`precondition = $${idx++}`); vals.push(precondition); }
    if (status !== undefined)       { updates.push(`status = $${idx++}`); vals.push(status); }
    if (tags !== undefined)         { updates.push(`tags = $${idx++}`); vals.push(normaliseTags(tags)); }

    if (updates.length === 0) { res.status(400).json({ error: 'No fields to update' }); return; }

    vals.push(caseId, testRunId);
    const result = await pool.query(
      `UPDATE test_cases SET ${updates.join(', ')} WHERE id = $${idx++} AND test_run_id = $${idx} RETURNING *`,
      vals
    );

    if (result.rows.length === 0) { res.status(404).json({ error: 'Test case not found' }); return; }
    res.json({ ok: true, testCase: result.rows[0] });
  } catch (err: any) {
    console.error('Update test case error:', err.message);
    res.status(500).json({ error: 'Failed to update test case' });
  }
});

/* ───────────────────────────────────────────
   POST /api/test-cases/:testRunId/cases
   Add a new test case to an existing run
   ─────────────────────────────────────────── */
router.post('/:testRunId/cases', async (req: Request, res: Response) => {
  try {
    const user = req.user!;
    const { testRunId } = req.params;
    const { title, steps, expected, priority, type, feature, precondition, tags: rawTags } = req.body;

    // Verify ownership
    const runRes = await pool.query(`SELECT id, module, submodule FROM test_runs WHERE id = $1 AND tenant_id = $2`, [testRunId, user.tenantId]);
    if (runRes.rows.length === 0) { res.status(404).json({ error: 'Test run not found' }); return; }
    const runRow = runRes.rows[0];

    // Get next sort_order and tc_number
    const maxRes = await pool.query(`SELECT COALESCE(MAX(sort_order), -1) AS mx, COUNT(*) AS cnt FROM test_cases WHERE test_run_id = $1`, [testRunId]);
    const nextSort = (maxRes.rows[0].mx || 0) + 1;
    const nextNum = `TC-${String(parseInt(maxRes.rows[0].cnt) + 1).padStart(3, '0')}`;
    const tags = normaliseTags(rawTags);

    const result = await pool.query(
      `INSERT INTO test_cases (test_run_id, tc_number, title, steps, expected, priority, type, feature, precondition, status, sort_order, module, submodule, tags)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'generated', $10, $11, $12, $13) RETURNING *`,
      [testRunId, nextNum, title || '', JSON.stringify(steps || []), expected || '', priority || 'P1', type || 'positive', feature || '', precondition || '', nextSort, runRow.module, runRow.submodule, tags]
    );

    res.json({ ok: true, testCase: result.rows[0] });
  } catch (err: any) {
    console.error('Add test case error:', err.message);
    res.status(500).json({ error: 'Failed to add test case' });
  }
});

/* ───────────────────────────────────────────
   DELETE /api/test-cases/:testRunId/cases/:caseId
   Delete a single test case
   ─────────────────────────────────────────── */
router.delete('/:testRunId/cases/:caseId', async (req: Request, res: Response) => {
  try {
    const user = req.user!;
    const { testRunId, caseId } = req.params;

    // Verify ownership
    const runRes = await pool.query(`SELECT id FROM test_runs WHERE id = $1 AND tenant_id = $2`, [testRunId, user.tenantId]);
    if (runRes.rows.length === 0) { res.status(404).json({ error: 'Test run not found' }); return; }

    const result = await pool.query(`DELETE FROM test_cases WHERE id = $1 AND test_run_id = $2 RETURNING id`, [caseId, testRunId]);
    if (result.rows.length === 0) { res.status(404).json({ error: 'Test case not found' }); return; }

    res.json({ ok: true });
  } catch (err: any) {
    console.error('Delete test case error:', err.message);
    res.status(500).json({ error: 'Failed to delete test case' });
  }
});

/* ───────────────────────────────────────────
   DELETE /api/test-cases/:testRunId
   Delete entire test run + all its test cases
   ─────────────────────────────────────────── */
router.delete('/:testRunId', async (req: Request, res: Response) => {
  try {
    const user = req.user!;
    const { testRunId } = req.params;

    // Verify ownership
    const runRes = await pool.query(`SELECT id FROM test_runs WHERE id = $1 AND tenant_id = $2`, [testRunId, user.tenantId]);
    if (runRes.rows.length === 0) { res.status(404).json({ error: 'Test run not found' }); return; }

    await pool.query(`DELETE FROM test_cases WHERE test_run_id = $1`, [testRunId]);
    await pool.query(`DELETE FROM test_runs WHERE id = $1`, [testRunId]);

    res.json({ ok: true });
  } catch (err: any) {
    console.error('Delete test run error:', err.message);
    res.status(500).json({ error: 'Failed to delete test run' });
  }
});

/* ───────────────────────────────────────────
   GET /api/test-cases/:testRunId
   Fetch saved test cases for a run
   ─────────────────────────────────────────── */
router.get('/:testRunId', async (req: Request, res: Response) => {
  try {
    const user = req.user!;
    const { testRunId } = req.params;

    // Verify the test run belongs to this tenant (platform admin sees all)
    const tenantFilter = user.isPlatform ? '' : ' AND tenant_id = $2';
    const params: any[] = [testRunId];
    if (!user.isPlatform) params.push(user.tenantId);

    const runRes = await pool.query(`SELECT * FROM test_runs WHERE id = $1${tenantFilter}`, params);
    if (runRes.rows.length === 0) { res.status(404).json({ error: 'Test run not found' }); return; }

    const rawTags = req.query.tag;
    const tagList = (Array.isArray(rawTags) ? rawTags : rawTags ? [rawTags] : [])
      .map((t) => String(t).toUpperCase().trim())
      .filter(Boolean);
    const caseParams: any[] = [testRunId];
    let tagClause = '';
    if (tagList.length > 0) {
      caseParams.push(tagList);
      // Match tags overlap OR case type (POSITIVE/NEGATIVE/E2E live in `type`,
      // not in the tags array — see the same clause in the runs-list route).
      tagClause = ` AND (EXISTS (SELECT 1 FROM OPENJSON(tags) jt JOIN OPENJSON($${caseParams.length}) pt ON jt.value = pt.value)
        OR UPPER(type) IN (SELECT value FROM OPENJSON($${caseParams.length})))`;
    }
    const casesRes = await pool.query(
      `SELECT * FROM test_cases WHERE test_run_id = $1${tagClause} ORDER BY sort_order`,
      caseParams
    );

    res.json({ testRun: runRes.rows[0], testCases: casesRes.rows });
  } catch (err: any) {
    console.error('Fetch test cases error:', err.message);
    res.status(500).json({ error: 'Failed to fetch test cases' });
  }
});

/* ───────────────────────────────────────────
   GET /api/test-cases/:testRunId/export?format=csv|jira|testrail
   Export test cases in requested format
   ─────────────────────────────────────────── */
router.get('/:testRunId/export', async (req: Request, res: Response) => {
  try {
    const user = req.user!;
    const { testRunId } = req.params;
    const format = (req.query.format as string || 'csv').toLowerCase();

    // Verify the test run belongs to this tenant before exporting its cases
    // (platform admin sees all). Without this, any authenticated user could
    // export another tenant's test cases by supplying their run id.
    const runFilter = user.isPlatform ? '' : ' AND tenant_id = $2';
    const runParams: any[] = [testRunId];
    if (!user.isPlatform) runParams.push(user.tenantId);
    const runRes = await pool.query(`SELECT id FROM test_runs WHERE id = $1${runFilter}`, runParams);
    if (runRes.rows.length === 0) { res.status(404).json({ error: 'Test run not found' }); return; }

    const casesRes = await pool.query(
      `SELECT * FROM test_cases WHERE test_run_id = $1 ORDER BY sort_order`,
      [testRunId]
    );
    if (casesRes.rows.length === 0) { res.status(404).json({ error: 'No test cases found' }); return; }

    const cases = casesRes.rows;

    if (format === 'testrail') {
      // TestRail CSV import format
      const header = 'Title,Steps (Step),Steps (Expected Result),Priority,Type,Preconditions';
      const rows = cases.map(tc => {
        const steps = (tc.steps || []).map((s: string, i: number) => `Step ${i + 1}: ${s}`).join('\n');
        return [
          csvEscape(tc.title),
          csvEscape(steps),
          csvEscape(tc.expected || ''),
          csvEscape(mapPriorityToTestrail(tc.priority)),
          csvEscape(tc.type || 'Functional'),
          csvEscape(tc.precondition || ''),
        ].join(',');
      });
      const csv = '\uFEFF' + header + '\n' + rows.join('\n');
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="testcases-testrail-${testRunId.slice(0, 8)}.csv"`);
      res.send(csv);

    } else if (format === 'jira') {
      // JIRA-compatible CSV (for Zephyr/Xray import)
      const header = 'Test Case ID,Summary,Test Steps,Expected Result,Priority,Labels,Status';
      const rows = cases.map(tc => {
        const steps = (tc.steps || []).map((s: string, i: number) => `${i + 1}. ${s}`).join(' | ');
        return [
          csvEscape(tc.tc_number),
          csvEscape(tc.title),
          csvEscape(steps),
          csvEscape(tc.expected || ''),
          csvEscape(mapPriorityToJira(tc.priority)),
          csvEscape(tc.type || ''),
          csvEscape(tc.status || 'Draft'),
        ].join(',');
      });
      const csv = '\uFEFF' + header + '\n' + rows.join('\n');
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="testcases-jira-${testRunId.slice(0, 8)}.csv"`);
      res.send(csv);

    } else {
      // Default: Standard Excel-compatible CSV
      const header = 'TC Number,Title,Test Steps,Expected Result,Priority,Type,Feature,Precondition,Status';
      const rows = cases.map(tc => {
        const steps = (tc.steps || []).map((s: string, i: number) => `${i + 1}. ${s}`).join('\n');
        return [
          csvEscape(tc.tc_number),
          csvEscape(tc.title),
          csvEscape(steps),
          csvEscape(tc.expected || ''),
          csvEscape(tc.priority || ''),
          csvEscape(tc.type || ''),
          csvEscape(tc.feature || ''),
          csvEscape(tc.precondition || ''),
          csvEscape(tc.status || ''),
        ].join(',');
      });
      const csv = '\uFEFF' + header + '\n' + rows.join('\n');
      const ext = format === 'excel' ? 'csv' : 'csv';
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="testcases-${testRunId.slice(0, 8)}.${ext}"`);
      res.send(csv);
    }
  } catch (err: any) {
    console.error('Export test cases error:', err.message);
    res.status(500).json({ error: 'Failed to export test cases' });
  }
});

/* ───────────────────────────────────────────
   GET /api/test-cases/:testRunId/test-data
   Fetch test data (datasets, field data, mappings, validations) for a pipeline run
   ─────────────────────────────────────────── */
router.get('/:testRunId/test-data', async (req: Request, res: Response) => {
  try {
    const user = req.user!;
    const { testRunId } = req.params;

    // Verify ownership. Test data can hang off an orchestrator run
    // (qa_pipeline_runs) OR a chat-flow run (test_runs) — accept either, since
    // the Generated Tests page passes test_runs ids.
    const tenantFilter = user.isPlatform ? '' : ' AND tenant_id = $2';
    const params: any[] = [testRunId];
    if (!user.isPlatform) params.push(user.tenantId);

    const runRes = await pool.query(`SELECT id FROM "JBSTestOpsAI".qa_pipeline_runs WHERE id = $1${tenantFilter}`, params);
    const owned = runRes.rows.length > 0
      || (await pool.query(`SELECT id FROM "JBSTestOpsAI".test_runs WHERE id = $1${tenantFilter}`, params)).rows.length > 0;
    if (!owned) { res.status(404).json({ error: 'Run not found' }); return; }

    const [datasetsRes, fieldDataRes, mappingsRes, validationsRes] = await Promise.all([
      pool.query(`SELECT * FROM "JBSTestOpsAI".test_datasets WHERE test_run_id = $1 ORDER BY dataset_id`, [testRunId]),
      pool.query(`SELECT * FROM "JBSTestOpsAI".test_field_data WHERE test_run_id = $1 ORDER BY field_data_id`, [testRunId]),
      pool.query(`SELECT * FROM "JBSTestOpsAI".test_data_mapping WHERE test_run_id = $1 ORDER BY test_case_id`, [testRunId]),
      pool.query(`SELECT * FROM "JBSTestOpsAI".test_data_validations WHERE test_run_id = $1 ORDER BY field`, [testRunId]),
    ]);

    res.json({
      datasets: datasetsRes.rows,
      fieldData: fieldDataRes.rows,
      mappings: mappingsRes.rows,
      validations: validationsRes.rows,
    });
  } catch (err: any) {
    console.error('Fetch test data error:', err.message);
    res.status(500).json({ error: 'Failed to fetch test data' });
  }
});

/* ───────────────────────────────────────────
   POST /api/test-cases/:testRunId/test-data
   Bulk-insert test data for a pipeline run
   ─────────────────────────────────────────── */
router.post('/:testRunId/test-data', async (req: Request, res: Response) => {
  try {
    const user = req.user!;
    const { testRunId } = req.params;
    const { datasets, fieldData, mappings, validations } = req.body;

    // Verify ownership — same dual-table check as the GET above.
    const tenantFilter = user.isPlatform ? '' : ' AND tenant_id = $2';
    const params: any[] = [testRunId];
    if (!user.isPlatform) params.push(user.tenantId);

    const runRes = await pool.query(`SELECT id FROM "JBSTestOpsAI".qa_pipeline_runs WHERE id = $1${tenantFilter}`, params);
    const owned = runRes.rows.length > 0
      || (await pool.query(`SELECT id FROM "JBSTestOpsAI".test_runs WHERE id = $1${tenantFilter}`, params)).rows.length > 0;
    if (!owned) { res.status(404).json({ error: 'Run not found' }); return; }

    let insertedCount = 0;

    if (Array.isArray(datasets)) {
      for (const ds of datasets) {
        await pool.query(
          `INSERT INTO "JBSTestOpsAI".test_datasets (test_run_id, dataset_id, role, scenario, fields, layer, source, source_config)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [testRunId, ds.dataset_id, ds.role, ds.scenario || null, JSON.stringify(ds.fields || {}), ds.layer || 'ui', ds.source || 'static', ds.source_config ? JSON.stringify(ds.source_config) : null]
        );
        insertedCount++;
      }
    }

    if (Array.isArray(fieldData)) {
      for (const fd of fieldData) {
        await pool.query(
          `INSERT INTO "JBSTestOpsAI".test_field_data (test_run_id, field_data_id, field_name, value, type, data_type, validation_rule, source, source_detail)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [testRunId, fd.id || fd.field_data_id, fd.field_name, fd.value, fd.type || 'valid', fd.data_type || 'string', fd.validation_rule || null, fd.source || 'static', fd.source_detail || null]
        );
        insertedCount++;
      }
    }

    if (Array.isArray(mappings)) {
      for (const m of mappings) {
        await pool.query(
          `INSERT INTO "JBSTestOpsAI".test_data_mapping (test_run_id, test_case_id, dataset_id)
           VALUES ($1, $2, $3)`,
          [testRunId, m.test_case_id, m.dataset_id]
        );
        insertedCount++;
      }
    }

    if (Array.isArray(validations)) {
      for (const v of validations) {
        await pool.query(
          `INSERT INTO "JBSTestOpsAI".test_data_validations (test_run_id, field, value, validation, reason)
           VALUES ($1, $2, $3, $4, $5)`,
          [testRunId, v.field, v.value, v.validation || 'accepted', v.reason || null]
        );
        insertedCount++;
      }
    }

    res.json({ ok: true, insertedCount });
  } catch (err: any) {
    console.error('Save test data error:', err.message);
    res.status(500).json({ error: 'Failed to save test data' });
  }
});

/* ── Helpers ── */
function csvEscape(val: string): string {
  if (!val) return '""';
  const s = String(val);
  if (s.includes(',') || s.includes('"') || s.includes('\n') || s.includes('\r')) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

function mapPriorityToTestrail(p: string): string {
  switch (p) {
    case 'P0': return 'Critical';
    case 'P1': return 'High';
    case 'P2': return 'Medium';
    case 'P3': return 'Low';
    default: return 'Medium';
  }
}

function mapPriorityToJira(p: string): string {
  switch (p) {
    case 'P0': return 'Highest';
    case 'P1': return 'High';
    case 'P2': return 'Medium';
    case 'P3': return 'Low';
    default: return 'Medium';
  }
}

export default router;
