import type { TestOpsState, AutomationScript, TestCase, ExploredApp } from './state.js';
import { runClaudePrompt, parseJsonFromResponse } from './claude-runner.js';
import {
  buildPomSpecPrompt,
  pomFallbackSpec,
  safeSpecFileName,
  type PomCasePayload,
  type PomScriptResponse,
} from './pom-spec-prompt.js';

/**
 * Script Agent — generates Playwright `.spec.ts` files for each generated test
 * case using Claude.
 *
 * Every spec follows the SINGLE Page Object Model convention defined in
 * pom-spec-prompt.ts (shared with the wizard's Generate-Scripts route so the two
 * generators never drift). Generated specs are self-contained single-file POM:
 * each carries its own Page Object class(es) because the runner executes specs
 * in isolation (see services/playwright-runner.service.ts).
 *
 * Each Claude call batches up to BATCH_SIZE test cases to stay within max-tokens
 * while cutting wall time vs. one call per test. POM specs are verbose (a
 * page-object class per spec), so the batch is kept small to keep each JSON
 * response whole rather than truncated.
 *
 * Per-entry template fallback: if Claude returns a valid batch response but a
 * single entry is malformed/missing, that entry falls back to a minimal,
 * still-POM-compliant template (pomFallbackSpec) — not a whole-batch escape.
 */

const BATCH_SIZE = 5;

/**
 * Condense the live-crawl UI map (exploreAgent output) into a compact, token-
 * bounded description the POM prompt can use to build locators from real,
 * observed elements rather than guesses. Returns undefined when no crawl ran.
 */
function renderUiMap(explored: ExploredApp | null | undefined): string | undefined {
  if (!explored || !explored.pages?.length) return undefined;
  const lines: string[] = [];
  for (const page of explored.pages.slice(0, 6)) {
    lines.push(`# ${page.title || page.url} (${page.url})`);
    if (page.headings?.length) lines.push(`  headings: ${page.headings.slice(0, 6).join(' | ')}`);
    for (const form of (page.forms || []).slice(0, 4)) {
      const fields = form.fields
        .slice(0, 12)
        .map((f) => `${f.label || f.name || '?'}${f.required ? '*' : ''} [${f.type}]`)
        .join(', ');
      if (fields) lines.push(`  form${form.name ? ` "${form.name}"` : ''}: ${fields}`);
    }
    if (page.buttons?.length) lines.push(`  buttons: ${page.buttons.slice(0, 10).join(' | ')}`);
  }
  const out = lines.join('\n');
  return out.length > 3000 ? `${out.slice(0, 3000)}\n…(truncated)` : out;
}

function toPayload(tc: TestCase): PomCasePayload {
  return {
    testCaseId: tc.id,
    title: tc.title || tc.scenario,
    feature: tc.feature,
    precondition: tc.precondition,
    steps: tc.steps,
    testSteps: tc.testSteps,
    testData: tc.testData,
    expectedResult: tc.expectedResult,
    type: tc.type,
    priority: tc.priority,
  };
}

async function aiBatch(state: TestOpsState, batch: TestCase[]): Promise<AutomationScript[]> {
  const ctx = {
    appName: state.appContext?.appName || 'Web Application',
    targetUrl: state.appContext?.targetUrl || '',
    // Feed the live-crawl UI map (when a crawl ran) into POM generation so page
    // objects use real, observed locators — POM + live-crawl reinforcing each other.
    uiMap: renderUiMap(state.exploredApp),
  };

  const prompt = buildPomSpecPrompt(batch.map(toPayload), ctx);

  const response = await runClaudePrompt(prompt, { maxTokens: 16384 });
  const parsed = parseJsonFromResponse<PomScriptResponse[]>(response);

  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error('Claude returned no scripts for batch');
  }

  const byId = new Map<string, PomScriptResponse>();
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
        fileName: entry.fileName?.trim() || safeSpecFileName(tc.scenario),
        code: entry.code,
      };
    }
    // Per-entry fallback: Claude returned a valid batch but this one entry was
    // malformed — emit a self-contained POM skeleton so the spec still runs.
    return pomFallbackSpec(toPayload(tc), ctx.targetUrl);
  });
}

export async function scriptAgent(state: TestOpsState): Promise<TestOpsState> {
  const eligible = state.testCases.filter((tc) => tc.type !== 'data');
  if (eligible.length === 0) return { ...state, automationScripts: [] };

  const scripts: AutomationScript[] = [];

  for (let i = 0; i < eligible.length; i += BATCH_SIZE) {
    const batch = eligible.slice(i, i + BATCH_SIZE);
    try {
      scripts.push(...await aiBatch(state, batch));
    } catch {
      // Whole-batch failure (no/invalid AI response): fall back to POM templates
      // for the batch so the pipeline still produces runnable specs.
      scripts.push(...batch.map((tc) => pomFallbackSpec(toPayload(tc), state.appContext?.targetUrl)));
    }
  }

  return { ...state, automationScripts: scripts };
}
