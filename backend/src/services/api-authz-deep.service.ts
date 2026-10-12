/**
 * api-authz-deep.service.ts
 * ─────────────────────────
 * Dynamic, multi-role security PROOF — the depth layer over the single-account
 * OWASP heuristics and the BOLA/BFLA scanner (api-authz). Where api-authz proves
 * API1/API5 (object- and function-level auth), this proves the rest of the
 * authenticated-scan surface that static path-regex checks only GUESS at:
 *
 *   • Excessive data exposure (API3) — a response carrying sensitive fields
 *     (tokens, password hashes, SSNs, other users' PII), and worse when a
 *     lower-privilege identity receives MORE fields than the owner's view should
 *     contain.
 *   • Mass assignment (API6/API3) — a write that silently ACCEPTS an injected
 *     privileged field (role=admin, isAdmin=true, verified=true) and echoes it
 *     back. (opt-in: this fires a real write.)
 *   • Broken-auth write (API2) — a write that succeeds with NO credentials.
 *     (opt-in: fires a real write.)
 *   • Method tampering (API5) — a privileged verb (PUT/PATCH/DELETE) reachable
 *     by a non-owner identity where it should be denied. (opt-in: fires a write.)
 *
 * Every finding carries the request/response EVIDENCE that proves it, not a
 * static guess. Reuses the identity model from api-authz; non-destructive by
 * default (read-only checks only) — write-based checks require allowWrites.
 * Standalone, opt-in; the generate → execute → heal pipeline is never touched.
 */
import { fetchFull, buildHeaders, isWriteMethod, type HttpAuth } from '../utils/api-http.js';
import {
  normalizeIdentities, normalizeAuthzEndpoints,
  type AuthzIdentity, type AuthzEndpointInput, type Severity, type FindingStatus,
} from './api-authz.service.js';

export type DeepCheck = 'excessive-data' | 'mass-assignment' | 'unauth-write' | 'method-tamper';

export interface DeepFinding {
  endpointId: string;
  title: string;
  method: string;
  url: string;
  check: DeepCheck;
  category: string;               // OWASP API category label
  severity: Severity;
  status: FindingStatus;
  detail: string;
  identities?: string[];
  evidence?: { request?: string; response?: string; fields?: string[] };
}

export interface DeepReport {
  findings: DeepFinding[];
  summary: { endpoints: number; identities: number; checksRun: DeepCheck[]; vulnerable: number; high: number; medium: number; low: number; info: number; writesFired: number };
  notes: string[];
}

const MAX_ENDPOINTS = 40;
const CONCURRENCY = 3;

/** Sensitive field-name / value detectors (key-name first, then a couple of value shapes). */
const SENSITIVE_KEYS = /(password|passwd|pwd|secret|token|apikey|api_key|access_key|private_key|ssn|social_security|credit_?card|card_?number|cvv|iban|routing|salary|is_?admin|isadmin|role|privilege|permission|auth|session|refresh_token)/i;
const SENSITIVE_VALUE = [
  { name: 'JWT', re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}\b/ },
  { name: 'bcrypt hash', re: /\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}/ },
  { name: 'SSN', re: /\b\d{3}-\d{2}-\d{4}\b/ },
  { name: 'credit card', re: /\b(?:\d[ -]?){13,16}\b/ },
];

/** Build headers for one identity: the endpoint's own non-auth headers + the identity's creds. */
function headersForIdentity(ep: AuthzEndpointInput, identity?: AuthzIdentity): Record<string, string> {
  const base = buildHeaders({ ...ep, auth: undefined }, { omitAuth: true });
  for (const k of Object.keys(base)) { if (/^authorization$/i.test(k) || /^x-api-key$/i.test(k)) delete base[k]; }
  if (identity) {
    for (const h of identity.headers || []) { if (h?.key) base[h.key] = h.value ?? ''; }
    const a = identity.auth;
    if (a && a.type !== 'none' && a.value) {
      if (a.type === 'bearer' || a.type === 'oauth2') base['Authorization'] = `Bearer ${a.value}`;
      else if (a.type === 'basic') base['Authorization'] = `Basic ${Buffer.from(a.value).toString('base64')}`;
      else if (a.type === 'apikey') base[a.headerName || 'X-API-Key'] = a.value;
    }
  }
  return base;
}

