/**
 * TestManagement — formal enterprise TM objects for the API module.
 *
 *  • Suites  — reusable sets of endpoints built from the catalogue.
 *  • Plans   — suite collections + the environment/coverage to run under.
 *  • Cycles  — dated executions of a plan (reuse the headless runner); status
 *              reconciles as the run finishes.
 *  • Assignments — assign a plan/suite to a teammate and track their progress.
 *
 * All opt-in and additive — first-class records beside the pipeline.
 */
import { useCallback, useEffect, useState } from 'react';
import { ClipboardList, X, Plus, Trash2, Save, Play, RefreshCw, CheckCircle2, XCircle, Clock, AlertTriangle } from 'lucide-react';
import Spinner from '@/components/feedback/Spinner';
import { useToast } from '@/components/feedback/ToastProvider';
import {
  listTestSuites, saveTestSuite, deleteTestSuite,
  listTestPlans, saveTestPlan, deleteTestPlan, getPlanProgress,
  listTestCycles, startTestCycle, deleteTestCycle,
  listAssignments, saveAssignment, setAssignmentStatus, deleteAssignment, listTenantMembers,
  type TestSuite, type TestPlan, type TestCycle, type Assignment, type AssignmentStatus, type PlanProgress, type TenantMember,
} from '@/services/api';
import { CARD, STRIP, INPUT, FIELD, LABEL, PRIMARY_BTN, SECONDARY_BTN, formatDuration, relativeTime } from './format';
import type { CatalogEndpoint } from './types';

type Tab = 'suites' | 'plans' | 'cycles' | 'assignments';
const TAB_ACTIVE = 'px-3 py-1.5 text-[12px] font-medium text-[#6D28D9] border-b-2 border-[#7C3AED]';
const TAB_INACTIVE = 'px-3 py-1.5 text-[12px] font-medium text-gray-500 hover:text-gray-700';
const COVERAGES = ['essential', 'standard', 'exhaustive'] as const;
const ASSIGN: AssignmentStatus[] = ['todo', 'in_progress', 'blocked', 'done'];
const CYCLE_STYLE: Record<string, string> = {
  planned: 'bg-gray-100 text-gray-500 border-gray-200', running: 'bg-[#F5F3FF] text-[#6D28D9] border-[#DDD6FE]',
  completed: 'bg-emerald-50 text-emerald-700 border-emerald-200', failed: 'bg-red-50 text-red-700 border-red-200', aborted: 'bg-gray-100 text-gray-500 border-gray-200',
};
const ASSIGN_STYLE: Record<AssignmentStatus, string> = {
  todo: 'bg-gray-100 text-gray-600', in_progress: 'bg-blue-50 text-blue-700', blocked: 'bg-amber-50 text-amber-700', done: 'bg-emerald-50 text-emerald-700',
};

interface SuiteForm { id?: string; name: string; description: string; endpoints: CatalogEndpoint[]; tagsText: string }
interface PlanForm { id?: string; name: string; description: string; suiteIds: string[]; coverage: string; environmentId: string; gateMinPassRate: string; gateMaxFailed: string }
const blankSuite = (): SuiteForm => ({ name: '', description: '', endpoints: [], tagsText: '' });
const blankPlan = (): PlanForm => ({ name: '', description: '', suiteIds: [], coverage: 'standard', environmentId: '', gateMinPassRate: '', gateMaxFailed: '' });

