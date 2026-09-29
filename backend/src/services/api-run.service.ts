/**
 * api-run.service.ts
 * ──────────────────
 * One call that runs the whole API Automation pipeline without a browser in
 * the loop: resolve the environment → understand the surface → design the
 * scenarios → save the run → execute → heal → report.
 *
 * The dashboard drives the same stages interactively (with a review gate
 * between design and execution); this is the headless variant behind the
 * public REST API and the CLI, so a CI job can do
 *
 *   intelliqe-api run --spec openapi.yaml --env staging --wait
 *
 * and get back the same run, report and Reports-page entry the UI produces.
 * It runs as a detached job (async-jobs.service) and publishes its phase so a
 * poller can show progress.
 */
import pool from '../db.js';
import { runGenerationOnly } from '../agents/pipeline.js';
import { getTenantLlm } from './llm.service.js';
import { sanitizeApiSpec } from '../utils/api-spec.js';
import { analyzeApiSurface, type ApiProfile } from './api-intelligence.service.js';
import { applyEnvironment, getEnvironment, listEnvironments } from './api-environments.service.js';
import { executeStage, healStage } from '../routes/pipeline-flow.routes.js';
import { setJobProgress } from './async-jobs.service.js';
import type { ImportedEndpoint } from './api-import.service.js';
import type { ApiSpec, TestCase } from '../agents/state.js';

export interface HeadlessRunInput {
  endpoints: ImportedEndpoint[];
  title?: string;
  coverage?: 'essential' | 'standard' | 'exhaustive';
  layers?: string[];
  environmentId?: string;
  /** Default true — false designs + saves the scenarios and stops. */
  execute?: boolean;
  /** Default true — false skips self-healing after a red execution. */
  heal?: boolean;
  requirements?: string;
}

export interface HeadlessRunResult {
  runId: string | null;
  title: string;
  profile: ApiProfile;
  environment: { id: string; name: string } | null;
  scenarios: { total: number; byType: Record<string, number> };
  executed: boolean;
  stats: { total: number; passed: number; failed: number; notRun: number; passRate: number; durationMs: number } | null;
  healed: { attempted: number; fixed: number } | null;
  reportUrl?: string;
  failures: { testCaseId: string; title: string; error?: string }[];
  phases: { phase: string; at: string; detail: string }[];
}

/** The API test-case columns the Reports page and exports expect. */
const API_COLUMNS = [
  'tcNumber', 'module', 'endpoint', 'method', 'scenario', 'type', 'priority',
  'precondition', 'requestHeaders', 'queryParams', 'requestBody', 'expectedStatus', 'expected',
];

