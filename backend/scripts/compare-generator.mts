/**
 * compare-generator.mts — REAL head-to-head of the test-case generator prompt.
 *
 * Same parsed requirements, same plan, same model. The ONLY difference is the
 * prompt: DEFAULT (the original generator prompt) vs STANDARD (the original
 * prompt + the Test-Case Authoring Standard injected). Prints both result sets
 * and an objective scorecard.
 *
 * Run from backend/:  npx tsx scripts/compare-generator.mts
 */
import { runClaudePrompt, parseJsonFromResponse } from '../src/agents/claude-runner.js';
import { TEST_CASE_STANDARD } from '../src/agents/testCaseStandard.js';

// ── Fixed, realistic input (Product Group Maintenance) ───────────────────────
const pr = {
  features: ['Create Product Group', 'Edit Product Group', 'Delete Product Group', 'Product Group Validation'],
  modules: [
    { module: 'Product Groups', submodule: 'Edit Product Group', features: ['Edit Product Group', 'Product Group Validation'] },
    { module: 'Product Groups', submodule: 'Create Product Group', features: ['Create Product Group'] },
    { module: 'Product Groups', submodule: 'Delete Product Group', features: ['Delete Product Group'] },
  ],
  actors: ['Admin', 'Standard User (read-only)'],
  flows: ['Admin edits an existing product group Name, Description and Service Type, then saves and verifies persistence'],
  edgeCases: ['Save with empty required Name', 'Duplicate product group name', 'Server returns HTTP 500 on save', 'Concurrent edit conflict'],
  dataRules: ['Name is required, max 100 characters', 'Service Type must be one of the allowed list'],
  acceptanceCriteria: ['Given a user with edit permission, when they change the Name and click Save, the change persists after reload'],
  nonFunctionalRequirements: { security: ['Read-only users must not be able to edit or delete a product group'], accessibility: ['The edit form is fully keyboard navigable'] },
  businessRisks: [{ feature: 'Edit Product Group', risk: 'High', rationale: 'Drives downstream catalog and pricing configuration' }],
  personaMatrix: [{ actor: 'Standard User (read-only)', allowedFeatures: [], deniedFeatures: ['Edit Product Group', 'Delete Product Group'] }],
};

const plan = {
  testStrategy: 'Risk-based coverage of Product Group maintenance; prioritise Edit (high business risk) and authorization.',
  uiTests: 6, apiTests: 1, dataTests: 1, e2eTests: 1, securityTests: 1, accessibilityTests: 1, performanceTests: 0,
  moduleStrategy: [{ module: 'Product Groups', riskLevel: 'High' }],
  environmentMatrix: { browsers: ['Chrome 120+', 'Edge 120+'] },
};

const appInfo = 'Application: Catalog Admin\nURL: https://catalog.example.com\nEnvironment: staging';
// Keep both sides small + comparable so the diff is easy to eyeball.
const countInstruction = '- The user asked for approximately 6 test cases — treat this as a HINT. Generate a few more if coverage demands.';

const exampleJson = `[
  {
    "traceabilityId": "REQ-LOGIN-01 or story key",
    "module": "Authentication",
    "submodule": "Login",
    "feature": "User Login",
    "title": "Verify successful login with valid credentials",
    "description": "Confirms a registered user can authenticate and reach the dashboard.",
    "precondition": "A registered user account exists with email user@example.com and password Test@1234.",
    "testData": { "email": "user@example.com", "password": "Test@1234" },
    "testSteps": [
      { "step": 1, "action": "Navigate to /login", "expected": "Login form is displayed with Email, Password and Sign In" },
      { "step": 2, "action": "Enter 'user@example.com' in Email", "expected": "Email field shows the value; no error" },
      { "step": 3, "action": "Click 'Sign In'", "expected": "User is redirected to /dashboard within 2 seconds" }
    ],
    "expectedResult": "User is authenticated and lands on the dashboard.",
    "type": "positive", "priority": "P0", "severity": "Critical", "tags": ["smoke", "auth"]
  }
]`;

const intro = `You are a Senior QA Engineer writing test cases reviewed by a QA Lead, executed by manual testers, and consumed by an automation engineer. The cases must be unambiguous, complete, and professional.`;

const reqBlock = `STRUCTURED REQUIREMENTS:
${JSON.stringify(pr, null, 2)}

TEST PLAN:
- Strategy: ${plan.testStrategy}
- Counts: UI=${plan.uiTests}, API=${plan.apiTests}, Data=${plan.dataTests}, E2E=${plan.e2eTests}, Security=${plan.securityTests}, Accessibility=${plan.accessibilityTests}

CONTEXT:
${appInfo}`;

// ── DEFAULT prompt (original generator) ──────────────────────────────────────
function defaultPrompt(): string {
  return `${intro}

${reqBlock}

OUTPUT — Return ONLY a valid JSON array (no markdown):
${exampleJson}

COVERAGE MANDATE:
${countInstruction}
- Cover EVERY feature. Per feature: 1 happy-path, 1 alternate, 2-4 negative, 1-2 edge, 1 authorization per relevant actor.
- Each test verifies ONE behaviour.

QUALITY RULES:
1. TITLE: Start with "Verify ". Be specific. Each title unique.
2. DESCRIPTION: 1-3 sentences explaining purpose and risk.
3. PRECONDITION: Full sentences with data/user/system state.
4. TEST DATA: Concrete realistic values, never placeholders.
5. TEST STEPS: testSteps array; each step numbered, imperative, with its own expected result.
6. EXPECTED RESULT: 1-2 sentence end-state summary.
7. TYPE / 8. PRIORITY (P0-P3) / 9. SEVERITY / 10. TAGS / 11. TRACEABILITY.

GENERATE NOW. Return the JSON array directly.`;
}

