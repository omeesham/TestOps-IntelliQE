import { useState, useRef, useEffect, useMemo, useCallback } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { useFeatureFlags } from '@/contexts/FeatureFlagsContext';
import {
  connectJira,
  getJiraStories,
  getJiraStoryDetails,
  startGeneration,
  getGenerationResult,
  generateScriptsForRun,
  executeScriptsForRun,
  healScriptsForRun,
  generateAllureReport,
  saveTestCases,
  exportTestCases,
  createChatConversation,
  saveChatMessage,
  getConfigurations,
  subscribeToPipelineEvents,
  extractDocumentText,
  publishToGit,
  getConfluencePages,
  getConfluencePage,
  getSharePointDocuments,
  getSharePointDocument,
  extractMobileAppMetadata,
} from '@/services/api';
import { normalizeError } from '@/utils/apiError';
import {
  Send, Bot, Loader2, CheckCircle, Monitor, Plug, Smartphone,
  Globe, Layers, Shield, FileText, Upload, Type, Link2,
  ArrowRight, RotateCcw, ChevronDown, Eye, EyeOff, Check, X,
  Plus, Trash2, Download, Clipboard, Cpu, Code, Search, Zap,
  BarChart3, Activity, Workflow, Box, Pencil, Save, ChevronLeft, ChevronRight,
  Play, Heart, GitBranch, Terminal, AlertTriangle, Wrench, ExternalLink, Copy, Package,
  SkipForward, XCircle, Volume2, VolumeX, Settings, Clock, Sparkles,
} from 'lucide-react';
import { initTTS, speak, speakAsync, waitForSpeech, waitForVoices, stopSpeaking, isTTSEnabled, toggleTTS } from '@/utils/tts';

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
  | 'content-select'
  | 'upload-doc'
  | 'paste-text'
  | 'explore-form'
  | 'mobile-select'
  | 'mobile-upload'
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

type Category = 'application' | 'api' | 'mobile';
type MobilePlatform = 'android' | 'ios';
interface MobileAppMeta {
  platform: MobilePlatform;
  fileName: string;
  appName?: string;
  packageName?: string;
  bundleId?: string;
  mainActivity?: string;
  versionName?: string;
  permissions?: string[];
  warning?: string;
}
type ReqSource = 'jira' | 'confluence' | 'sharepoint' | 'upload' | 'text' | 'explore';

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
  { id: 'mobile',      title: 'Mobile Application Automation', icon: Smartphone, desc: 'Upload an Android APK or iOS IPA — generate mobile test cases & Appium scripts.', comingSoon: true },
  { id: 'api',         title: 'API Automation',     icon: Plug,        desc: 'Test REST services, endpoints, and system integrations.', comingSoon: true },
];

const REQ_SOURCES: { id: ReqSource; title: string; icon: React.ElementType; desc: string }[] = [
  { id: 'jira', title: 'JIRA', icon: Link2, desc: 'Import from JIRA stories' },
  { id: 'confluence', title: 'Confluence', icon: FileText, desc: 'Import from Confluence' },
  { id: 'sharepoint', title: 'SharePoint', icon: Globe, desc: 'Import from SharePoint' },
  { id: 'upload', title: 'Upload Document', icon: Upload, desc: 'BRD / Functional Doc' },
  { id: 'text', title: 'Paste Requirements', icon: Type, desc: 'Type or paste text' },
  // "Explore" mode — when the user has nothing but a URL (+ optional creds).
  // The backend's exploreAgent crawls the live app and synthesises requirements.
  { id: 'explore', title: 'Explore App (URL only)', icon: Search, desc: 'Crawl the live app & infer tests' },
];

/* CONNECT_FIELDS removed — all connection configuration now lives in System Configuration page */

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
  /** Accumulated wall-clock time this stage spent in the 'running' state (ms). */
  durationMs?: number;
  /** Transient: epoch ms when the current 'running' segment began. */
  startedAt?: number;
}

/** Format a stage's elapsed time for display (e.g. "820ms", "12.3s", "1m 5s"). */
function formatStageDuration(ms?: number): string {
  if (!ms || ms < 0) return '';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  const rem = Math.round(s % 60);
  return `${m}m ${rem}s`;
}

/* ═══════════════════════════════════════════════════════════════
   MAIN COMPONENT
   ═══════════════════════════════════════════════════════════════ */
