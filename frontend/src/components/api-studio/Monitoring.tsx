/**
 * Monitoring — an always-on watcher over the API catalogue.
 *
 * Standalone, opt-in surface: configure a continuous check (health, contract
 * drift, coverage), save it against the current catalogue, and run the checks
 * on demand. Recent alerts raised by those checks are surfaced as a timeline.
 * Nothing here mutates the pipeline.
 */
import { useState, useEffect } from 'react';
import { Activity, X, AlertTriangle, RefreshCw } from 'lucide-react';
import Spinner from '@/components/feedback/Spinner';
import { useToast } from '@/components/feedback/ToastProvider';
import {
  getMonitorConfig,
  saveMonitorConfig,
  listMonitorEvents,
  runMonitorNow,
  type MonitorConfigView,
  type MonitorEvent,
} from '@/services/api';
import { CARD, STRIP, FIELD, LABEL, PRIMARY_BTN, SECONDARY_BTN, relativeTime } from './format';
import { EmptyState } from './primitives';
import type { CatalogEndpoint } from './types';

const CHECK_OPTIONS: { key: string; label: string }[] = [
  { key: 'health', label: 'Health' },
  { key: 'drift', label: 'Contract drift' },
  { key: 'coverage', label: 'Coverage' },
];

/** Classify an alert's severity into one of the app's chip tones. */
function severityClass(severity: MonitorEvent['severity']): string {
  if (severity === 'critical') return 'text-red-700 bg-red-50 border-red-200';
  if (severity === 'warning') return 'text-amber-700 bg-amber-50 border-amber-200';
  return 'text-blue-700 bg-blue-50 border-blue-200';
}

