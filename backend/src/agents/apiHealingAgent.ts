/**
 * apiHealingAgent
 * ───────────────
 * The API-Automation counterpart to healingAgent. Browser healing is built
 * around a DOM: it re-crawls the page, swaps selectors and re-anchors waits.
 * None of that exists for an HTTP request spec, and pointing the browser
 * healer at one produces nonsense (it has no `page`, no page objects, no
 * locators). This heals API specs the way an API engineer would:
 *
 *   1. CLASSIFY the failure from the error text — assertion mismatch, body
 *      that would not parse as JSON, unreachable host, or auth rejection.
 *   2. PROBE the real endpoint ONCE per failing case, capturing the actual
 *      status, headers and body. That observation is the evidence everything
 *      downstream reasons about — no guessing from the error string alone.
 *   3. DECIDE whether the failure is a TEST defect or an API defect, and heal
 *      only the former (see the guardrails below).
 *   4. REPAIR — deterministically where the evidence is unambiguous, via the
 *      LLM (given the observed response) where judgement is needed.
 *
 * ── Guardrails: what this agent will NOT do ────────────────────────────────
 * Rewriting an assertion so it matches whatever the API returned would turn
 * every genuine defect into a green test. That is the one thing a healer must
 * never do, so these failures are reported honestly instead of "healed":
 *
 *   • The observed status is 5xx — a server error is a defect, full stop.
 *   • The case asserts the status the USER explicitly entered as the expected
 *     status (the happy path) and the API returned something else.
 *   • The endpoint is unreachable (DNS, refused, TLS, timeout) — nothing about
 *     the spec is wrong.
 *   • Auth was configured and the API answered 401/403 on a case that expects
 *     success — the credential is wrong, not the test.
 *
 * What IS healed is test-authoring drift: assertions the generator guessed at
 * that the endpoint never promised — a JSON path that does not match the real
 * body shape, a content-type compared too strictly, a response-time bound too
 * tight for the environment, or a negative case that guessed the wrong 4xx.
 */
import type { TestOpsState, AutomationScript, ApiSpec } from './state.js';
import { runLLM, llmForStage } from './claude-runner.js';
import { sanitizeChatContent } from '../utils/crypto.js';

/* ────────────────────────────────────────────────────────────────
   Recognising an API spec
   ──────────────────────────────────────────────────────────────── */

/**
 * True when this script is a Playwright `request` spec (the shape
 * apiGeneratorAgent renders) rather than a browser spec. Used both to route
 * a whole heal to this agent and to skip individual non-API scripts.
 */
export function isApiSpecScript(code: string): boolean {
  if (!code) return false;
  const usesRequestFixture = /async\s*\(\s*\{\s*request\s*\}\s*\)/.test(code);
  const usesPage = /\bpage\s*\./.test(code) || /\{\s*page\s*[,}]/.test(code);
  return usesRequestFixture && !usesPage;
}

/**
 * How many failing specs are diagnosed at once. Each heal is a live replay
 * plus a model call, so the ceiling is the API's rate limit, not the CPU.
 */
const HEAL_CONCURRENCY = Math.max(1, Math.min(8, parseInt(process.env.API_HEAL_CONCURRENCY || '', 10) || 4));

/** Run `fn` over `items` with at most `limit` in flight; results keep input order. */
async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]!, i);
    }
  }));
  return results;
}

/** True when the run as a whole is an API run (every spec is a request spec). */
export function isApiRun(scripts: { code: string }[]): boolean {
  const withCode = scripts.filter((s) => s?.code);
  return withCode.length > 0 && withCode.every((s) => isApiSpecScript(s.code));
}

/* ────────────────────────────────────────────────────────────────
   Reading the request back out of a rendered spec
   ──────────────────────────────────────────────────────────────── */

