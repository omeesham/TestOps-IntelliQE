/**
 * api-tm-connectors.service.ts
 * ────────────────────────────
 * Native test-management connectors with bidirectional result export:
 * TestRail, Xray (Jira cloud), Zephyr Scale (cloud), and qTest. Each tenant can
 * register one or more connectors (base URL + project + credentials, encrypted
 * at rest). From a finished API run we can PUSH results out (create an external
 * run/execution and post per-case pass/fail) and, where the vendor exposes it,
 * PULL the external test cases back in for review.
 *
 * Deliberately its OWN table (not the pipeline's `client_configurations`, which
 * drives the "application under test" list) so it stays additive. Every vendor
 * call is guarded — a vendor outage or auth error returns a clean result, never
 * throws out of the export.
 */
import pool from '../db.js';
import { encryptAtRest, decryptStored } from '../utils/crypto.js';
import { fetchFull } from '../utils/api-http.js';
import { getApiRunDetail } from './api-dashboard.service.js';

export type TmVendor = 'testrail' | 'xray' | 'zephyr' | 'qtest';
const VENDORS: TmVendor[] = ['testrail', 'xray', 'zephyr', 'qtest'];
export const VENDOR_LABELS: Record<TmVendor, string> = {
  testrail: 'TestRail', xray: 'Xray (Jira Cloud)', zephyr: 'Zephyr Scale', qtest: 'qTest',
};

export interface TmConnector {
  id: string; vendor: TmVendor; name: string; baseUrl: string; projectKey: string;
  enabled: boolean; authFields: string[]; // which credential keys are set (never values)
  createdBy: string; createdAt: string; updatedAt: string;
}

const DEFAULT_BASE: Record<TmVendor, string> = {
  testrail: '', // tenant-specific, e.g. https://acme.testrail.io
  xray: 'https://xray.cloud.getxray.app',
  zephyr: 'https://api.zephyrscale.smartbear.com/v2',
  qtest: '', // tenant-specific, e.g. https://acme.qtestnet.com
};

