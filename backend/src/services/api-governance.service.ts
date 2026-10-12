/**
 * api-governance.service.ts
 * ─────────────────────────
 * Configurable API design-governance — a Spectral / SwaggerHub-governance-style
 * ruleset evaluated SERVER-SIDE over the catalogue, with a score, severity
 * budget and a machine-readable CI gate. Supersedes the fixed ~8-rule client
 * lint (GovernanceCheck.tsx): named presets select built-in rules, and a tenant
 * can pass CUSTOM rules (a small, safe predicate DSL) with their own severities.
 *
 * Standalone and opt-in: pure analysis over the endpoints the client sends, no
 * IO, no pipeline coupling. It asserts nothing live — a design-quality snapshot.
 */
export type Severity = 'error' | 'warn' | 'info' | 'off';
export interface GovEndpoint { method: string; url: string; auth?: { type?: string }; description?: string; title?: string; tags?: string[]; expectedStatus?: number; operationId?: string; deprecated?: boolean }

export interface GovFinding { ruleId: string; severity: Severity; message: string; endpoint?: string; hint?: string }
export interface GovReport {
  ruleset: string;
  evaluated: number;
  findings: GovFinding[];
  summary: Record<Severity, number>;
  score: number;
  grade: 'A' | 'B' | 'C' | 'D' | 'F';
  gate: { budget: GateBudget; passed: boolean; reasons: string[] };
}
export interface GateBudget { maxErrors?: number; maxWarnings?: number; minScore?: number }

/** A built-in rule: one predicate per endpoint; returns a message when VIOLATED. */
interface BuiltinRule { id: string; defaultSeverity: Severity; description: string; check: (e: GovEndpoint, ctx: RuleCtx) => string | null }
interface RuleCtx { all: GovEndpoint[] }

function pathOf(u: string): string { try { return new URL(u).pathname || '/'; } catch { return u.replace(/^[a-z]+:\/\/[^/]+/i, '') || u; } }
function isWrite(m: string): boolean { return ['POST', 'PUT', 'PATCH', 'DELETE'].includes((m || '').toUpperCase()); }
const VERB_IN_PATH = /\/(get|create|update|delete|remove|add|fetch|list|make|set|do|retrieve|save)([A-Z_/-]|$)/i;

