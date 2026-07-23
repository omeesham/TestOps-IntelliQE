import axios from 'axios';
import { encryptField, encryptSensitiveFields } from '@/utils/crypto';
import { log, newId } from '@/utils/logger';
import { normalizeError } from '@/utils/apiError';

const api = axios.create({
  baseURL: '/api',
  headers: { 'Content-Type': 'application/json' },
  timeout: 120_000, // 2 min — generous; UI shows TIMEOUT classification past this
  // Serialize array params as repeated keys (?tag=A&tag=B), not axios's default
  // bracket syntax (?tag[]=A). Express 5's "simple" query parser does NOT strip
  // brackets, so tag[] would land in req.query as the literal key "tag[]" and
  // server-side filters would silently never apply.
  paramsSerializer: { indexes: null },
});

// Long timeout for the AI pipeline stages. A single stage chains several
// sequential LLM calls (and Playwright for execution/heal) and is driven by the
// functionality, not a fixed size — so the default 2-min cap is far too short.
const PIPELINE_TIMEOUT_MS = 900_000; // 15 min

// Per-request tracing metadata is stashed on the axios config so the response
// interceptor can compute latency and echo the correlation id.
interface TraceMeta { start: number; requestId: string; }
function meta(config: any): TraceMeta | undefined { return config?.metadata; }

// ─────────────────────────────────────────────────────────────────
// Request interceptor
//   - attach the bearer token
//   - mint an X-Request-Id (a UUID) and send it; the backend reuses this exact
//     id (request-context.middleware) so a client log lines up 1:1 with the
//     server log + audit_log for that call
//   - stamp a start time for latency measurement + drop a breadcrumb
// ─────────────────────────────────────────────────────────────────
api.interceptors.request.use((config) => {
  const token = sessionStorage.getItem('intelliqe_token');
  if (token) config.headers.Authorization = `Bearer ${token}`;

  const requestId = newId();
  config.headers['X-Request-Id'] = requestId;
  (config as any).metadata = { start: Date.now(), requestId } satisfies TraceMeta;

  log.debug('api', `→ ${config.method?.toUpperCase() || 'GET'} ${config.url}`, {
    requestId,
    method: config.method,
    url: config.url,
  });
  return config;
});

// ─────────────────────────────────────────────────────────────────
// Response interceptor — global handling that every page benefits from
//   - success: log the resolved call with status + latency + requestId
//   - 401: session expired -> clear and bounce to /login (preserves return path)
//   - everything else: log the failure (reason + correlation id) then pass
//     through to be normalized at the call site
// ─────────────────────────────────────────────────────────────────
api.interceptors.response.use(
  (res) => {
    const m = meta(res.config);
    const requestId = (res.headers?.['x-request-id'] as string) || m?.requestId;
    const durationMs = m ? Date.now() - m.start : undefined;
    log.debug('api', `← ${res.status} ${res.config.method?.toUpperCase() || 'GET'} ${res.config.url}`, {
      requestId,
      status: res.status,
      durationMs,
      url: res.config.url,
    });
    return res;
  },
  (err) => {
    const status = err?.response?.status;
    const m = meta(err?.config);
    const norm = normalizeError(err);
    const requestId = norm.requestId || m?.requestId;
    const durationMs = m ? Date.now() - m.start : undefined;

    // A failed network/API call is the single most useful thing to capture:
    // what was called, why it failed (normalized code + message), the backend
    // correlation id, and how long it took. 5xx/network → error; 4xx → warn.
    const level = !status || status >= 500 ? 'error' : 'warn';
    log[level]('api', `✗ ${status || 'ERR'} ${err?.config?.method?.toUpperCase() || 'GET'} ${err?.config?.url} — ${norm.code}`, {
      requestId,
      status,
      durationMs,
      code: norm.code,
      reason: norm.message,
      url: err?.config?.url,
      method: err?.config?.method,
    });

    if (status === 401) {
      // Skip auto-redirect on the login endpoint itself — let the form show
      // the "Invalid credentials" message inline.
      const url: string = err?.config?.url || '';
      const isLoginCall = /\/auth\/(login|signup)/.test(url);
      if (!isLoginCall) {
        try {
          sessionStorage.removeItem('intelliqe_token');
          sessionStorage.removeItem('intelliqe_user');
        } catch { /* storage might be locked */ }
        const here = window.location.pathname + window.location.search;
        const onLogin = window.location.pathname === '/login';
        if (!onLogin) {
          window.location.href = `/login?from=${encodeURIComponent(here)}`;
        }
      }
    }

    return Promise.reject(err);
  },
);

/* ─────────────────────────────────────────────────────────────
   Health
   ───────────────────────────────────────────────────────────── */
export async function healthCheck() {
  const { data } = await api.get('/health');
  return data;
}

/* ─────────────────────────────────────────────────────────────
   Auth (password is XOR-encrypted in transit; server decrypts then hashes)
   ───────────────────────────────────────────────────────────── */
export async function loginUser(username: string, password: string) {
  const { data } = await api.post('/auth/login', {
    username,
    password: encryptField(password),
  });
  return data;
}

export async function signupUser(
  username: string,
  password: string,
  fullName: string,
  email: string,
  role: string,
  tenantName?: string,
) {
  const { data } = await api.post('/auth/signup', {
    username,
    password: encryptField(password),
    fullName,
    email,
    role,
    tenantName,
  });
  return data;
}

/* ─────────────────────────────────────────────────────────────
   Confluence — pulls requirement text from Confluence pages
   ───────────────────────────────────────────────────────────── */
