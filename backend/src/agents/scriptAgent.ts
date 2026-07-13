import type { TestOpsState, AutomationScript, PageObjectFile, TestCase, ExploredApp } from './state.js';
import { runLLM, parseJsonFromResponse, llmForStage } from './claude-runner.js';

/**
 * Script Agent — generates a Page Object Model (POM) Playwright suite.
 *
 * Two phases:
 *   1. Page objects — one `*.page.ts` per app page/module (shared, NOT 1:1 with
 *      test cases), grounded in the live crawl (`state.exploredApp`). Each
 *      extends `BasePage` (shipped in the client-deliverable scaffold).
 *   2. Specs — one `.spec.ts` per test case that IMPORTS and drives the page
 *      objects from phase 1, never inlining selectors.
 *
 * The cornerstone is a DETERMINISTIC import convention: the generator (not the
 * LLM) computes every relative import path, so specs always resolve their page
 * objects — in the ephemeral execution workspace and in the published repo.
 *
 *   Base page:    src/pages/base.page.ts
 *   Page objects: src/pages/<module>/<name>.page.ts   (import base as ../base.page)
 *   Specs:        tests/<module>/<name>.spec.ts        (import PO as ../../src/pages/<module>/<name>.page)
 */

const BATCH_SIZE = 10;          // test cases per spec-generation LLM call
const PO_BATCH_SIZE = 5;        // page targets per page-object LLM call

/* ─────────────────────────── naming helpers ─────────────────────────── */

function kebab(s: string): string {
  return (s || '')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .toLowerCase()
    .replace(/(^-|-$)/g, '')
    .slice(0, 60) || 'page';
}

function pascal(s: string): string {
  const parts = (s || '').replace(/[^a-zA-Z0-9]+/g, ' ').trim().split(/\s+/);
  const p = parts.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join('');
  return /^[A-Za-z]/.test(p) ? p : `Page${p}`;
}

/** Single, stable module slug used by BOTH phases so paths line up. */
function moduleSlug(s: string | undefined): string {
  const slug = kebab(s || 'app').split('-').slice(0, 3).join('-');
  return slug || 'app';
}

function safeFileName(scenario: string): string {
  return `${kebab(scenario)}.spec.ts`;
}

/** Spec destination, e.g. tests/auth/verify-login-fails.spec.ts */
function specPathFor(tc: TestCase): string {
  return `tests/${moduleSlug(tc.module || tc.feature)}/${safeFileName(tc.scenario)}`;
}

/** Import specifier from any spec (tests/<module>/x.spec.ts) to a page object. */
function specImportFor(po: PageObjectFile): string {
  return `../../${po.path.replace(/\.ts$/, '')}`;
}

/* ─────────────────────────── inventory helpers ─────────────────────────── */

type AppPage = ExploredApp['pages'][number];

/** Per-page selector inventory for grounding one page object. */
function pageInventory(p: AppPage): string {
  const lines: string[] = [];
  for (const form of (p.forms || []).slice(0, 6)) {
    const fields = (form.fields || []).slice(0, 30).map(
      (f) => `    • name="${f.name}" type="${f.type}"${f.label ? ` label/placeholder="${f.label}"` : ''}${f.required ? ' (required)' : ''}`,
    );
    if (fields.length) { lines.push('  Form fields:'); lines.push(...fields); }
  }
  const btns = (p.buttons || []).slice(0, 20);
  if (btns.length) lines.push(`  Buttons/links: ${btns.map((b) => `"${b}"`).join(', ')}`);
  const headings = (p.headings || []).slice(0, 10);
  if (headings.length) lines.push(`  Headings: ${headings.map((h) => `"${h}"`).join(', ')}`);
  return lines.join('\n');
}

const SELECTOR_RULES_GROUNDED = `- GROUND every selector in the page inventory. Do NOT guess.
  • Prefer \`getByLabel\`, \`getByPlaceholder\`, or \`getByRole('textbox', { name })\` when a label/placeholder is shown.
  • When the inventory shows a field's real name/id, target that EXACT attribute value from the inventory (e.g. \`this.page.locator('input[name="<name-from-inventory>"]')\`) — never copy attribute values from other apps or from examples.
  • For buttons, match the real text shown in the inventory. NEVER invent data-testids.`;