function is2xx(s?: number): boolean { return s !== undefined && s >= 200 && s < 300; }

async function send(ep: AuthzEndpointInput, identity: AuthzIdentity | undefined, method: string, body?: string) {
  const headers = headersForIdentity(ep, identity);
  if (body && !Object.keys(headers).some((k) => k.toLowerCase() === 'content-type')) headers['Content-Type'] = 'application/json';
  return fetchFull(ep.url, { method: method.toUpperCase(), headers, body });
}

/** Walk a JSON value and collect sensitive-looking keys + value hits (bounded). */
function scanSensitive(bodyText: string): { fields: string[]; valueHits: string[] } {
  const fields = new Set<string>();
  const valueHits = new Set<string>();
  for (const v of SENSITIVE_VALUE) { if (v.re.test(bodyText)) valueHits.add(v.name); }
  let parsed: unknown;
  try { parsed = JSON.parse(bodyText); } catch { return { fields: [], valueHits: [...valueHits] }; }
  const walk = (node: unknown, depth: number): void => {
    if (fields.size > 30 || depth > 6 || node == null || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.slice(0, 10).forEach((el) => walk(el, depth + 1)); return; }
    for (const [k, val] of Object.entries(node as Record<string, unknown>)) {
      if (SENSITIVE_KEYS.test(k)) fields.add(k);
      walk(val, depth + 1);
    }
  };
  walk(parsed, 0);
  return { fields: [...fields], valueHits: [...valueHits] };
}

function fieldSet(bodyText: string): Set<string> {
  const out = new Set<string>();
  try {
    const v = JSON.parse(bodyText);
    const obj = Array.isArray(v) ? v[0] : v;
    if (obj && typeof obj === 'object') for (const k of Object.keys(obj)) out.add(k);
  } catch { /* non-json */ }
  return out;
}

/** Inject privileged fields into a JSON body (or synthesize one) for the mass-assignment probe. */
const PRIV_INJECT: Record<string, unknown> = { role: 'admin', isAdmin: true, is_admin: true, admin: true, verified: true, isVerified: true, status: 'active', permissions: ['*'] };
function injectPrivileged(body?: string): { body: string; injected: string[] } {
  let base: Record<string, unknown> = {};
  if (body) { try { const p = JSON.parse(body); if (p && typeof p === 'object' && !Array.isArray(p)) base = p as Record<string, unknown>; } catch { /* start fresh */ } }
  const injected: string[] = [];
  for (const [k, v] of Object.entries(PRIV_INJECT)) { if (!(k in base)) { base[k] = v; injected.push(k); } }
  return { body: JSON.stringify(base), injected };
}

interface ScanCtx { allowWrites: boolean; checks: Set<DeepCheck>; writesFired: { n: number } }

