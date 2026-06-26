/**
 * critic-gate
 * ───────────
 * THE DETERMINISTIC TRUST ANCHOR of the AI Critic Agent. PURE + SYNCHRONOUS:
 * NO AI calls, NO network, NO I/O, NO Date/random. Same inputs → identical
 * outputs (L11 idempotent). This file — never the model — DECIDES THE VERDICT.
 *
 * SCOPE (L9): This module certifies test-DESIGN correctness and requirement
 * COVERAGE through STATIC analysis only. It scores clarity, correctness,
 * atomicity, data concreteness, coverage depth and non-ambiguity of the
 * generated test cases, and confirms that every feature, flow, edge case,
 * denied-persona authorization, and stated non-functional requirement has at
 * least one corresponding test, then gates on a deterministic Definition of
 * Done. It does NOT execute any test and therefore does NOT prove runtime
 * pass/fail, selector validity against the live application, or end-to-end
 * behaviour. Runtime correctness remains the responsibility of the execution
 * agent (real Playwright run) and the healing agent (post-failure repair). An
 * 'approved' design verdict means the test SPECIFICATIONS are complete,
 * unambiguous, concrete and fully cover the requirements — it is NOT a guarantee
 * that the generated automation will pass when executed, nor that the
 * application is bug-free. Together, this static design-gate and the runtime e2e
 * + healing loop form the closed quality loop; neither alone is sufficient and
 * this report MUST NOT be read as a runtime guarantee.
 *
 * Harness laws honoured here:
 *   L2  Definition of Done EXTERNALISED as exported constants resolved from env.
 *   L3  PASS-STATE GATING — runGate/evaluateDefinitionOfDone is the SOLE producer
 *       of 'approved'. The model proposes scores; the gate computes the verdict.
 *   L4  Layer1 (checkStructuralValidity) + Layer3 (computeCoverage) are pure/no-AI;
 *       both, plus the AI Layer2 score, are consumed by the gate.
 *   L5  recomputeWeightedScore RECOMPUTES the weighted overall in code — the
 *       model's arithmetic / claimed overall is never trusted.
 *   L6  computeCoverage builds the feature-list state machine; the gate BLOCKS
 *       'approved' while verifiedCoverageRatio < the configured target (VCR<1.0).
 *   L11 Pure functions, no mutation of inputs → reproducible verdict.
 *
 * NOTE ON THE CANONICAL TYPE GRAPH (state.ts): state.ts is the single source of
 * truth for the CriticReport type graph (CriticVerdict='approved'|'needs_work'|
 * 'rejected', StructuralLayer.ratio/.failures/.placeholderHits, CoverageLayer
 * .verifiedCoverageRatio/.checklist:CoverageItem[], SemanticLayer.dimensions:
 * DimensionScore[], the 5-field DefinitionOfDone incl. maxBlockerGaps). THIS gate
 * exposes a small, decoupled LOCAL contract (StructuralResult.score / Coverage
 * Result.ratio / SemanticScores dict / a 4-field gate DoD / verdict
 * 'needs_improvement') that is intentionally minimal so the gate is reusable from
 * pipeline/routes/worker/tests without importing the whole critic package. The
 * consumer (criticAgent.ts) owns the thin, pure ADAPTER layer that bridges these
 * local result types to the canonical state.ts report types — it maps
 * 'needs_improvement' → 'needs_work' (toCriticVerdict), copies .score→.ratio /
 * .ratio→.verifiedCoverageRatio, and enforces the canonical DoD.maxBlockerGaps
 * using its gaps[] array (runCriticGate). Keeping that mapping in ONE place (the
 * adapter) avoids dual-declaring the canonical graph here.
 */
import type { TestCase, ParsedRequirements } from './state.js';
import type { ExtendedTestPlan } from './plannerAgent.js';

// ─────────────────────────────────────────────────────────────────────────────
// Public types (self-contained so the gate is reusable from pipeline, routes,
// worker, or tests without dragging in the rest of the critic package). The
// consumer adapts these to the canonical state.ts report types (see header).
// ─────────────────────────────────────────────────────────────────────────────

