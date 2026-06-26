# AI Critic Loop — Rework Plan

**Status:** REMOVED from active code on 2026-06-27 so it does not affect the AI orchestration.
The full implementation is **preserved** (out of the build) in `backend/_archived_ai_critic/` and can
be reinstated by following this document. Nothing was lost.

The pipeline is currently the clean 6-stage flow:

```
Requirement Analysis → Test Design → Script Generation → Execution & Validation → Auto-Healing → Report Generation
```

When reinstated, it becomes 8 stages (two "AI Critic Loop" stages):

```
Requirement Analysis → Test Design → AI Critic Loop → Script Generation → AI Critic Loop → Execution & Validation → Auto-Healing → Report Generation
```

---

## 1. What it does

An independent, skeptical reviewer of the AI-generated artifacts, built to the *walkinglabs Harness
Engineering* 12 laws. Two stages:

- **Stage A — AI Critic Loop (after Test Design):** critiques the **test cases** (design quality +
  requirement coverage). One AI rubric call + a **deterministic gate** that owns the verdict.
- **Stage B — AI Critic Loop (after Script Generation):** critiques the **generated scripts** —
  **purely deterministic** Playwright-quality checks (no AI call, instant).

**Trust model (the point of it):** the model only *proposes* dimension scores + concrete gaps; a
deterministic gate (`critic-gate.ts`) computes the verdict. `approved` requires: structural validity
= 100%, requirement coverage (VCR) ≥ target, recomputed weighted score ≥ min, no dimension below
floor, and ≤ max blocker gaps. It certifies test **design** — runtime pass/fail stays with
execution + healing. It is **review-only** (no regeneration — that would orphan the scripts).

**Known cost:** Stage A adds one Sonnet/Opus call (~latency of one agent). Stage B is instant.

---

## 2. Preserved files (in `backend/_archived_ai_critic/`)

| Archived path | Restore to | Role |
|---|---|---|
| `agents/critic-gate.ts` | `backend/src/agents/critic-gate.ts` | PURE deterministic trust anchor — structural + coverage checks, weighted-score recompute, the gate (owns the verdict). No AI. |
| `agents/critic-prompt.ts` | `backend/src/agents/critic-prompt.ts` | Adversarial rubric prompt + `DIMENSION_ANCHORS` + `CriticSemanticResponse` type. |
| `agents/criticAgent.ts` | `backend/src/agents/criticAgent.ts` | `critiqueTestCases()` (reusable), `criticAgent(state)`, `runCriticImprovementLoop()` (bounded RALPH loop, currently unused by the 2-stage UI flow). |
| `agents/critic-script.ts` | `backend/src/agents/critic-script.ts` | PURE deterministic Playwright-script quality check (`checkScriptQuality`). |
| `routes/critic.routes.ts` | `backend/src/routes/critic.routes.ts` | `POST /api/critic/run` → `{ verdict, designScore, scriptScore, design, scripts }`. Combines only the layers actually evaluated. |

> These files import the `CriticReport` type graph from `../state.js`. That graph was removed from
> `state.ts` — **§4 below has the exact block to paste back** or they will not compile.

---

## 3. Re-wiring — BACKEND

1. **Move the files back:**
   ```bash
   cd backend
   mv _archived_ai_critic/agents/*.ts src/agents/
   mv _archived_ai_critic/routes/critic.routes.ts src/routes/
   rmdir _archived_ai_critic/agents _archived_ai_critic/routes _archived_ai_critic
   ```

2. **`src/agents/state.ts`** — re-add the `CriticReport` type graph (paste the block from §4 at the
   very top, before `export interface TestFieldData {`), then add to `TestOpsState` (before the
   closing `}`):
   ```ts
     criticReport?: CriticReport | null;
   ```
   and to `createInitialState`'s returned object:
   ```ts
       criticReport: null,
   ```

3. **`src/index.ts`** — add the import (next to the other route imports) and mount it (next to
   `automation-scripts`):
   ```ts
   import criticRoutes from './routes/critic.routes.js';
   // ...
   app.use('/api/critic', authMiddleware, criticRoutes);
   ```

> No change to `pipeline.ts` is required for the 2-stage UI flow — the critic is driven from the
> frontend via `POST /api/critic/run`. (An optional in-generation path exists via
> `runCriticImprovementLoop`, gated behind `CRITIC_ENABLED`; not used by the 2-stage flow.)

### Gate tuning env vars (optional)
`CRITIC_MIN_SCORE` (80), `CRITIC_MIN_COVERAGE` (1.0), `CRITIC_MIN_STRUCTURAL` (1.0),
`CRITIC_DIM_FLOOR` (60), `CRITIC_MAX_BLOCKER_GAPS` (0), plus coverage-overlap knobs in
`critic-gate.ts`.

---

## 4. `state.ts` — the CriticReport type graph to paste back (at top of file)

