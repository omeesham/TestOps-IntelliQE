/**
 * One-off: replace **bold** markdown with "quoted" text in Encore test cases.
 *
 *   npx tsx scripts/normalizeEncoreMarkdown.ts
 *
 * Affects: title, steps[], expected, precondition on all test_cases that belong
 * to the 'encore-global' tenant.
 */
import pool from '../src/db.js';

const TENANT_SLUG = 'encore-global';
const BOLD_RE = /\*\*([^*\n]+?)\*\*/g;

function stripBold(s: string | null | undefined): string | null {
  if (s == null) return s ?? null;
  return s.replace(BOLD_RE, (_m, g1) => `"${g1.trim()}"`);
}

async function main() {
  const tenantRes = await pool.query(
    `SELECT id FROM "JBSTestOpsAI".tenants WHERE slug = $1`,
    [TENANT_SLUG]
  );
  if (tenantRes.rows.length === 0) {
    console.error(`Tenant '${TENANT_SLUG}' not found`);
    process.exit(1);
  }
  const tenantId: string = tenantRes.rows[0].id;

  const { rows } = await pool.query(
    `SELECT tc.id, tc.title, tc.steps, tc.expected, tc.precondition
       FROM "JBSTestOpsAI".test_cases tc
       JOIN "JBSTestOpsAI".test_runs  r ON r.id = tc.test_run_id
      WHERE r.tenant_id = $1`,
    [tenantId]
  );

  let updated = 0;
  for (const row of rows) {
    const newTitle = stripBold(row.title);
    const newExpected = stripBold(row.expected);
    const newPre = stripBold(row.precondition);
    const steps: string[] = Array.isArray(row.steps) ? row.steps : [];
    const newSteps = steps.map((s) => stripBold(s) ?? '');

    const changed =
      newTitle !== row.title ||
      newExpected !== row.expected ||
      newPre !== row.precondition ||
      JSON.stringify(newSteps) !== JSON.stringify(steps);

    if (!changed) continue;

    await pool.query(
      `UPDATE "JBSTestOpsAI".test_cases
          SET title = $1, steps = $2::jsonb, expected = $3, precondition = $4
        WHERE id = $5`,
      [newTitle, JSON.stringify(newSteps), newExpected, newPre, row.id]
    );
    updated++;
  }

  console.log(`Normalized ${updated} / ${rows.length} test cases for tenant '${TENANT_SLUG}'`);
  await pool.end();
}

main().catch((err) => {
  console.error('Failed:', err);
  process.exit(1);
});
