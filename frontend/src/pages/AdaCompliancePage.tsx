/**
 * ADA Compliance — the website audit workspace.
 *
 *   /ada-compliance                  overview: key numbers, audit reports, scheduled audits
 *   /ada-compliance?scan=<id>        one audit: live progress while it runs, then the report
 *   /ada-compliance?new=1            overview with the New audit drawer open (used by Chat)
 *
 * Audits are started from the New audit drawer; nothing here runs in the chat.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  listAdaScans, deleteAdaScan, cancelAdaScan, type AdaScanRecord, type AdaSeverity,
  listAdaSchedules, createAdaSchedule, updateAdaSchedule, deleteAdaSchedule, runAdaScheduleNow, type AdaSchedule,
} from '@/services/api';
import AdaCompliancePanel, { type BrownfieldHandoff } from '@/components/ada/AdaCompliancePanel';
import NewAuditDrawer from '@/components/ada/NewAuditDrawer';
import Drawer from '@/components/ui/Drawer';
import { CadenceFields, HealthRing, SeverityChips } from '@/components/ada/SharedUi';
import { SEVERITIES, describeSlot, errorMessage, ghostBtn, inputCls, primaryBtn, timeAgo, toUtcSlot } from '@/components/ada/shared';
import {
  Plus, Trash2, Loader2, Square, ChevronRight, CalendarClock, Play, Lock, Search, Globe, Activity,
  AlertTriangle, FileBarChart, XCircle, User,
} from 'lucide-react';
import UniversalAccess from '@/components/icons/UniversalAccess';

/** The list also carries issue counts by severity; null while an audit has no report. */
type ScanRow = AdaScanRecord & { severity?: Record<AdaSeverity, number> | null };
type StatusFilter = 'all' | AdaScanRecord['status'];

const card = 'bg-white border border-gray-100 rounded-2xl shadow-sm';
const th = 'px-4 py-3 text-left text-[11px] font-semibold uppercase tracking-wider text-gray-400';
const STATUS_LABEL: Record<AdaScanRecord['status'], string> = { queued: 'Queued', running: 'Running', completed: 'Complete', failed: 'Failed', cancelled: 'Stopped early' };
const STATUS_STYLE: Record<AdaScanRecord['status'], string> = {
  queued: 'bg-gray-50 text-gray-600 border-gray-200',
  running: 'bg-violet-50 text-violet-700 border-violet-200',
  completed: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  failed: 'bg-red-50 text-red-700 border-red-200',
  cancelled: 'bg-amber-50 text-amber-700 border-amber-200',
};
const isFinished = (s: AdaScanRecord) => s.status === 'completed' || s.status === 'cancelled';
const issueTotal = (sev: Record<AdaSeverity, number>) => SEVERITIES.reduce((a, s) => a + (sev[s] || 0), 0);

function Kpi({ icon: Icon, label, value, sub, tone }: { icon: React.ElementType; label: string; value: React.ReactNode; sub?: string; tone: string }) {
  return (
    <div className={`${card} p-5 flex items-center gap-4 min-w-0`}>
      <div className={`w-11 h-11 rounded-xl flex items-center justify-center flex-shrink-0 ${tone}`}><Icon className="w-5 h-5" /></div>
      <div className="min-w-0">
        <p className="text-xs text-gray-500">{label}</p>
        <p className="text-2xl font-bold text-[#1E1B4B] leading-tight tabular-nums">{value}</p>
        {sub && <p className="text-xs text-gray-400 truncate" title={sub}>{sub}</p>}
      </div>
    </div>
  );
}

function EmptyState({ icon: Icon, title, text, action }: { icon: React.ElementType; title: string; text: string; action?: React.ReactNode }) {
  return (
    <div className="px-6 py-14 text-center">
      <div className="w-14 h-14 rounded-2xl bg-violet-50 flex items-center justify-center mx-auto mb-3"><Icon className="w-6 h-6 text-violet-500" /></div>
      <p className="text-sm font-semibold text-[#1E1B4B]">{title}</p>
      <p className="text-sm text-gray-500 mt-1 max-w-md mx-auto">{text}</p>
      {action && <div className="mt-4 flex justify-center">{action}</div>}
    </div>
  );
}

/* ───────────────────────────── new schedule drawer ───────────────────────────── */