export default function Monitoring({ endpoints, onClose }: { endpoints: CatalogEndpoint[]; onClose: () => void }) {
  const toast = useToast();
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [running, setRunning] = useState(false);

  const [config, setConfig] = useState<MonitorConfigView | null>(null);
  const [events, setEvents] = useState<MonitorEvent[]>([]);
  const [enabled, setEnabled] = useState(false);
  const [interval, setIntervalMinutes] = useState(15);
  const [checks, setChecks] = useState<string[]>([]);

  const applyConfig = (cfg: MonitorConfigView) => {
    setConfig(cfg);
    setEnabled(cfg.enabled);
    setIntervalMinutes(cfg.intervalMinutes);
    setChecks(cfg.checks || []);
  };

  useEffect(() => {
    (async () => {
      try {
        const [cfg, evs] = await Promise.all([getMonitorConfig(), listMonitorEvents()]);
        applyConfig(cfg);
        setEvents(evs.events || []);
      } catch (err: any) {
        setError(err?.response?.data?.error || err?.message || 'Could not load monitoring.');
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const toggleCheck = (name: string) =>
    setChecks((prev) => (prev.includes(name) ? prev.filter((c) => c !== name) : [...prev, name]));

  const save = async () => {
    setSaving(true); setError('');
    try {
      const cfg = await saveMonitorConfig({
        enabled,
        intervalMinutes: Number(interval),
        checks,
        endpoints: endpoints.map((e) => ({ method: e.method, url: e.url, title: e.title, headers: e.headers, auth: e.auth, expectedStatus: e.expectedStatus })),
      });
      applyConfig(cfg);
      toast.success('Monitoring saved');
    } catch (err: any) {
      setError(err?.response?.data?.error || err?.message || 'Could not save monitoring.');
    } finally {
      setSaving(false);
    }
  };

  const runNow = async () => {
    setRunning(true); setError('');
    try {
      const cfg = await runMonitorNow();
      const { events: list } = await listMonitorEvents();
      setEvents(list || []);
      applyConfig(cfg);
      toast.success('Checks run');
    } catch (err: any) {
      setError(err?.response?.data?.error || err?.message || 'Could not run checks.');
    } finally {
      setRunning(false);
    }
  };

  const errorBlock = error ? (
    <div className="flex items-start gap-2 px-3 py-2 bg-red-50 border border-red-200 rounded-lg">
      <AlertTriangle className="w-4 h-4 text-red-500 flex-shrink-0 mt-px" />
      <p className="text-[12px] text-red-700 min-w-0 whitespace-pre-wrap break-words">{error}</p>
    </div>
  ) : null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-[#1E1B4B]/30 backdrop-blur-sm p-4" onClick={onClose}>
      <div className={`${CARD} w-full max-w-2xl max-h-[85vh] flex flex-col overflow-hidden`} onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className={`flex items-center gap-2 px-4 h-12 border-b border-[#EDE9FE] flex-shrink-0 ${STRIP}`}>
          <Activity className="w-4 h-4 text-[#7C3AED]" />
          <h3 className="text-[13px] font-semibold text-gray-900">Monitoring</h3>
          <span className="text-[11px] text-gray-400">Always-on health · drift · coverage watcher</span>
          <button type="button" onClick={onClose} className="ml-auto p-1.5 rounded-md text-gray-400 hover:text-[#7C3AED] hover:bg-[#F5F3FF]"><X className="w-4 h-4" /></button>
        </div>

        {/* Body */}
        <div className="flex-1 min-h-0 overflow-y-auto p-4 space-y-4">
          {errorBlock}
          {loading ? (
            <div className="flex items-center justify-center py-8 text-gray-400"><Spinner className="w-5 h-5 animate-spin" /></div>
          ) : (
            <>
              {/* Config */}
              <div className="rounded-lg border border-[#E4E0F5] bg-[#FAF9FE] p-3 space-y-3">
                <label className="flex items-center gap-2 text-[12px] text-gray-700">
                  <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} className="w-3.5 h-3.5" />
                  <span className="font-medium">Enable continuous monitoring</span>
                </label>

                <div>
                  <label className={LABEL}>Check every (minutes)</label>
                  <input type="number" min={5} value={interval} onChange={(e) => setIntervalMinutes(Number(e.target.value))} className={`${FIELD} w-24`} />
                </div>

                <div>
                  <label className={LABEL}>Checks</label>
                  <div className="flex flex-wrap gap-4">
                    {CHECK_OPTIONS.map((c) => (
                      <label key={c.key} className="flex items-center gap-2 text-[12px] text-gray-600">
                        <input type="checkbox" checked={checks.includes(c.key)} onChange={() => toggleCheck(c.key)} className="w-3.5 h-3.5" />
                        {c.label}
                      </label>
                    ))}
                  </div>
                </div>

                <p className="text-[11.5px] text-gray-400">Watches {endpoints.length} endpoint(s) in the catalogue.</p>

                <div className="flex justify-end">
                  <button type="button" onClick={() => void save()} disabled={saving || running} className={PRIMARY_BTN}>
                    {saving && <Spinner className="w-3.5 h-3.5 animate-spin" />}Save
                  </button>
                </div>
              </div>

              {/* Status */}
              {config && (config.lastRunAt || (config.nextRunAt && enabled)) && (
                <div className="space-y-0.5">
                  {config.lastRunAt && (
                    <p className="text-[11.5px] text-gray-400">Last run {relativeTime(config.lastRunAt)} · {config.lastStatus} · {config.lastSummary}</p>
                  )}
                  {config.nextRunAt && enabled && (
                    <p className="text-[11.5px] text-gray-400">Next run {relativeTime(config.nextRunAt)}</p>
                  )}
                </div>
              )}

              {/* Run now */}
              <div>
                <button type="button" onClick={() => void runNow()} disabled={running || saving} className={SECONDARY_BTN}>
                  {running ? <Spinner className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}Run now
                </button>
              </div>

              {/* Recent alerts */}
              <div>
                <label className={LABEL}>Recent alerts</label>
                {events.length === 0 ? (
                  <EmptyState icon={Activity} title="No alerts yet" hint="Alerts from health, drift and coverage checks will appear here." />
                ) : (
                  <div className="space-y-1.5">
                    {events.map((ev) => (
                      <div key={ev.id} className={`${CARD} px-3 py-2 space-y-1`}>
                        <div className="flex items-center gap-2">
                          <span className={`inline-flex items-center px-1.5 py-0.5 rounded border text-[10px] font-medium flex-shrink-0 ${severityClass(ev.severity)}`}>{ev.severity}</span>
                          <span className="text-[11px] font-mono text-[#6D28D9] bg-[#F5F3FF] border border-[#DDD6FE] rounded px-1.5 py-0.5 flex-shrink-0">{ev.checkKind}</span>
                          <span className="text-[12px] text-gray-700 truncate min-w-0 flex-1">{ev.title}</span>
                          <span className="text-[10.5px] text-gray-400 flex-shrink-0 tabular-nums">{relativeTime(ev.createdAt)}</span>
                        </div>
                        <p className="text-[11px] text-gray-500 truncate">{ev.detail}</p>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
