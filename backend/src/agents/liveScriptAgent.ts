/**
 * Live Script Generator — works like Playwright's codegen / test-generator
 * agent: it drives a REAL browser while generating.
 *
 * For each test case it runs an observe → decide → act loop:
 *   1. Snapshot the current page's interactive elements (inputs with their
 *      labels/names, buttons, links, selects, headings, alerts).
 *   2. Ask the LLM for the SINGLE next action (goto / fill / click / assert /
 *      done…) as strict JSON, giving it the test case, the actions already
 *      verified, and the live observation.
 *   3. Execute that action in the browser. If it fails (wrong locator, strict
 *      mode violation, timeout) the error is fed back and the LLM picks a
 *      different locator — the failed action is NEVER recorded.
 *   4. When the scenario is complete, the spec is assembled ONLY from actions
 *      that actually executed against the live app — so every locator in the
 *      emitted code is proven, not guessed.
 *
 * Contrast with scriptAgent (batch mode): that crawls once, then generates all
 * specs from a static DOM inventory — locators are grounded but unverified
 * until execution. This agent verifies each step as it goes, like codegen.
 *
 * Falls back to the batch scriptAgent when no target URL is configured, when
 * the browser can't launch, or when live generation fails for every case.
 */
import type { TestOpsState, TestCase, AutomationScript } from './state.js';
import { runLLM, parseJsonFromResponse, llmForStage } from './claude-runner.js';
import { scriptAgent, templateSpec, ensureUniqueSpecPaths, safeFileName, specPathFor } from './scriptAgent.js';
import { crawlAppMap } from './exploreAgent.js';
import { healingAgent } from './healingAgent.js';
import { decryptStored } from '../utils/crypto.js';

type Page = import('@playwright/test').Page;
type Browser = import('@playwright/test').Browser;
type Locator = import('@playwright/test').Locator;

// Lazy chromium load (same pattern as exploreAgent) — @playwright/test is
// already a dependency; no separate `playwright` package needed.
type ChromiumModule = typeof import('@playwright/test').chromium;
let _chromium: ChromiumModule | null = null;
async function loadChromium(): Promise<ChromiumModule> {
  if (_chromium) return _chromium;
  const mod = await import('@playwright/test');
  _chromium = mod.chromium;
  return _chromium;
}

/* ── Tunables ── */
const MAX_ACTIONS_PER_CASE = 28;      // decide/act iterations (incl. retries)
const MAX_CONSECUTIVE_FAILURES = 4;   // same-step retries before giving up
const CASE_TIME_BUDGET_MS = 300_000;  // wall-clock cap per test case
const ACTION_TIMEOUT_MS = 10_000;     // per locator action
const NAV_TIMEOUT_MS = 30_000;
const CONCURRENCY = Math.max(1, Math.min(3, parseInt(process.env.LIVE_GEN_CONCURRENCY || '', 10) || 2));

/* ── Action & locator DSL (what the LLM returns each step) ── */

interface LocatorSpec {
  by: 'role' | 'label' | 'placeholder' | 'text' | 'testid' | 'css';
  /** ARIA role when by === 'role' (button, textbox, link, checkbox, …). */
  role?: string;
  /** Accessible name filter when by === 'role'. */
  name?: string;
  /** The label/placeholder/text/testid/css value for the other kinds. */
  value?: string;
  exact?: boolean;
  /** 0-based disambiguator when several elements match. */
  nth?: number;
}

interface LiveAction {
  action:
    | 'goto' | 'fill' | 'click' | 'select' | 'check' | 'uncheck' | 'press'
    | 'wait_url_change'
    | 'assert_visible' | 'assert_hidden' | 'assert_text' | 'assert_url'
    | 'done' | 'abort';
  locator?: LocatorSpec;
  /** goto url / fill text / select option / press key / assert text / assert_url substring. */
  value?: string;
  /** Short rationale — carried into the spec as a comment for asserts. */
  note?: string;
}

/* ── Locator building (execution) + rendering (codegen) ── */

