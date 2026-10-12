/**
 * ApiRegistry — the API Registry / Catalog half of the governance platform.
 *
 * One self-contained modal for the catalogue lifecycle: register APIs, track
 * their draft→published→deprecated→retired state, keep versions with their
 * OpenAPI spec, and diff two versions for breaking changes before a bump ships.
 *
 * Two-way spec sync is realised here as PUSH (publish the live catalogue as a
 * new version via toOpenApi) and PULL (view/download a version's stored spec so
 * it can be re-imported). Opt-in and standalone — nothing else depends on it.
 */
import { useState, useEffect } from 'react';
import {
  Library, X, Plus, Trash2, GitCompareArrows, Upload, Download, Archive,
  CheckCircle2, AlertTriangle, ShieldX,
} from 'lucide-react';
import Spinner from '@/components/feedback/Spinner';
import { CARD, STRIP, INPUT, FIELD, LABEL, PRIMARY_BTN, SECONDARY_BTN } from './format';
import type { CatalogEndpoint } from './types';
import { toOpenApi, downloadText } from './generators';
import {
  listApiRegistry, saveRegistryEntry, setRegistryLifecycle, deleteRegistryEntry,
  listRegistryVersions, addRegistryVersion, getRegistryVersionSpec,
  updateRegistryVersionStatus, deleteRegistryVersion, diffRegistryVersions,
  type RegistryEntry, type RegistryVersion, type Lifecycle, type SpecDiffResult,
} from '@/services/api';

/* ── Lifecycle colour code — gray / emerald / amber / red ── */
const LIFECYCLE: Record<Lifecycle, string> = {
  draft: 'text-gray-600 bg-gray-100 border-gray-300',
  published: 'text-emerald-700 bg-emerald-50 border-emerald-200',
  deprecated: 'text-amber-700 bg-amber-50 border-amber-200',
  retired: 'text-red-700 bg-red-50 border-red-200',
};
const LIFECYCLES: Lifecycle[] = ['draft', 'published', 'deprecated', 'retired'];

interface ApiForm { name: string; owner: string; description: string; tags: string; lifecycle: Lifecycle }
interface VersionForm { version: string; notes: string; spec: string }

const EMPTY_API_FORM: ApiForm = { name: '', owner: '', description: '', tags: '', lifecycle: 'draft' };
const EMPTY_VERSION_FORM: VersionForm = { version: '', notes: '', spec: '' };

const errText = (err: any): string => err?.response?.data?.error || err?.message || 'Request failed.';
const dateVal = (s?: string): string => (s ? s.slice(0, 10) : '');