async function scanOne(ep: AuthzEndpointInput, identities: AuthzIdentity[], ctx: ScanCtx): Promise<DeepFinding[]> {
  const method = (ep.method || 'GET').toUpperCase();
  const title = ep.title || `${method} ${ep.url}`;
  const out: DeepFinding[] = [];
  const owner = identities.find((i) => i.label === ep.owner) || identities[0]!;
  const others = identities.filter((i) => i.label !== owner.label);
  const mk = (check: DeepCheck, category: string, severity: Severity, status: FindingStatus, detail: string, extra: Partial<DeepFinding> = {}): DeepFinding =>
    ({ endpointId: ep.id, title, method, url: ep.url, check, category, severity, status, detail, ...extra });

  /* ── 1) Excessive data exposure (read-only; API3) ── */
  if (ctx.checks.has('excessive-data') && !isWriteMethod(method)) {
    const ownerRes = await send(ep, owner, method);
    if (is2xx(ownerRes.status)) {
      const s = scanSensitive(ownerRes.bodyText);
      const ownerFields = fieldSet(ownerRes.bodyText);
      if (s.fields.length || s.valueHits.length) {
        out.push(mk('excessive-data', 'API3:2023 Broken Object Property Level Authorization', s.valueHits.length ? 'high' : 'medium', 'vulnerable',
          `Response to "${owner.label}" exposes sensitive data: ${[...s.fields, ...s.valueHits.map((v) => `(${v})`)].slice(0, 10).join(', ')}. Confirm the client needs these fields; prefer an explicit allow-list / DTO.`,
          { identities: [owner.label], evidence: { response: ownerRes.bodyText.slice(0, 400), fields: s.fields } }));
      }
      // Field-level diff: a lower-privilege identity receiving the same/more fields on the owner's object.
      for (const other of others) {
        const r = await send(ep, other, method);
        if (is2xx(r.status)) {
          const otherFields = fieldSet(r.bodyText);
          const extra = [...otherFields].filter((f) => SENSITIVE_KEYS.test(f) && ownerFields.has(f));
          if (extra.length) {
            out.push(mk('excessive-data', 'API3:2023 Broken Object Property Level Authorization', 'high', 'vulnerable',
              `"${other.label}" received sensitive fields (${extra.slice(0, 8).join(', ')}) on a resource scoped to "${owner.label}". Lower-privilege roles should get a reduced view.`,
              { identities: [owner.label, other.label], evidence: { response: r.bodyText.slice(0, 300), fields: extra } }));
          }
        }
      }
    }
  }

  /* ── 2) Broken-auth write: an unauthenticated write that succeeds (opt-in; API2) ── */
  if (ctx.checks.has('unauth-write') && isWriteMethod(method)) {
    if (!ctx.allowWrites) {
      out.push(mk('unauth-write', 'API2:2023 Broken Authentication', 'info', 'skipped', 'Write check skipped — enable "allow writes" to fire a real unauthenticated write.'));
    } else {
      ctx.writesFired.n++;
      const r = await send(ep, undefined, method, ep.body);
      if (is2xx(r.status)) out.push(mk('unauth-write', 'API2:2023 Broken Authentication', 'high', 'vulnerable', `An unauthenticated ${method} succeeded (${r.status}). A state-changing endpoint must reject anonymous requests.`, { evidence: { request: `${method} ${ep.url} (no auth)`, response: r.bodyText.slice(0, 200) } }));
      else out.push(mk('unauth-write', 'API2:2023 Broken Authentication', 'high', 'ok', `Anonymous ${method} was correctly rejected (${r.status ?? r.error}).`));
    }
  }

  /* ── 3) Mass assignment: a write that accepts injected privileged fields (opt-in; API6) ── */
  if (ctx.checks.has('mass-assignment') && isWriteMethod(method)) {
    if (!ctx.allowWrites) {
      out.push(mk('mass-assignment', 'API6:2023 Unrestricted Access to Sensitive Business Flows', 'info', 'skipped', 'Mass-assignment check skipped — enable "allow writes" to send a privileged-field write.'));
    } else {
      const { body, injected } = injectPrivileged(ep.body);
      ctx.writesFired.n++;
      const r = await send(ep, owner, method, body);
      if (is2xx(r.status)) {
        const echoed = injected.filter((k) => new RegExp(`"${k}"\\s*:`).test(r.bodyText));
        if (echoed.length) out.push(mk('mass-assignment', 'API6:2023 Mass Assignment', 'high', 'vulnerable', `Injected privileged field(s) ${echoed.join(', ')} were accepted and echoed back (${r.status}). The endpoint binds client input without an allow-list.`, { identities: [owner.label], evidence: { request: body.slice(0, 200), response: r.bodyText.slice(0, 300), fields: echoed } }));
        else out.push(mk('mass-assignment', 'API6:2023 Mass Assignment', 'medium', 'info', `Write accepted (${r.status}) but injected privileged fields were not echoed — can't confirm binding from the response alone; verify server-side.`, { identities: [owner.label] }));
      } else {
        out.push(mk('mass-assignment', 'API6:2023 Mass Assignment', 'low', 'ok', `Privileged-field write was rejected (${r.status ?? r.error}).`, { identities: [owner.label] }));
      }
    }
  }

  /* ── 4) Method tampering: a privileged verb reachable by a non-owner (opt-in; API5) ── */
  if (ctx.checks.has('method-tamper')) {
    const tamperVerbs = ['PUT', 'PATCH', 'DELETE'].filter((v) => v !== method);
    if (!ctx.allowWrites) {
      out.push(mk('method-tamper', 'API5:2023 Broken Function Level Authorization', 'info', 'skipped', 'Method-tampering check skipped — enable "allow writes" to attempt alternate verbs.'));
    } else {
      for (const other of others.slice(0, 1)) {
        for (const verb of tamperVerbs.slice(0, 2)) {
          ctx.writesFired.n++;
          const r = await send(ep, other, verb, verb === 'DELETE' ? undefined : (ep.body || '{}'));
          if (is2xx(r.status)) { out.push(mk('method-tamper', 'API5:2023 Broken Function Level Authorization', 'high', 'vulnerable', `"${other.label}" reached ${verb} on ${ep.url} (${r.status}). The endpoint allows a state-changing verb the identity should not have.`, { identities: [other.label], evidence: { request: `${verb} ${ep.url} as ${other.label}` } })); break; }
        }
      }
    }
  }

  return out;
}

