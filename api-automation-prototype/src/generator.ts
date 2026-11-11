/**
 * generator.ts — the AI design stage.
 *
 * Ported and trimmed from backend/src/agents/apiGeneratorAgent.ts. It:
 *   1. Builds a prompt that asks the model to DESIGN a suite of test cases as
 *      STRUCTURED JSON — using ONLY the closed ApiCheck set — and tells it
 *      plainly it does NOT write code.
 *   2. Parses the response defensively (salvages a JSON array even when wrapped
 *      in prose) and normalizes each case: resolve absolute URL, merge headers,
 *      inject/strip auth per `includeAuth`, attach body for write methods,
 *      guarantee ≥1 assertion, assign an id, map category → type.
 *
 * The model's output is DATA. It never becomes code. That is the invariant.
 */
import type { ApiSpec, ApiCheck, NormalizedCase, CaseCategory } from './types';
import { callModel } from './llm';

let counter = 0;
function nextId(): string {
  return `TC-${String(++counter).padStart(3, '0')}`;
}
/** Test-only: reset the id counter so fixtures are stable. */
export function resetIds(): void {
  counter = 0;
}

/* ────────────────────────────── Prompt ────────────────────────────── */

export function buildPrompt(spec: ApiSpec): string {
  const headerLines =
    (spec.headers || [])
      .filter((h) => h.key?.trim())
      .map((h) => `  ${h.key}: ${h.value}`)
      .join('\n') || '  (none)';
  const authLine =
    !spec.auth || spec.auth.type === 'none'
      ? 'None'
      : `${spec.auth.type}${spec.auth.value ? ' (a value is configured — set includeAuth, never invent a token)' : ''}`;
  const coverage = spec.coverage || 'standard';
  const depth =
    coverage === 'essential'
      ? 'ESSENTIAL — the critical path only. Target 4–6 cases.'
      : coverage === 'exhaustive'
        ? 'EXHAUSTIVE — every validation angle that applies. Target 16–28 cases.'
        : 'STANDARD — a professional regression suite. Target 10–16 cases.';

  return `You are a Senior API Test Engineer. Design a FOCUSED, professional suite of HTTP test cases for the single endpoint below. Return STRUCTURED JSON ONLY — you do NOT write code; a deterministic renderer turns your JSON into runnable test specs.

ENDPOINT UNDER TEST
  Method: ${spec.method}
  URL: ${spec.url}
  Headers:
${headerLines}
  Authorization: ${authLine}
  Request body (write methods): ${spec.body?.trim() ? spec.body.trim().slice(0, 2000) : '(none)'}
  Expected HTTP status (the happy path MUST assert exactly this): ${spec.expectedStatus ?? '(infer from the method)'}
  Expected/sample response body: ${spec.expectedResponse?.trim() ? spec.expectedResponse.trim().slice(0, 2000) : '(not provided)'}

DEPTH: ${depth}

OUTPUT — return ONLY a JSON array (no markdown, no prose):
[
  {
    "title": "Verify GET /posts/1 returns 200 with the expected post schema",
    "description": "Confirms the endpoint responds successfully and the body carries the documented fields.",
    "feature": "Posts API",
    "category": "positive",            // positive | negative | auth | schema | edge
    "request": {
      "method": "GET",
      "url": "${spec.url}",            // ABSOLUTE url for this case; vary it for negative cases
      "headers": { "Accept": "application/json" },
      "body": null,                     // JSON string for POST/PUT/PATCH, else null
      "includeAuth": true               // false ONLY for a deliberate no-auth negative case
    },
    "checks": [
      { "kind": "status", "equals": 200 },
      { "kind": "header", "name": "content-type", "contains": "application/json" },
      { "kind": "jsonProperty", "path": "id", "type": "number" }
    ]
  }
]

CHECK TYPES — use ONLY these (the renderer supports exactly this set):
- { "kind": "status", "equals": 200 }        // or "oneOf": [200,201], or "lessThan": 500
- { "kind": "ok" }                            // response is 2xx
- { "kind": "notOk" }                         // response is NOT 2xx (negative cases)
- { "kind": "jsonProperty", "path": "data.0.id", "exists": true }
- { "kind": "jsonProperty", "path": "userId", "value": 1 }
- { "kind": "jsonProperty", "path": "title", "type": "string" }   // string|number|boolean|array|object
- { "kind": "jsonArrayNotEmpty", "path": "" }                     // "" = the body itself is a non-empty array
- { "kind": "header", "name": "content-type", "contains": "json" }
- { "kind": "bodyContains", "text": "some substring" }
- { "kind": "responseTimeUnderMs", "ms": 5000 }

SCENARIO COVERAGE — work through every row that applies:
  CONTRACT  — happy path (assert the EXACT expected status + content-type); response schema (each key field: existence AND type).
  NEGATIVE  — unknown resource (an id that cannot exist → 404); malformed path/query (a non-numeric id where a number is required → 4xx).
  BOUNDARY  — numeric id / pagination edges (0, negative, huge) → a clean 4xx or safely clamped 2xx, never 500.
  AUTH      — ONLY when Authorization is configured: valid credential → expected 2xx; no credential (includeAuth false) → 401/403.
  PAYLOAD   — write methods only: missing required field → 4xx; malformed JSON → 400.

RULES:
1. Ground EVERY case in the real endpoint above. Do not invent unrelated endpoints or fields.
2. Every case must be independently runnable — no shared state, no ordering between cases.
3. Titles are specific, full sentences naming the action, the variation, and the expected status code. Never "Test case 1" or a bare "METHOD url".
4. Paths use dot notation with array indices, e.g. "data.0.email". "" means the JSON root.
5. NEVER put real secrets in the JSON. Reference configured auth via includeAuth — the renderer injects the token.
6. A negative case asserts a SPECIFIC expectation ("status" with equals/oneOf, or "notOk") — never "ok" on a case designed to fail.
7. STRICT JSON: literals only — no comments in your output, no trailing commas, no code expressions.

Generate the JSON array now.`;
}

