/**
 * api-owasp.service.ts
 * ────────────────────
 * The OWASP API Security Top-10 (2023) compliance pack.
 *
 * This is a COMPLIANCE LAYER, not a new scanner. It reuses the existing
 * non-destructive security scan (`runSecurityScan`) for the categories that can
 * be judged dynamically (authentication, misconfiguration) and layers safe,
 * network-free STATIC heuristics over the endpoint catalogue for the categories
 * that dynamic probing cannot responsibly confirm (BOLA/BFLA, SSRF, sensitive
 * flows, inventory). Every category reports one of:
 *
 *   pass · warn · fail · review · not_assessed
 *
 * and — crucially — is honest about *how* it was judged (`assessment`) and what
 * it would take to close a gap (`remediation`). A category this pack cannot
 * safely automate is marked `not_assessed` rather than given a false pass.
 *
 * Standalone and opt-in. It touches no pipeline code and issues no new network
 * calls beyond the ones the reused security scan already makes.
 */
import { runSecurityScan, type SecurityFinding, type SecurityReport } from './api-security.service.js';
import { isWriteMethod } from '../utils/api-http.js';

export type OwaspStatus = 'pass' | 'warn' | 'fail' | 'review' | 'not_assessed';
export type Assessment = 'dynamic' | 'static' | 'none';
export type OwaspGrade = 'A' | 'B' | 'C' | 'D' | 'F';

export interface OwaspCategory {
  id: string;          // e.g. 'API1:2023'
  key: string;         // e.g. 'bola'
  name: string;        // official title
  status: OwaspStatus;
  assessment: Assessment;
  summary: string;     // one-line verdict
  evidence: string[];  // concrete signals behind the verdict
  affected: string[];  // endpoint labels the verdict points at
  remediation: string; // what to do / what closing the gap needs
}

export interface OwaspComplianceReport {
  categories: OwaspCategory[];
  summary: {
    total: number;
    assessed: number;
    passed: number;
    warned: number;
    failed: number;
    review: number;
    notAssessed: number;
    compliancePct: number | null;
    grade: OwaspGrade | null;
    high: number;
    medium: number;
    low: number;
  };
  basis: { endpoints: number; scanned: number; generatedAt: string };
  security: SecurityReport;
}

const MAX_ENDPOINTS = 200;

export interface OwaspEndpoint {
  id: string;
  label: string;
  method: string;
  url: string;
  path: string;
  host: string;
  scheme: string;
  hasAuth: boolean;
  hasBody: boolean;
  deprecated: boolean;
  pathParams: string[];
  queryParams: string[];
}

/* ── Keyword vocabularies for the static heuristics (all lower-case). ── */
const SSRF_PARAMS = ['url', 'uri', 'link', 'callback', 'webhook', 'redirect', 'redirect_uri', 'redirecturi', 'next', 'dest', 'destination', 'target', 'feed', 'image_url', 'imageurl', 'fetch', 'proxy', 'domain', 'site', 'return_url', 'returnurl', 'source', 'endpoint', 'upstream'];
const SENSITIVE_FLOW = ['login', 'signin', 'register', 'signup', 'checkout', 'payment', 'pay', 'purchase', 'order', 'transfer', 'withdraw', 'deposit', 'booking', 'reserve', 'reservation', 'otp', 'verify', 'coupon', 'promo', 'discount', 'vote', 'invite', 'referral', 'refund', 'reset', 'forgot', 'resend', 'subscribe'];
const PRIVILEGED = ['admin', 'internal', 'manage', 'management', 'config', 'configuration', 'setting', 'role', 'permission', 'grant', 'revoke', 'sudo', 'root', 'superuser', 'system', 'debug', 'audit', 'impersonate'];
const PAGINATION_PARAMS = ['limit', 'offset', 'page', 'per_page', 'perpage', 'pagesize', 'page_size', 'size', 'cursor', 'count', 'top', 'skip', 'maxresults', 'max_results', 'start'];
const VERSION_RE = /(^|\/)v(\d+)(\/|$)/i;

