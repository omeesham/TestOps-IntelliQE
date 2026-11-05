/**
 * apiValidation.ts
 * ────────────────
 * Deterministic readiness checks for the endpoints that enter the automation
 * pipeline. Nothing here calls a model: it is rule-based so it runs instantly
 * and gives the same verdict every time.
 *
 * Two gates share this one validator:
 *   - Import gate      — run over everything a document produced, so a file that
 *                        is not really an API spec (or whose endpoints can't be
 *                        automated) is flagged before it pollutes the catalogue.
 *   - Generation gate  — re-run over the *selected* endpoints the moment the user
 *                        starts test generation, resolved against the active
 *                        environment, so a run never kicks off on endpoints that
 *                        aren't ready.
 *
 * Policy is "warn, don't block": `ok` is true as long as there are no hard
 * errors; warnings are surfaced but the user may always proceed anyway.
 */
import type { ApiEnvironment } from './types';

export type ValidationLevel = 'error' | 'warning' | 'info';

/**
 * The structural subset both a catalogue endpoint and a freshly-parsed import
 * endpoint satisfy — so one validator serves both gates without coupling to the
 * full CatalogEndpoint shape.
 */
export interface ValidatableEndpoint {
  id?: string;
  method: string;
  url: string;
  headers?: { key: string; value: string }[];
  auth?: { type: string; value?: string; oauth2?: unknown };
  body?: string;
}

export interface ValidationIssue {
  level: ValidationLevel;
  /** Stable machine code for the check that fired. */
  code: string;
  message: string;
  /** Set when the issue is tied to one endpoint. */
  endpointId?: string;
  endpointLabel?: string;
}

export interface ApiValidationReport {
  /** True when there are no hard errors (warnings are allowed through). */
  ok: boolean;
  /** Endpoints examined. */
  total: number;
  /** Endpoints with no error and no warning. */
  ready: number;
  errorCount: number;
  warningCount: number;
  issues: ValidationIssue[];
}

const HTTP_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);
/** Mirrors the backend importer's PLACEHOLDER_HOST (api-import.service.ts). */
const PLACEHOLDER_HOSTS = new Set(['api.example.com']);
const VAR_RE = /\{\{\s*([^}]+?)\s*\}\}/g;

const isAbsolute = (url: string): boolean => /^https?:\/\//i.test(url.trim());

function hostOf(url: string): string {
  try { return new URL(url).host.toLowerCase(); } catch { return ''; }
}

function envValues(env?: ApiEnvironment | null): Record<string, string> {
  const map: Record<string, string> = {};
  if (env?.variables) for (const v of env.variables) if (v.key) map[v.key] = v.value ?? '';
  return map;
}

/** The `{{var}}` tokens in `text` that the environment can't fill. */
function unresolvedVars(text: string, vals: Record<string, string>): string[] {
  const out = new Set<string>();
  let m: RegExpExecArray | null;
  VAR_RE.lastIndex = 0;
  while ((m = VAR_RE.exec(text))) {
    const key = (m[1] || '').trim();
    if (key && (!(key in vals) || vals[key] === '')) out.add(key);
  }
  return [...out];
}

/**
 * Validate a set of endpoints for automation readiness.
 *
 * @param endpoints the endpoints to check (a document's output, or the selection)
 * @param env       the active environment, used to resolve `{{vars}}` and the base URL
 */
