/**
 * Traceability — the requirements traceability matrix (requirement → case →
 * defect). Manage requirements as first-class records that link to catalogue
 * endpoints and/or scenario titles, then build a matrix that joins those links
 * to a run's outcomes: each requirement shows its coverage, pass/fail, and the
 * failing cases that are its defects. Read-mostly and additive.
 */
import { useEffect, useState } from 'react';
import { Waypoints, X, Plus, Trash2, Save, Play, AlertTriangle } from 'lucide-react';
import Spinner from '@/components/feedback/Spinner';
import { useToast } from '@/components/feedback/ToastProvider';
import {
  listRequirements, saveRequirement, deleteRequirement, getTraceMatrix, listApiRuns,
  type Requirement, type LinkedEndpoint, type TraceMatrix, type TraceStatus,
} from '@/services/api';
import { CARD, STRIP, INPUT, FIELD, LABEL, PRIMARY_BTN, SECONDARY_BTN, THEAD } from './format';
import type { CatalogEndpoint } from './types';

type Priority = Requirement['priority'];
const PRIORITIES: Priority[] = ['low', 'medium', 'high', 'critical'];
const STATUS_STYLE: Record<TraceStatus, string> = {
  covered: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  partial: 'bg-amber-50 text-amber-700 border-amber-200',
  failing: 'bg-red-50 text-red-700 border-red-200',
  uncovered: 'bg-gray-100 text-gray-500 border-gray-200',
};

interface Form { id?: string; reqKey: string; title: string; description: string; priority: Priority; source: string; linkedEndpoints: LinkedEndpoint[]; scenariosText: string; defects: { key: string; url: string }[] }
const blankForm = (): Form => ({ reqKey: '', title: '', description: '', priority: 'medium', source: '', linkedEndpoints: [], scenariosText: '', defects: [] });

