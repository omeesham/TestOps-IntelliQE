/**
 * api-test-data-mgmt.service.ts
 * ─────────────────────────────
 * Enterprise test-data management — the depth on top of the synthetic-data factory
 * and named profiles that already exist (Tricentis TDM / BlazeMeter parity):
 *
 *   1. Referential-integrity synthetic data — generate MANY related entities at
 *      once (users → orders → items) where every foreign key points at a real
 *      parent primary key. Deterministic (seeded), so a dataset is reproducible.
 *   2. Production subsetting — take large related tables and extract a small,
 *      referentially-consistent subset (sample the root rows, then keep only the
 *      child rows whose FK survives) so a realistic slice fits a test environment.
 *   3. Dataset versioning — snapshot a generated/subset dataset with a content
 *      hash, list versions, and diff two versions (row-count + schema deltas).
 *
 * PURE generation + subsetting (reuses the deterministic faker-lite from the
 * synthetic-data factory); versioning is the only DB-backed part. Opt-in and
 * standalone — the pipeline is never involved.
 */
import pool from '../db.js';
import { mulberry32, genValue, type SynthField } from './api-synth-data.service.js';

/* ────────────────────────────────────────────────────────────────
   1. Referential-integrity synthetic data
   ──────────────────────────────────────────────────────────────── */

export interface RefEntity {
  name: string;
  count: number;
  /** primary-key field name (generated per row). */
  pk: string;
  fields: SynthField[];
  /** foreign keys: this entity's `field` references `entity`'s primary key. */
  refs?: { field: string; entity: string }[];
}

export interface ReferentialResult {
  entities: Record<string, Record<string, unknown>[]>;
  order: string[];
  seed: number;
  summary: { entity: string; rows: number; refs: string[] }[];
  notes: string[];
}

/** Topological order so a referenced entity is generated before the one referencing it. */
function topoOrder(entities: RefEntity[]): { order: string[]; cyclic: string[] } {
  const byName = new Map(entities.map((e) => [e.name, e]));
  const order: string[] = [];
  const state = new Map<string, 0 | 1 | 2>(); // 0=unseen 1=visiting 2=done
  const cyclic: string[] = [];
  const visit = (name: string) => {
    const s = state.get(name);
    if (s === 2) return;
    if (s === 1) { cyclic.push(name); return; }
    state.set(name, 1);
    const e = byName.get(name);
    for (const r of e?.refs || []) if (byName.has(r.entity) && r.entity !== name) visit(r.entity);
    state.set(name, 2);
    order.push(name);
  };
  for (const e of entities) visit(e.name);
  return { order, cyclic };
}

