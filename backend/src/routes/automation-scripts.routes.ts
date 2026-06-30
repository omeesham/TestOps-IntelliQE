import { Router, Request, Response } from 'express';
import pool from '../db.js';
import { runClaudePrompt, isClaudeCliAvailable, parseJsonFromResponse } from '../agents/claude-runner.js';

const router = Router();
const SCHEMA = process.env.DB_SCHEMA || 'JBSTestOpsAI';

/* ────────────────────────────────────────────
   GET /api/automation-scripts
   List scripts, optionally filtered by test_run_id
   ──────────────────────────────────────────── */
router.get('/', async (req: Request, res: Response) => {
  try {
    const tenantId = (req as any).tenantId;
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
    const tenantId = (req as any).tenantId;
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
    const tenantId = (req as any).tenantId;
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
    const tenantId = (req as any).tenantId;
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
    const tenantId = (req as any).tenantId;
    const username = (req as any).username || 'system';
    const { testRunId } = req.params;

    // Get test run info
    const runRes = await pool.query(
      `SELECT * FROM ${SCHEMA}.test_runs WHERE id = $1 AND tenant_id = $2`, [testRunId, tenantId]
    );
    if (runRes.rows.length === 0) return res.status(404).json({ error: 'Test run not found' });
    const run = runRes.rows[0];

    // Get reviewed/approved test cases
    const casesRes = await pool.query(
      `SELECT * FROM ${SCHEMA}.test_cases WHERE test_run_id = $1 AND status IN ('reviewed', 'approved')
       ORDER BY sort_order, created_at`, [testRunId]
    );
    if (casesRes.rows.length === 0) {
      return res.status(400).json({ error: 'No reviewed test cases found. Review test cases first before generating scripts.' });
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

    // Generate scripts using Claude CLI or fallback
    const scripts: Array<{ testCaseId: string; tcNumber: string; title: string; fileName: string; code: string }> = [];

    if (isClaudeCliAvailable()) {
      // Batch generate with Claude CLI
      const tcSummary = testCases.map((tc: any) => ({
        id: tc.id,
        tcNumber: tc.tc_number,
        title: tc.title,
        steps: tc.steps || [],
        expected: tc.expected_result || tc.expected || '',
        precondition: tc.precondition || '',
        type: tc.type,
        priority: tc.priority,
      }));

      const prompt = `You are a senior QA automation engineer. Generate Playwright TypeScript test scripts for these test cases.

Target Application: ${appName}
Target URL: ${targetUrl}
Story: ${run.story_key || ''} - ${run.story_title || ''}

Test Cases:
${JSON.stringify(tcSummary, null, 2)}

RULES:
- Use TypeScript with Playwright test runner
- Use role-based selectors: page.getByRole(), page.getByText(), page.getByLabel(), page.getByPlaceholder()
- NEVER use data-testid or CSS selectors
- Include proper expect() assertions
- Use test.describe() blocks grouped by feature
- Include beforeEach for common setup (navigation, login)
- Add meaningful test names
- Handle async/await properly
- Use page.goto('${targetUrl}') for navigation

Return ONLY a JSON array:
[
  {
    "testCaseId": "<id from above>",
    "fileName": "<kebab-case-name>.spec.ts",
    "code": "<full TypeScript code>"
  }
]`;

      try {
        const raw = runClaudePrompt(prompt, { maxTokens: 16000 });
        const parsed = parseJsonFromResponse(raw);
        if (Array.isArray(parsed)) {
          for (const item of parsed) {
            const tc = testCases.find((t: any) => t.id === item.testCaseId);
            scripts.push({
              testCaseId: item.testCaseId,
              tcNumber: tc?.tc_number || '',
              title: tc?.title || '',
              fileName: item.fileName || `test-${scripts.length + 1}.spec.ts`,
              code: item.code || '',
            });
          }
        }
      } catch (err: any) {
        console.error('Claude CLI script generation failed, using fallback:', err.message);
      }
    }

    // Fallback: generate template-based scripts if Claude didn't produce results
    if (scripts.length === 0) {
      for (const tc of testCases) {
        const steps = (tc.steps || []).map((step: string, i: number) => {
          const s = step.toLowerCase();
          if (s.includes('navigate') || s.includes('go to') || s.includes('open'))
            return `  await page.goto('${targetUrl}');`;
          if (s.includes('click'))
            return `  await page.getByRole('button', { name: '${step.replace(/click\s*/i, '').replace(/['"]/g, '')}' }).click();`;
          if (s.includes('enter') || s.includes('type') || s.includes('fill'))
            return `  await page.getByLabel('${step.replace(/enter|type|fill|input/gi, '').trim().split(' ')[0]}').fill('test-value');`;
          if (s.includes('verify') || s.includes('assert') || s.includes('check') || s.includes('should'))
            return `  await expect(page.getByText('${step.replace(/verify|assert|check|should|see|that/gi, '').trim().split(' ').slice(0, 3).join(' ')}')).toBeVisible();`;
          return `  // Step ${i + 1}: ${step}`;
        }).join('\n');

        const fileName = `${(tc.tc_number || 'tc').toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${tc.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40)}.spec.ts`;
        const code = `import { test, expect } from '@playwright/test';

test.describe('${tc.title}', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('${targetUrl}');
  });

  test('${tc.tc_number} - ${tc.title}', async ({ page }) => {
${tc.precondition ? `    // Precondition: ${tc.precondition}\n` : ''}${steps}

    // Expected: ${(tc.expected_result || tc.expected || 'Verify expected behavior').replace(/'/g, "\\'")}
  });
});
`;
        scripts.push({
          testCaseId: tc.id,
          tcNumber: tc.tc_number,
          title: tc.title,
          fileName,
          code,
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
       WHERE test_run_id = $1 AND status IN ('reviewed', 'approved')`, [testRunId]
    );

    res.json({
      ok: true,
      generated: savedScripts.length,
      total: testCases.length,
      scripts: savedScripts,
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
    const tenantId = (req as any).tenantId;
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

export default router;