function lc(s: unknown): string { return String(s ?? '').toLowerCase(); }
function matchesAny(haystack: string, needles: string[]): string[] {
  const h = haystack.toLowerCase();
  return needles.filter((n) => h.includes(n));
}

function toParamNames(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((p) => (p && typeof p === 'object' ? String((p as Record<string, unknown>).name ?? '') : String(p ?? ''))).filter(Boolean);
}

/** Normalise a raw catalogue endpoint into the fields the heuristics read — defensively. */
export function normalizeOwaspInput(raw: unknown): OwaspEndpoint[] {
  if (!Array.isArray(raw)) return [];
  const out: OwaspEndpoint[] = [];
  for (const e of raw.slice(0, MAX_ENDPOINTS)) {
    if (!e || typeof e !== 'object') continue;
    const ep = e as Record<string, unknown>;
    const url = String(ep.url ?? '').trim();
    if (!url) continue;
    let host = '';
    let scheme = '';
    let path = '';
    try {
      const u = new URL(url);
      host = u.host; scheme = u.protocol.replace(':', ''); path = u.pathname;
    } catch {
      path = url; scheme = /^http:\/\//i.test(url) ? 'http' : /^https:\/\//i.test(url) ? 'https' : '';
    }
    const pathTemplate = ep.pathTemplate ? String(ep.pathTemplate) : path;
    const method = String(ep.method ?? 'GET').toUpperCase();
    const auth = ep.auth as Record<string, unknown> | undefined;
    out.push({
      id: String(ep.id ?? url),
      label: String(ep.title ?? `${method} ${url}`),
      method,
      url,
      path: pathTemplate,
      host,
      scheme,
      hasAuth: !!(auth && auth.type && auth.type !== 'none' && auth.value),
      hasBody: !!ep.body && isWriteMethod(method),
      deprecated: ep.deprecated === true,
      pathParams: toParamNames(ep.pathParams),
      queryParams: toParamNames(ep.queryParams),
    });
  }
  return out;
}

function hasObjectId(ep: OwaspEndpoint): boolean {
  // A templated/variable path segment, or a path param whose name reads like an identifier.
  if (/\{[^}]+\}|:[A-Za-z_]\w*|\/\d+(?:\/|$)/.test(ep.path)) return true;
  return ep.pathParams.some((p) => /(^id$|_id$|Id$|uuid|guid|^key$|slug|number|code)/i.test(p));
}

function weightOf(status: OwaspStatus): number | null {
  switch (status) {
    case 'pass': return 1;
    case 'warn': return 0.5;
    case 'review': return 0.5;
    case 'fail': return 0;
    default: return null; // not_assessed → excluded from the denominator
  }
}

function gradeOf(pct: number): OwaspGrade {
  if (pct >= 90) return 'A';
  if (pct >= 80) return 'B';
  if (pct >= 70) return 'C';
  if (pct >= 60) return 'D';
  return 'F';
}

/** Findings for a set of check names, vulnerable ones first, capped for the UI. */
function evidenceFrom(findings: SecurityFinding[], checks: string[], limit = 6): string[] {
  const set = new Set(checks);
  return findings
    .filter((f) => set.has(f.check) && (f.status === 'vulnerable' || f.status === 'info'))
    .sort((a, b) => (a.status === 'vulnerable' ? 0 : 1) - (b.status === 'vulnerable' ? 0 : 1))
    .slice(0, limit)
    .map((f) => `${f.method} ${f.title} — ${f.detail}`);
}

export async function runOwaspCompliance(rawEndpoints: unknown): Promise<OwaspComplianceReport> {
  const eps = normalizeOwaspInput(rawEndpoints);
  const security = await runSecurityScan(rawEndpoints); // reuse the dynamic, non-destructive scan
  return buildCompliance(eps, security);
}

/**
 * Map normalized endpoints + a security scan onto the ten OWASP API categories.
 * Pure (no IO) so the whole classification is unit-testable with a synthetic scan.
 */
