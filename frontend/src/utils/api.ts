import axios from 'axios';
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
   Mobile app metadata (APK/IPA) — used by the Mobile Automation path
   ───────────────────────────────────────────────────────────── */
export interface MobileAppMetadata {
  platform: 'android' | 'ios';
  fileName: string;
  sizeBytes: number;
  appName?: string;
  packageName?: string;
  mainActivity?: string;
  bundleId?: string;
  versionName?: string;
  versionCode?: string;
  permissions?: string[];
  warning?: string;
}

export async function extractMobileAppMetadata(file: File): Promise<MobileAppMetadata> {
  const form = new FormData();
  form.append('file', file);
  const { data } = await api.post('/mobile/extract', form, {
    headers: { 'Content-Type': 'multipart/form-data' },
    // Mobile builds are large; allow generous time to upload + parse.
    timeout: 180_000,
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
    /**
     * Application Setup integration id (e.g. "app-acme-portal"). When provided,
     * the backend loads the saved URL + credentials for this app and fills in
     * any details the client didn't send — notably the role password, which is
     * never exposed to the browser. Client-supplied values take precedence.
     */
    appId?: string;
    /** Mobile Application Automation — native platform + uploaded build metadata. */
    platform?: 'android' | 'ios';
    appMetadata?: {
      packageName?: string;
      bundleId?: string;
      mainActivity?: string;
      versionName?: string;
      permissions?: string[];
      fileName?: string;
    };
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
    appId: options?.appId,
    platform: options?.platform,
    appMetadata: options?.appMetadata,
  });
  return data;
}

export interface GenerationResult {
  status: 'running' | 'done' | 'error' | 'unknown';
  stage?: string;
  detail?: string;
  result?: any;
  error?: string;
  code?: string;
}