export default function ChatPage() {
  const { user } = useAuth();
  const { isEnabled } = useFeatureFlags();
  const scrollRef = useRef<HTMLDivElement>(null);

  /* --- state --- */
  const [messages, setMessages] = useState<Msg[]>([]);
  const [step, setStep] = useState<Step>('welcome');
  const [category, setCategory] = useState<Category | null>(null);
  const [subCategory, setSubCategory] = useState<string | null>(null);
  const [source, setSource] = useState<ReqSource | null>(null);
  const [formValues, setFormValues] = useState<Record<string, string>>({});
  const [isConnecting, setIsConnecting] = useState(false);
  const [connectError, setConnectError] = useState('');
  const [stories, setStories] = useState<any[]>([]);
  const [selectedStory, setSelectedStory] = useState<string>('');
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

  // Applications configured under System Configuration → Application Setup.
  // We auto-fill the Explore form from these so the user never has to retype the
  // URL / username / password. The real password is resolved server-side via
  // `exploreAppId` (it's never exposed to the browser), so when a saved app is
  // selected we send its id and let the backend back-fill the credential.
  const [exploreApps, setExploreApps] = useState<{ integrationId: string; configData: any }[]>([]);
  const [exploreAppId, setExploreAppId] = useState<string | null>(null);
  const [exploreHasSavedPassword, setExploreHasSavedPassword] = useState(false);
  const [exploreLoadingApps, setExploreLoadingApps] = useState(false);

  // Mobile Application Automation state — the uploaded APK/IPA's parsed metadata
  // drives mobile-aware generation; the actual binary is never kept client-side.
  const [mobilePlatform, setMobilePlatform] = useState<MobilePlatform | null>(null);
  const [mobileMeta, setMobileMeta] = useState<MobileAppMeta | null>(null);
  const [mobileUploading, setMobileUploading] = useState(false);
  const [mobileError, setMobileError] = useState('');
  const mobileFileInputRef = useRef<HTMLInputElement | null>(null);

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

  // Pipeline progress sidebar
  const [pipelineStages, setPipelineStages] = useState<PipelineStageState[]>(
    PIPELINE_STAGES.map(s => ({ key: s.key, status: 'pending' as const, detail: 'Pending' }))
  );

  const updatePipeline = (key: string, status: 'pending' | 'running' | 'completed' | 'skipped', detail: string) => {
    setPipelineStages(prev => prev.map(s => {
      if (s.key !== key) return s;
      const next: PipelineStageState = { ...s, status, detail };
      // Start the clock when a stage enters 'running'; accumulate elapsed time on
      // finish. Accumulation handles stages that run in more than one segment
      // (e.g. execution re-recording results during a healing cycle).
      if (status === 'running' && s.status !== 'running') {
        next.startedAt = Date.now();
      } else if ((status === 'completed' || status === 'skipped') && s.startedAt) {
        next.durationMs = (s.durationMs || 0) + (Date.now() - s.startedAt);
        next.startedAt = undefined;
      }
      return next;
    }));
  };

  // Script generation results
  const [generatedScripts, setGeneratedScripts] = useState<{ testCaseId: string; fileName: string; code: string }[]>([]);
  const [selectedScriptIdx, setSelectedScriptIdx] = useState(0);

  // Execution state
  // 'not_run' is a real, distinct outcome — the backend tells us a test
  // wasn't executed (e.g., Playwright failed to start, or no spec was
  // produced). Surfacing it honestly beats faking a pass or a fail.
  const [executionResults, setExecutionResults] = useState<{ testCaseId: string; testName: string; status: 'pending' | 'running' | 'passed' | 'failed' | 'not_run'; duration: string; error?: string }[]>([]);
  const [executionSummary, setExecutionSummary] = useState<{ total: number; passed: number; failed: number; duration: string } | null>(null);

  // Healing state
  const [healingAttempt, setHealingAttempt] = useState(0);
  // 'unchanged' = backend re-ran but the test still failed; 'unknown' =
  // backend gave no answer at all (network error, timeout). Both are real
  // outcomes — we never claim a test was healed when it wasn't.
  const [healingLog, setHealingLog] = useState<{ testCaseId: string; error: string; fix: string; result: 'fixed' | 'unchanged' | 'unknown' | 'still-failing' }[]>([]);

  // Report state
  const [reportData, setReportData] = useState<{ totalTests: number; passed: number; failed: number; healed: number; passRate: number; executionTime: string; healingRequired: boolean } | null>(null);
  const [reportDownloadUrl, setReportDownloadUrl] = useState<string>('');
  // Tracks the downloadable Allure report build so the report card can always
  // show a clear state (preparing → ready → failed) instead of silently hiding
  // the Download button until generation resolves.
  const [reportGenStatus, setReportGenStatus] = useState<'idle' | 'generating' | 'ready' | 'failed'>('idle');

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
      if (s.mobilePlatform)         setMobilePlatform(s.mobilePlatform);
      if (s.mobileMeta)             setMobileMeta(s.mobileMeta);
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
        mobilePlatform,
        mobileMeta,
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
    messages, step, category, source, mobilePlatform, mobileMeta,
    pendingRequirements, storyMeta,
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
    // Auto-speak Tessa's messages — only when the Voice Assistant feature is on.
    if (sender === 'tessa' && isEnabled('chat.voice')) {
      speak(text);
    }
  };

  useEffect(() => {
    scrollRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, step, agentSteps]);

  // Role-based category filtering — data_analyst sees nothing in chat for now.
  // Feature-flag gate (additive): hide automation types toggled off for the tenant.
  const role = user?.role || 'admin';
  const CATEGORY_FLAG: Record<string, string> = {
    application: 'chat.webAutomation',
    mobile: 'chat.mobileAutomation',
    api: 'chat.apiAutomation',
  };
  const visibleCategories = CATEGORIES.filter((c) => {
    if (role === 'data_analyst') return false;
    if (!(c.id === 'application' || c.id === 'api' || c.id === 'mobile')) return false;
    const flag = CATEGORY_FLAG[c.id];
    if (flag && !isEnabled(flag)) return false;
    return true;
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
      push('tessa', `Hello ${user?.username || 'there'}! I'm Tessa, your IntelliQE TestOps Assistant.\n\nI can help you design, generate, and execute intelligent test validations across your platform.\n\nWhat would you like to test today?`);
    });
  }, []);

  /* --- flow handlers --- */
  const pickCategory = (c: typeof CATEGORIES[number]) => {
    if (c.comingSoon) {
      push('user', c.title);
      push('tessa', `${c.title} is coming soon. We're actively building this — stay tuned!`);
      return;
    }
    push('user', c.title);
    setCategory(c.id);
    setSubCategory(c.title);

    if (c.id === 'api') {
      push('tessa', 'Please provide the API details below.');
      setStep('api-form');
    } else if (c.id === 'mobile') {
      // Reset any prior mobile selection so a fresh flow starts clean.
      setMobilePlatform(null);
      setMobileMeta(null);
      setMobileError('');
      push('tessa', 'Which mobile platform are we automating?');
      setStep('mobile-select');
    } else {
      push('tessa', 'How would you like to provide the requirements?');
      setStep('source-select');
    }
  };

  const pickSource = async (s: ReqSource) => {
    push('user', REQ_SOURCES.find(r => r.id === s)!.title);
    setSource(s);
    setFormValues({});
    setConnectError('');
    if (s === 'upload') {
      push('tessa', 'Upload your BRD or Functional Specification document.');
      setStep('upload-doc');
    } else if (s === 'text') {
      push('tessa', 'Paste or type your requirements below.');
      setStep('paste-text');
    } else if (s === 'explore') {
      // Reset any prior prefill, then auto-fill from Application Setup.
      setExploreAppId(null);
      setExploreApps([]);
      setExploreHasSavedPassword(false);
      setExploreUrl('');
      setExploreAppName('');
      setExploreUsername('');
      setExplorePassword('');
      push('tessa', 'Select the application you want to test — these come from your Application Setup.');
      setStep('explore-form');
      await prefillExploreFromConfig();
    } else {
      const label = s === 'jira' ? 'JIRA' : s === 'confluence' ? 'Confluence' : 'SharePoint';
      // Check if already connected via System Configuration
      try {
        const result = await getConfigurations();
        const configs = result.configs || [];
        const matched = configs.find((c: any) => c.integrationId === s && c.status === 'connected');
        if (matched) {
          if (s === 'jira') {
            push('tessa', `${label} is connected. Fetching your stories...`);
            try {
              const storiesArr = await getJiraStories(user?.username || 'admin');
              const list = Array.isArray(storiesArr) ? storiesArr : (storiesArr?.stories || storiesArr?.issues || []);
              setStories(list);
              push('tessa', `Found ${list.length} stories/tasks. Select one to generate test cases.`);
              setStep('content-select');
            } catch {
              push('tessa', `${label} is connected but I could not fetch stories. Please verify your credentials in System Configuration.`);
            }
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
              push('tessa', `Found ${list.length} page(s). Pick one and I'll pull its content.`);
              setStep('content-select');
            } catch (err: any) {
              const msg = err?.response?.data?.error || err?.message || 'Could not fetch Confluence pages';
              push('tessa', `Confluence error: ${msg}`);
            }
          } else if (s === 'sharepoint') {
            // Real SharePoint fetch — list documents from the default library.
            push('tessa', `${label} is connected. Listing documents...`);
            try {
              const docs = await getSharePointDocuments();
              const list = docs.map((d) => ({
                key: d.id,
                summary: d.size ? `${d.name} (${(d.size / 1024).toFixed(1)} KB)` : d.name,
                title: d.name,
                description: '',
              }));
              setStories(list);
              push('tessa', `Found ${list.length} document(s). Select one to extract requirements.`);
              setStep('content-select');
            } catch (err: any) {
              const msg = err?.response?.data?.error || err?.message || 'Could not list SharePoint documents';
              push('tessa', `SharePoint error: ${msg}`);
            }
          }
          return;
        }
      } catch {}
      // Not connected — redirect to System Configuration
      push('tessa', `${label} is not configured yet. Please go to System Configuration to set up this connection first.`);
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
        // Backend returns StorySummary[] directly: [{key, summary}, ...]
        const list = Array.isArray(storiesArr) ? storiesArr : (storiesArr?.stories || storiesArr?.issues || []);
        setStories(list);
        push('tessa', `Connected successfully! Logged in as "${jiraName}". Found ${list.length} stories/tasks. Select one to generate test cases.`);
        setStep('content-select');
      } else if (source === 'confluence' || source === 'sharepoint') {
        push('tessa', `${source === 'confluence' ? 'Confluence' : 'SharePoint'} document fetching is not yet integrated. Please use JIRA, upload a document, or paste requirements directly.`);
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
  const handleStorySelect = async () => {
    if (!selectedStory) return;
    const item = stories.find(s => s.key === selectedStory);
    push('user', `${item?.key}: ${item?.title || item?.summary || selectedStory}`);
    setStoryMeta({ key: item?.key, title: item?.title || item?.summary || selectedStory });

    // Default: use whatever lightweight info we already have in `item`.
    let requirements = `${item?.title || item?.summary || ''}\n${item?.description || ''}`.trim();

    try {
      if (source === 'jira') {
        const details = await getJiraStoryDetails(user?.username || 'admin', selectedStory);
        const title = details.title || details.summary || item?.summary || '';
        const desc = details.description || '';
        const ac = details.acceptanceCriteria || '';
        requirements = [title, desc, ac ? `Acceptance Criteria:\n${ac}` : ''].filter(Boolean).join('\n\n');
      } else if (source === 'confluence') {
        const page = await getConfluencePage(selectedStory);
        if (!page.body || page.body.trim().length < 20) {
          throw new Error('Page is empty or too short to generate tests from.');
        }
        requirements = [page.title, page.body].filter(Boolean).join('\n\n');
      } else if (source === 'sharepoint') {
        const doc = await getSharePointDocument(selectedStory);
        if (!doc.text || doc.text.trim().length < 20) {
          throw new Error('Document parsed but contained no extractable text.');
        }
        const meta: string[] = [];
        if (doc.pageCount) meta.push(`${doc.pageCount} pages`);
        meta.push(`${doc.text.length.toLocaleString()} characters`);
        push('tessa', `Extracted ${meta.join(', ')} from ${doc.name}.`);
        requirements = [doc.name, doc.text].filter(Boolean).join('\n\n');
      }
    } catch (err: any) {
      const msg = err?.response?.data?.error || err?.message || 'Could not fetch details';
      push('tessa', `Couldn't load that item: ${msg}. Please pick a different one or use another source.`);
      return;
    }

    setPendingRequirements(requirements);
    push('tessa', 'Great! Now choose which columns you want in your test cases, then click Generate.');
    setStep('column-select');
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
      push('tessa', `Got it — extracted ${stats} from ${file.name}.${warn} Pick the columns you want and I'll generate the test cases.`);
      setStep('column-select');
    } catch (err: any) {
      const msg = err?.response?.data?.error || err?.message || 'Upload failed';
      setUploadError(msg);
      push('tessa', `I couldn't read that file: ${msg}`);
    } finally {
      setUploadInProgress(false);
    }
  };

  /* --- text paste --- */
  const handleTextSubmit = () => {
    if (!pasteText.trim()) return;
    push('user', pasteText.trim().length > 100 ? pasteText.trim().slice(0, 100) + '...' : pasteText.trim());
    setPendingRequirements(pasteText.trim());
    push('tessa', 'Requirements received! Choose which columns you want in your test cases.');
    setStep('column-select');
  };

  /* --- explore prefill from Application Setup ---
     Pull the saved applications (System Configuration → Application Setup) and
     auto-fill the explore form so the user never retypes the URL / username /
     password. URL, app name and username are non-sensitive and shown directly;
     the password stays encrypted server-side and is resolved at generation time
     via exploreAppId, so here we only flag whether a saved password exists. */
  const applyExploreApp = (cfg: { integrationId: string; configData: any }) => {
    const d = cfg.configData || {};
    setExploreAppId(cfg.integrationId);
    setExploreUrl(d.baseUrl || '');
    setExploreAppName(d.appName || '');
    const firstRole = Array.isArray(d.roles) ? d.roles.find((r: any) => r?.username) : null;
    setExploreUsername(firstRole?.username || '');
    // Never prefill the password field with stored ciphertext — the backend
    // uses the saved credential automatically when the field is left blank.
    setExplorePassword('');
    setExploreHasSavedPassword(Boolean(firstRole?.password));
  };

  const prefillExploreFromConfig = async () => {
    setExploreLoadingApps(true);
    try {
      const result = await getConfigurations();
      const configs = result.configs || [];
      const apps = configs.filter(
        (c: any) =>
          typeof c.integrationId === 'string' &&
          c.integrationId.startsWith('app-') &&
          c.configData?.baseUrl,
      );
      setExploreApps(apps);
      if (apps.length > 0) {
        applyExploreApp(apps[0]);
        const name = apps[0].configData?.appName || apps[0].integrationId.replace(/^app-/, '');
        push(
          'tessa',
          apps.length > 1
            ? `You have ${apps.length} applications configured. Select one by name below, then click Start Exploration.`
            : `Found "${name}" in your Application Setup. Click Start Exploration to begin — I'll use its saved URL and credentials.`,
        );
      }
    } catch {
      // Non-fatal — the user can still type the details manually.
    } finally {
      setExploreLoadingApps(false);
    }
  };

  /* --- explore submit ---
     The user has given us only a URL (optionally with credentials). We stash
     an "EXPLORE_MODE" marker into pendingRequirements so runGeneration knows
     to call the backend with exploreMode=true; the marker itself is never
     sent — runGeneration unpacks it back into structured options. */
  const handleExploreSubmit = () => {
    if (!exploreUrl.trim()) return;
    // Show only the chosen application's name — the URL/credentials are pulled
    // from Application Setup behind the scenes.
    const summary = `Explore ${exploreAppName || exploreUrl}`;
    push('user', summary);
    // The literal placeholder is what we'll show in the column-select UI;
    // the real backend call uses exploreMode + roles, not this text.
    setPendingRequirements(`__EXPLORE__:${exploreUrl}`);
    push('tessa', "Got it. I'll crawl the application, infer the features, then generate the test cases. Pick the columns you want and I'll start.");
    setStep('column-select');
  };

  /* --- mobile: platform choice + APK/IPA upload ---
     The uploaded build is parsed server-side for metadata (package/bundle id,
     version, permissions). Requirements still come from the existing sources
     (JIRA / upload / paste); the metadata is folded into generation so the AI
     produces native-mobile test cases and Appium scripts. */
  const pickMobilePlatform = (p: MobilePlatform) => {
    setMobilePlatform(p);
    push('user', p === 'android' ? 'Android' : 'iOS');
    push('tessa', p === 'android'
      ? "Great — upload your Android .apk build and I'll read its details."
      : "Great — upload your iOS .ipa build and I'll read its details.");
    setStep('mobile-upload');
  };

  const openMobileFilePicker = () => {
    setMobileError('');
    mobileFileInputRef.current?.click();
  };

  const handleMobileFileSelected = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setMobileError('');
    setMobileUploading(true);
    push('user', `Uploading: ${file.name} (${(file.size / 1024 / 1024).toFixed(1)} MB)`);
    try {
      const meta = await extractMobileAppMetadata(file);
      setMobileMeta(meta);
      if (meta.platform) setMobilePlatform(meta.platform);
      const idLine = meta.platform === 'ios'
        ? (meta.bundleId ? `Bundle id ${meta.bundleId}` : 'bundle id not detected')
        : (meta.packageName ? `package ${meta.packageName}` : 'package not detected');
      const verLine = meta.versionName ? `, v${meta.versionName}` : '';
      push('tessa', `Got "${meta.appName || meta.fileName}" (${idLine}${verLine}).${meta.warning ? ` Note: ${meta.warning}` : ''}\n\nNow choose where the requirements should come from and I'll generate mobile test cases.`);
      setStep('source-select');
    } catch (err: any) {
      const msg = err?.response?.data?.error || err?.message || 'Upload failed';
      setMobileError(msg);
      push('tessa', `I couldn't read that build: ${msg}`);
    } finally {
      setMobileUploading(false);
    }
  };

  /* --- API form submit --- */
  const handleApiSubmit = () => {
    if (!apiUrl.trim()) return;
    const summary = `${apiMethod} ${apiUrl}`;
    push('user', summary);
    setPendingRequirements(`API Testing: ${apiMethod} ${apiUrl} - ${subCategory}`);
    push('tessa', 'API details received. Choose which columns you want in your test cases.');
    setStep('column-select');
  };

  /* --- generation pipeline (only TC generation, not full pipeline) ---
     The backend runs the multi-stage Claude pipeline as a BACKGROUND job and
     returns a runId immediately. We drive the pipeline panel from SSE stage
     events and finish when the job reports done/error — with a poll fallback so
     a missed event can't hang the UI. No long-held request → no client timeout,
     and errors are shown as friendly messages, never raw text. */
  const runGeneration = async (requirements: string) => {
    const steps: AgentStep[] = AGENTS.map(a => ({ name: a.name, status: 'pending' as const, detail: a.detail }));
    setAgentSteps(steps);

    // Pipeline: Stage 1 → running
    updatePipeline('requirements', 'running', 'Analyzing requirements...');
    setAgentSteps(prev => prev.map((s, idx) => idx === 0 ? { ...s, status: 'running' } : s));

    /* Apply a successful result: map backend test cases (IEEE-829 shape, with
       legacy aliases preserved) into the wizard and advance to results. */
    const applyGenerationResult = (res: any) => {
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

      updatePipeline('requirements', 'completed', res?.summary?.features?.join(', ') || 'Completed');
      setAgentSteps(prev => prev.map((s, idx) => idx <= 1 ? { ...s, status: 'completed' } : s));

      if (!testCases.length) {
        const parsedFeatures: string[] = res?.summary?.features || [];
        const detail = parsedFeatures.length ? ` Parsed features: ${parsedFeatures.join(', ')}.` : '';
        push('tessa', `The AI didn't return any test cases this time.${detail} Please try a more specific requirement or a different JIRA story.`);
        updatePipeline('test-design', 'skipped', 'No test cases generated');
        setStep('welcome');
        return;
      }

      setResults({ testCases });
      setTcPage(1);
      setSelectedTcIds(new Set());
      setEditingTcId(null);
      updatePipeline('test-design', 'completed', `${testCases.length} test cases generated`);
      push('tessa', `Generated ${testCases.length} test cases from the AI pipeline. Review, edit, or delete as needed. Click Save when satisfied.`);
      setStep('results');
    };

    /* Friendly failure — never surface raw error text in the chat. */
    const failGeneration = (message: string) => {
      push('tessa', `⚠️ ${message}`);
      updatePipeline('test-design', 'skipped', 'Generation failed');
      setAgentSteps(prev => prev.map(s => s.status === 'running' ? { ...s, status: 'pending' } : s));
      setStep('welcome');
    };

    // ── Start the background generation job ──
    let runId = '';
    try {
      // Detect explore-mode marker stashed by handleExploreSubmit. When present,
      // route to the backend with exploreMode=true and roles instead of sending
      // the marker string as actual requirements.
      const isExplore = source === 'explore' || requirements.startsWith('__EXPLORE__:');
      if (isExplore) {
        // Send the username with whatever password the user typed. If the field
        // was left blank but the app came from Application Setup (exploreAppId),
        // the backend back-fills the saved password — it's never sent from here.
        const roles = exploreUsername
          ? [{ roleName: 'user', username: exploreUsername, password: explorePassword }]
          : undefined;
        const started = await startGeneration('', subCategory || undefined, {
          exploreMode: true,
          targetUrl: exploreUrl,
          appName: exploreAppName || undefined,
          roles,
          appId: exploreAppId || undefined,
        });
        runId = started?.runId || '';
      } else if (category === 'mobile') {
        // Mobile path: requirements come from the chosen source; the uploaded
        // app's metadata + platform steer native-mobile test generation.
        const started = await startGeneration(requirements, subCategory || undefined, {
          platform: mobilePlatform || undefined,
          appMetadata: mobileMeta
            ? {
                packageName: mobileMeta.packageName,
                bundleId: mobileMeta.bundleId,
                mainActivity: mobileMeta.mainActivity,
                versionName: mobileMeta.versionName,
                permissions: mobileMeta.permissions,
                fileName: mobileMeta.fileName,
              }
            : undefined,
        });
        runId = started?.runId || '';
      } else {
        const started = await startGeneration(requirements, subCategory || undefined);
        runId = started?.runId || '';
      }
    } catch (err: any) {
      console.error('Start generation failed:', err);
      failGeneration(normalizeError(err).message);
      return;
    }

    if (!runId) {
      failGeneration('Could not start generation. Please try again.');
      return;
    }
    setCurrentRunId(runId);
    setPipelineMode('async');

    // ── Drive progress + completion from SSE, with a polling fallback ──
    let handled = false;
    let es: EventSource | null = null;
    let pollTimer: ReturnType<typeof setInterval> | null = null;

    const cleanup = () => {
      if (es) { es.close(); es = null; }
      if (pollTimer !== null) { clearInterval(pollTimer); pollTimer = null; }
    };

    const onTerminal = (job: { status: string; result?: any; error?: string }) => {
      if (handled) return;
      handled = true;
      cleanup();
      if (job.status === 'done' && job.result) {
        applyGenerationResult(job.result);
      } else {
        failGeneration(job.error || 'Generation did not complete. Please try again.');
      }
    };

    es = subscribeToPipelineEvents(runId, (event: any) => {
      if (!event || typeof event !== 'object') return;
      if (event.type === 'gen_stage') {
        const status = event.status === 'completed' ? 'completed' : 'running';
        updatePipeline(event.stage, status, event.detail || '');
        if (event.stage === 'requirements') {
          setAgentSteps(prev => prev.map((s, i) => i === 0 ? { ...s, status } : s));
        } else if (event.stage === 'test-design') {
          setAgentSteps(prev => prev.map((s, i) =>
            i === 0 ? { ...s, status: 'completed' } : i === 1 ? { ...s, status } : s));
        }
      } else if (event.type === 'generation_complete') {
        getGenerationResult(runId).then(onTerminal).catch(() =>
          onTerminal({ status: 'error', error: 'Generation finished but the result could not be loaded. Please try again.' }),
        );
      } else if (event.type === 'generation_error') {
        onTerminal({ status: 'error', error: event.error });
      }
    });

    // Poll fallback every 4s — covers a missed SSE event or a dropped stream.
    pollTimer = setInterval(async () => {
      if (handled) return;
      try {
        const job = await getGenerationResult(runId);
        if (job.status === 'done' || job.status === 'error') {
          onTerminal(job);
        } else if (job.status === 'unknown') {
          onTerminal({ status: 'error', error: 'This generation run is no longer available. Please start a new generation.' });
        } else if (job.stage) {
          updatePipeline(job.stage, 'running', job.detail || '');
        }
      } catch {
        // transient network hiccup — keep polling
      }
    }, 4000);
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
        // Mark mobile runs so script generation emits Appium and execution
        // dispatches to the (gated) mobile runner.
        platform: category === 'mobile' ? (mobilePlatform || undefined) : undefined,
        appMetadata: category === 'mobile' && mobileMeta
          ? {
              packageName: mobileMeta.packageName,
              bundleId: mobileMeta.bundleId,
              mainActivity: mobileMeta.mainActivity,
              versionName: mobileMeta.versionName,
              permissions: mobileMeta.permissions,
              fileName: mobileMeta.fileName,
            }
          : undefined,
      });
      setSavedTestRunId(res.testRunId);
      push('tessa', `${results.testCases.length} test cases saved successfully! You can now export them or proceed to automation script generation.`);
      setStep('saved');
    } catch (err) {
      console.error('Save failed:', err);
      push('tessa', 'Failed to save test cases. Please try again.');
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
    } catch (err) {
      console.error('Export failed:', err);
    } finally {
      setIsExporting(false);
    }
  };

  /* --- Script generation (Stage 3 ONLY) --- */
  const handleScriptGeneration = async () => {
    const testCases = results?.testCases || [];
    if (testCases.length === 0) return;

    push('tessa', `Generating automation scripts for ${testCases.length} test cases...`);
    await waitForSpeech(); // Let Tessa finish speaking before starting execution
    setStep('script-generating');

    const steps: AgentStep[] = [{ name: 'Script Writer', status: 'pending' as const, detail: 'Analyzing test cases and producing automation scripts' }];
    setAgentSteps(steps);

    // Pipeline: Stage 3 → running
    updatePipeline('script-gen', 'running', 'Producing automation scripts...');
    setAgentSteps([{ name: 'Script Writer', status: 'running', detail: 'Analyzing test cases and producing automation scripts' }]);

    // Scripts are produced by the REAL backend script agent (Claude) against the
    // saved test run — no client-side fabrication. The run must be saved first.
    if (!savedTestRunId) {
      push('tessa', '⚠️ Please save the test cases first — scripts are generated from the saved run.');
      updatePipeline('script-gen', 'skipped', 'Save test cases first');
      setAgentSteps([{ name: 'Script Writer', status: 'completed', detail: 'Save required' }]);
      setStep('results');
      return;
    }

    let scripts: any[] = [];
    let scriptErr: string | null = null;
    try {
      const scriptRes = await generateScriptsForRun(savedTestRunId);
      const rows = Array.isArray(scriptRes?.scripts) ? scriptRes.scripts : [];
      scripts = rows.map((s: any) => ({
        testCaseId: s.test_case_id || s.testCaseId,
        fileName: s.file_name || s.fileName || `${s.tc_number || s.test_case_id || 'test'}.spec.ts`,
        code: s.code || '',
      })).filter((s: any) => s.code);
    } catch (err: any) {
      console.error('Script generation API failed:', err);
      const ne = normalizeError(err);
      scriptErr = ne.hint ? `${ne.message} — ${ne.hint}` : ne.message;
    }

    if (!scripts.length) {
      push('tessa', `⚠️ ${scriptErr || 'The backend returned no scripts. Ensure the AI engine is connected and try again.'}`);
      updatePipeline('script-gen', 'skipped', 'No scripts generated');
      setAgentSteps([{ name: 'Script Writer', status: 'completed', detail: 'No scripts produced' }]);
      setStep('results');
      return;
    }

    setGeneratedScripts(scripts);
    setSelectedScriptIdx(0);

    // Pipeline: Stage 3 → completed
    setAgentSteps([{ name: 'Script Writer', status: 'completed', detail: 'Automation scripts generated' }]);
    updatePipeline('script-gen', 'completed', `${scripts.length} scripts created`);

    push('tessa', `Generated ${scripts.length} test scripts. Review the code below, then click "Execute Test Suite" to run them.`);
    setStep('script-review');
  };

  /* --- Execute Tests (Stage 4) --- */
  const handleExecuteTests = async () => {
    push('tessa', 'Executing test suite across staging environment...');
    await waitForSpeech();
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

    // Execute the ACTUAL generated scripts for this saved run via Playwright —
    // not a re-run of the generation pipeline. Requires the run to be saved.
    let execRes: any = null;
    let execErr: string | null = null;
    if (!savedTestRunId) {
      execErr = 'Save the test cases and generate scripts before executing.';
    } else {
      try {
        execRes = await executeScriptsForRun(savedTestRunId);
      } catch (err: any) {
        console.error('Execute tests failed:', err);
        const ne = normalizeError(err);
        execErr = ne.hint ? `${ne.message} — ${ne.hint}` : ne.message;
      }
    }

    if (execErr) {
      push('tessa', `⚠️ ${execErr}`);
      updatePipeline('execution', 'skipped', 'Execution failed');
      setStep('script-review');
      return;
    }

    if (execRes?.runId) setCurrentRunId(execRes.runId);

    // Mobile (gated): the backend reports it did NOT execute on-device. Surface
    // that honestly — never map empty results into a misleading "0 passed".
    if (execRes?.summary && execRes.summary.executed === false) {
      const reason = execRes.summary.reason || 'Mobile tests were not executed on this host (no device/Appium).';
      const details: any[] = Array.isArray(execRes.executionDetails) ? execRes.executionDetails : [];
      const rows = (generatedScripts.length ? generatedScripts : details).map((s: any, i: number) => ({
        testCaseId: s.testCaseId || details[i]?.testCaseId || `m-${i}`,
        testName: String(s.fileName || details[i]?.scenario || 'Mobile test').replace(/\.(e2e|spec)\.ts$/, ''),
        status: 'not_run' as const,
        duration: '',
        error: reason,
      }));
      setExecutionResults(rows);
      setExecutionSummary({ total: rows.length, passed: 0, failed: 0, duration: '0.00s' });
      updatePipeline('execution', 'skipped', 'Not executed (no device)');
      push('tessa', `📱 ${reason} Your Appium scripts are generated and ready — connect a device/emulator (and set APPIUM_SERVER_URL on the server) to run them. You can still generate a report of the suite.`);
      setStep('execution-results');
      return;
    }

    // ─────────────────────────────────────────────────────────────
    // Map backend's REAL execution details onto our local result rows.
    // No artificial delays. No fabricated durations. No index-based
    // fake pass/fail inference. If the backend says a test was not
    // run, we show "not_run" — we do NOT pretend it passed.
    // ─────────────────────────────────────────────────────────────
    const backendDetails: any[] = Array.isArray(execRes?.executionDetails) ? execRes.executionDetails : [];
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

    // Sum real durations only. Tests with no duration contribute 0 — we
    // do NOT pad the total with random numbers.
    const totalMs = backendDetails.reduce((sum, d) => sum + (typeof d.durationMs === 'number' ? d.durationMs : 0), 0);
    setExecutionSummary({ total: finalResults.length, passed, failed, duration: `${(totalMs / 1000).toFixed(2)}s` });

    // Pipeline: Stage 4 → completed
    updatePipeline('execution', 'completed', `${passed}/${finalResults.length} passed`);

    if (failed > 0) {
      push('tessa', `Execution complete: ${passed} passed, ${failed} failed out of ${finalResults.length} tests. You can auto-heal failing tests or skip to report.`);
    } else {
      push('tessa', `All ${passed} tests passed! Proceed to generate the execution report.`);
    }
    setStep('execution-results');
  };

  /* --- Auto-Heal (Stage 5) --- */
  const handleAutoHeal = async () => {
    const failedTests = executionResults.filter(r => r.status === 'failed');
    if (failedTests.length === 0) return;

    const attempt = healingAttempt + 1;
    setHealingAttempt(attempt);
    setStep('healing');

    push('tessa', `Auto-healing attempt ${attempt}: Fixing ${failedTests.length} failing test(s)...`);
    await waitForSpeech(); // Let Tessa finish speaking before starting healing

    // Pipeline: Stage 5 → running
    updatePipeline('auto-healing', 'running', `Healing attempt ${attempt}...`);

    // Call backend healing endpoint to get real AI-powered fixes
    const newHealingLog: typeof healingLog = [];

    // Call the real backend healing endpoint. It loads THIS run's actual
    // failing scripts, AI-fixes each one (using its real code + real error +
    // test intent), persists the fix, then re-runs the healed subset and
    // returns real per-test results keyed by testCaseId. Whatever it returns is
    // what we surface — no fabricated "all healed pass" lies.
    let healRes: any = null;
    if (!savedTestRunId) {
      push('tessa', '⚠️ Cannot heal: the run was not saved. Save test cases and generate scripts first.');
      updatePipeline('auto-healing', 'skipped', 'No saved run to heal');
      setStep('execution-results');
      return;
    }
    try {
      healRes = await healScriptsForRun(
        savedTestRunId,
        failedTests.map(t => ({ testCaseId: t.testCaseId, error: t.error || '' })),
      );
    } catch (err: any) {
      console.error('Healing API call failed:', err);
      const ne = normalizeError(err);
      push('tessa', `⚠️ Auto-heal could not run: ${ne.hint ? `${ne.message} — ${ne.hint}` : ne.message}`);
      updatePipeline('auto-healing', 'skipped', 'Healing failed');
      setStep('execution-results');
      return;
    }

    // Map backend results so we can look up healed status by test-case id.
    const healDetails: any[] = Array.isArray(healRes?.executionDetails) ? healRes.executionDetails : [];
    const healByTcId = new Map<string, any>(healDetails.map((d) => [d.testCaseId, d]));

    for (const failedTest of failedTests) {
      const d = healByTcId.get(failedTest.testCaseId);
      // Healing log records what the backend actually reported — not a
      // canned "Analyzed and updated selectors" string.
      const resultStatus: 'fixed' | 'unchanged' | 'unknown' =
        d?.status === 'passed' ? 'fixed'
        : d?.status === 'failed' ? 'unchanged'
        : 'unknown';
      newHealingLog.push({
        testCaseId: failedTest.testCaseId,
        error: failedTest.error || 'Unknown error',
        fix: d?.healFix || (resultStatus === 'fixed' ? 'Backend healed and re-ran successfully' : 'Backend did not return a fix'),
        result: resultStatus,
      });
      setHealingLog([...newHealingLog]);
    }

    const healedCount = newHealingLog.filter(l => l.result === 'fixed').length;
    updatePipeline('auto-healing', 'completed', `Healed ${healedCount}/${failedTests.length}`);

    // Re-execution is already part of the backend call above — we
    // do NOT pretend to re-execute separately on the client.
    push('tessa', 'Backend re-executed the healed tests; recording real results...');
    updatePipeline('execution', 'running', 'Recording healed results...');

    const updatedResults = [...executionResults];
    let newPassed = updatedResults.filter(r => r.status === 'passed').length;
    let newFailed = 0;

    for (const logEntry of newHealingLog) {
      const idx = updatedResults.findIndex(r => r.testCaseId === logEntry.testCaseId);
      if (idx === -1) continue;
      const d = healByTcId.get(logEntry.testCaseId);
      const duration = typeof d?.durationMs === 'number'
        ? `${(d.durationMs / 1000).toFixed(2)}s`
        : '';
      if (logEntry.result === 'fixed') {
        newPassed++;
        updatedResults[idx] = { ...updatedResults[idx], status: 'passed', duration, error: undefined };
      } else {
        newFailed++;
        updatedResults[idx] = { ...updatedResults[idx], status: 'failed', duration, error: d?.error || updatedResults[idx].error };
      }
      setExecutionResults([...updatedResults]);
    }

    // Sum only real durations — empty strings contribute 0.
    const totalSec = updatedResults.reduce((sum, r) => {
      const v = parseFloat(r.duration || '0');
      return sum + (Number.isFinite(v) ? v : 0);
    }, 0);
    setExecutionSummary({ total: updatedResults.length, passed: newPassed, failed: newFailed, duration: `${totalSec.toFixed(2)}s` });
    updatePipeline('execution', 'completed', `${newPassed}/${updatedResults.length} passed`);

    if (newFailed > 0 && attempt < 2) {
      push('tessa', `Re-execution complete: ${newFailed} test(s) still failing. You can attempt another healing cycle or proceed to report.`);
    } else if (newFailed > 0) {
      push('tessa', `Maximum healing attempts reached. ${newFailed} test(s) remain failing. Proceed to report.`);
    } else {
      push('tessa', 'All tests passing after auto-healing! Proceed to generate the execution report.');
    }
    setStep('execution-results');
  };

  /* --- Proceed to Report (Stage 6) --- */
  const handleProceedToReport = async () => {
    // If all tests passed on first run and no healing was done, mark auto-healing as skipped
    if (healingAttempt === 0 && (executionSummary?.failed || 0) === 0) {
      updatePipeline('auto-healing', 'skipped', 'Not needed — all tests passed');
    }

    // Pipeline: Stage 6 → running
    updatePipeline('report-gen', 'running', 'Generating report...');
    push('tessa', 'Generating test execution report...');
    await waitForSpeech(); // Let Tessa finish speaking before generating report
    setStep('report');

    // No artificial wait — the report is built synchronously from existing state.
    const passRate = executionSummary && executionSummary.total > 0
      ? Math.round((executionSummary.passed / executionSummary.total) * 100)
      : 0;

    setReportData({
      totalTests: executionSummary?.total || 0,
      passed: executionSummary?.passed || 0,
      failed: executionSummary?.failed || 0,
      healed: healingLog.filter(l => l.result === 'fixed').length,
      passRate,
      executionTime: executionSummary?.duration || '0s',
      healingRequired: healingAttempt > 0,
    });

    // Materialize a downloadable Allure report for THIS run. The wizard just
    // executed, so real allure-results are already stored — generation is fast
    // (no re-run) and needs no Java. The report card shows a live "preparing…"
    // state meanwhile, so the Download option is always visible before the PR.
    let downloadMsg = '';
    setReportDownloadUrl('');
    if (savedTestRunId) {
      setReportGenStatus('generating');
      try {
        const allure = await generateAllureReport(savedTestRunId);
        if (allure?.reportUrl) {
          setReportDownloadUrl(allure.reportUrl.replace(/\/index\.html$/, '/download'));
          setReportGenStatus('ready');
          downloadMsg = ' You can download the full Allure report below, or open it any time from the Reports page.';
        } else {
          setReportGenStatus('failed');
        }
      } catch (err) {
        console.error('Allure report generation failed:', err);
        setReportGenStatus('failed');
        downloadMsg = ' (The detailed Allure report could not be built this time — the summary above still reflects the run.)';
      }
    } else {
      setReportGenStatus('failed');
    }

    // Pipeline: Stage 6 → completed
    updatePipeline('report-gen', 'completed', `Report ready — ${passRate}% pass rate`);
    push('tessa', `Report generated. Pass rate: ${passRate}%. ${healingAttempt > 0 ? `${healingLog.filter(l => l.result === 'fixed').length} test(s) were auto-healed.` : 'No auto-healing was needed.'}${downloadMsg}`);
  };

  /* --- Retry just the downloadable report build (no pipeline re-run) --- */
  const handleRetryReport = async () => {
    if (!savedTestRunId || reportGenStatus === 'generating') return;
    setReportGenStatus('generating');
    setReportDownloadUrl('');
    try {
      const allure = await generateAllureReport(savedTestRunId);
      if (allure?.reportUrl) {
        setReportDownloadUrl(allure.reportUrl.replace(/\/index\.html$/, '/download'));
        setReportGenStatus('ready');
      } else {
        setReportGenStatus('failed');
      }
    } catch (err) {
      console.error('Allure report retry failed:', err);
      setReportGenStatus('failed');
      const ne = normalizeError(err);
      push('tessa', `⚠️ ${ne.hint ? `${ne.message} — ${ne.hint}` : ne.message}`);
    }
  };

  /* --- Auto-populate git repo from System Configuration when entering publish step --- */
  useEffect(() => {
    if (step !== 'publish' || publishResult === 'success') return;
    // Only auto-fill if user hasn't manually entered a URL
    if (gitRepoUrl.trim()) return;

    (async () => {
      try {
        const result = await getConfigurations();
        const configs = result.configs || [];
        // Find the first connected git-repo integration (github, gitlab, bitbucket)
        const gitConfig = configs.find(
          (c: any) => c.category === 'git-repo' && c.status === 'connected'
        );
        if (gitConfig?.configData) {
          const repoUrl = gitConfig.configData.repo_url || gitConfig.configData.org_url || '';
          const branch = gitConfig.configData.branch || 'main';
          if (repoUrl) setGitRepoUrl(repoUrl);
          if (branch) setGitBranch(branch);
        }
      } catch { /* ignore — user can still fill manually */ }
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
    setIsPublishing(true);
    setPublishedPrUrl('');
    push('tessa', `Pushing ${generatedScripts.length} test script(s) to your git repository...`);
    await waitForSpeech();
    try {
      const result = await publishToGit({
        scripts: generatedScripts.map((s) => ({ fileName: s.fileName, code: s.code })),
        branch: gitBranch && gitBranch !== 'main' ? gitBranch : undefined,
        testRunId: savedTestRunId || currentRunId || undefined,
      });
      setPublishedPrUrl(result.prUrl);
      setPublishResult('success');
      push(
        'tessa',
        `Done — opened ${result.provider === 'gitlab' ? 'MR' : 'PR'} #${result.prNumber} on ${result.provider} with ${result.fileCount} file(s). View it at ${result.prUrl}`,
      );
    } catch (err: any) {
      const msg = err?.response?.data?.error || err?.message || 'Git publish failed';
      setPublishResult('error');
      push('tessa', `Couldn't publish to git: ${msg}. Your scripts are still available below for manual download.`);
    } finally {
      setIsPublishing(false);
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
    stopSpeaking(); // Stop any ongoing voice-over
    setMessages([]);
    setStep('welcome');
    setCategory(null);
    setSubCategory(null);
    setSource(null);
    setFormValues({});
    setStories([]);
    setSelectedStory('');
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
    setPipelineStages(PIPELINE_STAGES.map(s => ({ key: s.key, status: 'pending' as const, detail: 'Pending' })));
    setGeneratedScripts([]);
    setSelectedScriptIdx(0);
    setExecutionResults([]);
    setExecutionSummary(null);
    setHealingAttempt(0);
    setHealingLog([]);
    setReportData(null);
    setReportDownloadUrl('');
    setReportGenStatus('idle');
    setGitRepoUrl('');
    setGitBranch('main');
    setIsPublishing(false);
    setPublishResult(null);
    clearSession(); // clear persisted session on explicit reset
    setTimeout(() => push('tessa', `Welcome back! What would you like to test?`), 100);
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
        <div className="ml-11 max-w-lg">
          <p className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-violet-700 mb-3">
            <Sparkles className="w-3.5 h-3.5" /> Choose what to test
          </p>
          <div className="grid grid-cols-2 gap-3">
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
                      ? 'relative text-left p-4 bg-white border border-gray-100 rounded-2xl opacity-60 cursor-not-allowed'
                      : 'group relative text-left p-4 bg-white border border-[#DCE7FF] rounded-2xl hover:border-violet-300 hover:shadow-lg hover:shadow-violet-500/10 hover:-translate-y-0.5 transition-all duration-200 overflow-hidden'
                  }
                >
                  {!isComingSoon && (
                    <span className="pointer-events-none absolute inset-0 bg-gradient-to-br from-violet-50/0 to-violet-50/0 group-hover:from-violet-50/70 group-hover:to-indigo-50/40 transition-colors" />
                  )}
                  {isComingSoon && (
                    <span className="absolute top-2 right-2 px-2 py-0.5 bg-amber-50 text-amber-700 border border-amber-200 rounded-full text-[10px] font-semibold uppercase tracking-wide">
                      Coming Soon
                    </span>
                  )}
                  <div
                    className={
                      'relative w-10 h-10 rounded-xl flex items-center justify-center mb-3 transition-transform duration-200 ' +
                      (isComingSoon
                        ? 'bg-gradient-to-br from-gray-300 to-gray-400 blur-[1.5px]'
                        : 'bg-gradient-to-br from-violet-500 to-indigo-600 shadow-md shadow-violet-500/25 group-hover:scale-105')
                    }
                  >
                    <Icon className="w-5 h-5 text-white" />
                  </div>
                  <p
                    className={
                      'relative text-sm font-semibold ' +
                      (isComingSoon ? 'text-gray-500 blur-[1.5px]' : 'text-gray-800 group-hover:text-violet-700')
                    }
                  >
                    {c.title}
                  </p>
                  <p className={'relative text-[11px] text-gray-400 mt-0.5' + (isComingSoon ? ' blur-[1.5px]' : '')}>{c.desc}</p>
                  {!isComingSoon && (
                    <ArrowRight className="relative w-4 h-4 text-violet-700 mt-2 opacity-0 -translate-x-1 group-hover:opacity-100 group-hover:translate-x-0 transition-all duration-200" />
                  )}
                </button>
              );
            })}
          </div>
        </div>
      );
    }

    /* ── SOURCE SELECT ── */
    if (step === 'source-select') {
      // For mobile runs, the "Explore App (URL only)" source crawls a live web
      // URL — not applicable — so it's hidden; all other sources are reused.
      const sources = REQ_SOURCES.filter((s) => {
        // Explore is web-only and separately toggleable.
        if (s.id === 'explore') return category !== 'mobile' && isEnabled('chat.explore');
        return true;
      });
      return (
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-2.5 max-w-lg ml-11">
          {sources.map(s => {
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

    /* ── MOBILE: PLATFORM SELECT ── */
    if (step === 'mobile-select') {
      const platforms: { id: MobilePlatform; title: string; desc: string }[] = [
        { id: 'android', title: 'Android', desc: 'Upload an .apk build' },
        { id: 'ios', title: 'iOS', desc: 'Upload an .ipa build' },
      ];
      return (
        <div className="grid grid-cols-2 gap-2.5 max-w-sm ml-11">
          {platforms.map(p => (
            <button
              key={p.id}
              onClick={() => pickMobilePlatform(p.id)}
              className="group text-left p-4 bg-white border border-gray-100 rounded-xl hover:border-violet-300 hover:shadow-md transition-all"
            >
              <Smartphone className="w-5 h-5 text-violet-500 mb-2" />
              <p className="text-sm font-medium text-gray-800">{p.title}</p>
              <p className="text-[11px] text-gray-400">{p.desc}</p>
            </button>
          ))}
        </div>
      );
    }

    /* ── MOBILE: APK / IPA UPLOAD ── */
    if (step === 'mobile-upload') {
      const accept = mobilePlatform === 'ios' ? '.ipa' : '.apk';
      const label = mobilePlatform === 'ios' ? 'iOS .ipa' : 'Android .apk';
      return (
        <div className="max-w-md ml-11 bg-white border border-gray-100 rounded-xl p-5 shadow-sm">
          <input
            ref={mobileFileInputRef}
            type="file"
            accept={accept}
            className="hidden"
            onChange={handleMobileFileSelected}
          />
          <div
            className={`border-2 border-dashed rounded-lg p-8 text-center transition-colors ${
              mobileUploading ? 'border-violet-300 bg-violet-50/50 cursor-wait' : 'border-gray-200 hover:border-violet-300 cursor-pointer'
            }`}
            onClick={mobileUploading ? undefined : openMobileFilePicker}
            onDragOver={(e) => { e.preventDefault(); }}
            onDrop={(e) => {
              e.preventDefault();
              if (mobileUploading) return;
              const f = e.dataTransfer.files?.[0];
              if (f && mobileFileInputRef.current) {
                const dt = new DataTransfer();
                dt.items.add(f);
                mobileFileInputRef.current.files = dt.files;
                mobileFileInputRef.current.dispatchEvent(new Event('change', { bubbles: true }));
              }
            }}
          >
            {mobileUploading ? (
              <>
                <Loader2 className="w-8 h-8 text-violet-500 mx-auto mb-3 animate-spin" />
                <p className="text-sm font-medium text-gray-700">Reading your {label} build…</p>
                <p className="text-xs text-gray-400 mt-1">Large builds can take a moment to upload.</p>
              </>
            ) : (
              <>
                <Smartphone className="w-8 h-8 text-violet-700 mx-auto mb-3" />
                <p className="text-sm font-medium text-gray-700">Drop your {label} here or click to browse</p>
                <p className="text-xs text-gray-400 mt-1">{accept} — up to 300 MB</p>
              </>
            )}
          </div>
          {mobileError && (
            <div className="mt-3 text-xs text-rose-600 bg-rose-50 border border-rose-200 rounded-lg px-3 py-2">
              {mobileError}
            </div>
          )}
        </div>
      );
    }

    /* ── CONNECT FORM — redirects to System Configuration ── */
    if (step === 'connect-form' && source) {
      const label = source === 'jira' ? 'JIRA' : source === 'confluence' ? 'Confluence' : 'SharePoint';
      return (
        <div className="max-w-md ml-11 bg-white border border-gray-100 rounded-xl p-5 shadow-sm text-center">
          <Link2 className="w-8 h-8 text-violet-700 mx-auto mb-3" />
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

    /* ── CONTENT DROPDOWN (stories / docs) ── */
    if (step === 'content-select') {
      return (
        <div className="max-w-md ml-11 bg-white border border-gray-100 rounded-xl p-5 shadow-sm">
          <div className="flex items-center gap-2 mb-4 bg-emerald-50 border border-emerald-200 rounded-lg px-3 py-2">
            <CheckCircle className="w-4 h-4 text-emerald-600 flex-shrink-0" />
            <span className="text-xs font-medium text-emerald-700">Connected successfully</span>
          </div>
          <label className="block text-xs font-medium text-gray-600 mb-2">
            {source === 'jira' ? 'Select a Story' : 'Select a Document'}
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
          <button onClick={handleStorySelect} disabled={!selectedStory} className="mt-3 w-full py-2.5 bg-gradient-to-r from-violet-600 to-indigo-600 hover:from-violet-500 hover:to-indigo-500 disabled:opacity-40 text-white text-sm font-medium rounded-lg transition-all flex items-center justify-center gap-2">
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
                <Upload className="w-8 h-8 text-violet-700 mx-auto mb-3" />
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
          <button onClick={handleTextSubmit} disabled={!pasteText.trim()} className="mt-3 w-full py-2.5 bg-gradient-to-r from-violet-600 to-indigo-600 hover:from-violet-500 hover:to-indigo-500 disabled:opacity-40 text-white text-sm font-medium rounded-lg transition-all flex items-center justify-center gap-2">
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
      const selectedApp = exploreApps.find((a) => a.integrationId === exploreAppId);
      const selectedName = selectedApp?.configData?.appName || selectedApp?.integrationId?.replace(/^app-/, '') || '';
      return (
        <div className="max-w-md ml-11 bg-white border border-gray-100 rounded-xl p-5 shadow-sm space-y-3">
          <div className="flex items-center gap-2 mb-1">
            <Search className="w-4 h-4 text-violet-500" />
            <span className="text-sm font-semibold text-gray-800">Explore Application</span>
          </div>
          <p className="text-xs text-gray-500 -mt-1">Pick an application from your Application Setup. I'll explore it using its saved URL and credentials, then generate test cases, scripts, and reports.</p>

          {exploreLoadingApps && (
            <div className="flex items-center gap-2 text-xs text-gray-500">
              <Loader2 className="w-3.5 h-3.5 animate-spin text-violet-500" />
              Loading your applications…
            </div>
          )}

          {/* No saved apps — point the user to Application Setup */}
          {!exploreLoadingApps && exploreApps.length === 0 && (
            <div className="flex items-start gap-2 text-[11px] text-gray-500 bg-violet-50/50 border border-violet-100 rounded-lg px-3 py-2">
              <Settings className="w-3.5 h-3.5 text-violet-500 mt-0.5 flex-shrink-0" />
              <span>
                No applications are configured yet. Add one in{' '}
                <button
                  type="button"
                  onClick={() => (window.location.href = '/system-configuration')}
                  className="text-violet-600 font-medium underline underline-offset-2 hover:text-violet-700"
                >
                  System Configuration → Application Setup
                </button>{' '}
                with its URL and credentials, then come back here.
              </span>
            </div>
          )}

          {/* Application name picker — the only thing the user sees/selects */}
          {!exploreLoadingApps && exploreApps.length > 0 && (
            <>
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">Application</label>
                <div className="relative">
                  <select
                    value={exploreAppId || ''}
                    onChange={(e) => {
                      const cfg = exploreApps.find((a) => a.integrationId === e.target.value);
                      if (cfg) applyExploreApp(cfg);
                    }}
                    className={inputCls + ' appearance-none pr-9'}
                  >
                    {exploreApps.map((a) => (
                      <option key={a.integrationId} value={a.integrationId}>
                        {a.configData?.appName || a.integrationId.replace(/^app-/, '')}
                      </option>
                    ))}
                  </select>
                  <ChevronDown className="w-4 h-4 text-gray-400 absolute right-3 top-1/2 -translate-y-1/2 pointer-events-none" />
                </div>
              </div>

              <p className="text-[11px] text-violet-500 flex items-center gap-1">
                <CheckCircle className="w-3 h-3" />
                {selectedName ? `"${selectedName}" — using saved URL & credentials from Application Setup` : 'Using saved URL & credentials from Application Setup'}
              </p>
            </>
          )}

          <button
            onClick={handleExploreSubmit}
            disabled={!exploreAppId}
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

          <button onClick={handleApiSubmit} disabled={!apiUrl.trim()} className="w-full py-2.5 bg-gradient-to-r from-violet-600 to-indigo-600 hover:from-violet-500 hover:to-indigo-500 disabled:opacity-40 text-white text-sm font-medium rounded-lg transition-all flex items-center justify-center gap-2">
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
            onClick={() => { setStep('generating'); runGeneration(pendingRequirements); }}
            disabled={selectedColumns.length === 0}
            className="mt-4 w-full py-2.5 bg-gradient-to-r from-violet-600 to-indigo-600 hover:from-violet-500 hover:to-indigo-500 disabled:opacity-40 text-white text-sm font-medium rounded-lg transition-all flex items-center justify-center gap-2"
          >
            <Zap className="w-4 h-4" />Generate Test Cases
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
                          <button onClick={saveEdit} className="p-1 rounded hover:bg-emerald-50 text-emerald-600 transition-colors" title="Save"><Check className="w-3.5 h-3.5" /></button>
                          <button onClick={cancelEdit} className="p-1 rounded hover:bg-gray-100 text-gray-400 transition-colors" title="Cancel"><X className="w-3.5 h-3.5" /></button>
                        </>
                      ) : (
                        <>
                          <button onClick={() => startEdit(tc)} className="p-1 rounded hover:bg-violet-50 text-gray-400 hover:text-violet-600 transition-colors" title="Edit"><Pencil className="w-3.5 h-3.5" /></button>
                          <button onClick={() => deleteSingleTc(tc.id)} className="p-1 rounded hover:bg-red-50 text-gray-400 hover:text-red-500 transition-colors" title="Delete"><Trash2 className="w-3.5 h-3.5" /></button>
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
                            <ol className="space-y-0.5">
                              {(tc.steps || []).map((s: string, j: number) => (
                                <li key={j} className="text-xs text-gray-600 leading-relaxed">
                                  <span className="text-violet-500 font-semibold mr-1">{j + 1}.</span>{s}
                                </li>
                              ))}
                            </ol>
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
          <div className="bg-white border border-gray-100 rounded-xl p-5 shadow-sm">
            <div className="flex items-center gap-2 mb-3">
              <Download className="w-4 h-4 text-violet-500" />
              <span className="text-sm font-semibold text-gray-800">Export Test Cases</span>
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
                  className="group p-3 border border-gray-200 rounded-lg hover:border-violet-300 hover:bg-violet-50 disabled:opacity-50 transition-all text-center"
                >
                  <exp.icon className="w-4 h-4 mx-auto mb-1 text-gray-400 group-hover:text-violet-500 transition-colors" />
                  <p className="text-xs font-medium text-gray-700">{exp.label}</p>
                </button>
              ))}
            </div>
            {isExporting && (
              <p className="text-xs text-violet-500 mt-2 flex items-center gap-1"><Loader2 className="w-3 h-3 animate-spin" />Exporting...</p>
            )}
          </div>

          {/* Proceed to Script Generation */}
          <div className="bg-white border border-gray-100 rounded-xl p-5 shadow-sm">
            <div className="flex items-center gap-2 mb-2">
              <Code className="w-4 h-4 text-indigo-500" />
              <span className="text-sm font-semibold text-gray-800">Automation Scripts</span>
            </div>
            <p className="text-xs text-gray-500 mb-3">Generate automation scripts for your saved test cases.</p>
            <button
              onClick={handleScriptGeneration}
              className="w-full py-2.5 bg-gradient-to-r from-indigo-600 to-violet-600 hover:from-indigo-500 hover:to-violet-500 text-white text-sm font-medium rounded-lg transition-all flex items-center justify-center gap-2"
            >
              <Code className="w-4 h-4" />Generate Automation Scripts
            </button>
          </div>

          {/* Start New */}
          <button onClick={reset} className="inline-flex items-center gap-2 px-4 py-2 bg-white border border-gray-200 rounded-lg text-sm text-gray-600 hover:border-violet-300 hover:text-violet-600 transition-all">
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
                  <span className="text-[10px] px-1.5 py-0.5 bg-[#3366FF]/5 text-[#2143A8] rounded border border-[#3366FF]/10 font-mono">.spec.ts</span>
                </div>
              ))}
            </div>
          </div>
          {/* Execute CTA */}
          <button
            onClick={handleExecuteTests}
            className="w-full py-2.5 bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-500 hover:to-teal-500 text-white text-sm font-medium rounded-lg transition-all flex items-center justify-center gap-2 shadow-sm shadow-emerald-200"
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
                      <p className="text-[11px] text-red-500 mt-0.5 truncate">{r.error}</p>
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

          {/* Test Result List */}
          <div className="bg-white border border-gray-100 rounded-xl p-4 shadow-sm space-y-2 max-h-[300px] overflow-y-auto">
            {executionResults.map((r, i) => (
              <div key={i} className={`flex items-start gap-3 p-2 rounded-lg ${r.status === 'failed' ? 'bg-red-50/50' : ''}`}>
                <div className="flex-shrink-0 mt-0.5">
                  {r.status === 'passed' ? <CheckCircle className="w-4 h-4 text-emerald-500" /> : <XCircle className="w-4 h-4 text-red-500" />}
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-xs font-medium text-gray-800">{r.testName}.spec.ts</p>
                  {r.status === 'failed' && r.error && <p className="text-[11px] text-red-500 mt-0.5">{r.error}</p>}
                </div>
                <span className="text-[11px] text-gray-400">{r.duration}</span>
              </div>
            ))}
          </div>

          {/* Decision Buttons */}
          <div className="flex gap-2">
            {executionSummary.failed > 0 && healingAttempt < 2 && (
              <button
                onClick={handleAutoHeal}
                className="flex-1 py-2.5 bg-gradient-to-r from-amber-500 to-orange-500 hover:from-amber-400 hover:to-orange-400 text-white text-sm font-medium rounded-lg transition-all flex items-center justify-center gap-2"
              >
                <Wrench className="w-4 h-4" />Auto-Heal & Re-Execute
              </button>
            )}
            <button
              onClick={handleProceedToReport}
              className={`${executionSummary.failed > 0 && healingAttempt < 2 ? 'flex-1' : 'w-full'} py-2.5 bg-gradient-to-r from-violet-600 to-indigo-600 hover:from-violet-500 hover:to-indigo-500 text-white text-sm font-medium rounded-lg transition-all flex items-center justify-center gap-2`}
            >
              <BarChart3 className="w-4 h-4" />{executionSummary.failed > 0 && healingAttempt < 2 ? 'Skip to Report' : 'Generate Report'}
            </button>
          </div>
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
                <span className="text-sm font-semibold text-[#1E3A8A]">Test Execution Report</span>
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
                { label: 'Passed', value: reportData.passed, color: 'text-emerald-600' },
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
            {/* Agent execution times — how long each AI pipeline stage took */}
            {pipelineStages.some(s => s.durationMs) && (
              <div className="px-5 py-3 border-t border-gray-100">
                <p className="text-xs font-semibold text-gray-700 mb-2 flex items-center gap-1"><Clock className="w-3.5 h-3.5 text-violet-500" />Agent Execution Times</p>
                <div className="space-y-1">
                  {PIPELINE_STAGES.map((info) => {
                    const st = pipelineStages.find(s => s.key === info.key);
                    if (!st?.durationMs) return null;
                    return (
                      <div key={info.key} className="flex items-center justify-between text-[11px]">
                        <span className="text-gray-600">{info.name}</span>
                        <span className="font-medium text-gray-800 tabular-nums">{formatStageDuration(st.durationMs)}</span>
                      </div>
                    );
                  })}
                </div>
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
          {/* Download report — always shown in the report step so it's clearly
              available BEFORE creating a pull request. Switches between
              preparing / ready / retry states. */}
          {reportGenStatus === 'ready' && reportDownloadUrl ? (
            <a
              href={reportDownloadUrl}
              download
              className="w-full py-2.5 bg-emerald-50 border border-emerald-300 hover:border-emerald-500 hover:bg-emerald-100 text-emerald-700 text-sm font-semibold rounded-lg transition-all flex items-center justify-center gap-2"
            >
              <Download className="w-4 h-4" />Download Test Report
            </a>
          ) : reportGenStatus === 'failed' ? (
            <button
              onClick={handleRetryReport}
              className="w-full py-2.5 bg-white border border-amber-300 hover:border-amber-500 text-amber-700 text-sm font-medium rounded-lg transition-all flex items-center justify-center gap-2"
            >
              <RotateCcw className="w-4 h-4" />Report not ready — Retry download
            </button>
          ) : (
            <div className="w-full py-2.5 bg-gray-50 border border-gray-200 text-gray-500 text-sm font-medium rounded-lg flex items-center justify-center gap-2 cursor-default">
              <Loader2 className="w-4 h-4 animate-spin" />Preparing your downloadable report…
            </div>
          )}
          {reportGenStatus !== 'ready' && (
            <p className="text-[11px] text-gray-400 text-center -mt-1">
              You can download the report here before creating a pull request.
            </p>
          )}
          <button
            onClick={() => setStep('publish')}
            className="w-full py-2.5 bg-gradient-to-r from-violet-600 to-indigo-600 hover:from-violet-500 hover:to-indigo-500 text-white text-sm font-medium rounded-lg transition-all flex items-center justify-center gap-2"
          >
            <GitBranch className="w-4 h-4" />Create Pull Request
          </button>
          <button onClick={reset} className="inline-flex items-center gap-2 px-4 py-2 bg-white border border-gray-200 rounded-lg text-sm text-gray-600 hover:border-violet-300 hover:text-violet-600 transition-all">
            <RotateCcw className="w-3.5 h-3.5" />Start New Test
          </button>
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
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">Repository URL</label>
                  <input
                    type="text"
                    value={gitRepoUrl}
                    onChange={e => setGitRepoUrl(e.target.value)}
                    placeholder="https://github.com/org/repo.git"
                    className={inputCls}
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">Branch</label>
                  <input
                    type="text"
                    value={gitBranch}
                    onChange={e => setGitBranch(e.target.value)}
                    placeholder="main"
                    className={inputCls}
                  />
                </div>
                <div className="bg-gray-50 rounded-lg p-3 border border-gray-100">
                  <p className="text-xs text-gray-500 mb-1">Files to publish:</p>
                  <p className="text-xs font-medium text-gray-700">{generatedScripts.length} test scripts (.spec.ts)</p>
                  {reportData && <p className="text-xs font-medium text-gray-700">Test execution report</p>}
                </div>
              </div>
              <button
                onClick={handlePublishToGit}
                disabled={!gitRepoUrl.trim() || isPublishing}
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
  const renderPipelineSidebar = () => {
    const completedStages = pipelineStages.filter((s) => s.status === 'completed').length;
    const totalStages = pipelineStages.length;
    const stagePct = totalStages ? Math.round((completedStages / totalStages) * 100) : 0;
    return (
    <aside className="w-72 flex-shrink-0 border-l border-[#E1E9FB] bg-white/80 backdrop-blur-md overflow-y-auto">
      <div className="p-5">
        {/* Title + overall progress */}
        <div className="mb-6">
          <div className="flex items-center gap-2.5 mb-3">
            <div className="w-8 h-8 rounded-xl bg-gradient-to-br from-[#3366FF] to-[#2645D6] flex items-center justify-center shadow-md shadow-violet-500/25">
              <Workflow className="w-4 h-4 text-white" />
            </div>
            <div className="leading-tight">
              <h3 className="text-sm font-semibold text-[#1E3A8A]">AI Pipeline</h3>
              <p className="text-[10px] text-gray-400">{completedStages} of {totalStages} stages complete</p>
            </div>
            <span className="ml-auto text-xs font-semibold text-violet-600 tabular-nums">{stagePct}%</span>
          </div>
          <div className="h-1.5 rounded-full bg-violet-100 overflow-hidden">
            <div className="h-full rounded-full bg-gradient-to-r from-violet-500 to-indigo-500 transition-all duration-500" style={{ width: `${stagePct}%` }} />
          </div>
        </div>

        {/* Stages */}
        <div className="relative">
          {pipelineStages.map((stage, idx) => {
            const info = PIPELINE_STAGES[idx];
            const Icon = info.icon;
            const isLast = idx === pipelineStages.length - 1;

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
                          ? 'linear-gradient(to bottom, #3366FF, #E5E7EB)'
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
                    <div className="w-8 h-8 rounded-full bg-gradient-to-br from-[#3366FF] to-[#2645D6] flex items-center justify-center shadow-md shadow-violet-300 ring-4 ring-violet-200/60">
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
                    <Icon className={`w-3.5 h-3.5 ${
                      stage.status === 'completed' ? 'text-[#1E3A8A]' :
                      stage.status === 'running' ? 'text-[#2143A8]' :
                      stage.status === 'skipped' ? 'text-gray-400' :
                      'text-[#D1D5DB]'
                    }`} />
                    <p className={`text-sm font-medium ${
                      stage.status === 'completed' ? 'text-[#1E3A8A]' :
                      stage.status === 'running' ? 'text-[#2143A8]' :
                      stage.status === 'skipped' ? 'text-gray-400 line-through' :
                      'text-[#9CA3AF]'
                    }`}>
                      {info.name}
                    </p>
                    {stage.durationMs ? (
                      <span className="ml-auto flex items-center gap-0.5 text-[10px] font-medium text-gray-400 tabular-nums">
                        <Clock className="w-2.5 h-2.5" />{formatStageDuration(stage.durationMs)}
                      </span>
                    ) : null}
                  </div>
                  <p className={`text-[11px] mt-0.5 ${
                    stage.status === 'completed' ? 'text-[#1E3A8A]' :
                    stage.status === 'running' ? 'text-[#2143A8]' :
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
  };

  /* ═══════════════════════════════════════════════════════════════
     MAIN RENDER
     ═══════════════════════════════════════════════════════════════ */
  return (
    <div className="h-full flex flex-col bg-gradient-to-b from-[#F7FAFF] via-[#EEF4FF] to-[#DDE8FF]">
      {/* Two-Column Layout: Chat + Pipeline Sidebar */}
      <div className="flex-1 flex overflow-hidden">
        {/* Left: Chat Area */}
        <div className="relative flex-1 flex flex-col overflow-hidden min-w-0">
          {/* Chat header — assistant identity + controls */}
          <header className="relative z-20 flex-shrink-0 flex items-center justify-between gap-3 px-6 py-3 border-b border-[#DCE7FF] bg-white/70 backdrop-blur-md">
            <div className="flex items-center gap-3 min-w-0">
              <div className="relative flex-shrink-0">
                <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-violet-500 to-indigo-600 flex items-center justify-center shadow-md shadow-violet-500/25">
                  <Bot className="w-[18px] h-[18px] text-white" />
                </div>
                <span className="absolute -bottom-0.5 -right-0.5 w-3 h-3 rounded-full bg-emerald-500 ring-2 ring-white" />
              </div>
              <div className="min-w-0 leading-tight">
                <p className="text-sm font-semibold text-[#1E3A8A]">Tessa</p>
                <p className="text-[11px] text-gray-400">AI QA TestOps Assistant · <span className="text-emerald-500 font-medium">Online</span></p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              {isEnabled('chat.voice') && (
              <button
                onClick={handleVoiceToggle}
                title={voiceEnabled ? 'Mute Tessa voice' : 'Enable Tessa voice'}
                className={`p-2 rounded-lg border transition-all ${
                  voiceEnabled
                    ? 'text-violet-600 bg-violet-50 border-violet-200 hover:bg-violet-100'
                    : 'text-gray-400 bg-white border-gray-200 hover:text-gray-600 hover:bg-gray-50'
                }`}
              >
                {voiceEnabled ? <Volume2 className="w-4 h-4" /> : <VolumeX className="w-4 h-4" />}
              </button>
              )}
              {step !== 'welcome' && (
                <button
                  onClick={requestReset}
                  title="New chat"
                  className="flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-gray-600 bg-white border border-gray-200 rounded-lg hover:text-violet-600 hover:border-violet-300 hover:bg-violet-50 transition-colors"
                >
                  <RotateCcw className="w-3.5 h-3.5" />New chat
                </button>
              )}
            </div>
          </header>
          {/* Soft decorative glow behind the conversation */}
          <div aria-hidden className="pointer-events-none absolute -top-24 left-1/2 -translate-x-1/2 w-[520px] h-[320px] rounded-full bg-violet-400/10 blur-3xl" />

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
          <div className="relative z-10 flex-1 overflow-y-auto px-6 py-6">
            <div className={`mx-auto space-y-4 ${step === 'results' ? 'max-w-4xl' : 'max-w-2xl'}`}>
              {/* Session restored banner */}
              {sessionRestored && (
                <div className="flex items-center gap-2.5 px-4 py-2.5 bg-violet-50 border border-violet-200 rounded-xl text-sm text-violet-700 animate-fadeIn">
                  <RotateCcw className="w-3.5 h-3.5 flex-shrink-0" />
                  <span>Your previous session has been restored. Continue from where you left off.</span>
                  <button onClick={() => setSessionRestored(false)} className="ml-auto text-violet-700 hover:text-violet-600">
                    <X className="w-3.5 h-3.5" />
                  </button>
                </div>
              )}
              {/* Messages */}
              {messages.map(msg => (
                <div key={msg.id} className={`flex ${msg.sender === 'user' ? 'justify-end' : 'justify-start'} animate-fadeIn`}>
                  {msg.sender === 'tessa' && (
                    <div className="w-8 h-8 rounded-xl bg-gradient-to-br from-violet-500 to-indigo-600 flex items-center justify-center mr-3 flex-shrink-0 mt-0.5 shadow-sm shadow-violet-500/25">
                      <Bot className="w-4 h-4 text-white" />
                    </div>
                  )}
                  <div className={`max-w-[78%] px-4 py-2.5 text-sm leading-relaxed whitespace-pre-line ${
                    msg.sender === 'user'
                      ? 'bg-gradient-to-br from-violet-600 to-indigo-600 text-white rounded-2xl rounded-br-md shadow-md shadow-violet-500/20'
                      : 'bg-white/95 border border-[#EAEFFC] text-gray-700 rounded-2xl rounded-bl-md shadow-sm shadow-violet-900/[0.04]'
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
