/**
 * generatorAgent
 * ──────────────
 * Produces fully-formed, IEEE-829 / ISTQB-style test cases from the
 * ParsedRequirements + ExtendedTestPlan. Each test case is structured
 * such that a QA lead, a developer, or an automation engineer can pick
 * it up and execute or script it without re-reading the source spec.
 *
 * Per-test fields (see TestCase in state.ts):
 *   id                Sequential TC-### identifier
 *   traceabilityId    Link back to the originating story / requirement / persona
 *   module/submodule  Suite classification
 *   feature           Capability under test
 *   title             "Verify <action> <object> <condition>" — short and unique
 *   description       2-3 sentence purpose of the case
 *   precondition      System state required before execution
 *   testData          Concrete values (no placeholders)
 *   testSteps         Numbered step list, each with its own expected result
 *   steps             String form of the same steps (back-compat)
 *   expectedResult    Final / cumulative outcome
 *   type              positive | negative | edge | e2e | api | data | smoke | security | accessibility | performance
 *   priority          P0–P3
 *   severity          Critical | Major | Moderate | Minor
 *   tags              Free-form filters
 *
 * The prompt enforces three things that historically slipped:
 *   1. Every numbered step gets its own expected result.
 *   2. Test data must be CONCRETE (real values, not "<email>" placeholders).
 *   3. Titles must be unique and follow the "Verify …" convention.
 */
import { TEST_CATEGORIES } from './state.js';
import type { TestOpsState, TestCase, TestStep, TestCategory, CoverageLevel, CoverageSummary } from './state.js';
import { runClaudePrompt, parseJsonFromResponse } from './claude-runner.js';
import type { ExtendedTestPlan } from './plannerAgent.js';
import { mobileContextNote } from './mobile-context.js';
import { selectSkills, skillSystemPrompt } from './skills.js';

let counter = 0;
function nextId() { return `TC-${String(++counter).padStart(3, '0')}`; }

/** Shape Claude is asked to return — kept loose so we can normalise later. */
type RawTestCase = {
  traceabilityId?: string;
  module?: string;
  submodule?: string;
  feature: string;
  title?: string;
  scenario?: string;            // legacy alias
  description?: string;
  precondition?: string;
  testData?: Record<string, string>;
  testSteps?: { step?: number; action: string; expected: string; testData?: string }[];
  steps?: string[];             // legacy fallback
  expectedResult: string;
  type: string;
  priority: string;
  severity?: string;
  tags?: string[];
  category?: string;
};

const VALID_TYPES: TestCase['type'][] = [
  'positive', 'negative', 'edge', 'e2e', 'api', 'data', 'smoke', 'security', 'accessibility', 'performance',
];
const VALID_PRIORITIES: TestCase['priority'][] = ['P0', 'P1', 'P2', 'P3'];
const VALID_SEVERITIES: NonNullable<TestCase['severity']>[] = ['Critical', 'Major', 'Moderate', 'Minor'];

function coerceTestCase(raw: RawTestCase): TestCase {
  const title = (raw.title || raw.scenario || 'Untitled test case').trim();
  const testSteps: TestStep[] = Array.isArray(raw.testSteps) && raw.testSteps.length > 0
    ? raw.testSteps.map((s, i) => ({
        step: s.step ?? i + 1,
        action: String(s.action || '').trim(),
        expected: String(s.expected || '').trim(),
        testData: s.testData,
      })).filter((s) => s.action)
    : [];

  // Always also produce a plain-string steps array — older UI components,
  // the script agent, and DB rows still expect this.
  const stringSteps: string[] = testSteps.length > 0
    ? testSteps.map((s) => `${s.step}. ${s.action}${s.expected ? ` → Expected: ${s.expected}` : ''}`)
    : (Array.isArray(raw.steps) ? raw.steps : [title]);

  const type: TestCase['type'] = (VALID_TYPES as string[]).includes(raw.type)
    ? raw.type as TestCase['type']
    : 'positive';
  const priority: TestCase['priority'] = (VALID_PRIORITIES as string[]).includes(raw.priority)
    ? raw.priority as TestCase['priority']
    : 'P1';
  const severity: TestCase['severity'] | undefined = raw.severity && (VALID_SEVERITIES as string[]).includes(raw.severity)
    ? raw.severity as TestCase['severity']
    : undefined;

  return {
    id: nextId(),
    traceabilityId: raw.traceabilityId,
    module: raw.module,
    submodule: raw.submodule,
    feature: raw.feature || 'General',
    title,
    scenario: title,              // back-compat alias
    description: raw.description,
    precondition: raw.precondition,
    testData: raw.testData,
    testSteps,
    steps: stringSteps,
    expectedResult: raw.expectedResult || 'Test passes successfully',
    type,
    priority,
    severity,
    tags: Array.isArray(raw.tags) ? raw.tags : undefined,
    category: categoryFor(raw.category, type),
    status: 'generated',
  };
}

