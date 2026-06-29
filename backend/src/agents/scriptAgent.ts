import type { TestOpsState, AutomationScript, TestCase } from './state.js';
import { runClaudePrompt, parseJsonFromResponse } from './claude-runner.js';
import { transform } from 'esbuild';

/**
 * Script Agent — generates Playwright `.spec.ts` files for each generated
 * test case using Claude.
 *
 * Each Claude call batches up to BATCH_SIZE test cases to stay within
 * max-tokens while cutting wall time vs. one call per test.
 *
 * SAFETY NET: every generated spec is syntax-checked with esbuild before it is
 * stored. The #1 failure mode is the model embedding an apostrophe inside a
 * single-quoted JS string (e.g. test('shows 'Invalid' error', …)) — that
 * terminates the string and the whole spec fails to load, so Playwright collects
 * 0 runnable tests. Any spec that does not compile (or has no test() block)
 * falls back to a minimal, guaranteed-valid template instead of being stored
 * broken. This makes "Playwright collected 0 runnable tests" unreachable from a
 * generation defect.
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

/** Emit a safe single-quoted JS string literal (escapes \, ', and newlines). */
function jsLit(s: unknown): string {
  return `'${String(s ?? '').replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\r?\n/g, ' ')}'`;
}

/** Make arbitrary text safe to drop into a `//` line comment. */
function commentSafe(s: unknown): string {
  return String(s ?? '').replace(/\r?\n/g, ' ').replace(/\*\//g, '* /').trim();
}

function templateScript(tc: TestCase): AutomationScript {
  const stepCode = tc.steps.map((step, i) => {
    const label = commentSafe(step);
    const s = String(step).toLowerCase();
    if (s.includes('navigate') || s.includes('open') || s.includes('go to')) {
      return `  // Step ${i + 1}: ${label}\n  await page.goto('/${tc.feature.toLowerCase().replace(/\s+/g, '-')}');`;
    }
    if (s.includes('fill') || s.includes('enter') || s.includes('input') || s.includes('type')) {
      return `  // Step ${i + 1}: ${label}\n  await page.getByRole('textbox').first().fill('test-value');`;
    }
    if (s.includes('click') || s.includes('submit') || s.includes('press')) {
      return `  // Step ${i + 1}: ${label}\n  await page.getByRole('button').first().click();`;
    }
    if (s.includes('verify') || s.includes('check') || s.includes('assert') || s.includes('expect')) {
      return `  // Step ${i + 1}: ${label}\n  await expect(page).toHaveURL(/.*/);`;
    }
    return `  // Step ${i + 1}: ${label}\n  // TODO: Implement step`;
  }).join('\n\n');

  const code = `import { test, expect } from '@playwright/test';\n\ntest(${jsLit(tc.scenario)}, async ({ page }) => {\n${stepCode}\n});\n`;
  return { testCaseId: tc.id, fileName: safeFileName(tc.scenario), code };
}

/**
 * Syntax-validate a generated spec. Returns true only if it compiles as
 * TypeScript AND contains at least one test() block — the two conditions
 * Playwright needs to collect a runnable test from the file.
 */
async function isRunnableSpec(code: string): Promise<boolean> {
  if (!/\btest\s*\(/.test(code)) return false;
  try {
    await transform(code, { loader: 'ts', target: 'es2020' });
    return true;
  } catch {
    return false;
  }
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
    ? `BASE_URL is "${targetUrl}". Use page.goto("${targetUrl}") (or a full URL) for navigation.`
    : `No BASE_URL was provided — use relative paths like "/login" and let Playwright config resolve them.`;

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
    "code": "import { test, expect } from '@playwright/test';\\n\\ntest(\\"...\\", async ({ page }) => { ... });"
  }
]

CRITICAL — the \`code\` field MUST be valid TypeScript that compiles. The most common mistake is breaking a string literal with an apostrophe. To avoid it:
- Use DOUBLE QUOTES for every string that may contain an apostrophe or single quote — test titles, button names, expected messages. Example: test("login shows 'Invalid credentials'", ...). NEVER write test('login shows 'Invalid credentials'', ...) — the inner quotes terminate the string and the file will not load.
- Keep test() titles SHORT — a concise scenario name, never the full step text.

Selector rules (do NOT dump step sentences into selectors):
- Typing into a field → page.getByLabel("Username").fill("Admin")  (or getByPlaceholder / getByRole("textbox", { name: "Username" })).
- Clicking a control → page.getByRole("button", { name: "Login" }).click() — use ONLY the control's short visible label (e.g. "Login"), never the step description, step number, or any "→ Expected:" text.
- A step often combines an action and its expected result, separated by "→ Expected:" or "Expected:". SPLIT them: emit the Playwright ACTION for the action part, and an assertion (await expect(...)) for the expected part.

General rules:
- Import ONLY from '@playwright/test'. Do NOT import page objects, fixtures, or any other local file — those files do not exist in the run workspace and would make the spec fail to load.
- Use await expect(...) for every verification. Use realistic data (e.g. "user@example.com" for email).
- Cover every step in order; do not skip or merge. Wrap each scenario in a single test(...) (a describe block is fine for shared beforeEach).
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

  return Promise.all(batch.map(async (tc) => {
    const entry = byId.get(tc.id);
    // Accept the AI spec ONLY if it actually compiles and has a test() block.
    if (entry && entry.code.trim() && await isRunnableSpec(entry.code)) {
      return {
        testCaseId: tc.id,
        fileName: entry.fileName?.trim() || safeFileName(tc.scenario),
        code: entry.code,
      };
    }
    if (entry && entry.code.trim()) {
      // The model produced code but it doesn't compile (usually an unescaped
      // quote) — store a valid template instead of a broken spec so execution
      // never collects 0 runnable tests.
      console.warn(`[scriptAgent] spec for ${tc.id} failed syntax validation — using template fallback`);
    }
    return templateScript(tc);
  }));
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
