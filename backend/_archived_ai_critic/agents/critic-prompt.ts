/**
 * critic-prompt
 * ─────────────
 * The adversarial Layer-2 (semantic rubric) prompt for the AI Critic Agent.
 * Mirrors the buildHealingPrompt pattern in healing-prompt.ts so the two AI
 * prompt builders read alike.
 *
 * Harness laws honoured here:
 *   L1  The critic is framed as an INDEPENDENT, adversarial QA lead that DEFAULTS
 *       TO DISTRUST — it must hunt for what is missing/weak, never rubber-stamp.
 *       It is explicitly NOT the generator grading its own work.
 *   L3  The prompt NEVER asks the model for a verdict or an approve/reject
 *       decision. The deterministic gate (critic-gate.ts) is the sole producer of
 *       'approved'. The model only PROPOSES per-dimension scores + concrete gaps.
 *   L5  Every dimension is scored 0-100 against EXPLICIT 0/25/50/75/100 anchors
 *       (DIMENSION_ANCHORS) so scores are reproducible across runs/evaluators.
 *   L7  Every gap the model returns must carry WHAT + WHY + a CONCRETE repair
 *       scenario {feature,type,priority,title,rationale} so the regeneration step
 *       is self-correcting.
 *   L9  The scope is test-DESIGN quality only — the prompt tells the model NOT to
 *       judge runtime pass/fail (that is the execution + healing agents' job).
 */
import type { ParsedRequirements, TestCase, RubricKey } from './state.js';

/** One reproducible 0/25/50/75/100 anchor ladder for a rubric dimension (L5). */
export interface DimensionAnchor {
  /** Human label shown to the model. */
  label: string;
  /** What this dimension measures. */
  measures: string;
  /** Explicit meaning of each score band — the calibration that makes scoring reproducible. */
  ladder: { 0: string; 25: string; 50: string; 75: string; 100: string };
}

/**
 * L5 — the six code-owned rubric dimensions with explicit score anchors. The
 * WEIGHTS live in critic-gate.ts (code owns them); these anchors only calibrate
 * the 0-100 score the model proposes for each dimension. Keyed by the canonical
 * RubricKey so the dimension set can never drift from the gate.
 */
export const DIMENSION_ANCHORS: Record<RubricKey, DimensionAnchor> = {
  clarity: {
    label: 'Clarity',
    measures: 'Titles, steps and expected results are unambiguous and read top-to-bottom without re-reading the spec.',
    ladder: {
      0: 'Titles generic ("Verify login"); steps vague; a tester could not execute without guessing.',
      25: 'Many steps ambiguous or missing element references; frequent guessing required.',
      50: 'Mostly followable but several steps lack a concrete element/label or expected result.',
      75: 'Clear, specific steps referencing visible labels/roles; minor ambiguity only.',
      100: 'Every step names a specific UI element and has its own concrete expected result; zero ambiguity.',
    },
  },
  correctness: {
    label: 'Correctness',
    measures: 'Expected results actually match the requirement/acceptance criteria; no logically wrong assertions.',
    ladder: {
      0: 'Expected results contradict the requirements or are tautological ("test passes").',
      25: 'Several cases assert the wrong outcome or test an implementation detail instead of the intent.',
      50: 'Generally correct but some expected results are imprecise or weakly tied to acceptance criteria.',
      75: 'Expected results correctly reflect the intended behaviour for almost every case.',
      100: 'Every expected result is provably the correct outcome for its requirement/acceptance criterion.',
    },
  },
  atomicity: {
    label: 'Atomicity',
    measures: 'Each test verifies ONE behaviour; scenarios are not merged; failures localise cleanly.',
    ladder: {
      0: 'Cases bundle many unrelated checks; a failure cannot be attributed to one behaviour.',
      25: 'Frequent multi-behaviour cases; weak separation of positive/negative paths.',
      50: 'Mostly single-purpose but several cases test 2-3 behaviours at once.',
      75: 'Nearly all cases verify one behaviour; rare bundling.',
      100: 'Every case verifies exactly one behaviour; positive/negative/edge cleanly separated.',
    },
  },
  dataConcreteness: {
    label: 'Data Concreteness',
    measures: 'Test data is concrete and realistic (real values), never placeholders like <email> or {password}.',
    ladder: {
      0: 'Pervasive placeholders/stubs; no runnable concrete data.',
      25: 'Many placeholder or vague values ("a valid user", "<id>").',
      50: 'Mix of concrete and placeholder values; negative cases use vague invalid data.',
      75: 'Mostly concrete realistic values; a few non-specific entries.',
      100: 'Every value is concrete and realistic; invalid/negative values are specific (e.g. "alice@" not "bad email").',
    },
  },
  coverageDepth: {
    label: 'Coverage Depth',
    measures: 'Per feature: happy + alternate + negatives + edges + authz; flows have e2e; NFRs have tests. Breadth is gated deterministically — here judge the DEPTH and quality of the coverage that exists.',
    ladder: {
      0: 'Only happy paths; no negative/edge/authz/NFR depth at all.',
      25: 'Sparse: one or two negatives total; little edge/authz/NFR depth.',
      50: 'Reasonable happy+negative depth but thin on edges, authorization, and NFRs.',
      75: 'Good depth across positive/negative/edge with some authz + NFR coverage.',
      100: 'Rich depth per feature: happy + alternate + multiple realistic negatives + edges + authz + NFR where relevant.',
    },
  },
  nonAmbiguity: {
    label: 'Non-Ambiguity',
    measures: 'Preconditions and expected results are objectively verifiable — no "system is stable", no subjective pass criteria.',
    ladder: {
      0: 'Expected results subjective/unverifiable across the suite.',
      25: 'Many vague pass criteria ("works correctly", "looks fine").',
      50: 'Some objectively-verifiable results, but several remain subjective.',
      75: 'Almost all expected results are objectively checkable.',
      100: 'Every expected result is objectively verifiable (specific URL/text/state), every precondition explicit.',
    },
  },
};

