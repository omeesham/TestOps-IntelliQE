/**
 * api-readiness-suggest.service.ts
 * ────────────────────────────────
 * Suggest the details an endpoint is MISSING for the strict readiness gate
 * (purpose, expected response status + example body, business rules / acceptance
 * criteria, and a request body for write verbs) so that applying the suggestion
 * makes the endpoint pass review.
 *
 * AI-first, deterministic-always: when the tenant has an LLM configured we ask it
 * for realistic, endpoint-specific values; then a repair pass fills anything the
 * model left blank or malformed with safe defaults. With no LLM (or on any error)
 * the deterministic path alone still returns a complete, gate-passing suggestion —
 * the button never comes back empty.
 *
 * The gate it targets lives in the frontend's apiValidation.ts (reviewEndpoint):
 *   purpose           — a meaningful description (≥ 12 chars, not the URL/title)
 *   expected response — expectedStatus (number) AND a non-empty, VALID-JSON body
 *   business rules    — ≥ 8 chars of acceptance criteria
 *   inputs            — write verbs (POST/PUT/PATCH) need a request body
 */
import { runLLM, parseJsonFromResponse, type LlmConfig } from '../agents/claude-runner.js';

export interface EndpointForSuggest {
  method?: string;
  url?: string;
  title?: string;
  description?: string;
  expectedStatus?: number;
  expectedResponse?: string;
  businessRules?: string;
  body?: string;
  style?: string;
  resource?: string;
  pathParams?: { name: string; example?: string }[];
  queryParams?: { name: string; example?: string }[];
}

export interface ReadinessSuggestion {
  description: string;
  expectedStatus: number;
  expectedResponse: string;
  businessRules: string;
  /** Only meaningful for write verbs / SOAP; '' otherwise. */
  body: string;
}

const WRITE = new Set(['POST', 'PUT', 'PATCH']);

function pathOf(url: string): string {
  try { return new URL(url).pathname || url; } catch { return url || '/'; }
}

