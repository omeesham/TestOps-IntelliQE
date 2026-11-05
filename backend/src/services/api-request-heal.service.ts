/**
 * api-request-heal.service.ts
 * ───────────────────────────
 * "Heal it" for a single, manually-sent request (the Manual HTTP Request drawer).
 *
 * Distinct from api-heal.service.ts (which heals a failing TEST's expectations
 * without rewriting the request). This one proposes a corrected REQUEST — the
 * minimal change to auth / headers / body / URL / expected status so the next
 * Send is likely to succeed, preserving the caller's intent.
 *
 * Non-destructive and reviewable: it re-fires nothing. It reasons purely from
 * the request plus the response the client already observed, and returns a
 * proposal the UI auto-fills into the (still editable) form. Secret values are
 * masked before they reach the model — the model may suggest an auth scheme or
 * header, never a token value. The generate → execute → heal pipeline is
 * untouched.
 */
import { runLLM, parseJsonFromResponse, type LlmConfig } from '../agents/claude-runner.js';

export interface HeaderKV { key: string; value: string }

export interface RequestFixInput {
  method?: string;
  url?: string;
  headers?: HeaderKV[];
  auth?: { type?: string; value?: string; headerName?: string; in?: string };
  body?: string;
  bodyMode?: string;
  expectedStatus?: number;
  expectedResponse?: string;
  /** What the client saw when it sent the request (no re-firing here). */
  observed?: { status?: number | null; ok?: boolean; error?: string; bodyText?: string };
}

export interface RequestFix {
  classification: 'auth' | 'headers' | 'body' | 'url' | 'contract' | 'environment' | 'none' | 'unknown';
  confidence: 'high' | 'medium' | 'low';
  changed: boolean;
  summary: string;
  rationale: string;
  /** Minimal corrected fields — present only for what changed. */
  fix: {
    method?: string;
    url?: string;
    headers?: HeaderKV[];
    auth?: { type?: string; value?: string; headerName?: string; in?: string };
    body?: string;
    expectedStatus?: number;
    expectedResponse?: string;
  };
}

const SENSITIVE_HEADER = /(authorization|api[-_]?key|token|secret|cookie|x-amz-security-token)/i;

/** Redact obvious secrets so a token value never leaves for the model. */
function maskHeaders(headers?: HeaderKV[]): HeaderKV[] {
  return (Array.isArray(headers) ? headers : [])
    .filter((h) => h && h.key)
    .map((h) => ({ key: h.key, value: SENSITIVE_HEADER.test(h.key) && h.value ? '«set»' : String(h.value ?? '') }));
}

const SYSTEM = `You are IntelliQE's API request-fix assistant. You are given ONE API request that FAILED when sent, plus the live response the caller actually observed. Propose the MINIMAL corrected request so the NEXT send is likely to succeed, PRESERVING the caller's intent (same resource/operation).

DEFAULT TO FIXING: most failed manual requests ARE fixable by editing the request — prefer changed=true. Decide by the observed status + body:
- 401 / 403, or a body mentioning authenticate/authentication/token/credentials/unauthorized/permission → classification "auth", changed=true. Set fix.auth.type to the most likely scheme (use "bearer" unless the body or an existing header clearly indicates "apikey" or "basic"); for apikey also set headerName and in. Leave auth.value EMPTY for the user to fill.
- 415, or a body mentioning content-type / media type / unsupported → classification "headers", changed=true, add/correct the Content-Type (and Accept) header.
- 400 / 422 with a body about invalid/malformed JSON or a validation error → classification "body" (or "headers" if it's a header), changed=true, fix the body/header accordingly.
- 404 / 405 with a plausible path or method mistake → classification "url", changed=true, correct url/method.
- Only when NO request-side edit could plausibly help — a 5xx server bug, or a missing-backend-data/environment problem — set changed=false and explain why (do NOT fabricate a fix that hides a real server defect).

Rules:
- Change as little as possible. Put in "fix" ONLY the fields you actually change.
- NEVER invent secret values. Needing the user's real token is NOT a reason to refuse — still propose auth.type with an empty value. Secret header values arrive masked as «set»; do not echo or guess them.
- classification MUST be exactly one of: auth|headers|body|url|contract|environment|none|unknown.
Reply with ONLY JSON:
{"classification":<...>,"confidence":"high"|"medium"|"low","changed":<bool>,"summary":"<=160 chars","rationale":"<=320 chars","fix":{"method"?:"","url"?:"","headers"?:[{"key":"","value":""}],"auth"?:{"type":"none|bearer|basic|apikey|oauth2|digest|awssigv4|oauth1|mtls","headerName"?:"","in"?:"header|query","value"?:""},"body"?:"","expectedStatus"?:<int>,"expectedResponse"?:"<=1200 chars"}}`;

