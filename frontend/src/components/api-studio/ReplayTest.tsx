/**
 * ReplayTest — deterministic record-and-replay.
 *
 * Opt-in and standalone, zero model cost. Two moves:
 *   • Record — sample each endpoint TWICE, learn which fields are non-deterministic
 *     ("noise": timestamps, ids, tokens), and store the response as the recording.
 *   • Replay — re-send and diff the fresh response against the recording, ignoring
 *     the learned noise, for a flake-free pass/fail. Cheap enough to run on every CI build.
 */
import { useEffect, useState } from 'react';
import { X, Circle, Play, AlertTriangle, CheckCircle2, ShieldQuestion } from 'lucide-react';
import Spinner from '@/components/feedback/Spinner';
import {
  listApiReplays, recordApiReplays, runApiReplays,
  type ReplayRecord, type ReplayReport, type ReplayResult, type DriftEntry,
} from '@/services/api';
import { MethodBadge } from './primitives';
import { CARD, STRIP, relativeTime } from './format';
import type { CatalogEndpoint } from './types';

function toPayload(e: CatalogEndpoint) {
  return { id: e.id, title: e.title, method: e.method, url: e.url, headers: e.headers, auth: e.auth, body: e.body };
}

const DRIFT_TONE: Record<DriftEntry['kind'], string> = {
  status: 'text-red-700 bg-red-50', removed: 'text-red-700 bg-red-50', added: 'text-emerald-700 bg-emerald-50',
  'type-changed': 'text-amber-700 bg-amber-50', 'value-changed': 'text-amber-700 bg-amber-50',
  transport: 'text-amber-700 bg-amber-50', content: 'text-amber-700 bg-amber-50',
};