export function validateApiEndpoints(
  endpoints: ValidatableEndpoint[],
  env?: ApiEnvironment | null,
): ApiValidationReport {
  const issues: ValidationIssue[] = [];
  const total = endpoints.length;
  const vals = envValues(env);
  const hasEnvBaseUrl = !!env?.baseUrl && isAbsolute(env.baseUrl);

  // Document-level: an API doc that yielded nothing is the headline failure.
  if (total === 0) {
    issues.push({
      level: 'error',
      code: 'no-endpoints',
      message: 'No API endpoints were found — this document does not look like an API specification.',
    });
    return { ok: false, total: 0, ready: 0, errorCount: 1, warningCount: 0, issues };
  }

  let ready = 0;
  for (const ep of endpoints) {
    const label = `${ep.method} ${ep.url}`;
    const before = issues.length;
    const add = (level: ValidationLevel, code: string, message: string) =>
      issues.push({ level, code, message, endpointId: ep.id, endpointLabel: label });

    // Method must be a real HTTP verb.
    if (!HTTP_METHODS.has(String(ep.method || '').toUpperCase())) {
      add('warning', 'bad-method', `Unusual HTTP method "${ep.method || '(none)'}".`);
    }

    // URL must be an absolute, callable address.
    const url = String(ep.url || '').trim();
    if (!url) {
      add('error', 'no-url', 'Endpoint has no URL.');
    } else if (!isAbsolute(url)) {
      add('error', 'relative-url', `URL is not absolute (needs http/https): ${url}`);
    } else if (PLACEHOLDER_HOSTS.has(hostOf(url)) && !hasEnvBaseUrl) {
      add('warning', 'placeholder-host', 'Uses a placeholder host — select an environment with a base URL before running.');
    }

    // Unresolved {{variables}} across URL, headers and body.
    const texts = [url, ...(ep.headers || []).flatMap((h) => [h.key, h.value]), ep.body || ''];
    const missing = [...new Set(texts.flatMap((t) => unresolvedVars(String(t || ''), vals)))];
    if (missing.length) {
      add('warning', 'unresolved-vars',
        `Unresolved variable${missing.length > 1 ? 's' : ''}: ${missing.map((v) => `{{${v}}}`).join(', ')} — define ${missing.length > 1 ? 'them' : 'it'} in the environment.`);
    }

    // Declared auth with nothing behind it won't authenticate at run time.
    if (ep.auth && ep.auth.type !== 'none') {
      const hasValue = !!(ep.auth.value && ep.auth.value.trim()) || !!ep.auth.oauth2;
      if (!hasValue && ep.auth.type !== 'oauth2') {
        add('warning', 'auth-missing', `Auth is "${ep.auth.type}" but no token/secret is set.`);
      }
    }

    if (issues.length === before) ready++;
  }

  const errorCount = issues.filter((i) => i.level === 'error').length;
  const warningCount = issues.filter((i) => i.level === 'warning').length;
  return { ok: errorCount === 0, total, ready, errorCount, warningCount, issues };
}

/* ═══════════════════════════════════════════════════════════════════════════
   STRICT READINESS REVIEW — the reviewer gate before planning starts.
   ---------------------------------------------------------------------------
   Deterministic per-endpoint completeness. For every endpoint it captures and
   grades: purpose, inputs, expected responses, business rules, schema validity
   and that it is a valid, categorised API call. Required fields are errors, so
   the gate blocks planning until each endpoint is complete OR the reviewer
   removes it. Each item also carries its source and a per-category test
   checklist (REST vs SOAP vs …). No model calls — instant and repeatable.
   ═══════════════════════════════════════════════════════════════════════════ */

export type ApiCategory = 'rest' | 'soap' | 'graphql' | 'jsonrpc' | 'webhook' | 'mcp';

/** The richer shape the readiness review grades (CatalogEndpoint satisfies it). */
export interface ReviewableEndpoint extends ValidatableEndpoint {
  title?: string;
  description?: string;
  expectedStatus?: number;
  expectedResponse?: string;
  businessRules?: string;
  style?: string;
  bodyMode?: string;
  source?: { method: string; name: string };
  pathParams?: { name: string; example?: string; required?: boolean }[];
  queryParams?: { name: string; example?: string; required?: boolean }[];
  formFields?: unknown[];
}

export type ReadinessKey = 'valid' | 'purpose' | 'inputs' | 'responses' | 'businessRules' | 'schema';

export interface ReadinessField {
  key: ReadinessKey;
  label: string;
  ok: boolean;
  /** 'error' ⇒ required and blocks the gate; 'info' ⇒ nice-to-have. */
  level: ValidationLevel;
  /** Short preview of the captured value when present. */
  value?: string;
  /** Why it failed, when it did. */
  message?: string;
}

