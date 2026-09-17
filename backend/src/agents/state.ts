export interface TestFieldData {
  id: string;
  field_name: string;
  value: string;
  type: 'valid' | 'invalid';
  data_type: string;
  validation_rule?: string;
  source: 'static' | 'database' | 'api' | 'computed';
  source_detail?: string; // e.g. table.column, API endpoint, or computation description
}

export interface TestDataset {
  dataset_id: string;
  role: string;
  scenario: string;
  fields: Record<string, string>;
  layer: 'ui' | 'api' | 'both';
  source: 'static' | 'database' | 'mixed';
  source_config?: {
    db_table?: string;
    db_query?: string;
    connection_id?: string;
    description?: string;
  };
}

export interface TestDataMapping {
  test_case_id: string;
  dataset_id: string;
}

export interface DataValidationExpectation {
  field: string;
  value: string;
  validation: 'accepted' | 'rejected';
  reason: string;
}

export interface AccessibilityTestData {
  element: string;
  label: string;
  aria_role: string;
  tab_order?: number;
  expected_behavior: string;
}

export interface TestDataPayload {
  datasets: TestDataset[];
  field_data: TestFieldData[];
  mapping: TestDataMapping[];
  validations: DataValidationExpectation[];
  accessibility_data: AccessibilityTestData[];
}

/**
 * A single, professionally-formatted test step.
 * Each step carries its own expected result so the case reads cleanly
 * top-to-bottom (IEEE 829 / ISTQB style).
 */
export interface TestStep {
  step: number;
  action: string;        // What the tester does, in present tense ("Click Submit")
  expected: string;      // What should happen as a result of THIS step
  testData?: string;     // Concrete value used in this step (optional, e.g., "email = user@x.com")
}

/**
 * HTTP-level detail for an API Automation test case.
 * API runs replace the UI-oriented test-case columns (Test Steps, Feature …)
 * with these, so every field here backs one column in the API column set.
 * Secrets are masked before they land here — see apiGeneratorAgent.
 */
export interface ApiCaseMeta {
  /** Absolute endpoint WITHOUT the query string, e.g. https://api.x.com/posts/1 */
  endpoint: string;
  method: string;
  /** Request headers as sent, with auth values masked. */
  headers: Record<string, string>;
  /** Raw query string for this case ("userId=1&limit=10"), '' when there is none. */
  queryParams: string;
  /** JSON payload for write methods; absent for GET/HEAD. */
  requestBody?: string;
  /** Asserted status: "200", "401 / 403", "< 500", "2xx" or "4xx". */
  expectedStatus: string;
}

export interface TestCase {
  /** Internal sequence id, e.g., TC-001 */
  id: string;
  /** Traceability link back to source requirement (story key, REQ-id, or "EXPLORE-{module}") */
  traceabilityId?: string;
  /** Module / sub-module classification — required for organized test suites */
  module?: string;
  submodule?: string;
  /** Feature being exercised, e.g., "User Login" */
  feature: string;
  /**
   * Crisp title in the form: Verify <action> <object> <condition>
   * Example: "Verify login fails with invalid password"
   */
  title: string;
  /**
   * Legacy alias for title — kept so existing UI / DB code continues to work.
   * New code should prefer `title`.
   */
  scenario: string;
  /** 1-3 sentence description of WHAT this case proves and WHY it matters */
  description?: string;
  /** Prerequisite state: data, user role, system setup. Plain English, full sentences. */
  precondition?: string;
  /**
   * Structured steps (preferred). Each entry has action + expected + optional testData.
   * Keep `steps` populated as plain strings too for backward compat with old UI/script agent.
   */
  testSteps?: TestStep[];
  steps: string[];
  /** Final / cumulative expected outcome — short summary of the success criterion */
  expectedResult: string;
  /** Concrete test data block ("email", "valid_email", etc.) — populated when shared across steps */
  testData?: Record<string, string>;
  type: 'e2e' | 'positive' | 'negative' | 'edge' | 'api' | 'data' | 'smoke' | 'security' | 'accessibility' | 'performance';
  priority: 'P0' | 'P1' | 'P2' | 'P3';
  /** Bug severity if this case fails: how bad is the impact */
  severity?: 'Critical' | 'Major' | 'Moderate' | 'Minor';
  /** Free-form tags for filtering (smoke, regression, sanity, etc.) */
  tags?: string[];
  /** Populated ONLY by apiGeneratorAgent — backs the API Automation columns. */
  api?: ApiCaseMeta;
  status: 'generated' | 'automated' | 'executed' | 'passed' | 'failed';
}

