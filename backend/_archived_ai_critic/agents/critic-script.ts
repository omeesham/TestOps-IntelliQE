/**
 * critic-script
 * ─────────────
 * DETERMINISTIC quality check for the GENERATED Playwright automation scripts —
 * the script-side counterpart of critic-gate.ts (which gates the test-case
 * DESIGN). PURE + SYNCHRONOUS: no AI, no network, no I/O. Same input → identical
 * output (idempotent, L11), so the script verdict is reproducible and the model
 * can never inflate it (L3 pass-state gating).
 *
 * SCOPE (L9): this inspects the STATIC source of each spec for the failure modes
 * the healing taxonomy keeps catching — faked/weakened assertions, skips, hard
 * sleeps, missing assertions, non-self-contained imports. It does NOT run the
 * tests, so it does NOT prove they pass at runtime (that stays executionAgent +
 * healingAgent). A passing script here means the spec is STRUCTURALLY sound and
 * not cheating — not that it will go green against the live app.
 */

/** One script under review. */
export interface ScriptInput {
  testCaseId?: string;
  fileName?: string;
  code: string;
}

/** Per-script + suite-level deterministic verdict. */
export interface ScriptCriticResult {
  totalScripts: number;
  /** Scripts with zero violations. */
  passed: number;
  /** passed / totalScripts (0..1). 0 for an empty set (fail-closed). */
  ratio: number;
  /** 0..100 — round(ratio * 100). */
  score: number;
  /** Per-offending-script problems (agent-oriented, L7). */
  violations: { fileName: string; testCaseId: string; problems: string[] }[];
}

// ── Patterns that flag a cheating / broken spec (deterministic). ──
const RE = {
  playwrightImport: /from\s+['"]@playwright\/test['"]/,
  testBlock: /\btest\s*(\.\w+)?\s*\(/,            // test( / test.describe( / test.only(
  hasAssertion: /\bexpect\s*\(/,
  skip: /\btest\.(skip|fixme)\s*\(|test\.skip\b|\.fixme\s*\(/,
  only: /\btest\.only\s*\(|\.only\s*\(\s*['"`]/,
  hardSleep: /waitForTimeout\s*\(|\bsleep\s*\(/,
  // Trivially-true / faked assertions that "pass" without verifying intent.
  fakeAssert: /expect\s*\(\s*(true|1|['"`][^'"`]*['"`])\s*\)\s*\.\s*(toBeTruthy|toBe|toEqual|toBeDefined)\s*\(/,
  siblingImport: /from\s+['"]\.\.?\//,            // imports a sibling generated file (not self-contained)
};

/**
 * checkScriptQuality — assert structural quality invariants on every spec.
 *
 * Invariants per script (each failure is an agent-oriented problem string):
 *   • imports '@playwright/test'
 *   • contains at least one test( block
 *   • contains at least one expect( assertion
 *   • NO faked/trivially-true assertion (expect(true).toBeTruthy(), expect(1).toBe(1))
 *   • NO test.skip / test.fixme
 *   • NO test.only (would silently drop the rest of the suite)
 *   • NO hard sleep (waitForTimeout) — flaky, non-deterministic waits
 *   • self-contained — does not import a sibling generated spec
 *
 * Pure + total: a null/empty code string yields violations, never throws.
 */
export function checkScriptQuality(scripts: ScriptInput[]): ScriptCriticResult {
  const list = Array.isArray(scripts) ? scripts : [];
  const totalScripts = list.length;
  const violations: { fileName: string; testCaseId: string; problems: string[] }[] = [];
  let passed = 0;

  for (let i = 0; i < list.length; i++) {
    const s = list[i];
    const code = typeof s?.code === 'string' ? s.code : '';
    const fileName = (s?.fileName && s.fileName.trim()) || `script#${i + 1}`;
    const testCaseId = s?.testCaseId || '';
    const problems: string[] = [];

    if (!code.trim()) {
      problems.push('empty script — no code generated');
    } else {
      if (!RE.playwrightImport.test(code)) problems.push("does not import from '@playwright/test'");
      if (!RE.testBlock.test(code)) problems.push('no test() block found');
      if (!RE.hasAssertion.test(code)) problems.push('no expect() assertion — the test verifies nothing');
      if (RE.fakeAssert.test(code)) problems.push('contains a trivially-true / faked assertion (e.g. expect(true).toBeTruthy())');
      if (RE.skip.test(code)) problems.push('uses test.skip / test.fixme — the test is disabled, not verified');
      if (RE.only.test(code)) problems.push('uses test.only — would silently skip the rest of the suite');
      if (RE.hardSleep.test(code)) problems.push('uses a hard sleep (waitForTimeout) — flaky; use web-first assertions');
      if (RE.siblingImport.test(code)) problems.push('imports a sibling file — spec is not self-contained');
    }

    if (problems.length === 0) passed++;
    else violations.push({ fileName, testCaseId, problems });
  }

  // Empty set fails closed (an absent script suite is never "good").
  const ratio = totalScripts === 0 ? 0 : passed / totalScripts;
  return { totalScripts, passed, ratio, score: Math.round(ratio * 100), violations };
}