export interface ConfluencePageSummary {
  id: string;
  title: string;
  spaceKey?: string;
  spaceName?: string;
  updatedAt?: string;
  url?: string;
}
export interface ConfluencePageDetails {
  id: string;
  title: string;
  body: string;
  spaceKey?: string;
  spaceName?: string;
}
export async function getConfluencePages(spaceKey?: string): Promise<ConfluencePageSummary[]> {
  const { data } = await api.get('/confluence/pages', { params: spaceKey ? { spaceKey } : {} });
  return data;
}
export async function getConfluencePage(pageId: string): Promise<ConfluencePageDetails> {
  const { data } = await api.get(`/confluence/page/${encodeURIComponent(pageId)}`);
  return data;
}

/* ─────────────────────────────────────────────────────────────
   SharePoint — lists + downloads documents from a connected site
   ───────────────────────────────────────────────────────────── */
export interface SharePointDocSummary {
  id: string;
  name: string;
  webUrl?: string;
  size?: number;
  lastModified?: string;
  mimeType?: string;
}
export interface SharePointDocDetails {
  id: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
  text: string;
  pageCount?: number;
  warning?: string;
  webUrl?: string;
}
export async function getSharePointDocuments(): Promise<SharePointDocSummary[]> {
  const { data } = await api.get('/sharepoint/documents');
  return data;
}
export async function getSharePointDocument(itemId: string): Promise<SharePointDocDetails> {
  const { data } = await api.get(`/sharepoint/document/${encodeURIComponent(itemId)}`, { timeout: 60_000 });
  return data;
}

/* ─────────────────────────────────────────────────────────────
   Git publish — opens a real PR on the connected GitHub/GitLab/Bitbucket
   ───────────────────────────────────────────────────────────── */
export interface GitPublishResult {
  provider: 'github' | 'gitlab' | 'bitbucket';
  prUrl: string;
  prNumber: number;
  branch: string;
  fileCount: number;
}

export async function publishToGit(payload: {
  scripts: { fileName: string; code: string; path?: string }[];
  pageObjects?: { path: string; code: string }[];
  testCases?: any[];
  branch?: string;
  title?: string;
  description?: string;
  commitMessage?: string;
  directory?: string;
  testRunId?: string;
  integrationId?: 'github' | 'gitlab' | 'bitbucket';
}): Promise<GitPublishResult> {
  const { data } = await api.post('/git/publish', payload, { timeout: 120_000 });
  return data;
}

/** Read-only connectivity check for a git-repo integration — verifies the token
 *  can reach the repo and the default branch exists, without creating a PR.
 *  Pass form values to test before saving, or just `integrationId` for a saved one. */
export async function testGitConnection(payload: {
  integrationId?: string;
  repo_url?: string;
  branch?: string;
  access_token?: string;
  username?: string;
}): Promise<{ ok: boolean; message?: string; error?: string; canPush?: boolean }> {
  const { data } = await api.post('/git/test', payload, { timeout: 30_000 });
  return data;
}

/* ─────────────────────────────────────────────────────────────
   Document upload — extracts plain-text requirements from PDF / DOCX / TXT
   ───────────────────────────────────────────────────────────── */
export interface ExtractedDocument {
  text: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  characterCount: number;
  pageCount?: number;
  warning?: string;
}

export async function extractDocumentText(file: File): Promise<ExtractedDocument> {
  const form = new FormData();
  form.append('file', file);
  const { data } = await api.post('/document/extract', form, {
    // Let the browser set the multipart boundary automatically.
    headers: { 'Content-Type': 'multipart/form-data' },
    // Big PDFs can take a few seconds to parse — allow a generous timeout.
    timeout: 60_000,
  });
  return data;
}

/* ─────────────────────────────────────────────────────────────
   Test generation (chat wizard core)
   ───────────────────────────────────────────────────────────── */
export async function generateTests(
  requirements: string,
  testType?: string,
  options?: {
    targetUrl?: string;
    module?: string;
    appName?: string;
    /** When true, the backend skips the analyst pre-pass and goes straight to crawling the live app. */
    exploreMode?: boolean;
    /** Optional credentials so the explore agent can log in. */
    roles?: { roleName?: string; username: string; password: string }[];
    /** The specific Application Setup entry (`app-<slug>` integrationId) these
     *  requirements target. Required whenever the tenant has more than one
     *  application configured, so generation is grounded in the right one. */
    appId?: string;
  },
) {
  const body = {
    requirements,
    testType,
    targetUrl: options?.targetUrl,
    module: options?.module,
    appName: options?.appName,
    exploreMode: options?.exploreMode,
    roles: options?.roles,
    appId: options?.appId,
  };
  const post = () => api.post('/generate', body, { timeout: PIPELINE_TIMEOUT_MS });

  // A connection that drops EARLY — the dev backend restarting, or a brief
  // network blip — surfaces to the user as "Test generation failed: Network
  // Error", losing the whole flow. Retry ONCE, but only when the socket failed
  // FAST (< 15s): a quick failure means no long generation had started, so
  // re-issuing is safe and never runs two generations at once. A real timeout
  // (ECONNABORTED after the full window) or an HTTP error is NOT retried.
  const startedAt = Date.now();
  try {
    const { data } = await post();
    return data;
  } catch (err: any) {
    const fastConnDrop =
      !err?.response && err?.code !== 'ECONNABORTED' && Date.now() - startedAt < 15_000;
    if (!fastConnDrop) throw err;
    await new Promise((r) => setTimeout(r, 1500));
    const { data } = await post();
    return data;
  }
}

export async function executeTests(
  requirements: string,
  options?: { targetUrl?: string; module?: string },
) {
  const { data } = await api.post('/execute', {
    requirements,
    targetUrl: options?.targetUrl,
    module: options?.module,
  }, { timeout: PIPELINE_TIMEOUT_MS });
  return data;
}

/* ─────────────────────────────────────────────────────────────
   Stateless pipeline-flow stages (chat wizard).
   Each stage operates on the artifacts produced by the previous one, so
   test-case ids / scripts / results stay aligned end-to-end. The target
   application + credentials are resolved server-side from
   System Configuration → Application Setup.
   ───────────────────────────────────────────────────────────── */

