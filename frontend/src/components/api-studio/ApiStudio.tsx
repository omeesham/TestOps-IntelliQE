/**
 * API Studio — the API Automation workspace.
 *
 * One endpoint in, a validated suite out. The run is linear and always visible:
 *
 *   Scenarios → Automate → Execute → Heal → Report
 *
 * with a single deliberate stop, the scenario review gate. Design is the stage
 * a human should actually steer — what gets tested and what gets skipped is a
 * judgement call — while everything after it (rendering specs, running them,
 * repairing what broke, publishing the report) runs straight through.
 *
 * Layout: request on the left (the run's ground truth, locked once it starts),
 * the artifacts in the middle as tabs, and the activity log on the right so a
 * long stage is never a spinner with nothing behind it.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Play, RotateCcw, Loader2, ArrowRight, X, AlertTriangle,
  ListChecks, BarChart3, Plug, ChevronLeft, ChevronRight, Activity,
} from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/components/feedback/ToastProvider';
import {
  generateTests, executePipeline, healPipeline, saveTestCases, exportTestCases,
  parseApiSpecFromFile, publishToGit, getConfigurations,
  type ParsedApiEndpoint, type ApiSpecPayload,
} from '@/services/api';
import RequestPanel from './RequestPanel';
import ScenariosTab from './ScenariosTab';
import ReportTab from './ReportTab';
import StageRail from './StageRail';
import EndpointPicker from './EndpointPicker';
import { EmptyState, RequiredMark } from './primitives';
import { clock, formatDuration, parseQueryParams, buildUrlWithParams } from './format';
import type {
  Phase, Stage, StageKey, StageStatus, Scenario, Spec, RunRow, LogLine, LogLevel,
  HeaderPair, AuthType, RunReport, PushState, ServiceObject, QueryParamRow,
} from './types';

/* ── The standard palette ──
   The studio shares the app's violet-indigo scheme rather than carrying one of
   its own; these are the same values Chat, Reports and Bug Tracker use. */
const BRAND_BUTTON =
  'bg-gradient-to-b from-[#8B5CF6] to-[#6366F1] hover:from-[#7C3AED] hover:to-[#4F46E5]';

/* ── Depth tokens ──
   The studio borrows the raised, tactile surfaces of Postman and Bruno while
   staying in the app's violet-indigo palette. Depth is drawn with layered,
   violet-tinted shadows so the request bar and panels read as floating above the
   workspace, and the primary action presses like a physical key. Purely
   presentational — no run logic depends on any of these classes. */
const BAR_3D =
  'shadow-[0_1px_2px_rgba(15,23,42,0.05),0_6px_16px_-8px_rgba(76,29,149,0.28)]';
/** The Send / Run key: a hard bottom edge for the raised face, a soft violet
    ambient glow, a lift on hover and a real press-down on click. */
const BUTTON_3D =
  'shadow-[0_3px_0_0_#4338CA,0_8px_18px_-6px_rgba(99,102,241,0.55)] ' +
  'hover:-translate-y-px hover:shadow-[0_4px_0_0_#4338CA,0_12px_24px_-6px_rgba(99,102,241,0.6)] ' +
  'active:translate-y-[3px] active:shadow-[0_0_0_0_#4338CA,0_4px_10px_-6px_rgba(99,102,241,0.5)] ' +
  'disabled:translate-y-0 disabled:shadow-[0_2px_0_0_#c7d2fe] ' +
  'ring-1 ring-inset ring-white/25';

const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];

const API_SPEC_FORMATS = [
  { id: 'auto', label: 'Auto-detect' },
  { id: 'openapi', label: 'Swagger' },
  { id: 'postman', label: 'Postman' },
  { id: 'bruno', label: 'Bruno' },
  { id: 'json', label: 'JSON' },
  { id: 'xml', label: 'XML / WSDL' },
  { id: 'excel', label: 'Excel' },
  { id: 'pdf', label: 'PDF' },
  { id: 'docx', label: 'Word' },
];

/** The API test-case columns saved with the run (drives export + Reports page). */
const API_COLUMNS = [
  'tcNumber', 'module', 'endpoint', 'method', 'scenario', 'type', 'priority',
  'precondition', 'requestHeaders', 'queryParams', 'requestBody', 'expectedStatus', 'expected',
];

const INITIAL_STAGES: Stage[] = [
  { key: 'scenarios', label: 'Scenarios', hint: 'Design every scenario that validates this endpoint', status: 'pending', detail: 'Not started' },
  { key: 'automate', label: 'Automate', hint: 'Render each scenario into a runnable request spec', status: 'pending', detail: 'Not started' },
  { key: 'execute', label: 'Execute', hint: 'Run the suite against the live endpoint', status: 'pending', detail: 'Not started' },
  { key: 'heal', label: 'Heal', hint: 'Diagnose failures and repair what the test got wrong', status: 'pending', detail: 'Not started' },
  { key: 'report', label: 'Report', hint: 'Publish the result', status: 'pending', detail: 'Not started' },
];

/**
 * The studio shows the two artifacts a reviewer acts on: the scenarios it
 * designed and the report it produced. The rendered specs and the raw run table
 * are intermediate — they are still generated, executed, healed and pushed to
 * the repo, they just aren't tabs. Failures and heal notes surface in the
 * report; live progress is the stage rail and the activity log.
 */
type TabId = 'scenarios' | 'report';

const TABS: { id: TabId; label: string; icon: React.ElementType }[] = [
  { id: 'scenarios', label: 'Scenarios', icon: ListChecks },
  { id: 'report', label: 'Report', icon: BarChart3 },
];

