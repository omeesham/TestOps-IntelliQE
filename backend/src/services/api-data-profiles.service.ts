/**
 * api-data-profiles.service.ts
 * ────────────────────────────
 * Reusable Test Data Profiles — saved, named datasets (columns + rows) that
 * data-driven runs reuse instead of pasting rows ad-hoc each time (Testsigma
 * "Test Data Profiles" parity). Rows can be authored inline, imported from CSV
 * or Excel (.xlsx via the bundled `xlsx`), or pulled from a read-only DB query
 * (reuses api-db-validate's strictly-read-only runner). A profile can also be
 * run over a saved multi-step FLOW — one flow run per row — which closes the
 * "data-driven only replays a single endpoint" gap.
 *
 * Standalone and opt-in: its own table, never read by the generate → execute →
 * heal pipeline.
 */
import * as XLSX from 'xlsx';
import pool from '../db.js';
import { runDbValidation, type DbConnConfig } from './api-db-validate.service.js';
import { runFlow, type FlowStep } from './api-flow.service.js';

const MAX_ROWS = 2000;
const MAX_COLS = 60;

export interface DataProfile {
  id: string;
  name: string;
  columns: string[];
  rows: Record<string, string>[];
  rowCount: number;
  source: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

function toStrVal(v: unknown): string {
  if (v == null) return '';
  return typeof v === 'string' ? v : (typeof v === 'object' ? JSON.stringify(v) : String(v));
}

/** Normalize a loose {columns?, rows[]} into a clean, capped column list + string rows. */
export function normalizeTable(rawColumns: unknown, rawRows: unknown): { columns: string[]; rows: Record<string, string>[] } {
  const rowsIn = Array.isArray(rawRows) ? rawRows.slice(0, MAX_ROWS) : [];
  const colSet: string[] = [];
  const addCol = (c: string) => { if (c && !colSet.includes(c) && colSet.length < MAX_COLS) colSet.push(c); };
  for (const c of Array.isArray(rawColumns) ? rawColumns : []) addCol(String(c).slice(0, 120));
  for (const r of rowsIn) { if (r && typeof r === 'object') for (const k of Object.keys(r)) addCol(k.slice(0, 120)); }
  const rows = rowsIn
    .filter((r) => r && typeof r === 'object')
    .map((r) => {
      const out: Record<string, string> = {};
      for (const c of colSet) out[c] = toStrVal((r as Record<string, unknown>)[c]);
      return out;
    });
  return { columns: colSet, rows };
}

/** Minimal RFC-4180-ish CSV parser (quoted fields, escaped quotes, CRLF). */
export function parseCsv(text: string): { columns: string[]; rows: Record<string, string>[] } {
  const src = String(text || '').replace(/^﻿/, '');
  const records: string[][] = [];
  let field = '';
  let row: string[] = [];
  let inQuotes = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!;
    if (inQuotes) {
      if (ch === '"') { if (src[i + 1] === '"') { field += '"'; i++; } else inQuotes = false; }
      else field += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n') { row.push(field); records.push(row); row = []; field = ''; }
    else if (ch === '\r') { /* swallow, \n handles the break */ }
    else field += ch;
  }
  if (field.length || row.length) { row.push(field); records.push(row); }
  const nonEmpty = records.filter((r) => r.some((c) => c.trim() !== ''));
  if (!nonEmpty.length) return { columns: [], rows: [] };
  const header = nonEmpty[0]!.map((h, i) => (h.trim() || `col${i + 1}`));
  const rows = nonEmpty.slice(1).map((r) => {
    const o: Record<string, unknown> = {};
    header.forEach((h, i) => { o[h] = r[i] ?? ''; });
    return o;
  });
  return normalizeTable(header, rows);
}

/** Parse the first sheet of an .xlsx/.xls workbook (base64) into columns + rows. */
export function parseExcel(base64: string): { columns: string[]; rows: Record<string, string>[] } {
  const wb = XLSX.read(Buffer.from(String(base64 || ''), 'base64'), { type: 'buffer' });
  const first = wb.SheetNames[0];
  if (!first) return { columns: [], rows: [] };
  const sheet = wb.Sheets[first]!;
  const aoa = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, blankrows: false });
  if (!aoa.length) return { columns: [], rows: [] };
  const header = (aoa[0] as unknown[]).map((h, i) => (toStrVal(h).trim() || `col${i + 1}`));
  const rows = aoa.slice(1).map((r) => {
    const arr = r as unknown[];
    const o: Record<string, unknown> = {};
    header.forEach((h, i) => { o[h] = arr[i] ?? ''; });
    return o;
  });
  return normalizeTable(header, rows);
}