/** Input bundle for the critic prompt. `anchors` is always DIMENSION_ANCHORS. */
export interface CriticPromptInput {
  parsedRequirements: ParsedRequirements;
  testCases: TestCase[];
  anchors: typeof DIMENSION_ANCHORS;
}

/**
 * The strict JSON shape Claude must return. NOTE: there is deliberately NO
 * verdict / approved field — the deterministic gate (critic-gate.ts) owns the
 * verdict (L3). The model only proposes per-dimension scores and concrete,
 * repair-carrying gaps.
 */
export interface CriticSemanticResponse {
  /** One entry per rubric dimension the model scored (0-100 against the anchors). */
  dimensions: {
    key: RubricKey;
    score: number;
    /** One line of evidence the model must cite for the score. */
    justification: string;
    /** Concrete TestCase ids that drag this dimension down (may be empty). */
    weakestTestIds: string[];
  }[];
  /** The model's own overall — recorded for divergence audit, NEVER trusted (L5). */
  modelClaimedOverall?: number;
  /** Concrete, repair-carrying design gaps the model found (L7). */
  gaps: {
    severity: 'blocker' | 'major' | 'minor';
    /** Which area the weakness sits in (free-form, e.g. a feature or rubric dimension). */
    sourceArea?: string;
    what: string;
    why: string;
    /** The EXACT test scenario to add to close this gap — feeds regeneration. */
    repair: {
      feature: string;
      type: TestCase['type'];
      priority: TestCase['priority'];
      /** One-line "Verify ..." title. */
      title: string;
      rationale: string;
    };
  }[];
}

/** Compact, token-bounded view of one test case for the reviewer. */
function summariseCase(tc: TestCase, idx: number): string {
  const steps = Array.isArray(tc.testSteps) && tc.testSteps.length > 0
    ? tc.testSteps.map((s) => `${s.step}. ${s.action} → ${s.expected}`).join(' | ')
    : (Array.isArray(tc.steps) ? tc.steps.join(' | ') : '');
  const data = tc.testData && typeof tc.testData === 'object'
    ? Object.entries(tc.testData).map(([k, v]) => `${k}=${v}`).join(', ')
    : '';
  return [
    `#${idx + 1} [${tc.id}] (${tc.type}/${tc.priority}) feature="${tc.feature}"`,
    `   title: ${tc.title}`,
    tc.precondition ? `   precondition: ${truncate(tc.precondition, 200)}` : '',
    steps ? `   steps: ${truncate(steps, 400)}` : '   steps: (none)',
    data ? `   data: ${truncate(data, 200)}` : '',
    `   expected: ${truncate(tc.expectedResult || '(none)', 200)}`,
  ].filter(Boolean).join('\n');
}

function truncate(v: string, max: number): string {
  return v.length > max ? `${v.slice(0, max)}…` : v;
}

function anchorsBlock(anchors: typeof DIMENSION_ANCHORS): string {
  return (Object.keys(anchors) as RubricKey[]).map((key) => {
    const a = anchors[key];
    return `• ${key} — ${a.label}: ${a.measures}
    0=${a.ladder[0]}
    25=${a.ladder[25]}
    50=${a.ladder[50]}
    75=${a.ladder[75]}
    100=${a.ladder[100]}`;
  }).join('\n');
}