export function generateReferential(rawEntities: unknown, opts: { seed?: number } = {}): ReferentialResult {
  const entities: RefEntity[] = Array.isArray(rawEntities)
    ? rawEntities.slice(0, 20).map((e: any) => ({
        name: String(e?.name || 'entity').slice(0, 60),
        count: Math.min(2000, Math.max(0, Math.floor(Number(e?.count) || 10))),
        pk: String(e?.pk || 'id').slice(0, 60),
        fields: Array.isArray(e?.fields) ? e.fields.slice(0, 40).map((f: any) => ({ name: String(f?.name || 'field'), type: f?.type || 'string', min: f?.min, max: f?.max, options: Array.isArray(f?.options) ? f.options.map(String) : undefined })) : [],
        refs: Array.isArray(e?.refs) ? e.refs.slice(0, 20).map((r: any) => ({ field: String(r?.field || ''), entity: String(r?.entity || '') })).filter((r: any) => r.field && r.entity) : [],
      }))
    : [];
  if (!entities.length) throw new Error('Define at least one entity (name, count, pk, fields).');

  const seed = Number.isFinite(Number(opts.seed)) ? Number(opts.seed) >>> 0 : 20260101;
  const rng = mulberry32(seed);
  const { order, cyclic } = topoOrder(entities);
  const notes: string[] = [];
  if (cyclic.length) notes.push(`Cyclic references detected (${[...new Set(cyclic)].join(', ')}) — those FKs may reference rows generated in the same pass.`);
  const byName = new Map(entities.map((e) => [e.name, e]));

  const out: Record<string, Record<string, unknown>[]> = {};
  const pkValues: Record<string, unknown[]> = {};

  for (const name of order) {
    const e = byName.get(name)!;
    const rows: Record<string, unknown>[] = [];
    const pkField: SynthField = { name: e.pk, type: /uuid|guid/i.test(e.pk) ? 'uuid' : 'int', min: 1, max: 1_000_000 };
    const refFieldNames = new Set((e.refs || []).map((r) => r.field));
    for (let i = 0; i < e.count; i++) {
      const row: Record<string, unknown> = {};
      // Primary key: sequential ints stay unique & readable; uuids are random.
      row[e.pk] = pkField.type === 'uuid' ? genValue(pkField, rng) : i + 1;
      for (const f of e.fields) {
        if (f.name === e.pk || refFieldNames.has(f.name)) continue;
        row[f.name] = genValue(f, rng);
      }
      // Foreign keys: pick an existing parent PK (referential integrity).
      for (const r of e.refs || []) {
        const parentPks = pkValues[r.entity];
        if (parentPks && parentPks.length) row[r.field] = parentPks[Math.floor(rng() * parentPks.length)];
        else { row[r.field] = null; }
      }
      rows.push(row);
    }
    out[name] = rows;
    pkValues[name] = rows.map((r) => r[e.pk]);
  }

  const summary = order.map((name) => {
    const e = byName.get(name)!;
    return { entity: name, rows: out[name]?.length || 0, refs: (e.refs || []).map((r) => `${r.field}→${r.entity}`) };
  });
  // Flag FKs that pointed at an empty / missing parent.
  for (const name of order) {
    const e = byName.get(name)!;
    for (const r of e.refs || []) if (!byName.has(r.entity)) notes.push(`${name}.${r.field} references unknown entity "${r.entity}" — left null.`);
  }
  return { entities: out, order, seed, summary, notes: [...new Set(notes)].slice(0, 20) };
}

/* ────────────────────────────────────────────────────────────────
   2. Production subsetting (referentially consistent)
   ──────────────────────────────────────────────────────────────── */

export interface Relationship { child: string; childField: string; parent: string; parentKey: string }
export interface SubsetResult {
  tables: Record<string, Record<string, unknown>[]>;
  summary: { table: string; before: number; after: number }[];
  notes: string[];
}