/** The deterministic verdict. Only evaluateDefinitionOfDone may emit 'approved'.
 *  'needs_improvement' is the gate's LOCAL literal; criticAgent.toCriticVerdict()
 *  maps it to the canonical state.ts literal 'needs_work'. */
export type CriticVerdict = 'approved' | 'needs_improvement' | 'rejected';

/** The six rubric dimensions the AI scores (Layer2). Code owns their weights. */
export type RubricKey =
  | 'clarity'
  | 'correctness'
  | 'atomicity'
  | 'dataConcreteness'
  | 'coverageDepth'
  | 'nonAmbiguity';

/** L4 Layer1 — DETERMINISTIC structural result, NO AI. (Consumer adapts .score
 *  → canonical StructuralLayer.ratio and .violations → .failures, splitting out
 *  placeholder hits for the report card.) */
export interface StructuralResult {
  /** passed / totalCases — the floor the gate enforces (0..1). 0 when no cases
   *  (fail-closed: an empty suite is never structurally valid → never approved). */
  score: number;
  /** Cases satisfying ALL structural invariants. */
  passed: number;
  /** Total cases inspected. */
  totalCases: number;
  /** Per-offending-case violations + the suite-level duplicate-title list. */
  violations: { testId: string; problems: string[] }[];
  /** Titles that collide case-insensitively (mirrors the generator's dedup). */
  duplicateTitles: string[];
}

/** L4 Layer3 + L6 — one requirement element in the coverage state machine. */
export interface CoverageChecklistItem {
  area: 'feature' | 'flow' | 'edgeCase' | 'nfr' | 'deniedPersona';
  /** Stable, human-auditable key, e.g. 'feature:User Login' | 'flow:2'. */
  requirementKey: string;
  /** Human-readable target the loop drives from uncovered → covered. */
  expectedScenario: string;
  covered: boolean;
  /** First matching TestCase.id (deterministic first-match) when covered. */
  evidenceTestId?: string;
}

/** L4 Layer3 + L6 — DETERMINISTIC coverage result, NO AI. (Consumer adapts
 *  .ratio → canonical CoverageLayer.verifiedCoverageRatio.) */
export interface CoverageResult {
  /** covered / total (the VCR). Vacuously 1 when there are no requirement items
   *  to match — but the structural floor independently blocks an empty SUITE, so
   *  a vacuous VCR can never false-approve a suite with zero cases. */
  ratio: number;
  total: number;
  covered: number;
  checklist: CoverageChecklistItem[];
  /** The still-uncovered items (checklist.filter(!covered)) for gap building. */
  uncovered: CoverageChecklistItem[];
}

/** L4 Layer2 — the AI's proposed per-dimension scores (proposals only). The
 *  consumer derives this dict from the canonical SemanticLayer.dimensions[]. */
export interface SemanticScores {
  /** Each dimension's AI-proposed 0..100 score. Missing keys default to 50. */
  dimensions: Partial<Record<RubricKey, number>>;
  /** The model's own overall — recorded for divergence audit, NEVER trusted. */
  modelClaimedOverall?: number;
}

/** L2 — the gate's local Definition of Done. (The canonical state.ts DoD adds a
 *  5th field, maxBlockerGaps, enforced by the consumer's runCriticGate wrapper.) */
export interface DefinitionOfDone {
  /** Weighted rubric overall must be ≥ this. */
  minOverall: number;
  /** Every case must be structurally valid (default 1.0). */
  minStructuralRatio: number;
  /** VCR < this BLOCKS 'approved' (default 1.0 — the VCR<1.0 rule). */
  minVerifiedCoverageRatio: number;
  /** No single rubric dimension may sink below this floor. */
  perDimensionFloor: number;
}

/** Input bundle for the gate — the three layers + the recomputed overall. */
export interface GateInput {
  structural: StructuralResult;
  semantic: SemanticScores;
  coverage: CoverageResult;
  /** The CODE-recomputed weighted overall (recomputeWeightedScore), NOT the model's. */
  overallScore: number;
}

