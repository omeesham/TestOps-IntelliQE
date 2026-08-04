import { useState, useRef, useEffect, useMemo, useCallback } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import {
  connectJira,
  getJiraStories,
  getJiraStoryDetails,
  getJiraCurrentUser,
  getJiraAssignableUsers,
  assignJiraStory,
  unassignJiraStory,
  type JiraUser,
  getAzureDevopsStories,
  getAzureDevopsStoryDetails,
  getAzureDevopsTestCases,
  generateTests,
  generateScripts,
  executePipeline,
  healPipeline,
  saveTestCases,
  exportTestCases,
  createChatConversation,
  saveChatMessage,
  getConfigurations,
  extractDocumentText,
  publishToGit,
  getConfluencePages,
  getConfluencePage,
  getSharePointDocuments,
  getSharePointDocument,
  registerBugsFromRun,
  reportToSupport,
} from '@/services/api';
import {
  Send, Bot, Loader2, CheckCircle, Monitor, Plug,
  Globe, Layers, Shield, FileText, Upload, Type, Link2,
  ArrowRight, RotateCcw, ChevronDown, Eye, EyeOff, Check, X,
  Plus, Trash2, Download, Clipboard, Cpu, Code, Search, Zap,
  BarChart3, Activity, Workflow, Box, Pencil, Save, ChevronLeft, ChevronRight,
  Play, Heart, GitBranch, Terminal, AlertTriangle, Wrench, ExternalLink, Copy, Package,
  SkipForward, XCircle, Volume2, VolumeX, Settings, MoreHorizontal, Github, LifeBuoy,
  Pause, Square,
} from 'lucide-react';
import { initTTS, speak, speakAsync, waitForSpeech, waitForVoices, stopSpeaking, isTTSEnabled, toggleTTS } from '@/utils/tts';
import { useToast } from '@/components/feedback/ToastProvider';

/* ═══════════════════════════════════════════════════════════════
   TYPES
   ═══════════════════════════════════════════════════════════════ */
interface Msg {
  id: string;
  sender: 'tessa' | 'user';
  text: string;
}

type Step =
  | 'welcome'
  | 'source-select'
  | 'connect-form'
  | 'ado-mode'
  | 'app-select'
  | 'content-select'
  | 'jira-stories'
  | 'upload-doc'
  | 'paste-text'
  | 'explore-form'
  | 'api-form'
  | 'column-select'
  | 'generating'
  | 'results'
  | 'saved'
  | 'script-generating'
  | 'script-review'
  | 'executing'
  | 'execution-results'
  | 'healing'
  | 'report'
  | 'publish';

type Category = 'application' | 'api';
type ReqSource = 'jira' | 'azure-devops' | 'confluence' | 'sharepoint' | 'upload' | 'text' | 'explore';

interface FormField {
  key: string;
  label: string;
  type: 'text' | 'email' | 'password' | 'textarea' | 'select';
  placeholder: string;
  options?: { value: string; label: string }[];
}

interface HeaderPair { key: string; value: string }

interface AgentStep {
  name: string;
  status: 'pending' | 'running' | 'completed';
  detail: string;
}

/* ═══════════════════════════════════════════════════════════════
   CONSTANTS
   ═══════════════════════════════════════════════════════════════ */
const CATEGORIES: { id: Category; title: string; icon: React.ElementType; desc: string; comingSoon?: boolean }[] = [
  { id: 'application', title: 'Web Application Automation', icon: Monitor, desc: 'Validate functional workflows, E2E testing and cross-browser behavior.' },
  { id: 'api',         title: 'API Automation',     icon: Plug,        desc: 'Test REST services, endpoints, and system integrations.', comingSoon: true },
];

const REQ_SOURCES: { id: ReqSource; title: string; icon: React.ElementType; desc: string }[] = [
  { id: 'jira', title: 'JIRA', icon: Link2, desc: 'Import from JIRA stories' },
  { id: 'azure-devops', title: 'Azure DevOps', icon: Workflow, desc: 'Import stories & work items from Azure Boards' },
  { id: 'confluence', title: 'Confluence', icon: FileText, desc: 'Import from Confluence' },
  { id: 'sharepoint', title: 'SharePoint', icon: Globe, desc: 'Import from SharePoint' },
  { id: 'upload', title: 'Upload Document', icon: Upload, desc: 'BRD / Functional Doc' },
  { id: 'text', title: 'Paste Requirements', icon: Type, desc: 'Type or paste text' },
  // "Explore" mode — when the user has nothing but a URL (+ optional creds).
  // The backend's exploreAgent crawls the live app and synthesises requirements.
  { id: 'explore', title: 'Explore App (URL only)', icon: Search, desc: 'Crawl the live app & infer tests' },
];

/* CONNECT_FIELDS removed — all connection configuration now lives in System Configuration page */

/* ── Failure diagnostics ─────────────────────────────────────────
   Translate a raw Playwright error into a plain-English diagnosis (what broke)
   plus an actionable hint (how to fix it). The full raw error stays available
   behind the per-row ⋯ expander for whoever needs the technical detail. */
interface FailureDiagnosis { title: string; hint: string }