function NewScheduleDrawer({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: () => void }) {
  const [form, setForm] = useState({ url: '', frequency: 'weekly' as 'daily' | 'weekly', hour: 3, weekday: 1, checkExternalLinks: true, needsLogin: false, username: '', password: '' });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const create = async () => {
    if (!form.url.trim()) { setErr('Enter the website address to audit.'); return; }
    setBusy(true); setErr('');
    try {
      const slot = toUtcSlot(form.hour, form.frequency === 'weekly' ? form.weekday : null);
      await createAdaSchedule({
        url: form.url.trim(), frequency: form.frequency, runHourUtc: slot.runHourUtc, runWeekday: slot.runWeekday,
        checkExternalLinks: form.checkExternalLinks,
        username: form.needsLogin && form.username ? form.username : undefined,
        password: form.needsLogin && form.password ? form.password : undefined,
      });
      setForm((f) => ({ ...f, url: '', username: '', password: '', needsLogin: false }));
      onCreated();
    } catch (e: unknown) { setErr(errorMessage(e, 'Could not create the schedule')); }
    finally { setBusy(false); }
  };

  return (
    <Drawer
      open={open} onClose={onClose} title="New scheduled audit" subtitle="Audit a site every day or every week" icon={CalendarClock}
      footer={(
        <>
          <button type="button" onClick={onClose} className={ghostBtn}>Cancel</button>
          <button type="button" onClick={create} disabled={busy || !form.url.trim()} className={primaryBtn}>{busy && <Loader2 className="w-4 h-4 animate-spin" />} Save schedule</button>
        </>
      )}
    >
      <div className="space-y-6">
        <section className="space-y-2">
          <h3 className="text-xs font-semibold text-[#1E1B4B] uppercase tracking-wide">Website</h3>
          <div className="relative">
            <Globe className="w-4 h-4 text-gray-400 absolute left-3.5 top-1/2 -translate-y-1/2" />
            <input value={form.url} onChange={(e) => setForm({ ...form, url: e.target.value })} placeholder="www.example.com" aria-label="Website address" className={inputCls + ' pl-10'} autoFocus />
          </div>
          <label className="flex items-center gap-2.5 text-sm text-gray-700 cursor-pointer pt-1">
            <input type="checkbox" checked={form.checkExternalLinks} onChange={(e) => setForm({ ...form, checkExternalLinks: e.target.checked })} className="w-4 h-4 rounded border-gray-300 text-violet-600" />
            Also check links to other websites
          </label>
          <label className="flex items-center gap-2.5 text-sm text-gray-700 cursor-pointer">
            <input type="checkbox" checked={form.needsLogin} onChange={(e) => setForm({ ...form, needsLogin: e.target.checked })} className="w-4 h-4 rounded border-gray-300 text-violet-600" />
            <Lock className={`w-3.5 h-3.5 ${form.needsLogin ? 'text-violet-500' : 'text-gray-400'}`} /> The site needs a sign-in
          </label>
          {form.needsLogin && (
            <div className="grid grid-cols-2 gap-2">
              <input value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} placeholder="Username or email" className={inputCls} autoComplete="off" />
              <input type="password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} placeholder="Password" className={inputCls} autoComplete="new-password" />
            </div>
          )}
        </section>
        <section className="space-y-2">
          <h3 className="text-xs font-semibold text-[#1E1B4B] uppercase tracking-wide">Schedule</h3>
          <CadenceFields frequency={form.frequency} weekday={form.weekday} hour={form.hour} onChange={(p) => setForm((f) => ({ ...f, ...p }))} />
          <p className="text-xs text-gray-500">Times are in your local time. Each run is a full audit and appears under Audit reports.</p>
        </section>
        {err && <p className="text-sm text-red-700 bg-red-50 border border-red-100 rounded-xl px-3.5 py-3" role="alert">{err}</p>}
      </div>
    </Drawer>
  );
}

/* ───────────────────────────── scheduled audits ───────────────────────────── */

