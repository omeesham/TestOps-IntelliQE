/**
 * plannerAgent
 * ────────────
 * Turns the ParsedRequirements into a test-strategy document. The
 * generator agent reads this strategy and uses it to decide:
 *   • How many tests of each type to create
 *   • How to weight effort across modules (risk-based)
 *   • What environment / browser coverage to demand
 *   • What test scope each persona × module pair gets
 *
 * The output deliberately mirrors a real-world test plan you would
 * hand to a team lead — not just numeric counts.
 */
import type { TestOpsState } from './state.js';
import { runClaudePrompt, parseJsonFromResponse } from './claude-runner.js';

export interface ExtendedTestPlan {
  /** Headline counts — used by the generator as soft targets */
  uiTests: number;
  apiTests: number;
  dataTests: number;
  e2eTests: number;
  securityTests: number;
  accessibilityTests: number;
  performanceTests: number;

  /** Default priority for tests that don't carry their own */
  priority: 'P0' | 'P1' | 'P2' | 'P3';

  /** Feature names with the deepest expected coverage */
  coverageAreas: string[];

  /** One-paragraph narrative strategy: what we are testing and why */
  testStrategy: string;

  /** Per-module breakdown: count + risk level + types */
  moduleStrategy: {
    module: string;
    submodule?: string;
    riskLevel: 'High' | 'Medium' | 'Low';
    estimatedTestCount: number;
    testTypes: string[];   // e.g., ['positive','negative','edge','security']
    notes?: string;
  }[];

  /** Test environments: browsers, devices, network conditions */
  environmentMatrix: {
    browsers: string[];
    devices: string[];
    networkProfiles?: string[];   // 'slow-3g', 'offline', etc.
  };

  /** Entry / exit / suspension criteria — basic IEEE-829 fields */
  entryCriteria: string[];
  exitCriteria: string[];
  suspensionCriteria?: string[];

  /** Out-of-scope items the team explicitly chose not to test */
  outOfScope?: string[];
}