/** Fetch a generation job's status/result by runId. Returns the 404 body (status:'unknown') rather than throwing if the job has expired. */
export async function getGenerationResult(runId: string): Promise<GenerationResult> {
  try {
    const { data } = await api.get(`/generate/result/${runId}`);
    return data;
  } catch (err: any) {
    const data = err?.response?.data;
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
  testCases: any[];
  /** Mobile Application Automation — marks the run so scripts/execution use Appium. */
  platform?: 'android' | 'ios';
  appMetadata?: {
    packageName?: string;
    bundleId?: string;
    mainActivity?: string;
    versionName?: string;
    permissions?: string[];
    fileName?: string;
  };
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

// Auto-heal the failing scripts for a run: the backend AI-fixes each failing
// script (using its real code + real error + intent), saves the fix, re-runs the
// healed subset, and returns per-test results keyed by testCaseId (each detail
// carries a `healFix` description and `healed` flag). AI + browser re-run can
// take a few minutes, so use the long timeout.
export async function healScriptsForRun(
  testRunId: string,
  failures: { testCaseId: string; error?: string }[],
) {
  const { data } = await api.post(
    `/automation-scripts/heal/${testRunId}`,
    { failures },
    { timeout: 600_000 },
  );
  return data;
}

/* ─────────────────────────────────────────────────────────────
   Reports
   ───────────────────────────────────────────────────────────── */
export async function getReportsSummary() {
  const { data } = await api.get('/reports/summary');
  return data;
}

export interface CoverageReport {
  range: { from: string | null; to: string | null; granularity: 'day' | 'month' };
  summary: {
    total: number; scripted: number; executed: number; passed: number; failed: number;
    notRun: number; totalRuns: number; automationCoverage: number; passRate: number;
  };
  byStatus: { name: string; value: number }[];
  byType: { name: string; value: number }[];
  byPriority: { name: string; value: number }[];
  byFeature: { name: string; value: number }[];
  trend: { bucket: string; total: number; passed: number; failed: number }[];
  runs: {
    id: string; storyKey: string | null; storyTitle: string | null; source: string | null;
    platform: string | null; createdAt: string; total: number; passed: number; failed: number; notRun: number;
  }[];
}

export async function getCoverageReport(range?: { from?: string; to?: string }): Promise<CoverageReport> {
  const params: Record<string, string> = {};
  if (range?.from) params.from = range.from;
  if (range?.to) params.to = range.to;
  const { data } = await api.get('/reports/coverage', { params });
  return data;
}

/* ─────────────────────────────────────────────────────────────
   TestRail integration (TestRail = data source, IntelliQE = viz)
   ───────────────────────────────────────────────────────────── */
export interface TestRailStatus {
  connected: boolean; baseUrl: string | null; email: string | null;
  lastSyncedAt: string | null; syncStatus: string | null; projectsCount: number; runsCount: number;
}
export interface TestRailDashboardData {
  projects: { id: number; name: string; isCompleted: boolean }[];
  lastSyncedAt: string | null;
  summary: { runs: number; total: number; passed: number; failed: number; blocked: number; retest: number; untested: number; executed: number; passRate: number };
  byStatus: { name: string; value: number }[];
  perRun: { id: number; name: string; passed: number; failed: number; blocked: number; untested: number; total: number; createdOn: string | null }[];
  trend: { bucket: string; passed: number; failed: number; blocked: number }[];
  milestones: { id: number; name: string; isCompleted: boolean; startedOn: string | null; dueOn: string | null }[];
}

export async function getTestRailStatus(): Promise<TestRailStatus> {
  const { data } = await api.get('/testrail/status');
  return data;
}
export async function connectTestRail(baseUrl: string, email: string, apiKey: string) {
  const { data } = await api.post('/testrail/connect', { baseUrl, email, apiKey: encryptField(apiKey) }, { timeout: 120_000 });
  return data;
}
export async function syncTestRail() {
  const { data } = await api.post('/testrail/sync', {}, { timeout: 180_000 });
  return data;
}
export async function getTestRailDashboard(projectId?: number): Promise<TestRailDashboardData> {
  const { data } = await api.get('/testrail/dashboard', { params: projectId ? { projectId } : {} });
  return data;
}
export async function disconnectTestRail() {
  const { data } = await api.delete('/testrail/disconnect');
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
  const params: Record<string, any> = {};
  if (runId) params.runId = runId;
  const { data } = await api.get('/allure/status', { params });
  return data;
}

/* ─────────────────────────────────────────────────────────────
   Execution Recordings (CDP screen capture of test runs + timing)
   ───────────────────────────────────────────────────────────── */
export interface RecordedTest {
  testCaseId: string | null;
  tcNumber: string | null;
  title: string;
  status: 'passed' | 'failed' | 'not_run';
  durationMs: number;
  /** Frame-bundle file name (fetch via getRecordingFrames), or null if none captured. */
  framesFile: string | null;
  frameCount: number;
  /** First frame as base64 JPEG, for an instant poster without loading the bundle. */
  posterJpg: string | null;
  error?: string;
}

export interface ExecutionRecording {
  runId: string;
  recordedAt: string;
  mode: 'frames';
  totalDurationMs: number;
  sumTestDurationMs: number;
  passed: number;
  failed: number;
  total: number;
  tests: RecordedTest[];
  /** Set when no frames could be captured (non-Chromium host) — timing is still valid. */
  captureUnavailable?: boolean;
  note?: string;
}

/** A test's playable frames: each `jpg` is base64, shown at offset `tMs`. */
export interface FrameBundle {
  durationMs: number;
  frames: { tMs: number; jpg: string }[];
}

export interface RecordingRun {
  id: string;
  storyKey: string | null;
  storyTitle: string | null;
  source: string | null;
  createdAt: string;
  scriptCount: number;
  hasRecording: boolean;
  recordedAt: string | null;
}

export async function getRecordingRuns(): Promise<{ runs: RecordingRun[] }> {
  const { data } = await api.get('/recordings/runs');
  return data;
}

export async function getRecordingForRun(
  testRunId: string,
): Promise<{ exists: boolean; recording?: ExecutionRecording }> {
  const { data } = await api.get(`/recordings/by-run/${testRunId}`);
  return data;
}

// Fetch one test's frame bundle on demand (lazy — bundles can be large).
export async function getRecordingFrames(
  testRunId: string,
  framesFile: string,
): Promise<FrameBundle> {
  const { data } = await api.get(`/recordings/frames/${testRunId}/${encodeURIComponent(framesFile)}`);
  return data;
}

// Run the saved scripts with CDP screen recording on. Real browser execution can
// take several minutes for a full suite, so allow a long timeout.
// Pass `only` (test_case_ids / tc_numbers) to re-record just a subset — e.g. only
// the failed tests — which merges into the existing recording.
export async function recordExecutionForRun(
  testRunId: string,
  only?: string[],
): Promise<{ ok: boolean; recording: ExecutionRecording }> {
  const body = only && only.length ? { only } : {};
  const { data } = await api.post(`/recordings/run/${testRunId}`, body, { timeout: 900_000 });
  return data;
}

// Delete one test's recording from a run. `id` is the test's stable key
// (testCaseId, tcNumber, or title). Returns the updated recording, or
// exists:false when that was the last recording for the run.
export async function deleteRecordingEntry(
  testRunId: string,
  id: string,
): Promise<{ deleted: boolean; exists: boolean; recording: ExecutionRecording | null }> {
  const { data } = await api.delete(`/recordings/${testRunId}`, { data: { id } });
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

export async function connectIntegration(integrationId: string, configData: Record<string, any>) {
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

/* ─────────────────────────────────────────────────────────────
   Feature flags (per-tenant on/off switchboard)
   ───────────────────────────────────────────────────────────── */
export async function getFeatureFlags(): Promise<{ flags: Record<string, boolean> }> {
  const { data } = await api.get('/users/feature-flags');
  return data;
}

export async function saveFeatureFlags(flags: Record<string, boolean>): Promise<{ ok: boolean; flags: Record<string, boolean> }> {
  const { data } = await api.put('/users/feature-flags', { flags });
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