export interface EndpointReadiness {
  endpointId: string;
  title: string;
  method: string;
  url: string;
  category: ApiCategory;
  source?: { method: string; name: string };
  fields: ReadinessField[];
  ready: boolean;
  errorCount: number;
}

export interface ReadinessReviewReport {
  total: number;
  ready: number;
  notReady: number;
  allReady: boolean;
  items: EndpointReadiness[];
}

/** What the platform tests for each API category — shown per endpoint so the
 *  reviewer sees what "automate this" will mean for a REST vs a SOAP service. */
export const CATEGORY_CHECKLIST: Record<ApiCategory, { label: string; color: string; tests: string[] }> = {
  rest:    { label: 'REST',     color: '#2563EB', tests: ['Status codes & headers', 'Response schema / contract', 'CRUD happy paths', 'Auth & authorization', 'Negative & boundary inputs', 'Pagination & idempotency'] },
  soap:    { label: 'SOAP',     color: '#7C3AED', tests: ['WSDL operations reachable', 'SOAP envelope + SOAPAction header', 'Request/response XSD schema', 'SOAP Fault handling', 'WS-Security / auth headers'] },
  graphql: { label: 'GraphQL',  color: '#DB2777', tests: ['Query & mutation shape', 'Schema introspection', 'errors[] envelope', 'Auth on resolvers', 'Null / partial-data handling'] },
  jsonrpc: { label: 'JSON-RPC', color: '#0891B2', tests: ['method & params', 'result / error object', 'Batch requests', 'Auth'] },
  webhook: { label: 'Webhook',  color: '#D97706', tests: ['Payload schema', 'Signature verification', 'Retry / idempotency', 'Ack status code'] },
  mcp:     { label: 'MCP',      color: '#059669', tests: ['Tool listing', 'Tool-call schema', 'Error handling', 'Auth'] },
};

const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH']);

function categoryOf(ep: ReviewableEndpoint): ApiCategory {
  const s = String(ep.style || '').toLowerCase();
  if (s === 'soap' || s === 'graphql' || s === 'jsonrpc' || s === 'webhook' || s === 'mcp') return s as ApiCategory;
  const url = String(ep.url || '').toLowerCase();
  const body = String(ep.body || '').toLowerCase();
  if (url.includes('?wsdl') || url.endsWith('.wsdl') || body.includes('<soap:envelope') || body.includes('<soapenv:envelope')) return 'soap';
  return 'rest';
}

function parsesAsJson(text: string): boolean {
  try { JSON.parse(text); return true; } catch { return false; }
}

function previewText(text: string, n = 80): string {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
}