async function saveApiRun(tenantId: string, username: string, title: string, cases: TestCase[]): Promise<string> {
  const { rows } = await pool.query(
    `INSERT INTO test_runs (username, story_key, story_title, source, columns, tenant_id, module, submodule)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
    [username, null, title.slice(0, 500), 'api', JSON.stringify(API_COLUMNS), tenantId, 'API', null],
  );
  const runId: string = rows[0].id;
  for (let i = 0; i < cases.length; i++) {
    const tc = cases[i]!;
    await pool.query(
      `INSERT INTO test_cases
       (test_run_id, tc_number, title, steps, expected, priority, type, feature, precondition, status, sort_order, module, submodule, tags,
        description, test_steps, test_data, severity, traceability_id, api_meta)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20)`,
      [
        runId, tc.id, tc.title || tc.scenario || '', JSON.stringify(tc.steps || []), tc.expectedResult || '',
        tc.priority || 'P1', tc.type || 'api', tc.feature || '', tc.precondition || '', tc.status || 'generated', i,
        'API', tc.submodule || null, JSON.stringify(tc.tags || []),
        tc.description || null, JSON.stringify(tc.testSteps || []), JSON.stringify(tc.testData || {}),
        tc.severity || null, tc.traceabilityId || null, tc.api ? JSON.stringify(tc.api) : null,
      ],
    );
  }
  return runId;
}

export async function runHeadlessApiRun(
  tenantId: string,
  username: string,
  input: HeadlessRunInput,
  jobId?: string,
): Promise<HeadlessRunResult> {
  const phases: HeadlessRunResult['phases'] = [];
  const mark = (phase: string, detail: string) => {
    phases.push({ phase, at: new Date().toISOString(), detail });
    if (jobId) setJobProgress(jobId, { phase, detail, phases });
  };

  if (!Array.isArray(input.endpoints) || input.endpoints.length === 0) throw new Error('At least one endpoint is required.');

  /* 1. Environment */
  let env = null;
  if (input.environmentId) {
    env = await getEnvironment(tenantId, input.environmentId, { reveal: true });
    if (!env) throw new Error(`Environment ${input.environmentId} was not found.`);
  } else {
    const all = await listEnvironments(tenantId);
    const def = all.find((e) => e.isDefault);
    if (def) env = await getEnvironment(tenantId, def.id, { reveal: true });
  }
  const resolved = input.endpoints.map((e) => applyEnvironment(e, env));
  mark('environment', env ? `Resolved ${resolved.length} endpoints against "${env.name}"` : `No environment applied (${resolved.length} endpoints as imported)`);

  /* 2. Understand */
  const profile = analyzeApiSurface(resolved);
  mark('analyze', profile.summary);

  /* 3. Design */
  const llm = await getTenantLlm(tenantId);
  if (!llm) throw new Error('No LLM configured. Add an Anthropic API key in System Configuration → LLM Configuration.');
  const specs = resolved
    .map((e) => sanitizeApiSpec({ ...e, coverage: input.coverage || profile.strategy.recommendedCoverage }))
    .filter((s): s is ApiSpec => !!s);
  if (!specs.length) throw new Error('None of the endpoints had a valid absolute http(s) URL.');
  mark('design', `Designing scenarios for ${specs.length} endpoint${specs.length === 1 ? '' : 's'} at ${input.coverage || profile.strategy.recommendedCoverage} depth…`);
  const state = await runGenerationOnly(input.requirements || '', {
    llm, tenantId, apiSpecs: specs, apiProfile: profile, apiLayers: input.layers || null,
    // Per-endpoint progress goes to the job's live status only; the phase
    // list keeps one entry per phase rather than one per endpoint.
    onProgress: (p) => { if (jobId) setJobProgress(jobId, { phase: 'design', detail: p.message, done: p.done, total: p.total, phases }); },
    appContext: { targetUrl: specs[0]!.baseUrl, appName: 'API', environment: undefined, explorePrompt: undefined, roles: undefined },
  });
  const cases = state.testCases;
  const byType: Record<string, number> = {};
  for (const c of cases) byType[c.type] = (byType[c.type] || 0) + 1;
  mark('design', `${cases.length} scenarios designed (${Object.entries(byType).map(([k, v]) => `${v} ${k}`).join(', ')})`);

  /* 4. Save */
  const title = (input.title || '').trim() || (specs.length === 1 ? `${specs[0]!.method} ${specs[0]!.url}` : `${specs.length} API endpoints`);
  let runId: string | null = null;
  try {
    runId = await saveApiRun(tenantId, username, title, cases);
    mark('save', `Saved as test run ${runId}`);
  } catch (err) {
    mark('save', `Could not save the run (${(err as Error).message}) — continuing without a Reports-page entry`);
  }

  const base: HeadlessRunResult = {
    runId, title, profile, environment: env ? { id: env.id, name: env.name } : null,
    scenarios: { total: cases.length, byType }, executed: false, stats: null, healed: null, failures: [], phases,
  };
  if (input.execute === false) { mark('done', 'Stopped after design as requested'); return base; }

  /* 5. Execute */
  const apiSpec = specs[0]!;
  mark('execute', `Executing ${state.automationScripts.length} specs…`);
  const started = Date.now();
  let exec = await executeStage(tenantId, {
    testCases: cases, scripts: state.automationScripts, pageObjects: state.pageObjects,
    testRunId: runId || undefined, targetUrl: apiSpec.baseUrl, mode: 'api', apiSpec,
  });
  let details: any[] = Array.isArray(exec?.executionDetails) ? exec.executionDetails : [];
  let reportUrl: string | undefined = exec?.reportUrl;
  if (exec?.summary?.executed === false) {
    mark('execute', exec.summary.reason || 'Nothing ran');
    return { ...base, executed: false, stats: { total: cases.length, passed: 0, failed: 0, notRun: cases.length, passRate: 0, durationMs: Date.now() - started }, reportUrl };
  }
  let passed = details.filter((d) => d.status === 'passed').length;
  let failed = details.filter((d) => d.status === 'failed').length;
  mark('execute', `${passed} passed · ${failed} failed`);

  /* 6. Heal */
  let healed: HeadlessRunResult['healed'] = null;
  if (failed > 0 && input.heal !== false) {
    mark('heal', `Diagnosing ${failed} failure${failed === 1 ? '' : 's'}…`);
    try {
      const h = await healStage(tenantId, {
        testCases: cases, scripts: state.automationScripts, pageObjects: state.pageObjects, executionDetails: details,
        testRunId: runId || undefined, targetUrl: apiSpec.baseUrl, mode: 'api', apiSpec,
      });
      const log: any[] = Array.isArray(h?.healingLog) ? h.healingLog : [];
      healed = { attempted: log.length, fixed: log.filter((l) => l.result === 'fixed').length };
      if (Array.isArray(h?.executionDetails) && h.executionDetails.length) details = h.executionDetails;
      if (h?.reportUrl) reportUrl = h.reportUrl;
      passed = details.filter((d) => d.status === 'passed').length;
      failed = details.filter((d) => d.status === 'failed').length;
      mark('heal', healed.fixed ? `${healed.fixed} spec${healed.fixed === 1 ? '' : 's'} repaired · ${failed} still failing` : `Nothing repaired — ${failed} genuine failure${failed === 1 ? '' : 's'}`);
    } catch (err) {
      mark('heal', `Healing failed: ${(err as Error).message}`);
    }
  }

  const total = cases.length;
  const notRun = total - passed - failed;
  const byId = new Map(details.map((d) => [d.testCaseId, d]));
  const failures = cases
    .filter((c) => byId.get(c.id)?.status === 'failed' || !byId.has(c.id))
    .map((c) => ({ testCaseId: c.id, title: c.title, error: byId.get(c.id)?.error || (byId.has(c.id) ? undefined : 'No result returned') }));
  const stats = { total, passed, failed, notRun, passRate: total ? Math.round((passed / total) * 100) : 0, durationMs: Date.now() - started };
  mark('report', `${stats.passRate}% pass rate (${passed}/${total})`);
  return { ...base, executed: true, stats, healed, reportUrl, failures };
}
