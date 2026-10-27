/**
 * api-flow-bridge.service.ts
 * ──────────────────────────
 * The bridge between the platform's *understanding* of an API and its
 * *runnable* journey engine.
 *
 * `analyzeApiSurface()` (api-intelligence) already detects the integration
 * journeys worth testing — the create → read → update → delete lifecycle of a
 * resource, or a list → read browse — and exposes them as `ApiFlow` objects
 * (ordered endpoint indices). Until now those journeys only ever reached the
 * AI generator, which rendered them as Playwright *code*; the no-code runtime
 * engine (`runFlow`, FlowBuilder) could execute hand-built flows only. The two
 * never met.
 *
 * This service closes that gap deterministically: it turns each detected
 * `ApiFlow` into a runnable `FlowStep[]` — capturing the id the create step
 * mints, injecting it ({{id}}) into every later single-resource step, and
 * asserting the status each step should return (including the 404 a read after
 * a delete must give). The result drops straight into `saveFlow` / `runFlow`,
 * so an AI-detected journey becomes a runnable, editable Integration Test with
 * no model call.
 *
 * The id extraction path is a heuristic (most REST APIs return `id` or
 * `data.id`); every suggestion is clearly marked so a human reviews — and can
 * tweak in FlowBuilder — before saving.
 */
import { analyzeApiSurface, type ApiProfile, type ApiFlow } from './api-intelligence.service.js';
import { exampleForParam, type ImportedEndpoint } from './api-import.service.js';
import type { FlowStep, FlowCheck } from './api-flow.service.js';

/** The variable the create/list step binds and later steps inject as {{id}}. */
const ID_VAR = 'id';
const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
// Eventual-consistency polling for auto-generated reads: a create/delete may not
// be visible to the very next read, so wrap the read-after-create and the
// confirm-gone in a short retry that polls until the expected status holds.
const POLL_ATTEMPTS = 5;
const POLL_DELAY_MS = 400;

/** Wrap a request step in a retry that polls until `untilExpr` holds (eventual consistency). */
function pollWrap(step: FlowStep, untilExpr: string): FlowStep {
  const inner: FlowStep = { ...step };
  delete inner.phase;   // the wrapper carries the lifecycle phase
  return {
    name: step.name,
    type: 'retry',
    phase: step.phase,
    retry: { until: { expr: untilExpr }, attempts: POLL_ATTEMPTS, delayMs: POLL_DELAY_MS },
    steps: [inner],
  };
}

type Resource = ApiProfile['resources'][number];

export interface SuggestedFlow {
  name: string;
  description: string;
  resource: string;
  steps: FlowStep[];
  variables: Record<string, string>;
  /** Marks a journey proposed by the analyzer rather than hand-built. */
  suggested: true;
  /** True when any step performs a write — the UI warns before running. */
  hasWrites: boolean;
}

/**
 * Detect the integration journeys in a catalogue and return each as a runnable
 * flow. Empty when nothing chainable (no create/list resource) was found.
 * Also appends "auth guard" negative tests — a protected endpoint must reject an
 * unauthenticated request (401/403).
 */
export function suggestIntegrationFlows(endpoints: ImportedEndpoint[]): SuggestedFlow[] {
  const eps = Array.isArray(endpoints) ? endpoints : [];
  if (!eps.length) return [];
  const profile = analyzeApiSurface(eps);
  const out: SuggestedFlow[] = [];
  for (const flow of profile.flows) {
    const built = flow.crossService ? buildCrossServiceFlow(flow, eps) : buildRunnableFlow(flow, eps, profile);
    if (built) out.push(built);
  }
  out.push(...buildSmokeFlow(eps));
  out.push(...buildAuthGuardFlows(eps));
  out.push(...buildBadTokenFlows(eps));
  out.push(...buildNotFoundFlows(eps));
  return out;
}

