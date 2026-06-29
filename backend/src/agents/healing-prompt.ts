/**
 * Shared, production-grade prompt builder for the auto-healing agent.
 *
 * Both the DB-backed heal service (services/healing.service.ts — what the chat
 * wizard uses) and the in-memory pipeline healer (agents/healingAgent.ts) build
 * their fix prompt here, so the QUALITY of the heal is identical no matter which
 * path runs. This is the single most important lever on whether a failing test
 * actually gets fixed, so it is written to:
 *   1. DIAGNOSE the real cause from the actual Playwright error (not guess).
 *   2. Fix the test so it passes FOR THE RIGHT REASON — preserving the original
 *      intent, never weakening/faking/deleting the assertion or skipping.
 *   3. Cover the failure taxonomy we see in practice (assertion-intent
 *      mismatches like "no session cookie" false-positives, brittle selectors,
 *      strict-mode violations, timing races, wrong URL/protocol, connection
 *      refusals).
 */

export interface HealingPromptInput {
  /** Crisp title / scenario of the test (what it must prove). */
  title: string;
  feature?: string;
  type?: string;
  precondition?: string;
  /** Plain-string steps (the generator always keeps these populated). */
  steps?: string[];
  /** Final success criterion for the test. */
  expectedResult?: string;
  /** Current (failing) spec file name. */
  fileName: string;
  /** Current (failing) spec source. */
  code: string;
  /** The REAL error message captured from the Playwright run for THIS test. */
  error: string;
  /** Target application URL, used to correct wrong paths / http→https. */
  targetUrl?: string;
}

/** Shape Claude is required to return. */
export interface HealingFix {
  fileName: string;
  diagnosis: string;
  fix: string;
  code: string;
}

function formatSteps(steps?: string[]): string {
  if (!steps || steps.length === 0) return '(no explicit steps recorded)';
  return steps.map((s, i) => `  ${i + 1}. ${s}`).join('\n');
}

/**
 * Playwright's JSON reporter embeds ANSI colour escape codes in error.message
 * (the noise that renders as [2m / [31m in raw logs). Strip them so the model
 * reads a clean error and we don't waste tokens on terminal control sequences.
 * The pattern is built from char-code 27 (ESC) at runtime so no control byte
 * lives in this source file; ESC is optional, so a bare "[..m" left behind by a
 * JSON round-trip is removed too.
 */
function stripAnsi(s: string): string {
  const ansi = new RegExp(String.fromCharCode(27) + '?\\[[0-9;]*m', 'g');
  return s.replace(ansi, '');
}