export interface AutomationScript {
  testCaseId: string;
  fileName: string;
  code: string;
  /**
   * Repo-relative destination for the spec in the POM layout, e.g.
   * `tests/auth/login.spec.ts`. Optional for back-compat; when absent,
   * consumers fall back to `tests/<fileName>`.
   */
  path?: string;
  /** Repo-relative paths of the page objects this spec imports. */
  uses?: string[];
}

/**
 * A generated Page Object (POM). Shared across specs — NOT 1:1 with test cases.
 * The generator sets `path` deterministically so specs' relative imports always
 * resolve (in the execution workspace and the published repo alike).
 */
export interface PageObjectFile {
  /** Repo-relative path, e.g. `src/pages/auth/login.page.ts`. */
  path: string;
  /** Exported class name, e.g. `LoginPage` — fed into the spec prompt. */
  className: string;
  /** Module slug grouping the page object, e.g. `auth`. */
  module: string;
  /** Public method signatures, surfaced to the spec generator. */
  methods: string[];
  code: string;
}

/**
 * A single response assertion for an API test, kept as a small structured
 * union so the script renderer can emit reliable, compiling Playwright
 * `expect(...)` lines deterministically (no LLM-authored code to mis-parse).
 */
export interface ApiCheck {
  kind:
    | 'status'            // status code equals / one-of / less-than
    | 'ok'                // response.ok() is truthy (2xx)
    | 'notOk'             // response.ok() is falsy (non-2xx)
    | 'jsonProperty'      // a (dotted) path in the JSON body exists / equals / is of a type
    | 'jsonArrayNotEmpty' // the body (or a path) is a non-empty array
    | 'header'            // a response header exists / contains a substring
    | 'bodyContains'      // the raw response text contains a substring
    | 'responseTimeUnderMs'; // the round-trip completed under N ms
  /** status: exact code */
  equals?: number;
  /** status: any of these codes */
  oneOf?: number[];
  /** status/responseTime: upper bound */
  lessThan?: number;
  /** jsonProperty/jsonArrayNotEmpty: dotted path, e.g. "data.0.id" ("" = root) */
  path?: string;
  /** jsonProperty: the path must exist */
  exists?: boolean;
  /** jsonProperty: deep-equals this literal value */
  value?: unknown;
  /** jsonProperty: the value must be of this JS type */
  type?: 'string' | 'number' | 'boolean' | 'array' | 'object';
  /** header: header name (case-insensitive) */
  name?: string;
  /** header: header value must contain this substring */
  contains?: string;
  /** bodyContains: substring the raw body must include */
  text?: string;
  /** responseTimeUnderMs: the millisecond ceiling */
  ms?: number;
}

/**
 * The HTTP request + assertions for one generated API test case. Produced by
 * apiGeneratorAgent and rendered deterministically into a Playwright `request`
 * spec — never executed in a browser.
 */
export interface ApiTestRequest {
  method: string;                       // GET | POST | PUT | PATCH | DELETE | ...
  url: string;                          // absolute URL for THIS case
  headers?: Record<string, string>;
  /** Raw request body (JSON text) for POST/PUT/PATCH. */
  body?: string;
  checks: ApiCheck[];
}

/**
 * The user-supplied API details captured by the chat wizard's API form. This
 * is the ground truth apiGeneratorAgent designs test cases against — distinct
 * from AppContext, which describes a browser application under test.
 */
export interface ApiSpec {
  method: string;                       // the primary method the user entered
  url: string;                          // the full URL the user entered
  /** Scheme + host derived from `url` server-side; used as the execution target. */
  baseUrl?: string;
  headers?: { key: string; value: string }[];
  auth?: {
    type: 'none' | 'bearer' | 'basic' | 'apikey';
    /** Bearer token, "username:password" for basic, or the API key value. */
    value?: string;
    /** apikey only — the header the key is sent in (defaults to X-API-Key). */
    headerName?: string;
  };
  /** Raw request body (JSON text) the user entered for POST/PUT/PATCH. */
  body?: string;
  /** Required HTTP status code the endpoint is expected to return (100–599). */
  expectedStatus?: number;
  /** Required sample / expected response body the user pasted. */
  expectedResponse?: string;
  /**
   * How wide a scenario net apiGeneratorAgent should cast.
   *   essential  — the critical path only (happy path + the obvious negatives)
   *   standard   — the default professional suite (contract, negative, auth, schema)
   *   exhaustive — every validation angle that applies to this endpoint
   * Defaults to 'standard' when absent.
   */
  coverage?: 'essential' | 'standard' | 'exhaustive';
}

