import axios, { isAxiosError } from 'axios';
import { encryptField, encryptSensitiveFields } from '@/utils/crypto';

const api = axios.create({
  baseURL: '/api',
  headers: { 'Content-Type': 'application/json' },
  timeout: 120_000, // 2 min — generous; UI shows TIMEOUT classification past this
});

// Attach auth token to every request
api.interceptors.request.use((config) => {
  const token = sessionStorage.getItem('intelliqe_token');
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

// ─────────────────────────────────────────────────────────────────
// Response interceptor — global handling that every page benefits from
//   - 401: session expired -> clear and bounce to /login (preserves return path)
//   - everything else: pass through to be normalized at the call site
// ─────────────────────────────────────────────────────────────────
api.interceptors.response.use(
  (res) => res,
  (err) => {
    const status = err?.response?.status;

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

export async function ssoCallback(code: string, redirectUri: string) {
  const { data } = await api.post('/auth/sso/callback', { code, redirectUri });
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
  scripts: { fileName: string; code: string }[];
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
/**
 * Start a generation run. The backend now runs the multi-stage Claude pipeline
 * as a BACKGROUND job and returns `{ runId }` immediately (202) — no long-held
 * request, so this can never hit an axios timeout. Progress + the final result
 * stream over SSE (subscribeToPipelineEvents); the result is also fetchable via
 * getGenerationResult (used as a poll fallback).
 */
export async function startGeneration(
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
): Promise<{ runId: string }> {
  const { data } = await api.post('/generate', {
    requirements,
    testType,
    targetUrl: options?.targetUrl,
    module: options?.module,
    appName: options?.appName,
    exploreMode: options?.exploreMode,
    roles: options?.roles,
  });
  return data;
}

export interface GenerationResult {
  status: 'running' | 'done' | 'error' | 'unknown';
  stage?: string;
  detail?: string;
  result?: unknown;
  error?: string;
  code?: string;
}

/** Fetch a generation job's status/result by runId. Returns the 404 body (status:'unknown') rather than throwing if the job has expired. */
export async function getGenerationResult(runId: string): Promise<GenerationResult> {
  try {
    const { data } = await api.get(`/generate/result/${runId}`);
    return data;
  } catch (err) {
    const data = isAxiosError(err) ? err.response?.data : undefined;
    if (data && typeof data === 'object') return data as GenerationResult;
    throw err;
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
  });
  return data;
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
  testCases: Record<string, unknown>[];
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
  fields: Record<string, unknown>,
) {
  const { data } = await api.put(`/test-cases/${testRunId}/cases/${caseId}`, fields);
  return data;
}

export async function addTestCase(testRunId: string, tc: Record<string, unknown>) {
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
  payload: {
    datasets?: Record<string, unknown>[];
    fieldData?: Record<string, unknown>[];
    mappings?: Record<string, unknown>[];
    validations?: Record<string, unknown>[];
  },
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

export async function generateScriptsForRun(testRunId: string, regenerate = false) {
  // POM script generation runs several batched Claude calls server-side; allow
  // up to 6 min so the default 2-min client timeout doesn't abort it.
  const { data } = await api.post(
    `/automation-scripts/generate/${testRunId}`,
    { regenerate },
    { timeout: 360_000 },
  );
  return data;
}

export async function getScriptsByRun(testRunId: string) {
  const { data } = await api.get(`/automation-scripts/by-run/${testRunId}`);
  return data;
}

// Actually run the saved Playwright scripts for a run and return per-test
// pass/fail. Real browser execution can take a few minutes for a full suite.
export async function executeScriptsForRun(testRunId: string) {
  const { data } = await api.post(`/automation-scripts/execute/${testRunId}`, {}, { timeout: 600_000 });
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
  // Building the report normally reuses allure-results captured during the run
  // (fast, ~3s). Worst case it re-executes the saved scripts, so allow up to
  // 6 min rather than the default 2-min client timeout.
  const { data } = await api.post('/allure/generate', { runId }, { timeout: 360_000 });
  return data;
}

export async function getAllureReportStatus(runId?: string) {
  const params: Record<string, string> = {};
  if (runId) params.runId = runId;
  const { data } = await api.get('/allure/status', { params });
  return data;
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

export async function connectIntegration(integrationId: string, configData: Record<string, unknown>) {
  const encryptedData = encryptSensitiveFields(configData);
  const { data } = await api.put(`/configurations/${integrationId}`, encryptedData);
  return data;
}

export async function disconnectIntegration(integrationId: string) {
  const { data } = await api.delete(`/configurations/${integrationId}`);
  return data;
}

export async function testNotificationIntegration(integrationId: string) {
  const { data } = await api.post(`/configurations/${integrationId}/test`);
  return data;
}

/* ─────────────────────────────────────────────────────────────
   AI orchestrator — pipeline runs, stages, pages
   ───────────────────────────────────────────────────────────── */
export async function getAgentStatus() {
  const { data } = await api.get('/agents/status');
  return data;
}

/** One pipeline run as surfaced by the agent queue endpoint. */
export interface AgentQueueItem {
  id: string;
  feature: string;
  module: string;
  stage: string;
  status: string;
  priority: string;
  intent?: string;
  targetUrl?: string;
  cost?: number;
  createdAt?: string;
  updatedAt?: string;
}
export interface AgentQueueResponse {
  queue: AgentQueueItem[];
  config?: { maxRetries?: number; autoHealOnFailure?: boolean };
}
export async function getAgentQueue(): Promise<AgentQueueResponse> {
  const { data } = await api.get('/agents/queue');
  return data;
}

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
  const params: Record<string, string> = {};
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
  const params: Record<string, string> = {};
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
/**
 * Subscribe to a pipeline run's SSE stream.
 *
 * EventSource auto-reconnects on transient errors, which is what we want for
 * brief network blips. But on a *permanent* failure (run gone, auth rejected,
 * server down) it would otherwise reconnect forever in a tight loop. We bound
 * that: after `maxConsecutiveErrors` errors without a successful message in
 * between, we close the stream and notify the optional `onError` callback so
 * the caller can fall back to polling instead of leaking a socket. Any
 * successful message resets the counter, so a flaky-but-recovering connection
 * keeps reconnecting normally.
 */
export function subscribeToPipelineEvents(
  runId: string,
  onEvent: (event: unknown) => void,
  onError?: (err: Event) => void,
  maxConsecutiveErrors = 5,
): EventSource {
  const token = sessionStorage.getItem('intelliqe_token') || '';
  const es = new EventSource(`/api/pipeline-events/${runId}?token=${encodeURIComponent(token)}`);

  let consecutiveErrors = 0;

  es.onmessage = (e) => {
    // A delivered message means the stream is healthy again.
    consecutiveErrors = 0;
    try {
      onEvent(JSON.parse(e.data));
    } catch {
      // keepalive — ignore
    }
  };
  es.onerror = (err) => {
    consecutiveErrors += 1;
    // While we're under the cap and the browser is still trying to reconnect,
    // let it keep retrying transient errors.
    if (consecutiveErrors < maxConsecutiveErrors && es.readyState !== EventSource.CLOSED) {
      return;
    }
    // Permanent failure (or the cap was hit): stop reconnecting and surface it.
    es.close();
    onError?.(err);
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
  const body: Record<string, unknown> = { ...payload };
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