export function subsetDatasets(input: {
  tables: Record<string, Record<string, unknown>[]>;
  relationships?: Relationship[];
  root: string;
  size?: number;        // absolute rows to keep from the root
  fraction?: number;    // or a 0–1 fraction of root rows
  seed?: number;
}): SubsetResult {
  const tables = input.tables || {};
  const names = Object.keys(tables);
  if (!names.length) throw new Error('Provide at least one table of rows.');
  const root = input.root && tables[input.root] ? input.root : names[0]!;
  const rels = (input.relationships || []).filter((r) => tables[r.child] && tables[r.parent]);
  const seed = Number.isFinite(Number(input.seed)) ? Number(input.seed) >>> 0 : 20260101;
  const rng = mulberry32(seed);
  const notes: string[] = [];

  const rootRows = tables[root] || [];
  let keep = input.size != null ? Math.floor(Number(input.size)) : input.fraction != null ? Math.ceil(rootRows.length * Math.min(1, Math.max(0, Number(input.fraction)))) : Math.ceil(rootRows.length * 0.1);
  keep = Math.min(rootRows.length, Math.max(0, keep));

  // Deterministic sample of the root table (Fisher–Yates prefix).
  const idx = rootRows.map((_, i) => i);
  for (let i = idx.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [idx[i], idx[j]] = [idx[j]!, idx[i]!]; }
  const keptIdx = new Set(idx.slice(0, keep));

  const result: Record<string, Record<string, unknown>[]> = {};
  for (const name of names) result[name] = name === root ? rootRows.filter((_, i) => keptIdx.has(i)) : [];

  // Propagate: keep child rows whose FK value is present in the already-kept parent's key set.
  // Iterate to a fixed point so multi-level chains (root → a → b) resolve.
  const keyset = (table: string, keyField: string): Set<string> => new Set((result[table] || []).map((r) => String(r[keyField])));
  let changed = true; let guard = 0;
  while (changed && guard++ < names.length + 2) {
    changed = false;
    for (const r of rels) {
      const parentKeys = keyset(r.parent, r.parentKey);
      if (!parentKeys.size && r.parent !== root) continue;
      const before = result[r.child]!.length;
      const kept = (tables[r.child] || []).filter((row) => parentKeys.has(String(row[r.childField])));
      // merge (dedup by JSON) with anything already kept for this child
      const seen = new Set(result[r.child]!.map((x) => JSON.stringify(x)));
      for (const row of kept) { const k = JSON.stringify(row); if (!seen.has(k)) { result[r.child]!.push(row); seen.add(k); changed = true; } }
      if (result[r.child]!.length !== before) changed = true;
    }
  }

  for (const name of names) if (name !== root && !rels.some((r) => r.child === name)) notes.push(`"${name}" has no relationship to the subset — kept 0 rows (add a relationship to include it).`);
  const summary = names.map((name) => ({ table: name, before: (tables[name] || []).length, after: (result[name] || []).length }));
  return { tables: result, summary, notes: [...new Set(notes)].slice(0, 20) };
}

/* ────────────────────────────────────────────────────────────────
   3. Dataset versioning
   ──────────────────────────────────────────────────────────────── */

export interface DatasetVersion {
  id: string;
  name: string;
  version: number;
  rowCount: number;
  hash: string;
  notes?: string;
  tables: string[];
  createdBy?: string;
  createdAt: string;
}

function jObj(v: any): Record<string, unknown> {
  if (v && typeof v === 'object' && !Array.isArray(v)) return v;
  if (typeof v === 'string' && v.trim().startsWith('{')) { try { const p = JSON.parse(v); if (p && typeof p === 'object') return p; } catch { /* empty */ } }
  return {};
}

/** djb2 content hash — cheap, stable, enough to tell two snapshots apart. */
function hashData(data: unknown): string {
  const s = JSON.stringify(data);
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return `d${h.toString(16)}-${s.length}`;
}

function countRows(data: Record<string, unknown>): number {
  let n = 0;
  for (const v of Object.values(data)) if (Array.isArray(v)) n += v.length;
  return n;
}

function rowToVersion(r: any, includeTables = false): DatasetVersion {
  const data = jObj(r.data);
  const v: DatasetVersion = {
    id: String(r.id), name: r.name, version: Number(r.version) || 1,
    rowCount: Number(r.row_count) || 0, hash: r.hash || '', notes: r.notes || undefined,
    tables: Object.keys(data), createdBy: r.created_by || undefined, createdAt: r.created_at,
  };
  if (includeTables) (v as any).data = data;
  return v;
}

export async function listDatasetVersions(tenantId: string): Promise<DatasetVersion[]> {
  const { rows } = await pool.query(
    `SELECT id, name, version, data, row_count, hash, notes, created_by, created_at
       FROM api_dataset_versions WHERE tenant_id = $1 ORDER BY name ASC, version DESC`,
    [tenantId],
  );
  return rows.map((r) => rowToVersion(r));
}

export async function getDatasetVersion(tenantId: string, id: string): Promise<(DatasetVersion & { data: Record<string, unknown> }) | null> {
  const { rows } = await pool.query(
    `SELECT id, name, version, data, row_count, hash, notes, created_by, created_at
       FROM api_dataset_versions WHERE tenant_id = $1 AND id = $2`,
    [tenantId, id],
  );
  if (!rows[0]) return null;
  return rowToVersion(rows[0], true) as DatasetVersion & { data: Record<string, unknown> };
}

