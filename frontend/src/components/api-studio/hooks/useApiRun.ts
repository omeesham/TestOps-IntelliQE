/**
 * useApiRun — the pipeline, as state.
 *
 *   Scenarios → Automate → Execute → Heal → Report
 *
 * with one deliberate stop, the scenario review gate. Design is the stage a
 * human should steer — what gets tested and what gets skipped is a judgement
 * call — while everything after it runs straight through.
 *
 * The run is grounded in the catalogue's selected endpoints, resolved against
 * the active environment right before design, and shaped by the reviewer's
 * strategy (depth + layers). Every stage reports its progress so a
 * long stage is never a spinner with nothing behind it.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/components/feedback/ToastProvider';
import {
  designApiScenarios, getApiJob, executePipeline, healPipeline, saveTestCases, exportTestCases, publishToGit, getConfigurations,
  renderApiRun, notifyApiRun, type ApiSpecPayload, type ApiJob,
} from '@/services/api';
import { envRunKey } from './useApiEnvironments';
import { formatDuration } from '../format';
import type {
  Phase, Stage, StageKey, StageStatus, Scenario, Spec, RunRow, LogLine, LogLevel, RunReport, PushState,
  ServiceObject, CatalogEndpoint, Strategy, ApiProfile, ApiEnvironment,
} from '../types';

/** How often the design job is polled for progress. */
const DESIGN_POLL_MS = 3000;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const INITIAL_STAGES: Stage[] = [
  { key: 'scenarios', label: 'Scenarios', hint: 'Design every scenario the strategy calls for', status: 'pending', detail: 'Not started' },
  { key: 'automate', label: 'Automate', hint: 'Render each scenario into a runnable request spec', status: 'pending', detail: 'Not started' },
  { key: 'execute', label: 'Execute', hint: 'Run the suite against the live endpoints', status: 'pending', detail: 'Not started' },
  { key: 'heal', label: 'Heal', hint: 'Diagnose failures and repair what the test got wrong', status: 'pending', detail: 'Not started' },
  { key: 'report', label: 'Report', hint: 'Publish the result', status: 'pending', detail: 'Not started' },
];

/** The API test-case columns saved with the run (drives export + Reports page). */
const API_COLUMNS = [
  'tcNumber', 'module', 'endpoint', 'method', 'scenario', 'type', 'priority',
  'precondition', 'requestHeaders', 'queryParams', 'requestBody', 'expectedStatus', 'expected',
];

export interface RunInputs {
  endpoints: CatalogEndpoint[];
  strategy: Strategy;
  profile: ApiProfile | null;
  environment?: ApiEnvironment | null;
}

/** One backend test case → the Scenario the UI renders. Shared by the initial
 *  design and by the deterministic re-resolve, so both produce identical shapes. */
function toScenario(tc: any, i: number): Scenario {
  return {
    id: tc.id || `TC-${String(i + 1).padStart(3, '0')}`,
    title: tc.title || tc.scenario || 'Scenario',
    description: tc.description || '',
    feature: tc.feature || '',
    type: tc.type || 'api',
    priority: tc.priority || 'P1',
    severity: tc.severity || '',
    tags: Array.isArray(tc.tags) ? tc.tags : [],
    steps: Array.isArray(tc.steps) ? tc.steps : [],
    testSteps: Array.isArray(tc.testSteps) ? tc.testSteps : [],
    expectedResult: tc.expectedResult || '',
    precondition: tc.precondition || '',
    api: tc.api,
    raw: tc,
  };
}

/** Backend automation scripts → the Spec the UI holds and later executes. */
function toSpecs(scripts: any[]): Spec[] {
  return (Array.isArray(scripts) ? scripts : []).map((s: any) => ({
    testCaseId: s.testCaseId, fileName: s.fileName || `${s.testCaseId}.spec.ts`, code: s.code || '', path: s.path,
  }));
}

/** The conventional environment variable a credential resolves from when the
 *  endpoint's auth value is left blank — so auth still comes from the active
 *  environment (and retargets on a switch) rather than being dropped. */
