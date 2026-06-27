/**
 * One-off probe: shows what LLM credentials are actually configured in the DB,
 * so we can confirm the "LLM Configuration" key the user set is present and
 * decryptable. Prints masked keys only. Run:
 *   npx tsx --env-file=.env scripts/probe-llm.ts
 */
import pool from '../src/db.js';
import { decryptConfigData } from '../src/utils/crypto.js';

function mask(v?: unknown): string {
  if (typeof v !== 'string' || !v) return '(none)';
  if (v.length < 12) return `(short len=${v.length})`;
  return `${v.slice(0, 8)}…${v.slice(-4)} [len=${v.length}]`;
}

async function main() {
  const { rows } = await pool.query(
    `SELECT tenant_id, integration_id, config_data, status
       FROM client_configurations
      WHERE integration_id LIKE 'llm-%' OR integration_id = 'ai-self-healing'
      ORDER BY integration_id`,
  );
  console.log(`\n=== client_configurations (LLM rows): ${rows.length} ===`);
  for (const r of rows) {
    const dec = decryptConfigData(r.config_data || {});
    console.log(
      `${r.integration_id}\n   tenant=${r.tenant_id} status=${r.status}\n   provider=${dec.provider ?? ''} model=${dec.model ?? ''} enabled=${dec.enabled ?? ''} endpoint=${dec.endpoint ?? ''}\n   apiKey=${mask(dec.apiKey)} defaults=${dec.defaults ? JSON.stringify(dec.defaults) : ''} activeEnvironment=${dec.activeEnvironment ?? ''}`,
    );
  }

  const t = await pool.query(
    `SELECT id, slug, is_platform,
            CASE WHEN anthropic_api_key IS NULL OR anthropic_api_key = '' THEN 0 ELSE 1 END AS has_tenant_key
       FROM tenants`,
  );
  console.log(`\n=== tenants ===`);
  for (const r of t.rows) {
    console.log(`   id=${r.id} slug=${r.slug} is_platform=${r.is_platform} has_tenant_key=${r.has_tenant_key}`);
  }
  process.exit(0);
}

main().catch((e) => { console.error('PROBE ERROR:', e); process.exit(1); });
