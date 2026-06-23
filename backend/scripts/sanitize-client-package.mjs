#!/usr/bin/env node
/**
 * Internal tool — NOT shipped to clients.
 *
 * Walks a target directory and fails the build if any forbidden token is
 * found. Run this over `client-deliverable/` before packaging.
 *
 * Usage:
 *   node backend/scripts/sanitize-client-package.mjs [targetDir]
 *
 * Exits 0 on clean, 1 on any violation.
 */
import fs from 'node:fs';
import path from 'node:path';

const target = path.resolve(process.argv[2] ?? 'client-deliverable');

const FORBIDDEN = [
  // Known hardcoded credentials from the internal repo.
  /Omeesha@19/i,
  /Login@2026/i,
  /Encore@2026/i,
  // DB connection leaks.
  /JBSTestOpsAI/,
  /localhost:5432/,
  /pg\.Pool/,
  /password\s*:\s*['"]admin['"]/i,
  // Internal identifiers.
  /JBSIntelliQE/,
  /jbsadmin/i,
  /jbsqeadmin/i,
  // Internal routes.
  /\/api\/automation-scripts/,
  /\/api\/agents/,
  /\/api\/generate/,
  // API keys.
  /sk-ant-[a-z0-9-]{20,}/i,
  /ANTHROPIC_API_KEY/,
  // Paths back into the internal tree.
  /backend\/src\//,
];

// Files we don't scan (binaries, lockfiles, reports).
const SKIP_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.ico', '.zip', '.lock']);
const SKIP_DIR = new Set(['node_modules', 'reports', 'test-results', 'playwright-report', '.git']);

const hits = [];

function walk(dir) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIR.has(entry.name)) continue;
      walk(path.join(dir, entry.name));
      continue;
    }
    const file = path.join(dir, entry.name);
    if (SKIP_EXT.has(path.extname(entry.name))) continue;
    let text;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    for (const rx of FORBIDDEN) {
      const m = text.match(rx);
      if (m) hits.push({ file, token: m[0], pattern: rx.toString() });
    }
  }
}

walk(target);

if (hits.length === 0) {
  console.log(`[sanitize] OK — no forbidden tokens found in ${target}`);
  process.exit(0);
}

console.error(`[sanitize] FAIL — ${hits.length} violation(s) in ${target}:`);
for (const h of hits) {
  console.error(`  ${h.file}  ::  ${h.pattern}  →  ${h.token}`);
}
process.exit(1);
