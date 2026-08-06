/**
 * client-package.service.ts
 * ─────────────────────────
 * The publish-time PACKAGING layer. It takes the artifacts the AI pipeline
 * already produced — per-test-case specs (`tests/<module>/<name>.spec.ts`),
 * shared page objects (`src/pages/<module>/<name>.page.ts`) and the test cases —
 * and reshapes them into the IP-safe client deliverable the customer repo
 * expects:
 *
 *   - specs CONSOLIDATED to one file per module (tests/<module>/<module>.spec.ts)
 *     with each test sequentially numbered,
 *   - folders FLATTENED to the top-level layout (pages/, common/, data/testdata/, …),
 *   - a Markdown test plan at specs/basic-operations.md,
 *   - plus the static runner scaffold from client-package.templates.ts.
 *
 * This is a PURE transform of the publish payload. It does NOT touch the AI
 * pipeline, the execution workspace, or the database — generation, execution and
 * healing keep operating on the untouched one-spec-per-test-case representation.
 */
import type { GitFile } from './git/git.types.js';
import { deliveryScaffoldFiles } from './client-package.templates.js';
import { buildTestCaseDocs } from './test-case-doc.service.js';

/* ─────────────────────────── input shapes ─────────────────────────── */

/** A generated spec as forwarded by the publish route. */
export interface InputScript {
  fileName?: string;
  code?: string;
  /** e.g. `tests/auth/verify-login.spec.ts` (module encoded in the path). */
  path?: string;
}

/** A generated page object as forwarded by the publish route. */
export interface InputPageObject {
  /** e.g. `src/pages/auth/login.page.ts`. */
  path?: string;
  code?: string;
}

/** Loosely-typed test case (camelCase, optional structured steps). */
export interface InputTestCase {
  id?: string;
  module?: string;
  feature?: string;
  title?: string;
  scenario?: string;
  precondition?: string;
  steps?: string[];
  testSteps?: { step?: number; action?: string; expected?: string; testData?: string }[];
  expectedResult?: string;
  expected?: string;
  priority?: string;
  type?: string;
}

export interface AssembleInput {
  scripts: InputScript[];
  pageObjects?: InputPageObject[];
  testCases?: InputTestCase[];
  /** Extra docs to fold in (e.g. the run's execution report). Later wins on path. */
  extraFiles?: GitFile[];
}

/* ─────────────────────────── path helpers ─────────────────────────── */

/** Normalize a repo-relative path: forward slashes, no leading `./` or `/`. */
function cleanPath(p: string): string {
  return String(p || '').replace(/\\/g, '/').replace(/^\.?\/+/, '').replace(/\.\.+/g, '_');
}

/** Derive the module slug for a spec from its `tests/<module>/<name>.spec.ts` path. */
function moduleOf(script: InputScript): string {
  const p = cleanPath(script.path || '');
  const parts = p.split('/').filter(Boolean);
  // tests/<module>/<name>.spec.ts  →  parts[1] is the module.
  if (parts[0] === 'tests' && parts.length >= 3) return parts[1] || 'general';
  return 'general';
}

/* ─────────────────────── page-object remapping ─────────────────────── */

/**
 * Move page objects from the internal `src/pages/**` layout to the delivered
 * `pages/**` layout. The code is unchanged: a page object at
 * `pages/<module>/<name>.page.ts` still reaches the base at `pages/base.page.ts`
 * via its existing `import { BasePage } from '../base.page'`.
 */
