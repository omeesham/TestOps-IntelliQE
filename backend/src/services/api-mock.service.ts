/**
 * api-mock.service.ts
 * ───────────────────
 * Hosted mock server / service virtualization — an opt-in, standalone feature
 * that lives ALONGSIDE the generation → execute → heal pipeline and never
 * touches it.
 *
 * You "publish" a set of endpoints (from the catalogue) as a mock. Each mock
 * gets an unguessable public id and is served back as a live stub at
 *   /mock/:mockId/<path>
 * returning the stored example status + body. A system-under-test can point at
 * that URL when the real dependency is unavailable (contract-first dev, offline
 * CI, flaky upstream). Deleting the mock revokes the URL.
 *
 * Serving is public (no IntelliQE login — the SUT can't send one); the
 * unguessable mock id is the capability. Management (create/list/delete) is
 * tenant-authenticated like every other route.
 */
import { randomBytes } from 'node:crypto';
import pool from '../db.js';

export interface MockEndpointInput {
  method?: string;
  url?: string;
  path?: string;
  expectedStatus?: number;
  status?: number;
  expectedResponse?: string;
  body?: string;
  contentType?: string;
}

/** A stored, normalised mock route. */
interface MockRoute {
  method: string;
  path: string;        // pathname only, leading slash, no query
  segs: string[];      // split path for matching
  status: number;
  contentType: string;
  body: string;
}

