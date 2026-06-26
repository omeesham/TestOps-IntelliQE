/**
 * criticAgent
 * ───────────
 * An INDEPENDENT, skeptical reviewer of the test cases the generatorAgent
 * produced. This is the "checker" in the worker/checker split (L1): it is NEVER
 * the generator's self-assessment. It frames Claude as an adversarial QA lead
 * that DEFAULTS TO DISTRUST, scores the suite against a fixed rubric, runs a
 * DETERMINISTIC gate that alone may emit 'approved' (L3), and drives a bounded
 * RALPH loop (critique -> targeted regenerate to fill gaps -> re-critique ->
 * converge) that keeps criticising until the suite objectively passes the
 * externalised Definition of Done (L2) or a convergence guard halts it (L10).
 *
 * ─────────────────────────────────────────────────────────────────────────
 * SCOPE (L9 — read this before trusting any verdict): This critic certifies
 * test-DESIGN correctness and requirement COVERAGE through STATIC analysis only
 * — it scores clarity, correctness, atomicity, data concreteness, coverage depth
 * and non-ambiguity of the generated test cases, and confirms that every
 * feature, flow, edge case, denied-persona authorization, and stated
 * non-functional requirement has at least one corresponding test, then gates on
 * a deterministic Definition of Done. It does NOT execute any test and therefore
 * does NOT prove runtime pass/fail, selector validity against the live
 * application, or end-to-end behaviour. Runtime correctness remains the
 * responsibility of the execution agent (real Playwright run) and the healing
 * agent (post-failure repair). An 'approved' design verdict means the test
 * SPECIFICATIONS are complete, unambiguous, concrete and fully cover the
 * requirements — it is NOT a guarantee that the generated automation will pass
 * when executed, nor that the application is bug-free. Together, this static
 * design-gate and the runtime e2e + healing loop form the closed quality loop;
 * neither alone is sufficient and this report MUST NOT be read as a runtime
 * guarantee.
 * ─────────────────────────────────────────────────────────────────────────
 *
 * GROUND-TRUTH BINDING (why this file imports the way it does):
 *   The deterministic, AI-free Layer-1 (structural) and Layer-3 (coverage)
 *   checks, the rubric weights, the recompute-in-code overall, and the trust-
 *   anchor gate ALL already live in the sibling module `./critic-gate.js`
 *   (verified present on disk). The adversarial Layer-2 prompt + anchors live in
 *   `./critic-prompt.js` (verified present). The CriticReport type graph is
 *   declared canonically in `./state.js` (verified — TestOpsState.criticReport is
 *   already optional/additive). This file therefore imports the REAL exports of
 *   those three modules and is otherwise SELF-CONTAINED: it owns its own opt-in
 *   config (Definition of Done, loop guards, scope note), the gap builder, the
 *   small layer-shape adapters that bridge the gate's result types to the
 *   canonical state.ts report types, and the self-contained targeted
 *   regeneration. No `./critic/<...>` subfolder is referenced (none exists); the
 *   build is green against exactly the files that are present.
 *
 * PURELY ADDITIVE (L12): generatorAgent/auditAgent/healingAgent/plannerAgent/
 * requirementAgent are LEFT BYTE-FOR-BYTE UNTOUCHED. The generator's buildPrompt
 * and coerceTestCase are module-private in the running copy, so the loop ships a
 * self-contained regenerateForGaps() that MIRRORS the generator's proven
 * retry-pass idiom (an excludeTitles exclusion block + the top-K repair
 * scenarios, runClaudePrompt maxTokens 8192, then the SAME normalized-title Set
 * dedup) and assigns critic-namespaced TC-CR-### ids so they never collide with
 * the generator's TC-### counter. The loop only ever APPENDS gap-filling cases;
 * it never deletes or overwrites an original (L11).
 *
 * Exports:
 *   critiqueTestCases(input)         — pure (TestOpsState-decoupled), one rubric
 *                                      call + deterministic gate -> CriticReport.
 *   runSemanticRubric(pr, cases)     — the only AI call; defensively normalised.
 *   critiqueOnce(state, dod?)        — thin state adapter over critiqueTestCases.
 *   criticAgent(state, onProgress?)  — additive wrapper attaching state.criticReport
 *                                      (one critique, NO loop).
 *   runCriticImprovementLoop(state)  — the bounded RALPH loop.
 *   CRITIC_DOD / CRITIC_GUARDS / WEIGHTS / HONEST_SCOPE_NOTE / CRITIC_ENABLED.
 */
import type { TestOpsState, TestCase, TestStep, ParsedRequirements } from './state.js';
import type {
  CriticReport,
  CriticGap,
  CriticExitReason,
  CriticIterationTrace,
  DimensionScore,
  SemanticLayer,
  StructuralLayer,
  CoverageLayer,
  CoverageItem,
  GateResult,
  DefinitionOfDone,
  CriticVerdict,
  RubricKey,
} from './state.js';
import type { GenProgress } from './pipeline.js';
import { runClaudePrompt, parseJsonFromResponse } from './claude-runner.js';

// ── The deterministic trust anchor (Layer-1 + Layer-3 + recompute + gate). ──
// These are the REAL exports of the on-disk critic-gate.ts. Their result types
// (StructuralResult.score / CoverageResult.ratio / SemanticScores dict /
// gate CriticVerdict='needs_improvement') are LOCAL to the gate; we adapt them
// to the canonical state.ts report types below.
import {
  checkStructuralValidity,
  computeCoverage,
  recomputeWeightedScore,
  runGate,
  CRITIC_WEIGHTS,
  type StructuralResult,
  type CoverageResult,
  type SemanticScores,
  type GateResult as GateGateResult,
  type DefinitionOfDone as GateDefinitionOfDone,
  type RubricKey as GateRubricKey,
} from './critic-gate.js';

// ── The adversarial Layer-2 prompt + the 0/25/50/75/100 anchor ladders. ──
import {
  buildCriticPrompt,
  DIMENSION_ANCHORS,
  type CriticSemanticResponse,
} from './critic-prompt.js';

// ═════════════════════════════════════════════════════════════════════════
// L2 — DEFINITION OF DONE + RUBRIC WEIGHTS + LOOP GUARDS, externalised from env.
// 'done' = gate verdict 'approved'. Producing output or a model claiming a high
// score is explicitly NOT done. The model is NEVER shown these thresholds as a
// pass/fail switch — the gate (critic-gate.ts) is their sole consumer. These are
// snapshotted into report.gate.thresholdsApplied so a verdict is reproducible.
// ═════════════════════════════════════════════════════════════════════════