/** L3 — the deterministic gate verdict. The AI has no writable path to this. */
export interface GateResult {
  verdict: CriticVerdict;
  /** Empty iff verdict === 'approved'. Each is an objective, audit-ready reason. */
  blockingReasons: string[];
  /** The recomputed overall the gate actually evaluated. */
  computedOverall: number;
  /** Mirror of coverage.ratio — the value gated. */
  verifiedCoverageRatio: number;
  /** Mirror of structural.score — the value gated. */
  structuralRatio: number;
  /** Echo of the DoD constants enforced (audit trail, L2). */
  thresholdsApplied: DefinitionOfDone;
}

// ─────────────────────────────────────────────────────────────────────────────
// L2 — DEFINITION OF DONE + RUBRIC WEIGHTS, externalised from env.
// 'done' = gate verdict 'approved'. Producing output or the model claiming a
// high score is explicitly NOT done. The model is NEVER shown these thresholds
// as a pass/fail switch — the gate is their sole consumer.
// ─────────────────────────────────────────────────────────────────────────────

const num = (key: string, fallback: number): number => {
  const v = Number(process.env[key]);
  return Number.isFinite(v) ? v : fallback;
};

/** Rubric weights — code-owned, summing to 1.0. NEVER model-chosen (L5). */
export const CRITIC_WEIGHTS: Record<RubricKey, number> = {
  clarity: 0.15,
  correctness: 0.25,
  atomicity: 0.15,
  dataConcreteness: 0.2,
  coverageDepth: 0.15,
  nonAmbiguity: 0.1,
};

// Fail-fast at module load: a mis-typed weight that breaks the 1.0 sum would
// silently distort every overall. Catch it deterministically, here, once. The
// weights are a hard-coded literal above (never env-derived), so this can only
// fire if THIS file is edited with a bad weight — it is a developer guardrail,
// not a runtime/config failure mode, and the critic module is only imported when
// the (opt-in, default-off) critic runs, so it cannot crash the backend on boot
// for a tenant that never enables the critic. Plain top-level statement (no
// wrapping block) to match neighbour style.
const CRITIC_WEIGHTS_SUM = Object.values(CRITIC_WEIGHTS).reduce((a, b) => a + b, 0);
if (Math.abs(CRITIC_WEIGHTS_SUM - 1) > 1e-9) {
  throw new Error(`[critic-gate] CRITIC_WEIGHTS must sum to 1.0 — got ${CRITIC_WEIGHTS_SUM.toFixed(4)}`);
}

/** L2 — env-overridable thresholds. Snapshot into reports so a verdict is reproducible. */
export const CRITIC_DOD: DefinitionOfDone = {
  minOverall: num('CRITIC_MIN_SCORE', 80), // weighted rubric overall
  minStructuralRatio: num('CRITIC_MIN_STRUCTURAL', 1.0), // every case structurally valid
  minVerifiedCoverageRatio: num('CRITIC_MIN_COVERAGE', 1.0), // VCR<1.0 deliberately BLOCKS approved (L6)
  perDimensionFloor: num('CRITIC_DIM_FLOOR', 60), // a high average can't mask a fatal dimension
};

/**
 * Coverage-match overlap thresholds (0..1). Kept as exported, env-tunable
 * constants so the deterministic matcher is reproducible (L5/L11). Each area
 * additionally requires type alignment so a wrong-type test can't satisfy it.
 */
export const COVERAGE_THRESHOLDS = {
  feature: num('CRITIC_OVERLAP_FEATURE', 0.6),
  flow: num('CRITIC_OVERLAP_FLOW', 0.5),
  edgeCase: num('CRITIC_OVERLAP_EDGE', 0.5),
  nfr: num('CRITIC_OVERLAP_NFR', 0.4),
};

/** L4 Layer1 — non-placeholder data regex. A match means the value is a stub. */
const PLACEHOLDER_RE = /<[^>]+>|\{[^}]+\}|placeholder|\bTBD\b|\bxxx\b|\btodo\b|lorem/i;

/** L4 Layer1 — a tautological expected result is itself a violation. */
const TAUTOLOGY_RE = /^(test\s+)?(passes|works|ok|okay|successful|success|done)\.?$/i;

/** The 10 valid TestCase types (kept in lockstep with state.ts). */
const VALID_TYPES: ReadonlySet<TestCase['type']> = new Set<TestCase['type']>([
  'e2e', 'positive', 'negative', 'edge', 'api', 'data', 'smoke', 'security', 'accessibility', 'performance',
]);

