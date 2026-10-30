/**
 * api-brd.service.ts — Business Requirements Document module (Module 2).
 *
 * Reads an uploaded BRD (already extracted to text by document-parser) and uses
 * the tenant LLM to produce STRUCTURED business requirements — BR-### ids,
 * objectives, rules, workflows, acceptance criteria, validations, dependencies
 * and positive/negative scenarios — then persists them per tenant.
 *
 * This is distinct from the BRD *import* card (Module 1), which extracts API
 * endpoints. Here the output is the requirements themselves, for traceability.
 * Additive: new tables (brd_documents, business_requirements), nothing else
 * depends on it yet.
 */
import pool from '../db.js';
import { runLLM, parseJsonFromResponse, coerceJsonArray, salvageJsonArrayObjects, type LlmConfig } from '../agents/claude-runner.js';
import { annotateBrReviewFlags, type ReviewFlag } from '../utils/requirement-review.js';

export interface BusinessRequirement {
  brId: string;
  title: string;
  description?: string;
  objective?: string;
  rules?: string[];
  workflows?: string[];
  acceptanceCriteria?: string[];
  validations?: string[];
  dependencies?: string[];
  positiveScenarios?: string[];
  negativeScenarios?: string[];
  reviewFlags?: ReviewFlag[]; // Gap B — derived human-review flags
}

export interface BrdAnalysis {
  summary: string;
  requirements: BusinessRequirement[];
}

export interface BrdDocumentRow {
  id: string;
  name: string;
  summary?: string;
  source: string;
  requirementCount: number;
  createdBy?: string;
  createdAt: string;
}

const MAX_REQUIREMENTS = 200;

const asList = (v: unknown): string[] => {
  if (Array.isArray(v)) return v.map((x) => String(x)).map((s) => s.trim()).filter(Boolean).slice(0, 40);
  if (typeof v === 'string' && v.trim()) return [v.trim()];
  return [];
};

/** Normalise one raw model requirement into our shape, filling a BR id if absent. */
function normalizeRequirement(raw: any, index: number): BusinessRequirement | null {
  if (!raw || typeof raw !== 'object') return null;
  const title = String(raw.title || raw.name || raw.requirement || '').trim().slice(0, 600);
  const description = String(raw.description || raw.detail || '').trim().slice(0, 4000);
  if (!title && !description) return null;
  let brId = String(raw.brId || raw.id || raw.br_id || '').trim().toUpperCase();
  if (!/^BR[-_ ]?\d+/i.test(brId)) brId = `BR-${String(index + 1).padStart(3, '0')}`;
  brId = brId.replace(/^BR[-_ ]?/i, 'BR-');
  return {
    brId,
    title: title || `Requirement ${index + 1}`,
    description: description || undefined,
    objective: String(raw.objective || '').trim().slice(0, 2000) || undefined,
    rules: asList(raw.rules ?? raw.businessRules),
    workflows: asList(raw.workflows ?? raw.businessWorkflows),
    acceptanceCriteria: asList(raw.acceptanceCriteria ?? raw.acceptance_criteria),
    validations: asList(raw.validations ?? raw.businessValidations),
    dependencies: asList(raw.dependencies),
    positiveScenarios: asList(raw.positiveScenarios ?? raw.positive_scenarios),
    negativeScenarios: asList(raw.negativeScenarios ?? raw.negative_scenarios),
  };
}

function buildPrompt(text: string, fileName: string): string {
  return `You are a senior business analyst. Read the following Business Requirements Document and extract its BUSINESS requirements as structured data.

For EACH distinct business requirement, produce an object with:
- "brId": the document's own requirement id if present (e.g. "BR-001"); otherwise leave blank and one will be assigned.
- "title": a short imperative statement of the requirement.
- "description": the full requirement text.
- "objective": the business objective it serves (if stated or clearly implied).
- "rules": array of business rules it imposes.
- "workflows": array of business workflow steps it describes.
- "acceptanceCriteria": array of acceptance criteria.
- "validations": array of business validations/constraints.
- "dependencies": array of other requirements or systems it depends on.
- "positiveScenarios": array of positive (happy-path) business scenarios.
- "negativeScenarios": array of negative/exception business scenarios.
Leave an array empty when the document does not state it — do NOT invent detail.

Return ONLY a JSON object: { "summary": "<one-paragraph summary of the document>", "requirements": [ ... ] }. No markdown, no prose outside the JSON.

═══════════════════════════════════════════════════════════════
SOURCE: ${fileName}
DOCUMENT CONTENT (may be truncated):
═══════════════════════════════════════════════════════════════
${text.slice(0, 60000)}`;
}