/** Pull the element the test was looking for out of a Playwright error/call log. */
function extractFailedTarget(err: string): string | undefined {
  const m =
    err.match(/waiting for (getBy[A-Za-z]+\(.*?\))/) ||
    err.match(/waiting for locator\((['"].*?['"])\)/) ||
    err.match(/locator\((['"].*?['"])\)/) ||
    err.match(/(getBy[A-Za-z]+\(.*?\))/);
  const t = m?.[1]?.trim();
  return t ? (t.length > 70 ? `${t.slice(0, 70)}…` : t) : undefined;
}

function diagnoseFailure(raw?: string): FailureDiagnosis {
  const err = raw || '';
  if (!err) return { title: 'Test failed', hint: 'No error detail was returned for this test.' };
  const target = extractFailedTarget(err);

  if (/Missing page object/i.test(err)) return {
    title: 'Generated script is incomplete — a page object file is missing',
    hint: 'The spec imports a page object that was never created (a generation desync). Regenerate the automation scripts for this test case.',
  };
  if (/could not be generated/i.test(err)) return {
    title: 'No automation script could be generated for this test case',
    hint: 'The AI did not produce a runnable script for these steps. Regenerate the scripts, or simplify/clarify the test steps.',
  };
  if (/ERR_NAME_NOT_RESOLVED|ERR_CONNECTION_REFUSED|ERR_CONNECTION_TIMED_OUT|ERR_CERT|ECONNREFUSED|net::ERR/i.test(err)) return {
    title: 'Could not reach the application under test',
    hint: 'The target URL did not respond. Verify the Base URL in System Configuration → Application Setup and confirm the app is up and reachable from the server.',
  };
  if (/waitForURL/i.test(err) && /Timeout|exceeded/i.test(err)) return {
    title: 'Login or navigation never completed',
    hint: 'The app stayed on the same page after signing in / navigating — usually wrong credentials, an unexpected login flow (e.g. SSO), or a very slow redirect. Check the credentials in Application Setup.',
  };
  if (/strict mode violation/i.test(err)) return {
    title: `Selector matched more than one element${target ? `: ${target}` : ''}`,
    hint: 'The selector is ambiguous on this page — several elements match it. Auto-Heal can usually narrow it to the right one.',
  };
  if (/Timeout|exceeded|waiting for/i.test(err) && (/toBeVisible|toBeHidden|waiting for|not found/i.test(err))) return {
    title: `Element not found on the page${target ? `: ${target}` : ''}`,
    hint: 'The generated selector does not match the app’s actual DOM (or the element only appears after an earlier step that failed). Auto-Heal re-inspects the live page and fixes selectors like this.',
  };
  if (/expect\(|toBe|toHave|toContain|toEqual|Expected|Received/i.test(err)) return {
    title: 'Assertion failed — the app behaved differently than expected',
    hint: 'The steps ran, but what appeared on screen did not match the expected result. Review this test case’s expected result, or run Auto-Heal to adjust the assertion.',
  };
  if (/SyntaxError|Cannot find module|failed to load|Unexpected token|TS\d{4}/i.test(err)) return {
    title: 'The generated script has a code error',
    hint: 'The spec failed to compile/load, so it never ran. Regenerate the scripts or run Auto-Heal to rewrite it.',
  };
  if (/Timeout|exceeded/i.test(err)) return {
    title: `Timed out waiting for the page${target ? ` (${target})` : ''}`,
    hint: 'The app did not reach the expected state in time — slow environment, or the flow differs from the test’s assumption. Auto-Heal may adapt the wait/selector.',
  };
  const first = err.split('\n').map((l) => l.trim()).find(Boolean) || 'Test failed';
  return { title: first.length > 140 ? `${first.slice(0, 140)}…` : first, hint: 'See the full error below for details.' };
}

const AGENTS: { name: string; detail: string }[] = [
  { name: 'Requirement Analyst', detail: 'Parsing requirements & identifying test scenarios' },
  { name: 'Test Case Generator', detail: 'Generating detailed test cases' },
];

const SCRIPT_AGENTS: { name: string; detail: string }[] = [
  { name: 'Script Writer', detail: 'Producing automation scripts' },
  { name: 'Execution Engine', detail: 'Running tests across environments' },
  { name: 'Self-Healing Agent', detail: 'Auto-fixing flaky selectors & assertions' },
];


const ALL_COLUMNS = [
  { key: 'tcNumber', label: 'TC Number', default: true },
  { key: 'title', label: 'Test Case Title', default: true },
  { key: 'steps', label: 'Test Steps', default: true },
  { key: 'expected', label: 'Expected Result', default: true },
  { key: 'priority', label: 'Priority', default: true },
  { key: 'type', label: 'Type', default: true },
  { key: 'feature', label: 'Feature / Module', default: false },
  { key: 'precondition', label: 'Preconditions', default: false },
  { key: 'status', label: 'Status', default: false },
];

const PAGE_SIZES = [10, 25, 50];

// No mock constants — all data comes from the backend AI pipeline

interface PipelineStageInfo {
  key: string;
  name: string;
  icon: React.ElementType;
}

const PIPELINE_STAGES: PipelineStageInfo[] = [
  { key: 'requirements', name: 'Requirement Analysis', icon: Search },
  { key: 'test-design', name: 'Test Design', icon: FileText },
  { key: 'script-gen', name: 'Script Generation', icon: Code },
  { key: 'execution', name: 'Execution & Validation', icon: Play },
  { key: 'auto-healing', name: 'Auto-Healing', icon: Heart },
  { key: 'report-gen', name: 'Report Generation', icon: BarChart3 },
];

interface PipelineStageState {
  key: string;
  status: 'pending' | 'running' | 'completed' | 'skipped';
  detail: string;
  /** Epoch ms when the stage first entered 'running'. */
  startedAt?: number;
  /** Elapsed ms once the stage reached a terminal state. */
  durationMs?: number;
}

/** Format a millisecond duration adaptively: `45s`, `2m 35s`, `1h 02m 10s`.
 *  (The old fixed 00h00m00s clock read as "no timing" for sub-hour runs.) */
function formatHMS(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const p = (n: number) => String(n).padStart(2, '0');
  if (h > 0) return `${h}h ${p(m)}m ${p(s)}s`;
  if (m > 0) return `${m}m ${p(s)}s`;
  return `${s}s`;
}

/* ═══════════════════════════════════════════════════════════════
   MAIN COMPONENT
   ═══════════════════════════════════════════════════════════════ */
export default function ChatPage() {
  const { user } = useAuth();
  const toast = useToast();
  const scrollRef = useRef<HTMLDivElement>(null);

  /* --- state --- */
  const [messages, setMessages] = useState<Msg[]>([]);
  const [step, setStep] = useState<Step>('welcome');
  // Guards a primary action against double-clicks: set true the instant a CTA is
  // clicked (disabling it), and auto-cleared whenever the step advances so the
  // next screen's buttons are live. `runOnce` wraps a handler with this guard.
  const [busy, setBusy] = useState(false);
  const runOnce = (fn: () => void) => () => { if (busy) return; setBusy(true); fn(); };
  // Re-enable action buttons once the wizard moves to a new step.
  useEffect(() => { setBusy(false); }, [step]);
  // Monotonic id of the active wizard flow. Long-running handlers capture it on
  // entry and re-check it after every await: reset() (and each new generation)
  // bumps it, so a continuation from a discarded flow finds the id changed and
  // drops its result instead of clobbering the new flow's state. Without this,
  // an in-flight /generate from a discarded chat could resolve minutes later —
  // mid-heal — overwrite the test cases, or push "no test cases" and yank the
  // wizard back to welcome.
  const flowIdRef = useRef(0);
  const [category, setCategory] = useState<Category | null>(null);
  const [subCategory, setSubCategory] = useState<string | null>(null);
  const [source, setSource] = useState<ReqSource | null>(null);
  const [formValues, setFormValues] = useState<Record<string, string>>({});
  const [isConnecting, setIsConnecting] = useState(false);
  const [connectError, setConnectError] = useState('');
  const [stories, setStories] = useState<any[]>([]);
  const [selectedStory, setSelectedStory] = useState<string>('');
  // JIRA assignee view state (step === 'jira-stories')
  const [jiraTab, setJiraTab] = useState<'assigned' | 'unassigned'>('assigned');
  const [personFilter, setPersonFilter] = useState<string>('');       // '' = all people
  const [assigningKey, setAssigningKey] = useState<string>('');       // story key currently being assigned (row spinner)
  const [assignableUsers, setAssignableUsers] = useState<JiraUser[]>([]);
  const [assignLoading, setAssignLoading] = useState(false);          // an assign action is in flight
  const [peopleLoading, setPeopleLoading] = useState(false);          // one-time fetch of the Jira people list
  // Pending assignment awaiting user confirmation (popup before the ticket is changed).
  // action: 'assign-start' = assign an unassigned story then start analysis;
  //         'reassign' = change assignee of an assigned story (no auto-start);
  //         'unassign' = clear the assignee (story moves to the Unassigned tab).
  const [assignConfirm, setAssignConfirm] = useState<{ key: string; accountId: string; displayName: string; isMe?: boolean; action: 'assign-start' | 'reassign' | 'unassign' } | null>(null);
  // Configured application(s) under test — shown on the Jira card so it's clear
  // which app these stories will be tested against. null = not yet loaded.
  const [readyApps, setReadyApps] = useState<{ integrationId: string; appName: string; baseUrl: string }[] | null>(null);
  const [pasteText, setPasteText] = useState('');
  const [results, setResults] = useState<any>(null);
  const [showPasswords, setShowPasswords] = useState<Record<string, boolean>>({});


  // Explore-mode state — populated when the user picks the "Explore App" source.
  // The backend's exploreAgent will crawl exploreUrl and (if creds given) attempt
  // a login as exploreUsername/explorePassword before harvesting the UI map.
  const [exploreUrl, setExploreUrl] = useState('');
  const [exploreAppName, setExploreAppName] = useState('');
  const [exploreUsername, setExploreUsername] = useState('');
  const [explorePassword, setExplorePassword] = useState('');
  // Applications configured in System Configuration → Application Setup, offered
  // as a dropdown on the explore form so the user picks a known app (name + URL)
  // instead of retyping it. Loaded when the explore form opens.
  const [exploreApps, setExploreApps] = useState<{ integrationId: string; appName: string; baseUrl: string }[]>([]);
  const [exploreAppsLoading, setExploreAppsLoading] = useState(false);
  const [exploreAppId, setExploreAppId] = useState('');
  // Optional free-form guidance the user types to steer what the explore agent
  // focuses on (e.g. "focus on the checkout flow and negative payment cases").
  // Threaded to the backend as appContext.explorePrompt — never changes the
  // crawl itself, only biases the requirements synthesis.
  const [explorePrompt, setExplorePrompt] = useState('');

  // Column select + results management
  const [selectedColumns, setSelectedColumns] = useState<string[]>(ALL_COLUMNS.filter(c => c.default).map(c => c.key));
  const [pendingRequirements, setPendingRequirements] = useState<string>('');
  const [tcPage, setTcPage] = useState(1);
  const [tcPageSize, setTcPageSize] = useState(10);
  const [selectedTcIds, setSelectedTcIds] = useState<Set<string>>(new Set());
  const [editingTcId, setEditingTcId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState<any>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [savedTestRunId, setSavedTestRunId] = useState<string | null>(null);
  const [isExporting, setIsExporting] = useState(false);
  const [agentSteps, setAgentSteps] = useState<AgentStep[]>([]);
  const [storyMeta, setStoryMeta] = useState<{ key?: string; title?: string }>({});

  // Application selection — which Application Setup entry the current
  // requirements/test cases target. Required whenever the tenant has more
  // than one configured application, so generation/scripts/execution/healing
  // all ground themselves in the SAME application instead of the server
  // silently defaulting to "whichever app happens to be configured".
  const [appOptions, setAppOptions] = useState<{ integrationId: string; appName: string; baseUrl: string }[]>([]);
  const [selectedAppId, setSelectedAppId] = useState<string | null>(null);
  const [pendingGenRequirements, setPendingGenRequirements] = useState<string>('');

  // Pipeline progress sidebar
  const [pipelineStages, setPipelineStages] = useState<PipelineStageState[]>(
    PIPELINE_STAGES.map(s => ({ key: s.key, status: 'pending' as const, detail: 'Pending' }))
  );

  // `explicitDurationMs` overrides the measured elapsed time for stages whose
  // real cost isn't wall-clock between their running→completed transitions.
  // The Report stage is the case: the Allure report is built on the backend
  // during execution/healing, so this stage just assembles existing state in
  // ~0ms — showing its own elapsed renders a misleading 00h00m00s. We instead
  // surface the actual test-run duration there.
  const updatePipeline = (
    key: string,
    status: 'pending' | 'running' | 'completed' | 'skipped',
    detail: string,
    explicitDurationMs?: number,
  ) => {
    setPipelineStages(prev => prev.map(s => {
      if (s.key !== key) return s;
      const startedAt = status === 'running' ? (s.startedAt ?? Date.now()) : s.startedAt;
      // On a terminal transition, freeze the elapsed time once.
      const durationMs = (status === 'completed' || status === 'skipped')
        ? (explicitDurationMs ?? s.durationMs ?? (s.startedAt ? Date.now() - s.startedAt : 0))
        : s.durationMs;
      return { ...s, status, detail, startedAt, durationMs };
    }));
  };

  // Live 1s tick so the currently-running stage shows a real-time elapsed timer.
  // Runs only while a stage is 'running' to avoid needless re-renders.
  const [nowTick, setNowTick] = useState(0);
  useEffect(() => {
    const running = pipelineStages.some(s => s.status === 'running');
    if (!running) return;
    const id = setInterval(() => setNowTick(Date.now()), 1000);
    return () => clearInterval(id);
  }, [pipelineStages]);

  // ── Workflow run controls (Start / Pause / Stop) ──
  // The long-running stages (script generation, execution, healing) run as
  // detached server jobs the UI polls. `pipelineControl` gates that polling so
  // the user can pause the workflow (hold advancement without losing the run) or
  // stop it (discard the active flow). A ref mirror is read synchronously by the
  // poller; the state drives the sidebar buttons. 'idle' = run normally.
  type PipelineControlState = 'idle' | 'paused' | 'stopped';
  const [pipelineControl, setPipelineControl] = useState<PipelineControlState>('idle');
  const pipelineControlRef = useRef<PipelineControlState>('idle');
  const setControl = (v: PipelineControlState) => { pipelineControlRef.current = v; setPipelineControl(v); };
  // Stable controller handed to the api layer — reads the ref so it always sees
  // the latest value without being re-created on every render.
  const pipelineController = useRef({
    isPaused: () => pipelineControlRef.current === 'paused',
    isStopped: () => pipelineControlRef.current === 'stopped',
  }).current;

  // Only the detached-job stages poll the server, so only those can be paused
  // cooperatively. Stop works for any stage (it just discards the flow).
  const POLLER_STAGE_KEYS = new Set(['script-gen', 'execution', 'auto-healing']);
  const pipelineRunning = pipelineStages.some(s => s.status === 'running');
  const runningPollerStage = pipelineStages.some(s => s.status === 'running' && POLLER_STAGE_KEYS.has(s.key));
  const canPause = runningPollerStage && pipelineControl !== 'paused';
  const pipelineActive = pipelineRunning || pipelineControl === 'paused';

  const pausePipeline = () => { if (runningPollerStage) setControl('paused'); };
  const resumePipeline = () => { if (pipelineControl === 'paused') setControl('idle'); };
  const stopPipeline = () => {
    // Discard the active flow: bumping flowIdRef makes any in-flight handler
    // continuation drop its result (same guard reset() uses), and the poller
    // sees isStopped() and aborts its wait.
    flowIdRef.current += 1;
    setControl('stopped');
    setBusy(false);
    // Freeze the visual pipeline — mark any running stage as stopped.
    setPipelineStages(prev => prev.map(s => s.status === 'running'
      ? { ...s, status: 'skipped', detail: 'Stopped by user', durationMs: s.startedAt ? Date.now() - s.startedAt : s.durationMs }
      : s));
    push('tessa', 'Pipeline stopped. You can start a new test or continue from the current results.');
    // Leave any spinner screen so nothing is left hanging — drop back to the
    // last screen the user can act from for whichever stage was interrupted.
    setStep(prev => {
      if (prev === 'executing') return 'script-review';
      if (prev === 'healing') return 'execution-results';
      if (prev === 'script-generating') return 'results';
      return prev;
    });
  };

  // Script generation results (POM: specs + shared page objects)
  const [generatedScripts, setGeneratedScripts] = useState<{ testCaseId: string; fileName: string; code: string; path?: string; uses?: string[] }[]>([]);
  const [generatedPageObjects, setGeneratedPageObjects] = useState<{ path: string; className: string; module: string; methods: string[]; code: string }[]>([]);
  const [selectedScriptIdx, setSelectedScriptIdx] = useState(0);

  // Execution state
  // 'not_run' is a real, distinct outcome — the backend tells us a test
  // wasn't executed (e.g., Playwright failed to start, or no spec was
  // produced). Surfacing it honestly beats faking a pass or a fail.
  const [executionResults, setExecutionResults] = useState<{ testCaseId: string; testName: string; status: 'pending' | 'running' | 'passed' | 'failed' | 'not_run'; duration: string; error?: string }[]>([]);
  const [executionSummary, setExecutionSummary] = useState<{ total: number; passed: number; failed: number; duration: string; durationMs: number } | null>(null);
  // Which in-place subset re-run is running ('failure' | 'flaky' | ''), so only
  // that button spins and re-runs are not fired concurrently.
  const [rerunKind, setRerunKind] = useState<'' | 'failure' | 'flaky'>('');
  // One-click "Push to GitHub" state (report + results screens).
  const [gitPush, setGitPush] = useState<{ status: 'idle' | 'pushing' | 'done' | 'error'; prUrl?: string; error?: string }>({ status: 'idle' });
  // "Report to Support" state.
  const [supportState, setSupportState] = useState<{ status: 'idle' | 'sending' | 'sent' | 'error'; msg?: string }>({ status: 'idle' });
  // Rows whose ⋯ expander is open (full raw error + fix hint). Reset per run.
  const [expandedResults, setExpandedResults] = useState<Set<number>>(new Set());
  const toggleResultExpanded = (i: number) => setExpandedResults((prev) => {
    const next = new Set(prev);
    if (next.has(i)) next.delete(i); else next.add(i);
    return next;
  });

  // Healing state
  const [healingAttempt, setHealingAttempt] = useState(0);
  // 'unchanged' = backend re-ran but the test still failed; 'unknown' =
  // backend gave no answer at all (network error, timeout). Both are real
  // outcomes — we never claim a test was healed when it wasn't.
  const [healingLog, setHealingLog] = useState<{ testCaseId: string; error: string; fix: string; result: 'fixed' | 'unchanged' | 'unknown' | 'still-failing' }[]>([]);

  // Report state
  const [reportData, setReportData] = useState<{ totalTests: number; passed: number; failed: number; notRun: number; healed: number; passRate: number; executionTime: string; healingRequired: boolean } | null>(null);

  // Pipeline run tracking
  const [currentRunId, setCurrentRunId] = useState<string | null>(null);
  const [pipelineMode, setPipelineMode] = useState<'sync' | 'async'>('sync');

  // Session restore banner
  const [sessionRestored, setSessionRestored] = useState(false);

  // Git publish state
  const [gitRepoUrl, setGitRepoUrl] = useState('');
  const [gitBranch, setGitBranch] = useState('main');
  const [isPublishing, setIsPublishing] = useState(false);
  const [publishResult, setPublishResult] = useState<'success' | 'error' | null>(null);
  // Connected git-repo integrations (from System Configuration → Code
  // Repositories). The user picks one from a dropdown rather than re-typing
  // the URL/branch — the backend resolves repo, branch and scripts path from
  // the selected connection's saved (encrypted) config.
  type ConnectedRepo = { integrationId: string; name: string; repoUrl: string; branch: string; scriptsPath?: string };
  const [connectedRepos, setConnectedRepos] = useState<ConnectedRepo[]>([]);
  const [selectedRepoId, setSelectedRepoId] = useState('');

  // Voice-over state
  const [voiceEnabled, setVoiceEnabled] = useState(() => isTTSEnabled());

  // API form
  const [apiUrl, setApiUrl] = useState('');
  const [apiMethod, setApiMethod] = useState('GET');
  const [apiHeaders, setApiHeaders] = useState<HeaderPair[]>([{ key: '', value: '' }]);
  const [apiAuthType, setApiAuthType] = useState('none');
  const [apiAuthValue, setApiAuthValue] = useState('');
  const [apiBody, setApiBody] = useState('');
  const [apiSampleResp, setApiSampleResp] = useState('');

  /* --- TTS init --- */
  useEffect(() => { initTTS(); }, []);

  // Preload the Jira people list when the assignee view opens, so both the
  // "Assign to" (unassigned) and "Reassign / unassign" (assigned) dropdowns are
  // ready. Assignable users are project-scoped, so any story key works.
  useEffect(() => {
    if (step !== 'jira-stories') return;
    const anyStory = stories[0];
    if (!anyStory) return;
    loadAssignablePeople(anyStory.key);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, stories]);

  // Load the configured application(s) under test so the Jira card can show
  // which app these stories map to (from System Configuration → Application Setup).
  useEffect(() => {
    if (step !== 'jira-stories') return;
    let cancelled = false;
    (async () => {
      const apps = await getReadyApps();
      if (!cancelled) setReadyApps(apps);
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step]);

  // Load the applications configured in Application Setup for the explore form's
  // "Application" dropdown, so the user picks a configured app (name + base URL)
  // rather than retyping it. Runs whenever the explore form opens.
  useEffect(() => {
    if (step !== 'explore-form') return;
    let cancelled = false;
    setExploreAppsLoading(true);
    (async () => {
      const apps = await getReadyApps();
      if (!cancelled) {
        setExploreApps(apps || []);
        setExploreAppsLoading(false);
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step]);

  /* ─── Session persistence — save critical state to sessionStorage ─── */
  const SESSION_KEY = `qurify_chat_${user?.username || 'guest'}`;

  // Restore session on mount (tab switch / back-navigation)
  useEffect(() => {
    try {
      const saved = sessionStorage.getItem(SESSION_KEY);
      if (!saved) return;
      const s = JSON.parse(saved);
      if (s.messages?.length)       setMessages(s.messages);
      if (s.step)                   setStep(s.step);
      if (s.category)               setCategory(s.category);
      if (s.source)                 setSource(s.source);
      if (s.pendingRequirements)    setPendingRequirements(s.pendingRequirements);
      if (s.storyMeta)              setStoryMeta(s.storyMeta);
      if (s.selectedColumns)        setSelectedColumns(s.selectedColumns);
      if (s.results)                setResults(s.results);
      if (s.generatedScripts?.length) setGeneratedScripts(s.generatedScripts);
      if (s.executionResults?.length) setExecutionResults(s.executionResults);
      if (s.executionSummary)       setExecutionSummary(s.executionSummary);
      if (s.reportData)             setReportData(s.reportData);
      if (s.healingLog?.length)     setHealingLog(s.healingLog);
      if (s.healingAttempt)         setHealingAttempt(s.healingAttempt);
      if (s.savedTestRunId)         setSavedTestRunId(s.savedTestRunId);
      if (s.pipelineStages)         setPipelineStages(s.pipelineStages);
      setSessionRestored(true);
      // Auto-hide after 4 seconds
      setTimeout(() => setSessionRestored(false), 4000);
    } catch { /* ignore parse errors */ }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Persist state on every meaningful change
  useEffect(() => {
    // Don't save welcome state — only save if user has started a flow
    if (step === 'welcome' && messages.length === 0) return;
    try {
      sessionStorage.setItem(SESSION_KEY, JSON.stringify({
        messages,
        step,
        category,
        source,
        pendingRequirements,
        storyMeta,
        selectedColumns,
        results,
        generatedScripts,
        executionResults,
        executionSummary,
        reportData,
        healingLog,
        healingAttempt,
        savedTestRunId,
        pipelineStages,
      }));
    } catch { /* ignore quota errors */ }
  }, [
    messages, step, category, source, pendingRequirements, storyMeta,
    selectedColumns, results, generatedScripts, executionResults,
    executionSummary, reportData, healingLog, healingAttempt,
    savedTestRunId, pipelineStages, SESSION_KEY,
  ]);

  // Clear session when user explicitly resets/starts over
  const clearSession = useCallback(() => {
    sessionStorage.removeItem(SESSION_KEY);
  }, [SESSION_KEY]);

  const handleVoiceToggle = useCallback(() => {
    const newState = toggleTTS();
    setVoiceEnabled(newState);
  }, []);

  /* --- helpers --- */
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const push = (sender: 'tessa' | 'user', text: string) => {
    setMessages(prev => [...prev, { id: uid(), sender, text }]);
    // Auto-speak Tessa's messages
    if (sender === 'tessa') {
      speak(text);
    }
  };

  useEffect(() => {
    scrollRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, step, agentSteps]);

  // Role-based category filtering — data_analyst sees nothing in chat for now
  const role = user?.role || 'admin';
  const visibleCategories = CATEGORIES.filter((c) => {
    if (role === 'data_analyst') return false;
    return c.id === 'application' || c.id === 'api';
  });

  // welcome — runs once, waits for voices so Zira is used from the start
  const welcomed = useRef(false);
  useEffect(() => {
    if (welcomed.current) return;
    welcomed.current = true;

    // Skip welcome if a previous session was restored (it already has messages)
    const hasSavedSession = !!sessionStorage.getItem(SESSION_KEY);
    if (hasSavedSession) return;

    waitForVoices().then(() => {
      push('tessa', `Hello ${user?.username || 'there'}! I'm Tessa, your IntelliQE TestOps Assistant.\n\nI can help you design, generate, and run intelligent tests for your applications.\n\nWhat would you like to test today?`);
    });
  }, []);

  /* --- flow handlers --- */
  const pickCategory = (c: typeof CATEGORIES[number]) => {
    if (c.comingSoon) {
      push('user', c.title);
      push('tessa', `${c.title} is coming soon — we're actively working on it. Stay tuned!`);
      return;
    }
    push('user', c.title);
    setCategory(c.id);
    setSubCategory(c.title);

    if (c.id === 'api') {
      push('tessa', 'Please provide your API details below.');
      setStep('api-form');
    } else {
      push('tessa', 'How would you like to provide your requirements?');
      setStep('source-select');
    }
  };

  /* --- application-configured guard ---
     Requirement Analysis / test generation always needs a target application
     under test. Shared by the JIRA story-pick guard (checked as soon as a
     story/task is picked) and the Generate-time guard, so both agree on what
     "configured" means: a connected `app-*` integration with a base URL. */
  const isApplicationConfigured = async (): Promise<boolean> => {
    const apps = await getReadyApps();
    // null = couldn't verify (network/API) — don't block here; the backend guard still enforces it.
    return apps === null || apps.length > 0;
  };

  /* --- ready applications ---
     Returns every properly-configured application (connected app-* with a
     base URL), or null when the check itself failed (network/API — the
     backend guard still enforces it, so we don't block on our own error).
     Used by runGeneration to ground generation in ONE specific application:
     picking "just any configured app" let one application's stories
     (e.g. OrangeHRM) silently run against a DIFFERENT application's URL
     whenever more than one was configured. */
  const getReadyApps = async (): Promise<{ integrationId: string; appName: string; baseUrl: string }[] | null> => {
    try {
      const { configs } = await getConfigurations();
      return (configs || [])
        .filter((c: any) => c.integrationId?.startsWith('app-') && c.status === 'connected' && c.configData?.baseUrl)
        .map((c: any) => ({
          integrationId: c.integrationId,
          appName: c.configData?.appName || c.integrationId,
          baseUrl: c.configData?.baseUrl,
        }));
    } catch {
      return null;
    }
  };

  const pickInFlight = useRef(false);
  const pickSource = async (s: ReqSource) => {
    // Guard against a double-fire (double-click / re-render) replaying the whole
    // message thread. Block re-entry until this pick finishes.
    if (pickInFlight.current) return;
    pickInFlight.current = true;
    try {
    push('user', REQ_SOURCES.find(r => r.id === s)!.title);
    setSource(s);
    setFormValues({});
    setConnectError('');
    if (s === 'upload') {
      push('tessa', 'Please upload your BRD or functional specification document.');
      setStep('upload-doc');
    } else if (s === 'text') {
      push('tessa', 'Please paste or type your requirements below.');
      setStep('paste-text');
    } else if (s === 'explore') {
      push('tessa', "No problem! Please share the application URL (and login credentials if it's behind a login), and I'll explore the app to work out what to test.");
      setStep('explore-form');
    } else {
      const label = REQ_SOURCES.find((r) => r.id === s)?.title || String(s);
      // Check if already connected via System Configuration
      try {
        const result = await getConfigurations();
        const configs = result.configs || [];
        const matched = configs.find((c: any) => c.integrationId === s && c.status === 'connected');
        if (matched) {
          if (s === 'jira') {
            try {
              const storiesArr = await getJiraStories(user?.username || 'admin');
              const list = Array.isArray(storiesArr) ? storiesArr : (storiesArr?.stories || storiesArr?.issues || []);
              setStories(list);
              const assignedCount = list.filter((s: any) => s.assignee).length;
              setJiraTab(assignedCount > 0 ? 'assigned' : 'unassigned');
              push('tessa', `${label} is connected. I found ${list.length} stories/tasks (${assignedCount} assigned, ${list.length - assignedCount} unassigned). Pick one from the Assigned tab, or assign an Unassigned one to get started.`);
              setStep('jira-stories');
            } catch (err: any) {
              console.error('JIRA stories fetch failed:', err?.response?.data || err);
              const data = err?.response?.data;
              const status = data?.status ?? err?.response?.status;
              const msg = data?.error || err?.message || 'Could not fetch stories';
              push('tessa', `I couldn't fetch items from JIRA${status ? ` (error ${status})` : ''}: ${msg}. Please try again.`);
            }
          } else if (s === 'azure-devops') {
            // ADO offers TWO modes: generate from stories, or import existing
            // Test Cases authored in Azure DevOps. Let the user choose.
            push('tessa', `${label} is connected. Would you like me to generate new test cases from your stories, or import the test cases already authored in Azure DevOps?`);
            setStep('ado-mode');
          } else if (s === 'confluence') {
            // Real Confluence fetch — list pages from the connected wiki.
            push('tessa', `${label} is connected. Fetching your pages...`);
            try {
              const pages = await getConfluencePages();
              // Normalise into the shared `stories` shape so the existing
              // content-select UI can render the list without changes.
              const list = pages.map((p) => ({
                key: p.id,
                summary: p.spaceName ? `${p.title} — ${p.spaceName}` : p.title,
                title: p.title,
                description: '',
              }));
              setStories(list);
              push('tessa', `I found ${list.length} page(s). Please select one and I'll retrieve its content.`);
              setStep('content-select');
            } catch (err: any) {
              const msg = err?.response?.data?.error || err?.message || 'Could not fetch Confluence pages';
              push('tessa', `I couldn't fetch pages from Confluence: ${msg}. Please try again.`);
            }
          } else if (s === 'sharepoint') {
            // Real SharePoint fetch — list documents from the default library.
            push('tessa', `${label} is connected. Fetching your documents...`);
            try {
              const docs = await getSharePointDocuments();
              const list = docs.map((d) => ({
                key: d.id,
                summary: d.size ? `${d.name} (${(d.size / 1024).toFixed(1)} KB)` : d.name,
                title: d.name,
                description: '',
              }));
              setStories(list);
              push('tessa', `I found ${list.length} document(s). Please select one to extract requirements.`);
              setStep('content-select');
            } catch (err: any) {
              const msg = err?.response?.data?.error || err?.message || 'Could not list SharePoint documents';
              push('tessa', `I couldn't fetch documents from SharePoint: ${msg}. Please try again.`);
            }
          }
          return;
        }
      } catch {}
      // Not connected — redirect to System Configuration
      push('tessa', `${label} isn't configured yet. Please set up the connection under System Configuration first.`);
    }
    } finally {
      pickInFlight.current = false;
    }
  };

  /* --- Azure DevOps: fetch open stories/tasks (→ generate) --- */
  const adoFetchStories = async () => {
    try {
      const storiesArr = await getAzureDevopsStories();
      const list = (Array.isArray(storiesArr) ? storiesArr : []).map((w: any) => ({
        key: w.key,
        summary: w.type ? `${w.type}: ${w.summary}` : w.summary,
        title: w.summary,
        description: '',
      }));
      setStories(list);
      if (list.length === 0) {
        push('tessa', "I couldn't find any open stories or tasks on your Azure DevOps board. Items that are done or closed aren't shown here.");
        return;
      }
      push('tessa', `I found ${list.length} open ${list.length === 1 ? 'work item' : 'work items'} on your Azure DevOps board. Please select one to generate test cases.`);
      setStep('content-select');
    } catch (err: any) {
      const data = err?.response?.data;
      const status = data?.status ?? err?.response?.status;
      const msg = data?.error || err?.message || 'Could not fetch work items';
      push('tessa', `I couldn't reach Azure DevOps${status ? ` (error ${status})` : ''}: ${msg}. Please try again.`);
    }
  };

  /* --- Azure DevOps: import existing Test Case work items (with their steps) --- */
  const adoImportTestCases = async () => {
    push('tessa', 'Importing test cases from Azure DevOps...');
    try {
      const tcs = await getAzureDevopsTestCases();
      if (!Array.isArray(tcs) || tcs.length === 0) {
        push('tessa', "I couldn't find any Test Case work items in Azure DevOps. Please try the Stories option instead, or check the project/area path.");
        return;
      }
      const mapped = tcs.map((t, i) => {
        const steps = Array.isArray(t.steps) ? t.steps : [];
        return {
          id: t.key || `ADO-TC-${i + 1}`,
          traceabilityId: t.key || '',
          module: 'Azure DevOps',
          submodule: '',
          feature: '',
          title: t.title || `Test Case ${t.key || i + 1}`,
          scenario: t.title || `Test Case ${t.key || i + 1}`,
          description: '',
          precondition: '',
          testData: {},
          testSteps: steps.map((s) => ({ step: s.step, action: s.action, expected: s.expected })),
          steps: steps.map((s) => `${s.step}. ${s.action}${s.expected ? ` → Expected: ${s.expected}` : ''}`),
          expectedResult: steps.map((s) => s.expected).filter(Boolean).join('; '),
          type: 'positive',
          priority: 'P2',
          severity: '',
          tags: ['ADO'],
          status: 'imported',
        };
      });
      setResults({ testCases: mapped });
      setStoryMeta({ key: 'ADO', title: 'Azure DevOps Test Cases' });
      setTcPage(1);
      setSelectedTcIds(new Set());
      setEditingTcId(null);
      setGeneratedScripts([]);
      setGeneratedPageObjects([]);
      updatePipeline('requirements', 'completed', 'Imported from Azure DevOps');
      updatePipeline('test-design', 'completed', `${mapped.length} test cases imported`);
      push('tessa', `I imported ${mapped.length} test ${mapped.length === 1 ? 'case' : 'cases'} from Azure DevOps. Please review them, then click Save to continue to automation script generation.`);
      setStep('results');
    } catch (err: any) {
      const data = err?.response?.data;
      const status = data?.status ?? err?.response?.status;
      const msg = data?.error || err?.message || 'Could not import test cases';
      push('tessa', `I couldn't reach Azure DevOps${status ? ` (error ${status})` : ''}: ${msg}. Please try again.`);
    }
  };


  /* --- connection (kept for backward compat — inline connect forms are now handled via System Configuration) --- */
  const handleConnect = async () => {

    setIsConnecting(true);
    setConnectError('');

    try {
      if (source === 'jira') {
        // Real JIRA connection
        const connectRes = await connectJira(user?.username || 'admin', formValues.url, formValues.email, formValues.apiKey);
        const jiraName = connectRes?.displayName || 'JIRA';
        const storiesArr = await getJiraStories(user?.username || 'admin');
        // Backend returns StorySummary[] directly: [{key, summary, assignee}, ...]
        const list = Array.isArray(storiesArr) ? storiesArr : (storiesArr?.stories || storiesArr?.issues || []);
        setStories(list);
        const assignedCount = list.filter((s: any) => s.assignee).length;
        setJiraTab(assignedCount > 0 ? 'assigned' : 'unassigned');
        push('tessa', `Connected successfully as "${jiraName}". I found ${list.length} stories/tasks (${assignedCount} assigned, ${list.length - assignedCount} unassigned). Pick one from the Assigned tab, or assign an Unassigned one to get started.`);
        setStep('jira-stories');
      } else if (source === 'confluence' || source === 'sharepoint') {
        push('tessa', `${source === 'confluence' ? 'Confluence' : 'SharePoint'} document fetching isn't available yet. Please use JIRA, upload a document, or paste your requirements instead.`);
      }
    } catch (err: any) {
      setConnectError(err?.response?.data?.error || err?.message || 'Connection failed. Check credentials and try again.');
    } finally {
      setIsConnecting(false);
    }
  };

  /* --- content selection ---
     Branches on `source` to call the right per-provider detail endpoint:
       jira       → getJiraStoryDetails — title + description + acceptanceCriteria
       confluence → getConfluencePage   — body already converted to plain text
       sharepoint → getSharePointDocument — server-side extracted text from PDF/DOCX
     Whatever each returns is stitched into pendingRequirements and the
     wizard proceeds to column-select exactly like the existing flow. */
  const handleStorySelect = async (storyKeyArg?: string) => {
    // Accept an explicit key (used by the post-assign auto-start, where the
    // selectedStory state hasn't flushed yet) or fall back to selectedStory.
    const key = storyKeyArg || selectedStory;
    if (!key) return;
    const item = stories.find(s => s.key === key);
    push('user', `${item?.key || key}: ${item?.title || item?.summary || key}`);
    setStoryMeta({ key: item?.key || key, title: item?.title || item?.summary || key });

    // GUARD: a story/task picked from JIRA or Azure DevOps needs an application
    // under test already set up in System Configuration → Application Setup.
    // Check right here, as soon as the story is picked, instead of waiting until
    // the user has also chosen columns and clicked Generate.
    if (source === 'jira' || source === 'azure-devops') {
      const configured = await isApplicationConfigured();
      if (!configured) {
        push('tessa', `I've noted "${item?.key}", but the application under test isn't configured yet. Please go to System Configuration → Application Setup, add your application (name + base URL), save it, then come back and pick this story again.`);
        return;
      }
    }

    // Default: use whatever lightweight info we already have in `item`.
    let requirements = `${item?.title || item?.summary || ''}\n${item?.description || ''}`.trim();

    try {
      if (source === 'jira') {
        const details = await getJiraStoryDetails(user?.username || 'admin', key);
        const title = details.title || details.summary || item?.summary || '';
        const desc = details.description || '';
        const ac = details.acceptanceCriteria || '';
        requirements = [title, desc, ac ? `Acceptance Criteria:\n${ac}` : ''].filter(Boolean).join('\n\n');
      } else if (source === 'azure-devops') {
        const details = await getAzureDevopsStoryDetails(key);
        const title = details.title || item?.title || item?.summary || '';
        const desc = details.description || '';
        const ac = details.acceptanceCriteria || '';
        requirements = [title, desc, ac ? `Acceptance Criteria:\n${ac}` : ''].filter(Boolean).join('\n\n');
      } else if (source === 'confluence') {
        const page = await getConfluencePage(key);
        if (!page.body || page.body.trim().length < 20) {
          throw new Error('Page is empty or too short to generate tests from.');
        }
        requirements = [page.title, page.body].filter(Boolean).join('\n\n');
      } else if (source === 'sharepoint') {
        const doc = await getSharePointDocument(key);
        if (!doc.text || doc.text.trim().length < 20) {
          throw new Error('Document parsed but contained no extractable text.');
        }
        const meta: string[] = [];
        if (doc.pageCount) meta.push(`${doc.pageCount} pages`);
        meta.push(`${doc.text.length.toLocaleString()} characters`);
        push('tessa', `I extracted ${meta.join(', ')} from ${doc.name}.`);
        requirements = [doc.name, doc.text].filter(Boolean).join('\n\n');
      }
    } catch (err: any) {
      const msg = err?.response?.data?.error || err?.message || 'Could not fetch details';
      push('tessa', `I couldn't load that item: ${msg}. Please select a different one or try another source.`);
      return;
    }

    setPendingRequirements(requirements);
    push('tessa', "Great! Please choose the columns you'd like in your test cases, then click Generate.");
    setStep('column-select');
  };

  /* --- JIRA: load the list of people once (shown as the per-row dropdown) --- */
  const loadAssignablePeople = async (issueKey?: string) => {
    if (assignableUsers.length > 0 || peopleLoading) return;
    setPeopleLoading(true);
    try {
      const users = await getJiraAssignableUsers(user?.username || 'admin', issueKey || '');
      setAssignableUsers(users);
    } catch (err: any) {
      const msg = err?.response?.data?.error || err?.message || 'Could not load Jira users';
      push('tessa', `I couldn't load the list of Jira people: ${msg}. You can still use "Assign to me".`);
    } finally {
      setPeopleLoading(false);
    }
  };

  /* --- JIRA: assign an unassigned story to a user → moves it to the Assigned tab
     (no auto-start; the user selects it and clicks Proceed when ready). --- */
  const assignStory = async (key: string, accountId: string, displayName?: string) => {
    if (!key || !accountId) return;
    setAssigningKey(key);
    setAssignLoading(true);
    try {
      const res = await assignJiraStory(user?.username || 'admin', key, accountId);
      const assignee = res.assignee || { accountId, displayName: displayName || accountId };
      // Move the story into the Assigned group locally (no full refetch) and
      // surface it: switch to the Assigned tab, clear any filter, and select it.
      setStories(prev => prev.map(s => (s.key === key ? { ...s, assignee } : s)));
      setJiraTab('assigned');
      setPersonFilter('');
      setSelectedStory(key);
      push('tessa', `Assigned ${key} to ${assignee.displayName}. It's now in the Assigned tab — select it and click Proceed to start automation.`);
    } catch (err: any) {
      const msg = err?.response?.data?.error || err?.message || 'Could not assign the story';
      push('tessa', `I couldn't assign ${key}: ${msg}. Please check your JIRA "Assign issues" permission and try again.`);
    } finally {
      setAssignLoading(false);
      setAssigningKey('');
    }
  };

  /* --- JIRA: "Assign to me" shortcut (unassigned → assign, moves to Assigned) --- */
  const assignToMe = async (key: string) => {
    setAssigningKey(key);
    setAssignLoading(true);
    try {
      const me = await getJiraCurrentUser(user?.username || 'admin');
      await assignStory(key, me.accountId, me.displayName);
    } catch (err: any) {
      const msg = err?.response?.data?.error || err?.message || 'Could not resolve your JIRA account';
      push('tessa', `I couldn't assign ${key} to you: ${msg}.`);
      setAssignLoading(false);
      setAssigningKey('');
    }
  };

  /* --- JIRA: reassign an already-assigned story to a different user (no auto-start) --- */
  const reassignStory = async (key: string, accountId: string, displayName?: string) => {
    if (!key || !accountId) return;
    setAssigningKey(key);
    setAssignLoading(true);
    try {
      const res = await assignJiraStory(user?.username || 'admin', key, accountId);
      const assignee = res.assignee || { accountId, displayName: displayName || accountId };
      setStories(prev => prev.map(s => (s.key === key ? { ...s, assignee } : s)));
      push('tessa', `Reassigned ${key} to ${assignee.displayName}.`);
    } catch (err: any) {
      const msg = err?.response?.data?.error || err?.message || 'Could not reassign the story';
      push('tessa', `I couldn't reassign ${key}: ${msg}. Please check your JIRA "Assign issues" permission and try again.`);
    } finally {
      setAssignLoading(false);
      setAssigningKey('');
    }
  };

  /* --- JIRA: reassign to me (no auto-start) --- */
  const reassignToMe = async (key: string) => {
    setAssigningKey(key);
    setAssignLoading(true);
    try {
      const me = await getJiraCurrentUser(user?.username || 'admin');
      await reassignStory(key, me.accountId, me.displayName);
    } catch (err: any) {
      const msg = err?.response?.data?.error || err?.message || 'Could not resolve your JIRA account';
      push('tessa', `I couldn't reassign ${key} to you: ${msg}.`);
      setAssignLoading(false);
      setAssigningKey('');
    }
  };

  /* --- JIRA: unassign a story completely → moves it to the Unassigned tab --- */
  const unassignStoryFn = async (key: string) => {
    if (!key) return;
    setAssigningKey(key);
    setAssignLoading(true);
    try {
      await unassignJiraStory(user?.username || 'admin', key);
      setStories(prev => prev.map(s => (s.key === key ? { ...s, assignee: null } : s)));
      if (selectedStory === key) setSelectedStory('');
      push('tessa', `Unassigned ${key}. It's now in the Unassigned tab.`);
    } catch (err: any) {
      const msg = err?.response?.data?.error || err?.message || 'Could not unassign the story';
      push('tessa', `I couldn't unassign ${key}: ${msg}. Please check your JIRA "Assign issues" permission and try again.`);
    } finally {
      setAssignLoading(false);
      setAssigningKey('');
    }
  };

  /* --- file upload (real) ---
     Sends the chosen file to POST /api/document/extract, which runs
     pdf-parse / mammoth on the buffer and returns the plain-text contents.
     The extracted text becomes the pendingRequirements that the pipeline
     analyses. No mocking, no placeholders. */
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [uploadInProgress, setUploadInProgress] = useState(false);
  const [uploadError, setUploadError] = useState<string>('');

  const openFilePicker = () => {
    setUploadError('');
    fileInputRef.current?.click();
  };

  const handleFileSelected = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    // Reset the input so the same file can be re-selected if the user cancels.
    e.target.value = '';
    if (!file) return;

    setUploadError('');
    setUploadInProgress(true);
    push('user', `Uploading: ${file.name} (${(file.size / 1024).toFixed(1)} KB)`);

    try {
      const result = await extractDocumentText(file);
      if (!result.text || result.text.trim().length < 20) {
        throw new Error('Document parsed but contained too little text to generate tests from.');
      }
      setPendingRequirements(result.text);
      const stats = [
        `${result.characterCount.toLocaleString()} characters`,
        result.pageCount ? `${result.pageCount} pages` : null,
      ].filter(Boolean).join(', ');
      const warn = result.warning ? ` (Note: ${result.warning})` : '';
      push('tessa', `Got it! I extracted ${stats} from ${file.name}.${warn} Please choose the columns you'd like, then click Generate.`);
      setStep('column-select');
    } catch (err: any) {
      const msg = err?.response?.data?.error || err?.message || 'Upload failed';
      setUploadError(msg);
      push('tessa', `I couldn't read that file: ${msg}. Please try a different file.`);
    } finally {
      setUploadInProgress(false);
    }
  };

  /* --- text paste --- */
  const handleTextSubmit = () => {
    if (!pasteText.trim()) return;
    push('user', pasteText.trim().length > 100 ? pasteText.trim().slice(0, 100) + '...' : pasteText.trim());
    setPendingRequirements(pasteText.trim());
    push('tessa', "Requirements received! Please choose the columns you'd like in your test cases, then click Generate.");
    setStep('column-select');
  };

  /* --- explore submit ---
     The user has given us only a URL (optionally with credentials). We stash
     an "EXPLORE_MODE" marker into pendingRequirements so runGeneration knows
     to call the backend with exploreMode=true; the marker itself is never
     sent — runGeneration unpacks it back into structured options. */
  const handleExploreSubmit = () => {
    if (!exploreUrl.trim() || !explorePrompt.trim()) return;
    const base = exploreUsername
      ? `Explore ${exploreUrl} as ${exploreUsername}`
      : `Explore ${exploreUrl} (anonymous)`;
    const summary = explorePrompt.trim()
      ? `${base} — focus: ${explorePrompt.trim()}`
      : base;
    push('user', summary);
    // The literal placeholder is what we'll show in the column-select UI;
    // the real backend call uses exploreMode + roles, not this text.
    setPendingRequirements(`__EXPLORE__:${exploreUrl}`);
    push('tessa', "Got it! I'll explore the application, identify its features, and generate test cases. Please choose the columns you'd like, then click Generate.");
    setStep('column-select');
  };

  /* --- API form submit --- */
  const handleApiSubmit = () => {
    if (!apiUrl.trim()) return;
    const summary = `${apiMethod} ${apiUrl}`;
    push('user', summary);
    setPendingRequirements(`API Testing: ${apiMethod} ${apiUrl} - ${subCategory}`);
    push('tessa', "API details received! Please choose the columns you'd like in your test cases, then click Generate.");
    setStep('column-select');
  };

  /* --- generation pipeline (only TC generation, not full pipeline) --- */
  const runGeneration = async (requirements: string, explicitAppId?: string) => {
    // Starting a generation begins a new logical flow — bump the id so any
    // previous still-running generation becomes stale, and remember ours.
    const flowId = ++flowIdRef.current;

    // GUARD: Requirement Analysis must target a configured application. Explore
    // mode supplies the app URL inline; every other source (JIRA, upload,
    // manual, API) requires an application set up in System Configuration →
    // Application Setup. Check BEFORE any pipeline work so the user gets a clear
    // message instead of a failed run. The backend enforces the same rule.
    //
    // When more than one application is configured, "any application exists"
    // is not enough — the SPECIFIC application these requirements target must
    // be identified, or generation/scripts/execution silently ground
    // themselves in whichever application the server happens to pick. If we
    // don't already know which one (explicitAppId from a just-completed
    // app-select pick, or a previously selected one), ask before proceeding.
    const isExploreFlow = source === 'explore' || requirements.startsWith('__EXPLORE__:');
    let appIdToUse = explicitAppId || selectedAppId || undefined;
    if (!isExploreFlow) {
      const apps = await getReadyApps();
      if (apps !== null) {
        if (apps.length === 0) {
          push('tessa', 'Before I can start Requirement Analysis, please configure your application under test in System Configuration → Application Setup (application name, base URL, and test-user roles). Once it’s saved, come back and click Generate again.');
          setStep('column-select');
          return;
        }
        if (!appIdToUse) {
          if (apps.length === 1) {
            appIdToUse = apps[0].integrationId;
            setSelectedAppId(appIdToUse);
          } else {
            setAppOptions(apps);
            setPendingGenRequirements(requirements);
            push('tessa', 'You have more than one application configured under System Configuration → Application Setup. Which application are these test cases for?');
            setStep('app-select');
            return;
          }
        }
      }
    }

    const steps: AgentStep[] = AGENTS.map(a => ({ name: a.name, status: 'pending' as const, detail: a.detail }));
    setAgentSteps(steps);

    // Pipeline: Stage 1 → running
    updatePipeline('requirements', 'running', 'Analyzing requirements...');

    // Agent 1: Requirement Analyst
    setAgentSteps(prev => prev.map((s, idx) => idx === 0 ? { ...s, status: 'running' } : s));
    let res: any = null;
    let genErr: any = null;
    try {
      // Detect explore-mode marker stashed by handleExploreSubmit.
      // When present, route to the backend with exploreMode=true and roles
      // instead of sending the marker string as actual requirements.
      const isExplore = source === 'explore' || requirements.startsWith('__EXPLORE__:');
      if (isExplore) {
        const roles = exploreUsername
          ? [{ roleName: 'user', username: exploreUsername, password: explorePassword }]
          : undefined;
        res = await generateTests('', subCategory || undefined, {
          exploreMode: true,
          targetUrl: exploreUrl,
          appName: exploreAppName || undefined,
          explorePrompt: explorePrompt.trim() || undefined,
          roles,
        });
      } else {
        res = await generateTests(requirements, subCategory || undefined, { appId: appIdToUse });
      }
    } catch (err) {
      console.error('Generate tests failed:', err);
      genErr = err;
    }

    // The flow was discarded (New chat) or superseded while we were waiting —
    // this response belongs to a dead flow. Drop it without touching state.
    if (flowId !== flowIdRef.current) return;

    // A failed request is NOT "no test cases" — surface the real reason and
    // return the user to the start of the wizard.
    if (genErr) {
      const msg = genErr?.response?.data?.error
        || (genErr?.code === 'ECONNABORTED' ? 'The generation request timed out.' : '')
        || genErr?.message
        || 'Test generation failed';
      updatePipeline('requirements', 'skipped', msg);
      updatePipeline('test-design', 'skipped', 'Generation failed');
      push('tessa', `Test generation failed: ${msg}. Please try again.`);
      setStep('welcome');
      return;
    }

    // Track pipeline run
    if (res?.runId) {
      setCurrentRunId(res.runId);
      setPipelineMode(res.mode || 'sync');
    }

    setAgentSteps(prev => prev.map((s, idx) => idx === 0 ? { ...s, status: 'completed' } : s));

    // Pipeline: Stage 1 → completed
    updatePipeline('requirements', 'completed', res?.summary?.features?.join(', ') || 'Completed');

    // Pipeline: Stage 2 → running
    updatePipeline('test-design', 'running', 'Generating test cases...');

    // Agent 2: Test Case Generator — backend has already produced the cases
    // synchronously above; we just reflect the real status, no artificial wait.
    setAgentSteps(prev => prev.map((s, idx) => idx === 1 ? { ...s, status: 'running' } : s));
    setAgentSteps(prev => prev.map((s, idx) => idx === 1 ? { ...s, status: 'completed' } : s));

    // Map backend test cases from the real pipeline. The backend now emits
    // the IEEE-829 shape (title, description, testSteps with per-step expected,
    // testData, severity, traceabilityId). We keep the legacy aliases so the
    // existing render code and exports continue to work unchanged.
    let testCases: any[] = [];
    if (res?.testCases?.length) {
      testCases = res.testCases.map((tc: any, i: number) => ({
        id: tc.id || `TC-${String(i + 1).padStart(3, '0')}`,
        traceabilityId: tc.traceabilityId || '',
        module: tc.module || '',
        submodule: tc.submodule || '',
        feature: tc.feature || '',
        title: tc.title || tc.scenario || tc.name || 'Test scenario',
        scenario: tc.scenario || tc.title || tc.name || 'Test scenario',
        description: tc.description || '',
        precondition: tc.precondition || '',
        testData: tc.testData || {},
        testSteps: Array.isArray(tc.testSteps) ? tc.testSteps : [],
        // String steps are kept populated for the existing UI column
        steps: Array.isArray(tc.steps) && tc.steps.length
          ? tc.steps
          : Array.isArray(tc.testSteps)
            ? tc.testSteps.map((s: any, idx: number) =>
                `${s.step ?? idx + 1}. ${s.action}${s.expected ? ` → Expected: ${s.expected}` : ''}`)
            : [],
        expectedResult: tc.expectedResult || tc.expected || '',
        type: tc.type || tc.category || 'positive',
        priority: tc.priority || 'P1',
        severity: tc.severity || '',
        tags: Array.isArray(tc.tags) ? tc.tags : [],
        status: tc.status || 'generated',
      }));
    }

    if (!testCases.length) {
      const parsedFeatures: string[] = res?.summary?.features || [];
      const parsedFlows: string[] = res?.summary?.flows || [];
      const detail =
        parsedFeatures.length || parsedFlows.length
          ? ` Parsed features: ${parsedFeatures.join(', ') || '(none)'}. Flows: ${parsedFlows.join(', ') || '(none)'}.`
          : '';
      const warn = res?.warning === 'no_test_cases_generated' ? ' (backend returned no_test_cases_generated)' : '';
      push(
        'tessa',
        `The pipeline didn't return any test cases${warn}.${detail} Please try a more specific requirement or a different story.`
      );
      updatePipeline('test-design', 'skipped', 'No test cases generated');
      setStep('welcome');
      return;
    }

    setResults({ testCases });
    setTcPage(1);
    setSelectedTcIds(new Set());
    setEditingTcId(null);

    // The generation pipeline already produced Playwright scripts (scriptAgent
    // runs as part of /generate). Capture them now — aligned to these exact
    // test-case ids — so the Script Generation stage can reuse them instead of
    // re-running the whole pipeline. Backend field is `automationScripts`.
    const genScripts: any[] = Array.isArray(res?.automationScripts) ? res.automationScripts : [];
    setGeneratedScripts(
      genScripts.map((s: any) => ({
        testCaseId: s.testCaseId || s.testCase_id,
        fileName: s.fileName || s.file_name || `${s.testCaseId}.spec.ts`,
        code: s.code || s.script || '',
        path: s.path,
        uses: s.uses,
      })).filter((s: any) => s.testCaseId && s.code),
    );
    // Capture the POM page objects too — without these, execution can't resolve
    // the specs' imports ("Cannot find module …/pages/…").
    setGeneratedPageObjects(Array.isArray(res?.pageObjects) ? res.pageObjects : []);

    // Pipeline: Stage 2 → completed with count
    updatePipeline('test-design', 'completed', `${testCases.length} test cases generated`);

    push('tessa', `I generated ${testCases.length} test cases using the AI pipeline (${res?.mode === 'async' ? 'Claude AI' : 'local agents'}). Please review, edit, or delete them as needed, then click Save when you're ready.`);
    setStep('results');
  };

  /* --- application pick (only shown when >1 application is configured) ---
     Resumes the generation that paused in runGeneration() waiting for the
     user to say which configured application these requirements are for. */
  const handleAppSelected = (integrationId: string) => {
    const app = appOptions.find(a => a.integrationId === integrationId);
    push('user', app?.appName || integrationId);
    setSelectedAppId(integrationId);
    setStep('generating');
    runGeneration(pendingGenRequirements, integrationId);
  };

  /* --- Save test cases to DB --- */
  const handleSaveTestCases = async () => {
    if (!results?.testCases?.length) return;
    setIsSaving(true);
    try {
      const res = await saveTestCases({
        username: user?.username || 'admin',
        storyKey: storyMeta.key,
        storyTitle: storyMeta.title,
        source: source || undefined,
        columns: selectedColumns,
        testCases: results.testCases,
      });
      setSavedTestRunId(res.testRunId);
      push('tessa', `${results.testCases.length} test cases saved successfully! You can now export them or continue to automation script generation.`);
      toast.success('Saved successfully');
      setStep('saved');
    } catch (err) {
      console.error('Save failed:', err);
      push('tessa', "I couldn't save the test cases. Please try again.");
    } finally {
      setIsSaving(false);
    }
  };

  /* --- Export --- */
  const handleExport = async (format: string) => {
    if (!savedTestRunId) return;
    setIsExporting(true);
    try {
      const response = await exportTestCases(savedTestRunId, format);
      const disposition = response.headers['content-disposition'] || '';
      const match = disposition.match(/filename="?([^"]+)"?/);
      const filename = match?.[1] || `testcases.${format === 'excel' ? 'csv' : 'csv'}`;
      const url = window.URL.createObjectURL(new Blob([response.data]));
      const link = document.createElement('a');
      link.href = url;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.URL.revokeObjectURL(url);
      toast.success('Exported successfully');
    } catch (err) {
      console.error('Export failed:', err);
      toast.fromError(err);
    } finally {
      setIsExporting(false);
    }
  };

  /* --- Script generation (Stage 3 ONLY) --- */
  const handleScriptGeneration = async () => {
    const flowId = flowIdRef.current;
    const testCases = results?.testCases || [];
    if (testCases.length === 0) return;

    push('tessa', `Generating automation scripts for ${testCases.length} test cases...`);
    await waitForSpeech(); // Let Tessa finish speaking before starting execution
    if (flowId !== flowIdRef.current) return; // flow discarded while speaking
    setControl('idle'); // clear any prior stop/pause before a fresh run
    setStep('script-generating');

    const steps: AgentStep[] = [{ name: 'Script Writer', status: 'pending' as const, detail: 'Analyzing test cases and producing automation scripts' }];
    setAgentSteps(steps);

    // Pipeline: Stage 3 → running
    updatePipeline('script-gen', 'running', 'Producing automation scripts...');
    setAgentSteps([{ name: 'Script Writer', status: 'running', detail: 'Analyzing test cases and producing automation scripts' }]);

    // Reuse the scripts captured during generation when they already cover the
    // non-data test cases on screen (the common path — user didn't edit). Only
    // when coverage is incomplete (edits, additions) do we regenerate, and even
    // then we generate scripts ONLY — never re-run the whole pipeline, so the
    // testCaseIds stay aligned with what the user reviewed/saved.
    const eligibleIds = testCases.filter((tc: any) => tc.type !== 'data').map((tc: any) => tc.id);
    const haveIds = new Set(generatedScripts.map((s) => s.testCaseId));
    const covered = eligibleIds.length > 0 && eligibleIds.every((id: string) => haveIds.has(id));

    let scripts: any[] = generatedScripts;
    let pageObjects: any[] = generatedPageObjects;
    if (!covered) {
      try {
        const scriptRes = await generateScripts(testCases, selectedAppId || undefined, undefined, pipelineController);
        if (flowId !== flowIdRef.current) return; // flow discarded while generating
        scripts = (scriptRes?.scripts || []).map((s: any) => ({
          testCaseId: s.testCaseId,
          fileName: s.fileName || `${s.testCaseId}.spec.ts`,
          code: s.code,
          path: s.path,
          uses: s.uses,
        }));
        pageObjects = Array.isArray(scriptRes?.pageObjects) ? scriptRes.pageObjects : [];
      } catch (err: any) {
        if (flowId !== flowIdRef.current) return; // flow discarded while generating
        // Surface the REAL server error instead of silently proceeding with 0
        // scripts. The reason is also printed in the backend terminal as
        // "[pipeline-flow/scripts] error: …".
        const msg = err?.response?.data?.error || err?.message || 'Script generation failed';
        console.error('Script generation API failed:', err);
        updatePipeline('script-gen', 'skipped', msg);
        setAgentSteps([{ name: 'Script Writer', status: 'completed', detail: `Failed: ${msg}` }]);
        push('tessa', `Script generation failed: ${msg}. Please try again.`);
        setStep('results');
        return;
      }
    }

    // No scripts came back even though the call succeeded — don't pretend it
    // worked. Send the user back to the test cases to retry.
    if (scripts.length === 0) {
      const msg = 'No automation scripts were produced for these test cases.';
      updatePipeline('script-gen', 'skipped', msg);
      setAgentSteps([{ name: 'Script Writer', status: 'completed', detail: msg }]);
      push('tessa', `${msg} Please try again, or check the backend logs for details.`);
      setStep('results');
      return;
    }

    setGeneratedScripts(scripts);
    setGeneratedPageObjects(pageObjects);
    setSelectedScriptIdx(0);

    // Pipeline: Stage 3 → completed
    setAgentSteps([{ name: 'Script Writer', status: 'completed', detail: 'Automation scripts generated' }]);
    updatePipeline('script-gen', 'completed', `${scripts.length} scripts created`);

    push('tessa', `I generated ${scripts.length} automation scripts. Please review the code below, then click "Execute Test Suite" to run them.`);
    setStep('script-review');
  };

  /* --- Execute Tests (Stage 4) --- */
  const handleExecuteTests = async () => {
    const flowId = flowIdRef.current;
    // Runs against the Application configured in System Configuration → Application
    // Setup (resolved server-side). If none is configured, the backend reports
    // executed:false and we surface that gracefully — no blocking URL prompt.
    push('tessa', 'Executing your test suite in the staging environment...');
    await waitForSpeech();
    if (flowId !== flowIdRef.current) return; // flow discarded while speaking
    setControl('idle'); // clear any prior stop/pause before a fresh run
    setStep('executing');

    // Pipeline: Stage 4 → running
    updatePipeline('execution', 'running', 'Running tests...');

    // Initialize all tests as pending
    const initialResults = generatedScripts.map(s => ({
      testCaseId: s.testCaseId,
      testName: s.fileName.replace('.spec.ts', ''),
      status: 'pending' as const,
      duration: '',
      error: undefined as string | undefined,
    }));
    setExecutionResults([...initialResults]);
    setExpandedResults(new Set());

    // Execute the SAME scripts the user reviewed against the application
    // configured in System Configuration → Application Setup (resolved
    // server-side). Details come back keyed to these exact testCaseIds.
    // Wall-clock the execution stage. The per-test duration sum undercounts
    // badly (tests run in parallel workers, and tests with no result contribute
    // 0), which showed "0s" execution time for minutes-long runs.
    const execStartedAt = Date.now();
    let execRes: Awaited<ReturnType<typeof executePipeline>> | null = null;
    try {
      // Pass the saved run id so the Allure report is built for that run and
      // appears on the Reports page.
      execRes = await executePipeline(results?.testCases || [], generatedScripts, generatedPageObjects, selectedAppId || undefined, savedTestRunId || undefined, undefined, pipelineController);
    } catch (err) {
      console.error('Execute tests failed:', err);
    }
    const execWallMs = Date.now() - execStartedAt;
    if (flowId !== flowIdRef.current) return; // flow discarded while executing

    // When no application is configured (or no URL), the backend runs nothing
    // and says so. Surface that clearly and let the user continue to the report
    // rather than leaving the stage spinning.
    if (execRes && execRes.summary && execRes.summary.executed === false) {
      const reason = execRes.summary.reason || 'No target application configured.';
      const allNotRun = initialResults.map((row) => ({
        ...row, status: 'not_run' as const, duration: '', error: reason,
      }));
      setExecutionResults(allNotRun);
      setExecutionSummary({ total: allNotRun.length, passed: 0, failed: 0, duration: formatHMS(execWallMs), durationMs: execWallMs });
      updatePipeline('execution', 'skipped', 'Not run — no target app');
      push('tessa', `I couldn't run the tests: ${reason} Please add your application's Base URL under System Configuration → Application Setup, or continue to the report with the generated suite.`);
      setStep('execution-results');
      return;
    }

    if (execRes?.app?.name) {
      push('tessa', `Running the test suite against "${execRes.app.name}"${execRes.app.targetUrl ? ` (${execRes.app.targetUrl})` : ''}...`);
    }

    // ─────────────────────────────────────────────────────────────
    // Map backend's REAL execution details onto our local result rows.
    // No artificial delays. No fabricated durations. No index-based
    // fake pass/fail inference. If the backend says a test was not
    // run, we show "not_run" — we do NOT pretend it passed.
    // ─────────────────────────────────────────────────────────────
    const backendDetails: any[] = Array.isArray(execRes?.executionDetails) ? execRes!.executionDetails : [];
    const detailByTcId = new Map<string, any>(backendDetails.map((d) => [d.testCaseId, d]));

    let passed = 0;
    let failed = 0;
    let notRun = 0;
    const finalResults = initialResults.map((row) => {
      const d = detailByTcId.get(row.testCaseId);
      if (!d) {
        // Backend produced no details for this script. Either Playwright
        // crashed entirely or the script wasn't picked up. Mark honestly.
        notRun++;
        return { ...row, status: 'not_run' as const, duration: '', error: execRes?.failureReason || 'No execution result returned by backend' };
      }
      // Format the real duration from milliseconds → "1.2s" — only when present.
      const duration = typeof d.durationMs === 'number'
        ? `${(d.durationMs / 1000).toFixed(2)}s`
        : '';
      if (d.status === 'passed') {
        passed++;
        return { ...row, status: 'passed' as const, duration, error: undefined };
      }
      if (d.status === 'failed') {
        failed++;
        return { ...row, status: 'failed' as const, duration, error: d.error || 'Test failed (no error message returned)' };
      }
      // 'skipped' or 'not_run' from backend
      notRun++;
      return { ...row, status: 'not_run' as const, duration, error: undefined };
    });
    setExecutionResults(finalResults);

    // Report the REAL wall-clock time of the execution stage. Summing per-test
    // durations is wrong twice over: parallel workers overlap (sum ≠ elapsed),
    // and tests without a result sum to 0s even after a minutes-long run.
    setExecutionSummary({ total: finalResults.length, passed, failed, duration: formatHMS(execWallMs), durationMs: execWallMs });

    // Pipeline: Stage 4 → completed
    updatePipeline('execution', 'completed', `${passed}/${finalResults.length} passed`);

    if (failed > 0) {
      push('tessa', `Execution complete: ${passed} of ${finalResults.length} tests passed and ${failed} failed. You can auto-heal the failing tests or continue to the report.`);
    } else if (passed === 0) {
      // Nothing actually ran (e.g. backend returned no details). Don't pretend
      // a green run — tell the user honestly so they can investigate.
      const reason = execRes?.failureReason ? ` ${execRes.failureReason}` : '';
      push('tessa', `No tests were executed — ${notRun} of ${finalResults.length} couldn't run.${reason} Please check the target application configuration and the generated scripts, then try again.`);
    } else {
      push('tessa', `All ${passed} tests passed! You can now generate the execution report.`);
    }

    // Auto-register failures in the Bug Tracker as soon as the run finishes —
    // before any healing — so failing tests are tracked even if the user never
    // heals or proceeds to the report. Healing later reclassifies healed ones
    // to flaky via the same upsert key.
    if (failed > 0) void registerRunBugs(finalResults, []);

    setStep('execution-results');
  };

  /* --- Auto-Heal (Stage 5) --- */
  const handleAutoHeal = async () => {
    const flowId = flowIdRef.current;
    const failedTests = executionResults.filter(r => r.status === 'failed');
    if (failedTests.length === 0) return;

    const attempt = healingAttempt + 1;
    setHealingAttempt(attempt);
    setControl('idle'); // clear any prior stop/pause before a fresh heal run
    setStep('healing');

    push('tessa', `Auto-healing attempt ${attempt}: fixing ${failedTests.length} failing test(s)...`);
    await waitForSpeech(); // Let Tessa finish speaking before starting healing
    if (flowId !== flowIdRef.current) return; // flow discarded while speaking

    // Pipeline: Stage 5 → running
    updatePipeline('auto-healing', 'running', `Healing attempt ${attempt}...`);

    // Call the real backend heal+re-execute endpoint with the SAME test cases
    // and scripts. The backend heals the failing scripts, re-runs the whole
    // suite, and returns fresh results aligned to these testCaseIds — no
    // fabricated "all healed" outcomes.
    const healStartedAt = Date.now();
    let healRes: Awaited<ReturnType<typeof healPipeline>> | null = null;
    let healErr = '';
    try {
      const detailsPayload = executionResults.map((r) => ({
        testCaseId: r.testCaseId,
        status: r.status,
        error: r.error,
      }));
      healRes = await healPipeline(results?.testCases || [], generatedScripts, detailsPayload, generatedPageObjects, selectedAppId || undefined, savedTestRunId || undefined, undefined, pipelineController);
    } catch (err: any) {
      // Surface the REAL reason instead of a generic "could not be reached".
      // The backend also logs it as "[pipeline-flow/heal] error: …".
      console.error('Healing API call failed:', err);
      healErr =
        err?.response?.data?.error ||
        (err?.code === 'ECONNABORTED' ? 'The healing run timed out.' : '') ||
        err?.message ||
        '';
    }
    if (flowId !== flowIdRef.current) return; // flow discarded while healing

    if (!healRes) {
      updatePipeline('auto-healing', 'completed', 'Healing unavailable');
      push('tessa', `Auto-healing couldn't complete${healErr ? `: ${healErr.replace(/\.+$/, '')}` : ' — the healing service could not be reached'}. You can retry, or continue to the report with the current results.`);
      setStep('execution-results');
      return;
    }

    // Persist the healed scripts so the report / publish steps reflect the fixes.
    if (Array.isArray(healRes.scripts) && healRes.scripts.length) {
      setGeneratedScripts(healRes.scripts);
    }
    if (Array.isArray(healRes.pageObjects) && healRes.pageObjects.length) {
      setGeneratedPageObjects(healRes.pageObjects);
    }

    const healLog = Array.isArray(healRes.healingLog) ? healRes.healingLog : [];
    setHealingLog(healLog);
    const healedCount = healLog.filter((l) => l.result === 'fixed').length;
    updatePipeline('auto-healing', 'completed', `Healed ${healedCount}/${failedTests.length}`);

    push('tessa', 'Re-running the healed tests and recording the results...');
    updatePipeline('execution', 'running', 'Recording healed results...');

    // Rebuild the execution table from the re-execution details (aligned by id).
    const healByTcId = new Map<string, any>((healRes.executionDetails || []).map((d) => [d.testCaseId, d]));
    const updatedResults = executionResults.map((row) => {
      const d = healByTcId.get(row.testCaseId);
      if (!d) return row;
      const duration = typeof d.durationMs === 'number' ? `${(d.durationMs / 1000).toFixed(2)}s` : row.duration;
      if (d.status === 'passed') return { ...row, status: 'passed' as const, duration, error: undefined };
      if (d.status === 'failed') return { ...row, status: 'failed' as const, duration, error: d.error || row.error };
      return { ...row, status: 'not_run' as const, duration };
    });
    setExecutionResults(updatedResults);
    setExpandedResults(new Set());

    const newPassed = healRes.summary?.passed ?? updatedResults.filter((r) => r.status === 'passed').length;
    const newFailed = healRes.summary?.failed ?? updatedResults.filter((r) => r.status === 'failed').length;
    const totalSec = updatedResults.reduce((sum, r) => {
      const v = parseFloat(r.duration || '0');
      return sum + (Number.isFinite(v) ? v : 0);
    }, 0);
    // Prefer the per-test sum from the re-run; when no test reported a duration
    // (nothing executed), fall back to the heal stage's real wall-clock time so
    // the report never shows a bogus 0s.
    const healMs = totalSec > 0 ? totalSec * 1000 : Date.now() - healStartedAt;
    setExecutionSummary({ total: updatedResults.length, passed: newPassed, failed: newFailed, duration: formatHMS(healMs), durationMs: healMs });
    updatePipeline('execution', 'completed', `${newPassed}/${updatedResults.length} passed`);

    if (newFailed > 0 && attempt < 2) {
      push('tessa', `Re-execution complete: ${newFailed} test(s) are still failing. You can run another auto-healing cycle or continue to the report.`);
    } else if (newFailed > 0) {
      push('tessa', `Maximum auto-healing attempts reached — ${newFailed} test(s) are still failing. Use "Report to Support" to notify your team (email / Slack / Teams), or continue to the report.`);
    } else {
      push('tessa', 'All tests are passing after auto-healing! You can now generate the execution report.');
    }
    // Auto-register the outcomes in the Bug Tracker: still-failing → failure,
    // failed-then-healed → flaky. Fire-and-forget so it never blocks the flow.
    void registerRunBugs(updatedResults, healLog);

    setStep('execution-results');
  };

  /* --- Auto-register failures / flaky tests as bugs ---
     Classifies each affected test and upserts it into the Bug Tracker via the
     backend (keyed by testRunId + testCaseId so repeated cycles never
     duplicate). Needs a saved run id for the dedup/persistence key. */
  const registerRunBugs = async (
    rows: typeof executionResults,
    healLog: { testCaseId: string; error: string; fix: string; result: string }[],
  ): Promise<{ created: number; updated: number } | null> => {
    if (!savedTestRunId) return null;
    const healedById = new Map(
      healLog.filter((l) => l.result === 'fixed').map((l) => [l.testCaseId, l]),
    );
    type RunBugItem = { testCaseId: string; testName: string; bugType: 'failure' | 'flaky'; error?: string; fix?: string };
    const items: RunBugItem[] = [];
    for (const r of rows) {
      if (r.status === 'failed') {
        items.push({ testCaseId: r.testCaseId, testName: r.testName, bugType: 'failure', error: r.error });
      } else if (r.status === 'passed' && healedById.has(r.testCaseId)) {
        // A test that passed but was healed on the way is flaky.
        const log = healedById.get(r.testCaseId)!;
        items.push({ testCaseId: r.testCaseId, testName: r.testName, bugType: 'flaky', error: log.error, fix: log.fix });
      }
    }
    if (items.length === 0) return null;
    try {
      const res = await registerBugsFromRun({ testRunId: savedTestRunId, items });
      const n = (res.created || 0) + (res.updated || 0);
      if (n > 0) {
        const failures = items.filter((i) => i.bugType === 'failure').length;
        const flaky = items.filter((i) => i.bugType === 'flaky').length;
        const parts = [
          failures ? `${failures} failure${failures > 1 ? 's' : ''}` : '',
          flaky ? `${flaky} flaky` : '',
        ].filter(Boolean).join(' and ');
        push('tessa', `Logged ${parts} in the Bug Tracker — open it to triage, or re-run flaky / failing tests separately from there.`);
      }
      return { created: res.created, updated: res.updated };
    } catch (err) {
      console.error('Bug auto-registration failed:', err);
      return null;
    }
  };

  /* --- Re-run only the failing OR only the flaky tests, in place ---
     Re-executes just that subset of the reviewed scripts and merges the fresh
     results back into the table, then re-registers the affected bugs. */
  const handleRerunSubset = async (kind: 'failure' | 'flaky') => {
    if (rerunKind) return;
    const flowId = flowIdRef.current;
    const healedIds = new Set(
      healingLog.filter((l) => l.result === 'fixed').map((l) => l.testCaseId),
    );
    const targets = executionResults.filter((r) =>
      kind === 'failure'
        ? r.status === 'failed'
        : r.status === 'passed' && healedIds.has(r.testCaseId),
    );
    if (targets.length === 0) return;
    const targetIds = new Set(targets.map((r) => r.testCaseId));
    const subsetScripts = generatedScripts.filter((s) => targetIds.has(s.testCaseId));
    if (subsetScripts.length === 0) return;
    const subsetTestCases = (results?.testCases || []).filter((tc: any) =>
      targetIds.has(tc.id) || targetIds.has(tc.testCaseId));

    setRerunKind(kind);
    push('tessa', `Re-running ${targets.length} ${kind === 'flaky' ? 'flaky' : 'failing'} test${targets.length > 1 ? 's' : ''}...`);
    // Mark the targeted rows as running so the table reflects the in-flight subset.
    setExecutionResults((prev) => prev.map((r) =>
      targetIds.has(r.testCaseId) ? { ...r, status: 'running' as const, error: undefined } : r));

    let execRes: Awaited<ReturnType<typeof executePipeline>> | null = null;
    try {
      execRes = await executePipeline(subsetTestCases, subsetScripts, generatedPageObjects, selectedAppId || undefined, savedTestRunId || undefined);
    } catch (err) {
      console.error('Subset re-run failed:', err);
    }
    if (flowId !== flowIdRef.current) { setRerunKind(''); return; }

    const details: any[] = Array.isArray(execRes?.executionDetails) ? execRes!.executionDetails : [];
    const byId = new Map<string, any>(details.map((d) => [d.testCaseId, d]));
    // Merge fresh outcomes for the targeted rows onto the CURRENT table.
    const merged = executionResults.map((r) => {
      if (!targetIds.has(r.testCaseId)) return r;
      const d = byId.get(r.testCaseId);
      if (!d) return { ...r, status: 'not_run' as const, error: 'No result returned on re-run' };
      const duration = typeof d.durationMs === 'number' ? `${(d.durationMs / 1000).toFixed(2)}s` : r.duration;
      if (d.status === 'passed') return { ...r, status: 'passed' as const, duration, error: undefined };
      if (d.status === 'failed') return { ...r, status: 'failed' as const, duration, error: d.error || 'Test failed (no error message returned)' };
      return { ...r, status: 'not_run' as const, duration };
    });
    setExecutionResults(merged);
    const passed = merged.filter((r) => r.status === 'passed').length;
    const failed = merged.filter((r) => r.status === 'failed').length;
    setExecutionSummary((s) => (s ? { ...s, passed, failed } : s));

    // Refresh the Bug Tracker with the new outcomes for the re-run subset.
    // A flaky test that now passes cleanly (no heal this run) is no longer
    // flaky, but it stays registered; the user resolves it from the tracker.
    void registerRunBugs(merged, healingLog);

    const nowPassing = targets.filter((t) => byId.get(t.testCaseId)?.status === 'passed').length;
    const stillFailing = targets.length - nowPassing;
    push('tessa', `Re-run complete: ${nowPassing} now passing, ${stillFailing} still ${kind === 'flaky' ? 'flaky/failing' : 'failing'}.`);
    setRerunKind('');
  };

  /* --- Proceed to Report (Stage 6) --- */
  const handleProceedToReport = async () => {
    // If all tests passed on first run and no healing was done, mark auto-healing as skipped
    if (healingAttempt === 0 && (executionSummary?.failed || 0) === 0) {
      updatePipeline('auto-healing', 'skipped', 'Not needed — all tests passed');
    }

    // Pipeline: Stage 6 → running
    updatePipeline('report-gen', 'running', 'Generating report...');
    push('tessa', 'Generating your test execution report...');
    await waitForSpeech(); // Let Tessa finish speaking before generating report
    setStep('report');

    // No artificial wait — the report is built synchronously from existing state.
    const passRate = executionSummary && executionSummary.total > 0
      ? Math.round((executionSummary.passed / executionSummary.total) * 100)
      : 0;
    const notRun = executionResults.filter((r) => r.status === 'not_run').length;
    const failedCount = executionSummary?.failed || 0;

    setReportData({
      totalTests: executionSummary?.total || 0,
      passed: executionSummary?.passed || 0,
      failed: failedCount,
      notRun,
      healed: healingLog.filter(l => l.result === 'fixed').length,
      passRate,
      executionTime: executionSummary?.duration || '0s',
      // "Needed" is about the RESULTS, not just whether healing already ran:
      // failing (or unrunnable) tests still need attention.
      healingRequired: healingAttempt > 0 || failedCount > 0 || notRun > 0,
    });

    // Pipeline: Stage 6 → completed. This stage assembles the report from
    // existing state in ~0ms, so show the real test-run duration instead of
    // its own (near-zero) elapsed time.
    updatePipeline('report-gen', 'completed', `Report ready — ${passRate}% pass rate`, executionSummary?.durationMs);
    push('tessa', `Your test execution report is ready. Pass rate: ${passRate}%. ${healingAttempt > 0 ? `${healingLog.filter(l => l.result === 'fixed').length} test(s) were auto-healed.` : 'No auto-healing was needed.'}`);
  };

  /* --- Auto-populate git repo from System Configuration when entering publish step --- */
  useEffect(() => {
    if (step !== 'publish' || publishResult === 'success') return;

    (async () => {
      try {
        const result = await getConfigurations();
        const configs = result.configs || [];
        const PROVIDER_NAME: Record<string, string> = { github: 'GitHub', gitlab: 'GitLab', bitbucket: 'Bitbucket' };
        // All connected git-repo integrations. The /configurations payload has
        // no `category` field — match on the integration id instead.
        const repos: ConnectedRepo[] = configs
          .filter((c: any) => ['github', 'gitlab', 'bitbucket'].includes(c.integrationId) && c.status === 'connected')
          .map((c: any) => ({
            integrationId: c.integrationId,
            name: PROVIDER_NAME[c.integrationId] || c.integrationId,
            repoUrl: c.configData?.repo_url || c.configData?.org_url || '',
            branch: c.configData?.branch || 'main',
            scriptsPath: c.configData?.scripts_path || undefined,
          }));
        setConnectedRepos(repos);
        // Default the selection to the first connected repo (only if the user
        // hasn't already picked one this session).
        setSelectedRepoId((prev) => prev || (repos[0]?.integrationId ?? ''));
        if (repos[0]) {
          setGitRepoUrl(repos[0].repoUrl);
          setGitBranch(repos[0].branch);
        }
      } catch { /* ignore — the dropdown will simply show no connected repos */ }
    })();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step]);

  /* --- Create Pull Request (real) ---
     Calls POST /api/git/publish which opens a branch + commits the
     generated scripts + opens a real PR on GitHub / GitLab / Bitbucket
     using the user's connected git-repo integration credentials.
     We pass only the scripts; everything else (provider selection, repo
     URL, branch defaults) is resolved server-side from the integration. */
  const [publishedPrUrl, setPublishedPrUrl] = useState<string>('');
  const handlePublishToGit = async () => {
    if (generatedScripts.length === 0) {
      push('tessa', 'There are no scripts to publish yet.');
      return;
    }
    if (!selectedRepoId) {
      push('tessa', 'Please select a connected repository first, or connect one under System Configuration → Code Repositories.');
      return;
    }
    setIsPublishing(true);
    setPublishedPrUrl('');
    push('tessa', `Pushing ${generatedScripts.length} test script(s) to your Git repository...`);
    await waitForSpeech();
    try {
      const result = await publishToGit({
        // Ship the full POM: specs at their tests/<module> path + the shared page objects.
        scripts: generatedScripts.map((s) => ({ fileName: s.fileName, code: s.code, path: s.path })),
        pageObjects: generatedPageObjects.map((p) => ({ path: p.path, code: p.code })),
        // Attach the human-readable test cases (docs/TEST-CASES.md + .csv).
        testCases: results?.testCases || [],
        // The repo URL, target branch and scripts folder are resolved
        // server-side from the selected connection's saved config.
        integrationId: selectedRepoId as 'github' | 'gitlab' | 'bitbucket',
        testRunId: savedTestRunId || currentRunId || undefined,
      });
      setPublishedPrUrl(result.prUrl);
      setPublishResult('success');
      toast.success('Published successfully');
      push(
        'tessa',
        `Done! I opened ${result.provider === 'gitlab' ? 'MR' : 'PR'} #${result.prNumber} on ${result.provider} with ${result.fileCount} file(s). You can view it at ${result.prUrl}`,
      );
    } catch (err: any) {
      const msg = err?.response?.data?.error || err?.message || 'Git publish failed';
      setPublishResult('error');
      push('tessa', `I couldn't publish to Git: ${msg}. Your scripts are still available below for manual download.`);
    } finally {
      setIsPublishing(false);
    }
  };

  /* --- One-click Push to GitHub ---
     Pushes the generated test cases + scripts + page objects straight to the
     connected git repository (opens a PR), resolving the repo automatically from
     System Configuration → Code Repositories. No wizard — usable directly from
     the results/report screens once all agents have finished. */
  const handleQuickPushToGit = async () => {
    if (gitPush.status === 'pushing') return;
    if (generatedScripts.length === 0) {
      push('tessa', 'There are no scripts to push yet.');
      return;
    }
    setGitPush({ status: 'pushing' });
    try {
      // Resolve the connected repo: reuse a prior selection, else the first
      // connected git-repo integration from System Configuration.
      let integrationId = selectedRepoId as string | undefined;
      if (!integrationId) {
        const result = await getConfigurations();
        const repo = (result.configs || []).find(
          (c: any) => ['github', 'gitlab', 'bitbucket'].includes(c.integrationId) && c.status === 'connected',
        );
        integrationId = repo?.integrationId;
        if (integrationId) setSelectedRepoId(integrationId);
      }
      if (!integrationId) {
        setGitPush({ status: 'error', error: 'No repository connected' });
        push('tessa', 'No code repository is connected. Connect GitHub under System Configuration → Code Repositories, then try again.');
        return;
      }
      push('tessa', `Pushing ${generatedScripts.length} test script(s) and the test cases to your ${integrationId} repository...`);
      const result = await publishToGit({
        scripts: generatedScripts.map((s) => ({ fileName: s.fileName, code: s.code, path: s.path })),
        pageObjects: generatedPageObjects.map((p) => ({ path: p.path, code: p.code })),
        testCases: results?.testCases || [],
        integrationId: integrationId as 'github' | 'gitlab' | 'bitbucket',
        testRunId: savedTestRunId || currentRunId || undefined,
        // One-click push commits straight to the default branch so the code
        // shows up in the repo immediately (no PR to merge). The separate
        // "Create Pull Request" action still opens a PR.
        directCommit: true,
      });
      setPublishedPrUrl(result.prUrl);
      setGitPush({ status: 'done', prUrl: result.prUrl });
      toast.success('Pushed to GitHub');
      push('tessa', result.mode === 'commit'
        ? `Done! Committed ${result.fileCount} file(s) straight to the "${result.branch}" branch on ${result.provider}: ${result.prUrl}`
        : `Done! I opened ${result.provider === 'gitlab' ? 'MR' : 'PR'} #${result.prNumber} on ${result.provider} with ${result.fileCount} file(s): ${result.prUrl}`);
    } catch (err: any) {
      const msg = err?.response?.data?.error || err?.message || 'Git push failed';
      setGitPush({ status: 'error', error: msg });
      push('tessa', `I couldn't push to GitHub: ${msg}. You can still create a Pull Request from the report screen.`);
    }
  };

  /* --- Report to Support ---
     Sends a failure + flaky summary of this run to every notification channel
     the tenant has connected (Outlook email / Slack / Teams). The failures are
     already auto-registered in the Bug Tracker; this escalates them to the team. */
  const handleReportToSupport = async () => {
    if (supportState.status === 'sending') return;
    const healedIds = new Set(healingLog.filter((l) => l.result === 'fixed').map((l) => l.testCaseId));
    const failures = executionResults
      .filter((r) => r.status === 'failed')
      .map((r) => ({ name: r.testName, error: r.error }));
    const flaky = executionResults
      .filter((r) => r.status === 'passed' && healedIds.has(r.testCaseId))
      .map((r) => ({ name: r.testName }));
    if (failures.length === 0 && flaky.length === 0) {
      push('tessa', 'There are no failing or flaky tests to report — everything passed cleanly.');
      return;
    }
    setSupportState({ status: 'sending' });
    push('tessa', `Reporting ${failures.length} failing and ${flaky.length} flaky test(s) to your team...`);
    try {
      const res = await reportToSupport({
        runId: savedTestRunId || currentRunId || undefined,
        feature: (results?.testCases?.[0]?.feature) || (results?.testCases?.[0]?.module) || 'Web Application Automation',
        module: results?.testCases?.[0]?.module || undefined,
        total: executionSummary?.total,
        passed: executionSummary?.passed,
        failed: executionSummary?.failed,
        durationSeconds: executionSummary ? Math.round(executionSummary.durationMs / 1000) : undefined,
        failures,
        flaky,
      });
      if (!res.configured) {
        setSupportState({ status: 'error', msg: 'No notification channel configured' });
        push('tessa', 'No notification channel is connected yet. Add Outlook email, Slack, or Teams under System Configuration → Notifications, then try again. (The failures are already logged in the Bug Tracker.)');
        return;
      }
      const okChannels = res.results.filter((r) => r.sent).map((r) => r.channel);
      const failChannels = res.results.filter((r) => !r.sent);
      if (okChannels.length > 0) {
        setSupportState({ status: 'sent', msg: `Sent via ${okChannels.join(', ')}` });
        toast.success('Reported to support', `Sent via ${okChannels.join(', ')}.`);
        push('tessa', `Reported to your team via ${okChannels.join(', ')}. The failing and flaky tests are also tracked in the Bug Tracker.`);
      } else {
        const why = failChannels[0]?.error ? ` (${failChannels[0].error})` : '';
        setSupportState({ status: 'error', msg: `Could not send${why}` });
        push('tessa', `I couldn't deliver the report to your notification channel${why}. Please check the Notifications settings.`);
      }
    } catch (err: any) {
      const msg = err?.response?.data?.error || err?.message || 'Failed to report to support';
      setSupportState({ status: 'error', msg });
      push('tessa', `I couldn't report to support: ${msg}.`);
    }
  };

  /* --- TC editing helpers --- */
  const startEdit = (tc: any) => {
    setEditingTcId(tc.id);
    setEditDraft({ ...tc });
  };
  const cancelEdit = () => { setEditingTcId(null); setEditDraft(null); };
  const saveEdit = () => {
    if (!editDraft || !results) return;
    setResults((prev: any) => ({
      ...prev,
      testCases: prev.testCases.map((tc: any) => tc.id === editDraft.id ? { ...editDraft } : tc),
    }));
    setEditingTcId(null);
    setEditDraft(null);
  };
  const deleteTcs = () => {
    if (!results || selectedTcIds.size === 0) return;
    setResults((prev: any) => ({
      ...prev,
      testCases: prev.testCases.filter((tc: any) => !selectedTcIds.has(tc.id)),
    }));
    setSelectedTcIds(new Set());
  };
  const toggleTcSelect = (id: string) => {
    setSelectedTcIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };
  const toggleSelectAll = () => {
    if (!results) return;
    const pageIds = pagedTcs.map((tc: any) => tc.id);
    const allSelected = pageIds.every((id: string) => selectedTcIds.has(id));
    setSelectedTcIds(prev => {
      const next = new Set(prev);
      pageIds.forEach((id: string) => allSelected ? next.delete(id) : next.add(id));
      return next;
    });
  };

  // Pagination helpers
  const totalTcs = results?.testCases?.length || 0;
  const totalPages = Math.max(1, Math.ceil(totalTcs / tcPageSize));
  const pagedTcs = results?.testCases?.slice((tcPage - 1) * tcPageSize, tcPage * tcPageSize) || [];

  // Keep the current page valid when the list shrinks (e.g. after deleting the
  // last page's items) so the view never gets stuck on an empty page.
  useEffect(() => {
    if (tcPage > totalPages) setTcPage(totalPages);
  }, [tcPage, totalPages]);

  /* --- delete single TC --- */
  const deleteSingleTc = (id: string) => {
    if (!results) return;
    setResults((prev: any) => ({
      ...prev,
      testCases: prev.testCases.filter((tc: any) => tc.id !== id),
    }));
    setSelectedTcIds(prev => { const next = new Set(prev); next.delete(id); return next; });
    if (editingTcId === id) { setEditingTcId(null); setEditDraft(null); }
  };

  /* --- reset --- */
  const [showResetConfirm, setShowResetConfirm] = useState(false);
  const requestReset = () => {
    if (step === 'welcome') { reset(); return; }
    setShowResetConfirm(true);
  };
  const reset = () => {
    flowIdRef.current++; // Invalidate any in-flight generation/execution/heal continuations
    stopSpeaking(); // Stop any ongoing voice-over
    setMessages([]);
    setStep('welcome');
    setCategory(null);
    setSubCategory(null);
    setSource(null);
    setFormValues({});
    setStories([]);
    setSelectedStory('');
    setJiraTab('assigned');
    setPersonFilter('');
    setAssigningKey('');
    setAssignableUsers([]);
    setAssignLoading(false);
    setPeopleLoading(false);
    setAssignConfirm(null);
    setReadyApps(null);
    setPasteText('');
    setAgentSteps([]);
    setResults(null);
    setApiUrl('');
    setApiMethod('GET');
    setApiHeaders([{ key: '', value: '' }]);
    setApiAuthType('none');
    setApiAuthValue('');
    setApiBody('');
    setApiSampleResp('');
    setConnectError('');
    setSelectedColumns(ALL_COLUMNS.filter(c => c.default).map(c => c.key));
    setPendingRequirements('');
    setTcPage(1);
    setTcPageSize(10);
    setSelectedTcIds(new Set());
    setEditingTcId(null);
    setEditDraft(null);
    setIsSaving(false);
    setSavedTestRunId(null);
    setIsExporting(false);
    setStoryMeta({});
    setAppOptions([]);
    setSelectedAppId(null);
    setPendingGenRequirements('');
    setPipelineStages(PIPELINE_STAGES.map(s => ({ key: s.key, status: 'pending' as const, detail: 'Pending' })));
    setControl('idle');
    setGeneratedScripts([]);
    setSelectedScriptIdx(0);
    setExecutionResults([]);
    setExecutionSummary(null);
    setHealingAttempt(0);
    setHealingLog([]);
    setReportData(null);
    setGitRepoUrl('');
    setGitBranch('main');
    setIsPublishing(false);
    setPublishResult(null);
    setGitPush({ status: 'idle' });
    setSupportState({ status: 'idle' });
    clearSession(); // clear persisted session on explicit reset
    setTimeout(() => push('tessa', `Welcome back! What would you like to test today?`), 100);
  };

  /* ═══════════════════════════════════════════════════════════════
     RENDER HELPERS
     ═══════════════════════════════════════════════════════════════ */
  const inputCls = 'w-full px-3.5 py-2.5 bg-white border border-gray-200 rounded-lg text-sm text-gray-800 placeholder:text-gray-400 outline-none focus:ring-2 focus:ring-violet-500/20 focus:border-violet-400 transition-all';

  const renderFormField = (f: FormField) => {
    const val = formValues[f.key] || '';
    const isPass = f.type === 'password';
    const show = showPasswords[f.key];
    return (
      <div key={f.key}>
        <label className="block text-xs font-medium text-gray-600 mb-1">{f.label}</label>
        {f.type === 'textarea' ? (
          <textarea value={val} onChange={e => setFormValues(p => ({ ...p, [f.key]: e.target.value }))} placeholder={f.placeholder} rows={3} className={inputCls + ' resize-none'} />
        ) : (
          <div className="relative">
            <input
              type={isPass && !show ? 'password' : 'text'}
              value={val}
              onChange={e => setFormValues(p => ({ ...p, [f.key]: e.target.value }))}
              placeholder={f.placeholder}
              className={inputCls + (isPass ? ' pr-9' : '')}
            />
            {isPass && (
              <button type="button" onClick={() => setShowPasswords(p => ({ ...p, [f.key]: !p[f.key] }))} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-gray-400 hover:text-violet-500">
                {show ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
              </button>
            )}
          </div>
        )}
      </div>
    );
  };

  /* ═══════════════════════════════════════════════════════════════
     ACTIVE PANEL — the current interactive element
     ═══════════════════════════════════════════════════════════════ */
  const renderPanel = () => {
    /* ── WELCOME: Category Cards ── */
    if (step === 'welcome') {
      return (
        <div className="grid grid-cols-2 gap-3 max-w-lg ml-11">
          {visibleCategories.map((c) => {
            const Icon = c.icon;
            const isComingSoon = c.comingSoon === true;
            return (
              <button
                key={c.id}
                onClick={() => pickCategory(c)}
                disabled={isComingSoon}
                aria-disabled={isComingSoon}
                className={
                  isComingSoon
                    ? 'relative text-left p-4 bg-white border border-gray-100 rounded-xl opacity-60 cursor-not-allowed'
                    : 'group relative text-left p-4 bg-white border border-gray-100 rounded-xl hover:border-violet-300 hover:shadow-md hover:shadow-violet-500/5 transition-all'
                }
              >
                {isComingSoon && (
                  <span className="absolute top-2 right-2 px-2 py-0.5 bg-amber-50 text-amber-700 border border-amber-200 rounded-full text-[10px] font-semibold uppercase tracking-wide">
                    Coming Soon
                  </span>
                )}
                <div
                  className={
                    'w-9 h-9 rounded-lg flex items-center justify-center mb-3 ' +
                    (isComingSoon
                      ? 'bg-gradient-to-br from-gray-300 to-gray-400'
                      : 'bg-gradient-to-br from-violet-500 to-indigo-600')
                  }
                >
                  <Icon className="w-4.5 h-4.5 text-white" />
                </div>
                <p
                  className={
                    'text-sm font-semibold ' +
                    (isComingSoon ? 'text-gray-500' : 'text-gray-800 group-hover:text-violet-700')
                  }
                >
                  {c.title}
                </p>
                <p className="text-[11px] text-gray-400 mt-0.5">{c.desc}</p>
              </button>
            );
          })}
        </div>
      );
    }

    /* ── SOURCE SELECT ── */
    if (step === 'source-select') {
      return (
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-2.5 max-w-lg ml-11">
          {REQ_SOURCES.map(s => {
            const Icon = s.icon;
            return (
              <button key={s.id} onClick={() => pickSource(s.id)} className="group text-left p-3.5 bg-white border border-gray-100 rounded-xl hover:border-violet-300 hover:shadow-md transition-all">
                <Icon className="w-5 h-5 text-violet-500 mb-2" />
                <p className="text-sm font-medium text-gray-800">{s.title}</p>
                <p className="text-[11px] text-gray-400">{s.desc}</p>
              </button>
            );
          })}
        </div>
      );
    }

    /* ── AZURE DEVOPS: choose stories vs existing test cases ── */
    if (step === 'ado-mode') {
      return (
        <div className="max-w-md ml-11 bg-white border border-gray-100 rounded-xl p-5 shadow-sm space-y-3">
          <div className="flex items-center gap-2 mb-1 bg-emerald-50 border border-emerald-200 rounded-lg px-3 py-2">
            <CheckCircle className="w-4 h-4 text-emerald-600 flex-shrink-0" />
            <span className="text-xs font-medium text-emerald-700">Azure DevOps connected</span>
          </div>
          <p className="text-xs text-gray-600">What would you like to pull in?</p>
          <button
            onClick={runOnce(adoFetchStories)}
            disabled={busy}
            className="w-full text-left p-3.5 bg-white border border-gray-100 rounded-xl hover:border-violet-300 hover:shadow-md transition-all disabled:opacity-50"
          >
            <div className="flex items-center gap-2.5">
              <Workflow className="w-4 h-4 text-violet-500" />
              <div>
                <p className="text-sm font-medium text-gray-800">Generate from Stories</p>
                <p className="text-[11px] text-gray-400">Pull user stories / work items and let AI author new tests</p>
              </div>
            </div>
          </button>
          <button
            onClick={runOnce(adoImportTestCases)}
            disabled={busy}
            className="w-full text-left p-3.5 bg-white border border-gray-100 rounded-xl hover:border-violet-300 hover:shadow-md transition-all disabled:opacity-50"
          >
            <div className="flex items-center gap-2.5">
              <FileText className="w-4 h-4 text-violet-500" />
              <div>
                <p className="text-sm font-medium text-gray-800">Import Existing Test Cases</p>
                <p className="text-[11px] text-gray-400">Bring in Test Cases already authored in Azure DevOps, with their steps</p>
              </div>
            </div>
          </button>
        </div>
      );
    }

    /* ── APPLICATION PICK — shown only when >1 application is configured ── */
    if (step === 'app-select') {
      return (
        <div className="max-w-md ml-11 bg-white border border-gray-100 rounded-xl p-5 shadow-sm space-y-3">
          <p className="text-xs text-gray-600">Select the application these test cases are for:</p>
          {appOptions.map((app) => (
            <button
              key={app.integrationId}
              onClick={runOnce(() => handleAppSelected(app.integrationId))}
              disabled={busy}
              className="w-full text-left p-3.5 bg-white border border-gray-100 rounded-xl hover:border-violet-300 hover:shadow-md transition-all disabled:opacity-50"
            >
              <div className="flex items-center gap-2.5">
                <Monitor className="w-4 h-4 text-violet-500 flex-shrink-0" />
                <div className="min-w-0">
                  <p className="text-sm font-medium text-gray-800 truncate">{app.appName}</p>
                  <p className="text-[11px] text-gray-400 truncate">{app.baseUrl}</p>
                </div>
              </div>
            </button>
          ))}
          <p className="text-[11px] text-gray-400">
            Don't see it? Add it under{' '}
            <button
              onClick={() => window.location.href = '/system-configuration'}
              className="text-violet-500 hover:underline"
            >
              System Configuration → Application Setup
            </button>
            , then come back and click Generate again.
          </p>
        </div>
      );
    }

    /* ── CONNECT FORM — redirects to System Configuration ── */
    if (step === 'connect-form' && source) {
      const label = REQ_SOURCES.find((r) => r.id === source)?.title || String(source);
      return (
        <div className="max-w-md ml-11 bg-white border border-gray-100 rounded-xl p-5 shadow-sm text-center">
          <Link2 className="w-8 h-8 text-violet-400 mx-auto mb-3" />
          <p className="text-sm font-semibold text-gray-800 mb-1">{label} Not Configured</p>
          <p className="text-xs text-gray-500 mb-4">
            Set up your {label} connection in System Configuration to continue.
          </p>
          <button
            onClick={() => window.location.href = '/system-configuration'}
            className="px-5 py-2 bg-gradient-to-r from-violet-600 to-indigo-600 text-white text-sm font-medium rounded-lg hover:from-violet-500 hover:to-indigo-500 transition-all inline-flex items-center gap-2"
          >
            <Settings className="w-4 h-4" />
            Go to System Configuration
          </button>
        </div>
      );
    }

    /* ── JIRA STORIES (Assigned / Unassigned tabs, assign + auto-start) ── */
    if (step === 'jira-stories') {
      const assigned = stories.filter(s => s.assignee);
      const unassigned = stories.filter(s => !s.assignee);
      // Unique people present among assigned stories → filter dropdown options.
      const people = Array.from(new Map(assigned.map(s => [s.assignee.accountId, s.assignee])).values());
      const visibleAssigned = personFilter ? assigned.filter(s => s.assignee.accountId === personFilter) : assigned;
      const truncate = (t: string, n = 44) => (t.length > n ? t.slice(0, n).trimEnd() + '…' : t);
      const titleOf = (s: any) => (s.title || s.summary || s.key || '').trim();

      // Map a story to a configured application. With one app, every story maps
      // to it. With several, infer by matching the app's name (or its base-URL
      // host label) against the story key/title/summary. null = couldn't map.
      const appForStory = (s: any): { integrationId: string; appName: string; baseUrl: string } | null => {
        if (!readyApps || readyApps.length === 0) return null;
        if (readyApps.length === 1) return readyApps[0];
        const hay = `${s.key || ''} ${s.title || ''} ${s.summary || ''}`.toLowerCase();
        for (const app of readyApps) {
          const name = (app.appName || '').toLowerCase().trim();
          if (name && hay.includes(name)) return app;
          try {
            const label = new URL(app.baseUrl).host.replace(/^www\./, '').split('.')[0].toLowerCase();
            if (label.length > 2 && hay.includes(label)) return app;
          } catch { /* ignore bad URL */ }
        }
        return null;
      };

      // Small application badge rendered inside each story card.
      const AppBadge = ({ s }: { s: any }) => {
        if (!readyApps) return null;                       // still loading
        if (readyApps.length === 0)
          return <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] bg-amber-100 text-amber-700"><AlertTriangle className="w-2.5 h-2.5" />No app configured</span>;
        const app = appForStory(s);
        if (app)
          return <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] bg-violet-100 text-violet-700" title={app.baseUrl}><Box className="w-2.5 h-2.5" />{app.appName}</span>;
        // Multiple apps and no keyword match — user resolves at generation time.
        return <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] bg-gray-100 text-gray-500" title="No configured app name matched this story — you'll choose when generating"><Box className="w-2.5 h-2.5" />Choose at generation</span>;
      };

      const Avatar = ({ u }: { u: JiraUser }) =>
        u.avatarUrl
          ? <img src={u.avatarUrl} alt="" className="w-5 h-5 rounded-full flex-shrink-0" />
          : <span className="w-5 h-5 rounded-full bg-violet-100 text-violet-700 text-[10px] font-semibold flex items-center justify-center flex-shrink-0">{(u.displayName || '?').charAt(0).toUpperCase()}</span>;

      const tabBtn = (tab: 'assigned' | 'unassigned', label: string, count: number) => (
        <button
          onClick={() => setJiraTab(tab)}
          className={`flex-1 flex items-center justify-center gap-1.5 py-1.5 text-xs font-medium rounded-md transition-all ${jiraTab === tab ? 'bg-white text-violet-700 shadow-sm' : 'text-gray-500 hover:text-gray-700'}`}
        >
          {label}
          <span className={`px-1.5 py-0.5 rounded-full text-[10px] ${jiraTab === tab ? 'bg-violet-100 text-violet-700' : 'bg-gray-200 text-gray-600'}`}>{count}</span>
        </button>
      );

      const confirmStory = assignConfirm ? stories.find(s => s.key === assignConfirm.key) : null;

      return (
        <>
        <div className="max-w-md ml-11 bg-white border border-gray-100 rounded-xl p-5 shadow-sm">
          <div className="flex items-center gap-2 mb-3 bg-emerald-50 border border-emerald-200 rounded-lg px-3 py-2">
            <CheckCircle className="w-4 h-4 text-emerald-600 flex-shrink-0" />
            <span className="text-xs font-medium text-emerald-700">Connected to JIRA</span>
          </div>

          {/* One-time setup warning only — per-story app is shown on each card below */}
          {readyApps && readyApps.length === 0 && (
            <div className="flex items-start gap-2 mb-4 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
              <AlertTriangle className="w-4 h-4 text-amber-600 flex-shrink-0 mt-0.5" />
              <span className="text-[11px] text-amber-700">No application configured yet. Add one under System Configuration → Application Setup so these stories have an app to test against.</span>
            </div>
          )}

          {stories.length === 0 ? (
            <p className="text-xs text-gray-500">No stories or tasks were found in this project.</p>
          ) : (
            <>
              {/* Tabs */}
              <div className="flex gap-1 mb-4 bg-gray-100 rounded-lg p-1">
                {tabBtn('assigned', 'Assigned', assigned.length)}
                {tabBtn('unassigned', 'Unassigned', unassigned.length)}
              </div>

              {jiraTab === 'assigned' ? (
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-2">Filter by assignee</label>
                  <select value={personFilter} onChange={e => { setPersonFilter(e.target.value); setSelectedStory(''); }} className={inputCls + ' appearance-none mb-3'}>
                    <option value="">All people ({assigned.length})</option>
                    {people.map(p => (
                      <option key={p.accountId} value={p.accountId}>
                        {p.displayName} ({assigned.filter(s => s.assignee.accountId === p.accountId).length})
                      </option>
                    ))}
                  </select>

                  {visibleAssigned.length === 0 ? (
                    <p className="text-xs text-gray-500 py-2">No assigned stories to show.</p>
                  ) : (
                    <ul className="space-y-1.5 max-h-72 overflow-y-auto pr-1">
                      {visibleAssigned.map(s => {
                        const active = selectedStory === s.key;
                        const rowBusy = assignLoading && assigningKey === s.key;
                        return (
                          <li key={s.key} className={`rounded-lg border transition-all ${active ? 'border-violet-400 bg-violet-50 ring-2 ring-violet-500/20' : 'border-gray-200 hover:border-violet-300'}`}>
                            <button
                              onClick={() => setSelectedStory(s.key)}
                              className="w-full text-left px-3 pt-2 pb-1.5 rounded-t-lg hover:bg-gray-50/60"
                            >
                              <div className="flex items-center justify-between gap-2">
                                <span className="text-xs font-semibold text-violet-700">{s.key}</span>
                                <div className="flex items-center gap-1.5 flex-shrink-0">
                                  <AppBadge s={s} />
                                  {active && <Check className="w-3.5 h-3.5 text-violet-600" />}
                                </div>
                              </div>
                              <div className="text-xs text-gray-700 mt-0.5" title={titleOf(s)}>{truncate(titleOf(s))}</div>
                              <div className="flex items-center gap-1.5 mt-1.5">
                                <Avatar u={s.assignee} />
                                <span className="text-[11px] text-gray-500">{s.assignee.displayName}</span>
                              </div>
                            </button>
                            {/* Reassign to another user, or unassign completely */}
                            <div className="px-3 pb-2 pt-1.5 border-t border-gray-100 flex items-center gap-2">
                              <select
                                value=""
                                disabled={assignLoading}
                                onChange={e => {
                                  const val = e.target.value;
                                  if (!val) return;
                                  if (val === '__unassign__') { setAssignConfirm({ key: s.key, accountId: '', displayName: '(no assignee)', action: 'unassign' }); return; }
                                  if (val === '__me__') { setAssignConfirm({ key: s.key, accountId: '__me__', displayName: 'you (your connected Jira account)', isMe: true, action: 'reassign' }); return; }
                                  const u = assignableUsers.find(x => x.accountId === val);
                                  if (u) setAssignConfirm({ key: s.key, accountId: u.accountId, displayName: u.displayName, action: 'reassign' });
                                }}
                                className={inputCls + ' appearance-none py-1.5 text-[11px] disabled:opacity-50'}
                                title="Reassign to another user or unassign"
                              >
                                <option value="">Reassign / unassign…</option>
                                <option value="__me__">⭐ Assign to me</option>
                                <option value="__unassign__">🚫 Unassign (move to Unassigned)</option>
                                {assignableUsers.filter(u => u.accountId !== s.assignee.accountId).map(u => (
                                  <option key={u.accountId} value={u.accountId}>{u.displayName}{u.emailAddress ? ` — ${u.emailAddress}` : ''}</option>
                                ))}
                              </select>
                              {rowBusy && <Loader2 className="w-4 h-4 animate-spin text-violet-600 flex-shrink-0" />}
                            </div>
                          </li>
                        );
                      })}
                    </ul>
                  )}

                  <button onClick={runOnce(() => handleStorySelect())} disabled={busy || !selectedStory} className="mt-3 w-full py-2.5 bg-gradient-to-r from-violet-600 to-indigo-600 hover:from-violet-500 hover:to-indigo-500 disabled:opacity-40 text-white text-sm font-medium rounded-lg transition-all flex items-center justify-center gap-2">
                    <ArrowRight className="w-4 h-4" />Proceed
                  </button>
                </div>
              ) : (
                <div>
                  {unassigned.length === 0 ? (
                    <p className="text-xs text-gray-500 py-2">Every story is already assigned. 🎉</p>
                  ) : (
                    <ul className="space-y-1.5 max-h-80 overflow-y-auto pr-1">
                      {unassigned.map(s => {
                        const rowBusy = assignLoading && assigningKey === s.key;
                        return (
                          <li key={s.key} className="px-3 py-2 rounded-lg border border-gray-200">
                            <div className="flex items-center justify-between gap-2">
                              <span className="text-xs font-semibold text-violet-700">{s.key}</span>
                              <div className="flex items-center gap-1.5 flex-shrink-0">
                                <AppBadge s={s} />
                                <span className="px-1.5 py-0.5 rounded-full text-[10px] bg-amber-100 text-amber-700">Unassigned</span>
                              </div>
                            </div>
                            <div className="text-xs text-gray-700 mt-0.5" title={titleOf(s)}>{truncate(titleOf(s))}</div>

                            <div className="mt-2">
                              <label className="block text-[11px] font-medium text-gray-600 mb-1">Assign to</label>
                              {peopleLoading && assignableUsers.length === 0 ? (
                                <div className="flex items-center gap-2 text-[11px] text-gray-500"><Loader2 className="w-3.5 h-3.5 animate-spin" />Loading Jira people…</div>
                              ) : (
                                <div className="flex items-center gap-2">
                                  <select
                                    value=""
                                    disabled={assignLoading}
                                    onChange={e => {
                                      const val = e.target.value;
                                      if (!val) return;
                                      // Ask for confirmation before mutating the Jira ticket.
                                      if (val === '__me__') { setAssignConfirm({ key: s.key, accountId: '__me__', displayName: 'you (your connected Jira account)', isMe: true, action: 'assign-start' }); return; }
                                      const u = assignableUsers.find(x => x.accountId === val);
                                      if (u) setAssignConfirm({ key: s.key, accountId: u.accountId, displayName: u.displayName, action: 'assign-start' });
                                    }}
                                    className={inputCls + ' appearance-none py-2 text-xs disabled:opacity-50'}
                                  >
                                    <option value="">-- choose a person --</option>
                                    <option value="__me__">⭐ Assign to me</option>
                                    {assignableUsers.map(u => (
                                      <option key={u.accountId} value={u.accountId}>{u.displayName}{u.emailAddress ? ` — ${u.emailAddress}` : ''}</option>
                                    ))}
                                  </select>
                                  {rowBusy && <Loader2 className="w-4 h-4 animate-spin text-violet-600 flex-shrink-0" />}
                                </div>
                              )}
                              <p className="text-[10px] text-gray-400 mt-1">You'll confirm, then {s.key} moves to the Assigned tab.</p>
                            </div>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </div>
              )}
            </>
          )}
        </div>

        {/* Assignment confirmation popup — user sees exactly what will change */}
        {assignConfirm && (() => {
          const isUnassign = assignConfirm.action === 'unassign';
          const isReassign = assignConfirm.action === 'reassign';
          const title = isUnassign ? 'Confirm unassign' : isReassign ? 'Confirm reassignment' : 'Confirm assignment';
          const subtitle = isUnassign
            ? 'This removes the assignee. The story moves to the Unassigned tab.'
            : isReassign
              ? 'This changes who the Jira ticket is assigned to.'
              : 'This assigns the Jira ticket. It will move to the Assigned tab.';
          const confirmLabel = isUnassign ? 'Unassign' : isReassign ? 'Reassign' : 'Assign';
          const confirmClasses = isUnassign
            ? 'flex-1 py-2 bg-amber-600 hover:bg-amber-500 disabled:opacity-40 text-white text-sm font-medium rounded-lg transition-all flex items-center justify-center gap-1.5'
            : 'flex-1 py-2 bg-gradient-to-r from-violet-600 to-indigo-600 hover:from-violet-500 hover:to-indigo-500 disabled:opacity-40 text-white text-sm font-medium rounded-lg transition-all flex items-center justify-center gap-1.5';
          return (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4" onClick={() => !assignLoading && setAssignConfirm(null)}>
            <div className="w-full max-w-sm bg-white rounded-xl shadow-xl p-5" onClick={e => e.stopPropagation()}>
              <div className="flex items-start gap-3 mb-3">
                <div className={`w-9 h-9 rounded-full flex items-center justify-center flex-shrink-0 ${isUnassign ? 'bg-amber-100 text-amber-600' : 'bg-violet-100 text-violet-600'}`}>
                  {isUnassign ? <X className="w-5 h-5" /> : <Check className="w-5 h-5" />}
                </div>
                <div>
                  <h3 className="text-sm font-semibold text-gray-800">{title}</h3>
                  <p className="text-xs text-gray-500 mt-0.5">{subtitle}</p>
                </div>
              </div>
              <div className="bg-gray-50 border border-gray-100 rounded-lg px-3 py-2.5 mb-4 text-xs text-gray-700 space-y-1">
                <div><span className="text-gray-500">Story:</span> <span className="font-semibold text-violet-700">{assignConfirm.key}</span> — {truncate(titleOf(confirmStory || { key: assignConfirm.key }), 60)}</div>
                {isUnassign
                  ? <div><span className="text-gray-500">Currently:</span> <span className="font-semibold text-gray-800">{confirmStory?.assignee?.displayName || 'assigned'}</span> → <span className="font-semibold text-amber-700">Unassigned</span></div>
                  : <div><span className="text-gray-500">{isReassign ? 'Reassign to:' : 'Assign to:'}</span> <span className="font-semibold text-gray-800">{assignConfirm.displayName}</span></div>}
              </div>
              <div className="flex gap-2">
                <button
                  onClick={() => setAssignConfirm(null)}
                  disabled={assignLoading}
                  className="flex-1 py-2 border border-gray-200 text-gray-600 hover:bg-gray-50 disabled:opacity-40 text-sm font-medium rounded-lg transition-all"
                >
                  Cancel
                </button>
                <button
                  onClick={() => {
                    const c = assignConfirm;
                    setAssignConfirm(null);
                    if (c.action === 'unassign') { unassignStoryFn(c.key); return; }
                    if (c.action === 'reassign') { c.isMe ? reassignToMe(c.key) : reassignStory(c.key, c.accountId, c.displayName); return; }
                    c.isMe ? assignToMe(c.key) : assignStory(c.key, c.accountId, c.displayName);
                  }}
                  disabled={assignLoading}
                  className={confirmClasses}
                >
                  {assignLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : (isUnassign ? <X className="w-4 h-4" /> : <Check className="w-4 h-4" />)}
                  {confirmLabel}
                </button>
              </div>
            </div>
          </div>
          );
        })()}
        </>
      );
    }

    /* ── CONTENT DROPDOWN (stories / docs) ── */
    if (step === 'content-select') {
      return (
        <div className="max-w-md ml-11 bg-white border border-gray-100 rounded-xl p-5 shadow-sm">
          <div className="flex items-center gap-2 mb-4 bg-emerald-50 border border-emerald-200 rounded-lg px-3 py-2">
            <CheckCircle className="w-4 h-4 text-emerald-600 flex-shrink-0" />
            <span className="text-xs font-medium text-emerald-700">Connected successfully</span>
          </div>
          <label className="block text-xs font-medium text-gray-600 mb-2">
            {source === 'azure-devops' ? 'Select a Card' : source === 'jira' ? 'Select a Story' : 'Select a Document'}
          </label>
          <select value={selectedStory} onChange={e => setSelectedStory(e.target.value)} className={inputCls + ' appearance-none'}>
            <option value="">-- Choose --</option>
            {stories.map(s => {
              const full = (s.title || s.summary || '').trim();
              const display = full.length > 30 ? full.slice(0, 30).trimEnd() + '...' : full;
              return (
                <option key={s.key} value={s.key} title={`${s.key}: ${full}`}>{s.key}: {display}</option>
              );
            })}
          </select>
          <button onClick={runOnce(handleStorySelect)} disabled={busy || !selectedStory} className="mt-3 w-full py-2.5 bg-gradient-to-r from-violet-600 to-indigo-600 hover:from-violet-500 hover:to-indigo-500 disabled:opacity-40 text-white text-sm font-medium rounded-lg transition-all flex items-center justify-center gap-2">
            <ArrowRight className="w-4 h-4" />Proceed
          </button>
        </div>
      );
    }

    /* ── UPLOAD DOC ── */
    if (step === 'upload-doc') {
      return (
        <div className="max-w-md ml-11 bg-white border border-gray-100 rounded-xl p-5 shadow-sm">
          {/* Hidden input — opened via the visible drop zone */}
          <input
            ref={fileInputRef}
            type="file"
            accept=".pdf,.docx,.txt,.md,.markdown,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/plain,text/markdown"
            className="hidden"
            onChange={handleFileSelected}
          />
          <div
            className={`border-2 border-dashed rounded-lg p-8 text-center transition-colors ${
              uploadInProgress
                ? 'border-violet-300 bg-violet-50/50 cursor-wait'
                : 'border-gray-200 hover:border-violet-300 cursor-pointer'
            }`}
            onClick={uploadInProgress ? undefined : openFilePicker}
            onDragOver={(e) => { e.preventDefault(); }}
            onDrop={(e) => {
              e.preventDefault();
              if (uploadInProgress) return;
              const f = e.dataTransfer.files?.[0];
              if (f && fileInputRef.current) {
                // Use DataTransfer trick to set the file on the input so handleFileSelected fires uniformly.
                const dt = new DataTransfer();
                dt.items.add(f);
                fileInputRef.current.files = dt.files;
                fileInputRef.current.dispatchEvent(new Event('change', { bubbles: true }));
              }
            }}
          >
            {uploadInProgress ? (
              <>
                <Loader2 className="w-8 h-8 text-violet-500 mx-auto mb-3 animate-spin" />
                <p className="text-sm font-medium text-gray-700">Extracting text from your document…</p>
                <p className="text-xs text-gray-400 mt-1">This usually takes a few seconds.</p>
              </>
            ) : (
              <>
                <Upload className="w-8 h-8 text-violet-400 mx-auto mb-3" />
                <p className="text-sm font-medium text-gray-700">Drop your file here or click to browse</p>
                <p className="text-xs text-gray-400 mt-1">PDF, DOCX, TXT, or MD — up to 15 MB</p>
              </>
            )}
          </div>
          {uploadError && (
            <div className="mt-3 text-xs text-rose-600 bg-rose-50 border border-rose-200 rounded-lg px-3 py-2">
              {uploadError}
            </div>
          )}
        </div>
      );
    }

    /* ── PASTE TEXT ── */
    if (step === 'paste-text') {
      return (
        <div className="max-w-md ml-11 bg-white border border-gray-100 rounded-xl p-5 shadow-sm">
          <textarea value={pasteText} onChange={e => setPasteText(e.target.value)} placeholder="Paste your requirements, user stories, or acceptance criteria here..." rows={6} className={inputCls + ' resize-none'} />
          <button onClick={runOnce(handleTextSubmit)} disabled={busy || !pasteText.trim()} className="mt-3 w-full py-2.5 bg-gradient-to-r from-violet-600 to-indigo-600 hover:from-violet-500 hover:to-indigo-500 disabled:opacity-40 text-white text-sm font-medium rounded-lg transition-all flex items-center justify-center gap-2">
            <Send className="w-4 h-4" />Submit Requirements
          </button>
        </div>
      );
    }

    /* ── EXPLORE FORM ──
       Used when the user has nothing but a URL. The backend's exploreAgent
       will crawl the URL (logging in with the supplied creds if any) and
       synthesise requirements before generating test cases. */
    if (step === 'explore-form') {
      return (
        <div className="max-w-lg ml-11 bg-white border border-gray-100 rounded-xl p-5 shadow-sm space-y-3">
          <div className="flex items-center gap-2 mb-1">
            <Search className="w-4 h-4 text-violet-500" />
            <span className="text-sm font-semibold text-gray-800">Explore Application</span>
          </div>
          <p className="text-xs text-gray-500 -mt-1">I'll launch a headless browser, crawl your app's main pages, and infer the features that need test coverage. Credentials are used only for the crawl and are not stored.</p>

          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Application URL <span className="text-rose-500">*</span></label>
            <input
              value={exploreUrl}
              onChange={(e) => setExploreUrl(e.target.value)}
              placeholder="https://app.example.com"
              className={inputCls}
            />
          </div>

          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Application (optional)</label>
            <select
              value={exploreAppId}
              disabled={exploreAppsLoading || exploreApps.length === 0}
              onChange={(e) => {
                const id = e.target.value;
                setExploreAppId(id);
                const app = exploreApps.find((a) => a.integrationId === id);
                // Selecting a configured app fills its name and base URL; both
                // stay editable afterwards.
                setExploreAppName(app?.appName || '');
                if (app?.baseUrl) setExploreUrl(app.baseUrl);
              }}
              className={inputCls + ' disabled:bg-gray-50 disabled:text-gray-400'}
            >
              <option value="">
                {exploreAppsLoading
                  ? 'Loading applications…'
                  : exploreApps.length === 0
                    ? 'No applications configured in Application Setup'
                    : 'Select a configured application…'}
              </option>
              {exploreApps.map((a) => (
                <option key={a.integrationId} value={a.integrationId}>
                  {a.appName}{a.baseUrl ? ` — ${a.baseUrl}` : ''}
                </option>
              ))}
            </select>
            <p className="text-[11px] text-gray-400 mt-1">
              {exploreApps.length === 0 && !exploreAppsLoading
                ? 'Add applications under System Configuration → Application Setup to pick them here.'
                : 'Configured under System Configuration → Application Setup. Picking one fills the URL above.'}
            </p>
          </div>

          <div className="pt-1 border-t border-gray-100">
            <p className="text-[11px] uppercase tracking-wide text-gray-400 mb-2">Optional — required only if the app is behind a login</p>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">Username / Email</label>
                <input
                  value={exploreUsername}
                  onChange={(e) => setExploreUsername(e.target.value)}
                  placeholder="alice@example.com"
                  className={inputCls}
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">Password</label>
                <div className="relative">
                  <input
                    type={showPasswords['explore'] ? 'text' : 'password'}
                    value={explorePassword}
                    onChange={(e) => setExplorePassword(e.target.value)}
                    placeholder="••••••••"
                    className={inputCls + ' pr-9'}
                  />
                  <button
                    type="button"
                    onClick={() => setShowPasswords((p) => ({ ...p, explore: !p.explore }))}
                    className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
                  >
                    {showPasswords['explore'] ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                </div>
              </div>
            </div>
          </div>

          {/* Guidance prompt — mandatory. Filled last, after the fields above,
             it biases what the explore agent focuses on. Threaded to the backend
             as appContext.explorePrompt; never sent as credentials. */}
          <div className="pt-1 border-t border-gray-100">
            <label className="block text-xs font-medium text-gray-600 mb-1">
              Guide the exploration <span className="text-rose-500">*</span>
            </label>
            <textarea
              value={explorePrompt}
              onChange={(e) => setExplorePrompt(e.target.value)}
              rows={3}
              maxLength={1000}
              placeholder="e.g. Prioritise the checkout and payment flows, include negative cases for invalid cards, and cover mobile viewport behaviour."
              className={inputCls + ' resize-y'}
            />
            <div className="flex items-center justify-between mt-1">
              <span className="text-[11px] text-gray-400">Tell Tessa what to focus on — steers coverage, not sent as credentials.</span>
              <span className="text-[11px] text-gray-400 tabular-nums">{explorePrompt.length}/1000</span>
            </div>
          </div>

          <button
            onClick={runOnce(handleExploreSubmit)}
            disabled={busy || !exploreUrl.trim() || !explorePrompt.trim()}
            className="mt-2 w-full py-2.5 bg-gradient-to-r from-violet-600 to-indigo-600 hover:from-violet-500 hover:to-indigo-500 disabled:opacity-40 text-white text-sm font-medium rounded-lg transition-all flex items-center justify-center gap-2"
          >
            <Search className="w-4 h-4" />Start Exploration
          </button>
        </div>
      );
    }

    /* ── API FORM ── */
    if (step === 'api-form') {
      return (
        <div className="max-w-lg ml-11 bg-white border border-gray-100 rounded-xl p-5 shadow-sm space-y-4">
          <div className="flex items-center gap-2 mb-1">
            <Plug className="w-4 h-4 text-violet-500" />
            <span className="text-sm font-semibold text-gray-800">API Configuration</span>
          </div>

          {/* URL + Method */}
          <div className="flex gap-2">
            <select value={apiMethod} onChange={e => setApiMethod(e.target.value)} className="px-3 py-2.5 bg-violet-50 border border-violet-200 rounded-lg text-sm font-medium text-violet-700 outline-none w-28">
              {['GET', 'POST', 'PUT', 'DELETE', 'PATCH'].map(m => <option key={m}>{m}</option>)}
            </select>
            <input value={apiUrl} onChange={e => setApiUrl(e.target.value)} placeholder="https://api.example.com/v1/resource" className={inputCls + ' flex-1'} />
          </div>

          {/* Headers */}
          <div>
            <div className="flex items-center justify-between mb-1.5">
              <label className="text-xs font-medium text-gray-600">Headers</label>
              <button onClick={() => setApiHeaders(h => [...h, { key: '', value: '' }])} className="text-xs text-violet-500 hover:text-violet-700 flex items-center gap-0.5"><Plus className="w-3 h-3" />Add</button>
            </div>
            {apiHeaders.map((h, i) => (
              <div key={i} className="flex gap-2 mb-1.5">
                <input value={h.key} onChange={e => { const n = [...apiHeaders]; n[i].key = e.target.value; setApiHeaders(n); }} placeholder="Key" className={inputCls + ' flex-1 !py-2'} />
                <input value={h.value} onChange={e => { const n = [...apiHeaders]; n[i].value = e.target.value; setApiHeaders(n); }} placeholder="Value" className={inputCls + ' flex-1 !py-2'} />
                {apiHeaders.length > 1 && <button onClick={() => setApiHeaders(h => h.filter((_, idx) => idx !== i))} className="text-gray-300 hover:text-red-400"><Trash2 className="w-3.5 h-3.5" /></button>}
              </div>
            ))}
          </div>

          {/* Authorization */}
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1.5">Authorization</label>
            <select value={apiAuthType} onChange={e => setApiAuthType(e.target.value)} className={inputCls + ' mb-2'}>
              <option value="none">No Auth</option>
              <option value="bearer">Bearer Token</option>
              <option value="basic">Basic Auth</option>
              <option value="apikey">API Key</option>
            </select>
            {apiAuthType !== 'none' && (
              <input value={apiAuthValue} onChange={e => setApiAuthValue(e.target.value)} placeholder={apiAuthType === 'bearer' ? 'Enter Bearer token' : apiAuthType === 'basic' ? 'username:password' : 'Enter API key'} type="password" className={inputCls} />
            )}
          </div>

          {/* Request Body */}
          {['POST', 'PUT', 'PATCH'].includes(apiMethod) && (
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1.5">Request Body (JSON)</label>
              <textarea value={apiBody} onChange={e => setApiBody(e.target.value)} placeholder='{ "key": "value" }' rows={4} className={inputCls + ' resize-none font-mono text-xs'} />
            </div>
          )}

          {/* Sample Response */}
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1.5">Expected Response <span className="text-gray-400">(optional)</span></label>
            <textarea value={apiSampleResp} onChange={e => setApiSampleResp(e.target.value)} placeholder='{ "status": "ok", "data": [...] }' rows={3} className={inputCls + ' resize-none font-mono text-xs'} />
          </div>

          <button onClick={runOnce(handleApiSubmit)} disabled={busy || !apiUrl.trim()} className="w-full py-2.5 bg-gradient-to-r from-violet-600 to-indigo-600 hover:from-violet-500 hover:to-indigo-500 disabled:opacity-40 text-white text-sm font-medium rounded-lg transition-all flex items-center justify-center gap-2">
            <Zap className="w-4 h-4" />Generate API Tests
          </button>
        </div>
      );
    }

    /* ── COLUMN SELECT — pick columns before generation ── */
    if (step === 'column-select') {
      return (
        <div className="max-w-md ml-11 bg-white border border-gray-100 rounded-xl p-5 shadow-sm">
          <div className="flex items-center gap-2 mb-4">
            <Layers className="w-4 h-4 text-violet-500" />
            <span className="text-sm font-semibold text-gray-800">Select Test Case Columns</span>
          </div>
          <p className="text-xs text-gray-500 mb-3">Choose which columns to include in your generated test cases.</p>
          <div className="space-y-1">
            {ALL_COLUMNS.map(col => (
              <label key={col.key} className="flex items-center gap-2.5 px-3 py-2 rounded-lg hover:bg-violet-50/50 cursor-pointer transition-colors">
                <input
                  type="checkbox"
                  checked={selectedColumns.includes(col.key)}
                  onChange={() => setSelectedColumns(prev =>
                    prev.includes(col.key) ? prev.filter(k => k !== col.key) : [...prev, col.key]
                  )}
                  className="w-4 h-4 rounded border-gray-300 text-violet-600 focus:ring-violet-500"
                />
                <span className="text-sm text-gray-700">{col.label}</span>
                {col.default && <span className="text-[10px] text-gray-400 ml-auto">(default)</span>}
              </label>
            ))}
          </div>
          <button
            onClick={runOnce(() => { setStep('generating'); runGeneration(pendingRequirements); })}
            disabled={busy || selectedColumns.length === 0}
            className="mt-4 inline-flex items-center gap-2 px-5 py-2 bg-gradient-to-r from-violet-600 to-indigo-600 hover:from-violet-500 hover:to-indigo-500 disabled:opacity-40 text-white text-sm font-medium rounded-lg transition-all"
          >
            <Zap className="w-3.5 h-3.5" />Generate Test Cases
          </button>
        </div>
      );
    }

    /* ── GENERATING / SCRIPT-GENERATING — simple loading indicator ── */
    if (step === 'generating' || step === 'script-generating') {
      const loadingText = step === 'script-generating' ? 'Generating scripts...' : 'Generating test cases...';
      return (
        <div className="max-w-md ml-11 flex items-center gap-2.5 px-4 py-3 bg-white border border-gray-100 rounded-xl shadow-sm">
          <Loader2 className="w-4 h-4 text-violet-500 animate-spin flex-shrink-0" />
          <span className="text-sm text-gray-600">{loadingText}</span>
        </div>
      );
    }

    /* ── RESULTS — paginated table with edit/delete/save ── */
    if (step === 'results' && results) {
      const priorityStyle = (p: string) =>
        p === 'P0' ? 'bg-red-50 text-red-700 border-red-200' :
        p === 'P1' ? 'bg-amber-50 text-amber-700 border-amber-200' :
        p === 'P2' ? 'bg-blue-50 text-blue-700 border-blue-200' :
        'bg-gray-50 text-gray-600 border-gray-200';
      const typeStyle = (t: string) =>
        t === 'positive' ? 'bg-emerald-50 text-emerald-700' :
        t === 'negative' ? 'bg-rose-50 text-rose-700' :
        t === 'edge' ? 'bg-orange-50 text-orange-700' :
        t === 'e2e' ? 'bg-violet-50 text-violet-700' :
        t === 'api' ? 'bg-sky-50 text-sky-700' :
        'bg-gray-50 text-gray-600';
      const colVisible = (key: string) => selectedColumns.includes(key);
      const allPageSelected = pagedTcs.length > 0 && pagedTcs.every((tc: any) => selectedTcIds.has(tc.id));

      return (
        <div className="ml-11 space-y-3 max-w-[920px]">
          {/* ── Header Bar ── */}
          <div className="bg-white border border-gray-100 rounded-xl px-4 py-3 shadow-sm flex items-center justify-between flex-wrap gap-2">
            <div className="flex items-center gap-3">
              <span className="text-sm font-semibold text-gray-800">
                <FileText className="w-4 h-4 inline -mt-0.5 mr-1 text-violet-500" />
                Test Cases ({totalTcs})
              </span>
              <select
                value={tcPageSize}
                onChange={e => { setTcPageSize(Number(e.target.value)); setTcPage(1); }}
                className="text-xs border border-gray-200 rounded-md px-2 py-1 text-gray-600 bg-white outline-none focus:border-violet-400"
              >
                {PAGE_SIZES.map(s => <option key={s} value={s}>{s} per page</option>)}
              </select>
            </div>
            <div className="flex items-center gap-2">
              {selectedTcIds.size > 0 && (
                <button onClick={deleteTcs} className="text-xs text-red-500 hover:text-red-700 flex items-center gap-1 px-2 py-1 rounded hover:bg-red-50 transition-colors">
                  <Trash2 className="w-3 h-3" />Delete Selected ({selectedTcIds.size})
                </button>
              )}
              <button
                onClick={handleSaveTestCases}
                disabled={isSaving || totalTcs === 0}
                className="px-4 py-1.5 bg-gradient-to-r from-violet-600 to-indigo-600 hover:from-violet-500 hover:to-indigo-500 disabled:opacity-40 text-white text-xs font-medium rounded-lg transition-all flex items-center gap-1.5"
              >
                {isSaving ? <><Loader2 className="w-3 h-3 animate-spin" />Saving...</> : <><Save className="w-3 h-3" />Save Test Cases</>}
              </button>
            </div>
          </div>

          {/* ── Select All Row ── */}
          <div className="flex items-center gap-2.5 px-4 py-2 bg-gray-50 rounded-lg">
            <input
              type="checkbox"
              checked={allPageSelected}
              onChange={toggleSelectAll}
              className="w-3.5 h-3.5 rounded border-gray-300 text-violet-600 focus:ring-violet-500"
            />
            <span className="text-xs text-gray-500">Select all on this page</span>
            {totalPages > 1 && <span className="text-[10px] text-gray-400 ml-auto">Showing {(tcPage - 1) * tcPageSize + 1}–{Math.min(tcPage * tcPageSize, totalTcs)} of {totalTcs}</span>}
          </div>

          {/* ── TC Cards ── */}
          <div className="space-y-2">
            {pagedTcs.map((tc: any) => {
              const isEditing = editingTcId === tc.id;
              const draft = isEditing ? editDraft : tc;
              return (
                <div key={tc.id} className={`bg-white border ${selectedTcIds.has(tc.id) ? 'border-violet-300 bg-violet-50/30' : 'border-gray-100'} rounded-xl p-4 shadow-sm transition-colors`}>
                  {/* Row header: checkbox + TC# + badges + actions */}
                  <div className="flex items-center gap-2 mb-2 flex-wrap">
                    <input
                      type="checkbox"
                      checked={selectedTcIds.has(tc.id)}
                      onChange={() => toggleTcSelect(tc.id)}
                      className="w-3.5 h-3.5 rounded border-gray-300 text-violet-600 focus:ring-violet-500"
                    />
                    {colVisible('tcNumber') && (
                      <span className="text-xs font-mono font-bold text-violet-600 bg-violet-50 px-2 py-0.5 rounded">{tc.id}</span>
                    )}
                    {colVisible('priority') && !isEditing && (
                      <span className={`text-[10px] px-2 py-0.5 font-semibold rounded border ${priorityStyle(tc.priority)}`}>{tc.priority}</span>
                    )}
                    {colVisible('priority') && isEditing && (
                      <select value={draft.priority} onChange={e => setEditDraft((d: any) => ({ ...d, priority: e.target.value }))} className="text-[10px] px-1.5 py-0.5 border border-violet-300 rounded bg-white text-gray-700 outline-none">
                        {['P0', 'P1', 'P2', 'P3'].map(p => <option key={p}>{p}</option>)}
                      </select>
                    )}
                    {colVisible('type') && !isEditing && (
                      <span className={`text-[10px] px-2 py-0.5 font-medium rounded ${typeStyle(tc.type)}`}>{tc.type}</span>
                    )}
                    {colVisible('type') && isEditing && (
                      <select value={draft.type} onChange={e => setEditDraft((d: any) => ({ ...d, type: e.target.value }))} className="text-[10px] px-1.5 py-0.5 border border-violet-300 rounded bg-white text-gray-700 outline-none">
                        {['positive', 'negative', 'edge', 'e2e', 'api', 'security', 'performance'].map(t => <option key={t}>{t}</option>)}
                      </select>
                    )}
                    {colVisible('status') && !isEditing && (
                      <span className="inline-flex items-center gap-1 px-2 py-0.5 text-[10px] font-medium rounded bg-emerald-50 text-emerald-600 border border-emerald-200">
                        <CheckCircle className="w-2.5 h-2.5" />{tc.status}
                      </span>
                    )}
                    {/* Actions */}
                    <div className="ml-auto flex items-center gap-1">
                      {isEditing ? (
                        <>
                          <button onClick={saveEdit} className="inline-flex items-center justify-center w-6 h-6 rounded-md bg-emerald-100 text-emerald-600 hover:bg-emerald-600 hover:text-white shadow-sm transition-all" title="Save"><Check className="w-3.5 h-3.5" /></button>
                          <button onClick={cancelEdit} className="inline-flex items-center justify-center w-6 h-6 rounded-md bg-gray-100 text-gray-500 hover:bg-gray-500 hover:text-white shadow-sm transition-all" title="Cancel"><X className="w-3.5 h-3.5" /></button>
                        </>
                      ) : (
                        <>
                          <button onClick={() => startEdit(tc)} className="inline-flex items-center justify-center w-6 h-6 rounded-md bg-indigo-100 text-indigo-600 hover:bg-indigo-600 hover:text-white shadow-sm transition-all" title="Edit"><Pencil className="w-3.5 h-3.5" /></button>
                          <button onClick={() => deleteSingleTc(tc.id)} className="inline-flex items-center justify-center w-6 h-6 rounded-md bg-red-100 text-red-500 hover:bg-red-600 hover:text-white shadow-sm transition-all" title="Delete"><Trash2 className="w-3.5 h-3.5" /></button>
                        </>
                      )}
                    </div>
                  </div>

                  {/* Title */}
                  {colVisible('title') && (
                    isEditing ? (
                      <input
                        value={draft.scenario}
                        onChange={e => setEditDraft((d: any) => ({ ...d, scenario: e.target.value }))}
                        className="w-full text-[13px] font-semibold text-gray-800 mb-2 px-2 py-1.5 border border-violet-300 rounded-lg outline-none focus:ring-1 focus:ring-violet-400 bg-white"
                      />
                    ) : (
                      <p className="text-[13px] font-semibold text-gray-800 mb-2">{tc.scenario}</p>
                    )
                  )}

                  {/* Steps + Expected side-by-side */}
                  {(colVisible('steps') || colVisible('expected')) && (
                    <div className={`grid gap-4 ${colVisible('steps') && colVisible('expected') ? 'grid-cols-[1fr_1fr]' : 'grid-cols-1'}`}>
                      {colVisible('steps') && (
                        <div>
                          <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider mb-1">Test Steps</p>
                          {isEditing ? (
                            <textarea
                              value={(draft.steps || []).join('\n')}
                              onChange={e => setEditDraft((d: any) => ({ ...d, steps: e.target.value.split('\n') }))}
                              rows={Math.max(3, (draft.steps || []).length)}
                              className="w-full text-xs text-gray-600 px-2 py-1.5 border border-violet-300 rounded-lg outline-none focus:ring-1 focus:ring-violet-400 resize-none bg-white font-normal"
                              placeholder="One step per line"
                            />
                          ) : (
                            <ul className="space-y-0.5 list-none">
                              {(tc.steps || []).map((s: string, j: number) => {
                                // The step text already carries its number (this is the value
                                // saved to the DB). Render it as-is so the number appears ONCE.
                                const m = s.match(/^\s*(\d+[.)])\s*(.*)$/s);
                                return (
                                  <li key={j} className="text-xs text-gray-600 leading-relaxed">
                                    {m
                                      ? <><span className="text-violet-500 font-semibold mr-1">{m[1]}</span>{m[2]}</>
                                      : s}
                                  </li>
                                );
                              })}
                            </ul>
                          )}
                        </div>
                      )}
                      {colVisible('expected') && (
                        <div>
                          <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider mb-1">Expected Result</p>
                          {isEditing ? (
                            <textarea
                              value={draft.expectedResult}
                              onChange={e => setEditDraft((d: any) => ({ ...d, expectedResult: e.target.value }))}
                              rows={3}
                              className="w-full text-xs text-gray-600 px-2 py-1.5 border border-violet-300 rounded-lg outline-none focus:ring-1 focus:ring-violet-400 resize-none bg-white font-normal"
                            />
                          ) : (
                            <p className="text-xs text-gray-600 leading-relaxed">{tc.expectedResult}</p>
                          )}
                        </div>
                      )}
                    </div>
                  )}

                  {/* Feature / Precondition (if visible and has content) */}
                  {(colVisible('feature') || colVisible('precondition')) && (
                    <div className="flex flex-wrap gap-4 mt-2">
                      {colVisible('feature') && (tc.feature || isEditing) && (
                        <div className="flex-1 min-w-[120px]">
                          <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider mb-0.5">Feature</p>
                          {isEditing ? (
                            <input
                              value={draft.feature}
                              onChange={e => setEditDraft((d: any) => ({ ...d, feature: e.target.value }))}
                              className="w-full text-xs px-2 py-1 border border-violet-300 rounded-lg outline-none bg-white"
                            />
                          ) : (
                            <p className="text-xs text-gray-500">{tc.feature}</p>
                          )}
                        </div>
                      )}
                      {colVisible('precondition') && (tc.precondition || isEditing) && (
                        <div className="flex-1 min-w-[120px]">
                          <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider mb-0.5">Preconditions</p>
                          {isEditing ? (
                            <input
                              value={draft.precondition}
                              onChange={e => setEditDraft((d: any) => ({ ...d, precondition: e.target.value }))}
                              className="w-full text-xs px-2 py-1 border border-violet-300 rounded-lg outline-none bg-white"
                            />
                          ) : (
                            <p className="text-xs text-gray-500">{tc.precondition}</p>
                          )}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {/* ── Pagination ── */}
          {totalPages > 1 && (
            <div className="flex items-center justify-center gap-3 py-2">
              <button
                disabled={tcPage <= 1}
                onClick={() => setTcPage(p => p - 1)}
                className="p-1.5 rounded-lg border border-gray-200 text-gray-500 hover:border-violet-300 hover:text-violet-600 disabled:opacity-30 disabled:hover:border-gray-200 disabled:hover:text-gray-500 transition-colors"
              >
                <ChevronLeft className="w-4 h-4" />
              </button>
              <span className="text-xs text-gray-500">Page {tcPage} of {totalPages}</span>
              <button
                disabled={tcPage >= totalPages}
                onClick={() => setTcPage(p => p + 1)}
                className="p-1.5 rounded-lg border border-gray-200 text-gray-500 hover:border-violet-300 hover:text-violet-600 disabled:opacity-30 disabled:hover:border-gray-200 disabled:hover:text-gray-500 transition-colors"
              >
                <ChevronRight className="w-4 h-4" />
              </button>
            </div>
          )}

          {/* ── Bottom Bar ── */}
          <div className="flex items-center gap-3">
            <button
              onClick={handleSaveTestCases}
              disabled={isSaving || totalTcs === 0}
              className="px-5 py-2.5 bg-gradient-to-r from-violet-600 to-indigo-600 hover:from-violet-500 hover:to-indigo-500 disabled:opacity-40 text-white text-sm font-medium rounded-lg transition-all flex items-center gap-2"
            >
              {isSaving ? <><Loader2 className="w-4 h-4 animate-spin" />Saving...</> : <><Save className="w-4 h-4" />Save Test Cases</>}
            </button>
            <button onClick={reset} className="inline-flex items-center gap-2 px-4 py-2.5 bg-white border border-gray-200 rounded-lg text-sm text-gray-600 hover:border-violet-300 hover:text-violet-600 transition-all">
              <RotateCcw className="w-3.5 h-3.5" />Start New
            </button>
          </div>
        </div>
      );
    }

    /* ── SAVED — export + proceed to scripts ── */
    if (step === 'saved') {
      return (
        <div className="max-w-md ml-11 space-y-4">
          {/* Success Message */}
          <div className="bg-white border border-emerald-200 rounded-xl p-5 shadow-sm">
            <div className="flex items-center gap-2 mb-2">
              <div className="w-8 h-8 rounded-full bg-emerald-100 flex items-center justify-center">
                <CheckCircle className="w-4.5 h-4.5 text-emerald-600" />
              </div>
              <div>
                <p className="text-sm font-semibold text-gray-800">Test Cases Saved!</p>
                <p className="text-xs text-gray-500">{results?.testCases?.length || 0} test cases saved to database.</p>
              </div>
            </div>
          </div>

          {/* Export Section */}
          <div className="bg-white border border-gray-100 rounded-xl p-3.5 shadow-sm">
            <div className="flex items-center gap-2 mb-2.5">
              <Download className="w-3.5 h-3.5 text-violet-500" />
              <span className="text-xs font-semibold text-gray-800">Export Test Cases</span>
            </div>
            <div className="grid grid-cols-3 gap-2">
              {[
                { format: 'csv', label: 'Excel CSV', icon: FileText },
                { format: 'jira', label: 'JIRA', icon: Link2 },
                { format: 'testrail', label: 'TestRail', icon: Clipboard },
              ].map(exp => (
                <button
                  key={exp.format}
                  onClick={() => handleExport(exp.format)}
                  disabled={isExporting}
                  className="group flex items-center justify-center gap-1.5 px-2 py-1.5 border border-gray-200 rounded-lg hover:border-violet-300 hover:bg-violet-50 disabled:opacity-50 transition-all"
                >
                  <exp.icon className="w-3.5 h-3.5 text-gray-400 group-hover:text-violet-500 transition-colors" />
                  <span className="text-xs font-medium text-gray-700">{exp.label}</span>
                </button>
              ))}
            </div>
            {isExporting && (
              <p className="text-xs text-violet-500 mt-2 flex items-center gap-1"><Loader2 className="w-3 h-3 animate-spin" />Exporting...</p>
            )}
          </div>

          {/* Proceed to Script Generation */}
          <div className="bg-white border border-gray-100 rounded-xl p-3.5 shadow-sm flex items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <Code className="w-3.5 h-3.5 text-indigo-500" />
                <span className="text-xs font-semibold text-gray-800">Automation Scripts</span>
              </div>
              <p className="text-[11px] text-gray-500 mt-0.5">Generate automation scripts for your saved test cases.</p>
            </div>
            <button
              onClick={runOnce(handleScriptGeneration)}
              disabled={busy}
              className="inline-flex flex-shrink-0 items-center gap-1.5 px-3 py-1.5 bg-gradient-to-r from-indigo-600 to-violet-600 hover:from-indigo-500 hover:to-violet-500 disabled:opacity-40 text-white text-xs font-medium rounded-lg transition-all"
            >
              <Code className="w-3.5 h-3.5" />Generate Scripts
            </button>
          </div>

          {/* Start New */}
          <button onClick={reset} className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-white border border-gray-200 rounded-lg text-xs text-gray-600 hover:border-violet-300 hover:text-violet-600 transition-all">
            <RotateCcw className="w-3.5 h-3.5" />Start New Test
          </button>
        </div>
      );
    }

    /* ── SCRIPT REVIEW — Code Viewer ── */
    if (step === 'script-review' && generatedScripts.length > 0) {
      return (
        <div className="max-w-2xl ml-11 space-y-3">
          <div className="bg-white border border-gray-100 rounded-xl shadow-sm overflow-hidden">
            {/* Header */}
            <div className="px-5 py-3 border-b border-gray-100 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Code className="w-4 h-4 text-violet-500" />
                <span className="text-sm font-semibold text-gray-800">Generated Scripts</span>
                <span className="text-xs px-2 py-0.5 bg-violet-50 text-violet-600 rounded-full">{generatedScripts.length} scripts</span>
              </div>
            </div>
            {/* Script list */}
            <div className="divide-y divide-gray-100 max-h-[300px] overflow-y-auto">
              {generatedScripts.map((s, i) => (
                <div key={i} className="px-5 py-2.5 flex items-center gap-3 hover:bg-gray-50/50">
                  <CheckCircle className="w-4 h-4 text-emerald-500 flex-shrink-0" />
                  <div className="flex-1 min-w-0">
                    <p className="text-xs font-mono text-gray-700 truncate">{s.fileName}</p>
                    <p className="text-[10px] text-gray-400">{s.testCaseId}</p>
                  </div>
                  <span className="text-[10px] px-1.5 py-0.5 bg-[#7C3AED]/5 text-[#7C3AED] rounded border border-[#7C3AED]/10 font-mono">.spec.ts</span>
                </div>
              ))}
            </div>
          </div>
          {/* Execute CTA */}
          <button
            onClick={runOnce(handleExecuteTests)}
            disabled={busy}
            className="inline-flex items-center gap-2 px-5 py-2 bg-gradient-to-r from-violet-600 to-indigo-600 hover:from-violet-500 hover:to-indigo-500 disabled:opacity-40 text-white text-sm font-medium rounded-lg transition-all"
          >
            <Play className="w-4 h-4" />Execute Test Suite
          </button>
        </div>
      );
    }

    /* ── EXECUTING — Live Execution Progress ── */
    if (step === 'executing') {
      const completedCount = executionResults.filter(r => r.status === 'passed' || r.status === 'failed').length;
      const percent = executionResults.length > 0 ? Math.round((completedCount / executionResults.length) * 100) : 0;
      return (
        <div className="max-w-2xl ml-11 space-y-3">
          <div className="bg-white border border-gray-100 rounded-xl p-5 shadow-sm">
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2">
                <Terminal className="w-4 h-4 text-violet-500 animate-pulse" />
                <span className="text-sm font-semibold text-gray-800">Test Execution</span>
              </div>
              <span className="text-xs text-gray-400">{completedCount}/{executionResults.length} completed</span>
            </div>
            {/* Progress bar */}
            <div className="w-full h-2 bg-gray-100 rounded-full overflow-hidden mb-4">
              <div className="h-full bg-gradient-to-r from-violet-500 to-indigo-500 rounded-full transition-all duration-500" style={{ width: `${percent}%` }} />
            </div>
            {/* Test list */}
            <div className="space-y-2 max-h-[350px] overflow-y-auto">
              {executionResults.map((r, i) => (
                <div key={i} className={`flex items-start gap-3 p-2.5 rounded-lg border ${
                  r.status === 'passed' ? 'bg-emerald-50/80 border-emerald-200/60' :
                  r.status === 'failed' ? 'bg-red-50/80 border-red-200/60' :
                  r.status === 'running' ? 'bg-violet-50/80 border-violet-200/60' :
                  'bg-gray-50/80 border-gray-200/60'
                }`}>
                  <div className="flex-shrink-0 mt-0.5">
                    {r.status === 'passed' ? <CheckCircle className="w-4 h-4 text-emerald-500" /> :
                     r.status === 'failed' ? <XCircle className="w-4 h-4 text-red-500" /> :
                     r.status === 'running' ? <Loader2 className="w-4 h-4 text-violet-500 animate-spin" /> :
                     <span className="block w-4 h-4 rounded-full border-2 border-gray-300" />}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className={`text-xs font-medium ${r.status === 'running' ? 'text-violet-700' : 'text-gray-800'}`}>{r.testName}.spec.ts</p>
                    {r.status === 'failed' && r.error && (
                      <p className="text-[11px] text-red-500 mt-0.5 truncate">{diagnoseFailure(r.error).title}</p>
                    )}
                  </div>
                  {(r.status === 'passed' || r.status === 'failed') && (
                    <span className="text-[11px] text-gray-400 flex-shrink-0">{r.duration}</span>
                  )}
                </div>
              ))}
            </div>
          </div>
        </div>
      );
    }

    /* ── EXECUTION RESULTS — Decision Point ── */
    if (step === 'execution-results' && executionSummary) {
      return (
        <div className="max-w-2xl ml-11 space-y-3">
          {/* Summary Cards */}
          <div className="grid grid-cols-4 gap-2">
            <div className="bg-white border border-gray-100 rounded-xl p-3 text-center shadow-sm">
              <p className="text-lg font-bold text-gray-800">{executionSummary.total}</p>
              <p className="text-[10px] text-gray-400 uppercase">Total</p>
            </div>
            <div className="bg-emerald-50 border border-emerald-200/60 rounded-xl p-3 text-center shadow-sm">
              <p className="text-lg font-bold text-emerald-600">{executionSummary.passed}</p>
              <p className="text-[10px] text-emerald-500 uppercase">Passed</p>
            </div>
            <div className={`border rounded-xl p-3 text-center shadow-sm ${executionSummary.failed > 0 ? 'bg-red-50 border-red-200/60' : 'bg-gray-50 border-gray-200/60'}`}>
              <p className={`text-lg font-bold ${executionSummary.failed > 0 ? 'text-red-600' : 'text-gray-400'}`}>{executionSummary.failed}</p>
              <p className={`text-[10px] uppercase ${executionSummary.failed > 0 ? 'text-red-500' : 'text-gray-400'}`}>Failed</p>
            </div>
            <div className="bg-white border border-gray-100 rounded-xl p-3 text-center shadow-sm">
              <p className="text-lg font-bold text-gray-800">{executionSummary.duration}</p>
              <p className="text-[10px] text-gray-400 uppercase">Duration</p>
            </div>
          </div>

          {/* Test Result List — failed rows show a plain-English diagnosis; the
              ⋯ button expands the fix hint + full raw Playwright error. */}
          <div className="bg-white border border-gray-100 rounded-xl p-4 shadow-sm space-y-2 max-h-[300px] overflow-y-auto">
            {executionResults.map((r, i) => {
              const diag = r.status === 'failed' ? diagnoseFailure(r.error) : null;
              const expanded = expandedResults.has(i);
              return (
                <div key={i} className={`p-2 rounded-lg ${r.status === 'failed' ? 'bg-red-50/50' : r.status === 'not_run' ? 'bg-gray-50/70' : ''}`}>
                  <div className="flex items-start gap-3">
                    <div className="flex-shrink-0 mt-0.5">
                      {r.status === 'passed' ? <CheckCircle className="w-4 h-4 text-emerald-500" /> :
                       r.status === 'not_run' ? <SkipForward className="w-4 h-4 text-gray-400" /> :
                       <XCircle className="w-4 h-4 text-red-500" />}
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-xs font-medium text-gray-800">{r.testName}.spec.ts</p>
                      {diag && <p className="text-[11px] text-red-600 mt-0.5">{diag.title}</p>}
                      {r.status === 'not_run' && (
                        <p className="text-[11px] text-gray-500 mt-0.5">Not run{r.error ? ` — ${r.error}` : ''}</p>
                      )}
                    </div>
                    <span className="text-[11px] text-gray-400 flex-shrink-0">{r.duration}</span>
                    {diag && r.error && (
                      <button
                        onClick={() => toggleResultExpanded(i)}
                        title={expanded ? 'Hide error details' : 'Show error details'}
                        aria-expanded={expanded}
                        className={`flex-shrink-0 p-1 rounded-md transition-colors ${expanded ? 'bg-red-100 text-red-600' : 'text-gray-400 hover:bg-red-100 hover:text-red-600'}`}
                      >
                        <MoreHorizontal className="w-4 h-4" />
                      </button>
                    )}
                  </div>
                  {diag && r.error && expanded && (
                    <div className="mt-2 ml-7 mr-1 space-y-1.5">
                      <p className="text-[11px] text-gray-600"><span className="font-medium text-gray-700">How to fix:</span> {diag.hint}</p>
                      <pre className="text-[10px] leading-relaxed text-red-700/90 bg-red-50 border border-red-100 rounded-md p-2 max-h-40 overflow-auto whitespace-pre-wrap break-words">{r.error}</pre>
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {/* Run separately — re-execute just the failing OR just the flaky
              (auto-healed) subset in place. Failures are auto-registered in the
              Bug Tracker, where the same split re-run is also available. */}
          {(() => {
            const healedIds = new Set(healingLog.filter((l) => l.result === 'fixed').map((l) => l.testCaseId));
            const failCount = executionResults.filter((r) => r.status === 'failed').length;
            const flakyCount = executionResults.filter((r) => r.status === 'passed' && healedIds.has(r.testCaseId)).length;
            if (failCount === 0 && flakyCount === 0) return null;
            return (
              <div className="bg-white border border-gray-100 rounded-xl p-3 shadow-sm">
                <p className="text-[11px] font-semibold text-gray-500 uppercase tracking-wide mb-2">Run separately</p>
                <div className="flex gap-2">
                  <button
                    onClick={() => handleRerunSubset('failure')}
                    disabled={!!rerunKind || failCount === 0}
                    className="flex-1 py-2 bg-red-50 hover:bg-red-100 disabled:opacity-40 disabled:cursor-not-allowed text-red-700 border border-red-200 text-xs font-medium rounded-lg transition-all flex items-center justify-center gap-1.5"
                    title={failCount === 0 ? 'No failing tests' : 'Re-run only the failing tests'}
                  >
                    {rerunKind === 'failure' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <XCircle className="w-3.5 h-3.5" />}
                    Re-run Failures{failCount > 0 ? ` (${failCount})` : ''}
                  </button>
                  <button
                    onClick={() => handleRerunSubset('flaky')}
                    disabled={!!rerunKind || flakyCount === 0}
                    className="flex-1 py-2 bg-amber-50 hover:bg-amber-100 disabled:opacity-40 disabled:cursor-not-allowed text-amber-700 border border-amber-200 text-xs font-medium rounded-lg transition-all flex items-center justify-center gap-1.5"
                    title={flakyCount === 0 ? 'No flaky (auto-healed) tests yet — heal first' : 'Re-run only the flaky (auto-healed) tests'}
                  >
                    {rerunKind === 'flaky' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Zap className="w-3.5 h-3.5" />}
                    Re-run Flaky{flakyCount > 0 ? ` (${flakyCount})` : ''}
                  </button>
                </div>
              </div>
            );
          })()}

          {/* Decision Buttons */}
          <div className="flex gap-2">
            {executionSummary.failed > 0 && healingAttempt < 2 && (
              <button
                onClick={runOnce(handleAutoHeal)}
                disabled={busy || !!rerunKind}
                className="flex-1 py-2.5 bg-gradient-to-r from-amber-500 to-orange-500 hover:from-amber-400 hover:to-orange-400 disabled:opacity-40 text-white text-sm font-medium rounded-lg transition-all flex items-center justify-center gap-2"
              >
                <Wrench className="w-4 h-4" />Auto-Heal & Re-Execute
              </button>
            )}
            <button
              onClick={runOnce(handleProceedToReport)}
              disabled={busy}
              className={`${executionSummary.failed > 0 && healingAttempt < 2 ? 'flex-1' : 'w-full'} py-2.5 bg-gradient-to-r from-violet-600 to-indigo-600 hover:from-violet-500 hover:to-indigo-500 disabled:opacity-40 text-white text-sm font-medium rounded-lg transition-all flex items-center justify-center gap-2`}
            >
              <BarChart3 className="w-4 h-4" />Generate Report
            </button>
          </div>

          {/* Push generated tests + scripts straight to the connected repo, and
              escalate failures/flaky tests to the team's notification channel.
              Both are available as soon as the agents finish. */}
          {(() => {
            // Escalation to Support is offered only once auto-healing has run its
            // full course (2 attempts) and tests are STILL failing. Before that
            // the user is steered to Auto-Heal instead — the heal button and the
            // support button are mutually exclusive by design.
            const healExhausted = healingAttempt >= 2 && executionSummary.failed > 0;
            const hasEscalatable = healExhausted;
            return (
              <div className="flex gap-2">
                <button
                  onClick={handleQuickPushToGit}
                  disabled={gitPush.status === 'pushing' || generatedScripts.length === 0}
                  className="flex-1 py-2 bg-white border border-gray-800 hover:bg-gray-900 hover:text-white text-gray-800 disabled:opacity-40 text-sm font-medium rounded-lg transition-all flex items-center justify-center gap-2"
                  title="Push the generated test cases and scripts to your connected repository"
                >
                  {gitPush.status === 'pushing' ? <Loader2 className="w-4 h-4 animate-spin" />
                    : gitPush.status === 'done' ? <CheckCircle className="w-4 h-4 text-emerald-500" />
                    : <Github className="w-4 h-4" />}
                  {gitPush.status === 'done' ? 'Pushed to GitHub' : gitPush.status === 'pushing' ? 'Pushing…' : 'Push to GitHub'}
                </button>
                {hasEscalatable && (
                  <button
                    onClick={handleReportToSupport}
                    disabled={supportState.status === 'sending'}
                    className="flex-1 py-2 bg-white border border-rose-300 hover:bg-rose-50 text-rose-600 disabled:opacity-40 text-sm font-medium rounded-lg transition-all flex items-center justify-center gap-2"
                    title="Send a failure summary to your team (email / Slack / Teams)"
                  >
                    {supportState.status === 'sending' ? <Loader2 className="w-4 h-4 animate-spin" />
                      : supportState.status === 'sent' ? <CheckCircle className="w-4 h-4 text-emerald-500" />
                      : <LifeBuoy className="w-4 h-4" />}
                    {supportState.status === 'sent' ? 'Reported' : 'Report to Support'}
                  </button>
                )}
              </div>
            );
          })()}
          {gitPush.status === 'done' && gitPush.prUrl && (
            <a href={gitPush.prUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5 text-xs font-medium text-violet-700 hover:text-violet-800 break-all">
              <ExternalLink className="w-3.5 h-3.5 flex-shrink-0" /> {gitPush.prUrl}
            </a>
          )}
        </div>
      );
    }

    /* ── HEALING — Auto-Healing Progress ── */
    if (step === 'healing') {
      return (
        <div className="max-w-2xl ml-11 space-y-3">
          <div className="bg-white border border-amber-200/60 rounded-xl p-5 shadow-sm">
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-2">
                <Wrench className="w-4 h-4 text-amber-500 animate-pulse" />
                <span className="text-sm font-semibold text-gray-800">Auto-Healing Agent</span>
              </div>
              <span className="text-xs px-2 py-0.5 bg-amber-50 text-amber-600 rounded-full border border-amber-200">Attempt {healingAttempt} of 2</span>
            </div>
            <div className="space-y-3">
              {healingLog.map((entry, i) => (
                <div key={i} className="bg-gray-50 rounded-lg p-3 border border-gray-100">
                  <div className="flex items-center gap-2 mb-1.5">
                    {entry.result === 'fixed'
                      ? <CheckCircle className="w-3.5 h-3.5 text-emerald-500" />
                      : <XCircle className="w-3.5 h-3.5 text-red-500" />}
                    <span className="text-xs font-semibold text-gray-800">{entry.testCaseId}</span>
                    <span className={`text-[10px] px-1.5 py-0.5 rounded-full ${entry.result === 'fixed' ? 'bg-emerald-50 text-emerald-600' : 'bg-red-50 text-red-600'}`}>
                      {entry.result === 'fixed' ? 'FIXED' : 'STILL FAILING'}
                    </span>
                  </div>
                  <p className="text-[11px] text-red-500 mb-1"><AlertTriangle className="w-3 h-3 inline mr-1" />{entry.error}</p>
                  <p className="text-[11px] text-amber-600"><Wrench className="w-3 h-3 inline mr-1" />{entry.fix}</p>
                </div>
              ))}
              {/* Show progress indicator while still healing */}
              {healingLog.length < executionResults.filter(r => r.status === 'failed').length && (
                <div className="flex items-center gap-2 p-3">
                  <Loader2 className="w-4 h-4 text-amber-500 animate-spin" />
                  <span className="text-xs text-gray-500">Analyzing next failure...</span>
                </div>
              )}
            </div>
          </div>
        </div>
      );
    }

    /* ── REPORT — Test Execution Report ── */
    if (step === 'report' && reportData) {
      return (
        <div className="max-w-2xl ml-11 space-y-3">
          <div className="bg-white border border-gray-100 rounded-xl shadow-sm overflow-hidden">
            {/* Header */}
            <div className="px-5 py-4 bg-gradient-to-r from-violet-50 to-indigo-50 border-b border-violet-100">
              <div className="flex items-center gap-2 mb-2">
                <BarChart3 className="w-4.5 h-4.5 text-violet-600" />
                <span className="text-sm font-semibold text-[#1E1B4B]">Test Execution Report</span>
              </div>
              {/* Pass rate bar */}
              <div className="flex items-center gap-3">
                <div className="flex-1 h-3 bg-white rounded-full overflow-hidden border border-violet-100">
                  <div className={`h-full rounded-full transition-all duration-1000 ${reportData.passRate >= 90 ? 'bg-emerald-500' : reportData.passRate >= 70 ? 'bg-amber-500' : 'bg-red-500'}`} style={{ width: `${reportData.passRate}%` }} />
                </div>
                <span className={`text-lg font-bold ${reportData.passRate >= 90 ? 'text-emerald-600' : reportData.passRate >= 70 ? 'text-amber-600' : 'text-red-600'}`}>{reportData.passRate}%</span>
              </div>
            </div>
            {/* Metrics grid */}
            <div className="grid grid-cols-3 gap-px bg-gray-100">
              {[
                { label: 'Total Tests', value: reportData.totalTests, color: 'text-gray-800' },
                { label: 'Passed', value: reportData.passed, color: reportData.passed > 0 ? 'text-emerald-600' : 'text-gray-400' },
                { label: 'Failed', value: reportData.failed, color: reportData.failed > 0 ? 'text-red-600' : 'text-gray-400' },
                { label: 'Auto-Healed', value: reportData.healed, color: reportData.healed > 0 ? 'text-amber-600' : 'text-gray-400' },
                { label: 'Execution Time', value: reportData.executionTime, color: 'text-gray-800' },
                { label: 'Healing Needed', value: reportData.healingRequired ? 'Yes' : 'No', color: reportData.healingRequired ? 'text-amber-600' : 'text-emerald-600' },
              ].map((m, i) => (
                <div key={i} className="bg-white p-3 text-center">
                  <p className={`text-base font-bold ${m.color}`}>{m.value}</p>
                  <p className="text-[10px] text-gray-400 uppercase">{m.label}</p>
                </div>
              ))}
            </div>
            {/* Not-run callout — without this, "0 failed" next to "0 passed"
                reads as a healthy run when in fact nothing executed. */}
            {(reportData.notRun ?? 0) > 0 && (
              <div className="px-5 py-2.5 border-t border-amber-100 bg-amber-50/60 flex items-center gap-2">
                <AlertTriangle className="w-3.5 h-3.5 text-amber-500 flex-shrink-0" />
                <p className="text-[11px] text-amber-700">
                  {reportData.notRun} of {reportData.totalTests} test(s) could not be run — open the execution results above for the reason on each test.
                </p>
              </div>
            )}
            {/* Healing summary if applicable */}
            {healingLog.length > 0 && (
              <div className="px-5 py-3 border-t border-gray-100">
                <p className="text-xs font-semibold text-gray-700 mb-2 flex items-center gap-1"><Wrench className="w-3.5 h-3.5 text-amber-500" />Healing Summary</p>
                <div className="space-y-1">
                  {healingLog.map((entry, i) => (
                    <p key={i} className="text-[11px] text-gray-600">
                      <span className={`font-semibold ${entry.result === 'fixed' ? 'text-emerald-600' : 'text-red-500'}`}>{entry.testCaseId}:</span> {entry.fix}
                    </p>
                  ))}
                </div>
              </div>
            )}
          </div>
          {/* Action buttons */}
          <div className="flex items-center flex-wrap gap-3">
            <button
              onClick={handleQuickPushToGit}
              disabled={gitPush.status === 'pushing' || generatedScripts.length === 0}
              className="inline-flex items-center gap-2 px-4 py-2 bg-gray-900 hover:bg-gray-800 disabled:opacity-40 text-white text-sm font-medium rounded-lg transition-all"
              title="Push the generated test cases and scripts to your connected repository"
            >
              {gitPush.status === 'pushing' ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                : gitPush.status === 'done' ? <CheckCircle className="w-3.5 h-3.5" />
                : <Github className="w-3.5 h-3.5" />}
              {gitPush.status === 'done' ? 'Pushed to GitHub' : gitPush.status === 'pushing' ? 'Pushing…' : 'Push to GitHub'}
            </button>
            {(reportData.failed > 0 || reportData.healed > 0) && (
              <button
                onClick={handleReportToSupport}
                disabled={supportState.status === 'sending'}
                className="inline-flex items-center gap-2 px-4 py-2 bg-white border border-rose-300 text-rose-600 hover:bg-rose-50 disabled:opacity-40 text-sm font-medium rounded-lg transition-all"
                title="Send a failure summary to your team (email / Slack / Teams)"
              >
                {supportState.status === 'sending' ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  : supportState.status === 'sent' ? <CheckCircle className="w-3.5 h-3.5 text-emerald-500" />
                  : <LifeBuoy className="w-3.5 h-3.5" />}
                {supportState.status === 'sent' ? 'Reported' : 'Report to Support'}
              </button>
            )}
            <button
              onClick={() => setStep('publish')}
              className="inline-flex items-center gap-2 px-4 py-2 bg-white border border-violet-300 text-violet-700 hover:bg-violet-50 text-sm font-medium rounded-lg transition-all"
              title="Open the guided Pull Request flow"
            >
              <GitBranch className="w-3.5 h-3.5" />Create PR…
            </button>
            <button onClick={reset} className="inline-flex items-center gap-2 px-4 py-2 bg-white border border-gray-200 rounded-lg text-sm text-gray-600 hover:border-violet-300 hover:text-violet-600 transition-all">
              <RotateCcw className="w-3.5 h-3.5" />Start New Test
            </button>
          </div>
          {gitPush.status === 'done' && gitPush.prUrl && (
            <a href={gitPush.prUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5 text-xs font-medium text-violet-700 hover:text-violet-800 break-all">
              <ExternalLink className="w-3.5 h-3.5 flex-shrink-0" /> {gitPush.prUrl}
            </a>
          )}
        </div>
      );
    }

    /* ── PUBLISH — Git Publish ── */
    if (step === 'publish') {
      return (
        <div className="max-w-md ml-11 space-y-3">
          {publishResult === 'success' ? (
            /* Success state */
            <div className="bg-white border border-emerald-200 rounded-xl p-5 shadow-sm">
              <div className="flex items-center gap-2 mb-3">
                <div className="w-8 h-8 rounded-full bg-emerald-100 flex items-center justify-center">
                  <CheckCircle className="w-4.5 h-4.5 text-emerald-600" />
                </div>
                <div>
                  <p className="text-sm font-semibold text-gray-800">Pull Request Created!</p>
                  <p className="text-xs text-gray-500">Pull request created with {generatedScripts.length} test scripts</p>
                </div>
              </div>
              <div className="space-y-2 mt-3">
                {[
                  { icon: CheckCircle, text: `${generatedScripts.length} test scripts added`, color: 'text-emerald-600' },
                  { icon: GitBranch, text: `Branch: ${gitBranch}`, color: 'text-violet-600' },
                  { icon: Workflow, text: 'PR ready for review', color: 'text-indigo-600' },
                ].map((item, i) => (
                  <div key={i} className="flex items-center gap-2">
                    <item.icon className={`w-3.5 h-3.5 ${item.color}`} />
                    <span className="text-xs text-gray-700">{item.text}</span>
                  </div>
                ))}
              </div>
              {publishedPrUrl && (
                <a
                  href={publishedPrUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="mt-3 inline-flex items-center gap-1.5 text-xs font-medium text-violet-700 hover:text-violet-800 break-all"
                >
                  <ExternalLink className="w-3.5 h-3.5 flex-shrink-0" />
                  <span>{publishedPrUrl}</span>
                </a>
              )}
            </div>
          ) : (
            /* Form state */
            <div className="bg-white border border-gray-100 rounded-xl p-5 shadow-sm">
              <div className="flex items-center gap-2 mb-4">
                <GitBranch className="w-4 h-4 text-violet-500" />
                <span className="text-sm font-semibold text-gray-800">Create Pull Request</span>
              </div>
              <div className="space-y-3">
                {connectedRepos.length === 0 ? (
                  <div className="bg-amber-50 border border-amber-200 rounded-lg p-3">
                    <p className="text-xs text-amber-700">
                      No connected repository found. Connect GitHub, GitLab, or Bitbucket under{' '}
                      <span className="font-semibold">System Configuration → Code Repositories</span>, then come back here.
                    </p>
                  </div>
                ) : (
                  <div>
                    <label className="block text-xs font-medium text-gray-600 mb-1">Repository</label>
                    <select
                      value={selectedRepoId}
                      onChange={(e) => {
                        const id = e.target.value;
                        setSelectedRepoId(id);
                        const repo = connectedRepos.find((r) => r.integrationId === id);
                        if (repo) { setGitRepoUrl(repo.repoUrl); setGitBranch(repo.branch); }
                      }}
                      className={inputCls}
                    >
                      {connectedRepos.map((r) => (
                        <option key={r.integrationId} value={r.integrationId}>
                          {r.name}{r.repoUrl ? ` — ${r.repoUrl}` : ''}
                        </option>
                      ))}
                    </select>
                    {(() => {
                      const repo = connectedRepos.find((r) => r.integrationId === selectedRepoId);
                      if (!repo) return null;
                      return (
                        <p className="mt-1.5 text-xs text-gray-500">
                          Target branch <span className="font-medium text-gray-700">{repo.branch}</span>
                          {' · '}folder <span className="font-medium text-gray-700">{repo.scriptsPath || 'tests/'}</span>
                        </p>
                      );
                    })()}
                  </div>
                )}
                <div className="bg-gray-50 rounded-lg p-3 border border-gray-100">
                  <p className="text-xs text-gray-500 mb-1">Files to publish:</p>
                  <p className="text-xs font-medium text-gray-700">{generatedScripts.length} test scripts (.spec.ts)</p>
                  {generatedPageObjects.length > 0 && (
                    <p className="text-xs font-medium text-gray-700">{generatedPageObjects.length} page objects (src/pages)</p>
                  )}
                  {(results?.testCases?.length ?? 0) > 0 && (
                    <p className="text-xs font-medium text-gray-700">{results.testCases.length} test cases (docs/TEST-CASES.md + .csv)</p>
                  )}
                  {reportData && <p className="text-xs font-medium text-gray-700">Test execution report</p>}
                </div>
              </div>
              <button
                onClick={handlePublishToGit}
                disabled={!selectedRepoId || isPublishing}
                className="mt-4 w-full py-2.5 bg-gradient-to-r from-violet-600 to-indigo-600 hover:from-violet-500 hover:to-indigo-500 disabled:opacity-40 text-white text-sm font-medium rounded-lg transition-all flex items-center justify-center gap-2"
              >
                {isPublishing ? <Loader2 className="w-4 h-4 animate-spin" /> : <ExternalLink className="w-4 h-4" />}
                {isPublishing ? 'Creating PR...' : 'Create PR'}
              </button>
            </div>
          )}
          <button onClick={reset} className="inline-flex items-center gap-2 px-4 py-2 bg-white border border-gray-200 rounded-lg text-sm text-gray-600 hover:border-violet-300 hover:text-violet-600 transition-all">
            <RotateCcw className="w-3.5 h-3.5" />Start New Test
          </button>
        </div>
      );
    }

    return null;
  };

  /* ═══════════════════════════════════════════════════════════════
     PIPELINE SIDEBAR RENDERER
     ═══════════════════════════════════════════════════════════════ */
  const renderPipelineSidebar = () => (
    <aside className="w-72 flex-shrink-0 border-l border-[#DDD6FE]/60 bg-white/90 backdrop-blur-sm overflow-y-auto">
      <div className="p-5">
        {/* Title */}
        <div className="flex items-center gap-2 mb-4">
          <div className="w-7 h-7 rounded-lg bg-gradient-to-br from-[#7C3AED] to-[#6366F1] flex items-center justify-center">
            <Workflow className="w-3.5 h-3.5 text-white" />
          </div>
          <h3 className="text-sm font-semibold text-[#1E1B4B]">AI Pipeline Progress</h3>
          {pipelineActive && (
            <span className={`ml-auto text-[10px] font-semibold px-2 py-0.5 rounded-full ${
              pipelineControl === 'paused'
                ? 'bg-amber-50 text-amber-600 border border-amber-200'
                : 'bg-emerald-50 text-emerald-600 border border-emerald-200'
            }`}>
              {pipelineControl === 'paused' ? 'Paused' : 'Running'}
            </span>
          )}
        </div>

        {/* Run controls — Pause / Resume / Stop the active workflow. Shown only
            while a stage is running (or held), since there's nothing to control
            otherwise. Pause holds the UI's advancement without losing the
            server-side run; Stop discards the active flow. */}
        {pipelineActive && (
          <div className="flex items-center gap-2 mb-5">
            {pipelineControl === 'paused' ? (
              <button
                onClick={resumePipeline}
                className="flex-1 inline-flex items-center justify-center gap-1.5 py-1.5 bg-gradient-to-r from-[#7C3AED] to-[#6366F1] hover:opacity-90 text-white text-xs font-medium rounded-lg transition-all"
                title="Resume the workflow"
              >
                <Play className="w-3.5 h-3.5" />Resume
              </button>
            ) : (
              <button
                onClick={pausePipeline}
                disabled={!canPause}
                className="flex-1 inline-flex items-center justify-center gap-1.5 py-1.5 bg-white border border-amber-300 text-amber-600 hover:bg-amber-50 disabled:opacity-40 disabled:cursor-not-allowed text-xs font-medium rounded-lg transition-all"
                title={canPause
                  ? 'Pause the workflow (the current stage keeps running on the server)'
                  : 'This stage cannot be paused — you can still stop the run'}
              >
                <Pause className="w-3.5 h-3.5" />Pause
              </button>
            )}
            <button
              onClick={stopPipeline}
              className="flex-1 inline-flex items-center justify-center gap-1.5 py-1.5 bg-white border border-rose-300 text-rose-600 hover:bg-rose-50 text-xs font-medium rounded-lg transition-all"
              title="Stop the workflow and discard the active run"
            >
              <Square className="w-3.5 h-3.5" />Stop
            </button>
          </div>
        )}

        {/* Stages */}
        <div className="relative">
          {pipelineStages.map((stage, idx) => {
            const info = PIPELINE_STAGES[idx];
            const Icon = info.icon;
            const isLast = idx === pipelineStages.length - 1;

            // Per-agent timing: live elapsed while running, frozen once terminal.
            const elapsedMs = stage.status === 'running' && stage.startedAt
              ? Math.max(0, (nowTick || Date.now()) - stage.startedAt)
              : (stage.status === 'completed' || stage.status === 'skipped')
                ? stage.durationMs
                : undefined;
            const timeLabel = elapsedMs !== undefined ? formatHMS(elapsedMs) : null;

            return (
              <div key={stage.key} className="relative flex gap-3 pb-6">
                {/* Vertical connecting line */}
                {!isLast && (
                  <div className="absolute left-[15px] top-[32px] w-0.5 h-[calc(100%-20px)]" style={{
                    background: stage.status === 'completed'
                      ? '#10B981'
                      : stage.status === 'skipped'
                        ? '#9CA3AF'
                        : stage.status === 'running'
                          ? 'linear-gradient(to bottom, #7C3AED, #E5E7EB)'
                          : '#E5E7EB',
                  }} />
                )}

                {/* Status indicator */}
                <div className="relative z-10 flex-shrink-0">
                  {stage.status === 'completed' ? (
                    <div className="w-8 h-8 rounded-full bg-[#10B981] flex items-center justify-center shadow-sm shadow-emerald-200">
                      <Check className="w-4 h-4 text-white" />
                    </div>
                  ) : stage.status === 'running' ? (
                    <div className="w-8 h-8 rounded-full bg-[#7C3AED] flex items-center justify-center shadow-md shadow-violet-300 animate-pulse">
                      <Loader2 className="w-4 h-4 text-white animate-spin" />
                    </div>
                  ) : stage.status === 'skipped' ? (
                    <div className="w-8 h-8 rounded-full bg-gray-200 flex items-center justify-center">
                      <SkipForward className="w-3.5 h-3.5 text-gray-500" />
                    </div>
                  ) : (
                    <div className="w-8 h-8 rounded-full border-2 border-[#D1D5DB] bg-white flex items-center justify-center">
                      <div className="w-2 h-2 rounded-full bg-[#D1D5DB]" />
                    </div>
                  )}
                </div>

                {/* Stage info */}
                <div className="flex-1 min-w-0 pt-1">
                  <div className="flex items-center gap-1.5">
                    <Icon className={`w-3.5 h-3.5 flex-shrink-0 ${
                      stage.status === 'completed' ? 'text-[#1E1B4B]' :
                      stage.status === 'running' ? 'text-[#7C3AED]' :
                      stage.status === 'skipped' ? 'text-gray-400' :
                      'text-[#D1D5DB]'
                    }`} />
                    <p className={`text-sm font-medium truncate ${
                      stage.status === 'completed' ? 'text-[#1E1B4B]' :
                      stage.status === 'running' ? 'text-[#7C3AED]' :
                      stage.status === 'skipped' ? 'text-gray-400 line-through' :
                      'text-[#9CA3AF]'
                    }`}>
                      {info.name}
                    </p>
                    {timeLabel && (
                      <span className={`ml-auto flex-shrink-0 font-mono text-[10px] tabular-nums px-1.5 py-0.5 rounded ${
                        stage.status === 'running'
                          ? 'bg-[#F5F3FF] text-[#7C3AED]'
                          : stage.status === 'skipped'
                            ? 'bg-gray-100 text-gray-400'
                            : 'bg-emerald-50 text-emerald-600'
                      }`}>
                        {timeLabel}
                      </span>
                    )}
                  </div>
                  <p className={`text-[11px] mt-0.5 ${
                    stage.status === 'completed' ? 'text-[#1E1B4B]' :
                    stage.status === 'running' ? 'text-[#7C3AED]' :
                    stage.status === 'skipped' ? 'text-gray-400' :
                    'text-[#9CA3AF]'
                  }`}>
                    {stage.detail}
                  </p>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </aside>
  );

  /* ═══════════════════════════════════════════════════════════════
     MAIN RENDER
     ═══════════════════════════════════════════════════════════════ */
  return (
    <div className="h-full flex flex-col bg-[#FAFAFE]">
      {/* Two-Column Layout: Chat + Pipeline Sidebar */}
      <div className="flex-1 flex overflow-hidden">
        {/* Left: Chat Area */}
        <div className="relative flex-1 flex flex-col overflow-hidden min-w-0">
          {/* Floating controls (chat area only) */}
          <div className="absolute top-3 right-4 z-10 flex items-center gap-2">
            <button
              onClick={handleVoiceToggle}
              title={voiceEnabled ? 'Mute Tessa voice' : 'Enable Tessa voice'}
              className={`p-1.5 rounded-lg border transition-all ${
                voiceEnabled
                  ? 'text-violet-500 bg-white border-violet-200 hover:bg-violet-50'
                  : 'text-gray-400 bg-white border-gray-200 hover:text-gray-600 hover:bg-gray-50'
              }`}
            >
              {voiceEnabled ? <Volume2 className="w-4 h-4" /> : <VolumeX className="w-4 h-4" />}
            </button>
            {step !== 'welcome' && (
              <button
                onClick={requestReset}
                title="New chat"
                className="flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium text-gray-600 bg-white border border-gray-200 rounded-lg hover:text-violet-600 hover:border-violet-200 transition-colors"
              >
                <RotateCcw className="w-3.5 h-3.5" />New
              </button>
            )}
          </div>

          {/* Discard current flow confirmation */}
          {showResetConfirm && (
            <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm" onClick={() => setShowResetConfirm(false)}>
              <div className="bg-white rounded-2xl shadow-2xl p-6 max-w-md w-full mx-4" onClick={e => e.stopPropagation()}>
                <div className="flex items-start gap-3">
                  <div className="w-10 h-10 rounded-full bg-amber-100 flex items-center justify-center flex-shrink-0">
                    <RotateCcw className="w-5 h-5 text-amber-600" />
                  </div>
                  <div className="flex-1">
                    <h3 className="text-base font-semibold text-gray-900">Discard current flow?</h3>
                    <p className="text-sm text-gray-500 mt-1">Your in-progress chat will be lost. This action cannot be undone.</p>
                  </div>
                </div>
                <div className="flex justify-end gap-2 mt-5">
                  <button
                    onClick={() => setShowResetConfirm(false)}
                    className="px-4 py-2 text-sm font-medium text-gray-700 bg-gray-100 rounded-lg hover:bg-gray-200 transition-colors"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={() => { setShowResetConfirm(false); reset(); }}
                    className="px-4 py-2 text-sm font-medium text-white bg-red-600 rounded-lg hover:bg-red-700 transition-colors"
                  >
                    Discard &amp; Continue
                  </button>
                </div>
              </div>
            </div>
          )}
          <div className="flex-1 overflow-y-auto px-6 py-5">
            <div className={`mx-auto space-y-4 ${step === 'results' ? 'max-w-4xl' : 'max-w-2xl'}`}>
              {/* Session restored banner */}
              {sessionRestored && (
                <div className="flex items-center gap-2.5 px-4 py-2.5 bg-violet-50 border border-violet-200 rounded-xl text-sm text-violet-700 animate-fadeIn">
                  <RotateCcw className="w-3.5 h-3.5 flex-shrink-0" />
                  <span>Your previous session has been restored. Continue from where you left off.</span>
                  <button onClick={() => setSessionRestored(false)} className="ml-auto text-violet-400 hover:text-violet-600">
                    <X className="w-3.5 h-3.5" />
                  </button>
                </div>
              )}
              {/* Messages */}
              {messages.map(msg => (
                <div key={msg.id} className={`flex ${msg.sender === 'user' ? 'justify-end' : 'justify-start'} animate-fadeIn`}>
                  {msg.sender === 'tessa' && (
                    <div className="w-7 h-7 rounded-full bg-gradient-to-br from-violet-500 to-indigo-600 flex items-center justify-center mr-2 flex-shrink-0 mt-0.5">
                      <Bot className="w-3.5 h-3.5 text-white" />
                    </div>
                  )}
                  <div className={`max-w-[75%] px-4 py-2.5 text-sm leading-relaxed ${
                    msg.sender === 'user'
                      ? 'bg-gradient-to-r from-violet-600 to-indigo-600 text-white rounded-2xl rounded-br-md shadow-sm'
                      : 'bg-white border border-gray-100 text-gray-700 rounded-2xl rounded-bl-md shadow-sm'
                  }`}>
                    {msg.text}
                  </div>
                </div>
              ))}

              {/* Active Panel */}
              <div className="pt-1">
                {renderPanel()}
              </div>

              <div ref={scrollRef} />
            </div>
          </div>

          {/* Breadcrumb Trail */}
          {(category || subCategory || source) && !['results', 'saved', 'script-generating', 'script-review', 'executing', 'execution-results', 'healing', 'report', 'publish'].includes(step) && (
            <div className="flex-shrink-0 px-6 py-2 border-t border-gray-100 bg-white/60 backdrop-blur-sm">
              <div className="max-w-2xl mx-auto flex items-center gap-1.5 text-[11px] text-gray-400">
                {category && <span className="px-2 py-0.5 bg-violet-50 text-violet-600 rounded-full">{CATEGORIES.find(c => c.id === category)?.title}</span>}
                {subCategory && <><ChevronDown className="w-3 h-3 rotate-[-90deg]" /><span className="px-2 py-0.5 bg-indigo-50 text-indigo-600 rounded-full">{subCategory}</span></>}
                {source && <><ChevronDown className="w-3 h-3 rotate-[-90deg]" /><span className="px-2 py-0.5 bg-blue-50 text-blue-600 rounded-full">{REQ_SOURCES.find(s => s.id === source)?.title}</span></>}
              </div>
            </div>
          )}
        </div>

        {/* Right: Pipeline Progress Sidebar */}
        {renderPipelineSidebar()}
      </div>
    </div>
  );
}
