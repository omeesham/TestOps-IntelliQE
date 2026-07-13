import { createInitialState } from './state.js';
import { requirementAgent } from './requirementAgent.js';
import { auditAgent } from './auditAgent.js';
import { plannerAgent } from './plannerAgent.js';
import { generatorAgent } from './generatorAgent.js';
import { scriptAgent } from './scriptAgent.js';
import { executionAgent } from './executionAgent.js';
import { healingAgent } from './healingAgent.js';
import { exploreAgent } from './exploreAgent.js';
import type { TestOpsState, AppContext, LlmConfig } from './state.js';

/**
 * Decide if the explore agent should run. We trigger it when:
 *   • A target URL is present, AND
 *   • The user provided no real requirements text (empty, or just a stub
 *     like "Generate general tests" coming from a URL-only submission)
 * This keeps explore opt-in for users who have proper specs.
 */
function shouldExploreFirst(state: TestOpsState): boolean {
  if (!state.appContext?.targetUrl?.trim()) return false;
  const req = (state.requirements || '').trim();
  if (req.length === 0) return true;
  // Heuristic: the default fallback from generate.routes.ts is "Generate <type> tests"
  // — treat anything shorter than 40 chars as effectively empty.
  if (req.length < 40) return true;
  return false;
}

export type PipelineStage = 'requirement' | 'audit' | 'planning' | 'generation' | 'scripting' | 'execution' | 'healing' | 'completed';

export interface PipelineResult {
  state: TestOpsState;
  stages: { name: PipelineStage; duration: number; status: 'completed' | 'failed' }[];
}

async function runStage<T>(
  name: PipelineStage,
  fn: () => T | Promise<T>,
): Promise<{ result: T; stage: { name: PipelineStage; duration: number; status: 'completed' | 'failed' } }> {
  const start = Date.now();
  const result = await fn();
  return { result, stage: { name, duration: Date.now() - start, status: 'completed' } };
}

export async function runPipeline(
  requirements: string,
  appContext?: AppContext,
  llm?: LlmConfig | null,
): Promise<PipelineResult> {
  const stages: PipelineResult['stages'] = [];
  let state = createInitialState(requirements, appContext, llm);

  // Path 4 — exploration fallback. If we only have a URL, crawl the AUT
  // first to synthesise requirements before the analyst agent runs.
  if (shouldExploreFirst(state)) {
    const s0 = await runStage('requirement', () => exploreAgent(state));
    state = s0.result; stages.push({ ...s0.stage, name: 'requirement' });
  }

  const s1 = await runStage('requirement', () => requirementAgent(state));
  state = s1.result; stages.push(s1.stage);

  // Audit and planning both depend only on the parsed requirements — run them
  // in PARALLEL, then merge (audit's enhanced requirements + planner's plan).
  const [s2, s3] = await Promise.all([
    runStage('audit', () => auditAgent(state)),
    runStage('planning', () => plannerAgent(state)),
  ]);
  state = {
    ...state,
    parsedRequirements: s2.result.parsedRequirements,
    testPlan: s3.result.testPlan,
    extendedTestPlan: s3.result.extendedTestPlan,
  };
  stages.push(s2.stage, s3.stage);

  const s4 = await runStage('generation', () => generatorAgent(state));
  state = s4.result; stages.push(s4.stage);

  const s5 = await runStage('scripting', () => scriptAgent(state));
  state = s5.result; stages.push(s5.stage);

  const s6 = await runStage('execution', () => executionAgent(state));
  state = s6.result; stages.push(s6.stage);

  if (state.failureReason && state.executionResults && state.executionResults.failed > 0) {
    const s7 = await runStage('healing', () => healingAgent(state));
    state = s7.result; stages.push(s7.stage);
    // Healed code is only a claim until it runs — re-execute so the pipeline
    // reports real post-heal results instead of the healer's optimism.
    if (state.healingAttempted) {
      const s8 = await runStage('execution', () => executionAgent({ ...state, failureReason: null }));
      state = s8.result; stages.push(s8.stage);
    }
  }

  stages.push({ name: 'completed', duration: 0, status: 'completed' });

  return { state, stages };
}

export async function runGenerationOnly(
  requirements: string,
  options?: { maxTestCases?: number; appContext?: AppContext; llm?: LlmConfig | null },
): Promise<TestOpsState> {
  let state = createInitialState(requirements, options?.appContext, options?.llm);
  if (options?.maxTestCases !== undefined) {
    state.generationOptions = { maxTestCases: options.maxTestCases };
  }
  // Path 4 — explore the live application first when the user provided
  // only a URL (no Jira story, no upload, no pasted requirements).
  if (shouldExploreFirst(state)) {
    state = await exploreAgent(state);
  }
  state = await requirementAgent(state);
  // Audit (enhances edge cases) and planning (produces the strategy) both depend
  // only on the parsed requirements — run them in PARALLEL, then merge.
  const [audited, planned] = await Promise.all([auditAgent(state), plannerAgent(state)]);
  state = {
    ...state,
    parsedRequirements: audited.parsedRequirements,
    testPlan: planned.testPlan,
    extendedTestPlan: planned.extendedTestPlan,
  };
  state = await generatorAgent(state);
  // NOTE: scripts are intentionally NOT generated here. The chat flow generates
  // them in a later, DOM-grounded step (POST /api/pipeline-flow/scripts), which
  // crawls the live app for real selectors. Generating blind scripts here would
  // just waste tokens on output the script stage replaces.
  return state;
}
