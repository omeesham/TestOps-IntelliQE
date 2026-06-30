import type { TestOpsState, AutomationScript, PageObjectFile } from './state.js';
import { runLLM, parseJsonFromResponse, llmForStage } from './claude-runner.js';
import { scriptAgent } from './scriptAgent.js';

/**
 * Healing agent — fixes failing tests, then the caller RE-EXECUTES them.
 *
 * Two repair modes:
 *   1. REGENERATE (rerun/retry): when the page objects are missing or specs
 *      failed to even LOAD (e.g. "Cannot find module …/pages/…"), a text patch
 *      can't help — the broken thing is structural. We regenerate a
 *      self-consistent POM (page objects + specs, with deterministic imports)
 *      for the failing cases via the script agent so they resolve on retry.
 *   2. TEXT-HEAL: when the POM is intact, patch the failing spec's selectors /
 *      waits / assertions, giving the model the page-object source it uses.
 */
/**
 * Compact inventory of the LIVE application DOM (from a crawl), so the healer
 * fixes a broken selector against REAL elements instead of guessing. Without
 * this the healer is blind — it only sees the error string and swaps one guessed
 * locator for another. Empty string when no crawl is available.
 */
function buildDomInventory(state: TestOpsState): string {
  const pages = state.exploredApp?.pages;
  if (!Array.isArray(pages) || pages.length === 0) return '';
  const lines: string[] = [];
  for (const p of pages.slice(0, 8)) {
    lines.push(`PAGE: ${p.title || p.url} (${p.url})`);
    for (const f of (p.forms || []).slice(0, 4)) {
      for (const fld of (f.fields || []).slice(0, 25)) {
        lines.push(`  field: name="${fld.name}" type="${fld.type}"${fld.label ? ` label/placeholder="${fld.label}"` : ''}${fld.required ? ' (required)' : ''}`);
      }
    }
    const btns = (p.buttons || []).slice(0, 15);
    if (btns.length) lines.push(`  buttons/links: ${btns.map((b) => `"${b}"`).join(', ')}`);
    const headings = (p.headings || []).slice(0, 8);
    if (headings.length) lines.push(`  headings: ${headings.map((h) => `"${h}"`).join(', ')}`);
  }
  return `\nLIVE APP DOM — ground EVERY selector in these REAL elements (do NOT guess; if the failing locator is not here, replace it with the matching real element by name/label/text):\n${lines.join('\n')}\n`;
}