const BUILTINS: BuiltinRule[] = [
  { id: 'https-only', defaultSeverity: 'error', description: 'Endpoints must use TLS (https).', check: (e) => /^https:/i.test(e.url) ? null : 'Endpoint is served over plain http.' },
  { id: 'write-needs-auth', defaultSeverity: 'error', description: 'State-changing operations must declare auth.', check: (e) => isWrite(e.method) && (!e.auth || !e.auth.type || e.auth.type === 'none') ? 'Write operation declares no authentication.' : null },
  { id: 'no-verbs-in-path', defaultSeverity: 'warn', description: 'Paths should name resources, not actions.', check: (e) => VERB_IN_PATH.test(pathOf(e.url)) ? 'Path contains a verb; prefer a resource noun + HTTP method.' : null },
  { id: 'path-lowercase', defaultSeverity: 'warn', description: 'Path segments should be lowercase.', check: (e) => { const p = pathOf(e.url); return /[A-Z]/.test(p.replace(/\{[^}]*\}/g, '')) ? 'Path has uppercase characters.' : null; } },
  { id: 'no-trailing-slash', defaultSeverity: 'info', description: 'Paths should not end with a trailing slash.', check: (e) => { const p = pathOf(e.url); return p.length > 1 && p.endsWith('/') ? 'Path ends with a trailing slash.' : null; } },
  { id: 'kebab-case-path', defaultSeverity: 'info', description: 'Multi-word segments should be kebab-case (no snake_case/camelCase).', check: (e) => /\/[a-z0-9]+(_[a-z0-9]+|[a-z0-9][A-Z])/.test(pathOf(e.url)) ? 'Path segment is not kebab-case.' : null },
  { id: 'versioned-path', defaultSeverity: 'info', description: 'API should be versioned in the path (e.g. /v1/).', check: (e) => /\/v\d+(\/|$)/i.test(pathOf(e.url)) ? null : 'No version segment (/v1/) found in the path.' },
  { id: 'has-operation-name', defaultSeverity: 'warn', description: 'Each operation should have a name / summary.', check: (e) => (e.title && e.title.trim() && e.title !== `${(e.method || '').toUpperCase()} ${e.url}`) || (e.operationId && e.operationId.trim()) ? null : 'Operation has no meaningful name / operationId.' },
  { id: 'has-description', defaultSeverity: 'info', description: 'Each operation should be documented.', check: (e) => e.description && e.description.trim().length >= 10 ? null : 'Operation has no (or a very short) description.' },
  { id: 'declares-expected-status', defaultSeverity: 'warn', description: 'Each operation should declare its success status.', check: (e) => Number.isInteger(e.expectedStatus) && (e.expectedStatus as number) >= 100 ? null : 'Operation declares no expected status code.' },
  { id: 'collection-is-plural', defaultSeverity: 'info', description: 'Collection resources should be plural nouns.', check: (e) => { const segs = pathOf(e.url).split('/').filter(Boolean).filter((s) => !s.startsWith('{') && !/^v\d+$/i.test(s)); const last = segs[segs.length - 1]; return last && /[a-z]$/i.test(last) && !/s$/i.test(last) && (e.method || '').toUpperCase() === 'GET' && !/\{[^}]*\}$/.test(pathOf(e.url)) ? 'Collection path segment looks singular.' : null; } },
  { id: 'not-deprecated-without-note', defaultSeverity: 'info', description: 'Deprecated operations should be documented as such.', check: (e) => e.deprecated && !(e.description || '').toLowerCase().includes('deprecat') ? 'Operation is deprecated but the description does not say so.' : null },
  { id: 'consistent-collection-casing', defaultSeverity: 'info', description: 'Resource names should be cased consistently across the surface.', check: (e, ctx) => { const seg = pathOf(e.url).split('/').filter(Boolean).find((s) => !s.startsWith('{') && !/^v\d+$/i.test(s)); if (!seg) return null; const styles = new Set(ctx.all.map((x) => { const s = pathOf(x.url).split('/').filter(Boolean).find((y) => !y.startsWith('{') && !/^v\d+$/i.test(y)); return s ? (/[A-Z]/.test(s) ? (/_/.test(s) ? 'mixed' : 'camel') : (/_/.test(s) ? 'snake' : 'lower')) : null; }).filter(Boolean)); return styles.size > 1 && /[A-Z_]/.test(seg) ? 'Resource casing is inconsistent across the API surface.' : null; } },
];

/** Named presets: a rule → severity map. Severity 'off' disables a built-in. */
const PRESETS: Record<string, { label: string; severities: Record<string, Severity> }> = {
  'intelliqe-default': { label: 'IntelliQE default', severities: {} /* use defaults */ },
  'spectral-oas': { label: 'Spectral OAS (strict)', severities: { 'has-description': 'warn', 'declares-expected-status': 'error', 'has-operation-name': 'error' } },
  'security-first': { label: 'Security-first', severities: { 'https-only': 'error', 'write-needs-auth': 'error', 'no-verbs-in-path': 'info', 'kebab-case-path': 'off', 'collection-is-plural': 'off', 'consistent-collection-casing': 'off' } },
  'minimal': { label: 'Minimal (errors only)', severities: { 'no-verbs-in-path': 'off', 'path-lowercase': 'off', 'no-trailing-slash': 'off', 'kebab-case-path': 'off', 'versioned-path': 'off', 'has-operation-name': 'off', 'has-description': 'off', 'declares-expected-status': 'off', 'collection-is-plural': 'off', 'not-deprecated-without-note': 'off', 'consistent-collection-casing': 'off' } },
};