// ── STANDARD prompt (original + authoring standard injected) ─────────────────
function standardPrompt(): string {
  return `${intro} You MUST follow the Test-Case Authoring Standard below to the letter.

${TEST_CASE_STANDARD}

${reqBlock}

OUTPUT — Return ONLY a valid JSON array (no markdown). Apply the standard above:
- module AND submodule on EVERY case (consistent names).
- description = ONE-LINE business-intent Title Description.
- testData values tagged "(created by Planner)" / "(simulated)" where applicable; "None" if no data.
- every testStep has its own observable, definite expected result.
${exampleJson}

COVERAGE MANDATE:
${countInstruction}
- Per flow: at least one happy path, one negative/validation path, and relevant boundary/edge cases INCLUDING an API-failure simulation (e.g. forced HTTP 500).
- For every DENIED persona×feature pair: a negative authorization test.
- Each test verifies ONE behaviour.

PRIORITY maps to P0=Critical, P1=High, P2=Medium, P3=Low. Drive it from businessRisks.

GENERATE NOW. Return the JSON array directly.`;
}

// ── Scorecard ────────────────────────────────────────────────────────────────
function pct(n: number, d: number): string {
  return d === 0 ? '—' : `${Math.round((n / d) * 100)}%`;
}

function score(label: string, cases: any[]): Record<string, string> {
  const n = cases.length;
  let withModSub = 0, oneLineDesc = 0, taggedData = 0, definiteExp = 0;
  let totalSteps = 0, stepsWithExp = 0, goodTitle = 0;
  const hedges = /\b(should probably|may |might |maybe|seems|appears to)\b/i;
  for (const c of cases) {
    if ((c.module || '').trim() && (c.submodule || '').trim()) withModSub++;
    const d = (c.description || '').trim();
    if (d && d.split(/[.!?]\s/).filter(Boolean).length <= 1 && d.length <= 200) oneLineDesc++;
    const dataVals = Object.values(c.testData || {}).join(' ');
    if (/\(created by Planner\)|\(simulated\)|^None$/i.test(dataVals) || /none/i.test(dataVals)) taggedData++;
    const steps = Array.isArray(c.testSteps) ? c.testSteps : [];
    totalSteps += steps.length;
    let caseDefinite = steps.length > 0;
    for (const s of steps) {
      if ((s.expected || '').trim()) stepsWithExp++;
      if (hedges.test(s.expected || '')) caseDefinite = false;
    }
    if (caseDefinite) definiteExp++;
    const t = (c.title || '').trim();
    if (t && t.length <= 80 && !/^tc[_-]?\d/i.test(t)) goodTitle++;
  }
  return {
    label,
    cases: String(n),
    'module+submodule': pct(withModSub, n),
    'one-line desc': pct(oneLineDesc, n),
    'tagged test data': pct(taggedData, n),
    'steps w/ expected': pct(stepsWithExp, totalSteps),
    'definite wording': pct(definiteExp, n),
    'clean title': pct(goodTitle, n),
  };
}

function show(label: string, cases: any[]) {
  console.log(`\n${'═'.repeat(70)}\n${label} — ${cases.length} cases\n${'═'.repeat(70)}`);
  for (const c of cases.slice(0, 3)) {
    console.log(`\n• [${c.module || '—'} > ${c.submodule || '—'}] ${c.title}`);
    console.log(`  desc: ${c.description || '(none)'}`);
    console.log(`  priority: ${c.priority}  type: ${c.type}  traceability: ${c.traceabilityId || '—'}`);
    console.log(`  testData: ${JSON.stringify(c.testData || {})}`);
    const steps = Array.isArray(c.testSteps) ? c.testSteps : [];
    steps.slice(0, 3).forEach((s: any) => console.log(`    ${s.step}. ${s.action}  →  ${s.expected}`));
    if (steps.length > 3) console.log(`    … (${steps.length} steps total)`);
  }
  if (cases.length > 3) console.log(`\n  … (${cases.length - 3} more cases)`);
}

async function main() {
  console.log('Running DEFAULT prompt (this calls the model, ~30-90s)…');
  const defRaw = runClaudePrompt(defaultPrompt(), { maxTokens: 16384 });
  const defCases = parseJsonFromResponse<any[]>(defRaw);

  console.log('Running STANDARD prompt (~30-90s)…');
  const stdRaw = runClaudePrompt(standardPrompt(), { maxTokens: 16384 });
  const stdCases = parseJsonFromResponse<any[]>(stdRaw);

  show('DEFAULT (current agent)', defCases);
  show('STANDARD (with instruction file)', stdCases);

  console.log(`\n${'═'.repeat(70)}\nSCORECARD\n${'═'.repeat(70)}`);
  console.table([score('DEFAULT', defCases), score('STANDARD', stdCases)]);
}

main().catch((e) => { console.error('Comparison failed:', e); process.exit(1); });
