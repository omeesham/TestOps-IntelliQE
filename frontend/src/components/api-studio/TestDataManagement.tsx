/**
 * TestDataManagement — Enterprise test-data management.
 *
 * A self-contained modal with three jobs, one per tab:
 *   • Referential — generate relationally-consistent synthetic data from a set
 *     of entity definitions (fields + cross-entity references), seeded so a run
 *     is reproducible.
 *   • Subsetting — carve a small, referentially-intact slice out of a large
 *     production-shaped dataset by following declared child→parent keys.
 *   • Versions — save a generated/subset dataset as an immutable, hashed
 *     version, browse/download/delete versions, and diff any two of them.
 *
 * Opt-in and standalone — no endpoints prop, no pipeline coupling. Every data
 * operation goes through the existing `@/services/api` clients.
 */
import { useState, useEffect } from 'react';
import { Database, X, Plus, Trash2, Boxes, Scissors, History, Download, Save, GitCompareArrows } from 'lucide-react';
import Spinner from '@/components/feedback/Spinner';
import { CARD, STRIP, INPUT, FIELD, LABEL, PRIMARY_BTN, SECONDARY_BTN } from './format';
import { downloadText } from './generators';
import {
  generateReferentialData,
  subsetDatasets,
  listDatasetVersions,
  getDatasetVersion,
  saveDatasetVersion,
  deleteDatasetVersion,
  diffDatasetVersions,
  type RefEntityInput,
  type ReferentialResult,
  type SubsetRelationship,
  type SubsetResult,
  type DatasetVersion,
  type DatasetDiff,
} from '@/services/api';

type TabId = 'referential' | 'subset' | 'versions';

/** Common synthetic field generators — a select of these, free text also fine. */
const FIELD_TYPES: string[] = [
  'firstName', 'lastName', 'fullName', 'email', 'phone', 'uuid', 'int', 'float',
  'bool', 'date', 'datetime', 'city', 'country', 'company', 'word', 'sentence',
  'url', 'ipv4', 'currency', 'enum', 'ssn', 'creditCard', 'string',
];

const DEFAULT_TABLES = `{
  "users": [
    { "id": 1, "name": "Ada", "country": "UK" },
    { "id": 2, "name": "Lin", "country": "SG" },
    { "id": 3, "name": "Mo", "country": "US" }
  ],
  "orders": [
    { "id": 10, "userId": 1, "total": 42 },
    { "id": 11, "userId": 2, "total": 19 },
    { "id": 12, "userId": 1, "total": 7 },
    { "id": 13, "userId": 3, "total": 88 }
  ]
}`;

