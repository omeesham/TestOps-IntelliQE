/**
 * requirementAgent
 * ────────────────
 * Reads the raw requirements text (which may have been pasted, pulled
 * from Jira, or synthesized by exploreAgent) and produces a *structured*
 * `ParsedRequirements` object. The shape captures everything the planner
 * and generator need to write professional, IEEE-829-style test cases:
 *
 *   features                  high-level functional capabilities
 *   modules                   feature grouping (module / submodule)
 *   actors                    user roles / personas
 *   flows                     end-to-end user journeys
 *   edgeCases                 boundary + error + concurrency scenarios
 *   dataRules                 field-level validation rules
 *   acceptanceCriteria        Given/When/Then statements
 *   nonFunctionalRequirements perf, security, accessibility, compatibility
 *   businessRisks             feature × risk-level mapping (drives priority)
 *   personaMatrix             actor × allowed/denied features (drives authz tests)
 *
 * The prompt is deliberately strict: if the source text is ambiguous,
 * the agent must mark assumptions instead of inventing facts.
 */
import { EXTRACTED_DATA_TYPES } from './state.js';
import type { TestOpsState, ParsedRequirements, RuleSource, DocumentExtraction, ExtractedField, ExtractedDataType, RiskLevel } from './state.js';
import { runClaudePrompt, parseJsonFromResponse } from './claude-runner.js';
import { selectSkills, skillSystemPrompt } from './skills.js';
import { mobileContextNote } from './mobile-context.js';