const num = (key: string, fallback: number): number => {
  const v = Number(process.env[key]);
  return Number.isFinite(v) ? v : fallback;
};
const bool = (key: string, fallback: boolean): boolean =>
  process.env[key] === undefined ? fallback : process.env[key] === 'true';

/**
 * The six code-owned rubric weights (sum === 1.0). Sourced from the gate so the
 * weight vector the gate recomputes with and the one this agent attaches to each
 * DimensionScore can never drift. Typed to the canonical state.ts RubricKey
 * (structurally identical to the gate's RubricKey — same six string literals).
 */
export const WEIGHTS: Record<RubricKey, number> = CRITIC_WEIGHTS as Record<RubricKey, number>;

/**
 * L2 — externalised Definition of Done. Mirrors the gate's CRITIC_DOD but adds
 * `maxBlockerGaps` (the canonical state.ts DefinitionOfDone has it; the gate's
 * does not gate on it — this agent enforces it deterministically alongside the
 * gate, see runCriticGate()). Env keys match the gate's so a single override
 * tunes both.
 */
export const CRITIC_DOD: DefinitionOfDone = {
  minOverall: num('CRITIC_MIN_SCORE', 80),
  minStructuralRatio: num('CRITIC_MIN_STRUCTURAL', 1.0),
  minVerifiedCoverageRatio: num('CRITIC_MIN_COVERAGE', 1.0),
  perDimensionFloor: num('CRITIC_DIM_FLOOR', 60),
  maxBlockerGaps: num('CRITIC_MAX_BLOCKER_GAPS', 0),
};

/**
 * L10 — bounded-loop guards. Names mirror the orchestrator's ConvergenceGuard
 * vocabulary (maxIterations / notDecreasing window / sameFindings / budget).
 */
export const CRITIC_GUARDS = {
  maxIterations: num('CRITIC_MAX_ITERATIONS', 3), // hard for-loop bound
  minScoreDelta: num('CRITIC_MIN_SCORE_DELTA', 2), // < this over the window => notDecreasing
  notDecreasingWindow: num('CRITIC_WINDOW', 2),
  topKGapsPerIteration: num('CRITIC_TOPK', 8), // small targeted batch (L10)
  budgetMaxClaudeCalls: num('CRITIC_BUDGET_CALLS', 7), // 1 critique + up to 3*(regen+recritique)
  budgetCapUsd: num('CRITIC_BUDGET_USD', 1.0), // monetary double-bound
};

/** L12 — opt-in. Default OFF: byte-for-byte identical pipeline behaviour when unset. */
export const CRITIC_ENABLED: boolean = bool('CRITIC_ENABLED', false);

/** L9 — verbatim scope boundary, stamped into every CriticReport.scopeNote and the UI card. */
export const HONEST_SCOPE_NOTE =
  'SCOPE: This critic certifies test-DESIGN correctness and requirement COVERAGE through STATIC ' +
  'analysis only — it scores clarity, correctness, atomicity, data concreteness, coverage depth and ' +
  'non-ambiguity of the generated test cases, and confirms that every feature, flow, edge case, ' +
  'denied-persona authorization, and stated non-functional requirement has at least one corresponding ' +
  'test, then gates on a deterministic Definition of Done. It does NOT execute any test and therefore ' +
  'does NOT prove runtime pass/fail, selector validity against the live application, or end-to-end ' +
  'behaviour. Runtime correctness remains the responsibility of the execution agent (real Playwright ' +
  'run) and the healing agent (post-failure repair). An "approved" design verdict means the test ' +
  'SPECIFICATIONS are complete, unambiguous, concrete and fully cover the requirements — it is NOT a ' +
  'guarantee that the generated automation will pass when executed, nor that the application is ' +
  'bug-free. Together, this static design-gate and the runtime e2e + healing loop form the closed ' +
  'quality loop; neither alone is sufficient and this report MUST NOT be read as a runtime guarantee.';

// ─────────────────────────────────────────────────────────────────────────
// Cost estimation — coarse per-call USD estimates feed the loop's monetary
// budget cap (L10). The gate is the trust anchor for correctness; these are
// only for halting, so a rough constant is fine and intentionally pessimistic.
// ─────────────────────────────────────────────────────────────────────────
const RUBRIC_EST_USD = 0.15; // one ~6k-token critique call
const REGEN_EST_USD = 0.2;   // one ~8k-token targeted regeneration call

const ALL_DIMENSIONS: RubricKey[] = [
  'clarity', 'correctness', 'atomicity', 'dataConcreteness', 'coverageDepth', 'nonAmbiguity',
];

// Mirror the generator's coercion lists so a critic-regenerated case is
// normalised to the SAME enums the generator guarantees (L11 — appended cases
// are indistinguishable in shape from originals).
const VALID_TYPES: TestCase['type'][] = [
  'positive', 'negative', 'edge', 'e2e', 'api', 'data', 'smoke', 'security', 'accessibility', 'performance',
];
const VALID_PRIORITIES: TestCase['priority'][] = ['P0', 'P1', 'P2', 'P3'];
const VALID_SEVERITIES: NonNullable<TestCase['severity']>[] = ['Critical', 'Major', 'Moderate', 'Minor'];

const clampScore = (n: number): number =>
  Math.max(0, Math.min(100, Math.round(Number.isFinite(n) ? n : 0)));

// ═════════════════════════════════════════════════════════════════════════
// LAYER 2 — SEMANTIC RUBRIC (the only AI call). One Claude call, defensively
// normalised. The model PROPOSES per-dimension scores; code clamps them, fills
// any missing dimension conservatively, attaches the config WEIGHTS, and
// RECOMPUTES the weighted overall in code (L5). The model's own overall is
// recorded for audit only — never trusted by the gate.
//
// We keep the model's concrete repair-carrying gaps (CriticSemanticResponse.gaps)
// out-of-band on the returned layer (`semanticGaps`) so buildGaps can fold them
// into the agent-oriented gap list (L7) without a second AI round-trip.
// ═════════════════════════════════════════════════════════════════════════

/** A model-proposed semantic gap, carried alongside the normalised SemanticLayer. */
type SemanticGap = CriticSemanticResponse['gaps'][number];