/** A generated Page Object (POM). Shared across specs; carried alongside scripts. */
export interface GeneratedPageObject { path: string; className: string; module: string; methods: string[]; code: string; }
/** A generated spec, with its POM destination path + the page objects it imports. */
export interface GeneratedScript { testCaseId: string; fileName: string; code: string; path?: string; uses?: string[]; }

/** An inline target-application override for runs when no Application is
 *  configured under System Configuration. The URL/credentials the user types in
 *  the chat flow are used instead of a saved app. Password is encrypted in transit. */
export interface TargetOverride { targetUrl: string; username?: string; password?: string }
function targetBody(t?: TargetOverride): Record<string, any> {
  if (!t?.targetUrl?.trim()) return {};
  return {
    targetUrl: t.targetUrl.trim(),
    ...(t.username ? { username: t.username } : {}),
    ...(t.password ? { password: encryptField(t.password) } : {}),
  };
}

/** Stage 3 — generate automation scripts for the given (possibly edited) test
 *  cases. Runs as a detached server job + polling: the default LIVE generator
 *  drives a real browser through every test case (verifying each locator by
 *  executing it), which takes well past any single-request ingress timeout. */
export async function generateScripts(testCases: any[], appId?: string, target?: TargetOverride) {
  const body = { testCases, appId, ...targetBody(target) };
  const { data: started } = await api.post('/pipeline-flow/scripts/start', body, { timeout: 60_000 });
  // Live generation is slower than batch — allow up to 30 minutes of polling.
  return pollPipelineJob<{ scripts: GeneratedScript[]; pageObjects: GeneratedPageObject[]; mode?: string }>(started.jobId, 30 * 60_000);
}

/**
 * Poll a started pipeline-flow job until it settles, then return its result.
 * Execution/healing run as detached server-side jobs because a single long
 * HTTP request gets killed by the hosting ingress (~240s on Azure Container
 * Apps) long before Playwright finishes — the run continued server-side but
 * the results never reached the UI. Short poll requests are immune to that.
 * A few consecutive poll failures (network blips, brief backend restarts
 * during dev) are tolerated before giving up.
 */
async function pollPipelineJob<T>(jobId: string, deadlineMs: number = PIPELINE_TIMEOUT_MS): Promise<T> {
  const deadline = Date.now() + deadlineMs;
  let consecutiveErrors = 0;
  for (;;) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for the stage to finish.');
    await new Promise((r) => setTimeout(r, 4_000));
    let data: any;
    try {
      ({ data } = await api.get(`/pipeline-flow/jobs/${encodeURIComponent(jobId)}`, { timeout: 30_000 }));
      consecutiveErrors = 0;
    } catch (err: any) {
      // 404 = the job is gone (server restarted) — more polling can't recover it.
      if (err?.response?.status === 404) {
        throw new Error(err?.response?.data?.error || 'The job was lost (server restarted). Re-run the stage.');
      }
      if (++consecutiveErrors >= 5) throw err;
      continue;
    }
    if (data.status === 'completed') return data.result as T;
    if (data.status === 'failed') throw new Error(data.error || 'The pipeline stage failed on the server.');
  }
}

/** Stage 4 — execute the given scripts (+ page objects) against the configured app.
 *  Pass testRunId (the saved run) so the Allure report is built for that run and
 *  shows up on the Reports page. `target` supplies an inline URL when no app is configured.
 *  Runs as a detached server job + polling so long Playwright runs survive ingress timeouts. */
export async function executePipeline(testCases: any[], scripts: any[], pageObjects: any[] = [], appId?: string, testRunId?: string, target?: TargetOverride) {
  const body = { testCases, scripts, pageObjects, appId, testRunId, ...targetBody(target) };
  const { data: started } = await api.post('/pipeline-flow/execute/start', body, { timeout: 60_000 });
  return pollPipelineJob<{
    executionDetails: { testCaseId: string; scenario: string; status: string; durationMs?: number; error?: string }[];
    failureReason: string | null;
    reportUrl?: string;
    app: { name: string; targetUrl?: string } | null;
    summary: { total: number; passed: number; failed: number; executed: boolean; reason?: string };
  }>(started.jobId);
}

/** Stage 5 — heal failing tests then re-execute the suite (detached job + polling). */
export async function healPipeline(
  testCases: any[],
  scripts: any[],
  executionDetails: { testCaseId: string; status: string; error?: string }[],
  pageObjects: any[] = [],
  appId?: string,
  testRunId?: string,
  target?: TargetOverride,
) {
  const body = { testCases, scripts, executionDetails, pageObjects, appId, testRunId, ...targetBody(target) };
  const { data: started } = await api.post('/pipeline-flow/heal/start', body, { timeout: 60_000 });
  // Live healing replays each failing scenario in a real browser and then
  // re-executes the suite — allow up to 30 minutes of polling.
  return pollPipelineJob<{
    scripts: GeneratedScript[];
    pageObjects: GeneratedPageObject[];
    executionDetails: { testCaseId: string; scenario: string; status: string; durationMs?: number; error?: string }[];
    healingLog: { testCaseId: string; error: string; fix: string; result: 'fixed' | 'unchanged' | 'unknown' }[];
    reportUrl?: string;
    app: { name: string; targetUrl?: string } | null;
    summary: { total: number; passed: number; failed: number; executed: boolean; reason?: string };
  }>(started.jobId, 30 * 60_000);
}

/* ─────────────────────────────────────────────────────────────
   Test cases (saved/edited/deleted/exported)
   ───────────────────────────────────────────────────────────── */
export async function saveTestCases(payload: {
  username: string;
  storyKey?: string;
  storyTitle?: string;
  source?: string;
  columns: string[];
  testCases: any[];
}) {
  const { data } = await api.post('/test-cases/save', payload);
  return data;
}

