import type { TestOpsState, AutomationScript, PageObjectFile } from './state.js';
import { runLLM, parseJsonFromResponse, llmForStage } from './claude-runner.js';
import { scriptAgent, sanitizeLoginFlow } from './scriptAgent.js';
import { decryptStored } from '../utils/crypto.js';

/**
 * Healing agent — fixes failing tests, then the caller RE-EXECUTES them.
 *
 * Diagnosis-first, mirroring .github/agents/playwright-test-healer.agent.md:
 * every failure is classified BEFORE the model sees it, deterministic defects
 * (encrypted credential literals) are repaired without an LLM call, and the
 * model is told the failure category plus the application context (URL +
 * real credentials) so it fixes the root cause instead of guess-patching
 * selectors.
 *
 * Two repair modes:
 *   1. REGENERATE (rerun/retry): when the page objects are missing or specs
 *      failed to even LOAD (e.g. "Cannot find module …/pages/…"), a text patch
 *      can't help — the broken thing is structural. We regenerate a
 *      self-consistent POM (page objects + specs, with deterministic imports)
 *      for the failing cases via the script agent so they resolve on retry.
 *   2. TEXT-HEAL: when the POM is intact, patch the failing spec's navigation /
 *      selectors / waits / assertions, giving the model the page-object source
 *      it uses.
 */

/**
 * Parse the healer's delimiter-based response into { fileName, code, pageObject }.
 *
 * The corrected files are returned RAW between `===MARKER===` lines rather than
 * as JSON strings — Playwright/TypeScript is full of quotes and backslashes, and
 * embedding it in JSON regularly produced invalid JSON ("Unexpected token …")
 * that sank the whole heal. Reading between plain-text markers can't be broken
 * by the code's own punctuation. Falls back to the legacy JSON shape if a model
 * ignores the format.
 */
function parseHealResponse(response: string): { fileName: string; code: string; pageObject?: { path: string; code: string } } {
  const between = (startRe: RegExp, endRe: RegExp): string => {
    const s = response.match(startRe);
    if (!s || s.index === undefined) return '';
    const from = s.index + s[0].length;
    const rest = response.slice(from);
    const e = rest.match(endRe);
    const raw = e && e.index !== undefined ? rest.slice(0, e.index) : rest;
    // Strip any stray ```lang / ``` fences a model may add around the code.
    return raw.replace(/^\s*```[a-zA-Z]*\s*\n?/, '').replace(/\n?```\s*$/, '').trim();
  };

  if (/===\s*SPEC\s*===/i.test(response)) {
    const fileName = between(/===\s*FILENAME\s*===/i, /===\s*SPEC\s*===/i);
    const code = between(/===\s*SPEC\s*===/i, /===\s*PAGEOBJECT_PATH\s*===/i);
    const poPath = between(/===\s*PAGEOBJECT_PATH\s*===/i, /===\s*PAGEOBJECT\s*===/i);
    const poCode = between(/===\s*PAGEOBJECT\s*===/i, /===\s*END\s*===/i);
    return {
      fileName,
      code,
      pageObject: poPath && poCode ? { path: poPath, code: poCode } : undefined,
    };
  }

  // Fallback: a model that still emitted JSON (best-effort, may throw → caught upstream).
  return parseJsonFromResponse<{ fileName: string; code: string; pageObject?: { path: string; code: string } }>(response);
}

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

/**
 * Application-under-test block for the heal prompt. The healer cannot fix a
 * wrong URL or wrong credentials it never saw — this is what turns "swap one
 * guessed locator for another" into an actual root-cause fix.
 */
function buildAppContextBlock(state: TestOpsState): string {
  const ctx = state.appContext;
  if (!ctx) return '';
  const lines: string[] = [];
  if (ctx.targetUrl) {
    lines.push(`- Base URL: ${ctx.targetUrl}  (relative page.goto('/path') calls resolve against this — it is configured as Playwright's baseURL)`);
  }
  for (const r of ctx.roles || []) {
    if (!r.username) continue;
    lines.push(`- Credentials — role "${r.roleName}": username="${r.username}" password="${decryptStored(String(r.password || ''))}" (EXACT literal values)`);
  }
  if (lines.length === 0) return '';
  return `\nAPPLICATION UNDER TEST:\n${lines.join('\n')}\nNever emit placeholder or encrypted-looking strings ("__ENC__...", "__AES__...") as credentials — use the exact values above.\n`;
}