export default function Traceability({ endpoints, onClose }: { endpoints: CatalogEndpoint[]; onClose: () => void }) {
  const toast = useToast();
  const [requirements, setRequirements] = useState<Requirement[]>([]);
  const [form, setForm] = useState<Form>(blankForm());
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const [runs, setRuns] = useState<any[]>([]);
  const [runId, setRunId] = useState('');
  const [matrix, setMatrix] = useState<TraceMatrix | null>(null);
  const [building, setBuilding] = useState(false);
  const [epSel, setEpSel] = useState('');

  const refresh = async () => { try { setRequirements(await listRequirements()); } catch { /* list is a convenience */ } };
  useEffect(() => {
    void refresh();
    void listApiRuns(1, 20).then((r) => setRuns(Array.isArray(r?.items) ? r.items : [])).catch(() => { /* convenience */ });
  }, []);

  const editReq = (r: Requirement) => setForm({
    id: r.id, reqKey: r.reqKey, title: r.title, description: r.description, priority: r.priority, source: r.source,
    linkedEndpoints: r.linkedEndpoints, scenariosText: r.linkedScenarios.join('\n'), defects: r.defects.map((d) => ({ key: d.key, url: d.url || '' })),
  });

  const save = async () => {
    if (!form.title.trim()) { setError('A requirement needs a title.'); return; }
    setSaving(true); setError('');
    try {
      await saveRequirement({
        id: form.id, reqKey: form.reqKey.trim(), title: form.title.trim(), description: form.description, priority: form.priority, source: form.source.trim(),
        linkedEndpoints: form.linkedEndpoints,
        linkedScenarios: form.scenariosText.split('\n').map((s) => s.trim()).filter(Boolean),
        defects: form.defects.filter((d) => d.key.trim()).map((d) => ({ key: d.key.trim(), url: d.url.trim() || undefined })),
      });
      toast.success(form.id ? 'Requirement updated' : 'Requirement created');
      setForm(blankForm()); await refresh();
    } catch (e: any) { setError(e?.response?.data?.error || e?.message || 'Request failed.'); }
    finally { setSaving(false); }
  };
  const remove = async (id: string) => {
    try { await deleteRequirement(id); if (form.id === id) setForm(blankForm()); await refresh(); toast.success('Requirement deleted'); }
    catch (e: any) { toast.error('Delete failed', e?.response?.data?.error || e?.message || 'Request failed.'); }
  };

  const addEndpoint = (val: string) => {
    if (!val) return;
    const ep = endpoints.find((e) => `${e.method} ${e.url}` === val);
    if (ep && !form.linkedEndpoints.some((l) => l.method === ep.method && l.url === ep.url)) {
      setForm((p) => ({ ...p, linkedEndpoints: [...p.linkedEndpoints, { method: ep.method, url: ep.url }] }));
    }
    setEpSel('');
  };

  const build = async () => {
    setBuilding(true); setError('');
    try { setMatrix(await getTraceMatrix(runId || undefined)); }
    catch (e: any) { setError(e?.response?.data?.error || e?.message || 'Request failed.'); }
    finally { setBuilding(false); }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-[#1E1B4B]/30 backdrop-blur-sm p-4" onClick={onClose}>
      <div className={`${CARD} w-full max-w-3xl max-h-[88vh] flex flex-col overflow-hidden`} onClick={(e) => e.stopPropagation()}>
        <div className={`flex items-center gap-2 px-4 h-12 border-b border-[#EDE9FE] flex-shrink-0 ${STRIP}`}>
          <Waypoints className="w-4 h-4 text-[#7C3AED]" />
          <h3 className="text-[13px] font-semibold text-gray-900">Requirements traceability</h3>
          <span className="text-[11px] text-gray-400">requirement → case → defect</span>
          <button type="button" onClick={onClose} className="ml-auto p-1.5 rounded-md text-gray-400 hover:text-[#7C3AED] hover:bg-[#F5F3FF]"><X className="w-4 h-4" /></button>
        </div>

        <div className="p-4 space-y-3 overflow-y-auto min-h-0">
          {error && <div className="flex items-start gap-2 px-3 py-2 bg-red-50 border border-red-200 rounded-lg"><AlertTriangle className="w-4 h-4 text-red-500 flex-shrink-0 mt-px" /><p className="text-[12px] text-red-700 min-w-0 whitespace-pre-wrap break-words">{error}</p></div>}

          {/* Matrix */}
          <div className={`${CARD} p-3 space-y-2`}>
            <div className="flex flex-wrap items-end gap-2">
              <div className="flex-1 min-w-[180px]"><label className={LABEL}>Run to trace against</label>
                <select value={runId} onChange={(e) => setRunId(e.target.value)} className={FIELD}>
                  <option value="">Latest run</option>
                  {runs.map((r, i) => <option key={r.runId ?? r.id ?? i} value={String(r.runId ?? r.id ?? '')}>{(r.title || r.runId || 'Run')}</option>)}
                </select>
              </div>
              <button type="button" onClick={() => void build()} disabled={building} className={PRIMARY_BTN}>{building ? <Spinner className="w-3.5 h-3.5 animate-spin" /> : <Play className="w-3.5 h-3.5" />}Build matrix</button>
            </div>
            {matrix && (
              <>
                <div className="flex flex-wrap gap-2 text-[11.5px]">
                  <span className="px-2 py-0.5 rounded border bg-gray-50 border-gray-200 font-mono tabular-nums">{matrix.summary.coveragePct}% covered</span>
                  <span className="px-2 py-0.5 rounded border bg-emerald-50 border-emerald-200 text-emerald-700 tabular-nums">{matrix.summary.covered} covered</span>
                  <span className="px-2 py-0.5 rounded border bg-amber-50 border-amber-200 text-amber-700 tabular-nums">{matrix.summary.partial} partial</span>
                  <span className="px-2 py-0.5 rounded border bg-red-50 border-red-200 text-red-700 tabular-nums">{matrix.summary.failing} failing</span>
                  <span className="px-2 py-0.5 rounded border bg-gray-50 border-gray-200 text-gray-500 tabular-nums">{matrix.summary.uncovered} uncovered</span>
                  {matrix.runTitle && <span className="text-gray-400 ml-auto truncate max-w-[40%]">{matrix.runTitle}</span>}
                </div>
                <div className="border border-[#E9E5FB] rounded-lg overflow-hidden">
                  <table className="w-full text-[11.5px]">
                    <thead className={THEAD}><tr className="text-gray-500 text-left">
                      <th className="font-semibold px-2.5 py-1.5">Requirement</th>
                      <th className="font-semibold px-2.5 py-1.5">Status</th>
                      <th className="font-semibold px-2.5 py-1.5 text-right">Cases</th>
                      <th className="font-semibold px-2.5 py-1.5 text-right">Defects</th>
                    </tr></thead>
                    <tbody className="divide-y divide-gray-100">
                      {matrix.rows.length === 0 && <tr><td colSpan={4} className="px-2.5 py-4 text-center text-gray-400">No requirements yet — add some below.</td></tr>}
                      {matrix.rows.map((row) => (
                        <tr key={row.requirement.id} className="align-top">
                          <td className="px-2.5 py-1.5"><span className="text-gray-700">{row.requirement.reqKey ? <b className="font-mono text-[#6D28D9]">{row.requirement.reqKey} </b> : null}{row.requirement.title}</span></td>
                          <td className="px-2.5 py-1.5"><span className={`inline-flex px-1.5 py-0.5 rounded border text-[10.5px] font-semibold ${STATUS_STYLE[row.status]}`}>{row.status}</span></td>
                          <td className="px-2.5 py-1.5 text-right font-mono tabular-nums text-gray-600">{row.passed}✓ {row.failed}✗ {row.notRun}·</td>
                          <td className="px-2.5 py-1.5 text-right font-mono tabular-nums">{row.defects.length ? <span className="text-red-600">{row.defects.length}</span> : <span className="text-gray-300">0</span>}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}
          </div>

          {/* Requirements list */}
          {requirements.length > 0 && (
            <div className="border border-gray-100 rounded-lg divide-y divide-gray-100 overflow-hidden">
              {requirements.map((r) => (
                <div key={r.id} className={`flex items-center gap-2 px-3 py-1.5 ${form.id === r.id ? 'bg-[#F5F3FF]' : ''}`}>
                  <button type="button" onClick={() => editReq(r)} className="flex-1 min-w-0 text-left flex items-baseline gap-2">
                    {r.reqKey && <span className="text-[11px] font-mono text-[#6D28D9] flex-shrink-0">{r.reqKey}</span>}
                    <span className="text-[12px] font-medium text-gray-800 truncate">{r.title}</span>
                    <span className="text-[10.5px] text-gray-400 flex-shrink-0">{r.linkedEndpoints.length}ep · {r.linkedScenarios.length}sc</span>
                  </button>
                  <button type="button" onClick={() => void remove(r.id)} className="p-1 rounded text-gray-400 hover:text-red-500 flex-shrink-0"><Trash2 className="w-3.5 h-3.5" /></button>
                </div>
              ))}
            </div>
          )}

          {/* Editor */}
          <div className={`${CARD} p-3 space-y-2.5`}>
            <div className="flex items-center justify-between">
              <h4 className="text-[12px] font-semibold text-gray-800">{form.id ? 'Edit requirement' : 'New requirement'}</h4>
              {form.id && <button type="button" onClick={() => setForm(blankForm())} className="text-[11px] text-[#7C3AED] hover:underline">＋ New</button>}
            </div>
            <div className="flex gap-2">
              <div className="w-28"><label className={LABEL}>Key</label><input value={form.reqKey} onChange={(e) => setForm((p) => ({ ...p, reqKey: e.target.value }))} placeholder="REQ-1" className={INPUT} /></div>
              <div className="flex-1 min-w-0"><label className={LABEL}>Title</label><input value={form.title} onChange={(e) => setForm((p) => ({ ...p, title: e.target.value }))} placeholder="Users can reset their password" className={INPUT} /></div>
              <div className="w-28"><label className={LABEL}>Priority</label><select value={form.priority} onChange={(e) => setForm((p) => ({ ...p, priority: e.target.value as Priority }))} className={FIELD}>{PRIORITIES.map((pr) => <option key={pr} value={pr}>{pr}</option>)}</select></div>
            </div>
            <div><label className={LABEL}>Description</label><textarea value={form.description} onChange={(e) => setForm((p) => ({ ...p, description: e.target.value }))} rows={2} className={`${INPUT} resize-y`} /></div>

            <div>
              <label className={LABEL}>Linked endpoints</label>
              <div className="flex flex-wrap gap-1 mb-1">
                {form.linkedEndpoints.map((l, i) => (
                  <span key={i} className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded border border-[#DDD6FE] bg-[#F5F3FF] text-[10.5px] font-mono text-[#6D28D9]">{l.method} {l.url}
                    <button type="button" onClick={() => setForm((p) => ({ ...p, linkedEndpoints: p.linkedEndpoints.filter((_, j) => j !== i) }))} className="hover:text-red-500">×</button>
                  </span>
                ))}
              </div>
              {endpoints.length > 0 && (
                <select value={epSel} onChange={(e) => addEndpoint(e.target.value)} className={FIELD}>
                  <option value="">＋ link an endpoint…</option>
                  {endpoints.map((e) => <option key={e.id} value={`${e.method} ${e.url}`}>{e.method} {e.url}</option>)}
                </select>
              )}
            </div>

            <div><label className={LABEL}>Linked scenarios (one per line — match scenario titles)</label><textarea value={form.scenariosText} onChange={(e) => setForm((p) => ({ ...p, scenariosText: e.target.value }))} rows={2} placeholder={'Reset password happy path\nReset password with expired token'} className={`${INPUT} resize-y font-mono`} /></div>

            <div>
              <div className="flex items-center justify-between mb-1"><span className={`${LABEL} mb-0`}>Known defects (external refs)</span><button type="button" onClick={() => setForm((p) => ({ ...p, defects: [...p.defects, { key: '', url: '' }] }))} className="text-[11px] text-[#7C3AED] hover:underline inline-flex items-center gap-0.5"><Plus className="w-3 h-3" />Add</button></div>
              <div className="space-y-1.5">
                {form.defects.map((d, i) => (
                  <div key={i} className="flex gap-1.5 items-center">
                    <input value={d.key} onChange={(e) => setForm((p) => ({ ...p, defects: p.defects.map((x, j) => (j === i ? { ...x, key: e.target.value } : x)) }))} placeholder="JIRA-123" className={`${FIELD} w-32 flex-shrink-0`} />
                    <input value={d.url} onChange={(e) => setForm((p) => ({ ...p, defects: p.defects.map((x, j) => (j === i ? { ...x, url: e.target.value } : x)) }))} placeholder="https://…" className={`${FIELD} flex-1 min-w-0`} />
                    <button type="button" onClick={() => setForm((p) => ({ ...p, defects: p.defects.filter((_, j) => j !== i) }))} className="p-1 text-gray-400 hover:text-red-500 flex-shrink-0"><Trash2 className="w-3.5 h-3.5" /></button>
                  </div>
                ))}
              </div>
            </div>

            <div className="flex items-center gap-2">
              <input value={form.source} onChange={(e) => setForm((p) => ({ ...p, source: e.target.value }))} placeholder="source (optional)" className={`${FIELD} w-40`} />
              <button type="button" onClick={() => void save()} disabled={saving || !form.title.trim()} className={`${PRIMARY_BTN} ml-auto`}>{saving ? <Spinner className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}{form.id ? 'Update' : 'Create'}</button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