const SELECTOR_RULES_UNGROUNDED = `- Use \`getByRole\`, \`getByLabel\`, \`getByPlaceholder\`, \`getByText\`. Avoid invented data-testids.`;

/**
 * The single most common cause of every generated test failing: a sign-in
 * method (login) navigates AWAY from the login page, then the test asserts the
 * login form is still visible. Clicking "Login" leaves the login screen, so
 * `expect(usernameField).toBeVisible()` after login can NEVER pass and times
 * out — sinking the whole suite. These rules make the login flow correct and
 * are injected into BOTH the page-object and spec prompts.
 */
const LOGIN_CONTRACT = `NAVIGATION, LOGIN & READINESS ASSERTIONS — get this EXACTLY right (these are the #1 cause of every test failing). These rules are APP-AGNOSTIC — never hardcode a specific login path (e.g. '/auth/login'); derive everything from the application's OWN url/DOM:
  • BLANK-PAGE RULE: at the start of every test the browser is on a blank page. The FIRST thing a test does MUST be an action that NAVIGATES — a page-object method whose body starts with \`await this.page.goto('<the app's login/entry path>')\` (e.g. \`login()\`, \`open()\`). NEVER put a bare readiness/visibility assertion (\`expectLoaded()\`, \`expect(locator).toBeVisible()\`) BEFORE the first navigation — there is nothing on screen yet, so it ALWAYS times out.
  • A sign-in method (e.g. \`login(user, pass)\`) MUST: navigate to the login page, CAPTURE that url (\`const loginUrl = this.page.url();\`), fill + submit, then CONFIRM the app LEFT the login page by waiting for the url to change — \`await this.page.waitForURL((u) => u.toString() !== loginUrl, { timeout: 30000 });\` (or wait for a known post-login element such as a dashboard heading / nav menu / user avatar). Do NOT return from login while still on the login screen, and do NOT assume the login path — different apps use different urls.
  • SSO / FEDERATED LOGIN: when the login/entry page has NO username or password inputs but shows a single sign-in/continue button (e.g. "Continue Now", "Sign in with Microsoft/Google/SSO"), the credentials form lives on an EXTERNAL identity provider — waiting for a username field on the entry page will ALWAYS time out. The login method must handle the hop:
      1. Click the sign-in/continue button, then WAIT (30s — IdP pages are JS-rendered and slow) for the provider's identifier field: \`const emailField = this.page.locator('input[name="loginfmt"], input[type="email"], input[type="text"]').first(); await emailField.waitFor({ state: 'visible', timeout: 30000 });\`
      2. Fill the username/email and submit (\`this.page.locator('input[type="submit"], button[type="submit"], #idSIButton9').first()\`), then WAIT (30s) for the password field (\`input[name="passwd"], input[type="password"]\`), fill it, submit again.
      3. Handle an optional "Stay signed in?" interstitial — identify it by its TEXT, never by a generic submit button (right after submitting the password the OLD submit is still momentarily visible, and re-clicking it double-submits and breaks the flow). Race the two outcomes, then act:
         \`const offIdp = (u: URL | string) => !/login\\.microsoftonline|okta|auth0|accounts\\.google|login\\.windows/i.test(u.toString());\`
         \`await Promise.race([ this.page.waitForURL(offIdp, { timeout: 45000 }).catch(() => {}), this.page.getByText(/stay signed in\\?/i).waitFor({ state: 'visible', timeout: 45000 }).catch(() => {}) ]);\`
         \`if (!offIdp(this.page.url()) && await this.page.getByText(/stay signed in\\?/i).isVisible().catch(() => false)) { await this.page.locator('#idSIButton9, input[type="submit"], button[type="submit"]').first().click(); }\`
      4. Finish by waiting until the url leaves the identity provider: \`await this.page.waitForURL(offIdp, { timeout: 45000 });\`
  • NEVER assert that the login form (username / password / login button) is visible AFTER signing in. The submit navigates away, so those elements no longer exist and the assertion ALWAYS times out.
  • A readiness/\`expectLoaded()\` method must assert only elements of the page it represents. If it does NOT navigate itself, it may be called ONLY after another method already navigated to that page — never as a test's first step. (Prefer NOT calling a separate pre-login readiness check at all: let \`login()\` handle navigation and post-login verification.)
  • After sign-in, assert the POST-login state — a post-login landmark element (dashboard/header/menu/avatar) is visible, or the page is no longer on the captured login url. Do NOT assume any url pattern.`;

