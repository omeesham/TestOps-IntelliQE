/**
 * types.ts — the entire data contract of the prototype.
 *
 * These four types are copied (trimmed) from the production platform
 * (backend/src/agents/state.ts) so the path from prototype → the real
 * apiGeneratorAgent is additive, not a rewrite.
 *
 * The invariant the whole prototype exists to prove:
 *   The LLM designs test INTENT as typed JSON (ApiSpec in, ApiCheck[] out).
 *   Deterministic code renders and runs it. The model never authors code.
 */

/** What the user defines — the ground truth the generator designs against. */
export interface ApiSpec {
  method: string;
  url: string;
  /** Scheme + host derived from `url`; used as the execution target. */
  baseUrl?: string;
  headers?: { key: string; value: string }[];
  auth?: {
    type: 'none' | 'bearer' | 'basic' | 'apikey';
    /** Bearer token, "username:password" for basic, or the API key value. */
    value?: string;
    /** apikey only — the header the key is sent in (defaults to X-API-Key). */
    headerName?: string;
  };
  /** Raw request body (JSON text) for POST/PUT/PATCH. */
  body?: string;
  /** Required HTTP status code the endpoint is expected to return. */
  expectedStatus?: number;
  /** Sample / expected response body the user pasted. */
  expectedResponse?: string;
  /** How wide a scenario net the generator casts. Defaults to 'standard'. */
  coverage?: 'essential' | 'standard' | 'exhaustive';
}

/**
 * The CLOSED set of assertions. The model may ONLY emit these kinds — that is
 * what makes deterministic rendering and execution possible, and what stops the
 * model from ever authoring code.
 */
export interface ApiCheck {
  kind:
    | 'status' // status code equals / one-of / less-than
    | 'ok' // response is 2xx
    | 'notOk' // response is NOT 2xx (negative cases)
    | 'jsonProperty' // a dotted path in the JSON body exists / equals / is a type
    | 'jsonArrayNotEmpty' // the body (or a path) is a non-empty array
    | 'header' // a response header exists / contains a substring
    | 'bodyContains' // the raw response text contains a substring
    | 'responseTimeUnderMs'; // round-trip completed under N ms
  equals?: number;
  oneOf?: number[];
  lessThan?: number;
  /** jsonProperty/jsonArrayNotEmpty: dotted path, e.g. "data.0.id" ("" = root). */
  path?: string;
  exists?: boolean;
  value?: unknown;
  type?: 'string' | 'number' | 'boolean' | 'array' | 'object';
  /** header: header name (case-insensitive). */
  name?: string;
  /** header: value must contain this substring. */
  contains?: string;
  /** bodyContains: substring the raw body must include. */
  text?: string;
  /** responseTimeUnderMs: the millisecond ceiling. */
  ms?: number;
}

export type CaseCategory = 'positive' | 'negative' | 'auth' | 'schema' | 'edge';

/** One generated, validated test case after normalization. */
export interface NormalizedCase {
  id: string;
  title: string;
  description?: string;
  feature: string;
  category: CaseCategory;
  method: string;
  /** Absolute URL for THIS case. */
  url: string;
  headers: Record<string, string>;
  body?: string;
  checks: ApiCheck[];
}

/** One evaluated assertion. */
export interface CheckResult {
  label: string;
  pass: boolean;
  /** The actual value observed, for the report. */
  actual?: string;
}

/** One result row after execution. */
export interface RunResult {
  id: string;
  title: string;
  category: CaseCategory;
  method: string;
  url: string;
  ok: boolean;
  status?: number;
  durationMs: number;
  checks: CheckResult[];
  error?: string;
  /** Short preview of the response body (masked). */
  bodyPreview?: string;
}

/* ──────────────────────────────────────────────────────────────────
   M4 — multi-step flows (stateful journeys)
   One step can EXTRACT values from its response into named variables;
   later steps SUBSTITUTE {{name}} into their url / headers / body. This is
   the minimal slice of the production flow engine (api-flow.service.ts).
   ────────────────────────────────────────────────────────────────── */

/** One request of a journey, plus what it extracts for later steps. */
export interface FlowStep {
  name: string;
  method: string;
  url: string;
  headers?: Record<string, string>;
  body?: string;
  /**
   * variable name → where to read it from THIS step's response:
   *   "id" / "data.0.id"  → a dotted path in the JSON body
   *   "header:Location"   → a response header
   *   "status"            → the HTTP status code
   * The captured value becomes {{name}} for every later step.
   */
  extract?: Record<string, string>;
  checks?: ApiCheck[];
}

export interface FlowStepResult {
  index: number;
  name: string;
  method: string;
  url: string;
  ok: boolean;
  status?: number;
  durationMs: number;
  error?: string;
  /** Variables this step captured (name → value). */
  extracted: Record<string, string>;
  checks: CheckResult[];
  bodyPreview?: string;
}

export interface FlowRunResult {
  passed: boolean;
  steps: FlowStepResult[];
  /** The variable bag after the last step ran. */
  variables: Record<string, string>;
  durationMs: number;
  stepsRun: number;
  stepsTotal: number;
}

/** At-a-glance aggregates over a run. */
export interface RunSummary {
  total: number;
  passed: number;
  failed: number;
  checks: number;
  checksPassed: number;
  slowestMs: number;
  slowestCase?: string;
}