function buildLocator(page: Page, l: LocatorSpec): Locator {
  let loc: Locator;
  switch (l.by) {
    case 'role':
      loc = page.getByRole((l.role || 'button') as Parameters<Page['getByRole']>[0],
        l.name ? { name: l.name, exact: l.exact } : undefined);
      break;
    case 'label': loc = page.getByLabel(l.value || '', { exact: l.exact }); break;
    case 'placeholder': loc = page.getByPlaceholder(l.value || '', { exact: l.exact }); break;
    case 'text': loc = page.getByText(l.value || '', { exact: l.exact }); break;
    case 'testid': loc = page.getByTestId(l.value || ''); break;
    default: loc = page.locator(l.value || 'body');
  }
  if (typeof l.nth === 'number') loc = loc.nth(l.nth);
  return loc;
}

/** Render the exact source-code equivalent of buildLocator — what codegen emits. */
function locatorCode(l: LocatorSpec): string {
  const j = (s: string) => JSON.stringify(s);
  let code: string;
  switch (l.by) {
    case 'role': {
      const opts = l.name ? `, { name: ${j(l.name)}${l.exact ? ', exact: true' : ''} }` : '';
      code = `page.getByRole(${j(l.role || 'button')}${opts})`;
      break;
    }
    case 'label': code = `page.getByLabel(${j(l.value || '')}${l.exact ? ', { exact: true }' : ''})`; break;
    case 'placeholder': code = `page.getByPlaceholder(${j(l.value || '')}${l.exact ? ', { exact: true }' : ''})`; break;
    case 'text': code = `page.getByText(${j(l.value || '')}${l.exact ? ', { exact: true }' : ''})`; break;
    case 'testid': code = `page.getByTestId(${j(l.value || '')})`; break;
    default: code = `page.locator(${j(l.value || 'body')})`;
  }
  if (typeof l.nth === 'number') code += `.nth(${l.nth})`;
  return code;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/* ── Live page observation (what the LLM "sees" each step) ── */

async function observePage(page: Page): Promise<string> {
  const data = await page.evaluate(() => {
    const visible = (el: Element) => {
      const r = (el as HTMLElement).getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    };
    const txt = (s: string | null | undefined, n = 70) => (s || '').replace(/\s+/g, ' ').trim().slice(0, n);
    const inputs: string[] = [];
    document.querySelectorAll('input, textarea').forEach((el) => {
      const e = el as HTMLInputElement;
      if (!visible(e) || e.type === 'hidden') return;
      let label = e.getAttribute('aria-label') || e.getAttribute('placeholder') || '';
      if (!label && e.id) {
        const l = document.querySelector(`label[for="${CSS.escape(e.id)}"]`);
        if (l) label = txt(l.textContent);
      }
      if (!label && e.labels && e.labels[0]) label = txt(e.labels[0].textContent);
      inputs.push(`${e.tagName.toLowerCase()} type=${e.type || 'text'}${e.name ? ` name="${e.name}"` : ''}${e.id ? ` id="${e.id}"` : ''}${label ? ` label/placeholder="${txt(label)}"` : ''}`);
    });
    const selects: string[] = [];
    document.querySelectorAll('select').forEach((el) => {
      const e = el as HTMLSelectElement;
      if (!visible(e)) return;
      const opts = Array.from(e.options).slice(0, 8).map((o) => txt(o.textContent, 40));
      selects.push(`select${e.name ? ` name="${e.name}"` : ''}${e.id ? ` id="${e.id}"` : ''} options=[${opts.join(' | ')}]`);
    });
    const buttons: string[] = [];
    document.querySelectorAll('button, [role="button"], input[type="submit"], input[type="button"]').forEach((el) => {
      if (!visible(el)) return;
      const label = txt((el as HTMLElement).innerText || el.getAttribute('aria-label') || (el as HTMLInputElement).value);
      if (label) buttons.push(label);
    });
    const links: string[] = [];
    document.querySelectorAll('a[href]').forEach((el) => {
      if (!visible(el)) return;
      const label = txt((el as HTMLElement).innerText);
      if (label) links.push(label);
    });
    const headings: string[] = [];
    document.querySelectorAll('h1, h2, h3').forEach((el) => {
      if (!visible(el)) return;
      const label = txt((el as HTMLElement).innerText);
      if (label) headings.push(label);
    });
    const alerts: string[] = [];
    document.querySelectorAll('[role="alert"], .error, .alert, .toast, .invalid-feedback').forEach((el) => {
      if (!visible(el)) return;
      const label = txt((el as HTMLElement).innerText, 140);
      if (label) alerts.push(label);
    });
    const uniq = (a: string[], n: number) => Array.from(new Set(a)).slice(0, n);
    return {
      inputs: uniq(inputs, 30), selects: uniq(selects, 12), buttons: uniq(buttons, 25),
      links: uniq(links, 25), headings: uniq(headings, 12), alerts: uniq(alerts, 6),
    };
  }).catch(() => null);

  const lines: string[] = [`URL: ${page.url()}`, `Title: ${await page.title().catch(() => '')}`];
  if (!data) { lines.push('(could not inspect DOM — page may be navigating)'); return lines.join('\n'); }
  if (data.headings.length) lines.push(`Headings: ${data.headings.map((h) => `"${h}"`).join(', ')}`);
  if (data.alerts.length) lines.push(`Alerts/errors visible: ${data.alerts.map((a) => `"${a}"`).join(', ')}`);
  if (data.inputs.length) { lines.push('Inputs:'); data.inputs.forEach((i) => lines.push(`  • ${i}`)); }
  if (data.selects.length) { lines.push('Selects:'); data.selects.forEach((s) => lines.push(`  • ${s}`)); }
  if (data.buttons.length) lines.push(`Buttons: ${data.buttons.map((b) => `"${b}"`).join(', ')}`);
  if (data.links.length) lines.push(`Links: ${data.links.map((l) => `"${l}"`).join(', ')}`);
  return lines.join('\n');
}

/* ── Action execution + codegen ── */

interface RecordedAction { code: string }

/**
 * Execute one LLM-chosen action against the live page. Throws with a concise
 * reason on failure (fed back to the LLM). On success returns the exact spec
 * line(s) proving this step.
 */
async function executeAction(
  page: Page,
  act: LiveAction,
  baseUrl: string,
  urlBeforePrevAction: string,
): Promise<RecordedAction> {
  const j = (s: string) => JSON.stringify(s);
  switch (act.action) {
    case 'goto': {
      const raw = (act.value || '/').trim();
      const abs = /^https?:/i.test(raw) ? raw : new URL(raw, baseUrl).toString();
      await page.goto(abs, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });
      await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
      // Record a baseURL-relative path when possible so the spec is portable.
      let recorded = abs;
      try {
        const u = new URL(abs); const b = new URL(baseUrl);
        if (u.origin === b.origin) recorded = `${u.pathname}${u.search}` || '/';
      } catch { /* keep abs */ }
      return { code: `await page.goto(${j(recorded)});` };
    }
    case 'fill': {
      const loc = buildLocator(page, act.locator!);
      await loc.fill(act.value ?? '', { timeout: ACTION_TIMEOUT_MS });
      return { code: `await ${locatorCode(act.locator!)}.fill(${j(act.value ?? '')});` };
    }
    case 'click': {
      const loc = buildLocator(page, act.locator!);
      await loc.click({ timeout: ACTION_TIMEOUT_MS });
      await page.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => {});
      return { code: `await ${locatorCode(act.locator!)}.click();` };
    }
    case 'select': {
      const loc = buildLocator(page, act.locator!);
      await loc.selectOption({ label: act.value ?? '' }, { timeout: ACTION_TIMEOUT_MS })
        .catch(async () => { await loc.selectOption(act.value ?? '', { timeout: ACTION_TIMEOUT_MS }); });
      return { code: `await ${locatorCode(act.locator!)}.selectOption(${j(act.value ?? '')});` };
    }
    case 'check': {
      const loc = buildLocator(page, act.locator!);
      await loc.check({ timeout: ACTION_TIMEOUT_MS });
      return { code: `await ${locatorCode(act.locator!)}.check();` };
    }
    case 'uncheck': {
      const loc = buildLocator(page, act.locator!);
      await loc.uncheck({ timeout: ACTION_TIMEOUT_MS });
      return { code: `await ${locatorCode(act.locator!)}.uncheck();` };
    }
    case 'press': {
      const key = act.value || 'Enter';
      if (act.locator) {
        const loc = buildLocator(page, act.locator);
        await loc.press(key, { timeout: ACTION_TIMEOUT_MS });
        return { code: `await ${locatorCode(act.locator)}.press(${j(key)});` };
      }
      await page.keyboard.press(key);
      return { code: `await page.keyboard.press(${j(key)});` };
    }
    case 'wait_url_change': {
      // Confirm the last click/submit actually navigated away (login contract).
      await page.waitForURL((u) => u.toString() !== urlBeforePrevAction, { timeout: 20_000 });
      return { code: `await page.waitForURL((u) => u.toString() !== ${j(urlBeforePrevAction)}, { timeout: 30000 });` };
    }
    case 'assert_visible': {
      const loc = buildLocator(page, act.locator!);
      await loc.first().waitFor({ state: 'visible', timeout: ACTION_TIMEOUT_MS });
      return { code: `await expect(${locatorCode(act.locator!)}).toBeVisible({ timeout: 15000 });` };
    }
    case 'assert_hidden': {
      const loc = buildLocator(page, act.locator!);
      await loc.first().waitFor({ state: 'hidden', timeout: ACTION_TIMEOUT_MS });
      return { code: `await expect(${locatorCode(act.locator!)}).toBeHidden({ timeout: 15000 });` };
    }
    case 'assert_text': {
      const loc = buildLocator(page, act.locator!);
      const actual = await loc.first().innerText({ timeout: ACTION_TIMEOUT_MS });
      const want = (act.value || '').trim();
      if (!actual.toLowerCase().includes(want.toLowerCase())) {
        throw new Error(`Text mismatch: expected to find "${want}" but element shows "${actual.replace(/\s+/g, ' ').slice(0, 140)}"`);
      }
      return { code: `await expect(${locatorCode(act.locator!)}).toContainText(${j(want)}, { timeout: 15000 });` };
    }
    case 'assert_url': {
      const frag = act.value || '';
      await page.waitForURL((u) => u.toString().includes(frag), { timeout: 15_000 });
      return { code: `await expect(page).toHaveURL(new RegExp(${j(escapeRegex(frag))}), { timeout: 15000 });` };
    }
    default:
      throw new Error(`Unsupported action "${act.action}"`);
  }
}

