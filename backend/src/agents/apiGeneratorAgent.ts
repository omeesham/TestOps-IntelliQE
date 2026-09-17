/**
 * apiGeneratorAgent
 * ─────────────────
 * The API-Automation counterpart to generatorAgent. Given the user's ApiSpec
 * (method, URL, headers, auth, body, expected response) it:
 *
 *   1. Asks Claude to DESIGN a focused suite of real HTTP test cases — happy
 *      path, negative/validation, auth, and response-schema checks — as
 *      STRUCTURED JSON (an HTTP request + a list of typed assertions per case).
 *   2. Renders each case into a runnable Playwright `request` spec
 *      DETERMINISTICALLY in this file — the model never authors code, so the
 *      specs always compile and run through the existing execution engine
 *      (executionAgent / playwright-runner) with no browser.
 *
 * Both halves follow the Page Object Model. There is no DOM and no `page`
 * fixture here, so the object a spec drives is a SERVICE OBJECT rather than a
 * page object: `src/api/<module>/<module>.api.ts`, one class per feature,
 * extending the shared `BaseApi`. It owns the URL, the headers and the payload;
 * the spec only calls a method and asserts on the response. See
 * planServiceObjects/renderServiceObject below.
 */
import type { TestOpsState, TestCase, TestStep, ApiCheck, ApiSpec, ApiCaseMeta, AutomationScript, PageObjectFile } from './state.js';
import { runLLM, parseJsonFromResponse, coerceJsonArray, salvageJsonArrayObjects, llmForStage } from './claude-runner.js';
import { cleanAuthValue, isPlaceholderSecret } from '../utils/api-auth.js';
import { analyzeApiSurface, profileContextFor, type ApiProfile, type ApiFlow } from '../services/api-intelligence.service.js';
import type { ImportedEndpoint } from '../services/api-import.service.js';

let counter = 0;
function nextId() { return `TC-${String(++counter).padStart(3, '0')}`; }

/** The test layers a reviewer can switch off — see api-intelligence StrategyLayerId. */
type LayerId = 'smoke' | 'contract' | 'schema' | 'negative' | 'auth' | 'security' | 'performance' | 'flow';
const ALL_LAYERS: LayerId[] = ['smoke', 'contract', 'schema', 'negative', 'auth', 'security', 'performance', 'flow'];

/** One request of a multi-step flow, plus what it extracts for later steps. */
export interface FlowStep {
  name: string;
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: string;
  checks: ApiCheck[];
  /** variable name → dotted JSON path in THIS step's response body. */
  extract: Record<string, string>;
}

/** Loose shape Claude is asked to return — normalised below. */
type RawApiCase = {
  title?: string;
  scenario?: string;
  description?: string;
  feature?: string;
  category?: string;              // positive | negative | auth | schema | edge
  priority?: string;
  severity?: string;
  tags?: string[];
  /** The HTTP request for THIS case. */
  request?: {
    method?: string;
    url?: string;
    path?: string;                // relative to the base URL, when url is absent
    headers?: Record<string, string> | { key: string; value: string }[];
    body?: string | object;
    /** false ⇒ deliberately omit the configured auth (negative-auth case). */
    includeAuth?: boolean;
  };
  checks?: ApiCheck[];
};

export interface NormalizedApiCase {
  id: string;
  title: string;
  description: string;
  feature: string;
  type: TestCase['type'];
  priority: TestCase['priority'];
  severity?: TestCase['severity'];
  tags: string[];
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: string;
  checks: ApiCheck[];
  /**
   * Set for a multi-step flow (create → read → update → delete). The top-level
   * request/checks then describe the FIRST step; every step is rendered in
   * order inside one test, with `{{var}}` placeholders filled from what earlier
   * steps extracted.
   */
  steps?: FlowStep[];
}

const VALID_PRIORITIES: TestCase['priority'][] = ['P0', 'P1', 'P2', 'P3'];
const VALID_SEVERITIES: NonNullable<TestCase['severity']>[] = ['Critical', 'Major', 'Moderate', 'Minor'];

/* ────────────────────────────────────────────────────────────────
   Prompt
   ──────────────────────────────────────────────────────────────── */
