/**
 * ADA Compliance — standalone page.
 *
 * Lists this tenant's website audits and hosts the audit panel: start a new
 * audit or open a finished one. The same panel is embedded in the Chat wizard.
 */
import { useCallback, useEffect, useState } from 'react';

import { useNavigate } from 'react-router-dom';
import {
  listAdaScans, deleteAdaScan, cancelAdaScan, type AdaScanRecord,
  listAdaSchedules, createAdaSchedule, updateAdaSchedule, deleteAdaSchedule, runAdaScheduleNow, type AdaSchedule,
} from '@/services/api';
import AdaCompliancePanel, { type BrownfieldHandoff } from '@/components/ada/AdaCompliancePanel';
import { Accessibility, Plus, Trash2, Loader2, Clock, CheckCircle2, XCircle, Square, ChevronLeft, CalendarClock, Play, Lock } from 'lucide-react';

function errorMessage(err: unknown, fallback: string): string {
  const e = err as { response?: { data?: { error?: string } }; message?: string } | undefined;
  return e?.response?.data?.error || e?.message || fallback;
}

const GRADE_COLOR = (score: number | null | undefined) =>
  score == null ? 'text-gray-400' : score >= 90 ? 'text-emerald-600' : score >= 80 ? 'text-green-600' : score >= 70 ? 'text-amber-600' : score >= 60 ? 'text-orange-600' : 'text-red-600';

const STATUS_ICON: Record<AdaScanRecord['status'], React.ElementType> = {
  queued: Clock, running: Loader2, completed: CheckCircle2, failed: XCircle, cancelled: Square,
};

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const inputCls = 'px-3 py-2 bg-white border border-gray-200 rounded-lg text-sm text-gray-800 placeholder:text-gray-400 outline-none focus:ring-2 focus:ring-violet-500/20 focus:border-violet-400';

/** The user picks a local hour (and weekday); the server stores the UTC equivalent. */
function toUtcSlot(localHour: number, localWeekday: number | null): { runHourUtc: number; runWeekday: number | null } {
  const d = new Date();
  d.setHours(localHour, 0, 0, 0);
  if (localWeekday !== null) d.setDate(d.getDate() + ((localWeekday - d.getDay() + 7) % 7));
  return { runHourUtc: d.getUTCHours(), runWeekday: localWeekday === null ? null : d.getUTCDay() };
}

/** Describe a stored UTC slot in the viewer's local time. */
function describeSlot(s: AdaSchedule): string {
  const d = new Date();
  d.setUTCHours(s.run_hour_utc, 0, 0, 0);
  if (s.frequency === 'weekly' && s.run_weekday !== null) d.setUTCDate(d.getUTCDate() + ((s.run_weekday - d.getUTCDay() + 7) % 7));
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return s.frequency === 'weekly' ? `Weekly · ${WEEKDAYS[d.getDay()]} ${time}` : `Daily · ${time}`;
}

/**
 * Recurring audits: one row per site + cadence. The server runs them through
 * the same engine as a manual audit, so each run appears in the list below and
 * in the site's trend.
 */
