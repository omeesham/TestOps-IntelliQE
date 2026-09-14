/**
 * api-spec-parser.service.ts
 * ──────────────────────────
 * Turns an uploaded API description — in ANY format (OpenAPI/Swagger JSON or
 * YAML, a Postman collection, a WSDL/XML contract, an Excel/CSV table, a PDF or
 * Word API doc, a cURL snippet, or free-form text) — into the SAME structured
 * shape the chat "API Configuration" form produces.
 *
 * A single document usually describes MANY endpoints (an OpenAPI paths object, a
 * Postman collection's requests, one row per API in a spreadsheet). We extract
 * ALL of them so the user can pick which one to automate; the frontend fills the
 * card from the chosen endpoint. When only one is found we still return a
 * one-element list — the caller treats "one endpoint" as "auto-fill".
 *
 * "Understanding" is delegated to the tenant's configured Claude model: the raw
 * document text (already extracted by document-parser.service) is handed to the
 * LLM, which returns normalised endpoints. This is what lets a single code path
 * accept every format the user throws at it without a per-format parser.
 */
import { runLLM, parseJsonFromResponse, coerceJsonArray, salvageJsonArrayObjects, type LlmConfig } from '../agents/claude-runner.js';
import { cleanAuthValue, isPlaceholderSecret } from '../utils/api-auth.js';

export interface ParsedApiSpec {
  /** Short human label for the endpoint picker, e.g. "GET /users/{id} — Get user". */
  title: string;
  method: string;
  url: string;
  headers: { key: string; value: string }[];
  auth: { type: 'none' | 'bearer' | 'basic' | 'apikey'; value?: string };
  body?: string;
  /** Expected success HTTP status code, when the doc states one. */
  expectedStatus?: number;
  expectedResponse?: string;
}

const VALID_METHODS = new Set(['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS']);
const VALID_AUTH = new Set(['none', 'bearer', 'basic', 'apikey']);
const MAX_ENDPOINTS = 60;

/** Loose shape the model is asked to return; normalised into ParsedApiSpec. */
interface RawSpec {
  title?: string;
  summary?: string;
  name?: string;
  method?: string;
  url?: string;
  headers?: unknown;
  auth?: { type?: string; value?: string };
  body?: unknown;
  expectedStatus?: unknown;
  expectedResponse?: unknown;
}

function buildPrompt(text: string, fileName: string, formatHint?: string): string {
  const hint = formatHint && formatHint !== 'auto'
    ? `The user indicated this file is in "${formatHint}" format, but verify against the actual content.`
    : 'Auto-detect the format from the content.';
  return `You are an API integration specialist. Extract EVERY HTTP endpoint described in the API document below and return them as a STRICT JSON ARRAY. The document may be an OpenAPI/Swagger spec (JSON or YAML), a Postman collection, a Bruno collection (\`.bru\` files — a text DSL with blocks like \`get {\`, \`post {\`, \`url:\`, \`headers {\`, \`body:json {\`), a WSDL/XML contract, an Excel/CSV table (rendered as CSV rows — typically one endpoint per row with columns like endpoint/method/headers), a set of cURL commands, or free-form API documentation extracted from a PDF or Word file.

${hint}

═══════════════════════════════════════════════════════════════
SOURCE FILE: ${fileName}
DOCUMENT CONTENT (may be truncated):
═══════════════════════════════════════════════════════════════
${text.slice(0, 60000)}

═══════════════════════════════════════════════════════════════
RETURN ONLY A JSON ARRAY of endpoint objects (no markdown, no prose):
═══════════════════════════════════════════════════════════════
[
  {
    "title": "GET /users/{id} — Get a user by id",   // short, human-readable label for a picker
    "method": "GET",                         // one of GET, POST, PUT, DELETE, PATCH, HEAD, OPTIONS
    "url": "https://api.example.com/v1/users/1",  // ABSOLUTE url; combine servers/basePath + path
    "headers": [                              // request headers other than auth (e.g. Content-Type, Accept)
      { "key": "Accept", "value": "application/json" }
    ],
    "auth": {                                 // authentication scheme the endpoint uses
      "type": "none",                         // none | bearer | basic | apikey
      "value": ""                             // leave EMPTY unless a real, non-placeholder credential is literally present
    },
    "body": "",                               // request body as a JSON string for POST/PUT/PATCH, else ""
    "expectedStatus": 200,                    // expected SUCCESS status code (200, 201…); infer from the method if not stated
    "expectedResponse": ""                    // a sample/expected success response body if the doc shows one, else ""
  }
]

RULES:
1. Extract ALL distinct endpoints — every path × method combination, every Postman request, every spreadsheet row. Do NOT collapse them to one. If there are more than ${MAX_ENDPOINTS}, return the ${MAX_ENDPOINTS} most important ones.
2. Each url MUST be absolute (http/https). Build it from OpenAPI \`servers\`/\`host\`+\`basePath\` + the path, or a Postman \`url.raw\`. If truly no host is given, use "https://api.example.com" as the host.
3. NEVER invent or echo secret values. If auth is a placeholder like "Bearer <token>", "{{apiKey}}", or "YOUR_API_KEY", set the correct auth TYPE but leave "value" as "".
4. Convert path/query parameter placeholders to concrete-looking example values (e.g. \`/users/{id}\` → \`/users/1\`).
5. Give every endpoint a distinct, descriptive "title" (method + path + a few words of purpose) so a person can tell them apart in a list.
6. STRICT JSON only: double-quoted keys/strings, no comments, no trailing commas, no code expressions.

Return the JSON array now.`;
}