const MAX_BAD_TOKEN_FLOWS = 8;
const BOGUS_BEARER = 'invalid.token.000000';
const BOGUS_BASIC = 'YmFkOmJhZA==';   // base64("bad:bad")

/** Keep the auth scheme but swap in an obviously-invalid credential. */
function bogusHeaderValue(v: string): string {
  if (/^bearer\s+/i.test(v)) return `Bearer ${BOGUS_BEARER}`;
  if (/^basic\s+/i.test(v)) return `Basic ${BOGUS_BASIC}`;
  return BOGUS_BEARER;
}

/** Produce the endpoint's credentials replaced with invalid ones (same scheme). */
function bogusCredentials(e: ImportedEndpoint): { headers: { key: string; value: string }[]; auth: ImportedEndpoint['auth'] | undefined } {
  const a = e.auth;
  let auth: ImportedEndpoint['auth'] | undefined = undefined;
  if (a && a.type === 'bearer') auth = { type: 'bearer', value: BOGUS_BEARER };
  else if (a && a.type === 'basic') auth = { type: 'basic', value: 'baduser:badpass' };
  else if (a && a.type === 'apikey') auth = { type: 'apikey', value: 'invalid-api-key-000', headerName: a.headerName };
  else if (a && a.type && a.type !== 'none') auth = { ...a, value: BOGUS_BEARER };
  const headers = (e.headers || []).map((h) =>
    AUTH_HEADER_RE.test((h.key || '').trim()) ? { key: h.key, value: bogusHeaderValue(h.value) } : { key: h.key, value: h.value });
  return { headers, auth };
}

/**
 * For every protected READ endpoint, emit a negative test that sends an INVALID
 * credential (same scheme, bogus value) and asserts the API rejects it (401/403).
 * Distinct from the auth guard (missing creds): this catches an API that only
 * checks a token is PRESENT, not valid — i.e. accepts any non-empty credential (a
 * real auth bug; such an endpoint returns 200 here and fails the test). Reads only
 * (safe), deduped by method+url, capped.
 */