/** The 4 valid priorities. */
const VALID_PRIORITIES: ReadonlySet<TestCase['priority']> = new Set<TestCase['priority']>([
  'P0', 'P1', 'P2', 'P3',
]);

// ─────────────────────────────────────────────────────────────────────────────
// L4 LAYER 1 — STRUCTURAL VALIDITY (deterministic, no AI).
// ─────────────────────────────────────────────────────────────────────────────

/**
 * checkStructuralValidity — assert structural invariants on every test case.
 * Runs first, cheap, and reproducible (regex + Set membership only): the same
 * `testCases` always yields the same findings. A case failing here counts
 * against the gate regardless of the AI's opinion.
 *
 * Invariants per case:
 *   • required fields present: feature, title, expectedResult, type, priority
 *   • title starts with 'Verify ' AND is unique across the suite (case-insensitive)
 *   • at least one step (steps[] or testSteps[])
 *   • type ∈ the 10 valid types; priority ∈ {P0..P3}
 *   • CONCRETE data — no placeholder across testData values + each step's testData
 *   • expectedResult is non-tautological ("test passes" / "works" are violations)
 *
 * Every optional field (testData, testSteps, steps) is null-guarded, so a case
 * with testData/testSteps undefined (legal per TestCase) never throws — the
 * function is PURE and TOTAL.
 */
export function checkStructuralValidity(testCases: TestCase[]): StructuralResult {
  const cases = Array.isArray(testCases) ? testCases : [];
  const totalCases = cases.length;

  // Duplicate-title detection (case-insensitive, trimmed) — mirrors generator dedup.
  const titleCounts = new Map<string, number>();
  for (const tc of cases) {
    const key = normTitle(tc?.title);
    if (key) titleCounts.set(key, (titleCounts.get(key) ?? 0) + 1);
  }
  const duplicateTitles = [...titleCounts.entries()]
    .filter(([, n]) => n > 1)
    .map(([t]) => t);
  const duplicateSet = new Set(duplicateTitles);

  const violations: { testId: string; problems: string[] }[] = [];
  let passed = 0;

  for (let i = 0; i < cases.length; i++) {
    const tc = cases[i];
    const problems: string[] = [];
    const testId = (tc && typeof tc.id === 'string' && tc.id.trim()) ? tc.id : `index#${i}`;

    // Required fields.
    if (!nonEmpty(tc?.feature)) problems.push('missing required field: feature');
    if (!nonEmpty(tc?.title)) problems.push('missing required field: title');
    if (!nonEmpty(tc?.expectedResult)) problems.push('missing required field: expectedResult');
    if (!nonEmpty(tc?.type)) problems.push('missing required field: type');
    if (!nonEmpty(tc?.priority)) problems.push('missing required field: priority');

    // Title shape + uniqueness.
    if (nonEmpty(tc?.title)) {
      if (!/^verify\s+\S/i.test(tc.title.trim())) {
        problems.push(`title must start with "Verify " — got "${truncate(tc.title)}"`);
      }
      if (duplicateSet.has(normTitle(tc.title))) {
        problems.push(`duplicate title across suite: "${truncate(tc.title)}"`);
      }
    }

    // At least one step (both arrays optional → guarded).
    const stepCount = (Array.isArray(tc?.steps) ? tc.steps.length : 0)
      + (Array.isArray(tc?.testSteps) ? tc.testSteps.length : 0);
    if (stepCount < 1) problems.push('at least one step required (steps[] or testSteps[])');

    // Enum membership.
    if (nonEmpty(tc?.type) && !VALID_TYPES.has(tc.type)) {
      problems.push(`invalid type: "${tc.type}"`);
    }
    if (nonEmpty(tc?.priority) && !VALID_PRIORITIES.has(tc.priority)) {
      problems.push(`invalid priority: "${tc.priority}"`);
    }

    // Concrete (non-placeholder) data — shared testData block + per-step testData.
    for (const hit of collectPlaceholderHits(tc)) {
      problems.push(`placeholder/non-concrete data in ${hit.field}: "${truncate(hit.value)}"`);
    }

    // Non-tautological expected result.
    if (nonEmpty(tc?.expectedResult) && TAUTOLOGY_RE.test(tc.expectedResult.trim())) {
      problems.push(`expectedResult is tautological: "${truncate(tc.expectedResult)}"`);
    }

    if (problems.length === 0) {
      passed++;
    } else {
      violations.push({ testId, problems });
    }
  }

  // Empty suite: no case is invalid, but it cannot be "valid" either — treat as
  // score 0 so the gate blocks (an empty suite must never be approved).
  const score = totalCases === 0 ? 0 : passed / totalCases;

  return { score, passed, totalCases, violations, duplicateTitles };
}

