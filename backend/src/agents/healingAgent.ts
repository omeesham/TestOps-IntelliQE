import type { TestOpsState, AutomationScript } from './state.js';
import { runClaudePrompt, parseJsonFromResponse } from './claude-runner.js';

export async function healingAgent(state: TestOpsState): Promise<TestOpsState> {
  if (!state.failureReason) return state;

  const failedCases = state.testCases.filter((tc) => tc.status === 'failed');
  if (failedCases.length === 0) return state;

  const scriptMap = new Map<string, AutomationScript>();
  for (const script of state.automationScripts) {
    scriptMap.set(script.testCaseId, script);
  }

  const healedScripts: AutomationScript[] = [];

  for (const tc of failedCases) {
    const script = scriptMap.get(tc.id);
    if (!script) continue;

    try {
      const prompt = `You are a Playwright automation engineer. A test failed and needs to be fixed.

Test Case:
- Scenario: ${tc.scenario}
- Feature: ${tc.feature}
- Steps: ${tc.steps.join(' | ')}
- Expected Result: ${tc.expectedResult}
- Type: ${tc.type}

Failing script (${script.fileName}):
\`\`\`typescript
${script.code}
\`\`\`

Failure reason: ${state.failureReason}

Common causes: brittle selectors, missing waits, wrong assertions, wrong URL paths.

Return ONLY a JSON object (no markdown):
{
  "fileName": "same-or-corrected-filename.spec.ts",
  "code": "full corrected TypeScript Playwright script"
}

Rules:
- Use getByRole, getByLabel, getByText, getByPlaceholder — not CSS selectors
- Add explicit waits where needed (waitForSelector, waitForURL, expect with timeout)
- Fix incorrect assertions based on the expected result
- The script must be complete and runnable with @playwright/test`;

      const response = await runClaudePrompt(prompt, { maxTokens: 4096 });
      const fixed = parseJsonFromResponse<{ fileName: string; code: string }>(response);

      if (fixed?.code?.trim()) {
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
