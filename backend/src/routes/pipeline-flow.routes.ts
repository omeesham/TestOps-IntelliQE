import { Router } from 'express';
import type { Request, Response } from 'express';
import { createInitialState } from '../agents/state.js';
import type { TestOpsState, TestCase, AutomationScript, AppContext, PageObjectFile } from '../agents/state.js';
import { scriptAgent } from '../agents/scriptAgent.js';
import { liveScriptAgent, liveHealingAgent } from '../agents/liveScriptAgent.js';
import { executionAgent } from '../agents/executionAgent.js';
import { healingAgent } from '../agents/healingAgent.js';
import { crawlAppMap, snapshotEntryPage } from '../agents/exploreAgent.js';
import { getConfigsForTenant } from '../services/configurations.service.js';
import { getTenantLlm } from '../services/llm.service.js';
import { decryptStored, decryptField } from '../utils/crypto.js';
import { dispatchTestRunNotification } from '../services/notification-dispatcher.service.js';
import type { TestRunEmailPayload } from '../services/email.service.js';
import { generateAllureHtml, REPORTS_ROOT } from '../services/allure-report.service.js';
import { mirrorReportToBlob } from '../services/report-storage.service.js';
import { startJob, getJob } from '../services/async-jobs.service.js';
import { timed } from '../services/agent-metrics.service.js';
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
  // Relative URL works for the SPA (Vite proxy locally, same origin in prod) —
  // the same form allure.routes.ts returns. PUBLIC_BASE_URL upgrades it to an
  // absolute link, which external channels (email/Slack) require.
  const rel = `/api/allure/report/${tenantId}/${runId}/index.html`;
  return PUBLIC_BASE_URL ? `${PUBLIC_BASE_URL}${rel}` : rel;
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
    // External channels need an absolute link — a relative /api/... URL would
    // be a dead link in an email, so omit it there.
    reportUrl: args.reportUrl && /^https?:/i.test(args.reportUrl) ? args.reportUrl : undefined,
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

  const isReady = (c: (typeof apps)[number]) =>
    c.status === 'connected' && !!(c.configData?.baseUrl && String(c.configData.baseUrl).trim());

  let chosen;
  if (appId) {
    // A SPECIFIC application was requested (the chat wizard's selected app) —
    // it must resolve to a properly-configured entry, or we report "not
    // configured" rather than silently substituting a DIFFERENT application's
    // URL. That silent substitution was the bug: with multiple applications
    // configured, an unresolvable/misconfigured appId used to fall through to
    // "whichever app happens to be ready", running the wrong app's tests
    // against the wrong app's URL.
    chosen = apps.find((c) => c.integrationId === appId && isReady(c));
    if (!chosen) return { ctx: null };
  } else {
    chosen = apps.find(isReady);
    if (!chosen) return { ctx: null };
  }

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
 * Merge an inline target URL (+ optional login) from the request body into the
 * resolved app context. This lets the chat flow run against a URL the user
 * types in-flow when NO Application is configured under System Configuration —
 * so a missing Application Setup entry never dead-ends execution.
 * The typed URL takes precedence over any configured app when present.
 */
