/**
 * api-frd.service.ts — Functional Requirements Document module (Module 3).
 *
 * Reads an uploaded FRD (already extracted to text by document-parser) and uses
 * the tenant LLM to produce STRUCTURED functional requirements — FR-### ids,
 * each carrying the concrete API shape the requirement implies: endpoints
 * (method + path), parameters, headers, request body, auth, responses,
 * validations, error handling, acceptance criteria, dependencies and
 * positive/negative functional scenarios — then persists them per tenant.
 *
 * This is distinct from the FRD *import* card (Module 1), which extracts a flat
 * endpoint catalogue. Here the output is the functional requirements themselves,
 * for traceability and functional-scenario generation. Additive: new tables
 * (frd_documents, functional_requirements), nothing else depends on it yet.
 */
import pool from '../db.js';
import { runLLM, parseJsonFromResponse, coerceJsonArray, salvageJsonArrayObjects, type LlmConfig } from '../agents/claude-runner.js';

export interface FrEndpoint { method: string; path: string; description?: string }
export interface FrResponse { status: string; description?: string }

export interface FunctionalRequirement {
  frId: string;
  title: string;
  description?: string;
  actors?: string[];
  preconditions?: string[];
  endpoints?: FrEndpoint[];
  parameters?: string[];
  headers?: string[];
  requestBody?: string;
  auth?: string;
  responses?: FrResponse[];
  validations?: string[];
  errorHandling?: string[];
  acceptanceCriteria?: string[];
  dependencies?: string[];
  positiveScenarios?: string[];
  negativeScenarios?: string[];
}

export interface FrdAnalysis {
  summary: string;
  requirements: FunctionalRequirement[];
}

export interface FrdDocumentRow {
  id: string;
  name: string;
  summary?: string;
  source: string;
  requirementCount: number;
  createdBy?: string;
  createdAt: string;
}

const MAX_REQUIREMENTS = 200;
const HTTP_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS', 'TRACE']);

const asList = (v: unknown): string[] => {
  if (Array.isArray(v)) return v.map((x) => String(x)).map((s) => s.trim()).filter(Boolean).slice(0, 40);
  if (typeof v === 'string' && v.trim()) return [v.trim()];
  return [];
};

/**
 * Like asList, but parameters/headers often come back as objects
 * ({ name, in, type, required, description }) — flatten those to a readable
 * string instead of "[object Object]".
 */
const asFields = (v: unknown): string[] => {
  if (!Array.isArray(v)) return asList(v);
  const out: string[] = [];
  for (const x of v.slice(0, 40)) {
    if (x && typeof x === 'object') {
      const o = x as any;
      const name = String(o.name || o.field || o.key || o.param || o.header || '').trim();
      const meta = [String(o.in || o.location || '').trim(), String(o.type || '').trim(),
        o.required === true ? 'required' : o.required === false ? 'optional' : ''].filter(Boolean).join(', ');
      const desc = String(o.description || o.value || '').trim();
      let s = name + (meta ? ` (${meta})` : '');
      if (desc) s += s ? ` — ${desc}` : desc;
      s = s.trim();
      if (s) out.push(s.slice(0, 300));
    } else {
      const s = String(x).trim();
      if (s) out.push(s.slice(0, 300));
    }
  }
  return out.slice(0, 40);
};

/** Normalise endpoints — accepts {method,path,description} or a "GET /x" string. */
function asEndpoints(v: unknown): FrEndpoint[] {
  if (!Array.isArray(v)) return [];
  const out: FrEndpoint[] = [];
  for (const raw of v.slice(0, 40)) {
    if (raw && typeof raw === 'object') {
      const method = String((raw as any).method || '').trim().toUpperCase();
      const path = String((raw as any).path || (raw as any).url || '').trim();
      if (!path) continue;
      out.push({ method: HTTP_METHODS.has(method) ? method : 'GET', path: path.slice(0, 400), description: String((raw as any).description || '').trim().slice(0, 400) || undefined });
    } else if (typeof raw === 'string' && raw.trim()) {
      const m = raw.trim().match(/^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS|TRACE)\s+(\S+)/i);
      if (m) out.push({ method: m[1]!.toUpperCase(), path: m[2]!.slice(0, 400) });
      else out.push({ method: 'GET', path: raw.trim().slice(0, 400) });
    }
  }
  return out;
}