function buildApiPrompt(spec: ApiSpec, requirements: string, opts: { context?: string; layers?: Set<LayerId> } = {}): string {
  const layers = opts.layers || new Set<LayerId>(ALL_LAYERS);
  const off = (l: LayerId) => !layers.has(l);
  // Layers the reviewer switched off are removed from scope explicitly — the
  // matrix below stays complete so the model knows what it is NOT doing.
  const exclusions: string[] = [];
  if (off('negative')) exclusions.push('SKIP the entire NEGATIVE / VALIDATION and PAYLOAD blocks — the reviewer disabled negative testing for this run.');
  if (off('auth')) exclusions.push('SKIP the AUTH block entirely.');
  if (off('schema')) exclusions.push('SKIP the "Response schema" row — assert only status and content-type on the happy path.');
  if (off('performance')) exclusions.push('Do NOT emit any responseTimeUnderMs check.');
  if (off('security')) exclusions.push('SKIP the injection probe and other RESILIENCE rows.');
  if (off('contract')) exclusions.push('SKIP the content-type/header sanity rows (keep the exact-status assertion).');
  const exclusionBlock = exclusions.length ? `\nLAYERS DISABLED BY THE REVIEWER:\n${exclusions.map((e) => `- ${e}`).join('\n')}\n` : '';
  const contextBlock = opts.context ? `\n${opts.context}\n` : '';
  const headerLines = (spec.headers || [])
    .filter((h) => h.key?.trim())
    .map((h) => `  ${h.key}: ${h.value}`)
    .join('\n') || '  (none)';
  const authLine =
    !spec.auth || spec.auth.type === 'none'
      ? 'None'
      : `${spec.auth.type}${spec.auth.value ? ' (a value is configured — reference it as {{AUTH}}, never invent one)' : ''}`;
  const bodyBlock = spec.body?.trim() ? spec.body.trim().slice(0, 4000) : '(none)';
  const expectedBlock = spec.expectedResponse?.trim() ? spec.expectedResponse.trim().slice(0, 4000) : '(not provided)';
  const expectedStatusLine = typeof spec.expectedStatus === 'number' ? String(spec.expectedStatus) : '(not specified — infer from the method)';

  // How wide a net to cast. The matrix below is written once and gated per
  // row; this line tells the model which gates are open and roughly how many
  // cases that should amount to, so 'exhaustive' doesn't become 'unbounded'.
  const coverage = spec.coverage || 'standard';
  const coverageBlock =
    coverage === 'essential'
      ? 'DEPTH: ESSENTIAL — the critical path only. Include the [core] rows below and nothing else. Target 4–6 cases.'
      : coverage === 'exhaustive'
        ? 'DEPTH: EXHAUSTIVE — every validation angle that genuinely applies. Include the [core], [wide] AND [deep] rows below. Target 16–28 cases; go past that only when the endpoint truly warrants it.'
        : 'DEPTH: STANDARD — a professional regression suite. Include the [core] and [wide] rows below; skip [deep]. Target 10–16 cases.';

  return `You are a Senior API Test Engineer. Design a FOCUSED, professional suite of HTTP test cases for the single endpoint below. Return STRUCTURED JSON only — you do NOT write code; a deterministic renderer turns your JSON into Playwright request specs.

═══════════════════════════════════════════════════════════════
ENDPOINT UNDER TEST
═══════════════════════════════════════════════════════════════
Method: ${spec.method}
URL: ${spec.url}
Headers:
${headerLines}
Authorization: ${authLine}
Request body (for write methods):
${bodyBlock}
Expected HTTP status code (the happy-path case MUST assert exactly this): ${expectedStatusLine}
Expected/sample response body:
${expectedBlock}

Extra context from the requester:
${(requirements || '').slice(0, 1200)}
${contextBlock}${exclusionBlock}
═══════════════════════════════════════════════════════════════
OUTPUT — return ONLY a JSON array (no markdown, no prose):
═══════════════════════════════════════════════════════════════
[
  {
    "title": "Verify GET /posts/1 returns 200 with the expected post schema",
    "description": "Confirms the endpoint responds successfully and the body carries the documented fields.",
    "feature": "Posts API",
    "category": "positive",            // positive | negative | auth | schema | edge
    "priority": "P0",                   // P0 blocks release … P3 nice-to-have
    "severity": "Critical",             // Critical | Major | Moderate | Minor
    "tags": ["api", "smoke"],
    "request": {
      "method": "GET",
      "url": "${spec.url}",            // ABSOLUTE url for this case; vary it for negative cases
      "headers": { "Accept": "application/json" },
      "body": null,                     // JSON string for POST/PUT/PATCH, else null
      "includeAuth": true               // set false ONLY for a deliberate no-auth negative case
    },
    "checks": [
      { "kind": "status", "equals": 200 },
      { "kind": "header", "name": "content-type", "contains": "application/json" },
      { "kind": "jsonProperty", "path": "id", "exists": true },
      { "kind": "jsonProperty", "path": "id", "type": "number" },
      { "kind": "responseTimeUnderMs", "ms": 5000 }
    ]
  }
]

═══════════════════════════════════════════════════════════════
CHECK TYPES (use only these — the renderer supports exactly this set):
═══════════════════════════════════════════════════════════════
- { "kind": "status", "equals": 200 }              // or "oneOf": [200,201], or "lessThan": 500
- { "kind": "ok" }                                  // response is 2xx
- { "kind": "notOk" }                               // response is NOT 2xx (negative cases)
- { "kind": "jsonProperty", "path": "data.0.id", "exists": true }
- { "kind": "jsonProperty", "path": "userId", "value": 1 }         // deep-equals a literal
- { "kind": "jsonProperty", "path": "title", "type": "string" }    // string|number|boolean|array|object
- { "kind": "jsonArrayNotEmpty", "path": "" }       // "" = the body itself is a non-empty array
- { "kind": "header", "name": "content-type", "contains": "json" }
- { "kind": "bodyContains", "text": "some substring" }
- { "kind": "responseTimeUnderMs", "ms": 5000 }

════════════════════════════════════════════════════════════════
SCENARIO MATRIX — work through EVERY row that applies to this endpoint
════════════════════════════════════════════════════════════════
${coverageBlock}

Rows below marked [core] are ALWAYS in scope. Rows marked [wide] are in scope
only at standard/exhaustive depth, [deep] only at exhaustive depth. Skip any
row that genuinely cannot apply to this method/endpoint — never pad the suite
with a case you cannot ground in the endpoint above.

CONTRACT
  [core] Happy path — the documented request → assert the EXACT expected status
         code ({ "kind": "status", "equals": ${expectedStatusLine.replace(/\D/g, '') || '200'} }) plus content-type.
  [core] Response schema — assert each key field from the expected/sample body
         above: existence AND type ("jsonProperty" with "type"), and the literal
         value where the sample makes it unambiguous.
  [wide] Response time — one responseTimeUnderMs guard on the happy path.
  [deep] Content negotiation — Accept: application/xml (or an unsupported type)
         → expect 406, or a JSON body if the API ignores it.

NEGATIVE / VALIDATION
  [core] Unknown resource — a path id that cannot exist (e.g. 99999999) → 404.
  [core] Malformed path/query — a non-numeric id where a number is required, or
         an invalid query value → 4xx.
  [wide] Wrong HTTP method against the same URL → 405 (or a documented 4xx).
  [wide] Unknown query parameter — confirm it is ignored (2xx) rather than 500.
  [deep] Trailing-slash / case variance on the path — assert it does not 500.

PAYLOAD (write methods — POST/PUT/PATCH only; skip entirely for GET/HEAD/DELETE)
  [core] Missing required field — drop one field the sample body carries → 4xx.
  [core] Malformed JSON — a syntactically broken body → 400.
  [wide] Wrong field type — a string where the sample has a number → 4xx.
  [wide] Empty body — "{}" or "" → 4xx.
  [deep] Extra/unknown field — assert it is rejected or safely ignored.
  [deep] Oversized field — a very long string in one field → 4xx or 413.

AUTH (ONLY when Authorization is configured above — otherwise skip this block)
  [core] Valid credential (includeAuth true) → the expected 2xx.
  [core] No credential (includeAuth false) → 401/403.
  [wide] Malformed credential — includeAuth false plus an explicit bogus
         Authorization header → 401/403.
  [deep] Expired/revoked-shaped token — a well-formed but invalid value → 401.

RESILIENCE
  [wide] Header sanity — content-type on the happy path is the documented type.
  [deep] Injection probe — a SQL/script-shaped value in a query or body field →
         assert a clean 4xx and that the raw payload is NOT echoed back.
  [deep] Idempotency (GET/PUT/DELETE) — the documented request twice returns the
         same status.

RULES:
1. Ground EVERY case in the real endpoint above. Do NOT invent unrelated endpoints or fields not implied by the method/URL/body/expected response.
2. Every case must be INDEPENDENTLY runnable — no shared state, no ordering assumptions between cases.
3. TITLE — every case needs a specific, self-explanatory title that reads as a full sentence and names (a) the action, (b) the exact condition/variation under test, and (c) the expected outcome including the HTTP status code. It must stand on its own in a report. NEVER use vague titles like "API test", "Test case 1", "Scenario", "Positive case" or the bare "METHOD url". Examples across categories:
   - Happy path: "Verify GET /posts/1 returns 200 with the full post schema"
   - Negative:   "Reject POST /users with 400 when the email field is missing"
   - Auth:       "Return 401 for GET /orders when no bearer token is supplied"
   - Schema:     "Confirm GET /posts/1 returns id as a number and title as a string"
   No two titles may be near-duplicates — merge cases that would assert the same thing.
4. Paths use dot notation with array indices, e.g. "data.0.email". "" means the JSON root.
5. NEVER put real secrets in the JSON. Reference the configured auth via includeAuth — the renderer injects the actual token.
6. A negative case must assert a SPECIFIC expectation ("status" with equals/oneOf, or "notOk") — never assert "ok" on a case designed to fail.
7. STRICT JSON: literals only — no comments, no trailing commas, no code expressions. Escape quotes inside strings.
8. If the expected/sample response body above is "(not provided)", do NOT invent specific field names or values. For the happy path still assert the exact status code and the content-type, and — for a JSON API — that the body is present and non-empty (use "jsonArrayNotEmpty" with an empty path for list endpoints, or a "jsonProperty" existence check on a plausible top-level field for object endpoints). Detailed field-name/type/value assertions are ONLY for cases where a sample body makes the field names unambiguous.

Generate the JSON array now.`;
}

/* ────────────────────────────────────────────────────────────────
   Parse + normalise
   ──────────────────────────────────────────────────────────────── */
function extractCases(response: string): RawApiCase[] {
  let parsed: unknown = null;
  try { parsed = parseJsonFromResponse<unknown>(response); } catch { /* salvage below */ }
  let arr = coerceJsonArray<RawApiCase>(parsed);
  if (!arr || arr.length === 0) arr = salvageJsonArrayObjects<RawApiCase>(response);
  return (arr || []).filter((e): e is RawApiCase =>
    !!e && typeof e === 'object' && !Array.isArray(e) &&
    ('title' in e || 'scenario' in e || 'request' in e || 'checks' in e));
}

function normalizeHeaders(h: any): Record<string, string> {
  const out: Record<string, string> = {};
  if (Array.isArray(h)) {
    for (const p of h) if (p && p.key) out[String(p.key)] = String(p.value ?? '');
  } else if (h && typeof h === 'object') {
    for (const [k, v] of Object.entries(h)) if (k) out[k] = String(v ?? '');
  }
  return out;
}

/** Base64 without relying on a specific runtime global typing. */
function b64(s: string): string {
  return Buffer.from(s, 'utf-8').toString('base64');
}

/**
 * Build the auth header the user configured (or null when no auth / value).
 *
 * The configured value is normalised first: users and the spec parser often
 * supply a whole header line ("Authorization: Bearer <token>") or a multi-line
 * header block, and prefixing that with the scheme produced an invalid header
 * carrying a duplicated scheme and an embedded newline on every request.
 */
