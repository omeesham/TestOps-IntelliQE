/**
 * api-spec-audit.service.ts
 * ─────────────────────────
 * Static OpenAPI security audit & score — the 42Crunch-"Audit" slice: grade the
 * DEFINITION's security quality offline, before anything runs. Distinct from the
 * runtime DAST (api-security / api-owasp): this reads the OpenAPI document and
 * scores missing/weak auth schemes, unconstrained data (unbounded strings /
 * numbers / arrays, permissive additionalProperties), missing error & rate-limit
 * responses, and plaintext servers — each mapped to an OWASP API Top-10 category.
 *
 * Standalone, opt-in, pure analysis. Parses YAML or JSON (YAML is a JSON
 * superset, so one parser covers both). No IO, no pipeline coupling.
 */
import YAML from 'yaml';

export type AuditSeverity = 'critical' | 'high' | 'medium' | 'low' | 'info';
export interface AuditFinding { id: string; severity: AuditSeverity; owasp: string; message: string; pointer: string }
export interface SpecAuditReport {
  title: string;
  version: string;
  operations: number;
  findings: AuditFinding[];
  summary: Record<AuditSeverity, number>;
  score: number;
  grade: 'A' | 'B' | 'C' | 'D' | 'F';
  categories: { security: number; dataValidation: number; transport: number };
  gate: { minScore?: number; maxCritical?: number; maxHigh?: number; passed: boolean; reasons: string[] };
}

const SEV_WEIGHT: Record<AuditSeverity, number> = { critical: 20, high: 10, medium: 4, low: 1.5, info: 0 };
const METHODS = ['get', 'put', 'post', 'delete', 'patch', 'options', 'head', 'trace'];

