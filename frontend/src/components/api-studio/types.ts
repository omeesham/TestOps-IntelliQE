/**
 * API Automation — shared types.
 *
 * The workspace is a dashboard around one linear pipeline:
 *
 *   Import (any of 12 methods) → Understand (pattern intelligence) → Scenarios
 *   (the review gate) → Automate → Execute → Heal → Report
 *
 * Everything below describes a step of that pipeline, one of its artifacts, or
 * a piece of the dashboard built around it.
 */

/* ═══════════════════════════════════════════════════════════════
   Catalogue — the endpoints the workspace knows about
   ═══════════════════════════════════════════════════════════════ */

export type AuthType = 'none' | 'bearer' | 'basic' | 'apikey';
export type ApiStyle = 'rest' | 'graphql' | 'soap' | 'jsonrpc' | 'webhook' | 'mcp';

/** The twelve ways an API can enter the workspace. */
export type ImportMethod =
  | 'openapi' | 'postman' | 'endpoint' | 'curl' | 'docs-url' | 'connector'
  | 'sdk' | 'webhook' | 'graphql' | 'mcp' | 'middleware' | 'manual' | 'file';

export interface HeaderPair { key: string; value: string }

/**
 * One endpoint in the catalogue — the normalised shape every import method
 * produces and every pipeline stage consumes. `id` is client-side only.
 */
export interface CatalogEndpoint {
  id: string;
  title: string;
  method: string;
  url: string;
  headers: HeaderPair[];
  auth: { type: AuthType; value?: string; headerName?: string };
  body?: string;
  expectedStatus?: number;
  expectedResponse?: string;
  description?: string;
  operationId?: string;
  tags?: string[];
  resource?: string;
  pathTemplate?: string;
  pathParams?: { name: string; example?: string; required?: boolean }[];
  queryParams?: { name: string; example?: string; required?: boolean }[];
  style?: ApiStyle;
  source?: { method: ImportMethod; name: string };
  deprecated?: boolean;
  discovered?: boolean;
  /** When this endpoint landed in the catalogue (ms epoch). */
  importedAt: number;
}

/* ═══════════════════════════════════════════════════════════════
   Intelligence — what the platform understood about the API
   ═══════════════════════════════════════════════════════════════ */

export type CrudOp = 'list' | 'create' | 'read' | 'update' | 'delete';
export type StrategyLayerId = 'smoke' | 'contract' | 'schema' | 'negative' | 'auth' | 'security' | 'performance' | 'flow';

export interface ApiResource {
  name: string;
  pattern: string;
  host: string;
  endpoints: number[];
  operations: Partial<Record<CrudOp, number>> & { other: number[] };
  crudScore: number;
  idParam?: string;
  parent?: string;
}

export interface ApiFlow { id: string; name: string; resource: string; steps: number[]; description: string }
export interface ApiRisk { level: 'high' | 'medium' | 'low'; text: string; endpoints?: number[] }
export interface ApiDependency { from: number; to: number; kind: string; reason: string }
export interface StrategyLayer { id: StrategyLayerId; label: string; enabled: boolean; estimatedCases: number; rationale: string }

export interface ApiProfile {
  style: ApiStyle | 'mixed';
  styles: Record<string, number>;
  hosts: string[];
  versions: string[];
  totalEndpoints: number;
  methods: Record<string, number>;
  resources: ApiResource[];
  auth: { schemes: Record<string, number>; protected: number; public: number; mixed: boolean };
  pagination: { detected: boolean; params: string[]; endpoints: number[] };
  filtering: { params: string[] };
  contentTypes: string[];
  withExamples: number;
  dependencies: ApiDependency[];
  flows: ApiFlow[];
  risks: ApiRisk[];
  patterns: string[];
  strategy: { layers: StrategyLayer[]; recommendedCoverage: 'essential' | 'standard' | 'exhaustive'; estimatedTotal: number; rationale: string };
  summary: string;
  insights?: string[];
  analyzedAt: string;
}

/** The reviewer's choices that steer generation. */
export interface Strategy {
  coverage: 'essential' | 'standard' | 'exhaustive';
  layers: StrategyLayerId[];
}

/* ═══════════════════════════════════════════════════════════════
   Environments
   ═══════════════════════════════════════════════════════════════ */

export interface EnvVariable { key: string; value: string; secret: boolean }

export interface ApiEnvironment {
  id: string;
  name: string;
  baseUrl: string;
  variables: EnvVariable[];
  isDefault: boolean;
  createdBy?: string;
  createdAt: string;
  updatedAt: string;
}

/* ═══════════════════════════════════════════════════════════════
   The run
   ═══════════════════════════════════════════════════════════════ */