/* ── LLM step prompt ── */

function credentialsBlock(state: TestOpsState): string {
  const roles = (state.appContext?.roles || []).filter((r) => r.username);
  if (!roles.length) return '';
  // Passwords may arrive encrypted-at-rest (__ENC__…) — decrypt so the agent
  // types real credentials into the live login form, not an opaque blob.
  return `\nLOGIN CREDENTIALS (use these EXACT values when the scenario needs sign-in):\n${roles.map((r) => `- Role "${r.roleName}": username="${r.username}" password="${decryptStored(String(r.password || ''))}"`).join('\n')}\n`;
}

/** Context for a healing run: the spec that failed and its runtime error. */
export interface HealContext { previousCode: string; error: string }

function buildStepPrompt(
  tc: TestCase,
  state: TestOpsState,
  recorded: RecordedAction[],
  observation: string,
  lastError: string | null,
  heal?: HealContext,
): string {
  const stepsList = (tc.steps || []).map((s) => `  ${s}`).join('\n') || '  (no explicit steps — derive from the scenario)';
  const doneSoFar = recorded.length
    ? recorded.map((r) => `  ${r.code}`).join('\n')
    : '  (nothing yet — the browser is on a blank page; your first action MUST be "goto")';
  const healBlock = heal
    ? `\nTHIS IS A HEALING RUN. A previously generated test for this scenario FAILED when executed:
--- previous (failing) test code ---
${heal.previousCode.slice(0, 4000)}
--- the actual runtime failure ---
${heal.error.slice(0, 800)}
Rebuild the scenario live: reuse the approach/steps that clearly worked, avoid the exact locator or assumption that failed above, and let the live observations correct you. Do NOT weaken or drop the expected-result verification to force a pass.\n`
    : '';
  return `You are a live Playwright test-generation agent. You are driving a REAL browser RIGHT NOW — each action you return is executed immediately, and only actions that succeed are recorded into the final test.
${healBlock}
TEST CASE
Scenario: ${tc.scenario}
Steps:
${stepsList}
Expected result: ${tc.expectedResult || '(assert the scenario outcome)'}
${tc.precondition ? `Precondition: ${tc.precondition}\n` : ''}${credentialsBlock(state)}
ACTIONS ALREADY EXECUTED AND VERIFIED (do not repeat these):
${doneSoFar}
${lastError ? `\nYOUR LAST ACTION FAILED — do something different (different locator kind, different element, or a missing intermediate step):\n  ${lastError}\n` : ''}
CURRENT LIVE PAGE OBSERVATION:
${observation}

Return the SINGLE next action as STRICT JSON (no markdown, no commentary), using this schema:
{"action":"goto|fill|click|select|check|uncheck|press|wait_url_change|assert_visible|assert_hidden|assert_text|assert_url|done|abort","locator":{"by":"role|label|placeholder|text|testid|css","role":"button","name":"Save","value":"...","exact":false,"nth":0},"value":"...","note":"short reason"}

Rules:
- ONE action per response. Pick locators FROM THE OBSERVATION — prefer by:"role" with the visible name, then by:"label"/"placeholder"; use by:"css" (value = CSS selector, e.g. input[name="email"]) only when nothing semantic exists. Never invent test ids.
- "locator.value" carries the label/placeholder/text/css string; for by:"role" use "role" + "name".
- The test starts on a blank page: if nothing is recorded yet, the first action MUST be "goto" (value = path like "/" or "/login").
- After submitting a login form, return "wait_url_change" to prove the app left the login page. Never assert login-form elements after logging in.
- Cover every test step in order. Then VERIFY the expected result with an assert_* action before returning "done".
- For negative cases, assert the visible error/validation message (see "Alerts/errors visible" in the observation).
- If the scenario cannot be performed on this application at all, return {"action":"abort","note":"why"}.
- "done" only when all steps are performed AND the expected result was asserted.`;
}