/** Normalise responses — accepts {status,description} or a "200 OK" string. */
function asResponses(v: unknown): FrResponse[] {
  if (!Array.isArray(v)) return [];
  const out: FrResponse[] = [];
  for (const raw of v.slice(0, 40)) {
    if (raw && typeof raw === 'object') {
      const status = String((raw as any).status || (raw as any).code || '').trim();
      if (!status) continue;
      out.push({ status: status.slice(0, 40), description: String((raw as any).description || '').trim().slice(0, 400) || undefined });
    } else if (typeof raw === 'string' && raw.trim()) {
      const m = raw.trim().match(/^(\d{3})\b\s*(.*)$/);
      if (m) out.push({ status: m[1]!, description: m[2]?.trim().slice(0, 400) || undefined });
      else out.push({ status: raw.trim().slice(0, 40) });
    }
  }
  return out;
}

/** Normalise one raw model requirement, filling an FR id if absent. */
function normalizeRequirement(raw: any, index: number): FunctionalRequirement | null {
  if (!raw || typeof raw !== 'object') return null;
  const title = String(raw.title || raw.name || raw.requirement || '').trim().slice(0, 600);
  const description = String(raw.description || raw.detail || '').trim().slice(0, 4000);
  if (!title && !description) return null;
  let frId = String(raw.frId || raw.id || raw.fr_id || '').trim().toUpperCase();
  if (!/^FR[-_ ]?\d+/i.test(frId)) frId = `FR-${String(index + 1).padStart(3, '0')}`;
  frId = frId.replace(/^FR[-_ ]?/i, 'FR-');
  return {
    frId,
    title: title || `Functional requirement ${index + 1}`,
    description: description || undefined,
    actors: asList(raw.actors ?? raw.roles),
    preconditions: asList(raw.preconditions),
    endpoints: asEndpoints(raw.endpoints),
    parameters: asFields(raw.parameters ?? raw.params),
    headers: asFields(raw.headers),
    requestBody: String(raw.requestBody || raw.request_body || raw.body || '').trim().slice(0, 4000) || undefined,
    auth: String(raw.auth || raw.authentication || '').trim().slice(0, 400) || undefined,
    responses: asResponses(raw.responses),
    validations: asList(raw.validations),
    errorHandling: asList(raw.errorHandling ?? raw.error_handling ?? raw.errors),
    acceptanceCriteria: asList(raw.acceptanceCriteria ?? raw.acceptance_criteria),
    dependencies: asList(raw.dependencies),
    positiveScenarios: asList(raw.positiveScenarios ?? raw.positive_scenarios),
    negativeScenarios: asList(raw.negativeScenarios ?? raw.negative_scenarios),
  };
}

