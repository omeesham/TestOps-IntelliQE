/**
 * api-virtual.service.ts
 * ──────────────────────
 * STATEFUL service virtualization — a step beyond the static hosted mock. A
 * virtual service holds ordered rules; each rule MATCHES on method/path/body/
 * header/query/state and RESPONDS with a templated body, optional latency and
 * optional fault injection, and may MUTATE per-service state so a later response
 * depends on earlier requests (WireMock-scenarios / Parasoft-Virtualize parity).
 *
 * Standalone and opt-in: served publicly at /vs/:token/* (its own public route,
 * same pattern as /mock and /hook), reads only its own tables, and the
 * generate → execute → heal pipeline is never involved.
 */
import { randomBytes } from 'crypto';
import pool from '../db.js';

export type VirtualFault = 'none' | 'abort' | 'malformed' | 'server-500' | 'timeout';

export interface VirtualMatch {
  method?: string;                       // '' / 'ANY' = any method
  pathPattern?: string;                   // /orders/:id, /users/*, exact, or '*'
  bodyContains?: string;
  header?: { name: string; value: string };
  query?: { name: string; value: string };
  stateEquals?: { key: string; value: string };
}
export interface VirtualRespond {
  status: number;
  headers?: { key: string; value: string }[];
  body?: string;                          // template: {{request.body.x}} {{state.k}} {{uuid}} {{now}} {{request.query.q}} {{request.header.h}}
  delayMs?: number;
  fault?: VirtualFault;
}
export interface VirtualRule {
  id?: string;
  name?: string;
  when: VirtualMatch;
  respond: VirtualRespond;
  /** State mutations applied when this rule fires. Value "$inc" increments a number; else set (templated). */
  setState?: Record<string, string>;
}

