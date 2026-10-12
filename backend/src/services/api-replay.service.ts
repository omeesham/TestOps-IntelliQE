/**
 * api-replay.service.ts
 * ─────────────────────
 * Deterministic record-and-replay — capture a request's real response once, then
 * replay it later and assert the response is byte-for-byte equivalent EXCEPT for
 * fields that are legitimately non-deterministic ("noise": timestamps, generated
 * ids, tokens). Unlike the LLM pipeline this costs ZERO model tokens per run, so
 * it is the cheap, flake-free regression check for CI re-runs.
 *
 * Noise is learned automatically: each endpoint is sampled TWICE at record time
 * and any leaf whose value differs between the two samples is marked noise and
 * excluded from the replay diff. Callers may also attach captured downstream
 * dependency stubs (`deps`) alongside a recording so a replay can be pointed at
 * mocks instead of live dependencies.
 *
 * One recording per endpoint signature (method + url); re-recording overwrites.
 * Standalone and opt-in — it never touches the generate → execute → heal pipeline.
 */
import pool from '../db.js';
import { fetchFull, buildHeaders, isWriteMethod, type HttpEndpoint } from '../utils/api-http.js';

export interface ReplayEndpointInput extends HttpEndpoint {
  id: string;
  title?: string;
  /** Optional caller-supplied downstream dependency stubs to store with the recording. */
  deps?: unknown[];
}

export interface ReplayRecord {
  id: string;
  sig: string;
  method: string;
  url: string;
  title: string;
  status?: number;
  contentType?: string;
  noisePaths: string[];
  deps: unknown[];
  capturedBy?: string;
  capturedAt: string;
  updatedAt: string;
}

export type DriftKind = 'status' | 'added' | 'removed' | 'type-changed' | 'value-changed' | 'transport' | 'content';
export interface DriftEntry { kind: DriftKind; path: string; before?: string; after?: string }

export interface ReplayResult {
  id: string;
  title: string;
  method: string;
  url: string;
  hasRecording: boolean;
  reachable: boolean;
  status?: number;
  recordedStatus?: number;
  match: boolean;
  drift: DriftEntry[];
  noiseIgnored: number;
}

export interface ReplayReport {
  results: ReplayResult[];
  summary: { total: number; replayed: number; matched: number; drifted: number; unreachable: number; noRecording: number };
}

const MAX_ENDPOINTS = 100;
const CONCURRENCY = 5;
const BODY_STORE_LIMIT = 200_000;
const MAX_DRIFT = 60;

function sigOf(method: string, url: string): string { return `${(method || 'GET').toUpperCase()} ${url}`; }

function toInit(ep: ReplayEndpointInput): { url: string; init: RequestInit } {
  const headers = buildHeaders(ep);
  const method = (ep.method || 'GET').toUpperCase();
  const body = isWriteMethod(method) && ep.body ? ep.body : undefined;
  if (body && !Object.keys(headers).some((k) => k.toLowerCase() === 'content-type')) headers['Content-Type'] = 'application/json';
  return { url: ep.url, init: { method, headers, body } };
}

function parseJson(text: string): unknown {
  try { return JSON.parse(text); } catch { return undefined; }
}

/** Flatten a JSON tree to leaf paths → JSON-stringified value. Arrays indexed [i]. */
function collectLeaves(v: unknown, prefix: string, out: Map<string, string>, depth = 0): void {
  if (depth > 40 || out.size > 4000) return;
  if (v === null || typeof v !== 'object') { out.set(prefix || '(root)', JSON.stringify(v)); return; }
  if (Array.isArray(v)) {
    out.set(`${prefix}[]#`, String(v.length)); // length is itself a comparable leaf
    v.forEach((el, i) => collectLeaves(el, `${prefix}[${i}]`, out, depth + 1));
    return;
  }
  const o = v as Record<string, unknown>;
  for (const k of Object.keys(o)) collectLeaves(o[k], prefix ? `${prefix}.${k}` : k, out, depth + 1);
}

/** Leaf paths whose value differs between two samples = non-deterministic noise. */
function noiseBetween(a: unknown, b: unknown): string[] {
  const ma = new Map<string, string>(); const mb = new Map<string, string>();
  collectLeaves(a, '', ma); collectLeaves(b, '', mb);
  const noise = new Set<string>();
  for (const [k, va] of ma) { const vb = mb.get(k); if (vb !== undefined && vb !== va) noise.add(k); }
  return [...noise];
}