```ts
// ── AI Critic Agent — quality-gate report types (canonical declarer). ──
// critic-prompt.ts and criticAgent.ts import these directly from './state.js'.

export type CriticVerdict = 'approved' | 'needs_work' | 'rejected';

export type RubricKey =
  | 'clarity' | 'correctness' | 'atomicity'
  | 'dataConcreteness' | 'coverageDepth' | 'nonAmbiguity';

export interface DimensionScore {
  key: RubricKey;
  score: number;            // 0-100, AI-proposed, clamped in code
  weight: number;           // from config — NOT model-chosen
  justification: string;
  weakestTestIds: string[];
}

export interface StructuralLayer {
  totalCases: number;
  passed: number;
  ratio: number;            // passed / totalCases (gate floor)
  failures: { testId: string; violations: string[] }[];
  duplicateTitles: string[];
  placeholderHits: { testId: string; field: string; value: string }[];
}

export interface SemanticLayer {
  dimensions: DimensionScore[];
  overallScore: number;     // RECOMPUTED in code (weighted)
  modelClaimedOverall?: number; // recorded, never trusted
}

export interface CoverageItem {
  area: 'feature' | 'flow' | 'edgeCase' | 'nfr' | 'deniedPersona';
  requirementKey: string;
  expectedScenario: string;
  covered: boolean;
  evidenceTestId?: string;
}

export interface CoverageLayer {
  checklist: CoverageItem[];
  total: number;
  covered: number;
  verifiedCoverageRatio: number; // covered / total (VCR)
}

export interface CriticGap {
  id: string;               // stable hash — for sameFindings
  sourceLayer: 'structural' | 'semantic' | 'coverage';
  severity: 'blocker' | 'major' | 'minor';
  what: string;
  why: string;
  repair: {
    feature: string;
    type: TestCase['type'];
    priority: TestCase['priority'];
    title: string;
    rationale: string;
  };
}

export interface DefinitionOfDone {
  minOverall: number;
  minStructuralRatio: number;
  minVerifiedCoverageRatio: number;
  perDimensionFloor: number;
  maxBlockerGaps: number;
}

export interface GateResult {
  verdict: CriticVerdict;   // 'approved' ONLY from the gate
  computedOverall: number;
  verifiedCoverageRatio: number;
  structuralRatio: number;
  blockingReasons: string[];
  thresholdsApplied: DefinitionOfDone;
}

export type CriticExitReason =
  | 'approved' | 'maxIterations' | 'notDecreasing' | 'sameFindings'
  | 'budgetExhausted' | 'noProgress' | 'regenerationFailed';

export interface CriticIterationTrace {
  iteration: number;
  computedOverall: number;
  dimensionScores: Record<RubricKey, number>;
  verifiedCoverageRatio: number;
  structuralRatio: number;
  gapsFound: number;
  gapsClosed: number;
  regeneratedTitles: string[];
  verdict: CriticVerdict;
  exitReason?: CriticExitReason;
  costUsdCumulative: number;
  durationMs: number;
}

export interface CriticReport {
  scopeNote: string;
  structural: StructuralLayer;
  semantic: SemanticLayer;
  coverage: CoverageLayer;
  gaps: CriticGap[];
  gate: GateResult;
  trace: CriticIterationTrace[];
  exitReason: CriticExitReason;
  bestIteration: number;
  iterationsRun: number;
  definitionOfDone: DefinitionOfDone;
  testCaseCountBefore: number;
  testCaseCountAfter: number;
  addedTestCaseIds: string[];
  generatedAtIso: string;
}
```

---

## 5. Re-wiring — FRONTEND (`frontend/src/`)

### `services/api.ts` — add:
```ts
export async function runCritic(payload: {
  parsedRequirements: unknown;
  testCases: unknown[];
  scripts: { testCaseId?: string; fileName?: string; code: string }[];
}) {
  const { data } = await api.post('/critic/run', payload, { timeout: 600_000 });
  return data;
}
```

### `pages/ChatPage.tsx` — re-add, in order:

1. **Import:** add `runCritic,` to the `@/services/api` import block.
2. **PIPELINE_STAGES:** insert two stages — `{ key: 'ai-critic-design', name: 'AI Critic Loop', icon: Shield }`
   after `test-design`, and `{ key: 'ai-critic-script', name: 'AI Critic Loop', icon: Shield }` after `script-gen`.
3. **State:** `const [criticReport, setCriticReport] = useState<any>(null);` and
   `const [parsedReqs, setParsedReqs] = useState<any>(null);` (near `reportData`).
4. **Session restore:** `if (s.criticReport) setCriticReport(s.criticReport);` and
   `if (s.parsedReqs) setParsedReqs(s.parsedReqs);` (the key-based `pipelineStages` reconcile is
   already present and handles the stage-count change).
5. **Session persist:** add `criticReport,` and `parsedReqs,` to the `sessionStorage.setItem` object.
6. **Session reset:** add `setCriticReport(null);` and `setParsedReqs(null);`.
7. **`applyGenerationResult`:** after `updatePipeline('test-design','completed',...)` add
   `setParsedReqs(res?.parsedRequirements ?? null); setCriticReport(null); void runDesignCritic(res?.parsedRequirements ?? null, testCases);`
8. **`runDesignCritic` helper** (component-level): calls `runCritic({ parsedRequirements, testCases, scripts: [] })`,
   merges `{ design, designScore, verdict }` into `criticReport`, updates the `ai-critic-design` stage. Guarded.
9. **`handleScriptGeneration`:** after `setStep('script-review')`, add a block that calls
   `runCritic({ parsedRequirements: null, testCases: [], scripts })`, merges `{ scripts, scriptScore }`,
   updates the `ai-critic-script` stage. Guarded.
10. **Report card:** re-add the `{criticReport && (() => { ... })()}` "Test Design Quality" block in
    the report step (reads `criticReport.design` + `criticReport.scripts` defensively).

> The exact code for items 7–10 is in the git history of this file / recoverable from the archived
> `criticAgent` contract. The endpoint returns `{ verdict, designScore, scriptScore, design, scripts }`.

---

## 6. Verify after rework
```bash
cd backend && ./node_modules/.bin/tsc --noEmit --project tsconfig.json
cd ../frontend && ./node_modules/.bin/tsc -b
```
Restart the backend and hard-refresh the browser.