/* ── Spec assembly from verified actions ── */

function buildVerifiedSpec(tc: TestCase, recorded: RecordedAction[]): AutomationScript {
  const body = recorded.map((r) => `  ${r.code}`).join('\n');
  const code = `import { test, expect } from '@playwright/test';\n\n` +
    `// Generated LIVE against the running application — every locator below was\n` +
    `// executed and verified in a real browser at generation time.\n` +
    `test(${JSON.stringify(tc.scenario)}, async ({ page }) => {\n${body}\n});\n`;
  return { testCaseId: tc.id, fileName: safeFileName(tc.scenario), code, path: specPathFor(tc), uses: [] };
}

/* ── Per-case live loop ── */

async function generateOneLive(
  browser: Browser,
  state: TestOpsState,
  tc: TestCase,
  heal?: HealContext,
): Promise<{ script: AutomationScript; verified: boolean; log: string; steps: number }> {
  const baseUrl = state.appContext!.targetUrl!;
  const llm = llmForStage(state.llm, 'script');
  const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1280, height: 800 } });
  await context.addInitScript({ content: 'window.__name = window.__name || function (f) { return f; };' });
  const page = await context.newPage();

  const recorded: RecordedAction[] = [];
  let lastError: string | null = null;
  let consecutiveFailures = 0;
  let urlBeforePrevAction = 'about:blank';
  let outcome: 'done' | 'abort' | 'exhausted' = 'exhausted';
  let abortNote = '';
  const startedAt = Date.now();

  try {
    for (let i = 0; i < MAX_ACTIONS_PER_CASE; i++) {
      if (Date.now() - startedAt > CASE_TIME_BUDGET_MS) { abortNote = 'time budget exhausted'; break; }

      const observation = await observePage(page);
      let act: LiveAction;
      try {
        const resp = await runLLM(buildStepPrompt(tc, state, recorded, observation, lastError, heal), { maxTokens: 1200, llm });
        act = parseJsonFromResponse<LiveAction>(resp);
      } catch (e) {
        lastError = `Your previous response was not valid action JSON (${(e as Error).message.slice(0, 120)}). Return exactly one JSON object.`;
        if (++consecutiveFailures > MAX_CONSECUTIVE_FAILURES) { abortNote = 'model kept returning invalid actions'; break; }
        continue;
      }

      if (act.action === 'done') { outcome = 'done'; break; }
      if (act.action === 'abort') { outcome = 'abort'; abortNote = act.note || 'scenario not applicable'; break; }

      const urlBeforeThis = page.url();
      try {
        const rec = await executeAction(page, act, baseUrl, urlBeforePrevAction);
        recorded.push(rec);
        urlBeforePrevAction = urlBeforeThis;
        lastError = null;
        consecutiveFailures = 0;
      } catch (e) {
        lastError = (e as Error).message.replace(/\s+/g, ' ').slice(0, 300);
        if (++consecutiveFailures > MAX_CONSECUTIVE_FAILURES) { abortNote = `could not perform a step: ${lastError}`; break; }
      }
    }
  } finally {
    await context.close().catch(() => {});
  }

  const hasAssertion = recorded.some((r) => r.code.includes('expect(') || r.code.includes('waitForURL'));
  if (outcome === 'done' && recorded.length > 0 && hasAssertion) {
    return { script: buildVerifiedSpec(tc, recorded), verified: true, log: `verified in ${recorded.length} step(s)`, steps: recorded.length };
  }
  // Couldn't complete live — emit the honest failing placeholder so execution
  // reports it truthfully and the healer has a real signal to regenerate from.
  const reason = outcome === 'abort' ? abortNote : (abortNote || lastError || 'ran out of attempts');
  return { script: templateSpec(tc), verified: false, log: `not verified (${reason})`, steps: recorded.length };
}

