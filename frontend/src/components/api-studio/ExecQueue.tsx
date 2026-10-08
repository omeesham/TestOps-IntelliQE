/**
 * ExecQueue — a slot-based parallel execution queue over the headless pipeline.
 *
 * Opt-in and standalone. The workspace runs one pipeline at a time by default;
 * this modal fans runs out across a fixed number of "slots". A run is enqueued
 * with a title and a coverage level, then the queue drains it as a slot frees:
 * `queued → running → done | failed`, or `canceled` while still queued. The
 * modal polls the queue every 3s so the table tracks the drain live. It changes
 * nothing in the catalogue; it only enqueues headless runs over the endpoints
 * the workspace already holds.
 */
import { useState, useEffect, useRef, useCallback } from 'react';
import { X, Layers, Plus, Save, XCircle, AlertTriangle } from 'lucide-react';
import Spinner from '@/components/feedback/Spinner';
import { useToast } from '@/components/feedback/ToastProvider';
import { getExecQueue, saveExecQueueConfig, enqueueRun, cancelQueueItem, type QueueView, type QueueItem } from '@/services/api';
import { EmptyState } from './primitives';
import { CARD, STRIP, FIELD, INPUT, LABEL, PRIMARY_BTN, SECONDARY_BTN, THEAD, relativeTime } from './format';
import type { CatalogEndpoint } from './types';

/* Colour means status here: queued is muted, running takes the brand violet,
 * done is green, failed is red, canceled stays de-emphasised. */
const STATUS_CHIP: Record<QueueItem['status'], { label: string; cls: string; dot: string }> = {
  queued:   { label: 'Queued',   cls: 'text-[#6B7280] bg-gray-50 border-gray-200',           dot: 'bg-gray-400' },
  running:  { label: 'Running',  cls: 'text-[#7C3AED] bg-[#F5F3FF] border-[#DDD6FE]',         dot: 'bg-[#7C3AED] animate-pulse' },
  done:     { label: 'Done',     cls: 'text-[#15803D] bg-emerald-50 border-emerald-200',      dot: 'bg-[#15803D]' },
  failed:   { label: 'Failed',   cls: 'text-[#C32C2C] bg-red-50 border-red-200',              dot: 'bg-[#C32C2C]' },
  canceled: { label: 'Canceled', cls: 'text-[#6B7280] bg-gray-50 border-gray-200 opacity-70', dot: 'bg-gray-300' },
};

