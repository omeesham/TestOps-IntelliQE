/**
 * ActivityPanel — the narration of a run.
 *
 * The log is the only place that explains *why* a run took the shape it did, so
 * it earns more than a flat list of lines:
 *
 *   · a live header that says how long the run has been going,
 *   · a summary of what is under test and how far the pipeline has got,
 *   · stage-by-stage grouping with the time each stage took, and
 *   · level filters, so a three-hundred-line log still answers "what broke?".
 *
 * Nothing here drives the pipeline — it only reads what `useApiRun` reports.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity, ChevronRight, AlertTriangle, CheckCircle2, XCircle, Copy, Check,
  ArrowDown, Upload, Server, Sparkles, Code2, PlayCircle, Wrench, BarChart3, Zap, Globe,
} from 'lucide-react';
import { clock, formatDuration, hostOf, CHIP_3D, STRIP, TILE } from './format';
import type { ApiRun } from './hooks/useApiRun';
import type { LogLevel, LogLine } from './types';

type LogStage = LogLine['stage'];

const STAGE_META: Record<LogStage, { label: string; icon: React.ElementType }> = {
  run: { label: 'Run', icon: Zap },
  import: { label: 'Import', icon: Upload },
  env: { label: 'Environment', icon: Server },
  scenarios: { label: 'Scenarios', icon: Sparkles },
  automate: { label: 'Automate', icon: Code2 },
  execute: { label: 'Execute', icon: PlayCircle },
  heal: { label: 'Heal', icon: Wrench },
  report: { label: 'Report', icon: BarChart3 },
};

/** Level → the dot, the text colour, and the tint a row earns when it matters. */
const LEVEL: Record<LogLevel, { dot: string; ring: string; text: string; row: string }> = {
  info: { dot: 'bg-[#C4B5FD]', ring: 'ring-[#EDE9FE]', text: 'text-gray-600', row: 'border-transparent' },
  ok: { dot: 'bg-emerald-500', ring: 'ring-emerald-100', text: 'text-emerald-800', row: 'border-transparent' },
  warn: { dot: 'bg-amber-500', ring: 'ring-amber-100', text: 'text-amber-900', row: 'bg-amber-50 border-amber-200/70' },
  error: { dot: 'bg-red-500', ring: 'ring-red-100', text: 'text-red-800', row: 'bg-red-50 border-red-200/70' },
};

const FILTERS: { key: 'all' | LogLevel; label: string; icon?: React.ElementType }[] = [
  { key: 'all', label: 'All' },
  { key: 'ok', label: 'Done', icon: CheckCircle2 },
  { key: 'warn', label: 'Warn', icon: AlertTriangle },
  { key: 'error', label: 'Error', icon: XCircle },
];

interface Group { stage: LogStage; lines: LogLine[]; at: number }

/** Consecutive lines from the same stage read as one block of work. */
function groupByStage(lines: LogLine[]): Group[] {
  const out: Group[] = [];
  for (const l of lines) {
    const last = out[out.length - 1];
    if (last && last.stage === l.stage) last.lines.push(l);
    else out.push({ stage: l.stage, lines: [l], at: l.at });
  }
  return out;
}

