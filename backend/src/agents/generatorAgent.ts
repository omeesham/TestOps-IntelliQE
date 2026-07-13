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
import type { TestOpsState, TestCase, TestStep } from './state.js';
import { runLLM, parseJsonFromResponse, llmForStage } from './claude-runner.js';
import type { ExtendedTestPlan } from './plannerAgent.js';

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
    status: 'generated',
  };
}

function buildPrompt(state: TestOpsState, excludeTitles: string[] = []): string {
  const pr = state.parsedRequirements!;
  const plan = state.extendedTestPlan as ExtendedTestPlan | undefined;
  const appInfo = state.appContext
    ? `Application: ${state.appContext.appName || 'Web App'}\nURL: ${state.appContext.targetUrl || 'Not specified'}\nEnvironment: ${state.appContext.environment || 'staging'}`
    : '';

  // Count is driven by RELEVANCE, not exhaustiveness. No fixed target, but no
  // padding either: a simple page yields a small, focused suite.
  const countInstruction =
    `- The number of test cases is driven by what the functionality GENUINELY warrants — there is no target count and no minimum. A simple login page is a handful of cases (~6–12), not dozens. Do NOT pad to look thorough; a smaller, sharply relevant suite is better than a long one full of marginal scenarios. Any counts in the TEST PLAN are rough estimates, NOT quotas to fill.`;

  const exclusionBlock = excludeTitles.length > 0
    ? `\n\nALREADY GENERATED — DO NOT REPEAT THESE TITLES (case-insensitive):\n${excludeTitles.map((s) => `- ${s}`).join('\n')}\nGenerate only NEW scenarios not in the above list.`
    : '';

  // Plan summary — strategy + risk context only. Counts are deliberately framed
  // as non-binding estimates so they never cap the functionality-driven output.
  const planSummary = plan
    ? `\n\nTEST PLAN (strategy & risk context — counts are rough estimates, NOT limits):
- Strategy: ${plan.testStrategy}
- Estimated effort (non-binding): UI≈${plan.uiTests}, API≈${plan.apiTests}, Data≈${plan.dataTests}, E2E≈${plan.e2eTests}, Security≈${plan.securityTests}, Accessibility≈${plan.accessibilityTests}, Performance≈${plan.performanceTests}
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
${appInfo}
Source requirements: ${state.requirements.slice(0, 1500)}${state.requirements.length > 1500 ? '…' : ''}

═══════════════════════════════════════════════════════════════
OUTPUT — Return ONLY a valid JSON array (no markdown, no commentary):
═══════════════════════════════════════════════════════════════
[
  {
    "traceabilityId": "REQ-LOGIN-01 or story key — the requirement this test covers",
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
    "tags": ["smoke", "regression", "auth"]
  }
]

═══════════════════════════════════════════════════════════════
SCOPE & RELEVANCE (generate ONLY what the functionality genuinely warrants):
═══════════════════════════════════════════════════════════════
${countInstruction}
- Test ONLY behaviors that are described in the requirements or actually present in the application. Do NOT invent scenarios for features, fields, or protections that aren't there.
- NO speculative security cases (XSS, SQL injection, brute-force, rate-limiting, CSRF) and NO cross-browser, responsive, performance, or accessibility cases UNLESS parsedRequirements explicitly lists that as a requirement. If it isn't an explicit requirement, skip it entirely — do not add it "to be safe".
- For EACH real feature: ONE happy-path test, plus ONE test per DISTINCT validation/failure rule that actually exists. MERGE near-duplicates — write a single representative case per rule (e.g. one "login fails with wrong password", NOT separate cases for wrong-password variant A, B, C). Combining a couple of closely-related checks into one case is encouraged, not penalized.
- Add an end-to-end (type "e2e") test ONLY for genuine multi-step journeys. A single login form is NOT an e2e flow — do not create one for it.
- Authorization/RBAC tests ONLY when multiple roles with genuinely different access are defined for the feature. For a single-actor page, skip them.
- Skip edge cases that don't apply to the real fields/behaviors (no concurrency, network-failure, or partial-write cases unless the feature actually involves them).
- Prefer P0/P1 coverage of core behavior over a long tail of P3 trivia. If a case feels marginal or speculative, leave it out.${exclusionBlock}

═══════════════════════════════════════════════════════════════
QUALITY RULES (every case must satisfy these — incomplete cases will be rejected):
═══════════════════════════════════════════════════════════════
1. TITLE: Start with "Verify ". Be specific. "Verify login" is bad. "Verify login fails with locked account after 5 failed attempts" is good. Each title must be unique.
2. DESCRIPTION: 1-3 sentences explaining the purpose, the risk being mitigated, and why this case matters. Do not restate the title.
3. PRECONDITION: Full sentences. Include data state ("Cart contains 2 items totalling $50"), user state ("User is logged in as 'admin'"), and system state ("Stripe is in sandbox mode") where relevant.
4. TEST DATA: Use CONCRETE, REALISTIC values — "alice@example.com", "Test@1234", "ORDER-2024-0042". Never placeholders like "<email>" or "{password}". For negative tests, the invalid value must be specific (e.g., "alice@" not "invalid email"). For very long / boundary values, write a SHORT plain-string DESCRIPTION of the value (e.g. "a 10000-character string of 'a'") — do NOT inline the full literal.
5. TEST STEPS: Use the testSteps array. Each step:
   • Numbered, in order
   • Action in imperative present tense ("Click 'Save'", not "User should click Save")
   • References specific UI elements by visible label, role, or test-id ("the 'Submit Order' button", "the email field labelled 'Email Address'")
   • Has its OWN expected result — never blank
   • 3-12 steps total per case (most cases land at 4-7)
6. EXPECTED RESULT: A short overall summary (1-2 sentences) of the end-state. Per-step expectations live inside testSteps.
7. TYPE: positive | negative | edge | e2e | api | data | smoke | security | accessibility | performance — pick the most accurate single value.
8. PRIORITY: P0 = blocks release, P1 = important, P2 = should-have, P3 = nice-to-have. Drive priority from businessRisks: High → P0/P1, Medium → P1/P2, Low → P2/P3.
9. SEVERITY: Critical | Major | Moderate | Minor — describes the impact IF this test failed in production.
10. TAGS: Pick from {smoke, regression, sanity, auth, ui, api, security, accessibility, e2e, data-validation} — at least one tag per case.
11. TRACEABILITY: If a story key or REQ-ID is present in the source, use it. Otherwise fabricate one of the form REQ-<MODULE>-<NN>.
12. STRICT JSON: Output MUST be valid JSON. Every value is a literal string, number, boolean, array, or object. NEVER use code expressions (no "a" * 10000, no "x".repeat(n), no string concatenation with +, no comments, no trailing commas). Escape quotes inside strings.

GENERATE NOW. Return the JSON array directly.`;
}

export async function generatorAgent(state: TestOpsState): Promise<TestOpsState> {
  if (!state.parsedRequirements) return state;
  counter = 0;

  // SINGLE pass — no retry, no top-up. The model decides how many cases the
  // functionality needs (see the coverage mandate in buildPrompt). We give it
  // the model's full output window so a comprehensive set is never truncated.
  const response = await runLLM(buildPrompt(state), { maxTokens: 64000, llm: llmForStage(state.llm, 'generator') });
  const parsed = parseJsonFromResponse<RawTestCase[]>(response);

  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error('Claude returned no test cases');
  }

  const testCases = parsed.map(coerceTestCase);
  return { ...state, testCases };
}