/** Grade one endpoint across the six readiness fields. */
export function reviewEndpoint(ep: ReviewableEndpoint): EndpointReadiness {
  const category = categoryOf(ep);
  const method = String(ep.method || '').toUpperCase();
  const url = String(ep.url || '').trim();
  const title = String(ep.title || `${method} ${url}`.trim());
  const fields: ReadinessField[] = [];

  // 1 ▸ Valid, categorised API call.
  let validOk = true; let validMsg = '';
  const verbMatters = category !== 'graphql' && category !== 'jsonrpc' && category !== 'mcp';
  if (verbMatters && !HTTP_METHODS.has(method)) { validOk = false; validMsg = `"${method || '(none)'}" is not a valid HTTP method.`; }
  else if (!url) { validOk = false; validMsg = 'Endpoint has no URL.'; }
  else if (!isAbsolute(url)) { validOk = false; validMsg = 'URL is not absolute (needs http/https).'; }
  fields.push({ key: 'valid', label: 'Valid API call', ok: validOk, level: 'error', value: validOk ? `${method} ${url}` : undefined, message: validMsg || undefined });

  // 2 ▸ Purpose — a meaningful description, not just the URL echoed back.
  const desc = String(ep.description || '').trim();
  const meaningful = desc.length >= 12 && desc.toLowerCase() !== title.toLowerCase() && desc.toLowerCase() !== url.toLowerCase();
  fields.push({ key: 'purpose', label: 'Purpose', ok: meaningful, level: 'error', value: meaningful ? previewText(desc) : undefined,
    message: meaningful ? undefined : (desc ? 'Description is too short to be meaningful.' : 'No purpose / description captured.') });

  // 3 ▸ Inputs documented.
  const inputBits: string[] = [];
  if (ep.pathParams?.length) inputBits.push(`${ep.pathParams.length} path param${ep.pathParams.length === 1 ? '' : 's'}`);
  if (ep.queryParams?.length) inputBits.push(`${ep.queryParams.length} query param${ep.queryParams.length === 1 ? '' : 's'}`);
  const hasBody = !!(ep.body && String(ep.body).trim()) || !!(ep.formFields && ep.formFields.length);
  if (hasBody) inputBits.push('request body');
  const needsBody = WRITE_METHODS.has(method) || category === 'soap';
  let inputsOk = true; let inputsMsg = '';
  if (needsBody && !hasBody) { inputsOk = false; inputsMsg = category === 'soap' ? 'SOAP call needs a request envelope/body.' : `${method} needs a documented request body.`; }
  fields.push({ key: 'inputs', label: 'Inputs', ok: inputsOk, level: 'error',
    value: inputsOk ? (inputBits.length ? inputBits.join(', ') : 'no inputs required') : undefined, message: inputsOk ? undefined : inputsMsg });

  // 4 ▸ Expected responses — a status code and an example body.
  const hasStatus = typeof ep.expectedStatus === 'number' && ep.expectedStatus > 0;
  const expResp = String(ep.expectedResponse || '').trim();
  const respOk = hasStatus && !!expResp;
  fields.push({ key: 'responses', label: 'Expected response', ok: respOk, level: 'error',
    value: respOk ? `${ep.expectedStatus} · ${previewText(expResp, 44)}` : undefined,
    message: respOk ? undefined : (!hasStatus && !expResp ? 'No expected status code or body.' : (!hasStatus ? 'No expected status code.' : 'No expected response body.')) });

  // 5 ▸ Business rules / acceptance criteria.
  const rules = String(ep.businessRules || '').trim();
  const rulesOk = rules.length >= 8;
  fields.push({ key: 'businessRules', label: 'Business rules', ok: rulesOk, level: 'error',
    value: rulesOk ? previewText(rules) : undefined, message: rulesOk ? undefined : 'No business rules / acceptance criteria captured.' });

  // 6 ▸ Schema validity — the example body must parse (JSON, or XML for SOAP).
  let schemaOk = true; let schemaMsg = ''; let schemaVal = '';
  if (expResp) {
    if (category === 'soap') { schemaOk = expResp.includes('<'); schemaVal = schemaOk ? 'XML' : ''; schemaMsg = schemaOk ? '' : 'Expected SOAP response is not XML.'; }
    else { schemaOk = parsesAsJson(expResp); schemaVal = schemaOk ? 'valid JSON' : ''; schemaMsg = schemaOk ? '' : 'Expected response is not valid JSON.'; }
  }
  if (schemaOk && ep.body && String(ep.bodyMode || '') === 'json' && !parsesAsJson(String(ep.body))) {
    schemaOk = false; schemaMsg = 'Request body is declared JSON but does not parse.';
  }
  fields.push({ key: 'schema', label: 'Schema', ok: schemaOk, level: schemaOk ? 'info' : 'error',
    value: schemaOk ? (schemaVal || 'ok') : undefined, message: schemaMsg || undefined });

  const errorCount = fields.filter((f) => !f.ok && f.level === 'error').length;
  return { endpointId: ep.id || '', title, method, url, category, source: ep.source, fields, ready: errorCount === 0, errorCount };
}

/** Grade a whole selection; `allReady` gates the planning start. */
export function buildReadinessReview(endpoints: ReviewableEndpoint[]): ReadinessReviewReport {
  const items = endpoints.map(reviewEndpoint);
  const ready = items.filter((i) => i.ready).length;
  return { total: items.length, ready, notReady: items.length - ready, allReady: items.length > 0 && ready === items.length, items };
}
