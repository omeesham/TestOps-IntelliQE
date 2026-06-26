import type { TestOpsState, AutomationScript } from './state.js';
import { runClaudePrompt, parseJsonFromResponse } from './claude-runner.js';
import { buildHealingPrompt, type HealingFix } from './healing-prompt.js';

export async function healingAgent(state: TestOpsState): Promise<TestOpsState> {
  if (!state.failureReason) return state;

  const failedCases = state.testCases.filter((tc) => tc.status === 'failed');
  if (failedCases.length === 0) return state;

  const scriptMap = new Map<string, AutomationScript>();
  for (const script of state.automationScripts) {
    scriptMap.set(script.testCaseId, script);
  }

  // Per-test error from the real execution run — far more useful to the healer
  // than the single global failureReason that was previously sent for EVERY
  // test. Falls back to the global reason when a per-test message is missing.
  const errorByTcId = new Map<string, string>();
  for (const d of state.executionResults?.details || []) {
    if (d.status === 'failed' && d.error) errorByTcId.set(d.testCaseId, d.error);
  }

  const targetUrl = state.appContext?.targetUrl;
  const healedScripts: AutomationScript[] = [];

  for (const tc of failedCases) {
    const script = scriptMap.get(tc.id);
    if (!script) continue;

    try {
      const prompt = buildHealingPrompt({
        title: tc.title || tc.scenario,
        feature: tc.feature,
        type: tc.type,
        precondition: tc.precondition,
        steps: tc.steps,
        expectedResult: tc.expectedResult,
        fileName: script.fileName,
        code: script.code,
        error: errorByTcId.get(tc.id) || state.failureReason || 'Test failed during execution.',
        targetUrl,
      });

      const response = await runClaudePrompt(prompt, { maxTokens: 8000 });
      const fixed = parseJsonFromResponse<HealingFix>(response);

      if (fixed?.code?.trim() && fixed.code.trim() !== script.code.trim()) {
        healedScripts.push({
          testCaseId: tc.id,
          fileName: fixed.fileName?.trim() || script.fileName,
          code: fixed.code,
        });
      }
    } catch {
      // Could not heal this test — leave script unchanged, status stays 'failed'
    }
  }

  const healedIds = new Set(healedScripts.map((s) => s.testCaseId));

  const updatedScripts = [
    ...state.automationScripts.filter((s) => !healedIds.has(s.testCaseId)),
    ...healedScripts,
  ];

  // Healed tests move to 'automated' — fixed but not yet re-verified by execution
  const updatedCases = state.testCases.map((tc) =>
    tc.status === 'failed' && healedIds.has(tc.id)
      ? { ...tc, status: 'automated' as const }
      : tc
  );

  const stillFailed = updatedCases.filter((tc) => tc.status === 'failed').length;

  return {
    ...state,
    testCases: updatedCases,
    automationScripts: updatedScripts,
    healingAttempted: true,
    failureReason: stillFailed > 0 ? `${stillFailed} test(s) could not be healed` : null,
    executionResults: state.executionResults
      ? { ...state.executionResults, failed: stillFailed }
      : null,
  };
}
