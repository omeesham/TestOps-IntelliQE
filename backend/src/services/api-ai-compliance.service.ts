/**
 * api-ai-compliance.service.ts
 * ────────────────────────────
 * AI-era compliance packs — EU AI Act and DORA (Digital Operational Resilience
 * Act). The same posture idea as api-compliance.service.ts (PCI/HIPAA/GDPR/PSD2),
 * but for the two frameworks that govern AI systems and ICT operational
 * resilience: each control gets an honest status, a finding, and remediation.
 *
 * Assessment blends static heuristics over the catalogue (AI-shaped endpoints,
 * sensitive data in URLs, third-party host spread) with operator-supplied
 * context that cannot be seen from the API surface (human oversight, resilience
 * testing, monitoring, audit logging). Standalone, opt-in, no IO — a posture
 * snapshot, not a certified conformity assessment.
 */
export type ControlStatus = 'pass' | 'warn' | 'fail' | 'review' | 'not_assessed';
export interface AiComplianceEndpoint { method: string; url: string; auth?: { type?: string }; queryParams?: { name: string }[] }
export interface AiComplianceControl { id: string; title: string; status: ControlStatus; assessment: 'static' | 'supplied' | 'manual'; finding: string; remediation: string }
export interface AiCompliancePack { pack: string; packLabel: string; controls: AiComplianceControl[]; score: number; grade: 'A' | 'B' | 'C' | 'D' | 'F'; summary: Record<ControlStatus, number> }

/** Context the operator confirms — things the API surface cannot reveal. */
export interface AiComplianceContext {
  transportSecure?: boolean;
  humanOversight?: boolean;
  hasMonitoring?: boolean;
  hasResilienceTesting?: boolean;
  hasAudit?: boolean;
  hasDocumentation?: boolean;
}

const PACKS: Record<string, string> = { 'eu-ai-act': 'EU AI Act', dora: 'DORA' };
const SENSITIVE_PARAM = /\b(card|pan|ssn|sin|dob|birth|passport|email|phone|mrn|patient|iban|account|name|address)\b/i;
const AI_PATH = /\b(ai|ml|model|predict|inference|infer|score|classif|recommend|generate|gen|chat|complet|embed|llm|nlp|vision|detect|rank)\b/i;

function host(u: string): string { try { return new URL(u).host; } catch { return ''; } }
function path(u: string): string { try { return new URL(u).pathname; } catch { return u; } }
function allHttps(eps: AiComplianceEndpoint[]): boolean { return eps.length > 0 && eps.every((e) => /^https:/i.test(e.url)); }
function aiEndpoints(eps: AiComplianceEndpoint[]): AiComplianceEndpoint[] { return eps.filter((e) => AI_PATH.test(path(e.url))); }
function sensitiveInUrl(eps: AiComplianceEndpoint[]): AiComplianceEndpoint[] {
  return eps.filter((e) => SENSITIVE_PARAM.test(path(e.url)) || (e.queryParams || []).some((q) => SENSITIVE_PARAM.test(q.name)));
}
function authCoverage(eps: AiComplianceEndpoint[]): number {
  const writes = eps.filter((e) => ['POST', 'PUT', 'PATCH', 'DELETE'].includes((e.method || '').toUpperCase()));
  if (!writes.length) return 1;
  return writes.filter((e) => e.auth && e.auth.type && e.auth.type !== 'none').length / writes.length;
}

function score(controls: AiComplianceControl[]): { score: number; grade: AiCompliancePack['grade']; summary: Record<ControlStatus, number> } {
  const summary: Record<ControlStatus, number> = { pass: 0, warn: 0, fail: 0, review: 0, not_assessed: 0 };
  for (const c of controls) summary[c.status]++;
  const assessed = controls.filter((c) => c.status !== 'not_assessed' && c.status !== 'review');
  const pts = assessed.reduce((a, c) => a + (c.status === 'pass' ? 1 : c.status === 'warn' ? 0.5 : 0), 0);
  const pct = assessed.length ? Math.round((pts / assessed.length) * 100) : 0;
  const grade: AiCompliancePack['grade'] = pct >= 90 ? 'A' : pct >= 75 ? 'B' : pct >= 60 ? 'C' : pct >= 40 ? 'D' : 'F';
  return { score: pct, grade, summary };
}

/** Three-way control from a supplied boolean: true→pass, false→fail, undefined→review. */
function supplied(flag: boolean | undefined, whenTrue: string, whenFalse: string): { status: ControlStatus; assessment: AiComplianceControl['assessment']; finding: string } {
  if (flag === true) return { status: 'pass', assessment: 'supplied', finding: whenTrue };
  if (flag === false) return { status: 'fail', assessment: 'supplied', finding: whenFalse };
  return { status: 'review', assessment: 'manual', finding: 'Not confirmed — operator attestation required.' };
}