/** The last non-parameter path segment — a human-ish resource name. */
function resourceOf(ep: EndpointForSuggest): string {
  if (ep.resource && ep.resource.trim()) return ep.resource.trim();
  const segs = pathOf(String(ep.url || '')).split('/').filter(Boolean);
  for (let i = segs.length - 1; i >= 0; i--) {
    const s = segs[i]!;
    if (/^[:{]/.test(s) || /^\d+$/.test(s) || /^v\d+$/i.test(s)) continue;
    return s.replace(/[-_]+/g, ' ').toLowerCase();
  }
  return 'resource';
}

/** A conventional success status for a verb (always one that carries a body, so
 *  the "valid-JSON example body" rule can be satisfied alongside it). */
function defaultStatus(method: string): number {
  return method.toUpperCase() === 'POST' ? 201 : 200;
}

function defaultPurpose(ep: EndpointForSuggest): string {
  const m = String(ep.method || 'GET').toUpperCase();
  const r = resourceOf(ep);
  const verb = m === 'GET' ? `Retrieves the ${r}`
    : m === 'POST' ? `Creates a new ${r}`
    : m === 'PUT' ? `Replaces the ${r}`
    : m === 'PATCH' ? `Updates the ${r}`
    : m === 'DELETE' ? `Deletes the ${r}`
    : `Calls the ${r} endpoint`;
  return `${verb} and returns the result to the caller.`;
}

function defaultRules(ep: EndpointForSuggest): string {
  const m = String(ep.method || 'GET').toUpperCase();
  const r = resourceOf(ep);
  if (m === 'GET') return `Returns 200 with the ${r} when it exists and 404 when the identifier is unknown; the call must not modify data and must not expose secrets in the response.`;
  if (m === 'POST') return `Creates the ${r} and returns 201 with its identifier; rejects missing or invalid fields with a 4xx error and does not create duplicates.`;
  if (m === 'DELETE') return `Removes the ${r} and returns a success status; a second delete of the same ${r} returns 404 and no unrelated data is affected.`;
  return `Applies the requested change to the ${r} and returns 200 with the updated resource; rejects invalid input with a 4xx error.`;
}

/** A minimal, valid-JSON example body derived from the endpoint's shape. */
function defaultResponseBody(ep: EndpointForSuggest): string {
  const r = resourceOf(ep).replace(/\s+/g, '_');
  const obj: Record<string, unknown> = { id: '1', [r || 'resource']: { id: '1', name: 'example' }, status: 'ok' };
  return JSON.stringify(obj, null, 2);
}

function defaultRequestBody(ep: EndpointForSuggest): string {
  return JSON.stringify({ name: 'example', value: 'string' }, null, 2);
}

/** Ensure a string is valid JSON; if not, wrap/repair it into a valid object. */
function ensureJson(text: string, fallback: string): string {
  const t = String(text || '').trim();
  if (!t) return fallback;
  try { JSON.parse(t); return t; } catch { return fallback; }
}

/** The deterministic suggestion — always complete and gate-passing. */
function heuristicSuggestion(ep: EndpointForSuggest): ReadinessSuggestion {
  const method = String(ep.method || 'GET').toUpperCase();
  const needsBody = WRITE.has(method) || String(ep.style || '').toLowerCase() === 'soap';
  return {
    description: defaultPurpose(ep),
    expectedStatus: defaultStatus(method),
    expectedResponse: defaultResponseBody(ep),
    businessRules: defaultRules(ep),
    body: needsBody ? defaultRequestBody(ep) : '',
  };
}

/** Ask the model for realistic values; shape-tolerant parsing. Returns a partial. */
async function llmSuggestion(ep: EndpointForSuggest, llm: LlmConfig): Promise<Partial<ReadinessSuggestion>> {
  const method = String(ep.method || 'GET').toUpperCase();
  const prompt = `You are a principal API test architect. Fill in the MISSING review details for ONE endpoint so it can be automated. Return STRICT JSON only (no markdown) with exactly these keys:
{
  "description": "one or two sentences: what this endpoint does and when it is used",
  "expectedStatus": <the conventional success HTTP status code as a number>,
  "expectedResponse": <a realistic SUCCESS response body as a JSON object>,
  "businessRules": "the acceptance criteria / business rules a tester must verify (success and the main failure cases)",
  "body": <for POST/PUT/PATCH a realistic request body as a JSON object, otherwise null>
}

ENDPOINT:
method: ${method}
url: ${String(ep.url || '').slice(0, 300)}
title: ${String(ep.title || '').slice(0, 160)}
known purpose: ${String(ep.description || '(none)').slice(0, 400)}
path params: ${(ep.pathParams || []).map((p) => p.name).join(', ') || '(none)'}
query params: ${(ep.queryParams || []).map((p) => p.name).join(', ') || '(none)'}

Return the JSON object now.`;
  const res = await runLLM(prompt, { maxTokens: 900, llm });
  const parsed = parseJsonFromResponse<Record<string, unknown>>(res);
  if (!parsed || typeof parsed !== 'object') return {};
  const out: Partial<ReadinessSuggestion> = {};
  if (typeof parsed.description === 'string' && parsed.description.trim()) out.description = parsed.description.trim();
  const st = Number(parsed.expectedStatus);
  if (Number.isInteger(st) && st >= 100 && st <= 599) out.expectedStatus = st;
  if (parsed.expectedResponse != null) out.expectedResponse = typeof parsed.expectedResponse === 'string' ? parsed.expectedResponse : JSON.stringify(parsed.expectedResponse, null, 2);
  if (typeof parsed.businessRules === 'string' && parsed.businessRules.trim()) out.businessRules = parsed.businessRules.trim();
  if (parsed.body != null && parsed.body !== '') out.body = typeof parsed.body === 'string' ? parsed.body : JSON.stringify(parsed.body, null, 2);
  return out;
}

/**
 * Suggest the missing readiness details for an endpoint. AI-first with a
 * deterministic repair/fallback so the result always passes the gate.
 */
export async function suggestReadiness(ep: EndpointForSuggest, llm?: LlmConfig): Promise<{ suggestion: ReadinessSuggestion; source: 'ai' | 'heuristic' }> {
  const base = heuristicSuggestion(ep);
  let source: 'ai' | 'heuristic' = 'heuristic';
  if (llm) {
    try {
      const ai = await llmSuggestion(ep, llm);
      if (Object.keys(ai).length) {
        source = 'ai';
        if (ai.description && ai.description.length >= 12) base.description = ai.description.slice(0, 2000);
        if (ai.expectedStatus) base.expectedStatus = ai.expectedStatus;
        if (ai.expectedResponse) base.expectedResponse = ensureJson(ai.expectedResponse, base.expectedResponse).slice(0, 6000);
        if (ai.businessRules && ai.businessRules.length >= 8) base.businessRules = ai.businessRules.slice(0, 2000);
        if (ai.body) base.body = ensureJson(ai.body, base.body).slice(0, 6000);
      }
    } catch { /* keep the deterministic suggestion */ }
  }
  // Final guarantees — never return something the gate would still reject.
  if (base.description.length < 12) base.description = defaultPurpose(ep);
  if (!(base.expectedStatus >= 100)) base.expectedStatus = defaultStatus(String(ep.method || 'GET'));
  base.expectedResponse = ensureJson(base.expectedResponse, defaultResponseBody(ep));
  if (base.businessRules.length < 8) base.businessRules = defaultRules(ep);
  return { suggestion: base, source };
}
