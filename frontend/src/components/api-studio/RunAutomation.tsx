/**
 * RunAutomation — recurring schedules and outbound webhooks.
 *
 * Opt-in and standalone. "Schedules" saves the current endpoint set to re-run
 * on an interval through the same headless pipeline the app already uses;
 * "Webhooks" registers Slack/Teams/generic endpoints that get a summary when a
 * run finishes. Neither changes the generate → execute → heal pipeline — a
 * schedule only decides WHEN to invoke it, and a webhook only hears the result.
 */
import { useEffect, useState } from 'react';
import {
  X, Loader2, Clock, Bell, Plus, Trash2, Play, Power, Send, CheckCircle2, XCircle,
} from 'lucide-react';
import {
  listApiSchedules, createApiSchedule, updateApiSchedule, deleteApiSchedule, runApiScheduleNow, type ApiSchedule,
  listApiWebhooks, createApiWebhook, updateApiWebhook, deleteApiWebhook, testApiWebhook, type ApiWebhook,
} from '@/services/api';
import { useToast } from '@/components/feedback/ToastProvider';
import { CARD, STRIP, INPUT, LABEL, PRIMARY_BTN, relativeTime } from './format';
import type { CatalogEndpoint } from './types';

const INTERVALS: { label: string; minutes: number }[] = [
  { label: 'Every 15 min', minutes: 15 },
  { label: 'Every 30 min', minutes: 30 },
  { label: 'Hourly', minutes: 60 },
  { label: 'Every 6 hours', minutes: 360 },
  { label: 'Every 12 hours', minutes: 720 },
  { label: 'Daily', minutes: 1440 },
  { label: 'Weekly', minutes: 10080 },
];

function intervalLabel(m: number): string {
  return INTERVALS.find((i) => i.minutes === m)?.label || `Every ${m} min`;
}

function StatusDot({ status }: { status?: string }) {
  const map: Record<string, string> = { passed: 'bg-emerald-500', failed: 'bg-red-500', error: 'bg-amber-500', ok: 'bg-emerald-500' };
  return <span className={`w-2 h-2 rounded-full flex-shrink-0 ${map[status || ''] || 'bg-gray-300'}`} title={status || 'not run yet'} />;
}