/** SemanticLayer (canonical, state.ts shape) + the model's raw gaps for buildGaps. */
interface SemanticResult {
  layer: SemanticLayer;
  gaps: SemanticGap[];
}

function asStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.map((x) => String(x)).filter(Boolean);
}

/**
 * Normalise the model's raw rubric into a trustworthy SemanticLayer:
 *  • clamp every score to [0,100]
 *  • fill any missing RubricKey with a conservative 50 + an explicit note
 *  • attach config WEIGHTS (NEVER model-chosen)
 *  • overallScore = recomputeWeightedScore(dict) — the CODE number (L5)
 *  • modelClaimedOverall kept for divergence audit only
 */
function normaliseSemantic(raw: Partial<CriticSemanticResponse> | null | undefined): SemanticResult {
  const byKey = new Map<string, CriticSemanticResponse['dimensions'][number]>();
  for (const d of Array.isArray(raw?.dimensions) ? raw!.dimensions : []) {
    if (d && typeof d.key === 'string') byKey.set(d.key, d);
  }

  const dimensions: DimensionScore[] = ALL_DIMENSIONS.map((key) => {
    const r = byKey.get(key);
    if (!r) {
      return {
        key,
        score: 50,
        weight: WEIGHTS[key] ?? 0,
        justification: 'model omitted dimension — conservative default applied',
        weakestTestIds: [],
      };
    }
    return {
      key,
      score: clampScore(Number(r.score)),
      weight: WEIGHTS[key] ?? 0,
      justification: String(r.justification || '').trim() || '(no justification provided)',
      weakestTestIds: asStringArray(r.weakestTestIds),
    };
  });

  // Recompute the overall in code from a dict view of the (clamped) scores —
  // the gate's recompute consumes a Partial<Record<RubricKey, number>>.
  const dict = toScoreDict(dimensions);
  const modelClaimed = Number(raw?.modelClaimedOverall);

  const layer: SemanticLayer = {
    dimensions,
    overallScore: recomputeWeightedScore(dict as Partial<Record<GateRubricKey, number>>),
    modelClaimedOverall: Number.isFinite(modelClaimed) ? clampScore(modelClaimed) : undefined,
  };

  const gaps: SemanticGap[] = Array.isArray(raw?.gaps)
    ? raw!.gaps.filter((g): g is SemanticGap => !!g && !!g.repair)
    : [];
  return { layer, gaps };
}

/** Map the canonical DimensionScore[] to the gate's dict input (L5 bridge). */
function toScoreDict(dimensions: DimensionScore[]): Partial<Record<RubricKey, number>> {
  const dict: Partial<Record<RubricKey, number>> = {};
  for (const d of dimensions) dict[d.key] = clampScore(d.score);
  return dict;
}

/**
 * Run the adversarial QA-lead rubric over the suite. ONE Claude call.
 * Pure inputs (testCases + parsedRequirements) so it is reusable anywhere.
 * Defensive: a parse failure throws (the loop treats that as a terminal
 * 'regenerationFailed' exit returning the best report so far, L11) — it never
 * leaves a half-built layer.
 */
export async function runSemanticRubric(
  parsedRequirements: ParsedRequirements,
  testCases: TestCase[],
): Promise<SemanticLayer> {
  return (await runSemanticRubricFull(parsedRequirements, testCases)).layer;
}

/** Internal — returns the normalised layer AND the model's raw repair gaps. */
async function runSemanticRubricFull(
  parsedRequirements: ParsedRequirements,
  testCases: TestCase[],
): Promise<SemanticResult> {
  const prompt = buildCriticPrompt({ parsedRequirements, testCases, anchors: DIMENSION_ANCHORS });
  const response = await runClaudePrompt(prompt, { maxTokens: 6000 });
  const raw = parseJsonFromResponse<Partial<CriticSemanticResponse>>(response);
  return normaliseSemantic(raw && typeof raw === 'object' ? raw : null);
}

// ═════════════════════════════════════════════════════════════════════════
// LAYER-SHAPE ADAPTERS — bridge the gate's result types (StructuralResult /
// CoverageResult / gate GateResult, verdict 'needs_improvement') to the
// canonical state.ts report types (StructuralLayer / CoverageLayer / GateResult,
// verdict 'needs_work'). PURE — no AI, no I/O.
// ═════════════════════════════════════════════════════════════════════════

/** state.ts StructuralLayer ← gate StructuralResult. */
function toStructuralLayer(s: StructuralResult): StructuralLayer {
  const placeholderHits: { testId: string; field: string; value: string }[] = [];
  const failures: { testId: string; violations: string[] }[] = (s.violations ?? []).map((v) => {
    for (const p of v.problems) {
      // Surface placeholder/non-concrete hits separately for the report card.
      const m = /^placeholder\/non-concrete data in ([^:]+): "(.*)"$/.exec(p);
      if (m) placeholderHits.push({ testId: v.testId, field: m[1], value: m[2] });
    }
    return { testId: v.testId, violations: v.problems };
  });
  return {
    totalCases: s.totalCases,
    passed: s.passed,
    ratio: s.score, // gate names the floor `.score`; canonical names it `.ratio`
    failures,
    duplicateTitles: s.duplicateTitles ?? [],
    placeholderHits,
  };
}

/** state.ts CoverageLayer ← gate CoverageResult. */
function toCoverageLayer(c: CoverageResult): CoverageLayer {
  const checklist: CoverageItem[] = (c.checklist ?? []).map((i) => ({
    area: i.area,
    requirementKey: i.requirementKey,
    expectedScenario: i.expectedScenario,
    covered: i.covered,
    evidenceTestId: i.evidenceTestId,
  }));
  return {
    checklist,
    total: c.total,
    covered: c.covered,
    verifiedCoverageRatio: c.ratio, // gate names the VCR `.ratio`; canonical names it `.verifiedCoverageRatio`
  };
}

/** Map the gate's verdict literal to the canonical state.ts literal. */
function toCriticVerdict(v: GateGateResult['verdict']): CriticVerdict {
  return v === 'needs_improvement' ? 'needs_work' : v; // 'approved' | 'rejected' pass through
}

/**
 * Run the deterministic gate (L3 trust anchor) and adapt its result to the
 * canonical GateResult. The gate owns structure, coverage, the recomputed
 * overall, AND the base verdict; THIS function additionally enforces the
 * canonical DoD's `maxBlockerGaps` (the gate type has no such field) by
 * appending a blocking reason and demoting 'approved' if too many blocker gaps
 * remain. There is still NO model-writable path to the verdict.
 */