export async function runAuthzDeepScan(
  rawEndpoints: unknown,
  rawIdentities: unknown,
  opts: { allowWrites?: boolean; checks?: unknown } = {},
): Promise<DeepReport> {
  const endpoints = normalizeAuthzEndpoints(rawEndpoints).slice(0, MAX_ENDPOINTS);
  const identities = normalizeIdentities(rawIdentities);
  if (identities.length < 2) throw new Error('Deep authorization testing needs at least two identities (e.g. a normal user and an admin).');

  const ALL: DeepCheck[] = ['excessive-data', 'mass-assignment', 'unauth-write', 'method-tamper'];
  const checks = new Set<DeepCheck>(Array.isArray(opts.checks) && opts.checks.length ? (opts.checks as any[]).map(String).filter((c): c is DeepCheck => (ALL as string[]).includes(c)) : ALL);
  const ctx: ScanCtx = { allowWrites: !!opts.allowWrites, checks, writesFired: { n: 0 } };
  const notes: string[] = [];
  if (!ctx.allowWrites) notes.push('Write-based checks (mass assignment, broken-auth write, method tampering) are skipped until you enable "allow writes" — they send real state-changing requests.');

  const all: DeepFinding[][] = new Array(endpoints.length);
  let next = 0;
  async function worker(): Promise<void> {
    while (next < endpoints.length) {
      const i = next++;
      try { all[i] = await scanOne(endpoints[i]!, identities, ctx); }
      catch (e) { const ep = endpoints[i]!; all[i] = [{ endpointId: ep.id, title: ep.title || ep.url, method: (ep.method || 'GET').toUpperCase(), url: ep.url, check: 'excessive-data', category: '—', severity: 'info', status: 'info', detail: `Scan error: ${(e as Error).message}` }]; }
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, endpoints.length) }, worker));

  const findings = all.flat().filter(Boolean);
  const vuln = findings.filter((f) => f.status === 'vulnerable');
  return {
    findings,
    summary: {
      endpoints: endpoints.length,
      identities: identities.length,
      checksRun: [...checks],
      vulnerable: vuln.length,
      high: vuln.filter((f) => f.severity === 'high').length,
      medium: vuln.filter((f) => f.severity === 'medium').length,
      low: vuln.filter((f) => f.severity === 'low').length,
      info: findings.filter((f) => f.status === 'info').length,
      writesFired: ctx.writesFired.n,
    },
    notes,
  };
}
