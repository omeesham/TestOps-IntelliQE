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
import type { TestOpsState, ParsedRequirements } from './state.js';
import { runLLM, parseJsonFromResponse, llmForStage } from './claude-runner.js';

export async function requirementAgent(state: TestOpsState): Promise<TestOpsState> {
  const appInfo = state.appContext
    ? `\nApplication Under Test: ${state.appContext.appName || 'Unknown'}\nTarget URL: ${state.appContext.targetUrl || 'Not specified'}\nEnvironment: ${state.appContext.environment || 'staging'}`
    : '';

  const exploredHint = state.exploredApp
    ? `\n\nNote: This requirements text was synthesized from a live crawl of the application. The following pages were observed during exploration: ${state.exploredApp.pages.map((p) => p.title || p.url).slice(0, 8).join(' | ')}. Detected features: ${state.exploredApp.detectedFeatures.join(', ')}.`
    : '';

  const prompt = `You are a Senior QA Requirements Analyst with 15+ years of experience writing test plans for enterprise software. Read the requirements below and extract a structured analysis that a test designer can convert directly into IEEE-829-style test cases.

REQUIREMENTS:
${state.requirements}
${appInfo}${exploredHint}

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
  ]
}

EXTRACTION RULES (read carefully — GROUND EVERYTHING IN EVIDENCE, do not invent):
1. FEATURES — extract ONLY capabilities that are actually described in the requirements or visibly present in the observed application. Do NOT invent or infer features that aren't evidenced. A simple login page has a few features (e.g. "User Login", "Field Validation", "Forgot Password" if a link exists), NOT twenty. Quality and accuracy over breadth.
2. FLOWS — specific, grounded journeys only. A single-form page may have just one flow.
3. EDGE CASES — include ONLY edge cases that apply to the actual fields and behaviors present (e.g. empty required field, invalid format for a field that exists). Do NOT add a generic battery (concurrency, network failure, partial writes, session expiry) unless the requirements or the app clearly involve them.
4. DATA RULES must be field-specific and only for fields that actually exist. "Email is required" — good. "Inputs must be valid" — useless.
5. ACCEPTANCE CRITERIA — Given/When/Then form, only where they add real value. Do NOT pad to a fixed number per feature.
6. NON-FUNCTIONAL REQUIREMENTS — include ONLY those explicitly stated in the source. Do NOT infer or add security, performance, accessibility, or compatibility requirements the source doesn't mention. Leave these arrays empty when the source is silent. (No "(inferred)" padding — speculative non-functional requirements create irrelevant test cases downstream.)
7. BUSINESS RISKS — rate ONLY the real features you extracted. One-line rationale each.
8. PERSONA MATRIX — populate ONLY when the requirements actually describe multiple roles with different access. For a single-actor page, return an empty array (or one entry) — do not fabricate roles to create RBAC tests.
9. Do NOT invent features, rules, or requirements to look thorough. If the source is sparse, the analysis should be small and focused. Grounded, relevant coverage beats speculative breadth.
10. NEVER return empty arrays for features / actors / flows — at minimum return one grounded entry each.`;

  const response = await runLLM(prompt, { maxTokens: 8000, llm: llmForStage(state.llm, 'requirement') });
  // Resilience guard (additive): this is the FIRST pipeline stage and must never
  // hard-abort the whole run on an unparseable model response. parseJsonFromResponse
  // throws on total garbage; fall back to an empty object so the defensive
  // normalisation below still yields a minimal grounded shape. The success path is
  // unchanged — a valid response parses exactly as before.
  let parsed: Partial<ParsedRequirements>;
  try {
    parsed = parseJsonFromResponse<ParsedRequirements>(response);
  } catch (err) {
    console.warn('[requirementAgent] response was not parseable JSON — using grounded fallback:', (err as Error).message);
    parsed = {};
  }

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
  };

  return { ...state, parsedRequirements };
}