function RecurringAudits({ onOpenScan, onStarted }: { onOpenScan: (scanId: string) => void; onStarted: () => void }) {
  const [rows, setRows] = useState<AdaSchedule[] | null>(null);
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState('');
  const [form, setForm] = useState({ url: '', frequency: 'daily' as 'daily' | 'weekly', hour: 3, weekday: 1, checkExternalLinks: true, needsLogin: false, username: '', password: '' });

  const load = useCallback(() => {
    listAdaSchedules().then((r) => { setRows(r); setErr(''); }).catch((e: unknown) => { setErr(errorMessage(e, 'Could not load recurring audits')); setRows([]); });
  }, []);
  useEffect(() => { load(); }, [load]);

  const create = async () => {
    if (!form.url.trim()) { setErr('Enter the website address to audit.'); return; }
    setBusy('new');
    try {
      const slot = toUtcSlot(form.hour, form.frequency === 'weekly' ? form.weekday : null);
      await createAdaSchedule({
        url: form.url.trim(), frequency: form.frequency, runHourUtc: slot.runHourUtc, runWeekday: slot.runWeekday,
        checkExternalLinks: form.checkExternalLinks,
        username: form.needsLogin && form.username ? form.username : undefined,
        password: form.needsLogin && form.password ? form.password : undefined,
      });
      setForm((f) => ({ ...f, url: '', username: '', password: '', needsLogin: false }));
      setAdding(false);
      load();
    } catch (e: unknown) { setErr(errorMessage(e, 'Could not create the schedule')); }
    finally { setBusy(null); }
  };

  const toggle = async (s: AdaSchedule) => {
    setBusy(s.id);
    try { await updateAdaSchedule(s.id, { enabled: !s.enabled }); load(); } catch (e: unknown) { setErr(errorMessage(e, 'Could not update the schedule')); }
    finally { setBusy(null); }
  };

  const runNow = async (s: AdaSchedule) => {
    setBusy(s.id);
    try { const r = await runAdaScheduleNow(s.id); onStarted(); onOpenScan(r.scanId); } catch (e: unknown) { setErr(errorMessage(e, 'Could not start the audit')); }
    finally { setBusy(null); }
  };

  const remove = async (s: AdaSchedule) => {
    if (!confirm(`Stop auditing ${s.target_url} on a schedule? Past audits are kept.`)) return;
    setBusy(s.id);
    try { await deleteAdaSchedule(s.id); load(); } catch (e: unknown) { setErr(errorMessage(e, 'Could not delete the schedule')); }
    finally { setBusy(null); }
  };

  return (
    <div className="bg-white border border-gray-100 rounded-xl shadow-sm">
      <div className="flex items-center justify-between gap-3 px-4 py-3 border-b border-gray-100">
        <div>
          <p className="text-sm font-semibold text-gray-800 flex items-center gap-2"><CalendarClock className="w-4 h-4 text-violet-500" /> Recurring audits</p>
          <p className="text-[11px] text-gray-500 mt-0.5">Audit a site every day or week. Each run is a full audit; open any report to see how the score and issue counts moved since the previous run.</p>
        </div>
        <button onClick={() => setAdding((v) => !v)} className="flex-shrink-0 text-xs px-3 py-1.5 bg-gray-100 hover:bg-gray-200 text-gray-700 rounded-lg flex items-center gap-1.5 transition-colors">
          <Plus className="w-3.5 h-3.5" /> {adding ? 'Cancel' : 'Add schedule'}
        </button>
      </div>
      {err && <p className="mx-4 mt-3 text-xs text-red-600 bg-red-50 border border-red-100 rounded-lg px-3 py-2">{err}</p>}
      {adding && (
        <div className="px-4 py-3 border-b border-gray-100 bg-violet-50/30 space-y-2">
          <div className="grid sm:grid-cols-[1fr_auto_auto_auto] gap-2">
            <input value={form.url} onChange={(e) => setForm({ ...form, url: e.target.value })} placeholder="www.example.com" className={inputCls} autoFocus />
            <select value={form.frequency} onChange={(e) => setForm({ ...form, frequency: e.target.value as 'daily' | 'weekly' })} className={inputCls}>
              <option value="daily">Every day</option>
              <option value="weekly">Every week</option>
            </select>
            {form.frequency === 'weekly' && (
              <select value={form.weekday} onChange={(e) => setForm({ ...form, weekday: Number(e.target.value) })} className={inputCls}>
                {WEEKDAYS.map((d, i) => <option key={d} value={i}>{d}</option>)}
              </select>
            )}
            <select value={form.hour} onChange={(e) => setForm({ ...form, hour: Number(e.target.value) })} className={inputCls} title="Local time">
              {Array.from({ length: 24 }, (_, h) => <option key={h} value={h}>{new Date(2000, 0, 1, h).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</option>)}
            </select>
          </div>
          <div className="flex flex-wrap items-center gap-4 text-xs text-gray-600">
            <label className="flex items-center gap-1.5"><input type="checkbox" checked={form.checkExternalLinks} onChange={(e) => setForm({ ...form, checkExternalLinks: e.target.checked })} /> Check external links</label>
            <label className="flex items-center gap-1.5"><input type="checkbox" checked={form.needsLogin} onChange={(e) => setForm({ ...form, needsLogin: e.target.checked })} /> <Lock className="w-3 h-3" /> Site needs sign-in</label>
            {form.needsLogin && (
              <>
                <input value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} placeholder="Username" className={`${inputCls} py-1`} autoComplete="off" />
                <input type="password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} placeholder="Password" className={`${inputCls} py-1`} autoComplete="new-password" />
              </>
            )}
            <button onClick={create} disabled={busy === 'new'} className="ml-auto text-xs px-3 py-1.5 bg-gradient-to-r from-violet-600 to-indigo-600 hover:from-violet-500 hover:to-indigo-500 disabled:opacity-40 text-white rounded-lg flex items-center gap-1.5">
              {busy === 'new' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <CalendarClock className="w-3.5 h-3.5" />} Save schedule
            </button>
          </div>
        </div>
      )}
      {rows === null ? (
        <p className="p-4 text-xs text-gray-400 flex items-center gap-2"><Loader2 className="w-3.5 h-3.5 animate-spin" /> Loading…</p>
      ) : rows.length === 0 ? (
        <p className="p-4 text-xs text-gray-400">No recurring audits yet.</p>
      ) : (
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-[11px] text-gray-400 border-b border-gray-100 bg-gray-50/60">
              <th className="px-4 py-2 font-medium">Website</th>
              <th className="px-4 py-2 font-medium">Cadence</th>
              <th className="px-4 py-2 font-medium">Next run</th>
              <th className="px-4 py-2 font-medium">Last run</th>
              <th className="px-4 py-2 font-medium">Enabled</th>
              <th className="px-4 py-2" />
            </tr>
          </thead>
          <tbody>
            {rows.map((s) => (
              <tr key={s.id} className="border-b border-gray-50">
                <td className="px-4 py-2.5">
                  <p className="text-gray-800 truncate max-w-[320px]" title={s.target_url}>{s.target_url}</p>
                  <p className="text-[11px] text-gray-400">{s.options.username ? `signs in as ${s.options.username} · ` : ''}{s.options.checkExternalLinks === false ? 'internal links only' : 'checks external links'}{s.created_by ? ` · added by ${s.created_by}` : ''}</p>
                </td>
                <td className="px-4 py-2.5 text-xs text-gray-600 whitespace-nowrap">{describeSlot(s)}</td>
                <td className="px-4 py-2.5 text-xs text-gray-600 whitespace-nowrap">
                  {s.enabled && s.next_run_at ? new Date(s.next_run_at).toLocaleString() : <span className="text-gray-400">paused</span>}
                  {s.last_error && <p className="text-[11px] text-amber-600 max-w-[220px] truncate" title={s.last_error}>retrying: {s.last_error}</p>}
                </td>
                <td className="px-4 py-2.5 text-xs whitespace-nowrap">
                  {s.last_scan_id
                    ? <button onClick={() => onOpenScan(s.last_scan_id!)} className="text-violet-600 hover:underline">{s.last_run_at ? new Date(s.last_run_at).toLocaleString() : 'open'}</button>
                    : <span className="text-gray-400">never</span>}
                </td>
                <td className="px-4 py-2.5">
                  <button onClick={() => toggle(s)} disabled={busy === s.id} role="switch" aria-checked={s.enabled} className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors disabled:opacity-50 ${s.enabled ? 'bg-violet-600' : 'bg-gray-300'}`} title={s.enabled ? 'Pause' : 'Resume'}>
                    <span className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ${s.enabled ? 'translate-x-4' : 'translate-x-0.5'}`} />
                  </button>
                </td>
                <td className="px-4 py-2.5 text-right whitespace-nowrap">
                  <button onClick={() => runNow(s)} disabled={busy === s.id} className="inline-flex items-center gap-1 text-xs text-gray-600 hover:text-violet-700 border border-gray-200 hover:border-violet-200 bg-white rounded-lg px-2 py-1 mr-2 transition-colors disabled:opacity-50" title="Start this audit now">
                    <Play className="w-3 h-3" /> Run now
                  </button>
                  <button onClick={() => remove(s)} disabled={busy === s.id} className="text-gray-300 hover:text-red-500 transition-colors disabled:opacity-50" title="Delete schedule"><Trash2 className="w-4 h-4" /></button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

export default function AdaCompliancePage() {
  const navigate = useNavigate();
  const [scans, setScans] = useState<AdaScanRecord[] | null>(null);
  const [mode, setMode] = useState<'list' | 'new' | 'view'>('list');
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState('');

  const [reloadTick, setReloadTick] = useState(0);
  const load = useCallback(() => setReloadTick((n) => n + 1), []);

  useEffect(() => {
    let alive = true;
    listAdaScans()
      .then((rows) => { if (alive) { setScans(rows); setError(''); } })
      .catch((err: unknown) => { if (alive) { setError(errorMessage(err, 'Could not load audits')); setScans([]); } });
    return () => { alive = false; };
  }, [reloadTick]);
  // Keep the list fresh while an audit is running in the background.
  const anyRunning = mode === 'list' && !!scans?.some((s) => s.status === 'running');
  useEffect(() => {
    if (!anyRunning) return;
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [anyRunning, load]);

  const [stopping, setStopping] = useState<string | null>(null);
  const stop = async (id: string) => {
    setStopping(id);
    try { await cancelAdaScan(id); setTimeout(load, 2000); } catch (err: unknown) { setError(errorMessage(err, 'Could not stop the audit')); }
    finally { setTimeout(() => setStopping(null), 2000); }
  };

  const remove = async (id: string) => {
    if (!confirm('Delete this audit and all of its findings?')) return;
    try { await deleteAdaScan(id); load(); } catch (err: unknown) { setError(errorMessage(err, 'Delete failed')); }
  };

  // Hand the crawled site to the Chat wizard's explore flow.
  const brownfield = (ctx: BrownfieldHandoff) => {
    sessionStorage.setItem('intelliqe_ada_brownfield', JSON.stringify(ctx));
    navigate('/chat');
  };

  const backToList = () => { setMode('list'); setSelected(null); load(); };

  if (mode !== 'list') {
    return (
      <div className="p-6 space-y-4">
        <button onClick={backToList} className="text-xs text-gray-500 hover:text-gray-800 flex items-center gap-1"><ChevronLeft className="w-3.5 h-3.5" /> All audits</button>
        <AdaCompliancePanel initialScanId={mode === 'view' ? selected || undefined : undefined} onBrownfield={brownfield} onReset={backToList} />
      </div>
    );
  }

  return (
    <div className="p-6 space-y-5">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-lg font-semibold text-gray-800 flex items-center gap-2">
            <Accessibility className="w-5 h-5 text-violet-500" /> ADA Compliance
          </h1>
          <p className="text-xs text-gray-500 mt-1">
            Give IntelliQE a website address. It crawls every page it can reach and reports accessibility (WCAG 2.2 AA) violations, broken links and best-practice issues as one scored health report.
          </p>
        </div>
        <button onClick={() => setMode('new')} className="flex-shrink-0 px-3.5 py-2 bg-gradient-to-r from-violet-600 to-indigo-600 hover:from-violet-500 hover:to-indigo-500 text-white text-sm font-medium rounded-lg flex items-center gap-2 transition-all">
          <Plus className="w-4 h-4" /> New audit
        </button>
      </div>

      {error && <p className="text-xs text-red-600 bg-red-50 border border-red-100 rounded-lg px-3 py-2">{error}</p>}

      <RecurringAudits onOpenScan={(id) => { setSelected(id); setMode('view'); }} onStarted={load} />

      <div className="bg-white border border-gray-100 rounded-xl shadow-sm overflow-hidden">
        {scans === null ? (
          <p className="p-6 text-sm text-gray-400 flex items-center gap-2"><Loader2 className="w-4 h-4 animate-spin" /> Loading…</p>
        ) : scans.length === 0 ? (
          <div className="p-10 text-center">
            <Accessibility className="w-8 h-8 text-gray-300 mx-auto mb-2" />
            <p className="text-sm text-gray-600">No audits yet.</p>
            <p className="text-xs text-gray-400 mt-1">Start one with a single URL — no requirements or setup needed.</p>
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-[11px] text-gray-400 border-b border-gray-100 bg-gray-50/60">
                <th className="px-4 py-2.5 font-medium">Website</th>
                <th className="px-4 py-2.5 font-medium">Status</th>
                <th className="px-4 py-2.5 font-medium text-right">Health</th>
                <th className="px-4 py-2.5 font-medium text-right">Pages</th>
                <th className="px-4 py-2.5 font-medium text-right">Links</th>
                <th className="px-4 py-2.5 font-medium text-right">Issues</th>
                <th className="px-4 py-2.5 font-medium">Run</th>
                <th className="px-4 py-2.5" />
              </tr>
            </thead>
            <tbody>
              {scans.map((s) => {
                const Icon = STATUS_ICON[s.status] || Clock;
                const openable = s.status === 'completed' || s.status === 'cancelled' || s.status === 'running';
                return (
                  <tr key={s.id} className="border-b border-gray-50 hover:bg-violet-50/30 transition-colors">
                    <td className="px-4 py-3">
                      <button disabled={!openable} onClick={() => { setSelected(s.id); setMode('view'); }} className="text-left disabled:cursor-default">
                        <p className="text-gray-800 font-medium">{s.site_name || s.target_url}</p>
                        <p className="text-[11px] text-gray-400 truncate max-w-[360px]">{s.target_url}</p>
                      </button>
                    </td>
                    <td className="px-4 py-3">
                      <span className={`inline-flex items-center gap-1.5 text-xs ${s.status === 'completed' ? 'text-emerald-600' : s.status === 'failed' ? 'text-red-600' : s.status === 'running' ? 'text-violet-600' : 'text-gray-500'}`}>
                        <Icon className={`w-3.5 h-3.5 ${s.status === 'running' ? 'animate-spin' : ''}`} /> {s.status}
                      </span>
                      {s.status === 'failed' && s.error && <p className="text-[11px] text-red-500 mt-0.5 max-w-[240px] truncate" title={s.error}>{s.error}</p>}
                    </td>
                    <td className={`px-4 py-3 text-right font-semibold ${GRADE_COLOR(s.overall_score)}`}>{s.overall_score ?? '—'}</td>
                    <td className="px-4 py-3 text-right text-gray-600">{s.pages_crawled}</td>
                    <td className="px-4 py-3 text-right text-gray-600">{s.links_checked}</td>
                    <td className="px-4 py-3 text-right text-gray-600">{s.findings_count}</td>
                    <td className="px-4 py-3 text-xs text-gray-500">
                      {new Date(s.created_at).toLocaleString()}
                      {s.created_by && <span className="block text-[11px] text-gray-400">{s.created_by}</span>}
                    </td>
                    <td className="px-4 py-3 text-right">
                      {s.status === 'running' ? (
                        <button onClick={() => stop(s.id)} disabled={stopping === s.id} className="inline-flex items-center gap-1.5 text-xs text-gray-600 hover:text-red-600 border border-gray-200 hover:border-red-200 bg-white rounded-lg px-2.5 py-1 transition-colors disabled:opacity-50" title="Stop now and keep the report for the pages audited so far">
                          <Square className="w-3 h-3 fill-current" /> {stopping === s.id ? 'Stopping…' : 'Stop & report'}
                        </button>
                      ) : (
                        <button onClick={() => remove(s.id)} className="text-gray-300 hover:text-red-500 transition-colors" title="Delete audit"><Trash2 className="w-4 h-4" /></button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