/** Scan a balanced `{…}` / `[…]` literal starting at `open`, return its text. */
function balanced(src: string, open: number): string | null {
  const closer = src[open] === '{' ? '}' : src[open] === '[' ? ']' : null;
  if (!closer) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = open; i < src.length; i++) {
    const ch = src[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') { inStr = true; continue; }
    if (ch === '{' || ch === '[') depth++;
    else if (ch === '}' || ch === ']') {
      depth--;
      if (depth === 0) return src.slice(open, i + 1);
    }
  }
  return null;
}

/** The first double-quoted JSON string at/after `from`, parsed. */
function jsonStringAt(src: string, from: number): string | null {
  const m = /"(?:[^"\\]|\\.)*"/.exec(src.slice(from));
  if (!m) return null;
  try { return JSON.parse(m[0]) as string; } catch { return null; }
}

export interface ParsedApiRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: string;
}

/**
 * Recover the HTTP request from a rendered spec. The renderer emits every
 * value through JSON.stringify, so each literal below is valid JSON — this
 * reads them back rather than re-deriving the request from the test case
 * (whose stored headers are masked, and which goes stale after a heal).
 */
export function parseRenderedRequest(code: string): ParsedApiRequest | null {
  const call = /await\s+request\.(\w+)\(/.exec(code);
  if (!call) return null;
  const verb = call[1];

  const afterOpen = call.index + call[0].length;
  const url = jsonStringAt(code, afterOpen);
  if (!url || !/^https?:\/\//i.test(url)) return null;

  let method = verb.toUpperCase();
  if (verb === 'fetch') {
    const mm = /method:\s*("(?:[^"\\]|\\.)*")/.exec(code);
    if (mm) { try { method = String(JSON.parse(mm[1])).toUpperCase(); } catch { /* keep FETCH */ } }
  }

  let headers: Record<string, string> = {};
  const hIdx = code.indexOf('headers:');
  if (hIdx !== -1) {
    const brace = code.indexOf('{', hIdx);
    const lit = brace === -1 ? null : balanced(code, brace);
    if (lit) { try { headers = JSON.parse(lit); } catch { /* leave empty */ } }
  }

  let body: string | undefined;
  const dIdx = code.indexOf('data:');
  if (dIdx !== -1) {
    const parsed = jsonStringAt(code, dIdx + 'data:'.length);
    if (parsed !== null) body = parsed;
  }

  return { method, url, headers, body };
}

/** Which service object a POM spec drives, and which method it calls. */
export interface SpecCallTarget {
  className: string;
  methodName: string;
}

/**
 * Read the call target out of a POM spec, i.e.
 *
 *   const usersApi = new UsersApi(request);
 *   const response = await usersApi.listUsers();
 *
 * Returns null for a legacy flat spec that calls `request.get(...)` directly.
 */
export function specCallTarget(code: string): SpecCallTarget | null {
  const ctor = /const\s+(\w+)\s*=\s*new\s+(\w+)\s*\(\s*request\s*\)/.exec(code || '');
  if (!ctor) return null;
  const [, instance, className] = ctor;
  const call = new RegExp(`await\\s+${instance}\\.(\\w+)\\s*\\(`).exec(code);
  // json()/text() are BaseApi readers, never the request itself.
  if (!call || call[1] === 'json' || call[1] === 'text') return null;
  return { className: className!, methodName: call[1]! };
}

/**
 * Recover the HTTP request from a service object's method:
 *
 *   async listUsers(): Promise<APIResponse> {
 *     return this.send("GET", "https://…", { headers: {…}, data: "…" });
 *   }
 *
 * The renderer emits every value through JSON.stringify, so each literal is
 * valid JSON and can simply be read back.
 */
export function parseServiceRequest(serviceCode: string, methodName: string): ParsedApiRequest | null {
  if (!serviceCode || !methodName) return null;
  const decl = new RegExp(`async\\s+${methodName}\\s*\\(`).exec(serviceCode);
  if (!decl) return null;

  const sendIdx = serviceCode.indexOf('this.send(', decl.index);
  if (sendIdx === -1) return null;
  const afterSend = sendIdx + 'this.send('.length;

  const method = jsonStringAt(serviceCode, afterSend);
  if (!method) return null;
  // The URL is the next string literal after the method literal.
  const methodEnd = serviceCode.indexOf(JSON.stringify(method), afterSend) + JSON.stringify(method).length;
  const url = jsonStringAt(serviceCode, methodEnd);
  if (!url || !/^https?:\/\//i.test(url)) return null;

  // Options object — scoped to THIS method so a later method's headers can't
  // bleed in (the whole-file indexOf the flat parser used would do exactly that).
  const optsStart = serviceCode.indexOf('{', methodEnd);
  const methodBodyEnd = serviceCode.indexOf('this.send(', afterSend + 1);
  const scopeEnd = methodBodyEnd === -1 ? serviceCode.length : methodBodyEnd;
  let headers: Record<string, string> = {};
  let body: string | undefined;
  if (optsStart !== -1 && optsStart < scopeEnd) {
    const opts = balanced(serviceCode, optsStart);
    if (opts) {
      const hIdx = opts.indexOf('headers:');
      if (hIdx !== -1) {
        const brace = opts.indexOf('{', hIdx);
        const lit = brace === -1 ? null : balanced(opts, brace);
        if (lit) { try { headers = JSON.parse(lit); } catch { /* leave empty */ } }
      }
      const dIdx = opts.indexOf('data:');
      if (dIdx !== -1) {
        const parsed = jsonStringAt(opts, dIdx + 'data:'.length);
        if (parsed !== null) body = parsed;
      }
    }
  }

  return { method: method.toUpperCase(), url, headers, body };
}

/**
 * The request behind a failing spec, wherever it lives: the service object it
 * drives (POM, the shape the generator emits now) or the spec itself (a flat
 * spec from a run generated before the API side adopted the pattern).
 */
export function resolveRequestFor(
  specCode: string,
  serviceObjects: { className?: string; code: string }[] = [],
): ParsedApiRequest | null {
  const target = specCallTarget(specCode);
  if (target) {
    const po = serviceObjects.find((o) => o?.className === target.className)
      // Fall back to any object that declares the method, in case the class
      // name was not recorded on the file.
      || serviceObjects.find((o) => o?.code && new RegExp(`async\\s+${target.methodName}\\s*\\(`).test(o.code));
    const fromService = po ? parseServiceRequest(po.code, target.methodName) : null;
    if (fromService) return fromService;
  }
  return parseRenderedRequest(specCode);
}

/* ────────────────────────────────────────────────────────────────
   Probing the live endpoint
   ──────────────────────────────────────────────────────────────── */

export interface Probe {
  reachable: boolean;
  status?: number;
  statusText?: string;
  headers?: Record<string, string>;
  /** Response body, truncated — this is prompt material, not a payload store. */
  bodyText?: string;
  /** Parsed JSON body when the response really was JSON. */
  json?: unknown;
  elapsedMs?: number;
  /** Populated when the request never completed (DNS, refused, TLS, timeout). */
  transportError?: string;
}

const PROBE_TIMEOUT_MS = 20_000;
const PROBE_BODY_LIMIT = 4000;

/** Issue the failing case's own request once and record what came back. */
export async function probeEndpoint(req: ParsedApiRequest): Promise<Probe> {
  const started = Date.now();
  try {
    const res = await fetch(req.url, {
      method: req.method,
      headers: req.headers,
      body: req.body !== undefined && !['GET', 'HEAD'].includes(req.method) ? req.body : undefined,
      redirect: 'follow',
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    const elapsedMs = Date.now() - started;
    const headers: Record<string, string> = {};
    res.headers.forEach((v, k) => { headers[k] = v; });

    let bodyText = '';
    try { bodyText = (await res.text()).slice(0, PROBE_BODY_LIMIT); } catch { /* body may be empty */ }
    let json: unknown;
    try { json = JSON.parse(bodyText); } catch { /* not JSON — bodyText still stands */ }

    return { reachable: true, status: res.status, statusText: res.statusText, headers, bodyText, json, elapsedMs };
  } catch (err) {
    return { reachable: false, transportError: (err as Error).message || String(err), elapsedMs: Date.now() - started };
  }
}

/* ────────────────────────────────────────────────────────────────
   Classification
   ──────────────────────────────────────────────────────────────── */

export type FailureKind =
  | 'unreachable'     // the request never completed — nothing to heal
  | 'server-defect'   // the API answered 5xx — a real defect
  | 'auth-defect'     // 401/403 on a case that expects success — bad credential
  | 'rate-limited'    // 429 — the host throttled us; neither a defect nor healable
  | 'contract-defect' // the happy path did not return the user's expected status
  | 'assertion-drift' // the spec asserted something the endpoint never promised
  | 'unknown';

export interface Diagnosis {
  kind: FailureKind;
  /** Plain-English statement of what actually went wrong. */
  summary: string;
  /** False ⇒ report honestly, never rewrite the spec. */
  healable: boolean;
}

const TRANSPORT_RE =
  /ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ECONNRESET|EPROTO|ETIMEDOUT|socket hang up|getaddrinfo|self.signed certificate|unable to verify|certificate has expired|Timeout .* exceeded|net::ERR/i;

/**
 * Decide what kind of failure this is, from the test error plus what the live
 * endpoint actually returned. The probe outranks the error text: an error
 * saying "expected 200, received 404" tells us the assertion that fired, while
 * the probe tells us whether the endpoint is broken, unreachable, or simply
 * shaped differently from what the generator assumed.
 */
export function diagnose(error: string, probe: Probe, spec: ApiSpec | null | undefined): Diagnosis {
  const err = error || '';

  if (!probe.reachable) {
    return {
      kind: 'unreachable',
      summary: `The endpoint could not be reached (${probe.transportError || 'no response'}). The test itself is not at fault.`,
      healable: false,
    };
  }
  if (TRANSPORT_RE.test(err) && probe.status === undefined) {
    return { kind: 'unreachable', summary: `Transport failure: ${err.split('\n')[0].slice(0, 200)}`, healable: false };
  }

  const status = probe.status ?? 0;

  // Shared public sandboxes throttle by source IP; a whole suite can hit the
  // ceiling at once. Rewriting the assertion would only hide that.
  if (status === 429) {
    const retryAfter = probe.headers?.['retry-after'];
    return {
      kind: 'rate-limited',
      summary: `The API throttled this request (429${retryAfter ? `, Retry-After ${retryAfter}` : ''}). Not a product defect and not healable — rerun later or lower the coverage depth.`,
      healable: false,
    };
  }

  if (status >= 500) {
    return {
      kind: 'server-defect',
      summary: `The API returned ${status} ${probe.statusText || ''}`.trim() +
        '. A server error is a genuine defect — the assertion is right and was left untouched.',
      healable: false,
    };
  }

  // The status the user explicitly declared as the endpoint's contract. A case
  // asserting exactly that and not getting it is a contract breach, not drift.
  const declared = typeof spec?.expectedStatus === 'number' ? spec.expectedStatus : undefined;
  const assertedDeclared =
    declared !== undefined &&
    new RegExp(`expected[^\\n]*\\b${declared}\\b`, 'i').test(err);
  if (declared !== undefined && assertedDeclared && status !== declared) {
    return {
      kind: 'contract-defect',
      summary: `The endpoint returned ${status} where the documented contract is ${declared}. ` +
        'That is an API defect, so the expectation was preserved rather than relaxed.',
      healable: false,
    };
  }

  if ((status === 401 || status === 403) && /expected|toBe|ok\(\)/i.test(err) && spec?.auth && spec.auth.type !== 'none') {
    return {
      kind: 'auth-defect',
      summary: `The API rejected the configured ${spec.auth.type} credential with ${status}. ` +
        'Fix the credential in the request panel — rewriting the test would only hide it.',
      healable: false,
    };
  }

  if (/expect|assert|toBe|toEqual|toContain|toBeDefined|toBeTruthy|toBeFalsy|did not parse/i.test(err)) {
    return {
      kind: 'assertion-drift',
      summary: `The endpoint answered ${status}, but the spec asserted a different shape. ` +
        'The assertion was re-anchored to what the endpoint actually returns.',
      healable: true,
    };
  }

  return {
    kind: 'unknown',
    summary: `The endpoint answered ${status}. The failure did not match a known pattern.`,
    healable: true,
  };
}

/* ────────────────────────────────────────────────────────────────
   Repair
   ──────────────────────────────────────────────────────────────── */

/** Pull the corrected spec out of the model's marker-delimited reply. */
function parseHealedSpec(response: string): string {
  const m = /===\s*SPEC\s*===([\s\S]*?)===\s*END\s*===/i.exec(response);
  const raw = m ? m[1] : response;
  return raw
    .replace(/^\s*```[a-zA-Z]*\s*\n?/, '')
    .replace(/\n?```\s*$/, '')
    .trim();
}

/** A healed spec must still be a runnable request spec with real assertions. */
function isPlausibleSpec(code: string): boolean {
  // A POM spec issues its request through a service object
  // (`await usersApi.listUsers()`), so requiring `await request.` — which only
  // a flat spec has — would reject every healed spec as implausible. Accept
  // either, and keep requiring that SOMETHING is awaited and asserted.
  const issuesRequest = /await\s+request\./.test(code) || !!specCallTarget(code);
  return (
    code.length > 80 &&
    /@playwright\/test/.test(code) &&
    /\btest\s*\(/.test(code) &&
    issuesRequest &&
    /expect\s*\(/.test(code) &&
    isApiSpecScript(code)
  );
}

function summariseProbe(probe: Probe): string {
  if (!probe.reachable) return `The endpoint could not be reached: ${probe.transportError}`;
  // An echo-style sandbox reflects the request — headers, tokens and all — in
  // its body, and that body is about to become part of an LLM prompt.
  const headerLines = Object.entries(probe.headers || {})
    .filter(([k]) => /^(content-type|content-length|cache-control|etag|location|retry-after|www-authenticate|x-ratelimit)/i.test(k))
    .map(([k, v]) => `  ${k}: ${sanitizeChatContent(String(v))}`)
    .join('\n') || '  (none of interest)';
  const body = probe.bodyText?.trim() ? sanitizeChatContent(probe.bodyText.trim().slice(0, 2500)) : '(empty body)';
  return `Status: ${probe.status} ${probe.statusText || ''}
Round trip: ${probe.elapsedMs}ms
Notable response headers:
${headerLines}
Response body (truncated):
${body}`;
}

function buildHealPrompt(args: {
  title: string;
  code: string;
  error: string;
  probe: Probe;
  diagnosis: Diagnosis;
  spec: ApiSpec | null | undefined;
  /** The service object the spec drives, when it follows the POM layout. */
  serviceCode?: string;
}): string {
  const { title, code, error, probe, diagnosis, spec, serviceCode } = args;
  // Read-only context: the healer repairs ASSERTIONS, and the request lives
  // here. Without it the model cannot see what call the spec actually makes.
  const serviceBlock = serviceCode
    ? `
═══════════════════════════════════════════════════════════════
SERVICE OBJECT THE SPEC DRIVES (read-only — do NOT return this file)
═══════════════════════════════════════════════════════════════
${serviceCode.slice(0, 4000)}
`
    : '';
  const contractLines = [
    spec?.expectedStatus !== undefined ? `Documented status code: ${spec.expectedStatus}` : '',
    spec?.expectedResponse?.trim() ? `Documented response body:\n${spec.expectedResponse.trim().slice(0, 1500)}` : '',
  ].filter(Boolean).join('\n') || '(the requester documented no contract beyond the endpoint itself)';

  return `You are an API test healer. One Playwright \`request\` spec failed. Repair the SPEC — never weaken it to hide a real defect.

═══════════════════════════════════════════════════════════════
FAILING TEST
═══════════════════════════════════════════════════════════════
${title}

═══════════════════════════════════════════════════════════════
SPEC SOURCE (this exact file must be returned, corrected)
═══════════════════════════════════════════════════════════════
${code}
${serviceBlock}
═══════════════════════════════════════════════════════════════
FAILURE
═══════════════════════════════════════════════════════════════
${error.slice(0, 2000)}

═══════════════════════════════════════════════════════════════
LIVE OBSERVATION — this exact request was just replayed against the real endpoint
═══════════════════════════════════════════════════════════════
${summariseProbe(probe)}

═══════════════════════════════════════════════════════════════
THE REQUESTER'S DOCUMENTED CONTRACT
═══════════════════════════════════════════════════════════════
${contractLines}

═══════════════════════════════════════════════════════════════
DIAGNOSIS (already established — heal in line with it)
═══════════════════════════════════════════════════════════════
${diagnosis.kind}: ${diagnosis.summary}

═══════════════════════════════════════════════════════════════
RULES
═══════════════════════════════════════════════════════════════
1. Make the SMALLEST change that makes the test genuinely valid against the observed response.
2. Re-anchor assertions to the REAL body shape above — correct JSON paths (e.g. the field is at the root, not under "data"), correct types, correct header comparisons (compare loosely, e.g. content-type CONTAINS "json").
3. A negative/error case must still assert a failure. If it guessed the wrong 4xx, correct it to the observed 4xx — never relax it to a 2xx, "ok()", or a bare "toBeDefined()".
4. NEVER delete an assertion to make the test pass. NEVER replace a specific expectation with a vacuous one. If the only way to pass would be to stop checking something real, leave that assertion exactly as it is.
5. NEVER change the request's URL, method, headers or body — the request is the user's input, and the observation above belongs to it. Only assertions may change. The request lives in the service object, which you are NOT returning; keep calling the same method on it.
6. Keep the test title string byte-for-byte identical — results are matched to test cases by it.
7. Preserve the file's structure: the same imports (including the service object and getPath), the same object construction, one test() block.

Return the complete corrected spec between the markers, and nothing else:
===SPEC===
<the full corrected file>
===END===`;
}

/* ────────────────────────────────────────────────────────────────
   Agent entry
   ──────────────────────────────────────────────────────────────── */

/**
 * Heal the failing API specs in `state`. Mirrors healingAgent's contract: it
 * returns updated scripts + healingNotes, and the CALLER re-executes to find
 * out whether the repair actually worked.
 */
export async function apiHealingAgent(
  state: TestOpsState,
  opts?: { failuresByTc?: Record<string, string> },
): Promise<TestOpsState> {
  const failedCases = state.testCases.filter((tc) => tc.status === 'failed');
  if (failedCases.length === 0) return state;

  const failuresByTc: Record<string, string> = opts?.failuresByTc || Object.fromEntries(
    (state.executionResults?.details || [])
      .filter((d) => d.status === 'failed' && d.error)
      .map((d) => [d.testCaseId, d.error as string]),
  );

  const healingNotes: Record<string, string> = { ...(state.healingNotes || {}) };
  const scriptMap = new Map<string, AutomationScript>();
  for (const s of state.automationScripts) scriptMap.set(s.testCaseId, s);

  const llm = llmForStage(state.llm, 'heal');
  const spec = state.apiSpec;
  // The service objects this run's specs drive — where the HTTP request now
  // lives, and read-only context for the heal.
  const serviceObjects = (state.pageObjects || []).filter((o) => o?.code && /\.api\.ts$/.test(o.path || ''));

  // Heal each failing spec concurrently — the probes and LLM calls are
  // independent, and serialising 10+ of them costs minutes for no benefit.
  // Bounded, though: firing 60 failures at the model at once earns 429s, and
  // the backoff that follows is slower than a steady pool would have been.
  const outcomes = await mapWithConcurrency(failedCases, HEAL_CONCURRENCY, async (tc): Promise<AutomationScript | null> => {
    const script = scriptMap.get(tc.id);
    if (!script) {
      healingNotes[tc.id] = 'No script found for this test case';
      return null;
    }
    if (!isApiSpecScript(script.code)) {
      healingNotes[tc.id] = 'Not an API request spec — skipped by the API healer';
      return null;
    }
    // A multi-step flow fails at ONE step, and replaying step 1 in isolation
    // says nothing about a failure in step 3 that depended on step 1's id.
    // The failure is reported with the step that broke rather than "healed"
    // against the wrong request.
    if (/^\/\/ @flow /m.test(script.code)) {
      const error = failuresByTc[tc.id] || state.failureReason || 'Test failed';
      const stepMatch = /(\d+)\.\s+[a-z0-9 _-]+ — (GET|POST|PUT|PATCH|DELETE)\s+\S+/i.exec(error);
      healingNotes[tc.id] = `Multi-step flow — left as-is. ${stepMatch ? `It broke at step ${stepMatch[1]} (${stepMatch[2]} request)` : 'A flow failure usually means a real contract or data-setup problem'}: ${error.split('\n').map((l) => l.trim()).filter(Boolean).slice(0, 2).join(' · ').slice(0, 300)}`;
      return null;
    }

    const error = failuresByTc[tc.id] || state.failureReason || 'Test failed';
    const parsed = resolveRequestFor(script.code, serviceObjects);
    if (!parsed) {
      healingNotes[tc.id] = 'Could not read the HTTP request back out of the spec or its service object';
      return null;
    }
    const target = specCallTarget(script.code);
    const serviceCode = target
      ? serviceObjects.find((o) => o.className === target.className)?.code
      : undefined;

    // Replay the exact request so the repair reasons about a real response.
    const probe = await probeEndpoint(parsed);
    const diagnosis = diagnose(error, probe, spec);

    if (!diagnosis.healable) {
      // An honest non-heal. The note is what the user reads in the heal log —
      // it must say WHY nothing was changed, not "could not be healed".
      healingNotes[tc.id] = diagnosis.summary;
      console.warn(`[apiHealingAgent] ${tc.id}: ${diagnosis.kind} — left unchanged`);
      return null;
    }

    if (!llm) {
      healingNotes[tc.id] = 'No LLM configured — the assertion could not be re-anchored';
      return null;
    }

    try {
      const response = await runLLM(
        buildHealPrompt({ title: tc.title || tc.scenario || tc.id, code: script.code, error, probe, diagnosis, spec, serviceCode }),
        { maxTokens: 8000, llm },
      );
      const healed = parseHealedSpec(response);
      if (!isPlausibleSpec(healed)) {
        healingNotes[tc.id] = 'The healer did not return a usable spec — the original was kept';
        return null;
      }
      if (healed.trim() === script.code.trim()) {
        healingNotes[tc.id] = `${diagnosis.summary} No change was needed.`;
        return null;
      }
      healingNotes[tc.id] = diagnosis.summary;
      return { ...script, code: healed };
    } catch (err) {
      healingNotes[tc.id] = `Healing failed: ${(err as Error).message}`;
      return null;
    }
  });

  const healedById = new Map<string, AutomationScript>();
  for (const s of outcomes) if (s) healedById.set(s.testCaseId, s);

  const automationScripts = state.automationScripts.map((s) => healedById.get(s.testCaseId) || s);
  // Cases whose spec we actually changed go back to 'automated' so the
  // re-execution the caller runs decides their real outcome.
  const testCases = state.testCases.map((tc) =>
    tc.status === 'failed' && healedById.has(tc.id) ? { ...tc, status: 'automated' as const } : tc,
  );

  console.log(`[apiHealingAgent] repaired ${healedById.size}/${failedCases.length} failing API spec(s)`);

  return {
    ...state,
    automationScripts,
    testCases,
    healingAttempted: true,
    healingNotes,
    // Re-execution sets the real result; clearing this lets the caller run it.
    failureReason: null,
  };
}