export async function requirementAgent(state: TestOpsState): Promise<TestOpsState> {
  const appInfo = state.appContext
    ? `\nApplication Under Test: ${state.appContext.appName || 'Unknown'}\nTarget URL: ${state.appContext.targetUrl || 'Not specified'}\nEnvironment: ${state.appContext.environment || 'staging'}`
    : '';

  // Empty for web/API — appends native-mobile guidance only when platform is set.
  const mobileNote = mobileContextNote(state.appContext);

  const exploredHint = state.exploredApp
    ? `\n\nNote: This requirements text was synthesized from a live crawl of the application. The following pages were observed during exploration: ${state.exploredApp.pages.map((p) => p.title || p.url).slice(0, 8).join(' | ')}. Detected features: ${state.exploredApp.detectedFeatures.join(', ')}.`
    : '';

  // Screens the crawler identified as reading documents (exploreAgent.detectDocumentFeatures).
  const docSignals = state.exploredApp?.documentFeatures?.length
    ? `\n\nDOCUMENT FEATURES OBSERVED (fill documentExtraction from these; every listed field and table column is an extracted field):\n${JSON.stringify(state.exploredApp.documentFeatures, null, 2)}`
    : '';

  const prompt = `You are a Senior QA Requirements Analyst with 15+ years of experience writing test plans for enterprise software. Read the requirements below and extract a structured analysis that a test designer can convert directly into IEEE-829-style test cases.

REQUIREMENTS:
${state.requirements}
${appInfo}${exploredHint}${docSignals}${mobileNote}

Return ONLY valid JSON (no markdown, no commentary, no explanation) matching this exact schema:

{
  "features": ["Feature Name 1", "Feature Name 2", ...],
  "modules": [
    { "module": "Module Name", "submodule": "Optional Submodule", "features": ["Feature A", "Feature B"] }
  ],
  "actors": ["End User", "Administrator", "Anonymous Visitor"],
  "flows": [
    "Actor + verb + object + outcome — e.g., 'Registered customer searches for product, adds it to cart, applies a coupon, and completes checkout'"
  ],
  "edgeCases": [
    "Boundary / error / concurrency scenario — e.g., 'Coupon code expires during checkout session'"
  ],
  "dataRules": [
    "Field-level rule — e.g., 'Email must match RFC 5322 and be unique across registered users'"
  ],
  "acceptanceCriteria": [
    "Given <precondition> When <action> Then <expected result>"
  ],
  "nonFunctionalRequirements": {
    "performance": ["e.g., 'Search results return in under 2 seconds for 1M-product catalog'"],
    "security": ["e.g., 'Passwords stored using bcrypt cost 12'", "e.g., 'CSRF tokens on all state-changing requests'"],
    "accessibility": ["e.g., 'All form controls have labels conformant to WCAG 2.1 AA'"],
    "compatibility": ["e.g., 'Latest two versions of Chrome, Edge, Safari, Firefox'"],
    "usability": ["e.g., 'Error messages must be specific and actionable, not generic'"]
  },
  "businessRisks": [
    { "feature": "Checkout", "risk": "High", "rationale": "Revenue-critical path; failure causes immediate cart abandonment" },
    { "feature": "Search", "risk": "Medium", "rationale": "Affects discoverability but does not block transactions" }
  ],
  "personaMatrix": [
    { "actor": "Administrator", "allowedFeatures": ["User Management", "Reports"], "deniedFeatures": [] },
    { "actor": "End User", "allowedFeatures": ["Search", "Checkout"], "deniedFeatures": ["User Management"] }
  ],
  "fieldRules": [
    { "id": "FLD-01", "field": "Email", "screen": "Registration", "constraints": ["required", "valid email format", "max 100 characters"], "source": "observed" },
    { "id": "FLD-02", "field": "Quantity", "screen": "Cart", "constraints": ["whole number", "min 1", "max 10"], "source": "stated" }
  ],
  "businessRules": [
    { "id": "BR-01", "rule": "Order total = sum of line totals minus discount, never negative", "feature": "Checkout", "source": "stated" },
    { "id": "BR-02", "rule": "A coupon can be used once per customer", "feature": "Checkout", "source": "assumed" }
  ],
  "documentExtraction": [
    {
      "feature": "Timesheet Scanning",
      "screen": "/scan",
      "documentType": "Handwritten timesheet (PDF)",
      "inputs": ["pdf", "multiple files"],
      "trigger": "Scan",
      "fields": [
        { "id": "EXT-01", "name": "Timesheet Number", "group": "Header", "dataType": "code", "risk": "High", "required": true, "showsConfidence": true },
        { "id": "EXT-02", "name": "Hours Worked", "group": "Hours table", "dataType": "duration", "risk": "High", "required": false, "showsConfidence": true }
      ],
      "variations": ["neat handwriting", "messy handwriting", "crossed-out values", "faint scan", "rotated page", "multi-row", "several documents in one upload"],
      "ruleIds": []
    }
  ]
}

EXTRACTION RULES (read carefully):
1. Be exhaustive on FEATURES — every distinct user capability counts as one feature (for example "Registration", "Ticket booking", "Search"). A single input field is NOT a feature: field rules go in fieldRules.
2. Be specific on FLOWS — each flow is a complete journey with an actor, sequence, and outcome. No generic placeholders.
3. EDGE CASES must cover: empty/null/whitespace input, boundary values (min, max, off-by-one), invalid format, concurrency (two users editing the same record), session/auth expiry, network failure, partial writes, role-permission violations.
4. DATA RULES must be field-specific. "Email is required" — good. "Inputs must be valid" — useless.
5. ACCEPTANCE CRITERIA must be in Given/When/Then form. Generate at least 3 per major feature.
6. NON-FUNCTIONAL REQUIREMENTS — even if the source text omits them, infer reasonable ones based on the domain (a banking app implies stronger security; an e-commerce app implies performance under load). Mark inferred items by ending them with " (inferred)".
7. BUSINESS RISKS — rate each feature High / Medium / Low based on impact-on-revenue, regulatory exposure, user trust, and data sensitivity. Provide a one-line rationale.
8. PERSONA MATRIX — for every actor + feature pair where authorisation matters, list whether the actor is allowed or denied. This drives RBAC negative tests.
9. If the source text is sparse, INFER reasonable extensions based on the application domain — but mark inferences with " (inferred)" in the relevant field.
10. NEVER return empty arrays for features / actors / flows — at minimum return one entry each based on what you can deduce.
11. FIELD RULES — one entry per real input field, id FLD-01, FLD-02… Constraints must be concrete and testable ("max 50 characters", "digits only", "values: Yes | No", "pdf, png only"). Copy constraints observed on the page exactly. source: "observed" (seen on the page), "stated" (in the requirements text) or "assumed" (neither; keep these few).
12. BUSINESS RULES — every calculation, condition, cross-field check, permission or status rule the source states or the page clearly enforces, id BR-01, BR-02… One rule per entry, testable as written, with its source as above.
13. DOCUMENT EXTRACTION — only for features that read documents (upload a PDF or image, then OCR or AI extraction fills fields, often with a confidence score); otherwise an empty array. For each such feature:
    • fields: EVERY extracted output field (header fields AND every column of result tables), id EXT-01, EXT-02… unique across features, with group, dataType (text | name | number | money | date | time | duration | code | list), required (the screen marks it mandatory), showsConfidence, and risk: record-linking IDs (ticket, order, project, account numbers), hours, money and quantities are High; dates and names Medium; free text Low.
    • rules on extracted values go into businessRules ONLY when the requirements state them or the page enforces them; list their ids in ruleIds. Do not assume arithmetic between fields (totals, time differences) that nobody stated.
    • variations: the document variation classes that apply to this document type (handwriting, notation, scan quality, structure).`;

  const response = await runClaudePrompt(prompt, {
    maxTokens: 14000,
    system: skillSystemPrompt('You are a senior QA requirements analyst. Build the coverage model from section 1 of the skill.', selectSkills(state)),
  });
  const parsed = parseJsonFromResponse<ParsedRequirements>(response);

  // Defensive normalisation — Claude may omit some optional sections.
  const parsedRequirements: ParsedRequirements = {
    features: parsed.features?.length ? parsed.features : ['General'],
    modules: parsed.modules || [{ module: 'General', features: parsed.features || ['General'] }],
    actors: parsed.actors?.length ? parsed.actors : ['User'],
    flows: parsed.flows?.length ? parsed.flows : ['Primary user flow'],
    edgeCases: parsed.edgeCases || [],
    dataRules: parsed.dataRules || [],
    acceptanceCriteria: parsed.acceptanceCriteria || [],
    nonFunctionalRequirements: parsed.nonFunctionalRequirements || {},
    businessRisks: parsed.businessRisks || [],
    personaMatrix: parsed.personaMatrix || [],
    fieldRules: withIds<RawRule>(parsed.fieldRules, 'FLD', (r) => !!r.field).map((r) => ({
      id: r.id,
      field: String(r.field),
      screen: r.screen,
      constraints: (Array.isArray(r.constraints) ? r.constraints : r.constraints ? [r.constraints] : [])
        .map((c) => String(c ?? '').trim()).filter(Boolean),
      source: sourceOf(r.source),
    })),
    businessRules: withIds<RawRule>(parsed.businessRules, 'BR', (r) => !!r.rule).map((r) => ({
      id: r.id,
      rule: String(r.rule),
      feature: r.feature,
      source: sourceOf(r.source),
    })),
    documentExtraction: normaliseDocumentExtraction(parsed.documentExtraction),
  };

  return { ...state, parsedRequirements };
}

