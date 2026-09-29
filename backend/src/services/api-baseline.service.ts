/**
 * api-baseline.service.ts
 * ───────────────────────
 * Response-diff regression baselines — a standalone, opt-in check that lives
 * ALONGSIDE the generation → execute → heal pipeline and never modifies it.
 *
 * Capture stores a snapshot of an endpoint's live response (status, content
 * -type, JSON body). Later, compare probes the endpoint again and diffs the
 * fresh response against the stored one, surfacing silent contract drift:
 *   • status changed
 *   • a field was removed or added
 *   • a field changed type
 *   • a field changed value (volatile fields — ids, timestamps, tokens — are
 *     compared by presence/type only, so a fresh id is not reported as drift)
 *
 * One baseline per endpoint signature (method + url); re-capturing overwrites.
 * Nothing here is read by the pipeline — it is a pure record/replay of the
 * live API against a prior snapshot.
 */
import pool from '../db.js';
import { probeEndpoint, type ParsedApiRequest } from '../agents/apiHealingAgent.js';

export interface BaselineEndpointInput {
  id: string;
  title?: string;
  method: string;
  url: string;
  headers?: { key: string; value: string }[];
  auth?: { type: 'none' | 'bearer' | 'basic' | 'apikey'; value?: string; headerName?: string };
  body?: string;
}

export interface BaselineRecord {
  id: string;
  sig: string;
  method: string;
  url: string;
  title: string;
  status?: number;
  contentType?: string;
  capturedBy?: string;
  capturedAt: string;
  updatedAt: string;
}

export type DriftKind = 'status' | 'added' | 'removed' | 'type-changed' | 'value-changed' | 'transport' | 'content';
export interface DriftEntry { kind: DriftKind; path: string; before?: string; after?: string }

export interface CompareResult {
  id: string;
  title: string;
  method: string;
  url: string;
  hasBaseline: boolean;
  reachable: boolean;
  status?: number;
  baselineStatus?: number;
  drift: DriftEntry[];
  capturedAt?: string;
}

export interface CompareReport {
  results: CompareResult[];
  summary: { total: number; compared: number; unchanged: number; drifted: number; unreachable: number; noBaseline: number };
}

const MAX_ENDPOINTS = 100;
const CONCURRENCY = 6;
const BODY_STORE_LIMIT = 200_000;
const MAX_DRIFT_PER_ENDPOINT = 60;

/** Field names whose value is expected to change run-to-run — compared by type, not value. */
const VOLATILE_KEY = /(^|[_-])(id|uuid|guid|etag|nonce|token|time|timestamp|date|created|updated|modified|expires?|expiry|_at|traceid|requestid|correlationid|session|version|revision|hash|checksum|seq|sequence)$/i;
/** Values that self-evidently vary (ISO dates, UUIDs) even under a stable key. */
const VOLATILE_VALUE = /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|\d{4}-\d{2}-\d{2}T[\d:.]+Z?)$/i;

function sigOf(method: string, url: string): string {
  return `${(method || 'GET').toUpperCase()} ${url}`;
}

/** Build the live request, folding auth into headers the way the runner does. */
function toRequest(ep: BaselineEndpointInput): ParsedApiRequest {
  const headers: Record<string, string> = {};
  for (const h of ep.headers || []) { if (h?.key) headers[h.key] = h.value ?? ''; }
  const a = ep.auth;
  if (a && a.type !== 'none' && a.value) {
    if (a.type === 'bearer') headers['Authorization'] = `Bearer ${a.value}`;
    else if (a.type === 'basic') headers['Authorization'] = `Basic ${Buffer.from(a.value).toString('base64')}`;
    else if (a.type === 'apikey') headers[a.headerName || 'X-API-Key'] = a.value;
  }
  const method = (ep.method || 'GET').toUpperCase();
  const body = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method) && ep.body ? ep.body : undefined;
  if (body && !Object.keys(headers).some((k) => k.toLowerCase() === 'content-type')) headers['Content-Type'] = 'application/json';
  return { method, url: ep.url, headers, body };
}