export interface MockServer {
  id: string;
  mockId: string;
  name: string;
  enabled: boolean;
  hitCount: number;
  routeCount: number;
  routes: { method: string; path: string; status: number }[];
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

const MAX_ROUTES = 500;
const BODY_LIMIT = 200_000;

function looksJson(s: string): boolean {
  const t = s.trim();
  return (t.startsWith('{') && t.endsWith('}')) || (t.startsWith('[') && t.endsWith(']'));
}

function pathFrom(e: MockEndpointInput): string {
  if (e.path && e.path.trim()) {
    const p = e.path.trim();
    return ('/' + p.replace(/^\/+/, '')).replace(/\/+$/, '') || '/';
  }
  try {
    const u = new URL(String(e.url || ''));
    return u.pathname.replace(/\/+$/, '') || '/';
  } catch { return '/'; }
}

/** Build the normalised, stored route list from catalogue-shaped endpoints. */
export function buildRoutes(raw: unknown): MockRoute[] {
  const list = Array.isArray(raw) ? raw : [];
  const out: MockRoute[] = [];
  const seen = new Set<string>();
  for (const e of list.slice(0, MAX_ROUTES) as MockEndpointInput[]) {
    if (!e || typeof e !== 'object') continue;
    const method = String(e.method || 'GET').toUpperCase().replace(/[^A-Z]/g, '') || 'GET';
    const path = pathFrom(e);
    const key = `${method} ${path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const status = Number(e.status ?? e.expectedStatus) || 200;
    const rawBody = (e.body ?? e.expectedResponse ?? '').toString().slice(0, BODY_LIMIT);
    const body = rawBody || JSON.stringify({ mock: true, method, path }, null, 2);
    const contentType = e.contentType || (looksJson(body) ? 'application/json' : 'text/plain');
    out.push({ method, path, segs: path.split('/').filter(Boolean), status, contentType, body });
  }
  return out;
}

function mapMock(r: any): MockServer {
  let routes: MockRoute[] = [];
  try { routes = JSON.parse(r.endpoints || '[]'); } catch { /* ignore */ }
  return {
    id: String(r.id),
    mockId: r.mock_id,
    name: r.name || 'Mock',
    enabled: !!r.enabled,
    hitCount: Number(r.hit_count) || 0,
    routeCount: routes.length,
    routes: routes.slice(0, 200).map((rt) => ({ method: rt.method, path: rt.path, status: rt.status })),
    createdBy: r.created_by || '',
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/* ────────────────────────────────────────────────────────────────
   Management (tenant-authenticated)
   ──────────────────────────────────────────────────────────────── */

export async function listMocks(tenantId: string): Promise<MockServer[]> {
  const { rows } = await pool.query(`SELECT * FROM api_mocks WHERE tenant_id = $1 ORDER BY updated_at DESC`, [tenantId]);
  return rows.map(mapMock);
}

export async function createMock(tenantId: string, username: string, input: { name?: unknown; endpoints?: unknown }): Promise<MockServer> {
  const routes = buildRoutes(input.endpoints);
  if (!routes.length) throw new Error('Select at least one endpoint to publish as a mock.');
  const name = String(input.name || '').trim().slice(0, 200) || `Mock (${routes.length} route${routes.length === 1 ? '' : 's'})`;
  const mockId = randomBytes(16).toString('hex');
  const { rows } = await pool.query(
    `INSERT INTO api_mocks (tenant_id, mock_id, name, endpoints, created_by)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [tenantId, mockId, name, JSON.stringify(routes), username || ''],
  );
  return mapMock(rows[0]);
}

export async function setMockEnabled(tenantId: string, id: string, enabled: boolean): Promise<MockServer | null> {
  const { rowCount } = await pool.query(
    `UPDATE api_mocks SET enabled = $3, updated_at = SYSUTCDATETIME() WHERE tenant_id = $1 AND id = $2`,
    [tenantId, id, enabled ? 1 : 0],
  );
  if (!rowCount) return null;
  const { rows } = await pool.query(`SELECT * FROM api_mocks WHERE tenant_id = $1 AND id = $2`, [tenantId, id]);
  return rows.length ? mapMock(rows[0]) : null;
}

export async function deleteMock(tenantId: string, id: string): Promise<boolean> {
  const { rowCount } = await pool.query(`DELETE FROM api_mocks WHERE tenant_id = $1 AND id = $2`, [tenantId, id]);
  return rowCount > 0;
}

/* ────────────────────────────────────────────────────────────────
   Serving (PUBLIC — matched by the unguessable mock id only)
   ──────────────────────────────────────────────────────────────── */

/** A stored path matches the request path if the segment counts agree and each
 *  segment is equal — or is a template/param or an id-shaped value on either
 *  side (so /users/42 matches a stored /users/123 or /users/:id). */
function segMatches(stored: string, req: string): boolean {
  if (stored === req) return true;
  if (/^[:{]/.test(stored) || /^[:{]/.test(req)) return true;
  const idish = /^(?:\d+|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{16,})$/i;
  return idish.test(stored) && idish.test(req);
}

export interface MockHit { status: number; contentType: string; body: string }

/** Resolve a public mock request. Returns null when the mock/route is unknown
 *  or the mock is disabled. Increments the hit counter on a match. */
export async function serveMock(mockId: string, method: string, rawPath: string): Promise<MockHit | { notFound: true; routes: string[] } | null> {
  if (!/^[0-9a-f]{8,64}$/i.test(mockId)) return null;
  const { rows } = await pool.query(`SELECT id, endpoints, enabled FROM api_mocks WHERE mock_id = $1`, [mockId]);
  if (!rows.length || !rows[0].enabled) return null;
  let routes: MockRoute[] = [];
  try { routes = JSON.parse(rows[0].endpoints || '[]'); } catch { /* ignore */ }

  const path = ('/' + String(rawPath || '').split('?')[0].replace(/^\/+/, '')).replace(/\/+$/, '') || '/';
  const reqSegs = path.split('/').filter(Boolean);
  const m = method.toUpperCase();

  // Exact first, then template/id-shaped match.
  let match = routes.find((r) => r.method === m && r.path === path);
  if (!match) {
    match = routes.find((r) => r.method === m && r.segs.length === reqSegs.length && r.segs.every((s, i) => segMatches(s, reqSegs[i]!)));
  }
  if (!match) {
    return { notFound: true, routes: routes.filter((r) => r.method === m).slice(0, 20).map((r) => `${r.method} ${r.path}`) };
  }
  void pool.query(`UPDATE api_mocks SET hit_count = hit_count + 1 WHERE mock_id = $1`, [mockId]).catch(() => {});
  return { status: match.status, contentType: match.contentType, body: match.body };
}