function applyManualTarget(
  resolved: { ctx: AppContext | null; appName?: string },
  body: any,
): { ctx: AppContext | null; appName?: string } {
  const url = typeof body?.targetUrl === 'string' ? body.targetUrl.trim() : '';
  if (!url) return resolved;
  const username = typeof body?.username === 'string' ? body.username.trim() : '';
  // Password is transit-encrypted by the client; decryptField passes plaintext through.
  const password = body?.password ? decryptField(String(body.password)) : '';
  const roles = username ? [{ roleName: 'user', username, password }] : resolved.ctx?.roles;
  const appName = resolved.ctx?.appName || (typeof body?.appName === 'string' && body.appName.trim()) || 'Application';
  return {
    appName,
    ctx: {
      targetUrl: url,
      appName,
      environment: resolved.ctx?.environment,
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
async function scriptsStage(tenantId: string, body: any): Promise<any> {
  const { testCases, appId } = body || {};

  const llm = await getTenantLlm(tenantId);
  if (!llm) {
    throw new Error('No LLM configured. Add an Anthropic API key in System Configuration → LLM Configuration.');
  }
  const { ctx } = applyManualTarget(await resolveAppContext(tenantId, appId), body);

  const state: TestOpsState = {
    ...createInitialState('', ctx || undefined, llm),
    testCases: (testCases as any[]).map(normalizeTestCase),
    exploredApp: null,
  };

  // LIVE mode (default when a target URL exists): drive a real browser per
  // test case — observe the page, act, verify each locator by executing it,
  // and emit specs only from proven steps (Playwright codegen-style).
  // Set SCRIPT_GEN_MODE=batch to force the crawl-once batch generator.
  const live = !!ctx?.targetUrl && process.env.SCRIPT_GEN_MODE !== 'batch';
  let exploredApp = null;
  if (!live && ctx?.targetUrl) {
    // Batch mode grounding: crawl once for real selectors. Best-effort — a
    // crawl failure falls back to semantic-locator generation.
    try {
      console.log(`[pipeline-flow/scripts] crawling ${ctx.targetUrl} for real selectors…`);
      exploredApp = await crawlAppMap(ctx.targetUrl, ctx);
      console.log(`[pipeline-flow/scripts] crawled ${exploredApp.pages.length} page(s)`);
      state.exploredApp = exploredApp;
    } catch (e) {
      console.warn('[pipeline-flow/scripts] crawl failed, scripting without DOM:', (e as Error).message);
    }
  }

  const next = await timed(tenantId, 'script',
    () => (live ? liveScriptAgent(state) : scriptAgent(state)),
    (s) => ({ scripts: s.automationScripts.length, pageObjects: (s.pageObjects || []).length, mode: live ? 'live' : 'batch' }));
  console.log(
    `[pipeline-flow/scripts] (${live ? 'live' : 'batch'}) produced ${next.automationScripts.length} script(s), ` +
    `${(next.pageObjects || []).length} page object(s) for ${state.testCases.length} test case(s)`,
  );
  return {
    scripts: next.automationScripts,
    pageObjects: next.pageObjects || [],
    crawledPages: exploredApp?.pages.length || 0,
    mode: live ? 'live' : 'batch',
  };
}

router.post('/scripts', async (req: Request, res: Response) => {
  try {
    const { testCases } = req.body || {};
    if (!Array.isArray(testCases) || testCases.length === 0) {
      res.status(400).json({ error: 'testCases array is required' });
      return;
    }
    res.json(await scriptsStage(req.user!.tenantId, req.body));
  } catch (err) {
    const message = (err as Error).message || 'Script generation failed';
    console.error('[pipeline-flow/scripts] error:', message);
    res.status(500).json({ error: message });
  }
});

/**
 * POST /api/pipeline-flow/scripts/start
 * Async variant of /scripts — live generation drives a real browser through
 * every test case and routinely outlives the ~240s ingress cap on a single
 * request. Returns { jobId }; poll GET /jobs/:jobId for the result.
 */
router.post('/scripts/start', (req: Request, res: Response) => {
  const { testCases } = req.body || {};
  if (!Array.isArray(testCases) || testCases.length === 0) {
    res.status(400).json({ error: 'testCases array is required' });
    return;
  }
  const tenantId = req.user!.tenantId;
  const jobId = startJob(tenantId, () => scriptsStage(tenantId, req.body));
  res.json({ jobId });
});

/**
 * POST /api/pipeline-flow/execute
 * Stage 4 — run the provided scripts against the configured application.
 * Returns per-test details keyed to the same testCaseIds the client sent.
 * When no application (base URL) is configured, nothing is run and
 * `summary.executed` is false with a human-readable reason — the flow then
 * continues gracefully to the report rather than stalling.
 */
async function executeStage(tenantId: string, body: any): Promise<any> {
  const { testCases, scripts, pageObjects, appId, testRunId } = body || {};

  const { ctx, appName } = applyManualTarget(await resolveAppContext(tenantId, appId), body);
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
  const next = await timed(tenantId, 'execution',
    () => executionAgent(state, { htmlReportDir: reportDirFor(tenantId, reportScope), allureResultsDir }),
    (s) => ({ passed: s.executionResults?.passed ?? 0, failed: s.executionResults?.failed ?? 0, total: s.testCases.length }));
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
    // Persist the freshly-built report to cloud storage (Azure Blob) so it
    // survives the ephemeral container FS and is visible across replicas /
    // after redeploys. No-op unless STORAGE_PROVIDER is a cloud provider.
    void mirrorReportToBlob(tenantId, reportScope, { passed, failed, total, durationMs });
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

  return {
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
  };
}

router.post('/execute', async (req: Request, res: Response) => {
  try {
    const { testCases } = req.body || {};
    if (!Array.isArray(testCases) || testCases.length === 0) {
      res.status(400).json({ error: 'testCases array is required' });
      return;
    }
    res.json(await executeStage(req.user!.tenantId, req.body));
  } catch (err) {
    const message = (err as Error).message || 'Execution failed';
    console.error('[pipeline-flow/execute] error:', message);
    res.status(500).json({ error: message });
  }
});

/**
 * POST /api/pipeline-flow/execute/start
 * Async variant of /execute: a Playwright run can far outlive the ~240s Azure
 * Container Apps ingress cap on a single request, which killed the synchronous
 * call mid-run and made every test show "could not be run" even though real
 * results existed server-side. Starts the run detached and returns { jobId };
 * poll GET /jobs/:jobId for the same payload /execute would have returned.
 */
router.post('/execute/start', (req: Request, res: Response) => {
  const { testCases } = req.body || {};
  if (!Array.isArray(testCases) || testCases.length === 0) {
    res.status(400).json({ error: 'testCases array is required' });
    return;
  }
  const tenantId = req.user!.tenantId;
  const jobId = startJob(tenantId, () => executeStage(tenantId, req.body));
  res.json({ jobId });
});

/** GET /api/pipeline-flow/jobs/:jobId — poll a started stage for its result. */
router.get('/jobs/:jobId', (req: Request, res: Response) => {
  const job = getJob(req.user!.tenantId, req.params.jobId as string);
  if (!job) {
    res.status(404).json({ error: 'Job not found (it may have expired or the server restarted). Re-run the stage.' });
    return;
  }
  res.json(job);
});

/**
 * POST /api/pipeline-flow/heal
 * Stage 5 — heal the tests that failed, then re-execute the full suite so the
 * caller gets fresh, real pass/fail. Returns the updated scripts, new execution
 * details and a per-test healing log.
 */
async function healStage(tenantId: string, body: any): Promise<any> {
  const { testCases, scripts, pageObjects, executionDetails, appId, testRunId } = body || {};

  {
    const { ctx, appName } = applyManualTarget(await resolveAppContext(tenantId, appId), body);
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

    const cases = (testCases as any[]).map(normalizeTestCase).map((tc: TestCase) =>
      failedById.has(tc.id) ? { ...tc, status: 'failed' as const } : tc,
    );
    const failedCount = failedById.size;
    if (failedCount === 0) {
      return {
        scripts: normalizedScripts,
        pageObjects: normalizedPageObjects,
        executionDetails: details,
        healingLog: [],
        summary: { total: cases.length, passed: details.filter((d) => d.status === 'passed').length, failed: 0, executed: true },
      };
    }

    const llm = await getTenantLlm(tenantId);
    if (!llm) {
      throw new Error('No LLM configured. Add an Anthropic API key in System Configuration → LLM Configuration.');
    }

    const firstError = [...failedById.values()][0]?.error || 'Some tests failed';
    // Per-test error map so the healer fixes each spec against ITS OWN failure,
    // not one shared error.
    const failuresByTc: Record<string, string> = {};
    for (const [id, d] of failedById) failuresByTc[id] = String(d?.error || firstError);

    // Wall-clock budget for the whole heal run. Heals execute as detached jobs
    // (poll-based), so the old ~240s ingress ceiling no longer applies — the
    // budget now just caps runaway multi-pass loops. Counted from BEFORE the
    // entry-page snapshot.
    const healStart = Date.now();
    const timeBudgetMs = Math.max(60_000, parseInt(process.env.HEAL_TIME_BUDGET_MS || '', 10) || 600_000);

    // Default to the FAST targeted TEXT healer (Playwright-healer style:
    // diagnose the failure category → smallest patch → re-run to verify). It
    // heals every failing spec in PARALLEL with one LLM call each, so a handful
    // of tests heal in ~1-2 min. The LIVE browser healer instead re-derives each
    // test step-by-step (one LLM call per browser action, up to ~18/case, only 2
    // in parallel) — thorough but minutes-slow for a few tests. Opt into the live
    // healer with HEAL_MODE=live.
    const liveHeal = process.env.HEAL_MODE === 'live' && !!ctx?.targetUrl;

    // Text-healer grounding only: a real DOM inventory of the app's ENTRY
    // page. (The live healer observes pages itself, so the snapshot would be
    // wasted memory there.) A full crawl here OOM-killed the memory-limited
    // Azure container, so this is a single-page snapshot that fails soft —
    // set HEAL_LIGHT_CRAWL=false to disable entirely.
    let exploredApp: TestOpsState['exploredApp'] = null;
    if (!liveHeal && ctx?.targetUrl && process.env.HEAL_LIGHT_CRAWL !== 'false') {
      try {
        exploredApp = await snapshotEntryPage(ctx.targetUrl, ctx || undefined);
      } catch (err) {
        logger.warn('pipeline-flow/heal: entry-page snapshot failed — healing continues without DOM inventory', { error: (err as Error).message });
      }
    }

    const baseState: TestOpsState = {
      ...createInitialState('', ctx || undefined, llm),
      testCases: cases,
      automationScripts: normalizedScripts,
      pageObjects: normalizedPageObjects,
      exploredApp,
      failureReason: firstError,
      executionResults: { passed: cases.length - failedCount, failed: failedCount },
    };

    // Bounded heal → re-execute loop with convergence detection. This enforces
    // in code what pipeline-definition.json's convergence guards only declare:
    // stop when everything passes, when a pass makes NO progress (the same
    // tests fail with the same errors — more passes would just burn tokens),
    // or when the pass budget (HEAL_MAX_PASSES, default 2) is spent.
    const reportScope = (testRunId && String(testRunId)) || makeRunId();
    const allureResultsDir = path.join(os.tmpdir(), `jbs-allure-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    // Playwright's HTML reporter DELETES its output folder before writing, so
    // per-pass runs must not point at the shared run-root report dir (that
    // would wipe the saved run's report and leave nothing if a later pass
    // can't execute). Render to a temp dir; publish the final pass on success.
    const htmlTmpDir = path.join(os.tmpdir(), `jbs-html-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    const maxPasses = Math.max(1, Math.min(4, parseInt(process.env.HEAL_MAX_PASSES || '', 10) || 2));
    const failureSignature = (fails: Record<string, string>) =>
      Object.entries(fails)
        .map(([id, e]) => `${id}:${(e || '').split('\n')[0].slice(0, 160)}`)
        .sort()
        .join('|');

    let currentFailures = failuresByTc;
    let workingState = baseState;
    let reExecuted: TestOpsState = baseState;
    let passesRun = 0;
    const allNotes: Record<string, string> = {};

    for (let pass = 1; pass <= maxPasses; pass++) {
      if (pass > 1 && Date.now() - healStart > timeBudgetMs) {
        logger.warn(`pipeline-flow/heal: time budget (${timeBudgetMs}ms) spent after pass ${pass - 1} — returning current results`);
        break;
      }
      passesRun = pass;
      const healed = await timed(tenantId, 'healing',
        () => (liveHeal
          ? liveHealingAgent(workingState, { failuresByTc: currentFailures })
          : healingAgent(workingState, { failuresByTc: currentFailures })),
        () => ({ pass, mode: liveHeal ? 'live' : 'batch', failing: Object.keys(currentFailures).length }));
      Object.assign(allNotes, healed.healingNotes || {});
      // Fresh Allure results per pass so the final report reflects the last run.
      await fs.rm(allureResultsDir, { recursive: true, force: true }).catch(() => {});
      reExecuted = await executionAgent({ ...healed, failureReason: null }, { htmlReportDir: htmlTmpDir, allureResultsDir });

      if (reExecuted.executionResults === null) {
        // Infrastructure failure (spawn/timeout/OOM), NOT a green run — stop
        // and report executed:false rather than mistaking it for success.
        logger.warn(`pipeline-flow/heal: pass ${pass} could not execute — aborting heal loop`, { reason: reExecuted.failureReason });
        break;
      }

      const failsNow: Record<string, string> = {};
      for (const d of reExecuted.executionResults?.details || []) {
        if (d.status === 'failed') failsNow[d.testCaseId] = d.error || 'Test failed';
      }
      if (Object.keys(failsNow).length === 0) break; // all green
      if (pass < maxPasses && failureSignature(failsNow) === failureSignature(currentFailures)) {
        logger.warn(`pipeline-flow/heal: pass ${pass} made no progress (identical failures) — stopping early`);
        break;
      }
      currentFailures = failsNow;
      workingState = { ...reExecuted, failureReason: Object.values(failsNow)[0] || 'Some tests failed' };
    }

    const newDetails = reExecuted.executionResults?.details || [];
    const newById = new Map<string, any>(newDetails.map((d) => [d.testCaseId, d]));

    const healingLog = [...failedById.keys()].map((tcId) => {
      const after = newById.get(tcId);
      const result: 'fixed' | 'unchanged' | 'unknown' =
        after?.status === 'passed' ? 'fixed' : after?.status === 'failed' ? 'unchanged' : 'unknown';
      return {
        testCaseId: tcId,
        error: failedById.get(tcId)?.error || 'Unknown error',
        fix: result === 'fixed'
          ? `Healed and re-ran successfully (${passesRun} pass${passesRun > 1 ? 'es' : ''})`
          : (allNotes[tcId] || 'Could not be healed automatically'),
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
      // Publish the final pass's Playwright HTML report into the run root,
      // then rebuild the Allure report next to it. Skipped when nothing
      // executed, so the run's previous report survives an aborted heal.
      const runDir = reportDirFor(tenantId, reportScope);
      try {
        await fs.rm(runDir, { recursive: true, force: true });
        await fs.cp(htmlTmpDir, runDir, { recursive: true });
      } catch (err) {
        logger.warn('pipeline-flow/heal: could not publish HTML report', { error: (err as Error).message });
      }
      const built = await buildAllureReport(tenantId, reportScope, allureResultsDir);
      reportUrl = built ? reportUrlFor(tenantId, reportScope) : undefined;
      // Mirror the healed (re-published) report to cloud storage too, so the
      // Reports page reflects the post-heal results durably.
      void mirrorReportToBlob(tenantId, reportScope, { passed, failed, total, durationMs });
    }
    await fs.rm(allureResultsDir, { recursive: true, force: true }).catch(() => {});
    await fs.rm(htmlTmpDir, { recursive: true, force: true }).catch(() => {});

    if (executed) {
      notifyRun(tenantId, reportScope, {
        testCases: reExecuted.testCases, details: newDetails, passed, failed, total,
        durationSeconds: Math.round(durationMs / 1000), reportUrl, healed: true,
      });
    }

    return {
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
    };
  }
}

router.post('/heal', async (req: Request, res: Response) => {
  try {
    const { testCases } = req.body || {};
    if (!Array.isArray(testCases) || testCases.length === 0) {
      res.status(400).json({ error: 'testCases array is required' });
      return;
    }
    res.json(await healStage(req.user!.tenantId, req.body));
  } catch (err) {
    const message = (err as Error).message || 'Healing failed';
    console.error('[pipeline-flow/heal] error:', message);
    res.status(500).json({ error: message });
  }
});

/**
 * POST /api/pipeline-flow/heal/start
 * Async variant of /heal — heal passes chain LLM calls + full Playwright
 * re-runs and routinely outlive the ~240s ingress cap (the same failure mode
 * as /execute). Returns { jobId }; poll GET /jobs/:jobId for the result.
 */
router.post('/heal/start', (req: Request, res: Response) => {
  const { testCases } = req.body || {};
  if (!Array.isArray(testCases) || testCases.length === 0) {
    res.status(400).json({ error: 'testCases array is required' });
    return;
  }
  const tenantId = req.user!.tenantId;
  const jobId = startJob(tenantId, () => healStage(tenantId, req.body));
  res.json({ jobId });
});

/**
 * POST /report-support
 * On-demand "Report to Support": send a failure/flaky summary of the current run
 * to every notification channel the tenant has connected (Outlook email / Slack /
 * Teams). Distinct from the automatic post-run notification — this is a manual
 * button the user clicks to escalate a failing run. Returns per-channel results;
 * `configured:false` means the tenant has no notification channel set up yet.
 * Body: { runId?, feature?, module?, total?, passed?, failed?, durationSeconds?,
 *         reportUrl?, failures?: [{name,error}], flaky?: [{name,error}] }
 */
router.post('/report-support', async (req: Request, res: Response) => {
  try {
    const tenantId = req.user!.tenantId;
    const b = req.body || {};

    const failures: { name?: string; error?: string }[] = Array.isArray(b.failures) ? b.failures : [];
    const flaky: { name?: string; error?: string }[] = Array.isArray(b.flaky) ? b.flaky : [];

    const failLines = failures.slice(0, 10).map(
      (f) => `• ${f.name || 'test'}: ${String(f.error || 'failed').split('\n')[0].slice(0, 160)}`,
    );
    if (failures.length > 10) failLines.push(`…and ${failures.length - 10} more failing`);
    const flakyLines = flaky.slice(0, 10).map((f) => `• [flaky/auto-healed] ${f.name || 'test'}`);
    const errorText = [...failLines, ...flakyLines].join('\n') || undefined;

    const total = Number(b.total) || 0;
    const passed = Number(b.passed) || 0;
    const failed = Number(b.failed) || failures.length;
    const status: TestRunEmailPayload['status'] =
      total === 0 ? 'partial' : passed === 0 ? 'failed' : failed > 0 ? 'partial' : 'passed';

    const payload: TestRunEmailPayload = {
      runId: String(b.runId || `support-${Date.now()}`),
      feature: `Support escalation — ${String(b.feature || 'Web Application Automation')}`,
      module: b.module ? String(b.module) : undefined,
      status,
      totalTests: total,
      passed,
      failed,
      durationSeconds: typeof b.durationSeconds === 'number' ? b.durationSeconds : undefined,
      reportUrl: typeof b.reportUrl === 'string' && /^https?:/i.test(b.reportUrl) ? b.reportUrl : undefined,
      error: errorText,
    };

    const results = await dispatchTestRunNotification(tenantId, payload);
    res.json({ ok: true, configured: results.length > 0, results });
  } catch (err: any) {
    console.error('[pipeline-flow/report-support] error:', err.message);
    res.status(500).json({ error: 'Failed to send the support report.' });
  }
});

export default router;