function authHeader(spec: ApiSpec): { name: string; value: string } | null {
  const a = spec.auth;
  if (!a || a.type === 'none') return null;
  const v = cleanAuthValue(a.value);
  if (!v) return null;
  if (a.type === 'bearer') return { name: 'Authorization', value: `Bearer ${v}` };
  if (a.type === 'basic') return { name: 'Authorization', value: `Basic ${b64(v)}` };
  if (a.type === 'apikey') return { name: a.headerName?.trim() || 'X-API-Key', value: v };
  return null;
}

/**
 * A descriptive title for the rare case where the model returns none — built
 * from the category, method, path and asserted status, so even the fallback
 * reads like a real scenario instead of a bare "GET https://…".
 */
function fallbackTitle(method: string, url: string, category: string, checks: ApiCheck[]): string {
  let path = url;
  try { path = new URL(url).pathname || url; } catch { /* keep the raw url */ }
  const status = expectedStatusOf(checks);
  const verb =
    category === 'negative' ? 'Reject'
    : category === 'auth' ? 'Enforce authorization on'
    : category === 'schema' ? 'Validate the response schema of'
    : category === 'edge' ? 'Handle the edge case for'
    : 'Verify';
  return `${verb} ${method} ${path}${status ? ` (expects ${status})` : ''}`;
}

function normalizeCase(raw: RawApiCase, spec: ApiSpec): NormalizedApiCase | null {
  const req = raw.request || {};
  const method = String(req.method || spec.method || 'GET').toUpperCase();

  // Resolve the URL: an absolute url wins; otherwise join base + path; else the spec url.
  let url = typeof req.url === 'string' && req.url.trim() ? req.url.trim() : '';
  if (!url) {
    if (typeof req.path === 'string' && req.path.trim() && spec.baseUrl) {
      url = spec.baseUrl.replace(/\/+$/, '') + '/' + req.path.trim().replace(/^\/+/, '');
    } else {
      url = spec.url;
    }
  }
  if (!/^https?:\/\//i.test(url)) return null; // never emit a spec with a non-absolute URL

  // Merge headers: the spec's global headers first, then this case's overrides.
  const headers: Record<string, string> = {};
  for (const h of spec.headers || []) if (h.key?.trim()) headers[h.key.trim()] = String(h.value ?? '');
  Object.assign(headers, normalizeHeaders(req.headers));

  // Inject configured auth unless this case opts out (negative-auth test).
  const includeAuth = req.includeAuth !== false;
  if (includeAuth) {
    const ah = authHeader(spec);
    // Respect an explicit Authorization the model set; otherwise inject ours.
    if (ah && !Object.keys(headers).some((k) => k.toLowerCase() === ah.name.toLowerCase())) {
      headers[ah.name] = ah.value;
    }
  } else {
    const apiKeyHeader = (spec.auth?.headerName || 'x-api-key').toLowerCase();
    for (const k of Object.keys(headers)) {
      const lk = k.toLowerCase();
      if (lk === 'authorization' || lk === 'x-api-key' || lk === apiKeyHeader) delete headers[k];
    }
  }

  // Body only for write methods.
  let body: string | undefined;
  const hasBody = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method);
  if (hasBody) {
    const b = req.body;
    if (typeof b === 'string' && b.trim()) body = b;
    else if (b && typeof b === 'object') body = JSON.stringify(b);
    else if (spec.body?.trim() && (raw.category || '').toLowerCase() !== 'negative') body = spec.body;
    if (body && !Object.keys(headers).some((k) => k.toLowerCase() === 'content-type')) {
      headers['Content-Type'] = 'application/json';
    }
  }

  const checks: ApiCheck[] = Array.isArray(raw.checks) ? raw.checks.filter((c) => c && typeof c === 'object' && c.kind) : [];
  // Guarantee at least a status/ok assertion so no spec is assertion-free.
  if (checks.length === 0) checks.push({ kind: 'ok' });

  const category = (raw.category || '').toLowerCase();
  const type: TestCase['type'] =
    category === 'negative' ? 'negative'
    : category === 'auth' ? 'security'
    : category === 'schema' ? 'data'
    : category === 'edge' ? 'edge'
    : category === 'performance' ? 'performance'
    : category === 'flow' ? 'e2e'
    : 'api';

  const priority: TestCase['priority'] = (VALID_PRIORITIES as string[]).includes(raw.priority || '')
    ? (raw.priority as TestCase['priority']) : 'P1';
  const severity = raw.severity && (VALID_SEVERITIES as string[]).includes(raw.severity)
    ? (raw.severity as TestCase['severity']) : undefined;

  return {
    id: nextId(),
    title: (raw.title || raw.scenario || '').trim() || fallbackTitle(method, url, category, checks),
    description: (raw.description || '').trim(),
    feature: (raw.feature || 'API').trim(),
    type,
    priority,
    severity,
    tags: Array.isArray(raw.tags) && raw.tags.length ? raw.tags.map(String) : ['api'],
    method,
    url,
    headers,
    body,
    checks,
  };
}

/* ────────────────────────────────────────────────────────────────
   Deterministic Playwright `request` spec rendering
   ──────────────────────────────────────────────────────────────── */
function jsIndex(path: string | undefined): string {
  // "data.0.email" → ["data"]["0"]["email"] via the getPath helper.
  return JSON.stringify(path || '');
}

function checkLines(c: ApiCheck, inst: string): { needsJson?: boolean; needsText?: boolean; lines: string[] } {
  switch (c.kind) {
    case 'status':
      if (typeof c.equals === 'number')
        return { lines: [`  expect(response.status(), 'HTTP status code').toBe(${c.equals});`] };
      if (Array.isArray(c.oneOf) && c.oneOf.length)
        return { lines: [`  expect(${JSON.stringify(c.oneOf)}, 'HTTP status code').toContain(response.status());`] };
      if (typeof c.lessThan === 'number')
        return { lines: [`  expect(response.status(), 'HTTP status code').toBeLessThan(${c.lessThan});`] };
      return { lines: [`  expect(response.ok(), 'response should be 2xx').toBeTruthy();`] };
    case 'ok':
      return { lines: [`  expect(response.ok(), 'response should be successful (2xx)').toBeTruthy();`] };
    case 'notOk':
      return { lines: [`  expect(response.ok(), 'response should be a non-2xx error').toBeFalsy();`] };
    case 'jsonProperty': {
      const target = `getPath(body, ${jsIndex(c.path)})`;
      const lines: string[] = [];
      if (c.exists) lines.push(`  expect(${target}, ${JSON.stringify(`property "${c.path}" should exist`)}).toBeDefined();`);
      if ('value' in c && c.value !== undefined)
        lines.push(`  expect(${target}, ${JSON.stringify(`property "${c.path}"`)}).toEqual(${JSON.stringify(c.value)});`);
      if (c.type) {
        if (c.type === 'array') lines.push(`  expect(Array.isArray(${target}), ${JSON.stringify(`"${c.path}" should be an array`)}).toBeTruthy();`);
        else lines.push(`  expect(typeof ${target}, ${JSON.stringify(`"${c.path}" should be ${c.type}`)}).toBe(${JSON.stringify(c.type)});`);
      }
      if (lines.length === 0) lines.push(`  expect(${target}, ${JSON.stringify(`property "${c.path}" should exist`)}).toBeDefined();`);
      return { needsJson: true, lines };
    }
    case 'jsonArrayNotEmpty': {
      const target = c.path ? `getPath(body, ${jsIndex(c.path)})` : 'body';
      return {
        needsJson: true,
        lines: [
          `  expect(Array.isArray(${target}), 'response should be an array').toBeTruthy();`,
          `  expect((${target} || []).length, 'array should not be empty').toBeGreaterThan(0);`,
        ],
      };
    }
    case 'header': {
      const name = String(c.name || '').toLowerCase();
      const acc = `response.headers()[${JSON.stringify(name)}]`;
      if (c.contains)
        return { lines: [`  expect(String(${acc} || ''), ${JSON.stringify(`header "${c.name}" should contain "${c.contains}"`)}).toContain(${JSON.stringify(c.contains)});`] };
      return { lines: [`  expect(${acc}, ${JSON.stringify(`header "${c.name}" should be present`)}).toBeTruthy();`] };
    }
    case 'bodyContains':
      return { needsText: true, lines: [`  expect(rawText, ${JSON.stringify(`body should contain "${c.text}"`)}).toContain(${JSON.stringify(String(c.text ?? ''))});`] };
    case 'responseTimeUnderMs':
      // The service object times its own call — the spec never holds a stopwatch.
      return { lines: [`  expect(${inst}.durationMs, 'response time (ms)').toBeLessThan(${Number(c.ms) || 10000});`] };
    default:
      return { lines: [] };
  }
}