/* ─────────────────────── Parse + normalize ─────────────────────── */

type RawCase = {
  title?: string;
  description?: string;
  feature?: string;
  category?: string;
  request?: {
    method?: string;
    url?: string;
    path?: string;
    headers?: Record<string, string> | { key: string; value: string }[];
    body?: string | object | null;
    includeAuth?: boolean;
  };
  checks?: ApiCheck[];
};

/** Defensively extract a JSON array of cases from a model response. */
export function extractCases(response: string): RawCase[] {
  const tryParse = (s: string): unknown => {
    try {
      return JSON.parse(s);
    } catch {
      return undefined;
    }
  };
  // 1. Whole response is JSON.
  let parsed = tryParse(response.trim());
  // 2. Strip a ```json fence.
  if (parsed === undefined) {
    const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(response);
    if (fence) parsed = tryParse(fence[1]!.trim());
  }
  // 3. Grab the first [ … ] block.
  if (parsed === undefined) {
    const first = response.indexOf('[');
    const last = response.lastIndexOf(']');
    if (first !== -1 && last > first) parsed = tryParse(response.slice(first, last + 1));
  }
  const arr = Array.isArray(parsed) ? parsed : [];
  return arr.filter(
    (e): e is RawCase =>
      !!e && typeof e === 'object' && !Array.isArray(e) && ('title' in e || 'request' in e || 'checks' in e),
  );
}

function normalizeHeaders(h: RawCase['request'] extends undefined ? never : NonNullable<RawCase['request']>['headers']): Record<string, string> {
  const out: Record<string, string> = {};
  if (Array.isArray(h)) {
    for (const p of h) if (p && p.key) out[String(p.key)] = String(p.value ?? '');
  } else if (h && typeof h === 'object') {
    for (const [k, v] of Object.entries(h)) if (k) out[k] = String(v ?? '');
  }
  return out;
}

function b64(s: string): string {
  return Buffer.from(s, 'utf-8').toString('base64');
}

/** The auth header the user configured, or null. Secrets live here, never in the model's JSON. */
function authHeader(spec: ApiSpec): { name: string; value: string } | null {
  const a = spec.auth;
  if (!a || a.type === 'none' || !a.value?.trim()) return null;
  const v = a.value.trim();
  if (a.type === 'bearer') return { name: 'Authorization', value: `Bearer ${v}` };
  if (a.type === 'basic') return { name: 'Authorization', value: `Basic ${b64(v)}` };
  if (a.type === 'apikey') return { name: a.headerName?.trim() || 'X-API-Key', value: v };
  return null;
}