/**
 * Scenario breadth. The picker is gone from the request panel — a regression
 * suite is what the studio is for, and the other two settings mostly produced
 * suites that were too thin or too slow to be worth reviewing.
 */
const COVERAGE = 'standard';

export interface ApiStudioProps {
  /** Return to the automation-type picker. */
  onExit?: () => void;
}

export default function ApiStudio({ onExit }: ApiStudioProps) {
  const { user } = useAuth();
  const toast = useToast();

  /* ── Request state — the ground truth for every stage ── */
  const [method, setMethod] = useState('GET');
  const [url, setUrl] = useState('');
  /** Structured view over the URL's query string — see QueryParamRow. */
  const [queryParams, setQueryParams] = useState<QueryParamRow[]>([]);
  const [headers, setHeaders] = useState<HeaderPair[]>([{ key: '', value: '' }]);
  const [authType, setAuthType] = useState<AuthType>('none');
  const [authValue, setAuthValue] = useState('');
  const [body, setBody] = useState('');
  const [expectedStatus, setExpectedStatus] = useState('200');
  const [expectedBody, setExpectedBody] = useState('');
  /** Set when a run was attempted with required fields empty — marks them in the panel. */
  const [showRequired, setShowRequired] = useState(false);

  /* ── Spec import ── */
  const [specParsing, setSpecParsing] = useState(false);
  // Three distinct outcomes, kept apart because they call for different
  // reactions: the import failed, the import lost something, or the import
  // worked and this is what it covered.
  const [specError, setSpecError] = useState('');
  const [specWarning, setSpecWarning] = useState('');
  const [specNotice, setSpecNotice] = useState('');
  const [endpointChoices, setEndpointChoices] = useState<ParsedApiEndpoint[]>([]);
  const [pickerOpen, setPickerOpen] = useState(false);

  /* ── Run state ── */
  const [phase, setPhase] = useState<Phase>('idle');
  const [stages, setStages] = useState<Stage[]>(INITIAL_STAGES);
  const [scenarios, setScenarios] = useState<Scenario[]>([]);
  const [specs, setSpecs] = useState<Spec[]>([]);
  /** The service objects the specs drive — see ServiceObject. */
  const [serviceObjects, setServiceObjects] = useState<ServiceObject[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [rows, setRows] = useState<RunRow[]>([]);
  const [report, setReport] = useState<RunReport | null>(null);
  const [testRunId, setTestRunId] = useState('');
  const [runError, setRunError] = useState('');
  const [exporting, setExporting] = useState(false);
  const [pushState, setPushState] = useState<PushState>({ status: 'idle' });

  const [tab, setTab] = useState<TabId>('scenarios');
  const [logs, setLogs] = useState<LogLine[]>([]);
  // The activity rail is the first thing to give up space: the app's own
  // sidebar already takes ~256px, so on a 1366-wide laptop keeping all three
  // panes open would leave the scenario table too narrow to read.
  const [activityOpen, setActivityOpen] = useState(() =>
    typeof window === 'undefined' || window.innerWidth >= 1500);
  const logIdRef = useRef(0);
  const logEndRef = useRef<HTMLDivElement | null>(null);

  /** Bumped on reset so a still-in-flight stage from a discarded run is dropped. */
  const runIdRef = useRef(0);

  /* ── Activity log ── */
  const log = useCallback((stage: StageKey | 'run', text: string, level: LogLevel = 'info') => {
    setLogs((prev) => [...prev, { id: ++logIdRef.current, at: Date.now(), stage, level, text }].slice(-400));
  }, []);

  useEffect(() => { logEndRef.current?.scrollIntoView({ block: 'end' }); }, [logs]);

  /* ── Stage transitions ── */
  const setStage = useCallback((key: StageKey, status: StageStatus, detail: string) => {
    setStages((prev) => prev.map((s) => {
      if (s.key !== key) return s;
      if (status === 'running') return { ...s, status, detail, startedAt: Date.now(), durationMs: undefined };
      const durationMs = s.startedAt ? Date.now() - s.startedAt : s.durationMs;
      return { ...s, status, detail, durationMs };
    }));
  }, []);

  /* ── Derived ── */
  const baseUrl = useMemo(() => {
    try { return new URL(url.trim()).origin; } catch { return ''; }
  }, [url]);

  const endpointLabel = url.trim() ? `${method} ${url.trim()}` : 'No endpoint set';
  const running = ['generating', 'automating', 'executing', 'healing'].includes(phase);
  const started = phase !== 'idle';
  /** A run that has settled but still has scenarios to run again. */
  const finished = (phase === 'report' || phase === 'failed') && scenarios.length > 0;
  /**
   * The fields a run genuinely cannot start without, named exactly as the
   * request panel labels them so the error points somewhere findable. The run
   * button stays enabled when they are empty: a disabled button with no
   * explanation is the reason people sat on this screen not knowing why
   * nothing happened.
   */
  const missingRequired = useMemo(() => {
    const missing: string[] = [];
    if (!url.trim()) missing.push('Endpoint URL');
    if (!expectedStatus.trim()) missing.push('Expected response → Status code');
    if (!expectedBody.trim()) missing.push('Expected response → Response body');
    return missing;
  }, [url, expectedStatus, expectedBody]);

  // A "this field is required" banner that the user has since satisfied is just
  // wrong text on screen — retract it as soon as the last blank is filled,
  // rather than making them attempt the run again to find out.
  useEffect(() => {
    if (showRequired && missingRequired.length === 0) {
      setShowRequired(false);
      setRunError('');
    }
  }, [showRequired, missingRequired]);

  const apiSpecPayload = useCallback((): ApiSpecPayload => ({
    method,
    url: url.trim(),
    headers: headers.filter((h) => h.key.trim()),
    auth: { type: authType, value: authType !== 'none' ? authValue : undefined },
    body: ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method) && body.trim() ? body : undefined,
    expectedStatus: Number(expectedStatus),
    expectedResponse: expectedBody.trim(),
    coverage: COVERAGE,
  }), [method, url, headers, authType, authValue, body, expectedStatus, expectedBody]);

  /* ── Query params ⇄ URL ──
     The URL bar is canonical; these keep the Params table and the URL in lockstep
     so an edit in either place shows up in the other. Typing in the URL reparses
     the table; editing the table rewrites the URL's query string in place. */
  const handleUrlChange = useCallback((raw: string) => {
    setUrl(raw);
    setQueryParams(parseQueryParams(raw));
  }, []);

  const applyQueryParams = useCallback((next: QueryParamRow[]) => {
    setQueryParams(next);
    setUrl((prev) => buildUrlWithParams(prev, next));
  }, []);

  /* ═══════════════════════════════════════════════════════════════
     Spec import
     ═══════════════════════════════════════════════════════════════ */
  const fillFromEndpoint = (ep: ParsedApiEndpoint) => {
    setMethod((ep.method || 'GET').toUpperCase());
    setUrl(ep.url || '');
    setQueryParams(parseQueryParams(ep.url || ''));
    setHeaders(ep.headers?.length ? ep.headers : [{ key: '', value: '' }]);
    setAuthType((ep.auth?.type || 'none') as AuthType);
    setAuthValue(ep.auth?.value || '');
    setBody(ep.body || '');
    if (ep.expectedStatus) setExpectedStatus(String(ep.expectedStatus));
    setExpectedBody(ep.expectedResponse || '');
  };

  const handleSpecFile = async (file: File, format: string) => {
    setSpecError(''); setSpecWarning(''); setSpecNotice('');
    setEndpointChoices([]);
    setSpecParsing(true);
    try {
      const { endpoints, count, warning, notice } = await parseApiSpecFromFile(file, format);
      if (!endpoints?.length) throw new Error('No API endpoints were found in that file.');
      setEndpointChoices(endpoints);
      if (endpoints.length === 1) {
        fillFromEndpoint(endpoints[0]);
        toast.success('Endpoint imported', `${endpoints[0].method} ${endpoints[0].url}`);
      } else {
        setPickerOpen(true);
        toast.success(`${count} endpoints found`, `In ${file.name}`);
      }
      // A caution and a scope note are different things, so they land in
      // different places — neither of them in the error slot.
      if (warning) setSpecWarning(warning);
      if (notice) setSpecNotice(notice);
    } catch (err: any) {
      setSpecError(err?.response?.data?.error || err?.message || 'Could not read that file.');
    } finally {
      setSpecParsing(false);
    }
  };

  const discardSpec = () => {
    setEndpointChoices([]);
    setPickerOpen(false);
    setSpecError(''); setSpecWarning(''); setSpecNotice('');
    setMethod('GET');
    setUrl('');
    setQueryParams([]);
    setHeaders([{ key: '', value: '' }]);
    setAuthType('none');
    setAuthValue('');
    setBody('');
    setExpectedStatus('200');
    setExpectedBody('');
  };

  /* ═══════════════════════════════════════════════════════════════
     Stage 1 — design the scenarios (stops at the review gate)
     ═══════════════════════════════════════════════════════════════ */
  const runScenarios = async () => {
    // Mandatory fields first, all of them at once — telling someone about one
    // missing field only for the next attempt to stop on the next is worse than
    // saying nothing.
    if (missingRequired.length > 0) {
      setShowRequired(true);
      const list = missingRequired.length === 1
        ? missingRequired[0]
        : `${missingRequired.slice(0, -1).join(', ')} and ${missingRequired[missingRequired.length - 1]}`;
      const msg = missingRequired.length === 1
        ? `${list} is required — fill it in before automating this endpoint.`
        : `${list} are required — fill them in before automating this endpoint.`;
      setRunError(msg);
      toast.error(
        missingRequired.length === 1 ? 'A required field is missing' : `${missingRequired.length} required fields are missing`,
        list,
      );
      return;
    }
    setShowRequired(false);

    const trimmed = url.trim();
    let origin = '';
    try {
      const u = new URL(trimmed);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('protocol');
      origin = u.origin;
    } catch {
      setRunError('Enter a full absolute URL, for example https://api.mycompany.com/v1/users.');
      toast.error('Invalid URL', 'Enter a full absolute URL including https://');
      return;
    }

    const myRun = ++runIdRef.current;
    setRunError('');
    setStages(INITIAL_STAGES);
    setScenarios([]); setSpecs([]); setServiceObjects([]); setRows([]); setReport(null);
    setSelected(new Set()); setTestRunId('');
    setLogs([]);
    setPhase('generating');
    setTab('scenarios');

    log('run', `Target ${method} ${trimmed}`);
    if (/(^|\.)(example\.(com|net|org)|example|invalid|test)$/i.test(new URL(trimmed).hostname)) {
      log('run', 'This host is reserved for documentation and never resolves — scenarios can be designed and exported, but execution will fail to reach it.', 'warn');
    }
    setStage('scenarios', 'running', 'Designing coverage…');
    log('scenarios', 'Designing coverage for this endpoint');

    try {
      const res = await generateTests('API Testing', 'API Automation', { apiSpec: apiSpecPayload() });
      if (myRun !== runIdRef.current) return; // superseded by a reset

      const cases: any[] = Array.isArray(res?.testCases) ? res.testCases : [];
      if (cases.length === 0) throw new Error('The generator returned no scenarios for this endpoint.');

      const mapped: Scenario[] = cases.map((tc, i) => ({
        id: tc.id || `TC-${String(i + 1).padStart(3, '0')}`,
        title: tc.title || tc.scenario || 'Scenario',
        description: tc.description || '',
        feature: tc.feature || '',
        type: tc.type || 'api',
        priority: tc.priority || 'P1',
        severity: tc.severity || '',
        tags: Array.isArray(tc.tags) ? tc.tags : [],
        steps: Array.isArray(tc.steps) ? tc.steps : [],
        expectedResult: tc.expectedResult || '',
        precondition: tc.precondition || '',
        api: tc.api,
        raw: tc,
      }));
      const mappedSpecs: Spec[] = (res?.automationScripts || []).map((s: any) => ({
        testCaseId: s.testCaseId,
        fileName: s.fileName || `${s.testCaseId}.spec.ts`,
        code: s.code || '',
        path: s.path,
      }));

      setScenarios(mapped);
      setSpecs(mappedSpecs);
      // Without these the specs cannot resolve their imports at run time.
      setServiceObjects(Array.isArray(res?.pageObjects) ? res.pageObjects : []);
      setSelected(new Set(mapped.map((m) => m.id)));

      const byCategory = mapped.reduce<Record<string, number>>((acc, m) => {
        acc[m.type] = (acc[m.type] || 0) + 1;
        return acc;
      }, {});
      const breakdown = Object.entries(byCategory).map(([k, v]) => `${v} ${k}`).join(', ');

      setStage('scenarios', 'done', `${mapped.length} scenarios — ${breakdown}`);
      log('scenarios', `Designed ${mapped.length} scenarios (${breakdown})`, 'ok');
      log('run', 'Review the scenarios, then continue to run the suite.', 'info');
      setPhase('review');
      // The origin is what execution targets — surface it once, here.
      log('run', `Execution target ${origin}`);
    } catch (err: any) {
      if (myRun !== runIdRef.current) return;
      const msg = err?.response?.data?.error || err?.message || 'Scenario design failed.';
      setStage('scenarios', 'failed', msg);
      log('scenarios', msg, 'error');
      setRunError(msg);
      setPhase('failed');
      toast.error('Scenario design failed', msg);
    }
  };

  /* ═══════════════════════════════════════════════════════════════
     Stages 2-5 — automate, execute, heal, report (one continuous pass)
     ═══════════════════════════════════════════════════════════════ */
  const runSuite = async () => {
    const myRun = runIdRef.current;
    const chosen = scenarios.filter((s) => selected.has(s.id));
    if (chosen.length === 0) {
      toast.warning('Nothing selected', 'Select at least one scenario to run.');
      return;
    }
    const chosenIds = new Set(chosen.map((c) => c.id));
    const chosenSpecs = specs.filter((s) => chosenIds.has(s.testCaseId));
    const chosenCases = chosen.map((c) => c.raw);
    const api = { mode: 'api' as const, apiSpec: apiSpecPayload() };
    const target = baseUrl ? { targetUrl: baseUrl } : undefined;

    setRunError('');
    // Clear anything a previous run of these same scenarios left behind.
    setStages((prev) => prev.map((st) =>
      st.key === 'scenarios' ? st : { ...st, status: 'pending', detail: 'Not started', startedAt: undefined, durationMs: undefined }));
    setReport(null);
    setPushState({ status: 'idle' });

    /* ── Automate ── */
    setPhase('automating');
    setStage('automate', 'running', 'Rendering request specs…');
    log('automate', `Rendering ${chosenSpecs.length} Playwright request specs`);

    if (chosenSpecs.length === 0) {
      const msg = 'No runnable specs were produced for the selected scenarios.';
      setStage('automate', 'failed', msg);
      log('automate', msg, 'error');
      setRunError(msg);
      setPhase('failed');
      return;
    }

    // Persist the run so it gets a real id — that id is what the Allure report
    // is built under and what makes the run show up on the Reports page.
    let runId = testRunId;
    try {
      const saved = await saveTestCases({
        username: user?.username || 'admin',
        storyTitle: endpointLabel,
        source: 'api',
        columns: API_COLUMNS,
        testCases: chosenCases,
      });
      if (myRun !== runIdRef.current) return;
      runId = saved?.testRunId || '';
      setTestRunId(runId);
      log('automate', `Saved as test run ${runId || '(unnamed)'}`, 'ok');
    } catch (err: any) {
      // A failed save costs the Reports-page entry, not the run — say so and continue.
      log('automate', `Could not save the run: ${err?.response?.data?.error || err?.message}. Execution continues, but this run will not appear on the Reports page.`, 'warn');
    }
    if (myRun !== runIdRef.current) return;

    setStage('automate', 'done', `${chosenSpecs.length} specs ready`);

    /* ── Execute ── */
    setPhase('executing');
    setStage('execute', 'running', `Running ${chosenSpecs.length} specs…`);
    log('execute', `Executing ${chosenSpecs.length} specs against ${baseUrl || 'the endpoint'}`);
    setRows(chosen.map((c) => ({
      testCaseId: c.id,
      name: c.title,
      status: 'running',
      duration: '',
    })));

    const execStart = Date.now();
    let exec: any = null;
    try {
      exec = await executePipeline(chosenCases, chosenSpecs, serviceObjects, undefined, runId || undefined, target, api);
    } catch (err: any) {
      if (myRun !== runIdRef.current) return;
      const msg = err?.response?.data?.error || err?.message || 'Execution failed.';
      setStage('execute', 'failed', msg);
      log('execute', msg, 'error');
      setRunError(msg);
      setRows((prev) => prev.map((r) => ({ ...r, status: 'not_run', error: msg })));
      setPhase('failed');
      toast.error('Execution failed', msg);
      return;
    }
    if (myRun !== runIdRef.current) return;
    let execMs = Date.now() - execStart;

    // The backend ran nothing (no reachable target) — that is not "all failed".
    if (exec?.summary?.executed === false) {
      const reason = exec.summary.reason || 'The endpoint could not be reached.';
      setRows(chosen.map((c) => ({ testCaseId: c.id, name: c.title, status: 'not_run', duration: '', error: reason })));
      setStage('execute', 'skipped', reason);
      setStage('heal', 'skipped', 'Nothing ran to heal');
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
        const healed = await healPipeline(
          chosenCases, chosenSpecs, details, serviceObjects, undefined, runId || undefined, target, api,
        );
        if (myRun !== runIdRef.current) return;

        const healLog: any[] = Array.isArray(healed?.healingLog) ? healed.healingLog : [];
        const noteById = new Map(healLog.map((h) => [h.testCaseId, h]));
        const fixedIds = new Set(healLog.filter((h) => h.result === 'fixed').map((h) => h.testCaseId));
        healedCount = fixedIds.size;

        // A heal can rewrite a service object as well as a spec; keeping the
        // stale copy would desync the next re-run from the code that just passed.
        if (Array.isArray(healed?.pageObjects) && healed.pageObjects.length) {
          setServiceObjects(healed.pageObjects as ServiceObject[]);
        }
        if (Array.isArray(healed?.scripts) && healed.scripts.length) {
          const healedByCase = new Map(healed.scripts.map((s: any) => [s.testCaseId, s]));
          setSpecs((prev) => prev.map((p) => {
            const h: any = healedByCase.get(p.testCaseId);
            return h?.code ? { ...p, code: h.code } : p;
          }));
        }

        details = Array.isArray(healed?.executionDetails) ? healed.executionDetails : details;
        current = mapRows(chosen, details, null).map((r) => {
          const note = noteById.get(r.testCaseId);
          return note ? { ...r, healed: note.result === 'fixed', healNote: note.fix } : r;
        });
        setRows(current);

        passed = current.filter((r) => r.status === 'passed').length;
        failed = current.filter((r) => r.status === 'failed').length;
        notRun = current.filter((r) => r.status === 'not_run').length;
        execMs += Date.now() - healStart;

        // A heal that repaired nothing is a real outcome, not a failure — the
        // notes say why (an API defect is not the test's fault).
        setStage('heal', 'done', healedCount > 0
          ? `${healedCount} spec${healedCount > 1 ? 's' : ''} repaired · ${failed} still failing`
          : `Nothing repaired — ${failed} genuine failure${failed > 1 ? 's' : ''}`);
        for (const h of healLog) {
          log('heal', `${h.testCaseId}: ${h.fix}`, h.result === 'fixed' ? 'ok' : 'warn');
        }
        if (healed?.reportUrl) exec = { ...exec, reportUrl: healed.reportUrl };
      } catch (err: any) {
        if (myRun !== runIdRef.current) return;
        const msg = err?.response?.data?.error || err?.message || 'Healing failed.';
        setStage('heal', 'failed', msg);
        log('heal', msg, 'error');
      }
    }

    finishReport(chosen.length, passed, failed, notRun, healedCount, execMs, exec?.reportUrl);
  };

  /** Assemble the report from the real counts and finish the run. */
  const finishReport = (
    total: number, passed: number, failed: number, notRun: number,
    healed: number, durationMs: number, reportUrl?: string,
  ) => {
    setStage('report', 'running', 'Assembling…');
    const passRate = total > 0 ? Math.round((passed / total) * 100) : 0;
    setReport({ total, passed, failed, notRun, healed, passRate, durationMs, reportUrl });
    setStage('report', 'done', `${passRate}% pass rate`);
    log('report', `Report ready — ${passed}/${total} passed (${passRate}%) in ${formatDuration(durationMs)}`, failed > 0 ? 'warn' : 'ok');
    setPhase('report');
    setTab('report');
    if (failed > 0 || notRun > 0) toast.warning('Run complete', `${passed}/${total} passed`);
    else toast.success('Run complete', `All ${total} scenarios passed`);
  };

  /** Map backend execution details onto the selected scenarios — honestly. */
  const mapRows = (chosen: Scenario[], details: any[], fallbackError: string | null | undefined): RunRow[] => {
    const byId = new Map(details.map((d) => [d.testCaseId, d]));
    return chosen.map((c) => {
      const d = byId.get(c.id);
      if (!d) {
        return {
          testCaseId: c.id, name: c.title, status: 'not_run' as const, duration: '',
          error: fallbackError || 'The runner returned no result for this scenario.',
        };
      }
      const duration = typeof d.durationMs === 'number' ? `${(d.durationMs / 1000).toFixed(2)}s` : '';
      if (d.status === 'passed') return { testCaseId: c.id, name: c.title, status: 'passed' as const, duration };
      if (d.status === 'failed') {
        return { testCaseId: c.id, name: c.title, status: 'failed' as const, duration, error: d.error || 'Test failed (no message returned).' };
      }
      return { testCaseId: c.id, name: c.title, status: 'not_run' as const, duration, error: d.error };
    });
  };

  /* ── Export ── */
  const handleExport = async (format: 'excel' | 'json') => {
    if (!testRunId) return;
    setExporting(true);
    try {
      const response = await exportTestCases(testRunId, format);
      const disposition = response.headers['content-disposition'] || '';
      const filename = /filename="?([^"]+)"?/.exec(disposition)?.[1] || `api-scenarios.${format === 'excel' ? 'csv' : 'json'}`;
      const href = window.URL.createObjectURL(new Blob([response.data]));
      const link = document.createElement('a');
      link.href = href;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.URL.revokeObjectURL(href);
      toast.success('Exported', filename);
    } catch (err) {
      toast.fromError(err);
    } finally {
      setExporting(false);
    }
  };

  /* ── Push the generated specs to the connected code repository ──
     Resolves the repo server-side from the tenant's Code Repositories
     integration, exactly as the chat flow's publish does — the studio never
     asks for a repo URL or a token. */
  const handlePushToRepo = async () => {
    if (pushState.status === 'pushing') return;
    const chosen = scenarios.filter((s) => selected.has(s.id));
    const chosenIds = new Set(chosen.map((c) => c.id));
    const toPush = specs.filter((s) => chosenIds.has(s.testCaseId));
    if (toPush.length === 0) {
      setPushState({ status: 'error', error: 'There are no generated specs to push.' });
      return;
    }

    setPushState({ status: 'pushing' });
    log('report', `Pushing ${toPush.length} spec${toPush.length === 1 ? '' : 's'} to the connected repository`);
    try {
      const configs = await getConfigurations();
      const repo = (configs?.configs || []).find(
        (c: any) => ['github', 'gitlab', 'bitbucket'].includes(c.integrationId) && c.status === 'connected',
      );
      if (!repo) {
        const msg = 'No code repository is connected. Connect one under System Configuration → Code Repositories, then push again.';
        setPushState({ status: 'error', error: msg });
        log('report', msg, 'warn');
        return;
      }

      const result = await publishToGit({
        scripts: toPush.map((s) => ({ fileName: s.fileName, code: s.code, path: s.path })),
        // The specs import these — committing one without the other publishes a
        // repository that does not compile.
        pageObjects: serviceObjects.map((o) => ({ path: o.path, code: o.code })),
        testCases: chosen.map((c) => c.raw),
        integrationId: repo.integrationId,
        testRunId: testRunId || undefined,
        title: `API tests — ${endpointLabel}`,
        description: `${report?.passed ?? 0} of ${report?.total ?? toPush.length} scenarios passed against ${url.trim()}.`,
        commitMessage: `Add API tests for ${method} ${url.trim()}`,
      });

      let host = '';
      try { host = new URL(result.prUrl).pathname.split('/').filter(Boolean).slice(0, 2).join('/'); } catch { /* keep it blank */ }
      setPushState({
        status: 'done',
        url: result.prUrl,
        branch: result.branch,
        mode: result.mode,
        fileCount: result.fileCount,
        repo: host,
      });
      log('report', `${result.mode === 'pr' ? 'Pull request opened' : 'Committed'} on ${result.branch} (${result.fileCount} files)`, 'ok');
      toast.success(result.mode === 'pr' ? 'Pull request opened' : 'Pushed to repository', result.branch);
    } catch (err: any) {
      const msg = err?.response?.data?.error || err?.message || 'The push failed.';
      setPushState({ status: 'error', error: msg });
      log('report', `Push failed: ${msg}`, 'error');
      toast.error('Push failed', msg);
    }
  };

  /* ── Reset ── */
  const resetRun = () => {
    runIdRef.current++; // orphan anything still in flight
    setPhase('idle');
    setStages(INITIAL_STAGES);
    setScenarios([]); setSpecs([]); setServiceObjects([]); setRows([]); setReport(null);
    setSelected(new Set()); setTestRunId('');
    setRunError(''); setLogs([]); setTab('scenarios');
    setShowRequired(false);
    setPushState({ status: 'idle' });
  };

  /* ═══════════════════════════════════════════════════════════════
     Render
     ═══════════════════════════════════════════════════════════════ */
  return (
    <div className="h-full flex flex-col bg-gradient-to-b from-[#FAFAFE] to-[#F1EEFB] min-h-0">
      {/* ── Top bar ── */}
      <header className="flex items-center gap-2 px-3 h-12 bg-white border-b border-gray-200 flex-shrink-0">
        {onExit && (
          <button
            type="button"
            onClick={onExit}
            title="Back to automation types"
            className="p-1.5 -ml-1 rounded-md text-gray-400 hover:text-[#7C3AED] hover:bg-[#F5F3FF] transition-colors"
          >
            <ChevronLeft className="w-4 h-4" />
          </button>
        )}
        <div className="w-7 h-7 rounded-lg bg-gradient-to-br from-[#8B5CF6] to-[#6366F1] flex items-center justify-center flex-shrink-0 shadow-[0_2px_6px_-1px_rgba(124,58,237,0.55)] ring-1 ring-white/40">
          <Plug className="w-3.5 h-3.5 text-white" />
        </div>
        <div className="min-w-0">
          <h1 className="text-[13px] font-semibold text-gray-900 leading-tight">API Studio</h1>
          <p className="text-[10px] text-gray-400 leading-tight">Design, automate, run and heal API tests</p>
        </div>

        <div className="ml-auto flex items-center gap-2">
          {started && (
            <button
              type="button"
              onClick={resetRun}
              className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-[12px] font-medium text-gray-600 bg-white border border-gray-200 rounded-md hover:text-[#7C3AED] hover:border-[#DDD6FE] transition-colors"
            >
              <RotateCcw className="w-3.5 h-3.5" />New run
            </button>
          )}
        </div>
      </header>

      {/* ── URL bar ── */}
      <div className="flex items-center gap-2 px-3 py-2 bg-white border-b border-gray-200 flex-shrink-0">
        <div className={`flex flex-1 min-w-0 rounded-lg border bg-white transition-all overflow-hidden ${BAR_3D} ${
          showRequired && !url.trim()
            ? 'border-red-300 ring-2 ring-red-100'
            : 'border-gray-200/80 focus-within:border-[#A5B4FC] focus-within:ring-2 focus-within:ring-[#EDE9FE]'
        }`}>
          <select
            value={method}
            disabled={started}
            onChange={(e) => setMethod(e.target.value)}
            className="px-2.5 py-2 border-r border-gray-200 text-[12px] font-mono font-bold outline-none disabled:opacity-60 text-[#6D28D9] bg-gradient-to-b from-[#F5F3FF] to-[#EDE9FE] shadow-[inset_-1px_0_2px_rgba(76,29,149,0.06)]"
          >
            {HTTP_METHODS.map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
          <input
            value={url}
            disabled={started}
            onChange={(e) => handleUrlChange(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !running) runScenarios(); }}
            placeholder="https://api.mycompany.com/v1/users"
            spellCheck={false}
            aria-label="Endpoint URL"
            required
            className="flex-1 min-w-0 px-2.5 py-2 font-mono text-[12.5px] text-gray-800 placeholder-gray-300 outline-none disabled:bg-gray-50 disabled:text-gray-500"
          />
          {/* The URL has no label to hang the marker off, so it sits inside the
              field group where the eye already is. */}
          <span className="flex items-center pr-2.5 bg-white"><RequiredMark /></span>
        </div>

        {phase === 'review' ? (
          <button
            type="button"
            onClick={runSuite}
            disabled={selected.size === 0}
            className={`inline-flex items-center gap-1.5 px-3.5 py-2 text-[12px] font-semibold text-white ${BRAND_BUTTON} ${BUTTON_3D} rounded-lg disabled:opacity-40 transition-all flex-shrink-0`}
          >
            Run {selected.size} scenario{selected.size === 1 ? '' : 's'}
            <ArrowRight className="w-3.5 h-3.5" />
          </button>
        ) : finished ? (
          <button
            type="button"
            onClick={runSuite}
            disabled={selected.size === 0}
            title="Run the same scenarios again — use New run to design a fresh suite"
            className={`inline-flex items-center gap-1.5 px-3.5 py-2 text-[12px] font-semibold text-white ${BRAND_BUTTON} ${BUTTON_3D} rounded-lg disabled:opacity-40 transition-all flex-shrink-0`}
          >
            <Play className="w-3.5 h-3.5" />
            Re-run {selected.size} scenario{selected.size === 1 ? '' : 's'}
          </button>
        ) : (
          <button
            type="button"
            onClick={runScenarios}
            disabled={running}
            title={missingRequired.length > 0 ? `Required: ${missingRequired.join(', ')}` : ''}
            className={`inline-flex items-center gap-1.5 px-3.5 py-2 text-[12px] font-semibold text-white ${BRAND_BUTTON} ${BUTTON_3D} rounded-lg disabled:opacity-40 transition-all flex-shrink-0`}
          >
            {running ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Play className="w-3.5 h-3.5" />}
            {running ? 'Running…' : started ? 'Regenerate' : 'Send'}
          </button>
        )}
      </div>


      <StageRail stages={stages} />

      {/* Review-gate callout — the one place the run deliberately waits */}
      {phase === 'review' && (
        <div className="flex items-center gap-2 px-4 py-2 bg-[#F5F3FF] border-b border-[#DDD6FE] flex-shrink-0">
          <ListChecks className="w-4 h-4 text-[#7C3AED] flex-shrink-0" />
          <p className="text-[12px] text-[#4C1D95] min-w-0">
            <span className="font-semibold">{scenarios.length} scenarios designed.</span>{' '}
            Review them below and deselect anything you don't want — then run the suite. Automation, execution, healing and the report run straight through from there.
          </p>
        </div>
      )}

      {runError && (
        <div className="flex items-start gap-2 px-4 py-2 bg-red-50 border-b border-red-200 flex-shrink-0">
          <AlertTriangle className="w-4 h-4 text-red-500 flex-shrink-0 mt-px" />
          <p className="text-[12px] text-red-700 min-w-0">{runError}</p>
          <button type="button" onClick={() => setRunError('')} className="ml-auto text-red-400 hover:text-red-600 flex-shrink-0">
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      {/* ── Workspace ── */}
      <div className="flex-1 flex min-h-0">
        {/* Left: request */}
        <div className="w-[300px] flex-shrink-0 min-h-0">
          <RequestPanel
            queryParams={queryParams} onQueryParamsChange={applyQueryParams}
            headers={headers} onHeadersChange={setHeaders}
            authType={authType} onAuthTypeChange={setAuthType}
            authValue={authValue} onAuthValueChange={setAuthValue}
            method={method}
            body={body} onBodyChange={setBody}
            expectedStatus={expectedStatus} onExpectedStatusChange={setExpectedStatus}
            expectedBody={expectedBody} onExpectedBodyChange={setExpectedBody}
            showRequired={showRequired}
            specFormats={API_SPEC_FORMATS}
            onSpecFile={handleSpecFile}
            specParsing={specParsing}
            specError={specError}
            specWarning={specWarning}
            specNotice={specNotice}
            endpointCount={endpointChoices.length}
            onReopenEndpointPicker={() => setPickerOpen(true)}
            onDiscardSpec={discardSpec}
            locked={started}
          />
        </div>

        {/* Centre: artifacts */}
        <div className="flex-1 flex flex-col min-w-0 min-h-0 bg-white">
          <div className="flex items-center gap-0.5 px-2 h-9 border-b border-gray-200 bg-gray-50/70 flex-shrink-0">
            {TABS.map((t) => {
              const Icon = t.icon;
              const count = t.id === 'scenarios' ? scenarios.length : 0;
              return (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => setTab(t.id)}
                  className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[11.5px] font-medium transition-all ${
                    tab === t.id
                      ? 'bg-white text-[#6D28D9] border border-[#E9E5FB] shadow-[0_1px_2px_rgba(15,23,42,0.05),0_4px_10px_-4px_rgba(76,29,149,0.22)] -translate-y-px'
                      : 'text-[#6B7280] hover:text-gray-700 hover:bg-white/60 border border-transparent'
                  }`}
                >
                  <Icon className="w-3.5 h-3.5" />
                  {t.label}
                  {count > 0 && (
                    <span className="px-1 rounded bg-gray-100 text-[10px] font-mono text-gray-500 tabular-nums">{count}</span>
                  )}
                </button>
              );
            })}
          </div>

          <div className="flex-1 min-h-0">
            {tab === 'scenarios' && (
              <ScenariosTab
                scenarios={scenarios}
                selected={selected}
                editable={phase === 'review' || finished}
                onToggle={(id) => setSelected((prev) => {
                  const next = new Set(prev);
                  if (next.has(id)) next.delete(id); else next.add(id);
                  return next;
                })}
                onSelectAll={(ids) => setSelected((prev) => new Set([...prev, ...ids]))}
                onClearAll={() => setSelected(new Set())}
              />
            )}
            {tab === 'report' && (
              <ReportTab
                report={report}
                rows={rows}
                scenarios={scenarios}
                endpointLabel={endpointLabel}
                onExport={handleExport}
                exporting={exporting}
                canExport={!!testRunId}
                onPushToRepo={handlePushToRepo}
                pushState={pushState}
                canPush={specs.length > 0 && selected.size > 0}
              />
            )}
          </div>
        </div>

        {/* Right: activity — collapses to a strip when space is tight */}
        {!activityOpen && (
          <button
            type="button"
            onClick={() => setActivityOpen(true)}
            title="Show the activity log"
            className="w-9 flex-shrink-0 flex flex-col items-center gap-2 pt-2.5 border-l border-gray-200 bg-gray-50/70 hover:bg-[#F5F3FF] transition-colors group"
          >
            <Activity className={`w-3.5 h-3.5 ${running ? 'text-[#7C3AED]' : 'text-gray-400 group-hover:text-[#7C3AED]'}`} />
            {running && <Loader2 className="w-3 h-3 text-[#7C3AED] animate-spin" />}
            <span className="text-[10px] font-semibold uppercase tracking-wide text-gray-400 group-hover:text-[#7C3AED] [writing-mode:vertical-rl]">
              Activity
            </span>
          </button>
        )}
        <aside className={`w-[280px] flex-shrink-0 flex-col border-l border-gray-200 bg-white min-h-0 ${activityOpen ? 'flex' : 'hidden'}`}>
          <div className="flex items-center gap-1.5 px-3 h-9 border-b border-gray-200 bg-gray-50/70 flex-shrink-0">
            <Activity className="w-3.5 h-3.5 text-gray-400" />
            <span className="text-[11px] font-semibold text-gray-600 uppercase tracking-wide">Activity</span>
            {running && <Loader2 className="w-3 h-3 text-[#7C3AED] animate-spin" />}
            <button
              type="button"
              onClick={() => setActivityOpen(false)}
              title="Hide the activity log"
              className="ml-auto text-gray-300 hover:text-[#7C3AED] transition-colors"
            >
              <ChevronRight className="w-3.5 h-3.5" />
            </button>
          </div>
          <div className="flex-1 overflow-y-auto min-h-0 p-2 space-y-1">
            {logs.length === 0 ? (
              <EmptyState icon={Activity} title="Nothing yet" hint="Each stage reports what it is doing here as the run progresses." />
            ) : (
              logs.map((l) => (
                <div key={l.id} className="flex gap-1.5 text-[11px] leading-relaxed">
                  <span className="font-mono text-[9.5px] text-gray-300 tabular-nums pt-px flex-shrink-0">{clock(l.at)}</span>
                  <span className={`min-w-0 ${
                    l.level === 'ok' ? 'text-emerald-700'
                    : l.level === 'warn' ? 'text-amber-700'
                    : l.level === 'error' ? 'text-red-600'
                    : 'text-gray-600'
                  }`}>
                    <span className="font-mono text-[9.5px] uppercase text-gray-400 mr-1">{l.stage}</span>
                    {l.text}
                  </span>
                </div>
              ))
            )}
            <div ref={logEndRef} />
          </div>
        </aside>
      </div>

      {/* Shown when an import described several endpoints */}
      {pickerOpen && (
        <EndpointPicker
          endpoints={endpointChoices}
          onClose={() => setPickerOpen(false)}
          onPick={(ep) => {
            fillFromEndpoint(ep);
            setPickerOpen(false);
            toast.success('Endpoint selected', `${ep.method} ${ep.url}`);
          }}
        />
      )}
    </div>
  );
}