function buildCredentialsBlock(state: TestOpsState): string {
  const roles = (state.appContext?.roles || []).filter((r) => r.username);
  if (roles.length === 0) return '';
  const lines = roles.map((r) => `- Role "${r.roleName}": username="${r.username}" password="${r.password}"`);
  return `\nLOGIN CREDENTIALS (use these EXACT values for any sign-in — do not invent credentials; never emit encrypted-looking placeholders such as "__ENC__..." or "__AES__..."):\n${lines.join('\n')}\n`;
}

/* ─────────────────────────── phase 1: page objects ─────────────────────── */

interface PageTarget {
  module: string;
  name: string;       // kebab file base (no .page.ts)
  className: string;
  title: string;
  url: string;
  inventory: string;
}

/**
 * Decide which page objects to generate. Prefer the real crawl; fall back to
 * the distinct modules/features in the test cases when no crawl is available.
 */
function derivePageTargets(state: TestOpsState): PageTarget[] {
  const seen = new Set<string>();
  const targets: PageTarget[] = [];
  const add = (rawModule: string, rawName: string, title: string, url: string, inventory: string) => {
    const module = moduleSlug(rawModule);
    const name = kebab(rawName);
    const key = `${module}/${name}`;
    if (seen.has(key)) return;
    seen.add(key);
    targets.push({ module, name, className: `${pascal(rawName)}Page`, title, url, inventory });
  };

  const pages = state.exploredApp?.pages;
  if (Array.isArray(pages) && pages.length > 0) {
    for (const p of pages.slice(0, 12)) {
      const urlPath = (() => { try { return new URL(p.url).pathname.replace(/\/+$/, '') || '/'; } catch { return p.url; } })();
      const lastSeg = urlPath.split('/').filter(Boolean).pop() || 'home';
      const label = p.title || lastSeg;
      add(label, label, p.title || label, p.url, pageInventory(p));
    }
    if (targets.length > 0) return targets;
  }

  // No crawl — derive from test cases (one page object per module/feature).
  for (const tc of state.testCases) {
    const label = tc.module || tc.feature || 'app';
    add(label, label, label, '', '');
  }
  return targets;
}

