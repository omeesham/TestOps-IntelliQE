/**
 * Import Encore test cases from xlsx files on disk into the DB.
 *
 *   npx tsx scripts/seedEncoreTestCases.ts [--root "C:/path/to/Encore TestCases"]
 *
 * Module  = top-level folder name (e.g. "Location", "LocalOfficeSettings")
 * Submodule = xlsx filename (leading digits + "_test_cases.xlsx" stripped)
 *
 * Idempotent: upserts by (tenant_id, module, submodule). On re-run the old
 * test_cases for that run are deleted and re-inserted from xlsx.
 */
import fs from 'fs';
import path from 'path';
// xlsx ships as CommonJS — use createRequire for a clean default export under tsx/ESM.
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const XLSX: typeof import('xlsx') = require('xlsx');
import pool from '../src/db.js';

const DEFAULT_ROOT = 'C:/Users/OmeeshaMahanta/Downloads/TestCases_Encore/Encore TestCases';
const TENANT_SLUG = 'encore-global';

const TAG_VOCAB = ['POSITIVE', 'NEGATIVE', 'E2E', 'UI', 'API', 'SMOKE', 'REGRESSION'] as const;
type Tag = typeof TAG_VOCAB[number];

function parseArgs(): { root: string } {
  const args = process.argv.slice(2);
  let root = DEFAULT_ROOT;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--root' && args[i + 1]) root = args[++i];
  }
  return { root };
}

function normaliseSubmodule(fileName: string): string {
  return fileName
    .replace(/\.xlsx$/i, '')
    .replace(/_test_cases$/i, '')
    .replace(/^\d+[_\-\s]*/, '');
}

function inferTags(title: string, steps: string, expected: string): Tag[] {
  const text = `${title}\n${steps}\n${expected}`.toLowerCase();
  const tags: Set<Tag> = new Set();

  // Explicit markers `[TAG]` win.
  const marker = /\[(positive|negative|e2e|ui|api|smoke|regression)\]/gi;
  let m: RegExpExecArray | null;
  while ((m = marker.exec(text))) tags.add(m[1].toUpperCase() as Tag);

  if (tags.size === 0) {
    const negHit = /\b(invalid|error|fail(?:ure|ed|s)?|reject|denied|disabled|negative|not\s+allowed|cannot|blocked)\b/.test(text);
    tags.add(negHit ? 'NEGATIVE' : 'POSITIVE');
  }
  // Everything Encore has is browser-driven today → mark as UI unless tagged otherwise.
  if (/\bapi\b|endpoint|request body|response/.test(text)) tags.add('API');
  else tags.add('UI');

  return Array.from(tags);
}

function cellString(v: unknown): string {
  if (v === null || v === undefined) return '';
  return String(v).trim();
}

function splitSteps(raw: string): string[] {
  const s = cellString(raw);
  if (!s) return [];
  return s
    .split(/\r?\n/)
    .map((l) => l.trim())
    // Strip leading "1.", "1)", "1:", "Step 1 -" style numbering — the UI renders its own.
    .map((l) => l.replace(/^(?:step\s*)?\d+\s*[\.\):\-]\s*/i, '').trim())
    .filter(Boolean);
}

async function ensureTenant(): Promise<string> {
  const res = await pool.query(
    `INSERT INTO "JBSTestOpsAI".tenants (name, slug, is_platform)
     VALUES ('EncoreGlobal', $1, false)
     ON CONFLICT (slug) DO UPDATE SET updated_at = NOW()
     RETURNING id`,
    [TENANT_SLUG]
  );
  const tenantId: string = res.rows[0].id;

  const userCheck = await pool.query(
    `SELECT 1 FROM "JBSTestOpsAI".users WHERE tenant_id = $1 AND role = 'admin' LIMIT 1`,
    [tenantId]
  );
  if (userCheck.rows.length === 0) {
    await pool.query(
      `INSERT INTO "JBSTestOpsAI".users (tenant_id, username, password_hash, email, full_name, role)
       VALUES ($1, 'encore_admin', 'Encore@2026', 'admin@encoreglobal.com', 'Encore Admin', 'admin')
       ON CONFLICT (username) DO NOTHING`,
      [tenantId]
    );
    console.log('[seed] Created encore_admin user (password: Encore@2026)');
  }
  return tenantId;
}

interface ParsedCase {
  tc_number: string;
  title: string;
  steps: string[];
  expected: string;
  priority: string;
  feature: string;
  precondition: string;
  tags: Tag[];
  type: string;
}