/** Where the run currently is. `review` is the gate the user must pass through. */
export type Phase =
  | 'idle'        // nothing run yet
  | 'generating'  // designing scenarios
  | 'review'      // GATE: scenarios are on screen, waiting for the user to continue
  | 'automating'  // rendering the Playwright request specs + saving the run
  | 'executing'   // running the suite
  | 'healing'     // repairing failing specs and re-running
  | 'report'      // finished — the report is on screen
  | 'failed';     // the run stopped on an error

export type StageKey = 'scenarios' | 'automate' | 'execute' | 'heal' | 'report';
export type StageStatus = 'pending' | 'running' | 'done' | 'skipped' | 'failed';

export interface Stage {
  key: StageKey;
  label: string;
  hint: string;
  status: StageStatus;
  detail: string;
  startedAt?: number;
  durationMs?: number;
}

/**
 * One row of the query-param editor. `enabled` is the Bruno/Postman checkbox: a
 * disabled row stays in the table for easy re-use but is left out of the URL.
 */
export interface QueryParamRow { key: string; value: string; enabled: boolean }

export interface TestStep { step: number; action: string; expected: string; testData?: string }

/** The HTTP-level detail the generator attaches to each designed scenario. */
export interface ApiCaseMeta {
  endpoint: string;
  method: string;
  headers: Record<string, string>;
  queryParams: string;
  requestBody?: string;
  expectedStatus: string;
}

/** One designed scenario, as it comes back from the generator. */
export interface Scenario {
  id: string;
  title: string;
  description?: string;
  feature?: string;
  /** positive | negative | security | data | edge | api | e2e (flow) | performance */
  type: string;
  priority: string;
  severity?: string;
  tags?: string[];
  steps: string[];
  testSteps?: TestStep[];
  expectedResult?: string;
  precondition?: string;
  api?: ApiCaseMeta;
  /** Everything else the backend sent, carried through to save/execute intact. */
  raw: any;
}

/** A generated service object — the API half of the Page Object Model. */
export interface ServiceObject { path: string; className: string; module: string; methods: string[]; code: string }

/** A rendered Playwright request spec. */
export interface Spec { testCaseId: string; fileName: string; code: string; path?: string }

export type RunStatus = 'pending' | 'running' | 'passed' | 'failed' | 'not_run';

export interface RunRow {
  testCaseId: string;
  name: string;
  status: RunStatus;
  duration: string;
  error?: string;
  healed?: boolean;
  healNote?: string;
}

export type LogLevel = 'info' | 'ok' | 'warn' | 'error';
export interface LogLine { id: number; at: number; stage: StageKey | 'run' | 'import' | 'env'; level: LogLevel; text: string }

export type PushState =
  | { status: 'idle' }
  | { status: 'pushing' }
  | { status: 'done'; url: string; branch: string; mode: 'pr' | 'direct'; fileCount: number; repo: string }
  | { status: 'error'; error: string };

export interface RunReport {
  total: number;
  passed: number;
  failed: number;
  notRun: number;
  healed: number;
  passRate: number;
  durationMs: number;
  reportUrl?: string;
}

/* ═══════════════════════════════════════════════════════════════
   Dashboard data (from /api/api-automation/overview)
   ═══════════════════════════════════════════════════════════════ */

export interface ReportStats { passed: number; failed: number; broken: number; skipped: number; total: number; passRate: number; durationMs: number }

export interface ApiRunSummary {
  runId: string;
  title: string;
  createdAt: string;
  createdBy: string;
  source: string;
  caseCount: number;
  categories: Record<string, number>;
  endpoints: number;
  stats: ReportStats | null;
  reportUrl?: string;
  hasAllure: boolean;
}

export interface ApiOverview {
  kpis: {
    runs: number; runsLast30d: number; scenarios: number; endpointsCovered: number;
    avgPassRate: number | null; lastPassRate: number | null; lastRunAt: string | null; imports: number; environments: number;
  };
  trend: { runId: string; at: string; passRate: number; passed: number; failed: number; total: number; durationMs: number; title: string }[];
  categories: Record<string, number>;
  methods: Record<string, number>;
  recentRuns: ApiRunSummary[];
  anomalies: { name: string; kind: 'flaky' | 'slow' | 'new-failure'; detail: string; runs: number }[];
  slowest: { name: string; durationMs: number; runId: string }[];
  imports: { total: number; byMethod: Record<string, number>; recent: { id: string; method: string; name: string; format: string; endpointCount: number; createdAt: string; createdBy: string }[] };
}

export interface ApiRunDetail extends ApiRunSummary {
  cases: { id: string; title: string; type: string; priority: string; feature: string; api: ApiCaseMeta | null; status: string; durationMs?: number; error?: string }[];
}

/* ═══════════════════════════════════════════════════════════════
   Navigation
   ═══════════════════════════════════════════════════════════════ */

export type NavView = 'overview' | 'import' | 'endpoints' | 'scenarios' | 'runs' | 'report' | 'environments' | 'developer';
