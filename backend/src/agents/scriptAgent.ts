import type { TestOpsState, AutomationScript, TestCase } from './state.js';
import { runClaudePrompt, parseJsonFromResponse } from './claude-runner.js';

/**
 * Script Agent — generates Playwright `.spec.ts` files for each generated
 * test case using Claude CLI.
 *
 * Each Claude call batches up to BATCH_SIZE test cases to stay within
 * max-tokens while cutting wall time vs. one call per test.
 *
 * Per-entry template fallback: if Claude returns a valid batch response but
 * a single entry is malformed/missing, that entry falls back to a minimal
 * template. This is only for partial parse failures — not a whole-batch escape.
 */

const BATCH_SIZE = 10;

function safeFileName(scenario: string): string {
  const slug = scenario
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
    .slice(0, 60);
  return `${slug || 'test'}.spec.ts`;
}

function templateScript(tc: TestCase): AutomationScript {
  const stepCode = tc.steps.map((step, i) => {
    const s = step.toLowerCase();
    if (s.includes('navigate') || s.includes('open') || s.includes('go to')) {
      return `  // Step ${i + 1}: ${step}\n  await page.goto('/${tc.feature.toLowerCase().replace(/\s+/g, '-')}');`;
    }
    if (s.includes('fill') || s.includes('enter') || s.includes('input') || s.includes('type')) {
      return `  // Step ${i + 1}: ${step}\n  await page.getByRole('textbox').first().fill('test-value');`;
    }
    if (s.includes('click') || s.includes('submit') || s.includes('press')) {
      return `  // Step ${i + 1}: ${step}\n  await page.getByRole('button').first().click();`;
    }
    if (s.includes('verify') || s.includes('check') || s.includes('assert') || s.includes('expect')) {
      return `  // Step ${i + 1}: ${step}\n  await expect(page).toHaveURL(/.*/);`;
    }
    return `  // Step ${i + 1}: ${step}\n  // TODO: Implement step`;
  }).join('\n\n');

  const code = `import { test, expect } from '@playwright/test';\n\ntest('${tc.scenario.replace(/'/g, "\\'")}', async ({ page }) => {\n${stepCode}\n});\n`;
  return { testCaseId: tc.id, fileName: safeFileName(tc.scenario), code };
}

interface AiScriptResponse {
  testCaseId: string;
  fileName?: string;
  code: string;
}

async function aiBatch(state: TestOpsState, batch: TestCase[]): Promise<AutomationScript[]> {
  const appName = state.appContext?.appName || 'Web Application';
  const targetUrl = state.appContext?.targetUrl || '';
  const baseUrlNote = targetUrl
    ? `BASE_URL is "${targetUrl}". Use relative paths in goto() when sensible, or the full URL when the test references a specific environment.`
    : `No BASE_URL was provided — use relative paths like '/login' and let Playwright config resolve them.`;

  const casesPayload = batch.map((tc) => ({
    id: tc.id,
    feature: tc.feature,
    scenario: tc.scenario,
    steps: tc.steps,
    expectedResult: tc.expectedResult,
    type: tc.type,
    precondition: tc.precondition,
  }));

  const prompt = `You are a senior Playwright automation engineer. Generate runnable Playwright \`.spec.ts\` files for the test cases below.

Application: ${appName}
${baseUrlNote}

Test cases (JSON):
${JSON.stringify(casesPayload, null, 2)}

Return ONLY a JSON array (no markdown fence, no commentary) of objects in this exact shape:
[
  {
    "testCaseId": "TC-001",
    "fileName": "feature-scenario-name.spec.ts",
    "code": "import { test, expect } from '@playwright/test';\\n\\ntest('...', async ({ page }) => { ... });"
  }
]

Strict rules for the \`code\` field:
- Must compile as TypeScript with @playwright/test.
- Use \`getByRole\`, \`getByLabel\`, \`getByText\`, \`getByPlaceholder\` — NOT brittle CSS selectors or fake data-testids.
- Use \`await expect(...)\` for every verification step.
- Inline the precondition as a setup block at the top of the test.
- Cover EVERY step in the test case in order; do not skip or merge.
- Use realistic test data appropriate to the field (e.g. "user@example.com" for email).
- Wrap each scenario in a single \`test(...)\`. No describe blocks unless multiple related tests share setup.
- Return one entry per input test case, in the same order; testCaseId MUST match.`;

  const response = await runClaudePrompt(prompt, { maxTokens: 16384 });
  const parsed = parseJsonFromResponse<AiScriptResponse[]>(response);

  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error('Claude returned no scripts for batch');
  }

  const byId = new Map<string, AiScriptResponse>();
  for (const entry of parsed) {
    if (entry && typeof entry.code === 'string' && entry.testCaseId) {
      byId.set(entry.testCaseId, entry);
    }
  }

  return batch.map((tc) => {
    const entry = byId.get(tc.id);
    if (entry && entry.code.trim()) {
      return {
        testCaseId: tc.id,
        fileName: entry.fileName?.trim() || safeFileName(tc.scenario),
        code: entry.code,
      };
    }
    // Per-entry fallback: Claude returned a valid batch but this one entry was malformed
    return templateScript(tc);
  });
}

export async function scriptAgent(state: TestOpsState): Promise<TestOpsState> {
  const eligible = state.testCases.filter((tc) => tc.type !== 'data');
  if (eligible.length === 0) return { ...state, automationScripts: [] };

  const scripts: AutomationScript[] = [];

  for (let i = 0; i < eligible.length; i += BATCH_SIZE) {
    const batch = eligible.slice(i, i + BATCH_SIZE);
    scripts.push(...await aiBatch(state, batch));
  }

  return { ...state, automationScripts: scripts };
}