function parseWorkbook(filePath: string): ParsedCase[] {
  const wb = XLSX.readFile(filePath);
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json<string[]>(ws, { header: 1, defval: '' });
  if (rows.length < 2) return [];

  const header = (rows[0] as string[]).map((h) => String(h || '').toLowerCase().trim());
  const col = (name: string, ...aliases: string[]): number => {
    for (const n of [name, ...aliases]) {
      const i = header.indexOf(n);
      if (i !== -1) return i;
    }
    return -1;
  };
  const idxId = col('tc id', 'id', 'tc number');
  const idxTitle = col('title', 'scenario', 'test case');
  const idxSteps = col('steps', 'test steps');
  const idxExpected = col('expected result', 'expected');
  const idxPrecond = col('preconditions', 'precondition');
  const idxFeature = col('specific field', 'feature', 'scenario');
  const idxPriority = col('priority');
  const idxTags = col('tags', 'type');

  const cases: ParsedCase[] = [];
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r] as string[];
    const title = cellString(row[idxTitle]);
    if (!title) continue;
    const steps = splitSteps(cellString(row[idxSteps]));
    const expected = cellString(row[idxExpected]);
    const precondition = cellString(row[idxPrecond]);
    const feature = cellString(row[idxFeature]);

    let tags: Tag[];
    const rawTags = idxTags >= 0 ? cellString(row[idxTags]) : '';
    if (rawTags) {
      const found = rawTags
        .split(/[\s,;|\[\]]+/)
        .map((t) => t.toUpperCase())
        .filter((t) => (TAG_VOCAB as readonly string[]).includes(t)) as Tag[];
      tags = found.length > 0 ? Array.from(new Set(found)) : inferTags(title, steps.join('\n'), expected);
    } else {
      tags = inferTags(title, steps.join('\n'), expected);
    }

    const primary = tags.includes('NEGATIVE') ? 'negative' : 'positive';
    cases.push({
      tc_number: cellString(row[idxId]) || `TC-${String(r).padStart(3, '0')}`,
      title,
      steps,
      expected,
      priority: cellString(row[idxPriority]) || 'P2',
      feature,
      precondition,
      tags,
      type: primary,
    });
  }
  return cases;
}

async function upsertRun(
  tenantId: string,
  moduleName: string,
  submodule: string,
  storyTitle: string,
  cases: ParsedCase[]
): Promise<{ runId: string; inserted: number }> {
  const existing = await pool.query(
    `SELECT id FROM "JBSTestOpsAI".test_runs
       WHERE tenant_id = $1 AND module = $2 AND submodule = $3`,
    [tenantId, moduleName, submodule]
  );

  let runId: string;
  if (existing.rows.length > 0) {
    runId = existing.rows[0].id;
    await pool.query(`DELETE FROM "JBSTestOpsAI".test_cases WHERE test_run_id = $1`, [runId]);
    await pool.query(
      `UPDATE "JBSTestOpsAI".test_runs SET story_title = $1, source = 'xlsx-import' WHERE id = $2`,
      [storyTitle, runId]
    );
  } else {
    const ins = await pool.query(
      `INSERT INTO "JBSTestOpsAI".test_runs
         (username, story_key, story_title, source, columns, tenant_id, module, submodule)
       VALUES ('system', NULL, $1, 'xlsx-import', '[]'::jsonb, $2, $3, $4) RETURNING id`,
      [storyTitle, tenantId, moduleName, submodule]
    );
    runId = ins.rows[0].id;
  }

  let inserted = 0;
  for (let i = 0; i < cases.length; i++) {
    const c = cases[i];
    await pool.query(
      `INSERT INTO "JBSTestOpsAI".test_cases
         (test_run_id, tc_number, title, steps, expected, priority, type, feature,
          precondition, status, sort_order, module, submodule, tags)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'generated', $10, $11, $12, $13)`,
      [
        runId,
        c.tc_number,
        c.title,
        JSON.stringify(c.steps),
        c.expected,
        c.priority,
        c.type,
        c.feature,
        c.precondition,
        i,
        moduleName,
        submodule,
        c.tags,
      ]
    );
    inserted++;
  }

  return { runId, inserted };
}

async function main() {
  const { root } = parseArgs();
  if (!fs.existsSync(root)) {
    console.error(`[seed] Root folder not found: ${root}`);
    process.exit(1);
  }

  const tenantId = await ensureTenant();
  console.log(`[seed] Tenant '${TENANT_SLUG}' → ${tenantId}`);

  const modules = fs
    .readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);

  const summary: Array<{ module: string; submodule: string; count: number }> = [];
  for (const moduleName of modules) {
    const moduleDir = path.join(root, moduleName);
    const files = fs.readdirSync(moduleDir).filter((f) => f.toLowerCase().endsWith('.xlsx'));
    for (const file of files) {
      const submodule = normaliseSubmodule(file);
      const filePath = path.join(moduleDir, file);
      const cases = parseWorkbook(filePath);
      if (cases.length === 0) {
        console.log(`[seed] ${moduleName}/${submodule}: no rows — skipping`);
        continue;
      }
      const storyTitle = `${moduleName} / ${submodule}`;
      const { inserted } = await upsertRun(tenantId, moduleName, submodule, storyTitle, cases);
      summary.push({ module: moduleName, submodule, count: inserted });
      console.log(`[seed] ${moduleName}/${submodule}: ${inserted} cases`);
    }
  }

  console.log('\n=== Summary ===');
  for (const r of summary) console.log(`  ${r.module.padEnd(22)} ${r.submodule.padEnd(40)} ${r.count}`);
  console.log(`Total: ${summary.reduce((s, r) => s + r.count, 0)} test cases across ${summary.length} submodules`);

  await pool.end();
}

main().catch((err) => {
  console.error('[seed] Failed:', err);
  process.exit(1);
});