function buildBadTokenFlows(endpoints: ImportedEndpoint[]): SuggestedFlow[] {
  const out: SuggestedFlow[] = [];
  const seen = new Set<string>();
  for (const e of endpoints) {
    if (out.length >= MAX_BAD_TOKEN_FLOWS) break;
    const method = (e.method || 'GET').toUpperCase();
    if (WRITE_METHODS.has(method) || !isAuthenticated(e)) continue;
    const key = `${method} ${e.url}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const { headers, auth } = bogusCredentials(e);
    out.push({
      name: `Bad token — ${resourceLabel(e)}`,
      description: `${method} ${pathOnly(e.url)} must reject an INVALID credential (expect 401/403) — not accept any non-empty token.`,
      resource: e.resource || '',
      steps: [{ name: 'invalid credential', method, url: e.url, headers, auth, checks: [{ kind: 'status', oneOf: [401, 403] }] }],
      variables: {},
      suggested: true,
      hasWrites: false,
    });
  }
  return out;
}

const MAX_SMOKE_STEPS = 20;

/**
 * One "smoke" flow that GETs every COLLECTION read endpoint and asserts each
 * responds without error — the classic first integration test (breadth: is every
 * list endpoint up?). Collection reads only (by-id reads are skipped: a made-up
 * id would 404 and give a false failure). Reads only (safe), auth kept, deduped
 * by path, capped. No explicit check ⇒ the engine's default <400 gate (so a
 * documented `expectedStatus` is honoured when present).
 */
function buildSmokeFlow(endpoints: ImportedEndpoint[]): SuggestedFlow[] {
  const steps: FlowStep[] = [];
  const seen = new Set<string>();
  for (const e of endpoints) {
    if (steps.length >= MAX_SMOKE_STEPS) break;
    if ((e.method || 'GET').toUpperCase() !== 'GET') continue;
    if (isIdTargetedRead(e)) continue;   // skip by-id reads — a fabricated id would 404 (false failure)
    const key = pathOnly(e.url);
    if (seen.has(key)) continue;
    seen.add(key);
    steps.push({
      name: `GET ${pathOnly(e.url)}`.slice(0, 60),
      method: 'GET',
      url: e.url,
      headers: (e.headers || []).map((h) => ({ key: h.key, value: h.value })),
      auth: e.auth,
      checks: Number.isInteger(e.expectedStatus) ? [{ kind: 'status', equals: e.expectedStatus as number }] : [],
    });
  }
  if (steps.length < 2) return [];   // a 1-step smoke adds nothing over the browse journey
  return [{
    name: 'Smoke — all reads',
    description: `GET ${steps.length} collection endpoints and assert each responds without error (<400).`,
    resource: '',
    steps,
    variables: {},
    suggested: true,
    hasWrites: false,
  }];
}

// Headers that carry credentials — stripped when probing an endpoint unauthenticated.
const AUTH_HEADER_RE = /^(authorization|x-api-key|api-key|x-auth-token|x-access-token)$/i;
const MAX_AUTH_GUARD_FLOWS = 8;

/** True when the endpoint carries credentials (a structured auth scheme or an auth header). */
function isAuthenticated(e: ImportedEndpoint): boolean {
  if (e.auth && e.auth.type && e.auth.type !== 'none') return true;
  return (e.headers || []).some((h) => AUTH_HEADER_RE.test((h.key || '').trim()));
}

function pathOnly(url: string): string {
  try { return new URL(url).pathname; }
  catch { return (url || '').replace(/^https?:\/\/[^/]+/i, '').split('?')[0] || url; }
}

function resourceLabel(e: ImportedEndpoint): string {
  if (e.resource) return e.resource;
  const segs = pathOnly(e.url).split('/').filter((s) => s && !/^[{:]/.test(s));
  return segs[segs.length - 1] || 'endpoint';
}

/**
 * For every protected READ endpoint, emit a one-step negative test: repeat the
 * request with NO credentials (auth scheme dropped, auth headers stripped) and
 * assert the API rejects it with 401/403. Reads only — never fires an
 * unauthenticated write, which could mutate data on a mis-configured endpoint.
 */
function buildAuthGuardFlows(endpoints: ImportedEndpoint[]): SuggestedFlow[] {
  const out: SuggestedFlow[] = [];
  const seen = new Set<string>();
  for (const e of endpoints) {
    if (out.length >= MAX_AUTH_GUARD_FLOWS) break;
    const method = (e.method || 'GET').toUpperCase();
    if (WRITE_METHODS.has(method) || !isAuthenticated(e)) continue;
    const key = `${method} ${e.url}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const step: FlowStep = {
      name: 'unauthenticated request',
      method,
      url: e.url,
      headers: (e.headers || []).filter((h) => !AUTH_HEADER_RE.test((h.key || '').trim())).map((h) => ({ key: h.key, value: h.value })),
      // No `auth` field, no credential headers — a protected endpoint must reject this.
      checks: [{ kind: 'status', oneOf: [401, 403] }],
    };
    out.push({
      name: `Auth guard — ${resourceLabel(e)}`,
      description: `${method} ${pathOnly(e.url)} must reject an unauthenticated request (expect 401/403).`,
      resource: e.resource || '',
      steps: [step],
      variables: {},
      suggested: true,
      hasWrites: false,
    });
  }
  return out;
}

const MAX_NOT_FOUND_FLOWS = 8;
// Bogus ids substituted into a read-by-id endpoint to probe its not-found
// contract — a numeric sentinel, a zeroed uuid, a zeroed mongo ObjectId.
const BOGUS_NUM = '999999999';
const BOGUS_UUID = '00000000-0000-0000-0000-000000000000';
const BOGUS_MONGO = '0'.repeat(24);