function runCriticGate(
  structural: StructuralResult,
  semantic: SemanticLayer,
  coverage: CoverageResult,
  gaps: CriticGap[],
  dod: DefinitionOfDone,
): GateResult {
  // Feed the gate its own (dict-shaped) semantic + the gate-flavoured DoD.
  const gateSemantic: SemanticScores = {
    dimensions: toScoreDict(semantic.dimensions) as Partial<Record<GateRubricKey, number>>,
    modelClaimedOverall: semantic.modelClaimedOverall,
  };
  const gateDod: GateDefinitionOfDone = {
    minOverall: dod.minOverall,
    minStructuralRatio: dod.minStructuralRatio,
    minVerifiedCoverageRatio: dod.minVerifiedCoverageRatio,
    perDimensionFloor: dod.perDimensionFloor,
  };
  const base = runGate(structural, gateSemantic, coverage, gateDod);

  const reasons = [...base.blockingReasons];

  // L7 — enforce the blocker-gap ceiling the canonical DoD adds.
  const blockerCount = gaps.filter((gp: CriticGap) => gp.severity === 'blocker').length;
  if (blockerCount > dod.maxBlockerGaps) {
    reasons.push(`${blockerCount} blocker gap(s) > allowed ${dod.maxBlockerGaps}`);
  }

  // 'approved' survives ONLY when no reason blocks it (including the gap ceiling).
  const verdict: CriticVerdict =
    reasons.length === 0
      ? 'approved'
      : toCriticVerdict(base.verdict === 'approved' ? 'needs_improvement' : base.verdict);

  return {
    verdict,
    computedOverall: base.computedOverall,
    verifiedCoverageRatio: base.verifiedCoverageRatio,
    structuralRatio: base.structuralRatio,
    blockingReasons: reasons,
    thresholdsApplied: dod,
  };
}

// ═════════════════════════════════════════════════════════════════════════
// L7 — AGENT-ORIENTED GAP BUILDER. Folds every uncovered coverage item,
// structural failure, below-floor dimension, and model-proposed semantic gap
// into a single CriticGap list, each carrying WHAT + WHY + a concrete repair
// {feature,type,priority,title,rationale}. Stable ids (hash of the source) so
// the loop's sameFindings guard (L10) can compare top-gap sets across iterations.
// ═════════════════════════════════════════════════════════════════════════

/** Tiny deterministic hash → short stable id (no Date/random; idempotent, L11). */
function stableId(prefix: string, ...parts: string[]): string {
  const s = parts.join('|');
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return `${prefix}-${(h >>> 0).toString(36)}`;
}

/** Derive a concrete repair scenario from an uncovered coverage checklist item. */
function repairFromCoverage(item: CoverageItem): CriticGap['repair'] {
  const featureGuess = item.requirementKey.includes(':')
    ? item.requirementKey.split(':').slice(1).join(':')
    : item.requirementKey;
  const typeByArea: Record<CoverageItem['area'], TestCase['type']> = {
    feature: 'positive',
    flow: 'e2e',
    edgeCase: 'edge',
    nfr: 'security',
    deniedPersona: 'negative',
  };
  const titleSeed = item.expectedScenario.replace(/^A(n)?\s+/i, '').trim();
  const title = /^verify\b/i.test(titleSeed) ? titleSeed : `Verify ${titleSeed}`;
  return {
    feature: featureGuess || 'General',
    type: typeByArea[item.area],
    priority: item.area === 'feature' || item.area === 'flow' ? 'P1' : 'P2',
    title: title.slice(0, 160),
    rationale: `Requirement "${item.requirementKey}" has no corresponding test; closing it raises verified coverage.`,
  };
}

function buildGaps(
  structural: StructuralResult,
  semantic: SemanticResult,
  coverage: CoverageResult,
  dod: DefinitionOfDone,
): CriticGap[] {
  const gaps: CriticGap[] = [];

  // (a) Coverage gaps — one per uncovered checklist item (L6 → L7).
  for (const item of coverage.uncovered ?? []) {
    gaps.push({
      id: stableId('cov', item.area, item.requirementKey),
      sourceLayer: 'coverage',
      severity:
        item.area === 'feature' || item.area === 'flow' || item.area === 'deniedPersona' ? 'blocker' : 'major',
      what: `Uncovered ${item.area}: ${item.requirementKey}`,
      why: `No test exercises this requirement, so the gate's verified coverage ratio cannot reach the target.`,
      repair: repairFromCoverage(item),
    });
  }

  // (b) Model-proposed semantic gaps — carry the model's concrete repair (L7).
  for (const g of semantic.gaps) {
    const sev: CriticGap['severity'] =
      g.severity === 'blocker' || g.severity === 'major' || g.severity === 'minor' ? g.severity : 'major';
    gaps.push({
      id: stableId('sem', g.sourceArea ?? 'semantic', g.repair.title),
      sourceLayer: 'semantic',
      severity: sev,
      what: String(g.what || '').trim() || `Semantic weakness in ${g.sourceArea}`,
      why: String(g.why || '').trim() || 'Reduces design quality of the suite.',
      repair: {
        feature: g.repair.feature || 'General',
        type: (VALID_TYPES as string[]).includes(g.repair.type) ? g.repair.type : 'positive',
        priority: (VALID_PRIORITIES as string[]).includes(g.repair.priority) ? g.repair.priority : 'P2',
        title: /^verify\b/i.test(g.repair.title || '') ? g.repair.title : `Verify ${g.repair.title || 'scenario'}`,
        rationale: String(g.repair.rationale || '').trim() || 'Closes a design weakness the reviewer flagged.',
      },
    });
  }

  // (c) Below-floor dimensions — surface as advisory gaps (the concrete fix is
  //     qualitative; the model's gaps above carry the concrete scenarios). These
  //     still feed sameFindings/observability.
  for (const d of semantic.layer.dimensions) {
    if (clampScore(d.score) < dod.perDimensionFloor) {
      gaps.push({
        id: stableId('dim', d.key),
        sourceLayer: 'semantic',
        severity: 'major',
        what: `Dimension "${d.key}" scored ${clampScore(d.score)} (< floor ${dod.perDimensionFloor})`,
        why: d.justification || 'A fatal rubric dimension drags the suite below the Definition of Done.',
        repair: {
          feature: 'General',
          type: 'positive',
          priority: 'P2',
          title: `Verify improvements addressing weak ${d.key} (offenders: ${(d.weakestTestIds || []).slice(0, 3).join(', ') || 'suite-wide'})`,
          rationale: `Raise the "${d.key}" dimension above the ${dod.perDimensionFloor} floor.`,
        },
      });
    }
  }

  // (d) Structural failures — deterministic, AI-independent (L4 Layer1 → L7).
  for (const f of structural.violations ?? []) {
    gaps.push({
      id: stableId('struct', f.testId, f.problems[0] ?? ''),
      sourceLayer: 'structural',
      severity: 'blocker',
      what: `Structural violation in ${f.testId}: ${f.problems.join('; ')}`,
      why: 'Structurally invalid cases cannot be trusted and block the structural floor.',
      repair: {
        feature: 'General',
        type: 'positive',
        priority: 'P1',
        title: `Verify a corrected replacement for ${f.testId} satisfying all structural invariants`,
        rationale: 'Replace/repair the invalid case so the structural ratio reaches 1.0.',
      },
    });
  }

  return gaps;
}

