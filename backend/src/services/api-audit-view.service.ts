/**
 * api-audit-view.service.ts
 * ─────────────────────────
 * A read-only viewer over the existing `audit_log` table (written by
 * utils/audit.ts). The platform already records audit rows; this adds the
 * missing viewer: filter by action / resource type / user / date / free text,
 * page the results, and export the current filter as CSV.
 *
 * Strictly additive and read-only — it never writes, and every query is scoped
 * to the caller's tenant.
 */
import pool from '../db.js';

export interface AuditEntry {
  id: string; username: string; action: string; resourceType: string; resourceId: string;
  details: Record<string, unknown>; ipAddress: string; requestId: string; createdAt: string;
}
export interface AuditFilters {
  action?: string; resourceType?: string; username?: string;
  from?: string; to?: string; q?: string; page?: number; pageSize?: number;
}
export interface AuditPage { items: AuditEntry[]; total: number; page: number; pageSize: number }

function toEntry(r: any): AuditEntry {
  return {
    id: String(r.id), username: r.username || '', action: r.action || '', resourceType: r.resource_type || '',
    resourceId: r.resource_id || '', details: r.details && typeof r.details === 'object' ? r.details : {},
    ipAddress: r.ip_address || '', requestId: r.request_id ? String(r.request_id) : '', createdAt: r.created_at,
  };
}

function clampInt(v: unknown, def: number, min: number, max: number): number {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : def;
}

/** Build the shared WHERE clause + ordered params (starting at $1 = tenantId). */
function buildWhere(tenantId: string, f: AuditFilters): { sql: string; params: any[] } {
  const where: string[] = ['tenant_id = $1'];
  const params: any[] = [tenantId];
  let p = 2;
  const add = (clause: string, val: any) => { where.push(clause.replace('?', `$${p}`)); params.push(val); p++; };
  if (f.action) add('action = ?', String(f.action).slice(0, 50));
  if (f.resourceType) add('resource_type = ?', String(f.resourceType).slice(0, 50));
  if (f.username) add('username = ?', String(f.username).slice(0, 100));
  if (f.from) add('created_at >= ?', String(f.from).slice(0, 40));
  if (f.to) add('created_at <= ?', String(f.to).slice(0, 40));
  if (f.q) {
    const like = `%${String(f.q).slice(0, 200)}%`;
    where.push(`(resource_id LIKE $${p} OR username LIKE $${p} OR CAST(details AS NVARCHAR(MAX)) LIKE $${p})`);
    params.push(like); p++;
  }
  return { sql: where.join(' AND '), params };
}

export async function listAudit(tenantId: string, filters: AuditFilters = {}): Promise<AuditPage> {
  const page = clampInt(filters.page, 1, 1, 100000);
  const pageSize = clampInt(filters.pageSize, 25, 1, 200);
  const { sql, params } = buildWhere(tenantId, filters);
  const { rows: countRows } = await pool.query(`SELECT COUNT(*) AS n FROM audit_log WHERE ${sql}`, params);
  const total = Number(countRows[0]?.n || 0);
  const offset = (page - 1) * pageSize;
  const { rows } = await pool.query(
    `SELECT id, username, action, resource_type, resource_id, details, ip_address, request_id, created_at
       FROM audit_log WHERE ${sql}
      ORDER BY created_at DESC OFFSET ${offset} ROWS FETCH NEXT ${pageSize} ROWS ONLY`,
    params,
  );
  return { items: rows.map(toEntry), total, page, pageSize };
}

export interface AuditFacets { actions: string[]; resourceTypes: string[]; usernames: string[] }
export async function auditFacets(tenantId: string): Promise<AuditFacets> {
  const [a, rt, u] = await Promise.all([
    pool.query(`SELECT DISTINCT action FROM audit_log WHERE tenant_id = $1 ORDER BY action`, [tenantId]),
    pool.query(`SELECT DISTINCT resource_type FROM audit_log WHERE tenant_id = $1 ORDER BY resource_type`, [tenantId]),
    pool.query(`SELECT DISTINCT TOP 200 username FROM audit_log WHERE tenant_id = $1 ORDER BY username`, [tenantId]),
  ]);
  return {
    actions: a.rows.map((r: any) => r.action).filter(Boolean),
    resourceTypes: rt.rows.map((r: any) => r.resource_type).filter(Boolean),
    usernames: u.rows.map((r: any) => r.username).filter(Boolean),
  };
}

const csvCell = (v: unknown): string => {
  const s = v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export async function exportAuditCsv(tenantId: string, filters: AuditFilters = {}): Promise<string> {
  const { sql, params } = buildWhere(tenantId, filters);
  const { rows } = await pool.query(
    `SELECT TOP 5000 username, action, resource_type, resource_id, details, ip_address, created_at
       FROM audit_log WHERE ${sql} ORDER BY created_at DESC`,
    params,
  );
  const header = ['timestamp', 'user', 'action', 'resource_type', 'resource_id', 'ip_address', 'details'];
  const lines = [header.join(',')];
  for (const r of rows) {
    const e = toEntry(r);
    lines.push([e.createdAt, e.username, e.action, e.resourceType, e.resourceId, e.ipAddress, e.details].map(csvCell).join(','));
  }
  return lines.join('\r\n');
}