export async function exportTestCases(testRunId: string, format: string) {
  const response = await api.get(`/test-cases/${testRunId}/export`, {
    params: { format },
    responseType: 'blob',
  });
  return response;
}

export async function listTestRuns(opts?: {
  page?: number;
  limit?: number;
  search?: string;
  mine?: boolean;
  module?: string;
  submodule?: string;
  tag?: string | string[];
}) {
  const { data } = await api.get('/test-cases', { params: opts });
  return data;
}

export async function getTestRun(testRunId: string, opts?: { tag?: string | string[] }) {
  const { data } = await api.get(`/test-cases/${testRunId}`, { params: opts });
  return data;
}

export async function listTestCaseFacets(): Promise<{
  modules: string[];
  submodules: { module: string; name: string }[];
  tags: string[];
}> {
  const { data } = await api.get('/test-cases/facets');
  return data;
}

export async function updateTestCase(
  testRunId: string,
  caseId: string,
  fields: Record<string, any>,
) {
  const { data } = await api.put(`/test-cases/${testRunId}/cases/${caseId}`, fields);
  return data;
}

export async function addTestCase(testRunId: string, tc: Record<string, any>) {
  const { data } = await api.post(`/test-cases/${testRunId}/cases`, tc);
  return data;
}

export async function deleteTestCase(testRunId: string, caseId: string) {
  const { data } = await api.delete(`/test-cases/${testRunId}/cases/${caseId}`);
  return data;
}

export async function deleteTestRun(testRunId: string) {
  const { data } = await api.delete(`/test-cases/${testRunId}`);
  return data;
}

/* ─────────────────────────────────────────────────────────────
   Test data (datasets used by data-aware tests)
   ───────────────────────────────────────────────────────────── */
export async function getTestData(testRunId: string) {
  const { data } = await api.get(`/test-cases/${testRunId}/test-data`);
  return data;
}

export async function saveTestData(
  testRunId: string,
  payload: { datasets?: any[]; fieldData?: any[]; mappings?: any[]; validations?: any[] },
) {
  const { data } = await api.post(`/test-cases/${testRunId}/test-data`, payload);
  return data;
}

/* ─────────────────────────────────────────────────────────────
   Artifacts (download + execution report)
   ───────────────────────────────────────────────────────────── */
export async function getExecutionReport(runId: string) {
  const { data } = await api.get(`/artifacts/${runId}/report`);
  return data;
}

export async function downloadArtifactZip(runId: string) {
  const response = await api.get(`/artifacts/${runId}/download`, { responseType: 'blob' });
  const url = window.URL.createObjectURL(new Blob([response.data]));
  const link = document.createElement('a');
  link.href = url;
  link.setAttribute('download', `intelliqe-artifacts-${runId.slice(0, 8)}.zip`);
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.URL.revokeObjectURL(url);
}

/* ─────────────────────────────────────────────────────────────
   Automation scripts
   ───────────────────────────────────────────────────────────── */
export async function listAutomationScripts(params?: {
  page?: number;
  limit?: number;
  search?: string;
  test_run_id?: string;
}) {
  const { data } = await api.get('/automation-scripts', { params });
  return data;
}

export async function getAutomationScript(id: string) {
  const { data } = await api.get(`/automation-scripts/${id}`);
  return data;
}

export async function updateAutomationScript(
  id: string,
  updates: { code?: string; file_name?: string; status?: string },
) {
  const { data } = await api.put(`/automation-scripts/${id}`, updates);
  return data;
}

export async function deleteAutomationScript(id: string) {
  const { data } = await api.delete(`/automation-scripts/${id}`);
  return data;
}

export async function generateScriptsForRun(testRunId: string) {
  const { data } = await api.post(`/automation-scripts/generate/${testRunId}`);
  return data;
}

export async function getScriptsByRun(testRunId: string) {
  const { data } = await api.get(`/automation-scripts/by-run/${testRunId}`);
  return data;
}

/* ─────────────────────────────────────────────────────────────
   Reports
   ───────────────────────────────────────────────────────────── */
export async function getReportsSummary() {
  const { data } = await api.get('/reports/summary');
  return data;
}

export async function generateAllureReport(runId?: string) {
  const { data } = await api.post('/allure/generate', { runId });
  return data;
}

export async function getAllureReportStatus(runId?: string) {
  const params: Record<string, any> = {};
  if (runId) params.runId = runId;
  const { data } = await api.get('/allure/status', { params });
  return data;
}

/** The most recently generated report across all runs (used to show the latest by default). */
export async function getLatestAllureReport() {
  const { data } = await api.get('/allure/latest');
  return data as { exists: boolean; runId?: string; generatedAt?: string; reportUrl?: string };
}

/* ─────────────────────────────────────────────────────────────
   Reports history + export
   ───────────────────────────────────────────────────────────── */
export interface ReportHistoryItem {
  runId: string;
  generatedAt: string;
  hasBasic: boolean;
  hasAllure: boolean;
  reportType: 'allure' | 'basic';
  stats: { passed: number; failed: number; broken: number; skipped: number; total: number; passRate: number; durationMs: number } | null;
  source: string;
  story: string | null;
  storyKey: string | null;
  module: string | null;
  submodule: string | null;
  createdBy: string | null;
  origin: string;
}
export interface ReportHistoryResponse {
  items: ReportHistoryItem[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
  facets: { sources: string[] };
}

export async function getReportsHistory(params: { page?: number; pageSize?: number; source?: string; type?: string; search?: string } = {}) {
  const { data } = await api.get('/reports/history', { params });
  return data as ReportHistoryResponse;
}

/** Download a report as Excel or PDF; triggers a browser download. */
export async function downloadReportExport(runId: string, format: 'xlsx' | 'pdf') {
  const res = await api.get(`/reports/${encodeURIComponent(runId)}/export`, {
    params: { format },
    responseType: 'blob',
  });
  const disposition = res.headers['content-disposition'] || '';
  const match = disposition.match(/filename="?([^"]+)"?/);
  const filename = match?.[1] || `report.${format}`;
  const url = window.URL.createObjectURL(new Blob([res.data]));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.URL.revokeObjectURL(url);
}