export async function plannerAgent(state: TestOpsState): Promise<TestOpsState> {
  if (!state.parsedRequirements) return state;

  const pr = state.parsedRequirements;
  const appInfo = state.appContext
    ? `Application: ${state.appContext.appName || 'Web App'}, URL: ${state.appContext.targetUrl || 'N/A'}, Env: ${state.appContext.environment || 'staging'}`
    : '';

  const prompt = `You are a Senior Test Architect. Read the structured requirements below and produce a risk-based test plan. The plan must be specific, measurable, and traceable — not a generic template.

STRUCTURED REQUIREMENTS:
${JSON.stringify(pr, null, 2)}

CONTEXT:
${appInfo}
Raw requirements summary: ${state.requirements.slice(0, 1500)}${state.requirements.length > 1500 ? '…' : ''}

Return ONLY valid JSON (no markdown, no commentary):

{
  "uiTests": <int — number of UI/functional tests>,
  "apiTests": <int — number of API tests, 0 if no API surface known>,
  "dataTests": <int — data validation tests>,
  "e2eTests": <int — multi-step end-to-end tests>,
  "securityTests": <int — authn/authz, input validation, CSRF/XSS, etc.>,
  "accessibilityTests": <int — WCAG checks, keyboard nav, screen readers>,
  "performanceTests": <int — only if perf NFRs were stated>,
  "priority": "P0|P1|P2|P3",
  "coverageAreas": ["high-priority module 1", "high-priority module 2"],
  "testStrategy": "1-2 paragraph narrative: scope, approach, risk focus, what 'done' looks like",
  "moduleStrategy": [
    {
      "module": "Checkout",
      "submodule": "Payment",
      "riskLevel": "High",
      "estimatedTestCount": 18,
      "testTypes": ["positive", "negative", "edge", "security", "e2e"],
      "notes": "Revenue-critical; cover all payment gateways and error paths"
    }
  ],
  "environmentMatrix": {
    "browsers": ["Chrome 120+", "Edge 120+", "Safari 17+", "Firefox 120+"],
    "devices": ["Desktop 1920x1080", "Tablet 768x1024", "Mobile 375x667"],
    "networkProfiles": ["fast-3g (optional)"]
  },
  "entryCriteria": [
    "Build deployed to staging",
    "Test data seeded",
    "Credentials available for each role"
  ],
  "exitCriteria": [
    "100% of P0 cases pass",
    "≥ 95% of P1 cases pass",
    "Zero open Critical or Major defects"
  ],
  "suspensionCriteria": [
    "Smoke suite fails",
    "Authentication broken"
  ],
  "outOfScope": ["Load testing beyond 100 concurrent users (out of scope for MVP)"]
}

RULES:
1. Counts must be derived from REAL coverage need (features × flows × edge cases × actors). A trivial app may need 20 tests; a complex one may need 200.
2. moduleStrategy must include EVERY module from parsedRequirements.modules. Each entry must specify a risk level — drive it from businessRisks if provided, otherwise infer.
3. environmentMatrix.browsers and devices must reflect any compatibility NFRs given; otherwise default to the four major modern browsers and three standard form factors.
4. testStrategy must mention: the riskiest module, the testing approach (manual vs automated split), and what is excluded.
5. If non-functional requirements were captured (perf, security, a11y), allocate non-zero counts to those categories.
6. entryCriteria and exitCriteria must be objectively verifiable — no vague language ("system is stable" is not acceptable).
7. Do NOT pad numbers. Do NOT under-count either. Use the parsed features × flows × actors × edge cases as the math base.`;

  let parsed: Partial<ExtendedTestPlan>;
  try {
    const response = await runClaudePrompt(prompt, { maxTokens: 4000 });
    parsed = parseJsonFromResponse<ExtendedTestPlan>(response);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[plannerAgent] Claude planning failed, using heuristic plan:', (err as Error).message);
    parsed = {};
  }

  // Heuristic defaults — used when Claude is silent on a field.
  const featureCount = pr.features.length;
  const flowCount = Math.max(1, pr.flows.length);
  const actorCount = Math.max(1, pr.actors.length);
  const edgeCount = pr.edgeCases.length;

  const baseUi = featureCount * flowCount + edgeCount;

  const plan: ExtendedTestPlan = {
    uiTests: parsed.uiTests ?? baseUi,
    apiTests: parsed.apiTests ?? Math.max(2, Math.round(baseUi * 0.3)),
    dataTests: parsed.dataTests ?? Math.max(2, pr.dataRules.length),
    e2eTests: parsed.e2eTests ?? Math.max(2, flowCount),
    securityTests: parsed.securityTests ?? Math.max(2, actorCount * 2),
    accessibilityTests: parsed.accessibilityTests ?? Math.max(2, featureCount),
    performanceTests: parsed.performanceTests ?? 0,
    priority: (parsed.priority as ExtendedTestPlan['priority']) || 'P1',
    coverageAreas: parsed.coverageAreas?.length ? parsed.coverageAreas : pr.features,
    testStrategy:
      parsed.testStrategy ||
      `Risk-based testing across ${featureCount} feature(s) and ${actorCount} actor(s). Focus on revenue-critical and security-sensitive flows first; automate regression paths; reserve manual effort for exploratory and accessibility testing.`,
    moduleStrategy:
      parsed.moduleStrategy?.length
        ? parsed.moduleStrategy
        : (pr.modules || []).map((m) => ({
            module: m.module,
            submodule: m.submodule,
            riskLevel: 'Medium' as const,
            estimatedTestCount: Math.max(5, m.features.length * 3),
            testTypes: ['positive', 'negative', 'edge'],
          })),
    environmentMatrix: parsed.environmentMatrix || {
      browsers: ['Chrome 120+', 'Edge 120+', 'Safari 17+', 'Firefox 120+'],
      devices: ['Desktop 1920x1080', 'Tablet 768x1024', 'Mobile 375x667'],
    },
    entryCriteria: parsed.entryCriteria?.length
      ? parsed.entryCriteria
      : ['Application deployed to test environment', 'Test data available', 'Credentials provided for each role'],
    exitCriteria: parsed.exitCriteria?.length
      ? parsed.exitCriteria
      : ['100% of P0 test cases executed and passed', '≥ 95% of P1 cases pass', 'No open Critical or Major defects'],
    suspensionCriteria: parsed.suspensionCriteria,
    outOfScope: parsed.outOfScope,
  };

  // Surface the legacy shape so older consumers (existing UI, reports, etc.) keep working.
  return {
    ...state,
    testPlan: {
      uiTests: plan.uiTests,
      apiTests: plan.apiTests,
      dataTests: plan.dataTests,
      priority: plan.priority,
      coverageAreas: plan.coverageAreas,
    },
    extendedTestPlan: plan,
  };
}
