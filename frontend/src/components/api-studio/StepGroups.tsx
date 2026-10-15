/**
 * StepGroups — a reusable step library.
 *
 * Login, token refresh and teardown are the same handful of requests copied
 * into flow after flow. A step group names that sequence once and stores it;
 * a Flow then references it by groupId instead of repeating the steps, so a
 * change to the login group reaches every flow that uses it. This is the
 * editor for that library — a master list of saved groups on the left and a
 * lightweight step editor on the right. Opt-in, isolated from the pipeline.
 */
import { useEffect, useState } from 'react';
import { Layers, Plus, Trash2, Save, X, Pencil, ChevronUp, ChevronDown, AlertTriangle } from 'lucide-react';
import Spinner from '@/components/feedback/Spinner';
import { CARD, STRIP, INPUT, FIELD, LABEL, PRIMARY_BTN, SECONDARY_BTN, relativeTime } from './format';
import { MethodBadge } from './primitives';
import { listStepGroups, saveStepGroup, deleteStepGroup, type ApiStepGroup, type FlowStep } from '@/services/api';
import type { CatalogEndpoint } from './types';

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;
const EXTRACT_FROM = ['body', 'header', 'status'] as const;
type ExtractFrom = (typeof EXTRACT_FROM)[number];

/** A single captured value — login groups use this to expose `{{token}}`. */
type ExtractRow = { name: string; from: ExtractFrom; path: string };
/** A step as the editor holds it — flattened from the broad FlowStep shape. */
type EditStep = { name: string; method: string; url: string; body: string; extract: ExtractRow | null };
/** The group currently open in the editor. No `id` ⇒ a group not yet saved. */
type Draft = { id?: string; name: string; steps: EditStep[] };

const blankStep = (): EditStep => ({ name: '', method: 'GET', url: '', body: '', extract: null });

function stepToEdit(s: FlowStep): EditStep {
  const ex = s.extract && s.extract.length ? s.extract[0] : null;
  return {
    name: s.name || '',
    method: (s.method || 'GET').toUpperCase(),
    url: s.url || '',
    body: s.body || '',
    extract: ex ? { name: ex.name || '', from: (ex.from || 'body') as ExtractFrom, path: ex.path || '' } : null,
  };
}

function groupToDraft(g: ApiStepGroup): Draft {
  return { id: g.id, name: g.name, steps: (g.steps || []).map(stepToEdit) };
}

function errMessage(err: unknown, fallback: string): string {
  const e = err as { response?: { data?: { error?: string } }; message?: string };
  return e?.response?.data?.error || e?.message || fallback;
}

