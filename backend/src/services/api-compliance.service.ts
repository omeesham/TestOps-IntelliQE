/**
 * api-compliance.service.ts
 * ─────────────────────────
 * Compliance vertical packs — PCI-DSS, HIPAA, GDPR, PSD2. A per-framework
 * posture layer over the catalogue (the same idea as the OWASP API Top-10 pack):
 * each control is assessed with an honest status (pass / warn / fail / review /
 * not_assessed), a short finding, and remediation. Static heuristics over the
 * catalogue, optionally strengthened by a supplied security-scan summary.
 *
 * Standalone and opt-in: pure analysis, no IO beyond what the caller passes;
 * the generate → execute → heal pipeline is never involved.
 */
export type ControlStatus = 'pass' | 'warn' | 'fail' | 'review' | 'not_assessed';
export interface ComplianceEndpoint { method: string; url: string; auth?: { type?: string }; queryParams?: { name: string }[] }
export interface ComplianceControl { id: string; title: string; status: ControlStatus; assessment: 'static' | 'supplied' | 'manual'; finding: string; remediation: string }
export interface CompliancePack { pack: string; packLabel: string; controls: ComplianceControl[]; score: number; grade: 'A' | 'B' | 'C' | 'D' | 'F'; summary: Record<ControlStatus, number> }

const PACKS: Record<string, string> = { pci: 'PCI-DSS v4.0', hipaa: 'HIPAA Security Rule', gdpr: 'GDPR', psd2: 'PSD2 / SCA' };
const SENSITIVE_PARAM = /\b(card|pan|cc_?num|cvv|ssn|sin|dob|birth|passport|email|phone|mrn|patient|iban|account)\b/i;
const PAN_SHAPE = /\b\d{13,19}\b/;

function host(u: string): string { try { return new URL(u).host; } catch { return ''; } }
function path(u: string): string { try { return new URL(u).pathname; } catch { return u; } }

function allHttps(eps: ComplianceEndpoint[]): boolean { return eps.length > 0 && eps.every((e) => /^https:/i.test(e.url)); }
function authCoverage(eps: ComplianceEndpoint[]): number {
  const writes = eps.filter((e) => ['POST', 'PUT', 'PATCH', 'DELETE'].includes((e.method || '').toUpperCase()));
  if (!writes.length) return 1;
  return writes.filter((e) => e.auth && e.auth.type && e.auth.type !== 'none').length / writes.length;
}
function sensitiveInUrl(eps: ComplianceEndpoint[]): ComplianceEndpoint[] {
  return eps.filter((e) => SENSITIVE_PARAM.test(path(e.url)) || PAN_SHAPE.test(path(e.url)) || (e.queryParams || []).some((q) => SENSITIVE_PARAM.test(q.name)));
}
function hasPathLike(eps: ComplianceEndpoint[], rx: RegExp, method?: string): boolean {
  return eps.some((e) => rx.test(path(e.url)) && (!method || (e.method || '').toUpperCase() === method));
}

function score(controls: ComplianceControl[]): { score: number; grade: CompliancePack['grade']; summary: Record<ControlStatus, number> } {
  const summary: Record<ControlStatus, number> = { pass: 0, warn: 0, fail: 0, review: 0, not_assessed: 0 };
  for (const c of controls) summary[c.status]++;
  const assessed = controls.filter((c) => c.status !== 'not_assessed' && c.status !== 'review');
  const pts = assessed.reduce((a, c) => a + (c.status === 'pass' ? 1 : c.status === 'warn' ? 0.5 : 0), 0);
  const pct = assessed.length ? Math.round((pts / assessed.length) * 100) : 0;
  const grade: CompliancePack['grade'] = pct >= 90 ? 'A' : pct >= 75 ? 'B' : pct >= 60 ? 'C' : pct >= 40 ? 'D' : 'F';
  return { score: pct, grade, summary };
}