const VALID_CATEGORIES: CaseCategory[] = ['positive', 'negative', 'auth', 'schema', 'edge'];

export function normalizeCase(raw: RawCase, spec: ApiSpec): NormalizedCase | null {
  const req = raw.request || {};
  const method = String(req.method || spec.method || 'GET').toUpperCase();

  // Resolve the URL: absolute wins; else baseUrl + path; else the spec url.
  let url = typeof req.url === 'string' && req.url.trim() ? req.url.trim() : '';
  if (!url) {
    if (typeof req.path === 'string' && req.path.trim() && spec.baseUrl) {
      url = spec.baseUrl.replace(/\/+$/, '') + '/' + req.path.trim().replace(/^\/+/, '');
    } else {
      url = spec.url;
    }
  }
  if (!/^https?:\/\//i.test(url)) return null; // never emit a non-absolute URL

  // Merge headers: the spec's global headers first, then the case overrides.
  const headers: Record<string, string> = {};
  for (const h of spec.headers || []) if (h.key?.trim()) headers[h.key.trim()] = String(h.value ?? '');
  Object.assign(headers, normalizeHeaders(req.headers));

  // Inject configured auth unless this case opts out (negative-auth test).
  const includeAuth = req.includeAuth !== false;
  if (includeAuth) {
    const ah = authHeader(spec);
    if (ah && !Object.keys(headers).some((k) => k.toLowerCase() === ah.name.toLowerCase())) headers[ah.name] = ah.value;
  } else {
    const apiKeyHeader = (spec.auth?.headerName || 'x-api-key').toLowerCase();
    for (const k of Object.keys(headers)) {
      const lk = k.toLowerCase();
      if (lk === 'authorization' || lk === 'x-api-key' || lk === apiKeyHeader) delete headers[k];
    }
  }

  // Body only for write methods.
  let body: string | undefined;
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
    const b = req.body;
    if (typeof b === 'string' && b.trim()) body = b;
    else if (b && typeof b === 'object') body = JSON.stringify(b);
    else if (spec.body?.trim() && (raw.category || '').toLowerCase() !== 'negative') body = spec.body;
    if (body && !Object.keys(headers).some((k) => k.toLowerCase() === 'content-type')) headers['Content-Type'] = 'application/json';
  }

  const checks: ApiCheck[] = Array.isArray(raw.checks) ? raw.checks.filter((c) => c && typeof c === 'object' && c.kind) : [];
  if (checks.length === 0) checks.push({ kind: 'ok' });

  const category = (VALID_CATEGORIES as string[]).includes((raw.category || '').toLowerCase())
    ? ((raw.category || '').toLowerCase() as CaseCategory)
    : 'positive';

  return {
    id: nextId(),
    title: (raw.title || '').trim() || `${category} — ${method} ${url}`,
    description: (raw.description || '').trim() || undefined,
    feature: (raw.feature || 'API').trim(),
    category,
    method,
    url,
    headers,
    body,
    checks,
  };
}

/* ─────────────────────── Top-level generate ─────────────────────── */

/** Derive baseUrl (scheme + host) from the spec url if not already set. */
function withBaseUrl(spec: ApiSpec): ApiSpec {
  if (spec.baseUrl) return spec;
  try {
    const u = new URL(spec.url);
    return { ...spec, baseUrl: `${u.protocol}//${u.host}` };
  } catch {
    return spec;
  }
}

/**
 * Design a suite for one endpoint: one model call → typed JSON → NormalizedCase[].
 * Throws a clear error if no model credentials are configured.
 */
export async function generate(rawSpec: ApiSpec): Promise<NormalizedCase[]> {
  const spec = withBaseUrl(rawSpec);
  const text = await callModel(buildPrompt(spec));
  const rawCases = extractCases(text);
  const cases: NormalizedCase[] = [];
  for (const rc of rawCases) {
    const nc = normalizeCase(rc, spec);
    if (nc) cases.push(nc);
  }
  return cases;
}