/* ────────────────────────────────────────────────────────────────
   Service objects — the API half of the Page Object Model

   A page object encapsulates the selectors of one screen; a SERVICE OBJECT
   encapsulates the requests of one resource. Specs call methods on it and
   assert on what comes back — they never build a URL, set a header or
   serialise a payload, so moving an endpoint or changing its auth scheme is a
   one-file change. The layout mirrors the browser side deliberately:

     Base:            src/api/base.api.ts               (shipped in the scaffold)
     Service objects: src/api/<module>/<module>.api.ts   (imports base as ../base.api)
     Specs:           tests/api/<name>.spec.ts           (imports the object as ../../src/api/…)
   ──────────────────────────────────────────────────────────────── */

/** One request, encapsulated as a method on a service object. */
interface ServiceMethod {
  name: string;
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: string;
}

/** One generated service object: the requests of a single feature, as a class. */
export interface ServiceObjectPlan {
  module: string;
  className: string;
  instanceName: string;
  /** Repo-relative path, e.g. `src/api/users/users.api.ts`. */
  path: string;
  /** How a spec under tests/api/ imports it. */
  importPath: string;
  methods: ServiceMethod[];
}

/** What a spec needs in order to drive its service object. */
export interface CaseBinding {
  plan: ServiceObjectPlan;
  methodName: string;
  /** Flow cases: one method per step, in step order (methodName is step 0's). */
  stepMethods?: string[];
}

/** True when a request carries `{{var}}` placeholders a flow fills at run time. */
function hasVars(m: { url: string; headers: Record<string, string>; body?: string }): boolean {
  const re = /\{\{\s*[A-Za-z0-9_.\-]+\s*\}\}/;
  return re.test(m.url) || re.test(m.body || '') || Object.values(m.headers).some((v) => re.test(v));
}

