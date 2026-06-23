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
  status: 'generated' | 'automated' | 'executed' | 'passed' | 'failed';
}

export interface AutomationScript {
  testCaseId: string;
  fileName: string;
  code: string;
}

export interface AppContext {
  targetUrl?: string;
  appName?: string;
  environment?: string;
  roles?: { roleName: string; username: string; password: string }[];
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
}

export function createInitialState(requirements: string, appContext?: AppContext): TestOpsState {
  return {
    requirements,
    appContext: appContext || null,
    exploredApp: null,
    parsedRequirements: null,
    testPlan: null,
    testCases: [],
    automationScripts: [],
    executionResults: null,
    testData: null,
    failureReason: null,
    healingAttempted: false,
  };
}
