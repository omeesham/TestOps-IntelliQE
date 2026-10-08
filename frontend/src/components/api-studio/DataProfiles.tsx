/**
 * DataProfiles — reusable, named datasets for parameterised API testing.
 *
 * Standalone and opt-in. A profile is a small table (columns + rows) that can
 * be hand-entered, pasted as CSV, uploaded from Excel, or pulled from a SQL
 * query against a saved DB connection. Saved profiles are then replayed over a
 * saved API flow — the flow runs once per row — so one dataset drives many
 * end-to-end checks. Writes stay off unless explicitly allowed, and nothing
 * here touches the generate → execute → heal pipeline.
 */
import { useState, useEffect } from 'react';
import { X, Database, Plus, Trash2, Save, Play, AlertTriangle, CheckCircle2, XCircle, FileSpreadsheet, ClipboardPaste, Table2 } from 'lucide-react';
import Spinner from '@/components/feedback/Spinner';
import { useToast } from '@/components/feedback/ToastProvider';
import {
  listDataProfiles, saveDataProfile, deleteDataProfile,
  importProfileCsv, importProfileExcel, profileFromDb,
  listDbConnections, listApiFlows, runProfileOverFlow,
  type DataProfile, type ProfileFlowRunResult, type DbConnection, type SavedApiFlow,
} from '@/services/api';
import { CARD, STRIP, INPUT, FIELD, LABEL, PRIMARY_BTN, SECONDARY_BTN, THEAD, relativeTime } from './format';
import { EmptyState, CopyButton } from './primitives';

/** The editor's working copy — a saved profile loaded for edit, or a fresh draft (no id). */
type Draft = { id?: string; name: string; columns: string[]; rows: Record<string, string>[]; source: string };

type ImportTab = 'csv' | 'excel' | 'db' | 'manual';

const VISIBLE_ROWS = 50;
const EDITABLE_MAX = 25;

const impBtn = (active: boolean) =>
  `inline-flex items-center gap-1 px-2.5 py-1.5 text-[11.5px] font-medium rounded-md transition-colors ${
    active ? 'bg-[#F5F3FF] text-[#6D28D9] border border-[#DDD6FE]' : 'text-gray-500 hover:text-[#7C3AED] border border-transparent'
  }`;

const CHIP = 'inline-flex items-center px-1.5 py-0.5 rounded border text-[10px] font-medium text-[#6D28D9] bg-[#F5F3FF] border-[#DDD6FE]';