const AUTH_TYPES = ['none', 'bearer', 'basic', 'apikey', 'oauth2', 'digest', 'awssigv4', 'oauth1', 'mtls'];

export async function proposeRequestFix(input: RequestFixInput, llm: LlmConfig): Promise<RequestFix> {
  if (!llm) throw new Error('Request healing needs an LLM — configure one under System Configuration → LLM, or an API-automation LLM provider.');
  const method = String(input?.method || 'GET').toUpperCase();
  const url = String(input?.url || '');
  if (!/^https?:\/\//i.test(url)) throw new Error('A request with an absolute http(s) URL is required to heal.');

  const obs = input.observed || {};
  const prompt = [
    `REQUEST: ${method} ${url}`,
    input.headers?.length ? `HEADERS: ${JSON.stringify(maskHeaders(input.headers))}` : '',
    input.auth?.type && input.auth.type !== 'none'
      ? `AUTH: ${JSON.stringify({ type: input.auth.type, headerName: input.auth.headerName, in: input.auth.in, hasValue: !!input.auth.value })}`
      : 'AUTH: none',
    input.body ? `BODY (${input.bodyMode || 'json'}): ${String(input.body).slice(0, 1500)}` : '',
    input.expectedStatus ? `EXPECTED STATUS: ${input.expectedStatus}` : '',
    obs.error ? `OBSERVED: transport error — ${String(obs.error).slice(0, 400)}`
      : `OBSERVED STATUS: ${obs.status ?? '—'}${obs.ok === false ? ' (not ok)' : ''}`,
    obs.bodyText ? `OBSERVED BODY: ${String(obs.bodyText).slice(0, 1500)}` : '',
    'Return the JSON now.',
  ].filter(Boolean).join('\n');

  let parsed: Record<string, any> = {};
  try {
    const raw = await runLLM(prompt, { system: SYSTEM, llm, maxTokens: 1100 });
    parsed = parseJsonFromResponse<Record<string, any>>(raw) || {};
  } catch {
    // Model returned prose / unparseable JSON — fall through to the deterministic
    // heuristic below rather than giving up.
    parsed = {};
  }

  const classification = (['auth', 'headers', 'body', 'url', 'contract', 'environment', 'none'].includes(String(parsed.classification))
    ? parsed.classification : 'unknown') as RequestFix['classification'];
  const confidence = (['high', 'medium', 'low'].includes(String(parsed.confidence)) ? parsed.confidence : 'low') as RequestFix['confidence'];

  // Sanitize the proposed fix — only accept well-typed fields.
  const fix: RequestFix['fix'] = {};
  const p = (parsed.fix && typeof parsed.fix === 'object') ? parsed.fix : {};
  if (typeof p.method === 'string' && p.method.trim()) fix.method = p.method.trim().toUpperCase();
  if (typeof p.url === 'string' && /^https?:\/\//i.test(p.url.trim())) fix.url = p.url.trim();
  if (Array.isArray(p.headers)) {
    const hs = p.headers.filter((h: any) => h && typeof h.key === 'string' && h.key.trim())
      .map((h: any) => ({ key: String(h.key).trim(), value: String(h.value ?? '') }))
      // Drop any masked secret the model echoed back unchanged — never re-apply «set».
      .filter((h: HeaderKV) => h.value !== '«set»');
    if (hs.length) fix.headers = hs;
  }
  if (p.auth && typeof p.auth === 'object' && AUTH_TYPES.includes(String(p.auth.type))) {
    const a: RequestFix['fix']['auth'] = { type: String(p.auth.type) };
    if (typeof p.auth.headerName === 'string' && p.auth.headerName.trim()) a!.headerName = p.auth.headerName.trim();
    if (p.auth.in === 'query' || p.auth.in === 'header') a!.in = p.auth.in;
    // A suggested value is accepted only if it is not the masked placeholder.
    if (typeof p.auth.value === 'string' && p.auth.value && p.auth.value !== '«set»') a!.value = p.auth.value;
    fix.auth = a;
  }
  if (typeof p.body === 'string' && p.body.trim()) fix.body = p.body;
  if (Number.isInteger(Number(p.expectedStatus))) fix.expectedStatus = Number(p.expectedStatus);
  if (typeof p.expectedResponse === 'string' && p.expectedResponse.trim()) fix.expectedResponse = p.expectedResponse.slice(0, 1200);

  const changed = parsed.changed === true && Object.keys(fix).length > 0;
  if (changed) {
    return {
      classification, confidence, changed: true,
      summary: String(parsed.summary || '').slice(0, 160) || 'Proposed a fix',
      rationale: String(parsed.rationale || '').slice(0, 320),
      fix,
    };
  }

  // The model proposed no usable fix (conservative, or returned unparseable
  // output). Fall back to a deterministic fix for well-known failures so the
  // common cases still heal.
  const heur = heuristicFix(input);
  if (heur) return heur;

  return {
    classification,
    confidence,
    changed: false,
    summary: String(parsed.summary || '').slice(0, 160) || 'No safe request fix',
    rationale: String(parsed.rationale || '').slice(0, 320) || 'Could not derive a safe request-side fix from the response.',
    fix: {},
  };
}

/**
 * Deterministic fallback for well-known HTTP failures — used when the model is
 * unavailable, returns prose, or is too conservative to propose a fix. Only
 * fires for unambiguous, request-side problems; never guesses a secret value.
 */
function heuristicFix(input: RequestFixInput): RequestFix | null {
  const status = input.observed?.status ?? undefined;
  const body = String(input.observed?.bodyText || '').toLowerCase();
  const hasAuth = !!(input.auth?.type && input.auth.type !== 'none');

  // 401/403 (or a body that says so) with no credentials sent → add Bearer auth.
  const looksAuth = status === 401 || status === 403 || /unauthor|authenticat|requires? (a )?(token|auth|credential)|credential|permission denied|forbidden/.test(body);
  if (looksAuth && !hasAuth) {
    return {
      classification: 'auth', confidence: 'low', changed: true,
      summary: 'Endpoint requires authentication — added Bearer auth.',
      rationale: `The request returned ${status ?? 'an auth error'} and sent no credentials. Set Auth to Bearer — paste your token in the Auth field, then Send again.`,
      fix: { auth: { type: 'bearer' } },
    };
  }

  // 415 / media-type complaint → ensure a JSON Content-Type header.
  const looksMedia = status === 415 || /unsupported media type|content[- ]type/.test(body);
  const hasContentType = (input.headers || []).some((h) => h.key.trim().toLowerCase() === 'content-type');
  if (looksMedia && !hasContentType) {
    return {
      classification: 'headers', confidence: 'low', changed: true,
      summary: 'Added a JSON Content-Type header.',
      rationale: 'The response indicates a missing or unsupported media type. Added Content-Type: application/json — adjust if the API expects another type, then Send again.',
      fix: { headers: [{ key: 'Content-Type', value: 'application/json' }] },
    };
  }

  return null;
}
