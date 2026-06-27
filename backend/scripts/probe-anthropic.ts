/**
 * Resolves the configured Anthropic key exactly like the LLM Configuration UI
 * does (llm-settings.activeEnvironment + defaults → llm-<provider>-<env>) and
 * makes a MINIMAL live API call to verify the key works (auth + credits).
 * Prints only HTTP status + a short snippet — never the key.
 *   npx tsx --env-file=.env scripts/probe-anthropic.ts
 */
import pool from '../src/db.js';
import { decryptConfigData } from '../src/utils/crypto.js';

async function getConfig(tenantId: string, integrationId: string) {
  const { rows } = await pool.query(
    `SELECT config_data FROM client_configurations WHERE tenant_id = $1 AND integration_id = $2`,
    [tenantId, integrationId],
  );
  if (!rows.length) return null;
  return decryptConfigData(rows[0].config_data || {});
}

async function main() {
  const { rows: tenants } = await pool.query(
    `SELECT id FROM tenants WHERE is_platform = 1 ORDER BY created_at`,
  );
  const tenantId = tenants[0]?.id;
  if (!tenantId) { console.log('No platform tenant'); process.exit(2); }

  const settings = (await getConfig(tenantId, 'llm-settings')) || {};
  const env = settings.activeEnvironment || 'production';
  const defaults = settings.defaults || {};
  const providerId = defaults[env] || 'anthropic';
  console.log(`tenant=${tenantId} env=${env} provider=${providerId}`);

  const row = (await getConfig(tenantId, `llm-${providerId}-${env}`)) || {};
  const apiKey: string = row.apiKey;
  const model: string = row.model || 'claude-opus-4-8';
  const baseUrl: string = row.endpoint || 'https://api.anthropic.com';
  if (!apiKey) { console.log('No apiKey resolved'); process.exit(3); }
  console.log(`model=${model} baseUrl=${baseUrl} keyLen=${apiKey.length} enabled=${row.enabled}`);

  const t0 = Date.now();
  const res = await fetch(`${baseUrl}/v1/messages`, {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model,
      max_tokens: 16,
      messages: [{ role: 'user', content: 'Reply with exactly: OK' }],
    }),
  });
  const ms = Date.now() - t0;
  const text = await res.text();
  console.log(`\nHTTP ${res.status} in ${ms}ms`);
  console.log(text.slice(0, 600));
  process.exit(res.ok ? 0 : 1);
}

main().catch((e) => { console.error('PROBE ERROR:', e?.message || e); process.exit(1); });
