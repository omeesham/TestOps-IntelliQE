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
   Azure Storage — durable report archive (System Configuration → Storage)
   ───────────────────────────────────────────────────────────── */
export async function connectAzureStorage(payload: {
  accountUrl?: string; connectionString?: string; containerName?: string; prefix?: string;
}) {
  const { data } = await api.post('/storage/connect', {
    accountUrl: payload.accountUrl || undefined,
    connectionString: payload.connectionString ? encryptField(payload.connectionString) : undefined,
    containerName: payload.containerName || undefined,
    prefix: payload.prefix || undefined,
  });
  return data as { ok: boolean; message?: string; containerName?: string };
}

export async function testAzureStorage(payload: {
  accountUrl?: string; connectionString?: string; containerName?: string;
}) {
  const { data } = await api.post('/storage/test', {
    accountUrl: payload.accountUrl || undefined,
    connectionString: payload.connectionString ? encryptField(payload.connectionString) : undefined,
    containerName: payload.containerName || undefined,
  });
  return data as { ok: boolean; message?: string; error?: string };
}

/** Load a run's report — restores it from Azure storage when not cached locally. */
export async function loadAllureReport(runId: string) {
  const { data } = await api.post('/allure/load', { runId }, { timeout: 120_000 });
  return data as {
    exists: boolean; generatedAt?: string; reportUrl?: string; allureReportUrl?: string;
    /** Why this run has no Allure report, when it has none. */
    allureError?: string;
    source?: 'local' | 'restored' | 'missing';
  };
}

/* ─────────────────────────────────────────────────────────────
   Git publish — GitHub commits straight onto the configured branch
   (mode 'direct'); GitLab/Bitbucket open a real MR/PR (mode 'pr').
   ───────────────────────────────────────────────────────────── */