export default function DataProfiles({ onClose }: { onClose: () => void }) {
  const toast = useToast();
  const [profiles, setProfiles] = useState<DataProfile[]>([]);
  const [connections, setConnections] = useState<DbConnection[]>([]);
  const [flows, setFlows] = useState<SavedApiFlow[]>([]);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState('');

  const [imp, setImp] = useState<ImportTab>('csv');
  const [csvText, setCsvText] = useState('');
  const [dbConnId, setDbConnId] = useState('');
  const [dbQuery, setDbQuery] = useState('');
  const [newCol, setNewCol] = useState('');

  const [flowId, setFlowId] = useState('');
  const [allowWrites, setAllowWrites] = useState(false);
  const [runResult, setRunResult] = useState<ProfileFlowRunResult | null>(null);

  const refreshProfiles = async () => {
    const { profiles: list } = await listDataProfiles();
    setProfiles(list);
  };

  useEffect(() => {
    (async () => {
      try {
        const [p, db, fl] = await Promise.all([listDataProfiles(), listDbConnections(), listApiFlows()]);
        setProfiles(p.profiles);
        setConnections(db.connections);
        setFlows(fl.flows);
      } catch (e: any) {
        setError(e?.response?.data?.error || e?.message || 'Could not load data profiles.');
      } finally {
        setLoading(false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const selectProfile = (p: DataProfile) => {
    setDraft({ id: p.id, name: p.name, columns: [...p.columns], rows: [...p.rows], source: p.source });
    setRunResult(null);
    setError('');
  };

  const newDraft = () => {
    setDraft({ name: 'New profile', columns: [], rows: [], source: 'manual' });
    setRunResult(null);
    setImp('manual');
    setError('');
  };

  const save = async () => {
    if (!draft) return;
    const name = draft.name.trim();
    if (!name) { setError('A profile name is required.'); return; }
    setBusy(true); setError('');
    try {
      const { profile } = await saveDataProfile({ id: draft.id, name, columns: draft.columns, rows: draft.rows, source: draft.source });
      setDraft({ id: profile.id, name: profile.name, columns: [...profile.columns], rows: [...profile.rows], source: profile.source });
      await refreshProfiles();
      toast.success('Profile saved', profile.name);
    } catch (e: any) {
      setError(e?.response?.data?.error || e?.message || 'Could not save the profile.');
    } finally { setBusy(false); }
  };

  const remove = async (id: string) => {
    setBusy(true); setError('');
    try {
      await deleteDataProfile(id);
      setProfiles((prev) => prev.filter((p) => p.id !== id));
      if (draft?.id === id) { setDraft(null); setRunResult(null); }
      toast.success('Profile deleted');
    } catch (e: any) {
      setError(e?.response?.data?.error || e?.message || 'Could not delete the profile.');
    } finally { setBusy(false); }
  };

  const parseCsv = async () => {
    if (!draft || !csvText.trim()) return;
    setBusy(true); setError('');
    try {
      const { columns, rows } = await importProfileCsv(csvText);
      setDraft({ ...draft, columns, rows, source: 'csv' });
    } catch (e: any) {
      setError(e?.response?.data?.error || e?.message || 'Could not parse the CSV.');
    } finally { setBusy(false); }
  };

  const onExcel = (file: File | null | undefined) => {
    if (!file || !draft) return;
    setBusy(true); setError('');
    const reader = new FileReader();
    reader.onload = async () => {
      try {
        const dataUrl = String(reader.result || '');
        const base64 = dataUrl.includes(',') ? dataUrl.slice(dataUrl.indexOf(',') + 1) : dataUrl;
        const { columns, rows } = await importProfileExcel(base64);
        setDraft((d) => (d ? { ...d, columns, rows, source: 'excel' } : d));
      } catch (e: any) {
        setError(e?.response?.data?.error || e?.message || 'Could not import the Excel file.');
      } finally { setBusy(false); }
    };
    reader.onerror = () => { setError('Could not read the file.'); setBusy(false); };
    reader.readAsDataURL(file);
  };

  const runDbQuery = async () => {
    if (!draft || !dbQuery.trim()) return;
    setBusy(true); setError('');
    try {
      const { columns, rows } = await profileFromDb({ connectionId: dbConnId || undefined, query: dbQuery });
      setDraft({ ...draft, columns, rows, source: 'db' });
    } catch (e: any) {
      setError(e?.response?.data?.error || e?.message || 'Could not run the query.');
    } finally { setBusy(false); }
  };

  const addColumn = () => {
    const name = newCol.trim();
    if (!name || !draft || draft.columns.includes(name)) return;
    setDraft({ ...draft, columns: [...draft.columns, name], rows: draft.rows.map((r) => ({ ...r, [name]: r[name] ?? '' })) });
    setNewCol('');
  };

  const addRow = () => setDraft((d) => {
    if (!d) return d;
    const row: Record<string, string> = {};
    d.columns.forEach((c) => { row[c] = ''; });
    return { ...d, rows: [...d.rows, row] };
  });

  const removeRow = (i: number) => setDraft((d) => (d ? { ...d, rows: d.rows.filter((_, j) => j !== i) } : d));

  const setCell = (i: number, col: string, value: string) =>
    setDraft((d) => (d ? { ...d, rows: d.rows.map((r, j) => (j === i ? { ...r, [col]: value } : r)) } : d));

  const selectedFlow = flows.find((f) => f.id === flowId);

  const runFlow = async () => {
    if (!draft || !selectedFlow) return;
    setRunning(true); setError(''); setRunResult(null);
    try {
      setRunResult(await runProfileOverFlow({ steps: selectedFlow.steps, rows: draft.rows, allowWrites, maxRows: 100 }));
    } catch (e: any) {
      setError(e?.response?.data?.error || e?.message || 'Flow run failed.');
    } finally { setRunning(false); }
  };

  const editable = !!draft && draft.rows.length <= EDITABLE_MAX;
  const visibleRows = draft ? draft.rows.slice(0, VISIBLE_ROWS) : [];
  const hiddenCount = draft ? Math.max(0, draft.rows.length - VISIBLE_ROWS) : 0;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-[#1E1B4B]/30 backdrop-blur-sm p-4" onClick={onClose}>
      <div className={`${CARD} w-full max-w-3xl max-h-[88vh] flex flex-col overflow-hidden`} onClick={(e) => e.stopPropagation()}>
        <div className={`flex items-center gap-2 px-4 h-12 border-b border-[#EDE9FE] flex-shrink-0 ${STRIP}`}>
          <Database className="w-4 h-4 text-[#7C3AED]" />
          <h3 className="text-[13px] font-semibold text-gray-900">Data profiles</h3>
          <span className="text-[11px] text-gray-400">reusable datasets for data-driven flows</span>
          <button type="button" onClick={onClose} className="ml-auto p-1.5 rounded-md text-gray-400 hover:text-[#7C3AED] hover:bg-[#F5F3FF]"><X className="w-4 h-4" /></button>
        </div>

        <div className="p-4 overflow-y-auto min-h-0">
          {error && (
            <div className="flex items-start gap-2 px-3 py-2 bg-red-50 border border-red-200 rounded-lg mb-3">
              <AlertTriangle className="w-4 h-4 text-red-500 flex-shrink-0 mt-px" /><p className="text-[12px] text-red-700 min-w-0 whitespace-pre-wrap break-words">{error}</p>
            </div>
          )}

          <div className="flex gap-4">
            {/* ── Left: profile list ── */}
            <aside className="w-56 flex-shrink-0 flex flex-col">
              <div className="flex items-center justify-between mb-2">
                <span className="text-[10.5px] font-semibold uppercase tracking-wide text-gray-500">Profiles</span>
                <button type="button" onClick={newDraft} className="inline-flex items-center gap-1 text-[11px] font-medium text-[#6D28D9] hover:underline"><Plus className="w-3.5 h-3.5" />New</button>
              </div>

              {loading ? (
                <div className="flex items-center justify-center py-10 text-gray-400"><Spinner className="w-5 h-5 animate-spin" /></div>
              ) : profiles.length === 0 ? (
                <p className="text-[11.5px] text-gray-400 py-4 text-center">No profiles yet — create one with “New”.</p>
              ) : (
                <div className="space-y-1.5 max-h-[62vh] overflow-y-auto pr-1">
                  {profiles.map((p) => {
                    const sel = draft?.id === p.id;
                    return (
                      <div key={p.id} className={`flex items-start gap-1 rounded-lg border px-2 py-1.5 ${sel ? 'border-[#DDD6FE] bg-[#F5F3FF]' : 'border-[#E9E5FB] bg-white hover:border-[#DDD6FE]'}`}>
                        <button type="button" onClick={() => selectProfile(p)} className="flex-1 min-w-0 text-left">
                          <div className="text-[12px] font-medium text-gray-800 truncate">{p.name}</div>
                          <div className="flex items-center gap-1.5 mt-0.5">
                            <span className={CHIP}>{p.source || 'manual'}</span>
                            <span className="text-[10px] text-gray-400 tabular-nums">{p.rowCount} rows</span>
                          </div>
                          <div className="text-[10px] text-gray-400 mt-0.5">{relativeTime(p.updatedAt || p.createdAt)}</div>
                        </button>
                        <button type="button" onClick={() => void remove(p.id)} disabled={busy} className="flex-shrink-0 p-1 rounded text-gray-300 hover:text-red-500 disabled:opacity-40" title="Delete profile"><Trash2 className="w-3.5 h-3.5" /></button>
                      </div>
                    );
                  })}
                </div>
              )}
            </aside>

            {/* ── Right: editor ── */}
            <section className="flex-1 min-w-0">
              {!draft ? (
                <EmptyState icon={Database} title="No profile selected" hint="Pick a profile on the left, or create a new one to paste, upload, query, or hand-enter rows." />
              ) : (
                <div className="space-y-3">
                  {/* Name + source + save */}
                  <div className="flex items-end gap-2">
                    <div className="flex-1 min-w-0">
                      <label className={LABEL}>Name</label>
                      <input value={draft.name} onChange={(e) => { setDraft({ ...draft, name: e.target.value }); setError(''); }} placeholder="Profile name" className={INPUT} />
                    </div>
                    <div className="flex flex-col items-start">
                      <label className={LABEL}>Source</label>
                      <span className={`${CHIP} h-[34px] !py-0`}>{draft.source || 'manual'}</span>
                    </div>
                    <button type="button" onClick={() => void save()} disabled={busy || !draft.name.trim()} className={SECONDARY_BTN}>
                      {busy ? <Spinner className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}Save
                    </button>
                  </div>

                  {/* Import switcher */}
                  <div>
                    <label className={LABEL}>Import data</label>
                    <div className="flex flex-wrap items-center gap-1 mb-2">
                      <button type="button" onClick={() => setImp('csv')} className={impBtn(imp === 'csv')}><ClipboardPaste className="w-3.5 h-3.5" />Paste CSV</button>
                      <button type="button" onClick={() => setImp('excel')} className={impBtn(imp === 'excel')}><FileSpreadsheet className="w-3.5 h-3.5" />Excel</button>
                      <button type="button" onClick={() => setImp('db')} className={impBtn(imp === 'db')}><Database className="w-3.5 h-3.5" />From DB</button>
                      <button type="button" onClick={() => setImp('manual')} className={impBtn(imp === 'manual')}><Table2 className="w-3.5 h-3.5" />Manual</button>
                    </div>

                    {imp === 'csv' && (
                      <div className="space-y-1.5">
                        <textarea
                          value={csvText}
                          onChange={(e) => { setCsvText(e.target.value); setError(''); }}
                          rows={4}
                          spellCheck={false}
                          placeholder={'name,email\nAda Lovelace,ada@example.com\nAlan Turing,alan@example.com'}
                          className={`${INPUT} font-mono text-[11.5px] leading-relaxed resize-y`}
                        />
                        <div className="flex justify-end">
                          <button type="button" onClick={() => void parseCsv()} disabled={busy || !csvText.trim()} className={SECONDARY_BTN}>
                            {busy ? <Spinner className="w-3.5 h-3.5 animate-spin" /> : <ClipboardPaste className="w-3.5 h-3.5" />}Parse CSV
                          </button>
                        </div>
                      </div>
                    )}

                    {imp === 'excel' && (
                      <div className="space-y-1.5">
                        <input
                          type="file"
                          accept=".xlsx,.xls"
                          onChange={(e) => { onExcel(e.target.files?.[0]); e.target.value = ''; }}
                          className="block w-full text-[12px] text-gray-600 file:mr-3 file:py-1.5 file:px-3 file:rounded-lg file:border-0 file:text-[12px] file:font-medium file:bg-[#F5F3FF] file:text-[#6D28D9] hover:file:bg-[#EDE9FE]"
                        />
                        <p className="text-[10.5px] text-gray-400">The first sheet's header row becomes the columns; the rest become rows.</p>
                      </div>
                    )}

                    {imp === 'db' && (
                      <div className="space-y-1.5">
                        <select value={dbConnId} onChange={(e) => setDbConnId(e.target.value)} className={INPUT}>
                          <option value="">Default connection</option>
                          {connections.map((c) => <option key={c.id} value={c.id}>{c.name} · {c.dialect} · {c.database}</option>)}
                        </select>
                        <input
                          value={dbQuery}
                          onChange={(e) => { setDbQuery(e.target.value); setError(''); }}
                          placeholder="SELECT id, email FROM users WHERE active = 1"
                          className={`${INPUT} font-mono text-[11.5px]`}
                        />
                        <div className="flex justify-end">
                          <button type="button" onClick={() => void runDbQuery()} disabled={busy || !dbQuery.trim()} className={SECONDARY_BTN}>
                            {busy ? <Spinner className="w-3.5 h-3.5 animate-spin" /> : <Play className="w-3.5 h-3.5" />}Run query
                          </button>
                        </div>
                      </div>
                    )}

                    {imp === 'manual' && (
                      <div className="flex flex-wrap items-end gap-2">
                        <div className="flex-1 min-w-[140px]">
                          <input value={newCol} onChange={(e) => setNewCol(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addColumn(); } }} placeholder="New column name" className={`${FIELD} w-full`} />
                        </div>
                        <button type="button" onClick={addColumn} disabled={!newCol.trim()} className={SECONDARY_BTN}><Plus className="w-3.5 h-3.5" />Add column</button>
                        <button type="button" onClick={addRow} disabled={!draft.columns.length} className={SECONDARY_BTN}><Plus className="w-3.5 h-3.5" />Add row</button>
                      </div>
                    )}
                  </div>

                  {/* Data grid */}
                  <div>
                    <div className="flex items-center justify-between mb-1">
                      <span className="text-[10.5px] font-semibold uppercase tracking-wide text-gray-500">
                        Data{draft.rows.length ? ` · ${draft.rows.length} row${draft.rows.length === 1 ? '' : 's'}` : ''}
                      </span>
                      {draft.rows.length > 0 && <CopyButton text={JSON.stringify(draft.rows, null, 2)} label="Copy JSON" />}
                    </div>

                    {draft.columns.length === 0 ? (
                      <p className="text-[11.5px] text-gray-400 py-4 text-center border border-dashed border-[#E9E5FB] rounded-lg">No columns yet — import data above, or add a column on the Manual tab.</p>
                    ) : (
                      <>
                        <div className="border border-[#E9E5FB] rounded-lg overflow-hidden">
                          <div className="overflow-auto max-h-72">
                            <table className="w-full text-[11.5px]">
                              <thead className={THEAD}>
                                <tr className="text-gray-500 text-left">
                                  <th className="font-semibold px-2 py-1.5 w-8">#</th>
                                  {draft.columns.map((c) => <th key={c} className="font-semibold px-2.5 py-1.5 font-mono whitespace-nowrap">{c}</th>)}
                                  {editable && <th className="px-2 py-1.5 w-8"> </th>}
                                </tr>
                              </thead>
                              <tbody className="divide-y divide-gray-100">
                                {visibleRows.map((r, i) => (
                                  <tr key={i}>
                                    <td className="px-2 py-1 text-gray-400 tabular-nums align-top">{i + 1}</td>
                                    {draft.columns.map((c) => (
                                      <td key={c} className="px-1.5 py-1 align-top">
                                        {editable
                                          ? <input value={r[c] ?? ''} onChange={(e) => setCell(i, c, e.target.value)} className={`${FIELD} w-full min-w-[90px] py-1 font-mono text-[11px]`} />
                                          : <span className="font-mono text-gray-700 block max-w-[180px] truncate" title={r[c] ?? ''}>{r[c] ?? ''}</span>}
                                      </td>
                                    ))}
                                    {editable && (
                                      <td className="px-1 py-1 align-top text-right">
                                        <button type="button" onClick={() => removeRow(i)} className="p-1 rounded text-gray-300 hover:text-red-500" title="Remove row"><Trash2 className="w-3.5 h-3.5" /></button>
                                      </td>
                                    )}
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                        </div>
                        {hiddenCount > 0 && <p className="text-[10.5px] text-gray-400 mt-1">+{hiddenCount} more row{hiddenCount === 1 ? '' : 's'} not shown</p>}
                        {!editable && <p className="text-[10.5px] text-gray-400 mt-1">Read-only preview — profiles with more than {EDITABLE_MAX} rows are not edited inline.</p>}
                      </>
                    )}
                  </div>

                  {/* Run over a flow */}
                  <div className="rounded-lg border border-[#E9E5FB] p-3 space-y-2">
                    <label className={LABEL}>Run over a flow — the flow runs once per row</label>
                    <div className="flex flex-wrap items-center gap-2">
                      <div className="flex-1 min-w-[160px]">
                        <select value={flowId} onChange={(e) => setFlowId(e.target.value)} className={INPUT} disabled={!flows.length}>
                          <option value="">{flows.length ? 'Select a saved flow…' : 'No saved flows'}</option>
                          {flows.map((f) => <option key={f.id} value={f.id}>{f.name} · {f.steps.length} step{f.steps.length === 1 ? '' : 's'}</option>)}
                        </select>
                      </div>
                      <label className="flex items-center gap-1.5 text-[11.5px] text-gray-600">
                        <input type="checkbox" checked={allowWrites} onChange={(e) => setAllowWrites(e.target.checked)} className="w-3.5 h-3.5" />
                        Allow writes
                      </label>
                      <button type="button" onClick={() => void runFlow()} disabled={running || !selectedFlow || !draft.rows.length} className={PRIMARY_BTN}>
                        {running ? <Spinner className="w-3.5 h-3.5 animate-spin" /> : <Play className="w-3.5 h-3.5" />}
                        {running ? 'Running…' : 'Run'}
                      </button>
                    </div>

                    {runResult && (
                      <div className="space-y-2.5 pt-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md border text-[11.5px] font-semibold text-gray-700 bg-gray-50 border-gray-200 tabular-nums">{runResult.total} rows</span>
                          <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md border text-[11.5px] font-semibold text-emerald-700 bg-emerald-50 border-emerald-200 tabular-nums"><CheckCircle2 className="w-3.5 h-3.5" />{runResult.passed} passed</span>
                          <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md border text-[11.5px] font-semibold tabular-nums ${runResult.failed ? 'text-red-700 bg-red-50 border-red-200' : 'text-gray-500 bg-gray-50 border-gray-200'}`}><XCircle className="w-3.5 h-3.5" />{runResult.failed} failed</span>
                        </div>
                        <div className="border border-[#E9E5FB] rounded-lg overflow-hidden">
                          <div className="overflow-auto max-h-64">
                            <table className="w-full text-[11.5px]">
                              <thead className={THEAD}>
                                <tr className="text-gray-500 text-left">
                                  <th className="font-semibold px-2.5 py-1.5 w-10">row</th>
                                  <th className="font-semibold px-2.5 py-1.5 w-20">result</th>
                                  <th className="font-semibold px-2.5 py-1.5 text-right">steps</th>
                                  <th className="font-semibold px-2.5 py-1.5 text-right">time</th>
                                  <th className="font-semibold px-2.5 py-1.5">first error</th>
                                </tr>
                              </thead>
                              <tbody className="divide-y divide-gray-100">
                                {runResult.runs.map((r: any) => (
                                  <tr key={r.row} className={r.passed ? '' : 'bg-red-50/40'}>
                                    <td className="px-2.5 py-1.5 text-gray-400 tabular-nums">{r.row + 1}</td>
                                    <td className="px-2.5 py-1.5">
                                      {r.passed
                                        ? <span className="inline-flex items-center gap-1 text-emerald-700"><CheckCircle2 className="w-3.5 h-3.5" />pass</span>
                                        : <span className="inline-flex items-center gap-1 text-red-700"><XCircle className="w-3.5 h-3.5" />fail</span>}
                                    </td>
                                    <td className="px-2.5 py-1.5 text-right font-mono tabular-nums text-gray-600">{r.stepsRun}/{r.stepsTotal}</td>
                                    <td className="px-2.5 py-1.5 text-right font-mono tabular-nums text-gray-600">{r.durationMs}ms</td>
                                    <td className="px-2.5 py-1.5 text-red-600 max-w-[220px] truncate" title={r.firstError || ''}>{r.firstError || '—'}</td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              )}
            </section>
          </div>
        </div>
      </div>
    </div>
  );
}
