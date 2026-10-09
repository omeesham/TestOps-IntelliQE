/**
 * Approvals — multi-stage review/approval gating for API runs.
 *
 * Two tabs. Workflows defines ordered approval stages (e.g. QA Lead → Release
 * Manager), each needing N approvals from a named set of approvers. Requests
 * ties a run to a workflow and advances stage-by-stage as approvers act; one
 * reject stops it. Layered beside the existing single-stage run sign-off; it
 * grants no permissions and touches nothing in the pipeline.
 */
import { useEffect, useState } from 'react';
import { Stamp, X, Plus, Trash2, Save, CheckCircle2, XCircle, Clock, AlertTriangle, Ban } from 'lucide-react';
import Spinner from '@/components/feedback/Spinner';
import { useToast } from '@/components/feedback/ToastProvider';
import {
  listApprovalWorkflows, saveApprovalWorkflow, deleteApprovalWorkflow,
  listApprovalRequests, createApprovalRequest, actOnApprovalRequest, cancelApprovalRequest,
  listTenantMembers, listApiRuns,
  type ApprovalWorkflow, type ApprovalRequest, type ApprovalStage, type TenantMember,
} from '@/services/api';
import { CARD, STRIP, INPUT, FIELD, LABEL, PRIMARY_BTN, SECONDARY_BTN, relativeTime } from './format';

type Tab = 'requests' | 'workflows';
const TAB_ACTIVE = 'px-3 py-1.5 text-[12px] font-medium text-[#6D28D9] border-b-2 border-[#7C3AED]';
const TAB_INACTIVE = 'px-3 py-1.5 text-[12px] font-medium text-gray-500 hover:text-gray-700';

let _seq = 0;
const nextKey = () => `st-${Date.now().toString(36)}-${(_seq++).toString(36)}`;
interface EditStage { _k: string; name: string; approvers: string; minApprovals: string }
const blankStage = (): EditStage => ({ _k: nextKey(), name: '', approvers: '', minApprovals: '1' });

const STATUS_STYLE: Record<string, string> = {
  pending: 'bg-amber-50 text-amber-700 border-amber-200',
  approved: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  rejected: 'bg-red-50 text-red-700 border-red-200',
  canceled: 'bg-gray-100 text-gray-500 border-gray-200',
};

