import axios from 'axios';
import { encryptField, encryptSensitiveFields } from '@/utils/crypto';
import { log, newId } from '@/utils/logger';
import { normalizeError } from '@/utils/apiError';

const api = axios.create({
  baseURL: '/api',
  headers: { 'Content-Type': 'application/json' },
  timeout: 120_000, // 2 min — generous; UI shows TIMEOUT classification past this
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
  },
) {
  const { data } = await api.post('/generate', {
    requirements,
    testType,
    targetUrl: options?.targetUrl,
    module: options?.module,
    appName: options?.appName,
    exploreMode: options?.exploreMode,
    roles: options?.roles,
  }, { timeout: PIPELINE_TIMEOUT_MS });
  return data;
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

/** Stage 3 — generate POM page objects + specs for the given (possibly edited) test cases. */
export async function generateScripts(testCases: any[], appId?: string) {
  const { data } = await api.post('/pipeline-flow/scripts', { testCases, appId }, { timeout: PIPELINE_TIMEOUT_MS });
  return data as { scripts: GeneratedScript[]; pageObjects: GeneratedPageObject[] };
}

/** Stage 4 — execute the given scripts (+ page objects) against the configured app.
 *  Pass testRunId (the saved run) so the Allure report is built for that run and
 *  shows up on the Reports page. */
export async function executePipeline(testCases: any[], scripts: any[], pageObjects: any[] = [], appId?: string, testRunId?: string) {
  const { data } = await api.post('/pipeline-flow/execute', { testCases, scripts, pageObjects, appId, testRunId }, { timeout: PIPELINE_TIMEOUT_MS });
  return data as {
    executionDetails: { testCaseId: string; scenario: string; status: string; durationMs?: number; error?: string }[];
    failureReason: string | null;
    reportUrl?: string;
    app: { name: string; targetUrl?: string } | null;
    summary: { total: number; passed: number; failed: number; executed: boolean; reason?: string };
  };
}

/** Stage 5 — heal failing tests then re-execute the suite. */
export async function healPipeline(
  testCases: any[],
  scripts: any[],
  executionDetails: { testCaseId: string; status: string; error?: string }[],
  pageObjects: any[] = [],
  appId?: string,
  testRunId?: string,
) {
  const { data } = await api.post('/pipeline-flow/heal', { testCases, scripts, executionDetails, pageObjects, appId, testRunId }, { timeout: PIPELINE_TIMEOUT_MS });
  return data as {
    scripts: GeneratedScript[];
    pageObjects: GeneratedPageObject[];
    executionDetails: { testCaseId: string; scenario: string; status: string; durationMs?: number; error?: string }[];
    healingLog: { testCaseId: string; error: string; fix: string; result: 'fixed' | 'unchanged' | 'unknown' }[];
    reportUrl?: string;
    app: { name: string; targetUrl?: string } | null;
    summary: { total: number; passed: number; failed: number; executed: boolean; reason?: string };
  };
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
  model: string | null;
  /** Per-agent model overrides (stage → model). Empty object when unset. */
  agentModels?: Record<string, string>;
  /** Reasoning effort (low|medium|high|xhigh|max). Null = provider default. */
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max' | null;
  /** Extended ("ultra") thinking toggle. */
  extendedThinking?: boolean;
  /**
   * Per-auth-method model settings so API Key and Claude Code stay independent.
   * The top-level model/agentModels/effort/extendedThinking reflect the active
   * method; this exposes both so the editor can swap without cross-contamination.
   */
  settingsByMethod?: Partial<Record<'api_key' | 'claude_code', {
    model: string | null;
    agentModels?: Record<string, string>;
    effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max' | null;
    extendedThinking?: boolean;
  }>>;
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

/**
 * Live model discovery for a provider. Returns the currently-available models
 * (auto-includes newly released ones) resolved from the provider's own API using
 * the stored credential, with a fallback lineup when nothing is configured.
 */
export async function getLlmModels(
  provider: string,
): Promise<{ ok: boolean; source: string; models: string[] }> {
  const { data } = await api.get(`/llm-config/${provider}/models`);
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
    effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
    extendedThinking?: boolean;
  },
) {
  const body: Record<string, any> = { baseUrl: payload.baseUrl, model: payload.model };
  if (payload.authMethod) body.authMethod = payload.authMethod;
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
): EventSource {
  const token = sessionStorage.getItem('intelliqe_token') || '';
  const es = new EventSource(`/api/pipeline-events/${runId}?token=${encodeURIComponent(token)}`);

  es.onmessage = (e) => {
    try {
      onEvent(JSON.parse(e.data));
    } catch {
      // keepalive — ignore
    }
  };
  es.onerror = () => {
    // EventSource auto-reconnects
  };
  return es;
}

/* ─────────────────────────────────────────────────────────────
   User management
   ───────────────────────────────────────────────────────────── */
export async function getMenuConfig() {
  const { data } = await api.get('/users/menu-config');
  return data;
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