/** A document feature as the model returns it, before normalisation. */
type RawDocument = { feature?: unknown; screen?: unknown; documentType?: unknown; inputs?: unknown; trigger?: unknown; fields?: unknown; variations?: unknown; ruleIds?: unknown };
type RawExtractedField = { id?: string; name?: unknown; group?: unknown; dataType?: unknown; risk?: unknown; required?: unknown; showsConfidence?: unknown };

const RISKS: RiskLevel[] = ['High', 'Medium', 'Low'];
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.map((s) => String(s ?? '').trim()).filter(Boolean) : []);
const optionalText = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);

/**
 * Well-formed document features only, every field typed and every EXT id unique
 * across features. Values the model gets wrong fall back to safe defaults
 * (unknown type → text; unknown risk → Medium).
 */
export function normaliseDocumentExtraction(input: unknown): DocumentExtraction[] {
  if (!Array.isArray(input)) return [];
  const docs = input.filter((d): d is RawDocument => !!d && typeof d === 'object' && typeof (d as RawDocument).feature === 'string');
  const isField = (f: unknown): f is RawExtractedField =>
    !!f && typeof f === 'object' && typeof (f as RawExtractedField).name === 'string' && !!String((f as RawExtractedField).name).trim();
  const fieldsPerDoc = docs.map((d) => (Array.isArray(d.fields) ? d.fields.filter(isField) : []));
  // EXT ids are unique across all features, so every field is numbered in one pass.
  const numbered = withIds<RawExtractedField>(fieldsPerDoc.flat(), 'EXT', () => true);
  let at = 0;
  return docs.map((d, i) => {
    const count = fieldsPerDoc[i].length;
    const fields: ExtractedField[] = numbered.slice(at, at + count).map((f) => ({
      id: f.id,
      name: String(f.name).trim(),
      group: optionalText(f.group),
      dataType: EXTRACTED_DATA_TYPES.includes(f.dataType as ExtractedDataType) ? f.dataType as ExtractedDataType : 'text',
      risk: RISKS.includes(f.risk as RiskLevel) ? f.risk as RiskLevel : 'Medium',
      required: f.required === true,
      showsConfidence: f.showsConfidence === true,
    }));
    at += count;
    return {
      feature: String(d.feature).trim(),
      screen: optionalText(d.screen),
      documentType: optionalText(d.documentType) || 'Document',
      inputs: strings(d.inputs),
      trigger: optionalText(d.trigger),
      fields,
      variations: strings(d.variations),
      ruleIds: strings(d.ruleIds),
    };
  }).filter((d) => d.fields.length > 0);
}

/** A rule as the model returns it, before normalisation. */
type RawRule = { id?: string; field?: unknown; screen?: string; constraints?: unknown; rule?: unknown; feature?: string; source?: unknown };

const RULE_SOURCES: RuleSource[] = ['observed', 'stated', 'assumed'];
const sourceOf = (v: unknown): RuleSource => (RULE_SOURCES.includes(v as RuleSource) ? v as RuleSource : 'assumed');

/**
 * Drop malformed entries and give every rule a unique id (PREFIX-01…): the model
 * sometimes omits ids or repeats them, and coverage tracking depends on them.
 */
export function withIds<T extends { id?: string }>(list: unknown, prefix: string, valid: (r: T) => boolean): (T & { id: string })[] {
  if (!Array.isArray(list)) return [];
  const seen = new Set<string>();
  let n = 0;
  return (list.filter((r) => r && typeof r === 'object') as T[]).filter(valid).map((r) => {
    let id = String(r.id || '').toUpperCase().trim();
    if (!new RegExp(`^${prefix}-\\d+$`).test(id) || seen.has(id)) {
      do { id = `${prefix}-${String(++n).padStart(2, '0')}`; } while (seen.has(id));
    }
    seen.add(id);
    return { ...r, id };
  });
}