export default function Approvals({ onClose }: { onClose: () => void }) {
  const toast = useToast();
  const [tab, setTab] = useState<Tab>('requests');
  const [error, setError] = useState('');

  const [workflows, setWorkflows] = useState<ApprovalWorkflow[]>([]);
  const [members, setMembers] = useState<TenantMember[]>([]);
  const [requests, setRequests] = useState<ApprovalRequest[]>([]);
  const [runs, setRuns] = useState<any[]>([]);

  // workflow editor
  const [wfId, setWfId] = useState<string | null>(null);
  const [wfName, setWfName] = useState('');
  const [stages, setStages] = useState<EditStage[]>([blankStage()]);
  const [savingWf, setSavingWf] = useState(false);

  // create request
  const [newWorkflowId, setNewWorkflowId] = useState('');
  const [newRunId, setNewRunId] = useState('');
  const [creating, setCreating] = useState(false);

  // act
  const [noteFor, setNoteFor] = useState<Record<string, string>>({});
  const [acting, setActing] = useState('');

  const refresh = async () => {
    const [wf, rq] = await Promise.all([listApprovalWorkflows(), listApprovalRequests()]);
    setWorkflows(wf); setRequests(rq);
    setNewWorkflowId((prev) => prev || wf[0]?.id || '');
  };
  useEffect(() => {
    void refresh().catch((e: any) => setError(e?.response?.data?.error || e?.message || 'Request failed.'));
    void listTenantMembers().then(setMembers).catch(() => { /* members are a convenience */ });
    void listApiRuns(1, 20).then((r) => {
      const items = Array.isArray(r?.items) ? r.items : [];
      setRuns(items);
      if (items.length) setNewRunId(String(items[0].runId ?? items[0].id ?? ''));
    }).catch(() => { /* runs are a convenience */ });
  }, []);

  // ── workflow editor ──
  const resetWf = () => { setWfId(null); setWfName(''); setStages([blankStage()]); };
  const editWf = (w: ApprovalWorkflow) => {
    setWfId(w.id); setWfName(w.name);
    setStages(w.stages.length ? w.stages.map((s) => ({ _k: nextKey(), name: s.name, approvers: s.approvers.join(', '), minApprovals: String(s.minApprovals) })) : [blankStage()]);
  };
  const patchStage = (k: string, p: Partial<EditStage>) => setStages((prev) => prev.map((s) => (s._k === k ? { ...s, ...p } : s)));
  const saveWf = async () => {
    if (!wfName.trim()) { setError('Name the workflow.'); return; }
    const out: ApprovalStage[] = stages.filter((s) => s.name.trim()).map((s) => ({
      key: s.name.trim(), name: s.name.trim(),
      approvers: s.approvers.split(',').map((a) => a.trim()).filter(Boolean),
      minApprovals: Math.max(1, Number(s.minApprovals) || 1),
    }));
    if (!out.length) { setError('Add at least one stage.'); return; }
    setSavingWf(true); setError('');
    try {
      await saveApprovalWorkflow({ id: wfId ?? undefined, name: wfName.trim(), stages: out });
      toast.success(wfId ? 'Workflow updated' : 'Workflow created');
      resetWf(); await refresh();
    } catch (e: any) { setError(e?.response?.data?.error || e?.message || 'Request failed.'); }
    finally { setSavingWf(false); }
  };
  const removeWf = async (id: string) => {
    try { await deleteApprovalWorkflow(id); if (wfId === id) resetWf(); await refresh(); toast.success('Workflow deleted'); }
    catch (e: any) { toast.error('Delete failed', e?.response?.data?.error || e?.message || 'Request failed.'); }
  };

  // ── requests ──
  const create = async () => {
    if (!newWorkflowId || !newRunId) { setError('Pick a workflow and a run.'); return; }
    setCreating(true); setError('');
    try { await createApprovalRequest({ workflowId: newWorkflowId, runId: newRunId }); await refresh(); toast.success('Approval requested'); }
    catch (e: any) { setError(e?.response?.data?.error || e?.message || 'Request failed.'); }
    finally { setCreating(false); }
  };
  const act = async (id: string, decision: 'approve' | 'reject') => {
    setActing(`${id}:${decision}`); setError('');
    try { await actOnApprovalRequest({ requestId: id, decision, note: noteFor[id] || '' }); await refresh(); toast.success(decision === 'approve' ? 'Approved' : 'Rejected'); }
    catch (e: any) { toast.error('Action failed', e?.response?.data?.error || e?.message || 'Request failed.'); }
    finally { setActing(''); }
  };
  const cancel = async (id: string) => {
    try { await cancelApprovalRequest(id); await refresh(); toast.success('Request canceled'); }
    catch (e: any) { toast.error('Cancel failed', e?.response?.data?.error || e?.message || 'Request failed.'); }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-[#1E1B4B]/30 backdrop-blur-sm p-4" onClick={onClose}>
      <div className={`${CARD} w-full max-w-2xl max-h-[88vh] flex flex-col overflow-hidden`} onClick={(e) => e.stopPropagation()}>
        <div className={`flex items-center gap-2 px-4 h-12 border-b border-[#EDE9FE] flex-shrink-0 ${STRIP}`}>
          <Stamp className="w-4 h-4 text-[#7C3AED]" />
          <h3 className="text-[13px] font-semibold text-gray-900">Multi-stage approvals</h3>
          <span className="text-[11px] text-gray-400">stage-by-stage release gating</span>
          <button type="button" onClick={onClose} className="ml-auto p-1.5 rounded-md text-gray-400 hover:text-[#7C3AED] hover:bg-[#F5F3FF]"><X className="w-4 h-4" /></button>
        </div>

        <div className="flex items-center gap-1 px-3 border-b border-[#EDE9FE] flex-shrink-0">
          <button type="button" onClick={() => { setTab('requests'); setError(''); }} className={tab === 'requests' ? TAB_ACTIVE : TAB_INACTIVE}>Requests</button>
          <button type="button" onClick={() => { setTab('workflows'); setError(''); }} className={tab === 'workflows' ? TAB_ACTIVE : TAB_INACTIVE}>Workflows</button>
        </div>

        <div className="p-4 space-y-3 overflow-y-auto min-h-0">
          {error && <div className="flex items-start gap-2 px-3 py-2 bg-red-50 border border-red-200 rounded-lg"><AlertTriangle className="w-4 h-4 text-red-500 flex-shrink-0 mt-px" /><p className="text-[12px] text-red-700 min-w-0 whitespace-pre-wrap break-words">{error}</p></div>}

          {tab === 'requests' && (
            <>
              {/* Create */}
              <div className={`${CARD} p-3 flex flex-wrap items-end gap-2`}>
                <div className="min-w-[150px] flex-1"><label className={LABEL}>Workflow</label>
                  <select value={newWorkflowId} onChange={(e) => setNewWorkflowId(e.target.value)} className={FIELD} disabled={!workflows.length}>
                    {workflows.length === 0 && <option value="">Create a workflow first</option>}
                    {workflows.map((w) => <option key={w.id} value={w.id}>{w.name} ({w.stages.length} stage{w.stages.length === 1 ? '' : 's'})</option>)}
                  </select>
                </div>
                <div className="min-w-[150px] flex-1"><label className={LABEL}>Run</label>
                  <select value={newRunId} onChange={(e) => setNewRunId(e.target.value)} className={FIELD} disabled={!runs.length}>
                    {runs.length === 0 && <option value="">No runs yet</option>}
                    {runs.map((r, i) => <option key={r.runId ?? r.id ?? i} value={String(r.runId ?? r.id ?? '')}>{(r.title || r.runId || 'Run')}</option>)}
                  </select>
                </div>
                <button type="button" onClick={() => void create()} disabled={creating || !newWorkflowId || !newRunId} className={PRIMARY_BTN}>{creating ? <Spinner className="w-3.5 h-3.5 animate-spin" /> : <Plus className="w-3.5 h-3.5" />}Request</button>
              </div>

              {requests.length === 0 && <p className="text-[12px] text-gray-400">No approval requests yet.</p>}
              {requests.map((r) => {
                const stage = r.stages[r.currentStage];
                const stageApprovals = r.decisions.filter((d) => d.stage === r.currentStage && d.decision === 'approve').length;
                return (
                  <div key={r.id} className={`${CARD} p-3 space-y-2`}>
                    <div className="flex items-center gap-2">
                      <span className="text-[12px] font-medium text-gray-800 truncate flex-1 min-w-0">{r.title}</span>
                      <span className={`text-[10.5px] font-semibold px-2 py-0.5 rounded border ${STATUS_STYLE[r.status] || STATUS_STYLE.canceled}`}>{r.status}</span>
                      <span className="text-[10.5px] text-gray-400">{relativeTime(r.createdAt)}</span>
                    </div>
                    {/* stage pipeline */}
                    <div className="flex flex-wrap items-center gap-1.5">
                      {r.stages.map((st, i) => {
                        const done = i < r.currentStage || r.status === 'approved';
                        const activeNow = i === r.currentStage && r.status === 'pending';
                        return <span key={i} className={`inline-flex items-center gap-1 text-[10.5px] px-2 py-0.5 rounded-full border ${done ? 'bg-emerald-50 border-emerald-200 text-emerald-700' : activeNow ? 'bg-[#F5F3FF] border-[#DDD6FE] text-[#6D28D9]' : 'bg-gray-50 border-gray-200 text-gray-400'}`}>{done ? <CheckCircle2 className="w-3 h-3" /> : activeNow ? <Clock className="w-3 h-3" /> : null}{st.name}</span>;
                      })}
                    </div>
                    {r.status === 'pending' && stage && (
                      <div className="space-y-1.5">
                        <p className="text-[11px] text-gray-500">Stage <b>{stage.name}</b> — {stageApprovals}/{stage.minApprovals} approvals{stage.approvers.length ? ` · approvers: ${stage.approvers.join(', ')}` : ''}</p>
                        <input value={noteFor[r.id] || ''} onChange={(e) => setNoteFor((p) => ({ ...p, [r.id]: e.target.value }))} placeholder="note (optional)" className={`${INPUT} py-1`} />
                        <div className="flex items-center gap-2">
                          <button type="button" onClick={() => void act(r.id, 'approve')} disabled={!!acting} className={PRIMARY_BTN}>{acting === `${r.id}:approve` ? <Spinner className="w-3.5 h-3.5 animate-spin" /> : <CheckCircle2 className="w-3.5 h-3.5" />}Approve</button>
                          <button type="button" onClick={() => void act(r.id, 'reject')} disabled={!!acting} className={SECONDARY_BTN}>{acting === `${r.id}:reject` ? <Spinner className="w-3.5 h-3.5 animate-spin" /> : <XCircle className="w-3.5 h-3.5" />}Reject</button>
                          <button type="button" onClick={() => void cancel(r.id)} className="ml-auto p-1.5 rounded text-gray-400 hover:text-red-500" title="Cancel request"><Ban className="w-4 h-4" /></button>
                        </div>
                      </div>
                    )}
                    {r.decisions.length > 0 && (
                      <div className="space-y-0.5 pt-1 border-t border-gray-100">
                        {r.decisions.map((d, i) => (
                          <div key={i} className="flex items-center gap-1.5 text-[11px] text-gray-500">
                            {d.decision === 'approve' ? <CheckCircle2 className="w-3 h-3 text-emerald-600" /> : <XCircle className="w-3 h-3 text-red-500" />}
                            <span>{d.approver} {d.decision}d {r.stages[d.stage]?.name ? `“${r.stages[d.stage]!.name}”` : ''}{d.note ? ` — ${d.note}` : ''}</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </>
          )}

          {tab === 'workflows' && (
            <>
              {workflows.length > 0 && (
                <div className="border border-gray-100 rounded-lg divide-y divide-gray-100 overflow-hidden">
                  {workflows.map((w) => (
                    <div key={w.id} className={`flex items-center gap-2 px-3 py-1.5 ${wfId === w.id ? 'bg-[#F5F3FF]' : ''}`}>
                      <button type="button" onClick={() => editWf(w)} className="flex-1 min-w-0 text-left flex items-baseline gap-2">
                        <span className="text-[12px] font-medium text-gray-800 truncate">{w.name}</span>
                        <span className="text-[10.5px] text-gray-400 whitespace-nowrap">{w.stages.map((s) => s.name).join(' → ')}</span>
                      </button>
                      <button type="button" onClick={() => void removeWf(w.id)} className="p-1 rounded text-gray-400 hover:text-red-500 flex-shrink-0"><Trash2 className="w-3.5 h-3.5" /></button>
                    </div>
                  ))}
                </div>
              )}

              <div className={`${CARD} p-3 space-y-2.5`}>
                <div className="flex items-center justify-between">
                  <h4 className="text-[12px] font-semibold text-gray-800">{wfId ? 'Edit workflow' : 'New workflow'}</h4>
                  {wfId && <button type="button" onClick={resetWf} className="text-[11px] text-[#7C3AED] hover:underline">＋ New</button>}
                </div>
                <input value={wfName} onChange={(e) => setWfName(e.target.value)} placeholder="Workflow name (e.g. Production release)" className={INPUT} />
                {members.length > 0 && <p className="text-[11px] text-gray-400">Team: {members.map((m) => m.username).join(', ')}</p>}
                <div className="space-y-2">
                  {stages.map((s, i) => (
                    <div key={s._k} className="flex gap-1.5 items-center">
                      <span className="text-[11px] font-mono text-gray-400 w-4 text-center">{i + 1}</span>
                      <input value={s.name} onChange={(e) => patchStage(s._k, { name: e.target.value })} placeholder="Stage (e.g. QA Lead)" className={`${FIELD} w-40 flex-shrink-0`} />
                      <input value={s.approvers} onChange={(e) => patchStage(s._k, { approvers: e.target.value })} placeholder="approver usernames, comma-separated" className={`${FIELD} flex-1 min-w-0`} />
                      <input value={s.minApprovals} onChange={(e) => patchStage(s._k, { minApprovals: e.target.value })} inputMode="numeric" className={`${FIELD} w-14 flex-shrink-0`} title="min approvals" />
                      <button type="button" onClick={() => setStages((p) => p.filter((x) => x._k !== s._k))} className="p-1 text-gray-400 hover:text-red-500 flex-shrink-0"><Trash2 className="w-3.5 h-3.5" /></button>
                    </div>
                  ))}
                </div>
                <div className="flex items-center gap-2">
                  <button type="button" onClick={() => setStages((p) => [...p, blankStage()])} className={SECONDARY_BTN}><Plus className="w-3.5 h-3.5" />Add stage</button>
                  <button type="button" onClick={() => void saveWf()} disabled={savingWf || !wfName.trim()} className={PRIMARY_BTN}>{savingWf ? <Spinner className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}{wfId ? 'Update' : 'Create'}</button>
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