function pascal(s: string): string {
  const out = (s || '')
    .replace(/[^A-Za-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w[0]!.toUpperCase() + w.slice(1))
    .join('');
  if (!out) return 'Api';
  // A leading digit is not a valid identifier start.
  return /^[0-9]/.test(out) ? `N${out}` : out;
}

function camel(s: string): string {
  const p = pascal(s);
  return p[0]!.toLowerCase() + p.slice(1);
}

/**
 * A method name from a scenario title, truncated on a WORD boundary.
 *
 * Slicing the camel-cased title at a fixed length cuts mid-word and ships
 * identifiers like `createPostWithTheDocumentedBodyRetur` into customer code.
 * Build from whole words instead and stop before the budget is blown.
 */
function methodNameFrom(title: string): string {
  const words = (title || '').replace(/[^A-Za-z0-9]+/g, ' ').trim().split(/\s+/).filter(Boolean);
  // Cap each word WITHOUT pascal()'s leading-digit guard — that guard belongs to
  // the identifier as a whole, and applying it per word turns "returns 200 with"
  // into "returnsN200With".
  const cap = (w: string) => w[0]!.toUpperCase() + w.slice(1);
  let out = '';
  for (const w of words) {
    const next = out ? out + cap(w) : w.toLowerCase();
    if (out && next.length > 44) break;
    out = next;
  }
  return /^[0-9]/.test(out) ? `n${out}` : out;
}

/**
 * Two cases that issue the byte-identical request share ONE method — that
 * shared definition is the reuse the pattern exists for. A case that differs in
 * any way (a dropped auth header, a malformed payload) is genuinely a different
 * request and gets its own method.
 */
function requestSignature(nc: { method: string; url: string; headers: Record<string, string>; body?: string }): string {
  return JSON.stringify([nc.method, nc.url, nc.headers, nc.body ?? null]);
}

/**
 * Group the designed cases into service objects — one per feature, mirroring
 * one page object per module on the browser side — and decide which method each
 * case calls.
 */
export function planServiceObjects(
  cases: NormalizedApiCase[],
): { plans: ServiceObjectPlan[]; bindings: Map<string, CaseBinding> } {
  const plans = new Map<string, ServiceObjectPlan>();
  const bindings = new Map<string, CaseBinding>();
  /** module → (request signature → method name) */
  const bySignature = new Map<string, Map<string, string>>();

  for (const nc of cases) {
    const module = slug(nc.feature || 'api');
    let plan = plans.get(module);
    if (!plan) {
      // Strip a trailing "Api" the feature name already carries, so a feature
      // called "Posts API" yields PostsApi and not PostsApiApi.
      const className = `${pascal(module).replace(/Api$/, '') || 'Resource'}Api`;
      plan = {
        module,
        className,
        instanceName: camel(className),
        path: `src/api/${module}/${module}.api.ts`,
        importPath: `../../src/api/${module}/${module}.api`,
        methods: [],
      };
      plans.set(module, plan);
      bySignature.set(module, new Map());
    }

    const sigs = bySignature.get(module)!;
    const bind = (req: { method: string; url: string; headers: Record<string, string>; body?: string }, title: string): string => {
      const sig = requestSignature(req);
      let methodName = sigs.get(sig);
      if (!methodName) {
        const base = methodNameFrom(title) || `${req.method.toLowerCase()}Request`;
        methodName = base;
        let n = 2;
        while (plan!.methods.some((m) => m.name === methodName)) methodName = `${base}${n++}`;
        sigs.set(sig, methodName);
        plan!.methods.push({ name: methodName, method: req.method, url: req.url, headers: req.headers, body: req.body });
      }
      return methodName;
    };

    if (nc.steps && nc.steps.length) {
      // A flow drives one method per step; the step name keeps the service
      // object readable ("createUser", "readUser", "deleteUser").
      const stepMethods = nc.steps.map((st) => bind(st, `${st.name} ${nc.feature.replace(/ flows$/i, '')}`));
      bindings.set(nc.id, { plan, methodName: stepMethods[0]!, stepMethods });
    } else {
      bindings.set(nc.id, { plan, methodName: bind(nc, nc.title) });
    }
  }

  return { plans: [...plans.values()], bindings };
}

/** Render one service object class. */
export function renderServiceObject(plan: ServiceObjectPlan): string {
  const anyVars = plan.methods.some(hasVars);
  const methods = plan.methods
    .map((m) => {
      const opts: string[] = [];
      // A request that carries {{var}} placeholders (a flow step that needs the
      // id an earlier step minted) takes a `vars` map and fills them at call
      // time; a plain request renders exactly as before.
      const dyn = hasVars(m);
      const wrap = (lit: string) => (dyn ? `fill(${lit}, vars)` : lit);
      if (Object.keys(m.headers).length) opts.push(`      headers: ${dyn ? `fillHeaders(${JSON.stringify(m.headers)}, vars)` : JSON.stringify(m.headers)}`);
      if (m.body !== undefined) opts.push(`      data: ${wrap(JSON.stringify(m.body))}`);
      const optsArg = opts.length ? `, {\n${opts.join(',\n')},\n    }` : '';
      return `  /** ${m.method} ${m.url} */\n`
        + `  async ${m.name}(${dyn ? 'vars: Vars = {}' : ''}): Promise<APIResponse> {\n`
        + `    return this.send(${JSON.stringify(m.method)}, ${wrap(JSON.stringify(m.url))}${optsArg});\n`
        + `  }`;
    })
    .join('\n\n');

  const baseImport = anyVars
    ? `import { BaseApi, fill, fillHeaders, type Vars } from '../base.api';`
    : `import { BaseApi } from '../base.api';`;
  return `import type { APIResponse } from '@playwright/test';
${baseImport}

/**
 * ${plan.className} — service object for the "${plan.module}" endpoints.
 *
 * One method per distinct request. Specs call these methods and assert on the
 * response; the URL, headers and payload live here and nowhere else.
 */
export class ${plan.className} extends BaseApi {
${methods}
}
`;
}

/* ────────────────────────────────────────────────────────────────
   Deterministic Playwright spec rendering
   ──────────────────────────────────────────────────────────────── */

/**
 * The JS expression for the ACTUAL value an assertion observed, used to build
 * the per-assertion console.log so the execution output shows not just what was
 * checked but what the endpoint actually returned. Every expression it can
 * return is already in scope wherever it is emitted: `response` always, `body`
 * whenever a jsonProperty/array check made needsJson true, `rawText` whenever a
 * bodyContains check made needsText true.
 */
function actualExpr(c: ApiCheck, inst: string): string {
  switch (c.kind) {
    case 'status':
    case 'ok':
    case 'notOk':
      return 'response.status()';
    case 'jsonProperty':
      return `getPath(body, ${jsIndex(c.path)})`;
    case 'jsonArrayNotEmpty':
      return c.path ? `getPath(body, ${jsIndex(c.path)})` : 'body';
    case 'header':
      return `String(response.headers()[${JSON.stringify(String(c.name || '').toLowerCase())}] || '')`;
    case 'bodyContains':
      return `rawText.slice(0, 200)`;
    case 'responseTimeUnderMs':
      return `${inst}.durationMs`;
    default:
      return '';
  }
}

// Exported for tests — renders a normalized case to a spec that drives its
// service object.
export function renderSpec(nc: NormalizedApiCase, binding: CaseBinding): string {
  if (nc.steps && nc.steps.length && binding.stepMethods) return renderFlowSpec(nc, binding);
  const inst = binding.plan.instanceName;
  const bodyLines: string[] = [];
  let needsJson = false;
  let needsText = false;
  for (const c of nc.checks) {
    const r = checkLines(c, inst);
    needsJson = needsJson || !!r.needsJson;
    needsText = needsText || !!r.needsText;
    // Announce each assertion before it runs, with the actual value it saw, so
    // the execution log reads as a detailed step-by-step account of the checks.
    const actual = actualExpr(c, inst);
    bodyLines.push(
      `  console.log('   ↳ assert:', ${JSON.stringify(describeCheck(c))}${actual ? `, '| actual =', ${actual}` : ''});`,
    );
    bodyLines.push(...r.lines);
  }

  const imports = [
    `import { test, expect } from '@playwright/test';`,
    `import { ${binding.plan.className} } from '${binding.plan.importPath}';`,
  ];
  // getPath is shared from the base rather than redefined at the top of every
  // spec, which is what the pre-POM renderer had to do.
  if (needsJson) imports.push(`import { getPath } from '../../src/api/base.api';`);

  const readJson = needsJson ? `  const body = await ${inst}.json(response);\n` : '';
  const readText = needsText ? `  const rawText = await ${inst}.text(response);\n` : '';

  const title = `${nc.id} — ${nc.title}`;
  const assertCount = nc.checks.length;
  return `${imports.join('\n')}

test(${JSON.stringify(title)}, async ({ request }) => {
  const ${inst} = new ${binding.plan.className}(request);

  console.log(${JSON.stringify(`\n▶ ${nc.id} — ${nc.title}`)});
  console.log('  → request:', ${JSON.stringify(`${nc.method} ${nc.url}`)});

  const response = await ${inst}.${binding.methodName}();
  console.log('  ← response:', response.status(), '·', ${inst}.durationMs + 'ms');
${readJson}${readText}
${bodyLines.join('\n')}

  console.log(${JSON.stringify(`  ✓ ${nc.id}: all ${assertCount} assertion${assertCount === 1 ? '' : 's'} passed`)});
});
`;
}

/**
 * Render a multi-step flow: every step runs in order inside ONE test, each in
 * its own `test.step`, and values a step extracts (`extract: { userId: "id" }`)
 * become `{{userId}}` for the steps after it. The service object fills the
 * placeholders; the spec only carries the assertions and the hand-over.
 */
function renderFlowSpec(nc: NormalizedApiCase, binding: CaseBinding): string {
  const inst = binding.plan.instanceName;
  const steps = nc.steps!;
  const methods = binding.stepMethods!;
  const blocks: string[] = [];
  steps.forEach((st, i) => {
    const lines: string[] = [];
    let stepJson = false;
    let stepText = false;
    for (const c of st.checks) {
      const r = checkLines(c, inst);
      stepJson = stepJson || !!r.needsJson;
      stepText = stepText || !!r.needsText;
      const actual = actualExpr(c, inst);
      lines.push(`    console.log('     ↳ assert:', ${JSON.stringify(describeCheck(c))}${actual ? `, '| actual =', ${actual}` : ''});`);
      lines.push(...r.lines.map((l) => `  ${l}`));
    }
    const extracts = Object.entries(st.extract || {});
    if (extracts.length) stepJson = true;
    const dyn = hasVars(st);
    const readJson = stepJson ? `    const body = await ${inst}.json(response);\n` : '';
    const readText = stepText ? `    const rawText = await ${inst}.text(response);\n` : '';
    const extractLines = extracts.map(([k, p]) =>
      `    vars[${JSON.stringify(k)}] = String(getPath(body, ${JSON.stringify(p)}) ?? '');\n` +
      `    expect(vars[${JSON.stringify(k)}], ${JSON.stringify(`step ${i + 1} must yield "${k}" from "${p}"`)}).not.toBe('');\n` +
      `    console.log('     ↳ extract:', ${JSON.stringify(`${k} = `)} + vars[${JSON.stringify(k)}]);`).join('\n');
    blocks.push(`  await test.step(${JSON.stringify(`${i + 1}. ${st.name} — ${st.method} ${st.url}`)}, async () => {
    console.log('  → step ${i + 1}:', ${JSON.stringify(`${st.name} · ${st.method} ${st.url}`)});
    const response = await ${inst}.${methods[i]}(${dyn ? 'vars' : ''});
    console.log('  ← response:', response.status(), '·', ${inst}.durationMs + 'ms');
${readJson}${readText}${lines.join('\n')}${extractLines ? `\n${extractLines}` : ''}
  });`);
  });
  const imports = [
    `import { test, expect } from '@playwright/test';`,
    `import { ${binding.plan.className} } from '${binding.plan.importPath}';`,
    `import { getPath, type Vars } from '../../src/api/base.api';`,
  ];
  const title = `${nc.id} — ${nc.title}`;
  const assertCount = steps.reduce((n, st) => n + st.checks.length, 0);
  return `${imports.join('\n')}

// @flow ${steps.length} steps — values extracted by one step feed the next.
test(${JSON.stringify(title)}, async ({ request }) => {
  const ${inst} = new ${binding.plan.className}(request);
  const vars: Vars = {};

  console.log(${JSON.stringify(`\n▶ ${nc.id} — ${nc.title}`)});

${blocks.join('\n\n')}

  console.log(${JSON.stringify(`  ✓ ${nc.id}: all ${assertCount} assertion${assertCount === 1 ? '' : 's'} across ${steps.length} steps passed`)});
});
`;
}

/**
 * Human-readable steps for the test-case table, derived from request + checks.
 *
 * Every step carries its OWN concrete expected result — the send step says what
 * the endpoint should return, and each assertion step states the specific
 * outcome it verifies (never a generic "assertion holds"). This is what the API
 * Automation UI renders as the step-by-step / expected-result pairs.
 */
function stepsFor(nc: NormalizedApiCase): { testSteps: TestStep[]; steps: string[] } {
  const testSteps: TestStep[] = [];

  if (nc.steps && nc.steps.length) {
    let n = 1;
    nc.steps.forEach((st, i) => {
      const extracts = Object.entries(st.extract || {});
      testSteps.push({
        step: n++,
        action: `Step ${i + 1} (${st.name}): send ${st.method} ${st.url}${st.body ? ' with the step\'s JSON body' : ''}${/\{\{/.test(st.url + (st.body || '')) ? ', filling {{…}} from earlier steps' : ''}.`,
        expected: `${st.checks.map(expectedForCheck).join(' ')}${extracts.length ? ` Captures ${extracts.map(([k, p]) => `"${k}" from "${p}"`).join(', ')} for the following steps.` : ''}`,
        testData: st.body || undefined,
      });
    });
    return { testSteps, steps: testSteps.map((s) => `${s.step}. ${s.action} → Expected: ${s.expected}`) };
  }

  const authNote = nc.headers['Authorization'] || nc.headers['X-API-Key']
    ? ' including the configured authorization header'
    : '';
  const bodyNote = nc.body ? ' carrying the JSON request body shown above' : '';
  testSteps.push({
    step: 1,
    action: `Send an HTTP ${nc.method} request to ${nc.url}${bodyNote}${authNote}.`,
    expected: `The endpoint accepts the request and returns an HTTP response — status code, headers and body — that the assertions below validate.`,
    testData: nc.body || undefined,
  });

  let n = 2;
  for (const c of nc.checks) {
    testSteps.push({
      step: n++,
      action: `Assert that ${describeCheck(c)}.`,
      expected: expectedForCheck(c),
    });
  }

  const steps = testSteps.map((s) => `${s.step}. ${s.action} → Expected: ${s.expected}`);
  return { testSteps, steps };
}

/**
 * The concrete, per-step expected result for a single assertion — the exact
 * outcome that step proves, phrased as a full sentence for the report and the
 * test-case export.
 */
function expectedForCheck(c: ApiCheck): string {
  switch (c.kind) {
    case 'status':
      if (typeof c.equals === 'number') return `The response status code is exactly ${c.equals}.`;
      if (Array.isArray(c.oneOf) && c.oneOf.length) return `The response status code is one of ${c.oneOf.join(', ')}.`;
      if (typeof c.lessThan === 'number') return `The response status code is below ${c.lessThan}.`;
      return 'The response status code is in the 2xx success range.';
    case 'ok': return 'The response status code is in the 2xx success range.';
    case 'notOk': return 'The response status code is a non-2xx error, as this negative case expects.';
    case 'jsonProperty': {
      const p = c.path || 'the response root';
      if ('value' in c && c.value !== undefined) return `The JSON field "${p}" is present and equals ${JSON.stringify(c.value)}.`;
      if (c.type) return `The JSON field "${p}" is present and is of type ${c.type}.`;
      return `The JSON field "${p}" is present in the response body.`;
    }
    case 'jsonArrayNotEmpty':
      return `The ${c.path ? `"${c.path}" field` : 'response body'} is an array containing at least one item.`;
    case 'header':
      return c.contains
        ? `The "${c.name}" response header is present and contains "${c.contains}".`
        : `The "${c.name}" response header is present on the response.`;
    case 'bodyContains': return `The response body contains the text "${c.text}".`;
    case 'responseTimeUnderMs': return `The endpoint responds in under ${c.ms} ms.`;
    default: return 'The assertion holds.';
  }
}

function describeCheck(c: ApiCheck): string {
  switch (c.kind) {
    case 'status':
      if (typeof c.equals === 'number') return `response status is ${c.equals}`;
      if (Array.isArray(c.oneOf)) return `response status is one of ${c.oneOf.join(', ')}`;
      if (typeof c.lessThan === 'number') return `response status is under ${c.lessThan}`;
      return 'response is successful (2xx)';
    case 'ok': return 'response is successful (2xx)';
    case 'notOk': return 'response is an error (non-2xx)';
    case 'jsonProperty': {
      const p = c.path || 'root';
      if ('value' in c && c.value !== undefined) return `JSON "${p}" equals ${JSON.stringify(c.value)}`;
      if (c.type) return `JSON "${p}" is of type ${c.type}`;
      return `JSON "${p}" is present`;
    }
    case 'jsonArrayNotEmpty': return `JSON ${c.path ? `"${c.path}"` : 'body'} is a non-empty array`;
    case 'header': return c.contains ? `header "${c.name}" contains "${c.contains}"` : `header "${c.name}" is present`;
    case 'bodyContains': return `response body contains "${c.text}"`;
    case 'responseTimeUnderMs': return `response time is under ${c.ms} ms`;
    default: return c.kind;
  }
}

/* ────────────────────────────────────────────────────────────────
   API column data — endpoint / method / headers / params / payload /
   expected status, as shown in the API Automation test-case columns.
   ──────────────────────────────────────────────────────────────── */

/** Mask credential header values — these are displayed, exported and stored. */
function maskHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (/^(authorization|x-api-key|api-key|apikey|cookie|x-auth-token|x-signature-256)$/i.test(k) || /(secret|token|api[-_]?key|subscription-key)/i.test(k)) {
      const scheme = /^(bearer|basic)\s/i.exec(v)?.[1];
      const credential = v.replace(/^(bearer|basic)\s+/i, '');
      // An unresolved placeholder is not a secret — showing it is how the user
      // finds out WHY every authenticated call came back 401.
      if (isPlaceholderSecret(credential)) { out[k] = v; continue; }
      // Otherwise keep only the scheme (Bearer / Basic) so the reader can still
      // tell WHAT was sent — never the token itself.
      out[k] = scheme ? `${scheme} ********` : '********';
    } else {
      out[k] = v;
    }
  }
  return out;
}

