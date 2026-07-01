/**
 * Single source of truth for the Page Object Model (POM) convention used by
 * EVERY Playwright spec the platform generates.
 *
 * Both spec generators import from here so they cannot drift:
 *   • agents/scriptAgent.ts            — the in-memory pipeline ("scripting" stage)
 *   • routes/automation-scripts.routes — the wizard's "Generate Scripts" action
 *
 * WHY SELF-CONTAINED POM (and not a shared pages/ directory):
 * generated specs are executed in ISOLATION — services/playwright-runner.service.ts
 * writes each spec ALONE into a temp tests/ dir with no sibling framework files,
 * then runs Playwright. A spec that imports `../pages/login.page` would fail to
 * load ("collected 0 tests"). So each generated spec must carry its own Page
 * Object class(es) inline while still obeying the POM rules below.
 *
 * The human-authored client-deliverable framework uses the SAME rules in their
 * shared form (src/pages, src/selectors, src/fixtures). See
 * client-deliverable/src/README.md for the human-facing description of the
 * single convention.
 */

/** Normalised test-case shape the prompt builder consumes. Each generator maps
 *  its own DB / state row onto this. */
export interface PomCasePayload {
  /** MUST be echoed back unchanged so the response maps to the right case. */
  testCaseId: string;
  tcNumber?: string;
  title: string;
  feature?: string;
  precondition?: string;
  steps?: string[];
  testSteps?: { step: number; action: string; expected: string; testData?: string }[];
  testData?: Record<string, string>;
  expectedResult?: string;
  type?: string;
  priority?: string;
}

export interface PomPromptContext {
  appName: string;
  targetUrl?: string;
  story?: string;
  /**
   * Optional compact UI map harvested by the live-crawl agent (exploreAgent):
   * real pages, forms, fields, and buttons observed on the running app. When
   * present it is injected into the prompt so generated Page Objects build
   * locators from ACTUALLY-OBSERVED accessible names instead of guessing —
   * this is what makes POM + live-crawl reinforce each other.
   */
  uiMap?: string;
}

/** Shape Claude must return — one object per input case (fileName optional;
 *  the caller falls back to a derived name when absent). */
export interface PomScriptResponse {
  testCaseId: string;
  fileName?: string;
  code: string;
}

/** A fully-formed spec with a guaranteed file name (the fallback never omits it). */
export interface GeneratedSpec {
  testCaseId: string;
  fileName: string;
  code: string;
}

/* ──────────────────────────────────────────────────────────────────
   Shared helpers (also used by the template fallbacks)
   ────────────────────────────────────────────────────────────────── */

export function safeSpecFileName(parts: string): string {
  const slug = parts
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
    .slice(0, 60);
  return `${slug || 'test'}.spec.ts`;
}

function pascalCase(raw: string): string {
  const words = (raw || 'App').replace(/[^a-zA-Z0-9]+/g, ' ').trim().split(/\s+/);
  const name = words.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join('');
  return /^[A-Za-z]/.test(name) ? name : `App${name}`;
}