/* ── Orchestration ── */

/**
 * Batch fallback with DOM grounding. When live generation can't be used, crawl
 * the target app first so scriptAgent grounds its selectors in the real pages
 * (forms, buttons, headings) instead of inventing them from requirement text —
 * ungrounded selectors are the #1 cause of whole-suite toBeVisible timeouts.
 * The crawl is best-effort: on failure we still generate, but loudly.
 */
async function groundedBatchFallback(state: TestOpsState): Promise<TestOpsState> {
  const targetUrl = state.appContext?.targetUrl;
  if (!targetUrl || state.exploredApp) return scriptAgent(state);
  try {
    console.log(`[liveScriptAgent] crawling ${targetUrl} to ground the batch generator…`);
    const exploredApp = await crawlAppMap(targetUrl, state.appContext || undefined);
    console.log(`[liveScriptAgent] crawl captured ${exploredApp.pages.length} page(s) for grounding`);
    return scriptAgent({ ...state, exploredApp });
  } catch (e) {
    console.warn('[liveScriptAgent] grounding crawl failed — batch generation will use UNVERIFIED selectors:', (e as Error).message);
    return scriptAgent(state);
  }
}

/**
 * Drop-in alternative to scriptAgent. Requires appContext.targetUrl; otherwise
 * (or when the browser can't launch / nothing verifies) falls back to the
 * batch generator so script generation never comes back empty.
 */
