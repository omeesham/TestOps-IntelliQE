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
  • When a field has a real name/id, \`this.page.locator('input[name="username"]')\` is preferred — use the EXACT attribute.
  • For buttons, match the real text, e.g. \`getByRole('button', { name: 'Login' })\`. NEVER invent data-testids.`;

const SELECTOR_RULES_UNGROUNDED = `- Use \`getByRole\`, \`getByLabel\`, \`getByPlaceholder\`, \`getByText\`. Avoid invented data-testids.`;

function buildCredentialsBlock(state: TestOpsState): string {
  const roles = (state.appContext?.roles || []).filter((r) => r.username);
  if (roles.length === 0) return '';
  const lines = roles.map((r) => `- Role "${r.roleName}": username="${r.username}" password="${r.password}"`);
  return `\nLOGIN CREDENTIALS (use these EXACT values for any sign-in — do not invent credentials):\n${lines.join('\n')}\n`;
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

function templateSpec(tc: TestCase): AutomationScript {
  const code = `import { test, expect } from '@playwright/test';\n\ntest('${tc.scenario.replace(/'/g, "\\'")}', async ({ page }) => {\n  await page.goto('/');\n  await expect(page).toHaveURL(/.*/);\n  // TODO: implement steps:\n${tc.steps.map((s) => `  // - ${s}`).join('\n')}\n});\n`;
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
- LOGIN: if a test needs an authenticated user, sign in first (use the login page object / credentials).
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
      return { testCaseId: tc.id, fileName: safeFileName(tc.scenario), code, path: specPathFor(tc), uses };
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
