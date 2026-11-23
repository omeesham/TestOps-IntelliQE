/**
 * flake-engine.ts
 * ───────────────
 * Pure, DB-free reliability/determinism summariser.
 *
 * "Deterministic execution" is only a selling point if it is MEASURED. Given the
 * outcomes of running the same flow N times, this computes a reliability report:
 * the overall flake rate (fraction of runs that disagree with the majority
 * outcome), which steps are flaky (pass in some runs, fail in others), and a
 * plain verdict. No DB, no network — directly unit-testable.
 */

export interface RunStepOutcome { name: string; ok: boolean }
export interface RunOutcome {
  passed: boolean;
  steps: RunStepOutcome[];
  durationMs?: number;
}

export interface StepReliability {
  name: string;
  runs: number;
  passes: number;
  passRate: number;      // 0..1
  flaky: boolean;        // passed in some runs, failed in others
}

export interface ReliabilityReport {
  runs: number;
  passedRuns: number;
  failedRuns: number;
  /** Fraction of runs whose overall pass/fail differs from the majority outcome (0 = perfectly stable). */
  flakeRate: number;
  /** True when every run agreed AND no step flipped — i.e. genuinely deterministic. */
  deterministic: boolean;
  /** Steps that flipped between pass and fail across runs. */
  flakySteps: StepReliability[];
  /** Per-step reliability for every step seen. */
  steps: StepReliability[];
  latency?: { minMs: number; maxMs: number; avgMs: number };
  verdict: string;
}

function round(n: number, dp = 4): number {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}

/**
 * Summarise N run outcomes into a reliability report. Step identity is the step
 * NAME (stable across runs); a step missing from some runs is counted only over
 * the runs it appeared in, and flagged flaky if it both passed and failed.
 */
export function summarizeReliability(outcomes: RunOutcome[]): ReliabilityReport {
  const runs = outcomes.length;
  if (!runs) {
    return { runs: 0, passedRuns: 0, failedRuns: 0, flakeRate: 0, deterministic: true, flakySteps: [], steps: [], verdict: 'No runs.' };
  }

  const passedRuns = outcomes.filter((o) => o.passed).length;
  const failedRuns = runs - passedRuns;

  // Overall flake rate: fraction disagreeing with the majority pass/fail outcome.
  const majority = Math.max(passedRuns, failedRuns);
  const flakeRate = round((runs - majority) / runs);

  // Per-step aggregation, preserving first-seen order.
  const order: string[] = [];
  const agg = new Map<string, { runs: number; passes: number }>();
  for (const o of outcomes) {
    for (const s of o.steps || []) {
      let a = agg.get(s.name);
      if (!a) { a = { runs: 0, passes: 0 }; agg.set(s.name, a); order.push(s.name); }
      a.runs += 1;
      if (s.ok) a.passes += 1;
    }
  }
  const steps: StepReliability[] = order.map((name) => {
    const a = agg.get(name)!;
    return { name, runs: a.runs, passes: a.passes, passRate: round(a.passes / a.runs), flaky: a.passes > 0 && a.passes < a.runs };
  });
  const flakySteps = steps.filter((s) => s.flaky);

  const deterministic = flakeRate === 0 && flakySteps.length === 0;

  const durations = outcomes.map((o) => o.durationMs).filter((d): d is number => typeof d === 'number' && d >= 0);
  const latency = durations.length
    ? { minMs: Math.min(...durations), maxMs: Math.max(...durations), avgMs: Math.round(durations.reduce((x, y) => x + y, 0) / durations.length) }
    : undefined;

  let verdict: string;
  if (deterministic && passedRuns === runs) verdict = `Deterministic — ${runs}/${runs} runs passed identically, no flaky steps.`;
  else if (deterministic) verdict = `Stable but failing — every run failed the same way (${flakySteps.length === 0 ? 'no flaky steps' : ''}). Fix the test or the API, not the flake.`;
  else verdict = `Flaky — ${Math.round(flakeRate * 100)}% of runs disagreed${flakySteps.length ? `; ${flakySteps.length} unstable step${flakySteps.length === 1 ? '' : 's'}: ${flakySteps.slice(0, 3).map((s) => s.name).join(', ')}` : ''}.`;

  return { runs, passedRuns, failedRuns, flakeRate, deterministic, flakySteps, steps, latency, verdict };
}
