/**
 * api-datadriven.service.ts
 * ─────────────────────────
 * Data-driven testing — run ONE endpoint against a table of input rows, a
 * standalone opt-in check that lives ALONGSIDE the generation → execute → heal
 * pipeline and never modifies it.
 *
 * Each row is a set of `{{placeholder}}` values (the same `{{name}}` convention
 * environments use) plus an optional per-row `expectedStatus`. For every row we
 * substitute the placeholders into the URL, headers and body, issue the request
 * once (reusing the healer's `probeEndpoint`), and record whether the response
 * met the row's expectation. Nothing is persisted and no generator/executor
 * code is touched — it is a pure parameterised replay of one live endpoint.
 */
import { probeEndpoint, type ParsedApiRequest } from '../agents/apiHealingAgent.js';
import { fillTemplate } from './api-environments.service.js';

export interface DataDrivenEndpoint {
  title?: string;
  method: string;
  url: string;
  headers?: { key: string; value: string }[];
  auth?: { type: 'none' | 'bearer' | 'basic' | 'apikey'; value?: string; headerName?: string };
  body?: string;
  expectedStatus?: number;
}

export interface DataDrivenRowResult {
  index: number;
  values: Record<string, string>;
  url: string;
  reachable: boolean;
  status?: number;
  expectedStatus?: number;
  elapsedMs?: number;
  pass: boolean;
  error?: string;
}

export interface DataDrivenReport {
  method: string;
  title: string;
  results: DataDrivenRowResult[];
  summary: { total: number; passed: number; failed: number; unreachable: number; avgMs: number };
}

const MAX_ROWS = 200;
const CONCURRENCY = 6;
/** A row key reserved for the per-row expected status; not treated as a placeholder. */
const STATUS_KEYS = ['expectedStatus', '_status', '_expectedStatus'];

function toRow(raw: unknown): { values: Record<string, string>; expectedStatus?: number } | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const values: Record<string, string> = {};
  let expectedStatus: number | undefined;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    const key = String(k).trim();
    if (!key) continue;
    if (STATUS_KEYS.includes(key)) {
      const n = Number(v);
      if (Number.isInteger(n) && n >= 100 && n < 600) expectedStatus = n;
      continue;
    }
    values[key.slice(0, 80)] = v === null || v === undefined ? '' : String(v).slice(0, 4000);
  }
  return { values, expectedStatus };
}

export function normalizeRows(raw: unknown): { values: Record<string, string>; expectedStatus?: number }[] {
  if (!Array.isArray(raw)) return [];
  const out: { values: Record<string, string>; expectedStatus?: number }[] = [];
  for (const r of raw.slice(0, MAX_ROWS)) {
    const row = toRow(r);
    if (row) out.push(row);
  }
  return out;
}

function normalizeEndpoint(raw: unknown): DataDrivenEndpoint | null {
  if (!raw || typeof raw !== 'object') return null;
  const ep = raw as Record<string, any>;
  const url = String(ep.url || '').trim();
  if (!url) return null;
  return {
    title: ep.title ? String(ep.title) : undefined,
    method: String(ep.method || 'GET'),
    url,
    headers: Array.isArray(ep.headers) ? ep.headers.filter((h: any) => h?.key).map((h: any) => ({ key: String(h.key), value: String(h.value ?? '') })) : [],
    auth: ep.auth && typeof ep.auth === 'object'
      ? { type: (['none', 'bearer', 'basic', 'apikey'].includes(ep.auth.type) ? ep.auth.type : 'none'), value: ep.auth.value ? String(ep.auth.value) : undefined, headerName: ep.auth.headerName ? String(ep.auth.headerName) : undefined }
      : undefined,
    body: ep.body ? String(ep.body) : undefined,
    expectedStatus: typeof ep.expectedStatus === 'number' ? ep.expectedStatus : undefined,
  };
}

/** Build the live request for one row, substituting placeholders and folding auth in. */
function toRequest(ep: DataDrivenEndpoint, vars: Record<string, string>): ParsedApiRequest {
  const headers: Record<string, string> = {};
  for (const h of ep.headers || []) { if (h?.key) headers[fillTemplate(h.key, vars) || h.key] = fillTemplate(h.value, vars) ?? ''; }
  const a = ep.auth;
  if (a && a.type !== 'none' && a.value) {
    const value = fillTemplate(a.value, vars) || a.value;
    if (a.type === 'bearer') headers['Authorization'] = `Bearer ${value}`;
    else if (a.type === 'basic') headers['Authorization'] = `Basic ${Buffer.from(value).toString('base64')}`;
    else if (a.type === 'apikey') headers[a.headerName || 'X-API-Key'] = value;
  }
  const method = (ep.method || 'GET').toUpperCase();
  const url = fillTemplate(ep.url, vars) || ep.url;
  const body = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method) && ep.body ? fillTemplate(ep.body, vars) : undefined;
  if (body && !Object.keys(headers).some((k) => k.toLowerCase() === 'content-type')) headers['Content-Type'] = 'application/json';
  return { method, url, headers, body };
}

export async function runDataDriven(rawEndpoint: unknown, rawRows: unknown): Promise<DataDrivenReport> {
  const parsed = normalizeEndpoint(rawEndpoint);
  if (!parsed) throw new Error('Select an endpoint to run the dataset against.');
  const ep: DataDrivenEndpoint = parsed;
  const rows = normalizeRows(rawRows);
  if (rows.length === 0) throw new Error('Add at least one data row.');

  const method = (ep.method || 'GET').toUpperCase();
  const results: DataDrivenRowResult[] = new Array(rows.length);
  let next = 0;
  async function worker(): Promise<void> {
    while (next < rows.length) {
      const i = next++;
      const row = rows[i]!;
      const req = toRequest(ep, row.values);
      const expected = row.expectedStatus ?? ep.expectedStatus;
      const probe = await probeEndpoint(req);
      if (!probe.reachable) {
        results[i] = { index: i, values: row.values, url: req.url, reachable: false, expectedStatus: expected, pass: false, error: probe.transportError || 'The endpoint could not be reached.' };
        continue;
      }
      const pass = expected !== undefined
        ? probe.status === expected
        : probe.status !== undefined && probe.status >= 200 && probe.status < 300;
      results[i] = { index: i, values: row.values, url: req.url, reachable: true, status: probe.status, expectedStatus: expected, elapsedMs: probe.elapsedMs, pass };
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, rows.length) }, worker));

  const passed = results.filter((r) => r.pass).length;
  const unreachable = results.filter((r) => !r.reachable).length;
  const timed = results.filter((r) => typeof r.elapsedMs === 'number');
  const avgMs = timed.length ? Math.round(timed.reduce((a, r) => a + (r.elapsedMs || 0), 0) / timed.length) : 0;
  return {
    method,
    title: ep.title || `${method} ${ep.url}`,
    results,
    summary: { total: results.length, passed, failed: results.length - passed, unreachable, avgMs },
  };
}
