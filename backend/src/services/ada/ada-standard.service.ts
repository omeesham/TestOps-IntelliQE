/**
 * Storage for uploaded design standards (one tenant, many standards —
 * typically one per brand or product). The raw upload is kept next to the
 * normalised standard so a better parser can re-read old uploads later.
 */
import pool from '../../db.js';
import { parseDesignStandard, type DesignStandard, type ParsedStandard } from './ada-design-standard.js';

export interface StoredStandard {
  id: string;
  name: string;
  source_format: string;
  stats: ParsedStandard['stats'];
  warnings: string[];
  standard: DesignStandard;
  created_by: string | null;
  created_at: string;
}

function parseJson<T>(v: unknown, fallback: T): T {
  if (v && typeof v === 'object') return v as T;
  if (typeof v === 'string') { try { return JSON.parse(v) as T; } catch { return fallback; } }
  return fallback;
}

function toPublic(row: Record<string, unknown>): StoredStandard {
  const meta = parseJson<{ stats?: ParsedStandard['stats']; warnings?: string[] }>(row.meta, {});
  const standard = parseJson<DesignStandard>(row.standard, {} as DesignStandard);
  return {
    id: String(row.id), name: String(row.name), source_format: String(row.source_format || ''),
    stats: meta.stats || { colors: standard.colors?.length || 0, fontFamilies: standard.fontFamilies?.length || 0, fontSizes: standard.fontSizes?.length || 0, fontWeights: standard.fontWeights?.length || 0, spacing: standard.spacing?.length || 0, radii: standard.radii?.length || 0 },
    warnings: meta.warnings || [], standard,
    created_by: (row.created_by as string) || null, created_at: String(row.created_at),
  };
}

export async function listStandards(tenantId: string): Promise<StoredStandard[]> {
  const { rows } = await pool.query(`SELECT id, name, source_format, standard, meta, created_by, created_at FROM ada_design_standards WHERE tenant_id = $1 ORDER BY created_at DESC`, [tenantId]);
  return rows.map(toPublic);
}

export async function loadStandard(tenantId: string, id: string): Promise<StoredStandard | null> {
  const { rows } = await pool.query(`SELECT id, name, source_format, standard, meta, created_by, created_at FROM ada_design_standards WHERE id = $1 AND tenant_id = $2`, [id, tenantId]);
  return rows[0] ? toPublic(rows[0]) : null;
}

/** Parse first — a file we cannot read is rejected with the reason, never stored. */
export async function createStandard(tenantId: string, createdBy: string, name: string, content: string): Promise<StoredStandard> {
  const parsed = parseDesignStandard(content);
  const { rows } = await pool.query(
    `INSERT INTO ada_design_standards (tenant_id, name, source_format, tokens, standard, meta, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id, name, source_format, standard, meta, created_by, created_at`,
    [tenantId, name.slice(0, 200), parsed.format, content, JSON.stringify(parsed.standard), JSON.stringify({ stats: parsed.stats, warnings: parsed.warnings }), createdBy],
  );
  return toPublic(rows[0]);
}

export async function deleteStandard(tenantId: string, id: string): Promise<boolean> {
  const r = await pool.query(`DELETE FROM ada_design_standards WHERE id = $1 AND tenant_id = $2`, [id, tenantId]);
  return !!r.rowCount;
}