/** The status code this case asserts, rendered for the column. */
function expectedStatusOf(checks: ApiCheck[]): string {
  for (const c of checks) {
    if (c.kind !== 'status') continue;
    if (typeof c.equals === 'number') return String(c.equals);
    if (Array.isArray(c.oneOf) && c.oneOf.length) return c.oneOf.join(' / ');
    if (typeof c.lessThan === 'number') return `< ${c.lessThan}`;
  }
  if (checks.some((c) => c.kind === 'notOk')) return '4xx';
  if (checks.some((c) => c.kind === 'ok')) return '2xx';
  return '';
}

function apiMetaFor(nc: NormalizedApiCase): ApiCaseMeta {
  let endpoint = nc.url;
  let queryParams = '';
  try {
    const u = new URL(nc.url);
    endpoint = `${u.origin}${u.pathname}`;
    queryParams = u.search.replace(/^\?/, '');
  } catch { /* non-parseable URL — show it whole */ }
  return {
    endpoint,
    method: nc.method,
    headers: maskHeaders(nc.headers),
    queryParams,
    requestBody: nc.body,
    expectedStatus: expectedStatusOf(nc.checks),
  };
}

function slug(s: string): string {
  return (s || 'api-test').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'api-test';
}

/* ────────────────────────────────────────────────────────────────
   Flow generation — one multi-step scenario per detected lifecycle
   ──────────────────────────────────────────────────────────────── */

/** Loose shape of a flow case the model returns; normalised by normalizeFlow. */
type RawFlowCase = {
  title?: string;
  description?: string;
  priority?: string;
  severity?: string;
  tags?: string[];
  steps?: {
    name?: string;
    request?: RawApiCase['request'];
    checks?: ApiCheck[];
    extract?: Record<string, string>;
  }[];
};