/** Ensure the base import inside a generated page object is the canonical one. */
function enforceBaseImport(code: string): string {
  const body = code
    .split('\n')
    .filter((l) => !/^\s*import\s.*from\s+['"].*base\.page['"];?\s*$/.test(l))
    .join('\n');
  return `import { BasePage } from '../base.page';\n${body}`;
}

async function generatePageObjects(state: TestOpsState, targets: PageTarget[]): Promise<PageObjectFile[]> {
  if (targets.length === 0) return [];
  const appName = state.appContext?.appName || 'Web Application';
  const targetUrl = state.appContext?.targetUrl || '';
  const grounded = targets.some((t) => t.inventory);
  const credentials = buildCredentialsBlock(state);

  const batches: PageTarget[][] = [];
  for (let i = 0; i < targets.length; i += PO_BATCH_SIZE) batches.push(targets.slice(i, i + PO_BATCH_SIZE));

  const results = await Promise.all(batches.map(async (batch) => {
    const payload = batch.map((t) => ({
      module: t.module,
      className: t.className,
      page: t.title,
      url: t.url,
      inventory: t.inventory || '(no crawl data — use semantic role/label selectors)',
    }));

    const prompt = `You are a senior Playwright automation engineer building a Page Object Model.

Application: ${appName}${targetUrl ? ` (BASE_URL ${targetUrl})` : ''}
${credentials}
Generate ONE page object class per target below. Each class MUST:
- \`export class <className> extends BasePage\` and import the base as: import { BasePage } from '../base.page';
- NOT redefine the constructor (BasePage already takes (page: Page); use \`this.page\`).
- Expose \`readonly\` Locator properties for the page's key elements.
- Expose async methods for the meaningful actions and verifications (e.g. \`login(username: string, password: string)\`, \`expectLoaded()\`).
- NAVIGATE FIRST: the method that starts a flow on this page (e.g. \`login(...)\` on a login page, or an \`open()\` method) MUST begin with \`await this.page.goto('<url path>')\` using the page's URL path — relative paths resolve against the configured baseURL. Tests run on a blank page until something calls goto; never assume the browser is already on the page.
${LOGIN_CONTRACT}
${grounded ? SELECTOR_RULES_GROUNDED : SELECTOR_RULES_UNGROUNDED}
- Import Locator/Page types from '@playwright/test' if referenced.

Targets (JSON):
${JSON.stringify(payload, null, 2)}

Return ONLY a JSON array (no markdown, no commentary):
[
  {
    "module": "auth",
    "className": "LoginPage",
    "fileName": "login.page.ts",
    "methods": ["login(username: string, password: string): Promise<void>", "expectLoaded(): Promise<void>"],
    "code": "import { Locator } from '@playwright/test';\\nimport { BasePage } from '../base.page';\\n\\nexport class LoginPage extends BasePage { ... }"
  }
]
Output STRICT valid JSON — literal strings only, no trailing commas.`;

    try {
      const response = await runLLM(prompt, { maxTokens: 16000, llm: llmForStage(state.llm, 'script') });
      const parsed = parseJsonFromResponse<{ module?: string; className?: string; fileName?: string; methods?: string[]; code?: string }[]>(response);
      if (!Array.isArray(parsed)) return [] as PageObjectFile[];
      const out: PageObjectFile[] = [];
      for (let i = 0; i < parsed.length; i++) {
        const entry = parsed[i];
        const target = batch[i] || batch[0];
        if (!entry || typeof entry.code !== 'string' || !entry.code.trim()) continue;
        const module = moduleSlug(entry.module || target.module);
        const className = (entry.className && /^[A-Za-z][A-Za-z0-9]*$/.test(entry.className)) ? entry.className : target.className;
        const base = kebab((entry.fileName || target.name).replace(/\.page\.ts$/, '').replace(/\.ts$/, ''));
        out.push({
          path: `src/pages/${module}/${base}.page.ts`,
          className,
          module,
          methods: Array.isArray(entry.methods) ? entry.methods.filter((m) => typeof m === 'string') : [],
          code: enforceBaseImport(entry.code),
        });
      }
      return out;
    } catch (err) {
      console.warn('[scriptAgent] page-object batch failed:', (err as Error).message);
      return [] as PageObjectFile[];
    }
  }));

  // Dedup by path (first wins) and keep class names unique.
  const byPath = new Map<string, PageObjectFile>();
  const usedClasses = new Set<string>();
  for (const po of results.flat()) {
    if (byPath.has(po.path)) continue;
    let className = po.className;
    if (usedClasses.has(className)) className = `${pascal(po.module)}${className}`;
    usedClasses.add(className);
    byPath.set(po.path, { ...po, className, code: po.code.replace(new RegExp(`\\bclass\\s+${po.className}\\b`), `class ${className}`) });
  }
  return [...byPath.values()];
}

/* ─────────────────────────── phase 2: specs ─────────────────────── */

interface AiSpecResponse { testCaseId: string; code: string; }

/**
 * Deterministic repair for the single most common login failure the LLM keeps
 * re-introducing despite the prompt contract: calling a page object's
 * `expectLoaded()` (which asserts the LOGIN form is visible) AFTER `login()`.
 * `login()` navigates away from the login page, so re-asserting the login form
 * always times out. `login()` already confirms success via its post-login
 * `waitForURL`, so a trailing `expectLoaded()` on the SAME object is redundant
 * AND harmful — drop it. Only affects calls that come AFTER a `.login(`; a
 * pre-login readiness check is left intact. Exported + reused by the healer.
 */
export function sanitizeLoginFlow(code: string): string {
  if (!code) return code;
  const lines = code.split('\n');
  const loggedIn = new Set<string>();
  const out: string[] = [];
  for (const line of lines) {
    const login = line.match(/\b([A-Za-z_$][\w$]*)\.login\s*\(/);
    if (login) loggedIn.add(login[1]!);
    const ready = line.match(/\bawait\s+([A-Za-z_$][\w$]*)\.expectLoaded\s*\(\s*\)\s*;?\s*$/);
    if (ready && loggedIn.has(ready[1]!)) continue; // drop post-login login-form re-assertion
    out.push(line);
  }
  return out.join('\n');
}

function templateSpec(tc: TestCase): AutomationScript {
  // A placeholder emitted only when real spec generation for this case failed.
  // It imports nothing but @playwright/test (so it always LOADS — never a
  // "Cannot find module" that aborts the whole suite) and FAILS honestly with a
  // clear reason. A previous version asserted `toHaveURL(/.*/)` which passes for
  // ANY page — a placeholder must never report a false green. The
  // `TODO: implement steps:` marker is kept so the healer recognises the stub.
  const code = `import { test, expect } from '@playwright/test';\n\n` +
    `test('${tc.scenario.replace(/'/g, "\\'")}', async () => {\n` +
    `  // TODO: implement steps:\n${tc.steps.map((s) => `  // - ${s}`).join('\n')}\n` +
    `  expect(false, 'Automated script could not be generated for this test case — regenerate its scripts.').toBe(true);\n` +
    `});\n`;
  return { testCaseId: tc.id, fileName: safeFileName(tc.scenario), code, path: specPathFor(tc), uses: [] };
}

/**
 * Force a generated spec's imports to the deterministic specifiers: drop any
 * model-written page/fixture imports (which may be the wrong depth or point at
 * a non-existent file) and re-add correct imports for the page objects actually
 * referenced in the body.
 */
function enforceSpecImports(code: string, catalog: PageObjectFile[]): { code: string; uses: string[] } {
  const used = catalog.filter((po) => new RegExp(`\\b${po.className}\\b`).test(code));
  const body = code
    .split('\n')
    .filter((l) => !/^\s*import\s.*from\s+['"][^'"]*(pages\/|fixtures\/)[^'"]*['"];?\s*$/.test(l))
    .join('\n')
    .replace(/^\n+/, '');
  const hasPw = /from\s+['"]@playwright\/test['"]/.test(body);
  const header: string[] = [];
  if (!hasPw) header.push(`import { test, expect } from '@playwright/test';`);
  for (const po of used) header.push(`import { ${po.className} } from '${specImportFor(po)}';`);
  return { code: header.length ? `${header.join('\n')}\n${body}` : body, uses: used.map((p) => p.path) };
}

function buildCatalog(catalog: PageObjectFile[]): string {
  if (catalog.length === 0) return '';
  const lines = catalog.map((po) => {
    const methods = po.methods.length ? `\n    methods: ${po.methods.join('; ')}` : '';
    return `- class ${po.className}  (import: import { ${po.className} } from '${specImportFor(po)}';)${methods}`;
  });
  return `\nPAGE OBJECTS AVAILABLE — import and use these; do NOT inline selectors or duplicate their logic:\n${lines.join('\n')}\n`;
}

async function generateSpecs(state: TestOpsState, batch: TestCase[], catalog: PageObjectFile[]): Promise<AutomationScript[]> {
  const appName = state.appContext?.appName || 'Web Application';
  const targetUrl = state.appContext?.targetUrl || '';
  const baseUrlNote = targetUrl
    ? `BASE_URL is "${targetUrl}". Navigate via page-object methods or relative paths under it.`
    : `No BASE_URL — use relative paths like '/login'; the Playwright config resolves them.`;
  const catalogBlock = buildCatalog(catalog);
  const credentials = buildCredentialsBlock(state);

  const casesPayload = batch.map((tc) => ({
    id: tc.id, feature: tc.feature, scenario: tc.scenario,
    steps: tc.steps, expectedResult: tc.expectedResult, type: tc.type, precondition: tc.precondition,
  }));

  const usageRules = catalog.length > 0
    ? `- Drive the scenario through the PAGE OBJECTS above: \`const login = new LoginPage(page);\` then call its methods. Do NOT write raw selectors in the spec.
- Import only the page objects you use (exact import lines shown above). Import { test, expect } from '@playwright/test'.`
    : `- Use \`page\` directly with \`getByRole\`/\`getByLabel\`/\`getByPlaceholder\`. Import { test, expect } from '@playwright/test'.`;

  const prompt = `You are a senior Playwright automation engineer writing specs for a Page Object Model suite.

Application: ${appName}
${baseUrlNote}
${catalogBlock}${credentials}
Test cases (JSON):
${JSON.stringify(casesPayload, null, 2)}

Return ONLY a JSON array (no markdown): [ { "testCaseId": "TC-001", "code": "..." } ]

Strict rules for the \`code\` field:
- Must compile as TypeScript with @playwright/test.
${usageRules}
- NAVIGATION: the FIRST action of every test must load a page — either \`await page.goto(...)\` in the spec or a page-object method that navigates internally (e.g. a login() that starts with goto). A spec whose first interaction is a fill/click on a never-navigated page fails on a blank screen.
- ${LOGIN_CONTRACT}
- WAITS: SPA-safe — auto-waiting locators and \`await expect(locator).toBeVisible({ timeout: 15000 })\`; never \`waitForTimeout\`.
- ASSERTIONS: functional only. No timing/performance thresholds. For a "performance" case, just assert the page/feature loads.
- Cover EVERY step in order. Wrap each scenario in a single \`test(...)\`. One entry per input test case; testCaseId MUST match.
- Output STRICT valid JSON — literal strings only, no trailing commas.`;

  const response = await runLLM(prompt, { maxTokens: 20000, llm: llmForStage(state.llm, 'script') });
  const parsed = parseJsonFromResponse<AiSpecResponse[]>(response);
  if (!Array.isArray(parsed) || parsed.length === 0) throw new Error('LLM returned no specs for batch');

  const byId = new Map<string, AiSpecResponse>();
  for (const e of parsed) if (e && typeof e.code === 'string' && e.testCaseId) byId.set(e.testCaseId, e);

  return batch.map((tc) => {
    const entry = byId.get(tc.id);
    if (entry && entry.code.trim()) {
      const { code, uses } = enforceSpecImports(entry.code, catalog);
      return { testCaseId: tc.id, fileName: safeFileName(tc.scenario), code: sanitizeLoginFlow(code), path: specPathFor(tc), uses };
    }
    return templateSpec(tc);
  });
}

/* ─────────────────────────── orchestration ─────────────────────── */

export async function scriptAgent(state: TestOpsState): Promise<TestOpsState> {
  const eligible = state.testCases.filter((tc) => tc.type !== 'data');
  if (eligible.length === 0) return { ...state, automationScripts: [], pageObjects: [] };

  // Phase 1 — page objects (shared), grounded in the crawl.
  const pageObjects = await generatePageObjects(state, derivePageTargets(state));

  // Phase 2 — specs that use them, batched in parallel.
  const batches: TestCase[][] = [];
  for (let i = 0; i < eligible.length; i += BATCH_SIZE) batches.push(eligible.slice(i, i + BATCH_SIZE));
  const specBatches = await Promise.all(batches.map((batch) => generateSpecs(state, batch, pageObjects).catch((err) => {
    console.warn('[scriptAgent] spec batch failed, using templates:', (err as Error).message);
    return batch.map(templateSpec);
  })));

  return { ...state, pageObjects, automationScripts: specBatches.flat() };
}