export interface AppContext {
  targetUrl?: string;
  appName?: string;
  environment?: string;
  roles?: { roleName: string; username: string; password: string }[];
  /**
   * Optional free-form guidance from the user (explore mode) that steers what
   * the explore agent emphasises when synthesising requirements from the crawl.
   * Purely additive — it never changes the crawl itself.
   */
  explorePrompt?: string;
}

/**
 * Per-tenant LLM credentials, resolved from the DB (System Configuration →
 * LLM Configuration). Threaded through the pipeline so every agent calls the
 * Anthropic Messages API with the admin-saved key — not an env var or a local
 * `claude` CLI login. See services/llm.service.ts and agents/claude-runner.ts.
 */
export interface LlmConfig {
  /**
   * How the tenant authenticates to Anthropic:
   *   - 'api_key'     → standard API key (x-api-key), consumes API credits.
   *   - 'claude_code' → Claude Code OAuth token (from `claude setup-token`),
   *                     using the Claude subscription instead of API credits.
   *                     Falls back to a logged-in local `claude` CLI when no
   *                     token is set (local dev).
   * Defaults to 'api_key' when omitted.
   */
  authMethod?: 'api_key' | 'claude_code';
  apiKey?: string;
  /** Claude Code OAuth token (sk-ant-oat…) — used when authMethod is 'claude_code'. */
  oauthToken?: string;
  /**
   * Claude Code transport, chosen by the admin when authMethod is 'claude_code':
   *   - 'api' → OAuth token against the Anthropic Messages API (Bearer).
   *   - 'cli' → the logged-in local `claude` CLI (subscription, no API cost).
   * Defaults to 'api'. Used to run local testing through the CLI while Azure
   * uses the API key/token — the two run against separate databases.
   */
  claudeCodeMode?: 'api' | 'cli';
  /** Default model, used for any stage without a specific override. */
  model?: string;
  baseUrl?: string;
  /** Per-agent model overrides, keyed by stage (requirement, generator, …). */
  agentModels?: Record<string, string>;
  /**
   * Reasoning effort (output_config.effort): low | medium | high | xhigh | max.
   * Applied only to models that support it (gated in claude-runner) — Haiku 4.5
   * and Sonnet 4.5 reject it, so it's dropped there. Default high when unset.
   */
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  /**
   * Extended ("ultra") thinking. When true, sends thinking:{type:'adaptive'} on
   * models that support adaptive thinking (Opus 4.6+/Sonnet 4.6/Fable). Gated in
   * claude-runner so unsupported models are never sent the param.
   */
  extendedThinking?: boolean;
}

export interface GenerationOptions {
  maxTestCases?: number;
}

/**
 * Structured analysis output of the requirementAgent.
 * Richer than a flat list — captures everything a planner / generator
 * needs to produce IEEE-829-grade test cases.
 */
export interface ParsedRequirements {
  /** High-level functional features (e.g., "User Login", "Checkout") */
  features: string[];
  /** Modules / submodules organising the features (e.g., {module:"Account", submodule:"Login"}) */
  modules?: { module: string; submodule?: string; features: string[] }[];
  /** Distinct user roles / personas mentioned in the requirements */
  actors: string[];
  /** End-to-end user flows ("Customer adds item, applies coupon, checks out") */
  flows: string[];
  /** Edge cases, boundary conditions, error paths */
  edgeCases: string[];
  /** Data validation rules (required fields, format constraints) */
  dataRules: string[];
  /** Explicit Given/When/Then or "shall …" acceptance criteria mined from the input */
  acceptanceCriteria?: string[];
  /** Non-functional requirements (performance, security, accessibility, compatibility) */
  nonFunctionalRequirements?: {
    performance?: string[];
    security?: string[];
    accessibility?: string[];
    compatibility?: string[];
    usability?: string[];
  };
  /** Business risk per feature — drives priority & coverage depth */
  businessRisks?: { feature: string; risk: 'High' | 'Medium' | 'Low'; rationale: string }[];
  /** Per-actor permission matrix — which roles can do which features (used for authz negative tests) */
  personaMatrix?: { actor: string; allowedFeatures: string[]; deniedFeatures?: string[] }[];
}

