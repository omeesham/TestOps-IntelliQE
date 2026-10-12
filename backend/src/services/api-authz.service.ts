/**
 * api-authz.service.ts
 * ────────────────────
 * Multi-role authorization testing — the OWASP API Security Top-10 class that a
 * single-account scan can't reach: API1 (BOLA / Broken Object Level Auth) and
 * API5 (BFLA / Broken Function Level Auth).
 *
 * The caller supplies two or more IDENTITIES (each a set of credentials for a
 * different user/role). For every endpoint we:
 *   • probe it UNAUTHENTICATED to learn whether it is protected at all;
 *   • probe it as the OWNER identity (expected to succeed);
 *   • probe it as every OTHER identity — on a protected, resource-scoped
 *     endpoint a different user getting 2xx is a BOLA leak;
 *   • flag BFLA when a privileged-looking function is reachable by a
 *     non-owner identity.
 *
 * Non-destructive: write verbs (POST/PUT/PATCH/DELETE) are skipped unless the
 * caller explicitly opts in with allowWrites. Standalone and opt-in — it live-
 * probes the API and never touches the generate → execute → heal pipeline.
 */
import { fetchFull, buildHeaders, isWriteMethod, type HttpAuth, type HttpEndpoint } from '../utils/api-http.js';

export interface AuthzIdentity {
  label: string;
  auth?: HttpAuth;
  headers?: { key: string; value: string }[];
}

export interface AuthzEndpointInput extends HttpEndpoint {
  id: string;
  title?: string;
  /** label of the identity that legitimately owns this resource (defaults to the first identity). */
  owner?: string;
}

export type Severity = 'high' | 'medium' | 'low' | 'info';
export type FindingStatus = 'vulnerable' | 'ok' | 'info' | 'skipped';
export type AuthzCheck = 'bola' | 'bfla' | 'unauth' | 'baseline';

export interface AuthzFinding {
  endpointId: string;
  title: string;
  method: string;
  url: string;
  check: AuthzCheck;
  severity: Severity;
  status: FindingStatus;
  detail: string;
  identities?: string[];
  statuses?: Record<string, number | string>;
}

export interface AuthzReport {
  findings: AuthzFinding[];
  summary: { endpoints: number; identities: number; vulnerable: number; high: number; medium: number; low: number; info: number };
}

const MAX_ENDPOINTS = 40;
const CONCURRENCY = 4;
/** Paths/titles that look like privileged or administrative functions (BFLA candidates). */
const PRIVILEGED_RE = /(^|[\/_-])(admin|administrator|manage|management|internal|config|configuration|settings|role|roles|permission|permissions|grant|revoke|promote|disable|enable|suspend|approve|audit|billing|invoice|payout|sudo|superuser|system)(\b|[\/_-])/i;

function is2xx(s?: number): boolean { return s !== undefined && s >= 200 && s < 300; }