/** True when a GET targets a single resource by id (a template id placeholder or a concrete id-like last segment). */
function isIdTargetedRead(e: ImportedEndpoint): boolean {
  if ((e.method || 'GET').toUpperCase() !== 'GET') return false;
  const template = e.pathTemplate || pathOnly(e.url);
  if (/[{:]/.test(template)) {
    const names = [...template.matchAll(/\{([^}]+)\}/g)].map((m) => m[1]!)
      .concat([...template.matchAll(/:([A-Za-z_][A-Za-z0-9_]*)/g)].map((m) => m[1]!));
    if (names.some((n) => isIdParam(n))) return true;
  }
  const last = pathOnly(e.url).split('/').filter(Boolean).pop() || '';
  return isIdLikeSegment(last);
}

/** Rewrite a read-by-id URL so its id becomes a bogus (non-existent) value. Null when no id position was found. */
function injectBogusIdIntoUrl(e: ImportedEndpoint): string | null {
  try {
    const u = new URL(e.url);
    const template = e.pathTemplate || u.pathname;
    if (/[{:]/.test(template)) {
      let replaced = false;
      const path = template
        .replace(/\{([^}]+)\}/g, (_m, k: string) => { if (isIdParam(k)) { replaced = true; return BOGUS_NUM; } return exampleForParam(k); })
        .replace(/:([A-Za-z_][A-Za-z0-9_]*)/g, (_m, k: string) => { if (isIdParam(k)) { replaced = true; return BOGUS_NUM; } return exampleForParam(k); });
      return replaced ? u.origin + ensureLeadingSlash(path) + (u.search || '') : null;
    }
    let replaced = false;
    const swapped = u.pathname.replace(/\/([^/]+)(\/?)$/, (m, seg: string, tail: string) => {
      if (!isIdLikeSegment(seg)) return m;
      replaced = true;
      const bogus = /^[0-9a-f]{24}$/i.test(seg) ? BOGUS_MONGO : /^[0-9a-f]{8}-/i.test(seg) ? BOGUS_UUID : BOGUS_NUM;
      return `/${bogus}${tail}`;
    });
    return replaced ? u.origin + swapped + (u.search || '') : null;
  } catch { return null; }
}

/**
 * For every read-by-id endpoint, emit a one-step negative test: request the SAME
 * endpoint with a bogus (non-existent) id, KEEPING credentials, and assert a
 * client not-found status (400/404/410) — so a missing resource can't silently
 * return 200 with another record's data. Reads only (safe); auth is kept so this
 * isolates the not-found contract from the unauthenticated case (that's the auth
 * guard). Deduped by method+path, capped.
 */
function buildNotFoundFlows(endpoints: ImportedEndpoint[]): SuggestedFlow[] {
  const out: SuggestedFlow[] = [];
  const seen = new Set<string>();
  for (const e of endpoints) {
    if (out.length >= MAX_NOT_FOUND_FLOWS) break;
    if (!isIdTargetedRead(e)) continue;
    const url = injectBogusIdIntoUrl(e);
    if (!url) continue;
    const key = pathOnly(url);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      name: `Not found — ${resourceLabel(e)}`,
      description: `GET ${pathOnly(e.url)} with a non-existent id must return a client not-found status (400/404/410), not 200.`,
      resource: e.resource || '',
      steps: [{
        name: 'read non-existent id',
        method: 'GET',
        url,
        headers: (e.headers || []).map((h) => ({ key: h.key, value: h.value })),
        auth: e.auth,   // keep credentials — a missing resource, not an unauthorized one
        checks: [{ kind: 'status', oneOf: [400, 404, 410] }],
      }],
      variables: {},
      suggested: true,
      hasWrites: false,
    });
  }
  return out;
}

/**
 * Build a cross-service journey: create the first resource, capture the id it
 * mints, and inject that id into each later step wherever the analyzer said it
 * belongs — a path placeholder, a query param, or a request-body field.
 */