export function remapPageObjects(pageObjects: InputPageObject[] | undefined): GitFile[] {
  if (!Array.isArray(pageObjects)) return [];
  const out: GitFile[] = [];
  for (const po of pageObjects) {
    if (!po || typeof po.path !== 'string' || typeof po.code !== 'string') continue;
    const path = cleanPath(po.path).replace(/^src\//, '');
    out.push({ path, content: po.code });
  }
  return out;
}

/* ─────────────────────── spec consolidation ─────────────────────── */

const PW_IMPORT = `import { test, expect } from '@playwright/test';`;

/** Split leading/scattered single-line imports from the rest of a spec. */
function splitImports(code: string): { imports: string[]; body: string } {
  const lines = String(code || '').replace(/\r\n/g, '\n').split('\n');
  const importRe = /^\s*import\b[^\n]*?from\s*['"][^'"]+['"];?\s*$/;
  const sideEffectRe = /^\s*import\s*['"][^'"]+['"];?\s*$/;
  const imports: string[] = [];
  const body: string[] = [];
  for (const line of lines) {
    if (importRe.test(line) || sideEffectRe.test(line)) imports.push(line.trim());
    else body.push(line);
  }
  while (body.length && body[0]!.trim() === '') body.shift();
  while (body.length && body[body.length - 1]!.trim() === '') body.pop();
  return { imports, body: body.join('\n') };
}

/**
 * Rewrite a page-object import specifier from the internal layout to the
 * delivered one. The consolidated spec stays at `tests/<module>/…` (same depth
 * as the original), so only the `src/pages/` segment changes to `pages/`.
 */
function rewriteImport(line: string): string {
  return line.replace(/src\/pages\//g, 'pages/');
}

/**
 * Prefix the (single) `test(...)` title in a spec body with a sequential number.
 * `test.describe(` is intentionally not matched — only the real `test(` call is.
 * Each source spec contains exactly one `test()`, so this is one reliable edit.
 */
function numberTest(body: string, label: string): string {
  return body.replace(/(\btest\s*\(\s*)(['"`])/, `$1$2${label} - `);
}

/**
 * Consolidate the per-test-case specs into ONE file per module:
 *   tests/<module>/<module>.spec.ts
 * with hoisted/deduped imports and each test sequentially numbered.
 */
export function consolidateSpecsByModule(scripts: InputScript[]): GitFile[] {
  const groups = new Map<string, InputScript[]>();
  for (const s of scripts) {
    if (!s || typeof s.code !== 'string' || !s.code.trim()) continue;
    const mod = moduleOf(s);
    (groups.get(mod) || groups.set(mod, []).get(mod)!).push(s);
  }

  const files: GitFile[] = [];
  for (const [mod, group] of groups) {
    const importSet = new Set<string>();
    const bodies: string[] = [];
    const width = Math.max(3, String(group.length).length);

    group.forEach((s, i) => {
      const { imports, body } = splitImports(s.code || '');
      for (const imp of imports) importSet.add(rewriteImport(imp));
      const label = String(i + 1).padStart(width, '0');
      bodies.push(numberTest(body, label));
    });

    // Guarantee the Playwright import is present exactly once, first, then the
    // (deduped) page-object imports.
    const importLines = [...importSet].filter((l) => !/@playwright\/test/.test(l));
    const header =
      `// Module: ${mod} — consolidated Playwright specs (${group.length} test case${group.length === 1 ? '' : 's'}).\n` +
      `// Generated by JBS IntelliQE. Tests are numbered sequentially within this file.\n`;
    const importBlock = [PW_IMPORT, ...importLines].join('\n');
    const content = `${header}\n${importBlock}\n\n${bodies.join('\n\n')}\n`;

    files.push({ path: `tests/${mod}/${mod}.spec.ts`, content });
  }
  return files;
}

/* ─────────────────────── test plan (specs/) ─────────────────────── */

function titleOf(tc: InputTestCase): string {
  return tc.title || tc.scenario || 'Untitled scenario';
}

function stepsOf(tc: InputTestCase): string[] {
  if (Array.isArray(tc.testSteps) && tc.testSteps.length) {
    return tc.testSteps.map((s, i) => {
      const n = s.step ?? i + 1;
      const exp = s.expected ? ` → Expected: ${s.expected}` : '';
      const data = s.testData ? ` [data: ${s.testData}]` : '';
      return `${n}. ${s.action || ''}${data}${exp}`;
    });
  }
  return (tc.steps || []).map((s, i) => `${i + 1}. ${s}`);
}

/**
 * Build the deliverable test plan at specs/basic-operations.md. Scenarios are
 * grouped by module and numbered 1..N to line up with the numbered tests in
 * each module's consolidated spec file.
 */
export function buildTestPlanMarkdown(testCases: InputTestCase[] | undefined): string {
  const cases = Array.isArray(testCases) ? testCases : [];
  const groups = new Map<string, InputTestCase[]>();
  for (const tc of cases) {
    const key = tc.module || tc.feature || 'general';
    (groups.get(key) || groups.set(key, []).get(key)!).push(tc);
  }

  const lines: string[] = [];
  lines.push('# Test Plan — Basic Operations');
  lines.push('');
  lines.push('_Generated by JBS IntelliQE._ This plan enumerates the automated scenarios in this');
  lines.push('suite, grouped by module. Each numbered scenario maps to the correspondingly');
  lines.push('numbered test in `tests/<module>/<module>.spec.ts`.');
  lines.push('');
  lines.push(`- **Total scenarios:** ${cases.length}`);
  lines.push(`- **Modules:** ${groups.size ? [...groups.keys()].join(', ') : '—'}`);
  lines.push('');

  if (cases.length === 0) {
    lines.push('> No test cases were provided at publish time. Generate test cases in');
    lines.push('> IntelliQE and re-publish to populate this plan.');
    lines.push('');
    return lines.join('\n');
  }

  for (const [mod, list] of groups) {
    lines.push(`## ${mod}`);
    lines.push('');
    list.forEach((tc, i) => {
      lines.push(`### ${i + 1}. ${titleOf(tc)}`);
      const meta = [
        tc.feature ? `**Feature:** ${tc.feature}` : '',
        tc.priority ? `**Priority:** ${tc.priority}` : '',
        tc.type ? `**Type:** ${tc.type}` : '',
      ].filter(Boolean).join(' · ');
      if (meta) { lines.push(meta); }
      if (tc.precondition) { lines.push(''); lines.push(`**Precondition:** ${tc.precondition}`); }
      const steps = stepsOf(tc);
      if (steps.length) {
        lines.push('');
        lines.push('**Steps:**');
        lines.push('');
        for (const s of steps) lines.push(s);
      }
      const expected = tc.expectedResult || tc.expected || '';
      if (expected) { lines.push(''); lines.push(`**Expected Result:** ${expected}`); }
      lines.push('');
    });
  }
  return lines.join('\n');
}

/* ─────────────────────── smoke fallback ─────────────────────── */

/** Placeholder spec so the suite runs even when no scripts were generated. */
const SMOKE_SPEC = `import { test, expect } from '@playwright/test';

// Placeholder smoke test. Real generated specs replace this on the next publish.
test.describe('Smoke', () => {
  test('001 - base URL responds', async ({ page }) => {
    await page.goto('/');
    await expect(page).toHaveURL(/.*/);
  });
});
`;

/* ─────────────────────── assembly ─────────────────────── */

/**
 * Assemble the full client deliverable as GitFile[]: static scaffold + remapped
 * page objects + consolidated per-module specs + test plan + test-case docs.
 * Later entries win on path collision, so generated content overrides scaffold
 * placeholders.
 */
export function assembleClientPackage(input: AssembleInput): GitFile[] {
  const scripts = Array.isArray(input.scripts) ? input.scripts : [];
  const specs = consolidateSpecsByModule(scripts);
  const specFiles: GitFile[] = specs.length > 0
    ? specs
    : [{ path: 'tests/smoke.spec.ts', content: SMOKE_SPEC }];

  const pageObjectFiles = remapPageObjects(input.pageObjects);
  const testPlan: GitFile = {
    path: 'specs/basic-operations.md',
    content: buildTestPlanMarkdown(input.testCases),
  };
  const docFiles = buildTestCaseDocs(input.testCases);
  const extras = Array.isArray(input.extraFiles) ? input.extraFiles : [];

  const byPath = new Map<string, GitFile>();
  for (const f of [
    ...deliveryScaffoldFiles(),
    ...pageObjectFiles,
    ...specFiles,
    testPlan,
    ...docFiles,
    ...extras,
  ]) {
    byPath.set(cleanPath(f.path), { path: cleanPath(f.path), content: f.content });
  }
  return [...byPath.values()];
}