export function auditOpenApiSpec(raw: string, opts: { gate?: { minScore?: number; maxCritical?: number; maxHigh?: number } } = {}): SpecAuditReport {
  let doc: any;
  try { doc = YAML.parse(raw); } catch (e) { throw new Error(`Could not parse the OpenAPI document: ${(e as Error).message}`); }
  if (!doc || typeof doc !== 'object') throw new Error('The document is empty or not an object.');
  if (!doc.openapi && !doc.swagger) throw new Error('Not an OpenAPI/Swagger document (missing "openapi"/"swagger" field).');

  const findings: AuditFinding[] = [];
  const add = (id: string, severity: AuditSeverity, owasp: string, message: string, pointer: string) => findings.push({ id, severity, owasp, message, pointer });

  // ── Transport ──
  const servers: any[] = Array.isArray(doc.servers) ? doc.servers : [];
  for (const [i, s] of servers.entries()) {
    if (typeof s?.url === 'string' && /^http:\/\//i.test(s.url)) add('server-http', 'high', 'API8:2023', `Server "${s.url}" uses plain http.`, `#/servers/${i}/url`);
  }
  if (!servers.length) add('no-servers', 'info', 'API9:2023', 'No servers are declared — base URL / environments are undocumented.', '#/servers');

  // ── Security schemes ──
  const schemes: Record<string, any> = doc.components?.securitySchemes || doc.securityDefinitions || {};
  const schemeNames = Object.keys(schemes);
  if (!schemeNames.length) add('no-security-schemes', 'critical', 'API2:2023', 'No securitySchemes are defined — the API advertises no authentication.', '#/components/securitySchemes');
  for (const [name, sc] of Object.entries(schemes)) {
    const t = (sc?.type || '').toLowerCase();
    if (t === 'apikey' && (sc.in || '').toLowerCase() === 'query') add(`weak-apikey-query-${name}`, 'high', 'API2:2023', `Security scheme "${name}" passes an API key in the query string (logged, cached).`, `#/components/securitySchemes/${name}`);
    if (t === 'http' && (sc.scheme || '').toLowerCase() === 'basic') add(`weak-basic-${name}`, 'medium', 'API2:2023', `Security scheme "${name}" uses HTTP Basic auth.`, `#/components/securitySchemes/${name}`);
    if (t === 'oauth2' && !sc.flows) add(`oauth-noflows-${name}`, 'medium', 'API2:2023', `OAuth2 scheme "${name}" declares no flows.`, `#/components/securitySchemes/${name}`);
  }
  const globalSecurity = Array.isArray(doc.security) && doc.security.length > 0;

  // ── Operations ──
  const paths: Record<string, any> = doc.paths || {};
  let opCount = 0;
  for (const [p, item] of Object.entries(paths)) {
    if (!item || typeof item !== 'object') continue;
    for (const m of METHODS) {
      const op = (item as any)[m];
      if (!op || typeof op !== 'object') continue;
      opCount++;
      const ptr = `#/paths/${p.replace(/\//g, '~1')}/${m}`;
      const write = ['put', 'post', 'delete', 'patch'].includes(m);

      // Auth on the operation (or global).
      const opSecurity = Array.isArray(op.security) ? op.security.length > 0 : undefined;
      const secured = opSecurity === true || (opSecurity === undefined && globalSecurity);
      if (!secured && schemeNames.length) add(`op-no-security-${opCount}`, write ? 'high' : 'medium', 'API1:2023', `${m.toUpperCase()} ${p} declares no security (and no global security applies).`, ptr);

      // Responses: error + rate-limit coverage.
      const responses = op.responses || {};
      const codes = Object.keys(responses);
      if (!codes.some((c) => /^4\d\d$/.test(c) || c === '4XX')) add(`op-no-4xx-${opCount}`, 'low', 'API8:2023', `${m.toUpperCase()} ${p} defines no 4xx error response.`, ptr);
      if (!codes.some((c) => c === '429')) add(`op-no-429-${opCount}`, 'low', 'API4:2023', `${m.toUpperCase()} ${p} defines no 429 response (no documented rate limiting).`, ptr);

      // Write operations should define a request body schema.
      if (write && !op.requestBody) add(`op-no-reqbody-${opCount}`, 'low', 'API6:2023', `${m.toUpperCase()} ${p} is a write operation with no requestBody schema.`, ptr);

      // Unconstrained parameters.
      for (const [i, prm] of (Array.isArray(op.parameters) ? op.parameters : []).entries()) {
        auditSchema(prm?.schema, `${ptr}/parameters/${i}/schema`, `param "${prm?.name || i}"`, add, 0);
      }
      // Request + response body schemas.
      collectSchemas(op.requestBody?.content).forEach((s, i) => auditSchema(s.schema, `${ptr}/requestBody/${i}`, `${m.toUpperCase()} ${p} request body`, add, 0));
      for (const code of codes) collectSchemas(responses[code]?.content).forEach((s, i) => auditSchema(s.schema, `${ptr}/responses/${code}/${i}`, `${m.toUpperCase()} ${p} ${code} body`, add, 0));
    }
  }

  // ── Component schemas ──
  for (const [name, schema] of Object.entries(doc.components?.schemas || doc.definitions || {})) {
    auditSchema(schema, `#/components/schemas/${name}`, `schema "${name}"`, add, 0);
  }

  if (!opCount) add('no-operations', 'info', 'API9:2023', 'The document defines no operations.', '#/paths');

  // ── Score ──
  const summary: Record<AuditSeverity, number> = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
  for (const f of findings) summary[f.severity]++;
  const penalty = findings.reduce((a, f) => a + SEV_WEIGHT[f.severity], 0);
  const ceiling = Math.max(60, opCount * 12 + 40);
  const score = Math.max(0, Math.round(100 - Math.min(100, (penalty / ceiling) * 100)));
  const grade: SpecAuditReport['grade'] = score >= 90 ? 'A' : score >= 75 ? 'B' : score >= 60 ? 'C' : score >= 40 ? 'D' : 'F';

  const catScore = (ids: RegExp) => { const rel = findings.filter((f) => ids.test(f.id)); const pen = rel.reduce((a, f) => a + SEV_WEIGHT[f.severity], 0); return Math.max(0, Math.round(100 - Math.min(100, (pen / Math.max(20, ceiling / 2)) * 100))); };
  const categories = {
    security: catScore(/security|apikey|basic|oauth|no-security/),
    dataValidation: catScore(/unbounded|no-max|additional-props|no-reqbody|untyped/),
    transport: catScore(/http|server/),
  };

  const gate = opts.gate || {};
  const reasons: string[] = [];
  if (gate.minScore != null && score < gate.minScore) reasons.push(`Score ${score} is below the minimum of ${gate.minScore}.`);
  if (gate.maxCritical != null && summary.critical > gate.maxCritical) reasons.push(`${summary.critical} critical findings exceed the budget of ${gate.maxCritical}.`);
  if (gate.maxHigh != null && summary.high > gate.maxHigh) reasons.push(`${summary.high} high findings exceed the budget of ${gate.maxHigh}.`);

  return {
    title: String(doc.info?.title || 'Untitled API'),
    version: String(doc.info?.version || ''),
    operations: opCount,
    findings: findings.slice(0, 400),
    summary, score, grade, categories,
    gate: { ...gate, passed: reasons.length === 0, reasons },
  };
}

function collectSchemas(content: any): { schema: any }[] {
  if (!content || typeof content !== 'object') return [];
  return Object.values(content).map((c: any) => ({ schema: c?.schema })).filter((x) => x.schema);
}

/** Audit a single JSON Schema node for data-validation weaknesses (bounded depth). */
function auditSchema(schema: any, pointer: string, where: string, add: (id: string, s: AuditSeverity, o: string, m: string, p: string) => void, depth: number): void {
  if (!schema || typeof schema !== 'object' || depth > 6) return;
  if (schema.$ref) return; // resolved elsewhere (component schemas audited directly)
  const type = schema.type;
  if (type === 'string' && schema.maxLength == null && !schema.enum && !schema.format) add(`unbounded-string-${hash(pointer)}`, 'low', 'API6:2023', `Unbounded string in ${where} (no maxLength / enum / format).`, pointer);
  if ((type === 'integer' || type === 'number') && schema.maximum == null && schema.minimum == null && !schema.enum) add(`no-max-number-${hash(pointer)}`, 'low', 'API6:2023', `Unconstrained ${type} in ${where} (no minimum/maximum).`, pointer);
  if (type === 'array' && schema.maxItems == null) add(`unbounded-array-${hash(pointer)}`, 'medium', 'API4:2023', `Unbounded array in ${where} (no maxItems) — resource-exhaustion risk.`, pointer);
  if (type === 'object' || schema.properties) {
    if (schema.additionalProperties === true || schema.additionalProperties === undefined && !schema.properties) {
      add(`additional-props-${hash(pointer)}`, 'medium', 'API6:2023', `Permissive object in ${where} (additionalProperties not restricted) — mass-assignment risk.`, pointer);
    }
    for (const [k, v] of Object.entries(schema.properties || {})) auditSchema(v, `${pointer}/properties/${k}`, where, add, depth + 1);
  }
  if (schema.items) auditSchema(schema.items, `${pointer}/items`, where, add, depth + 1);
  for (const key of ['allOf', 'anyOf', 'oneOf']) if (Array.isArray(schema[key])) schema[key].forEach((s: any, i: number) => auditSchema(s, `${pointer}/${key}/${i}`, where, add, depth + 1));
}

function hash(s: string): string { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return Math.abs(h).toString(36); }