function readAuth(r: any): Record<string, string> {
  if (!r.auth) return {};
  try { return JSON.parse(decryptStored(String(r.auth))) || {}; } catch { return {}; }
}
function toConnector(r: any): TmConnector {
  const auth = readAuth(r);
  return {
    id: String(r.id), vendor: (VENDORS.includes(r.vendor) ? r.vendor : 'testrail') as TmVendor,
    name: r.name || '', baseUrl: r.base_url || '', projectKey: r.project_key || '',
    enabled: r.enabled === true || r.enabled === 1,
    authFields: Object.keys(auth).filter((k) => auth[k]),
    createdBy: r.created_by || '', createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

const MASK = /•/;
function cleanAuthInput(obj: any): Record<string, string> {
  const out: Record<string, string> = {};
  if (obj && typeof obj === 'object') {
    for (const [k, v] of Object.entries(obj)) {
      if (typeof v === 'string' && v && !MASK.test(v)) out[String(k).slice(0, 40)] = v.slice(0, 2000);
    }
  }
  return out;
}

async function loadRow(tenantId: string, id: string): Promise<any | null> {
  if (!id) return null;
  const { rows } = await pool.query(`SELECT * FROM api_tm_connectors WHERE tenant_id = $1 AND id = $2`, [tenantId, id]);
  return rows.length ? rows[0] : null;
}

export async function listConnectors(tenantId: string): Promise<TmConnector[]> {
  const { rows } = await pool.query(`SELECT * FROM api_tm_connectors WHERE tenant_id = $1 ORDER BY updated_at DESC`, [tenantId]);
  return rows.map(toConnector);
}

export async function saveConnector(tenantId: string, username: string, input: any): Promise<TmConnector> {
  const vendor: TmVendor = VENDORS.includes(input?.vendor) ? input.vendor : 'testrail';
  const name = String(input?.name || '').trim().slice(0, 200) || VENDOR_LABELS[vendor];
  const baseUrl = String(input?.baseUrl || '').trim().slice(0, 500) || DEFAULT_BASE[vendor];
  const projectKey = String(input?.projectKey || '').trim().slice(0, 200);
  const enabled = input?.enabled !== false;
  const provided = cleanAuthInput(input?.auth);

  if (input?.id) {
    const existing = await loadRow(tenantId, String(input.id));
    if (!existing) throw new Error('Connector not found.');
    const merged = { ...readAuth(existing), ...provided }; // partial update keeps untouched secrets
    const { rows } = await pool.query(
      `UPDATE api_tm_connectors SET vendor = $3, name = $4, base_url = $5, project_key = $6, auth = $7, enabled = $8, updated_at = SYSUTCDATETIME()
         OUTPUT INSERTED.* WHERE tenant_id = $1 AND id = $2`,
      [tenantId, input.id, vendor, name, baseUrl, projectKey, encryptAtRest(JSON.stringify(merged)), enabled],
    );
    return toConnector(rows[0]);
  }
  const { rows } = await pool.query(
    `INSERT INTO api_tm_connectors (tenant_id, vendor, name, base_url, project_key, auth, enabled, created_by)
       OUTPUT INSERTED.* VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [tenantId, vendor, name, baseUrl, projectKey, encryptAtRest(JSON.stringify(provided)), enabled, username],
  );
  return toConnector(rows[0]);
}

export async function deleteConnector(tenantId: string, id: string): Promise<boolean> {
  const { rowCount } = await pool.query(`DELETE FROM api_tm_connectors WHERE tenant_id = $1 AND id = $2`, [tenantId, id]);
  return rowCount > 0;
}

// ─── vendor plumbing ──────────────────────────────────────────────────────

const basic = (u: string, p: string) => 'Basic ' + Buffer.from(`${u}:${p}`).toString('base64');
const trimSlash = (s: string) => s.replace(/\/+$/, '');

async function xrayToken(base: string, auth: Record<string, string>): Promise<string> {
  const r = await fetchFull(`${trimSlash(base)}/api/v2/authenticate`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client_id: auth.clientId, client_secret: auth.clientSecret }),
  }, 20_000, 4000);
  if (!r.ok) throw new Error(`Xray auth failed (${r.status || 'no status'}).`);
  return r.bodyText.replace(/^"|"$/g, '').trim();
}

/** passed / failed(+broken) / other → vendor-specific tokens. */
function mapStatus(status: string): 'pass' | 'fail' | 'other' {
  if (status === 'passed') return 'pass';
  if (status === 'failed' || status === 'broken') return 'fail';
  return 'other';
}

export interface TmTestResult { ok: boolean; detail: string }
export interface TmExportResult { ok: boolean; detail: string; externalRef?: string; exported: number; skipped: number }

/** Lightweight connection check per vendor. */
export async function testConnector(tenantId: string, id: string): Promise<TmTestResult> {
  const row = await loadRow(tenantId, id);
  if (!row) throw new Error('Connector not found.');
  const c = toConnector(row);
  const auth = readAuth(row);
  try {
    if (c.vendor === 'testrail') {
      const r = await fetchFull(`${trimSlash(c.baseUrl)}/index.php?/api/v2/get_projects`, { method: 'GET', headers: { Authorization: basic(auth.email || '', auth.apiKey || ''), 'content-type': 'application/json' } }, 20_000, 2000);
      return r.ok ? { ok: true, detail: 'Authenticated with TestRail.' } : { ok: false, detail: `TestRail returned ${r.status || 'no status'}.` };
    }
    if (c.vendor === 'xray') {
      await xrayToken(c.baseUrl || DEFAULT_BASE.xray, auth);
      return { ok: true, detail: 'Obtained an Xray token.' };
    }
    if (c.vendor === 'zephyr') {
      const r = await fetchFull(`${trimSlash(c.baseUrl || DEFAULT_BASE.zephyr)}/testcases?maxResults=1${c.projectKey ? `&projectKey=${encodeURIComponent(c.projectKey)}` : ''}`, { method: 'GET', headers: { Authorization: `Bearer ${auth.token || ''}` } }, 20_000, 2000);
      return r.ok ? { ok: true, detail: 'Authenticated with Zephyr Scale.' } : { ok: false, detail: `Zephyr returned ${r.status || 'no status'}.` };
    }
    // qtest
    const r = await fetchFull(`${trimSlash(c.baseUrl)}/api/v3/projects`, { method: 'GET', headers: { Authorization: `Bearer ${auth.token || ''}` } }, 20_000, 2000);
    return r.ok ? { ok: true, detail: 'Authenticated with qTest.' } : { ok: false, detail: `qTest returned ${r.status || 'no status'}.` };
  } catch (e) {
    return { ok: false, detail: (e as Error).message };
  }
}

/** Push a finished run's results into the external tool. */
export async function exportRun(tenantId: string, id: string, runId: string): Promise<TmExportResult> {
  const row = await loadRow(tenantId, id);
  if (!row) throw new Error('Connector not found.');
  const c = toConnector(row);
  if (!c.enabled) throw new Error('This connector is disabled.');
  const auth = readAuth(row);
  const detail = await getApiRunDetail(tenantId, runId);
  if (!detail) throw new Error('Run not found.');
  const cases = detail.cases || [];
  const title = detail.title || `API run ${runId}`;

  try {
    if (c.vendor === 'xray') return await exportToXray(c, auth, title, cases);
    if (c.vendor === 'testrail') return await exportToTestRail(c, auth, title, cases);
    if (c.vendor === 'zephyr') return await exportToZephyr(c, auth, title, cases);
    return await exportToQTest(c, auth, title, cases);
  } catch (e) {
    return { ok: false, detail: (e as Error).message, exported: 0, skipped: cases.length };
  }
}

type RunCase = { id: string; title: string; status: string };

/** Xray cloud: import/execution auto-creates test issues from testInfo — pushes every case. */
async function exportToXray(c: TmConnector, auth: Record<string, string>, title: string, cases: RunCase[]): Promise<TmExportResult> {
  const token = await xrayToken(c.baseUrl || DEFAULT_BASE.xray, auth);
  const tests = cases.map((t) => ({
    testInfo: { summary: `${t.id} ${t.title}`.slice(0, 250), type: 'Generic', projectKey: c.projectKey || undefined, definition: t.id },
    status: mapStatus(t.status) === 'pass' ? 'PASSED' : mapStatus(t.status) === 'fail' ? 'FAILED' : 'TODO',
  }));
  const body = { info: { summary: `IntelliQE: ${title}`.slice(0, 250), project: c.projectKey || undefined }, tests };
  const r = await fetchFull(`${trimSlash(c.baseUrl || DEFAULT_BASE.xray)}/api/v2/import/execution`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body),
  }, 45_000, 4000);
  if (!r.ok) return { ok: false, detail: `Xray import returned ${r.status || 'no status'}: ${r.bodyText.slice(0, 200)}`, exported: 0, skipped: cases.length };
  let ref: string | undefined;
  try { ref = JSON.parse(r.bodyText)?.key; } catch { /* non-JSON ok */ }
  return { ok: true, detail: `Imported ${tests.length} results into Xray${ref ? ` (execution ${ref})` : ''}.`, externalRef: ref, exported: tests.length, skipped: 0 };
}

/** TestRail: create a run, then post results for cases whose id resolves to a TestRail case (C###). */
async function exportToTestRail(c: TmConnector, auth: Record<string, string>, title: string, cases: RunCase[]): Promise<TmExportResult> {
  const headers = { Authorization: basic(auth.email || '', auth.apiKey || ''), 'content-type': 'application/json' };
  const projectId = c.projectKey;
  if (!projectId) throw new Error('Set the TestRail project id first.');
  // Resolve TestRail case ids from a "C123" token in the case id/title.
  const resolved = cases.map((t) => ({ t, caseId: (/(?:^|\b)C(\d+)\b/i.exec(`${t.id} ${t.title}`)?.[1]) || null })).filter((x) => x.caseId);
  const runBody: any = { name: `IntelliQE: ${title}`.slice(0, 250), include_all: resolved.length === 0 };
  if (resolved.length) runBody.case_ids = resolved.map((x) => Number(x.caseId));
  const addRun = await fetchFull(`${trimSlash(c.baseUrl)}/index.php?/api/v2/add_run/${encodeURIComponent(projectId)}`, { method: 'POST', headers, body: JSON.stringify(runBody) }, 30_000, 4000);
  if (!addRun.ok) return { ok: false, detail: `TestRail add_run returned ${addRun.status || 'no status'}.`, exported: 0, skipped: cases.length };
  let newRunId: number | undefined;
  try { newRunId = JSON.parse(addRun.bodyText)?.id; } catch { /* ignore */ }
  if (!newRunId) return { ok: false, detail: 'TestRail did not return a run id.', exported: 0, skipped: cases.length };
  if (!resolved.length) {
    return { ok: true, detail: `Created TestRail run R${newRunId}, but no case carried a TestRail case id (C###), so no per-case results were posted.`, externalRef: `R${newRunId}`, exported: 0, skipped: cases.length };
  }
  const results = resolved.map((x) => ({ case_id: Number(x.caseId), status_id: mapStatus(x.t.status) === 'pass' ? 1 : mapStatus(x.t.status) === 'fail' ? 5 : 4 }));
  const post = await fetchFull(`${trimSlash(c.baseUrl)}/index.php?/api/v2/add_results_for_cases/${newRunId}`, { method: 'POST', headers, body: JSON.stringify({ results }) }, 30_000, 4000);
  if (!post.ok) return { ok: false, detail: `TestRail add_results returned ${post.status || 'no status'}.`, externalRef: `R${newRunId}`, exported: 0, skipped: cases.length };
  return { ok: true, detail: `Posted ${results.length} results to TestRail run R${newRunId}.`, externalRef: `R${newRunId}`, exported: results.length, skipped: cases.length - results.length };
}

/** Zephyr Scale: create a test cycle (per-case executions need Zephyr testCase keys). */
async function exportToZephyr(c: TmConnector, auth: Record<string, string>, title: string, cases: RunCase[]): Promise<TmExportResult> {
  const base = trimSlash(c.baseUrl || DEFAULT_BASE.zephyr);
  const headers = { Authorization: `Bearer ${auth.token || ''}`, 'content-type': 'application/json' };
  if (!c.projectKey) throw new Error('Set the Zephyr project key first.');
  const cyc = await fetchFull(`${base}/testcycles`, { method: 'POST', headers, body: JSON.stringify({ projectKey: c.projectKey, name: `IntelliQE: ${title}`.slice(0, 250) }) }, 30_000, 4000);
  if (!cyc.ok) return { ok: false, detail: `Zephyr create cycle returned ${cyc.status || 'no status'}.`, exported: 0, skipped: cases.length };
  let key: string | undefined;
  try { key = JSON.parse(cyc.bodyText)?.key; } catch { /* ignore */ }
  // Post executions for cases whose title/id carries a Zephyr testCase key (PROJ-T123).
  const kre = new RegExp(`${c.projectKey}-T?\\d+`, 'i');
  const resolved = cases.map((t) => ({ t, tcKey: kre.exec(`${t.id} ${t.title}`)?.[0] || null })).filter((x) => x.tcKey);
  let exported = 0;
  for (const x of resolved) {
    const statusName = mapStatus(x.t.status) === 'pass' ? 'Pass' : mapStatus(x.t.status) === 'fail' ? 'Fail' : 'Not Executed';
    const ex = await fetchFull(`${base}/testexecutions`, { method: 'POST', headers, body: JSON.stringify({ projectKey: c.projectKey, testCycleKey: key, testCaseKey: x.tcKey, statusName }) }, 20_000, 2000);
    if (ex.ok) exported++;
  }
  return { ok: true, detail: `Created Zephyr cycle${key ? ` ${key}` : ''}; posted ${exported} executions${resolved.length < cases.length ? ` (${cases.length - resolved.length} cases had no Zephyr key)` : ''}.`, externalRef: key, exported, skipped: cases.length - exported };
}

/** qTest: submit an automation test-log payload (auto-creates test cases by name). */
async function exportToQTest(c: TmConnector, auth: Record<string, string>, title: string, cases: RunCase[]): Promise<TmExportResult> {
  if (!c.projectKey) throw new Error('Set the qTest project id first.');
  const headers = { Authorization: `Bearer ${auth.token || ''}`, 'content-type': 'application/json' };
  const now = new Date().toISOString();
  const logs = cases.map((t) => ({
    name: `${t.id} ${t.title}`.slice(0, 250),
    automation_content: t.id,
    exe_start_date: now, exe_end_date: now,
    status: mapStatus(t.status) === 'pass' ? 'PASS' : mapStatus(t.status) === 'fail' ? 'FAIL' : 'SKIP',
  }));
  const body = { test_cycle: `IntelliQE: ${title}`.slice(0, 250), test_logs: logs };
  const r = await fetchFull(`${trimSlash(c.baseUrl)}/api/v3/projects/${encodeURIComponent(c.projectKey)}/auto-test-logs?type=automation`, { method: 'POST', headers, body: JSON.stringify(body) }, 45_000, 4000);
  if (!r.ok) return { ok: false, detail: `qTest returned ${r.status || 'no status'}: ${r.bodyText.slice(0, 200)}`, exported: 0, skipped: cases.length };
  return { ok: true, detail: `Submitted ${logs.length} automation logs to qTest project ${c.projectKey}.`, exported: logs.length, skipped: 0 };
}

// ─── pull (bidirectional, where the vendor offers a simple list) ─────────────

export interface ImportedCase { externalId: string; title: string; status?: string }
export interface TmImportResult { ok: boolean; detail: string; cases: ImportedCase[] }

export async function importCases(tenantId: string, id: string, limit = 100): Promise<TmImportResult> {
  const row = await loadRow(tenantId, id);
  if (!row) throw new Error('Connector not found.');
  const c = toConnector(row);
  const auth = readAuth(row);
  const cap = Math.max(1, Math.min(250, Number(limit) || 100));
  try {
    if (c.vendor === 'testrail') {
      if (!c.projectKey) throw new Error('Set the TestRail project id first.');
      const r = await fetchFull(`${trimSlash(c.baseUrl)}/index.php?/api/v2/get_cases/${encodeURIComponent(c.projectKey)}`, { method: 'GET', headers: { Authorization: basic(auth.email || '', auth.apiKey || ''), 'content-type': 'application/json' } }, 30_000, 20_000);
      if (!r.ok) return { ok: false, detail: `TestRail returned ${r.status || 'no status'}.`, cases: [] };
      const parsed = safeJson(r.bodyText);
      const arr = Array.isArray(parsed) ? parsed : (parsed?.cases || []);
      return { ok: true, detail: `Pulled ${Math.min(arr.length, cap)} TestRail cases.`, cases: arr.slice(0, cap).map((x: any) => ({ externalId: `C${x.id}`, title: String(x.title || '') })) };
    }
    if (c.vendor === 'zephyr') {
      const r = await fetchFull(`${trimSlash(c.baseUrl || DEFAULT_BASE.zephyr)}/testcases?maxResults=${cap}${c.projectKey ? `&projectKey=${encodeURIComponent(c.projectKey)}` : ''}`, { method: 'GET', headers: { Authorization: `Bearer ${auth.token || ''}` } }, 30_000, 20_000);
      if (!r.ok) return { ok: false, detail: `Zephyr returned ${r.status || 'no status'}.`, cases: [] };
      const vals = safeJson(r.bodyText)?.values || [];
      return { ok: true, detail: `Pulled ${vals.length} Zephyr cases.`, cases: vals.map((x: any) => ({ externalId: String(x.key || x.id || ''), title: String(x.name || '') })) };
    }
    if (c.vendor === 'qtest') {
      if (!c.projectKey) throw new Error('Set the qTest project id first.');
      const r = await fetchFull(`${trimSlash(c.baseUrl)}/api/v3/projects/${encodeURIComponent(c.projectKey)}/test-cases?pageSize=${cap}`, { method: 'GET', headers: { Authorization: `Bearer ${auth.token || ''}` } }, 30_000, 20_000);
      if (!r.ok) return { ok: false, detail: `qTest returned ${r.status || 'no status'}.`, cases: [] };
      const arr = safeJson(r.bodyText);
      const items = Array.isArray(arr) ? arr : (arr?.items || []);
      return { ok: true, detail: `Pulled ${items.length} qTest cases.`, cases: items.map((x: any) => ({ externalId: String(x.pid || x.id || ''), title: String(x.name || '') })) };
    }
    return { ok: false, detail: 'Pulling cases from Xray needs a JQL/GraphQL query and is not supported here yet — export to Xray works.', cases: [] };
  } catch (e) {
    return { ok: false, detail: (e as Error).message, cases: [] };
  }
}

function safeJson(s: string): any { try { return JSON.parse(s); } catch { return null; } }