export function runCompliancePack(pack: string, eps: ComplianceEndpoint[], security?: { transportSecure?: boolean; headersSecure?: boolean }): CompliancePack {
  const p = String(pack || '').toLowerCase();
  if (!PACKS[p]) throw new Error(`Unknown compliance pack: ${pack}. One of: ${Object.keys(PACKS).join(', ')}`);
  const https = security?.transportSecure ?? allHttps(eps);
  const auth = authCoverage(eps);
  const leaky = sensitiveInUrl(eps);
  const controls: ComplianceControl[] = [];
  const C = (id: string, title: string, status: ControlStatus, assessment: ComplianceControl['assessment'], finding: string, remediation: string) => controls.push({ id, title, status, assessment, finding, remediation });

  // Shared transport + exposure controls.
  C('transport', 'Encrypt data in transit (TLS)', https ? 'pass' : 'fail', security?.transportSecure != null ? 'supplied' : 'static', https ? 'All endpoints use https.' : 'One or more endpoints are plain http.', 'Serve every endpoint over TLS 1.2+ and redirect http→https.');
  C('exposure', 'No sensitive data in URLs/query', leaky.length ? 'fail' : 'pass', 'static', leaky.length ? `${leaky.length} endpoint(s) put sensitive identifiers in the path/query (e.g. ${path(leaky[0]!.url)}).` : 'No sensitive identifiers seen in paths/queries.', 'Move card/PHI/PII identifiers out of URLs into the request body; URLs are logged and cached.');
  C('access', 'Access control on write/sensitive ops', auth >= 0.99 ? 'pass' : auth >= 0.5 ? 'warn' : 'fail', 'static', `${Math.round(auth * 100)}% of write endpoints declare authentication.`, 'Require authentication + least-privilege authorization on every state-changing or sensitive endpoint.');

  if (p === 'pci') {
    C('pan-storage', 'PAN never exposed in responses/URLs', leaky.some((e) => PAN_SHAPE.test(path(e.url))) ? 'fail' : 'pass', 'static', 'Checked URLs for card-number-shaped values.', 'Mask PAN (show at most first6/last4); never place it in a URL.');
    C('strong-crypto', 'Strong cryptography & key management', 'review', 'manual', 'Key management and cipher suites can’t be assessed from the catalogue.', 'Verify TLS cipher suites, HSTS, and documented key rotation.');
    C('logging', 'Log access to cardholder data', 'review', 'manual', 'Audit logging is not visible from the API surface.', 'Log and retain access to cardholder-data endpoints (Req 10).');
  } else if (p === 'hipaa') {
    C('phi-url', 'PHI not in URLs (minimum necessary)', leaky.length ? 'fail' : 'pass', 'static', leaky.length ? 'Patient/PHI-shaped identifiers appear in paths/queries.' : 'No PHI identifiers seen in URLs.', 'Keep PHI out of URLs; apply minimum-necessary to each response.');
    C('audit', 'Audit controls (§164.312(b))', 'review', 'manual', 'Audit logging is not visible from the API surface.', 'Record access to ePHI with user, time and action.');
    C('integrity', 'Transmission security (§164.312(e))', https ? 'pass' : 'fail', https ? 'static' : 'static', https ? 'TLS in use.' : 'Plain http detected.', 'Encrypt all ePHI in transit; consider message-level integrity.');
  } else if (p === 'gdpr') {
    C('access-right', 'Right of access (data export)', hasPathLike(eps, /export|download|me\/data|data-?export/i) ? 'pass' : 'warn', 'static', hasPathLike(eps, /export|download/i) ? 'A data-export-shaped endpoint exists.' : 'No data-export endpoint detected.', 'Expose an authenticated data-subject export endpoint (Art. 15/20).');
    C('erasure', 'Right to erasure', hasPathLike(eps, /users?\/[^/]+$/i, 'DELETE') || hasPathLike(eps, /delete-?account|erase/i) ? 'pass' : 'warn', 'static', 'Looked for a user/account delete endpoint.', 'Provide an authenticated erasure endpoint (Art. 17).');
    C('pii-url', 'No PII in URLs (data minimization)', leaky.length ? 'fail' : 'pass', 'static', leaky.length ? 'PII-shaped identifiers appear in URLs.' : 'No PII identifiers in URLs.', 'Keep PII out of URLs/logs; minimise collected fields (Art. 5).');
    C('consent', 'Consent management', 'review', 'manual', 'Consent flows can’t be inferred from the catalogue.', 'Expose and record consent; honour withdrawal.');
  } else if (p === 'psd2') {
    C('sca', 'Strong Customer Authentication', auth >= 0.99 ? 'warn' : 'fail', 'static', `${Math.round(auth * 100)}% of write endpoints require auth; 2-factor/SCA can’t be confirmed statically.`, 'Enforce SCA (2+ independent factors) on payment-initiation & account-access endpoints.');
    C('consent', 'Explicit consent / token scope', 'review', 'manual', 'Consent token scopes are not visible from the catalogue.', 'Scope access tokens to the consent granted; expire and allow revocation.');
    C('transport-psd2', 'Secure communication (eIDAS/QWAC)', https ? 'warn' : 'fail', 'static', https ? 'TLS present; QWAC/certificate pinning not assessable.' : 'Plain http detected.', 'Use qualified certificates (QWAC) and mutual TLS for the dedicated interface.');
  }

  const { score: sc, grade, summary } = score(controls);
  return { pack: p, packLabel: PACKS[p]!, controls, score: sc, grade, summary };
}

export function listCompliancePacks(): { id: string; label: string }[] {
  return Object.entries(PACKS).map(([id, label]) => ({ id, label }));
}