export default function ReplayTest({ endpoints, onClose }: { endpoints: CatalogEndpoint[]; onClose: () => void }) {
  const [recordings, setRecordings] = useState<ReplayRecord[]>([]);
  const [report, setReport] = useState<ReplayReport | null>(null);
  const [busy, setBusy] = useState<'idle' | 'loading' | 'recording' | 'replaying'>('loading');
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');

  const refreshList = async () => { try { setRecordings((await listApiReplays()).recordings); } catch { /* non-fatal */ } };
  useEffect(() => { (async () => { await refreshList(); setBusy('idle'); })(); }, []);

  const record = async () => {
    setBusy('recording'); setError(''); setNotice(''); setReport(null);
    try {
      const r = await recordApiReplays(endpoints.map(toPayload));
      setNotice(`Recorded ${r.recorded} endpoint${r.recorded === 1 ? '' : 's'}${r.skipped ? ` · ${r.skipped} unreachable, skipped` : ''}. Noise fields learned automatically.`);
      await refreshList();
    } catch (err: any) { setError(err?.response?.data?.error || err?.message || 'Record failed.'); } finally { setBusy('idle'); }
  };

  const replay = async () => {
    setBusy('replaying'); setError(''); setNotice('');
    try { setReport(await runApiReplays(endpoints.map(toPayload))); }
    catch (err: any) { setError(err?.response?.data?.error || err?.message || 'Replay failed.'); } finally { setBusy('idle'); }
  };

  const running = busy === 'recording' || busy === 'replaying';
  const covered = recordings.length;
  const s = report?.summary;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-[#1E1B4B]/45 backdrop-blur-md p-4" onClick={onClose}>
      <div className={`${CARD} w-full max-w-3xl max-h-[85vh] flex flex-col overflow-hidden`} onClick={(e) => e.stopPropagation()}>
        <div className={`flex items-center gap-2 px-4 h-12 border-b border-[#EDE9FE] flex-shrink-0 ${STRIP}`}>
          <Play className="w-4 h-4 text-[#7C3AED]" />
          <h3 className="text-[13px] font-semibold text-gray-900">Record &amp; replay</h3>
          <span className="text-[11px] text-gray-400">{covered} recording{covered === 1 ? '' : 's'} · {endpoints.length} selected · zero model cost</span>
          <button type="button" onClick={onClose} className="ml-auto p-1.5 rounded-md text-gray-400 hover:text-[#7C3AED] hover:bg-[#F5F3FF]"><X className="w-4 h-4" /></button>
        </div>

        <div className="flex flex-wrap items-center gap-2 px-4 py-2.5 border-b border-[#EDE9FE] flex-shrink-0">
          <button type="button" onClick={() => void record()} disabled={running || endpoints.length === 0}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[12px] font-semibold text-white bg-gradient-to-b from-[#7C3AED] to-[#6D28D9] border border-[#6D28D9]/50 hover:from-[#7C3AED] hover:to-[#5B21B6] disabled:opacity-50">
            {busy === 'recording' ? <Spinner className="w-3.5 h-3.5 animate-spin" /> : <Circle className="w-3.5 h-3.5" />}Record
          </button>
          <button type="button" onClick={() => void replay()} disabled={running || covered === 0}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[12px] font-semibold text-[#6D28D9] bg-white border border-[#DDD6FE] hover:bg-[#F5F3FF] disabled:opacity-50"
            title={covered === 0 ? 'Record first' : 'Replay and diff against the recording'}>
            {busy === 'replaying' ? <Spinner className="w-3.5 h-3.5 animate-spin" /> : <Play className="w-3.5 h-3.5" />}Replay
          </button>
          <span className="text-[11px] text-gray-400 ml-auto">Double-samples at record time to auto-detect noise</span>
        </div>

        {(notice || error) && (
          <div className={`mx-4 mt-3 flex items-start gap-2 px-3 py-2 rounded-lg border ${error ? 'bg-red-50 border-red-200' : 'bg-emerald-50 border-emerald-200'}`}>
            {error ? <AlertTriangle className="w-4 h-4 text-red-500 flex-shrink-0 mt-px" /> : <CheckCircle2 className="w-4 h-4 text-emerald-500 flex-shrink-0 mt-px" />}
            <p className={`text-[12px] min-w-0 ${error ? 'text-red-700' : 'text-emerald-700'}`}>{error || notice}</p>
          </div>
        )}

        {s && (
          <div className="flex flex-wrap items-center gap-2 px-4 py-2.5 border-b border-t border-[#EDE9FE] flex-shrink-0 mt-3">
            <Pill icon={CheckCircle2} label="Matched" value={s.matched} tone={s.matched ? 'good' : 'muted'} />
            <Pill icon={AlertTriangle} label="Drifted" value={s.drifted} tone={s.drifted ? 'bad' : 'muted'} />
            {s.unreachable > 0 && <Pill icon={AlertTriangle} label="Unreachable" value={s.unreachable} tone="warn" />}
            {s.noRecording > 0 && <Pill icon={ShieldQuestion} label="No recording" value={s.noRecording} tone="muted" />}
          </div>
        )}

        <div className="flex-1 overflow-y-auto min-h-0">
          {busy === 'loading' ? (
            <div className="flex items-center justify-center gap-2 py-16 text-[12px] text-gray-500"><Spinner className="w-4 h-4 animate-spin text-[#7C3AED]" />Loading recordings…</div>
          ) : running ? (
            <div className="flex items-center justify-center gap-2 py-16 text-[12px] text-gray-500"><Spinner className="w-4 h-4 animate-spin text-[#7C3AED]" />{busy === 'recording' ? 'Recording' : 'Replaying'} {endpoints.length} endpoint{endpoints.length === 1 ? '' : 's'}…</div>
          ) : report ? (
            <div className="divide-y divide-gray-100">{report.results.map((r) => <ReplayRow key={r.id} r={r} />)}</div>
          ) : (
            <StoredList recordings={recordings} />
          )}
        </div>
      </div>
    </div>
  );
}

function Pill({ icon: Icon, label, value, tone }: { icon: React.ElementType; label: string; value: number; tone: 'good' | 'bad' | 'warn' | 'muted' }) {
  const cls = {
    good: 'text-emerald-700 bg-emerald-50 border-emerald-200', bad: 'text-red-700 bg-red-50 border-red-200',
    warn: 'text-amber-700 bg-amber-50 border-amber-200', muted: 'text-gray-500 bg-gray-50 border-gray-200',
  }[tone];
  return <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md border text-[11.5px] font-semibold ${cls}`}><Icon className="w-3.5 h-3.5" />{value} {label}</span>;
}

function ReplayRow({ r }: { r: ReplayResult }) {
  const state = !r.hasRecording ? 'none' : !r.reachable ? 'unreachable' : r.match ? 'clean' : 'drift';
  const dot = state === 'clean' ? 'bg-emerald-500' : state === 'drift' ? 'bg-red-500' : state === 'unreachable' ? 'bg-amber-500' : 'bg-gray-300';
  return (
    <div className="px-4 py-2.5">
      <div className="flex items-center gap-2">
        <span className={`w-2 h-2 rounded-full flex-shrink-0 ${dot}`} />
        <MethodBadge method={r.method} />
        <span className="text-[12px] text-gray-800 min-w-0 flex-1 truncate" title={r.url}>{r.title}</span>
        {r.recordedStatus !== undefined && r.status !== undefined && r.status !== r.recordedStatus && (
          <span className="font-mono text-[10px] text-red-600 tabular-nums flex-shrink-0">{r.recordedStatus}→{r.status}</span>
        )}
        {r.noiseIgnored > 0 && <span className="text-[9.5px] text-gray-400 flex-shrink-0">{r.noiseIgnored} noise ignored</span>}
        {state === 'none' && <span className="text-[9.5px] font-semibold px-1.5 py-0.5 rounded border text-gray-500 bg-gray-50 border-gray-200 flex-shrink-0">no recording</span>}
        {state === 'clean' && <span className="text-[9.5px] font-semibold px-1.5 py-0.5 rounded border text-emerald-700 bg-emerald-50 border-emerald-200 flex-shrink-0">match</span>}
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
                  <span className="text-gray-400"> {d.before !== undefined && <span className="line-through">{d.before}</span>}{d.before !== undefined && d.after !== undefined && ' → '}{d.after !== undefined && <span className="text-gray-700">{d.after}</span>}</span>
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

function StoredList({ recordings }: { recordings: ReplayRecord[] }) {
  if (recordings.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-2 py-16 px-6 text-center">
        <Circle className="w-7 h-7 text-gray-300" />
        <p className="text-[12.5px] text-gray-500 max-w-sm"><span className="text-gray-700 font-medium">Record</span> samples each endpoint twice to learn its noise and store the response. Later, <span className="text-gray-700 font-medium">Replay</span> flags anything that drifted — ignoring the noisy fields.</p>
      </div>
    );
  }
  return (
    <div className="divide-y divide-gray-100">
      <div className="px-4 py-2 text-[10.5px] font-semibold uppercase tracking-wide text-gray-400 bg-gray-50/60">Stored recordings</div>
      {recordings.map((r) => (
        <div key={r.id} className="px-4 py-2 flex items-center gap-2">
          <MethodBadge method={r.method} />
          <span className="text-[12px] text-gray-800 min-w-0 flex-1 truncate" title={r.url}>{r.title}</span>
          {r.noisePaths.length > 0 && <span className="text-[10px] text-gray-400 flex-shrink-0">{r.noisePaths.length} noise field{r.noisePaths.length === 1 ? '' : 's'}</span>}
          {r.status !== undefined && <span className="font-mono text-[10.5px] text-gray-500 tabular-nums flex-shrink-0">{r.status}</span>}
          <span className="text-[10.5px] text-gray-400 flex-shrink-0">{relativeTime(r.capturedAt)}</span>
        </div>
      ))}
    </div>
  );
}
