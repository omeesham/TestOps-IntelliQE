/**
 * api-proxy.service.ts
 * ────────────────────
 * Contract-validating / simulating proxy — the Prism-proxy / Hoverfly slice the
 * static mock (api-mock) and stateful stub (api-virtual) don't cover. A system
 * points at a public /proxy/:token/* URL; in VALIDATE mode the proxy forwards
 * to the real target and checks each live response against the catalogue's
 * expected status + shape (recording violations); in SIMULATE mode it replies
 * from the stored examples without forwarding. Deleting the proxy revokes the URL.
 *
 * Management is tenant-authenticated; serving is public (the unguessable token
 * is the capability). Standalone, opt-in; no pipeline coupling.
 */
import { randomBytes } from 'node:crypto';
import pool from '../db.js';

export type ProxyMode = 'validate' | 'simulate';
interface ProxyRoute { method: string; path: string; segs: string[]; status: number; body: string; shape: string[] }
export interface ApiProxy { id: string; token: string; name: string; targetBase: string; mode: ProxyMode; enabled: boolean; hitCount: number; routeCount: number; createdBy: string; createdAt: string; updatedAt: string }
export interface ProxyEvent { at: string; method: string; path: string; upstreamStatus: number | null; ok: boolean; issues: string[] }

const BODY_LIMIT = 200_000;
function pathFrom(e: any): string { if (e?.path) return ('/' + String(e.path).replace(/^\/+/, '')).replace(/\/+$/, '') || '/'; try { return new URL(String(e?.url || '')).pathname.replace(/\/+$/, '') || '/'; } catch { return '/'; } }
function topKeys(body: string): string[] { try { const o = JSON.parse(body); return o && typeof o === 'object' && !Array.isArray(o) ? Object.keys(o).slice(0, 50) : []; } catch { return []; } }

function buildRoutes(raw: unknown): ProxyRoute[] {
  const list = Array.isArray(raw) ? raw : [];
  const out: ProxyRoute[] = [];
  for (const e of list.slice(0, 500) as any[]) {
    if (!e || typeof e !== 'object') continue;
    const method = String(e.method || 'GET').toUpperCase().replace(/[^A-Z]/g, '') || 'GET';
    const path = pathFrom(e);
    const status = Number(e.status ?? e.expectedStatus) || 200;
    const body = String(e.body ?? e.expectedResponse ?? '').slice(0, BODY_LIMIT);
    out.push({ method, path, segs: path.split('/').filter(Boolean), status, body, shape: topKeys(body) });
  }
  return out;
}
function mapProxy(r: any): ApiProxy {
  let routes: ProxyRoute[] = []; try { routes = JSON.parse(r.routes_json || '[]'); } catch { /* */ }
  return { id: String(r.id), token: r.token, name: r.name || 'Proxy', targetBase: r.target_base || '', mode: r.mode === 'simulate' ? 'simulate' : 'validate', enabled: !!r.enabled, hitCount: Number(r.hit_count) || 0, routeCount: routes.length, createdBy: r.created_by || '', createdAt: r.created_at, updatedAt: r.updated_at };
}

export async function listProxies(tenantId: string): Promise<ApiProxy[]> {
  const { rows } = await pool.query(`SELECT * FROM api_proxies WHERE tenant_id = $1 ORDER BY updated_at DESC`, [tenantId]);
  return rows.map(mapProxy);
}
export async function createProxy(tenantId: string, username: string, input: any): Promise<ApiProxy> {
  const targetBase = String(input?.targetBase || '').trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(targetBase)) throw new Error('Enter the real API base URL to proxy to (https://…).');
  const routes = buildRoutes(input?.endpoints);
  const mode: ProxyMode = input?.mode === 'simulate' ? 'simulate' : 'validate';
  if (mode === 'simulate' && !routes.length) throw new Error('Simulate mode needs at least one endpoint with a stored example.');
  const name = String(input?.name || '').trim().slice(0, 200) || `Proxy → ${targetBase}`;
  const token = randomBytes(16).toString('hex');
  const { rows } = await pool.query(`INSERT INTO api_proxies (tenant_id, token, name, target_base, mode, routes_json, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`, [tenantId, token, name, targetBase, mode, JSON.stringify(routes), username || '']);
  return mapProxy(rows[0]);
}
export async function setProxyEnabled(tenantId: string, id: string, enabled: boolean): Promise<ApiProxy | null> {
  const { rowCount } = await pool.query(`UPDATE api_proxies SET enabled=$3, updated_at=SYSUTCDATETIME() WHERE tenant_id=$1 AND id=$2`, [tenantId, id, enabled ? 1 : 0]);
  if (!rowCount) return null;
  const { rows } = await pool.query(`SELECT * FROM api_proxies WHERE tenant_id=$1 AND id=$2`, [tenantId, id]);
  return rows.length ? mapProxy(rows[0]) : null;
}
export async function deleteProxy(tenantId: string, id: string): Promise<boolean> {
  const { rowCount } = await pool.query(`DELETE FROM api_proxies WHERE tenant_id=$1 AND id=$2`, [tenantId, id]);
  await pool.query(`DELETE FROM api_proxy_events WHERE tenant_id=$1 AND proxy_id=$2`, [tenantId, id]).catch(() => {});
  return rowCount > 0;
}
export async function listProxyEvents(tenantId: string, id: string): Promise<ProxyEvent[]> {
  const { rows } = await pool.query(`SELECT TOP 100 * FROM api_proxy_events WHERE tenant_id=$1 AND proxy_id=$2 ORDER BY created_at DESC`, [tenantId, id]);
  return rows.map((r: any) => { let issues: string[] = []; try { issues = JSON.parse(r.issues || '[]'); } catch { /* */ } return { at: r.created_at, method: r.method, path: r.path, upstreamStatus: r.upstream_status ?? null, ok: !!r.ok, issues }; });
}