/** Collect every placeholder/non-concrete data value on a case (every optional
 *  field null-guarded so an undefined testData/testSteps never throws). */
function collectPlaceholderHits(tc: TestCase | undefined): { field: string; value: string }[] {
  const hits: { field: string; value: string }[] = [];
  if (!tc) return hits;

  if (tc.testData && typeof tc.testData === 'object') {
    for (const [k, v] of Object.entries(tc.testData)) {
      if (typeof v === 'string' && PLACEHOLDER_RE.test(v)) {
        hits.push({ field: `testData.${k}`, value: v });
      }
    }
  }
  if (Array.isArray(tc.testSteps)) {
    tc.testSteps.forEach((s, idx) => {
      if (s && typeof s.testData === 'string' && PLACEHOLDER_RE.test(s.testData)) {
        hits.push({ field: `testSteps[${idx}].testData`, value: s.testData });
      }
    });
  }
  return hits;
}

// ─────────────────────────────────────────────────────────────────────────────
// L4 LAYER 3 + L6 — COVERAGE (deterministic feature-list state machine, no AI).
// ─────────────────────────────────────────────────────────────────────────────

/**
 * computeCoverage — build a checklist from ParsedRequirements (the source of
 * truth) and deterministically match each requirement element to a TestCase.
 *
 * One checklist item per: feature, flow, edge case, stated NFR (across all five
 * NFR categories), and every (actor × deniedFeature) authorization pair. Each
 * item is matched by token/keyword overlap WITH a required type alignment so a
 * wrong-type test can't satisfy a flow / edge / nfr / denied item. First match
 * wins (deterministic) and records evidenceTestId.
 *
 * VCR = covered / total. The gate BLOCKS 'approved' while VCR is below target.
 * The optional `plan` is accepted for signature compatibility / future use; the
 * coverage baseline is intentionally driven only by ParsedRequirements so the
 * gate cannot be diluted by a thin plan.
 */
