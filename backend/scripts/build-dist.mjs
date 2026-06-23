#!/usr/bin/env node
/**
 * Internal tool — NOT shipped to clients.
 *
 * Produces `client-deliverable/dist/` from `client-deliverable/src/` by
 * transpiling and minifying every .ts file with esbuild. Non-code assets
 * (JSON, .env.example, README) are copied verbatim. A dist-specific
 * package.json is emitted so the dist folder runs without `typescript`.
 *
 * Usage:
 *   node backend/scripts/build-dist.mjs
 *
 * Requires: `npm i -D esbuild` in the backend workspace (or run via npx).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..', '..');
const SRC = path.join(ROOT, 'client-deliverable', 'src');
const DIST = path.join(ROOT, 'client-deliverable', 'dist');

// Lazy-load esbuild so the file can be read without the dep installed.
let esbuild;
try {
  esbuild = await import('esbuild');
} catch {
  console.error('[build-dist] esbuild not installed. Run: npm i -D esbuild');
  process.exit(2);
}

function rimraf(p) {
  if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true });
}

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'reports') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

rimraf(DIST);
fs.mkdirSync(DIST, { recursive: true });

const files = walk(SRC);
const tsFiles = files.filter((f) => f.endsWith('.ts'));
const otherFiles = files.filter((f) => !f.endsWith('.ts'));

// 1. Transpile + minify TS → JS.
await esbuild.build({
  entryPoints: tsFiles,
  outdir: DIST,
  outbase: SRC,
  platform: 'node',
  target: 'node18',
  format: 'cjs',
  minify: true,
  sourcemap: false,
  bundle: false,
  logLevel: 'info',
});

// 2. Copy non-TS assets verbatim (JSON data, .env.example, .gitignore, README).
for (const f of otherFiles) {
  const rel = path.relative(SRC, f);
  const base = path.basename(f);
  // Drop files that belong to the source build only.
  if (base === 'tsconfig.json') continue;
  if (base === 'package.json') continue; // replaced below
  if (base === 'README.md') continue; // dist gets its own
  const dest = path.join(DIST, rel);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(f, dest);
}

// 3. Emit a dist-specific package.json (no TypeScript needed at runtime).
const distPkg = {
  name: 'qe-playwright-tests-dist',
  version: '1.0.0',
  private: true,
  description: 'Playwright end-to-end test package (minified distribution build).',
  scripts: {
    test: 'playwright test -c config/playwright.config.js',
    'test:headed': 'playwright test -c config/playwright.config.js --headed',
    'test:ui': 'playwright test -c config/playwright.config.js --ui',
    'test:chromium': 'playwright test -c config/playwright.config.js --project=chromium',
    report: 'playwright show-report ./reports/html',
    'install:browsers': 'playwright install',
  },
  dependencies: {
    '@playwright/test': '^1.58.2',
  },
};
fs.writeFileSync(path.join(DIST, 'package.json'), JSON.stringify(distPkg, null, 2));

// 4. Emit dist README.
const distReadme = `# QE Playwright Tests — Distribution Build

Minified JavaScript Playwright test suite. No TypeScript toolchain required.

## Install

\`\`\`bash
npm ci
npm run install:browsers
cp .env.example .env
# edit .env and set BASE_URL
\`\`\`

## Run

\`\`\`bash
npm test
npm run test:headed
npm run test:ui
npm run report
\`\`\`

See \`../EXECUTION.md\` for the full execution guide.
`;
fs.writeFileSync(path.join(DIST, 'README.md'), distReadme);

console.log(`[build-dist] Built ${tsFiles.length} file(s) → ${DIST}`);
