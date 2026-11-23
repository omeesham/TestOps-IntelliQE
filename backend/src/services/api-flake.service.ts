/**
 * api-flake.service.ts
 * ────────────────────
 * Reliability / determinism benchmark. Runs a flow N times and reports the flake
 * rate, unstable steps and latency spread — turning "deterministic execution"
 * from a claim into a measured number a buyer (or a CI gate) can see.
 *
 * All summarisation is the pure `utils/flake-engine` (unit-tested); this file
 * only drives the existing flow runner N times. Standalone and opt-in — it never
 * touches the generate→heal pipeline. Writes stay disabled unless explicitly
 * allowed, so a benchmark re-run doesn't create N copies of a resource.
 */
import { runFlow, getFlow, type FlowStep } from './api-flow.service.js';
import { summarizeReliability, type ReliabilityReport, type RunOutcome } from '../utils/flake-engine.js';

const MIN_RUNS = 2;
const MAX_RUNS = 20;

export interface ReliabilityInput {
  steps?: FlowStep[];
  flowId?: string;
  variables?: Record<string, string>;
  allowWrites?: boolean;
  groups?: Record<string, FlowStep[]>;
  runs?: number;
}

export interface ReliabilityResult extends ReliabilityReport {
  flowName?: string;
  perRun: { run: number; passed: boolean; durationMs: number; stepsRun: number }[];
}

export async function runReliability(tenantId: string, input: ReliabilityInput): Promise<ReliabilityResult> {
  let steps = Array.isArray(input.steps) ? input.steps : [];
  let flowName: string | undefined;
  let variables = input.variables || {};

  if (input.flowId) {
    const flow = await getFlow(tenantId, String(input.flowId));
    if (!flow) throw new Error('Flow not found.');
    steps = flow.steps;
    flowName = flow.name;
    variables = { ...flow.variables, ...variables };
  }
  if (!steps.length) throw new Error('Provide a flow (flowId) or steps to benchmark.');

  const runs = Math.min(MAX_RUNS, Math.max(MIN_RUNS, Number(input.runs) || 5));
  const outcomes: RunOutcome[] = [];
  const perRun: ReliabilityResult['perRun'] = [];

  for (let i = 0; i < runs; i++) {
    const r = await runFlow({ steps, variables, allowWrites: !!input.allowWrites, groups: input.groups });
    outcomes.push({
      passed: r.passed,
      durationMs: r.durationMs,
      steps: r.steps
        .filter((s) => s.method !== 'WAIT')            // wait markers aren't assertions
        .map((s) => ({ name: s.name, ok: s.ok })),
    });
    perRun.push({ run: i + 1, passed: r.passed, durationMs: r.durationMs, stepsRun: r.stepsRun });
  }

  return { ...summarizeReliability(outcomes), flowName, perRun };
}