// ═════════════════════════════════════════════════════════════════════════
// CORE — critiqueTestCases: pure, decoupled from TestOpsState so the gate is
// reusable from pipeline, routes, worker, tests, or a future REST endpoint.
// Runs Layer1 (deterministic) + Layer2 (AI) + Layer3 (deterministic), builds
// gaps, runs the deterministic gate, and assembles a single-iteration report
// carrying ONE trace entry (L8).
// ═════════════════════════════════════════════════════════════════════════

export interface CritiqueInput {
  parsedRequirements: ParsedRequirements;
  testCases: TestCase[];
  dod?: DefinitionOfDone;
}

/**
 * One full critique (Layer1 + Layer2 + Layer3 + gaps + deterministic gate),
 * assembled into a CriticReport with a single trace entry. No loop, no
 * regeneration. `new Date().toISOString()` is allowed here (Node context) and
 * only stamps the report's generatedAtIso — it never feeds the pure gate, so
 * the verdict stays reproducible (L11).
 */
export async function critiqueTestCases(input: CritiqueInput): Promise<CriticReport> {
  const dod = input.dod ?? CRITIC_DOD;
  const testCases = input.testCases;
  const pr = input.parsedRequirements;

  const t0 = Date.now();

  // Layer 1 — STRUCTURAL (deterministic, no AI).
  const structuralRaw = checkStructuralValidity(testCases);
  // Layer 3 — COVERAGE (deterministic, no AI).
  const coverageRaw = computeCoverage(testCases, pr);
  // Layer 2 — SEMANTIC (one AI call; recomputed overall in code).
  const semantic = await runSemanticRubricFull(pr, testCases);

  // L7 — agent-oriented gaps with concrete repairs (feeds regeneration).
  const gaps = buildGaps(structuralRaw, semantic, coverageRaw, dod);
  // L3 — deterministic gate is the SOLE producer of 'approved'.
  const gate = runCriticGate(structuralRaw, semantic.layer, coverageRaw, gaps, dod);

  const structural = toStructuralLayer(structuralRaw);
  const coverage = toCoverageLayer(coverageRaw);

  const trace: CriticIterationTrace[] = [
    makeTraceEntry({
      iteration: 0,
      gate,
      semantic: semantic.layer,
      coverage,
      structural,
      gapsFound: gaps.length,
      gapsClosed: 0,
      regeneratedTitles: [],
      costUsdCumulative: RUBRIC_EST_USD,
      durationMs: Date.now() - t0,
      exitReason: gate.verdict === 'approved' ? 'approved' : undefined,
    }),
  ];

  return assembleReport({
    structural,
    semantic: semantic.layer,
    coverage,
    gaps,
    gate,
    trace,
    bestIteration: 0,
    iterationsRun: 1,
    dod,
    testCaseCountBefore: testCases.length,
    testCaseCountAfter: testCases.length,
    addedTestCaseIds: [],
    // One-shot critique: 'approved' if the gate cleared it, else the single
    // allotted iteration is its bound — report it as 'maxIterations'.
    exitReason: gate.verdict === 'approved' ? 'approved' : 'maxIterations',
  });
}

/** Thin state adapter — one-shot critique over a TestOpsState (no loop). */
export async function critiqueOnce(state: TestOpsState, dod?: DefinitionOfDone): Promise<CriticReport> {
  if (!state.parsedRequirements) {
    throw new Error('criticAgent: state.parsedRequirements is null — run requirementAgent first');
  }
  return critiqueTestCases({ parsedRequirements: state.parsedRequirements, testCases: state.testCases, dod });
}

/**
 * Additive wrapper (L12): attaches state.criticReport from a single critique
 * (NO loop, NO regeneration). Returns the caller's state untouched on any
 * failure so the pipeline never crashes and no partial report leaks (L11).
 */
export async function criticAgent(state: TestOpsState, onProgress?: GenProgress): Promise<TestOpsState> {
  const emit: GenProgress = onProgress ?? (() => {});
  if (!state.parsedRequirements) return state;
  try {
    emit('test-design', 'running', 'Critiquing generated test cases…');
    const report = await critiqueOnce(state);
    emit(
      'test-design',
      'running',
      `Critic: ${report.gate.verdict} — score ${report.gate.computedOverall}/100, coverage ${Math.round(report.coverage.verifiedCoverageRatio * 100)}%`,
    );
    return { ...state, criticReport: report };
  } catch (e) {
    console.error('[critic] critique failed, proceeding without report:', (e as Error)?.message);
    return state;
  }
}

// ═════════════════════════════════════════════════════════════════════════
// L10 — BOUNDED RALPH LOOP. critique → if verdict !== 'approved' && guards
// permit, regenerate ONLY the top-K gap scenarios (non-destructive append, L11)
// → re-critique. Honours maxIterations / minScoreDelta / sameFindings / budget,
// accumulates the trace (L8), and ALWAYS returns the best report + exitReason.
//
// WORST-CASE TERMINATION PROOF (model returns the same low scores forever and
// regen never closes a gap): three INDEPENDENT monotone bounds each force a
// return — (iter↑) the for-loop hits maxIterations; (calls↑/spend↑) the budget
// caps are checked BEFORE every Claude call; (score/gap plateau) sameFindings,
// notDecreasing and noProgress fire once the history fills. Every path reaches a
// finish() that returns the BEST report + an explicit exitReason. The loop
// provably halts.
// ═════════════════════════════════════════════════════════════════════════

