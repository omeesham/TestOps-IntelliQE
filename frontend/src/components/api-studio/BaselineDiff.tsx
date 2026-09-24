/**
 * BaselineDiff — response-diff regression baselines.
 *
 * Opt-in and standalone. Two moves, both live-probing the endpoints handed to
 * it and touching nothing in the catalogue or the pipeline:
 *   • Capture — snapshot each endpoint's current response as the baseline.
 *   • Compare — probe again and diff the fresh response against the snapshot,
 *     surfacing silent drift (status, added/removed/retyped/changed fields).
 * Volatile fields (ids, timestamps, tokens) are compared by type, not value,
 * so a fresh id is never reported as a regression.
 */
import { useEffect, useState } from 'react';
import {
  X, Loader2, Camera, GitCompare, AlertTriangle, CheckCircle2, ShieldQuestion,
} from 'lucide-react';
import {
  listApiBaselines, captureApiBaselines, compareApiBaselines,
  type BaselineRecord, type BaselineCompareReport, type BaselineCompareResult, type DriftEntry,
} from '@/services/api';
import { MethodBadge } from './primitives';
import { CARD, STRIP, RAISED, relativeTime } from './format';
import type { CatalogEndpoint } from './types';

function toPayload(e: CatalogEndpoint) {
  return { id: e.id, title: e.title, method: e.method, url: e.url, headers: e.headers, auth: e.auth, body: e.body };
}

const DRIFT_TONE: Record<DriftEntry['kind'], string> = {
  status: 'text-red-700 bg-red-50',
  removed: 'text-red-700 bg-red-50',
  added: 'text-emerald-700 bg-emerald-50',
  'type-changed': 'text-amber-700 bg-amber-50',
  'value-changed': 'text-amber-700 bg-amber-50',
  transport: 'text-amber-700 bg-amber-50',
  content: 'text-amber-700 bg-amber-50',
};