export default function RunAutomation({ endpoints, onClose }: { endpoints: CatalogEndpoint[]; onClose: () => void }) {
  const toast = useToast();
  const [tab, setTab] = useState<'schedules' | 'webhooks'>('schedules');
  const [schedules, setSchedules] = useState<ApiSchedule[]>([]);
  const [webhooks, setWebhooks] = useState<ApiWebhook[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState('');

  const refresh = async () => {
    try {
      const [s, w] = await Promise.all([listApiSchedules(), listApiWebhooks()]);
      setSchedules(s.schedules); setWebhooks(w.webhooks);
    } catch (err) { toast.fromError(err); }
  };
  useEffect(() => { (async () => { await refresh(); setLoading(false); })(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-[#1E1B4B]/30 backdrop-blur-sm p-4" onClick={onClose}>
      <div className={`${CARD} w-full max-w-2xl max-h-[85vh] flex flex-col overflow-hidden`} onClick={(e) => e.stopPropagation()}>
        <div className={`flex items-center gap-2 px-4 h-12 border-b border-[#EDE9FE] flex-shrink-0 ${STRIP}`}>
          <Clock className="w-4 h-4 text-[#7C3AED]" />
          <h3 className="text-[13px] font-semibold text-gray-900">Run automation</h3>
          <div className="ml-3 flex items-center gap-1 bg-[#F1EDFB] rounded-lg p-0.5">
            {(['schedules', 'webhooks'] as const).map((t) => (
              <button key={t} type="button" onClick={() => setTab(t)}
                className={`px-2.5 py-1 rounded-md text-[11.5px] font-medium capitalize transition-colors ${tab === t ? 'bg-white text-[#6D28D9] shadow-sm' : 'text-gray-500 hover:text-gray-700'}`}>
                {t === 'schedules' ? <Clock className="w-3 h-3 inline mr-1" /> : <Bell className="w-3 h-3 inline mr-1" />}{t}
              </button>
            ))}
          </div>
          <button type="button" onClick={onClose} className="ml-auto p-1.5 rounded-md text-gray-400 hover:text-[#7C3AED] hover:bg-[#F5F3FF]"><X className="w-4 h-4" /></button>
        </div>

        <div className="flex-1 overflow-y-auto min-h-0 p-4">
          {loading ? (
            <div className="flex items-center justify-center gap-2 py-16 text-[12px] text-gray-500"><Loader2 className="w-4 h-4 animate-spin text-[#7C3AED]" />Loading…</div>
          ) : tab === 'schedules' ? (
            <SchedulesTab
              endpoints={endpoints} schedules={schedules} busyId={busyId} setBusyId={setBusyId}
              onChange={refresh} toast={toast}
            />
          ) : (
            <WebhooksTab webhooks={webhooks} busyId={busyId} setBusyId={setBusyId} onChange={refresh} toast={toast} />
          )}
        </div>
      </div>
    </div>
  );
}

/* ───────────────────────────── Schedules ───────────────────────────── */

function SchedulesTab({ endpoints, schedules, busyId, setBusyId, onChange, toast }: {
  endpoints: CatalogEndpoint[]; schedules: ApiSchedule[]; busyId: string; setBusyId: (v: string) => void;
  onChange: () => Promise<void>; toast: ReturnType<typeof useToast>;
}) {
  const [name, setName] = useState('');
  const [minutes, setMinutes] = useState(1440);
  const [heal, setHeal] = useState(true);
  const [creating, setCreating] = useState(false);

  const create = async () => {
    if (!name.trim()) { toast.warning('Name required', 'Give the schedule a name.'); return; }
    if (endpoints.length === 0) { toast.warning('No endpoints', 'Import or select endpoints before scheduling a run.'); return; }
    setCreating(true);
    try {
      await createApiSchedule({
        name: name.trim(),
        endpoints: endpoints.map((e) => ({ id: e.id, title: e.title, method: e.method, url: e.url, headers: e.headers, auth: e.auth, body: e.body, expectedStatus: e.expectedStatus })),
        intervalMinutes: minutes, heal, execute: true, enabled: true,
      });
      toast.success('Schedule created', `${name.trim()} · ${intervalLabel(minutes)}`);
      setName('');
      await onChange();
    } catch (err) { toast.fromError(err); } finally { setCreating(false); }
  };

  const toggle = async (s: ApiSchedule) => {
    setBusyId(s.id);
    try { await updateApiSchedule(s.id, { enabled: !s.enabled }); await onChange(); }
    catch (err) { toast.fromError(err); } finally { setBusyId(''); }
  };
  const runNow = async (s: ApiSchedule) => {
    setBusyId(s.id);
    try { await runApiScheduleNow(s.id); toast.info('Run started', `${s.name} is running in the background.`); }
    catch (err) { toast.fromError(err); } finally { setBusyId(''); }
  };
  const remove = async (s: ApiSchedule) => {
    if (!window.confirm(`Delete the schedule "${s.name}"? This stops its recurring runs.`)) return;
    setBusyId(s.id);
    try { await deleteApiSchedule(s.id); toast.success('Schedule deleted', s.name); await onChange(); }
    catch (err) { toast.fromError(err); } finally { setBusyId(''); }
  };

  return (
    <div className="space-y-4">
      {/* New schedule */}
      <div className="border border-[#E9E5FB] rounded-lg p-3 bg-white">
        <div className="grid grid-cols-[1fr_150px] gap-2.5 items-end">
          <div>
            <label className={LABEL}>New schedule name</label>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Nightly smoke — staging" className={INPUT} />
          </div>
          <div>
            <label className={LABEL}>Interval</label>
            <select value={minutes} onChange={(e) => setMinutes(Number(e.target.value))} className={INPUT}>
              {INTERVALS.map((i) => <option key={i.minutes} value={i.minutes}>{i.label}</option>)}
            </select>
          </div>
        </div>
        <div className="flex items-center justify-between mt-2.5">
          <label className="flex items-center gap-1.5 text-[11.5px] text-gray-600 cursor-pointer">
            <input type="checkbox" checked={heal} onChange={(e) => setHeal(e.target.checked)} className="w-3.5 h-3.5 rounded border-gray-300 text-[#7C3AED]" />
            Self-heal failures
          </label>
          <span className="text-[10.5px] text-gray-400">{endpoints.length} endpoint{endpoints.length === 1 ? '' : 's'} captured</span>
          <button type="button" onClick={() => void create()} disabled={creating} className={PRIMARY_BTN}>
            {creating ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Plus className="w-3.5 h-3.5" />}Create
          </button>
        </div>
        <p className="text-[10.5px] text-gray-400 mt-2">First run fires one interval from now. Each run uses the endpoints captured above; re-create to refresh them.</p>
      </div>

      {/* Existing schedules */}
      {schedules.length === 0 ? (
        <p className="text-center text-[12px] text-gray-400 py-6">No schedules yet.</p>
      ) : (
        <div className="space-y-1.5">
          {schedules.map((s) => (
            <div key={s.id} className="flex items-center gap-2 border border-gray-200 rounded-lg px-3 py-2">
              <StatusDot status={s.lastStatus} />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                  <span className="text-[12px] font-medium text-gray-800 truncate">{s.name}</span>
                  {!s.enabled && <span className="text-[9px] font-semibold uppercase px-1 py-0.5 rounded bg-gray-100 text-gray-500">paused</span>}
                </div>
                <div className="text-[10.5px] text-gray-400 flex items-center gap-1.5 flex-wrap">
                  <span>{intervalLabel(s.intervalMinutes)}</span>·<span>{s.endpointCount} ep</span>
                  {s.lastStatus && <>·<span className={s.lastStatus === 'passed' ? 'text-emerald-600' : s.lastStatus === 'error' ? 'text-amber-600' : 'text-red-600'}>{s.lastSummary || s.lastStatus}</span></>}
                  {s.enabled && s.nextRunAt && <>·<span>next {relativeTime(s.nextRunAt)}</span></>}
                </div>
              </div>
              <button type="button" onClick={() => void runNow(s)} disabled={busyId === s.id} title="Run now" className="p-1.5 rounded-md text-gray-400 hover:text-[#7C3AED] hover:bg-[#F5F3FF] disabled:opacity-40"><Play className="w-3.5 h-3.5" /></button>
              <button type="button" onClick={() => void toggle(s)} disabled={busyId === s.id} title={s.enabled ? 'Pause' : 'Resume'} className={`p-1.5 rounded-md hover:bg-[#F5F3FF] disabled:opacity-40 ${s.enabled ? 'text-emerald-600' : 'text-gray-400'}`}><Power className="w-3.5 h-3.5" /></button>
              <button type="button" onClick={() => void remove(s)} disabled={busyId === s.id} title="Delete" className="p-1.5 rounded-md text-gray-400 hover:text-red-500 hover:bg-red-50 disabled:opacity-40"><Trash2 className="w-3.5 h-3.5" /></button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ───────────────────────────── Webhooks ───────────────────────────── */

function WebhooksTab({ webhooks, busyId, setBusyId, onChange, toast }: {
  webhooks: ApiWebhook[]; busyId: string; setBusyId: (v: string) => void;
  onChange: () => Promise<void>; toast: ReturnType<typeof useToast>;
}) {
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [kind, setKind] = useState<'slack' | 'teams' | 'generic'>('slack');
  const [failOnly, setFailOnly] = useState(false);
  const [creating, setCreating] = useState(false);

  const create = async () => {
    if (!name.trim()) { toast.warning('Name required', 'Give the webhook a name.'); return; }
    if (!/^https?:\/\//i.test(url.trim())) { toast.warning('URL required', 'Enter the incoming-webhook URL.'); return; }
    setCreating(true);
    try {
      await createApiWebhook({ name: name.trim(), url: url.trim(), kind, onFailureOnly: failOnly, enabled: true });
      toast.success('Webhook added', name.trim());
      setName(''); setUrl('');
      await onChange();
    } catch (err) { toast.fromError(err); } finally { setCreating(false); }
  };
  const toggle = async (w: ApiWebhook) => {
    setBusyId(w.id);
    try { await updateApiWebhook(w.id, { enabled: !w.enabled }); await onChange(); }
    catch (err) { toast.fromError(err); } finally { setBusyId(''); }
  };
  const test = async (w: ApiWebhook) => {
    setBusyId(w.id);
    try { await testApiWebhook(w.id); toast.success('Test sent', `${w.name} accepted the test notification.`); await onChange(); }
    catch (err) { toast.fromError(err); } finally { setBusyId(''); }
  };
  const remove = async (w: ApiWebhook) => {
    if (!window.confirm(`Delete the webhook "${w.name}"?`)) return;
    setBusyId(w.id);
    try { await deleteApiWebhook(w.id); toast.success('Webhook deleted', w.name); await onChange(); }
    catch (err) { toast.fromError(err); } finally { setBusyId(''); }
  };

  return (
    <div className="space-y-4">
      <div className="border border-[#E9E5FB] rounded-lg p-3 bg-white">
        <div className="grid grid-cols-[1fr_130px] gap-2.5 items-end">
          <div>
            <label className={LABEL}>Name</label>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="#qa-alerts" className={INPUT} />
          </div>
          <div>
            <label className={LABEL}>Type</label>
            <select value={kind} onChange={(e) => setKind(e.target.value as 'slack' | 'teams' | 'generic')} className={INPUT}>
              <option value="slack">Slack</option>
              <option value="teams">Microsoft Teams</option>
              <option value="generic">Generic JSON</option>
            </select>
          </div>
        </div>
        <div className="mt-2.5">
          <label className={LABEL}>Incoming-webhook URL</label>
          <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://hooks.slack.com/services/…" className={`${INPUT} font-mono text-[11.5px]`} />
        </div>
        <div className="flex items-center justify-between mt-2.5">
          <label className="flex items-center gap-1.5 text-[11.5px] text-gray-600 cursor-pointer">
            <input type="checkbox" checked={failOnly} onChange={(e) => setFailOnly(e.target.checked)} className="w-3.5 h-3.5 rounded border-gray-300 text-[#7C3AED]" />
            Only notify on failures
          </label>
          <button type="button" onClick={() => void create()} disabled={creating} className={PRIMARY_BTN}>
            {creating ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Plus className="w-3.5 h-3.5" />}Add
          </button>
        </div>
        <p className="text-[10.5px] text-gray-400 mt-2">A scheduled run notifies these automatically. Generic webhooks can add a secret later for HMAC signing.</p>
      </div>

      {webhooks.length === 0 ? (
        <p className="text-center text-[12px] text-gray-400 py-6">No webhooks yet.</p>
      ) : (
        <div className="space-y-1.5">
          {webhooks.map((w) => (
            <div key={w.id} className="flex items-center gap-2 border border-gray-200 rounded-lg px-3 py-2">
              <span className={`text-[9px] font-semibold uppercase px-1.5 py-0.5 rounded flex-shrink-0 ${w.kind === 'slack' ? 'bg-[#4A154B]/10 text-[#4A154B]' : w.kind === 'teams' ? 'bg-[#4B53BC]/10 text-[#4B53BC]' : 'bg-gray-100 text-gray-600'}`}>{w.kind}</span>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                  <span className="text-[12px] font-medium text-gray-800 truncate">{w.name}</span>
                  {!w.enabled && <span className="text-[9px] font-semibold uppercase px-1 py-0.5 rounded bg-gray-100 text-gray-500">off</span>}
                  {w.onFailureOnly && <span className="text-[9px] font-semibold uppercase px-1 py-0.5 rounded bg-amber-50 text-amber-600">fails only</span>}
                </div>
                <div className="text-[10.5px] text-gray-400 flex items-center gap-1.5">
                  <span className="font-mono truncate">{w.url}</span>
                  {w.lastStatus && <span className="flex items-center gap-1 flex-shrink-0">{w.lastStatus === 'ok' ? <CheckCircle2 className="w-3 h-3 text-emerald-500" /> : <XCircle className="w-3 h-3 text-red-500" />}{relativeTime(w.lastSentAt)}</span>}
                </div>
              </div>
              <button type="button" onClick={() => void test(w)} disabled={busyId === w.id} title="Send test" className="p-1.5 rounded-md text-gray-400 hover:text-[#7C3AED] hover:bg-[#F5F3FF] disabled:opacity-40"><Send className="w-3.5 h-3.5" /></button>
              <button type="button" onClick={() => void toggle(w)} disabled={busyId === w.id} title={w.enabled ? 'Disable' : 'Enable'} className={`p-1.5 rounded-md hover:bg-[#F5F3FF] disabled:opacity-40 ${w.enabled ? 'text-emerald-600' : 'text-gray-400'}`}><Power className="w-3.5 h-3.5" /></button>
              <button type="button" onClick={() => void remove(w)} disabled={busyId === w.id} title="Delete" className="p-1.5 rounded-md text-gray-400 hover:text-red-500 hover:bg-red-50 disabled:opacity-40"><Trash2 className="w-3.5 h-3.5" /></button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