export default function TestManagement({ endpoints, onClose }: { endpoints: CatalogEndpoint[]; onClose: () => void }) {
  const toast = useToast();
  const [tab, setTab] = useState<Tab>('suites');
  const [error, setError] = useState('');

  const [suites, setSuites] = useState<TestSuite[]>([]);
  const [plans, setPlans] = useState<TestPlan[]>([]);
  const [members, setMembers] = useState<TenantMember[]>([]);
  const [activePlanId, setActivePlanId] = useState('');

  const [suiteForm, setSuiteForm] = useState<SuiteForm>(blankSuite());
  const [planForm, setPlanForm] = useState<PlanForm>(blankPlan());
  const [savingSuite, setSavingSuite] = useState(false);
  const [savingPlan, setSavingPlan] = useState(false);
  const [epSel, setEpSel] = useState('');

  const [cycles, setCycles] = useState<TestCycle[]>([]);
  const [starting, setStarting] = useState(false);
  const [assignments, setAssignments] = useState<Assignment[]>([]);
  const [progress, setProgress] = useState<PlanProgress | null>(null);
  const [newAssignee, setNewAssignee] = useState('');

  const loadBase = async () => {
    try {
      const [s, p] = await Promise.all([listTestSuites(), listTestPlans()]);
      setSuites(s); setPlans(p);
      setActivePlanId((prev) => prev || p[0]?.id || '');
    } catch (e: any) { setError(e?.response?.data?.error || e?.message || 'Request failed.'); }
  };
  useEffect(() => { void loadBase(); void listTenantMembers().then(setMembers).catch(() => { /* convenience */ }); }, []);

  const loadCycles = useCallback(async (planId: string) => { if (!planId) { setCycles([]); return; } try { setCycles(await listTestCycles(planId)); } catch { /* convenience */ } }, []);
  const loadAssignments = useCallback(async (planId: string) => {
    if (!planId) { setAssignments([]); setProgress(null); return; }
    try { const [a, pr] = await Promise.all([listAssignments(planId), getPlanProgress(planId)]); setAssignments(a); setProgress(pr); } catch { /* convenience */ }
  }, []);

  useEffect(() => {
    if (tab === 'cycles') void loadCycles(activePlanId);
    if (tab === 'assignments') void loadAssignments(activePlanId);
  }, [tab, activePlanId, loadCycles, loadAssignments]);

  useEffect(() => {
    if (tab !== 'cycles' || !activePlanId || !cycles.some((c) => c.status === 'running')) return;
    const t = setInterval(() => void loadCycles(activePlanId), 5000);
    return () => clearInterval(t);
  }, [tab, activePlanId, cycles, loadCycles]);

  // ── suites ──
  const addEndpoint = (val: string) => {
    const ep = endpoints.find((e) => `${e.method} ${e.url}` === val);
    if (ep && !suiteForm.endpoints.some((x) => x.method === ep.method && x.url === ep.url)) setSuiteForm((p) => ({ ...p, endpoints: [...p.endpoints, ep] }));
    setEpSel('');
  };
  const saveSuiteFn = async () => {
    if (!suiteForm.name.trim()) { setError('Name the suite.'); return; }
    setSavingSuite(true); setError('');
    try {
      await saveTestSuite({ id: suiteForm.id, name: suiteForm.name.trim(), description: suiteForm.description, endpoints: suiteForm.endpoints, tags: suiteForm.tagsText.split(',').map((t) => t.trim()).filter(Boolean) });
      toast.success(suiteForm.id ? 'Suite updated' : 'Suite created'); setSuiteForm(blankSuite()); await loadBase();
    } catch (e: any) { setError(e?.response?.data?.error || e?.message || 'Request failed.'); }
    finally { setSavingSuite(false); }
  };

  // ── plans ──
  const savePlanFn = async () => {
    if (!planForm.name.trim()) { setError('Name the plan.'); return; }
    setSavingPlan(true); setError('');
    const gate = planForm.gateMinPassRate || planForm.gateMaxFailed
      ? { minPassRate: planForm.gateMinPassRate ? Number(planForm.gateMinPassRate) : undefined, maxFailed: planForm.gateMaxFailed ? Number(planForm.gateMaxFailed) : undefined }
      : null;
    try {
      await saveTestPlan({ id: planForm.id, name: planForm.name.trim(), description: planForm.description, suiteIds: planForm.suiteIds, coverage: planForm.coverage, environmentId: planForm.environmentId.trim() || undefined, gate });
      toast.success(planForm.id ? 'Plan updated' : 'Plan created'); setPlanForm(blankPlan()); await loadBase();
    } catch (e: any) { setError(e?.response?.data?.error || e?.message || 'Request failed.'); }
    finally { setSavingPlan(false); }
  };

  // ── cycles ──
  const start = async () => {
    if (!activePlanId) { setError('Pick a plan.'); return; }
    setStarting(true); setError('');
    try { await startTestCycle({ planId: activePlanId }); await loadCycles(activePlanId); toast.success('Cycle started', 'Running the plan through the pipeline.'); }
    catch (e: any) { setError(e?.response?.data?.error || e?.message || 'Request failed.'); }
    finally { setStarting(false); }
  };

  // ── assignments ──
  const addAssignment = async () => {
    if (!activePlanId || !newAssignee) { setError('Pick a plan and a teammate.'); return; }
    try { await saveAssignment({ planId: activePlanId, assignee: newAssignee }); setNewAssignee(''); await loadAssignments(activePlanId); }
    catch (e: any) { setError(e?.response?.data?.error || e?.message || 'Request failed.'); }
  };
  const changeStatus = async (id: string, status: AssignmentStatus) => {
    try { await setAssignmentStatus(id, status); await loadAssignments(activePlanId); } catch (e: any) { toast.error('Update failed', e?.response?.data?.error || e?.message || 'Request failed.'); }
  };

  const planName = (id: string) => plans.find((p) => p.id === id)?.name || '—';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-[#1E1B4B]/30 backdrop-blur-sm p-4" onClick={onClose}>
      <div className={`${CARD} w-full max-w-3xl max-h-[88vh] flex flex-col overflow-hidden`} onClick={(e) => e.stopPropagation()}>
        <div className={`flex items-center gap-2 px-4 h-12 border-b border-[#EDE9FE] flex-shrink-0 ${STRIP}`}>
          <ClipboardList className="w-4 h-4 text-[#7C3AED]" />
          <h3 className="text-[13px] font-semibold text-gray-900">Test management</h3>
          <span className="text-[11px] text-gray-400">suites · plans · cycles · assignments</span>
          <button type="button" onClick={onClose} className="ml-auto p-1.5 rounded-md text-gray-400 hover:text-[#7C3AED] hover:bg-[#F5F3FF]"><X className="w-4 h-4" /></button>
        </div>

        <div className="flex items-center gap-1 px-3 border-b border-[#EDE9FE] flex-shrink-0">
          {(['suites', 'plans', 'cycles', 'assignments'] as Tab[]).map((t) => (
            <button key={t} type="button" onClick={() => { setTab(t); setError(''); }} className={tab === t ? TAB_ACTIVE : TAB_INACTIVE}>{t[0]!.toUpperCase() + t.slice(1)}</button>
          ))}
        </div>

        <div className="p-4 space-y-3 overflow-y-auto min-h-0">
          {error && <div className="flex items-start gap-2 px-3 py-2 bg-red-50 border border-red-200 rounded-lg"><AlertTriangle className="w-4 h-4 text-red-500 flex-shrink-0 mt-px" /><p className="text-[12px] text-red-700 min-w-0 whitespace-pre-wrap break-words">{error}</p></div>}

          {/* plan selector for cycles/assignments */}
          {(tab === 'cycles' || tab === 'assignments') && (
            <div><label className={LABEL}>Plan</label>
              <select value={activePlanId} onChange={(e) => setActivePlanId(e.target.value)} className={INPUT} disabled={!plans.length}>
                {plans.length === 0 && <option value="">Create a plan first</option>}
                {plans.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </div>
          )}

          {/* ───── SUITES ───── */}
          {tab === 'suites' && (
            <>
              {suites.length > 0 && (
                <div className="border border-gray-100 rounded-lg divide-y divide-gray-100 overflow-hidden">
                  {suites.map((s) => (
                    <div key={s.id} className={`flex items-center gap-2 px-3 py-1.5 ${suiteForm.id === s.id ? 'bg-[#F5F3FF]' : ''}`}>
                      <button type="button" onClick={() => setSuiteForm({ id: s.id, name: s.name, description: s.description, endpoints: s.endpoints as CatalogEndpoint[], tagsText: s.tags.join(', ') })} className="flex-1 min-w-0 text-left flex items-baseline gap-2">
                        <span className="text-[12px] font-medium text-gray-800 truncate">{s.name}</span>
                        <span className="text-[10.5px] text-gray-400 flex-shrink-0">{s.endpoints.length} endpoints</span>
                      </button>
                      <button type="button" onClick={async () => { try { await deleteTestSuite(s.id); if (suiteForm.id === s.id) setSuiteForm(blankSuite()); await loadBase(); } catch { /* */ } }} className="p-1 rounded text-gray-400 hover:text-red-500 flex-shrink-0"><Trash2 className="w-3.5 h-3.5" /></button>
                    </div>
                  ))}
                </div>
              )}
              <div className={`${CARD} p-3 space-y-2.5`}>
                <div className="flex items-center justify-between"><h4 className="text-[12px] font-semibold text-gray-800">{suiteForm.id ? 'Edit suite' : 'New suite'}</h4>{suiteForm.id && <button type="button" onClick={() => setSuiteForm(blankSuite())} className="text-[11px] text-[#7C3AED] hover:underline">＋ New</button>}</div>
                <input value={suiteForm.name} onChange={(e) => setSuiteForm((p) => ({ ...p, name: e.target.value }))} placeholder="Suite name (e.g. Checkout smoke)" className={INPUT} />
                <input value={suiteForm.description} onChange={(e) => setSuiteForm((p) => ({ ...p, description: e.target.value }))} placeholder="Description" className={INPUT} />
                <div>
                  <div className="flex items-center justify-between mb-1"><span className={`${LABEL} mb-0`}>Endpoints ({suiteForm.endpoints.length})</span>{endpoints.length > 0 && <button type="button" onClick={() => setSuiteForm((p) => ({ ...p, endpoints: [...endpoints] }))} className="text-[11px] text-[#7C3AED] hover:underline">Add all {endpoints.length}</button>}</div>
                  <div className="flex flex-wrap gap-1 mb-1">
                    {suiteForm.endpoints.map((e, i) => (
                      <span key={i} className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded border border-[#DDD6FE] bg-[#F5F3FF] text-[10.5px] font-mono text-[#6D28D9]">{e.method} {e.url}
                        <button type="button" onClick={() => setSuiteForm((p) => ({ ...p, endpoints: p.endpoints.filter((_, j) => j !== i) }))} className="hover:text-red-500">×</button>
                      </span>
                    ))}
                  </div>
                  {endpoints.length > 0 && (
                    <select value={epSel} onChange={(e) => addEndpoint(e.target.value)} className={FIELD}>
                      <option value="">＋ add an endpoint…</option>
                      {endpoints.map((e) => <option key={e.id} value={`${e.method} ${e.url}`}>{e.method} {e.url}</option>)}
                    </select>
                  )}
                </div>
                <input value={suiteForm.tagsText} onChange={(e) => setSuiteForm((p) => ({ ...p, tagsText: e.target.value }))} placeholder="tags, comma-separated" className={INPUT} />
                <button type="button" onClick={() => void saveSuiteFn()} disabled={savingSuite || !suiteForm.name.trim()} className={PRIMARY_BTN}>{savingSuite ? <Spinner className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}{suiteForm.id ? 'Update suite' : 'Create suite'}</button>
              </div>
            </>
          )}

          {/* ───── PLANS ───── */}
          {tab === 'plans' && (
            <>
              {plans.length > 0 && (
                <div className="border border-gray-100 rounded-lg divide-y divide-gray-100 overflow-hidden">
                  {plans.map((p) => (
                    <div key={p.id} className={`flex items-center gap-2 px-3 py-1.5 ${planForm.id === p.id ? 'bg-[#F5F3FF]' : ''}`}>
                      <button type="button" onClick={() => setPlanForm({ id: p.id, name: p.name, description: p.description, suiteIds: p.suiteIds, coverage: p.coverage, environmentId: p.environmentId || '', gateMinPassRate: p.gate?.minPassRate != null ? String(p.gate.minPassRate) : '', gateMaxFailed: p.gate?.maxFailed != null ? String(p.gate.maxFailed) : '' })} className="flex-1 min-w-0 text-left flex items-baseline gap-2">
                        <span className="text-[12px] font-medium text-gray-800 truncate">{p.name}</span>
                        <span className="text-[10.5px] text-gray-400 flex-shrink-0">{p.suiteIds.length} suites · {p.coverage}</span>
                      </button>
                      <button type="button" onClick={async () => { try { await deleteTestPlan(p.id); if (planForm.id === p.id) setPlanForm(blankPlan()); await loadBase(); } catch { /* */ } }} className="p-1 rounded text-gray-400 hover:text-red-500 flex-shrink-0"><Trash2 className="w-3.5 h-3.5" /></button>
                    </div>
                  ))}
                </div>
              )}
              <div className={`${CARD} p-3 space-y-2.5`}>
                <div className="flex items-center justify-between"><h4 className="text-[12px] font-semibold text-gray-800">{planForm.id ? 'Edit plan' : 'New plan'}</h4>{planForm.id && <button type="button" onClick={() => setPlanForm(blankPlan())} className="text-[11px] text-[#7C3AED] hover:underline">＋ New</button>}</div>
                <input value={planForm.name} onChange={(e) => setPlanForm((p) => ({ ...p, name: e.target.value }))} placeholder="Plan name (e.g. Release regression)" className={INPUT} />
                <input value={planForm.description} onChange={(e) => setPlanForm((p) => ({ ...p, description: e.target.value }))} placeholder="Description" className={INPUT} />
                <div>
                  <label className={LABEL}>Suites</label>
                  {suites.length === 0 ? <p className="text-[11px] text-gray-400">Create suites first.</p> : (
                    <div className="flex flex-wrap gap-1.5">
                      {suites.map((s) => {
                        const on = planForm.suiteIds.includes(s.id);
                        return <button key={s.id} type="button" onClick={() => setPlanForm((p) => ({ ...p, suiteIds: on ? p.suiteIds.filter((x) => x !== s.id) : [...p.suiteIds, s.id] }))} className={`px-2 py-0.5 rounded-md border text-[11px] ${on ? 'border-[#DDD6FE] bg-[#F5F3FF] text-[#6D28D9]' : 'border-gray-200 text-gray-500'}`}>{s.name}</button>;
                      })}
                    </div>
                  )}
                </div>
                <div className="flex gap-2">
                  <div><label className={LABEL}>Coverage</label><select value={planForm.coverage} onChange={(e) => setPlanForm((p) => ({ ...p, coverage: e.target.value }))} className={FIELD}>{COVERAGES.map((c) => <option key={c} value={c}>{c}</option>)}</select></div>
                  <div className="flex-1 min-w-0"><label className={LABEL}>Environment id (optional)</label><input value={planForm.environmentId} onChange={(e) => setPlanForm((p) => ({ ...p, environmentId: e.target.value }))} placeholder="environment id" className={INPUT} /></div>
                </div>
                <div className="flex gap-2">
                  <div><label className={LABEL}>Gate min pass %</label><input value={planForm.gateMinPassRate} onChange={(e) => setPlanForm((p) => ({ ...p, gateMinPassRate: e.target.value }))} inputMode="numeric" placeholder="—" className={`${FIELD} w-28`} /></div>
                  <div><label className={LABEL}>Gate max failed</label><input value={planForm.gateMaxFailed} onChange={(e) => setPlanForm((p) => ({ ...p, gateMaxFailed: e.target.value }))} inputMode="numeric" placeholder="—" className={`${FIELD} w-28`} /></div>
                </div>
                <button type="button" onClick={() => void savePlanFn()} disabled={savingPlan || !planForm.name.trim()} className={PRIMARY_BTN}>{savingPlan ? <Spinner className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}{planForm.id ? 'Update plan' : 'Create plan'}</button>
              </div>
            </>
          )}

          {/* ───── CYCLES ───── */}
          {tab === 'cycles' && (
            <>
              <div className="flex items-center gap-2">
                <button type="button" onClick={() => void start()} disabled={starting || !activePlanId} className={PRIMARY_BTN}>{starting ? <Spinner className="w-3.5 h-3.5 animate-spin" /> : <Play className="w-3.5 h-3.5" />}Start cycle</button>
                <button type="button" onClick={() => void loadCycles(activePlanId)} className={SECONDARY_BTN}><RefreshCw className="w-3.5 h-3.5" />Refresh</button>
                <span className="text-[11px] text-gray-400 ml-auto">{planName(activePlanId)}</span>
              </div>
              {cycles.length === 0 ? <p className="text-[12px] text-gray-400">No cycles yet for this plan.</p> : (
                <div className="space-y-1.5">
                  {cycles.map((c) => (
                    <div key={c.id} className={`${CARD} p-2.5 flex items-center gap-2`}>
                      <span className="text-[12px] font-medium text-gray-800 truncate flex-1 min-w-0">{c.name}</span>
                      {c.stats && <span className="text-[11px] font-mono tabular-nums text-gray-500">{c.stats.passRate}% · {c.stats.passed}/{c.stats.total}{c.stats.durationMs ? ` · ${formatDuration(c.stats.durationMs)}` : ''}</span>}
                      {c.error && <span className="text-[11px] text-red-500 truncate max-w-[30%]">{c.error}</span>}
                      <span className={`inline-flex items-center gap-1 text-[10.5px] font-semibold px-2 py-0.5 rounded border ${CYCLE_STYLE[c.status] || CYCLE_STYLE.planned}`}>
                        {c.status === 'running' ? <Clock className="w-3 h-3" /> : c.status === 'completed' ? <CheckCircle2 className="w-3 h-3" /> : c.status === 'failed' ? <XCircle className="w-3 h-3" /> : null}{c.status}
                      </span>
                      <button type="button" onClick={async () => { try { await deleteTestCycle(c.id); await loadCycles(activePlanId); } catch { /* */ } }} className="p-1 rounded text-gray-400 hover:text-red-500 flex-shrink-0"><Trash2 className="w-3.5 h-3.5" /></button>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}

          {/* ───── ASSIGNMENTS ───── */}
          {tab === 'assignments' && (
            <>
              {progress && progress.total > 0 && (
                <div className={`${CARD} p-3`}>
                  <div className="flex items-center gap-2 mb-1.5"><span className="text-[12px] font-semibold text-gray-800">Progress</span><span className="ml-auto text-[11px] text-gray-500 tabular-nums">{progress.donePct}% done · {progress.total} assigned</span></div>
                  <div className="h-2 rounded-full bg-gray-100 overflow-hidden"><div className="h-full bg-emerald-500" style={{ width: `${progress.donePct}%` }} /></div>
                  <div className="flex flex-wrap gap-2 mt-2 text-[10.5px]">
                    {(ASSIGN).map((st) => <span key={st} className={`px-1.5 py-0.5 rounded ${ASSIGN_STYLE[st]}`}>{st}: {progress.byStatus[st]}</span>)}
                  </div>
                </div>
              )}
              <div className="flex items-end gap-2">
                <div className="flex-1 min-w-0"><label className={LABEL}>Assign to</label>
                  <select value={newAssignee} onChange={(e) => setNewAssignee(e.target.value)} className={FIELD} disabled={!members.length}>
                    <option value="">{members.length ? 'choose teammate…' : 'no members found'}</option>
                    {members.map((m) => <option key={m.username} value={m.username}>{m.fullName || m.username} ({m.role})</option>)}
                  </select>
                </div>
                <button type="button" onClick={() => void addAssignment()} disabled={!activePlanId || !newAssignee} className={PRIMARY_BTN}><Plus className="w-3.5 h-3.5" />Assign</button>
              </div>
              {assignments.length === 0 ? <p className="text-[12px] text-gray-400">No assignments yet.</p> : (
                <div className="space-y-1.5">
                  {assignments.map((a) => (
                    <div key={a.id} className={`${CARD} p-2.5 flex items-center gap-2`}>
                      <span className="text-[12px] font-medium text-gray-800 truncate flex-1 min-w-0">{a.assignee}</span>
                      <span className="text-[10.5px] text-gray-400">{relativeTime(a.updatedAt)}</span>
                      <select value={a.status} onChange={(e) => void changeStatus(a.id, e.target.value as AssignmentStatus)} className={`${FIELD} w-32 ${ASSIGN_STYLE[a.status]}`}>
                        {ASSIGN.map((st) => <option key={st} value={st}>{st}</option>)}
                      </select>
                      <button type="button" onClick={async () => { try { await deleteAssignment(a.id); await loadAssignments(activePlanId); } catch { /* */ } }} className="p-1 rounded text-gray-400 hover:text-red-500 flex-shrink-0"><Trash2 className="w-3.5 h-3.5" /></button>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