/**
 * Output of the exploreAgent — a structured snapshot of the live AUT.
 * The requirementAgent later turns this into a ParsedRequirements.
 */
export interface ExploredApp {
  appName?: string;
  baseUrl: string;
  pages: {
    url: string;
    title: string;
    headings: string[];
    forms: { id?: string; name?: string; action?: string; fields: { name: string; type: string; required: boolean; label?: string }[] }[];
    buttons: string[];
    links: { text: string; href: string }[];
    navItems: string[];
  }[];
  detectedFeatures: string[];     // Heuristic feature names ("Login Page", "Search", "Cart")
  authDetected: boolean;
  notes: string[];                // Anything unusual the crawler observed
}

export interface TestOpsState {
  requirements: string;
  appContext: AppContext | null;
  /**
   * Present only for API Automation runs — the user's API details. When set,
   * the pipeline routes to apiGeneratorAgent (real HTTP test cases + Playwright
   * `request` specs) instead of the browser/UI generator.
   */
  apiSpec?: ApiSpec | null;
  /**
   * API Automation, multi-endpoint. When an imported collection/spec is run
   * across several endpoints at once, each endpoint's contract is one entry
   * here; apiGeneratorAgent generates a suite for every one and merges them
   * into a single set of test cases + specs (ids and service-object paths kept
   * collision-free by a single planning pass). When present this takes priority
   * over the single `apiSpec`.
   */
  apiSpecs?: ApiSpec[] | null;
  /**
   * API Automation — the pattern profile derived from the whole imported
   * surface (resources, CRUD chains, auth, pagination, flows). Rendered into
   * every generation prompt as context and used to design multi-step flows.
   * Shape: ApiProfile from api-intelligence.service — kept loose here so the
   * agent state does not import the service layer.
   */
  apiProfile?: Record<string, any> | null;
  /**
   * API Automation — which test layers the reviewer switched on for this run
   * (smoke, contract, schema, negative, auth, security, performance, flow).
   * Absent = every layer that applies.
   */
  apiLayers?: string[] | null;
  /**
   * API Automation — optional progress sink for long generations (one model
   * call per endpoint). Not serialised; set by the async design job.
   */
  onProgress?: ((p: { phase: string; done: number; total: number; flows?: number; message?: string }) => void) | null;
  /** Resolved per-tenant LLM credentials (DB-backed). Null = none configured. */
  llm?: LlmConfig | null;
  generationOptions?: GenerationOptions;
  /** Populated by exploreAgent when only a URL is provided */
  exploredApp?: ExploredApp | null;
  parsedRequirements: ParsedRequirements | null;
  testPlan: {
    uiTests: number;
    apiTests: number;
    dataTests: number;
    priority: string;
    coverageAreas: string[];
  } | null;
  /**
   * Rich IEEE-829-style plan produced by plannerAgent. Optional — the legacy
   * `testPlan` field above remains for older consumers, but new code should
   * read this when present.
   * Typed as `unknown` here to avoid a circular import with plannerAgent.
   * Cast at the read site to `ExtendedTestPlan` from plannerAgent.ts.
   */
  extendedTestPlan?: unknown;
  testCases: TestCase[];
  automationScripts: AutomationScript[];
  /** Generated page objects (POM). Shared support files imported by the specs. */
  pageObjects?: PageObjectFile[];
  executionResults: {
    passed: number;
    failed: number;
    failReason?: string;
    /**
     * Per-test outcomes from the real Playwright run. Frontend uses this
     * to render an accurate, non-fabricated execution table.
     */
    details?: {
      testCaseId: string;
      scenario: string;
      status: 'passed' | 'failed' | 'skipped' | 'not_run';
      durationMs?: number;
      error?: string;
    }[];
  } | null;
  testData: TestDataPayload | null;
  failureReason: string | null;
  healingAttempted: boolean;
  /** Per-test healing outcome notes (why a heal was skipped or failed) for the UI log. */
  healingNotes?: Record<string, string>;
}

export function createInitialState(requirements: string, appContext?: AppContext, llm?: LlmConfig | null): TestOpsState {
  return {
    requirements,
    appContext: appContext || null,
    apiSpec: null,
    apiSpecs: null,
    apiProfile: null,
    apiLayers: null,
    llm: llm || null,
    exploredApp: null,
    parsedRequirements: null,
    testPlan: null,
    testCases: [],
    automationScripts: [],
    pageObjects: [],
    executionResults: null,
    testData: null,
    failureReason: null,
    healingAttempted: false,
  };
}