function typeOf(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

function preview(v: unknown): string {
  if (v === undefined) return '';
  if (typeof v === 'string') return v.length > 80 ? `${v.slice(0, 80)}…` : v;
  if (v === null || typeof v === 'number' || typeof v === 'boolean') return String(v);
  const s = JSON.stringify(v);
  return s && s.length > 80 ? `${s.slice(0, 80)}…` : (s || '');
}

/**
 * Structural + value diff of a fresh response against the baseline. Walks both
 * trees: reports removed/added keys and type changes always; reports value
 * changes only for stable (non-volatile) leaves. Arrays are compared by shape
 * (length and first-element structure), never element-by-element, so reordered
 * or paginated lists don't drown the report.
 */
function diffValue(base: unknown, curr: unknown, path: string, key: string, out: DriftEntry[]): void {
  if (out.length >= MAX_DRIFT_PER_ENDPOINT) return;
  const bt = typeOf(base);
  const ct = typeOf(curr);
  if (bt !== ct) {
    out.push({ kind: 'type-changed', path: path || '(root)', before: bt, after: ct });
    return;
  }
  if (bt === 'object') {
    const bo = base as Record<string, unknown>;
    const co = curr as Record<string, unknown>;
    for (const k of Object.keys(bo)) {
      if (!(k in co)) { out.push({ kind: 'removed', path: `${path}.${k}`.replace(/^\./, ''), before: preview(bo[k]) }); continue; }
      diffValue(bo[k], co[k], `${path}.${k}`.replace(/^\./, ''), k, out);
    }
    for (const k of Object.keys(co)) {
      if (!(k in bo)) out.push({ kind: 'added', path: `${path}.${k}`.replace(/^\./, ''), after: preview(co[k]) });
    }
    return;
  }
  if (bt === 'array') {
    const ba = base as unknown[];
    const ca = curr as unknown[];
    if (ba.length !== ca.length) out.push({ kind: 'value-changed', path: `${path}[]`.replace(/^\./, ''), before: `${ba.length} items`, after: `${ca.length} items` });
    if (ba.length && ca.length) diffValue(ba[0], ca[0], `${path}[0]`.replace(/^\./, ''), key, out); // shape of the first element
    return;
  }
  // primitive leaf
  if (base === curr) return;
  if (VOLATILE_KEY.test(key) || (typeof base === 'string' && VOLATILE_VALUE.test(base))) return; // expected to vary
  out.push({ kind: 'value-changed', path: path || '(root)', before: preview(base), after: preview(curr) });
}

export function normalizeBaselineInput(raw: unknown): BaselineEndpointInput[] {
  if (!Array.isArray(raw)) return [];
  const out: BaselineEndpointInput[] = [];
  for (const e of raw.slice(0, MAX_ENDPOINTS)) {
    if (!e || typeof e !== 'object') continue;
    const ep = e as Record<string, any>;
    const url = String(ep.url || '').trim();
    if (!/^https?:\/\//i.test(url)) continue;
    out.push({
      id: String(ep.id || url),
      title: ep.title ? String(ep.title) : undefined,
      method: String(ep.method || 'GET'),
      url,
      headers: Array.isArray(ep.headers) ? ep.headers.filter((h: any) => h?.key).map((h: any) => ({ key: String(h.key), value: String(h.value ?? '') })) : [],
      auth: ep.auth && typeof ep.auth === 'object'
        ? { type: (['none', 'bearer', 'basic', 'apikey'].includes(ep.auth.type) ? ep.auth.type : 'none'), value: ep.auth.value ? String(ep.auth.value) : undefined, headerName: ep.auth.headerName ? String(ep.auth.headerName) : undefined }
        : undefined,
      body: ep.body ? String(ep.body) : undefined,
    });
  }
  return out;
}

function rowToRecord(row: any): BaselineRecord {
  return {
    id: String(row.id),
    sig: row.sig,
    method: row.method,
    url: row.url,
    title: row.title || `${row.method} ${row.url}`,
    status: row.status ?? undefined,
    contentType: row.content_type || undefined,
    capturedBy: row.captured_by || undefined,
    capturedAt: row.captured_at,
    updatedAt: row.updated_at,
  };
}

/** List stored baselines (metadata only — bodies stay server-side). */
export async function listBaselines(tenantId: string): Promise<BaselineRecord[]> {
  const { rows } = await pool.query(
    `SELECT id, sig, method, url, title, status, content_type, captured_by, captured_at, updated_at
       FROM api_response_baselines WHERE tenant_id = $1 ORDER BY updated_at DESC`,
    [tenantId],
  );
  return rows.map(rowToRecord);
}

export async function deleteBaseline(tenantId: string, id: string): Promise<boolean> {
  const { rowCount } = await pool.query(`DELETE FROM api_response_baselines WHERE tenant_id = $1 AND id = $2`, [tenantId, id]);
  return rowCount > 0;
}

export interface CaptureReport { captured: number; skipped: number; total: number; baselines: BaselineRecord[] }

/** Probe each endpoint once and store (overwriting) its response as the baseline. */
export async function captureBaselines(tenantId: string, capturedBy: string, rawEndpoints: unknown): Promise<CaptureReport> {
  const endpoints = normalizeBaselineInput(rawEndpoints);
  let captured = 0;
  let skipped = 0;
  let next = 0;
  async function worker(): Promise<void> {
    while (next < endpoints.length) {
      const ep = endpoints[next++]!;
      const probe = await probeEndpoint(toRequest(ep));
      if (!probe.reachable) { skipped++; continue; }
      const sig = sigOf(ep.method, ep.url);
      const contentType = probe.headers?.['content-type']?.slice(0, 200) || null;
      // Store the JSON body when we have it (canonical), else the raw text.
      const bodyStore = probe.json !== undefined
        ? JSON.stringify(probe.json).slice(0, BODY_STORE_LIMIT)
        : (probe.bodyText || '').slice(0, BODY_STORE_LIMIT);
      await pool.query(`DELETE FROM api_response_baselines WHERE tenant_id = $1 AND sig = $2`, [tenantId, sig]);
      await pool.query(
        `INSERT INTO api_response_baselines (tenant_id, sig, method, url, title, status, content_type, body, captured_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [tenantId, sig, (ep.method || 'GET').toUpperCase(), ep.url, (ep.title || `${ep.method} ${ep.url}`).slice(0, 300), probe.status ?? null, contentType, bodyStore, capturedBy],
      );
      captured++;
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, endpoints.length) }, worker));
  return { captured, skipped, total: endpoints.length, baselines: await listBaselines(tenantId) };
}

/** Probe each endpoint that has a baseline and diff the fresh response against it. */
export async function compareBaselines(tenantId: string, rawEndpoints: unknown): Promise<CompareReport> {
  const endpoints = normalizeBaselineInput(rawEndpoints);
  const stored = await pool.query(
    `SELECT sig, status, content_type, body FROM api_response_baselines WHERE tenant_id = $1`,
    [tenantId],
  );
  const bySig = new Map<string, { status?: number; contentType?: string; body: string }>();
  for (const r of stored.rows as any[]) bySig.set(r.sig, { status: r.status ?? undefined, contentType: r.content_type || undefined, body: r.body || '' });

  const results: CompareResult[] = new Array(endpoints.length);
  let next = 0;
  async function worker(): Promise<void> {
    while (next < endpoints.length) {
      const i = next++;
      const ep = endpoints[i]!;
      const base = bySig.get(sigOf(ep.method, ep.url));
      if (!base) {
        results[i] = { id: ep.id, title: ep.title || `${ep.method} ${ep.url}`, method: (ep.method || 'GET').toUpperCase(), url: ep.url, hasBaseline: false, reachable: false, drift: [] };
        continue;
      }
      const probe = await probeEndpoint(toRequest(ep));
      const title = ep.title || `${ep.method} ${ep.url}`;
      const method = (ep.method || 'GET').toUpperCase();
      if (!probe.reachable) {
        results[i] = { id: ep.id, title, method, url: ep.url, hasBaseline: true, reachable: false, baselineStatus: base.status, drift: [{ kind: 'transport', path: '(request)', before: 'reachable', after: probe.transportError || 'unreachable' }] };
        continue;
      }
      const drift: DriftEntry[] = [];
      if (base.status !== undefined && probe.status !== base.status) {
        drift.push({ kind: 'status', path: '(status)', before: String(base.status), after: String(probe.status ?? '—') });
      }
      let baseJson: unknown;
      try { baseJson = JSON.parse(base.body); } catch { baseJson = undefined; }
      if (baseJson !== undefined) {
        if (probe.json === undefined) {
          drift.push({ kind: 'content', path: '(body)', before: 'JSON', after: probe.headers?.['content-type'] || 'non-JSON' });
        } else {
          diffValue(baseJson, probe.json, '', '(root)', drift);
        }
      }
      results[i] = { id: ep.id, title, method, url: ep.url, hasBaseline: true, reachable: true, status: probe.status, baselineStatus: base.status, drift };
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, endpoints.length) }, worker));

  const compared = results.filter((r) => r.hasBaseline && r.reachable).length;
  const drifted = results.filter((r) => r.hasBaseline && r.reachable && r.drift.length > 0).length;
  const unchanged = results.filter((r) => r.hasBaseline && r.reachable && r.drift.length === 0).length;
  const unreachable = results.filter((r) => r.hasBaseline && !r.reachable).length;
  const noBaseline = results.filter((r) => !r.hasBaseline).length;
  return {
    results,
    summary: { total: results.length, compared, unchanged, drifted, unreachable, noBaseline },
  };
}