/* ─────────────────────────────────────────────────────────────
   Chat
   ───────────────────────────────────────────────────────────── */
export async function createChatConversation(username: string, title?: string) {
  const { data } = await api.post('/chat/conversations', { username, title });
  return data;
}

export async function saveChatMessage(
  conversationId: string,
  role: 'user' | 'assistant' | 'system',
  content: string,
  metadata?: Record<string, unknown>,
) {
  const { data } = await api.post('/chat/messages', { conversationId, role, content, metadata });
  return data;
}

/* ─────────────────────────────────────────────────────────────
   JIRA (apiToken is encrypted in transit)
   ───────────────────────────────────────────────────────────── */
export async function connectJira(username: string, baseUrl: string, email: string, apiToken: string) {
  const { data } = await api.post('/jira/connect', {
    username,
    baseUrl,
    email,
    apiToken: encryptField(apiToken),
  });
  return data;
}

export async function getJiraStatus(username: string) {
  const { data } = await api.get('/jira/status', { params: { username } });
  return data;
}

export async function getJiraStories(username: string) {
  const { data } = await api.get('/jira/stories', { params: { username } });
  return data;
}

export async function getJiraStoryDetails(username: string, issueKey: string) {
  const { data } = await api.get(`/jira/story/${encodeURIComponent(issueKey)}`, {
    params: { username },
  });
  return data;
}

export async function disconnectJira(username: string) {
  const { data } = await api.delete('/jira/disconnect', { params: { username } });
  return data;
}

export interface JiraUser {
  accountId: string;
  displayName: string;
  emailAddress?: string;
  avatarUrl?: string;
}

/** Current connected JIRA user — for the "Assign to me" shortcut. */
export async function getJiraCurrentUser(username: string) {
  const { data } = await api.get('/jira/me', { params: { username } });
  return data as JiraUser;
}

/** Users who can be assigned to a given issue (or the project). */
export async function getJiraAssignableUsers(username: string, issueKey: string) {
  const { data } = await api.get('/jira/assignable', { params: { username, issueKey } });
  return data as JiraUser[];
}

/** Assign a JIRA issue to a user; returns the resolved assignee. */
export async function assignJiraStory(username: string, issueKey: string, accountId: string) {
  const { data } = await api.put('/jira/assign', { issueKey, accountId }, { params: { username } });
  return data as { ok: boolean; issueKey: string; assignee: JiraUser };
}

/** Remove the assignee from a JIRA issue (moves it back to unassigned). */
export async function unassignJiraStory(username: string, issueKey: string) {
  const { data } = await api.put('/jira/unassign', { issueKey }, { params: { username } });
  return data as { ok: boolean; issueKey: string };
}

/* ─────────────────────────────────────────────────────────────
   Azure DevOps (PAT is encrypted in transit)
   ───────────────────────────────────────────────────────────── */
export async function connectAzureDevops(orgUrl: string, project: string, pat: string, areaPath?: string) {
  const { data } = await api.post('/azure-devops/connect', {
    orgUrl,
    project,
    pat: encryptField(pat),
    areaPath: areaPath || undefined,
  });
  return data;
}

export async function getAzureDevopsStatus() {
  const { data } = await api.get('/azure-devops/status');
  return data;
}

/** Requirement-type work items (User Story, Bug, Feature, Epic, …). */
export async function getAzureDevopsStories() {
  const { data } = await api.get('/azure-devops/stories');
  return data as { key: string; summary: string; type: string; state?: string }[];
}

/** All work items, or one type via `?type=`. */
export async function getAzureDevopsWorkItems(type?: string) {
  const { data } = await api.get('/azure-devops/work-items', { params: type ? { type } : undefined });
  return data as { key: string; summary: string; type: string; state?: string }[];
}

/** Authored Test Case work items, with parsed steps. */
export async function getAzureDevopsTestCases() {
  const { data } = await api.get('/azure-devops/test-cases');
  return data as { key: string; title: string; state?: string; steps: { step: number; action: string; expected: string }[] }[];
}

export async function getAzureDevopsStoryDetails(id: string) {
  const { data } = await api.get(`/azure-devops/story/${encodeURIComponent(id)}`);
  return data as { key: string; title: string; description?: string; acceptanceCriteria?: string; type?: string };
}

export async function disconnectAzureDevops() {
  const { data } = await api.delete('/azure-devops/disconnect');
  return data;
}

/* ─────────────────────────────────────────────────────────────
   Tenant-scoped integration configurations
   ───────────────────────────────────────────────────────────── */
export async function getConfigurations() {
  const { data } = await api.get('/configurations');
  return data;
}

export async function getConfigurationsByCategory(category: string) {
  const { data } = await api.get('/configurations', { params: { category } });
  return data;
}

export async function connectIntegration(integrationId: string, configData: Record<string, any>) {
  const encryptedData = encryptSensitiveFields(configData);
  const { data } = await api.put(`/configurations/${integrationId}`, encryptedData);
  return data;
}

/** Soft-disconnect — keeps the saved config so it can be reconnected later. */
export async function disconnectIntegration(integrationId: string) {
  const { data } = await api.post(`/configurations/${integrationId}/disconnect`);
  return data;
}

/** Reactivate a previously-disconnected integration (reuses its stored config). */
export async function reconnectIntegration(integrationId: string) {
  const { data } = await api.post(`/configurations/${integrationId}/reconnect`);
  return data;
}