export default function ActivityPanel({ run, onClose }: { run: ApiRun; onClose: () => void }) {
  const [filter, setFilter] = useState<'all' | LogLevel>('all');
  const [stick, setStick] = useState(true);
  const [copied, setCopied] = useState(false);
  /* Only the setter is used: the tick exists to re-render the live clock. */
  const [, setTick] = useState(0);
  const bodyRef = useRef<HTMLDivElement | null>(null);

  const { logs, stages, running, started } = run;

  /* A one-second heartbeat, but only while something is actually happening. */
  useEffect(() => {
    if (!running) return;
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, [running]);

  const counts = useMemo(() => {
    const c: Record<LogLevel, number> = { info: 0, ok: 0, warn: 0, error: 0 };
    for (const l of logs) c[l.level]++;
    return c;
  }, [logs]);

  /* A filter the reader can no longer see (a new run wiped the warnings it
     selected) must not silently hide the log, so it lapses back to "all". */
  const canFilter = counts.ok + counts.warn + counts.error > 0;
  const active = canFilter ? filter : 'all';
  const shown = useMemo(() => (active === 'all' ? logs : logs.filter((l) => l.level === active)), [logs, active]);
  const groups = useMemo(() => groupByStage(shown), [shown]);

  /* While it runs, the clock ticks. Once it stops, the sum of the stage times
     is the honest total — `elapsedMs()` would keep counting for ever. */
  const stageTotal = useMemo(() => stages.reduce((a, s) => a + (s.durationMs || 0), 0), [stages]);
  const elapsed = running ? run.elapsedMs() : stageTotal;

  const done = stages.filter((s) => s.status === 'done' || s.status === 'skipped').length;
  const current = stages.find((s) => s.status === 'running') || (running ? stages.find((s) => s.status === 'pending') : null);
  const failedStage = stages.find((s) => s.status === 'failed');

  /* Follow the tail unless the reader has scrolled away to look at something. */
  useEffect(() => {
    const el = bodyRef.current;
    if (!el || !stick) return;
    el.scrollTop = el.scrollHeight;
  }, [shown.length, stick]);

  const onScroll = () => {
    const el = bodyRef.current;
    if (el) setStick(el.scrollHeight - el.scrollTop - el.clientHeight < 48);
  };

  const copyLog = () => {
    const text = logs.map((l) => `${clock(l.at)}  ${STAGE_META[l.stage].label.toUpperCase().padEnd(11)} ${l.level.toUpperCase().padEnd(5)} ${l.text}`).join('\n');
    navigator.clipboard?.writeText(text).then(
      () => { setCopied(true); setTimeout(() => setCopied(false), 1600); },
      () => { /* clipboard blocked — the log is on screen and selectable */ },
    );
  };

  return (
    <>
      {/* ── Header: what is happening, and for how long ── */}
      <div className={`flex items-center gap-1.5 px-3 h-9 flex-shrink-0 ${STRIP}`}>
        <span className="relative flex-shrink-0">
          <Activity className={`w-3.5 h-3.5 ${running ? 'text-[#7C3AED]' : 'text-gray-400'}`} />
          {running && <span className="absolute -top-0.5 -right-0.5 w-1.5 h-1.5 rounded-full bg-[#7C3AED] animate-ping" />}
        </span>
        <span className="text-[11px] font-semibold text-gray-600 uppercase tracking-wide">Activity</span>
        {started && (
          <span
            title={running ? 'Time since the run started' : 'Total time across all stages'}
            className={`font-mono text-[10px] tabular-nums px-1.5 py-0.5 rounded border ${running ? 'text-[#6D28D9] bg-[#F5F3FF] border-[#DDD6FE]' : 'text-gray-500 bg-gray-50 border-gray-200'}`}
          >
            {formatDuration(elapsed)}
          </span>
        )}
        <button type="button" onClick={copyLog} disabled={logs.length === 0} title="Copy the whole log" className="ml-auto p-1 rounded text-gray-300 hover:text-[#7C3AED] disabled:opacity-40 disabled:hover:text-gray-300 transition-colors">
          {copied ? <Check className="w-3.5 h-3.5 text-emerald-600" /> : <Copy className="w-3.5 h-3.5" />}
        </button>
        <button type="button" onClick={onClose} title="Hide the activity log" className="p-1 rounded text-gray-300 hover:text-[#7C3AED] transition-colors"><ChevronRight className="w-3.5 h-3.5" /></button>
      </div>

      {/* ── What is under test, and how far the pipeline has got ── */}
      {started && (
        <div className="flex-shrink-0 px-3 pt-2.5 pb-2 border-b border-[#EDE9FE] bg-white">
          <div className="flex items-center gap-1.5 min-w-0">
            <Globe className="w-3 h-3 text-gray-300 flex-shrink-0" />
            <span className="text-[11px] text-gray-700 truncate" title={run.runLabel}>{run.runLabel || 'Run'}</span>
          </div>
          {run.baseUrl && (
            <div className="mt-0.5 text-[10px] text-gray-400 min-w-0">
              <span className="font-mono truncate" title={run.baseUrl}>{hostOf(run.baseUrl)}</span>
            </div>
          )}

          <div className="mt-2 grid grid-cols-3 gap-1.5">
            <Stat label="Endpoints" value={run.runEndpoints.length} />
            <Stat label="Scenarios" value={run.scenarios.length} />
            {run.report
              ? <Stat label="Passed" value={`${run.report.passed}/${run.report.total}`} tone={run.report.failed > 0 ? 'warn' : 'ok'} />
              : <Stat label="Specs" value={run.specs.length} />}
          </div>

          {/* Five pips, one per stage — the shape of the pipeline at a glance. */}
          <div className="mt-2 flex items-center gap-1">
            {stages.map((s) => (
              <span
                key={s.key}
                title={`${s.label} — ${s.detail}`}
                className={`h-1.5 flex-1 rounded-full transition-colors ${
                  s.status === 'done' ? 'bg-gradient-to-r from-[#7C3AED] to-[#6366F1]'
                    : s.status === 'running' ? 'bg-[#A78BFA] animate-pulse'
                      : s.status === 'failed' ? 'bg-red-400'
                        : s.status === 'skipped' ? 'bg-gray-200'
                          : 'bg-[#EDE9FE]'}`}
              />
            ))}
            <span className="ml-1 font-mono text-[9.5px] text-gray-400 tabular-nums flex-shrink-0">{done}/{stages.length}</span>
          </div>
          {(current || failedStage) && (
            <p className={`mt-1 text-[10px] truncate ${failedStage ? 'text-red-600' : 'text-gray-500'}`} title={(failedStage || current)?.detail}>
              <span className="font-semibold">{(failedStage || current)?.label}</span>
              {' · '}{(failedStage || current)?.detail}
            </p>
          )}
        </div>
      )}

      {/* ── Level filters, shown only once there is something to filter ──
           A row of one "All" chip would be furniture, so it waits until at
           least one line has a level worth separating out. ── */}
      {canFilter && (
        <div className="flex-shrink-0 flex items-center gap-1 px-2.5 py-1.5 border-b border-[#EDE9FE]">
          {FILTERS.map((f) => {
            const n = f.key === 'all' ? logs.length : counts[f.key];
            if (n === 0 && f.key !== 'all') return null;
            const on = active === f.key;
            const Icon = f.icon;
            const tone = f.key === 'error' ? 'text-red-600' : f.key === 'warn' ? 'text-amber-600' : f.key === 'ok' ? 'text-emerald-600' : 'text-gray-500';
            return (
              <button
                key={f.key}
                type="button"
                onClick={() => setFilter(on ? 'all' : f.key)}
                title={`Show ${f.key === 'all' ? 'everything' : `${f.label.toLowerCase()} lines only`}`}
                className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md border text-[10px] font-medium transition-all ${CHIP_3D} ${
                  on ? 'bg-[#F5F3FF] border-[#DDD6FE] text-[#6D28D9]' : `bg-white border-gray-200 ${tone} hover:border-[#DDD6FE]`}`}
              >
                {Icon && <Icon className="w-2.5 h-2.5" />}
                {f.label}
                <span className="font-mono tabular-nums opacity-70">{n}</span>
              </button>
            );
          })}
        </div>
      )}

      {/* ── The log itself ── */}
      <div ref={bodyRef} onScroll={onScroll} className="relative flex-1 overflow-y-auto min-h-0 px-2 py-2">
        {logs.length === 0 ? (
          <div className="h-full flex flex-col items-center justify-center text-center px-4">
            <span className={`w-9 h-9 rounded-xl flex items-center justify-center mb-2 ${TILE}`}><Activity className="w-4 h-4 text-[#7C3AED]" /></span>
            <p className="text-[11.5px] font-semibold text-gray-600">Nothing yet</p>
            <p className="mt-1 text-[10.5px] text-gray-400 leading-relaxed">Every import and every run stage narrates itself here — what it read, what it decided, how long it took and anything it could not do.</p>
          </div>
        ) : shown.length === 0 ? (
          <p className="px-2 py-6 text-center text-[10.5px] text-gray-400">No {active} lines in this run.</p>
        ) : (
          groups.map((g, gi) => {
            const Icon = STAGE_META[g.stage].icon;
            const stage = stages.find((s) => s.key === g.stage);
            return (
              <div key={`${g.stage}-${g.lines[0]!.id}`} className="relative pl-[22px] pb-1.5">
                {/* The rail that ties one stage's lines together. */}
                {gi < groups.length - 1 && <span className="absolute left-[8px] top-4 bottom-0 w-px bg-gradient-to-b from-[#DDD6FE] via-[#EDE9FE] to-transparent" />}
                <div className="flex items-center gap-1.5 mb-1 -ml-[22px]">
                  <span className={`w-[17px] h-[17px] rounded-md flex items-center justify-center flex-shrink-0 ${TILE}`}>
                    <Icon className="w-2.5 h-2.5 text-[#7C3AED]" />
                  </span>
                  <span className="text-[9.5px] font-semibold uppercase tracking-wide text-[#6D28D9]">{STAGE_META[g.stage].label}</span>
                  {stage?.durationMs ? <span className="font-mono text-[9px] text-gray-400 tabular-nums">{formatDuration(stage.durationMs)}</span> : null}
                  <span className="ml-auto font-mono text-[9px] text-gray-300 tabular-nums flex-shrink-0">{clock(g.at)}</span>
                </div>
                <div className="space-y-px">
                  {g.lines.map((l, i) => {
                    const lv = LEVEL[l.level];
                    const prev = i > 0 ? g.lines[i - 1]! : null;
                    const gap = prev ? l.at - prev.at : 0;
                    return (
                      <div key={l.id} className={`flex gap-1.5 px-1.5 py-[3px] rounded-md border ${lv.row}`}>
                        <span className={`mt-[5px] w-1.5 h-1.5 rounded-full flex-shrink-0 ring-2 ${lv.dot} ${lv.ring}`} />
                        <span className={`flex-1 min-w-0 text-[11px] leading-[1.45] break-words ${lv.text}`}>{l.text}</span>
                        {gap >= 1000 && <span className="font-mono text-[9px] text-gray-300 tabular-nums flex-shrink-0 mt-px" title={`${formatDuration(gap)} after the line above`}>+{formatDuration(gap)}</span>}
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })
        )}
      </div>

      {/* The tail is only followed while the reader is at the tail. */}
      {!stick && logs.length > 0 && (
        <button
          type="button"
          onClick={() => { setStick(true); const el = bodyRef.current; if (el) el.scrollTop = el.scrollHeight; }}
          className="absolute bottom-3 left-1/2 -translate-x-1/2 inline-flex items-center gap-1 px-2 py-1 rounded-full bg-white border border-[#DDD6FE] text-[10px] font-medium text-[#6D28D9] shadow-[0_4px_12px_-4px_rgba(76,29,149,0.4)]"
        >
          <ArrowDown className="w-2.5 h-2.5" />Latest
        </button>
      )}
    </>
  );
}

/** One of the three little numbers under the target line. */
function Stat({ label, value, tone = 'plain' }: { label: string; value: number | string; tone?: 'plain' | 'ok' | 'warn' }) {
  const colour = tone === 'ok' ? 'text-emerald-700' : tone === 'warn' ? 'text-amber-700' : 'text-gray-800';
  return (
    <div className="px-1.5 py-1 rounded-lg bg-[#FCFBFF] border border-[#EDE9FE] shadow-[inset_0_1px_2px_rgba(30,27,75,0.06)]">
      <div className={`font-mono text-[12px] font-semibold tabular-nums leading-none ${colour}`}>{value}</div>
      <div className="mt-0.5 text-[9px] uppercase tracking-wide text-gray-400 truncate">{label}</div>
    </div>
  );
}