export async function healingAgent(
  state: TestOpsState,
  opts?: { failuresByTc?: Record<string, string> },
): Promise<TestOpsState> {
  if (!state.failureReason) return state;

  const failedCases = state.testCases.filter((tc) => tc.status === 'failed');
  if (failedCases.length === 0) return state;

  const failuresByTc = opts?.failuresByTc || {};
  const domInventory = buildDomInventory(state);

  const pageObjects = state.pageObjects || [];
  const moduleError = /cannot find module|failed to load|cannot resolve/i.test(state.failureReason || '');
  const pomMissing = pageObjects.length === 0;

  // ── Mode 1: regenerate the POM for the failing cases and retry ──
  if ((moduleError || pomMissing) && state.llm) {
    try {
      const regen = await scriptAgent({ ...state, testCases: failedCases, automationScripts: [], pageObjects: [] });
      const regenById = new Map(regen.automationScripts.map((s) => [s.testCaseId, s]));

      // Replace each failing spec with its regenerated version; keep the rest.
      const updatedScripts: AutomationScript[] = state.automationScripts.map((s) => regenById.get(s.testCaseId) || s);
      for (const s of regen.automationScripts) {
        if (!updatedScripts.some((x) => x.testCaseId === s.testCaseId)) updatedScripts.push(s);
      }

      // Union page objects by path (regenerated ones win, so imports resolve).
      const poByPath = new Map<string, PageObjectFile>(pageObjects.map((p) => [p.path, p]));
      for (const p of regen.pageObjects || []) poByPath.set(p.path, p);

      const updatedCases = state.testCases.map((tc) =>
        tc.status === 'failed' ? { ...tc, status: 'automated' as const } : tc,
      );

      return {
        ...state,
        automationScripts: updatedScripts,
        pageObjects: [...poByPath.values()],
        testCases: updatedCases,
        healingAttempted: true,
        failureReason: null, // re-execution will set the real result
      };
    } catch (err) {
      console.warn('[healingAgent] POM regeneration failed, falling back to text-heal:', (err as Error).message);
      // fall through to text-heal
    }
  }

  // ── Mode 2: POM-aware text heal of the failing specs ──
  const scriptMap = new Map<string, AutomationScript>();
  for (const script of state.automationScripts) scriptMap.set(script.testCaseId, script);
  const poByPath = new Map<string, PageObjectFile>(pageObjects.map((p) => [p.path, p]));

  const healedScripts: AutomationScript[] = [];

  // Heal each failing spec CONCURRENTLY. Sequential LLM calls (8+ specs ×
  // ~15-30s each) push the whole /heal request past Azure's 240s ingress
  // timeout → 504. Independent per-spec fixes parallelize cleanly.
  type HealOutcome = { script: AutomationScript; pageObject?: { path: string; code: string } } | null;
  const outcomes = await Promise.all(failedCases.map(async (tc): Promise<HealOutcome> => {
    const script = scriptMap.get(tc.id);
    if (!script) return null;

    // Surface the page-object source this spec uses, so the model fixes the
    // right place (selectors live in the page object, not the spec).
    const usedPoSource = (script.uses || [])
      .map((p) => poByPath.get(p))
      .filter((p): p is PageObjectFile => !!p)
      .map((p) => `// ${p.path}\n${p.code}`)
      .join('\n\n');

    try {
      const prompt = `You are a Playwright automation engineer. A test failed and needs to be fixed.

Test Case:
- Scenario: ${tc.scenario}
- Feature: ${tc.feature}
- Steps: ${tc.steps.join(' | ')}
- Expected Result: ${tc.expectedResult}
- Type: ${tc.type}

Failing spec (${script.fileName}):
\`\`\`typescript
${script.code}
\`\`\`
${usedPoSource ? `\nPage object(s) this spec imports (fix selectors HERE if the locator is wrong — keep the class/method names and import paths EXACTLY):\n\`\`\`typescript\n${usedPoSource}\n\`\`\`\n` : ''}${domInventory}
Failure for THIS test (the actual Playwright error to fix): ${failuresByTc[tc.id] || state.failureReason}

Common causes: a selector that doesn't match the live DOM, missing waits, wrong assertions, wrong URL paths.

Return ONLY a JSON object (no markdown):
{
  "fileName": "same-or-corrected-filename.spec.ts",
  "code": "full corrected spec",
  "pageObject": { "path": "src/pages/<module>/<name>.page.ts", "code": "full corrected page object" }   // OPTIONAL — include ONLY if you changed the page object
}

Rules:
- Fix the SPECIFIC failure above. If the error is "element(s) not found" for a locator, that locator is wrong — replace it with the matching element from the LIVE APP DOM (by exact name/label/visible text); never keep a locator that isn't in the DOM.
- Keep the spec's import lines EXACTLY as they are (do not change page-object import paths).
- Prefer fixing the selector in the page object over inlining selectors in the spec.
- Prefer getByLabel/getByPlaceholder/getByRole(name)/getByText grounded in the real DOM over brittle CSS; add an explicit \`{ timeout: 20000 }\` only where a slow element genuinely needs it.`;

      const response = await runLLM(prompt, { maxTokens: 6000, llm: llmForStage(state.llm, 'heal') });
      const fixed = parseJsonFromResponse<{ fileName: string; code: string; pageObject?: { path: string; code: string } }>(response);

      if (fixed?.code?.trim()) {
        // Preserve the POM destination + page-object links so re-execution writes
        // the spec at the right path and resolves its imports.
        const healedScript: AutomationScript = {
          testCaseId: tc.id,
          fileName: fixed.fileName?.trim() || script.fileName,
          code: fixed.code,
          path: script.path,
          uses: script.uses,
        };
        const pageObject = (fixed.pageObject?.path && typeof fixed.pageObject.code === 'string' && fixed.pageObject.code.trim())
          ? { path: fixed.pageObject.path, code: fixed.pageObject.code }
          : undefined;
        return { script: healedScript, pageObject };
      }
    } catch {
      // Could not heal this test — leave script unchanged, status stays 'failed'
    }
    return null;
  }));

  // Merge the parallel outcomes (page-object fixes win, so imports resolve).
  for (const outcome of outcomes) {
    if (!outcome) continue;
    healedScripts.push(outcome.script);
    if (outcome.pageObject) {
      const existing = poByPath.get(outcome.pageObject.path);
      poByPath.set(outcome.pageObject.path, {
        path: outcome.pageObject.path,
        code: outcome.pageObject.code,
        className: existing?.className || '',
        module: existing?.module || '',
        methods: existing?.methods || [],
      });
    }
  }

  const healedIds = new Set(healedScripts.map((s) => s.testCaseId));

  const updatedScripts = [
    ...state.automationScripts.filter((s) => !healedIds.has(s.testCaseId)),
    ...healedScripts,
  ];

  const updatedCases = state.testCases.map((tc) =>
    tc.status === 'failed' && healedIds.has(tc.id) ? { ...tc, status: 'automated' as const } : tc,
  );

  const stillFailed = updatedCases.filter((tc) => tc.status === 'failed').length;

  return {
    ...state,
    testCases: updatedCases,
    automationScripts: updatedScripts,
    pageObjects: [...poByPath.values()],
    healingAttempted: true,
    failureReason: stillFailed > 0 ? `${stillFailed} test(s) could not be healed` : null,
    executionResults: state.executionResults ? { ...state.executionResults, failed: stillFailed } : null,
  };
}
