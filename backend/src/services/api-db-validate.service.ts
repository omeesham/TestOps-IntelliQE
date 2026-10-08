/**
 * api-db-validate.service.ts
 * ──────────────────────────
 * Database / backend-state validation. After an API call, verify the side-effect
 * it should have produced by running a READ-ONLY query against the application's
 * database and asserting on the result (row count, a column value). Closes the
 * "can't verify what the API persisted" gap.
 *
 * Standalone and opt-in: saved connections (passwords encrypted) live in their
 * own table; SQL Server uses the bundled `mssql`, Postgres/MySQL load via
 * OPTIONAL dynamic imports. STRICTLY read-only — anything that isn't a single
 * SELECT/WITH is refused. The pipeline is never involved.
 */
import pool from '../db.js';
import { encryptField, decryptStored } from '../utils/crypto.js';

async function optional(moduleName: string): Promise<any> {
  try { const spec = moduleName; return await import(spec); }
  catch { throw new Error(`The "${moduleName}" driver is not installed on this server. Run: npm install ${moduleName}`); }
}

export type DbDialect = 'mssql' | 'postgres' | 'mysql';
export interface DbConnConfig { dialect: DbDialect; host: string; port?: number; user: string; password?: string; database: string; encrypt?: boolean; ssl?: boolean }
export interface DbConnection { id: string; name: string; dialect: DbDialect; host: string; database: string; user: string; hasPassword: boolean; createdAt: string }

function mapConn(r: any): DbConnection {
  const c = typeof r.config === 'string' ? JSON.parse(r.config) : (r.config || {});
  return { id: String(r.id), name: r.name, dialect: c.dialect, host: c.host, database: c.database, user: c.user, hasPassword: !!c.password, createdAt: r.created_at };
}

export async function listDbConnections(tenantId: string): Promise<DbConnection[]> {
  const { rows } = await pool.query(`SELECT * FROM api_db_connections WHERE tenant_id = $1 ORDER BY created_at DESC`, [tenantId]);
  return rows.map(mapConn);
}

export async function saveDbConnection(tenantId: string, username: string, input: DbConnConfig & { id?: string; name?: string }): Promise<DbConnection> {
  const name = String(input.name || '').trim().slice(0, 200) || `${input.dialect}@${input.host}`;
  const cfg: Record<string, unknown> = { dialect: input.dialect, host: input.host, port: input.port, user: input.user, database: input.database, encrypt: !!input.encrypt, ssl: !!input.ssl };
  if (input.password && !input.password.includes('•') && !input.password.includes('*')) cfg.password = encryptField(input.password);
  if (input.id) {
    const { rows: ex } = await pool.query(`SELECT config FROM api_db_connections WHERE tenant_id = $1 AND id = $2`, [tenantId, input.id]);
    if (ex.length) { const prev = typeof ex[0].config === 'string' ? JSON.parse(ex[0].config) : ex[0].config; if (!cfg.password && prev.password) cfg.password = prev.password; }
    const { rows } = await pool.query(`UPDATE api_db_connections SET name = $3, config = $4, updated_at = SYSUTCDATETIME() OUTPUT INSERTED.* WHERE tenant_id = $1 AND id = $2`, [tenantId, input.id, name, JSON.stringify(cfg)]);
    if (!rows.length) throw new Error('Connection not found.');
    return mapConn(rows[0]);
  }
  const { rows } = await pool.query(`INSERT INTO api_db_connections (tenant_id, name, config, created_by) OUTPUT INSERTED.* VALUES ($1, $2, $3, $4)`, [tenantId, name, JSON.stringify(cfg), username || '']);
  return mapConn(rows[0]);
}

export async function deleteDbConnection(tenantId: string, id: string): Promise<boolean> {
  const { rowCount } = await pool.query(`DELETE FROM api_db_connections WHERE tenant_id = $1 AND id = $2`, [tenantId, id]);
  return rowCount > 0;
}