export async function saveDatasetVersion(tenantId: string, username: string, input: { name?: unknown; data?: unknown; notes?: unknown }): Promise<DatasetVersion> {
  const name = String(input?.name || '').trim().slice(0, 200);
  if (!name) throw new Error('Provide a dataset name.');
  const data = jObj(input?.data);
  if (!Object.keys(data).length) throw new Error('Provide dataset tables to snapshot.');
  // Next version number for this name.
  const { rows: maxRows } = await pool.query(`SELECT MAX(version) AS v FROM api_dataset_versions WHERE tenant_id = $1 AND name = $2`, [tenantId, name]);
  const nextVersion = (Number(maxRows[0]?.v) || 0) + 1;
  const hash = hashData(data);
  const rowCount = countRows(data);
  const { rows } = await pool.query(
    `INSERT INTO api_dataset_versions (tenant_id, name, version, data, row_count, hash, notes, created_by)
     OUTPUT INSERTED.id, INSERTED.name, INSERTED.version, INSERTED.row_count, INSERTED.hash, INSERTED.notes, INSERTED.created_by, INSERTED.created_at
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [tenantId, name, nextVersion, data, rowCount, hash, String(input?.notes || '').slice(0, 2000) || null, username],
  );
  const r = rows[0];
  return { id: String(r.id), name: r.name, version: Number(r.version), rowCount: Number(r.row_count), hash: r.hash, notes: r.notes || undefined, tables: Object.keys(data), createdBy: r.created_by || undefined, createdAt: r.created_at };
}

export async function deleteDatasetVersion(tenantId: string, id: string): Promise<boolean> {
  const { rowCount } = await pool.query(`DELETE FROM api_dataset_versions WHERE tenant_id = $1 AND id = $2`, [tenantId, id]);
  return rowCount > 0;
}

export interface DatasetDiff {
  a: { id: string; name: string; version: number; hash: string };
  b: { id: string; name: string; version: number; hash: string };
  identical: boolean;
  tables: { table: string; beforeRows: number; afterRows: number; rowDelta: number; addedColumns: string[]; removedColumns: string[]; status: 'added' | 'removed' | 'changed' | 'unchanged' }[];
}

function columnsOf(rows: unknown): string[] {
  if (!Array.isArray(rows) || !rows.length) return [];
  const cols = new Set<string>();
  for (const r of rows.slice(0, 50)) if (r && typeof r === 'object') for (const k of Object.keys(r as object)) cols.add(k);
  return [...cols];
}

export async function diffDatasetVersions(tenantId: string, idA: string, idB: string): Promise<DatasetDiff> {
  const a = await getDatasetVersion(tenantId, idA);
  const b = await getDatasetVersion(tenantId, idB);
  if (!a || !b) throw new Error('One or both dataset versions were not found.');
  const tablesSet = new Set([...Object.keys(a.data), ...Object.keys(b.data)]);
  const tables = [...tablesSet].map((table) => {
    const ar = (a.data as any)[table]; const br = (b.data as any)[table];
    const beforeRows = Array.isArray(ar) ? ar.length : 0;
    const afterRows = Array.isArray(br) ? br.length : 0;
    const aCols = columnsOf(ar); const bCols = columnsOf(br);
    const addedColumns = bCols.filter((c) => !aCols.includes(c));
    const removedColumns = aCols.filter((c) => !bCols.includes(c));
    const status: DatasetDiff['tables'][number]['status'] = ar === undefined ? 'added' : br === undefined ? 'removed' : (beforeRows !== afterRows || addedColumns.length || removedColumns.length) ? 'changed' : 'unchanged';
    return { table, beforeRows, afterRows, rowDelta: afterRows - beforeRows, addedColumns, removedColumns, status };
  });
  return {
    a: { id: a.id, name: a.name, version: a.version, hash: a.hash },
    b: { id: b.id, name: b.name, version: b.version, hash: b.hash },
    identical: a.hash === b.hash,
    tables,
  };
}