export default function BaselineDiff({ endpoints, onClose }: { endpoints: CatalogEndpoint[]; onClose: () => void }) {
  const [baselines, setBaselines] = useState<BaselineRecord[]>([]);
  const [report, setReport] = useState<BaselineCompareReport | null>(null);
  const [busy, setBusy] = useState<'idle' | 'loading' | 'capturing' | 'comparing'>('loading');
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');

  const refreshList = async () => {
    try { setBaselines((await listApiBaselines()).baselines); } catch { /* non-fatal — the actions still work */ }
  };

  useEffect(() => {
    (async () => { await refreshList(); setBusy('idle'); })();
  }, []);

  const capture = async () => {
    setBusy('capturing'); setError(''); setNotice(''); setReport(null);
    try {
      const r = await captureApiBaselines(endpoints.map(toPayload));
      setNotice(`Captured ${r.captured} baseline${r.captured === 1 ? '' : 's'}${r.skipped ? ` · ${r.skipped} unreachable, skipped` : ''}.`);
      await refreshList();
    } catch (err: any) {
      setError(err?.response?.data?.error || err?.message || 'Capture failed.');
    } finally { setBusy('idle'); }
  };

  const compare = async () => {
    setBusy('comparing'); setError(''); setNotice('');
    try {
      setReport(await compareApiBaselines(endpoints.map(toPayload)));
    } catch (err: any) {
      setError(err?.response?.data?.error || err?.message || 'Compare failed.');
    } finally { setBusy('idle'); }
  };

  const running = busy === 'capturing' || busy === 'comparing';
  const covered = baselines.length;
  const s = report?.summary;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-[#1E1B4B]/30 backdrop-blur-sm p-4" onClick={onClose}>
      <div className={`${CARD} w-full max-w-3xl max-h-[85vh] flex flex-col overflow-hidden`} onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className={`flex items-center gap-2 px-4 h-12 border-b border-[#EDE9FE] flex-shrink-0 ${STRIP}`}>
          <GitCompare className="w-4 h-4 text-[#7C3AED]" />
          <h3 className="text-[13px] font-semibold text-gray-900">Regression baselines</h3>
          <span className="text-[11px] text-gray-400">{covered} snapshot{covered === 1 ? '' : 's'} stored · {endpoints.length} selected</span>
          <button type="button" onClick={onClose} className="ml-auto p-1.5 rounded-md text-gray-400 hover:text-[#7C3AED] hover:bg-[#F5F3FF]" title="Close"><X className="w-4 h-4" /></button>
        </div>

        {/* Actions */}
        <div className="flex flex-wrap items-center gap-2 px-4 py-2.5 border-b border-[#EDE9FE] flex-shrink-0">
          <button
            type="button" onClick={() => void capture()} disabled={running || endpoints.length === 0}
            className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[12px] font-semibold text-white bg-gradient-to-b from-[#7C3AED] to-[#6D28D9] border border-[#6D28D9]/50 ring-1 ring-inset ring-white/20 ${RAISED} hover:from-[#7C3AED] hover:to-[#5B21B6] disabled:opacity-50`}
          >
            {busy === 'capturing' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Camera className="w-3.5 h-3.5" />}
            Capture baseline
          </button>
          <button
            type="button" onClick={() => void compare()} disabled={running || covered === 0}
            className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[12px] font-semibold text-[#6D28D9] bg-white border border-[#DDD6FE] ${RAISED} hover:bg-[#F5F3FF] disabled:opacity-50`}
            title={covered === 0 ? 'Capture a baseline first' : 'Diff the current responses against the stored baseline'}
          >
            {busy === 'comparing' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <GitCompare className="w-3.5 h-3.5" />}
            Compare now
          </button>
          <span className="text-[11px] text-gray-400 ml-auto">Snapshots the live response; volatile fields ignored on diff</span>
        </div>

        {(notice || error) && (
          <div className={`mx-4 mt-3 flex items-start gap-2 px-3 py-2 rounded-lg border ${error ? 'bg-red-50 border-red-200' : 'bg-emerald-50 border-emerald-200'}`}>
            {error ? <AlertTriangle className="w-4 h-4 text-red-500 flex-shrink-0 mt-px" /> : <CheckCircle2 className="w-4 h-4 text-emerald-500 flex-shrink-0 mt-px" />}
            <p className={`text-[12px] min-w-0 ${error ? 'text-red-700' : 'text-emerald-700'}`}>{error || notice}</p>
          </div>
        )}

        {/* Compare summary */}
        {s && (
          <div className="flex flex-wrap items-center gap-2 px-4 py-2.5 border-b border-t border-[#EDE9FE] flex-shrink-0 mt-3">
            <SummaryPill icon={CheckCircle2} label="Unchanged" value={s.unchanged} tone="good" />
            <SummaryPill icon={AlertTriangle} label="Drifted" value={s.drifted} tone={s.drifted ? 'bad' : 'muted'} />
            {s.unreachable > 0 && <SummaryPill icon={AlertTriangle} label="Unreachable" value={s.unreachable} tone="warn" />}
            {s.noBaseline > 0 && <SummaryPill icon={ShieldQuestion} label="No baseline" value={s.noBaseline} tone="muted" />}
          </div>
        )}

        {/* Body */}
        <div className="flex-1 overflow-y-auto min-h-0">
          {busy === 'loading' ? (
            <div className="flex items-center justify-center gap-2 py-16 text-[12px] text-gray-500"><Loader2 className="w-4 h-4 animate-spin text-[#7C3AED]" />Loading baselines…</div>
          ) : running ? (
            <div className="flex items-center justify-center gap-2 py-16 text-[12px] text-gray-500"><Loader2 className="w-4 h-4 animate-spin text-[#7C3AED]" />{busy === 'capturing' ? 'Snapshotting' : 'Diffing'} {endpoints.length} endpoint{endpoints.length === 1 ? '' : 's'}…</div>
          ) : report ? (
            <div className="divide-y divide-gray-100">
              {report.results.map((r) => <CompareRow key={r.id} r={r} />)}
            </div>
          ) : (
            <StoredList baselines={baselines} />
          )}
        </div>
      </div>
    </div>
  );
}

function SummaryPill({ icon: Icon, label, value, tone }: { icon: React.ElementType; label: string; value: number; tone: 'good' | 'bad' | 'warn' | 'muted' }) {
  const cls = {
    good: 'text-emerald-700 bg-emerald-50 border-emerald-200',
    bad: 'text-red-700 bg-red-50 border-red-200',
    warn: 'text-amber-700 bg-amber-50 border-amber-200',
    muted: 'text-gray-500 bg-gray-50 border-gray-200',
  }[tone];
  return (
    <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md border text-[11.5px] font-semibold ${cls} ${RAISED}`}>
      <Icon className="w-3.5 h-3.5" />{value} {label}
    </span>
  );
}

function CompareRow({ r }: { r: BaselineCompareResult }) {
  const state = !r.hasBaseline ? 'none' : !r.reachable ? 'unreachable' : r.drift.length ? 'drift' : 'clean';
  const dot = state === 'clean' ? 'bg-emerald-500' : state === 'drift' ? 'bg-red-500' : state === 'unreachable' ? 'bg-amber-500' : 'bg-gray-300';
  return (
    <div className="px-4 py-2.5">
      <div className="flex items-center gap-2">
        <span className={`w-2 h-2 rounded-full flex-shrink-0 ${dot}`} />
        <MethodBadge method={r.method} />
        <span className="text-[12px] text-gray-800 min-w-0 flex-1 truncate" title={r.url}>{r.title}</span>
        {r.baselineStatus !== undefined && r.status !== undefined && r.status !== r.baselineStatus && (
          <span className="font-mono text-[10px] text-red-600 tabular-nums flex-shrink-0">{r.baselineStatus}→{r.status}</span>
        )}
        {state === 'none' && <span className="text-[9.5px] font-semibold px-1.5 py-0.5 rounded border text-gray-500 bg-gray-50 border-gray-200 flex-shrink-0">no baseline</span>}
        {state === 'clean' && <span className="text-[9.5px] font-semibold px-1.5 py-0.5 rounded border text-emerald-700 bg-emerald-50 border-emerald-200 flex-shrink-0">no drift</span>}
        {state === 'drift' && <span className="text-[9.5px] font-semibold px-1.5 py-0.5 rounded border text-red-700 bg-red-50 border-red-200 flex-shrink-0">{r.drift.length} change{r.drift.length === 1 ? '' : 's'}</span>}
      </div>
      {r.drift.length > 0 && (
        <ul className="mt-1 ml-4 space-y-0.5">
          {r.drift.slice(0, 10).map((d, i) => (
            <li key={i} className="flex gap-1.5 text-[11px] text-gray-600 items-baseline">
              <span className={`font-mono text-[9.5px] font-semibold uppercase px-1 rounded flex-shrink-0 ${DRIFT_TONE[d.kind]}`}>{d.kind}</span>
              <span className="min-w-0 font-mono">
                <span className="text-gray-800">{d.path}</span>
                {(d.before !== undefined || d.after !== undefined) && (
                  <span className="text-gray-400">
                    {' '}{d.before !== undefined && <span className="line-through">{d.before}</span>}
                    {d.before !== undefined && d.after !== undefined && ' → '}
                    {d.after !== undefined && <span className="text-gray-700">{d.after}</span>}
                  </span>
                )}
              </span>
            </li>
          ))}
          {r.drift.length > 10 && <li className="text-[10.5px] text-gray-400 ml-1">…and {r.drift.length - 10} more</li>}
        </ul>
      )}
    </div>
  );
}

function StoredList({ baselines }: { baselines: BaselineRecord[] }) {
  if (baselines.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-2 py-16 px-6 text-center">
        <Camera className="w-7 h-7 text-gray-300" />
        <p className="text-[12.5px] text-gray-500 max-w-sm">No baselines yet. <span className="text-gray-700 font-medium">Capture baseline</span> snapshots the current responses; later, <span className="text-gray-700 font-medium">Compare now</span> flags anything that has drifted from that snapshot.</p>
      </div>
    );
  }
  return (
    <div className="divide-y divide-gray-100">
      <div className="px-4 py-2 text-[10.5px] font-semibold uppercase tracking-wide text-gray-400 bg-gray-50/60">Stored snapshots</div>
      {baselines.map((b) => (
        <div key={b.id} className="px-4 py-2 flex items-center gap-2">
          <MethodBadge method={b.method} />
          <span className="text-[12px] text-gray-800 min-w-0 flex-1 truncate" title={b.url}>{b.title}</span>
          {b.status !== undefined && <span className="font-mono text-[10.5px] text-gray-500 tabular-nums flex-shrink-0">{b.status}</span>}
          <span className="text-[10.5px] text-gray-400 flex-shrink-0">{relativeTime(b.capturedAt)}</span>
        </div>
      ))}
    </div>
  );
}