/** Reject anything that isn't a single read-only SELECT/WITH statement. */
function assertReadOnly(sql: string): void {
  const stripped = sql.replace(/--[^\n]*/g, ' ').replace(/\/\*[\s\S]*?\*\//g, ' ').trim();
  if (!/^(select|with)\b/i.test(stripped)) throw new Error('Only read-only SELECT/WITH queries are allowed.');
  if (/\b(insert|update|delete|drop|alter|truncate|create|merge|exec|execute|grant|revoke|call|into\s+\w)\b/i.test(stripped)) {
    throw new Error('The query contains a write/DDL keyword — only read-only SELECT is allowed.');
  }
  if (stripped.replace(/;\s*$/, '').includes(';')) throw new Error('Only a single statement is allowed.');
}

async function resolveConfig(tenantId: string, connectionId?: string, inline?: DbConnConfig): Promise<DbConnConfig> {
  if (inline && inline.host) return inline;
  if (!connectionId) throw new Error('Provide a saved connection or an inline config.');
  const { rows } = await pool.query(`SELECT config FROM api_db_connections WHERE tenant_id = $1 AND id = $2`, [tenantId, connectionId]);
  if (!rows.length) throw new Error('Connection not found.');
  const c = typeof rows[0].config === 'string' ? JSON.parse(rows[0].config) : rows[0].config;
  return { ...c, password: c.password ? decryptStored(c.password) : undefined };
}

const MAX_ROWS = 200;

async function runQuery(cfg: DbConnConfig, sql: string): Promise<Record<string, unknown>[]> {
  if (cfg.dialect === 'mssql') {
    const mssql = (await import('mssql')).default;
    const poolCx = new mssql.ConnectionPool({ server: cfg.host, port: cfg.port || 1433, user: cfg.user, password: cfg.password || '', database: cfg.database, options: { encrypt: cfg.encrypt ?? false, trustServerCertificate: true }, connectionTimeout: 15000, requestTimeout: 20000 });
    await poolCx.connect();
    try { const r = await poolCx.request().query(sql); return (r.recordset || []).slice(0, MAX_ROWS); }
    finally { await poolCx.close().catch(() => {}); }
  }
  if (cfg.dialect === 'postgres') {
    const pg = await optional('pg');
    const client = new pg.Client({ host: cfg.host, port: cfg.port || 5432, user: cfg.user, password: cfg.password || '', database: cfg.database, ssl: cfg.ssl ? { rejectUnauthorized: false } : undefined, connectionTimeoutMillis: 15000 });
    await client.connect();
    try { const r = await client.query(sql); return (r.rows || []).slice(0, MAX_ROWS); }
    finally { await client.end().catch(() => {}); }
  }
  if (cfg.dialect === 'mysql') {
    const mysql = await optional('mysql2/promise');
    const conn = await mysql.createConnection({ host: cfg.host, port: cfg.port || 3306, user: cfg.user, password: cfg.password || '', database: cfg.database, ssl: cfg.ssl ? {} : undefined, connectTimeout: 15000 });
    try { const [rows] = await conn.execute(sql); return (Array.isArray(rows) ? rows : []).slice(0, MAX_ROWS); }
    finally { await conn.end().catch(() => {}); }
  }
  throw new Error(`Unsupported dialect: ${cfg.dialect}`);
}

export interface DbValidateInput { connectionId?: string; config?: DbConnConfig; query: string; expect?: { minRows?: number; maxRows?: number; column?: string; equals?: string } }
export interface DbValidateResult {
  rowCount: number;
  rows: Record<string, unknown>[];
  checks: { name: string; pass: boolean; detail: string }[];
  passed: boolean;
  elapsedMs: number;
}

export async function runDbValidation(tenantId: string, input: DbValidateInput): Promise<DbValidateResult> {
  const sql = String(input.query || '').trim();
  if (!sql) throw new Error('Provide a SQL query.');
  assertReadOnly(sql);
  const cfg = await resolveConfig(tenantId, input.connectionId, input.config);
  const started = Date.now();
  const rows = await runQuery(cfg, sql);
  const checks: DbValidateResult['checks'] = [];
  const e = input.expect || {};
  if (e.minRows != null) checks.push({ name: `≥ ${e.minRows} rows`, pass: rows.length >= e.minRows, detail: `got ${rows.length}` });
  if (e.maxRows != null) checks.push({ name: `≤ ${e.maxRows} rows`, pass: rows.length <= e.maxRows, detail: `got ${rows.length}` });
  if (e.column && e.equals != null) {
    const hit = rows.some((r) => String((r as any)[e.column!]) === String(e.equals));
    checks.push({ name: `${e.column} = ${e.equals}`, pass: hit, detail: hit ? 'found' : 'no row matched' });
  }
  const passed = checks.length === 0 ? rows.length > 0 : checks.every((c) => c.pass);
  return { rowCount: rows.length, rows, checks, passed, elapsedMs: Date.now() - started };
}