/**
 * Build the adversarial semantic-rubric prompt. The model scores the GENERATED
 * test cases against the calibrated rubric and proposes concrete gaps — it does
 * NOT decide pass/fail (the gate does) and does NOT judge runtime behaviour.
 */
export function buildCriticPrompt(input: CriticPromptInput): string {
  const { parsedRequirements: pr, testCases, anchors } = input;

  const reqSummary = {
    features: pr.features,
    flows: pr.flows,
    edgeCases: pr.edgeCases,
    actors: pr.actors,
    dataRules: pr.dataRules,
    acceptanceCriteria: pr.acceptanceCriteria,
    nonFunctionalRequirements: pr.nonFunctionalRequirements,
    personaMatrix: pr.personaMatrix,
    businessRisks: pr.businessRisks,
  };

  const casesBlock = testCases.length > 0
    ? testCases.map(summariseCase).join('\n')
    : '(no test cases were generated)';

  const dimensionKeys = (Object.keys(anchors) as RubricKey[]).join(', ');

  return `You are a Principal QA Lead performing an ADVERSARIAL design review of a set of AI-generated test cases. Your job is to find what is WEAK, AMBIGUOUS, or MISSING — assume the author was sloppy and prove it. You did NOT write these tests and you owe them no benefit of the doubt. Be a hostile reviewer, not a cheerleader.

SCOPE (read carefully): You are judging the QUALITY OF THE TEST DESIGN only — clarity, correctness, atomicity, data concreteness, depth, and non-ambiguity of the SPECIFICATIONS. You are NOT executing anything and you must NOT judge whether the automation will pass at runtime, whether selectors are valid against the live app, or whether the application has bugs — that is verified separately. Do NOT reward or penalise based on guessed runtime behaviour.

You do NOT decide a pass/fail verdict. A separate deterministic gate computes that from your scores plus objective structural and coverage checks. Your ONLY job is to (a) score each rubric dimension 0-100 against the explicit anchors below, and (b) list concrete, repairable design gaps. Do not output a verdict, an "approved" field, or an overall recommendation.

═══════════════════════════════════════════════════════════
REQUIREMENTS (the source of truth the tests must satisfy)
═══════════════════════════════════════════════════════════
${JSON.stringify(reqSummary, null, 2)}

═══════════════════════════════════════════════════════════
GENERATED TEST CASES UNDER REVIEW (${testCases.length})
═══════════════════════════════════════════════════════════
${casesBlock}

═══════════════════════════════════════════════════════════
RUBRIC — score EACH dimension 0-100 against THESE anchors (be calibrated; cite evidence)
═══════════════════════════════════════════════════════════
${anchorsBlock(anchors)}

SCORING RULES:
- Score strictly against the anchors. Do not inflate. If you cannot cite a specific weakness for a high score, the score is too high.
- For every dimension, name the weakest test case ids (weakestTestIds) that justify a score below 100. If the dimension is genuinely strong, return an empty array.
- modelClaimedOverall is your own holistic 0-100 impression — it is recorded for audit but is NOT used to decide the verdict, so do not game it.

GAPS (this is what drives improvement — be concrete):
- List every meaningful design gap: a missing negative/edge/authz/NFR scenario, an ambiguous or incorrect expected result, a merged (non-atomic) case, or placeholder data.
- Each gap MUST carry a concrete repair: the exact NEW or CORRECTED test to add, with feature, type (one of: positive, negative, edge, e2e, api, data, smoke, security, accessibility, performance), priority (P0|P1|P2|P3), a one-line "Verify ..." title, and a one-line rationale.
- Severity: blocker = a required scenario is absent or an expected result is wrong; major = meaningful weakness; minor = polish.
- Prefer gaps that close real requirement coverage (a missing flow e2e, a denied-persona authz test, an untested NFR) — those matter most.

═══════════════════════════════════════════════════════════
OUTPUT — return ONLY this JSON object (no markdown fence, no commentary):
═══════════════════════════════════════════════════════════
{
  "dimensions": [
    { "key": "<one of: ${dimensionKeys}>", "score": <0-100>, "justification": "<one line citing evidence>", "weakestTestIds": ["TC-0xx", ...] }
    // exactly one entry per dimension listed above
  ],
  "modelClaimedOverall": <0-100>,
  "gaps": [
    {
      "severity": "blocker|major|minor",
      "sourceArea": "<feature name or rubric dimension>",
      "what": "<what is missing or wrong>",
      "why": "<why it matters / the risk>",
      "repair": {
        "feature": "<feature>",
        "type": "negative",
        "priority": "P1",
        "title": "Verify <specific scenario to add>",
        "rationale": "<one line>"
      }
    }
  ]
}

Return the JSON object directly.`;
}
