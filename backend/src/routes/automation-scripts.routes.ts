import { Router, Request, Response } from 'express';
import pool from '../db.js';
import { runClaudePrompt, isClaudeCliAuthenticated, parseJsonFromResponse } from '../agents/claude-runner.js';
import { executeRunScripts, PlaywrightRunError } from '../services/playwright-runner.service.js';
import { healRunScripts } from '../services/healing.service.js';
import { executeRunScriptsMobile } from '../services/appium-runner.service.js';

/** Read a run's mobile platform marker ('android' | 'ios') or null for web/API. */
async function getRunPlatform(testRunId: string, tenantId: string, isPlatform: boolean): Promise<string | null> {
  const q = isPlatform
    ? `SELECT platform FROM ${SCHEMA}.test_runs WHERE id = $1`
    : `SELECT platform FROM ${SCHEMA}.test_runs WHERE id = $1 AND tenant_id = $2`;
  const { rows } = await pool.query(q, isPlatform ? [testRunId] : [testRunId, tenantId]);
  const p = rows[0]?.platform;
  return p === 'android' || p === 'ios' ? p : null;
}

/**
 * Build the Claude prompt for Appium / WebdriverIO mobile specs. Parallel to the
 * inline Playwright prompt used for web runs — same input/output contract
 * (JSON array of {testCaseId, fileName, code}) so the route stays uniform.
 */