export async function liveScriptAgent(state: TestOpsState): Promise<TestOpsState> {
  const eligible = state.testCases;
  if (eligible.length === 0) return { ...state, automationScripts: [], pageObjects: [] };
  if (!state.appContext?.targetUrl) return scriptAgent(state);

  let browser: Browser;
  try {
    const chromium = await loadChromium();
    browser = await chromium.launch({ headless: true });
  } catch (e) {
    console.warn('[liveScriptAgent] browser launch failed — falling back to batch generation:', (e as Error).message);
    return groundedBatchFallback(state);
  }

  const results = new Array<{ script: AutomationScript; verified: boolean; log: string; steps: number }>(eligible.length);
  try {
    // Small worker pool: one shared browser, isolated context per test case.
    let nextIdx = 0;
    const worker = async () => {
      for (;;) {
        const idx = nextIdx++;
        if (idx >= eligible.length) return;
        const tc = eligible[idx]!;
        try {
          results[idx] = await generateOneLive(browser, state, tc);
        } catch (e) {
          results[idx] = { script: templateSpec(tc), verified: false, log: `error: ${(e as Error).message.slice(0, 200)}`, steps: 0 };
        }
        console.log(`[liveScriptAgent] ${tc.id}: ${results[idx]!.log}`);
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, eligible.length) }, worker));
  } finally {
    await browser.close().catch(() => {});
  }

  const verifiedCount = results.filter((r) => r?.verified).length;
  if (verifiedCount === 0) {
    // Live mode produced nothing usable (app unreachable? model trouble?) —
    // the batch generator is strictly better than a page of placeholders.
    console.warn('[liveScriptAgent] no test case could be verified live — falling back to batch generation');
    return groundedBatchFallback(state);
  }
  console.log(`[liveScriptAgent] ${verifiedCount}/${eligible.length} spec(s) verified live against ${state.appContext.targetUrl}`);
  return {
    ...state,
    // Live specs are self-contained (codegen-style, proven locators) — no POM
    // files needed; execution handles page-object-free specs natively.
    pageObjects: [],
    automationScripts: ensureUniqueSpecPaths(results.map((r) => r.script)),
  };
}