/** Build a table from a read-only DB query (reuses the strictly-read-only validator). */
export async function profileFromDb(tenantId: string, input: { connectionId?: string; config?: DbConnConfig; query: string }): Promise<{ columns: string[]; rows: Record<string, string>[] }> {
  const res = await runDbValidation(tenantId, { connectionId: input.connectionId, config: input.config, query: input.query });
  return normalizeTable(res.rows.length ? Object.keys(res.rows[0]!) : [], res.rows);
}

/**
 * Derive the CSV-export URL for a Google Sheet from a share/edit/publish URL.
 * PURE + testable. Supports the three common shapes:
 *   - /spreadsheets/d/<ID>/edit…        → /spreadsheets/d/<ID>/export?format=csv[&gid=]
 *   - /spreadsheets/d/e/<PUBID>/pub…     → /spreadsheets/d/e/<PUBID>/pub?output=csv[&gid=]
 *   - an already-CSV export/pub URL      → returned as-is
 * Throws for anything that isn't a docs.google.com spreadsheet URL. The sheet
 * must be shared ("anyone with the link") or published — there is no auth here.
 */
export function googleSheetCsvUrl(raw: string): string {
  const url = String(raw || '').trim();
  let parsed: URL;
  try { parsed = new URL(url); } catch { throw new Error('Enter a valid Google Sheets URL.'); }
  if (!/(^|\.)docs\.google\.com$/i.test(parsed.hostname)) throw new Error('That is not a Google Sheets link (expected a docs.google.com URL).');
  // Already a CSV endpoint.
  if (/[?&](format|output)=csv/i.test(parsed.search)) return parsed.toString();
  // gid may live in the query or the #fragment.
  const gid = parsed.searchParams.get('gid') || (parsed.hash.match(/gid=(\d+)/)?.[1] ?? '');
  // Published-to-web form: /spreadsheets/d/e/<PUBID>/...
  const pub = parsed.pathname.match(/\/spreadsheets\/d\/e\/([^/]+)\//);
  if (pub) {
    const u = `https://docs.google.com/spreadsheets/d/e/${pub[1]}/pub?output=csv`;
    return gid ? `${u}&gid=${gid}` : u;
  }
  // Standard document id form: /spreadsheets/d/<ID>/...
  const doc = parsed.pathname.match(/\/spreadsheets\/d\/([^/]+)/);
  if (doc) {
    const u = `https://docs.google.com/spreadsheets/d/${doc[1]}/export?format=csv`;
    return gid ? `${u}&gid=${gid}` : u;
  }
  throw new Error('Could not find a spreadsheet id in that Google Sheets URL.');
}

/** Fetch a shared/published Google Sheet as CSV and parse it into columns + rows. */
export async function fetchGoogleSheet(rawUrl: string): Promise<{ columns: string[]; rows: Record<string, string>[] }> {
  const csvUrl = googleSheetCsvUrl(rawUrl);
  // Belt-and-braces SSRF guard: the derived URL is always docs.google.com, but verify.
  if (!/^https:\/\/docs\.google\.com\//i.test(csvUrl)) throw new Error('Refusing to fetch a non-Google-Sheets URL.');
  let res: Response;
  try {
    res = await fetch(csvUrl, { redirect: 'follow', signal: AbortSignal.timeout(20_000), headers: { accept: 'text/csv,*/*' } });
  } catch (e) {
    throw new Error(`Could not reach Google Sheets: ${(e as Error).message}`);
  }
  if (!res.ok) throw new Error(`Google Sheets returned ${res.status}. Make sure the sheet is shared "anyone with the link" or published to the web.`);
  const text = await res.text();
  const ctype = res.headers.get('content-type') || '';
  // A sign-in / permission page comes back as HTML, not CSV — detect and explain.
  if (/text\/html/i.test(ctype) || /^\s*<(!doctype|html)/i.test(text)) {
    throw new Error('That sheet is not publicly readable. In Google Sheets choose Share → "Anyone with the link", or File → Share → Publish to web, then paste the link again.');
  }
  return parseCsv(text);
}

/* ── CRUD ── */

function mapProfile(r: any): DataProfile {
  const columns = (() => { try { return typeof r.columns === 'string' ? JSON.parse(r.columns) : (r.columns || []); } catch { return []; } })();
  const rows = (() => { try { return typeof r.rows === 'string' ? JSON.parse(r.rows) : (r.rows || []); } catch { return []; } })();
  return {
    id: String(r.id),
    name: r.name || 'Data profile',
    columns: Array.isArray(columns) ? columns : [],
    rows: Array.isArray(rows) ? rows : [],
    rowCount: Array.isArray(rows) ? rows.length : 0,
    source: r.source || 'manual',
    createdBy: r.created_by || '',
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export async function listDataProfiles(tenantId: string): Promise<DataProfile[]> {
  const { rows } = await pool.query(`SELECT * FROM api_data_profiles WHERE tenant_id = $1 ORDER BY updated_at DESC`, [tenantId]);
  return rows.map(mapProfile);
}

export async function getDataProfile(tenantId: string, id: string): Promise<DataProfile | null> {
  const { rows } = await pool.query(`SELECT * FROM api_data_profiles WHERE tenant_id = $1 AND id = $2`, [tenantId, id]);
  return rows.length ? mapProfile(rows[0]) : null;
}

export async function saveDataProfile(tenantId: string, username: string, input: { id?: string; name?: unknown; columns?: unknown; rows?: unknown; source?: unknown }): Promise<DataProfile> {
  const name = String(input.name || '').trim().slice(0, 200) || 'Untitled profile';
  const { columns, rows } = normalizeTable(input.columns, input.rows);
  const source = String(input.source || 'manual').slice(0, 40);
  const colsJson = JSON.stringify(columns);
  const rowsJson = JSON.stringify(rows);
  if (input.id) {
    const { rows: up } = await pool.query(
      `UPDATE api_data_profiles SET name = $3, columns = $4, rows = $5, source = $6, updated_at = SYSUTCDATETIME()
       OUTPUT INSERTED.* WHERE tenant_id = $1 AND id = $2`,
      [tenantId, input.id, name, colsJson, rowsJson, source],
    );
    if (!up.length) throw new Error('Data profile not found.');
    return mapProfile(up[0]);
  }
  const { rows: ins } = await pool.query(
    `INSERT INTO api_data_profiles (tenant_id, name, columns, rows, source, created_by)
     OUTPUT INSERTED.* VALUES ($1, $2, $3, $4, $5, $6)`,
    [tenantId, name, colsJson, rowsJson, source, username || ''],
  );
  return mapProfile(ins[0]);
}

export async function deleteDataProfile(tenantId: string, id: string): Promise<boolean> {
  const { rowCount } = await pool.query(`DELETE FROM api_data_profiles WHERE tenant_id = $1 AND id = $2`, [tenantId, id]);
  return rowCount > 0;
}

/* ── Data-driven iteration over a multi-step flow (one flow run per row) ── */

export interface ProfileFlowRunResult {
  total: number;
  passed: number;
  failed: number;
  runs: { row: number; passed: boolean; stepsRun: number; stepsTotal: number; durationMs: number; firstError?: string }[];
}

/**
 * Resolve an optional 1-based inclusive row range against a row count. PURE.
 * Omitted bounds default to the first/last row; out-of-range values are clamped.
 * Returns 0-based [start, endExclusive).
 */
export function resolveRowRange(count: number, rowStart?: unknown, rowEnd?: unknown): [number, number] {
  const n = Math.max(0, count);
  const s = Number.isFinite(Number(rowStart)) && Number(rowStart) >= 1 ? Math.floor(Number(rowStart)) : 1;
  const e = Number.isFinite(Number(rowEnd)) && Number(rowEnd) >= 1 ? Math.floor(Number(rowEnd)) : n;
  const start = Math.min(n, s - 1);
  const end = Math.min(n, Math.max(start, e));
  return [start, end];
}

export async function runProfileOverFlow(input: { steps: FlowStep[]; rows: Record<string, string>[]; allowWrites?: boolean; maxRows?: number; rowStart?: number; rowEnd?: number }): Promise<ProfileFlowRunResult> {
  const steps = Array.isArray(input.steps) ? input.steps : [];
  if (!steps.length) throw new Error('Provide the flow steps to iterate.');
  const all = Array.isArray(input.rows) ? input.rows : [];
  // Row range (1-based, inclusive) selects a slice; the cap still bounds the run.
  const [start, end] = resolveRowRange(all.length, input.rowStart, input.rowEnd);
  const cap = Math.min(200, Math.max(1, input.maxRows || 100));
  const rows = all.slice(start, end).slice(0, cap);
  if (!rows.length) throw new Error(all.length ? 'The selected row range is empty.' : 'The profile has no rows to iterate.');
  const runs: ProfileFlowRunResult['runs'] = [];
  let passed = 0;
  for (let i = 0; i < rows.length; i++) {
    const row = start + i; // absolute 0-based index into the profile, so results name the real row
    try {
      const r = await runFlow({ steps, variables: rows[i], allowWrites: input.allowWrites });
      if (r.passed) passed++;
      const firstErr = r.steps.find((s) => s.error)?.error || r.steps.find((s) => !s.ok)?.checks.find((c) => !c.pass)?.label;
      runs.push({ row, passed: r.passed, stepsRun: r.stepsRun, stepsTotal: r.stepsTotal, durationMs: r.durationMs, firstError: r.passed ? undefined : firstErr });
    } catch (e) {
      runs.push({ row, passed: false, stepsRun: 0, stepsTotal: steps.length, durationMs: 0, firstError: (e as Error).message });
    }
  }
  return { total: rows.length, passed, failed: rows.length - passed, runs };
}