export interface CriticLoopOptions {
  onProgress?: GenProgress;
  dod?: DefinitionOfDone;
  guards?: typeof CRITIC_GUARDS;
}

export async function runCriticImprovementLoop(
  state: TestOpsState,
  opts?: CriticLoopOptions,
): Promise<{ state: TestOpsState; report: CriticReport }> {
  const dod = opts?.dod ?? CRITIC_DOD;
  const g = opts?.guards ?? CRITIC_GUARDS;
  const onProgress: GenProgress = opts?.onProgress ?? (() => {});

  if (!state.parsedRequirements) {
    throw new Error('runCriticImprovementLoop: state.parsedRequirements is null');
  }
  const pr = state.parsedRequirements;

  // NEVER mutate the caller's array (L11). Work on a local copy and APPEND only.
  let working: TestOpsState = { ...state, testCases: [...state.testCases] };
  const beforeCount = working.testCases.length;
  const addedIds: string[] = [];

  const trace: CriticIterationTrace[] = [];
  let best: { report: CriticReport; overall: number; vcr: number } | null = null;
  let prevTopGapIds: string[] = [];
  const overallHistory: number[] = [];
  let spentUsd = 0;
  let calls = 0;
  let lastRegen: string[] = [];

  // Bounded hard for-loop (the unconditional backstop terminator, L10).
  // iter 0 = the initial critique of the generator's raw output.
  for (let iter = 0; iter <= g.maxIterations; iter++) {
    const tIter = Date.now();

    // (1) THREE LAYERS — Layer1 & Layer3 deterministic; Layer2 = one Claude call.
    const structuralRaw = checkStructuralValidity(working.testCases);
    const coverageRaw = computeCoverage(working.testCases, pr);

    if (calls >= g.budgetMaxClaudeCalls) {
      return finish('budgetExhausted'); // guard BEFORE the AI call
    }
    let semantic: SemanticResult;
    try {
      semantic = await runSemanticRubricFull(pr, working.testCases);
    } catch (e) {
      console.error('[critic] semantic rubric failed:', (e as Error)?.message);
      return finish('regenerationFailed'); // L11 — return best-so-far, no partial leak
    }
    calls++;
    spentUsd += RUBRIC_EST_USD;

    // (2) GAPS (L7) + (3) GATE (L3 — the trust anchor).
    const gaps = buildGaps(structuralRaw, semantic, coverageRaw, dod);
    const gate = runCriticGate(structuralRaw, semantic.layer, coverageRaw, gaps, dod);
    const overall = gate.computedOverall;
    overallHistory.push(overall);

    const structural = toStructuralLayer(structuralRaw);
    const coverage = toCoverageLayer(coverageRaw);

    // gapsClosed = previous top gaps no longer present this iteration (by id).
    const gapsClosed = prevTopGapIds.length
      ? prevTopGapIds.filter((id) => !gaps.some((x: CriticGap) => x.id === id)).length
      : 0;

    const report = assembleReport({
      structural,
      semantic: semantic.layer,
      coverage,
      gaps,
      gate,
      trace,            // history BEFORE this entry (the entry is pushed below)
      bestIteration: iter,
      iterationsRun: trace.length + 1,
      dod,
      testCaseCountBefore: beforeCount,
      testCaseCountAfter: working.testCases.length,
      addedTestCaseIds: [...addedIds],
      exitReason: 'maxIterations', // provisional; finish() overwrites with the real reason
    });

    // Keep the BEST report — highest overall, tie-broken by higher VCR.
    if (!best || overall > best.overall || (overall === best.overall && gate.verifiedCoverageRatio > best.vcr)) {
      best = { report, overall, vcr: gate.verifiedCoverageRatio };
    }

    const topGapIds = gaps.slice(0, g.topKGapsPerIteration).map((x: CriticGap) => x.id).sort();

    trace.push(
      makeTraceEntry({
        iteration: iter,
        gate,
        semantic: semantic.layer,
        coverage,
        structural,
        gapsFound: gaps.length,
        gapsClosed,
        regeneratedTitles: lastRegen,
        costUsdCumulative: spentUsd,
        durationMs: Date.now() - tIter,
      }),
    );

    onProgress(
      'test-design',
      'running',
      `Critic iter ${iter}: score ${overall}/100, coverage ${Math.round(coverage.verifiedCoverageRatio * 100)}%, ${gaps.length} gap(s), ${gapsClosed} closed`,
    );

    // (4) EXIT CHECKS — each returns the BEST report + exitReason.
    if (gate.verdict === 'approved') return finish('approved');                 // the only success exit
    if (iter === g.maxIterations) return finish('maxIterations');               // hard bound
    if (prevTopGapIds.length && arraysEqual(topGapIds, prevTopGapIds)) {
      return finish('sameFindings');                                            // identical top gaps recurred
    }
    if (
      overallHistory.length >= g.notDecreasingWindow &&
      overall - overallHistory[overallHistory.length - g.notDecreasingWindow] < g.minScoreDelta
    ) {
      return finish('notDecreasing');                                           // score plateaued
    }
    if (spentUsd >= g.budgetCapUsd) return finish('budgetExhausted');           // monetary cap

    const topGaps = gaps.slice(0, g.topKGapsPerIteration).filter((x: CriticGap) => x.repair);
    if (topGaps.length === 0) return finish('noProgress');                      // nothing actionable to fix

    // (5) SMALL TARGETED REGEN — self-contained mirror of the generator retry
    // pass. generatorAgent stays byte-for-byte untouched.
    if (calls >= g.budgetMaxClaudeCalls) return finish('budgetExhausted');
    const excludeTitles = working.testCases.map((tc) => tc.title);
    let newCases: TestCase[];
    try {
      newCases = await regenerateForGaps(working, topGaps, excludeTitles);
    } catch (e) {
      console.error('[critic] targeted regeneration failed:', (e as Error)?.message);
      return finish('regenerationFailed');
    }
    calls++;
    spentUsd += REGEN_EST_USD;

    // SAME dedup the generator retry pass uses — appended cases can't duplicate.
    const existingSet = new Set(excludeTitles.map((s) => s.toLowerCase().trim()));
    newCases = newCases.filter((tc) => !existingSet.has(tc.title.toLowerCase().trim()));
    if (newCases.length === 0) return finish('noProgress');                     // regen closed zero gaps

    onProgress('test-design', 'running', `Regenerating ${newCases.length} case(s) to close gaps…`);

    working = { ...working, testCases: [...working.testCases, ...newCases] };   // APPEND only (L11)
    addedIds.push(...newCases.map((c) => c.id));
    lastRegen = newCases.map((c) => c.title);
    prevTopGapIds = topGapIds;
  }

  // Unreachable in practice — the for-loop's `iter === g.maxIterations` check
  // returns first — but a defensive terminator keeps the function total.
  return finish('maxIterations');

  /**
   * Stamp the terminal exitReason onto the best report + its last trace entry,
   * patch the additive append-tracking fields, and return the loop result with
   * criticReport attached (L11 — assembled locally, attached only on exit).
   */
  function finish(reason: CriticExitReason): { state: TestOpsState; report: CriticReport } {
    // Guarantee a report even on the earliest possible budget exit (calls
    // already exhausted before iter 0 ever produced one).
    if (!best) {
      const structuralRaw = checkStructuralValidity(working.testCases);
      const coverageRaw = computeCoverage(working.testCases, pr);
      const semantic = emptySemantic();
      const gaps = buildGaps(structuralRaw, semantic, coverageRaw, dod);
      const gate = runCriticGate(structuralRaw, semantic.layer, coverageRaw, gaps, dod);
      const fallback = assembleReport({
        structural: toStructuralLayer(structuralRaw),
        semantic: semantic.layer,
        coverage: toCoverageLayer(coverageRaw),
        gaps,
        gate,
        trace: [],
        bestIteration: 0,
        iterationsRun: trace.length,
        dod,
        testCaseCountBefore: beforeCount,
        testCaseCountAfter: working.testCases.length,
        addedTestCaseIds: [...addedIds],
        exitReason: reason,
      });
      best = { report: fallback, overall: gate.computedOverall, vcr: gate.verifiedCoverageRatio };
    }

    if (trace.length > 0) trace[trace.length - 1].exitReason = reason;

    const report: CriticReport = {
      ...best.report,
      trace: [...trace],
      exitReason: reason,
      iterationsRun: trace.length,
      addedTestCaseIds: [...addedIds],
      testCaseCountBefore: beforeCount,
      testCaseCountAfter: working.testCases.length,
    };

    onProgress(
      'test-design',
      'running',
      `Critic finished: ${report.gate.verdict} (${reason}) — score ${report.gate.computedOverall}/100, coverage ${Math.round(report.coverage.verifiedCoverageRatio * 100)}%, +${addedIds.length} case(s)`,
    );

    return { state: { ...working, criticReport: report }, report };
  }
}

