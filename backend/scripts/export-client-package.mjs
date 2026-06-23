#!/usr/bin/env node
/**
 * Internal tool — NOT shipped to clients.
 *
 * Exports generated automation_scripts rows from the internal Postgres DB
 * into `client-deliverable/src/tests/*.spec.ts`, sanitizing hardcoded URLs
 * and proprietary markers on the way out.
 *
 * Usage:
 *   node backend/scripts/export-client-package.mjs --testRunId <uuid> [--outDir client-deliverable/src/tests]
 *
 * Reads DB connection from env: PGHOST, PGPORT, PGUSER, PGPASSWORD, PGDATABASE, DB_SCHEMA.
 * Falls back to the internal defaults if env is not set (same as backend/src/db.ts).
 */
import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : def;
}

const testRunId = arg('testRunId');
const outDir = path.resolve(arg('outDir', 'client-deliverable/src/tests'));

if (!testRunId) {
  console.error('Usage: node backend/scripts/export-client-package.mjs --testRunId <uuid> [--outDir <dir>]');
  process.exit(2);
}

const pool = new pg.Pool({
  host: process.env.PGHOST ?? 'localhost',
  port: Number(process.env.PGPORT ?? 5432),
  user: process.env.PGUSER ?? 'postgres',
  password: process.env.PGPASSWORD ?? '',
  database: process.env.PGDATABASE ?? 'postgres',
});
const schema = process.env.DB_SCHEMA ?? 'JBSTestOpsAI';

function safeFileName(name, fallback) {
  const base = (name || fallback || 'test')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return `${base || 'test'}.spec.ts`;
}

/**
 * Strip proprietary markers and replace hardcoded http(s) URLs with
 * `process.env.BASE_URL`-relative navigation so tests become env-agnostic.
 */
function sanitizeCode(code) {
  let out = code;

  // Strip internal comment markers.
  out = out.replace(/\/\/\s*(internal|JBS|tenant[^\n]*)[^\n]*/gi, '');

  // Replace absolute URLs in page.goto('...') with a relative path using BASE_URL.
  out = out.replace(
    /page\.goto\(\s*['"`](https?:\/\/[^'"`]+)['"`]/g,
    (_m, url) => {
      try {
        const u = new URL(url);
        const rel = `${u.pathname}${u.search}` || '/';
        return `page.goto(\`\${process.env.BASE_URL ?? ''}${rel}\``;
      } catch {
        return `page.goto(\`\${process.env.BASE_URL ?? ''}/\``;
      }
    }
  );

  // Remove any leftover references to internal identifiers.
  out = out.replace(/JBSTestOpsAI|JBSIntelliQE/g, 'qe');

  return out;
}

async function main() {
  fs.mkdirSync(outDir, { recursive: true });

  const sql = `
    SELECT tc_number, test_case_title, file_name, code
      FROM "${schema}".automation_scripts
     WHERE test_run_id = $1
     ORDER BY tc_number NULLS LAST, created_at ASC
  `;
  const { rows } = await pool.query(sql, [testRunId]);

  if (rows.length === 0) {
    console.error(`[export] No automation_scripts rows found for test_run_id=${testRunId}`);
    process.exit(3);
  }

  let written = 0;
  for (const row of rows) {
    const fname = safeFileName(row.file_name, row.test_case_title || row.tc_number);
    const dest = path.join(outDir, fname);
    fs.writeFileSync(dest, sanitizeCode(row.code ?? ''), 'utf8');
    written++;
  }

  console.log(`[export] Wrote ${written} spec file(s) → ${outDir}`);
  await pool.end();
}

main().catch((err) => {
  console.error('[export] FAIL', err);
  process.exit(1);
});
