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
import type { TestOpsState, ParsedRequirements, RuleSource } from './state.js';
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

  const prompt = `You are a Senior QA Requirements Analyst with 15+ years of experience writing test plans for enterprise software. Read the requirements below and extract a structured analysis that a test designer can convert directly into IEEE-829-style test cases.

REQUIREMENTS:
${state.requirements}
${appInfo}${exploredHint}${mobileNote}

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
12. BUSINESS RULES — every calculation, condition, cross-field check, permission or status rule the source states or the page clearly enforces, id BR-01, BR-02… One rule per entry, testable as written, with its source as above.`;

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
  };

  return { ...state, parsedRequirements };
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
