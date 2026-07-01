import type { TestOpsState, AutomationScript } from './state.js';
import { isClaudeCliAuthenticated } from './claude-runner.js';
import { healSpecs, type HealSpecInput } from './heal-engine.js';
import { verifySpecsByKey } from '../services/playwright-runner.service.js';

/**
 * In-memory pipeline healer. Runs the SAME shared heal engine as the DB-backed
 * wizard service (agents/heal-engine.ts), so the in-pipeline heal is just as
 * rigorous: iterative + feedback + anti-cheat + verify-before-trust. A test is
 * only marked healed after the engine re-ran it and it actually passed without
 * weakening — no more "apply the AI fix and hope".
 */
export async function healingAgent(state: TestOpsState): Promise<TestOpsState> {
  if (!state.failureReason) return state;

  const failedCases = state.testCases.filter((tc) => tc.status === 'failed');
  if (failedCases.length === 0) return state;

  const scriptMap = new Map<string, AutomationScript>();
  for (const script of state.automationScripts) {
    scriptMap.set(script.testCaseId, script);
  }

  // Per-test error from the real execution run — far more useful to the healer
  // than the single global failureReason.
  const errorByTcId = new Map<string, string>();
  for (const d of state.executionResults?.details || []) {
    if (d.status === 'failed' && d.error) errorByTcId.set(d.testCaseId, d.error);
  }

  const inputs: HealSpecInput[] = [];
  for (const tc of failedCases) {
    const script = scriptMap.get(tc.id);
    if (!script) continue;
    inputs.push({
      id: tc.id,
      fileName: script.fileName,
      code: script.code,
      intent: {
        title: tc.title || tc.scenario,
        feature: tc.feature,
        type: tc.type,
        precondition: tc.precondition,
        steps: tc.steps,
        expectedResult: tc.expectedResult,
      },
      initialError: errorByTcId.get(tc.id) || state.failureReason || 'Test failed during execution.',
    });
  }
  if (inputs.length === 0) return state;

  const outcomes = await healSpecs(inputs, verifySpecsByKey, {
    canUseAi: isClaudeCliAuthenticated(),
    targetUrl: state.appContext?.targetUrl,
  });

  // Apply ONLY verified-healed fixes to the in-memory scripts.
  const healedIds = new Set<string>();
  const updatedScripts = state.automationScripts.map((s) => {
    const o = outcomes.get(s.testCaseId);
    if (o?.healed) {
      healedIds.add(s.testCaseId);
      return { ...s, code: o.finalCode };
    }
    return s;
  });

  // Healed tests were re-run and PASSED inside the engine → mark them 'passed'
  // (verified), not merely 'automated'.
  const updatedCases = state.testCases.map((tc) =>
    healedIds.has(tc.id) ? { ...tc, status: 'passed' as const } : tc,
  );

  const stillFailed = updatedCases.filter((tc) => tc.status === 'failed').length;
  const prevPassed = state.executionResults?.passed ?? 0;
  const updatedDetails = (state.executionResults?.details || []).map((d) =>
    healedIds.has(d.testCaseId) ? { ...d, status: 'passed' as const, error: undefined } : d,
  );

  return {
    ...state,
    testCases: updatedCases,
    automationScripts: updatedScripts,
    healingAttempted: true,
    failureReason: stillFailed > 0 ? `${stillFailed} test(s) could not be healed` : null,
    executionResults: state.executionResults
      ? { ...state.executionResults, passed: prevPassed + healedIds.size, failed: stillFailed, details: updatedDetails }
      : null,
  };
}