/** Category from the model, else derived from the type. */
export function categoryFor(raw: string | undefined, type: TestCase['type']): TestCategory {
  const v = String(raw || '').toLowerCase().trim().replace(/[\s_]+/g, '-');
  const alias: Record<string, TestCategory> = {
    business: 'business-rule', 'business-rules': 'business-rule', rule: 'business-rule',
    boundaries: 'boundary', 'boundary-value': 'boundary', 'edge-case': 'edge', a11y: 'accessibility',
  };
  if ((TEST_CATEGORIES as readonly string[]).includes(v)) return v as TestCategory;
  if (alias[v]) return alias[v];
  if (type === 'negative' || type === 'edge' || type === 'security' || type === 'accessibility') return type;
  return 'positive';
}

/** What each coverage level asks for (test-design skill, section 4). */
const COVERAGE_INSTRUCTIONS: Record<CoverageLevel, string> = {
  essential: 'COVERAGE LEVEL: essential (smoke). One happy path per feature, one negative case per validation rule, and every business rule (BR-xx) once. Budget: about 1 case per rule plus 1 happy path per feature.',
  standard: 'COVERAGE LEVEL: standard (regression). Everything in essential, plus: boundary values (min, max, just below, just above) for every constrained field (FLD-xx); one case per meaningful condition combination of multi-condition business rules; each valid state transition and at least one blocked transition; error guessing for each form (empty submit, leading/trailing spaces, special characters, duplicate submit); and at most one baseline security check per form, only for what the app really has. Budget: at most 3 cases per field or business rule; combine valid boundaries of independent fields into one case.',
  exhaustive: 'COVERAGE LEVEL: exhaustive (full regression). Everything in standard, plus: every invalid equivalence class per field, pairwise combinations of independent options, extended error guessing (interruptions, back button after submit, session expiry where the app has sessions), role × action for every role, and baseline accessibility checks per screen. Budget: at most 6 cases per field or business rule.',
};

/** Rules handled per generation call, so each response stays within output and time limits. */
const RULES_PER_BATCH = 8;

/** Rule ids (FLD-xx, BR-xx) that the cases trace to. */
export function coveredIds(cases: { traceabilityId?: string }[]): Set<string> {
  const ids = new Set<string>();
  for (const c of cases) {
    for (const m of String(c.traceabilityId || '').toUpperCase().matchAll(/\b(?:FLD|BR)-\d+\b/g)) ids.add(m[0]);
  }
  return ids;
}

/** Every rule in the coverage model, as "id — text" for prompts and the coverage summary. */
function ruleItems(state: TestOpsState): { id: string; text: string }[] {
  const pr = state.parsedRequirements!;
  return [
    ...(pr.fieldRules || []).map((f) => ({
      id: f.id.toUpperCase(),
      text: `${f.id} — ${f.field}${f.screen ? ` (${f.screen})` : ''}: ${f.constraints.join('; ')}`,
    })),
    ...(pr.businessRules || []).map((b) => ({ id: b.id.toUpperCase(), text: `${b.id} — ${b.rule}` })),
  ];
}