export default function ApiRegistry({ endpoints, onClose }: { endpoints: CatalogEndpoint[]; onClose: () => void }) {
  const [apis, setApis] = useState<RegistryEntry[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [versions, setVersions] = useState<RegistryVersion[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [versionsLoading, setVersionsLoading] = useState<boolean>(false);
  const [saving, setSaving] = useState<boolean>(false);
  const [rowBusy, setRowBusy] = useState<string>('');
  const [error, setError] = useState<string>('');

  // API register / edit form
  const [apiForm, setApiForm] = useState<ApiForm>(EMPTY_API_FORM);
  const [apiFormOpen, setApiFormOpen] = useState<boolean>(false);
  const [apiFormEditId, setApiFormEditId] = useState<string | null>(null);
  const [confirmDelApi, setConfirmDelApi] = useState<string | null>(null);

  // version add form + spec view + diff
  const [verForm, setVerForm] = useState<VersionForm>(EMPTY_VERSION_FORM);
  const [showVersionForm, setShowVersionForm] = useState<boolean>(false);
  const [specView, setSpecView] = useState<{ version: RegistryVersion; spec: string } | null>(null);
  const [confirmDelVer, setConfirmDelVer] = useState<string | null>(null);
  const [diffA, setDiffA] = useState<string>('');
  const [diffB, setDiffB] = useState<string>('');
  const [diffResult, setDiffResult] = useState<(SpecDiffResult & { a: string; b: string }) | null>(null);
  const [diffBusy, setDiffBusy] = useState<boolean>(false);

  const selected = apis.find((a) => a.id === selectedId) || null;
  const specVersions = versions.filter((v) => v.hasSpec);

  const reload = async () => {
    setLoading(true); setError('');
    try { const r = await listApiRegistry(); setApis(r.apis); }
    catch (err: any) { setError(errText(err)); }
    finally { setLoading(false); }
  };

  useEffect(() => { void reload(); }, []);

  const loadVersions = async (apiId: string) => {
    setVersionsLoading(true); setError('');
    try { const r = await listRegistryVersions(apiId); setVersions(r.versions); }
    catch (err: any) { setError(errText(err)); }
    finally { setVersionsLoading(false); }
  };

  const selectApi = async (id: string) => {
    setSelectedId(id);
    setSpecView(null); setDiffResult(null); setDiffA(''); setDiffB('');
    setShowVersionForm(false); setVerForm(EMPTY_VERSION_FORM); setApiFormOpen(false);
    await loadVersions(id);
  };

  const openNewApiForm = () => { setApiForm(EMPTY_API_FORM); setApiFormEditId(null); setApiFormOpen(true); };
  const openEditApiForm = (a: RegistryEntry) => {
    setApiForm({ name: a.name, owner: a.owner || '', description: a.description || '', tags: (a.tags || []).join(', '), lifecycle: a.lifecycle });
    setApiFormEditId(a.id); setApiFormOpen(true);
  };

  const saveApi = async () => {
    if (!apiForm.name.trim()) return;
    setSaving(true); setError('');
    try {
      const input: Partial<RegistryEntry> = {
        name: apiForm.name.trim(),
        owner: apiForm.owner.trim() || undefined,
        description: apiForm.description.trim() || undefined,
        tags: apiForm.tags.split(',').map((t) => t.trim()).filter(Boolean),
        lifecycle: apiForm.lifecycle,
      };
      if (apiFormEditId) input.id = apiFormEditId;
      const saved = await saveRegistryEntry(input);
      setApiFormOpen(false); setApiFormEditId(null);
      await reload();
      await selectApi(saved.id);
    } catch (err: any) { setError(errText(err)); }
    finally { setSaving(false); }
  };

  const changeLifecycle = async (id: string, lifecycle: Lifecycle) => {
    setError('');
    try { await setRegistryLifecycle(id, lifecycle); await reload(); }
    catch (err: any) { setError(errText(err)); }
  };

  const removeApi = async (id: string) => {
    if (confirmDelApi !== id) { setConfirmDelApi(id); return; }
    setError('');
    try {
      await deleteRegistryEntry(id);
      setConfirmDelApi(null);
      if (selectedId === id) { setSelectedId(null); setVersions([]); }
      await reload();
    } catch (err: any) { setError(errText(err)); }
  };

  const addVersion = async () => {
    if (!selectedId || !verForm.version.trim()) return;
    setSaving(true); setError('');
    try {
      await addRegistryVersion(selectedId, {
        version: verForm.version.trim(),
        spec: verForm.spec.trim() || undefined,
        notes: verForm.notes.trim() || undefined,
      });
      setVerForm(EMPTY_VERSION_FORM); setShowVersionForm(false);
      await loadVersions(selectedId); await reload();
    } catch (err: any) { setError(errText(err)); }
    finally { setSaving(false); }
  };

  const applyVersionStatus = async (v: RegistryVersion, patch: { status?: Lifecycle; deprecationDate?: string; sunsetDate?: string }) => {
    if (!selectedId) return;
    setRowBusy(v.id); setError('');
    try { await updateRegistryVersionStatus(v.id, patch); await loadVersions(selectedId); await reload(); }
    catch (err: any) { setError(errText(err)); }
    finally { setRowBusy(''); }
  };

  const viewSpec = async (v: RegistryVersion) => {
    setError('');
    try { setSpecView(await getRegistryVersionSpec(v.id)); }
    catch (err: any) { setError(errText(err)); }
  };

  const removeVersion = async (v: RegistryVersion) => {
    if (confirmDelVer !== v.id) { setConfirmDelVer(v.id); return; }
    setError('');
    try {
      await deleteRegistryVersion(v.id);
      setConfirmDelVer(null);
      if (specView?.version.id === v.id) setSpecView(null);
      if (diffA === v.id) setDiffA('');
      if (diffB === v.id) setDiffB('');
      if (selectedId) { await loadVersions(selectedId); await reload(); }
    } catch (err: any) { setError(errText(err)); }
  };

  const runDiff = async () => {
    if (!diffA || !diffB) return;
    setDiffBusy(true); setError(''); setDiffResult(null);
    try { setDiffResult(await diffRegistryVersions(diffA, diffB)); }
    catch (err: any) { setError(errText(err)); }
    finally { setDiffBusy(false); }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-[#1E1B4B]/30 backdrop-blur-sm p-4" onClick={onClose}>
      <div className={`${CARD} w-full max-w-4xl max-h-[88vh] flex flex-col overflow-hidden`} onClick={(e) => e.stopPropagation()}>
        <div className={`flex items-center gap-2 px-4 h-12 border-b border-[#EDE9FE] flex-shrink-0 ${STRIP}`}>
          <Library className="w-4 h-4 text-[#7C3AED]" />
          <h3 className="text-[13px] font-semibold text-gray-900">API registry</h3>
          <span className="text-[11px] text-gray-400">Catalog · versioning · lifecycle · spec sync</span>
          <button type="button" onClick={onClose} className="ml-auto p-1.5 rounded-md text-gray-400 hover:text-[#7C3AED] hover:bg-[#F5F3FF]"><X className="w-4 h-4" /></button>
        </div>

        <div className="flex-1 overflow-y-auto min-h-0 p-4 space-y-3">
          {error && (
            <div className="flex items-start gap-2 px-4 py-2.5 bg-red-50 border border-red-200 rounded-lg">
              <AlertTriangle className="w-4 h-4 text-red-500 flex-shrink-0 mt-px" />
              <p className="text-[12px] text-red-700 min-w-0">{error}</p>
            </div>
          )}

          <p className="text-[11px] text-gray-400 leading-relaxed">
            Two-way spec sync — <span className="font-semibold text-gray-500">PUSH</span> publishes the current catalogue as a new version, and{' '}
            <span className="font-semibold text-gray-500">PULL</span> downloads a version's stored spec so you can re-import it.
          </p>

          <div className={selected ? 'grid grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)] gap-3' : ''}>
            {/* ── LEFT: registered APIs ── */}
            <div className="min-w-0 space-y-2">
              <div className="flex items-center gap-2">
                <span className="text-[11px] font-semibold uppercase tracking-wide text-gray-500">Registered APIs</span>
                <span className="text-[10px] text-gray-400 tabular-nums">{apis.length}</span>
                <button type="button" onClick={apiFormOpen && !apiFormEditId ? () => setApiFormOpen(false) : openNewApiForm} className={`ml-auto ${PRIMARY_BTN} !px-2.5 !py-1.5`}>
                  <Plus className="w-3.5 h-3.5" />Register API
                </button>
              </div>

              {apiFormOpen && (
                <div className={`${CARD} p-3 space-y-2 border-[#DDD6FE]`}>
                  <p className="text-[11px] font-semibold text-[#6D28D9]">{apiFormEditId ? 'Edit API' : 'Register a new API'}</p>
                  <div>
                    <label className={LABEL}>Name</label>
                    <input value={apiForm.name} onChange={(e) => setApiForm({ ...apiForm, name: e.target.value })} placeholder="Payments API" className={INPUT} />
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <label className={LABEL}>Owner</label>
                      <input value={apiForm.owner} onChange={(e) => setApiForm({ ...apiForm, owner: e.target.value })} placeholder="Platform team" className={INPUT} />
                    </div>
                    <div>
                      <label className={LABEL}>Lifecycle</label>
                      <select value={apiForm.lifecycle} onChange={(e) => setApiForm({ ...apiForm, lifecycle: e.target.value as Lifecycle })} className={`${FIELD} w-full capitalize`}>
                        {LIFECYCLES.map((l) => <option key={l} value={l}>{l}</option>)}
                      </select>
                    </div>
                  </div>
                  <div>
                    <label className={LABEL}>Description</label>
                    <textarea value={apiForm.description} onChange={(e) => setApiForm({ ...apiForm, description: e.target.value })} placeholder="What this API does…" className={`${FIELD} w-full h-16 resize-none`} />
                  </div>
                  <div>
                    <label className={LABEL}>Tags (comma-separated)</label>
                    <input value={apiForm.tags} onChange={(e) => setApiForm({ ...apiForm, tags: e.target.value })} placeholder="billing, public, v2" className={INPUT} />
                  </div>
                  <div className="flex items-center justify-end gap-2 pt-0.5">
                    <button type="button" onClick={() => { setApiFormOpen(false); setApiFormEditId(null); }} className={SECONDARY_BTN}>Cancel</button>
                    <button type="button" onClick={() => void saveApi()} disabled={saving || !apiForm.name.trim()} className={PRIMARY_BTN}>
                      {saving ? <Spinner className="w-3.5 h-3.5 animate-spin" /> : <CheckCircle2 className="w-3.5 h-3.5" />}{apiFormEditId ? 'Save changes' : 'Register'}
                    </button>
                  </div>
                </div>
              )}

              {loading ? (
                <div className="flex items-center gap-2 px-4 py-6 text-[12px] text-gray-400"><Spinner className="w-4 h-4 animate-spin" />Loading registry…</div>
              ) : apis.length === 0 ? (
                <div className="px-4 py-6 text-center text-[12px] text-gray-400 border border-dashed border-gray-200 rounded-lg">No APIs registered yet.</div>
              ) : (
                <div className="space-y-1.5">
                  {apis.map((a) => (
                    <button
                      key={a.id}
                      type="button"
                      onClick={() => void selectApi(a.id)}
                      className={`w-full text-left ${CARD} p-2.5 transition-colors ${selectedId === a.id ? 'border-[#DDD6FE] bg-[#F5F3FF]' : 'hover:bg-gray-50'}`}
                    >
                      <div className="flex items-center gap-2">
                        <span className="text-[12.5px] font-semibold text-gray-900 truncate min-w-0 flex-1">{a.name}</span>
                        <span className={`inline-flex items-center px-1.5 py-0.5 rounded border text-[9px] font-bold uppercase tracking-wide flex-shrink-0 ${LIFECYCLE[a.lifecycle]}`}>{a.lifecycle}</span>
                        <span
                          role="button"
                          tabIndex={0}
                          onClick={(e) => { e.stopPropagation(); void removeApi(a.id); }}
                          onKeyDown={(e) => { if (e.key === 'Enter') { e.stopPropagation(); void removeApi(a.id); } }}
                          className={`flex-shrink-0 p-1 rounded-md cursor-pointer ${confirmDelApi === a.id ? 'text-red-600 bg-red-50' : 'text-gray-300 hover:text-red-500 hover:bg-red-50'}`}
                          title={confirmDelApi === a.id ? 'Click again to delete' : 'Delete API'}
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </span>
                      </div>
                      {a.owner && <p className="mt-0.5 text-[10.5px] text-gray-400 truncate">{a.owner}</p>}
                      {(a.tags || []).length > 0 && (
                        <div className="mt-1 flex flex-wrap gap-1">
                          {(a.tags || []).map((t) => <span key={t} className="inline-flex items-center px-1.5 py-0.5 rounded border text-[9px] text-[#6D28D9] bg-[#F5F3FF] border-[#DDD6FE]">{t}</span>)}
                        </div>
                      )}
                      <div className="mt-1 flex items-center gap-2 text-[10px] text-gray-400 tabular-nums">
                        <span>{a.versionCount ?? 0} version{(a.versionCount ?? 0) === 1 ? '' : 's'}</span>
                        {a.latestVersion && <span className="text-gray-300">·</span>}
                        {a.latestVersion && <span className="text-gray-500 font-medium">latest {a.latestVersion}</span>}
                        {confirmDelApi === a.id && <span className="ml-auto text-red-500 font-medium">click trash again to delete</span>}
                      </div>
                    </button>
                  ))}
                </div>
              )}
            </div>

            {/* ── RIGHT: selected API detail ── */}
            {selected && (
              <div className="min-w-0 space-y-3">
                <div className={`${CARD} p-3 space-y-2`}>
                  <div className="flex items-center gap-2">
                    <span className="text-[13px] font-semibold text-gray-900 truncate min-w-0 flex-1">{selected.name}</span>
                    <button type="button" onClick={() => openEditApiForm(selected)} className={`${SECONDARY_BTN} !px-2.5 !py-1`}>Edit</button>
                  </div>
                  {selected.description && <p className="text-[11px] text-gray-500 leading-relaxed">{selected.description}</p>}
                  <div className="flex items-center gap-2">
                    <label className={`${LABEL} !mb-0`}>Lifecycle</label>
                    <select value={selected.lifecycle} onChange={(e) => void changeLifecycle(selected.id, e.target.value as Lifecycle)} className={`${FIELD} capitalize`}>
                      {LIFECYCLES.map((l) => <option key={l} value={l}>{l}</option>)}
                    </select>
                    <span className={`inline-flex items-center px-1.5 py-0.5 rounded border text-[9px] font-bold uppercase tracking-wide ${LIFECYCLE[selected.lifecycle]}`}>{selected.lifecycle}</span>
                  </div>
                </div>

                {/* spec view (PULL) */}
                {specView && (
                  <div className={`${CARD} p-3 space-y-2 border-[#DDD6FE]`}>
                    <div className="flex items-center gap-2">
                      <span className="text-[11px] font-semibold text-[#6D28D9]">Spec · {specView.version.version}</span>
                      <button type="button" onClick={() => downloadText(`${selected.name}-${specView.version.version}.json`, specView.spec)} className={`ml-auto ${SECONDARY_BTN} !px-2.5 !py-1`}>
                        <Download className="w-3.5 h-3.5" />Download
                      </button>
                      <button type="button" onClick={() => setSpecView(null)} className="p-1 rounded-md text-gray-400 hover:text-[#7C3AED] hover:bg-[#F5F3FF]"><X className="w-4 h-4" /></button>
                    </div>
                    <pre className="max-h-56 overflow-auto rounded-md bg-[#FCFBFF] border border-[#E4E0F5] p-2.5 text-[10.5px] font-mono text-gray-700 whitespace-pre">{specView.spec}</pre>
                  </div>
                )}

                {/* versions */}
                <div className="space-y-2">
                  <div className="flex items-center gap-2">
                    <Archive className="w-3.5 h-3.5 text-[#7C3AED]" />
                    <span className="text-[11px] font-semibold uppercase tracking-wide text-gray-500">Versions</span>
                    <span className="text-[10px] text-gray-400 tabular-nums">{versions.length}</span>
                    <button type="button" onClick={() => setShowVersionForm((s) => !s)} className={`ml-auto ${SECONDARY_BTN} !px-2.5 !py-1`}>
                      <Plus className="w-3.5 h-3.5" />Add version
                    </button>
                  </div>

                  {showVersionForm && (
                    <div className={`${CARD} p-3 space-y-2 border-[#DDD6FE]`}>
                      <div className="grid grid-cols-2 gap-2">
                        <div>
                          <label className={LABEL}>Version</label>
                          <input value={verForm.version} onChange={(e) => setVerForm({ ...verForm, version: e.target.value })} placeholder="1.2.0" className={INPUT} />
                        </div>
                        <div>
                          <label className={LABEL}>Notes</label>
                          <input value={verForm.notes} onChange={(e) => setVerForm({ ...verForm, notes: e.target.value })} placeholder="Changelog…" className={INPUT} />
                        </div>
                      </div>
                      <div>
                        <div className="flex items-center gap-2 mb-1">
                          <label className={`${LABEL} !mb-0`}>OpenAPI spec (optional)</label>
                          <button type="button" onClick={() => setVerForm((f) => ({ ...f, spec: toOpenApi(endpoints) }))} className={`ml-auto ${SECONDARY_BTN} !px-2.5 !py-1`}>
                            <Upload className="w-3.5 h-3.5" />Push current catalogue
                          </button>
                          <span className="text-[10px] text-gray-400">{endpoints.length} endpoint{endpoints.length === 1 ? '' : 's'}</span>
                        </div>
                        <textarea value={verForm.spec} onChange={(e) => setVerForm({ ...verForm, spec: e.target.value })} placeholder="Paste an OpenAPI document, or push the catalogue…" spellCheck={false} className={`${FIELD} w-full h-32 font-mono text-[11px] resize-none`} />
                      </div>
                      <div className="flex items-center justify-end gap-2">
                        <button type="button" onClick={() => { setShowVersionForm(false); setVerForm(EMPTY_VERSION_FORM); }} className={SECONDARY_BTN}>Cancel</button>
                        <button type="button" onClick={() => void addVersion()} disabled={saving || !verForm.version.trim()} className={PRIMARY_BTN}>
                          {saving ? <Spinner className="w-3.5 h-3.5 animate-spin" /> : <Plus className="w-3.5 h-3.5" />}Add version
                        </button>
                      </div>
                    </div>
                  )}

                  {versionsLoading ? (
                    <div className="flex items-center gap-2 px-4 py-5 text-[12px] text-gray-400"><Spinner className="w-4 h-4 animate-spin" />Loading versions…</div>
                  ) : versions.length === 0 ? (
                    <div className="px-4 py-5 text-center text-[12px] text-gray-400 border border-dashed border-gray-200 rounded-lg">No versions yet.</div>
                  ) : (
                    <div className="space-y-1.5">
                      {versions.map((v) => (
                        <div key={v.id} className={`${CARD} p-2.5 space-y-2`}>
                          <div className="flex items-center gap-2">
                            <span className="text-[12px] font-semibold text-gray-900 font-mono">{v.version}</span>
                            <span className={`inline-flex items-center px-1.5 py-0.5 rounded border text-[9px] font-bold uppercase tracking-wide ${LIFECYCLE[v.status]}`}>{v.status}</span>
                            {v.hasSpec
                              ? <span className="inline-flex items-center gap-1 text-[10px] text-emerald-600"><CheckCircle2 className="w-3 h-3" />spec</span>
                              : <span className="text-[10px] text-gray-300">no spec</span>}
                            {rowBusy === v.id && <Spinner className="w-3.5 h-3.5 animate-spin text-[#7C3AED]" />}
                            <div className="ml-auto flex items-center gap-1">
                              {v.hasSpec && (
                                <button type="button" onClick={() => void viewSpec(v)} className={`${SECONDARY_BTN} !px-2 !py-1`} title="View / download spec (PULL)">
                                  <Download className="w-3.5 h-3.5" />Spec
                                </button>
                              )}
                              <button
                                type="button"
                                onClick={() => void removeVersion(v)}
                                className={`p-1 rounded-md ${confirmDelVer === v.id ? 'text-red-600 bg-red-50' : 'text-gray-300 hover:text-red-500 hover:bg-red-50'}`}
                                title={confirmDelVer === v.id ? 'Click again to delete' : 'Delete version'}
                              >
                                <Trash2 className="w-3.5 h-3.5" />
                              </button>
                            </div>
                          </div>
                          {v.notes && <p className="text-[11px] text-gray-500 leading-relaxed">{v.notes}</p>}
                          <div className="flex flex-wrap items-end gap-2">
                            <div>
                              <label className={LABEL}>Status</label>
                              <select value={v.status} onChange={(e) => void applyVersionStatus(v, { status: e.target.value as Lifecycle })} disabled={rowBusy === v.id} className={`${FIELD} capitalize`}>
                                {LIFECYCLES.map((l) => <option key={l} value={l}>{l}</option>)}
                              </select>
                            </div>
                            <div>
                              <label className={LABEL}>Deprecation</label>
                              <input type="date" value={dateVal(v.deprecationDate)} onChange={(e) => void applyVersionStatus(v, { deprecationDate: e.target.value })} disabled={rowBusy === v.id} className={FIELD} />
                            </div>
                            <div>
                              <label className={LABEL}>Sunset</label>
                              <input type="date" value={dateVal(v.sunsetDate)} onChange={(e) => void applyVersionStatus(v, { sunsetDate: e.target.value })} disabled={rowBusy === v.id} className={FIELD} />
                            </div>
                            {confirmDelVer === v.id && <span className="ml-auto text-[10px] text-red-500 font-medium self-center">click trash again to delete</span>}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                {/* diff versions */}
                <div className={`${CARD} p-3 space-y-2`}>
                  <div className="flex items-center gap-2">
                    <GitCompareArrows className="w-3.5 h-3.5 text-[#7C3AED]" />
                    <span className="text-[11px] font-semibold uppercase tracking-wide text-gray-500">Diff versions</span>
                  </div>
                  {specVersions.length < 2 ? (
                    <p className="text-[11px] text-gray-400">Add at least two versions with a spec to compare them.</p>
                  ) : (
                    <>
                      <div className="flex flex-wrap items-end gap-2">
                        <div>
                          <label className={LABEL}>Version A (old)</label>
                          <select value={diffA} onChange={(e) => setDiffA(e.target.value)} className={`${FIELD} capitalize`}>
                            <option value="">Select…</option>
                            {specVersions.map((v) => <option key={v.id} value={v.id}>{v.version}</option>)}
                          </select>
                        </div>
                        <div>
                          <label className={LABEL}>Version B (new)</label>
                          <select value={diffB} onChange={(e) => setDiffB(e.target.value)} className={`${FIELD} capitalize`}>
                            <option value="">Select…</option>
                            {specVersions.map((v) => <option key={v.id} value={v.id}>{v.version}</option>)}
                          </select>
                        </div>
                        <button type="button" onClick={() => void runDiff()} disabled={diffBusy || !diffA || !diffB || diffA === diffB} className={PRIMARY_BTN}>
                          {diffBusy ? <Spinner className="w-3.5 h-3.5 animate-spin" /> : <GitCompareArrows className="w-3.5 h-3.5" />}Diff
                        </button>
                      </div>

                      {diffResult && (
                        <div className="space-y-2 pt-1">
                          <div className={`flex items-center gap-2 px-3 py-2.5 rounded-lg border ${diffResult.gate.passed ? 'bg-emerald-50 border-emerald-200' : 'bg-red-50 border-red-200'}`}>
                            {diffResult.gate.passed ? <CheckCircle2 className="w-5 h-5 text-emerald-600 flex-shrink-0" /> : <ShieldX className="w-5 h-5 text-red-600 flex-shrink-0" />}
                            <div className="min-w-0">
                              <p className={`text-[12.5px] font-semibold ${diffResult.gate.passed ? 'text-emerald-800' : 'text-red-800'}`}>{diffResult.gate.passed ? 'GO — safe' : 'NO-GO — breaking'}</p>
                              <p className="text-[11px] text-gray-600">{diffResult.gate.reason}</p>
                            </div>
                            <span className="ml-auto text-[10.5px] font-mono text-gray-400 truncate">{diffResult.a} → {diffResult.b}</span>
                          </div>
                          <div className="flex flex-wrap items-center gap-2">
                            <span className={`inline-flex items-center px-2.5 py-1 rounded-md border text-[11px] font-semibold tabular-nums ${diffResult.summary.breaking ? 'text-red-700 bg-red-50 border-red-200' : 'text-gray-400 bg-gray-50 border-gray-200'}`}>{diffResult.summary.breaking} Breaking</span>
                            <span className="inline-flex items-center px-2.5 py-1 rounded-md border text-[11px] font-semibold tabular-nums text-amber-700 bg-amber-50 border-amber-200">{diffResult.summary.nonBreaking} Non-breaking</span>
                            <span className="inline-flex items-center px-2.5 py-1 rounded-md border text-[11px] font-semibold tabular-nums text-emerald-700 bg-emerald-50 border-emerald-200">{diffResult.summary.additions} Additions</span>
                          </div>
                          {diffResult.changes.length === 0 ? (
                            <div className="flex items-center gap-2 px-3 py-2.5 bg-emerald-50 border border-emerald-200 rounded-lg text-[12px] text-emerald-800"><CheckCircle2 className="w-4 h-4 text-emerald-600" />No differences between the two specs.</div>
                          ) : (
                            <div className="rounded-lg border border-gray-100 divide-y divide-gray-100 max-h-56 overflow-auto">
                              {diffResult.changes.map((c, i) => (
                                <div key={i} className="px-3 py-2">
                                  <div className="flex items-center gap-2">
                                    <span className={`text-[9px] font-bold uppercase px-1.5 py-0.5 rounded border flex-shrink-0 ${c.breaking ? 'text-red-700 bg-red-50 border-red-200' : 'text-gray-600 bg-gray-100 border-gray-300'}`}>{c.breaking ? 'breaking' : 'ok'}</span>
                                    <span className="text-[10.5px] font-mono text-gray-500 flex-shrink-0">{c.kind}</span>
                                    <span className="text-[11.5px] font-mono text-gray-800 min-w-0 flex-1 truncate" title={c.location}>{c.location}</span>
                                  </div>
                                  <p className="mt-1 ml-1 text-[11px] text-gray-600 leading-relaxed">{c.detail}</p>
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      )}
                    </>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