function StatusChip({ status }: { status: QueueItem['status'] }) {
  const m = STATUS_CHIP[status];
  return (
    <span className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full border text-[11px] font-medium ${m.cls}`}>
      <span className={`w-1.5 h-1.5 rounded-full ${m.dot}`} />
      {m.label}
    </span>
  );
}

export default function ExecQueue({ endpoints, onClose }: { endpoints: CatalogEndpoint[]; onClose: () => void }) {
  const toast = useToast();
  const [view, setView] = useState<QueueView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [slots, setSlots] = useState(2);
  const [savingSlots, setSavingSlots] = useState(false);
  const [title, setTitle] = useState('Queued run');
  const [coverage, setCoverage] = useState('standard');
  const [enqueuing, setEnqueuing] = useState(false);
  const [canceling, setCanceling] = useState<string | null>(null);

  // Seed the slots input from the server's configured value once, so the 3s
  // poll never clobbers what the user is in the middle of typing.
  const seeded = useRef(false);

  const refresh = useCallback(async () => {
    try {
      const v = await getExecQueue();
      setView(v);
      if (!seeded.current) { setSlots(v.slots); seeded.current = true; }
      setError('');
    } catch (e: any) {
      setError(e?.response?.data?.error || e?.message || 'Request failed.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const id = setInterval(() => void refresh(), 3000);
    return () => clearInterval(id);
  }, [refresh]);

  const saveSlots = async () => {
    setSavingSlots(true); setError('');
    try {
      await saveExecQueueConfig(slots);
      await refresh();
      toast.success('Slots updated', `Up to ${slots} run${slots === 1 ? '' : 's'} in parallel.`);
    } catch (e: any) {
      setError(e?.response?.data?.error || e?.message || 'Request failed.');
    } finally {
      setSavingSlots(false);
    }
  };

  const enqueue = async () => {
    setEnqueuing(true); setError('');
    try {
      await enqueueRun({ title: title.trim() || 'Queued run', endpoints, coverage });
      await refresh();
      toast.success('Run enqueued', `${endpoints.length} endpoint${endpoints.length === 1 ? '' : 's'} queued.`);
    } catch (e: any) {
      setError(e?.response?.data?.error || e?.message || 'Request failed.');
    } finally {
      setEnqueuing(false);
    }
  };

  const cancel = async (id: string) => {
    setCanceling(id); setError('');
    try {
      await cancelQueueItem(id);
      await refresh();
    } catch (e: any) {
      setError(e?.response?.data?.error || e?.message || 'Request failed.');
    } finally {
      setCanceling(null);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-[#1E1B4B]/30 backdrop-blur-sm p-4" onClick={onClose}>
      <div className={`${CARD} w-full max-w-2xl max-h-[88vh] flex flex-col overflow-hidden`} onClick={(e) => e.stopPropagation()}>
        <div className={`flex items-center gap-2 px-4 h-12 border-b border-[#EDE9FE] flex-shrink-0 ${STRIP}`}>
          <Layers className="w-4 h-4 text-[#7C3AED]" />
          <h3 className="text-[13px] font-semibold text-gray-900">Parallel execution queue</h3>
          <span className="text-[11px] text-gray-400">slot-based parallel run queue</span>
          <button type="button" onClick={onClose} className="ml-auto p-1.5 rounded-md text-gray-400 hover:text-[#7C3AED] hover:bg-[#F5F3FF]"><X className="w-4 h-4" /></button>
        </div>

        <div className="p-4 space-y-3 overflow-y-auto min-h-0">
          {/* Header stats */}
          <div className="flex flex-wrap items-center gap-2 text-[11.5px]">
            <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md border bg-gray-50 border-gray-200 text-gray-700 font-mono tabular-nums">{view?.slots ?? '—'} slots</span>
            <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md border bg-[#F5F3FF] border-[#DDD6FE] text-[#6D28D9] font-mono tabular-nums">{view?.running ?? 0} running</span>
            <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md border bg-gray-50 border-gray-200 text-gray-700 font-mono tabular-nums">{view?.queued ?? 0} queued</span>
          </div>

          {/* Slots config */}
          <div>
            <label className={LABEL}>Parallel slots — how many runs execute at once</label>
            <div className="flex items-center gap-2">
              <input type="number" min={1} max={8} value={slots} onChange={(e) => setSlots(Math.min(8, Math.max(1, Number(e.target.value))))} className={`${FIELD} w-20 tabular-nums`} />
              <button type="button" onClick={() => void saveSlots()} disabled={savingSlots} className={SECONDARY_BTN}>
                {savingSlots ? <Spinner className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
                Save
              </button>
            </div>
          </div>

          {/* Enqueue a run */}
          <div>
            <label className={LABEL}>Enqueue a run</label>
            <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Queued run" className={INPUT} />
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <select value={coverage} onChange={(e) => setCoverage(e.target.value)} className={`${FIELD} w-40`}>
                <option value="essential">Essential</option>
                <option value="standard">Standard</option>
                <option value="exhaustive">Exhaustive</option>
              </select>
              <span className="text-[11px] text-gray-400 tabular-nums">
                {endpoints.length === 0 ? 'No endpoints to enqueue' : `${endpoints.length} endpoint${endpoints.length === 1 ? '' : 's'} will be enqueued`}
              </span>
              <button type="button" onClick={() => void enqueue()} disabled={enqueuing || endpoints.length === 0} className={`${PRIMARY_BTN} ml-auto`}>
                {enqueuing ? <Spinner className="w-3.5 h-3.5 animate-spin" /> : <Plus className="w-3.5 h-3.5" />}
                Enqueue
              </button>
            </div>
          </div>

          {error && (
            <div className="flex items-start gap-2 px-3 py-2 bg-red-50 border border-red-200 rounded-lg">
              <AlertTriangle className="w-4 h-4 text-red-500 flex-shrink-0 mt-px" /><p className="text-[12px] text-red-700 min-w-0 whitespace-pre-wrap break-words">{error}</p>
            </div>
          )}

          {/* Queue */}
          <div>
            <label className={LABEL}>Queue</label>
            {loading && !view ? (
              <div className="flex items-center justify-center py-10"><Spinner className="w-5 h-5 text-[#7C3AED]" /></div>
            ) : !view || view.items.length === 0 ? (
              <EmptyState icon={Layers} title="Nothing queued yet" hint="Enqueue a run above and it will appear here, draining as a slot frees up." />
            ) : (
              <div className="border border-[#E9E5FB] rounded-lg overflow-hidden">
                <table className="w-full text-[11.5px]">
                  <thead className={THEAD}>
                    <tr className="text-gray-500 text-left">
                      <th className="font-semibold px-2.5 py-1.5">Title</th>
                      <th className="font-semibold px-2.5 py-1.5">Status</th>
                      <th className="font-semibold px-2.5 py-1.5 text-right">Endpoints</th>
                      <th className="font-semibold px-2.5 py-1.5 text-right">Pass rate</th>
                      <th className="font-semibold px-2.5 py-1.5 text-right">Enqueued</th>
                      <th className="font-semibold px-2.5 py-1.5" />
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {view.items.map((it) => (
                      <tr key={it.id}>
                        <td className="px-2.5 py-1.5 text-gray-700 truncate max-w-[180px]">{it.title}</td>
                        <td className="px-2.5 py-1.5"><StatusChip status={it.status} /></td>
                        <td className="px-2.5 py-1.5 text-right font-mono tabular-nums">{it.endpointCount}</td>
                        <td className="px-2.5 py-1.5 text-right font-mono tabular-nums">{it.stats?.passRate != null ? `${it.stats.passRate}%` : '—'}</td>
                        <td className="px-2.5 py-1.5 text-right text-gray-500 tabular-nums">{relativeTime(it.enqueuedAt)}</td>
                        <td className="px-2.5 py-1.5 text-right">
                          {it.status === 'queued' && (
                            <button
                              type="button"
                              onClick={() => void cancel(it.id)}
                              disabled={canceling === it.id}
                              className="inline-flex items-center gap-1 px-2 py-1 text-[11px] font-medium rounded border text-gray-600 bg-white border-gray-200 hover:text-red-600 hover:border-red-200 disabled:opacity-40"
                            >
                              {canceling === it.id ? <Spinner className="w-3 h-3 animate-spin" /> : <XCircle className="w-3 h-3" />}
                              Cancel
                            </button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