/** A custom rule in the safe predicate DSL. */
export interface CustomRule { id: string; severity?: Severity; field: 'url' | 'method' | 'description' | 'title' | 'auth.type' | 'tags'; assert: 'defined' | 'pattern' | 'notPattern' | 'equals' | 'oneOf'; value?: string; message?: string; appliesTo?: 'all' | 'write' | 'read' }
function fieldValue(e: GovEndpoint, field: CustomRule['field']): string { switch (field) { case 'url': return e.url || ''; case 'method': return (e.method || '').toUpperCase(); case 'description': return e.description || ''; case 'title': return e.title || ''; case 'auth.type': return e.auth?.type || 'none'; case 'tags': return (e.tags || []).join(','); default: return ''; } }
function evalCustom(e: GovEndpoint, r: CustomRule): string | null {
  if (r.appliesTo === 'write' && !isWrite(e.method)) return null;
  if (r.appliesTo === 'read' && isWrite(e.method)) return null;
  const v = fieldValue(e, r.field);
  let violated = false;
  try {
    if (r.assert === 'defined') violated = !v.trim();
    else if (r.assert === 'equals') violated = v !== (r.value || '');
    else if (r.assert === 'oneOf') violated = !String(r.value || '').split(',').map((s) => s.trim()).includes(v);
    else if (r.assert === 'pattern') violated = !new RegExp(r.value || '', 'i').test(v);
    else if (r.assert === 'notPattern') violated = new RegExp(r.value || '', 'i').test(v);
  } catch { return null; }
  return violated ? (r.message || `Custom rule ${r.id} failed on ${r.field}.`) : null;
}

export function listGovernanceRulesets(): { id: string; label: string }[] { return Object.entries(PRESETS).map(([id, p]) => ({ id, label: p.label })); }
export function listGovernanceRules(): { id: string; defaultSeverity: Severity; description: string }[] { return BUILTINS.map((r) => ({ id: r.id, defaultSeverity: r.defaultSeverity, description: r.description })); }

const WEIGHT: Record<Severity, number> = { error: 5, warn: 2, info: 0.5, off: 0 };

export function runGovernance(endpoints: GovEndpoint[], opts: { ruleset?: string; customRules?: CustomRule[]; gate?: GateBudget } = {}): GovReport {
  const preset = PRESETS[opts.ruleset || 'intelliqe-default'] || PRESETS['intelliqe-default']!;
  const sevOf = (rule: BuiltinRule): Severity => preset.severities[rule.id] ?? rule.defaultSeverity;
  const ctx: RuleCtx = { all: endpoints };
  const findings: GovFinding[] = [];

  for (const e of endpoints) {
    const label = `${(e.method || 'GET').toUpperCase()} ${pathOf(e.url)}`;
    for (const rule of BUILTINS) {
      const sev = sevOf(rule);
      if (sev === 'off') continue;
      const msg = rule.check(e, ctx);
      if (msg) findings.push({ ruleId: rule.id, severity: sev, message: msg, endpoint: label, hint: rule.description });
    }
    for (const r of opts.customRules || []) {
      const sev = r.severity || 'warn';
      if (sev === 'off') continue;
      const msg = evalCustom(e, r);
      if (msg) findings.push({ ruleId: r.id || 'custom', severity: sev, message: msg, endpoint: label });
    }
  }

  const summary: Record<Severity, number> = { error: 0, warn: 0, info: 0, off: 0 };
  for (const f of findings) summary[f.severity]++;
  // Score: penalise per weighted finding, normalised against the endpoints assessed.
  const penalty = findings.reduce((a, f) => a + WEIGHT[f.severity], 0);
  const budgetMax = Math.max(1, endpoints.length) * 6;
  const score = Math.max(0, Math.round(100 - (penalty / budgetMax) * 100));
  const grade: GovReport['grade'] = score >= 90 ? 'A' : score >= 75 ? 'B' : score >= 60 ? 'C' : score >= 40 ? 'D' : 'F';

  const budget = opts.gate || {};
  const reasons: string[] = [];
  if (budget.maxErrors != null && summary.error > budget.maxErrors) reasons.push(`${summary.error} errors exceed the budget of ${budget.maxErrors}.`);
  if (budget.maxWarnings != null && summary.warn > budget.maxWarnings) reasons.push(`${summary.warn} warnings exceed the budget of ${budget.maxWarnings}.`);
  if (budget.minScore != null && score < budget.minScore) reasons.push(`Score ${score} is below the minimum of ${budget.minScore}.`);
  const passed = reasons.length === 0;

  return { ruleset: opts.ruleset || 'intelliqe-default', evaluated: endpoints.length, findings, summary, score, grade, gate: { budget, passed, reasons } };
}