function buildCrossServiceFlow(flow: ApiFlow, endpoints: ImportedEndpoint[]): SuggestedFlow | null {
  if (flow.steps.length < 2) return null;
  const createEp = endpoints[flow.steps[0]!];
  if (!createEp) return null;
  const idPath = detectIdPath(createEp);
  const bindings = flow.bindings || [];
  const capVar = bindings[0]?.var || ID_VAR;
  let hasWrites = false;
  const steps: FlowStep[] = [];

  flow.steps.forEach((idx, i) => {
    const e = endpoints[idx];
    if (!e) return;
    const method = (e.method || 'GET').toUpperCase();
    if (WRITE_METHODS.has(method)) hasWrites = true;

    if (i === 0) {
      steps.push({
        name: 'create',
        method,
        url: e.url,
        headers: (e.headers || []).map((h) => ({ key: h.key, value: h.value })),
        auth: e.auth,
        body: e.body,
        extract: [{ name: capVar, from: 'body', path: idPath }],
        checks: [statusCheck(e, method, method === 'POST', false, false), { kind: 'jsonPathExists', path: idPath }],
      });
      return;
    }

    const binding = bindings.find((b) => b.toStep === i);
    let url = e.url;
    let body = e.body;
    if (binding) {
      if (binding.into === 'path') url = injectVarIntoPath(e, binding.target, binding.var);
      else if (binding.into === 'query') url = injectVarIntoQuery(e, binding.target, binding.var);
      else if (binding.into === 'body') body = injectVarIntoBody(e.body, binding.target, binding.var);
    }
    steps.push({
      name: `${method.toLowerCase()} ${e.resource || ''}`.trim() || method.toLowerCase(),
      method,
      url,
      headers: (e.headers || []).map((h) => ({ key: h.key, value: h.value })),
      auth: e.auth,
      body,
      checks: [statusCheck(e, method, method === 'POST', false, false)],
    });
  });

  if (steps.length < 2) return null;
  return {
    name: flow.name.replace(/\b\w/g, (c) => c.toUpperCase()),
    description: flow.description,
    resource: flow.resource,
    steps,
    variables: {},
    suggested: true,
    hasWrites,
  };
}

/** Replace a named path placeholder with {{var}}; other placeholders get examples. */
function injectVarIntoPath(e: ImportedEndpoint, target: string, varName: string): string {
  try {
    const u = new URL(e.url);
    const template = e.pathTemplate || u.pathname;
    const path = template
      .replace(/\{([^}]+)\}/g, (_m, k: string) => (k.toLowerCase() === target.toLowerCase() ? `{{${varName}}}` : exampleForParam(k)))
      .replace(/:([A-Za-z_][A-Za-z0-9_]*)/g, (_m, k: string) => (k.toLowerCase() === target.toLowerCase() ? `{{${varName}}}` : exampleForParam(k)));
    return u.origin + ensureLeadingSlash(path) + (u.search || '');
  } catch {
    return e.url;
  }
}

/** Set (or add) a query param to {{var}}, keeping the literal braces. */
function injectVarIntoQuery(e: ImportedEndpoint, target: string, varName: string): string {
  try {
    const u = new URL(e.url);
    const kept = (u.search ? u.search.slice(1).split('&') : [])
      .filter((p) => decodeURIComponent((p.split('=')[0] || '')).toLowerCase() !== target.toLowerCase());
    kept.push(`${encodeURIComponent(target)}={{${varName}}}`);
    return `${u.origin}${u.pathname}?${kept.join('&')}`;
  } catch {
    return e.url;
  }
}

/** Set a body field (JSON key, up to two levels) to {{var}}; raw fallback via regex. */
function injectVarIntoBody(body: string | undefined, target: string, varName: string): string | undefined {
  if (!body) return body;
  const value = `{{${varName}}}`;
  try {
    const doc = JSON.parse(body);
    if (doc && typeof doc === 'object') {
      if (setKeyDeep(doc, target, value)) return JSON.stringify(doc, null, 2);
    }
    return body;
  } catch {
    return body.replace(new RegExp(`("${target}"\\s*:\\s*)("[^"]*"|-?\\d+(?:\\.\\d+)?|true|false|null)`, 'i'), `$1"${value}"`);
  }
}

