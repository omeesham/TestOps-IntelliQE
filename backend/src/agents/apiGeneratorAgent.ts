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

let counter = 0;
function nextId() { return `TC-${String(++counter).padStart(3, '0')}`; }

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
}

const VALID_PRIORITIES: TestCase['priority'][] = ['P0', 'P1', 'P2', 'P3'];
const VALID_SEVERITIES: NonNullable<TestCase['severity']>[] = ['Critical', 'Major', 'Moderate', 'Minor'];

/* ────────────────────────────────────────────────────────────────
   Prompt
   ──────────────────────────────────────────────────────────────── */
function buildApiPrompt(state: TestOpsState): string {
  const spec = state.apiSpec!;
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
${(state.requirements || '').slice(0, 1200)}

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
3. Give each case a title that names the scenario and its expectation, e.g. "Reject POST /users when the email field is missing (400)". No two titles may be near-duplicates — merge cases that would assert the same thing.
4. Paths use dot notation with array indices, e.g. "data.0.email". "" means the JSON root.
5. NEVER put real secrets in the JSON. Reference the configured auth via includeAuth — the renderer injects the actual token.
6. A negative case must assert a SPECIFIC expectation ("status" with equals/oneOf, or "notOk") — never assert "ok" on a case designed to fail.
7. STRICT JSON: literals only — no comments, no trailing commas, no code expressions. Escape quotes inside strings.

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
  if (a.type === 'apikey') return { name: 'X-API-Key', value: v };
  return null;
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
    for (const k of Object.keys(headers)) {
      if (k.toLowerCase() === 'authorization' || k.toLowerCase() === 'x-api-key') delete headers[k];
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
    : 'api';

  const priority: TestCase['priority'] = (VALID_PRIORITIES as string[]).includes(raw.priority || '')
    ? (raw.priority as TestCase['priority']) : 'P1';
  const severity = raw.severity && (VALID_SEVERITIES as string[]).includes(raw.severity)
    ? (raw.severity as TestCase['severity']) : undefined;

  return {
    id: nextId(),
    title: (raw.title || raw.scenario || `${method} ${url}`).trim(),
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
function requestSignature(nc: NormalizedApiCase): string {
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
    const sig = requestSignature(nc);
    let methodName = sigs.get(sig);
    if (!methodName) {
      const base = methodNameFrom(nc.title) || `${nc.method.toLowerCase()}Request`;
      methodName = base;
      let n = 2;
      while (plan.methods.some((m) => m.name === methodName)) methodName = `${base}${n++}`;
      sigs.set(sig, methodName);
      plan.methods.push({ name: methodName, method: nc.method, url: nc.url, headers: nc.headers, body: nc.body });
    }
    bindings.set(nc.id, { plan, methodName });
  }

  return { plans: [...plans.values()], bindings };
}

/** Render one service object class. */
export function renderServiceObject(plan: ServiceObjectPlan): string {
  const methods = plan.methods
    .map((m) => {
      const opts: string[] = [];
      if (Object.keys(m.headers).length) opts.push(`      headers: ${JSON.stringify(m.headers)}`);
      if (m.body !== undefined) opts.push(`      data: ${JSON.stringify(m.body)}`);
      const optsArg = opts.length ? `, {\n${opts.join(',\n')},\n    }` : '';
      return `  /** ${m.method} ${m.url} */\n`
        + `  async ${m.name}(): Promise<APIResponse> {\n`
        + `    return this.send(${JSON.stringify(m.method)}, ${JSON.stringify(m.url)}${optsArg});\n`
        + `  }`;
    })
    .join('\n\n');

  return `import type { APIResponse } from '@playwright/test';
import { BaseApi } from '../base.api';

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

// Exported for tests — renders a normalized case to a spec that drives its
// service object.
export function renderSpec(nc: NormalizedApiCase, binding: CaseBinding): string {
  const inst = binding.plan.instanceName;
  const bodyLines: string[] = [];
  let needsJson = false;
  let needsText = false;
  for (const c of nc.checks) {
    const r = checkLines(c, inst);
    needsJson = needsJson || !!r.needsJson;
    needsText = needsText || !!r.needsText;
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
  return `${imports.join('\n')}

test(${JSON.stringify(title)}, async ({ request }) => {
  const ${inst} = new ${binding.plan.className}(request);

  const response = await ${inst}.${binding.methodName}();
${readJson}${readText}
${bodyLines.join('\n')}
});
`;
}

/** Human-readable steps for the test-case table, derived from request + checks. */
function stepsFor(nc: NormalizedApiCase): { testSteps: TestStep[]; steps: string[] } {
  const testSteps: TestStep[] = [];
  testSteps.push({
    step: 1,
    action: `Send an HTTP ${nc.method} request to ${nc.url}${nc.body ? ' with the JSON request body' : ''}`,
    expected: 'The API returns a response',
  });
  let n = 2;
  for (const c of nc.checks) {
    testSteps.push({ step: n++, action: `Assert: ${describeCheck(c)}`, expected: 'Assertion holds' });
  }
  const steps = testSteps.map((s) => `${s.step}. ${s.action} → Expected: ${s.expected}`);
  return { testSteps, steps };
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
    if (/^(authorization|x-api-key|api-key|cookie|x-auth-token)$/i.test(k)) {
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
   Agent entry
   ──────────────────────────────────────────────────────────────── */
export async function apiGeneratorAgent(state: TestOpsState): Promise<TestOpsState> {
  if (!state.apiSpec) return state;
  counter = 0;

  const llm = llmForStage(state.llm, 'generator');
  let raw: RawApiCase[] = [];
  let lastHead = '';
  for (let attempt = 1; attempt <= 2 && raw.length === 0; attempt++) {
    const prompt = attempt === 1
      ? buildApiPrompt(state)
      : buildApiPrompt(state) +
        '\n\nIMPORTANT: your previous reply was not a parseable JSON array. Return ONLY the raw JSON array — starting with [ and ending with ] — no wrapper object, no markdown, no commentary.';
    const response = await runLLM(prompt, { maxTokens: 32000, llm });
    raw = extractCases(response);
    if (raw.length === 0) lastHead = response.slice(0, 400).replace(/\s+/g, ' ').trim();
  }

  if (raw.length === 0) {
    throw new Error(
      `API test generation produced no cases after 2 attempts — the model's response was not a usable JSON array. ` +
      `Response started with: "${lastHead.slice(0, 200)}". Check the configured model in System Configuration → LLM Configuration and try again.`,
    );
  }

  const normalized = raw
    .map((r) => normalizeCase(r, state.apiSpec!))
    .filter((n): n is NormalizedApiCase => n !== null);

  // Plan the service objects BEFORE rendering: every spec needs to know which
  // class it drives and which method it calls.
  const { plans, bindings } = planServiceObjects(normalized);
  const pageObjects: PageObjectFile[] = plans.map((plan) => ({
    path: plan.path,
    className: plan.className,
    module: plan.module,
    methods: plan.methods.map((m) => `${m.name}(): Promise<APIResponse>  // ${m.method} ${m.url}`),
    code: renderServiceObject(plan),
  }));

  const testCases: TestCase[] = [];
  const automationScripts: AutomationScript[] = [];
  const usedNames = new Set<string>();
  for (const nc of normalized) {
    const { testSteps, steps } = stepsFor(nc);
    testCases.push({
      id: nc.id,
      traceabilityId: `API-${nc.method}`,
      module: 'API',
      submodule: nc.feature,
      feature: nc.feature,
      title: nc.title,
      scenario: nc.title,
      description: nc.description,
      precondition: `The API endpoint ${nc.url} is reachable from the test environment.`,
      testSteps,
      steps,
      expectedResult: nc.checks.map(describeCheck).join('; '),
      type: nc.type,
      priority: nc.priority,
      severity: nc.severity,
      tags: nc.tags,
      api: apiMetaFor(nc),
      status: 'generated',
    });

    // Deterministic, self-contained Playwright request spec.
    let base = `${slug(`${nc.method}-${nc.title}`)}`;
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

  return { ...state, testCases, automationScripts, pageObjects };
}