export function computeCoverage(
  testCases: TestCase[],
  parsedRequirements: ParsedRequirements | null | undefined,
  _plan?: ExtendedTestPlan | null,
): CoverageResult {
  const cases = Array.isArray(testCases) ? testCases : [];
  const pr = parsedRequirements;
  const checklist: CoverageChecklistItem[] = [];

  if (!pr) {
    // No requirements to match against → vacuously fully covered (gate relies on
    // structural + semantic layers in that degenerate case; the structural floor
    // independently blocks an empty SUITE).
    return { ratio: 1, total: 0, covered: 0, checklist: [], uncovered: [] };
  }

  // Pre-index each case's searchable text once (lowercased token sets).
  const indexed = cases.map((tc) => ({
    tc,
    titleTokens: tokenize(`${str(tc?.title)} ${str(tc?.feature)}`),
    scenarioTokens: tokenize(`${str(tc?.title)} ${str(tc?.scenario)}`),
    descTokens: tokenize(`${str(tc?.title)} ${str(tc?.description)}`),
    titleLc: `${str(tc?.title)}`.toLowerCase(),
    type: tc?.type,
    featureLc: `${str(tc?.feature)}`.toLowerCase().trim(),
    moduleLc: `${str(tc?.module)}`.toLowerCase().trim(),
  }));

  // ── features ──────────────────────────────────────────────────────────────
  (pr.features ?? []).forEach((f) => {
    const target = tokenize(f);
    const fLc = f.toLowerCase().trim();
    const match = indexed.find((ix) =>
      ix.featureLc === fLc ||
      ix.moduleLc === fLc ||
      tokenOverlap(target, ix.titleTokens) >= COVERAGE_THRESHOLDS.feature,
    );
    checklist.push(item('feature', `feature:${f}`,
      `At least happy+negative coverage of "${f}"`, match?.tc.id));
  });

  // ── flows (require an e2e test) ─────────────────────────────────────────────
  (pr.flows ?? []).forEach((flow, i) => {
    const target = tokenize(flow);
    const match = indexed.find((ix) =>
      ix.type === 'e2e' && tokenOverlap(target, ix.scenarioTokens) >= COVERAGE_THRESHOLDS.flow,
    );
    checklist.push(item('flow', `flow:${i}`,
      `An e2e test walking "${truncate(flow, 80)}" end-to-end`, match?.tc.id));
  });

  // ── edge cases (require an edge/negative/security test) ─────────────────────
  (pr.edgeCases ?? []).forEach((edge, i) => {
    const target = tokenize(edge);
    const match = indexed.find((ix) =>
      (ix.type === 'edge' || ix.type === 'negative' || ix.type === 'security') &&
      tokenOverlap(target, ix.descTokens) >= COVERAGE_THRESHOLDS.edgeCase,
    );
    checklist.push(item('edgeCase', `edge:${i}`,
      `A dedicated edge/negative test for "${truncate(edge, 80)}"`, match?.tc.id));
  });

  // ── NFRs (require a type aligned to the NFR category) ───────────────────────
  const nfr = pr.nonFunctionalRequirements ?? {};
  const NFR_TYPE: Record<string, TestCase['type'] | null> = {
    performance: 'performance',
    security: 'security',
    accessibility: 'accessibility',
    compatibility: null, // no dedicated type — match any aligned test by overlap only
    usability: null,
  };
  (Object.keys(NFR_TYPE) as (keyof typeof nfr)[]).forEach((cat) => {
    const list = (nfr[cat] ?? []) as string[];
    const requiredType = NFR_TYPE[cat as string];
    list.forEach((spec, i) => {
      if (!nonEmpty(spec)) return;
      const target = tokenize(spec);
      const match = indexed.find((ix) =>
        (requiredType === null || ix.type === requiredType) &&
        tokenOverlap(target, ix.titleTokens) >= COVERAGE_THRESHOLDS.nfr,
      );
      checklist.push(item('nfr', `nfr:${cat}:${i}`,
        `A ${cat} test verifying "${truncate(spec, 80)}"`, match?.tc.id));
    });
  });

  // ── denied personas (require a negative/security authz test) ────────────────
  (pr.personaMatrix ?? []).forEach((p) => {
    const actor = str(p?.actor);
    const denied = Array.isArray(p?.deniedFeatures) ? p.deniedFeatures : [];
    denied.forEach((feat) => {
      const actorTok = actor.toLowerCase().trim();
      const featTok = str(feat).toLowerCase().trim();
      const match = indexed.find((ix) =>
        (ix.type === 'negative' || ix.type === 'security') &&
        ix.titleLc.includes(firstToken(actorTok)) &&
        ix.titleLc.includes(firstToken(featTok)) &&
        /denied|forbidden|cannot|unauthor|403|blocked|not\s+allowed/i.test(ix.titleLc),
      );
      checklist.push(item('deniedPersona', `deny:${actor}#${feat}`,
        `A negative authz test that ${actor} is denied ${feat}`, match?.tc.id));
    });
  });

  const total = checklist.length;
  const covered = checklist.filter((c) => c.covered).length;
  const ratio = total === 0 ? 1 : covered / total;
  const uncovered = checklist.filter((c) => !c.covered);

  return { ratio, total, covered, checklist, uncovered };
}