function segMatch(stored: string, req: string): boolean { if (stored === req) return true; if (/^[:{]/.test(stored)) return true; return /^(?:\d+|[0-9a-f-]{16,})$/i.test(stored) && /^(?:\d+|[0-9a-f-]{16,})$/i.test(req); }

async function recordEvent(tenantId: string, proxyId: string, ev: ProxyEvent): Promise<void> {
  await pool.query(`INSERT INTO api_proxy_events (tenant_id, proxy_id, method, path, upstream_status, ok, issues) VALUES ($1,$2,$3,$4,$5,$6,$7)`, [tenantId, proxyId, ev.method, ev.path.slice(0, 500), ev.upstreamStatus, ev.ok ? 1 : 0, JSON.stringify(ev.issues)]).catch(() => {});
  // Trim to newest 200 per proxy.
  await pool.query(`DELETE FROM api_proxy_events WHERE tenant_id=$1 AND proxy_id=$2 AND id NOT IN (SELECT TOP 200 id FROM api_proxy_events WHERE tenant_id=$1 AND proxy_id=$2 ORDER BY created_at DESC)`, [tenantId, proxyId]).catch(() => {});
}

export interface ProxyServeResult { status: number; contentType: string; body: string; validation: 'ok' | 'fail' | 'none' }

/** PUBLIC: resolve a /proxy/:token/* request. Returns null when unknown/disabled. */
export async function serveProxy(token: string, method: string, rawPath: string, query: string, reqBody: string | undefined): Promise<ProxyServeResult | null> {
  if (!/^[0-9a-f]{8,64}$/i.test(token)) return null;
  const { rows } = await pool.query(`SELECT * FROM api_proxies WHERE token = $1`, [token]);
  if (!rows.length || !rows[0].enabled) return null;
  const proxy = rows[0];
  let routes: ProxyRoute[] = []; try { routes = JSON.parse(proxy.routes_json || '[]'); } catch { /* */ }
  const path = ('/' + String(rawPath || '').replace(/^\/+/, '')).replace(/\/+$/, '') || '/';
  const m = method.toUpperCase();
  const reqSegs = path.split('/').filter(Boolean);
  const route = routes.find((r) => r.method === m && r.path === path) || routes.find((r) => r.method === m && r.segs.length === reqSegs.length && r.segs.every((s, i) => segMatch(s, reqSegs[i]!)));
  void pool.query(`UPDATE api_proxies SET hit_count = hit_count + 1 WHERE token = $1`, [token]).catch(() => {});

  if (proxy.mode === 'simulate') {
    if (!route) { await recordEvent(proxy.tenant_id, proxy.id, { at: '', method: m, path, upstreamStatus: null, ok: false, issues: ['No stored example for this route.'] }); return { status: 404, contentType: 'application/json', body: JSON.stringify({ error: 'No simulation for ' + m + ' ' + path }), validation: 'fail' }; }
    await recordEvent(proxy.tenant_id, proxy.id, { at: '', method: m, path, upstreamStatus: route.status, ok: true, issues: [] });
    return { status: route.status, contentType: 'application/json', body: route.body || '{}', validation: 'none' };
  }

  // Validate mode: forward to the real target and check the live response.
  const targetUrl = String(proxy.target_base).replace(/\/+$/, '') + path + (query ? `?${query}` : '');
  const issues: string[] = [];
  try {
    const res = await fetch(targetUrl, { method: m, body: ['GET', 'HEAD'].includes(m) ? undefined : reqBody, headers: reqBody ? { 'content-type': 'application/json' } : undefined, redirect: 'follow', signal: AbortSignal.timeout(15000) });
    const ct = res.headers.get('content-type') || '';
    const bodyText = (await res.text()).slice(0, BODY_LIMIT);
    if (route) {
      if (route.status && res.status !== route.status) issues.push(`Status ${res.status} ≠ expected ${route.status}.`);
      if (route.shape.length) { let parsed: any; try { parsed = JSON.parse(bodyText); } catch { issues.push('Response is not valid JSON.'); } if (parsed && typeof parsed === 'object') { const missing = route.shape.filter((k) => !(k in parsed)); if (missing.length) issues.push(`Missing field(s): ${missing.slice(0, 8).join(', ')}.`); } }
    } else { issues.push('No contract for this route — forwarded without validation.'); }
    await recordEvent(proxy.tenant_id, proxy.id, { at: '', method: m, path, upstreamStatus: res.status, ok: issues.length === 0, issues });
    return { status: res.status, contentType: ct || 'application/json', body: bodyText, validation: route ? (issues.length ? 'fail' : 'ok') : 'none' };
  } catch (e) {
    issues.push(`Upstream error: ${(e as Error).message}`);
    await recordEvent(proxy.tenant_id, proxy.id, { at: '', method: m, path, upstreamStatus: null, ok: false, issues });
    return { status: 502, contentType: 'application/json', body: JSON.stringify({ error: 'Upstream unreachable', detail: (e as Error).message }), validation: 'fail' };
  }
}