// ─────────────────────────────────────────────────────────────────────────
// SELF-CONTAINED TARGETED REGENERATION — mirrors generatorAgent's retry pass
// WITHOUT importing or modifying it (its buildPrompt/coerceTestCase are
// module-private in the running copy). Assigns critic-namespaced TC-CR-### ids
// so they never collide with the generator's TC-### counter.
// ─────────────────────────────────────────────────────────────────────────

let critofCounter = 0;
function nextCriticId(): string { return `TC-CR-${String(++critofCounter).padStart(3, '0')}`; }

/** Loose shape Claude returns for a regenerated case — normalised below. */
type RawRegenCase = {
  traceabilityId?: string;
  module?: string;
  submodule?: string;
  feature?: string;
  title?: string;
  scenario?: string;
  description?: string;
  precondition?: string;
  testData?: Record<string, string>;
  testSteps?: { step?: number; action?: string; expected?: string; testData?: string }[];
  steps?: string[];
  expectedResult?: string;
  type?: string;
  priority?: string;
  severity?: string;
  tags?: string[];
};

/** Critic-local coercion — same normalisation contract as the generator,
 *  but with TC-CR-### ids. Keeps appended cases shape-identical to originals. */
function coerceCriticCase(raw: RawRegenCase): TestCase {
  const title = (raw.title || raw.scenario || 'Untitled test case').trim();
  const testSteps: TestStep[] = Array.isArray(raw.testSteps) && raw.testSteps.length > 0
    ? raw.testSteps
        .map((s, i) => ({
          step: s.step ?? i + 1,
          action: String(s.action || '').trim(),
          expected: String(s.expected || '').trim(),
          testData: s.testData,
        }))
        .filter((s) => s.action)
    : [];

  const stringSteps: string[] = testSteps.length > 0
    ? testSteps.map((s) => `${s.step}. ${s.action}${s.expected ? ` → Expected: ${s.expected}` : ''}`)
    : (Array.isArray(raw.steps) ? raw.steps : [title]);

  const type: TestCase['type'] = (VALID_TYPES as string[]).includes(raw.type ?? '')
    ? (raw.type as TestCase['type'])
    : 'positive';
  const priority: TestCase['priority'] = (VALID_PRIORITIES as string[]).includes(raw.priority ?? '')
    ? (raw.priority as TestCase['priority'])
    : 'P1';
  const severity: TestCase['severity'] | undefined =
    raw.severity && (VALID_SEVERITIES as string[]).includes(raw.severity)
      ? (raw.severity as TestCase['severity'])
      : undefined;

  return {
    id: nextCriticId(),
    traceabilityId: raw.traceabilityId,
    module: raw.module,
    submodule: raw.submodule,
    feature: raw.feature || 'General',
    title,
    scenario: title,
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

/**
 * Build a gap-targeted prompt that MIRRORS the generator's retry idiom: the
 * structured requirements as anchor, the exact top-K repair scenarios the
 * critic demands, and the excludeTitles exclusion block. The model returns ONLY
 * the new cases. runClaudePrompt is bounded at maxTokens 8192 (smaller than the
 * generator's 16384 — this is a small targeted batch, L10).
 */
async function regenerateForGaps(
  state: TestOpsState,
  topGaps: CriticGap[],
  excludeTitles: string[],
): Promise<TestCase[]> {
  const pr = state.parsedRequirements!;
  const appInfo = state.appContext
    ? `Application: ${state.appContext.appName || 'Web App'}\nURL: ${state.appContext.targetUrl || 'Not specified'}\nEnvironment: ${state.appContext.environment || 'staging'}`
    : '';

  const repairLines = topGaps
    .map((gp) => `- [${gp.repair.type}/${gp.repair.priority}] ${gp.repair.title} — ${gp.repair.rationale}`)
    .join('\n');

  const exclusionBlock = excludeTitles.length > 0
    ? `\n\nALREADY GENERATED — DO NOT REPEAT THESE TITLES (case-insensitive):\n${excludeTitles
        .map((s) => `- ${s}`)
        .join('\n')}\nGenerate only NEW scenarios not in the above list.`
    : '';

  const prompt = `You are a Senior QA Engineer closing SPECIFIC coverage and quality gaps an adversarial QA-lead reviewer flagged in an existing test suite. Produce ONLY the missing test cases — one per gap below — at the same IEEE-829 / ISTQB quality bar as the rest of the suite. There is ZERO tolerance for placeholders, generic phrasing, or missing fields.

═══════════════════════════════════════════════════════════════
STRUCTURED REQUIREMENTS (source of truth):
═══════════════════════════════════════════════════════════════
${JSON.stringify(pr, null, 2)}

CONTEXT:
${appInfo}
Source requirements: ${state.requirements.slice(0, 1200)}${state.requirements.length > 1200 ? '…' : ''}

═══════════════════════════════════════════════════════════════
GAPS TO CLOSE (write exactly one focused test case for each):
═══════════════════════════════════════════════════════════════
${repairLines}
${exclusionBlock}

═══════════════════════════════════════════════════════════════
QUALITY RULES (every case must satisfy these — incomplete cases are rejected):
═══════════════════════════════════════════════════════════════
1. TITLE: Start with "Verify ". Be specific and unique. Use (or sharpen) the gap's title.
2. PRECONDITION: Full sentences covering data state, user/role state, and system state.
3. TEST DATA: CONCRETE, REALISTIC values ("alice@example.com", "Test@1234", "ORDER-2024-0042"). Never placeholders like "<email>" or "{password}". For negatives use a specifically-rejectable value ("alice@" or "' OR '1'='1'", not "bad email").
4. TEST STEPS: Numbered testSteps; each action imperative present-tense, names the exact UI element by visible label/role/test-id, and has its OWN non-blank expected. 3-12 steps.
5. EXPECTED RESULT: The TRUE success criterion for the case type. A negative/security test asserts the real rejection (stays on the login URL + error visible + protected area NOT reached), never a brittle implementation-detail check.
6. ATOMICITY: Each case verifies exactly ONE behaviour; multi-step journeys are typed "e2e".
7. TYPE: positive | negative | edge | e2e | api | data | smoke | security | accessibility | performance — match the gap's requested type.
8. PRIORITY: P0|P1|P2|P3 — match the gap's requested priority.

OUTPUT — Return ONLY a valid JSON array of the new test cases (no markdown, no commentary), each object using the fields: traceabilityId, module, submodule, feature, title, description, precondition, testData, testSteps[{step,action,expected,testData}], expectedResult, type, priority, severity, tags.

GENERATE NOW. Return the JSON array directly.`;

  const response = await runClaudePrompt(prompt, { maxTokens: 8192 });
  const parsed = parseJsonFromResponse<RawRegenCase[]>(response);
  if (!Array.isArray(parsed) || parsed.length === 0) return [];
  return parsed.map(coerceCriticCase);
}

// ─────────────────────────────────────────────────────────────────────────
// Report / trace assembly helpers (pure aside from new Date().toISOString()).
// ─────────────────────────────────────────────────────────────────────────

interface TraceArgs {
  iteration: number;
  gate: GateResult;
  semantic: SemanticLayer;
  coverage: CoverageLayer;
  structural: StructuralLayer;
  gapsFound: number;
  gapsClosed: number;
  regeneratedTitles: string[];
  costUsdCumulative: number;
  durationMs: number;
  exitReason?: CriticExitReason;
}

function makeTraceEntry(a: TraceArgs): CriticIterationTrace {
  const dimensionScores = {} as Record<RubricKey, number>;
  for (const key of ALL_DIMENSIONS) dimensionScores[key] = 50; // conservative default
  for (const d of a.semantic.dimensions) dimensionScores[d.key] = clampScore(d.score);

  return {
    iteration: a.iteration,
    computedOverall: a.gate.computedOverall,
    dimensionScores,
    verifiedCoverageRatio: a.coverage.verifiedCoverageRatio,
    structuralRatio: a.structural.ratio,
    gapsFound: a.gapsFound,
    gapsClosed: a.gapsClosed,
    regeneratedTitles: a.regeneratedTitles,
    verdict: a.gate.verdict,
    exitReason: a.exitReason,
    costUsdCumulative: a.costUsdCumulative,
    durationMs: a.durationMs,
  };
}

interface AssembleArgs {
  structural: StructuralLayer;
  semantic: SemanticLayer;
  coverage: CoverageLayer;
  gaps: CriticGap[];
  gate: GateResult;
  trace: CriticIterationTrace[];
  bestIteration: number;
  iterationsRun: number;
  dod: DefinitionOfDone;
  testCaseCountBefore: number;
  testCaseCountAfter: number;
  addedTestCaseIds: string[];
  exitReason: CriticExitReason;
}

function assembleReport(a: AssembleArgs): CriticReport {
  return {
    scopeNote: HONEST_SCOPE_NOTE,
    structural: a.structural,
    semantic: a.semantic,
    coverage: a.coverage,
    gaps: a.gaps,
    gate: a.gate,
    trace: a.trace,
    exitReason: a.exitReason,
    bestIteration: a.bestIteration,
    iterationsRun: a.iterationsRun,
    definitionOfDone: a.dod,
    testCaseCountBefore: a.testCaseCountBefore,
    testCaseCountAfter: a.testCaseCountAfter,
    addedTestCaseIds: a.addedTestCaseIds,
    generatedAtIso: new Date().toISOString(),
  };
}

/** A conservative all-50 semantic result for the no-AI fallback path (used only
 *  when the budget is exhausted before any rubric call could run). */
function emptySemantic(): SemanticResult {
  const dimensions: DimensionScore[] = ALL_DIMENSIONS.map((key) => ({
    key,
    score: 50,
    weight: WEIGHTS[key] ?? 0,
    justification: 'rubric not run (budget exhausted before any critique) — conservative default',
    weakestTestIds: [],
  }));
  const layer: SemanticLayer = {
    dimensions,
    overallScore: recomputeWeightedScore(toScoreDict(dimensions) as Partial<Record<GateRubricKey, number>>),
    modelClaimedOverall: undefined,
  };
  return { layer, gaps: [] };
}

function arraysEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