function cellText(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

function statusCls(status: DatasetDiff['tables'][number]['status']): string {
  if (status === 'added') return 'text-emerald-700 bg-emerald-50 border-emerald-200';
  if (status === 'removed') return 'text-red-700 bg-red-50 border-red-200';
  if (status === 'changed') return 'text-amber-700 bg-amber-50 border-amber-200';
  return 'text-gray-600 bg-gray-50 border-gray-200';
}

export default function TestDataManagement({ onClose }: { onClose: () => void }) {
  const [tab, setTab] = useState<TabId>('referential');

  /* ── Tab 1: referential ── */
  const [entities, setEntities] = useState<RefEntityInput[]>([
    {
      name: 'users',
      count: 10,
      pk: 'id',
      fields: [
        { name: 'id', type: 'uuid' },
        { name: 'email', type: 'email' },
        { name: 'country', type: 'country' },
      ],
      refs: [],
    },
    {
      name: 'orders',
      count: 25,
      pk: 'id',
      fields: [
        { name: 'id', type: 'uuid' },
        { name: 'userId', type: 'uuid' },
        { name: 'total', type: 'float', min: 1, max: 500 },
      ],
      refs: [{ field: 'userId', entity: 'users' }],
    },
  ]);
  const [seed, setSeed] = useState<string>('');
  const [refResult, setRefResult] = useState<ReferentialResult | null>(null);
  const [refLoading, setRefLoading] = useState<boolean>(false);
  const [refError, setRefError] = useState<string>('');

  /* ── Tab 2: subsetting ── */
  const [tablesText, setTablesText] = useState<string>(DEFAULT_TABLES);
  const [relationships, setRelationships] = useState<SubsetRelationship[]>([
    { child: 'orders', childField: 'userId', parent: 'users', parentKey: 'id' },
  ]);
  const [root, setRoot] = useState<string>('users');
  const [subSize, setSubSize] = useState<string>('');
  const [subFraction, setSubFraction] = useState<string>('0.5');
  const [subSeed, setSubSeed] = useState<string>('');
  const [subResult, setSubResult] = useState<SubsetResult | null>(null);
  const [subLoading, setSubLoading] = useState<boolean>(false);
  const [subError, setSubError] = useState<string>('');

  /* ── Tab 3: versions ── */
  const [versions, setVersions] = useState<DatasetVersion[]>([]);
  const [vLoading, setVLoading] = useState<boolean>(false);
  const [vError, setVError] = useState<string>('');
  const [viewing, setViewing] = useState<DatasetVersion | null>(null);
  const [viewLoading, setViewLoading] = useState<boolean>(false);
  const [diffA, setDiffA] = useState<string>('');
  const [diffB, setDiffB] = useState<string>('');
  const [diff, setDiff] = useState<DatasetDiff | null>(null);
  const [diffLoading, setDiffLoading] = useState<boolean>(false);

  const loadVersions = async () => {
    setVLoading(true); setVError('');
    try {
      const res = await listDatasetVersions();
      setVersions(res.versions || []);
    } catch (err: any) {
      setVError(err?.response?.data?.error || err?.message || 'Failed to load dataset versions.');
    } finally {
      setVLoading(false);
    }
  };

  useEffect(() => { void loadVersions(); }, []);
  useEffect(() => { if (tab === 'versions') void loadVersions(); }, [tab]);

  /* ── Entity editing helpers (immutable) ── */
  const setEntity = (ei: number, next: RefEntityInput) =>
    setEntities((prev) => prev.map((e, i) => (i === ei ? next : e)));
  const addEntity = () =>
    setEntities((prev) => [...prev, { name: '', count: 10, pk: 'id', fields: [], refs: [] }]);
  const removeEntity = (ei: number) =>
    setEntities((prev) => prev.filter((_, i) => i !== ei));
  const patchField = (ei: number, fi: number, patch: Partial<RefEntityInput['fields'][number]>) =>
    setEntities((prev) => prev.map((e, i) => (i === ei
      ? { ...e, fields: e.fields.map((f, j) => (j === fi ? { ...f, ...patch } : f)) }
      : e)));
  const addField = (ei: number) =>
    setEntities((prev) => prev.map((e, i) => (i === ei ? { ...e, fields: [...e.fields, { name: '', type: 'string' }] } : e)));
  const removeField = (ei: number, fi: number) =>
    setEntities((prev) => prev.map((e, i) => (i === ei ? { ...e, fields: e.fields.filter((_, j) => j !== fi) } : e)));
  const patchRef = (ei: number, ri: number, patch: Partial<{ field: string; entity: string }>) =>
    setEntities((prev) => prev.map((e, i) => (i === ei
      ? { ...e, refs: (e.refs || []).map((r, j) => (j === ri ? { ...r, ...patch } : r)) }
      : e)));
  const addRef = (ei: number) =>
    setEntities((prev) => prev.map((e, i) => (i === ei ? { ...e, refs: [...(e.refs || []), { field: '', entity: '' }] } : e)));
  const removeRef = (ei: number, ri: number) =>
    setEntities((prev) => prev.map((e, i) => (i === ei ? { ...e, refs: (e.refs || []).filter((_, j) => j !== ri) } : e)));

  /* ── Relationship editing helpers ── */
  const addRel = () =>
    setRelationships((prev) => [...prev, { child: '', childField: '', parent: '', parentKey: '' }]);
  const removeRel = (i: number) =>
    setRelationships((prev) => prev.filter((_, j) => j !== i));
  const patchRel = (i: number, patch: Partial<SubsetRelationship>) =>
    setRelationships((prev) => prev.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  /* ── Table names parsed best-effort from the Tables JSON (populates selects) ── */
  const tableNames: string[] = (() => {
    try {
      const o: unknown = JSON.parse(tablesText);
      if (o && typeof o === 'object' && !Array.isArray(o)) return Object.keys(o as Record<string, unknown>);
    } catch { /* ignore — reported on run */ }
    return [];
  })();

  /* ── Runs ── */
  const runReferential = async () => {
    setRefLoading(true); setRefError(''); setRefResult(null);
    try {
      const seedNum = seed.trim() ? Number(seed) : undefined;
      setRefResult(await generateReferentialData(entities, seedNum));
    } catch (err: any) {
      setRefError(err?.response?.data?.error || err?.message || 'Generation failed.');
    } finally {
      setRefLoading(false);
    }
  };

  const runSubset = async () => {
    setSubLoading(true); setSubError(''); setSubResult(null);
    let tables: Record<string, Record<string, unknown>[]>;
    try {
      const parsed: unknown = JSON.parse(tablesText);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('Tables must be a JSON object of { tableName: rows[] }.');
      }
      tables = parsed as Record<string, Record<string, unknown>[]>;
    } catch (err: any) {
      setSubError(err?.message || 'Invalid tables JSON.');
      setSubLoading(false);
      return;
    }
    try {
      const sizeNum = subSize.trim() ? Number(subSize) : undefined;
      const fractionNum = subFraction.trim() ? Number(subFraction) : undefined;
      const seedNum = subSeed.trim() ? Number(subSeed) : undefined;
      setSubResult(await subsetDatasets({ tables, relationships, root, size: sizeNum, fraction: fractionNum, seed: seedNum }));
    } catch (err: any) {
      setSubError(err?.response?.data?.error || err?.message || 'Subset failed.');
    } finally {
      setSubLoading(false);
    }
  };

  const viewVersion = async (id: string) => {
    setViewLoading(true); setVError('');
    try {
      setViewing(await getDatasetVersion(id));
    } catch (err: any) {
      setVError(err?.response?.data?.error || err?.message || 'Failed to load version.');
    } finally {
      setViewLoading(false);
    }
  };

  const removeVersion = async (id: string) => {
    setVError('');
    try {
      await deleteDatasetVersion(id);
      if (viewing?.id === id) setViewing(null);
      if (diffA === id) setDiffA('');
      if (diffB === id) setDiffB('');
      await loadVersions();
    } catch (err: any) {
      setVError(err?.response?.data?.error || err?.message || 'Delete failed.');
    }
  };

  const runDiff = async () => {
    if (!diffA || !diffB) return;
    setDiffLoading(true); setVError(''); setDiff(null);
    try {
      setDiff(await diffDatasetVersions(diffA, diffB));
    } catch (err: any) {
      setVError(err?.response?.data?.error || err?.message || 'Diff failed.');
    } finally {
      setDiffLoading(false);
    }
  };

  const tabCls = (id: TabId) =>
    `inline-flex items-center gap-1.5 text-[12px] rounded-md px-3 py-1.5 transition-colors ${
      tab === id ? 'bg-[#7C3AED] text-white' : 'bg-white text-gray-600 border border-gray-200 hover:text-[#7C3AED]'
    }`;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-[#1E1B4B]/45 backdrop-blur-md p-4" onClick={onClose}>
      <div className={`${CARD} w-full max-w-4xl max-h-[88vh] flex flex-col overflow-hidden`} onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className={`flex items-center gap-2 px-4 h-12 border-b border-[#EDE9FE] flex-shrink-0 ${STRIP}`}>
          <Database className="w-4 h-4 text-[#7C3AED]" />
          <h3 className="text-[13px] font-semibold text-gray-900">Test data management</h3>
          <span className="text-[11px] text-gray-400">Referential · subsetting · versioning</span>
          <button type="button" onClick={onClose} className="ml-auto p-1.5 rounded-md text-gray-400 hover:text-[#7C3AED] hover:bg-[#F5F3FF]"><X className="w-4 h-4" /></button>
        </div>

        {/* Tabs */}
        <div className="flex items-center gap-1.5 px-4 py-2 border-b border-[#EDE9FE] flex-shrink-0">
          <button type="button" onClick={() => setTab('referential')} className={tabCls('referential')}><Boxes className="w-3.5 h-3.5" />Referential</button>
          <button type="button" onClick={() => setTab('subset')} className={tabCls('subset')}><Scissors className="w-3.5 h-3.5" />Subsetting</button>
          <button type="button" onClick={() => setTab('versions')} className={tabCls('versions')}><History className="w-3.5 h-3.5" />Versions</button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto min-h-0 p-4">
          {/* ───────────── Tab 1: Referential ───────────── */}
          {tab === 'referential' && (
            <div className="space-y-3">
              <ErrorBox msg={refError} />

              <div className="flex flex-wrap items-end gap-2">
                <div>
                  <label className={LABEL}>Seed (optional)</label>
                  <input type="number" value={seed} onChange={(e) => setSeed(e.target.value)} placeholder="auto" className={`${FIELD} w-28`} />
                </div>
                <div className="ml-auto flex items-center gap-2">
                  <button type="button" onClick={addEntity} className={SECONDARY_BTN}><Plus className="w-3.5 h-3.5" />Add entity</button>
                  <button type="button" onClick={() => void runReferential()} disabled={refLoading || entities.length === 0} className={PRIMARY_BTN}>
                    {refLoading ? <Spinner className="w-3.5 h-3.5" /> : <Boxes className="w-3.5 h-3.5" />}Generate
                  </button>
                </div>
              </div>

              <div className="space-y-2">
                {entities.length === 0 && <div className="text-[11px] text-gray-400">No entities — add one to define a dataset.</div>}
                {entities.map((ent, ei) => (
                  <div key={ei} className="rounded-lg border border-[#E9E5FB] bg-[#FCFBFF] p-3 space-y-2">
                    <div className="flex flex-wrap items-end gap-2">
                      <div>
                        <label className={LABEL}>Entity</label>
                        <input value={ent.name} onChange={(e) => setEntity(ei, { ...ent, name: e.target.value })} placeholder="name" className={`${FIELD} w-40`} />
                      </div>
                      <div>
                        <label className={LABEL}>Rows</label>
                        <input type="number" min={0} value={ent.count} onChange={(e) => setEntity(ei, { ...ent, count: Number(e.target.value) || 0 })} className={`${FIELD} w-24`} />
                      </div>
                      <div>
                        <label className={LABEL}>PK</label>
                        <input value={ent.pk} onChange={(e) => setEntity(ei, { ...ent, pk: e.target.value })} placeholder="id" className={`${FIELD} w-24`} />
                      </div>
                      <button type="button" onClick={() => removeEntity(ei)} className="ml-auto p-1.5 rounded-md text-gray-400 hover:text-red-500 hover:bg-red-50"><Trash2 className="w-3.5 h-3.5" /></button>
                    </div>

                    {/* Fields */}
                    <div className="space-y-1.5">
                      <div className="flex items-center justify-between">
                        <span className="text-[10.5px] font-semibold uppercase tracking-wide text-gray-500">Fields</span>
                        <button type="button" onClick={() => addField(ei)} className="inline-flex items-center gap-1 text-[11px] text-[#6D28D9] hover:text-[#5B21B6]"><Plus className="w-3 h-3" />field</button>
                      </div>
                      {ent.fields.length === 0 && <div className="text-[10.5px] text-gray-400">No fields yet.</div>}
                      {ent.fields.map((f, fi) => (
                        <div key={fi} className="flex flex-wrap items-center gap-1.5">
                          <input value={f.name} onChange={(e) => patchField(ei, fi, { name: e.target.value })} placeholder="field" className={`${FIELD} w-28`} />
                          <select value={f.type} onChange={(e) => patchField(ei, fi, { type: e.target.value })} className={`${FIELD} w-32`}>
                            {FIELD_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
                          </select>
                          {(f.type === 'int' || f.type === 'float') && (
                            <>
                              <input type="number" value={f.min ?? ''} onChange={(e) => patchField(ei, fi, { min: e.target.value === '' ? undefined : Number(e.target.value) })} placeholder="min" className={`${FIELD} w-20`} />
                              <input type="number" value={f.max ?? ''} onChange={(e) => patchField(ei, fi, { max: e.target.value === '' ? undefined : Number(e.target.value) })} placeholder="max" className={`${FIELD} w-20`} />
                            </>
                          )}
                          {f.type === 'enum' && (
                            <input value={(f.options || []).join(', ')} onChange={(e) => patchField(ei, fi, { options: e.target.value.split(',').map((s) => s.trim()).filter(Boolean) })} placeholder="options (comma-sep)" className={`${FIELD} w-52`} />
                          )}
                          <button type="button" onClick={() => removeField(ei, fi)} className="p-1 text-gray-400 hover:text-red-500"><Trash2 className="w-3.5 h-3.5" /></button>
                        </div>
                      ))}
                    </div>

                    {/* References */}
                    <div className="space-y-1.5">
                      <div className="flex items-center justify-between">
                        <span className="text-[10.5px] font-semibold uppercase tracking-wide text-gray-500">References</span>
                        <button type="button" onClick={() => addRef(ei)} className="inline-flex items-center gap-1 text-[11px] text-[#6D28D9] hover:text-[#5B21B6]"><Plus className="w-3 h-3" />ref</button>
                      </div>
                      {(ent.refs || []).length === 0 && <div className="text-[10.5px] text-gray-400">No references — this entity stands alone.</div>}
                      {(ent.refs || []).map((r, ri) => (
                        <div key={ri} className="flex flex-wrap items-center gap-1.5">
                          <input value={r.field} onChange={(e) => patchRef(ei, ri, { field: e.target.value })} placeholder="field" className={`${FIELD} w-28`} />
                          <span className="text-[11px] text-gray-400">references</span>
                          <select value={r.entity} onChange={(e) => patchRef(ei, ri, { entity: e.target.value })} className={`${FIELD} w-36`}>
                            <option value="">entity…</option>
                            {entities.filter((o, oi) => oi !== ei && o.name.trim()).map((o) => <option key={o.name} value={o.name}>{o.name}</option>)}
                          </select>
                          <button type="button" onClick={() => removeRef(ei, ri)} className="p-1 text-gray-400 hover:text-red-500"><Trash2 className="w-3.5 h-3.5" /></button>
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>

              {refResult && (
                <div className="space-y-3 pt-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <button type="button" onClick={() => downloadText('referential.json', JSON.stringify(refResult.entities, null, 2))} className={SECONDARY_BTN}><Download className="w-3.5 h-3.5" />Download JSON</button>
                    <SaveVersion data={refResult.entities} onSaved={() => void loadVersions()} />
                    <span className="ml-auto text-[11px] text-gray-400 tabular-nums">seed {refResult.seed}</span>
                  </div>

                  <div className="space-y-1.5">
                    {refResult.summary.map((s) => (
                      <div key={s.entity} className="flex flex-wrap items-center gap-2">
                        <span className="font-mono text-[12px] font-semibold text-gray-800">{s.entity}</span>
                        <span className="text-[11px] text-gray-500 tabular-nums">{s.rows} rows</span>
                        {s.refs.map((r) => <span key={r} className="inline-flex items-center px-1.5 py-0.5 rounded border text-[10px] text-[#6D28D9] bg-[#F5F3FF] border-[#DDD6FE] font-mono">{r}</span>)}
                      </div>
                    ))}
                  </div>

                  {refResult.notes.length > 0 && (
                    <ul className="space-y-0.5">{refResult.notes.map((n, i) => <li key={i} className="text-[11px] text-gray-500">{n}</li>)}</ul>
                  )}

                  {refResult.order.map((name) => (
                    <div key={name}>
                      <div className="text-[11px] font-semibold text-gray-600 mb-1">{name}</div>
                      <PreviewTable rows={refResult.entities[name] || []} />
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* ───────────── Tab 2: Subsetting ───────────── */}
          {tab === 'subset' && (
            <div className="space-y-3">
              <ErrorBox msg={subError} />

              <div>
                <label className={LABEL}>Tables (JSON object of rows)</label>
                <textarea value={tablesText} onChange={(e) => setTablesText(e.target.value)} spellCheck={false} placeholder='{ "users": [ { "id": 1 } ] }' className={`${FIELD} w-full h-44 font-mono text-[11px] resize-none`} />
              </div>

              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <label className={LABEL}>Relationships (child → parent)</label>
                  <button type="button" onClick={addRel} className={SECONDARY_BTN}><Plus className="w-3.5 h-3.5" />Add</button>
                </div>
                {relationships.length === 0 && <div className="text-[11px] text-gray-400">No relationships — tables are subset independently.</div>}
                {relationships.map((r, i) => (
                  <div key={i} className="flex flex-wrap items-center gap-1.5">
                    <select value={r.child} onChange={(e) => patchRel(i, { child: e.target.value })} className={`${FIELD} w-32`}>
                      <option value="">child…</option>
                      {tableNames.map((t) => <option key={t} value={t}>{t}</option>)}
                    </select>
                    <input value={r.childField} onChange={(e) => patchRel(i, { childField: e.target.value })} placeholder="childField" className={`${FIELD} w-28`} />
                    <span className="text-[11px] text-gray-400">→</span>
                    <select value={r.parent} onChange={(e) => patchRel(i, { parent: e.target.value })} className={`${FIELD} w-32`}>
                      <option value="">parent…</option>
                      {tableNames.map((t) => <option key={t} value={t}>{t}</option>)}
                    </select>
                    <input value={r.parentKey} onChange={(e) => patchRel(i, { parentKey: e.target.value })} placeholder="parentKey" className={`${FIELD} w-28`} />
                    <button type="button" onClick={() => removeRel(i)} className="p-1 text-gray-400 hover:text-red-500"><Trash2 className="w-3.5 h-3.5" /></button>
                  </div>
                ))}
              </div>

              <div className="flex flex-wrap items-end gap-2">
                <div>
                  <label className={LABEL}>Root table</label>
                  <select value={root} onChange={(e) => setRoot(e.target.value)} className={`${FIELD} w-40`}>
                    <option value="">select…</option>
                    {tableNames.map((t) => <option key={t} value={t}>{t}</option>)}
                  </select>
                </div>
                <div>
                  <label className={LABEL}>Size (rows)</label>
                  <input type="number" min={0} value={subSize} onChange={(e) => setSubSize(e.target.value)} placeholder="e.g. 50" className={`${FIELD} w-24`} />
                </div>
                <div>
                  <label className={LABEL}>Fraction (0–1)</label>
                  <input type="number" step="0.01" min={0} max={1} value={subFraction} onChange={(e) => setSubFraction(e.target.value)} placeholder="e.g. 0.1" className={`${FIELD} w-24`} />
                </div>
                <div>
                  <label className={LABEL}>Seed</label>
                  <input type="number" value={subSeed} onChange={(e) => setSubSeed(e.target.value)} placeholder="auto" className={`${FIELD} w-24`} />
                </div>
                <button type="button" onClick={() => void runSubset()} disabled={subLoading || !root} className={`${PRIMARY_BTN} ml-auto`}>
                  {subLoading ? <Spinner className="w-3.5 h-3.5" /> : <Scissors className="w-3.5 h-3.5" />}Subset
                </button>
              </div>

              {subResult && (
                <div className="space-y-3 pt-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <button type="button" onClick={() => downloadText('subset.json', JSON.stringify(subResult.tables, null, 2))} className={SECONDARY_BTN}><Download className="w-3.5 h-3.5" />Download JSON</button>
                    <SaveVersion data={subResult.tables} onSaved={() => void loadVersions()} />
                  </div>

                  <div className="overflow-auto rounded-lg border border-gray-100">
                    <table className="w-full text-[11px]">
                      <thead className="bg-gray-50">
                        <tr>
                          <th className="text-left font-semibold text-gray-500 px-2 py-1">Table</th>
                          <th className="text-right font-semibold text-gray-500 px-2 py-1">Before</th>
                          <th className="text-right font-semibold text-gray-500 px-2 py-1">After</th>
                        </tr>
                      </thead>
                      <tbody>
                        {subResult.summary.map((s) => (
                          <tr key={s.table} className="border-t border-gray-50">
                            <td className="px-2 py-1 font-mono text-gray-700">{s.table}</td>
                            <td className="px-2 py-1 text-right tabular-nums text-gray-600">{s.before}</td>
                            <td className="px-2 py-1 text-right tabular-nums text-gray-800 font-semibold">{s.after}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>

                  {subResult.notes.length > 0 && (
                    <ul className="space-y-0.5">{subResult.notes.map((n, i) => <li key={i} className="text-[11px] text-gray-500">{n}</li>)}</ul>
                  )}

                  {Object.keys(subResult.tables).map((name) => (
                    <div key={name}>
                      <div className="text-[11px] font-semibold text-gray-600 mb-1">{name}</div>
                      <PreviewTable rows={subResult.tables[name] || []} />
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* ───────────── Tab 3: Versions ───────────── */}
          {tab === 'versions' && (
            <div className="space-y-4">
              <ErrorBox msg={vError} />

              {/* Diff */}
              <div className={`rounded-lg border border-[#E9E5FB] p-3 space-y-2 ${STRIP}`}>
                <div className="text-[11px] font-semibold text-gray-600">Compare two versions</div>
                <div className="flex flex-wrap items-center gap-2">
                  <select value={diffA} onChange={(e) => setDiffA(e.target.value)} className={`${FIELD} w-48`}>
                    <option value="">Version A…</option>
                    {versions.map((v) => <option key={v.id} value={v.id}>{v.name} v{v.version}</option>)}
                  </select>
                  <GitCompareArrows className="w-4 h-4 text-[#7C3AED]" />
                  <select value={diffB} onChange={(e) => setDiffB(e.target.value)} className={`${FIELD} w-48`}>
                    <option value="">Version B…</option>
                    {versions.map((v) => <option key={v.id} value={v.id}>{v.name} v{v.version}</option>)}
                  </select>
                  <button type="button" onClick={() => void runDiff()} disabled={diffLoading || !diffA || !diffB} className={PRIMARY_BTN}>
                    {diffLoading ? <Spinner className="w-3.5 h-3.5" /> : <GitCompareArrows className="w-3.5 h-3.5" />}Diff
                  </button>
                </div>
                {diff && <DiffView diff={diff} />}
              </div>

              {/* List */}
              {vLoading ? (
                <div className="flex items-center gap-2 text-[12px] text-gray-400"><Spinner className="w-4 h-4" />Loading versions…</div>
              ) : versions.length === 0 ? (
                <div className="text-[12px] text-gray-400">No saved dataset versions yet. Generate or subset data, then save it as a version.</div>
              ) : (
                <div className="space-y-2">
                  {versions.map((v) => (
                    <div key={v.id} className="rounded-lg border border-[#E9E5FB] bg-[#FCFBFF] p-3">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-[12px] font-semibold text-gray-800">{v.name}</span>
                        <span className="inline-flex items-center px-1.5 py-0.5 rounded border text-[10px] text-[#6D28D9] bg-[#F5F3FF] border-[#DDD6FE] tabular-nums">v{v.version}</span>
                        <span className="text-[11px] text-gray-500 tabular-nums">{v.rowCount} rows</span>
                        {v.tables.map((t) => <span key={t} className="inline-flex items-center px-1.5 py-0.5 rounded border text-[10px] text-gray-600 bg-gray-50 border-gray-200 font-mono">{t}</span>)}
                        <span className="ml-auto flex items-center gap-1.5">
                          <button type="button" onClick={() => void viewVersion(v.id)} className={SECONDARY_BTN}>View</button>
                          <button type="button" onClick={() => void removeVersion(v.id)} className="p-1.5 rounded-md text-gray-400 hover:text-red-500 hover:bg-red-50"><Trash2 className="w-3.5 h-3.5" /></button>
                        </span>
                      </div>
                      <div className="mt-1 flex flex-wrap items-center gap-2 text-[10.5px] text-gray-400">
                        <span className="font-mono truncate max-w-[18rem]" title={v.hash}>{v.hash}</span>
                        <span>{new Date(v.createdAt).toLocaleString()}</span>
                        {v.createdBy && <span>· {v.createdBy}</span>}
                      </div>
                      {v.notes && <p className="mt-1 text-[11px] text-gray-600">{v.notes}</p>}

                      {viewing?.id === v.id && (
                        <div className="mt-2 space-y-2">
                          <div className="flex items-center gap-2">
                            <button type="button" onClick={() => downloadText(`${viewing.name}.json`, JSON.stringify(viewing.data ?? {}, null, 2))} className={SECONDARY_BTN}><Download className="w-3.5 h-3.5" />Download</button>
                            <button type="button" onClick={() => setViewing(null)} className="text-[11px] font-semibold text-[#6D28D9] hover:text-[#5B21B6]">Hide</button>
                          </div>
                          <pre className="max-h-72 overflow-auto rounded-lg border border-gray-100 bg-gray-50 p-2 text-[10.5px] font-mono text-gray-700 whitespace-pre-wrap break-words">{JSON.stringify(viewing.data ?? {}, null, 2)}</pre>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}

              {viewLoading && <div className="flex items-center gap-2 text-[11px] text-gray-400"><Spinner className="w-3.5 h-3.5" />Loading version…</div>}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/* ── Small, local building blocks ── */

function ErrorBox({ msg }: { msg: string }) {
  if (!msg) return null;
  return <div className="px-3 py-2 bg-red-50 border border-red-200 rounded-lg text-[12px] text-red-700 whitespace-pre-wrap break-words">{msg}</div>;
}

function PreviewTable({ rows }: { rows: Record<string, unknown>[] }) {
  const sample = rows.slice(0, 10);
  if (sample.length === 0) return <div className="text-[11px] text-gray-400">No rows.</div>;
  const cols = Object.keys(sample[0]);
  return (
    <div className="overflow-auto max-h-56 rounded-lg border border-gray-100">
      <table className="w-full text-[11px]">
        <thead className="bg-gray-50">
          <tr>{cols.map((c) => <th key={c} className="text-left font-semibold text-gray-500 px-2 py-1 whitespace-nowrap">{c}</th>)}</tr>
        </thead>
        <tbody>
          {sample.map((row, ri) => (
            <tr key={ri} className="border-t border-gray-50">
              {cols.map((c) => {
                const text = cellText(row[c]);
                return <td key={c} className="px-2 py-1 text-gray-700 font-mono tabular-nums whitespace-nowrap max-w-[14rem] truncate" title={text}>{text}</td>;
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function SaveVersion({ data, onSaved }: { data: Record<string, unknown>; onSaved: () => void }) {
  const [open, setOpen] = useState<boolean>(false);
  const [name, setName] = useState<string>('');
  const [notes, setNotes] = useState<string>('');
  const [busy, setBusy] = useState<boolean>(false);
  const [err, setErr] = useState<string>('');
  const [done, setDone] = useState<string>('');

  const save = async () => {
    if (!name.trim()) return;
    setBusy(true); setErr('');
    try {
      const v = await saveDatasetVersion({ name: name.trim(), data, notes: notes.trim() || undefined });
      setDone(`Saved ${v.name} v${v.version}`);
      setOpen(false); setName(''); setNotes('');
      onSaved();
    } catch (e: any) {
      setErr(e?.response?.data?.error || e?.message || 'Save failed.');
    } finally {
      setBusy(false);
    }
  };

  if (!open) {
    return (
      <span className="inline-flex items-center gap-2">
        <button type="button" onClick={() => { setOpen(true); setDone(''); }} className={SECONDARY_BTN}><Save className="w-3.5 h-3.5" />Save as dataset version</button>
        {done && <span className="text-[11px] text-emerald-600">{done}</span>}
      </span>
    );
  }

  return (
    <div className="w-full space-y-2 rounded-lg border border-[#E9E5FB] bg-[#FCFBFF] p-2">
      <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Version name" className={INPUT} />
      <textarea value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Notes (optional)" className={`${FIELD} w-full h-16 text-[11px] resize-none`} />
      {err && <div className="text-[11px] text-red-600 whitespace-pre-wrap break-words">{err}</div>}
      <div className="flex items-center gap-2">
        <button type="button" onClick={() => void save()} disabled={busy || !name.trim()} className={PRIMARY_BTN}>
          {busy ? <Spinner className="w-3.5 h-3.5" /> : <Save className="w-3.5 h-3.5" />}Save
        </button>
        <button type="button" onClick={() => { setOpen(false); setErr(''); }} className={SECONDARY_BTN}>Cancel</button>
      </div>
    </div>
  );
}

function DiffView({ diff }: { diff: DatasetDiff }) {
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2 text-[11px]">
        <span className={`inline-flex items-center px-2 py-0.5 rounded border text-[10px] font-semibold ${diff.identical ? 'text-emerald-700 bg-emerald-50 border-emerald-200' : 'text-amber-700 bg-amber-50 border-amber-200'}`}>
          {diff.identical ? 'identical' : 'differs'}
        </span>
        <span className="text-gray-500 tabular-nums">{diff.a.name} v{diff.a.version} → {diff.b.name} v{diff.b.version}</span>
      </div>
      <div className="overflow-auto rounded-lg border border-gray-100 bg-white">
        <table className="w-full text-[11px]">
          <thead className="bg-gray-50">
            <tr>
              <th className="text-left font-semibold text-gray-500 px-2 py-1">Table</th>
              <th className="text-left font-semibold text-gray-500 px-2 py-1">Status</th>
              <th className="text-right font-semibold text-gray-500 px-2 py-1">Rows</th>
              <th className="text-right font-semibold text-gray-500 px-2 py-1">Δ</th>
              <th className="text-left font-semibold text-gray-500 px-2 py-1">Columns</th>
            </tr>
          </thead>
          <tbody>
            {diff.tables.map((t) => (
              <tr key={t.table} className="border-t border-gray-50 align-top">
                <td className="px-2 py-1 font-mono text-gray-700">{t.table}</td>
                <td className="px-2 py-1"><span className={`inline-flex items-center px-1.5 py-0.5 rounded border text-[10px] font-semibold ${statusCls(t.status)}`}>{t.status}</span></td>
                <td className="px-2 py-1 text-right tabular-nums text-gray-600">{t.beforeRows} → {t.afterRows}</td>
                <td className={`px-2 py-1 text-right tabular-nums font-semibold ${t.rowDelta > 0 ? 'text-emerald-600' : t.rowDelta < 0 ? 'text-red-600' : 'text-gray-400'}`}>{t.rowDelta > 0 ? '+' : ''}{t.rowDelta}</td>
                <td className="px-2 py-1">
                  <div className="flex flex-wrap gap-1">
                    {t.addedColumns.map((c) => <span key={`a-${c}`} className="inline-flex items-center px-1 py-0.5 rounded border text-[9.5px] text-emerald-700 bg-emerald-50 border-emerald-200 font-mono">+{c}</span>)}
                    {t.removedColumns.map((c) => <span key={`r-${c}`} className="inline-flex items-center px-1 py-0.5 rounded border text-[9.5px] text-red-700 bg-red-50 border-red-200 font-mono">-{c}</span>)}
                    {t.addedColumns.length === 0 && t.removedColumns.length === 0 && <span className="text-[10px] text-gray-300">—</span>}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