export interface VirtualService {
  id: string;
  token: string;
  name: string;
  enabled: boolean;
  rules: VirtualRule[];
  state: Record<string, string>;
  hitCount: number;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

const MAX_RULES = 60;

function mapService(r: any): VirtualService {
  const parse = <T,>(v: unknown, d: T): T => { try { return (typeof v === 'string' ? JSON.parse(v) : (v ?? d)) as T; } catch { return d; } };
  return {
    id: String(r.id),
    token: r.token,
    name: r.name || 'Virtual service',
    enabled: r.enabled === true || r.enabled === 1,
    rules: parse<VirtualRule[]>(r.rules, []),
    state: parse<Record<string, string>>(r.state, {}),
    hitCount: Number(r.hit_count) || 0,
    createdBy: r.created_by || '',
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function sanitizeRules(raw: unknown): VirtualRule[] {
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, MAX_RULES).map((r: any, i: number) => ({
    id: String(r?.id || `r${i}`),
    name: typeof r?.name === 'string' ? r.name.slice(0, 120) : undefined,
    when: {
      method: typeof r?.when?.method === 'string' ? r.when.method.toUpperCase().slice(0, 10) : undefined,
      pathPattern: typeof r?.when?.pathPattern === 'string' ? r.when.pathPattern.slice(0, 500) : undefined,
      bodyContains: typeof r?.when?.bodyContains === 'string' ? r.when.bodyContains.slice(0, 500) : undefined,
      header: r?.when?.header?.name ? { name: String(r.when.header.name).slice(0, 100), value: String(r.when.header.value ?? '').slice(0, 500) } : undefined,
      query: r?.when?.query?.name ? { name: String(r.when.query.name).slice(0, 100), value: String(r.when.query.value ?? '').slice(0, 500) } : undefined,
      stateEquals: r?.when?.stateEquals?.key ? { key: String(r.when.stateEquals.key).slice(0, 100), value: String(r.when.stateEquals.value ?? '').slice(0, 500) } : undefined,
    },
    respond: {
      status: Number.isInteger(Number(r?.respond?.status)) ? Math.min(599, Math.max(100, Number(r.respond.status))) : 200,
      headers: Array.isArray(r?.respond?.headers) ? r.respond.headers.filter((h: any) => h?.key).slice(0, 30).map((h: any) => ({ key: String(h.key).slice(0, 100), value: String(h.value ?? '').slice(0, 2000) })) : undefined,
      body: typeof r?.respond?.body === 'string' ? r.respond.body.slice(0, 50000) : undefined,
      delayMs: Number.isFinite(Number(r?.respond?.delayMs)) ? Math.min(30000, Math.max(0, Number(r.respond.delayMs))) : undefined,
      fault: ['abort', 'malformed', 'server-500', 'timeout'].includes(r?.respond?.fault) ? r.respond.fault : undefined,
    },
    setState: r?.setState && typeof r.setState === 'object' ? Object.fromEntries(Object.entries(r.setState).slice(0, 20).map(([k, v]) => [String(k).slice(0, 100), String(v ?? '').slice(0, 500)])) : undefined,
  }));
}

/* ── CRUD ── */

export async function listVirtualServices(tenantId: string): Promise<VirtualService[]> {
  const { rows } = await pool.query(`SELECT * FROM api_virtual_services WHERE tenant_id = $1 ORDER BY updated_at DESC`, [tenantId]);
  return rows.map(mapService);
}

export async function createVirtualService(tenantId: string, username: string, input: { name?: unknown; rules?: unknown }): Promise<VirtualService> {
  const name = String(input.name || '').trim().slice(0, 200) || 'Virtual service';
  const token = `vs_${randomBytes(14).toString('hex')}`;
  const rules = JSON.stringify(sanitizeRules(input.rules));
  const { rows } = await pool.query(
    `INSERT INTO api_virtual_services (tenant_id, token, name, enabled, rules, state, created_by)
     OUTPUT INSERTED.* VALUES ($1, $2, $3, 1, $4, '{}', $5)`,
    [tenantId, token, name, rules, username || ''],
  );
  return mapService(rows[0]);
}

export async function updateVirtualService(tenantId: string, id: string, patch: { name?: unknown; rules?: unknown; enabled?: unknown; resetState?: boolean }): Promise<VirtualService | null> {
  const sets: string[] = ['updated_at = SYSUTCDATETIME()'];
  const params: unknown[] = [tenantId, id];
  if (patch.name !== undefined) { params.push(String(patch.name).slice(0, 200)); sets.push(`name = $${params.length}`); }
  if (patch.rules !== undefined) { params.push(JSON.stringify(sanitizeRules(patch.rules))); sets.push(`rules = $${params.length}`); }
  if (patch.enabled !== undefined) { params.push(patch.enabled ? 1 : 0); sets.push(`enabled = $${params.length}`); }
  if (patch.resetState) sets.push(`state = '{}'`);
  const { rows } = await pool.query(`UPDATE api_virtual_services SET ${sets.join(', ')} OUTPUT INSERTED.* WHERE tenant_id = $1 AND id = $2`, params);
  return rows.length ? mapService(rows[0]) : null;
}

export async function deleteVirtualService(tenantId: string, id: string): Promise<boolean> {
  const { rowCount } = await pool.query(`DELETE FROM api_virtual_services WHERE tenant_id = $1 AND id = $2`, [tenantId, id]);
  return rowCount > 0;
}

/* ── Serving (public) ── */

function pathToRegex(pattern: string): RegExp {
  if (!pattern || pattern === '*' || pattern === '/*') return /^\/?.*$/;
  const norm = pattern.startsWith('/') ? pattern : `/${pattern}`;
  const rx = norm.split('/').map((seg) => {
    if (seg === '*') return '[^/]+';
    if (seg === '**') return '.*';
    if (seg.startsWith(':') || (seg.startsWith('{') && seg.endsWith('}'))) return '[^/]+';
    return seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }).join('/');
  return new RegExp(`^${rx}/?$`, 'i');
}

function readDotted(obj: unknown, path: string): string {
  let cur: any = obj;
  for (const seg of path.split('.')) { if (cur == null) return ''; cur = cur[seg]; }
  return cur == null ? '' : typeof cur === 'string' ? cur : JSON.stringify(cur);
}

function renderTemplate(tpl: string, ctx: { body: unknown; query: Record<string, string>; headers: Record<string, string>; state: Record<string, string> }): string {
  return tpl.replace(/\{\{\s*([\w.$-]+)\s*\}\}/g, (_m, key: string) => {
    if (key === 'uuid') return randomBytes(16).toString('hex').replace(/(.{8})(.{4})(.{4})(.{4})(.{12})/, '$1-$2-$3-$4-$5');
    if (key === 'now') return new Date().toISOString();
    if (key.startsWith('request.body.')) return readDotted(ctx.body, key.slice('request.body.'.length));
    if (key === 'request.body') return typeof ctx.body === 'string' ? ctx.body : JSON.stringify(ctx.body ?? '');
    if (key.startsWith('request.query.')) return ctx.query[key.slice('request.query.'.length)] ?? '';
    if (key.startsWith('request.header.')) return ctx.headers[key.slice('request.header.'.length).toLowerCase()] ?? '';
    if (key.startsWith('state.')) return ctx.state[key.slice('state.'.length)] ?? '';
    return '';
  });
}

export interface VirtualResolution {
  status: number;
  headers: Record<string, string>;
  body: string;
  delayMs: number;
  fault: VirtualFault;
  matched: boolean;
  ruleName?: string;
}

/** Resolve an inbound request against a virtual service, applying + persisting state. */
export async function resolveVirtual(token: string, req: { method: string; path: string; query: Record<string, string>; headers: Record<string, string>; body: string }): Promise<VirtualResolution | null> {
  const { rows } = await pool.query(`SELECT * FROM api_virtual_services WHERE token = $1`, [token]);
  if (!rows.length) return null;
  const svc = mapService(rows[0]);
  if (!svc.enabled) return { status: 503, headers: {}, body: JSON.stringify({ error: 'virtual service disabled' }), delayMs: 0, fault: 'none', matched: false };

  let parsedBody: unknown = req.body;
  try { parsedBody = JSON.parse(req.body); } catch { /* keep raw */ }
  const lowHeaders: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.headers)) lowHeaders[k.toLowerCase()] = String(v);

