import { Router } from 'express';
import type { Request, Response } from 'express';
import { createInitialState } from '../agents/state.js';
import type { TestOpsState, TestCase, AutomationScript, AppContext, PageObjectFile } from '../agents/state.js';
import { scriptAgent } from '../agents/scriptAgent.js';
import { executionAgent } from '../agents/executionAgent.js';
import { healingAgent } from '../agents/healingAgent.js';
import { crawlAppMap } from '../agents/exploreAgent.js';
import { getConfigsForTenant } from '../services/configurations.service.js';
import { getTenantLlm } from '../services/llm.service.js';
import { decryptStored } from '../utils/crypto.js';
import { dispatchTestRunNotification } from '../services/notification-dispatcher.service.js';
import type { TestRunEmailPayload } from '../services/email.service.js';
import { generateAllureHtml, REPORTS_ROOT } from '../services/allure-report.service.js';
import { logger } from '../utils/logger.js';
import path from 'path';
import fs from 'fs/promises';
import os from 'os';

/**
 * Stateless, app-aware pipeline-flow endpoints.
 *
 * The Chat wizard drives the 6 visible stages (Requirement Analysis → Test
 * Design → Script Generation → Execution & Validation → Auto-Healing → Report)
 * synchronously, one user action per stage. The artifacts produced by one stage
 * are the input to the next, so the client passes them forward verbatim and we
 * NEVER re-run earlier stages. This keeps test-case ids, scripts and execution
 * results aligned end-to-end — the previous design re-ran the whole pipeline on
 * every call, generating fresh ids that never matched what the user saw.
 *
 * The target application (base URL + login credentials) is resolved server-side
 * from System Configuration → Application Setup so credentials never travel to
 * the browser in plaintext.
 */

const router = Router();

// Public, externally-reachable base URL so notification "Open Full Report" links
// work from Teams/email. MUST be the public app URL (e.g. the Azure Container App
// FQDN) — do NOT fall back to BACKEND_URL, which on Azure is the container's
// INTERNAL http://127.0.0.1:3001 and produces dead localhost links. When neither
// PUBLIC_BASE_URL nor APP_URL is set, the report link is omitted rather than broken.
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || process.env.APP_URL || '').replace(/\/+$/, '');