const ENCRYPTED_LITERAL_RE = /__(?:ENC|AES)__[A-Za-z0-9+/=]+/g; // /g for .replace() only
// Non-global sibling for boolean checks — .test() on a /g regex is stateful
// (lastIndex persists across calls), which silently misclassifies every other test.
const ENCRYPTED_LITERAL_TEST_RE = /__(?:ENC|AES)__[A-Za-z0-9+/=]+/;

/**
 * Deterministic pre-heal repair: encrypted credential blobs that leaked into
 * generated code (e.g. `login('Admin', '__ENC__...')`) are decryptable without
 * an LLM. Fixing them here means the repair survives even when the model call
 * for that spec fails, and the model never sees (and re-emits) the blob.
 */
function scrubEncryptedLiterals(code: string): { code: string; replaced: number } {
  let replaced = 0;
  const out = code.replace(ENCRYPTED_LITERAL_RE, (match) => {
    try {
      const plain = decryptStored(match);
      // The XOR (__ENC__) path never throws — a mangled/invented blob "decrypts"
      // to garbage bytes. Only substitute printable output; otherwise leave the
      // literal for the LLM (which gets the real credentials in its prompt).
      const printable = !!plain && /^[\x20-\x7E]+$/.test(plain);
      if (printable && plain !== match && !plain.startsWith('__ENC__') && !plain.startsWith('__AES__')) {
        replaced++;
        // The blob sits inside a TS string literal of unknown quote style.
        // Identity escapes (\' \" \`) are valid in all three literal flavors,
        // so escaping every delimiter keeps the code syntactically correct
        // while preserving the runtime value.
        return plain
          .replace(/\\/g, '\\\\')
          .replace(/'/g, "\\'")
          .replace(/"/g, '\\"')
          .replace(/`/g, '\\`')
          .replace(/\$\{/g, '\\${');
      }
    } catch {
      // undecryptable (foreign key / corrupt) — leave the literal for the LLM
    }
    return match;
  });
  return { code: out, replaced };
}

type FailureCategory = 'module-load' | 'navigation' | 'credentials' | 'selector' | 'assertion' | 'timeout' | 'unknown';

/**
 * Classify a failure BEFORE the model sees it (the .agent.md triage table,
 * enforced in code). `combinedCode` is the spec plus every page object it
 * imports — the whole execution path that could have navigated.
 */
function classifyFailure(error: string, combinedCode: string): { category: FailureCategory; guidance: string } {
  const err = error || '';
  if (/cannot find module|failed to load|cannot resolve|missing page object/i.test(err)) {
    return {
      category: 'module-load',
      guidance: 'The spec failed to LOAD (broken import). Fix the import path/structure; do not touch selectors.',
    };
  }
  const navigates = /\.goto\s*\(/.test(combinedCode);
  if (!navigates && /waiting for|timeout/i.test(err)) {
    return {
      category: 'navigation',
      guidance: 'ROOT CAUSE: this test NEVER NAVIGATES — neither the spec nor its page objects call page.goto(), so every locator waits on a blank about:blank page until it times out. Fix by making the first interaction navigate: the page object method that starts the flow (e.g. login()) must begin with `await this.page.goto(\'/<login path>\')` (relative paths resolve against the configured baseURL), or the spec must call goto before interacting. Do NOT change selectors to fix this — they never had a page to match against.',
    };
  }
  if (/invalid credentials|401|unauthorized|authentication failed/i.test(err) || ENCRYPTED_LITERAL_TEST_RE.test(combinedCode)) {
    return {
      category: 'credentials',
      guidance: 'The test signs in with wrong credentials (placeholder/encrypted values). Replace them with the EXACT credentials from APPLICATION UNDER TEST.',
    };
  }
  if (/waiting for locator|strict mode violation|element\(s\)? not found|resolved to \d+ elements|not visible/i.test(err)) {
    return {
      category: 'selector',
      guidance: 'A locator does not match the live DOM. Replace it with the matching REAL element (prefer the LIVE APP DOM inventory; use getByRole/getByLabel/getByPlaceholder/getByText). Fix it in the page object, not the spec.',
    };
  }
  if (/expect\(|toHave|toBe|toEqual|received/i.test(err)) {
    return {
      category: 'assertion',
      guidance: 'An assertion failed. Determine whether the expectation is wrong (fix the expected value/locator) or the flow is wrong (fix the steps). NEVER delete or weaken the assertion just to make the test pass.',
    };
  }
  if (/timeout.*exceeded/i.test(err)) {
    return {
      category: 'timeout',
      guidance: 'A step timed out. Check the flow reaches the right page/state first (navigation, prior steps), then add targeted waits (`await expect(locator).toBeVisible({ timeout: 20000 })`) — never blanket waitForTimeout.',
    };
  }
  return {
    category: 'unknown',
    guidance: 'Diagnose from the error text and fix the root cause with the smallest change that makes the test genuinely valid.',
  };
}

export async function healingAgent(
  state: TestOpsState,
  opts?: { failuresByTc?: Record<string, string> },
): Promise<TestOpsState> {
  if (!state.failureReason) return state;

  const failedCases = state.testCases.filter((tc) => tc.status === 'failed');
  if (failedCases.length === 0) return state;

  // Per-test errors: explicit map from the /heal route, or recovered from the
  // execution details (runPipeline path) — never heal N specs against one
  // shared error string.
  const failuresByTc: Record<string, string> = opts?.failuresByTc || Object.fromEntries(
    (state.executionResults?.details || [])
      .filter((d) => d.status === 'failed' && d.error)
      .map((d) => [d.testCaseId, d.error as string]),
  );

  const healingNotes: Record<string, string> = { ...(state.healingNotes || {}) };

  // Deterministic pre-heal: repair encrypted credential literals in ALL code
  // (also in passing specs — the blob is wrong everywhere it appears).
  let scrubbedCount = 0;
  const scrubbedScripts = state.automationScripts.map((s) => {
    const { code, replaced } = scrubEncryptedLiterals(s.code);
    scrubbedCount += replaced;
    return replaced ? { ...s, code } : s;
  });
  const scrubbedPageObjects = (state.pageObjects || []).map((p) => {
    const { code, replaced } = scrubEncryptedLiterals(p.code);
    scrubbedCount += replaced;
    return replaced ? { ...p, code } : p;
  });
  if (scrubbedCount > 0) {
    console.warn(`[healingAgent] replaced ${scrubbedCount} encrypted credential literal(s) baked into generated code`);
  }
  state = { ...state, automationScripts: scrubbedScripts, pageObjects: scrubbedPageObjects };

  const domInventory = buildDomInventory(state);
  const appContextBlock = buildAppContextBlock(state);

  const pageObjects = state.pageObjects || [];
  const moduleError = /cannot find module|failed to load|cannot resolve|missing page object/i.test(state.failureReason || '');
  const pomMissing = pageObjects.length === 0;

  // ── Mode 1: regenerate the POM for the failing cases and retry ──
  if ((moduleError || pomMissing) && state.llm) {
    try {
      const regen = await scriptAgent({ ...state, testCases: failedCases, automationScripts: [], pageObjects: [] });
      // scriptAgent falls back to a TODO template stub when a spec batch fails.
      // The stub now FAILS honestly (see scriptAgent.templateSpec) and imports
      // nothing, so ALWAYS take the regenerated spec — a stub is self-consistent
      // and will re-run to a real failure, whereas KEEPING the old failing spec
      // re-introduces its (now-missing) page-object import and aborts the whole
      // suite with "Cannot find module". Consistency beats a stale spec.
      const isTemplateStub = (s: AutomationScript) => s.code.includes('TODO: implement steps:');
      const regenById = new Map(regen.automationScripts.map((s) => [s.testCaseId, s]));

      // Replace each failing spec with its regenerated version; keep the rest.
      const updatedScripts: AutomationScript[] = state.automationScripts.map((s) => regenById.get(s.testCaseId) || s);
      for (const s of regen.automationScripts) {
        if (!updatedScripts.some((x) => x.testCaseId === s.testCaseId)) updatedScripts.push(s);
      }

      // Union page objects by path (regenerated ones win, so imports resolve).
      const poByPath = new Map<string, PageObjectFile>(pageObjects.map((p) => [p.path, p]));
      for (const p of regen.pageObjects || []) poByPath.set(p.path, p);

      // A stub is self-consistent but not a real fix — note it (re-execution
      // reports the true pass/fail either way).
      const updatedCases = state.testCases.map((tc) =>
        tc.status === 'failed' && regenById.has(tc.id) && !isTemplateStub(regenById.get(tc.id)!) ? { ...tc, status: 'automated' as const } : tc,
      );
      const uncovered = failedCases.filter((tc) => !regenById.has(tc.id) || isTemplateStub(regenById.get(tc.id)!));
      for (const tc of uncovered) {
        healingNotes[tc.id] = regenById.has(tc.id)
          ? 'Regenerated as a placeholder — real selectors could not be produced'
          : 'Regeneration did not produce a script for this case';
        console.warn(`[healingAgent] regeneration left ${tc.id} uncovered`);
      }
      const stillFailed = uncovered.length;

      return {
        ...state,
        automationScripts: updatedScripts,
        pageObjects: [...poByPath.values()],
        testCases: updatedCases,
        healingAttempted: true,
        healingNotes,
        failureReason: stillFailed > 0 ? `${stillFailed} test(s) not covered by regeneration` : null, // re-execution sets the real result
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
    if (!script) {
      healingNotes[tc.id] = 'No script found for this test case';
      return null;
    }

    // Surface the page-object source this spec uses, so the model fixes the
    // right place (selectors live in the page object, not the spec).
    const usedPoSource = (script.uses || [])
      .map((p) => poByPath.get(p))
      .filter((p): p is PageObjectFile => !!p)
      .map((p) => `// ${p.path}\n${p.code}`)
      .join('\n\n');

    const failureText = failuresByTc[tc.id] || state.failureReason || 'Test failed';
    const { category, guidance } = classifyFailure(failureText, `${script.code}\n${usedPoSource}`);

    try {
      const prompt = `You are a Playwright test healer. A test failed; diagnose the root cause from the evidence below, then fix it with the SMALLEST change that makes the test genuinely valid.

Test Case:
- Scenario: ${tc.scenario}
- Feature: ${tc.feature}
- Steps: ${tc.steps.join(' | ')}
- Expected Result: ${tc.expectedResult}
- Type: ${tc.type}
${appContextBlock}
Failing spec (${script.fileName}):
\`\`\`typescript
${script.code}
\`\`\`
${usedPoSource ? `\nPage object(s) this spec imports (fix selectors/navigation HERE — keep the class/method names and import paths EXACTLY):\n\`\`\`typescript\n${usedPoSource}\n\`\`\`\n` : ''}${domInventory}
Failure for THIS test (the actual Playwright error): ${failureText}

DIAGNOSED FAILURE CATEGORY: ${category}
${guidance}

Return the corrected files using EXACTLY this delimiter format — NOT JSON, no markdown code fences. Put the code RAW between the markers (do not escape quotes or backslashes; the markers alone delimit each section):

===FILENAME===
same-or-corrected-filename.spec.ts
===SPEC===
<the full corrected spec code, verbatim>
===PAGEOBJECT_PATH===
<src/pages/<module>/<name>.page.ts — or leave this line blank if you did NOT change the page object>
===PAGEOBJECT===
<the full corrected page object code, verbatim — or leave blank if unchanged>
===END===

Rules:
- Fix the DIAGNOSED root cause above — do not shotgun unrelated changes.
- LOGIN vs POST-LOGIN (a very common root cause): if the test signs in and then waits for a LOGIN-form element (username/password/login button) to be visible, THAT is the bug — clicking Login navigates away from the login page, so those elements no longer exist and the wait times out. Fix APP-AGNOSTICALLY (never hardcode a login path like '/auth/login'): capture the login url before submit (\`const loginUrl = this.page.url();\`) and await the app leaving it (\`await this.page.waitForURL((u) => u.toString() !== loginUrl, { timeout: 30000 })\`), then assert a POST-login landmark element (dashboard/header/menu) or that the page is no longer on the captured login url — NEVER re-assert the login form after signing in.
- SSO / FEDERATED LOGIN (diagnose this when the failure is "no username/password input found" on the entry page): if the app's login page has NO credential inputs but a single sign-in/continue button (e.g. "Continue Now", "Sign in with Microsoft/SSO"), the credentials form lives on an EXTERNAL identity provider — waiting for a username field on the entry page will ALWAYS time out. Fix the login method to: (1) click the sign-in/continue button, (2) wait 30s for the IdP identifier field (\`input[name="loginfmt"], input[type="email"], input[type="text"]\`), fill + submit (\`input[type="submit"], button[type="submit"], #idSIButton9\`), (3) wait 30s for \`input[name="passwd"], input[type="password"]\`, fill + submit, (4) handle an optional "Stay signed in?" interstitial — identify it by its TEXT (\`getByText(/stay signed in\\?/i)\`) AFTER racing it against leaving the IdP; NEVER click a generic still-visible submit right after the password submit (that double-submits and breaks the flow), (5) finish with \`await this.page.waitForURL((u) => !/login\\.microsoftonline|okta|auth0|accounts\\.google|login\\.windows/i.test(u.toString()), { timeout: 45000 })\`.
- NAVIGATION FIRST: the test must navigate (page.goto) before its first interaction — either in the spec or inside the page-object method that starts the flow. Relative paths resolve against the configured baseURL.
- Keep the spec's import lines EXACTLY as they are (do not change page-object import paths).
- Prefer fixing selectors/navigation in the page object over inlining them in the spec.
- Prefer getByLabel/getByPlaceholder/getByRole(name)/getByText grounded in the real DOM over brittle CSS; add an explicit \`{ timeout: 20000 }\` only where a slow element genuinely needs it.
- NEVER delete, skip (test.skip/fixme), or weaken assertions to force a pass — a healed test must still verify the scenario's expected result.
- NEVER wait for 'networkidle' (\`waitForLoadState('networkidle')\`) or use other discouraged/deprecated APIs (\`waitForTimeout\`, \`waitForNavigation\`, \`page.$\`) — rely on locator auto-waiting and web-first \`expect(...)\` assertions.
- For inherently dynamic data (timestamps, counters, generated ids), use regular expressions to produce resilient locators/assertions instead of exact literals that change every run.
- Use the EXACT credentials from APPLICATION UNDER TEST when the flow signs in; never invent or placeholder them.`;

      const response = await runLLM(prompt, { maxTokens: 12000, llm: llmForStage(state.llm, 'heal') });
      const fixed = parseHealResponse(response);

      if (fixed?.code?.trim()) {
        // Preserve the POM destination + page-object links so re-execution writes
        // the spec at the right path and resolves its imports.
        const healedScript: AutomationScript = {
          testCaseId: tc.id,
          fileName: fixed.fileName?.trim() || script.fileName,
          code: sanitizeLoginFlow(fixed.code),
          path: script.path,
          uses: script.uses,
        };
        const pageObject = (fixed.pageObject?.path && typeof fixed.pageObject.code === 'string' && fixed.pageObject.code.trim())
          ? { path: fixed.pageObject.path, code: fixed.pageObject.code }
          : undefined;
        // Not "Healed" yet — a patch is only proven by the re-run. The route's
        // fixed branch overwrites this with a success message when it passes.
        healingNotes[tc.id] = `Patched (${category}) — still failing after re-run`;
        return { script: healedScript, pageObject };
      }
      healingNotes[tc.id] = `Heal skipped: model returned no code (${category})`;
      console.warn(`[healingAgent] ${tc.id}: model returned no usable code (category=${category})`);
    } catch (err) {
      // Leave the script unchanged, status stays 'failed' — but never silently.
      healingNotes[tc.id] = `Heal failed: ${(err as Error).message?.slice(0, 200) || 'LLM error'} (${category})`;
      console.warn(`[healingAgent] ${tc.id}: heal attempt failed (category=${category}):`, (err as Error).message);
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
    healingNotes,
    failureReason: stillFailed > 0 ? `${stillFailed} test(s) could not be healed` : null,
    executionResults: state.executionResults ? { ...state.executionResults, failed: stillFailed } : null,
  };
}
