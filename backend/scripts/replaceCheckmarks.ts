import pool from '../src/db.js';

const TENANT_SLUG = 'encore-global';
const CHECKMARK_RE = /[\u2713\u2714\u2705]/g;

function swap(s: string | null | undefined): string | null {
  if (s == null) return s ?? null;
  return s.replace(CHECKMARK_RE, '-');
}

async function main() {
  const { rows } = await pool.query(
    `SELECT tc.id, tc.title, tc.steps, tc.expected, tc.precondition
       FROM "JBSTestOpsAI".test_cases tc
       JOIN "JBSTestOpsAI".test_runs  r ON r.id = tc.test_run_id
       JOIN "JBSTestOpsAI".tenants    t ON t.id = r.tenant_id
      WHERE t.slug = $1`,
    [TENANT_SLUG]
  );

  let updated = 0;
  for (const row of rows) {
    const title = swap(row.title);
    const expected = swap(row.expected);
    const pre = swap(row.precondition);
    const steps: string[] = Array.isArray(row.steps) ? row.steps : [];
    const newSteps = steps.map((s) => swap(s) ?? '');
    const changed =
      title !== row.title ||
      expected !== row.expected ||
      pre !== row.precondition ||
      JSON.stringify(newSteps) !== JSON.stringify(steps);
    if (!changed) continue;
    await pool.query(
      `UPDATE "JBSTestOpsAI".test_cases SET title = $1, steps = $2::jsonb, expected = $3, precondition = $4 WHERE id = $5`,
      [title, JSON.stringify(newSteps), expected, pre, row.id]
    );
    updated++;
  }
  console.log(`Replaced checkmarks with '-' in ${updated} / ${rows.length} test cases`);
  await pool.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