/** Build headers for one identity: the endpoint's own non-auth headers + the identity's creds. */
function headersForIdentity(ep: AuthzEndpointInput, identity?: AuthzIdentity): Record<string, string> {
  // Start from the endpoint's own headers but strip any baked-in auth header.
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

async function probeAs(ep: AuthzEndpointInput, identity?: AuthzIdentity) {
  const method = (ep.method || 'GET').toUpperCase();
  const headers = headersForIdentity(ep, identity);
  const body = isWriteMethod(method) && ep.body ? ep.body : undefined;
  if (body && !Object.keys(headers).some((k) => k.toLowerCase() === 'content-type')) headers['Content-Type'] = 'application/json';
  return fetchFull(ep.url, { method, headers, body });
}

async function scanOne(ep: AuthzEndpointInput, identities: AuthzIdentity[], allowWrites: boolean): Promise<AuthzFinding[]> {
  const method = (ep.method || 'GET').toUpperCase();
  const title = ep.title || `${method} ${ep.url}`;
  const out: AuthzFinding[] = [];
  const mk = (check: AuthzCheck, severity: Severity, status: FindingStatus, detail: string, extra: Partial<AuthzFinding> = {}): AuthzFinding =>
    ({ endpointId: ep.id, title, method, url: ep.url, check, severity, status, detail, ...extra });

  if (isWriteMethod(method) && !allowWrites) {
    return [mk('baseline', 'info', 'skipped', 'Write method skipped — enable "Test write methods" to exercise it (it will send real requests as each identity).')];
  }

  const owner = identities.find((i) => i.label === ep.owner) || identities[0]!;
  const others = identities.filter((i) => i.label !== owner.label);

  // 1) Unauthenticated probe — is the endpoint protected at all?
  const unauth = await probeAs(ep, undefined);
  if (unauth.error) {
    return [mk('baseline', 'info', 'info', `Endpoint could not be reached: ${unauth.error}`)];
  }
  const publicEndpoint = is2xx(unauth.status);
  if (publicEndpoint) {
    out.push(mk('unauth', 'high', 'vulnerable', `Returned ${unauth.status} with NO credentials — the endpoint is unauthenticated, so object-level access can't be enforced.`, { statuses: { anonymous: unauth.status! } }));
  } else {
    out.push(mk('unauth', 'high', 'ok', `Rejected the anonymous request (${unauth.status ?? unauth.error}).`, { statuses: { anonymous: unauth.status ?? 'err' } }));
  }

  // 2) Owner probe — establish the authorized baseline.
  const ownerRes = await probeAs(ep, owner);
  out.push(mk('baseline', 'info', 'info', `Owner "${owner.label}" received ${ownerRes.status ?? ownerRes.error}.`, { identities: [owner.label], statuses: { [owner.label]: ownerRes.status ?? 'err' } }));
  if (!is2xx(ownerRes.status)) {
    out.push(mk('bola', 'medium', 'info', `Could not assess cross-user access — the owner identity did not get a 2xx (got ${ownerRes.status ?? ownerRes.error}). Check the owner credentials / resource id.`));
    return out;
  }

  // 3) Each other identity — on a protected, resource-scoped endpoint they should be denied.
  const privileged = PRIVILEGED_RE.test(ep.url) || PRIVILEGED_RE.test(title);
  for (const other of others) {
    const res = await probeAs(ep, other);
    const statuses = { [owner.label]: ownerRes.status!, [other.label]: res.status ?? ('err' as const) };
    if (is2xx(res.status)) {
      if (publicEndpoint) {
        out.push(mk('bola', 'low', 'info', `"${other.label}" got ${res.status}, but the endpoint is public (anonymous also succeeds), so this isn't a cross-user leak on its own.`, { identities: [owner.label, other.label], statuses }));
      } else if (privileged) {
        out.push(mk('bfla', 'high', 'vulnerable', `BFLA: privileged function reachable by "${other.label}" (${res.status}). A lower-privilege role should not reach an admin/management function.`, { identities: [owner.label, other.label], statuses }));
      } else {
        out.push(mk('bola', 'high', 'vulnerable', `BOLA: "${other.label}" received ${res.status} on a resource owned by "${owner.label}". A protected, user-scoped object should return 403/404 to other users. (Verify this is a per-user resource and not a shared one.)`, { identities: [owner.label, other.label], statuses }));
      }
    } else {
      out.push(mk(privileged ? 'bfla' : 'bola', privileged ? 'high' : 'high', 'ok', `"${other.label}" was correctly denied (${res.status ?? res.error}) while "${owner.label}" succeeded.`, { identities: [owner.label, other.label], statuses }));
    }
  }

  return out;
}

export function normalizeIdentities(raw: unknown): AuthzIdentity[] {
  if (!Array.isArray(raw)) return [];
  const out: AuthzIdentity[] = [];
  for (const r of raw.slice(0, 8)) {
    if (!r || typeof r !== 'object') continue;
    const o = r as Record<string, any>;
    const label = String(o.label || '').trim().slice(0, 60);
    if (!label) continue;
    out.push({
      label,
      auth: o.auth && typeof o.auth === 'object'
        ? { type: String(o.auth.type || 'none'), value: o.auth.value ? String(o.auth.value) : undefined, headerName: o.auth.headerName ? String(o.auth.headerName) : undefined }
        : undefined,
      headers: Array.isArray(o.headers) ? o.headers.filter((h: any) => h?.key).map((h: any) => ({ key: String(h.key), value: String(h.value ?? '') })) : [],
    });
  }
  return out;
}

export function normalizeAuthzEndpoints(raw: unknown): AuthzEndpointInput[] {
  if (!Array.isArray(raw)) return [];
  const out: AuthzEndpointInput[] = [];
  for (const e of raw.slice(0, MAX_ENDPOINTS)) {
    if (!e || typeof e !== 'object') continue;
    const ep = e as Record<string, any>;
    const url = String(ep.url || '').trim();
    if (!/^https?:\/\//i.test(url)) continue;
    out.push({
      id: String(ep.id || url),
      title: ep.title ? String(ep.title) : undefined,
      method: String(ep.method || 'GET'),
      url,
      headers: Array.isArray(ep.headers) ? ep.headers.filter((h: any) => h?.key).map((h: any) => ({ key: String(h.key), value: String(h.value ?? '') })) : [],
      body: ep.body ? String(ep.body) : undefined,
      owner: ep.owner ? String(ep.owner).slice(0, 60) : undefined,
    });
  }
  return out;
}

export async function runAuthzScan(rawEndpoints: unknown, rawIdentities: unknown, opts: { allowWrites?: boolean } = {}): Promise<AuthzReport> {
  const endpoints = normalizeAuthzEndpoints(rawEndpoints);
  const identities = normalizeIdentities(rawIdentities);
  if (identities.length < 2) {
    throw new Error('Multi-role authorization testing needs at least two identities (e.g. two users, or a user and an admin).');
  }
  const all: AuthzFinding[][] = new Array(endpoints.length);
  let next = 0;
  async function worker(): Promise<void> {
    while (next < endpoints.length) {
      const i = next++;
      try { all[i] = await scanOne(endpoints[i]!, identities, !!opts.allowWrites); }
      catch (e) { all[i] = [{ endpointId: endpoints[i]!.id, title: endpoints[i]!.title || endpoints[i]!.url, method: (endpoints[i]!.method || 'GET').toUpperCase(), url: endpoints[i]!.url, check: 'baseline', severity: 'info', status: 'info', detail: `Scan error: ${(e as Error).message}` }]; }
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
      vulnerable: vuln.length,
      high: vuln.filter((f) => f.severity === 'high').length,
      medium: vuln.filter((f) => f.severity === 'medium').length,
      low: vuln.filter((f) => f.severity === 'low').length,
      info: findings.filter((f) => f.status === 'info').length,
    },
  };
}