  const matches = (rule: VirtualRule): boolean => {
    const w = rule.when || {};
    if (w.method && w.method !== 'ANY' && w.method !== req.method.toUpperCase()) return false;
    if (w.pathPattern && !pathToRegex(w.pathPattern).test(req.path)) return false;
    if (w.bodyContains && !req.body.includes(w.bodyContains)) return false;
    if (w.header && (lowHeaders[w.header.name.toLowerCase()] ?? '') !== w.header.value) return false;
    if (w.query && (req.query[w.query.name] ?? '') !== w.query.value) return false;
    if (w.stateEquals && (svc.state[w.stateEquals.key] ?? '') !== w.stateEquals.value) return false;
    return true;
  };

  const rule = svc.rules.find(matches);
  const ctx = { body: parsedBody, query: req.query, headers: lowHeaders, state: svc.state };

  // Apply + persist state mutations and the hit counter.
  const newState = { ...svc.state };
  if (rule?.setState) {
    for (const [k, v] of Object.entries(rule.setState)) {
      if (v === '$inc') newState[k] = String((Number(newState[k]) || 0) + 1);
      else newState[k] = renderTemplate(v, ctx);
    }
  }
  await pool.query(`UPDATE api_virtual_services SET state = $3, hit_count = hit_count + 1, updated_at = SYSUTCDATETIME() WHERE token = $1 AND id = $2`, [token, svc.id, JSON.stringify(newState)]).catch(() => {});

  if (!rule) {
    return { status: 404, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ error: 'no virtual rule matched', path: req.path }), delayMs: 0, fault: 'none', matched: false };
  }
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  for (const h of rule.respond.headers || []) headers[h.key] = h.value;
  const body = rule.respond.body ? renderTemplate(rule.respond.body, { ...ctx, state: newState }) : '';
  return {
    status: rule.respond.status,
    headers,
    body,
    delayMs: rule.respond.delayMs || 0,
    fault: rule.respond.fault || 'none',
    matched: true,
    ruleName: rule.name,
  };
}