export function buildCompliance(eps: OwaspEndpoint[], security: SecurityReport): OwaspComplianceReport {
  const F = security.findings;
  const vuln = (check: string) => F.filter((f) => f.check === check && f.status === 'vulnerable');

  const anyEndpoints = eps.length > 0;
  const authEps = eps.filter((e) => e.hasAuth);
  const labels = (list: OwaspEndpoint[], n = 8) => list.slice(0, n).map((e) => e.label);

  // ── Dynamic signals ──
  const baVuln = vuln('broken-auth');
  const transportVuln = vuln('transport-security');
  const baTested = F.some((f) => f.check === 'broken-auth' && f.status === 'ok');
  const A8_CHECKS = ['transport-security', 'hsts', 'security-headers', 'cors', 'info-leak', 'injection'];
  // Plaintext transport and leaked internals are compliance failures even though the
  // scanner rates them 'medium' — treat them as high-impact for the misconfiguration verdict.
  const A8_HIGH_CHECKS = new Set(['transport-security', 'info-leak']);
  const a8Vuln = F.filter((f) => A8_CHECKS.includes(f.check) && f.status === 'vulnerable');
  const a8High = a8Vuln.some((f) => f.severity === 'high' || A8_HIGH_CHECKS.has(f.check));
  const a8Med = a8Vuln.some((f) => f.severity === 'medium');

  // ── Static signals ──
  const idEps = eps.filter(hasObjectId);
  const privEps = eps.filter((e) => matchesAny(`${e.path} ${e.label}`, PRIVILEGED).length > 0);
  const writeBodyEps = eps.filter((e) => e.hasBody);
  const collections = eps.filter((e) => e.method === 'GET' && !hasObjectId(e));
  const unbounded = collections.filter((e) => matchesAny(e.queryParams.join(' '), PAGINATION_PARAMS).length === 0);
  const flowEps = eps.filter((e) => matchesAny(`${e.path} ${e.label}`, SENSITIVE_FLOW).length > 0);
  const ssrfEps = eps.filter((e) => matchesAny([...e.queryParams, ...e.pathParams].join(' '), SSRF_PARAMS).length > 0);

  const schemes = new Set(eps.map((e) => e.scheme).filter(Boolean));
  const hosts = new Set(eps.map((e) => e.host).filter(Boolean));
  const plainHttp = eps.filter((e) => e.scheme === 'http');
  const deprecated = eps.filter((e) => e.deprecated);
  const versions = new Set(eps.map((e) => (e.path.match(VERSION_RE) || [])[2]).filter(Boolean));

  const categories: OwaspCategory[] = [];

  // API1:2023 — Broken Object Level Authorization (BOLA)
  categories.push({
    id: 'API1:2023', key: 'bola', name: 'Broken Object Level Authorization',
    ...(baVuln.length && idEps.length
      ? { status: 'fail' as OwaspStatus, assessment: 'dynamic' as Assessment, summary: 'Object-addressing endpoints answered an unauthenticated request — object-level authorization is not enforced.', evidence: baVuln.slice(0, 6).map((f) => `${f.method} ${f.title} — ${f.detail}`), affected: labels(idEps) }
      : idEps.length
        ? { status: 'review' as OwaspStatus, assessment: 'static' as Assessment, summary: `${idEps.length} endpoint${idEps.length === 1 ? '' : 's'} address objects by ID — confirm each checks that the caller owns the requested object.`, evidence: [`ID-addressing endpoints: ${idEps.map((e) => e.path).slice(0, 6).join(', ')}`], affected: labels(idEps) }
        : { status: 'not_assessed' as OwaspStatus, assessment: 'none' as Assessment, summary: 'No object-addressing endpoints detected to assess.', evidence: [], affected: [] }),
    remediation: 'For every object reference, verify the authenticated caller is authorized for that specific object (not just the route). Test by swapping IDs across two accounts/tenants.',
  });

  // API2:2023 — Broken Authentication
  categories.push({
    id: 'API2:2023', key: 'broken-auth', name: 'Broken Authentication',
    ...(baVuln.length
      ? { status: 'fail' as OwaspStatus, assessment: 'dynamic' as Assessment, summary: 'An authenticated endpoint returned a success status with no credentials.', evidence: baVuln.slice(0, 6).map((f) => `${f.method} ${f.title} — ${f.detail}`), affected: baVuln.slice(0, 8).map((f) => f.title) }
      : transportVuln.length
        ? { status: 'warn' as OwaspStatus, assessment: 'dynamic' as Assessment, summary: 'Credentials may travel over plaintext HTTP on one or more endpoints.', evidence: transportVuln.slice(0, 6).map((f) => `${f.method} ${f.title} — ${f.detail}`), affected: transportVuln.slice(0, 8).map((f) => f.title) }
        : baTested
          ? { status: 'pass' as OwaspStatus, assessment: 'dynamic' as Assessment, summary: 'Authenticated endpoints rejected the unauthenticated request.', evidence: [], affected: [] }
          : { status: 'not_assessed' as OwaspStatus, assessment: 'none' as Assessment, summary: 'No endpoints carry credentials, so authentication enforcement could not be exercised.', evidence: [], affected: [] }),
    remediation: 'Enforce authentication on every non-public route, serve auth only over TLS, use short-lived tokens, and rate-limit login / token endpoints against credential stuffing.',
  });

  // API3:2023 — Broken Object Property Level Authorization (mass assignment / excessive exposure)
  categories.push({
    id: 'API3:2023', key: 'property-auth', name: 'Broken Object Property Level Authorization',
    ...(writeBodyEps.length
      ? { status: 'review' as OwaspStatus, assessment: 'static' as Assessment, summary: `${writeBodyEps.length} write endpoint${writeBodyEps.length === 1 ? '' : 's'} accept object bodies — confirm they whitelist writable properties and redact sensitive ones on read.`, evidence: [`Body-accepting writes: ${writeBodyEps.map((e) => `${e.method} ${e.path}`).slice(0, 6).join(', ')}`], affected: labels(writeBodyEps) }
      : { status: 'not_assessed' as OwaspStatus, assessment: 'none' as Assessment, summary: 'No write endpoints with request bodies detected to assess.', evidence: [], affected: [] }),
    remediation: 'Bind requests to an explicit allow-list of writable fields (no blanket model binding), and filter response payloads to the properties the caller is allowed to see.',
  });

  // API4:2023 — Unrestricted Resource Consumption
  categories.push({
    id: 'API4:2023', key: 'resource-consumption', name: 'Unrestricted Resource Consumption',
    ...(unbounded.length
      ? { status: 'review' as OwaspStatus, assessment: 'static' as Assessment, summary: `${unbounded.length} collection endpoint${unbounded.length === 1 ? '' : 's'} expose no pagination parameter — responses may be unbounded.`, evidence: [`Unpaginated collections: ${unbounded.map((e) => e.path).slice(0, 6).join(', ')}`], affected: labels(unbounded) }
      : collections.length
        ? { status: 'pass' as OwaspStatus, assessment: 'static' as Assessment, summary: 'Collection endpoints expose pagination parameters.', evidence: [], affected: [] }
        : { status: 'not_assessed' as OwaspStatus, assessment: 'none' as Assessment, summary: 'No collection endpoints detected to assess.', evidence: [], affected: [] }),
    remediation: 'Enforce pagination with a maximum page size, apply per-client rate and payload limits, and cap execution time / memory for expensive operations.',
  });

  // API5:2023 — Broken Function Level Authorization (BFLA)
  categories.push({
    id: 'API5:2023', key: 'bfla', name: 'Broken Function Level Authorization',
    ...(baVuln.length && privEps.length
      ? { status: 'fail' as OwaspStatus, assessment: 'dynamic' as Assessment, summary: 'Administrative / privileged endpoints answered without credentials.', evidence: baVuln.slice(0, 6).map((f) => `${f.method} ${f.title} — ${f.detail}`), affected: labels(privEps) }
      : privEps.length
        ? { status: 'review' as OwaspStatus, assessment: 'static' as Assessment, summary: `${privEps.length} endpoint${privEps.length === 1 ? '' : 's'} look administrative — confirm they require the right role, not merely a valid session.`, evidence: [`Privileged-looking routes: ${privEps.map((e) => e.path).slice(0, 6).join(', ')}`], affected: labels(privEps) }
        : { status: 'not_assessed' as OwaspStatus, assessment: 'none' as Assessment, summary: 'No administrative / privileged endpoints detected to assess.', evidence: [], affected: [] }),
    remediation: 'Deny by default and grant function access per role. Administrative operations must check the caller’s role/permission server-side on every request.',
  });

  // API6:2023 — Unrestricted Access to Sensitive Business Flows
  categories.push({
    id: 'API6:2023', key: 'business-flows', name: 'Unrestricted Access to Sensitive Business Flows',
    ...(flowEps.length
      ? { status: 'review' as OwaspStatus, assessment: 'static' as Assessment, summary: `${flowEps.length} sensitive business-flow endpoint${flowEps.length === 1 ? '' : 's'} detected — verify anti-automation protection.`, evidence: [`Sensitive flows: ${flowEps.map((e) => e.path).slice(0, 6).join(', ')}`], affected: labels(flowEps) }
      : { status: 'not_assessed' as OwaspStatus, assessment: 'none' as Assessment, summary: 'No sensitive business-flow endpoints detected to assess.', evidence: [], affected: [] }),
    remediation: 'Protect flows that can be abused at scale (checkout, signup, OTP, coupons, transfers) with rate limiting, device fingerprinting, human-detection and business-logic throttles.',
  });

  // API7:2023 — Server Side Request Forgery (SSRF)
  categories.push({
    id: 'API7:2023', key: 'ssrf', name: 'Server Side Request Forgery',
    ...(ssrfEps.length
      ? { status: 'review' as OwaspStatus, assessment: 'static' as Assessment, summary: `${ssrfEps.length} endpoint${ssrfEps.length === 1 ? '' : 's'} accept a URL / callback-shaped parameter — a classic SSRF vector.`, evidence: ssrfEps.slice(0, 6).map((e) => `${e.method} ${e.path} — param(s): ${matchesAny([...e.queryParams, ...e.pathParams].join(' '), SSRF_PARAMS).join(', ')}`), affected: labels(ssrfEps) }
      : { status: 'not_assessed' as OwaspStatus, assessment: 'none' as Assessment, summary: 'No URL / callback-shaped parameters detected to assess.', evidence: [], affected: [] }),
    remediation: 'For any user-supplied URL, validate against an allow-list of schemes and hosts, resolve and block internal/link-local ranges, and disable redirects on the outbound fetch.',
  });

  // API8:2023 — Security Misconfiguration (dynamic; the richest category)
  categories.push({
    id: 'API8:2023', key: 'misconfiguration', name: 'Security Misconfiguration',
    ...(!anyEndpoints
      ? { status: 'not_assessed' as OwaspStatus, assessment: 'none' as Assessment, summary: 'No endpoints to inspect.', evidence: [], affected: [] }
      : a8High
        ? { status: 'fail' as OwaspStatus, assessment: 'dynamic' as Assessment, summary: 'High-severity misconfiguration found (plaintext transport, verbose errors or permissive CORS).', evidence: evidenceFrom(F, A8_CHECKS), affected: a8Vuln.slice(0, 8).map((f) => f.title) }
        : a8Med || a8Vuln.length
          ? { status: 'warn' as OwaspStatus, assessment: 'dynamic' as Assessment, summary: 'Hardening gaps found (missing security headers, HSTS or error hygiene).', evidence: evidenceFrom(F, A8_CHECKS), affected: a8Vuln.slice(0, 8).map((f) => f.title) }
          : { status: 'pass' as OwaspStatus, assessment: 'dynamic' as Assessment, summary: 'Transport, CORS, security headers and error hygiene checks passed.', evidence: [], affected: [] }),
    remediation: 'Serve over TLS with HSTS, send X-Content-Type-Options / X-Frame-Options / CSP, scope CORS to known origins, and never return stack traces or DB errors to clients.',
  });

  // API9:2023 — Improper Inventory Management (static inventory hygiene)
  const invIssues: string[] = [];
  if (plainHttp.length) invIssues.push(`${plainHttp.length} endpoint(s) served over plain HTTP`);
  if (deprecated.length) invIssues.push(`${deprecated.length} deprecated endpoint(s) still in the catalogue`);
  if (versions.size > 1) invIssues.push(`multiple API versions in use (v${[...versions].sort().join(', v')}) — retire old ones`);
  if (hosts.size > 1) invIssues.push(`endpoints span ${hosts.size} hosts (${[...hosts].slice(0, 4).join(', ')}) — watch for shadow / rogue APIs`);
  if (schemes.size > 1) invIssues.push('mixed http/https schemes across the inventory');
  categories.push({
    id: 'API9:2023', key: 'inventory', name: 'Improper Inventory Management',
    ...(!anyEndpoints
      ? { status: 'not_assessed' as OwaspStatus, assessment: 'none' as Assessment, summary: 'No inventory to assess.', evidence: [], affected: [] }
      : (plainHttp.length || deprecated.length)
        ? { status: 'warn' as OwaspStatus, assessment: 'static' as Assessment, summary: 'Inventory hygiene issues found (plaintext or deprecated endpoints still exposed).', evidence: invIssues, affected: [...labels(plainHttp, 4), ...labels(deprecated, 4)] }
        : invIssues.length
          ? { status: 'review' as OwaspStatus, assessment: 'static' as Assessment, summary: 'Inventory spans multiple versions/hosts — confirm each is documented and intended.', evidence: invIssues, affected: [] }
          : { status: 'pass' as OwaspStatus, assessment: 'static' as Assessment, summary: 'Single host, single scheme, no deprecated or mixed-version endpoints.', evidence: [], affected: [] }),
    remediation: 'Keep an authoritative, environment-tagged inventory. Retire deprecated versions, decommission non-production hosts and document every exposed endpoint.',
  });

  // API10:2023 — Unsafe Consumption of APIs (outbound; not statically inferable here)
  categories.push({
    id: 'API10:2023', key: 'unsafe-consumption', name: 'Unsafe Consumption of APIs',
    status: 'not_assessed', assessment: 'none',
    summary: 'This category covers how your services consume third-party APIs — not observable from an inbound endpoint catalogue.',
    evidence: [],
    affected: [],
    remediation: 'Validate and sanitise data received from upstream/third-party APIs, enforce TLS and timeouts on outbound calls, and never blindly follow redirects returned by them.',
  });

  // ── Roll-up ──
  let sum = 0, assessed = 0;
  let passed = 0, warned = 0, failed = 0, review = 0, notAssessed = 0;
  for (const c of categories) {
    const w = weightOf(c.status);
    if (w === null) { notAssessed++; continue; }
    assessed++; sum += w;
    if (c.status === 'pass') passed++;
    else if (c.status === 'warn') warned++;
    else if (c.status === 'fail') failed++;
    else if (c.status === 'review') review++;
  }
  const compliancePct = assessed > 0 ? Math.round((sum / assessed) * 100) : null;

  return {
    categories,
    summary: {
      total: categories.length,
      assessed, passed, warned, failed, review, notAssessed,
      compliancePct,
      grade: compliancePct === null ? null : gradeOf(compliancePct),
      high: security.summary.high,
      medium: security.summary.medium,
      low: security.summary.low,
    },
    basis: { endpoints: eps.length, scanned: security.summary.endpoints, generatedAt: new Date().toISOString() },
    security,
  };
}