function buildAppiumPrompt(
  tcSummary: any[],
  ctx: { appName: string; platform: 'android' | 'ios'; appId: string; mainActivity?: string },
): string {
  const platformLabel = ctx.platform === 'ios' ? 'iOS' : 'Android';
  const capsHint = ctx.platform === 'ios'
    ? `'appium:automationName': 'XCUITest', 'platformName': 'iOS', 'appium:bundleId': '${ctx.appId || 'com.example.app'}'`
    : `'appium:automationName': 'UiAutomator2', 'platformName': 'Android', 'appium:appPackage': '${ctx.appId || 'com.example.app'}'${ctx.mainActivity ? `, 'appium:appActivity': '${ctx.mainActivity}'` : ''}`;
  const locatorHint = ctx.platform === 'ios'
    ? `Prefer accessibility ids: $('~accessibilityId'). Fall back to iOS predicate/class-chain strings only when no accessibility id exists.`
    : `Prefer resource-id / accessibility ids: $('android=new UiSelector().resourceId("pkg:id/login")') or $('~accessibilityId'). Avoid brittle XPath unless unavoidable.`;

  return `You are a Principal Mobile SDET. Generate complete, runnable WebdriverIO + Appium specs in TypeScript for EACH test case below, targeting a NATIVE ${platformLabel} app.

Target App: ${ctx.appName}
Platform: ${platformLabel}
App identifier: ${ctx.appId || '(unknown — use a sensible placeholder and add a // TODO)'}

Test Cases (JSON):
${JSON.stringify(tcSummary, null, 2)}

═══════════════════════════════════════════════════════════
MOBILE AUTOMATION RULES (WebdriverIO + Appium)
═══════════════════════════════════════════════════════════
- Each spec is self-contained and runs in isolation. Use the Mocha-style globals WebdriverIO injects: describe(), it(), and the global browser + $ / $$.
- Do NOT call remote()/new session inside the spec — assume the WebdriverIO runner provides the Appium session via capabilities. Add the intended capabilities as a top-of-file comment so they're documented:
    // Appium capabilities: { ${capsHint} }
- Use Appium/WDIO gestures, NOT web APIs: await el.click(), await el.addValue('text'), await driver.back() (Android back), await browser.execute('mobile: scroll', ...), swipe via browser.action/performActions or 'mobile: swipeGesture'/'mobile: scroll'.
- ${locatorHint}
- Use WDIO assertions: await expect(el).toBeDisplayed(), toHaveText(...). Use await el.waitForDisplayed({ timeout: 15000 }) instead of fixed sleeps.
- Cover EVERY step of the test case in order. Inline the precondition as setup at the top of the it().
- Exercise mobile concerns where the test calls for them: permission dialogs, app backgrounding/resume (driver.background(seconds)), rotation (driver.setOrientation), and the Android back button.
- Use realistic test data from the test case's testData when present.

Return ONLY a JSON array (no markdown fence, no commentary), one object per input test case, testCaseId MUST match:
[
  { "testCaseId": "<id from above>", "fileName": "<kebab-case-name>.e2e.ts", "code": "<full self-contained WebdriverIO + Appium TypeScript spec>" }
]`;
}

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

    // Mobile vs web run — mobile produces Appium/WebdriverIO specs (framework=appium).
    const mobilePlatform: 'android' | 'ios' | null =
      run.platform === 'android' || run.platform === 'ios' ? run.platform : null;
    const isMobileRun = mobilePlatform !== null;
    const framework = isMobileRun ? 'appium' : 'playwright';
    // mobile_context is JSON-parsed by the db shim (registered JSON column).
    const mobileMeta: any = (run.mobile_context && typeof run.mobile_context === 'object') ? run.mobile_context : {};
    const mobileAppId: string = isMobileRun
      ? (mobilePlatform === 'ios' ? (mobileMeta.bundleId || '') : (mobileMeta.packageName || ''))
      : '';

    // Get app context for target URL (web runs only)
    let appContext: any = null;
    if (!isMobileRun) {
      try {
        const appRes = await pool.query(
          `SELECT config_data FROM ${SCHEMA}.client_configurations
           WHERE tenant_id = $1 AND integration_id LIKE 'app-%' AND status = 'connected'
           ORDER BY updated_at DESC LIMIT 1`, [tenantId]
        );
        if (appRes.rows.length > 0) appContext = appRes.rows[0].config_data;
      } catch { /* ignore */ }
    }

    const targetUrl = appContext?.baseUrl || appContext?.targetUrl || 'https://example.com';
    const appName = (isMobileRun ? (mobileMeta.fileName || mobileMeta.appName) : appContext?.name)
      || run.story_title || 'Application';

    // Generate scripts using Claude CLI or fallback
    const scripts: Array<{ testCaseId: string; tcNumber: string; title: string; fileName: string; code: string }> = [];

    if (isClaudeCliAuthenticated()) {
      // Generate in small batches so each Claude call returns COMPLETE output.
      // POM specs are verbose (a page-object class per spec), so a single call
      // for all cases would overflow the token limit and truncate the JSON,
      // forcing the template fallback. 4 per call keeps every response whole.
      const BATCH_SIZE = 4;

      for (let start = 0; start < testCases.length; start += BATCH_SIZE) {
        const batch = testCases.slice(start, start + BATCH_SIZE);
        const tcSummary = batch.map((tc: any) => ({
          id: tc.id,
          tcNumber: tc.tc_number,
          title: tc.title,
          feature: tc.feature || '',
          steps: tc.steps || [],
          testSteps: tc.test_steps || [],
          testData: tc.test_data || {},
          expected: tc.expected_result || tc.expected || '',
          precondition: tc.precondition || '',
          type: tc.type,
          priority: tc.priority,
        }));

        const prompt = isMobileRun
          ? buildAppiumPrompt(tcSummary, { appName, platform: mobilePlatform!, appId: mobileAppId, mainActivity: mobileMeta.mainActivity })
          : `You are a Principal SDET who builds resilient Playwright automation using the Page Object Model (POM). Generate a complete, robust, runnable Playwright + TypeScript spec for EACH test case below.

Target Application: ${appName}
Target URL: ${targetUrl}
Story: ${run.story_key || ''} - ${run.story_title || ''}

Test Cases (JSON):
${JSON.stringify(tcSummary, null, 2)}

═══════════════════════════════════════════════════════════
PAGE OBJECT MODEL — MANDATORY STRUCTURE FOR EVERY SPEC
═══════════════════════════════════════════════════════════
Each spec file MUST be self-contained (independently runnable — it will be executed in isolation, so do NOT import from other generated files) and follow this exact layout:
1. import { test, expect, type Page, type Locator } from '@playwright/test';
2. One or more Page Object CLASSES for the screen(s) under test:
   - All locators declared ONCE as 'readonly' Locator fields, initialised in the constructor. NO raw selectors anywhere in the test body.
   - Action methods that express user intent (e.g. async login(user, pass), async submit(), async expectDashboard()).
   - Navigation method (e.g. async goto()) using page.goto('${targetUrl}') or the relevant path.
3. A test.describe() block whose test(s) instantiate the page object(s) and call ONLY their methods — the test body reads like a scenario, never touches a locator directly.

═══════════════════════════════════════════════════════════
LOCATOR RULES (this is what makes the tests foolproof)
═══════════════════════════════════════════════════════════
- Prefer accessibility-first locators IN THIS ORDER: getByRole(role, { name }) → getByLabel → getByPlaceholder → getByText. Use exact, realistic accessible names.
- NEVER use CSS selectors, XPath, data-testid, or positional .nth()/.first() unless there is genuinely no accessible alternative (then add a // comment explaining why).
- Use Playwright's WEB-FIRST assertions that auto-wait and auto-retry: await expect(locator).toBeVisible(), toHaveText(), toHaveURL(), toBeEnabled().
- NEVER use page.waitForTimeout() or fixed sleeps. Rely on auto-waiting and expect() polling.
- Assert every step's expected outcome from the test case. Each test maps to ONE test case and verifies its expectedResult.
- Use realistic test data from the test case's testData when present.
- Add test.describe.configure or beforeEach for shared navigation/setup.

Return ONLY a JSON array (no markdown fence, no commentary), one object per input test case, testCaseId MUST match:
[
  { "testCaseId": "<id from above>", "fileName": "<kebab-case-name>.spec.ts", "code": "<full self-contained TypeScript POM spec>" }
]`;

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
          console.error(`Claude script generation failed for batch starting ${start}:`, err.message);
        }
      }
    }

    // Fallback: generate template-based scripts if Claude didn't produce results
    if (scripts.length === 0) {
      for (const tc of testCases) {
        const slug = `${(tc.tc_number || 'tc').toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${tc.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40)}`;

        let fileName: string;
        let code: string;
        if (isMobileRun) {
          // Appium / WebdriverIO scaffold — mobile gestures, not web APIs.
          const stepCode = (tc.steps || []).map((step: string, i: number) => {
            const s = step.toLowerCase();
            if (s.includes('tap') || s.includes('click') || s.includes('press') || s.includes('select'))
              return `    // Step ${i + 1}: ${step}\n    await $('~SOME_ACCESSIBILITY_ID').click(); // TODO: set the real accessibility id / selector`;
            if (s.includes('enter') || s.includes('type') || s.includes('fill') || s.includes('input'))
              return `    // Step ${i + 1}: ${step}\n    await $('~SOME_INPUT_ID').addValue('test-value'); // TODO: set the real selector`;
            if (s.includes('swipe') || s.includes('scroll'))
              return `    // Step ${i + 1}: ${step}\n    await driver.execute('mobile: scrollGesture', { left: 100, top: 300, width: 200, height: 600, direction: 'down', percent: 1.0 });`;
            if (s.includes('back'))
              return `    // Step ${i + 1}: ${step}\n    await driver.back();`;
            if (s.includes('verify') || s.includes('assert') || s.includes('check') || s.includes('should') || s.includes('see'))
              return `    // Step ${i + 1}: ${step}\n    await expect($('~SOME_ELEMENT')).toBeDisplayed(); // TODO: assert the expected element`;
            return `    // Step ${i + 1}: ${step}`;
          }).join('\n\n');
          const caps = mobilePlatform === 'ios'
            ? `{ 'appium:automationName': 'XCUITest', 'platformName': 'iOS', 'appium:bundleId': '${mobileAppId || 'com.example.app'}' }`
            : `{ 'appium:automationName': 'UiAutomator2', 'platformName': 'Android', 'appium:appPackage': '${mobileAppId || 'com.example.app'}'${mobileMeta.mainActivity ? `, 'appium:appActivity': '${mobileMeta.mainActivity}'` : ''} }`;
          fileName = `${slug}.e2e.ts`;
          code = `// Appium capabilities: ${caps}
// WebdriverIO + Appium spec (uses the runner-provided global \`browser\`/\`driver\`/\`$\`).

describe('${tc.title.replace(/'/g, "\\'")}', () => {
  it('${(tc.tc_number || '').replace(/'/g, "\\'")} - ${tc.title.replace(/'/g, "\\'")}', async () => {
${tc.precondition ? `    // Precondition: ${String(tc.precondition).replace(/\n/g, ' ')}\n` : ''}${stepCode}

    // Expected: ${(tc.expected_result || tc.expected || 'Verify expected behavior').replace(/'/g, "\\'")}
  });
});
`;
        } else {
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

          fileName = `${slug}.spec.ts`;
          code = `import { test, expect } from '@playwright/test';

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
        }
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
        SELECT $1, $2, $3, $4, $5, $6, 'typescript', $9, $7, 'generated', $8
        WHERE NOT EXISTS (
          SELECT 1 FROM ${SCHEMA}.automation_scripts
          WHERE test_run_id = $2 AND test_case_id = $3
        )
      `, [tenantId, testRunId, script.testCaseId, script.tcNumber, script.title, script.fileName, script.code, username, framework]);

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
    // Mobile runs go to the Appium runner (gated/honest not_run when no device);
    // web/API runs keep the existing Playwright path untouched.
    const platform = await getRunPlatform(testRunId, tenantId, isPlatform);
    if (platform) {
      const mob = await executeRunScriptsMobile(tenantId, isPlatform, testRunId);
      res.json({
        runId: testRunId,
        executionDetails: mob.details,
        summary: {
          totalTests: mob.details.length,
          passed: mob.passed,
          failed: mob.failed,
          notRun: mob.notRun,
          executed: mob.executed,
          reason: mob.reason,
        },
      });
      return;
    }

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
    // Mobile runs aren't executed on this host (gated), so there's nothing to
    // heal — respond honestly instead of erroring on the Playwright-only path.
    const platform = await getRunPlatform(testRunId, tenantId, isPlatform);
    if (platform) {
      res.json({
        runId: testRunId,
        executionDetails: [],
        summary: { totalTests: 0, healed: 0, stillFailing: 0, executed: false,
          reason: 'Auto-heal runs after on-device execution. Connect a mobile device/Appium server to execute and heal mobile tests.' },
      });
      return;
    }

    const { details, healedCount, stillFailing } = await healRunScripts(tenantId, isPlatform, testRunId, failures);
    res.json({
      runId: testRunId,
      // Same shape as /execute so the frontend maps results by testCaseId the same way.
      executionDetails: details,
      summary: { totalTests: details.length, healed: healedCount, stillFailing, executed: true },
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