/**
 * Live Healing Agent — the healing counterpart, working like Playwright's
 * test-healer agent: instead of text-patching the failing spec and hoping the
 * re-run agrees, it REPLAYS each failing scenario in a real browser, seeded
 * with the failing code + its exact runtime error, rebuilds the flow step by
 * step against the live DOM, and only accepts a heal that actually completed
 * (every step executed, expected result asserted) at heal time.
 *
 * Contract mirrors healingAgent: takes the state with failed cases + per-test
 * errors, returns updated scripts/notes; the caller re-executes the suite for
 * the authoritative pass/fail. Unverifiable cases keep their ORIGINAL script
 * (a stable failure beats a stub). Falls back to the text healer when there is
 * no target URL, the browser can't launch, or nothing verifies live.
 */
export async function liveHealingAgent(
  state: TestOpsState,
  opts?: { failuresByTc?: Record<string, string> },
): Promise<TestOpsState> {
  const failedCases = state.testCases.filter((tc) => tc.status === 'failed');
  if (failedCases.length === 0) return state;
  if (!state.appContext?.targetUrl) return healingAgent(state, opts);

  const failuresByTc: Record<string, string> = opts?.failuresByTc || Object.fromEntries(
    (state.executionResults?.details || [])
      .filter((d) => d.status === 'failed' && d.error)
      .map((d) => [d.testCaseId, d.error as string]),
  );

  let browser: Browser;
  try {
    const chromium = await loadChromium();
    browser = await chromium.launch({ headless: true });
  } catch (e) {
    console.warn('[liveHealingAgent] browser launch failed — falling back to text healing:', (e as Error).message);
    return healingAgent(state, opts);
  }

  const scriptById = new Map(state.automationScripts.map((s) => [s.testCaseId, s]));
  const healingNotes: Record<string, string> = { ...(state.healingNotes || {}) };
  const healed = new Map<string, AutomationScript>();

  try {
    let nextIdx = 0;
    const worker = async () => {
      for (;;) {
        const idx = nextIdx++;
        if (idx >= failedCases.length) return;
        const tc = failedCases[idx]!;
        const prev = scriptById.get(tc.id);
        const heal: HealContext = {
          previousCode: prev?.code || '(no script was generated for this case)',
          error: failuresByTc[tc.id] || state.failureReason || 'Test failed',
        };
        try {
          const r = await generateOneLive(browser, state, tc, heal);
          if (r.verified) {
            healed.set(tc.id, r.script);
            healingNotes[tc.id] = `Rebuilt and verified live against the running app (${r.steps} steps)`;
          } else {
            healingNotes[tc.id] = `Live heal could not verify this scenario — ${r.log}`;
          }
          console.log(`[liveHealingAgent] ${tc.id}: ${r.log}`);
        } catch (e) {
          healingNotes[tc.id] = `Live heal error: ${(e as Error).message.slice(0, 200)}`;
          console.warn(`[liveHealingAgent] ${tc.id}:`, (e as Error).message);
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, failedCases.length) }, worker));
  } finally {
    await browser.close().catch(() => {});
  }

  if (healed.size === 0) {
    // Nothing could be verified live (app down? scenarios impossible?) —
    // the text healer may still fix structural defects (imports, credentials).
    console.warn('[liveHealingAgent] no failing case verified live — falling back to text healing');
    return healingAgent({ ...state, healingNotes }, opts);
  }

  // Replace healed specs; keep every other script byte-identical. Healed specs
  // are self-contained (no page-object imports), so existing POM files stay
  // for the untouched specs.
  const updatedScripts = ensureUniqueSpecPaths(
    state.automationScripts.map((s) => healed.get(s.testCaseId) || s),
  );
  // A failed case that never had a script at all still gets its healed spec.
  for (const [tcId, script] of healed) {
    if (!updatedScripts.some((s) => s.testCaseId === tcId)) updatedScripts.push(script);
  }
  const updatedCases = state.testCases.map((tc) =>
    tc.status === 'failed' && healed.has(tc.id) ? { ...tc, status: 'automated' as const } : tc,
  );
  const stillFailed = updatedCases.filter((tc) => tc.status === 'failed').length;
  console.log(`[liveHealingAgent] ${healed.size}/${failedCases.length} failing test(s) rebuilt and verified live`);

  return {
    ...state,
    testCases: updatedCases,
    automationScripts: updatedScripts,
    healingAttempted: true,
    healingNotes,
    failureReason: stillFailed > 0 ? `${stillFailed} test(s) could not be healed` : null,
    executionResults: state.executionResults ? { ...state.executionResults, failed: stillFailed } : null,
  };
}