/** Permanently remove an integration configuration. */
export async function deleteIntegration(integrationId: string) {
  const { data } = await api.delete(`/configurations/${integrationId}`);
  return data;
}

export async function testNotificationIntegration(
  integrationId: string,
  config?: { webhook_url?: string },
) {
  const body: Record<string, any> = {};
  // Ad-hoc test (before saving): send the entered webhook URL, encrypted in transit.
  if (config?.webhook_url) body.webhook_url = encryptField(config.webhook_url);
  const { data } = await api.post(`/configurations/${integrationId}/test`, body);
  return data;
}

/* ─────────────────────────────────────────────────────────────
   LLM Configuration — centralized provider connectivity
   ───────────────────────────────────────────────────────────── */
export interface LlmProviderConfig {
  provider: 'anthropic' | 'gemini' | 'openai';
  label: string;
  configured: boolean;
  status: 'connected' | 'not_configured' | 'invalid_credentials' | 'connection_failed';
  /** Anthropic only: 'api_key' (API credits) or 'claude_code' (subscription). */
  authMethod?: 'api_key' | 'claude_code';
  /** Claude Code transport: 'api' (OAuth→API) or 'cli' (local claude CLI). */
  claudeCodeMode?: 'api' | 'cli';
  model: string | null;
  /** Per-agent model overrides (stage → model). Empty object when unset. */
  agentModels?: Record<string, string>;
  /** Reasoning effort (low|medium|high|xhigh|max). Null = provider default. */
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max' | null;
  /** Extended ("ultra") thinking toggle. */
  extendedThinking?: boolean;
  baseUrl: string;
  maskedKey: string | null;
  /** Masked Claude Code OAuth token (Anthropic + claude_code). */
  maskedToken?: string | null;
  isDefault: boolean;
  updatedBy: string | null;
  updatedAt: string | null;
}

export async function getLlmConfig(): Promise<{ providers: LlmProviderConfig[]; defaultProvider: string | null }> {
  const { data } = await api.get('/llm-config');
  return data;
}

export async function testLlmConnection(
  provider: string,
  payload: { apiKey?: string; baseUrl?: string; authMethod?: 'api_key' | 'claude_code'; oauthToken?: string; mode?: 'api' | 'cli' },
): Promise<{ ok: boolean; status: string; message: string; models: string[]; raw?: string }> {
  const body: Record<string, any> = { baseUrl: payload.baseUrl };
  if (payload.authMethod) body.authMethod = payload.authMethod;
  if (payload.mode) body.mode = payload.mode;
  if (payload.apiKey) body.apiKey = encryptField(payload.apiKey);
  if (payload.oauthToken) body.oauthToken = encryptField(payload.oauthToken);
  const { data } = await api.post(`/llm-config/${provider}/test`, body);
  return data;
}

export async function saveLlmConfig(
  provider: string,
  payload: {
    apiKey?: string; baseUrl?: string; model?: string | null;
    agentModels?: Record<string, string>;
    authMethod?: 'api_key' | 'claude_code'; oauthToken?: string;
    claudeCodeMode?: 'api' | 'cli';
    effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
    extendedThinking?: boolean;
  },
) {
  const body: Record<string, any> = { baseUrl: payload.baseUrl, model: payload.model };
  if (payload.authMethod) body.authMethod = payload.authMethod;
  if (payload.claudeCodeMode) body.claudeCodeMode = payload.claudeCodeMode;
  if (payload.agentModels) body.agentModels = payload.agentModels;
  if (payload.effort) body.effort = payload.effort;
  if (typeof payload.extendedThinking === 'boolean') body.extendedThinking = payload.extendedThinking;
  if (payload.apiKey) body.apiKey = encryptField(payload.apiKey);
  if (payload.oauthToken) body.oauthToken = encryptField(payload.oauthToken);
  const { data } = await api.put(`/llm-config/${provider}`, body);
  return data;
}

export async function setDefaultLlmProvider(provider: string) {
  const { data } = await api.post(`/llm-config/${provider}/default`);
  return data;
}

export async function deleteLlmConfig(provider: string) {
  const { data } = await api.delete(`/llm-config/${provider}`);
  return data;
}

/* ─────────────────────────────────────────────────────────────
   AI orchestrator — pipeline runs, stages, pages
   ───────────────────────────────────────────────────────────── */
export async function createPipelineRun(payload: {
  feature: string;
  module: string;
  intent: string;
  priority?: string;
  targetUrl?: string;
  executionMode?: 'full-auto' | 'approve-per-stage' | 'dry-run';
  startStage?: string;
  pageSlug?: string;
  pageName?: string;
}) {
  const { data } = await api.post('/pipeline/run', payload);
  return data;
}

export async function listPipelineRuns(status?: string) {
  const params: Record<string, any> = {};
  if (status) params.status = status;
  const { data } = await api.get('/pipeline/list', { params });
  return data;
}

export async function getPipelineRun(id: string) {
  const { data } = await api.get(`/pipeline/${id}`);
  return data;
}

export async function cancelPipelineRun(id: string) {
  const { data } = await api.post(`/pipeline/${id}/cancel`);
  return data;
}

export async function approvePipelineStage(id: string) {
  const { data } = await api.post(`/pipeline/${id}/approve`);
  return data;
}

export async function rejectPipelineStage(id: string) {
  const { data } = await api.post(`/pipeline/${id}/reject`);
  return data;
}

export async function steerPipeline(id: string, message: string) {
  const { data } = await api.post(`/pipeline/${id}/steer`, { message });
  return data;
}

export async function switchPipelineMode(id: string, mode: 'full-auto' | 'approve-per-stage') {
  const { data } = await api.patch(`/pipeline/${id}/mode`, { mode });
  return data;
}

export async function listPipelinePages(module?: string) {
  const params: Record<string, any> = {};
  if (module) params.module = module;
  const { data } = await api.get('/pipeline-pages', { params });
  return data;
}