function buildFlowPrompt(flow: ApiFlow, specs: ApiSpec[], profile: ApiProfile, requirements: string): string {
  const stepSpecs = flow.steps.map((i) => specs[i]).filter((s): s is ApiSpec => !!s);
  const catalogue = stepSpecs.map((sp, i) => {
    const headers = (sp.headers || []).filter((h) => h.key?.trim()).map((h) => `${h.key}: ${h.value}`).join(', ') || '(none)';
    return `${i + 1}. ${sp.method} ${sp.url}\n   headers: ${headers}\n   auth: ${sp.auth?.type || 'none'}\n   body: ${sp.body?.trim() ? sp.body.trim().slice(0, 1200) : '(none)'}\n   expected status: ${sp.expectedStatus ?? '(infer)'}\n   sample response: ${sp.expectedResponse?.trim() ? sp.expectedResponse.trim().slice(0, 800) : '(none)'}`;
  }).join('\n\n');
  const resource = profile.resources.find((r) => r.name === flow.resource);
  return `You are a Senior API Test Engineer designing ONE end-to-end WORKFLOW test that chains several requests of the same resource, carrying real values from one step to the next. Return STRUCTURED JSON only — a deterministic renderer turns it into a Playwright request spec.

FLOW: ${flow.name}
${flow.description}
Resource: ${flow.resource}${resource?.idParam ? ` (id parameter "${resource.idParam}")` : ''}

THE ENDPOINTS INVOLVED (in the order the flow should use them):
${catalogue}

${requirements ? `Extra context from the requester:\n${requirements.slice(0, 800)}\n` : ''}
═══════════════════════════════════════════════════════════════
OUTPUT — return ONLY a JSON array containing exactly ONE flow object:
═══════════════════════════════════════════════════════════════
[
  {
    "title": "Verify the full user lifecycle: create → read → update → delete → confirm 404",
    "description": "Creates a user, reads it back by the returned id, updates it, verifies the update, deletes it and confirms it is gone.",
    "priority": "P0",
    "severity": "Critical",
    "tags": ["api", "flow", "regression"],
    "steps": [
      {
        "name": "create",
        "request": { "method": "POST", "url": "https://api.example.com/users", "headers": { "Content-Type": "application/json" }, "body": "{\\"name\\":\\"Flow User\\",\\"email\\":\\"flow.user@example.com\\"}", "includeAuth": true },
        "checks": [ { "kind": "status", "equals": 201 }, { "kind": "jsonProperty", "path": "id", "exists": true } ],
        "extract": { "userId": "id" }
      },
      {
        "name": "read",
        "request": { "method": "GET", "url": "https://api.example.com/users/{{userId}}", "includeAuth": true },
        "checks": [ { "kind": "status", "equals": 200 }, { "kind": "jsonProperty", "path": "email", "value": "flow.user@example.com" } ]
      }
    ]
  }
]

RULES:
1. Use ONLY the endpoints listed above, in a sensible order. Every step after the first may reference values extracted by earlier steps as {{name}} in its url, headers or body.
2. "extract" maps a variable name to a dotted JSON path in THAT step's response body (e.g. "id", "data.id", "items.0.id"). Extract exactly what later steps need — normally the resource id.
3. Every step MUST assert its status with { "kind": "status", "equals": N } (or oneOf), and the read-after-write steps MUST assert the fields that were written (jsonProperty with "value").
4. After a delete step, a final read of the same id should assert 404 (or the documented gone-status).
5. Use realistic, unique-looking test data in the create body; never a real secret. Reference the configured auth via includeAuth.
6. Check kinds supported: status (equals/oneOf/lessThan), ok, notOk, jsonProperty (path + exists/value/type), jsonArrayNotEmpty, header (name + contains), bodyContains, responseTimeUnderMs.
7. STRICT JSON: no comments, no trailing commas, escape quotes inside strings.

Return the JSON array now.`;
}

/** Substitute the flow's variables so a step's request can still be normalised. */
function normalizeFlow(raw: RawFlowCase, flow: ApiFlow, specs: ApiSpec[]): NormalizedApiCase | null {
  const stepsRaw = Array.isArray(raw.steps) ? raw.steps : [];
  if (stepsRaw.length < 2) return null;
  const stepSpecs = flow.steps.map((i) => specs[i]).filter((s): s is ApiSpec => !!s);
  const anchor = stepSpecs[0]!;
  const steps: FlowStep[] = [];
  stepsRaw.forEach((st, i) => {
    // Pair each step with the spec whose method+path matches best, falling back
    // to positional order, so auth/header injection uses the right contract.
    const reqMethod = String(st.request?.method || '').toUpperCase();
    const reqUrl = String(st.request?.url || '');
    const matched = stepSpecs.find((sp) => sp.method === reqMethod && samePathShape(sp.url, reqUrl)) || stepSpecs[Math.min(i, stepSpecs.length - 1)] || anchor;
    const nc = normalizeCase({ title: st.name || `step ${i + 1}`, category: 'flow', request: st.request, checks: st.checks }, matched);
    if (!nc) return;
    // normalizeCase consumed a counter id we do not want for a step.
    counter--;
    const extract: Record<string, string> = {};
    if (st.extract && typeof st.extract === 'object') {
      for (const [k, v] of Object.entries(st.extract)) {
        const key = String(k).replace(/[^A-Za-z0-9_.\-]/g, '');
        if (key && typeof v === 'string') extract[key] = v;
      }
    }
    steps.push({ name: String(st.name || `step-${i + 1}`).replace(/[^A-Za-z0-9 _-]/g, '').slice(0, 40) || `step-${i + 1}`, method: nc.method, url: nc.url, headers: nc.headers, body: nc.body, checks: nc.checks, extract });
  });
  if (steps.length < 2) return null;
  const first = steps[0]!;
  const priority: TestCase['priority'] = (VALID_PRIORITIES as string[]).includes(raw.priority || '') ? (raw.priority as TestCase['priority']) : 'P0';
  const severity = raw.severity && (VALID_SEVERITIES as string[]).includes(raw.severity) ? (raw.severity as TestCase['severity']) : 'Critical';
  return {
    id: nextId(),
    title: (raw.title || '').trim() || `Verify the ${flow.resource} lifecycle end to end (${steps.map((s) => s.name).join(' → ')})`,
    description: (raw.description || flow.description).trim(),
    feature: `${flow.resource} flows`,
    type: 'e2e',
    priority,
    severity,
    tags: Array.isArray(raw.tags) && raw.tags.length ? raw.tags.map(String) : ['api', 'flow'],
    method: first.method,
    url: first.url,
    headers: first.headers,
    body: first.body,
    checks: first.checks,
    steps,
  };
}

/** `/users/1` and `/users/{{userId}}` are the same shape. */
function samePathShape(a: string, b: string): boolean {
  const norm = (u: string) => {
    let p = u;
    try { p = new URL(u).pathname; } catch { /* keep */ }
    return p.replace(/\{\{[^}]+\}\}|\{[^}]+\}|\b\d+\b|[0-9a-f]{8}-[0-9a-f-]{27}/gi, '{id}').replace(/\/+$/, '').toLowerCase();
  };
  return norm(a) === norm(b);
}

async function generateFlows(
  profile: ApiProfile,
  specs: ApiSpec[],
  requirements: string,
  llm: ReturnType<typeof llmForStage>,
): Promise<NormalizedApiCase[]> {
  // Bounded: the biggest resources first, at most six flows per run.
  const flows = [...profile.flows].sort((a, b) => b.steps.length - a.steps.length).slice(0, 6);
  // The model calls run concurrently; normalisation (which hands out ids) runs
  // afterwards in flow order so ids stay deterministic.
  const raws = await mapWithConcurrency(flows, FLOW_CONCURRENCY, async (flow) => {
    try {
      const response = await runLLM(buildFlowPrompt(flow, specs, profile, requirements), { maxTokens: 8000, llm });
      let parsed: unknown = null;
      try { parsed = parseJsonFromResponse<unknown>(response); } catch { /* salvage */ }
      let arr = coerceJsonArray<RawFlowCase>(parsed);
      if (!arr || !arr.length) arr = salvageJsonArrayObjects<RawFlowCase>(response);
      return (arr || []).find((x) => x && typeof x === 'object' && Array.isArray((x as RawFlowCase).steps)) || null;
    } catch (err) {
      console.warn(`[apiGenerator] flow "${flow.name}" was skipped: ${(err as Error).message}`);
      return null;
    }
  });
  const out: NormalizedApiCase[] = [];
  raws.forEach((raw, i) => {
    if (!raw) return;
    const nc = normalizeFlow(raw, flows[i]!, specs);
    if (nc) out.push(nc);
  });
  return out;
}

/* ────────────────────────────────────────────────────────────────
   Concurrency
   ──────────────────────────────────────────────────────────────── */
/**
 * One model call per endpoint, run sequentially, made a 60-endpoint catalogue
 * take 15–20 minutes — past every HTTP timeout in the chain. The calls are
 * independent, so they run in a bounded pool instead: ENDPOINT_CONCURRENCY at
 * a time keeps well inside the API rate limits while cutting wall-clock by the
 * same factor. Results come back in input order.
 */
const ENDPOINT_CONCURRENCY = Math.max(1, Math.min(8, Number(process.env.API_GEN_CONCURRENCY) || 4));
const FLOW_CONCURRENCY = 3;

async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]!, i);
    }
  });
  await Promise.all(workers);
  return results;
}

/* ────────────────────────────────────────────────────────────────
   Agent entry
   ──────────────────────────────────────────────────────────────── */
/**
 * Ask the model for one endpoint's raw cases, retrying once when the first
 * reply is not a parseable JSON array.
 */