function buildPrompt(state: TestOpsState, excludeTitles: string[] = [], gapFocus = ''): string {
  const pr = state.parsedRequirements!;
  const plan = state.extendedTestPlan as ExtendedTestPlan | undefined;
  const appInfo = state.appContext
    ? `Application: ${state.appContext.appName || 'Web App'}\nURL: ${state.appContext.targetUrl || 'Not specified'}\nEnvironment: ${state.appContext.environment || 'staging'}`
    : '';

  const coverage = state.generationOptions?.coverage || 'standard';
  const requestedMax = state.generationOptions?.maxTestCases;
  const countInstruction = requestedMax && requestedMax > 0
    ? `- Generate AT MOST ${requestedMax} test cases — this is a HARD CEILING, do not exceed it. Spend the budget on the HIGHEST-VALUE cases: prioritise by business risk (happy path, then the most likely failure modes, then critical edge/security cases). Return ONLY the most important ${requestedMax}.`
    : `- The number of cases follows from the coverage model and the coverage level: as many as the techniques require, no padding.`;

  const exclusionBlock = excludeTitles.length > 0
    ? `\n\nALREADY GENERATED — DO NOT REPEAT THESE TITLES (case-insensitive):\n${excludeTitles.map((s) => `- ${s}`).join('\n')}\nGenerate only NEW scenarios not in the above list.`
    : '';

  // Plan summary — gives the LLM something concrete to anchor counts and types to.
  const planSummary = plan
    ? `\n\nTEST PLAN:
- Strategy: ${plan.testStrategy}
- Counts: UI=${plan.uiTests}, API=${plan.apiTests}, Data=${plan.dataTests}, E2E=${plan.e2eTests}, Security=${plan.securityTests}, Accessibility=${plan.accessibilityTests}, Performance=${plan.performanceTests}
- High-risk modules: ${plan.moduleStrategy.filter((m) => m.riskLevel === 'High').map((m) => m.module).join(', ') || 'none flagged'}
- Browsers: ${plan.environmentMatrix.browsers.join(', ')}`
    : '';

  return `You are a Senior QA Engineer writing test cases that will be reviewed by a QA Lead, executed by manual testers, AND consumed by an automation engineer to script Playwright tests. The cases must be unambiguous, complete, and professional. There is ZERO tolerance for placeholders, generic phrasing, or missing fields.

═══════════════════════════════════════════════════════════════
STRUCTURED REQUIREMENTS:
═══════════════════════════════════════════════════════════════
${JSON.stringify(pr, null, 2)}
${planSummary}

CONTEXT:
${appInfo}${mobileContextNote(state.appContext)}
Source requirements: ${state.requirements.slice(0, 8000)}${state.requirements.length > 8000 ? '…' : ''}

═══════════════════════════════════════════════════════════════
OUTPUT — Return ONLY a valid JSON array (no markdown, no commentary):
═══════════════════════════════════════════════════════════════
[
  {
    "traceabilityId": "The coverage-model ids this case tests (FLD-01, BR-02), else a story key or REQ-<MODULE>-<NN>. Comma-separate several.",
    "module": "Authentication",
    "submodule": "Login",
    "feature": "User Login",
    "title": "Verify successful login with valid credentials",
    "description": "Confirms a registered user with valid email and password can authenticate via the standard login form and lands on the dashboard.",
    "precondition": "A registered user account exists with email user@example.com and password Test@1234. The login page /login is reachable.",
    "testData": {
      "email": "user@example.com",
      "password": "Test@1234"
    },
    "testSteps": [
      { "step": 1, "action": "Navigate to https://app.example.com/login", "expected": "Login form is displayed with Email and Password fields and a Sign In button" },
      { "step": 2, "action": "Enter 'user@example.com' into the Email field", "expected": "Email field shows the entered value; no validation error appears" },
      { "step": 3, "action": "Enter 'Test@1234' into the Password field", "expected": "Password field shows masked dots; no validation error appears" },
      { "step": 4, "action": "Click the 'Sign In' button", "expected": "User is redirected to /dashboard within 2 seconds and the dashboard greeting shows the user's name" }
    ],
    "expectedResult": "User is authenticated and lands on the dashboard. A session cookie is set.",
    "type": "positive",
    "priority": "P0",
    "severity": "Critical",
    "tags": ["smoke", "regression", "auth"],
    "category": "positive"
  }
]

═══════════════════════════════════════════════════════════════
COVERAGE MANDATE (NON-NEGOTIABLE):
═══════════════════════════════════════════════════════════════
${COVERAGE_INSTRUCTIONS[coverage]}
${countInstruction}
- Every field rule (FLD-xx) and business rule (BR-xx) in STRUCTURED REQUIREMENTS gets at least one case, with its id in traceabilityId.
- Ground every case in the requirements or the observed application. Never invent pages, fields, roles or protections; state assumptions in the description.
- Cover EVERY feature in parsedRequirements.features.
- For EACH feature, generate at minimum: 1 happy-path test, 1 alternate-path test, 2-4 negative tests (one per realistic failure mode), 1-2 edge case tests, 1 authorization test per relevant actor, and (where relevant) 1 accessibility and 1 security test.
- For EACH user flow in parsedRequirements.flows: at least one full end-to-end test (type: "e2e") that walks the flow start to finish.
- For EACH edge case listed: at least one dedicated test.
- For EACH non-functional requirement (security, accessibility, performance): at least one test that explicitly verifies it.
- For EVERY persona x feature pair in personaMatrix where the actor is DENIED: a negative authorization test confirming the denial is enforced.
- Do NOT merge multiple scenarios into one case. Each test verifies ONE behaviour.${gapFocus}${exclusionBlock}

═══════════════════════════════════════════════════════════════
QUALITY RULES (every case must satisfy these — incomplete cases will be rejected):
═══════════════════════════════════════════════════════════════
1. TITLE: Start with "Verify ". Be specific. "Verify login" is bad. "Verify login fails with locked account after 5 failed attempts" is good. Each title must be unique.
2. DESCRIPTION: 1-3 sentences explaining the purpose, the risk being mitigated, and why this case matters. Do not restate the title.
3. PRECONDITION: Full sentences. Include data state ("Cart contains 2 items totalling $50"), user state ("User is logged in as 'admin'"), and system state ("Stripe is in sandbox mode") where relevant.
4. TEST DATA: Use CONCRETE, REALISTIC values — "alice@example.com", "Test@1234", "ORDER-2024-0042". Never placeholders like "<email>" or "{password}". For negative tests, the invalid value must be specific (e.g., "alice@" not "invalid email").
5. TEST STEPS: Use the testSteps array. Each step:
   • Numbered, in order
   • Action in imperative present tense ("Click 'Save'", not "User should click Save")
   • References specific UI elements by visible label, role, or test-id ("the 'Submit Order' button", "the email field labelled 'Email Address'")
   • Has its OWN expected result — never blank
   • 3-12 steps total per case (most cases land at 4-7)
6. EXPECTED RESULT: A short overall summary (1-2 sentences) of the end-state. Per-step expectations live inside testSteps.
7. TYPE: positive | negative | edge | e2e | api | data | smoke | security | accessibility | performance — pick the most accurate single value.
7b. CATEGORY: positive | negative | boundary | business-rule | edge | security | accessibility — the test-design category (skill section 3). Exactly one per case.
8. PRIORITY: P0 = blocks release, P1 = important, P2 = should-have, P3 = nice-to-have. Drive priority from businessRisks: High → P0/P1, Medium → P1/P2, Low → P2/P3.
9. SEVERITY: Critical | Major | Moderate | Minor — describes the impact IF this test failed in production.
10. TAGS: Pick from {smoke, regression, sanity, auth, ui, api, security, accessibility, e2e, data-validation} — at least one tag per case.
11. TRACEABILITY: Use the FLD-xx / BR-xx ids the case tests. Otherwise use a story key or REQ-ID from the source, or one of the form REQ-<MODULE>-<NN>.

GENERATE NOW. Return the JSON array directly.`;
}