function buildPrompt(text: string, fileName: string): string {
  return `You are a senior systems analyst. Read the following Functional Requirements Document and extract its FUNCTIONAL requirements as structured data.

For EACH distinct functional requirement, produce an object with:
- "frId": the document's own requirement id if present (e.g. "FR-001"); otherwise leave blank and one will be assigned.
- "title": a short statement of the function.
- "description": the full functional requirement text.
- "actors": array of the roles/actors that use this function.
- "preconditions": array of preconditions that must hold first.
- "endpoints": array of the API operations it implies, each { "method": "GET|POST|PUT|PATCH|DELETE", "path": "/resource", "description": "..." }. Infer them from the described behaviour when not stated verbatim; do NOT invent resources the text does not imply.
- "parameters": array of input parameters (path/query/body fields).
- "headers": array of required headers.
- "requestBody": a short description of the request payload (string), if any.
- "auth": the authentication/authorization this function requires (string), if any.
- "responses": array of expected responses, each { "status": "200", "description": "..." }.
- "validations": array of input/business validations.
- "errorHandling": array of error conditions and how they must be handled.
- "acceptanceCriteria": array of acceptance criteria.
- "dependencies": array of other requirements or systems it depends on.
- "positiveScenarios": array of positive (happy-path) functional scenarios.
- "negativeScenarios": array of negative/exception functional scenarios.
Leave an array empty when the document does not state it — do NOT invent detail.

Return ONLY a JSON object: { "summary": "<one-paragraph summary of the document>", "requirements": [ ... ] }. No markdown, no prose outside the JSON.

═══════════════════════════════════════════════════════════════
SOURCE: ${fileName}
DOCUMENT CONTENT (may be truncated):
═══════════════════════════════════════════════════════════════
${text.slice(0, 60000)}`;
}

/** Extract structured functional requirements from FRD text via the tenant LLM. */
export async function analyzeFrd(text: string, fileName: string, llm: LlmConfig | undefined): Promise<FrdAnalysis> {
  if (!text || text.trim().length < 20) {
    throw new Error('The document contained too little text to extract functional requirements.');
  }
  if (!llm) {
    throw new Error('No LLM is configured for this tenant. Add one under System Configuration → LLM Configuration.');
  }
  const response = await runLLM(buildPrompt(text, fileName), { maxTokens: 8192, llm });

  let summary = '';
  let rawReqs: any[] = [];
  try {
    const parsed = parseJsonFromResponse<any>(response);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      summary = String(parsed.summary || '').trim();
      rawReqs = coerceJsonArray<any>(parsed.requirements) || [];
    } else {
      rawReqs = coerceJsonArray<any>(parsed) || [];
    }
  } catch { /* salvage below */ }
  if (rawReqs.length === 0) rawReqs = salvageJsonArrayObjects<any>(response);

  const requirements = rawReqs
    .map((r, i) => normalizeRequirement(r, i))
    .filter((r): r is FunctionalRequirement => r !== null)
    .slice(0, MAX_REQUIREMENTS);

  if (requirements.length === 0) {
    throw new Error('No functional requirements could be identified in the document.');
  }
  return { summary: summary.slice(0, 4000), requirements };
}