/** Diff a fresh response against the recorded one, excluding known noise paths. */
function diffRecorded(recorded: unknown, fresh: unknown, noise: Set<string>): DriftEntry[] {
  const mr = new Map<string, string>(); const mf = new Map<string, string>();
  collectLeaves(recorded, '', mr); collectLeaves(fresh, '', mf);
  const out: DriftEntry[] = [];
  for (const [k, rv] of mr) {
    if (out.length >= MAX_DRIFT) break;
    if (noise.has(k)) continue;
    if (!mf.has(k)) { out.push({ kind: 'removed', path: k, before: rv.slice(0, 80) }); continue; }
    const fv = mf.get(k)!;
    if (fv !== rv) out.push({ kind: 'value-changed', path: k, before: rv.slice(0, 80), after: fv.slice(0, 80) });
  }
  for (const [k, fv] of mf) {
    if (out.length >= MAX_DRIFT) break;
    if (noise.has(k)) continue;
    if (!mr.has(k)) out.push({ kind: 'added', path: k, after: fv.slice(0, 80) });
  }
  return out;
}

export function normalizeReplayInput(raw: unknown): ReplayEndpointInput[] {
  if (!Array.isArray(raw)) return [];
  const out: ReplayEndpointInput[] = [];
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
      auth: ep.auth && typeof ep.auth === 'object' ? { type: String(ep.auth.type || 'none'), value: ep.auth.value ? String(ep.auth.value) : undefined, headerName: ep.auth.headerName ? String(ep.auth.headerName) : undefined } : undefined,
      body: ep.body ? String(ep.body) : undefined,
      deps: Array.isArray(ep.deps) ? ep.deps.slice(0, 100) : undefined,
    });
  }
  return out;
}

// db.ts only JSON-parses allowlisted columns on read; noise_paths/deps aren't on it, so coerce here.
function jArr(v: any): any[] {
  if (Array.isArray(v)) return v;
  if (typeof v === 'string' && v.trim().startsWith('[')) { try { const p = JSON.parse(v); if (Array.isArray(p)) return p; } catch { /* empty */ } }
  return [];
}

function rowToRecord(row: any): ReplayRecord {
  return {
    id: String(row.id),
    sig: row.sig,
    method: row.method,
    url: row.url,
    title: row.title || `${row.method} ${row.url}`,
    status: row.status ?? undefined,
    contentType: row.content_type || undefined,
    noisePaths: jArr(row.noise_paths).map(String),
    deps: jArr(row.deps),
    capturedBy: row.captured_by || undefined,
    capturedAt: row.captured_at,
    updatedAt: row.updated_at,
  };
}

export async function listReplays(tenantId: string): Promise<ReplayRecord[]> {
  const { rows } = await pool.query(
    `SELECT id, sig, method, url, title, status, content_type, noise_paths, deps, captured_by, captured_at, updated_at
       FROM api_replay_recordings WHERE tenant_id = $1 ORDER BY updated_at DESC`,
    [tenantId],
  );
  return rows.map(rowToRecord);
}

export async function deleteReplay(tenantId: string, id: string): Promise<boolean> {
  const { rowCount } = await pool.query(`DELETE FROM api_replay_recordings WHERE tenant_id = $1 AND id = $2`, [tenantId, id]);
  return rowCount > 0;
}

export interface RecordReport { recorded: number; skipped: number; total: number; recordings: ReplayRecord[] }