const AUTH_PLACEHOLDER: Record<string, string> = { bearer: '{{token}}', apikey: '{{apiKey}}', basic: '{{basicAuth}}' };

function specFrom(ep: CatalogEndpoint, coverage: Strategy['coverage'], hasEnv = false): ApiSpecPayload {
  const m = (ep.method || 'GET').toUpperCase();
  const authType = ep.auth?.type || 'none';
  // Keep an explicit value; otherwise, when a run has an environment, fall back to
  // the conventional {{var}} so the environment supplies the credential at render
  // time (with no environment we leave it blank, exactly as before).
  const authValue = authType !== 'none'
    ? (ep.auth?.value || (hasEnv ? AUTH_PLACEHOLDER[authType] : undefined) || undefined)
    : undefined;
  return {
    method: m,
    url: ep.url,
    headers: (ep.headers || []).filter((h) => h.key?.trim()),
    auth: { type: authType, value: authValue, headerName: ep.auth?.headerName },
    body: ['POST', 'PUT', 'PATCH', 'DELETE'].includes(m) && ep.body?.trim() ? ep.body : undefined,
    expectedStatus: ep.expectedStatus || 200,
    expectedResponse: ep.expectedResponse || '',
    coverage,
  };
}

export function useApiRun(opts: { onPhase?: (phase: Phase) => void } = {}) {
  const { user } = useAuth();
  const toast = useToast();

  const [phase, setPhase] = useState<Phase>('idle');
  const [stages, setStages] = useState<Stage[]>(INITIAL_STAGES);
  const [scenarios, setScenarios] = useState<Scenario[]>([]);
  const [specs, setSpecs] = useState<Spec[]>([]);
  const [serviceObjects, setServiceObjects] = useState<ServiceObject[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [rows, setRows] = useState<RunRow[]>([]);
  const [report, setReport] = useState<RunReport | null>(null);
  const [testRunId, setTestRunId] = useState('');
  const [runError, setRunError] = useState('');
  const [exporting, setExporting] = useState(false);
  const [pushState, setPushState] = useState<PushState>({ status: 'idle' });
  /** The endpoints this run was designed for — frozen once design starts. */
  const [runEndpoints, setRunEndpoints] = useState<CatalogEndpoint[]>([]);
  const [runLabel, setRunLabel] = useState('');
  /** Which environment this run was designed against — so the shell can tell
   *  when the active environment has since changed, and re-resolve against it. */
  const [runEnvName, setRunEnvName] = useState('');
  const [runEnvKey, setRunEnvKey] = useState('');
  const [runEnv, setRunEnv] = useState<ApiEnvironment | null>(null);
  /** The TEMPLATED designed cases, kept so the run can be re-rendered against
   *  another environment deterministically (no model call). */
  const [runCases, setRunCases] = useState<any[]>([]);
  /** True while a live environment switch is re-resolving the run's data. */
  const [reresolving, setReresolving] = useState(false);
  const [logs, setLogs] = useState<LogLine[]>([]);
  const logIdRef = useRef(0);
  const runIdRef = useRef(0);
  const startedAtRef = useRef<number>(0);

  const log = useCallback((stage: LogLine['stage'], text: string, level: LogLevel = 'info') => {
    setLogs((prev) => [...prev, { id: ++logIdRef.current, at: Date.now(), stage, level, text }].slice(-500));
  }, []);

  const setStage = useCallback((key: StageKey, status: StageStatus, detail: string) => {
    setStages((prev) => prev.map((s) => {
      if (s.key !== key) return s;
      if (status === 'running') return { ...s, status, detail, startedAt: Date.now(), durationMs: undefined };
      const durationMs = s.startedAt ? Date.now() - s.startedAt : s.durationMs;
      return { ...s, status, detail, durationMs };
    }));
  }, []);

  useEffect(() => { opts.onPhase?.(phase); }, [phase]); // eslint-disable-line react-hooks/exhaustive-deps

  const running = ['generating', 'automating', 'executing', 'healing'].includes(phase);
  const started = phase !== 'idle';
  const finished = (phase === 'report' || phase === 'failed') && scenarios.length > 0;
  const baseUrl = useMemo(() => {
    // Prefer the run environment's base URL — the endpoints are kept templated,
    // so their own host is the imported one, not where the run actually points.
    if (runEnv?.baseUrl) { try { return new URL(runEnv.baseUrl).origin; } catch { /* fall through */ } }
    try { return runEndpoints[0] ? new URL(runEndpoints[0].url).origin : ''; } catch { return ''; }
  }, [runEnv, runEndpoints]);

  /* ═══════════════════════════════════════════════════════════════
     Stage 1 — design the scenarios (stops at the review gate)
     ═══════════════════════════════════════════════════════════════ */
  const runScenarios = useCallback(async (inputs: RunInputs) => {
    if (inputs.endpoints.length === 0) {
      toast.warning('Nothing selected', 'Select at least one endpoint in the catalogue to design scenarios for.');
      return;
    }
    const bad = inputs.endpoints.find((e) => { try { const u = new URL(e.url); return u.protocol !== 'http:' && u.protocol !== 'https:'; } catch { return true; } });
    if (bad) {
      setRunError(`"${bad.title}" has no valid absolute URL (${bad.url || 'empty'}). Fix it in the catalogue first.`);
      toast.error('Invalid endpoint URL', bad.url || bad.title);
      return;
    }

    const myRun = ++runIdRef.current;
    startedAtRef.current = Date.now();
    setRunError('');
    setStages(INITIAL_STAGES);
    setScenarios([]); setSpecs([]); setServiceObjects([]); setRows([]); setReport(null);
    setSelected(new Set()); setTestRunId('');
    setLogs([]);
    setPushState({ status: 'idle' });
    setPhase('generating');

    const label = inputs.endpoints.length === 1
      ? `${inputs.endpoints[0]!.method} ${inputs.endpoints[0]!.url}`
      : `${inputs.endpoints.length} API endpoints${inputs.profile?.resources.length ? ` · ${inputs.profile.resources.slice(0, 3).map((r) => r.name).join(', ')}${inputs.profile.resources.length > 3 ? '…' : ''}` : ''}`;
    setRunLabel(label);
    log('run', `Target: ${label}`);

    /* Environment — the endpoints stay TEMPLATED; the server resolves {{vars}} +
       the base URL against the active environment at render time, so the run can
       later retarget to another environment with no model call. Record which
       environment (and which revision) this run is grounded in. */
    setRunEnvName(inputs.environment ? inputs.environment.name : 'No environment');
    setRunEnvKey(envRunKey(inputs.environment));
    setRunEnv(inputs.environment || null);
    const endpoints = inputs.endpoints;
    setRunEndpoints(endpoints);
    if (inputs.environment) log('env', `Resolving {{variables}} + base URL against environment "${inputs.environment.name}"${inputs.environment.baseUrl ? ` (${inputs.environment.baseUrl})` : ''}`, 'ok');
    const placeholder = endpoints.filter((e) => /^https?:\/\/api\.example\.com/i.test(e.url));
    if (placeholder.length) log('run', `${placeholder.length} endpoint${placeholder.length === 1 ? '' : 's'} still point at the placeholder host api.example.com — scenarios can be designed, but execution will not reach a real API. Edit the endpoint URL in the catalogue.`, 'warn');

    setStage('scenarios', 'running', `Designing coverage across ${endpoints.length} endpoint${endpoints.length === 1 ? '' : 's'}…`);
    log('scenarios', `Strategy: ${inputs.strategy.coverage} depth · layers ${inputs.strategy.layers.join(', ')}`);

    try {
      // Design runs as a server-side job (one model call per endpoint, in a
      // concurrent pool) and is polled — a 60-endpoint catalogue takes minutes,
      // longer than any single request is allowed to live.
      const { jobId } = await designApiScenarios({
        apiSpecs: endpoints.map((e) => specFrom(e, inputs.strategy.coverage, !!inputs.environment)),
        apiLayers: inputs.strategy.layers,
        apiProfile: inputs.profile?.insights?.length ? { insights: inputs.profile.insights } : null,
        // Optional NL-authored brief; undefined keeps the prior behaviour.
        requirements: inputs.strategy.requirements || undefined,
        // The server resolves {{vars}} + base URL against this environment at
        // render time; undefined designs the endpoints exactly as sent.
        environmentId: inputs.environment?.id,
      });
      let res: any = null;
      let lastProgress = '';
      let pollErrors = 0;
      for (;;) {
        await sleep(DESIGN_POLL_MS);
        if (myRun !== runIdRef.current) return;
        let job: ApiJob;
        try { job = await getApiJob(jobId); pollErrors = 0; }
        catch (err: any) {
          // A transient poll failure is not a failed design — retry a few times.
          if (++pollErrors >= 5) throw new Error(err?.response?.data?.error || err?.message || 'Lost contact with the design job.');
          continue;
        }
        const p = job.progress;
        if (p && typeof p.total === 'number') {
          const line = p.message || `${p.done ?? 0}/${p.total} endpoints designed`;
          if (line !== lastProgress) {
            lastProgress = line;
            setStage('scenarios', 'running', `${line}…`);
            if (p.phase !== 'design' || (p.done ?? 0) === 0 || (p.done ?? 0) % 5 === 0 || p.done === p.total) log('scenarios', line);
          }
        }
        if (job.status === 'completed') { res = job.result; break; }
        if (job.status === 'failed') throw new Error(job.error || 'Scenario design failed.');
      }
      if (myRun !== runIdRef.current) return;

      const cases: any[] = Array.isArray(res?.testCases) ? res.testCases : [];
      if (cases.length === 0) throw new Error('The generator returned no scenarios for these endpoints.');

      const mapped: Scenario[] = cases.map(toScenario);
      const mappedSpecs: Spec[] = toSpecs(res?.automationScripts || []);

      setScenarios(mapped);
      setSpecs(mappedSpecs);
      setServiceObjects(Array.isArray(res?.pageObjects) ? res.pageObjects : []);
      // Keep the templated cases so a later environment switch re-resolves the
      // data deterministically, without another model call.
      setRunCases(Array.isArray(res?.normalizedCases) ? res.normalizedCases : []);
      setSelected(new Set(mapped.map((m) => m.id)));

      const byCategory = mapped.reduce<Record<string, number>>((acc, m) => { acc[m.type] = (acc[m.type] || 0) + 1; return acc; }, {});
      const breakdown = Object.entries(byCategory).map(([k, v]) => `${v} ${k === 'e2e' ? 'flow' : k}`).join(', ');
      setStage('scenarios', 'done', `${mapped.length} scenarios — ${breakdown}`);
      log('scenarios', `Designed ${mapped.length} scenarios (${breakdown}) with ${(res?.pageObjects || []).length} service object${(res?.pageObjects || []).length === 1 ? '' : 's'}`, 'ok');
      log('run', 'Review the scenarios, then run the suite.', 'info');
      setPhase('review');
    } catch (err: any) {
      if (myRun !== runIdRef.current) return;
      const msg = err?.response?.data?.error || err?.message || 'Scenario design failed.';
      setStage('scenarios', 'failed', msg);
      log('scenarios', msg, 'error');
      setRunError(msg);
      setPhase('failed');
      toast.error('Scenario design failed', msg);
    }
  }, [log, setStage, toast]);

  /* ═══════════════════════════════════════════════════════════════
     Live environment switch — re-resolve the designed run's data
     against another environment, deterministically (no model call).
     ═══════════════════════════════════════════════════════════════ */
  const reresolve = useCallback(async (environment: ApiEnvironment | null) => {
    // Nothing designed yet, or a run is mid-flight — never retarget under it.
    if (!runCases.length) return;
    if (['generating', 'automating', 'executing', 'healing'].includes(phase)) return;
    setReresolving(true);
    try {
      const r = await renderApiRun(runCases, environment?.id);
      const cases: any[] = Array.isArray(r?.testCases) ? r.testCases : [];
      if (!cases.length) throw new Error('The re-render returned no cases.');
      const mapped = cases.map(toScenario);
      setScenarios(mapped);
      setSpecs(toSpecs(r?.automationScripts || []));
      setServiceObjects(Array.isArray(r?.pageObjects) ? r.pageObjects : []);
      // Ids are stable across a re-render, so keep the user's selection.
      setSelected((prev) => {
        const ids = new Set(mapped.map((m) => m.id));
        const kept = new Set([...prev].filter((id) => ids.has(id)));
        return kept.size ? kept : ids;
      });
      setRunEnv(environment || null);
      setRunEnvName(environment ? environment.name : 'No environment');
      setRunEnvKey(envRunKey(environment));
      log('env', `Re-resolved test data against "${environment?.name || 'No environment'}"${environment?.baseUrl ? ` (${environment.baseUrl})` : ''}`, 'ok');
    } catch (err: any) {
      log('env', `Could not re-resolve against the environment: ${err?.response?.data?.error || err?.message}`, 'warn');
    } finally {
      setReresolving(false);
    }
  }, [runCases, phase, log]);

  /** Map backend execution details onto the selected scenarios — honestly. */
  const mapRows = (chosen: Scenario[], details: any[], fallbackError: string | null | undefined): RunRow[] => {
    const byId = new Map(details.map((d) => [d.testCaseId, d]));
    return chosen.map((c) => {
      const d = byId.get(c.id);
      if (!d) return { testCaseId: c.id, name: c.title, status: 'not_run' as const, duration: '', error: fallbackError || 'The runner returned no result for this scenario.' };
      const duration = typeof d.durationMs === 'number' ? `${(d.durationMs / 1000).toFixed(2)}s` : '';
      if (d.status === 'passed') return { testCaseId: c.id, name: c.title, status: 'passed' as const, duration };
      if (d.status === 'failed') return { testCaseId: c.id, name: c.title, status: 'failed' as const, duration, error: d.error || 'Test failed (no message returned).' };
      return { testCaseId: c.id, name: c.title, status: 'not_run' as const, duration, error: d.error };
    });
  };

  const finishReport = (total: number, passed: number, failed: number, notRun: number, healed: number, durationMs: number, reportUrl?: string) => {
    setStage('report', 'running', 'Assembling…');
    const passRate = total > 0 ? Math.round((passed / total) * 100) : 0;
    setReport({ total, passed, failed, notRun, healed, passRate, durationMs, reportUrl });
    setStage('report', 'done', `${passRate}% pass rate`);
    log('report', `Report ready — ${passed}/${total} passed (${passRate}%) in ${formatDuration(durationMs)}`, failed > 0 ? 'warn' : 'ok');
    setPhase('report');
    if (failed > 0 || notRun > 0) toast.warning('Run complete', `${passed}/${total} passed`);
    else toast.success('Run complete', `All ${total} scenarios passed`);
    // Fire-and-forget: notify any configured webhooks. Off the run's critical
    // path — a failure to notify is swallowed and never surfaces to the user.
    void notifyApiRun({
      title: runLabel || 'API run',
      runId: testRunId || undefined,
      reportUrl,
      status: (failed > 0 || notRun > 0) ? 'failed' : 'passed',
      stats: { total, passed, failed, notRun, passRate },
    }).catch(() => { /* webhooks are best-effort */ });
  };

  /* ═══════════════════════════════════════════════════════════════
     Stages 2-5 — automate, execute, heal, report (one continuous pass)
     ═══════════════════════════════════════════════════════════════ */
  const runSuite = useCallback(async () => {
    const myRun = runIdRef.current;
    const chosen = scenarios.filter((s) => selected.has(s.id));
    if (chosen.length === 0) { toast.warning('Nothing selected', 'Select at least one scenario to run.'); return; }
    const chosenIds = new Set(chosen.map((c) => c.id));
    const chosenSpecs = specs.filter((s) => chosenIds.has(s.testCaseId));
    const chosenCases = chosen.map((c) => c.raw);
    const primary = runEndpoints[0];
    const api = primary ? { mode: 'api' as const, apiSpec: specFrom(primary, 'standard', !!runEnv) } : undefined;
    const target = baseUrl ? { targetUrl: baseUrl } : undefined;

    setRunError('');
    setStages((prev) => prev.map((st) => st.key === 'scenarios' ? st : { ...st, status: 'pending', detail: 'Not started', startedAt: undefined, durationMs: undefined }));
    setReport(null);
    setPushState({ status: 'idle' });

    /* ── Automate ── */
    setPhase('automating');
    setStage('automate', 'running', 'Rendering request specs…');
    log('automate', `Rendering ${chosenSpecs.length} Playwright request specs`);
    if (chosenSpecs.length === 0) {
      const msg = 'No runnable specs were produced for the selected scenarios.';
      setStage('automate', 'failed', msg); log('automate', msg, 'error'); setRunError(msg); setPhase('failed');
      return;
    }
    let runId = testRunId;
    try {
      const saved = await saveTestCases({ username: user?.username || 'admin', storyTitle: runLabel, source: 'api', columns: API_COLUMNS, testCases: chosenCases });
      if (myRun !== runIdRef.current) return;
      runId = saved?.testRunId || '';
      setTestRunId(runId);
      log('automate', `Saved as test run ${runId || '(unnamed)'}`, 'ok');
    } catch (err: any) {
      log('automate', `Could not save the run: ${err?.response?.data?.error || err?.message}. Execution continues, but this run will not appear on the Reports page.`, 'warn');
    }
    if (myRun !== runIdRef.current) return;
    setStage('automate', 'done', `${chosenSpecs.length} specs ready`);

    /* ── Execute ── */
    setPhase('executing');
    setStage('execute', 'running', `Running ${chosenSpecs.length} specs…`);
    log('execute', `Executing ${chosenSpecs.length} specs against ${baseUrl || 'the endpoints'}`);
    setRows(chosen.map((c) => ({ testCaseId: c.id, name: c.title, status: 'running', duration: '' })));
    const execStart = Date.now();
    let exec: any = null;
    try {
      exec = await executePipeline(chosenCases, chosenSpecs, serviceObjects, undefined, runId || undefined, target, api);
    } catch (err: any) {
      if (myRun !== runIdRef.current) return;
      const msg = err?.response?.data?.error || err?.message || 'Execution failed.';
      setStage('execute', 'failed', msg); log('execute', msg, 'error'); setRunError(msg);
      setRows((prev) => prev.map((r) => ({ ...r, status: 'not_run', error: msg })));
      setPhase('failed'); toast.error('Execution failed', msg);
      return;
    }
    if (myRun !== runIdRef.current) return;
    let execMs = Date.now() - execStart;

    if (exec?.summary?.executed === false) {
      const reason = exec.summary.reason || 'The endpoint could not be reached.';
      setRows(chosen.map((c) => ({ testCaseId: c.id, name: c.title, status: 'not_run', duration: '', error: reason })));
      setStage('execute', 'skipped', reason); setStage('heal', 'skipped', 'Nothing ran to heal');
      log('execute', reason, 'warn');
      finishReport(chosen.length, 0, 0, chosen.length, 0, execMs, exec?.reportUrl);
      return;
    }

    let details: any[] = Array.isArray(exec?.executionDetails) ? exec.executionDetails : [];
    let current = mapRows(chosen, details, exec?.failureReason);
    setRows(current);
    let passed = current.filter((r) => r.status === 'passed').length;
    let failed = current.filter((r) => r.status === 'failed').length;
    let notRun = current.filter((r) => r.status === 'not_run').length;
    setStage('execute', 'done', `${passed} passed · ${failed} failed${notRun ? ` · ${notRun} not run` : ''}`);
    log('execute', `${passed} passed, ${failed} failed${notRun ? `, ${notRun} not run` : ''}`, failed > 0 ? 'warn' : 'ok');

    /* ── Heal ── */
    let healedCount = 0;
    if (failed === 0) {
      setStage('heal', 'skipped', 'Not needed — nothing failed');
      log('heal', 'Skipped — no failures to diagnose');
    } else {
      setPhase('healing');
      setStage('heal', 'running', `Diagnosing ${failed} failure${failed > 1 ? 's' : ''}…`);
      log('heal', `Replaying ${failed} failing request${failed > 1 ? 's' : ''} against the live endpoint to diagnose them`);
      const healStart = Date.now();
      try {
        const healed = await healPipeline(chosenCases, chosenSpecs, details, serviceObjects, undefined, runId || undefined, target, api);
        if (myRun !== runIdRef.current) return;
        const healLog: any[] = Array.isArray(healed?.healingLog) ? healed.healingLog : [];
        const noteById = new Map(healLog.map((h) => [h.testCaseId, h]));
        const fixedIds = new Set(healLog.filter((h) => h.result === 'fixed').map((h) => h.testCaseId));
        healedCount = fixedIds.size;
        if (Array.isArray(healed?.pageObjects) && healed.pageObjects.length) setServiceObjects(healed.pageObjects as ServiceObject[]);
        if (Array.isArray(healed?.scripts) && healed.scripts.length) {
          const healedByCase = new Map(healed.scripts.map((s: any) => [s.testCaseId, s]));
          setSpecs((prev) => prev.map((p) => { const h: any = healedByCase.get(p.testCaseId); return h?.code ? { ...p, code: h.code } : p; }));
        }
        details = Array.isArray(healed?.executionDetails) ? healed.executionDetails : details;
        current = mapRows(chosen, details, null).map((r) => { const note = noteById.get(r.testCaseId); return note ? { ...r, healed: note.result === 'fixed', healNote: note.fix } : r; });
        setRows(current);
        passed = current.filter((r) => r.status === 'passed').length;
        failed = current.filter((r) => r.status === 'failed').length;
        notRun = current.filter((r) => r.status === 'not_run').length;
        execMs += Date.now() - healStart;
        setStage('heal', 'done', healedCount > 0 ? `${healedCount} spec${healedCount > 1 ? 's' : ''} repaired · ${failed} still failing` : `Nothing repaired — ${failed} genuine failure${failed > 1 ? 's' : ''}`);
        for (const h of healLog) log('heal', `${h.testCaseId}: ${h.fix}`, h.result === 'fixed' ? 'ok' : 'warn');
        if (healed?.reportUrl) exec = { ...exec, reportUrl: healed.reportUrl };
      } catch (err: any) {
        if (myRun !== runIdRef.current) return;
        const msg = err?.response?.data?.error || err?.message || 'Healing failed.';
        setStage('heal', 'failed', msg); log('heal', msg, 'error');
      }
    }
    finishReport(chosen.length, passed, failed, notRun, healedCount, execMs, exec?.reportUrl);
  }, [scenarios, selected, specs, serviceObjects, runEndpoints, baseUrl, testRunId, runLabel, user, log, setStage, toast]); // eslint-disable-line react-hooks/exhaustive-deps

  /* ── Export ── */
  const handleExport = useCallback(async (format: 'excel' | 'json') => {
    if (!testRunId) return;
    setExporting(true);
    try {
      const response = await exportTestCases(testRunId, format);
      const disposition = response.headers['content-disposition'] || '';
      const filename = /filename="?([^"]+)"?/.exec(disposition)?.[1] || `api-scenarios.${format === 'excel' ? 'csv' : 'json'}`;
      const href = window.URL.createObjectURL(new Blob([response.data]));
      const link = document.createElement('a');
      link.href = href; link.download = filename;
      document.body.appendChild(link); link.click(); link.remove();
      window.URL.revokeObjectURL(href);
      toast.success('Exported', filename);
    } catch (err) { toast.fromError(err); }
    finally { setExporting(false); }
  }, [testRunId, toast]);

  /* ── Push to the connected repository ── */
  const handlePushToRepo = useCallback(async () => {
    if (pushState.status === 'pushing') return;
    const chosen = scenarios.filter((s) => selected.has(s.id));
    const chosenIds = new Set(chosen.map((c) => c.id));
    const toPush = specs.filter((s) => chosenIds.has(s.testCaseId));
    if (toPush.length === 0) { setPushState({ status: 'error', error: 'There are no generated specs to push.' }); return; }
    setPushState({ status: 'pushing' });
    log('report', `Pushing ${toPush.length} spec${toPush.length === 1 ? '' : 's'} to the connected repository`);
    try {
      const configs = await getConfigurations();
      const repo = (configs?.configs || []).find((c: any) => ['github', 'gitlab', 'bitbucket'].includes(c.integrationId) && c.status === 'connected');
      if (!repo) {
        const msg = 'No code repository is connected. Connect one under System Configuration → Code Repositories, then push again.';
        setPushState({ status: 'error', error: msg }); log('report', msg, 'warn');
        return;
      }
      const result = await publishToGit({
        scripts: toPush.map((s) => ({ fileName: s.fileName, code: s.code, path: s.path })),
        pageObjects: serviceObjects.map((o) => ({ path: o.path, code: o.code })),
        testCases: chosen.map((c) => c.raw),
        integrationId: repo.integrationId,
        testRunId: testRunId || undefined,
        title: `API tests — ${runLabel}`,
        description: `${report?.passed ?? 0} of ${report?.total ?? toPush.length} scenarios passed.`,
        commitMessage: `Add API tests for ${runLabel}`,
      });
      let host = '';
      try { host = new URL(result.prUrl).pathname.split('/').filter(Boolean).slice(0, 2).join('/'); } catch { /* blank */ }
      setPushState({ status: 'done', url: result.prUrl, branch: result.branch, mode: result.mode, fileCount: result.fileCount, repo: host });
      log('report', `${result.mode === 'pr' ? 'Pull request opened' : 'Committed'} on ${result.branch} (${result.fileCount} files)`, 'ok');
      toast.success(result.mode === 'pr' ? 'Pull request opened' : 'Pushed to repository', result.branch);
    } catch (err: any) {
      const msg = err?.response?.data?.error || err?.message || 'The push failed.';
      setPushState({ status: 'error', error: msg }); log('report', `Push failed: ${msg}`, 'error'); toast.error('Push failed', msg);
    }
  }, [pushState.status, scenarios, selected, specs, serviceObjects, testRunId, runLabel, report, log, toast]);

  /* ── Reset ── */
  const resetRun = useCallback(() => {
    runIdRef.current++;
    setPhase('idle');
    setStages(INITIAL_STAGES);
    setScenarios([]); setSpecs([]); setServiceObjects([]); setRows([]); setReport(null);
    setSelected(new Set()); setTestRunId('');
    setRunError(''); setLogs([]);
    setPushState({ status: 'idle' });
    setRunEndpoints([]); setRunLabel('');
    setRunEnvName(''); setRunEnvKey(''); setRunEnv(null); setRunCases([]); setReresolving(false);
  }, []);

  const toggleScenario = useCallback((id: string) => setSelected((prev) => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n; }), []);
  const selectScenarios = useCallback((ids: string[]) => setSelected((prev) => new Set([...prev, ...ids])), []);
  const clearScenarios = useCallback(() => setSelected(new Set()), []);

  return {
    phase, stages, scenarios, specs, serviceObjects, selected, rows, report, testRunId, runError, exporting, pushState,
    runEndpoints, runLabel, runEnvName, runEnvKey, runCases, reresolving, logs, running, started, finished, baseUrl,
    runScenarios, runSuite, reresolve, resetRun, handleExport, handlePushToRepo,
    toggleScenario, selectScenarios, clearScenarios, setRunError, log,
    elapsedMs: () => (startedAtRef.current ? Date.now() - startedAtRef.current : 0),
  };
}

export type ApiRun = ReturnType<typeof useApiRun>;