export async function createPipelinePage(payload: {
  module: string;
  page_slug: string;
  display_name: string;
  target_url?: string;
}) {
  const { data } = await api.post('/pipeline-pages', payload);
  return data;
}

export async function getPipelinePage(id: string) {
  const { data } = await api.get(`/pipeline-pages/${id}`);
  return data;
}

export async function getAgentTypes() {
  const { data } = await api.get('/pipeline-admin/agent-types');
  return data;
}

export async function getPipelineDefinition() {
  const { data } = await api.get('/pipeline-admin/pipeline-definition');
  return data;
}

export async function getWorkerStatus() {
  const { data } = await api.get('/pipeline-admin/worker-status');
  return data;
}

export async function getPipelineUsage() {
  const { data } = await api.get('/pipeline-admin/usage');
  return data;
}

/* ─────────────────────────────────────────────────────────────
   SSE — real-time pipeline events
   ───────────────────────────────────────────────────────────── */
export function subscribeToPipelineEvents(
  runId: string,
  onEvent: (event: any) => void,
  onStatusChange?: (connected: boolean) => void,
): () => void {
  // Native EventSource cannot send the Authorization header that authMiddleware
  // requires (a ?token= query param is NOT read server-side and yields 401), so
  // stream via fetch with the Bearer header — same pattern as subscribeToBugEvents.
  const controller = new AbortController();
  let stopped = false;

  async function connect() {
    while (!stopped) {
      try {
        const token = sessionStorage.getItem('intelliqe_token') || '';
        const resp = await fetch(`/api/pipeline-events/${encodeURIComponent(runId)}`, {
          headers: { Authorization: `Bearer ${token}`, Accept: 'text/event-stream' },
          signal: controller.signal,
        });
        if (!resp.ok || !resp.body) throw new Error(`SSE connect failed: ${resp.status}`);
        onStatusChange?.(true);

        const reader = resp.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const frames = buffer.split('\n\n');
          buffer = frames.pop() || '';
          for (const frame of frames) {
            const dataLine = frame.split('\n').find((l) => l.startsWith('data: '));
            if (!dataLine) continue; // keepalive comment
            try {
              onEvent(JSON.parse(dataLine.slice(6)));
            } catch {
              // malformed frame — ignore
            }
          }
        }
      } catch {
        // fall through to reconnect
      }
      onStatusChange?.(false);
      if (stopped) return;
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }
  }

  connect();
  return () => {
    stopped = true;
    controller.abort();
    onStatusChange?.(false);
  };
}

/* ─────────────────────────────────────────────────────────────
   User management
   ───────────────────────────────────────────────────────────── */
export async function getMenuConfig() {
  const { data } = await api.get('/users/menu-config');
  return data;
}

// ─── Feature Toggles (per-tenant, per-role UI permissions) ───────────────────

/** Get the current tenant's feature-toggle map: { features: { key: { role: bool } } } */
export async function getFeatureToggles() {
  const { data } = await api.get('/feature-toggles');
  return data as { features: Record<string, Record<string, boolean>> };
}

/** Replace the tenant's feature-toggle map (admin only). */
export async function updateFeatureToggles(
  features: Record<string, Record<string, boolean>>,
) {
  const { data } = await api.put('/feature-toggles', { features });
  return data as { success: boolean; features: Record<string, Record<string, boolean>> };
}

export async function listTenantUsers() {
  const { data } = await api.get('/users');
  return data;
}

export async function listTenants() {
  const { data } = await api.get('/users/tenants');
  return data;
}

export async function createTenantUser(payload: {
  username: string;
  password: string;
  email: string;
  fullName: string;
  role: string;
  tenantId?: string;
}) {
  const { data } = await api.post('/users', {
    ...payload,
    password: encryptField(payload.password),
  });
  return data;
}

export async function updateTenantUser(
  userId: string,
  payload: { fullName?: string; email?: string; role?: string; password?: string; isActive?: boolean },
) {
  const body: any = { ...payload };
  if (payload.password) body.password = encryptField(payload.password);
  const { data } = await api.put(`/users/${userId}`, body);
  return data;
}

export async function deleteTenantUser(userId: string) {
  const { data } = await api.delete(`/users/${userId}`);
  return data;
}

export async function setTenantUserStatus(userId: string, isActive: boolean) {
  const { data } = await api.put(`/users/${userId}/status`, { isActive });
  return data;
}

/* ─────────────────────────────────────────────────────────────
   Bug tracker
   ───────────────────────────────────────────────────────────── */
export async function listBugs(opts?: {
  page?: number;
  limit?: number;
  search?: string;
  status?: string;
  severity?: string;
  priority?: string;
  assignee?: string;
}) {
  const { data } = await api.get('/bugs', { params: opts });
  return data;
}

export async function getBugStats() {
  const { data } = await api.get('/bugs/stats');
  return data;
}

export async function getBug(bugId: string) {
  const { data } = await api.get(`/bugs/${bugId}`);
  return data;
}

export async function createBug(payload: Record<string, any>) {
  const { data } = await api.post('/bugs', payload);
  return data;
}

export async function updateBug(bugId: string, fields: Record<string, any>) {
  const { data } = await api.put(`/bugs/${bugId}`, fields);
  return data;
}

export async function revokeBug(bugId: string, reason: string) {
  const { data } = await api.post(`/bugs/${bugId}/revoke`, { reason });
  return data;
}

export async function deleteBug(bugId: string) {
  const { data } = await api.delete(`/bugs/${bugId}`);
  return data;
}

/** Is Azure DevOps connected for this tenant? (drives the "Raise in Azure DevOps" UI) */
export async function getBugAdoStatus() {
  const { data } = await api.get('/bugs/ado/status');
  return data as { connected: boolean; orgUrl?: string; project?: string };
}