/** Persist an analysed FRD and its requirements for a tenant. Returns the doc row. */
export async function saveFrdAnalysis(
  tenantId: string, username: string, name: string, analysis: FrdAnalysis, source = 'upload',
): Promise<FrdDocumentRow> {
  const inserted = await pool.query(
    `INSERT INTO frd_documents (tenant_id, name, summary, source, requirement_count, created_by)
     OUTPUT INSERTED.id, INSERTED.created_at
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [tenantId, name.slice(0, 400), analysis.summary || null, source, analysis.requirements.length, username],
  );
  const docId = inserted.rows[0].id as string;
  const createdAt = String(inserted.rows[0].created_at);

  let order = 0;
  for (const r of analysis.requirements) {
    await pool.query(
      `INSERT INTO functional_requirements
         (tenant_id, document_id, fr_id, title, description, actors, preconditions, endpoints, parameters,
          headers, request_body, auth, responses, validations, error_handling, acceptance_criteria,
          dependencies, positive_scenarios, negative_scenarios, sort_order)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)`,
      [
        tenantId, docId, r.frId, r.title.slice(0, 600), r.description || null,
        JSON.stringify(r.actors || []), JSON.stringify(r.preconditions || []),
        JSON.stringify(r.endpoints || []), JSON.stringify(r.parameters || []),
        JSON.stringify(r.headers || []), r.requestBody || null, r.auth || null,
        JSON.stringify(r.responses || []), JSON.stringify(r.validations || []),
        JSON.stringify(r.errorHandling || []), JSON.stringify(r.acceptanceCriteria || []),
        JSON.stringify(r.dependencies || []), JSON.stringify(r.positiveScenarios || []),
        JSON.stringify(r.negativeScenarios || []), order++,
      ],
    );
  }
  return { id: docId, name: name.slice(0, 400), summary: analysis.summary, source, requirementCount: analysis.requirements.length, createdBy: username, createdAt };
}

/** List a tenant's FRD documents, most recent first. */
export async function listFrdDocuments(tenantId: string): Promise<FrdDocumentRow[]> {
  const { rows } = await pool.query(
    `SELECT id, name, summary, source, requirement_count, created_by, created_at
     FROM frd_documents WHERE tenant_id = $1 ORDER BY created_at DESC`,
    [tenantId],
  );
  return rows.map((r: any) => ({
    id: r.id, name: r.name, summary: r.summary || undefined, source: r.source,
    requirementCount: Number(r.requirement_count || 0), createdBy: r.created_by || undefined,
    createdAt: String(r.created_at),
  }));
}

const parseArr = (v: unknown): any[] => {
  if (Array.isArray(v)) return v;
  if (typeof v === 'string' && v.trim()) { try { const p = JSON.parse(v); return Array.isArray(p) ? p : []; } catch { return []; } }
  return [];
};
const parseStrArr = (v: unknown): string[] => parseArr(v).map(String);

/** An FRD document plus its structured functional requirements. */
export async function getFrdDocument(tenantId: string, id: string): Promise<{ document: FrdDocumentRow; requirements: FunctionalRequirement[] } | null> {
  const { rows: docs } = await pool.query(
    `SELECT id, name, summary, source, requirement_count, created_by, created_at
     FROM frd_documents WHERE tenant_id = $1 AND id = $2`,
    [tenantId, id],
  );
  if (!docs.length) return null;
  const d = docs[0];
  const { rows } = await pool.query(
    `SELECT fr_id, title, description, actors, preconditions, endpoints, parameters, headers,
            request_body, auth, responses, validations, error_handling, acceptance_criteria,
            dependencies, positive_scenarios, negative_scenarios
     FROM functional_requirements WHERE tenant_id = $1 AND document_id = $2 ORDER BY sort_order`,
    [tenantId, id],
  );
  const requirements: FunctionalRequirement[] = rows.map((r: any) => ({
    frId: r.fr_id, title: r.title, description: r.description || undefined,
    actors: parseStrArr(r.actors), preconditions: parseStrArr(r.preconditions),
    endpoints: parseArr(r.endpoints) as FrEndpoint[], parameters: parseStrArr(r.parameters),
    headers: parseStrArr(r.headers), requestBody: r.request_body || undefined, auth: r.auth || undefined,
    responses: parseArr(r.responses) as FrResponse[], validations: parseStrArr(r.validations),
    errorHandling: parseStrArr(r.error_handling), acceptanceCriteria: parseStrArr(r.acceptance_criteria),
    dependencies: parseStrArr(r.dependencies), positiveScenarios: parseStrArr(r.positive_scenarios),
    negativeScenarios: parseStrArr(r.negative_scenarios),
  }));
  return {
    document: {
      id: d.id, name: d.name, summary: d.summary || undefined, source: d.source,
      requirementCount: Number(d.requirement_count || 0), createdBy: d.created_by || undefined, createdAt: String(d.created_at),
    },
    requirements,
  };
}

/** Delete an FRD document and its requirements (cascade). */
export async function deleteFrdDocument(tenantId: string, id: string): Promise<boolean> {
  const { rowCount } = await pool.query(`DELETE FROM frd_documents WHERE tenant_id = $1 AND id = $2`, [tenantId, id]);
  return (rowCount || 0) > 0;
}