export function buildHealingPrompt(input: HealingPromptInput): string {
  const {
    title,
    feature,
    type,
    precondition,
    steps,
    expectedResult,
    fileName,
    code,
    error,
    targetUrl,
  } = input;

  const cleanError = stripAnsi(error || 'No error message was captured.').slice(0, 4000);

  return `You are a Principal SDET and Playwright auto-healing specialist. A generated Playwright test has FAILED during a real execution. Diagnose the true cause from the actual error output, then return a corrected, fully-runnable spec that makes the test pass FOR THE RIGHT REASON — by faithfully verifying the test's original intent, never by weakening, faking, skipping, or deleting the verification.

═══════════════════════════════════════════════════════════
TEST INTENT (what this test must prove — do not change it)
═══════════════════════════════════════════════════════════
- Title:           ${title}
- Feature:         ${feature || '(unspecified)'}
- Type:            ${type || '(unspecified)'}
- Precondition:    ${precondition || '(none)'}
- Target URL:      ${targetUrl || '(use the URL already in the script)'}
- Steps:
${formatSteps(steps)}
- Expected result: ${expectedResult || '(derive from the title and steps)'}

═══════════════════════════════════════════════════════════
FAILING SPEC (${fileName})
═══════════════════════════════════════════════════════════
\`\`\`typescript
${code}
\`\`\`

═══════════════════════════════════════════════════════════
ACTUAL FAILURE OUTPUT (from the Playwright run — this is ground truth)
═══════════════════════════════════════════════════════════
\`\`\`
${cleanError}
\`\`\`

═══════════════════════════════════════════════════════════
DIAGNOSE, THEN FIX — match the error to ONE primary cause:
═══════════════════════════════════════════════════════════
1. ASSERTION-INTENT MISMATCH (the most common false failure). The assertion is testing an over-specific implementation detail instead of the actual intent, so a correctly-behaving app fails it.
   • Classic example: a security / injection / negative-login test asserts "no session cookie was created" via expect(cookie).toBeFalsy(), but the application sets a framework/CSRF session cookie on EVERY page load — even the login page, before any authentication. The cookie's presence does NOT mean the attacker authenticated.
   • Correct fix: assert the REAL success criterion of the intent — that the user is NOT authenticated: the page is still on the login URL, an "Invalid credentials" / error message is visible, and the protected area (e.g. /dashboard) was NOT reached. Do NOT assert on the raw cookie.
   • IMPORTANT inverse case: if a negative / invalid / injection login test UNEXPECTEDLY reaches an authenticated page — e.g. expect(page).not.toHaveURL(/dashboard/) FAILS because the received URL IS the dashboard — then the credentials the test submits are actually being ACCEPTED. The test is using valid credentials (or a payload the app honours) instead of a rejected one. Fix by submitting a clearly-invalid / injection payload the app WILL reject (e.g. username "' OR '1'='1" with a wrong password, or an obviously-bad credential), then assert rejection (stays on the login URL + error visible). Never make it pass by deleting the not.toHaveURL check.
   • General rule: re-derive the assertion from "Expected result", not from a brittle implementation detail.

2. BRITTLE / WRONG LOCATOR (selector not found, resolves to 0 elements, or uses CSS/XPath/data-testid that does not exist).
   • Fix with accessibility-first locators in this order: getByRole(role, { name }) → getByLabel → getByPlaceholder → getByText, using exact, realistic accessible names.
   • If this is an OrangeHRM app: username = getByPlaceholder('Username'); password = getByPlaceholder('Password'); submit = getByRole('button', { name: 'Login' }); login error = getByText('Invalid credentials').

3. STRICT-MODE VIOLATION ("resolved to N elements"). Narrow the locator with an exact name/role, scope it to a container (page.getByRole(...).filter(...)), or append .first() WITH a one-line comment explaining why.

4. TIMING / RACE (element used before render; navigation/submit not awaited; slow page load).
   • Use web-first, auto-retrying assertions: await expect(locator).toBeVisible(), await expect(page).toHaveURL(/.*dashboard/, { timeout: 15000 }), toHaveText(). Add await page.waitForLoadState('networkidle') after navigation or form submit where needed. NEVER use page.waitForTimeout() or any fixed sleep.
   • If page.goto TIMES OUT waiting for the "load" event (e.g. 'page.goto: Timeout 30000ms exceeded ... waiting until "load"'), the app is just slow to fully load every resource. Change the navigation to page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 }) so it proceeds once the DOM is ready instead of blocking on every sub-resource, then rely on web-first assertions for the elements you need.

5. WRONG URL / PROTOCOL / CONNECTION (net::ERR_CONNECTION_REFUSED, ERR_NAME_NOT_RESOLVED, connect ECONNREFUSED, 404, wrong path).
   • Navigate to the correct absolute Target URL above; prefer https:// over http://. Make the FIRST navigation resilient to a transient refusal: retry goto up to 3 times with a short backoff (a for-loop that catches the error and retries), and pass { waitUntil: 'domcontentloaded', timeout: 30000 } to page.goto.
   • This also applies to API calls via request / apiRequestContext (e.g. 'apiRequestContext.get: connect ECONNREFUSED <ip>:80' for request.get('http://...')). A refusal on port 80 means the host serves only HTTPS — change the request URL from http:// to https:// (port 443). Do the same for any baseURL used by the API context.

═══════════════════════════════════════════════════════════
HARD RULES (a "fix" that violates any of these is REJECTED)
═══════════════════════════════════════════════════════════
- PRESERVE INTENT: the healed test must still genuinely verify the Expected result. Never replace a real assertion with a trivially-true one (no expect(true).toBeTruthy(), no expect(1).toBe(1)), never delete the verification, never use test.skip()/test.fixme(), never comment out the assertion to make it "pass".
- SELF-CONTAINED: the spec must run in isolation. Import only from '@playwright/test'. Do NOT import from sibling generated files.
- PRESERVE THE PAGE OBJECT MODEL: the healed spec MUST keep its Page Object class(es) — locators stay declared as 'readonly' Locator fields, interactions stay in intent-named methods, and the test body must NOT introduce raw page.* calls or inline selectors. If the failing spec was not already POM-structured, refactor it INTO a self-contained Page Object class as part of the fix.
- MINIMAL CHANGE: fix the real root cause and keep the same overall scenario and structure.
- COMPLETE OUTPUT: return the ENTIRE corrected file, not a diff or a snippet.

Return ONLY this JSON object (no markdown fence, no commentary before or after):
{
  "fileName": "${fileName}",
  "diagnosis": "<one sentence: the real root cause you identified from the error>",
  "fix": "<one sentence: what you changed and why the test now passes for the right reason>",
  "code": "<the full corrected, runnable TypeScript Playwright spec>"
}`;
}