function makeRunId(): string {
  return `chat-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}
// Reports are written under REPORTS_ROOT (REPORTS_DIR env on Azure → a persistent
// Azure Files volume; in-image path locally). Same root the /api/allure/report
// static route and getReportStatus/getLatestReport read from.
function reportDirFor(tenantId: string, runId: string): string {
  return path.join(REPORTS_ROOT, tenantId, runId);
}
function reportUrlFor(tenantId: string, runId: string): string | undefined {
  return PUBLIC_BASE_URL ? `${PUBLIC_BASE_URL}/api/allure/report/${tenantId}/${runId}/index.html` : undefined;
}

/** Compact failing-test summary for the notification body. */
function failingSummary(details: any[]): string | undefined {
  const failed = details.filter((d) => d?.status === 'failed');
  if (failed.length === 0) return undefined;
  const lines = failed.slice(0, 10).map(
    (d) => `• ${d.scenario || d.testCaseId}: ${String(d.error || 'failed').split('\n')[0].slice(0, 160)}`,
  );
  if (failed.length > 10) lines.push(`…and ${failed.length - 10} more`);
  return lines.join('\n');
}

/**
 * Send the run status + report link to every channel the tenant has connected
 * (email / Slack / Teams). Fire-and-forget — never blocks or fails the request.
 */
function notifyRun(tenantId: string, runId: string, args: {
  testCases: any[]; details: any[]; passed: number; failed: number; total: number;
  durationSeconds: number; reportUrl?: string; healed?: boolean;
}): void {
  const first = args.testCases[0] || {};
  // 'failed' is reserved for a full wipeout (nothing passed). A mix of pass/fail
  // is a PARTIAL result, not a hard failure — so 7/9 reads as partial, not FAILED.
  const status: TestRunEmailPayload['status'] =
    args.total === 0 ? 'partial'
      : args.passed === 0 ? 'failed'
        : args.failed > 0 ? 'partial'
          : 'passed';
  const payload: TestRunEmailPayload = {
    runId,
    feature: `${first.feature || first.module || 'Web Application Automation'}${args.healed ? ' (after auto-heal)' : ''}`,
    module: first.module || undefined,
    status,
    totalTests: args.total,
    passed: args.passed,
    failed: args.failed,
    durationSeconds: args.durationSeconds,
    reportUrl: args.reportUrl,
    error: failingSummary(args.details),
  };
  dispatchTestRunNotification(tenantId, payload)
    .then((results) => {
      if (results.length) console.log('[pipeline-flow] notifications:', results.map((r) => `${r.channel}:${r.sent ? 'ok' : 'fail' + (r.error ? `(${r.error})` : '')}`).join(', '));
    })
    .catch((e) => console.warn('[pipeline-flow] notification dispatch failed:', (e as Error).message));
}

/**
 * Build the Allure HTML report for a run from the allure-results the Playwright
 * run just produced, writing it to allure-reports/<tenant>/<scope>/ — exactly
 * where the Reports page (and the /api/allure/report static route) look for it.
 *
 * `scope` is the SAVED test-run id when the Chat flow saved the cases, so the
 * Reports dropdown finds the report by selecting that run; otherwise it's the
 * ephemeral chat run id. Best-effort — a failure just means no Allure report
 * (the run results are still returned to the UI).
 */
async function buildAllureReport(tenantId: string, scope: string, resultsDir: string): Promise<boolean> {
  try {
    const files = await fs.readdir(resultsDir).catch(() => [] as string[]);
    if (files.length === 0) {
      // Loud on purpose: a run can pass yet leave no report (e.g. the reporter
      // wrote results elsewhere). Without this log the only symptom is a stale
      // report on the Reports page while the notification says "passed".
      logger.warn('allure.no_results', {
        tenantId, scope, resultsDir,
        msg: 'No allure-results were produced for this run — no report built.',
      });
      return false;
    }
    // The Allure report lives in an `/allure` SUBFOLDER of the run dir. The run
    // root holds the Playwright HTML report (the "Basic Report"); keeping Allure
    // separate lets the Reports page show each under its own tab. `--clean` then
    // only wipes the allure subfolder, never the Playwright report.
    await generateAllureHtml(resultsDir, path.join(reportDirFor(tenantId, scope), 'allure'));
    await fs.writeFile(
      path.join(reportDirFor(tenantId, scope), 'report-meta.json'),
      JSON.stringify({ generatedAt: new Date().toISOString(), runId: scope, tenantId, real: true, allure: true }, null, 2),
    ).catch(() => {});
    return true;
  } catch (e) {
    logger.warn('allure.build_failed', { tenantId, scope, err: (e as Error).message });
    return false;
  }
}

/**
 * Resolve the application-under-test context for a tenant from the saved
 * "Application Setup" configs (integration ids prefixed `app-`).
 * Role passwords are stored AES-encrypted at rest — decrypt them here for the
 * agents to use, but they are never returned to the client.
 *
 * Selection: an explicit `appId` wins; otherwise the first app with a base URL.
 * Returns null when no application is configured.
 */
async function resolveAppContext(tenantId: string, appId?: string): Promise<{ ctx: AppContext | null; appName?: string }> {
  let configs;
  try {
    configs = await getConfigsForTenant(tenantId);
  } catch {
    return { ctx: null };
  }
  const apps = configs.filter((c) => c.integrationId.startsWith('app-'));
  if (apps.length === 0) return { ctx: null };

  let chosen = appId ? apps.find((c) => c.integrationId === appId) : undefined;
  if (!chosen) chosen = apps.find((c) => (c.configData?.baseUrl || '').trim()) || apps[0];

  const d = chosen.configData || {};
  const roles = Array.isArray(d.roles)
    ? d.roles
        .filter((r: any) => r && typeof r === 'object')
        .map((r: any) => ({
          roleName: String(r.roleName || 'user'),
          username: String(r.username || ''),
          password: decryptStored(String(r.password || '')),
        }))
    : undefined;

  return {
    appName: d.appName,
    ctx: {
      targetUrl: (d.baseUrl || '').trim() || undefined,
      appName: d.appName,
      environment: d.environment,
      roles,
    },
  };
}

/**
 * Normalize a test case coming from the client into the shape the agents expect.
 * The frontend keeps a few legacy aliases (scenario/title, steps as strings);
 * we accept whatever it sends and fill the required fields with sane defaults.
 */
function normalizeTestCase(tc: any, idx: number): TestCase {
  const stringSteps: string[] = Array.isArray(tc?.steps) && tc.steps.length
    ? tc.steps.map((s: any) => String(s))
    : Array.isArray(tc?.testSteps)
      ? tc.testSteps.map((s: any, i: number) => `${s.step ?? i + 1}. ${s.action}${s.expected ? ` → Expected: ${s.expected}` : ''}`)
      : [];
  return {
    id: tc?.id || `TC-${String(idx + 1).padStart(3, '0')}`,
    traceabilityId: tc?.traceabilityId || '',
    module: tc?.module || '',
    submodule: tc?.submodule || '',
    feature: tc?.feature || 'Feature',
    title: tc?.title || tc?.scenario || tc?.name || 'Test scenario',
    scenario: tc?.scenario || tc?.title || tc?.name || 'Test scenario',
    description: tc?.description || '',
    precondition: tc?.precondition || '',
    testSteps: Array.isArray(tc?.testSteps) ? tc.testSteps : [],
    steps: stringSteps,
    expectedResult: tc?.expectedResult || tc?.expected || '',
    testData: tc?.testData || {},
    type: tc?.type || tc?.category || 'positive',
    priority: tc?.priority || 'P1',
    severity: tc?.severity || undefined,
    tags: Array.isArray(tc?.tags) ? tc.tags : [],
    status: tc?.status || 'generated',
  };
}

function normalizeScript(s: any): AutomationScript | null {
  const testCaseId = s?.testCaseId || s?.testCase_id;
  const code = s?.code || s?.script;
  if (!testCaseId || typeof code !== 'string' || !code.trim()) return null;
  return {
    testCaseId,
    fileName: s?.fileName || s?.file_name || `${testCaseId}.spec.ts`,
    code,
    // Preserve the POM destination + page-object links when the client sends
    // them back, so execution and publish keep the deterministic layout.
    path: typeof s?.path === 'string' && s.path.trim() ? s.path : undefined,
    uses: Array.isArray(s?.uses) ? s.uses.filter((u: any) => typeof u === 'string') : undefined,
  };
}

function normalizePageObject(p: any): PageObjectFile | null {
  const code = p?.code;
  const poPath = p?.path;
  if (typeof code !== 'string' || !code.trim() || typeof poPath !== 'string' || !poPath.trim()) return null;
  return {
    path: poPath,
    className: String(p?.className || ''),
    module: String(p?.module || ''),
    methods: Array.isArray(p?.methods) ? p.methods.filter((m: any) => typeof m === 'string') : [],
    code,
  };
}

/**
 * POST /api/pipeline-flow/scripts
 * Stage 3 — generate Playwright scripts for the (possibly edited) test cases
 * the user is looking at. Returns scripts aligned to the same testCaseIds.
 */
router.post('/scripts', async (req: Request, res: Response) => {
  try {
    const tenantId = req.user!.tenantId;
    const { testCases, appId } = req.body || {};
    if (!Array.isArray(testCases) || testCases.length === 0) {
      res.status(400).json({ error: 'testCases array is required' });
      return;
    }

    const llm = await getTenantLlm(tenantId);
    if (!llm) {
      res.status(400).json({ error: 'No LLM configured. Add an Anthropic API key in System Configuration → LLM Configuration.' });
      return;
    }
    const { ctx } = await resolveAppContext(tenantId, appId);

    // Ground the scripts in the REAL app: crawl it for actual selectors so the
    // generated Playwright matches the live DOM instead of guessing. Best-effort
    // — a crawl failure falls back to semantic-locator generation.
    let exploredApp = null;
    if (ctx?.targetUrl) {
      try {
        console.log(`[pipeline-flow/scripts] crawling ${ctx.targetUrl} for real selectors…`);
        exploredApp = await crawlAppMap(ctx.targetUrl, ctx);
        console.log(`[pipeline-flow/scripts] crawled ${exploredApp.pages.length} page(s)`);
      } catch (e) {
        console.warn('[pipeline-flow/scripts] crawl failed, scripting without DOM:', (e as Error).message);
      }
    }

    const state: TestOpsState = {
      ...createInitialState('', ctx || undefined, llm),
      testCases: testCases.map(normalizeTestCase),
      exploredApp,
    };

    const next = await scriptAgent(state);
    console.log(
      `[pipeline-flow/scripts] produced ${next.automationScripts.length} script(s), ` +
      `${(next.pageObjects || []).length} page object(s) for ${state.testCases.length} test case(s)`,
    );
    res.json({
      scripts: next.automationScripts,
      pageObjects: next.pageObjects || [],
      crawledPages: exploredApp?.pages.length || 0,
    });
  } catch (err) {
    const message = (err as Error).message || 'Script generation failed';
    console.error('[pipeline-flow/scripts] error:', message);
    res.status(500).json({ error: message });
  }
});

/**
 * POST /api/pipeline-flow/execute
 * Stage 4 — run the provided scripts against the configured application.
 * Returns per-test details keyed to the same testCaseIds the client sent.
 * When no application (base URL) is configured, nothing is run and
 * `summary.executed` is false with a human-readable reason — the flow then
 * continues gracefully to the report rather than stalling.
 */
router.post('/execute', async (req: Request, res: Response) => {
  try {
    const tenantId = req.user!.tenantId;
    const { testCases, scripts, pageObjects, appId, testRunId } = req.body || {};
    if (!Array.isArray(testCases) || testCases.length === 0) {
      res.status(400).json({ error: 'testCases array is required' });
      return;
    }

    const { ctx, appName } = await resolveAppContext(tenantId, appId);
    const normalizedScripts = (Array.isArray(scripts) ? scripts : [])
      .map(normalizeScript)
      .filter((s): s is AutomationScript => s !== null);
    const normalizedPageObjects = (Array.isArray(pageObjects) ? pageObjects : [])
      .map(normalizePageObject)
      .filter((p): p is PageObjectFile => p !== null);

    const state: TestOpsState = {
      ...createInitialState('', ctx || undefined),
      testCases: testCases.map(normalizeTestCase),
      automationScripts: normalizedScripts,
      pageObjects: normalizedPageObjects,
    };

    // Run once, capturing allure-results, then build the Allure report under the
    // SAVED run id (so the Reports page finds it) or an ephemeral chat run id.
    const reportScope = (testRunId && String(testRunId)) || makeRunId();
    const allureResultsDir = path.join(os.tmpdir(), `jbs-allure-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    // Playwright HTML report → run root (served as the "Basic Report").
    // Allure results → tmp, then built into the run's /allure subfolder below.
    const next = await executionAgent(state, { htmlReportDir: reportDirFor(tenantId, reportScope), allureResultsDir });
    const executed = next.executionResults !== null;
    const details = next.executionResults?.details || [];
    const passed = next.executionResults?.passed || 0;
    const failed = next.executionResults?.failed || 0;
    const total = next.testCases.length;
    const durationMs = details.reduce((s, d) => s + (typeof d.durationMs === 'number' ? d.durationMs : 0), 0);

    let reportUrl: string | undefined;
    if (executed) {
      const built = await buildAllureReport(tenantId, reportScope, allureResultsDir);
      reportUrl = built ? reportUrlFor(tenantId, reportScope) : undefined;
    }
    await fs.rm(allureResultsDir, { recursive: true, force: true }).catch(() => {});

    // After a real execution, push status + report to the tenant's channels
    // (email / Slack / Teams). Fire-and-forget so the UI isn't blocked.
    if (executed) {
      notifyRun(tenantId, reportScope, {
        testCases: next.testCases, details, passed, failed, total,
        durationSeconds: Math.round(durationMs / 1000), reportUrl,
      });
    }

    res.json({
      executionDetails: details,
      failureReason: next.failureReason,
      reportUrl,
      app: appName ? { name: appName, targetUrl: ctx?.targetUrl } : null,
      summary: {
        total,
        passed,
        failed,
        executed,
        // Surface WHY nothing ran so the UI can guide the user.
        reason: executed ? undefined : (next.failureReason || 'No application configured'),
      },
    });
  } catch (err) {
    const message = (err as Error).message || 'Execution failed';
    console.error('[pipeline-flow/execute] error:', message);
    res.status(500).json({ error: message });
  }
});