export async function generatorAgent(state: TestOpsState): Promise<TestOpsState> {
  if (!state.parsedRequirements) return state;
  counter = 0;

  const pr = state.parsedRequirements;
  const plan = state.extendedTestPlan as ExtendedTestPlan | undefined;
  const skills = selectSkills(state);
  const system = skillSystemPrompt('You are a senior test architect. Design test cases with the skills below.', skills);

  const requestedMax = state.generationOptions?.maxTestCases;
  const items = ruleItems(state);
  // One retry when the answer is not a JSON array (a prose reply or a cut-off
  // response), so a single bad answer does not fail the whole generation.
  const generate = async (gapFocus = '', exclude: string[] = []): Promise<TestCase[]> => {
    const prompt = buildPrompt(state, exclude, gapFocus);
    for (let attempt = 1; ; attempt++) {
      const response = await runClaudePrompt(prompt, { maxTokens: 16384, system });
      try {
        const parsed = parseJsonFromResponse<RawTestCase[]>(response);
        return Array.isArray(parsed) ? parsed.map(coerceTestCase) : [];
      } catch (err) {
        console.warn(`[generatorAgent] unreadable answer (attempt ${attempt}): ${response.slice(0, 200).replace(/\s+/g, ' ')}`);
        if (attempt >= 2) throw err;
      }
    }
  };
  const addNew = (base: TestCase[], extra: TestCase[]) => {
    const seen = new Set(base.map((tc) => tc.title.toLowerCase().trim()));
    return [...base, ...extra.filter((tc) => !seen.has(tc.title.toLowerCase().trim()))];
  };

  let testCases: TestCase[];
  if (items.length > RULES_PER_BATCH && !(requestedMax && requestedMax > 0)) {
    // Large coverage model: one call for journeys, then one call per batch of
    // rules, so no single response grows past the model's output or time limits.
    testCases = await generate(`\n\nTHIS PASS: happy paths per feature, end-to-end flows, and role or security cases. Field rules and business rules are covered in separate passes, so do not write boundary, invalid-input or rule cases here.`);
    if (testCases.length === 0) throw new Error('Claude returned no test cases in first pass');
    for (let i = 0; i < items.length; i += RULES_PER_BATCH) {
      const batch = items.slice(i, i + RULES_PER_BATCH);
      try {
        const extra = await generate(`\n\nTHIS PASS: write cases ONLY for these rules, applying the techniques for the coverage level, with each rule id in traceabilityId. Do not add security, accessibility, end-to-end or happy-path cases in this pass; the journeys pass covers them:\n${batch.map((b) => `- ${b.text}`).join('\n')}`, testCases.map((tc) => tc.title));
        testCases = addNew(testCases, extra);
      } catch (err) {
        console.warn(`[generatorAgent] rule batch ${i / RULES_PER_BATCH + 1} failed: ${(err as Error).message}`);
      }
    }
  } else {
    testCases = await generate();
    if (testCases.length === 0) throw new Error('Claude returned no test cases in first pass');
  }

  // Retry pass — sparse coverage. Drive the floor from the plan if we have one.
  const plannedTotal = plan
    ? plan.uiTests + plan.apiTests + plan.dataTests + plan.e2eTests + plan.securityTests + plan.accessibilityTests + plan.performanceTests
    : pr.features.length * Math.max(pr.flows.length, 3) + pr.edgeCases.length;

  let minimumExpected = Math.max(
    pr.features.length * 3,            // never accept fewer than 3 per feature
    Math.round(plannedTotal * 0.7),    // 70 % of plan, to allow LLM rounding
  );

  // When the caller asked for a specific count (the chat wizard always does),
  // treat it as the floor. Otherwise a small request like "3 cases" still drags
  // in a second full 16k-token generation pass and blows the request timeout.
  if (requestedMax && requestedMax > 0) {
    minimumExpected = Math.min(minimumExpected, requestedMax);
  }

  const room = requestedMax && requestedMax > 0 ? requestedMax - testCases.length : Infinity;
  const uncovered = items.filter((it) => !coveredIds(testCases).has(it.id));

  if (items.length > 0 && uncovered.length > 0 && room > 0) {
    // Gap fill: one extra pass for exactly the rules no case traces to.
    const gapFocus = `\n\nGAP FILL: the cases already written do not cover the rules below. Write cases ONLY for these rules, applying the techniques for the coverage level, with each rule id in traceabilityId:\n${uncovered.slice(0, RULES_PER_BATCH * 2).map((m) => `- ${m.text}`).join('\n')}`;
    try {
      testCases = addNew(testCases, await generate(gapFocus, testCases.map((tc) => tc.title)));
    } catch (err) {
      console.warn(`[generatorAgent] gap fill failed (${uncovered.length} rule(s) uncovered): ${(err as Error).message}`);
    }
  } else if (items.length === 0 && testCases.length < minimumExpected) {
    // No rules were extracted: fall back to topping up by count.
    const existingTitles = testCases.map((tc) => tc.title);
    const needed = minimumExpected - testCases.length;

    const retryPrompt = `${buildPrompt(state, existingTitles)}

You returned only ${testCases.length} test cases. With ${pr.features.length} features, ${pr.flows.length} flows, ${pr.actors.length} actors, and ${pr.edgeCases.length} edge cases, the plan calls for at least ${minimumExpected} cases. Generate the missing ${needed}+ test cases for scenarios you have NOT yet covered.`;

    try {
      const retryResponse = await runClaudePrompt(retryPrompt, { maxTokens: 16384, system });
      const retryParsed = parseJsonFromResponse<RawTestCase[]>(retryResponse);
      if (Array.isArray(retryParsed) && retryParsed.length > 0) {
        const existingSet = new Set(existingTitles.map((s) => s.toLowerCase().trim()));
        const newCases = retryParsed
          .map(coerceTestCase)
          .filter((tc) => !existingSet.has(tc.title.toLowerCase().trim()));
        testCases = [...testCases, ...newCases];
      }
    } catch {
      // Retry failed — proceed with whatever we have rather than block the pipeline
    }
  }

  if (requestedMax && requestedMax > 0) testCases = testCases.slice(0, requestedMax);

  const covered = coveredIds(testCases);
  const coverageSummary: CoverageSummary = {
    level: state.generationOptions?.coverage || 'standard',
    totalRules: items.length,
    coveredRules: items.filter((it) => covered.has(it.id)).length,
    uncovered: items.filter((it) => !covered.has(it.id)),
    skills,
  };
  return { ...state, testCases, coverageSummary };
}