export interface GitPublishResult {
  provider: 'github' | 'gitlab' | 'bitbucket';
  /** 'direct' = committed onto the configured branch; 'pr' = PR/MR opened. */
  mode: 'pr' | 'direct';
  /** PR/MR URL in 'pr' mode; the branch's web URL in 'direct' mode. */
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
  /** Content was lost or degraded while reading the file — a caution. */
  warning?: string;
  /** What was read, for confirmation — information, not a problem. */
  notice?: string;
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
   API-spec upload — "Upload API Spec" button on the chat API form.
   Uploads a spec in any format (OpenAPI/Swagger, Postman, XML/WSDL,
   PDF, Word, JSON, YAML, text) and gets back a normalised endpoint
   the form fields can be populated from.
   ───────────────────────────────────────────────────────────── */
export interface ParsedApiEndpoint {
  /** Short human label for the picker, e.g. "GET /users/{id} — Get user". */
  title: string;
  method: string;
  url: string;
  headers: { key: string; value: string }[];
  auth: { type: 'none' | 'bearer' | 'basic' | 'apikey'; value?: string };
  body?: string;
  expectedStatus?: number;
  expectedResponse?: string;
}

export interface ParsedApiSpecResult {
  /** Every endpoint found in the file (>=1). One → auto-fill; many → let the user pick. */
  endpoints: ParsedApiEndpoint[];
  count: number;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  /** Content was lost or degraded while reading the file — shown as a caution. */
  warning?: string;
  /** What was read, for confirmation — shown as plain information, not a problem. */
  notice?: string;
}

export async function parseApiSpecFromFile(file: File, format?: string): Promise<ParsedApiSpecResult> {
  const form = new FormData();
  form.append('file', file);
  if (format) form.append('format', format);
  const { data } = await api.post('/document/parse-api-spec', form, {
    headers: { 'Content-Type': 'multipart/form-data' },
    // Parsing extracts text AND makes an LLM call — allow a generous timeout.
    timeout: 120_000,
  });
  return data;
}

/* ─────────────────────────────────────────────────────────────
   API Automation workspace — /api/api-automation
   Intake (12 methods), pattern intelligence, environments, the
   dashboard and the headless run. Every import answers with the
   same shape: the endpoints it produced plus the profile derived
   from them.
   ───────────────────────────────────────────────────────────── */
export interface ApiImportResponse {
  endpoints: any[];
  count: number;
  parser: string;
  format: string;
  warnings: string[];
  notice?: string;
  profile: any | null;
  /** Bulk file import only — per-file outcome. */
  files?: { fileName: string; count: number; parser?: string; format?: string; error?: string; warnings: string[] }[];
  /** Live probe only. */
  observed?: { status: number; durationMs: number; contentType: string };
}

const IMPORT_TIMEOUT = 180_000;

export async function importApiFiles(files: File[], format = 'auto'): Promise<ApiImportResponse> {
  const form = new FormData();
  for (const f of files) form.append('files', f);
  form.append('format', format);
  const { data } = await api.post('/api-automation/import/files', form, { headers: { 'Content-Type': 'multipart/form-data' }, timeout: IMPORT_TIMEOUT });
  return data;
}

export async function importApiText(text: string, opts: { format?: string; method?: string; name?: string; variables?: Record<string, string> } = {}): Promise<ApiImportResponse> {
  const { data } = await api.post('/api-automation/import/text', { text, ...opts }, { timeout: IMPORT_TIMEOUT });
  return data;
}

export async function importApiUrl(url: string, opts: { format?: string; headers?: { key: string; value: string }[]; baseUrl?: string } = {}): Promise<ApiImportResponse> {
  const { data } = await api.post('/api-automation/import/url', { url, ...opts }, { timeout: IMPORT_TIMEOUT });
  return data;
}

export async function importApiEndpoint(input: { url: string; method?: string; headers?: { key: string; value: string }[]; auth?: { type: string; value?: string; headerName?: string }; body?: string; discover?: boolean }): Promise<ApiImportResponse> {
  const { data } = await api.post('/api-automation/import/endpoint', input, { timeout: 60_000 });
  return data;
}

export async function importApiCurl(curl: string): Promise<ApiImportResponse> {
  const { data } = await api.post('/api-automation/import/curl', { curl });
  return data;
}

export async function importApiGraphql(url: string, headers?: { key: string; value: string }[], auth?: { type: string; value?: string }): Promise<ApiImportResponse> {
  const { data } = await api.post('/api-automation/import/graphql', { url, headers, auth }, { timeout: 60_000 });
  return data;
}

export async function importApiMcp(url: string, headers?: { key: string; value: string }[], auth?: { type: string; value?: string }): Promise<ApiImportResponse> {
  const { data } = await api.post('/api-automation/import/mcp', { url, headers, auth }, { timeout: 60_000 });
  return data;
}

export async function importApiConnector(manifest: string | object, name?: string): Promise<ApiImportResponse> {
  const { data } = await api.post('/api-automation/import/connector', { manifest, name });
  return data;
}

export async function importApiWebhook(def: { url: string; method?: string; signatureHeader?: string; secret?: string; headers?: { key: string; value: string }[]; expectedStatus?: number; events: { name: string; payload: string; description?: string }[] }): Promise<ApiImportResponse> {
  const { data } = await api.post('/api-automation/import/webhook', def);
  return data;
}

/** SDK source or middleware/route definitions — pasted text or an uploaded file. */
export async function importApiSource(method: 'sdk' | 'middleware', input: { text?: string; file?: File; name?: string }): Promise<ApiImportResponse> {
  const form = new FormData();
  if (input.file) form.append('file', input.file);
  if (input.text) form.append('text', input.text);
  if (input.name) form.append('name', input.name);
  const { data } = await api.post(`/api-automation/import/${method}`, form, { headers: { 'Content-Type': 'multipart/form-data' }, timeout: IMPORT_TIMEOUT });
  return data;
}

/**
 * Design scenarios as a background job — one model call per endpoint means a
 * big catalogue outlives any single HTTP request. Returns the jobId to poll.
 */
export async function designApiScenarios(input: { apiSpecs: ApiSpecPayload[]; apiLayers?: string[]; apiProfile?: { insights?: string[] } | null; requirements?: string; environmentId?: string }): Promise<{ jobId: string; pollUrl: string }> {
  const { data } = await api.post('/api-automation/design', input, { timeout: 60_000 });
  return data;
}

/**
 * Re-render an already-designed run against another environment — deterministic,
 * no model call. Takes the templated cases the design job returned and returns
 * fresh test cases + specs + service objects resolved against `environmentId`
 * (omit it for "no environment").
 */
export async function renderApiRun(cases: any[], environmentId?: string): Promise<{ testCases: any[]; automationScripts: any[]; pageObjects: any[]; environment: { id: string; name: string } | null }> {
  const { data } = await api.post('/api-automation/render', { cases, environmentId }, { timeout: 60_000 });
  return data;
}

export interface ApiJob<T = any> {
  status: 'running' | 'completed' | 'failed';
  result?: T;
  error?: string;
  progress?: { phase?: string; done?: number; total?: number; flows?: number; message?: string; detail?: string };
  createdAt: number;
  finishedAt?: number;
}

export async function getApiJob<T = any>(jobId: string): Promise<ApiJob<T>> {
  const { data } = await api.get(`/api-automation/jobs/${encodeURIComponent(jobId)}`, { timeout: 30_000 });
  return data;
}

export async function analyzeApi(endpoints: any[], deep = false): Promise<{ profile: any }> {
  const { data } = await api.post('/api-automation/analyze', { endpoints, deep }, { timeout: deep ? 120_000 : 30_000 });
  return data;
}

/* ── Contract / schema validation (opt-in, standalone) ── */
export interface ContractViolation { kind: 'transport' | 'status' | 'content-type' | 'schema'; message: string; path?: string }
export interface ContractResult {
  id: string; title: string; method: string; url: string;
  reachable: boolean; status?: number; elapsedMs?: number;
  expectedStatus?: number; statusOk: boolean;
  schemaChecked: boolean; schemaValid: boolean;
  violations: ContractViolation[];
}
export interface ContractReport {
  results: ContractResult[];
  summary: { total: number; passed: number; failed: number; unreachable: number; checkedSchema: number };
}
/** Live-probe the given endpoints and validate each response against its contract. */
export async function validateApiContract(endpoints: any[]): Promise<ContractReport> {
  const { data } = await api.post('/api-automation/contract/validate', { endpoints }, { timeout: 120_000 });
  return data;
}

/* ── Async / streaming probe (WebSocket + SSE, opt-in) ── */
export interface AsyncFrame { at: number; preview: string }
export interface AsyncProbeResult {
  protocol: 'websocket' | 'sse'; url: string; connected: boolean; received: number;
  frames: AsyncFrame[]; firstByteMs?: number; durationMs: number;
  matched?: boolean; expectContains?: string; error?: string;
}
export async function runAsyncProbe(input: { url: string; message?: string; headers?: { key: string; value: string }[]; waitMs?: number; expectContains?: string }): Promise<AsyncProbeResult> {
  const { data } = await api.post('/api-automation/async/probe', input, { timeout: 30_000 });
  return data;
}

/* ── Contract-drift maintenance (opt-in, standalone) ── */
export interface DriftShapeChange { kind: 'added' | 'removed' | 'type-changed'; path: string; detail?: string }
export interface DriftResult {
  id: string; title: string; method: string; url: string; reachable: boolean;
  hasStoredStatus: boolean; hasStoredShape: boolean; liveStatus?: number; storedStatus?: number;
  statusDrift: boolean; shapeDrift: boolean; changes: DriftShapeChange[];
  suggestedStatus?: number; suggestedResponse?: string; note?: string;
}
export interface DriftReport {
  results: DriftResult[];
  summary: { total: number; drifted: number; clean: number; unreachable: number; noExpectation: number };
}
export async function scanApiDrift(endpoints: any[]): Promise<DriftReport> {
  const { data } = await api.post('/api-automation/drift/scan', { endpoints }, { timeout: 120_000 });
  return data;
}

/* ── Load test (opt-in, standalone) ── */
export interface LoadTestResult {
  url: string; method: string; totalRequests: number; concurrency: number; durationMs: number;
  completed: number; failed: number; non2xx: number; throughputRps: number;
  latency: { min: number; p50: number; p90: number; p95: number; p99: number; max: number; avg: number };
  statusCounts: Record<string, number>;
  errors: { message: string; count: number }[];
}
export async function runApiLoadTest(input: { endpoint: any; totalRequests?: number; concurrency?: number; allowWrites?: boolean }): Promise<LoadTestResult> {
  const { data } = await api.post('/api-automation/loadtest', input, { timeout: 180_000 });
  return data;
}

/* ── Staged load profile + SLA gate (opt-in, standalone) ── */
export interface LoadStageInput { durationSec: number; concurrency: number }
export interface SlaThresholds { p95Ms?: number; p99Ms?: number; maxErrorRatePct?: number; minThroughputRps?: number }
export interface LoadStageResult {
  index: number; concurrency: number; durationMs: number; completed: number; failed: number; non2xx: number;
  throughputRps: number; latency: LoadTestResult['latency'];
}
export interface SlaCheck { name: string; limit: number; actual: number; unit: string; pass: boolean }
export interface LoadProfileResult {
  url: string; method: string;
  stages: LoadStageResult[];
  totals: { completed: number; failed: number; non2xx: number; durationMs: number; throughputRps: number; errorRatePct: number; latency: LoadTestResult['latency'] };
  statusCounts: Record<string, number>;
  errors: { message: string; count: number }[];
  sla: { pass: boolean; checks: SlaCheck[] } | null;
}
export async function runApiLoadProfile(input: { endpoint: any; stages: LoadStageInput[]; sla?: SlaThresholds; allowWrites?: boolean }): Promise<LoadProfileResult> {
  const { data } = await api.post('/api-automation/loadtest/profile', input, { timeout: 180_000 });
  return data;
}

/* ── Security scan (opt-in, standalone) ── */
export interface SecurityFinding {
  endpointId: string; title: string; method: string; url: string; check: string;
  severity: 'high' | 'medium' | 'low' | 'info'; status: 'vulnerable' | 'ok' | 'info' | 'skipped'; detail: string;
}
export interface SecurityReport {
  findings: SecurityFinding[];
  summary: { endpoints: number; vulnerable: number; high: number; medium: number; low: number; info: number };
}
export async function runApiSecurityScan(endpoints: any[]): Promise<SecurityReport> {
  const { data } = await api.post('/api-automation/security/scan', { endpoints }, { timeout: 180_000 });
  return data;
}

/* ── OWASP API Security Top-10 (2023) compliance pack (opt-in, standalone) ── */
export type OwaspStatus = 'pass' | 'warn' | 'fail' | 'review' | 'not_assessed';
export type OwaspAssessment = 'dynamic' | 'static' | 'none';
export type OwaspGrade = 'A' | 'B' | 'C' | 'D' | 'F';
export interface OwaspCategory {
  id: string; key: string; name: string;
  status: OwaspStatus; assessment: OwaspAssessment;
  summary: string; evidence: string[]; affected: string[]; remediation: string;
}
export interface OwaspComplianceReport {
  categories: OwaspCategory[];
  summary: {
    total: number; assessed: number; passed: number; warned: number; failed: number; review: number; notAssessed: number;
    compliancePct: number | null; grade: OwaspGrade | null; high: number; medium: number; low: number;
  };
  basis: { endpoints: number; scanned: number; generatedAt: string };
  security: SecurityReport;
}
export async function runApiOwaspCompliance(endpoints: any[]): Promise<OwaspComplianceReport> {
  const { data } = await api.post('/api-automation/security/owasp', { endpoints }, { timeout: 180_000 });
  return data;
}

/* ── AI-guided fuzzing / property-based robustness (opt-in, standalone) ── */
export type FuzzSeverity = 'high' | 'medium' | 'low' | 'info';
export type FuzzKind = 'server-error' | 'info-leak' | 'reflection' | 'timeout' | 'weak-validation' | 'handled' | 'unreachable' | 'skipped';
export interface FuzzFinding {
  endpointId: string; title: string; method: string; url: string;
  param: string; category: string; payload: string; status?: number;
  kind: FuzzKind; severity: FuzzSeverity; detail: string;
}
export interface FuzzReport {
  findings: FuzzFinding[];
  summary: { endpoints: number; cases: number; crashes: number; leaks: number; reflections: number; timeouts: number; weakValidation: number; handled: number; issues: number };
}
export async function runApiFuzz(endpoints: any[]): Promise<FuzzReport> {
  const { data } = await api.post('/api-automation/fuzz', { endpoints }, { timeout: 180_000 });
  return data;
}

/* ── AI root-cause diagnosis (opt-in, standalone) ── */
export interface Diagnosis {
  category: string; rootCause: string; suggestedFix: string;
  confidence: 'high' | 'medium' | 'low'; reproCurl: string;
}
export async function diagnoseApiFailure(failure: {
  title?: string; method: string; url: string; error: string;
  expectedStatus?: number; requestBody?: string; responseStatus?: number; responseBody?: string;
}): Promise<Diagnosis> {
  const { data } = await api.post('/api-automation/diagnose', { failure }, { timeout: 60_000 });
  return data;
}

/* ── Run sign-off / review thread (collaboration) ── */
export type ReviewDecision = 'approved' | 'rejected' | 'needs_work' | 'comment';
export interface RunReview {
  id: string; runId: string; decision: ReviewDecision; note?: string; reviewer?: string; createdAt: string;
}
export interface RunReviewThread { reviews: RunReview[]; status: ReviewDecision | null }
export async function listApiRunReviews(runId: string): Promise<RunReviewThread> {
  const { data } = await api.get(`/api-automation/runs/${runId}/reviews`);
  return data;
}
export async function addApiRunReview(runId: string, decision: ReviewDecision, note?: string): Promise<{ review: RunReview }> {
  const { data } = await api.post(`/api-automation/runs/${runId}/reviews`, { decision, note });
  return data;
}

/* ── NL authoring (opt-in, standalone) ── */
export interface NlBrief {
  requirements: string;
  coverage: 'essential' | 'standard' | 'exhaustive';
  layers: string[];
  focus: string[];
  outline: string[];
}
export async function authorApiBrief(description: string, endpoints: any[]): Promise<NlBrief> {
  const { data } = await api.post('/api-automation/nl-author', { description, endpoints }, { timeout: 60_000 });
  return data.brief;
}

/* ── Response-diff regression baselines (opt-in, standalone) ── */
export interface BaselineRecord {
  id: string; sig: string; method: string; url: string; title: string;
  status?: number; contentType?: string; capturedBy?: string; capturedAt: string; updatedAt: string;
}
export type DriftKind = 'status' | 'added' | 'removed' | 'type-changed' | 'value-changed' | 'transport' | 'content';
export interface DriftEntry { kind: DriftKind; path: string; before?: string; after?: string }
export interface BaselineCompareResult {
  id: string; title: string; method: string; url: string;
  hasBaseline: boolean; reachable: boolean; status?: number; baselineStatus?: number;
  drift: DriftEntry[]; capturedAt?: string;
}
export interface BaselineCompareReport {
  results: BaselineCompareResult[];
  summary: { total: number; compared: number; unchanged: number; drifted: number; unreachable: number; noBaseline: number };
}
export interface BaselineCaptureReport { captured: number; skipped: number; total: number; baselines: BaselineRecord[] }

export async function listApiBaselines(): Promise<{ baselines: BaselineRecord[] }> {
  const { data } = await api.get('/api-automation/baselines');
  return data;
}
export async function captureApiBaselines(endpoints: any[]): Promise<BaselineCaptureReport> {
  const { data } = await api.post('/api-automation/baselines/capture', { endpoints }, { timeout: 180_000 });
  return data;
}
export async function compareApiBaselines(endpoints: any[]): Promise<BaselineCompareReport> {
  const { data } = await api.post('/api-automation/baselines/compare', { endpoints }, { timeout: 180_000 });
  return data;
}
export async function deleteApiBaseline(id: string): Promise<{ ok: boolean }> {
  const { data } = await api.delete(`/api-automation/baselines/${id}`);
  return data;
}

/* ── Data-driven testing (opt-in, standalone) ── */
export interface DataDrivenRowResult {
  index: number; values: Record<string, string>; url: string; reachable: boolean;
  status?: number; expectedStatus?: number; elapsedMs?: number; pass: boolean; error?: string;
}
export interface DataDrivenReport {
  method: string; title: string; results: DataDrivenRowResult[];
  summary: { total: number; passed: number; failed: number; unreachable: number; avgMs: number };
}
export async function runApiDataDriven(endpoint: any, rows: Record<string, any>[]): Promise<DataDrivenReport> {
  const { data } = await api.post('/api-automation/datadriven', { endpoint, rows }, { timeout: 180_000 });
  return data;
}

/* ── Schedules (opt-in recurring runs) ── */
export interface ApiSchedule {
  id: string; name: string; endpointCount: number; environmentId?: string; coverage?: string;
  intervalMinutes: number; execute: boolean; heal: boolean; enabled: boolean; createdBy?: string;
  nextRunAt?: string; lastRunAt?: string; lastRunId?: string; lastStatus?: string; lastSummary?: string;
  createdAt: string; updatedAt: string;
}
export async function listApiSchedules(): Promise<{ schedules: ApiSchedule[] }> {
  const { data } = await api.get('/api-automation/schedules');
  return data;
}
export async function createApiSchedule(input: { name: string; endpoints: any[]; environmentId?: string; coverage?: string; intervalMinutes?: number; execute?: boolean; heal?: boolean; enabled?: boolean }): Promise<{ schedule: ApiSchedule }> {
  const { data } = await api.post('/api-automation/schedules', input);
  return data;
}
export async function updateApiSchedule(id: string, input: Partial<{ name: string; endpoints: any[]; environmentId: string; coverage: string; intervalMinutes: number; execute: boolean; heal: boolean; enabled: boolean }>): Promise<{ schedule: ApiSchedule }> {
  const { data } = await api.put(`/api-automation/schedules/${id}`, input);
  return data;
}
export async function deleteApiSchedule(id: string): Promise<{ ok: boolean }> {
  const { data } = await api.delete(`/api-automation/schedules/${id}`);
  return data;
}
export async function runApiScheduleNow(id: string): Promise<{ ok: boolean; message: string }> {
  const { data } = await api.post(`/api-automation/schedules/${id}/run`, {});
  return data;
}

/* ── Webhooks (opt-in run notifications) ── */
export interface ApiWebhook {
  id: string; name: string; url: string; kind: 'slack' | 'teams' | 'generic'; hasSecret: boolean;
  onFailureOnly: boolean; enabled: boolean; createdBy?: string; lastStatus?: string; lastSentAt?: string;
  createdAt: string; updatedAt: string;
}
export async function listApiWebhooks(): Promise<{ webhooks: ApiWebhook[] }> {
  const { data } = await api.get('/api-automation/webhooks');
  return data;
}
export async function createApiWebhook(input: { name: string; url: string; kind?: string; secret?: string; onFailureOnly?: boolean; enabled?: boolean }): Promise<{ webhook: ApiWebhook }> {
  const { data } = await api.post('/api-automation/webhooks', input);
  return data;
}
export async function updateApiWebhook(id: string, input: Partial<{ name: string; url: string; kind: string; secret: string; onFailureOnly: boolean; enabled: boolean }>): Promise<{ webhook: ApiWebhook }> {
  const { data } = await api.put(`/api-automation/webhooks/${id}`, input);
  return data;
}
export async function deleteApiWebhook(id: string): Promise<{ ok: boolean }> {
  const { data } = await api.delete(`/api-automation/webhooks/${id}`);
  return data;
}
export async function testApiWebhook(id: string): Promise<{ ok: boolean }> {
  const { data } = await api.post(`/api-automation/webhooks/${id}/test`, {}, { timeout: 20_000 });
  return data;
}
/** Fire-and-forget: notify configured webhooks about a run the UI just finished. */
export async function notifyApiRun(notification: {
  title: string; runId?: string; reportUrl?: string; status: 'passed' | 'failed';
  stats?: { total: number; passed: number; failed: number; notRun: number; passRate: number };
  failures?: { title: string; error?: string }[];
}): Promise<{ sent: number; failed: number }> {
  const { data } = await api.post('/api-automation/notify', { notification }, { timeout: 15_000 });
  return data;
}

export async function listApiEnvironments(): Promise<{ environments: any[] }> {
  const { data } = await api.get('/api-automation/environments');
  return data;
}
export async function createApiEnvironment(input: { name: string; baseUrl?: string; color?: string; variables?: any[]; isDefault?: boolean }): Promise<{ environment: any }> {
  const { data } = await api.post('/api-automation/environments', input);
  return data;
}
export async function updateApiEnvironment(id: string, input: { name?: string; baseUrl?: string; color?: string; variables?: any[]; isDefault?: boolean }): Promise<{ environment: any }> {
  const { data } = await api.put(`/api-automation/environments/${encodeURIComponent(id)}`, input);
  return data;
}
export async function deleteApiEnvironment(id: string): Promise<void> {
  await api.delete(`/api-automation/environments/${encodeURIComponent(id)}`);
}
/** Resolve {{vars}} + base URL server-side (secrets never leave the server in a list). */
export async function resolveApiEnvironment(id: string, endpoints: any[]): Promise<{ endpoints: any[]; environment: { id: string; name: string; baseUrl: string } }> {
  const { data } = await api.post(`/api-automation/environments/${encodeURIComponent(id)}/resolve`, { endpoints });
  return data;
}

/** The dashboard roll-up; `fresh` bypasses the server's short cache (Refresh, post-run reload). */
export async function getApiOverview(fresh = false): Promise<any> {
  const { data } = await api.get('/api-automation/overview', { timeout: 60_000, params: fresh ? { fresh: 1 } : undefined });
  return data;
}

export async function listApiRuns(page = 1, pageSize = 20): Promise<{ items: any[]; total: number; page: number; pageSize: number }> {
  const { data } = await api.get('/api-automation/runs', { params: { page, pageSize }, timeout: 60_000 });
  return data;
}
export async function getApiRun(id: string): Promise<any> {
  const { data } = await api.get(`/api-automation/runs/${encodeURIComponent(id)}`, { timeout: 60_000 });
  return data;
}
export async function listApiImports(limit = 50): Promise<{ items: any[] }> {
  const { data } = await api.get('/api-automation/imports', { params: { limit } });
  return data;
}

/* ── Traffic capture: record real API calls → catalogue endpoints ── */
export interface CaptureSession {
  id: string;
  name: string;
  status: 'recording' | 'closed';
  entryCount: number;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  sample?: { method: string; url: string; status?: number; mime?: string; at: string }[];
}
export interface CaptureIngestResult { accepted: number; skipped: number; entryCount: number; capped: boolean }

export async function listCaptureSessions(): Promise<{ sessions: CaptureSession[] }> {
  const { data } = await api.get('/api-automation/capture/sessions');
  return data;
}
export async function createCaptureSession(name?: string): Promise<{ session: CaptureSession }> {
  const { data } = await api.post('/api-automation/capture/sessions', { name });
  return data;
}
export async function getCaptureSession(id: string): Promise<{ session: CaptureSession }> {
  const { data } = await api.get(`/api-automation/capture/sessions/${encodeURIComponent(id)}`);
  return data;
}
export async function ingestCaptureEntries(id: string, entries: unknown): Promise<CaptureIngestResult> {
  const { data } = await api.post(`/api-automation/capture/sessions/${encodeURIComponent(id)}/ingest`, { entries }, { timeout: 60_000 });
  return data;
}
export async function captureToEndpoints(id: string): Promise<ApiImportResponse> {
  const { data } = await api.post(`/api-automation/capture/sessions/${encodeURIComponent(id)}/endpoints`, {}, { timeout: 60_000 });
  return data;
}
export async function closeCaptureSession(id: string): Promise<{ ok: boolean }> {
  const { data } = await api.post(`/api-automation/capture/sessions/${encodeURIComponent(id)}/close`, {});
  return data;
}
export async function deleteCaptureSession(id: string): Promise<{ ok: boolean }> {
  const { data } = await api.delete(`/api-automation/capture/sessions/${encodeURIComponent(id)}`);
  return data;
}

/* ── Hosted mock servers: publish endpoints as a live public stub ── */
export interface MockServer {
  id: string;
  mockId: string;
  name: string;
  enabled: boolean;
  hitCount: number;
  routeCount: number;
  routes: { method: string; path: string; status: number }[];
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}
export async function listMockServers(): Promise<{ mocks: MockServer[] }> {
  const { data } = await api.get('/api-automation/mocks');
  return data;
}
export async function createMockServer(name: string, endpoints: any[]): Promise<{ mock: MockServer }> {
  const { data } = await api.post('/api-automation/mocks', { name, endpoints });
  return data;
}
export async function toggleMockServer(id: string, enabled: boolean): Promise<{ mock: MockServer }> {
  const { data } = await api.post(`/api-automation/mocks/${encodeURIComponent(id)}/toggle`, { enabled });
  return data;
}
export async function deleteMockServer(id: string): Promise<{ ok: boolean }> {
  const { data } = await api.delete(`/api-automation/mocks/${encodeURIComponent(id)}`);
  return data;
}

/* ── Traffic coverage gaps: recorded traffic vs tested catalogue ── */
export interface CoverageGapsReport {
  summary: { observed: number; tested: number; covered: number; gaps: number; coveragePct: number };
  gaps: any[];
  coveredSignatures: string[];
  gapSignatures: string[];
  fromSessions: { id: string; name: string; entryCount: number }[];
  profile: any | null;
}
export async function analyzeCoverageGaps(endpoints: any[], sessionId?: string): Promise<CoverageGapsReport> {
  const { data } = await api.post('/api-automation/coverage/gaps', { endpoints, sessionId }, { timeout: 120_000 });
  return data;
}

/* ── Semantic / AI-response assertion ── */
export interface SemanticAssertResult {
  intent: string; passed: boolean; confidence: 'high' | 'medium' | 'low'; rationale: string;
  observed: { ok: boolean; status?: number; elapsedMs: number; bodyPreview: string; error?: string };
}
export async function runSemanticAssertion(endpoint: any, intent: string): Promise<SemanticAssertResult> {
  const { data } = await api.post('/api-automation/semantic/assert', { endpoint, intent }, { timeout: 60_000 });
  return data;
}

/* ── Failure clustering ── */
export interface FailureCluster { signature: string; label: string; category: string; count: number; members: string[]; sample: { title?: string; method?: string; url?: string; error?: string; status?: number }; suggestedFix?: string }
export interface FailureClusterReport { summary: { failures: number; clusters: number }; clusters: FailureCluster[] }
export async function clusterApiFailures(failures: any[], explain = false): Promise<FailureClusterReport> {
  const { data } = await api.post('/api-automation/failures/cluster', { failures, explain }, { timeout: 60_000 });
  return data;
}

/* ── Async callback / webhook capture ── */
export interface CallbackListener { id: string; token: string; name: string; eventCount: number; createdBy: string; createdAt: string }
export interface CallbackEvent { id: string; method: string; path: string; query: string; headers: Record<string, string>; body: string; receivedAt: string }
export async function listCallbackListeners(): Promise<{ listeners: CallbackListener[] }> {
  const { data } = await api.get('/api-automation/callbacks');
  return data;
}
export async function createCallbackListener(name?: string): Promise<{ listener: CallbackListener }> {
  const { data } = await api.post('/api-automation/callbacks', { name });
  return data;
}
export async function deleteCallbackListener(id: string): Promise<{ ok: boolean }> {
  const { data } = await api.delete(`/api-automation/callbacks/${encodeURIComponent(id)}`);
  return data;
}
export async function getCallbackEvents(token: string): Promise<{ events: CallbackEvent[] }> {
  const { data } = await api.get(`/api-automation/callbacks/${encodeURIComponent(token)}/events`);
  return data;
}

/* ─────────────────────────────────────────────────────────────
   Web Lab — opt-in browser tools (accessibility, visual/cross-browser,
   responsive, performance). Each launches a headless browser server-side.
   ───────────────────────────────────────────────────────────── */
const WEB_TOOL_TIMEOUT = 120_000;

export type WebEngine = 'chromium' | 'firefox' | 'webkit';

// Accessibility
export interface A11yViolation { id: string; impact: string; help: string; description: string; helpUrl: string; wcagTags: string[]; nodeCount: number; sampleNodes: { html: string; target: string }[] }
export interface A11yReport {
  url: string; engine: WebEngine; engineLabel: string; standard: string; standardLabel: string;
  summary: { violations: number; byImpact: Record<string, number>; passes: number; incomplete: number; score: number };
  violations: A11yViolation[]; scannedAt: string;
}
export async function runWebAccessibility(input: { url: string; engine?: WebEngine; standard?: string }): Promise<A11yReport> {
  const { data } = await api.post('/web-tools/accessibility', input, { timeout: WEB_TOOL_TIMEOUT });
  return data;
}

// Visual + cross-browser
export interface VisualCaptureCell { engine: WebEngine; engineLabel: string; viewport: string; ok: boolean; pngBase64?: string; width?: number; height?: number; error?: string; unavailable?: boolean }
export interface VisualCaptureReport { url: string; cells: VisualCaptureCell[]; capturedAt: string }
export interface VisualBaseline { id: string; sig: string; url: string; engine: WebEngine; viewport: string; width: number; height: number; capturedBy: string; capturedAt: string; updatedAt: string }
export interface VisualCompareResult {
  url: string; engine: WebEngine; viewport: string; hasBaseline: boolean; matched: boolean; reason?: string;
  diffPixels: number; totalPixels: number; diffRatio: number; width: number; height: number;
  baselinePng?: string; currentPng?: string; diffPng?: string; comparedAt: string;
}
export async function webVisualViewports(): Promise<{ viewports: { name: string; width: number; height: number }[] }> {
  const { data } = await api.get('/web-tools/visual/viewports');
  return data;
}
export async function webVisualCapture(input: { url: string; engines?: WebEngine[]; viewports?: string[]; fullPage?: boolean }): Promise<VisualCaptureReport> {
  const { data } = await api.post('/web-tools/visual/capture', input, { timeout: WEB_TOOL_TIMEOUT });
  return data;
}
export async function listWebVisualBaselines(): Promise<{ baselines: VisualBaseline[] }> {
  const { data } = await api.get('/web-tools/visual/baselines');
  return data;
}
export async function captureWebVisualBaseline(input: { url: string; engine?: WebEngine; viewport?: string; fullPage?: boolean }): Promise<{ baseline: VisualBaseline }> {
  const { data } = await api.post('/web-tools/visual/baseline', input, { timeout: WEB_TOOL_TIMEOUT });
  return data;
}
export async function compareWebVisual(input: { url: string; engine?: WebEngine; viewport?: string; fullPage?: boolean; threshold?: number }): Promise<VisualCompareResult> {
  const { data } = await api.post('/web-tools/visual/compare', input, { timeout: WEB_TOOL_TIMEOUT });
  return data;
}
export async function deleteWebVisualBaseline(id: string): Promise<{ ok: boolean }> {
  const { data } = await api.delete(`/web-tools/visual/baselines/${encodeURIComponent(id)}`);
  return data;
}

// Responsive / device
export interface DeviceCell { device: string; ok: boolean; width?: number; height?: number; isMobile?: boolean; deviceScaleFactor?: number; pngBase64?: string; error?: string }
export interface DeviceReport { url: string; cells: DeviceCell[]; capturedAt: string }
export async function listWebDevices(): Promise<{ devices: string[] }> {
  const { data } = await api.get('/web-tools/responsive/devices');
  return data;
}
export async function captureWebDevices(input: { url: string; devices?: string[]; fullPage?: boolean }): Promise<DeviceReport> {
  const { data } = await api.post('/web-tools/responsive/capture', input, { timeout: WEB_TOOL_TIMEOUT });
  return data;
}

// Performance
export interface PerfMetric { key: string; label: string; value: number | null; unit: string; rating: string }
export interface PerfReport {
  url: string; engine: WebEngine; engineLabel: string; metrics: PerfMetric[];
  resources: { total: number; transferBytes: number; byType: { type: string; count: number; bytes: number }[] };
  overall: string; measuredAt: string;
}
export async function captureWebPerformance(input: { url: string; engine?: WebEngine }): Promise<PerfReport> {
  const { data } = await api.post('/web-tools/performance', input, { timeout: WEB_TOOL_TIMEOUT });
  return data;
}

/* ═════════════════════════════════════════════════════════════
   Market-gap feature set (all opt-in; none touch the generate→execute→heal core)
   ═════════════════════════════════════════════════════════════ */

/* ── 1. Visual flow / journey builder ── */
export interface FlowExtract { name: string; from: 'body' | 'header' | 'status'; path?: string }
export type CompareMode = 'strict' | 'strict-order' | 'lenient' | 'non-extensible';
export interface FlowCheck { kind: 'status' | 'jsonPathExists' | 'jsonPathEquals' | 'bodyContains' | 'responseTimeUnderMs' | 'header' | 'bodyMatches' | 'xpath'; equals?: number | string; oneOf?: number[]; path?: string; value?: unknown; text?: string; ms?: number; name?: string; op?: 'equals' | 'contains' | 'exists'; compareMode?: CompareMode }
export interface ApiOAuth2Config { grant?: string; tokenUrl?: string; clientId?: string; clientSecret?: string; scope?: string; audience?: string; username?: string; password?: string; refreshToken?: string; clientAuthBasic?: boolean }
export interface ApiHttpAuth { type: string; value?: string; headerName?: string; oauth2?: ApiOAuth2Config }
export interface ApiFormField { key: string; value?: string; type?: 'text' | 'file'; filename?: string; contentType?: string; dataBase64?: string }
export type FlowStepType = 'request' | 'if' | 'loop' | 'wait' | 'group';
export type FlowConditionOp = 'eq' | 'ne' | 'exists' | 'notExists' | 'contains' | 'gt' | 'lt';
export interface FlowCondition { var: string; op: FlowConditionOp; value?: string }
export interface FlowLoop { mode: 'times' | 'while'; times?: number; while?: FlowCondition; maxIterations?: number }
export interface FlowStep {
  id?: string;
  name?: string;
  type?: FlowStepType;
  method?: string;
  url?: string;
  headers?: { key: string; value: string }[];
  auth?: ApiHttpAuth;
  body?: string;
  bodyMode?: 'raw' | 'json' | 'form-data' | 'urlencoded' | 'binary';
  formFields?: ApiFormField[];
  bodyBase64?: string;
  bodyContentType?: string;
  extract?: FlowExtract[];
  checks?: FlowCheck[];
  condition?: FlowCondition;
  then?: FlowStep[];
  else?: FlowStep[];
  loop?: FlowLoop;
  steps?: FlowStep[];
  waitMs?: number;
  groupId?: string;
}
export interface SavedApiFlow { id: string; name: string; steps: FlowStep[]; variables: Record<string, string>; createdBy: string; createdAt: string; updatedAt: string }
export interface FlowStepResult { index: number; name: string; method: string; url: string; ok: boolean; status?: number; elapsedMs: number; error?: string; extracted: Record<string, string>; checks: { kind: string; label: string; pass: boolean; detail?: string }[]; bodyPreview: string }
export interface FlowRunResult { passed: boolean; steps: FlowStepResult[]; variables: Record<string, string>; durationMs: number; stepsRun: number; stepsTotal: number }
export async function listApiFlows(): Promise<{ flows: SavedApiFlow[] }> { const { data } = await api.get('/api-automation/flows'); return data; }
export async function saveApiFlow(input: { id?: string; name: string; steps: FlowStep[]; variables?: Record<string, string> }): Promise<{ flow: SavedApiFlow }> { const { data } = await api.post('/api-automation/flows', input); return data; }
export async function deleteApiFlow(id: string): Promise<{ ok: boolean }> { const { data } = await api.delete(`/api-automation/flows/${encodeURIComponent(id)}`); return data; }
export async function runApiFlow(input: { steps: FlowStep[]; variables?: Record<string, string>; allowWrites?: boolean }): Promise<FlowRunResult> { const { data } = await api.post('/api-automation/flows/run', input, { timeout: 180_000 }); return data; }

/* ── 2. Conversational chat-to-test ── */
export interface ChatTestDraft { title: string; method: string; url: string; headers: { key: string; value: string }[]; body?: string; checks: FlowCheck[] }
export interface ChatMessage { role: 'user' | 'assistant'; content: string }
export interface ChatTestResult { reply: string; draft: ChatTestDraft; snippet: string }
export async function chatRefineApiTest(input: { endpoint: { method: string; url: string; headers?: { key: string; value: string }[]; body?: string }; current?: ChatTestDraft; history?: ChatMessage[]; instruction: string }): Promise<ChatTestResult> {
  const { data } = await api.post('/api-automation/chat-test/refine', input, { timeout: 90_000 });
  return data;
}

/* ── 3. Autonomous test maintenance ── */
export interface MaintenanceProposal { id: string; kind: 'adopt-status' | 'adopt-response' | 'add-endpoint'; severity: 'high' | 'medium' | 'low'; title: string; method: string; url: string; rationale: string; endpointId?: string; patch?: { expectedStatus?: number; expectedResponse?: string }; addEndpoint?: any; signature?: string }
export interface MaintenancePlan { summary: { proposals: number; adoptStatus: number; adoptResponse: number; addEndpoint: number; drifted: number; gaps: number }; proposals: MaintenanceProposal[]; narrative?: string }
export async function planApiMaintenance(endpoints: any[], opts: { sessionId?: string; explain?: boolean } = {}): Promise<MaintenancePlan> {
  const { data } = await api.post('/api-automation/maintenance/plan', { endpoints, ...opts }, { timeout: 180_000 });
  return data;
}

/* ── 4. Synthetic test-data factory ── */
export interface SynthField { name: string; type: string; options?: string[]; min?: number; max?: number; pii?: boolean }
export interface SynthDataResult { rows: Record<string, unknown>[]; columns: string[]; fields: SynthField[]; seed: number; csv: string; notes: string[] }
export async function generateSyntheticData(input: { fields?: SynthField[]; sampleBody?: string; endpoint?: { method: string; url: string; description?: string }; count?: number; seed?: number; locale?: string; piiMask?: boolean; edgeCases?: boolean }): Promise<SynthDataResult> {
  const { data } = await api.post('/api-automation/synth-data/generate', input, { timeout: 90_000 });
  return data;
}

/* ── 5. Multi-LLM provider choice ── */
export interface ApiLlmProviderConfig { enabled: boolean; provider: string; model: string; baseUrl: string; keyMasked: string; hasKey: boolean }
export async function getLlmProviderConfig(): Promise<ApiLlmProviderConfig> { const { data } = await api.get('/api-automation/providers/config'); return data; }
export async function saveLlmProviderConfig(input: { enabled?: boolean; provider?: string; model?: string; baseUrl?: string; apiKey?: string }): Promise<ApiLlmProviderConfig> { const { data } = await api.put('/api-automation/providers/config', input); return data; }
export async function deleteLlmProviderConfig(): Promise<{ ok: boolean }> { const { data } = await api.delete('/api-automation/providers/config'); return data; }
export async function testLlmProvider(input?: { provider?: string; model?: string; baseUrl?: string; apiKey?: string }): Promise<{ ok: boolean; reply?: string; error?: string; elapsedMs: number }> { const { data } = await api.post('/api-automation/providers/test', input || {}, { timeout: 60_000 }); return data; }

/* ── 6. MCP server tokens ── */
export interface McpToken { id: string; token: string; name: string; createdBy: string; createdAt: string; lastUsedAt: string | null }
export async function listMcpTokens(): Promise<{ tokens: McpToken[] }> { const { data } = await api.get('/api-automation/mcp-tokens'); return data; }
export async function createMcpToken(name?: string): Promise<{ token: McpToken }> { const { data } = await api.post('/api-automation/mcp-tokens', { name }); return data; }
export async function deleteMcpToken(id: string): Promise<{ ok: boolean }> { const { data } = await api.delete(`/api-automation/mcp-tokens/${encodeURIComponent(id)}`); return data; }

/* ── 7. Event/queue + gRPC ── */
export interface KafkaResult { mode: string; topic: string; produced?: { partition: number; offset?: string }; messages?: { partition: number; offset: string; key: string | null; value: string; timestamp?: string }[]; elapsedMs: number }
export interface GrpcResult { ok: boolean; service: string; method: string; response?: unknown; error?: string; code?: number | string; elapsedMs: number }
export async function kafkaProbe(input: { brokers: string; topic: string; mode: 'produce' | 'consume'; message?: string; key?: string; groupId?: string; fromBeginning?: boolean; ssl?: boolean; sasl?: { mechanism?: string; username?: string; password?: string }; timeoutMs?: number }): Promise<KafkaResult> {
  const { data } = await api.post('/api-automation/messaging/kafka', input, { timeout: 60_000 });
  return data;
}
export async function grpcCall(input: { target: string; protoText: string; service: string; method: string; requestJson?: string; tls?: boolean; metadata?: Record<string, string>; timeoutMs?: number }): Promise<GrpcResult> {
  const { data } = await api.post('/api-automation/messaging/grpc', input, { timeout: 60_000 });
  return data;
}

/* ── 8. Distributed / geo load ── */
export interface GeoRegionInput { name: string; concurrency?: number; proxyUrl?: string; addedLatencyMs?: number }
interface GeoLatency { min: number; p50: number; p90: number; p95: number; p99: number; max: number; avg: number }
export interface GeoRegionResult { name: string; concurrency: number; proxied: boolean; addedLatencyMs: number; completed: number; failed: number; non2xx: number; throughputRps: number; latency: GeoLatency }
export interface GeoLoadResult { url: string; method: string; durationMs: number; regions: GeoRegionResult[]; totals: { completed: number; failed: number; non2xx: number; throughputRps: number; errorRatePct: number; latency: GeoLatency }; statusCounts: Record<string, number>; errors: { message: string; count: number }[]; sla: { pass: boolean; checks: { name: string; limit: number; actual: number; unit: string; pass: boolean }[] } | null; notes: string[] }
export async function runGeoLoad(input: { endpoint: any; regions: GeoRegionInput[]; durationSec?: number; sla?: { p95Ms?: number; p99Ms?: number; maxErrorRatePct?: number; minThroughputRps?: number }; allowWrites?: boolean }): Promise<GeoLoadResult> {
  const { data } = await api.post('/api-automation/loadtest/geo', input, { timeout: 180_000 });
  return data;
}

/* ── 9. Test-level collaboration + versioning ── */
export interface ApiTestComment { id: string; testKey: string; author: string; body: string; createdAt: string }
export interface ApiTestVersion { id: string; testKey: string; versionNo: number; label: string; snapshot: any; author: string; createdAt: string }
export interface ApiFieldDiff { field: string; change: 'added' | 'removed' | 'changed'; before?: string; after?: string }
export async function listApiComments(testKey: string): Promise<{ comments: ApiTestComment[] }> { const { data } = await api.get('/api-automation/collab/comments', { params: { testKey } }); return data; }
export async function addApiComment(testKey: string, body: string): Promise<{ comment: ApiTestComment }> { const { data } = await api.post('/api-automation/collab/comments', { testKey, body }); return data; }
export async function deleteApiComment(id: string): Promise<{ ok: boolean }> { const { data } = await api.delete(`/api-automation/collab/comments/${encodeURIComponent(id)}`); return data; }
export async function listApiVersions(testKey: string): Promise<{ versions: ApiTestVersion[] }> { const { data } = await api.get('/api-automation/collab/versions', { params: { testKey } }); return data; }
export async function saveApiVersion(input: { testKey: string; label?: string; snapshot: any }): Promise<{ version: ApiTestVersion }> { const { data } = await api.post('/api-automation/collab/versions', input); return data; }
export async function deleteApiVersion(id: string): Promise<{ ok: boolean }> { const { data } = await api.delete(`/api-automation/collab/versions/${encodeURIComponent(id)}`); return data; }
export async function getApiVersionDiff(from: string, to: string): Promise<{ from: ApiTestVersion; to: ApiTestVersion; diff: ApiFieldDiff[] }> { const { data } = await api.get('/api-automation/collab/versions/diff', { params: { from, to } }); return data; }

/* ── 10. Browser-extension recorder source ── */
export interface RecorderExtensionFile { path: string; content: string; contentType: string }
export async function getRecorderExtension(): Promise<{ files: RecorderExtensionFile[] }> { const { data } = await api.get('/api-automation/capture/recorder-extension'); return data; }

/* ═══════════════════════════════════════════════════════════════
   Enterprise batch (Tier 1–3) — all additive, opt-in API clients.
   ═══════════════════════════════════════════════════════════════ */

/* ── T1. Stateful service virtualization (data-plane: /vs/:token) ── */
export type VirtualFault = 'none' | 'abort' | 'malformed' | 'server-500' | 'timeout';
export interface VirtualMatch { method?: string; pathPattern?: string; bodyContains?: string; header?: { name: string; value: string }; query?: { name: string; value: string }; stateEquals?: { key: string; value: string } }
export interface VirtualRespond { status: number; headers?: { key: string; value: string }[]; body?: string; delayMs?: number; fault?: VirtualFault }
export interface VirtualRule { id?: string; name?: string; when: VirtualMatch; respond: VirtualRespond; setState?: Record<string, string> }
export interface VirtualService { id: string; token: string; name: string; enabled: boolean; rules: VirtualRule[]; state: Record<string, string>; hitCount: number; createdBy: string; createdAt: string; updatedAt: string }
export async function listVirtualServices(): Promise<{ services: VirtualService[] }> { const { data } = await api.get('/api-automation/virtual-services'); return data; }
export async function createVirtualService(input: { name?: string; rules?: VirtualRule[] }): Promise<{ service: VirtualService }> { const { data } = await api.post('/api-automation/virtual-services', input); return data; }
export async function updateVirtualService(id: string, patch: { name?: string; rules?: VirtualRule[]; enabled?: boolean; resetState?: boolean }): Promise<{ service: VirtualService }> { const { data } = await api.put(`/api-automation/virtual-services/${encodeURIComponent(id)}`, patch); return data; }
export async function deleteVirtualService(id: string): Promise<{ ok: boolean }> { const { data } = await api.delete(`/api-automation/virtual-services/${encodeURIComponent(id)}`); return data; }

/* ── T2. Consumer-driven contracts (Pact broker) ── */
export interface StoredPact { id: string; consumer: string; provider: string; version: string; branch: string; interactionCount: number; createdAt: string; lastVerification?: { success: boolean; providerVersion: string; at: string } }
export interface PactVerification { id: string; pactId: string; providerVersion: string; success: boolean; results: { description: string; expected: number; actual?: number; ok: boolean; error?: string }[]; createdAt: string }
export interface CanIDeployResult { deployable: boolean; pacticipant: string; version: string; environment: string; reasons: string[]; pairs: { consumer: string; provider: string; verified: boolean; detail: string }[] }
export async function listPacts(): Promise<{ pacts: StoredPact[] }> { const { data } = await api.get('/api-automation/pacts'); return data; }
export async function publishPact(input: { consumer?: string; provider?: string; version?: string; branch?: string; contract: any }): Promise<{ pact: StoredPact }> { const { data } = await api.post('/api-automation/pacts', input); return data; }
export async function deletePact(id: string): Promise<{ ok: boolean }> { const { data } = await api.delete(`/api-automation/pacts/${encodeURIComponent(id)}`); return data; }
export async function verifyPact(id: string, providerBaseUrl: string, providerVersion?: string): Promise<{ verification: PactVerification }> { const { data } = await api.post(`/api-automation/pacts/${encodeURIComponent(id)}/verify`, { providerBaseUrl, providerVersion }, { timeout: 120_000 }); return data; }
export async function recordPactDeployment(input: { pacticipant: string; version: string; environment: string }): Promise<{ ok: boolean }> { const { data } = await api.post('/api-automation/pacts/deployments', input); return data; }
export async function canIDeploy(pacticipant: string, version: string, environment: string): Promise<CanIDeployResult> { const { data } = await api.get('/api-automation/pacts/can-i-deploy', { params: { pacticipant, version, environment } }); return data; }

/* ── T3. Chaos / resilience probe ── */
export interface ChaosExperiment { name: string; description: string; status?: number; elapsedMs: number; outcome: 'resilient' | 'fragile' | 'skipped'; detail: string }
export interface ChaosReport { url: string; method: string; experiments: ChaosExperiment[]; burst: { requests: number; concurrency: number; completed: number; serverErrors: number; failures: number; avgMs: number; outcome: 'resilient' | 'fragile' }; resilienceScore: number; grade: 'A' | 'B' | 'C' | 'D' | 'F'; summary: { resilient: number; fragile: number; skipped: number } }
export async function runChaosProbe(input: { endpoint: any; requests?: number; concurrency?: number; allowWrites?: boolean; timeoutMs?: number }): Promise<ChaosReport> { const { data } = await api.post('/api-automation/chaos/probe', input, { timeout: 120_000 }); return data; }

/* ── T4. OAuth2 token helper + external secret managers ── */
export interface OAuthToken { accessToken: string; tokenType: string; expiresIn?: number; refreshToken?: string; scope?: string; raw: Record<string, unknown> }
export interface OAuthConfigView { id: string; name: string; grant: string; tokenUrl: string; clientId: string; scope: string; hasSecret: boolean; createdAt: string }
export interface SecretResult { ok: boolean; valueMasked?: string; value?: string; error?: string }
export async function fetchOAuthToken(input: any): Promise<OAuthToken> { const { data } = await api.post('/api-automation/oauth/token', input, { timeout: 60_000 }); return data; }
export async function listOAuthConfigs(): Promise<{ configs: OAuthConfigView[] }> { const { data } = await api.get('/api-automation/oauth/configs'); return data; }
export async function saveOAuthConfig(input: any): Promise<{ config: OAuthConfigView }> { const { data } = await api.post('/api-automation/oauth/configs', input); return data; }
export async function deleteOAuthConfig(id: string): Promise<{ ok: boolean }> { const { data } = await api.delete(`/api-automation/oauth/configs/${encodeURIComponent(id)}`); return data; }
export async function fetchOAuthTokenFromConfig(id: string): Promise<OAuthToken> { const { data } = await api.post(`/api-automation/oauth/configs/${encodeURIComponent(id)}/token`, {}, { timeout: 60_000 }); return data; }
export async function resolveSecret(input: any): Promise<SecretResult> { const { data } = await api.post('/api-automation/secrets/resolve', input, { timeout: 60_000 }); return data; }

/* ── T5. Database validation (read-only SELECT assertions) ── */
export interface DbConnection { id: string; name: string; dialect: 'mssql' | 'postgres' | 'mysql'; host: string; database: string; user: string; hasPassword: boolean; createdAt: string }
export interface DbValidateResult { rowCount: number; rows: Record<string, unknown>[]; checks: { name: string; pass: boolean; detail: string }[]; passed: boolean; elapsedMs: number }
export async function listDbConnections(): Promise<{ connections: DbConnection[] }> { const { data } = await api.get('/api-automation/db/connections'); return data; }
export async function saveDbConnection(input: any): Promise<{ connection: DbConnection }> { const { data } = await api.post('/api-automation/db/connections', input); return data; }
export async function deleteDbConnection(id: string): Promise<{ ok: boolean }> { const { data } = await api.delete(`/api-automation/db/connections/${encodeURIComponent(id)}`); return data; }
export async function runDbValidation(input: { connectionId?: string; config?: any; query: string; expect?: { minRows?: number; maxRows?: number; column?: string; equals?: string } }): Promise<DbValidateResult> { const { data } = await api.post('/api-automation/db/validate', input, { timeout: 60_000 }); return data; }

/* ── T6. AsyncAPI (event-driven) contracts ── */
export interface AsyncChannel { name: string; operations: string[]; messageNames: string[]; hasSchema: boolean }
export interface AsyncApiSummary { title: string; version: string; asyncapi: string; channels: AsyncChannel[] }
export interface AsyncValidateResult { valid: boolean; channel: string; errors: { path: string; message: string }[]; schemaFound: boolean }
export async function summarizeAsyncApi(text: string): Promise<AsyncApiSummary> { const { data } = await api.post('/api-automation/asyncapi/summary', { text }); return data; }
export async function validateAsyncMessage(text: string, channel: string, payload: any): Promise<AsyncValidateResult> { const { data } = await api.post('/api-automation/asyncapi/validate', { text, channel, payload }); return data; }

/* ── T7. Distributed-trace correlation probe ── */
export interface TraceSpan { name: string; service: string; durationMs: number; error?: boolean }
export interface TraceResult { traceId: string; correlationId: string; request: { status?: number; elapsedMs: number; error?: string }; backend?: string; spans: TraceSpan[]; spanCount: number; assertions: { name: string; pass: boolean; detail?: string }[]; note?: string }
export async function runTraceProbe(input: { endpoint: any; tracing?: { type: 'jaeger' | 'zipkin' | 'tempo'; queryUrl: string }; expectSpans?: string[]; minSpans?: number; waitMs?: number }): Promise<TraceResult> { const { data } = await api.post('/api-automation/trace/probe', input, { timeout: 60_000 }); return data; }

/* ── T8. Test intelligence: flaky detection, quarantine, change-impact ── */
export interface FlakyTest { name: string; appearances: number; passed: number; failed: number; flips: number; flakiness: number; lastStatuses: string[] }
export interface FlakyReport { runsAnalyzed: number; totalTests: number; flaky: FlakyTest[]; summary: { flaky: number; stable: number } }
export interface QuarantineItem { id: string; testKey: string; reason: string; createdBy: string; createdAt: string }
export interface ImpactResult { changedSignatures: string[]; impacted: { id?: string; title?: string; method: string; url: string; signature: string }[]; notImpacted: number; summary: { candidates: number; impacted: number; selectedPct: number } }
export async function detectFlakyTests(runLimit?: number): Promise<FlakyReport> { const { data } = await api.get('/api-automation/testintel/flaky', { params: { runLimit } }); return data; }
export async function listQuarantine(): Promise<{ items: QuarantineItem[] }> { const { data } = await api.get('/api-automation/testintel/quarantine'); return data; }
export async function addQuarantine(testKey: string, reason?: string): Promise<{ item: QuarantineItem }> { const { data } = await api.post('/api-automation/testintel/quarantine', { testKey, reason }); return data; }
export async function removeQuarantine(id: string): Promise<{ ok: boolean }> { const { data } = await api.delete(`/api-automation/testintel/quarantine/${encodeURIComponent(id)}`); return data; }
export async function analyzeImpact(input: { changed: { method?: string; url: string }[]; candidates: { id?: string; title?: string; method: string; url: string }[] }): Promise<ImpactResult> { const { data } = await api.post('/api-automation/testintel/impact', input); return data; }

/* ── T9. gRPC server-streaming + reflection ── */
export interface GrpcStreamResult { ok: boolean; service: string; method: string; messages: unknown[]; count: number; truncated: boolean; error?: string; code?: number | string; elapsedMs: number }
export interface GrpcReflectResult { ok: boolean; services: string[]; error?: string }
export async function grpcServerStream(input: any): Promise<GrpcStreamResult> { const { data } = await api.post('/api-automation/messaging/grpc-stream', input, { timeout: 90_000 }); return data; }
export async function grpcReflect(input: { target: string; tls?: boolean }): Promise<GrpcReflectResult> { const { data } = await api.post('/api-automation/messaging/grpc-reflect', input, { timeout: 60_000 }); return data; }

/* ── T10. Distributed cloud load (remote agents) ── */
export interface LoadAgent { id: string; name: string; url: string; region: string; enabled: boolean; createdAt: string }
interface CloudLatency { min: number; p50: number; p90: number; p95: number; p99: number; max: number; avg: number }
export interface CloudNodeResult { node: string; region: string; remote: boolean; completed: number; failed: number; non2xx: number; throughputRps: number; latency: CloudLatency; error?: string }
export interface CloudLoadResult { url: string; method: string; durationMs: number; nodes: CloudNodeResult[]; totals: { completed: number; failed: number; non2xx: number; throughputRps: number; errorRatePct: number; latency: CloudLatency }; sla: { pass: boolean; checks: { name: string; limit: number; actual: number; unit: string; pass: boolean }[] } | null; note: string }
export async function listLoadAgents(): Promise<{ agents: LoadAgent[] }> { const { data } = await api.get('/api-automation/load-agents'); return data; }
export async function saveLoadAgent(input: { id?: string; name?: string; url: string; region?: string; enabled?: boolean }): Promise<{ agent: LoadAgent }> { const { data } = await api.post('/api-automation/load-agents', input); return data; }
export async function deleteLoadAgent(id: string): Promise<{ ok: boolean }> { const { data } = await api.delete(`/api-automation/load-agents/${encodeURIComponent(id)}`); return data; }
export async function runCloudLoad(input: { endpoint: any; durationSec?: number; concurrencyPerAgent?: number; allowWrites?: boolean; sla?: { p95Ms?: number; maxErrorRatePct?: number; minThroughputRps?: number } }): Promise<CloudLoadResult> { const { data } = await api.post('/api-automation/loadtest/cloud', input, { timeout: 200_000 }); return data; }

/* ── T11. Access control: RBAC + SSO(OIDC) + SCIM ── */
export interface PermissionDef { key: string; label: string; group: string }
export interface AccessPermissions { catalog: PermissionDef[]; roles: Record<string, string[]> }
export interface SsoConfigView { type: 'oidc' | 'saml' | 'none'; enabled: boolean; issuer: string; clientId: string; hasSecret: boolean; samlEntryPoint: string; defaultRole: string }
export interface ScimTokenView { hasToken: boolean; token?: string; baseUrl: string }
export async function getAccessPermissions(): Promise<AccessPermissions> { const { data } = await api.get('/api-automation/access/permissions'); return data; }
export async function setRolePermissions(role: string, permissions: string[]): Promise<{ roles: Record<string, string[]> }> { const { data } = await api.put('/api-automation/access/permissions', { role, permissions }); return data; }
export async function getSsoConfig(): Promise<SsoConfigView> { const { data } = await api.get('/api-automation/access/sso'); return data; }
export async function saveSsoConfig(input: any): Promise<SsoConfigView> { const { data } = await api.put('/api-automation/access/sso', input); return data; }
export async function testOidcDiscovery(issuer: string): Promise<{ ok: boolean; authorizationEndpoint?: string; tokenEndpoint?: string; userinfoEndpoint?: string; error?: string }> { const { data } = await api.post('/api-automation/access/sso/test', { issuer }, { timeout: 30_000 }); return data; }
export async function getScimToken(): Promise<ScimTokenView> { const { data } = await api.get('/api-automation/access/scim'); return data; }
export async function rotateScimToken(): Promise<{ token: string }> { const { data } = await api.post('/api-automation/access/scim/rotate', {}); return data; }
export async function revokeScimToken(): Promise<{ ok: boolean }> { const { data } = await api.delete('/api-automation/access/scim'); return data; }

/* ── T12. Autonomous remediation PRs (GitHub/GitLab) ── */
export interface RemediationResult { url: string; branch: string; provider: string; filesCommitted: number }
export async function openRemediationPr(input: { provider: 'github' | 'gitlab'; token: string; repo: string; baseBranch?: string; branch?: string; title: string; body?: string; files: { path: string; content: string }[]; host?: string }): Promise<RemediationResult> { const { data } = await api.post('/api-automation/remediation/pr', input, { timeout: 90_000 }); return data; }

/* ── T13. Compliance vertical packs (PCI/HIPAA/GDPR/PSD2) ── */
export type ComplianceControlStatus = 'pass' | 'warn' | 'fail' | 'review' | 'not_assessed';
export interface ComplianceControl { id: string; title: string; status: ComplianceControlStatus; assessment: 'static' | 'supplied' | 'manual'; finding: string; remediation: string }
export interface CompliancePack { pack: string; packLabel: string; controls: ComplianceControl[]; score: number; grade: 'A' | 'B' | 'C' | 'D' | 'F'; summary: Record<ComplianceControlStatus, number> }
export async function listCompliancePacks(): Promise<{ packs: { id: string; label: string }[] }> { const { data } = await api.get('/api-automation/compliance/packs'); return data; }
export async function runCompliancePack(pack: string, endpoints: any[], security?: { transportSecure?: boolean; headersSecure?: boolean }): Promise<CompliancePack> { const { data } = await api.post('/api-automation/compliance/scan', { pack, endpoints, security }); return data; }

/* ── T14. Git-synced test-as-code ── */
export interface GitSyncConfigView { provider: 'github' | 'gitlab' | 'none'; repo: string; branch: string; path: string; host: string; hasToken: boolean }
export async function getGitSyncConfig(): Promise<GitSyncConfigView> { const { data } = await api.get('/api-automation/git-sync/config'); return data; }
export async function saveGitSyncConfig(input: any): Promise<GitSyncConfigView> { const { data } = await api.put('/api-automation/git-sync/config', input); return data; }
export async function pushToGit(content: string): Promise<{ url: string; path: string; branch: string; commit?: string }> { const { data } = await api.post('/api-automation/git-sync/push', { content }, { timeout: 60_000 }); return data; }
export async function pullFromGit(): Promise<{ content: string; path: string; branch: string }> { const { data } = await api.post('/api-automation/git-sync/pull', {}, { timeout: 60_000 }); return data; }

/* ═══════════════════════════════════════════════════════════════
   Testsigma-gap batch — rich requests, flow control, data profiles,
   AI coworker, identity hardening. All additive, opt-in.
   ═══════════════════════════════════════════════════════════════ */

/* ── G1. Interactive request send (rich bodies + OAuth2) ── */
export interface SendRequestResult { ok: boolean; status?: number; headers: Record<string, string>; bodyText: string; elapsedMs: number; error?: string }
export async function sendApiRequest(input: { method: string; url: string; headers?: { key: string; value: string }[]; auth?: ApiHttpAuth; body?: string; bodyMode?: string; formFields?: ApiFormField[]; bodyBase64?: string; bodyContentType?: string }): Promise<SendRequestResult> {
  const { data } = await api.post('/api-automation/request/send', input, { timeout: 30_000 });
  return data;
}

/* ── G2. Reusable step groups (flows reference them via groupId) ── */
export interface ApiStepGroup { id: string; name: string; steps: FlowStep[]; createdBy: string; createdAt: string; updatedAt: string }
export async function listStepGroups(): Promise<{ groups: ApiStepGroup[] }> { const { data } = await api.get('/api-automation/step-groups'); return data; }
export async function saveStepGroup(input: { id?: string; name: string; steps: FlowStep[] }): Promise<{ group: ApiStepGroup }> { const { data } = await api.post('/api-automation/step-groups', input); return data; }
export async function deleteStepGroup(id: string): Promise<{ ok: boolean }> { const { data } = await api.delete(`/api-automation/step-groups/${encodeURIComponent(id)}`); return data; }

/* ── G3. Reusable test-data profiles ── */
export interface DataProfile { id: string; name: string; columns: string[]; rows: Record<string, string>[]; rowCount: number; source: string; createdBy: string; createdAt: string; updatedAt: string }
export interface ProfileFlowRunResult { total: number; passed: number; failed: number; runs: { row: number; passed: boolean; stepsRun: number; stepsTotal: number; durationMs: number; firstError?: string }[] }
export async function listDataProfiles(): Promise<{ profiles: DataProfile[] }> { const { data } = await api.get('/api-automation/data-profiles'); return data; }
export async function saveDataProfile(input: { id?: string; name: string; columns: string[]; rows: Record<string, string>[]; source?: string }): Promise<{ profile: DataProfile }> { const { data } = await api.post('/api-automation/data-profiles', input); return data; }
export async function deleteDataProfile(id: string): Promise<{ ok: boolean }> { const { data } = await api.delete(`/api-automation/data-profiles/${encodeURIComponent(id)}`); return data; }
export async function importProfileCsv(text: string): Promise<{ columns: string[]; rows: Record<string, string>[] }> { const { data } = await api.post('/api-automation/data-profiles/import/csv', { text }); return data; }
export async function importProfileExcel(base64: string): Promise<{ columns: string[]; rows: Record<string, string>[] }> { const { data } = await api.post('/api-automation/data-profiles/import/excel', { base64 }); return data; }
export async function profileFromDb(input: { connectionId?: string; config?: any; query: string }): Promise<{ columns: string[]; rows: Record<string, string>[] }> { const { data } = await api.post('/api-automation/data-profiles/from-db', input, { timeout: 60_000 }); return data; }
export async function importProfileGoogleSheet(url: string): Promise<{ columns: string[]; rows: Record<string, string>[] }> { const { data } = await api.post('/api-automation/data-profiles/from-gsheet', { url }, { timeout: 60_000 }); return data; }
export async function runProfileOverFlow(input: { steps: FlowStep[]; rows: Record<string, string>[]; allowWrites?: boolean; maxRows?: number; rowStart?: number; rowEnd?: number }): Promise<ProfileFlowRunResult> { const { data } = await api.post('/api-automation/data-profiles/run-flow', input, { timeout: 200_000 }); return data; }

/* ── G4. AI coworker / orchestrator ── */
export interface OrchestrateResult { reply: string; intent: string; plan?: { action: string; params?: Record<string, unknown> }; data?: any }
export interface OrchestratorConfigView { enabled: boolean; triggers: string[]; action: string; hasToken: boolean; token?: string; eventPath: string }
export interface OrchestratorEvent { id: string; source: string; type: string; summary: string; status: string; createdAt: string }
export async function orchestrate(input: { message: string; endpoints?: any[]; changed?: { method?: string; url: string }[]; history?: { role: 'user' | 'assistant'; content: string }[] }): Promise<OrchestrateResult> { const { data } = await api.post('/api-automation/orchestrator/chat', input, { timeout: 120_000 }); return data; }
export async function getOrchestratorConfig(): Promise<OrchestratorConfigView> { const { data } = await api.get('/api-automation/orchestrator/config'); return data; }
export async function saveOrchestratorConfig(input: { enabled?: boolean; triggers?: string[]; action?: string }): Promise<OrchestratorConfigView> { const { data } = await api.put('/api-automation/orchestrator/config', input); return data; }
export async function rotateOrchestratorToken(): Promise<{ token: string }> { const { data } = await api.post('/api-automation/orchestrator/token', {}); return data; }
export async function listOrchestratorEvents(): Promise<{ events: OrchestratorEvent[] }> { const { data } = await api.get('/api-automation/orchestrator/events'); return data; }

/* ── Atto coworker lifecycle tools (all additive, opt-in) ── */

/** A ready-to-apply strategy brief (same shape the NL author produces). */
export interface AttoBrief { requirements: string; coverage: 'essential' | 'standard' | 'exhaustive'; layers: string[]; focus: string[]; outline: string[] }

// Story-driven generation
export interface AcceptanceCriterion { id: string; text: string; endpoints: string[]; testIdeas: string[]; kind: 'happy-path' | 'negative' | 'auth' | 'validation' | 'edge' | 'other' }
export interface StoryGenResult { title: string; summary: string; criteria: AcceptanceCriterion[]; brief: AttoBrief; unmappedCriteria: number }
export async function generateFromStory(input: { story: string; endpoints: any[] }): Promise<StoryGenResult> { const { data } = await api.post('/api-automation/story/generate', input, { timeout: 180_000 }); return data; }

// Multimodal inputs
export interface DetectedFlow { name: string; steps: string[] }
export interface DetectedField { name: string; constraint: string }
export interface MultimodalResult { observations: string[]; flows: DetectedFlow[]; fields: DetectedField[]; mappedEndpoints: string[]; brief: AttoBrief }
export async function analyzeMultimodal(input: { images?: { data: string; mediaType: string }[]; figma?: string; transcript?: string; note?: string; endpoints: any[] }): Promise<MultimodalResult> { const { data } = await api.post('/api-automation/multimodal/analyze', input, { timeout: 180_000 }); return data; }

// Suite optimizer
export interface PrioritizedEndpoint { id?: string; title?: string; method: string; url: string; signature: string; score: number; priority: 'critical' | 'high' | 'medium' | 'low'; reasons: string[]; failRate: number; appearances: number; traffic: number; quarantined: boolean }
export interface RedundancyCluster { signature: string; endpoints: { id?: string; title?: string; method: string; url: string }[] }
export interface SuiteOptimizerResult { runsAnalyzed: number; prioritized: PrioritizedEndpoint[]; redundancies: RedundancyCluster[]; summary: { endpoints: number; redundantGroups: number; prunable: number; critical: number; high: number } }
export async function optimizeSuite(input: { endpoints: any[]; runLimit?: number }): Promise<SuiteOptimizerResult> { const { data } = await api.post('/api-automation/suite/optimize', input, { timeout: 120_000 }); return data; }

// Semantic self-healing
export interface HealProposal { endpointId?: string; title: string; method: string; url: string; classification: 'regression' | 'contract-evolution' | 'flaky' | 'environment' | 'auth' | 'unknown'; confidence: 'high' | 'medium' | 'low'; shouldHeal: boolean; summary: string; rationale: string; observed?: { status?: number; reachable: boolean; bodySnippet?: string }; patch?: { expectedStatus?: number; expectedResponse?: string }; note?: string }
export interface HealResult { proposals: HealProposal[]; summary: { analyzed: number; healable: number; regressions: number; flaky: number; skipped: number } }
export async function proposeHeal(input: { failures: any[]; allowWrites?: boolean }): Promise<HealResult> { const { data } = await api.post('/api-automation/heal/propose', input, { timeout: 180_000 }); return data; }

// History-/flow-aware change impact
export interface ImpactedFlow { id: string; name: string; matchedSignatures: string[]; endpoints: { method: string; url: string; signature: string }[] }
export interface ImpactedEndpoint { id?: string; title?: string; method: string; url: string; signature: string; via: ('structural' | 'flow')[]; viaFlows: string[]; failRate: number; appearances: number; priorityScore: number }
export interface DeepImpactResult { changedSignatures: string[]; impacted: ImpactedEndpoint[]; flows: ImpactedFlow[]; summary: { candidates: number; structural: number; withFlows: number; total: number; selectedPct: number } }
export async function analyzeImpactDeep(input: { changed: { method?: string; url: string }[]; endpoints?: any[]; candidates?: any[] }): Promise<DeepImpactResult> { const { data } = await api.post('/api-automation/impact/deep', input); return data; }

// Auto bug-report artifact
export interface BugReport { title: string; severity: 'critical' | 'high' | 'medium' | 'low'; labels: string[]; markdown: string; jira: { summary: string; description: string; issuetype: string; priority: string; labels: string[] }; github: { title: string; body: string; labels: string[] }; diagnosis?: { category: string; rootCause: string; suggestedFix: string; confidence: string; reproCurl: string }; reproCurl: string }
export async function buildBugReport(input: { title?: string; method: string; url: string; error?: string; expectedStatus?: number; expectedResponse?: string; responseStatus?: number; requestBody?: string; responseBody?: string; requestHeaders?: { key: string; value: string }[]; responseHeaders?: { key: string; value: string }[]; environment?: string; runId?: string; reportUrl?: string }): Promise<BugReport> { const { data } = await api.post('/api-automation/bug-report', input, { timeout: 120_000 }); return data; }

// Always-on monitoring loop
export interface MonitorConfigView { enabled: boolean; intervalMinutes: number; checks: ('health' | 'drift' | 'coverage')[]; endpointCount: number; nextRunAt?: string; lastRunAt?: string; lastStatus?: string; lastSummary?: string }
export interface MonitorEvent { id: string; checkKind: string; severity: 'info' | 'warning' | 'critical'; title: string; detail: string; signature?: string; createdAt: string }
export async function getMonitorConfig(): Promise<MonitorConfigView> { const { data } = await api.get('/api-automation/monitor/config'); return data; }
export async function saveMonitorConfig(input: { enabled?: boolean; intervalMinutes?: number; endpoints?: any[]; checks?: string[] }): Promise<MonitorConfigView> { const { data } = await api.put('/api-automation/monitor/config', input); return data; }
export async function listMonitorEvents(limit = 100): Promise<{ events: MonitorEvent[] }> { const { data } = await api.get('/api-automation/monitor/events', { params: { limit } }); return data; }
export async function runMonitorNow(): Promise<MonitorConfigView> { const { data } = await api.post('/api-automation/monitor/run', {}, { timeout: 180_000 }); return data; }

/* ── G5. Identity hardening — security settings + MFA enrolment ── */
export interface ApiPasswordPolicy { minLength: number; requireUpper: boolean; requireNumber: boolean; requireSymbol: boolean }
export interface ApiSecuritySettings { ssoEnforced: boolean; mfaRequired: boolean; passwordPolicy: ApiPasswordPolicy }
export async function getSecuritySettings(): Promise<ApiSecuritySettings> { const { data } = await api.get('/api-automation/access/security'); return data; }
export async function saveSecuritySettings(input: Partial<ApiSecuritySettings>): Promise<ApiSecuritySettings> { const { data } = await api.put('/api-automation/access/security', input); return data; }
export async function getMfaStatus(): Promise<{ enrolled: boolean }> { const { data } = await api.get('/api-automation/access/mfa/status'); return data; }
export async function beginMfaEnrollment(): Promise<{ secret: string; otpauthUrl: string }> { const { data } = await api.post('/api-automation/access/mfa/begin', {}); return data; }
export async function confirmMfaEnrollment(secret: string, code: string): Promise<{ ok: boolean; enrolled: boolean }> { const { data } = await api.post('/api-automation/access/mfa/confirm', { secret, code }); return data; }
export async function disableMfa(): Promise<{ ok: boolean }> { const { data } = await api.post('/api-automation/access/mfa/disable', {}); return data; }

/* ─────────────────────────────────────────────────────────────
   Execution/CI batch — hybrid API+UI, release gate, CI trigger, parallel queue
   (all additive, opt-in; never touched by the core pipeline)
   ───────────────────────────────────────────────────────────── */

// Feature A — API + UI hybrid test (seed via API → verify in a browser → cleanup via API)
export type UiCheckKind = 'textPresent' | 'textAbsent' | 'selectorPresent' | 'selectorCount' | 'titleContains' | 'urlContains';
export interface UiCheck { kind: UiCheckKind; selector?: string; text?: string; count?: number }
export interface HybridUi { url: string; engine?: 'chromium' | 'firefox' | 'webkit'; waitUntil?: 'load' | 'domcontentloaded' | 'networkidle' | 'commit'; checks: UiCheck[] }
export interface HybridTest { id: string; name: string; seed: FlowStep[]; ui: HybridUi; cleanup: FlowStep[]; createdBy: string; createdAt: string; updatedAt: string }
export interface HybridUiResult { reached: boolean; checks: { label: string; pass: boolean; detail?: string }[]; screenshotBase64?: string; title?: string; finalUrl?: string; error?: string }
export interface HybridRunResult { passed: boolean; durationMs: number; seed: FlowRunResult; ui: HybridUiResult; cleanup: FlowRunResult; variables: Record<string, string> }
export async function listHybridTests(): Promise<HybridTest[]> { const { data } = await api.get('/api-automation/hybrid'); return data.tests || []; }
export async function saveHybridTest(input: Partial<HybridTest>): Promise<HybridTest> { const { data } = await api.post('/api-automation/hybrid', input); return data.test; }
export async function deleteHybridTest(id: string): Promise<void> { await api.delete(`/api-automation/hybrid/${encodeURIComponent(id)}`); }
export async function runHybridTest(input: { seed?: FlowStep[]; ui: HybridUi; cleanup?: FlowStep[]; variables?: Record<string, string>; allowWrites?: boolean }): Promise<HybridRunResult> { const { data } = await api.post('/api-automation/hybrid/run', input, { timeout: 120_000 }); return data; }

// Feature B — Agentic release gate (score a finished run → go / no-go)
export interface GatePolicy { id: string; name: string; minPassRate: number; maxFailed: number; maxBroken: number; minConfidence: number; requireNoNewFailures: boolean; blockOnHighSeverityFail: boolean; createdBy: string; createdAt: string; updatedAt: string }
export interface GateCheck { label: string; pass: boolean; actual: number | string; threshold: number | string }
export interface GateResult { decision: 'go' | 'no-go'; score: number; runId: string; title: string; stats: { total: number; passed: number; failed: number; broken: number; passRate: number } | null; checks: GateCheck[]; reasons: string[]; anomalies: { flaky: number; slow: number; newFailure: number } }
export async function listGatePolicies(): Promise<GatePolicy[]> { const { data } = await api.get('/api-automation/release-gates'); return data.policies || []; }
export async function saveGatePolicy(input: Partial<GatePolicy>): Promise<GatePolicy> { const { data } = await api.post('/api-automation/release-gates', input); return data.policy; }
export async function deleteGatePolicy(id: string): Promise<void> { await api.delete(`/api-automation/release-gates/${encodeURIComponent(id)}`); }
export async function evaluateReleaseGate(input: { runId: string; policyId?: string; thresholds?: Partial<GatePolicy> }): Promise<GateResult> { const { data } = await api.post('/api-automation/release-gate/evaluate', input); return data; }

// Feature C — First-party CI / GitHub Action (mint the token the public /api/ci trigger uses)
export interface CiConfigView { enabled: boolean; hasToken: boolean; tokenMasked: string; triggerPath: string }
export async function getCiConfig(): Promise<CiConfigView> { const { data } = await api.get('/api-automation/ci/config'); return data; }
export async function rotateCiToken(): Promise<{ token: string }> { const { data } = await api.post('/api-automation/ci/token', {}); return data; }
export async function setCiEnabled(enabled: boolean): Promise<CiConfigView> { const { data } = await api.put('/api-automation/ci/config', { enabled }); return data; }

// Feature D — Parallel execution queue (slot model over the headless pipeline)
export type QueueStatus = 'queued' | 'running' | 'done' | 'failed' | 'canceled';
export interface QueueItem { id: string; title: string; status: QueueStatus; endpointCount: number; jobId?: string; stats?: { total: number; passed: number; failed: number; passRate: number } | null; error?: string; enqueuedAt: string; startedAt?: string; finishedAt?: string }
export interface QueueView { slots: number; running: number; queued: number; items: QueueItem[] }
export async function getExecQueue(): Promise<QueueView> { const { data } = await api.get('/api-automation/exec-queue'); return data; }
export async function saveExecQueueConfig(slots: number): Promise<{ slots: number }> { const { data } = await api.put('/api-automation/exec-queue/config', { slots }); return data; }
export async function enqueueRun(input: { title?: string; endpoints: unknown[]; coverage?: string; execute?: boolean; heal?: boolean }): Promise<QueueItem> { const { data } = await api.post('/api-automation/exec-queue/enqueue', input); return data.item; }
export async function cancelQueueItem(id: string): Promise<void> { await api.delete(`/api-automation/exec-queue/${encodeURIComponent(id)}`); }

// Feature E — Cloud browser/device lab (run the UI checks on hosted provider browsers; cross-browser matrix)
export type CloudProvider = 'browserstack' | 'lambdatest' | 'custom';
export interface CloudTarget { browser?: string; browserVersion?: string; os?: string; osVersion?: string; label?: string }
export interface CloudLabConfig { id: string; name: string; provider: CloudProvider; username: string; enabled: boolean; hasAccessKey: boolean; hasWsEndpoint: boolean; accessKeyMasked?: string; createdBy: string; createdAt: string; updatedAt: string }
export interface CloudCheckOutcome { label: string; pass: boolean; detail?: string }
export interface CloudTargetResult { label: string; target: CloudTarget; reached: boolean; passed: boolean; checks: CloudCheckOutcome[]; screenshotBase64?: string; title?: string; finalUrl?: string; durationMs: number; error?: string }
export interface CloudRunResult { passed: boolean; total: number; passedCount: number; failedCount: number; durationMs: number; url: string; provider: CloudProvider; results: CloudTargetResult[] }
export async function listCloudLabs(): Promise<CloudLabConfig[]> { const { data } = await api.get('/api-automation/cloud-labs'); return data.labs || []; }
export async function saveCloudLab(input: { id?: string; name: string; provider: CloudProvider; username?: string; accessKey?: string; wsEndpoint?: string; enabled?: boolean }): Promise<CloudLabConfig> { const { data } = await api.post('/api-automation/cloud-labs', input); return data.lab; }
export async function deleteCloudLab(id: string): Promise<void> { await api.delete(`/api-automation/cloud-labs/${encodeURIComponent(id)}`); }
export async function testCloudLab(id: string): Promise<{ ok: boolean; detail: string; label?: string }> { const { data } = await api.post(`/api-automation/cloud-labs/${encodeURIComponent(id)}/test`, {}, { timeout: 90_000 }); return data; }
export async function runCloudMatrix(input: { configId: string; url: string; name?: string; targets?: CloudTarget[]; checks?: UiCheck[]; variables?: Record<string, string>; waitUntil?: HybridUi['waitUntil'] }): Promise<CloudRunResult> { const { data } = await api.post('/api-automation/cloud-labs/run', input, { timeout: 240_000 }); return data; }

/* ─────────────────────────────────────────────────────────────
   Enterprise test management & governance (all additive, opt-in)
   ───────────────────────────────────────────────────────────── */

// Suites / Plans / Cycles + assignments + progress (items 1 & 2)
export interface TestSuite { id: string; name: string; description: string; endpoints: any[]; tags: string[]; createdBy: string; createdAt: string; updatedAt: string }
export interface PlanGate { minPassRate?: number; maxFailed?: number }
export interface TestPlan { id: string; name: string; description: string; suiteIds: string[]; environmentId?: string; coverage: 'essential' | 'standard' | 'exhaustive'; gate?: PlanGate | null; createdBy: string; createdAt: string; updatedAt: string }
export type CycleStatus = 'planned' | 'running' | 'completed' | 'failed' | 'aborted';
export interface TestCycle { id: string; planId: string; name: string; status: CycleStatus; runId?: string; jobId?: string; stats?: { total: number; passed: number; failed: number; notRun: number; passRate: number; durationMs: number } | null; error?: string; createdBy: string; createdAt: string; startedAt?: string; finishedAt?: string }
export type AssignmentStatus = 'todo' | 'in_progress' | 'blocked' | 'done';
export interface Assignment { id: string; planId: string; suiteId?: string; assignee: string; status: AssignmentStatus; notes: string; createdBy: string; createdAt: string; updatedAt: string }
export interface TenantMember { username: string; fullName: string; email: string; role: string }
export interface PlanProgress { planId: string; total: number; byStatus: Record<AssignmentStatus, number>; byAssignee: { assignee: string; total: number; done: number; byStatus: Record<AssignmentStatus, number> }[]; donePct: number }
export async function listTestSuites(): Promise<TestSuite[]> { const { data } = await api.get('/api-automation/suites'); return data.suites || []; }
export async function saveTestSuite(input: { id?: string; name: string; description?: string; endpoints?: unknown[]; tags?: string[] }): Promise<TestSuite> { const { data } = await api.post('/api-automation/suites', input); return data.suite; }
export async function deleteTestSuite(id: string): Promise<void> { await api.delete(`/api-automation/suites/${encodeURIComponent(id)}`); }
export async function listTestPlans(): Promise<TestPlan[]> { const { data } = await api.get('/api-automation/plans'); return data.plans || []; }
export async function saveTestPlan(input: { id?: string; name: string; description?: string; suiteIds?: string[]; environmentId?: string; coverage?: string; gate?: PlanGate | null }): Promise<TestPlan> { const { data } = await api.post('/api-automation/plans', input); return data.plan; }
export async function deleteTestPlan(id: string): Promise<void> { await api.delete(`/api-automation/plans/${encodeURIComponent(id)}`); }
export async function getPlanProgress(id: string): Promise<PlanProgress> { const { data } = await api.get(`/api-automation/plans/${encodeURIComponent(id)}/progress`); return data; }
export async function listTestCycles(planId?: string): Promise<TestCycle[]> { const { data } = await api.get('/api-automation/cycles', { params: planId ? { planId } : {} }); return data.cycles || []; }
export async function startTestCycle(input: { planId: string; name?: string; execute?: boolean }): Promise<TestCycle> { const { data } = await api.post('/api-automation/cycles/start', input); return data.cycle; }
export async function deleteTestCycle(id: string): Promise<void> { await api.delete(`/api-automation/cycles/${encodeURIComponent(id)}`); }
export async function listAssignments(planId?: string): Promise<Assignment[]> { const { data } = await api.get('/api-automation/assignments', { params: planId ? { planId } : {} }); return data.assignments || []; }
export async function saveAssignment(input: { id?: string; planId: string; suiteId?: string; assignee: string; status?: AssignmentStatus; notes?: string }): Promise<Assignment> { const { data } = await api.post('/api-automation/assignments', input); return data.assignment; }
export async function setAssignmentStatus(id: string, status: AssignmentStatus): Promise<Assignment> { const { data } = await api.put(`/api-automation/assignments/${encodeURIComponent(id)}/status`, { status }); return data.assignment; }
export async function deleteAssignment(id: string): Promise<void> { await api.delete(`/api-automation/assignments/${encodeURIComponent(id)}`); }
export async function listTenantMembers(): Promise<TenantMember[]> { const { data } = await api.get('/api-automation/members'); return data.members || []; }

// Requirements traceability matrix (item 3)
export interface LinkedEndpoint { method: string; url: string }
export interface DefectRef { key: string; url?: string; status?: string }
export interface Requirement { id: string; reqKey: string; title: string; description: string; priority: 'low' | 'medium' | 'high' | 'critical'; source: string; linkedEndpoints: LinkedEndpoint[]; linkedScenarios: string[]; defects: DefectRef[]; createdBy: string; createdAt: string; updatedAt: string }
export type TraceStatus = 'covered' | 'partial' | 'failing' | 'uncovered';
export interface MatrixCase { id: string; title: string; status: string }
export interface MatrixRow { requirement: { id: string; reqKey: string; title: string; priority: string }; cases: MatrixCase[]; passed: number; failed: number; notRun: number; status: TraceStatus; defects: DefectRef[] }
export interface TraceMatrix { runId: string | null; runTitle: string | null; rows: MatrixRow[]; summary: { total: number; covered: number; partial: number; failing: number; uncovered: number; coveragePct: number } }
export async function listRequirements(): Promise<Requirement[]> { const { data } = await api.get('/api-automation/requirements'); return data.requirements || []; }
export async function saveRequirement(input: Partial<Requirement> & { title: string }): Promise<Requirement> { const { data } = await api.post('/api-automation/requirements', input); return data.requirement; }
export async function deleteRequirement(id: string): Promise<void> { await api.delete(`/api-automation/requirements/${encodeURIComponent(id)}`); }
export async function getTraceMatrix(runId?: string): Promise<TraceMatrix> { const { data } = await api.get('/api-automation/traceability/matrix', { params: runId ? { runId } : {} }); return data; }

// Native TM connectors (item 4)
export type TmVendor = 'testrail' | 'xray' | 'zephyr' | 'qtest';
export interface TmConnector { id: string; vendor: TmVendor; name: string; baseUrl: string; projectKey: string; enabled: boolean; authFields: string[]; createdBy: string; createdAt: string; updatedAt: string }
export interface TmExportResult { ok: boolean; detail: string; externalRef?: string; exported: number; skipped: number }
export interface TmImportedCase { externalId: string; title: string; status?: string }
export async function listTmConnectors(): Promise<TmConnector[]> { const { data } = await api.get('/api-automation/tm-connectors'); return data.connectors || []; }
export async function saveTmConnector(input: { id?: string; vendor: TmVendor; name: string; baseUrl?: string; projectKey?: string; auth?: Record<string, string>; enabled?: boolean }): Promise<TmConnector> { const { data } = await api.post('/api-automation/tm-connectors', input); return data.connector; }
export async function deleteTmConnector(id: string): Promise<void> { await api.delete(`/api-automation/tm-connectors/${encodeURIComponent(id)}`); }
export async function testTmConnector(id: string): Promise<{ ok: boolean; detail: string }> { const { data } = await api.post(`/api-automation/tm-connectors/${encodeURIComponent(id)}/test`, {}, { timeout: 40_000 }); return data; }
export async function exportRunToTm(id: string, runId: string): Promise<TmExportResult> { const { data } = await api.post(`/api-automation/tm-connectors/${encodeURIComponent(id)}/export`, { runId }, { timeout: 90_000 }); return data; }
export async function importTmCases(id: string, limit = 100): Promise<{ ok: boolean; detail: string; cases: TmImportedCase[] }> { const { data } = await api.post(`/api-automation/tm-connectors/${encodeURIComponent(id)}/import`, { limit }, { timeout: 60_000 }); return data; }

// Audit-log viewer (item 5)
export interface AuditEntry { id: string; username: string; action: string; resourceType: string; resourceId: string; details: Record<string, unknown>; ipAddress: string; requestId: string; createdAt: string }
export interface AuditPage { items: AuditEntry[]; total: number; page: number; pageSize: number }
export interface AuditFacets { actions: string[]; resourceTypes: string[]; usernames: string[] }
export interface AuditFilters { action?: string; resourceType?: string; username?: string; from?: string; to?: string; q?: string; page?: number; pageSize?: number }
export async function listAudit(filters: AuditFilters = {}): Promise<AuditPage> { const { data } = await api.get('/api-automation/audit', { params: filters }); return data; }
export async function getAuditFacets(): Promise<AuditFacets> { const { data } = await api.get('/api-automation/audit/facets'); return data; }
export async function exportAuditCsv(filters: AuditFilters = {}): Promise<Blob> { const { data } = await api.get('/api-automation/audit/export', { params: filters, responseType: 'blob' }); return data as Blob; }

// Multi-stage approval gating (item 6)
export interface ApprovalStage { key: string; name: string; approvers: string[]; minApprovals: number }
export interface ApprovalWorkflow { id: string; name: string; stages: ApprovalStage[]; createdBy: string; createdAt: string; updatedAt: string }
export interface ApprovalDecision { stage: number; stageKey: string; approver: string; decision: 'approve' | 'reject'; note: string; at: string }
export type ApprovalRequestStatus = 'pending' | 'approved' | 'rejected' | 'canceled';
export interface ApprovalRequest { id: string; workflowId: string; workflowName: string; runId: string; title: string; status: ApprovalRequestStatus; currentStage: number; stages: ApprovalStage[]; decisions: ApprovalDecision[]; createdBy: string; createdAt: string; updatedAt: string }
export interface ApprovalGate { status: ApprovalRequestStatus | 'none'; requestId?: string; workflowName?: string; stage?: number; totalStages?: number }
export async function listApprovalWorkflows(): Promise<ApprovalWorkflow[]> { const { data } = await api.get('/api-automation/approval-workflows'); return data.workflows || []; }
export async function saveApprovalWorkflow(input: { id?: string; name: string; stages: ApprovalStage[] }): Promise<ApprovalWorkflow> { const { data } = await api.post('/api-automation/approval-workflows', input); return data.workflow; }
export async function deleteApprovalWorkflow(id: string): Promise<void> { await api.delete(`/api-automation/approval-workflows/${encodeURIComponent(id)}`); }
export async function listApprovalRequests(runId?: string): Promise<ApprovalRequest[]> { const { data } = await api.get('/api-automation/approval-requests', { params: runId ? { runId } : {} }); return data.requests || []; }
export async function createApprovalRequest(input: { workflowId: string; runId: string; title?: string }): Promise<ApprovalRequest> { const { data } = await api.post('/api-automation/approval-requests', input); return data.request; }
export async function actOnApprovalRequest(input: { requestId: string; decision: 'approve' | 'reject'; note?: string }): Promise<ApprovalRequest> { const { data } = await api.post('/api-automation/approval-requests/act', input); return data.request; }
export async function cancelApprovalRequest(id: string): Promise<ApprovalRequest> { const { data } = await api.post(`/api-automation/approval-requests/${encodeURIComponent(id)}/cancel`, {}); return data.request; }
export async function getApprovalGate(runId: string): Promise<ApprovalGate> { const { data } = await api.get(`/api-automation/approval-gate/${encodeURIComponent(runId)}`); return data; }

// Compliance-evidence export (item 7)
export interface EvidenceDoc { generatedAt: string; run: { runId: string; title: string; createdAt: string; createdBy: string; reportUrl?: string; caseCount: number; stats: { total: number; passed: number; failed: number; broken: number; passRate: number; durationMs: number } | null }; compliance: { pack: string; label: string; grade: string; score: number; summary: Record<string, number> }[]; failures: { id: string; title: string; error?: string }[]; signoff: { status: string | null; count: number; latest?: { decision: string; reviewer?: string; note?: string; at: string } }; approval: ApprovalGate }
export async function previewEvidence(runId: string, standards?: string[]): Promise<EvidenceDoc> { const { data } = await api.post('/api-automation/evidence/preview', { runId, standards }); return data; }
export async function exportEvidence(runId: string, opts: { standards?: string[]; format?: 'pdf' | 'html' } = {}): Promise<Blob> { const { data } = await api.post('/api-automation/evidence/export', { runId, standards: opts.standards, format: opts.format }, { responseType: 'blob', timeout: 90_000 }); return data as Blob; }

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
    /** Optional free-form guidance that steers what the explore agent focuses on. */
    explorePrompt?: string;
    /** Optional credentials so the explore agent can log in. */
    roles?: { roleName?: string; username: string; password: string }[];
    /** The specific Application Setup entry (`app-<slug>` integrationId) these
     *  requirements target. Required whenever the tenant has more than one
     *  application configured, so generation is grounded in the right one. */
    appId?: string;
    /** API Automation — the structured endpoint from the chat API form. When
     *  present the backend generates real HTTP test cases + Playwright request
     *  specs and needs no configured browser application. */
    apiSpec?: ApiSpecPayload;
    /** API Automation, multi-endpoint — several selected endpoints from an
     *  imported collection/spec. The backend generates a suite for each and
     *  merges them into one aggregated set of cases + specs. */
    apiSpecs?: ApiSpecPayload[];
    /** API Automation — the test layers the reviewer switched on. */
    apiLayers?: string[];
    /** API Automation — AI insights from the deep analysis, as generator context. */
    apiProfile?: { insights?: string[] } | null;
  },
) {
  const body = {
    requirements,
    testType,
    targetUrl: options?.targetUrl,
    module: options?.module,
    appName: options?.appName,
    exploreMode: options?.exploreMode,
    explorePrompt: options?.explorePrompt,
    roles: options?.roles,
    appId: options?.appId,
    apiSpec: options?.apiSpec,
    apiSpecs: options?.apiSpecs,
    apiLayers: options?.apiLayers,
    apiProfile: options?.apiProfile,
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

/** The endpoint definition the API Studio sends to every pipeline stage. */
export interface ApiSpecPayload {
  method: string;
  url: string;
  headers?: { key: string; value: string }[];
  auth?: { type: string; value?: string; headerName?: string };
  body?: string;
  expectedStatus?: number;
  expectedResponse?: string;
  /** How wide a scenario net the generator should cast. */
  coverage?: 'essential' | 'standard' | 'exhaustive';
}

/** Marks a run as API Automation and carries the endpoint's contract with it.
 *  Execution uses the endpoint's own origin as its target (the request specs
 *  carry absolute URLs, so this is just the baseURL); healing needs the spec to
 *  tell an API defect apart from a test that asserted the wrong thing. */
export interface ApiRunOptions {
  mode: 'api';
  apiSpec: ApiSpecPayload;
}

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
export async function executePipeline(testCases: any[], scripts: any[], pageObjects: any[] = [], appId?: string, testRunId?: string, target?: TargetOverride, apiRun?: ApiRunOptions) {
  const body = { testCases, scripts, pageObjects, appId, testRunId, ...targetBody(target), ...(apiRun || {}) };
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
  apiRun?: ApiRunOptions,
) {
  const body = { testCases, scripts, executionDetails, pageObjects, appId, testRunId, ...targetBody(target), ...(apiRun || {}) };
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

/**
 * Escalate a failing run to Support: sends a failure/flaky summary to every
 * notification channel the tenant has connected (Outlook email / Slack / Teams).
 * `configured:false` means no channel is set up yet.
 */
export async function reportToSupport(payload: {
  runId?: string;
  feature?: string;
  module?: string;
  total?: number;
  passed?: number;
  failed?: number;
  durationSeconds?: number;
  reportUrl?: string;
  failures?: { name?: string; error?: string }[];
  flaky?: { name?: string; error?: string }[];
}) {
  const { data } = await api.post('/pipeline-flow/report-support', payload);
  return data as {
    ok: boolean;
    configured: boolean;
    results: { channel: string; sent: boolean; error?: string }[];
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
  /** 'api' = API Automation run, 'web' = Web Application Automation run. */
  kind: 'api' | 'web';
}
export interface ReportHistoryResponse {
  items: ReportHistoryItem[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
  facets: { sources: string[]; kinds?: { all: number; api: number; web: number } };
}

export async function getReportsHistory(params: { page?: number; pageSize?: number; source?: string; type?: string; kind?: 'api' | 'web'; search?: string } = {}) {
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
  /** Filter by origin: 'manual' | 'failure' | 'flaky'. */
  type?: string;
}) {
  const { data } = await api.get('/bugs', { params: opts });
  return data;
}

/**
 * Auto-register bugs from a completed execution run. `items` classify each
 * affected test as a 'failure' (still failing) or 'flaky' (failed then healed).
 * Upserts by (testRunId, testCaseId) server-side so repeated cycles don't
 * duplicate bugs.
 */
export async function registerBugsFromRun(payload: {
  testRunId?: string;
  appName?: string;
  environment?: string;
  module?: string;
  items: {
    testCaseId: string;
    testName?: string;
    bugType: 'failure' | 'flaky';
    error?: string;
    fix?: string;
    severity?: string;
  }[];
}) {
  const { data } = await api.post('/bugs/from-run', payload);
  return data as { ok: boolean; created: number; updated: number; skipped: number; bugs: any[] };
}

/** Re-execute the tests behind flaky/failure bugs (or specific bug ids). */
export async function rerunBugs(opts: { bugType?: 'flaky' | 'failure'; ids?: string[] }) {
  const { data } = await api.post('/bugs/rerun', opts, { timeout: 30 * 60_000 });
  return data as {
    ok: boolean;
    ran: number;
    passed: number;
    failed: number;
    resolved: number;
    byRun: { testRunId: string; ran: number; passed: number; failed: number; error?: string }[];
    message?: string;
  };
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

/** Escalate the selected bug(s) to the JBS SDET team via the connected Teams channel. */
export async function raiseSdetTicket(ids: string[]) {
  const { data } = await api.post('/bugs/sdet-ticket', { ids });
  return data as { ok: boolean; notified: number };
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