/** Sample each endpoint twice, learn its noise, and store (overwriting) the recording. */
export async function recordReplays(tenantId: string, capturedBy: string, rawEndpoints: unknown): Promise<RecordReport> {
  const endpoints = normalizeReplayInput(rawEndpoints);
  let recorded = 0; let skipped = 0; let next = 0;
  async function worker(): Promise<void> {
    while (next < endpoints.length) {
      const ep = endpoints[next++]!;
      const { url, init } = toInit(ep);
      const a = await fetchFull(url, init, 20_000, BODY_STORE_LIMIT);
      if (a.error) { skipped++; continue; }
      const b = await fetchFull(url, init, 20_000, BODY_STORE_LIMIT);
      const aJson = parseJson(a.bodyText);
      const bJson = b.error ? undefined : parseJson(b.bodyText);
      const noise = (aJson !== undefined && bJson !== undefined) ? noiseBetween(aJson, bJson) : [];
      const sig = sigOf(ep.method, ep.url);
      const contentType = a.headers['content-type']?.slice(0, 200) || null;
      const bodyStore = (aJson !== undefined ? JSON.stringify(aJson) : a.bodyText).slice(0, BODY_STORE_LIMIT);
      await pool.query(`DELETE FROM api_replay_recordings WHERE tenant_id = $1 AND sig = $2`, [tenantId, sig]);
      await pool.query(
        `INSERT INTO api_replay_recordings (tenant_id, sig, method, url, title, status, content_type, body, noise_paths, deps, captured_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [tenantId, sig, (ep.method || 'GET').toUpperCase(), ep.url, (ep.title || `${ep.method} ${ep.url}`).slice(0, 300), a.status ?? null, contentType, bodyStore, noise, ep.deps || [], capturedBy],
      );
      recorded++;
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, endpoints.length) }, worker));
  return { recorded, skipped, total: endpoints.length, recordings: await listReplays(tenantId) };
}

/** Replay each endpoint that has a recording and diff the fresh response, ignoring learned noise. */
export async function replayAll(tenantId: string, rawEndpoints: unknown): Promise<ReplayReport> {
  const endpoints = normalizeReplayInput(rawEndpoints);
  const stored = await pool.query(
    `SELECT sig, status, body, noise_paths FROM api_replay_recordings WHERE tenant_id = $1`,
    [tenantId],
  );
  const bySig = new Map<string, { status?: number; body: string; noise: Set<string> }>();
  for (const r of stored.rows as any[]) bySig.set(r.sig, { status: r.status ?? undefined, body: r.body || '', noise: new Set(jArr(r.noise_paths).map(String)) });

  const results: ReplayResult[] = new Array(endpoints.length);
  let next = 0;
  async function worker(): Promise<void> {
    while (next < endpoints.length) {
      const i = next++;
      const ep = endpoints[i]!;
      const rec = bySig.get(sigOf(ep.method, ep.url));
      const title = ep.title || `${ep.method} ${ep.url}`;
      const method = (ep.method || 'GET').toUpperCase();
      if (!rec) { results[i] = { id: ep.id, title, method, url: ep.url, hasRecording: false, reachable: false, match: false, drift: [], noiseIgnored: 0 }; continue; }
      const { url, init } = toInit(ep);
      const fresh = await fetchFull(url, init, 20_000, BODY_STORE_LIMIT);
      if (fresh.error) {
        results[i] = { id: ep.id, title, method, url: ep.url, hasRecording: true, reachable: false, recordedStatus: rec.status, match: false, drift: [{ kind: 'transport', path: '(request)', before: 'reachable', after: fresh.error }], noiseIgnored: rec.noise.size };
        continue;
      }
      const drift: DriftEntry[] = [];
      if (rec.status !== undefined && fresh.status !== rec.status) drift.push({ kind: 'status', path: '(status)', before: String(rec.status), after: String(fresh.status ?? '—') });
      const recJson = parseJson(rec.body);
      const freshJson = parseJson(fresh.bodyText);
      if (recJson !== undefined) {
        if (freshJson === undefined) drift.push({ kind: 'content', path: '(body)', before: 'JSON', after: fresh.headers['content-type'] || 'non-JSON' });
        else drift.push(...diffRecorded(recJson, freshJson, rec.noise));
      }
      results[i] = { id: ep.id, title, method, url: ep.url, hasRecording: true, reachable: true, status: fresh.status, recordedStatus: rec.status, match: drift.length === 0, drift, noiseIgnored: rec.noise.size };
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, endpoints.length) }, worker));

  const replayed = results.filter((r) => r.hasRecording && r.reachable).length;
  const matched = results.filter((r) => r.hasRecording && r.reachable && r.match).length;
  const drifted = results.filter((r) => r.hasRecording && r.reachable && !r.match).length;
  const unreachable = results.filter((r) => r.hasRecording && !r.reachable).length;
  const noRecording = results.filter((r) => !r.hasRecording).length;
  return { results, summary: { total: results.length, replayed, matched, drifted, unreachable, noRecording } };
}