function SchedulesTable({ rows, onChanged, onOpenScan, onAdd, onError }: {
  rows: AdaSchedule[] | null; onChanged: () => void; onOpenScan: (id: string) => void; onAdd: () => void; onError: (msg: string) => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const run = async (id: string, fn: () => Promise<void>, fallback: string) => {
    setBusy(id);
    try { await fn(); } catch (e: unknown) { onError(errorMessage(e, fallback)); }
    finally { setBusy(null); }
  };
  const toggle = (s: AdaSchedule) => run(s.id, async () => { await updateAdaSchedule(s.id, { enabled: !s.enabled }); onChanged(); }, 'Could not update the schedule');
  const runNow = (s: AdaSchedule) => run(s.id, async () => { const r = await runAdaScheduleNow(s.id); onOpenScan(r.scanId); }, 'Could not start the audit');
  const remove = (s: AdaSchedule) => {
    if (!confirm(`Stop auditing ${s.target_url} on a schedule? Past audits are kept.`)) return;
    void run(s.id, async () => { await deleteAdaSchedule(s.id); onChanged(); }, 'Could not delete the schedule');
  };

  if (rows === null) return <p className="p-6 text-sm text-gray-400 flex items-center gap-2"><Loader2 className="w-4 h-4 animate-spin" /> Loading</p>;
  if (rows.length === 0) {
    return <EmptyState icon={CalendarClock} title="No scheduled audits" text="Schedule an audit to run every day or every week and track how a site changes." action={<button onClick={onAdd} className={primaryBtn}><Plus className="w-4 h-4" /> New schedule</button>} />;
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[720px] table-fixed text-sm">
        <colgroup>
          <col />
          <col className="w-[210px]" />
          <col className="w-[150px]" />
          <col className="w-[76px]" />
          <col className="w-[176px]" />
        </colgroup>
        <thead>
          <tr className="border-b border-gray-100 bg-gray-50/60">
            <th className={th}>Website</th>
            <th className={th}>Schedule</th>
            <th className={th}>Latest run</th>
            <th className={th}>Active</th>
            <th className={th} />
          </tr>
        </thead>
        <tbody>
          {rows.map((s) => (
            <tr key={s.id} className="border-b border-gray-50 last:border-0 hover:bg-violet-50/30">
              <td className="px-4 py-4">
                <p className="font-medium text-[#1E1B4B] truncate" title={s.target_url}>{s.target_url}</p>
                <p className="text-xs text-gray-400 mt-0.5 flex flex-wrap items-center gap-x-3">
                  {s.created_by && <span className="inline-flex items-center gap-1"><User className="w-3 h-3" /> {s.created_by}</span>}
                  <span>{s.options.checkExternalLinks === false ? 'Internal links only' : 'Checks external links'}</span>
                  {s.options.username && <span className="inline-flex items-center gap-1"><Lock className="w-3 h-3" /> Signs in as {s.options.username}</span>}
                </p>
              </td>
              <td className="px-4 py-4">
                <span className={`inline-flex px-2 py-0.5 rounded-full border text-[11px] font-semibold ${s.enabled ? 'bg-violet-50 text-violet-700 border-violet-200' : 'bg-gray-50 text-gray-500 border-gray-200'}`}>{s.enabled ? 'Recurring' : 'Paused'}</span>
                <p className="text-sm text-gray-700 mt-1">{describeSlot(s)}</p>
                {s.enabled && s.next_run_at && <p className="text-xs text-gray-400">Next: {new Date(s.next_run_at).toLocaleString()}</p>}
                 {s.last_error && <p className="text-xs text-amber-600 truncate" title={s.last_error}>Retrying: {s.last_error}</p>}
              </td>
              <td className="px-4 py-4">
                {s.last_scan_id
                  ? <button onClick={() => onOpenScan(s.last_scan_id!)} className="text-sm text-violet-700 hover:underline text-left">{s.last_run_at ? new Date(s.last_run_at).toLocaleString() : 'Open report'}</button>
                  : <span className="text-sm text-gray-400">Not run yet</span>}
              </td>
              <td className="px-4 py-4">
                <button onClick={() => toggle(s)} disabled={busy === s.id} role="switch" aria-checked={s.enabled} aria-label={`Schedule for ${s.target_url}`} className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors disabled:opacity-50 ${s.enabled ? 'bg-violet-600' : 'bg-gray-300'}`} title={s.enabled ? 'Pause' : 'Resume'}>
                  <span className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ${s.enabled ? 'translate-x-4' : 'translate-x-0.5'}`} />
                </button>
              </td>
              <td className="px-4 py-4 text-right">
                <button onClick={() => runNow(s)} disabled={busy === s.id} className="inline-flex items-center gap-1.5 text-xs text-gray-700 hover:text-violet-700 border border-gray-200 hover:border-violet-300 bg-white rounded-lg px-3 py-1.5 mr-2 disabled:opacity-50">
                  <Play className="w-3 h-3" /> Run now
                </button>
                <button onClick={() => remove(s)} disabled={busy === s.id} className="p-1.5 text-gray-300 hover:text-red-500 disabled:opacity-50 align-middle" title="Delete schedule" aria-label={`Delete schedule for ${s.target_url}`}><Trash2 className="w-4 h-4" /></button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* ───────────────────────────── page ───────────────────────────── */

export default function AdaCompliancePage() {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const scanId = params.get('scan');
  const tab: 'reports' | 'schedules' = params.get('tab') === 'schedules' ? 'schedules' : 'reports';

  const [scans, setScans] = useState<ScanRow[] | null>(null);
  const [schedules, setSchedules] = useState<AdaSchedule[] | null>(null);
  const [error, setError] = useState('');
  const [auditDrawer, setAuditDrawer] = useState(false);
  const [scheduleDrawer, setScheduleDrawer] = useState(false);
  const [query, setQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [stopping, setStopping] = useState<string | null>(null);

  // Chat's ADA Compliance tile lands here with ?new=1.
  const wantsNew = params.get('new') === '1';
  useEffect(() => {
    if (!wantsNew) return;
    setAuditDrawer(true);
    setParams((p) => { const n = new URLSearchParams(p); n.delete('new'); return n; }, { replace: true });
  }, [wantsNew, setParams]);

  const [reloadTick, setReloadTick] = useState(0);
  const reload = useCallback(() => setReloadTick((n) => n + 1), []);
  useEffect(() => {
    if (scanId) return;
    let alive = true;
    listAdaScans()
      .then((rows) => { if (alive) { setScans(rows); setError(''); } })
      .catch((err: unknown) => { if (alive) { setError(errorMessage(err, 'Could not load audits')); setScans([]); } });
    listAdaSchedules()
      .then((rows) => { if (alive) setSchedules(rows); })
      .catch((err: unknown) => { if (alive) { setError(errorMessage(err, 'Could not load scheduled audits')); setSchedules([]); } });
    return () => { alive = false; };
  }, [reloadTick, scanId]);

  // Keep the list fresh while an audit is running in the background.
  const anyRunning = !scanId && !!scans?.some((s) => s.status === 'running' || s.status === 'queued');
  useEffect(() => {
    if (!anyRunning) return;
    const t = setInterval(reload, 5000);
    return () => clearInterval(t);
  }, [anyRunning, reload]);

  const openScan = (id: string) => setParams({ scan: id });
  const backToList = () => setParams(tab === 'schedules' ? { tab } : {});
  const setTab = (t: 'reports' | 'schedules') => setParams(t === 'schedules' ? { tab: t } : {});

  const stop = async (id: string) => {
    setStopping(id);
    try { await cancelAdaScan(id); setTimeout(reload, 2000); } catch (err: unknown) { setError(errorMessage(err, 'Could not stop the audit')); }
    finally { setTimeout(() => setStopping(null), 2000); }
  };
  const remove = async (s: ScanRow) => {
    if (!confirm(`Delete the audit of ${s.site_name || s.target_url} and all of its findings?`)) return;
    try { await deleteAdaScan(s.id); reload(); } catch (err: unknown) { setError(errorMessage(err, 'Delete failed')); }
  };

  // Hand the crawled site to the Chat wizard's explore flow.
  const brownfield = (ctx: BrownfieldHandoff) => {
    sessionStorage.setItem('intelliqe_ada_brownfield', JSON.stringify(ctx));
    navigate('/chat');
  };

  /* Key numbers, each from the latest finished audit of every site in the list. */
  const kpi = useMemo(() => {
    const latest = new Map<string, ScanRow>();
    for (const s of scans || []) if (isFinished(s) && !latest.has(s.target_url)) latest.set(s.target_url, s);
    const rows = [...latest.values()];
    const scored = rows.filter((s) => s.overall_score != null);
    const counted = rows.filter((s) => s.severity);
    return {
      sites: rows.length,
      avg: scored.length ? Math.round(scored.reduce((a, s) => a + (s.overall_score as number), 0) / scored.length) : null,
      issues: counted.length ? counted.reduce((a, s) => a + issueTotal(s.severity!), 0) : null,
      critical: counted.reduce((a, s) => a + (s.severity!.critical || 0), 0),
      running: (scans || []).filter((s) => s.status === 'running').length,
    };
  }, [scans]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (scans || []).filter((s) =>
      (statusFilter === 'all' || s.status === statusFilter)
      && (!q || [s.site_name, s.target_url, s.created_by].some((v) => (v || '').toLowerCase().includes(q))));
  }, [scans, query, statusFilter]);

  const drawers = (
    <>
      <NewAuditDrawer open={auditDrawer} onClose={() => setAuditDrawer(false)} onStarted={(id) => { setAuditDrawer(false); openScan(id); }} onScheduleCreated={reload} />
      <NewScheduleDrawer open={scheduleDrawer} onClose={() => setScheduleDrawer(false)} onCreated={() => { setScheduleDrawer(false); reload(); }} />
    </>
  );

  /* ═════════════════════════════ ONE AUDIT ═════════════════════════════ */
  if (scanId) {
    return (
      <div className="space-y-4 animate-fadeIn">
        <nav className="flex items-center gap-1.5 text-sm" aria-label="Breadcrumb">
          <button onClick={backToList} className="text-gray-500 hover:text-violet-700">All audits</button>
          <ChevronRight className="w-4 h-4 text-gray-300" />
          <span className="text-[#1E1B4B] font-medium">Audit report</span>
        </nav>
        <AdaCompliancePanel key={scanId} scanId={scanId} onBrownfield={brownfield} onNewAudit={() => setAuditDrawer(true)} />
        {drawers}
      </div>
    );
  }

  /* ═════════════════════════════ OVERVIEW ═════════════════════════════ */
  const activeSchedules = (schedules || []).filter((s) => s.enabled).length;
  return (
    <div className="space-y-5 animate-fadeIn">
      <div className="relative overflow-hidden rounded-2xl bg-gradient-to-r from-[#1E1B4B] via-[#4C1D95] to-[#4F46E5] px-6 py-6 shadow-lg shadow-purple-900/20">
        <div className="absolute -top-16 -right-10 w-64 h-64 rounded-full bg-violet-400/20 blur-3xl" aria-hidden />
        <div className="absolute -bottom-24 left-1/3 w-72 h-72 rounded-full bg-cyan-400/10 blur-3xl" aria-hidden />
        <div className="relative flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-4 min-w-0">
            <div className="w-12 h-12 rounded-xl bg-white/10 border border-white/20 flex items-center justify-center flex-shrink-0"><UniversalAccess className="w-6 h-6 text-white" /></div>
            <div className="min-w-0">
              <h2 className="text-xl font-bold text-white">Website audits</h2>
              <p className="text-sm text-violet-100/90 mt-0.5">Accessibility to WCAG 2.2 AA, broken links, best practices and UX, in one scored report.</p>
            </div>
          </div>
          <button onClick={() => setAuditDrawer(true)} className="px-4 py-2.5 bg-white text-violet-700 hover:bg-violet-50 text-sm font-semibold rounded-lg flex items-center gap-2 shadow-md">
            <Plus className="w-4 h-4" /> New audit
          </button>
        </div>
      </div>

      {error && <p className="text-sm text-red-700 bg-red-50 border border-red-100 rounded-xl px-4 py-3" role="alert">{error}</p>}

      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
        <Kpi icon={Globe} label="Sites audited" value={scans === null ? '—' : kpi.sites} sub={kpi.running ? `${kpi.running} audit running now` : 'With a finished audit'} tone="bg-violet-50 text-violet-600" />
        <div className={`${card} p-5 flex items-center gap-4 min-w-0`}>
          <HealthRing score={kpi.avg} size={44} stroke={6} bare />
          <div className="min-w-0">
            <p className="text-xs text-gray-500">Average health</p>
            <p className="text-2xl font-bold text-[#1E1B4B] leading-tight tabular-nums">{kpi.avg ?? '—'}{kpi.avg != null && <span className="text-sm font-medium text-gray-400"> / 100</span>}</p>
            <p className="text-xs text-gray-400 truncate">Latest audit of each site</p>
          </div>
        </div>
        <Kpi icon={AlertTriangle} label="Open issues" value={kpi.issues == null ? '—' : kpi.issues.toLocaleString()} sub={kpi.issues == null ? 'Latest audit of each site' : `${kpi.critical.toLocaleString()} critical`} tone="bg-amber-50 text-amber-600" />
        <Kpi icon={CalendarClock} label="Scheduled audits" value={schedules === null ? '—' : activeSchedules} sub={schedules && schedules.length > activeSchedules ? `${schedules.length - activeSchedules} paused` : 'Active'} tone="bg-cyan-50 text-cyan-600" />
      </div>

      <div className={card}>
        <div className="flex flex-wrap items-center justify-between gap-3 px-3 border-b border-gray-100">
          <div className="flex gap-1" role="tablist">
            {([['reports', 'Audit reports', FileBarChart, scans?.length], ['schedules', 'Scheduled audits', CalendarClock, schedules?.length]] as ['reports' | 'schedules', string, React.ElementType, number | undefined][]).map(([key, label, Icon, count]) => (
              <button key={key} role="tab" aria-selected={tab === key} onClick={() => setTab(key)} className={`px-3.5 py-3.5 text-sm font-medium border-b-2 -mb-px flex items-center gap-2 !rounded-none ${tab === key ? 'border-violet-600 text-violet-700' : 'border-transparent text-gray-500 hover:text-gray-800'}`}>
                <Icon className="w-4 h-4" /> {label}
                {count !== undefined && <span className={`px-1.5 py-0.5 rounded-full text-[11px] tabular-nums ${tab === key ? 'bg-violet-100 text-violet-700' : 'bg-gray-100 text-gray-500'}`}>{count}</span>}
              </button>
            ))}
          </div>
          {tab === 'schedules' && schedules && schedules.length > 0 && (
            <button onClick={() => setScheduleDrawer(true)} className="my-2 mr-2 text-sm px-3.5 py-2 bg-white border border-gray-200 hover:border-violet-300 text-gray-700 rounded-lg flex items-center gap-2"><Plus className="w-4 h-4" /> New schedule</button>
          )}
          {tab === 'reports' && scans && scans.length > 0 && (
            <div className="flex items-center gap-2 my-2 mr-2">
              <div className="relative">
                <Search className="w-4 h-4 text-gray-400 absolute left-3 top-1/2 -translate-y-1/2" />
                <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search by site or user" aria-label="Search audits" className="w-60 pl-9 pr-3 py-2 bg-white border border-gray-200 rounded-lg text-sm text-gray-800 placeholder:text-gray-400 outline-none focus:ring-2 focus:ring-violet-500/20 focus:border-violet-400" />
              </div>
              <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as StatusFilter)} aria-label="Filter by status" className="px-3 py-2 bg-white border border-gray-200 rounded-lg text-sm text-gray-700 outline-none focus:ring-2 focus:ring-violet-500/20 focus:border-violet-400">
                <option value="all">All statuses</option>
                {(['running', 'completed', 'cancelled', 'failed'] as const).map((s) => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}
              </select>
            </div>
          )}
        </div>

        {tab === 'schedules' && <SchedulesTable rows={schedules} onChanged={reload} onOpenScan={openScan} onAdd={() => setScheduleDrawer(true)} onError={setError} />}

        {tab === 'reports' && (scans === null ? (
          <p className="p-6 text-sm text-gray-400 flex items-center gap-2"><Loader2 className="w-4 h-4 animate-spin" /> Loading</p>
        ) : scans.length === 0 ? (
          <EmptyState icon={UniversalAccess} title="No audits yet" text="Enter a website address to get a scored report. No requirements or setup needed." action={<button onClick={() => setAuditDrawer(true)} className={primaryBtn}><Plus className="w-4 h-4" /> New audit</button>} />
        ) : filtered.length === 0 ? (
          <EmptyState icon={Search} title="No audits match" text="Try a different search or status." />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[720px] table-fixed text-sm">
              <colgroup>
                <col />
                <col className="w-[168px]" />
                <col className="w-[236px]" />
                <col className="w-[76px]" />
                <col className="w-[110px]" />
              </colgroup>
              <thead>
                <tr className="border-b border-gray-100 bg-gray-50/60">
                  <th className={th}>Report</th>
                  <th className={th}>Summary</th>
                  <th className={th}>Severity</th>
                  <th className={`${th} text-center`}>Health</th>
                  <th className={th} />
                </tr>
              </thead>
              <tbody>
                {filtered.map((s) => {
                  const active = s.status === 'running' || s.status === 'queued';
                  const openable = active || isFinished(s);
                  const scheduled = s.created_by === 'schedule';
                  return (
                    <tr
                      key={s.id}
                      onClick={openable ? () => openScan(s.id) : undefined}
                      className={`border-b border-gray-50 last:border-0 ${openable ? 'cursor-pointer hover:bg-violet-50/40' : ''}`}
                    >
                      <td className="px-4 py-4">
                        <span className={`inline-flex items-center px-2 py-0.5 mb-1 rounded-full border text-[11px] font-semibold ${STATUS_STYLE[s.status]}`}>
                          {active && <Loader2 className="w-3 h-3 animate-spin mr-1" />}{STATUS_LABEL[s.status]}
                        </span>
                        {openable
                          ? <button onClick={(e) => { e.stopPropagation(); openScan(s.id); }} className="font-semibold text-[#1E1B4B] hover:text-violet-700 text-left truncate max-w-full block" style={{ transform: 'none' }}>{s.site_name || s.target_url}</button>
                          : <p className="font-semibold text-[#1E1B4B] truncate">{s.site_name || s.target_url}</p>}
                        {s.site_name && <p className="text-xs text-gray-400 truncate" title={s.target_url}>{s.target_url}</p>}
                        <p className="text-xs text-gray-400 mt-0.5" title={new Date(s.created_at).toLocaleString()}>
                          {scheduled ? 'Scheduled run' : s.created_by ? `On demand by ${s.created_by}` : ''}{s.created_by ? ', ' : ''}{timeAgo(s.created_at)}
                        </p>
                      </td>
                      <td className="px-4 py-4">
                        {s.status === 'failed' ? (
                          <p className="text-xs text-red-600 line-clamp-3" title={s.error || undefined}><XCircle className="w-3.5 h-3.5 inline mr-1 -mt-0.5" />{s.error || 'The audit could not be completed'}</p>
                        ) : active ? (
                          <>
                            <p className="text-sm text-gray-700">{s.pages_crawled ? `${s.pages_crawled.toLocaleString()} pages so far` : 'In progress'}</p>
                            <div className="w-full max-w-32 h-1.5 mt-1.5 bg-violet-100 rounded-full overflow-hidden"><div className="h-full w-1/2 rounded-full bg-gradient-to-r from-violet-400 via-indigo-500 to-violet-400 animate-shimmer" /></div>
                          </>
                        ) : (
                          <>
                            <p className="text-sm font-semibold text-gray-800 tabular-nums">{s.severity ? `${issueTotal(s.severity).toLocaleString()} issue${issueTotal(s.severity) === 1 ? '' : 's'}` : '—'}</p>
                            <p className="text-xs text-gray-400">{s.pages_crawled.toLocaleString()} page{s.pages_crawled === 1 ? '' : 's'}, {s.links_checked ? `${s.links_checked.toLocaleString()} links checked` : 'links not checked'}</p>
                          </>
                        )}
                      </td>
                      <td className="px-4 py-4">{s.severity && isFinished(s) ? <SeverityChips counts={s.severity} /> : <span className="text-gray-300">—</span>}</td>
                      <td className="px-2 py-4"><div className="flex justify-center"><HealthRing score={isFinished(s) ? s.overall_score : null} /></div></td>
                      <td className="px-4 py-4 text-right" onClick={(e) => e.stopPropagation()}>
                        {active ? (
                          <button onClick={() => stop(s.id)} disabled={stopping === s.id} className="inline-flex items-center gap-1.5 text-xs text-gray-700 hover:text-red-600 border border-gray-200 hover:border-red-200 bg-white rounded-lg px-3 py-1.5 disabled:opacity-50" title="Stop now and keep the report for the pages audited so far">
                            <Square className="w-3 h-3 fill-current" /> {stopping === s.id ? 'Stopping' : 'Stop'}
                          </button>
                        ) : (
                          <button onClick={() => remove(s)} className="p-1.5 text-gray-300 hover:text-red-500" title="Delete audit" aria-label={`Delete the audit of ${s.site_name || s.target_url}`}><Trash2 className="w-4 h-4" /></button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ))}
      </div>
      {scans && scans.length >= 50 && tab === 'reports' && <p className="text-xs text-gray-400 flex items-center gap-1.5"><Activity className="w-3.5 h-3.5" /> Showing the 50 most recent audits.</p>}
      {drawers}
    </div>
  );
}