async function generateRawForSpec(
  spec: ApiSpec,
  requirements: string,
  llm: ReturnType<typeof llmForStage>,
  opts: { context?: string; layers?: Set<LayerId> },
): Promise<{ raw: RawApiCase[]; lastHead: string }> {
  let raw: RawApiCase[] = [];
  let lastHead = '';
  for (let attempt = 1; attempt <= 2 && raw.length === 0; attempt++) {
    const prompt = attempt === 1
      ? buildApiPrompt(spec, requirements, opts)
      : buildApiPrompt(spec, requirements, opts) +
        '\n\nIMPORTANT: your previous reply was not a parseable JSON array. Return ONLY the raw JSON array — starting with [ and ending with ] — no wrapper object, no markdown, no commentary.';
    const response = await runLLM(prompt, { maxTokens: 32000, llm });
    raw = extractCases(response);
    if (raw.length === 0) lastHead = response.slice(0, 400).replace(/\s+/g, ' ').trim();
  }
  return { raw, lastHead };
}

export async function apiGeneratorAgent(state: TestOpsState): Promise<TestOpsState> {
  // One or many endpoints: the multi-endpoint list wins when present, otherwise
  // the single apiSpec. Every endpoint is generated, then ALL cases share one
  // planning + rendering pass, so test-case ids and service-object paths stay
  // collision-free across endpoints.
  const specs: ApiSpec[] = (state.apiSpecs && state.apiSpecs.length)
    ? state.apiSpecs
    : (state.apiSpec ? [state.apiSpec] : []);
  if (specs.length === 0) return state;
  counter = 0;

  // Understand the surface first. The profile is recomputed over exactly the
  // specs being generated (deterministic and cheap), so its indices always line
  // up with `specs` regardless of what subset the client selected.
  const profile = analyzeApiSurface(specs as unknown as ImportedEndpoint[]);
  const layers = new Set<LayerId>(
    (Array.isArray(state.apiLayers) && state.apiLayers.length ? state.apiLayers : ALL_LAYERS).filter((l): l is LayerId => (ALL_LAYERS as string[]).includes(l)),
  );
  const insights: string[] = Array.isArray(state.apiProfile?.insights) ? state.apiProfile!.insights.map(String) : [];
  const insightBlock = insights.length ? `\nARCHITECT INSIGHTS (from the AI review of the whole API):\n${insights.slice(0, 6).map((i) => `- ${i}`).join('\n')}` : '';

  const llm = llmForStage(state.llm, 'generator');
  const normalized: NormalizedApiCase[] = [];
  const failedEndpoints: string[] = [];
  let lastHead = '';
  const progress = state.onProgress;
  const flowCount = layers.has('flow') ? Math.min(profile.flows.length, 6) : 0;
  let done = 0;
  progress?.({ phase: 'design', done: 0, total: specs.length, flows: flowCount, message: `Designing coverage for ${specs.length} endpoint${specs.length === 1 ? '' : 's'}` });

  // Every endpoint's model call runs in the pool; a failure on one endpoint
  // never sinks the run — it is reported and skipped.
  const results = await mapWithConcurrency(specs, ENDPOINT_CONCURRENCY, async (spec, i) => {
    const context = profileContextFor(profile, specs as unknown as ImportedEndpoint[], i) + insightBlock;
    try {
      return await generateRawForSpec(spec, state.requirements || '', llm, { context, layers });
    } catch (err) {
      console.warn(`[apiGenerator] ${spec.method} ${spec.url}: ${(err as Error).message}`);
      return { raw: [] as RawApiCase[], lastHead: `error: ${(err as Error).message}` };
    } finally {
      done++;
      progress?.({ phase: 'design', done, total: specs.length, flows: flowCount, message: `${done}/${specs.length} endpoints designed` });
    }
  });
  // Normalise in input order so TC ids are stable regardless of which call
  // finished first.
  results.forEach(({ raw, lastHead: head }, i) => {
    const spec = specs[i]!;
    if (raw.length === 0) {
      if (head) lastHead = head;
      failedEndpoints.push(spec.url);
      return;
    }
    for (const r of raw) {
      const nc = normalizeCase(r, spec);
      if (nc) normalized.push(nc);
    }
  });

  if (normalized.length === 0) {
    throw new Error(
      `API test generation produced no cases — the model's response was not a usable JSON array. ` +
      `Response started with: "${lastHead.slice(0, 200)}". Check the configured model in System Configuration → LLM Configuration and try again.`,
    );
  }
  if (failedEndpoints.length) {
    console.warn(`[apiGenerator] ${failedEndpoints.length} endpoint(s) produced no cases and were skipped: ${failedEndpoints.slice(0, 5).join(', ')}${failedEndpoints.length > 5 ? '…' : ''}`);
  }

  // Multi-step flows for every create → read → update → delete chain the
  // analysis found — the workflow tests a per-endpoint suite cannot express.
  if (layers.has('flow') && profile.flows.length) {
    progress?.({ phase: 'flows', done: specs.length, total: specs.length, flows: flowCount, message: `Designing ${flowCount} lifecycle flow${flowCount === 1 ? '' : 's'}` });
    const flows = await generateFlows(profile, specs, state.requirements || '', llm);
    normalized.push(...flows);
  }
  progress?.({ phase: 'render', done: specs.length, total: specs.length, flows: flowCount, message: `Rendering ${normalized.length} request specs` });

  // Plan the service objects BEFORE rendering: every spec needs to know which
  // class it drives and which method it calls.
  const { plans, bindings } = planServiceObjects(normalized);
  const pageObjects: PageObjectFile[] = plans.map((plan) => ({
    path: plan.path,
    className: plan.className,
    module: plan.module,
    methods: plan.methods.map((m) => `${m.name}(${hasVars(m) ? 'vars' : ''}): Promise<APIResponse>  // ${m.method} ${m.url}`),
    code: renderServiceObject(plan),
  }));

  const testCases: TestCase[] = [];
  const automationScripts: AutomationScript[] = [];
  const usedNames = new Set<string>();
  for (const nc of normalized) {
    const { testSteps, steps } = stepsFor(nc);
    const checkCount = nc.steps ? nc.steps.reduce((n, st) => n + st.checks.length, 0) : nc.checks.length;
    const checkList = nc.steps ? nc.steps.map((st) => `${st.name}: ${st.checks.map(describeCheck).join(', ')}`).join('; ') : nc.checks.map(describeCheck).join('; ');
    testCases.push({
      id: nc.id,
      traceabilityId: nc.steps ? 'API-FLOW' : `API-${nc.method}`,
      module: 'API',
      submodule: nc.feature,
      feature: nc.feature,
      title: nc.title,
      scenario: nc.title,
      description: nc.description,
      precondition: nc.steps
        ? `The ${nc.steps.length} endpoints in this flow are reachable and the environment allows creating and deleting ${nc.feature.replace(/ flows$/, '')} records.`
        : `The API endpoint ${nc.url} is reachable from the test environment.`,
      testSteps,
      steps,
      expectedResult: `All ${checkCount} assertion${checkCount === 1 ? '' : 's'} pass — ${checkList}.`,
      type: nc.type,
      priority: nc.priority,
      severity: nc.severity,
      tags: nc.tags,
      api: apiMetaFor(nc),
      status: 'generated',
    });

    // Deterministic, self-contained Playwright request spec. The filename is
    // built to be clear and traceable: the test-case id, the HTTP method, then a
    // short slug of the title with any duplicate method word dropped — e.g.
    // `tc-003-post-reject-missing-email.spec.ts`.
    const titleSlug = slug(nc.title)
      .split('-')
      .filter((w) => w && w !== nc.method.toLowerCase())
      .slice(0, 6)
      .join('-');
    const base = nc.steps
      ? `${nc.id.toLowerCase()}-flow${titleSlug ? `-${titleSlug}` : ''}`
      : `${nc.id.toLowerCase()}-${nc.method.toLowerCase()}${titleSlug ? `-${titleSlug}` : ''}`;
    let name = `${base}.spec.ts`;
    let k = 2;
    while (usedNames.has(name)) name = `${base}-${k++}.spec.ts`;
    usedNames.add(name);
    const binding = bindings.get(nc.id)!;
    automationScripts.push({
      testCaseId: nc.id,
      fileName: name,
      path: `tests/api/${name}`,
      code: renderSpec(nc, binding),
      // The service object this spec imports — the execution workspace writes
      // it, and the publish step commits it alongside the spec.
      uses: [binding.plan.path],
    });
  }

  return { ...state, testCases, automationScripts, pageObjects, apiProfile: { ...(state.apiProfile || {}), ...profile } };
}