/** Raise the selected bug(s) in Azure DevOps as Bug work items. */
export async function pushBugsToAdo(ids: string[]) {
  const { data } = await api.post('/bugs/ado/push', { ids });
  return data as {
    ok: boolean;
    raised: number;
    project?: string;
    org?: string;
    results: { id: string; ok: boolean; adoId?: number; adoUrl?: string; error?: string }[];
  };
}

/** Delete just the Azure DevOps work item a bug was raised as (the IntelliQE bug stays and can be raised again). */
export async function removeBugFromAdo(bugId: string) {
  const { data } = await api.delete(`/bugs/${bugId}/ado`);
  return data as { ok: boolean; adoId: number; alreadyGone?: boolean };
}

/** Is JIRA connected for this tenant? (drives the "Raise in JIRA" UI) */
export async function getBugJiraStatus() {
  const { data } = await api.get('/bugs/jira/status');
  return data as { connected: boolean; jiraUrl?: string; projectKey?: string };
}

/** Raise the selected bug(s) in JIRA as Bug issues. */
export async function pushBugsToJira(ids: string[]) {
  const { data } = await api.post('/bugs/jira/push', { ids });
  return data as {
    ok: boolean;
    raised: number;
    projectKey?: string;
    results: { id: string; ok: boolean; jiraKey?: string; jiraUrl?: string; error?: string }[];
  };
}

/** Delete just the JIRA issue a bug was raised as (the IntelliQE bug stays and can be raised again). */
export async function removeBugFromJira(bugId: string) {
  const { data } = await api.delete(`/bugs/${bugId}/jira`);
  return data as { ok: boolean; jiraKey: string; alreadyGone?: boolean };
}

/**
 * Live bug events over SSE. Native EventSource cannot send the Authorization
 * header the backend requires, so this streams via fetch and reconnects with
 * a fixed backoff. Returns an unsubscribe function.
 */
export function subscribeToBugEvents(
  onEvent: (event: any) => void,
  onStatusChange?: (connected: boolean) => void,
): () => void {
  const controller = new AbortController();
  let stopped = false;

  async function connect() {
    while (!stopped) {
      try {
        const token = sessionStorage.getItem('intelliqe_token') || '';
        const resp = await fetch('/api/bugs/events', {
          headers: { Authorization: `Bearer ${token}`, Accept: 'text/event-stream' },
          signal: controller.signal,
        });
        if (!resp.ok || !resp.body) throw new Error(`SSE connect failed: ${resp.status}`);
        onStatusChange?.(true);

        const reader = resp.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const frames = buffer.split('\n\n');
          buffer = frames.pop() || '';
          for (const frame of frames) {
            const dataLine = frame.split('\n').find((l) => l.startsWith('data: '));
            if (!dataLine) continue; // keepalive comment
            try {
              onEvent(JSON.parse(dataLine.slice(6)));
            } catch {
              // malformed frame — ignore
            }
          }
        }
      } catch {
        // fall through to reconnect
      }
      onStatusChange?.(false);
      if (stopped) return;
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }
  }

  connect();
  return () => {
    stopped = true;
    controller.abort();
    onStatusChange?.(false);
  };
}

/* ─────────────────────────────────────────────────────────────
   Agent Performance monitor
   ───────────────────────────────────────────────────────────── */
export interface AgentStat {
  agent: string;
  runs: number;
  successes: number;
  errors: number;
  lastStatus: 'success' | 'error' | null;
  lastDurationMs: number | null;
  avgDurationMs: number | null;
  minDurationMs: number | null;
  maxDurationMs: number | null;
  totalDurationMs: number;
  lastRunAt: string | null;
  lastError?: string;
  lastMeta?: Record<string, unknown>;
  recent: { durationMs: number; status: 'success' | 'error'; at: string }[];
}

export interface AgentPerformance {
  agents: AgentStat[];
  totals: { totalRuns: number; totalDurationMs: number; agentsUsed: number; errors: number };
  generatedAt: string;
}

/** Snapshot of every agent's performance stats for this tenant. */
export async function getAgentPerformance() {
  const { data } = await api.get('/agent-performance/stats');
  return data as AgentPerformance;
}

/** Clear this tenant's captured agent runs. */
export async function resetAgentPerformance() {
  const { data } = await api.post('/agent-performance/reset');
  return data as { ok: boolean };
}

/**
 * Live agent-performance events over SSE (agent_start / agent_run / agent_reset).
 * Same auth-aware fetch-stream + reconnect pattern as subscribeToBugEvents.
 * Returns an unsubscribe function.
 */
export function subscribeToAgentPerformance(
  onEvent: (event: any) => void,
  onStatusChange?: (connected: boolean) => void,
): () => void {
  const controller = new AbortController();
  let stopped = false;

  async function connect() {
    while (!stopped) {
      try {
        const token = sessionStorage.getItem('intelliqe_token') || '';
        const resp = await fetch('/api/agent-performance/events', {
          headers: { Authorization: `Bearer ${token}`, Accept: 'text/event-stream' },
          signal: controller.signal,
        });
        if (!resp.ok || !resp.body) throw new Error(`SSE connect failed: ${resp.status}`);
        onStatusChange?.(true);

        const reader = resp.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const frames = buffer.split('\n\n');
          buffer = frames.pop() || '';
          for (const frame of frames) {
            const dataLine = frame.split('\n').find((l) => l.startsWith('data: '));
            if (!dataLine) continue;
            try { onEvent(JSON.parse(dataLine.slice(6))); } catch { /* ignore */ }
          }
        }
      } catch {
        // fall through to reconnect
      }
      onStatusChange?.(false);
      if (stopped) return;
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }
  }

  connect();
  return () => {
    stopped = true;
    controller.abort();
    onStatusChange?.(false);
  };
}