function normalizeHeaders(h: unknown): { key: string; value: string }[] {
  const out: { key: string; value: string }[] = [];
  if (Array.isArray(h)) {
    for (const p of h) {
      if (p && typeof p === 'object' && 'key' in p && String((p as any).key).trim()) {
        out.push({ key: String((p as any).key).trim().slice(0, 200), value: String((p as any).value ?? '').slice(0, 2000) });
      }
    }
  } else if (h && typeof h === 'object') {
    for (const [k, v] of Object.entries(h as Record<string, unknown>)) {
      if (k.trim()) out.push({ key: k.trim().slice(0, 200), value: String(v ?? '').slice(0, 2000) });
    }
  }
  return out.slice(0, 40);
}

/** Coerce one loose endpoint object into a validated ParsedApiSpec, or null. */
function normalize(raw: RawSpec): ParsedApiSpec | null {
  const method = String(raw.method || 'GET').toUpperCase().trim();
  const url = String(raw.url || '').trim();
  // Every endpoint needs an absolute URL — anything else can't be executed.
  if (!/^https?:\/\//i.test(url)) return null;

  const authTypeRaw = String(raw.auth?.type || 'none').toLowerCase().trim();
  const authType = (VALID_AUTH.has(authTypeRaw) ? authTypeRaw : 'none') as ParsedApiSpec['auth']['type'];
  // Reduce whatever the model returned to the bare credential first: it often
  // lifts a whole header line — or an entire header block — out of the document.
  // A value is then only kept when it isn't a placeholder; we never want to
  // surface an invented or template credential as if it were real.
  const cleanedAuthValue = cleanAuthValue(String(raw.auth?.value ?? ''));
  const authValue = authType !== 'none' && !isPlaceholderSecret(cleanedAuthValue)
    ? cleanedAuthValue.slice(0, 4000)
    : undefined;

  const body = typeof raw.body === 'string'
    ? raw.body.slice(0, 20000)
    : raw.body && typeof raw.body === 'object'
      ? JSON.stringify(raw.body, null, 2).slice(0, 20000)
      : undefined;

  const expectedResponse = typeof raw.expectedResponse === 'string'
    ? raw.expectedResponse.slice(0, 20000)
    : raw.expectedResponse && typeof raw.expectedResponse === 'object'
      ? JSON.stringify(raw.expectedResponse, null, 2).slice(0, 20000)
      : undefined;

  const statusNum = Number(raw.expectedStatus);
  const expectedStatus = Number.isInteger(statusNum) && statusNum >= 100 && statusNum <= 599 ? statusNum : undefined;

  const normalizedMethod = VALID_METHODS.has(method) ? method : 'GET';
  let title = String(raw.title || raw.summary || raw.name || '').trim().slice(0, 160);
  if (!title) {
    // Fall back to "METHOD /path" derived from the URL.
    let path = url;
    try { path = new URL(url).pathname || url; } catch { /* keep url */ }
    title = `${normalizedMethod} ${path}`;
  }

  return {
    title,
    method: normalizedMethod,
    url,
    headers: normalizeHeaders(raw.headers),
    auth: { type: authType, value: authValue },
    body: body?.trim() ? body : undefined,
    expectedStatus,
    expectedResponse: expectedResponse?.trim() ? expectedResponse : undefined,
  };
}

/** De-duplicate endpoints that share the same method + URL. */
function dedupe(list: ParsedApiSpec[]): ParsedApiSpec[] {
  const seen = new Set<string>();
  const out: ParsedApiSpec[] = [];
  for (const e of list) {
    const key = `${e.method} ${e.url}`.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(e);
  }
  return out;
}

/**
 * Parse extracted document text into every API endpoint it describes, using the
 * tenant's configured LLM. Returns a non-empty list (one element when the doc
 * describes a single endpoint). Throws a clear Error when nothing usable is
 * found (e.g. the file wasn't actually an API spec).
 */
export async function parseApiEndpointsFromText(
  text: string,
  fileName: string,
  llm: LlmConfig | undefined,
  formatHint?: string,
): Promise<ParsedApiSpec[]> {
  if (!text || text.trim().length < 10) {
    throw new Error('The file contained too little text to identify an API endpoint.');
  }

  const prompt = buildPrompt(text, fileName, formatHint);
  const response = await runLLM(prompt, { maxTokens: 8192, llm });

  // The model is asked for a bare array; tolerate an object wrapper and a
  // truncated tail (large specs) via the shared salvage helpers.
  let rawList: RawSpec[] = [];
  try {
    const parsed = parseJsonFromResponse<unknown>(response);
    rawList = coerceJsonArray<RawSpec>(parsed) || [];
  } catch { /* salvage below */ }
  if (rawList.length === 0) rawList = salvageJsonArrayObjects<RawSpec>(response);

  const endpoints = dedupe(
    rawList
      .map(normalize)
      .filter((e): e is ParsedApiSpec => e !== null),
  ).slice(0, MAX_ENDPOINTS);

  if (endpoints.length === 0) {
    throw new Error('Could not find a usable API endpoint in the uploaded file. Try a clearer OpenAPI/Swagger, Postman, or documented endpoint, or enter it manually.');
  }
  return endpoints;
}