function setKeyDeep(o: any, target: string, value: string, depth = 0): boolean {
  if (!o || typeof o !== 'object' || depth > 2) return false;
  for (const k of Object.keys(o)) if (k.toLowerCase() === target.toLowerCase()) { o[k] = value; return true; }
  for (const k of Object.keys(o)) if (setKeyDeep(o[k], target, value, depth + 1)) return true;
  return false;
}

/** Turn one detected journey into runnable steps. */
function buildRunnableFlow(flow: ApiFlow, endpoints: ImportedEndpoint[], profile: ApiProfile): SuggestedFlow | null {
  const resource = profile.resources.find((r) => r.name === flow.resource);
  const ops = resource?.operations;
  const createIdx = ops?.create;
  const listIdx = ops?.list;
  const delIdx = ops?.delete;

  // Which step mints the id, and where it lives in that step's response.
  const captureIdx = createIdx !== undefined ? createIdx : listIdx;
  const capturePath = captureIdx === undefined ? ID_VAR
    : captureIdx === createIdx ? detectIdPath(endpoints[captureIdx])
      : detectListIdPath(endpoints[captureIdx]);

  const steps: FlowStep[] = [];
  let captured = false;
  let sawDelete = false;
  let hasWrites = false;
  let wrappedRead = false;

  flow.steps.forEach((idx) => {
    const e = endpoints[idx];
    if (!e) return;
    const method = (e.method || 'GET').toUpperCase();
    if (WRITE_METHODS.has(method)) hasWrites = true;

    const isCapture = idx === captureIdx && !captured;
    const isDelete = delIdx !== undefined && idx === delIdx && !sawDelete;
    // A read of the resource AFTER its delete step should now be gone.
    const isConfirmGone = sawDelete && method === 'GET';
    // Single-resource steps (anything that isn't the collection-level
    // create/list) carry the id we captured, so inject {{id}} into the path.
    const injectId = captured && !isCapture;
    // The first read of the just-created resource — poll it (create may be async).
    const isReadAfterCreate = createIdx !== undefined && captured && method === 'GET' && injectId && !isConfirmGone && !wrappedRead;

    const url = injectId ? injectIdIntoUrl(e, resource) : e.url;
    const checks: FlowCheck[] = [statusCheck(e, method, isCapture && idx === createIdx, isDelete, isConfirmGone)];

    const step: FlowStep = {
      name: stepName(method, e, idx, { createIdx, listIdx, delIdx, isConfirmGone }),
      method,
      url,
      // Delete (and the 404 check after it) is cleanup — it runs in teardown so
      // the created resource is removed even if a read/update step fails.
      phase: isDelete || isConfirmGone ? 'teardown' : 'main',
      headers: (e.headers || []).map((h) => ({ key: h.key, value: h.value })),
      auth: e.auth,
      body: e.body,
      checks,
    };

    if (isCapture) {
      step.extract = [{ name: ID_VAR, from: 'body', path: capturePath }];
      step.checks!.push({ kind: 'jsonPathExists', path: capturePath });
      captured = true;
    }
    if (isDelete) sawDelete = true;

    // Wrap reads that race against eventual consistency in a poll (the inner
    // status check still owns the verdict, so a success on any attempt passes).
    if (isConfirmGone) { steps.push(pollWrap(step, 'status == 404')); }
    else if (isReadAfterCreate) { steps.push(pollWrap(step, 'status >= 200 && status < 300')); wrappedRead = true; }
    else { steps.push(step); }
  });

  if (steps.length < 2) return null;
  return {
    name: flow.name.replace(/\b\w/g, (c) => c.toUpperCase()),
    description: flow.description,
    resource: flow.resource,
    steps,
    variables: {},
    suggested: true,
    hasWrites,
  };
}