/** Construct a checklist item; presence of evidenceTestId sets covered=true. */
function item(
  area: CoverageChecklistItem['area'],
  requirementKey: string,
  expectedScenario: string,
  evidenceTestId?: string,
): CoverageChecklistItem {
  return {
    area,
    requirementKey,
    expectedScenario,
    covered: Boolean(evidenceTestId),
    evidenceTestId,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// L5 — RECOMPUTE THE WEIGHTED OVERALL IN CODE. Never trust model arithmetic.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * recomputeWeightedScore — weighted average of the (clamped) per-dimension
 * scores using the CODE-owned weights. The denominator is the FULL config weight
 * sum (1.0), so present and omitted dimensions are weighted consistently. A
 * dimension the model omitted defaults to a conservative 50 so a missing score
 * can neither inflate nor zero the overall. The upstream normaliser
 * (criticAgent.normaliseSemantic) materialises all 6 dimensions before the gate
 * runs, so the omitted-default path is a defensive fallback only. Returns a
 * rounded 0..100 integer; the model's claimed overall is never used.
 */
export function recomputeWeightedScore(
  dimensionScores: Partial<Record<RubricKey, number>>,
  weights: Record<RubricKey, number> = CRITIC_WEIGHTS,
): number {
  const clamp = (n: unknown): number => {
    const v = Number(n);
    return Math.max(0, Math.min(100, Math.round(Number.isFinite(v) ? v : 50)));
  };

  let acc = 0;
  let wSum = 0;
  for (const key of Object.keys(weights) as RubricKey[]) {
    const w = weights[key] ?? 0;
    const raw = dimensionScores?.[key];
    const score = raw === undefined || raw === null ? 50 : clamp(raw);
    acc += score * w;
    wSum += w;
  }
  return wSum > 0 ? Math.round(acc / wSum) : 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// L2 / L3 — THE GATE. The SOLE producer of 'approved'.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * evaluateDefinitionOfDone — the deterministic gate. Given the three layers and
 * the CODE-recomputed overall, it computes the final verdict + the objective
 * blockingReasons. 'approved' is reachable ONLY here, ONLY when every threshold
 * passes (blockingReasons empty). The model can return score:100 everywhere and
 * still be blocked when coverage or structure falls short — code owns coverage,
 * structure, the recomputed overall, AND the verdict.
 *
 * Blocking rules enforced here: empty-suite fail-closed, structural floor (L4),
 * VCR floor (L6), recomputed weighted overall (L5), and the per-dimension floor
 * (L5). The canonical DoD's blocker-gap ceiling (L7, maxBlockerGaps) is enforced
 * by the consumer's runCriticGate wrapper, which has the gaps[] array.
 *
 * KEY INVARIANT: there is NO model-writable path to GateResult.verdict.
 */
export function evaluateDefinitionOfDone(
  input: GateInput,
  dod: DefinitionOfDone = CRITIC_DOD,
): GateResult {
  const { structural, semantic, coverage, overallScore } = input;
  const reasons: string[] = [];

  const structuralRatio = clampRatio(structural?.score);
  const verifiedCoverageRatio = clampRatio(coverage?.ratio);
  const computedOverall = Math.max(0, Math.min(100, Math.round(Number.isFinite(overallScore) ? overallScore : 0)));
  const totalCases = structural?.totalCases ?? 0;

  // 0. Empty suite — fail-closed. An empty suite must NEVER be approved even if
  //    there happen to be no requirement items to cover (VCR would be vacuously
  //    1). checkStructuralValidity already reports score 0 for an empty suite, so
  //    the structural floor below also blocks; this surfaces a clearer reason.
  if (totalCases === 0) {
    reasons.push('empty suite — no test cases to evaluate');
  }

  // 1. Structural floor (L4 Layer1) — hard.
  if (structuralRatio < dod.minStructuralRatio) {
    const bad = structural?.violations?.length ?? 0;
    reasons.push(
      `structuralRatio ${structuralRatio.toFixed(2)} < ${dod.minStructuralRatio} (${bad} invalid case(s))`,
    );
  }

  // 2. Coverage state machine (L6) — VCR < target BLOCKS approved.
  if (verifiedCoverageRatio < dod.minVerifiedCoverageRatio) {
    const open = (coverage?.total ?? 0) - (coverage?.covered ?? 0);
    reasons.push(
      `verifiedCoverageRatio ${verifiedCoverageRatio.toFixed(2)} < ${dod.minVerifiedCoverageRatio} (${open} uncovered requirement(s))`,
    );
  }

  // 3. Weighted overall (L5) — recomputed, not the model's number.
  if (computedOverall < dod.minOverall) {
    reasons.push(`computedOverall ${computedOverall} < ${dod.minOverall}`);
  }

  // 4. Per-dimension floor (L5) — a high average can't mask a fatal dimension.
  const dims = semantic?.dimensions ?? {};
  for (const key of Object.keys(CRITIC_WEIGHTS) as RubricKey[]) {
    const raw = dims[key];
    if (raw === undefined || raw === null) continue; // missing handled by overall default
    const sc = Math.max(0, Math.min(100, Math.round(Number(raw))));
    if (sc < dod.perDimensionFloor) {
      reasons.push(`dimension ${key} ${sc} < floor ${dod.perDimensionFloor}`);
    }
  }

  // VERDICT: 'approved' ONLY when no reason blocks it. A clearly-broken suite (or
  // an empty one) is 'rejected'; anything in between is 'needs_improvement' (the
  // loop keeps going). The consumer maps 'needs_improvement' → the canonical
  // state.ts literal 'needs_work' via toCriticVerdict(); this gate keeps its own
  // local literal deliberately (the adapter owns the canonical mapping).
  const verdict: CriticVerdict =
    reasons.length === 0
      ? 'approved'
      : totalCases === 0 || structuralRatio < 0.5 || verifiedCoverageRatio < 0.5 || computedOverall < 50
        ? 'rejected'
        : 'needs_improvement';

  return {
    verdict,
    blockingReasons: reasons,
    computedOverall,
    verifiedCoverageRatio,
    structuralRatio,
    thresholdsApplied: dod,
  };
}

/**
 * runGate — convenience wrapper that recomputes the overall in code (L5) from
 * the AI's proposed dimension scores and then runs the deterministic gate, so a
 * caller cannot accidentally feed the gate the model's own (untrusted) overall.
 */
export function runGate(
  structural: StructuralResult,
  semantic: SemanticScores,
  coverage: CoverageResult,
  dod: DefinitionOfDone = CRITIC_DOD,
): GateResult {
  const overallScore = recomputeWeightedScore(semantic?.dimensions ?? {});
  return evaluateDefinitionOfDone({ structural, semantic, coverage, overallScore }, dod);
}

// ─────────────────────────────────────────────────────────────────────────────
// Pure helpers (deterministic — no Date/random/I/O).
// ─────────────────────────────────────────────────────────────────────────────

const STOP_WORDS: ReadonlySet<string> = new Set([
  'the', 'and', 'for', 'that', 'with', 'this', 'from', 'into', 'must', 'should',
  'shall', 'when', 'then', 'given', 'verify', 'test', 'user', 'users', 'page',
  'system', 'application', 'app', 'using', 'while', 'their', 'have', 'will',
  'within', 'over', 'under', 'each', 'also', 'than', 'them', 'they',
]);

/** Lowercase, strip punctuation, drop stop-words + short tokens, return a Set. */
function tokenize(text: unknown): Set<string> {
  const out = new Set<string>();
  if (typeof text !== 'string') return out;
  for (const raw of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length > 3 && !STOP_WORDS.has(raw)) out.add(stem(raw));
  }
  return out;
}

/** Crude, deterministic stemmer — strips a couple of common suffixes. */
function stem(t: string): string {
  if (t.endsWith('ing') && t.length > 5) return t.slice(0, -3);
  if (t.endsWith('ies') && t.length > 4) return `${t.slice(0, -3)}y`;
  if (t.endsWith('es') && t.length > 4) return t.slice(0, -2);
  if (t.endsWith('s') && t.length > 4) return t.slice(0, -1);
  return t;
}

/** |A ∩ B| / |smaller| over the two token sets (0..1). 0 when either is empty. */
function tokenOverlap(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  const [small, big] = a.size <= b.size ? [a, b] : [b, a];
  let inter = 0;
  for (const t of small) if (big.has(t)) inter++;
  return inter / small.size;
}

/** First significant token of a phrase (for actor/feature mention checks). */
function firstToken(text: string): string {
  for (const raw of text.split(/[^a-z0-9]+/i)) {
    if (raw.length > 2) return raw.toLowerCase();
  }
  return text.toLowerCase().trim();
}

function normTitle(title: unknown): string {
  return typeof title === 'string' ? title.toLowerCase().trim() : '';
}

function nonEmpty(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0;
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function truncate(v: string, max = 60): string {
  return v.length > max ? `${v.slice(0, max)}…` : v;
}

function clampRatio(n: unknown): number {
  const v = Number(n);
  if (!Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(1, v));
}