/** Extract structured business requirements from BRD text via the tenant LLM. */
export async function analyzeBrd(text: string, fileName: string, llm: LlmConfig | undefined): Promise<BrdAnalysis> {
  if (!text || text.trim().length < 20) {
    throw new Error('The document contained too little text to extract business requirements.');
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
    .filter((r): r is BusinessRequirement => r !== null)
    .slice(0, MAX_REQUIREMENTS);

  if (requirements.length === 0) {
    throw new Error('No business requirements could be identified in the document.');
  }
  return { summary: summary.slice(0, 4000), requirements: annotateBrReviewFlags(requirements) };
}

/** Persist an analysed BRD and its requirements for a tenant. Returns the doc id. */
export async function saveBrdAnalysis(
  tenantId: string, username: string, name: string, analysis: BrdAnalysis, source = 'upload',
): Promise<BrdDocumentRow> {
  const inserted = await pool.query(
    `INSERT INTO brd_documents (tenant_id, name, summary, source, requirement_count, created_by)
     OUTPUT INSERTED.id, INSERTED.created_at
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [tenantId, name.slice(0, 400), analysis.summary || null, source, analysis.requirements.length, username],
  );
  const docId = inserted.rows[0].id as string;
  const createdAt = String(inserted.rows[0].created_at);

  let order = 0;
  for (const r of analysis.requirements) {
    await pool.query(
      `INSERT INTO business_requirements
         (tenant_id, document_id, br_id, title, description, objective, rules, workflows,
          acceptance_criteria, validations, dependencies, positive_scenarios, negative_scenarios, sort_order)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [
        tenantId, docId, r.brId, r.title.slice(0, 600), r.description || null, r.objective || null,
        JSON.stringify(r.rules || []), JSON.stringify(r.workflows || []),
        JSON.stringify(r.acceptanceCriteria || []), JSON.stringify(r.validations || []),
        JSON.stringify(r.dependencies || []), JSON.stringify(r.positiveScenarios || []),
        JSON.stringify(r.negativeScenarios || []), order++,
      ],
    );
  }
  return { id: docId, name: name.slice(0, 400), summary: analysis.summary, source, requirementCount: analysis.requirements.length, createdBy: username, createdAt };
}

/** List a tenant's BRD documents, most recent first. */
export async function listBrdDocuments(tenantId: string): Promise<BrdDocumentRow[]> {
  const { rows } = await pool.query(
    `SELECT id, name, summary, source, requirement_count, created_by, created_at
     FROM brd_documents WHERE tenant_id = $1 ORDER BY created_at DESC`,
    [tenantId],
  );
  return rows.map((r: any) => ({
    id: r.id, name: r.name, summary: r.summary || undefined, source: r.source,
    requirementCount: Number(r.requirement_count || 0), createdBy: r.created_by || undefined,
    createdAt: String(r.created_at),
  }));
}

const parseArr = (v: unknown): string[] => {
  if (Array.isArray(v)) return v.map(String);
  if (typeof v === 'string' && v.trim()) { try { const p = JSON.parse(v); return Array.isArray(p) ? p.map(String) : []; } catch { return []; } }
  return [];
};

/** A BRD document plus its structured requirements. */
export async function getBrdDocument(tenantId: string, id: string): Promise<{ document: BrdDocumentRow; requirements: BusinessRequirement[] } | null> {
  const { rows: docs } = await pool.query(
    `SELECT id, name, summary, source, requirement_count, created_by, created_at
     FROM brd_documents WHERE tenant_id = $1 AND id = $2`,
    [tenantId, id],
  );
  if (!docs.length) return null;
  const d = docs[0];
  const { rows } = await pool.query(
    `SELECT br_id, title, description, objective, rules, workflows, acceptance_criteria,
            validations, dependencies, positive_scenarios, negative_scenarios
     FROM business_requirements WHERE tenant_id = $1 AND document_id = $2 ORDER BY sort_order`,
    [tenantId, id],
  );
  const requirements: BusinessRequirement[] = annotateBrReviewFlags(rows.map((r: any) => ({
    brId: r.br_id, title: r.title, description: r.description || undefined, objective: r.objective || undefined,
    rules: parseArr(r.rules), workflows: parseArr(r.workflows), acceptanceCriteria: parseArr(r.acceptance_criteria),
    validations: parseArr(r.validations), dependencies: parseArr(r.dependencies),
    positiveScenarios: parseArr(r.positive_scenarios), negativeScenarios: parseArr(r.negative_scenarios),
  })));
  return {
    document: {
      id: d.id, name: d.name, summary: d.summary || undefined, source: d.source,
      requirementCount: Number(d.requirement_count || 0), createdBy: d.created_by || undefined, createdAt: String(d.created_at),
    },
    requirements,
  };
}

/** Delete a BRD document and its requirements (cascade). */
export async function deleteBrdDocument(tenantId: string, id: string): Promise<boolean> {
  const { rowCount } = await pool.query(`DELETE FROM brd_documents WHERE tenant_id = $1 AND id = $2`, [tenantId, id]);
  return (rowCount || 0) > 0;
}