export function runAiCompliancePack(pack: string, eps: AiComplianceEndpoint[], ctx: AiComplianceContext = {}): AiCompliancePack {
  const p = String(pack || '').toLowerCase();
  if (!PACKS[p]) throw new Error(`Unknown AI compliance pack: ${pack}. One of: ${Object.keys(PACKS).join(', ')}`);
  const https = ctx.transportSecure ?? allHttps(eps);
  const ai = aiEndpoints(eps);
  const leaky = sensitiveInUrl(eps);
  const auth = authCoverage(eps);
  const hosts = [...new Set(eps.map((e) => host(e.url)).filter(Boolean))];

  const controls: AiComplianceControl[] = [];
  const C = (id: string, title: string, status: ControlStatus, assessment: AiComplianceControl['assessment'], finding: string, remediation: string) => controls.push({ id, title, status, assessment, finding, remediation });

  if (p === 'eu-ai-act') {
    C('inventory', 'AI system inventory & classification', ai.length ? 'warn' : 'review', 'static',
      ai.length ? `${ai.length} endpoint(s) look AI/ML-driven (e.g. ${path(ai[0]!.url)}). Each must be inventoried and risk-classified.` : 'No AI-shaped endpoints detected from paths — confirm whether any AI system is in scope.',
      'Maintain an AI system register; classify each as prohibited / high-risk / limited / minimal (Art. 6, Annex III).');
    {
      const r = supplied(ctx.humanOversight, 'Human oversight is in place for AI decisions.', 'No human oversight confirmed for AI-driven decisions.');
      C('oversight', 'Human oversight (Art. 14)', r.status, r.assessment, r.finding, 'Provide human review / override for high-risk AI outputs; log interventions.');
    }
    C('transparency', 'Transparency & disclosure (Art. 13/52)', ai.length ? 'warn' : 'review', 'static',
      ai.length ? 'AI-driven endpoints must disclose to users that they interact with / are affected by an AI system.' : 'No AI endpoints detected to assess disclosure.',
      'Label AI-generated output and inform users; document intended purpose and limitations.');
    C('data-governance', 'Data governance & data quality (Art. 10)', leaky.length ? 'fail' : 'pass', 'static',
      leaky.length ? `${leaky.length} endpoint(s) carry personal identifiers in URLs/queries — training/inference data governance is at risk.` : 'No personal identifiers seen in URLs/queries.',
      'Keep PII out of URLs; document data provenance, bias checks and data-quality controls for training sets.');
    {
      const r = supplied(ctx.hasAudit, 'Automatic event logging is in place.', 'No automatic event logging confirmed.');
      C('logging', 'Record-keeping & logging (Art. 12)', r.status, r.assessment, r.finding, 'Log AI system events (inputs, decisions, overrides) with retention for traceability.');
    }
    {
      const r = supplied(ctx.hasResilienceTesting, 'Accuracy / robustness testing is performed.', 'No accuracy/robustness testing confirmed.');
      C('robustness', 'Accuracy, robustness & cybersecurity (Art. 15)', r.status, r.assessment, r.finding, 'Test accuracy, adversarial robustness and security of AI endpoints; gate releases on it.');
    }
    {
      const r = supplied(ctx.hasDocumentation, 'Technical documentation is maintained.', 'Technical documentation not confirmed.');
      C('tech-docs', 'Technical documentation (Art. 11, Annex IV)', r.status, r.assessment, r.finding, 'Maintain technical documentation sufficient to assess conformity before placing on market.');
    }
    C('access', 'Access control on AI endpoints', ai.length === 0 ? 'not_assessed' : auth >= 0.99 ? 'pass' : auth >= 0.5 ? 'warn' : 'fail', 'static',
      ai.length === 0 ? 'No AI endpoints to assess.' : `${Math.round(auth * 100)}% of write endpoints declare authentication.`,
      'Require authentication and least-privilege authorization on AI inference and management endpoints.');
  } else if (p === 'dora') {
    {
      const r = supplied(ctx.hasMonitoring, 'Continuous ICT monitoring is in place.', 'No continuous ICT monitoring confirmed.');
      C('ict-risk', 'ICT risk management framework (Art. 5–6)', r.status, r.assessment, r.finding, 'Operate a documented ICT risk framework with continuous monitoring of critical services.');
    }
    C('transport', 'Secure ICT communications (TLS)', https ? 'pass' : 'fail', ctx.transportSecure != null ? 'supplied' : 'static',
      https ? 'All endpoints use https.' : 'One or more endpoints are plain http.', 'Encrypt all ICT communications in transit (TLS 1.2+).');
    {
      const r = supplied(ctx.hasAudit, 'Incident logging / detection is in place.', 'No incident logging / detection confirmed.');
      C('incident', 'ICT incident detection & reporting (Art. 17–19)', r.status, r.assessment, r.finding, 'Detect, classify and report major ICT incidents within the regulatory deadlines.');
    }
    {
      const r = supplied(ctx.hasResilienceTesting, 'Resilience / chaos / load testing is performed.', 'No resilience testing confirmed.');
      C('resilience-testing', 'Digital operational resilience testing (Art. 24–25)', r.status, r.assessment, r.finding, 'Run a resilience testing programme (load, chaos, failover) on critical services; TLPT where required.');
    }
    C('third-party', 'ICT third-party concentration risk (Art. 28–30)', hosts.length === 0 ? 'not_assessed' : hosts.length > 10 ? 'warn' : 'pass', 'static',
      `${hosts.length} distinct ICT provider host(s) in the catalogue.${hosts.length > 10 ? ' A wide third-party surface increases concentration and supply-chain risk.' : ''}`,
      'Register ICT third parties, assess concentration risk, and secure exit / substitutability for critical providers.');
    C('data-exposure', 'Protection of data in ICT systems', leaky.length ? 'fail' : 'pass', 'static',
      leaky.length ? `${leaky.length} endpoint(s) expose personal/financial identifiers in URLs.` : 'No sensitive identifiers seen in URLs.',
      'Keep financial/personal identifiers out of URLs and logs; apply least-privilege access.');
    C('continuity', 'ICT business continuity & recovery (Art. 11–12)', 'review', 'manual',
      'Backup, recovery and continuity arrangements cannot be assessed from the API surface.',
      'Document and test ICT business-continuity and disaster-recovery plans with defined RTO/RPO.');
  }

  const { score: sc, grade, summary } = score(controls);
  return { pack: p, packLabel: PACKS[p]!, controls, score: sc, grade, summary };
}

export function listAiCompliancePacks(): { id: string; label: string }[] {
  return Object.entries(PACKS).map(([id, label]) => ({ id, label }));
}