/** The status a step is expected to return. */
function statusCheck(e: ImportedEndpoint, method: string, isCreate: boolean, isDelete: boolean, isConfirmGone: boolean): FlowCheck {
  if (isConfirmGone) return { kind: 'status', equals: 404 };
  if (Number.isInteger(e.expectedStatus)) return { kind: 'status', equals: e.expectedStatus as number };
  if (isCreate) return { kind: 'status', oneOf: [200, 201] };
  if (isDelete) return { kind: 'status', oneOf: [200, 202, 204] };
  if (method === 'POST') return { kind: 'status', oneOf: [200, 201] };
  return { kind: 'status', oneOf: [200] };
}

function stepName(method: string, e: ImportedEndpoint, idx: number, ctx: { createIdx?: number; listIdx?: number; delIdx?: number; isConfirmGone: boolean }): string {
  if (ctx.isConfirmGone) return 'confirm gone';
  if (idx === ctx.createIdx) return 'create';
  if (idx === ctx.listIdx) return 'list';
  if (idx === ctx.delIdx) return 'delete';
  if (method === 'GET') return 'read';
  if (method === 'PUT' || method === 'PATCH') return 'update';
  return `${method.toLowerCase()} ${e.resource || ''}`.trim().slice(0, 40);
}

/** `id` ⇒ which field of a create response holds it. */
function detectIdPath(e?: ImportedEndpoint): string {
  const body = parse(e?.expectedResponse);
  if (isObj(body)) {
    if ('id' in body) return 'id';
    if (isObj(body.data) && 'id' in body.data) return 'data.id';
  }
  return 'id';
}

/** Which path of a list response holds the first item's id. */
function detectListIdPath(e?: ImportedEndpoint): string {
  const body = parse(e?.expectedResponse);
  if (Array.isArray(body)) return '0.id';
  if (isObj(body)) {
    for (const key of ['data', 'items', 'results', 'records', 'rows']) {
      if (Array.isArray(body[key])) return `${key}.0.id`;
    }
  }
  return 'data.0.id';
}

/** Rewrite a single-resource URL so its id segment becomes {{id}}. */
function injectIdIntoUrl(e: ImportedEndpoint, resource?: Resource): string {
  const idParam = resource?.idParam;
  try {
    const u = new URL(e.url);
    const template = e.pathTemplate || u.pathname;
    if (/[{:]/.test(template)) {
      const path = template
        .replace(/\{([^}]+)\}/g, (_m, k: string) => (isIdParam(k, idParam) ? `{{${ID_VAR}}}` : exampleForParam(k)))
        .replace(/:([A-Za-z_][A-Za-z0-9_]*)/g, (_m, k: string) => (isIdParam(k, idParam) ? `{{${ID_VAR}}}` : exampleForParam(k)));
      return u.origin + ensureLeadingSlash(path) + (u.search || '');
    }
    // Concrete path (e.g. /users/1) — swap the last id-like segment.
    const swapped = u.pathname.replace(/\/([^/]+)(\/?)$/, (m, seg: string, tail: string) => (isIdLikeSegment(seg) ? `/{{${ID_VAR}}}${tail}` : m));
    return u.origin + swapped + (u.search || '');
  } catch {
    return e.url;
  }
}

function isIdParam(name: string, idParam?: string): boolean {
  const n = (name || '').toLowerCase();
  if (idParam && n === idParam.toLowerCase()) return true;
  return n === 'id' || /(^|_)id$/.test(n) || n.endsWith('id');
}

function isIdLikeSegment(seg: string): boolean {
  return /^\d+$/.test(seg) || /^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(seg) || /^[0-9a-f]{24}$/i.test(seg);
}

function ensureLeadingSlash(p: string): string {
  return p.startsWith('/') ? p : `/${p}`;
}

function isObj(v: unknown): v is Record<string, any> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function parse(text?: string): unknown {
  if (!text) return undefined;
  try { return JSON.parse(text); } catch { return undefined; }
}