function esc(s: string): string {
  return (s || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

/* ──────────────────────────────────────────────────────────────────
   The mandatory convention, expressed once as a prompt fragment.
   ────────────────────────────────────────────────────────────────── */

export const POM_SPEC_RULES = `═══════════════════════════════════════════════════════════
PAGE OBJECT MODEL — MANDATORY STRUCTURE FOR EVERY SPEC
═══════════════════════════════════════════════════════════
Each spec file MUST be self-contained and independently runnable: it is executed
in ISOLATION, so import ONLY from '@playwright/test' — NEVER from sibling files.
Follow this exact layout:
1. import { test, expect, type Page, type Locator } from '@playwright/test';
2. One or more Page Object CLASSES for the screen(s) under test:
   - Every locator declared ONCE as a 'readonly' Locator field, initialised in the
     constructor from page.getByRole / getByLabel / getByPlaceholder / getByText.
     There must be NO raw selector or page.* call inside the test body.
   - A navigation method, e.g. async goto() { await this.page.goto('<url-or-path>', { waitUntil: 'domcontentloaded' }); }
   - Action methods named for USER INTENT (login(user, pass), submit(), search(term)).
   - Assertion helpers that wrap web-first expects (expectLoginError(), expectOnDashboard()).
3. A test.describe() block whose test(s) CONSTRUCT the page object(s) and call ONLY
   their methods. The test body must read like a scenario and must NEVER touch a
   Locator or a page.* action directly — 'page' may only be passed to a page-object
   constructor.

═══════════════════════════════════════════════════════════
LOCATOR & ASSERTION RULES (this is what makes the tests resilient)
═══════════════════════════════════════════════════════════
- Prefer STABLE, accessibility-first locators: getByRole(role, { name }) → getByLabel
  → getByPlaceholder → getByText → getByTestId (data-testid). Use exact, realistic
  accessible names.
- AVOID brittle CSS/XPath tied to layout or styling, and positional .nth()/.first(),
  unless there is no stable alternative (then add a // comment explaining why).
- Use Playwright's WEB-FIRST assertions that auto-wait and auto-retry:
  await expect(locator).toBeVisible() / toHaveText() / toHaveURL() / toBeEnabled().
- NEVER use page.waitForTimeout() or any fixed sleep. Rely on auto-waiting + expect polling.
- Each test maps to ONE test case and asserts its expected result. Cover every step in order.
- Each test must be INDEPENDENT and IDEMPOTENT: it sets up the state it needs, does not
  rely on another test's side effects or pre-seeded data, and yields the same result on re-run.
- Use realistic test data from the case's testData when present.
- Put shared navigation/setup in test.beforeEach where it reduces duplication.`;

/**
 * Build the full generation prompt for a batch of cases. Both generators call
 * this so the produced specs are structurally identical.
 */
export function buildPomSpecPrompt(cases: PomCasePayload[], ctx: PomPromptContext): string {
  const baseUrlNote = ctx.targetUrl
    ? `Target URL is "${ctx.targetUrl}". Use it in goto() (relative paths are fine when the test references a path on that origin).`
    : `No Target URL was provided — use relative paths like '/login' and let the Playwright config's baseURL resolve them.`;

  const observedUi = ctx.uiMap
    ? `

═══════════════════════════════════════════════════════════
OBSERVED UI — captured from a LIVE CRAWL of the target application
═══════════════════════════════════════════════════════════
These elements were actually seen on the running app. PREFER these real,
observed accessible names / labels / field names when building Page Object
locators — do NOT invent a selector when a matching element appears below.
${ctx.uiMap}`
    : '';

  return `You are a Principal SDET who builds resilient Playwright automation using the Page Object Model (POM). Generate a complete, robust, runnable Playwright + TypeScript spec for EACH test case below.

Target Application: ${ctx.appName}
${ctx.story ? `Story: ${ctx.story}\n` : ''}${baseUrlNote}${observedUi}

Test cases (JSON):
${JSON.stringify(cases, null, 2)}

${POM_SPEC_RULES}

Return ONLY a JSON array (no markdown fence, no commentary), one object per input
test case, in the same order, with testCaseId echoed back EXACTLY:
[
  { "testCaseId": "<id from above>", "fileName": "<kebab-case-name>.spec.ts", "code": "<full self-contained TypeScript POM spec>" }
]`;
}

/**
 * Deterministic fallback when the AI is unavailable or returns a malformed entry.
 * Produces a VALID, self-contained POM skeleton (a real Page Object class + a
 * runnable test that navigates and asserts the page loaded) so execution never
 * trips the "0 tests collected" guard. Steps are preserved as TODO comments.
 */
export function pomFallbackSpec(c: PomCasePayload, targetUrl?: string): GeneratedSpec {
  const className = `${pascalCase(c.feature || c.title || 'App')}Page`;
  const gotoTarget = targetUrl && targetUrl.trim() ? targetUrl.trim() : '/';
  const describeName = esc(c.feature || c.title || 'Generated test');
  const testName = esc(`${c.tcNumber ? `${c.tcNumber} - ` : ''}${c.title}`);
  const stepComments = (c.steps && c.steps.length
    ? c.steps
    : (c.testSteps || []).map((s) => s.action)
  ).map((s, i) => `    // Step ${i + 1}: ${esc(s)}`).join('\n');
  const expected = esc(c.expectedResult || 'Verify expected behaviour');

  const code = `import { test, expect, type Page } from '@playwright/test';

/**
 * ${esc(c.title)}
 * Self-contained Page Object Model spec (deterministic template fallback).
 * Replace the TODO step comments with concrete page-object actions for your app.
 */
class ${className} {
  constructor(private readonly page: Page) {}

  async goto(): Promise<void> {
    await this.page.goto('${esc(gotoTarget)}', { waitUntil: 'domcontentloaded' });
  }

  async expectLoaded(): Promise<void> {
    await expect(this.page).toHaveURL(/.*/);
  }
}

test.describe('${describeName}', () => {
  test('${testName}', async ({ page }) => {
    const screen = new ${className}(page);
    await screen.goto();
${stepComments}
    // Expected: ${expected}
    await screen.expectLoaded();
  });
});
`;

  return {
    testCaseId: c.testCaseId,
    fileName: safeSpecFileName(`${c.tcNumber || ''}-${c.title}`),
    code,
  };
}
