/**
 * api-registry.service.ts
 * ───────────────────────
 * The catalog / registry half of the governance platform (Postman Spec Hub /
 * Stoplight parity):
 *
 *   • An API registry — register each API service with an owner, tags and a
 *     lifecycle state (draft → published → deprecated → retired).
 *   • Versioning — store an OpenAPI spec snapshot per version, with deprecation /
 *     sunset dates, and diff two versions for breaking changes (reusing the
 *     spec-diff gate).
 *   • Two-way spec sync — "push" the working catalogue in as a new version, and
 *     "pull" a stored version's spec back out to re-import into the catalogue.
 *
 * DB-backed registry; the version diff reuses the pure spec-diff engine. Opt-in and
 * standalone — the pipeline is never involved.
 */
import pool from '../db.js';
import { diffSpecs, type SpecDiffResult } from './api-specdiff.service.js';

export type Lifecycle = 'draft' | 'published' | 'deprecated' | 'retired';
const LIFECYCLES: Lifecycle[] = ['draft', 'published', 'deprecated', 'retired'];

export interface RegistryEntry {
  id: string;
  name: string;
  description?: string;
  owner?: string;
  lifecycle: Lifecycle;
  tags: string[];
  versionCount?: number;
  latestVersion?: string;
  createdBy?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface RegistryVersion {
  id: string;
  apiId: string;
  version: string;
  status: Lifecycle;
  deprecationDate?: string;
  sunsetDate?: string;
  notes?: string;
  hasSpec: boolean;
  createdBy?: string;
  createdAt?: string;
  updatedAt?: string;
}

function jArr(v: any): string[] {
  if (Array.isArray(v)) return v.map(String);
  if (typeof v === 'string' && v.trim().startsWith('[')) { try { const p = JSON.parse(v); if (Array.isArray(p)) return p.map(String); } catch { /* empty */ } }
  return [];
}

function lc(v: unknown, fallback: Lifecycle = 'draft'): Lifecycle {
  return LIFECYCLES.includes(String(v) as Lifecycle) ? (String(v) as Lifecycle) : fallback;
}

function rowToEntry(r: any): RegistryEntry {
  return {
    id: String(r.id), name: r.name, description: r.description || undefined, owner: r.owner || undefined,
    lifecycle: lc(r.lifecycle), tags: jArr(r.tags),
    versionCount: r.version_count != null ? Number(r.version_count) : undefined,
    latestVersion: r.latest_version || undefined,
    createdBy: r.created_by || undefined, createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

function rowToVersion(r: any): RegistryVersion {
  return {
    id: String(r.id), apiId: String(r.api_id), version: r.version, status: lc(r.status),
    deprecationDate: r.deprecation_date || undefined, sunsetDate: r.sunset_date || undefined,
    notes: r.notes || undefined, hasSpec: !!r.has_spec,
    createdBy: r.created_by || undefined, createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

/* ── Registry entries ── */

export async function listRegistry(tenantId: string): Promise<RegistryEntry[]> {
  const { rows } = await pool.query(
    `SELECT e.id, e.name, e.description, e.owner, e.lifecycle, e.tags, e.created_by, e.created_at, e.updated_at,
            (SELECT COUNT(*) FROM api_registry_versions v WHERE v.tenant_id = e.tenant_id AND v.api_id = e.id) AS version_count,
            (SELECT TOP 1 v2.version FROM api_registry_versions v2 WHERE v2.tenant_id = e.tenant_id AND v2.api_id = e.id ORDER BY v2.created_at DESC) AS latest_version
       FROM api_registry_entries e WHERE e.tenant_id = $1 ORDER BY e.updated_at DESC`,
    [tenantId],
  );
  return rows.map(rowToEntry);
}

export async function saveRegistryEntry(tenantId: string, username: string, input: { id?: unknown; name?: unknown; description?: unknown; owner?: unknown; lifecycle?: unknown; tags?: unknown }): Promise<RegistryEntry> {
  const name = String(input?.name || '').trim().slice(0, 200);
  if (!name) throw new Error('Provide an API name.');
  const description = input?.description ? String(input.description).slice(0, 4000) : null;
  const owner = input?.owner ? String(input.owner).slice(0, 200) : null;
  const lifecycle = lc(input?.lifecycle);
  const tags = Array.isArray(input?.tags) ? (input!.tags as any[]).map(String).slice(0, 20) : [];
  const id = input?.id ? String(input.id) : '';

  if (id) {
    const { rows } = await pool.query(
      `UPDATE api_registry_entries SET name = $3, description = $4, owner = $5, lifecycle = $6, tags = $7, updated_at = SYSUTCDATETIME()
       OUTPUT INSERTED.id, INSERTED.name, INSERTED.description, INSERTED.owner, INSERTED.lifecycle, INSERTED.tags, INSERTED.created_by, INSERTED.created_at, INSERTED.updated_at
       WHERE tenant_id = $1 AND id = $2`,
      [tenantId, id, name, description, owner, lifecycle, tags],
    );
    if (rows[0]) return rowToEntry(rows[0]);
  }
  const { rows } = await pool.query(
    `INSERT INTO api_registry_entries (tenant_id, name, description, owner, lifecycle, tags, created_by)
     OUTPUT INSERTED.id, INSERTED.name, INSERTED.description, INSERTED.owner, INSERTED.lifecycle, INSERTED.tags, INSERTED.created_by, INSERTED.created_at, INSERTED.updated_at
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [tenantId, name, description, owner, lifecycle, tags, username],
  );
  return rowToEntry(rows[0]);
}

export async function setLifecycle(tenantId: string, id: string, lifecycle: string): Promise<RegistryEntry | null> {
  const next = lc(lifecycle);
  const { rows } = await pool.query(
    `UPDATE api_registry_entries SET lifecycle = $3, updated_at = SYSUTCDATETIME()
     OUTPUT INSERTED.id, INSERTED.name, INSERTED.description, INSERTED.owner, INSERTED.lifecycle, INSERTED.tags, INSERTED.created_by, INSERTED.created_at, INSERTED.updated_at
     WHERE tenant_id = $1 AND id = $2`,
    [tenantId, id, next],
  );
  return rows[0] ? rowToEntry(rows[0]) : null;
}

export async function deleteRegistryEntry(tenantId: string, id: string): Promise<boolean> {
  await pool.query(`DELETE FROM api_registry_versions WHERE tenant_id = $1 AND api_id = $2`, [tenantId, id]);
  const { rowCount } = await pool.query(`DELETE FROM api_registry_entries WHERE tenant_id = $1 AND id = $2`, [tenantId, id]);
  return rowCount > 0;
}

/* ── Versions ── */

export async function listVersions(tenantId: string, apiId: string): Promise<RegistryVersion[]> {
  const { rows } = await pool.query(
    `SELECT id, api_id, version, status, deprecation_date, sunset_date, notes,
            CASE WHEN spec IS NULL OR spec = '' THEN 0 ELSE 1 END AS has_spec,
            created_by, created_at, updated_at
       FROM api_registry_versions WHERE tenant_id = $1 AND api_id = $2 ORDER BY created_at DESC`,
    [tenantId, apiId],
  );
  return rows.map(rowToVersion);
}

export async function getVersionSpec(tenantId: string, versionId: string): Promise<{ version: RegistryVersion; spec: string } | null> {
  const { rows } = await pool.query(
    `SELECT id, api_id, version, status, deprecation_date, sunset_date, notes, spec,
            CASE WHEN spec IS NULL OR spec = '' THEN 0 ELSE 1 END AS has_spec,
            created_by, created_at, updated_at
       FROM api_registry_versions WHERE tenant_id = $1 AND id = $2`,
    [tenantId, versionId],
  );
  if (!rows[0]) return null;
  return { version: rowToVersion(rows[0]), spec: rows[0].spec || '' };
}

/** Push a new version (store the OpenAPI spec snapshot). */
export async function addVersion(tenantId: string, username: string, apiId: string, input: { version?: unknown; spec?: unknown; status?: unknown; deprecationDate?: unknown; sunsetDate?: unknown; notes?: unknown }): Promise<RegistryVersion> {
  const { rows: owns } = await pool.query(`SELECT id FROM api_registry_entries WHERE tenant_id = $1 AND id = $2`, [tenantId, apiId]);
  if (!owns[0]) throw new Error('API not found in the registry.');
  const version = String(input?.version || '').trim().slice(0, 60);
  if (!version) throw new Error('Provide a version label (e.g. 1.0.0).');
  const spec = input?.spec ? String(input.spec).slice(0, 2_000_000) : null;
  const { rows } = await pool.query(
    `INSERT INTO api_registry_versions (tenant_id, api_id, version, spec, status, deprecation_date, sunset_date, notes, created_by)
     OUTPUT INSERTED.id, INSERTED.api_id, INSERTED.version, INSERTED.status, INSERTED.deprecation_date, INSERTED.sunset_date, INSERTED.notes,
            CASE WHEN INSERTED.spec IS NULL OR INSERTED.spec = '' THEN 0 ELSE 1 END AS has_spec,
            INSERTED.created_by, INSERTED.created_at, INSERTED.updated_at
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [tenantId, apiId, version, spec, lc(input?.status, 'draft'), input?.deprecationDate ? String(input.deprecationDate).slice(0, 40) : null, input?.sunsetDate ? String(input.sunsetDate).slice(0, 40) : null, input?.notes ? String(input.notes).slice(0, 2000) : null, username],
  );
  return rowToVersion(rows[0]);
}

export async function updateVersionStatus(tenantId: string, versionId: string, input: { status?: unknown; deprecationDate?: unknown; sunsetDate?: unknown }): Promise<RegistryVersion | null> {
  const { rows } = await pool.query(
    `UPDATE api_registry_versions SET status = $3, deprecation_date = $4, sunset_date = $5, updated_at = SYSUTCDATETIME()
     OUTPUT INSERTED.id, INSERTED.api_id, INSERTED.version, INSERTED.status, INSERTED.deprecation_date, INSERTED.sunset_date, INSERTED.notes,
            CASE WHEN INSERTED.spec IS NULL OR INSERTED.spec = '' THEN 0 ELSE 1 END AS has_spec,
            INSERTED.created_by, INSERTED.created_at, INSERTED.updated_at
     WHERE tenant_id = $1 AND id = $2`,
    [tenantId, versionId, lc(input?.status), input?.deprecationDate ? String(input.deprecationDate).slice(0, 40) : null, input?.sunsetDate ? String(input.sunsetDate).slice(0, 40) : null],
  );
  return rows[0] ? rowToVersion(rows[0]) : null;
}

export async function deleteVersion(tenantId: string, versionId: string): Promise<boolean> {
  const { rowCount } = await pool.query(`DELETE FROM api_registry_versions WHERE tenant_id = $1 AND id = $2`, [tenantId, versionId]);
  return rowCount > 0;
}

/** Diff two stored versions' specs through the breaking-change gate. */
export async function diffVersions(tenantId: string, versionIdA: string, versionIdB: string): Promise<SpecDiffResult & { a: string; b: string }> {
  const a = await getVersionSpec(tenantId, versionIdA);
  const b = await getVersionSpec(tenantId, versionIdB);
  if (!a || !b) throw new Error('One or both versions were not found.');
  if (!a.spec || !b.spec) throw new Error('Both versions need a stored spec to diff.');
  const result = diffSpecs(a.spec, b.spec, { failOnBreaking: true });
  return { ...result, a: a.version.version, b: b.version.version };
}
