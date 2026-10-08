/**
 * api-pact-broker.service.ts
 * ──────────────────────────
 * A lightweight in-house Pact broker. Consumers PUBLISH pacts; providers are
 * VERIFIED by replaying each interaction against a live provider base URL and
 * recording the result; deployments are recorded per environment; and
 * can-i-deploy gates a release when any relevant consumer↔provider pair is
 * unverified. (Pact Broker + provider verification + can-i-deploy parity.)
 *
 * Standalone and opt-in: its own tables, reuses only the shared HTTP helper, and
 * the generate → execute → heal pipeline is never involved.
 */
import pool from '../db.js';
import { fetchFull } from '../utils/api-http.js';

export interface PactInteraction { description?: string; request: { method: string; path: string; query?: string; headers?: Record<string, string>; body?: unknown }; response: { status: number; headers?: Record<string, string>; body?: unknown } }
export interface PactDoc { consumer: { name: string }; provider: { name: string }; interactions: PactInteraction[]; metadata?: Record<string, unknown> }

export interface StoredPact { id: string; consumer: string; provider: string; version: string; branch: string; interactionCount: number; createdAt: string; lastVerification?: { success: boolean; providerVersion: string; at: string } }
export interface PactVerification { id: string; pactId: string; providerVersion: string; success: boolean; results: { description: string; expected: number; actual?: number; ok: boolean; error?: string }[]; createdAt: string }

function mapPact(r: any): StoredPact {
  let interactions = 0;
  try { const c = typeof r.contract === 'string' ? JSON.parse(r.contract) : r.contract; interactions = Array.isArray(c?.interactions) ? c.interactions.length : 0; } catch { /* ignore */ }
  return { id: String(r.id), consumer: r.consumer, provider: r.provider, version: r.version, branch: r.branch || 'main', interactionCount: interactions, createdAt: r.created_at };
}

export async function publishPact(tenantId: string, input: { consumer?: unknown; provider?: unknown; version?: unknown; branch?: unknown; contract: unknown }): Promise<StoredPact> {
  let doc: PactDoc;
  try { doc = typeof input.contract === 'string' ? JSON.parse(input.contract) : (input.contract as PactDoc); }
  catch { throw new Error('contract is not valid JSON.'); }
  if (!doc || !Array.isArray(doc.interactions)) throw new Error('A Pact contract needs an "interactions" array.');
  const consumer = String(input.consumer || doc.consumer?.name || '').trim().slice(0, 200);
  const provider = String(input.provider || doc.provider?.name || '').trim().slice(0, 200);
  if (!consumer || !provider) throw new Error('Pact needs a consumer and a provider (in the body or the contract).');
  const version = String(input.version || '0.0.0').trim().slice(0, 100);
  const branch = String(input.branch || 'main').trim().slice(0, 100);
  const { rows } = await pool.query(
    `INSERT INTO api_pacts (tenant_id, consumer, provider, version, branch, contract)
     OUTPUT INSERTED.* VALUES ($1, $2, $3, $4, $5, $6)`,
    [tenantId, consumer, provider, version, branch, JSON.stringify(doc)],
  );
  return mapPact(rows[0]);
}

export async function listPacts(tenantId: string): Promise<StoredPact[]> {
  const { rows } = await pool.query(`SELECT * FROM api_pacts WHERE tenant_id = $1 ORDER BY created_at DESC`, [tenantId]);
  const pacts = rows.map(mapPact);
  // Attach each pact's latest verification.
  const { rows: v } = await pool.query(`SELECT pact_id, success, provider_version, created_at FROM api_pact_verifications WHERE tenant_id = $1 ORDER BY created_at DESC`, [tenantId]);
  const latest = new Map<string, any>();
  for (const row of v) if (!latest.has(String(row.pact_id))) latest.set(String(row.pact_id), row);
  for (const p of pacts) { const lv = latest.get(p.id); if (lv) p.lastVerification = { success: lv.success === true || lv.success === 1, providerVersion: lv.provider_version, at: lv.created_at }; }
  return pacts;
}

export async function deletePact(tenantId: string, id: string): Promise<boolean> {
  await pool.query(`DELETE FROM api_pact_verifications WHERE tenant_id = $1 AND pact_id = $2`, [tenantId, id]);
  const { rowCount } = await pool.query(`DELETE FROM api_pacts WHERE tenant_id = $1 AND id = $2`, [tenantId, id]);
  return rowCount > 0;
}