export default function StepGroups({ endpoints, onClose }: { endpoints: CatalogEndpoint[]; onClose: () => void }) {
  const [groups, setGroups] = useState<ApiStepGroup[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);
  const [deletingId, setDeletingId] = useState('');

  const refresh = async () => {
    setLoading(true); setError('');
    try {
      const { groups: list } = await listStepGroups();
      setGroups(list || []);
    } catch (err) {
      setError(errMessage(err, 'Could not load step groups.'));
    } finally { setLoading(false); }
  };

  useEffect(() => { void refresh(); }, []);

  /* ── Step mutations on the open draft ── */
  const setStep = (i: number, patch: Partial<EditStep>) =>
    setEditing((d) => (d ? { ...d, steps: d.steps.map((s, j) => (j === i ? { ...s, ...patch } : s)) } : d));
  const addStep = () => setEditing((d) => (d ? { ...d, steps: [...d.steps, blankStep()] } : d));
  const delStep = (i: number) => setEditing((d) => (d ? { ...d, steps: d.steps.filter((_, j) => j !== i) } : d));
  const moveStep = (i: number, dir: -1 | 1) =>
    setEditing((d) => {
      if (!d) return d;
      const j = i + dir;
      if (j < 0 || j >= d.steps.length) return d;
      const steps = [...d.steps];
      [steps[i], steps[j]] = [steps[j], steps[i]];
      return { ...d, steps };
    });

  const newGroup = () => { setError(''); setEditing({ name: '', steps: [blankStep()] }); };
  const openGroup = (g: ApiStepGroup) => { setError(''); setEditing(groupToDraft(g)); };

  const save = async () => {
    if (!editing) return;
    const name = editing.name.trim();
    if (!name) { setError('Give the group a name before saving.'); return; }
    setSaving(true); setError('');
    try {
      const steps = editing.steps.map((s) => ({
        name: s.name.trim() || undefined,
        method: s.method,
        url: s.url.trim(),
        body: s.body.trim() ? s.body : undefined,
        extract: s.extract && s.extract.name.trim()
          ? [{ name: s.extract.name.trim(), from: s.extract.from, path: s.extract.path.trim() || undefined }]
          : undefined,
      })) as FlowStep[];
      const { group } = await saveStepGroup({ id: editing.id, name, steps });
      await refresh();
      setEditing(groupToDraft(group));
    } catch (err) {
      setError(errMessage(err, 'Could not save the step group.'));
    } finally { setSaving(false); }
  };

  const remove = async (g: ApiStepGroup) => {
    if (!window.confirm(`Delete step group "${g.name}"? Flows that reference it will lose the steps.`)) return;
    setDeletingId(g.id); setError('');
    try {
      await deleteStepGroup(g.id);
      if (editing?.id === g.id) setEditing(null);
      await refresh();
    } catch (err) {
      setError(errMessage(err, 'Could not delete the step group.'));
    } finally { setDeletingId(''); }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-[#1E1B4B]/45 backdrop-blur-md p-4" onClick={onClose}>
      <div className={`${CARD} w-full max-w-4xl max-h-[88vh] flex flex-col overflow-hidden`} onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className={`flex items-center gap-2 px-4 h-12 border-b border-[#EDE9FE] flex-shrink-0 ${STRIP}`}>
          <Layers className="w-4 h-4 text-[#7C3AED]" />
          <h3 className="text-[13px] font-semibold text-gray-900">Step Groups — reusable step library</h3>
          <span className="text-[11px] text-gray-400">{groups.length} group{groups.length === 1 ? '' : 's'}</span>
          <button type="button" onClick={onClose} className="ml-auto p-1.5 rounded-md text-gray-400 hover:text-[#7C3AED] hover:bg-[#F5F3FF]"><X className="w-4 h-4" /></button>
        </div>

        <div className="flex flex-1 min-h-0">
          {/* Master list */}
          <div className="w-60 flex-shrink-0 border-r border-[#EDE9FE] flex flex-col min-h-0">
            <div className="px-3 py-2.5 border-b border-[#EDE9FE] flex-shrink-0">
              <button type="button" onClick={newGroup} className={`${SECONDARY_BTN} w-full justify-center`}>
                <Plus className="w-3.5 h-3.5" />New group
              </button>
            </div>
            <div className="flex-1 overflow-y-auto min-h-0">
              {loading && groups.length === 0 ? (
                <div className="flex items-center justify-center gap-2 py-10 text-[12px] text-gray-500"><Spinner className="w-4 h-4 animate-spin text-[#7C3AED]" />Loading…</div>
              ) : groups.length === 0 ? (
                <div className="flex flex-col items-center justify-center gap-1.5 py-12 px-4 text-center">
                  <Layers className="w-6 h-6 text-gray-300" />
                  <p className="text-[11.5px] text-gray-400">No step groups yet.</p>
                </div>
              ) : (
                <ul className="divide-y divide-gray-50">
                  {groups.map((g) => {
                    const active = editing?.id === g.id;
                    return (
                      <li key={g.id} className={`group flex items-center gap-2 px-3 py-2 cursor-pointer ${active ? 'bg-[#F5F3FF]' : 'hover:bg-gray-50'}`} onClick={() => openGroup(g)}>
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-1.5">
                            <span className={`text-[12.5px] font-medium truncate ${active ? 'text-[#6D28D9]' : 'text-gray-800'}`}>{g.name || 'Untitled group'}</span>
                          </div>
                          <div className="text-[10.5px] text-gray-400">{g.steps?.length || 0} step{(g.steps?.length || 0) === 1 ? '' : 's'} · {relativeTime(g.updatedAt)}</div>
                        </div>
                        <button
                          type="button"
                          onClick={(e) => { e.stopPropagation(); void remove(g); }}
                          disabled={deletingId === g.id}
                          className="p-1 rounded text-gray-300 opacity-0 group-hover:opacity-100 hover:text-red-500 disabled:opacity-40 flex-shrink-0"
                          title="Delete group"
                        >
                          {deletingId === g.id ? <Spinner className="w-3.5 h-3.5 animate-spin" /> : <Trash2 className="w-3.5 h-3.5" />}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          </div>

          {/* Detail / editor */}
          <div className="flex-1 flex flex-col min-h-0">
            {!editing ? (
              <div className="flex-1 flex flex-col items-center justify-center gap-2 px-8 text-center">
                <Pencil className="w-7 h-7 text-gray-300" />
                <p className="text-[12.5px] text-gray-500 max-w-sm">Pick a group on the left to edit it, or <span className="text-gray-700 font-medium">+ New group</span> to build a reusable sequence like login or teardown.</p>
              </div>
            ) : (
              <>
                <div className="px-4 py-3 border-b border-[#EDE9FE] flex-shrink-0 space-y-1.5">
                  <label className={LABEL}>Group name</label>
                  <input
                    value={editing.name}
                    onChange={(e) => setEditing((d) => (d ? { ...d, name: e.target.value } : d))}
                    placeholder="e.g. Login + capture token"
                    className={INPUT}
                  />
                </div>

                {error && (
                  <div className="flex items-start gap-2 mx-4 mt-3 px-3 py-2 bg-red-50 border border-red-200 rounded-lg flex-shrink-0">
                    <AlertTriangle className="w-4 h-4 text-red-500 flex-shrink-0 mt-px" />
                    <p className="text-[12px] text-red-700 min-w-0">{error}</p>
                  </div>
                )}

                <div className="flex-1 overflow-y-auto min-h-0 px-4 py-3 space-y-2.5">
                  {editing.steps.length === 0 && (
                    <p className="text-[12px] text-gray-400 text-center py-6">No steps yet — add the first request below.</p>
                  )}
                  {editing.steps.map((s, i) => (
                    <div key={i} className="border border-gray-100 rounded-lg p-2.5 space-y-2 bg-[#FCFBFF]">
                      <div className="flex items-center gap-1.5">
                        <MethodBadge method={s.method} />
                        <span className="text-[10.5px] font-semibold text-gray-400 tabular-nums">#{i + 1}</span>
                        <input value={s.name} onChange={(e) => setStep(i, { name: e.target.value })} placeholder="step name (optional)" className={`${FIELD} flex-1 min-w-0`} />
                        <div className="flex items-center gap-0.5 flex-shrink-0">
                          <button type="button" onClick={() => moveStep(i, -1)} disabled={i === 0} className="p-1 rounded text-gray-300 hover:text-[#7C3AED] disabled:opacity-30" title="Move up"><ChevronUp className="w-3.5 h-3.5" /></button>
                          <button type="button" onClick={() => moveStep(i, 1)} disabled={i === editing.steps.length - 1} className="p-1 rounded text-gray-300 hover:text-[#7C3AED] disabled:opacity-30" title="Move down"><ChevronDown className="w-3.5 h-3.5" /></button>
                          <button type="button" onClick={() => delStep(i)} className="p-1 rounded text-gray-300 hover:text-red-500" title="Remove step"><Trash2 className="w-3.5 h-3.5" /></button>
                        </div>
                      </div>

                      <div className="flex items-center gap-1.5">
                        <select value={s.method} onChange={(e) => setStep(i, { method: e.target.value })} className={`${FIELD} w-24 flex-shrink-0`}>
                          {METHODS.map((m) => <option key={m} value={m}>{m}</option>)}
                        </select>
                        <input value={s.url} onChange={(e) => setStep(i, { url: e.target.value })} placeholder="https://api.example.com/login" className={`${FIELD} flex-1 min-w-0`} />
                        {endpoints.length > 0 && (
                          <select
                            value=""
                            onChange={(e) => {
                              const ep = endpoints.find((x) => x.id === e.target.value);
                              if (ep) setStep(i, { url: ep.url, method: (ep.method || 'GET').toUpperCase() });
                            }}
                            className={`${FIELD} w-32 flex-shrink-0`}
                            title="Prefill from a catalogue endpoint"
                          >
                            <option value="">From endpoint…</option>
                            {endpoints.map((ep) => <option key={ep.id} value={ep.id}>{(ep.method || 'GET').toUpperCase()} {ep.title}</option>)}
                          </select>
                        )}
                      </div>

                      <textarea value={s.body} onChange={(e) => setStep(i, { body: e.target.value })} placeholder="request body (optional JSON)" rows={2} className={`${INPUT} font-mono text-[11.5px] resize-y`} />

                      {s.extract ? (
                        <div className="flex items-center gap-1.5">
                          <span className="text-[10px] font-semibold uppercase tracking-wide text-gray-400 flex-shrink-0">Capture</span>
                          <input value={s.extract.name} onChange={(e) => setStep(i, { extract: { ...s.extract!, name: e.target.value } })} placeholder="token" className={`${FIELD} w-28 flex-shrink-0`} />
                          <span className="text-[11px] text-gray-400 flex-shrink-0">from</span>
                          <select value={s.extract.from} onChange={(e) => setStep(i, { extract: { ...s.extract!, from: e.target.value as ExtractFrom } })} className={`${FIELD} w-24 flex-shrink-0`}>
                            {EXTRACT_FROM.map((f) => <option key={f} value={f}>{f}</option>)}
                          </select>
                          {s.extract.from !== 'status' && (
                            <input value={s.extract.path} onChange={(e) => setStep(i, { extract: { ...s.extract!, path: e.target.value } })} placeholder={s.extract.from === 'header' ? 'Set-Cookie' : 'data.accessToken'} className={`${FIELD} flex-1 min-w-0`} />
                          )}
                          <button type="button" onClick={() => setStep(i, { extract: null })} className="p-1 rounded text-gray-300 hover:text-red-500 flex-shrink-0" title="Remove capture"><X className="w-3.5 h-3.5" /></button>
                        </div>
                      ) : (
                        <button type="button" onClick={() => setStep(i, { extract: { name: '', from: 'body', path: '' } })} className="inline-flex items-center gap-1 text-[11px] font-medium text-[#6D28D9] hover:text-[#5B21B6]">
                          <Plus className="w-3.5 h-3.5" />Capture a value (e.g. {'{{token}}'})
                        </button>
                      )}
                    </div>
                  ))}

                  <button type="button" onClick={addStep} className={`${SECONDARY_BTN} w-full justify-center`}>
                    <Plus className="w-3.5 h-3.5" />Add step
                  </button>
                </div>

                <div className="flex items-center gap-3 px-4 py-3 border-t border-[#EDE9FE] flex-shrink-0">
                  <p className="text-[11px] text-gray-400 min-w-0 flex-1">Reference a saved group from a Flow via a group step (groupId).</p>
                  <button type="button" onClick={() => void save()} disabled={saving} className={PRIMARY_BTN}>
                    {saving ? <Spinner className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}Save group
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