/**
 * POST /api/pipeline-flow/heal
 * Stage 5 — heal the tests that failed, then re-execute the full suite so the
 * caller gets fresh, real pass/fail. Returns the updated scripts, new execution
 * details and a per-test healing log.
 */
router.post('/heal', async (req: Request, res: Response) => {
  try {
    const tenantId = req.user!.tenantId;
    const { testCases, scripts, pageObjects, executionDetails, appId, testRunId } = req.body || {};
    if (!Array.isArray(testCases) || testCases.length === 0) {
      res.status(400).json({ error: 'testCases array is required' });
      return;
    }

    const { ctx, appName } = await resolveAppContext(tenantId, appId);
    const normalizedScripts = (Array.isArray(scripts) ? scripts : [])
      .map(normalizeScript)
      .filter((s): s is AutomationScript => s !== null);
    const normalizedPageObjects = (Array.isArray(pageObjects) ? pageObjects : [])
      .map(normalizePageObject)
      .filter((p): p is PageObjectFile => p !== null);

    // Mark the cases the previous run reported as failed, so the healing agent
    // knows what to work on.
    const details: any[] = Array.isArray(executionDetails) ? executionDetails : [];
    const failedById = new Map<string, any>();
    for (const d of details) {
      if (d?.testCaseId && d.status === 'failed') failedById.set(d.testCaseId, d);
    }

    const cases = testCases.map(normalizeTestCase).map((tc) =>
      failedById.has(tc.id) ? { ...tc, status: 'failed' as const } : tc,
    );
    const failedCount = failedById.size;
    if (failedCount === 0) {
      res.json({
        scripts: normalizedScripts,
        pageObjects: normalizedPageObjects,
        executionDetails: details,
        healingLog: [],
        summary: { total: cases.length, passed: details.filter((d) => d.status === 'passed').length, failed: 0, executed: true },
      });
      return;
    }

    const llm = await getTenantLlm(tenantId);
    if (!llm) {
      res.status(400).json({ error: 'No LLM configured. Add an Anthropic API key in System Configuration → LLM Configuration.' });
      return;
    }

    const firstError = [...failedById.values()][0]?.error || 'Some tests failed';
    // Per-test error map so the healer fixes each spec against ITS OWN failure,
    // not one shared error.
    const failuresByTc: Record<string, string> = {};
    for (const [id, d] of failedById) failuresByTc[id] = String(d?.error || firstError);

    // NOTE: we deliberately do NOT crawl the live app here. On the memory-limited
    // Azure container, launching a second Chromium during heal (on top of the
    // re-execution run) OOM-killed the process → the request returned 504. The
    // healer still gets each test's specific error (failuresByTc) to work from.
    const baseState: TestOpsState = {
      ...createInitialState('', ctx || undefined, llm),
      testCases: cases,
      automationScripts: normalizedScripts,
      pageObjects: normalizedPageObjects,
      failureReason: firstError,
      executionResults: { passed: cases.length - failedCount, failed: failedCount },
    };

    // 1) Heal failing scripts. 2) Re-execute the whole suite for real results,
    //    building a fresh Allure report for the post-heal run.
    const reportScope = (testRunId && String(testRunId)) || makeRunId();
    const allureResultsDir = path.join(os.tmpdir(), `jbs-allure-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    const healed = await healingAgent(baseState, { failuresByTc });
    const reExecuted = await executionAgent({ ...healed, failureReason: null }, { htmlReportDir: reportDirFor(tenantId, reportScope), allureResultsDir });

    const newDetails = reExecuted.executionResults?.details || [];
    const newById = new Map<string, any>(newDetails.map((d) => [d.testCaseId, d]));

    const healingLog = [...failedById.keys()].map((tcId) => {
      const after = newById.get(tcId);
      const result: 'fixed' | 'unchanged' | 'unknown' =
        after?.status === 'passed' ? 'fixed' : after?.status === 'failed' ? 'unchanged' : 'unknown';
      return {
        testCaseId: tcId,
        error: failedById.get(tcId)?.error || 'Unknown error',
        fix: result === 'fixed' ? 'Healed and re-ran successfully' : 'Could not be healed automatically',
        result,
      };
    });

    const executed = reExecuted.executionResults !== null;
    const passed = reExecuted.executionResults?.passed || 0;
    const failed = reExecuted.executionResults?.failed || 0;
    const total = reExecuted.testCases.length;
    const durationMs = newDetails.reduce((s, d) => s + (typeof d.durationMs === 'number' ? d.durationMs : 0), 0);

    let reportUrl: string | undefined;
    if (executed) {
      const built = await buildAllureReport(tenantId, reportScope, allureResultsDir);
      reportUrl = built ? reportUrlFor(tenantId, reportScope) : undefined;
    }
    await fs.rm(allureResultsDir, { recursive: true, force: true }).catch(() => {});

    if (executed) {
      notifyRun(tenantId, reportScope, {
        testCases: reExecuted.testCases, details: newDetails, passed, failed, total,
        durationSeconds: Math.round(durationMs / 1000), reportUrl, healed: true,
      });
    }

    res.json({
      scripts: reExecuted.automationScripts,
      pageObjects: reExecuted.pageObjects || normalizedPageObjects,
      executionDetails: newDetails,
      healingLog,
      reportUrl,
      app: appName ? { name: appName, targetUrl: ctx?.targetUrl } : null,
      summary: {
        total,
        passed,
        failed,
        executed,
        reason: executed ? undefined : (reExecuted.failureReason || 'No application configured'),
      },
    });
  } catch (err) {
    const message = (err as Error).message || 'Healing failed';
    console.error('[pipeline-flow/heal] error:', message);
    res.status(500).json({ error: message });
  }
});

export default router;