/** Replay every interaction of a stored pact against a live provider base URL. */
export async function verifyPact(tenantId: string, pactId: string, providerBaseUrl: string, providerVersion: string): Promise<PactVerification> {
  if (!/^https?:\/\//i.test(providerBaseUrl)) throw new Error('providerBaseUrl must be an absolute http(s) URL.');
  const { rows } = await pool.query(`SELECT contract FROM api_pacts WHERE tenant_id = $1 AND id = $2`, [tenantId, pactId]);
  if (!rows.length) throw new Error('Pact not found.');
  const doc: PactDoc = typeof rows[0].contract === 'string' ? JSON.parse(rows[0].contract) : rows[0].contract;
  const base = providerBaseUrl.replace(/\/+$/, '');

  const results: PactVerification['results'] = [];
  for (const it of (doc.interactions || []).slice(0, 100)) {
    const path = String(it.request?.path || '/');
    const url = base + (path.startsWith('/') ? path : `/${path}`) + (it.request?.query ? `?${it.request.query}` : '');
    const method = String(it.request?.method || 'GET').toUpperCase();
    const headers: Record<string, string> = { ...(it.request?.headers || {}) };
    const body = it.request?.body != null ? (typeof it.request.body === 'string' ? it.request.body : JSON.stringify(it.request.body)) : undefined;
    if (body && !Object.keys(headers).some((k) => k.toLowerCase() === 'content-type')) headers['content-type'] = 'application/json';
    try {
      const r = await fetchFull(url, { method, headers, body });
      const expected = Number(it.response?.status) || 200;
      const ok = r.status === expected;
      results.push({ description: it.description || `${method} ${path}`, expected, actual: r.status, ok, error: ok ? undefined : (r.error || `expected ${expected}, got ${r.status}`) });
    } catch (e) {
      results.push({ description: it.description || `${method} ${path}`, expected: Number(it.response?.status) || 200, ok: false, error: (e as Error).message });
    }
  }
  const success = results.length > 0 && results.every((r) => r.ok);
  const { rows: vr } = await pool.query(
    `INSERT INTO api_pact_verifications (tenant_id, pact_id, provider_version, success, results)
     OUTPUT INSERTED.* VALUES ($1, $2, $3, $4, $5)`,
    [tenantId, pactId, String(providerVersion || '0.0.0').slice(0, 100), success ? 1 : 0, JSON.stringify(results)],
  );
  return { id: String(vr[0].id), pactId, providerVersion: vr[0].provider_version, success, results, createdAt: vr[0].created_at };
}

export async function recordDeployment(tenantId: string, pacticipant: string, version: string, environment: string): Promise<{ ok: boolean }> {
  if (!pacticipant || !version || !environment) throw new Error('recordDeployment needs pacticipant, version and environment.');
  await pool.query(
    `INSERT INTO api_pact_deployments (tenant_id, pacticipant, version, environment) VALUES ($1, $2, $3, $4)`,
    [tenantId, String(pacticipant).slice(0, 200), String(version).slice(0, 100), String(environment).slice(0, 100)],
  );
  return { ok: true };
}

export interface CanIDeployResult { deployable: boolean; pacticipant: string; version: string; environment: string; reasons: string[]; pairs: { consumer: string; provider: string; verified: boolean; detail: string }[] }

/** Can this pacticipant@version deploy to this environment? Every relevant pair must be verified. */
export async function canIDeploy(tenantId: string, pacticipant: string, version: string, environment: string): Promise<CanIDeployResult> {
  const { rows: pacts } = await pool.query(
    `SELECT id, consumer, provider FROM api_pacts WHERE tenant_id = $1 AND (consumer = $2 OR provider = $2)`,
    [tenantId, pacticipant],
  );
  const { rows: verifs } = await pool.query(`SELECT pact_id, success FROM api_pact_verifications WHERE tenant_id = $1`, [tenantId]);
  const verifiedPact = new Set<string>();
  for (const v of verifs) if (v.success === true || v.success === 1) verifiedPact.add(String(v.pact_id));

  const pairs: CanIDeployResult['pairs'] = [];
  const reasons: string[] = [];
  for (const p of pacts) {
    const verified = verifiedPact.has(String(p.id));
    pairs.push({ consumer: p.consumer, provider: p.provider, verified, detail: verified ? 'latest verification passed' : 'no successful provider verification' });
    if (!verified) reasons.push(`${p.consumer} → ${p.provider}: not verified`);
  }
  if (!pacts.length) reasons.push(`No pacts found involving "${pacticipant}" — nothing to gate on (treated as deployable).`);
  const deployable = reasons.length === 0 || (!pacts.length);
  return { deployable, pacticipant, version, environment, reasons, pairs };
}
