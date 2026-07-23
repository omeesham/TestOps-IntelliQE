/**
 * Agent Performance — a Task-Manager-style live monitor for the AI pipeline
 * agents. A left rail lists every agent (with a live sparkline of recent run
 * durations, like the CPU/Memory tiles in Windows Task Manager); the right
 * panel shows a large live 3D duration chart plus a detailed stat grid for the
 * selected agent — when it last ran, how long it took, averages, fastest /
 * slowest, success rate, and the work it produced.
 *
 * Data comes from /api/agent-performance/stats (snapshot) + an SSE stream that
 * pushes `agent_start` / `agent_run` events the moment an agent works, so the
 * monitor updates live as a pipeline runs.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity, Search, ShieldCheck, Map as MapIcon, Sparkles, Code2, PlayCircle,
  HeartPulse, Compass, RotateCcw, Clock, Zap, CheckCircle2, AlertCircle,
  Timer, Gauge, TrendingUp, Layers,
} from 'lucide-react';
import {
  getAgentPerformance, resetAgentPerformance, subscribeToAgentPerformance,
  type AgentStat, type AgentPerformance,
} from '@/services/api';
import { useToast } from '@/components/feedback/ToastProvider';

interface AgentDef { key: string; name: string; sub: string; Icon: React.ElementType; accent: string; }

// Display catalog — every agent shows, even before it has run (like Task
// Manager listing all cores). Order mirrors the pipeline sequence.
const AGENTS: AgentDef[] = [
  { key: 'explore',     name: 'App Explorer',           sub: 'Crawls the live application',   Icon: Compass,     accent: '#EC4899' },
  { key: 'requirement', name: 'Requirement Analysis',   sub: 'Parses requirements',           Icon: Search,      accent: '#7C3AED' },
  { key: 'audit',       name: 'Quality Audit',          sub: 'Reviews & enhances coverage',   Icon: ShieldCheck, accent: '#6366F1' },
  { key: 'planner',     name: 'Test Planner',           sub: 'Designs the test strategy',     Icon: MapIcon,     accent: '#3B82F6' },
  { key: 'generator',   name: 'Test Generator',         sub: 'Generates test cases',          Icon: Sparkles,    accent: '#06B6D4' },
  { key: 'script',      name: 'Script Generation',      sub: 'Builds Playwright specs',       Icon: Code2,       accent: '#0EA5E9' },
  { key: 'execution',   name: 'Execution & Validation', sub: 'Runs the suite',                Icon: PlayCircle,  accent: '#10B981' },
  { key: 'healing',     name: 'Auto-Healing',           sub: 'Diagnoses & fixes failures',    Icon: HeartPulse,  accent: '#F59E0B' },
];

const EMPTY_STAT = (agent: string): AgentStat => ({
  agent, runs: 0, successes: 0, errors: 0, lastStatus: null, lastDurationMs: null,
  avgDurationMs: null, minDurationMs: null, maxDurationMs: null, totalDurationMs: 0,
  lastRunAt: null, recent: [],
});

function fmtMs(ms: number | null | undefined): string {
  if (ms == null) return '—';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(s < 10 ? 2 : 1)}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${Math.round(s % 60)}s`;
}

function fmtAgo(iso: string | null): string {
  if (!iso) return 'never';
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 0) return 'just now';
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export default function AgentPerformancePage() {
  const toast = useToast();
  const [statsByAgent, setStatsByAgent] = useState<Record<string, AgentStat>>({});
  const [totals, setTotals] = useState<AgentPerformance['totals']>({ totalRuns: 0, totalDurationMs: 0, agentsUsed: 0, errors: 0 });
  const [selected, setSelected] = useState<string>('generator');
  const [live, setLive] = useState(false);
  const [running, setRunning] = useState<Record<string, number>>({}); // agent → startedAt ms
  const [now, setNow] = useState(() => 0);

  // Seed from the snapshot.
  const seed = (data: AgentPerformance) => {
    const map: Record<string, AgentStat> = {};
    for (const s of data.agents) map[s.agent] = s;
    setStatsByAgent(map);
    setTotals(data.totals);
  };

  useEffect(() => {
    getAgentPerformance().then(seed).catch(() => { /* first load may be empty */ });
  }, []);

  // Live stream.
  useEffect(() => {
    const unsub = subscribeToAgentPerformance((event) => {
      if (!event || event.type === 'connected') return;
      if (event.type === 'agent_start' && event.agent) {
        const startedMs = event.startedAt ? new Date(event.startedAt).getTime() : Date.now();
        setRunning((r) => ({ ...r, [event.agent]: startedMs }));
        setSelected(event.agent); // jump to the agent that just started working
      } else if (event.type === 'agent_run' && event.run) {
        setRunning((r) => { const n = { ...r }; delete n[event.run.agent]; return n; });
        // Cheap in-memory backend — refetch the authoritative aggregate.
        getAgentPerformance().then(seed).catch(() => {});
      } else if (event.type === 'agent_reset') {
        setStatsByAgent({});
        setTotals({ totalRuns: 0, totalDurationMs: 0, agentsUsed: 0, errors: 0 });
        setRunning({});
      }
    }, setLive);
    return unsub;
  }, []);

  // Tick a clock only while something is running (drives the live elapsed timer).
  const anyRunning = Object.keys(running).length > 0;
  useEffect(() => {
    if (!anyRunning) return;
    const t = setInterval(() => setNow(Date.now()), 200);
    return () => clearInterval(t);
  }, [anyRunning]);

  const handleReset = async () => {
    try {
      await resetAgentPerformance();
      setStatsByAgent({});
      setTotals({ totalRuns: 0, totalDurationMs: 0, agentsUsed: 0, errors: 0 });
      setRunning({});
      toast.success('Agent metrics cleared');
    } catch (err) { toast.fromError(err); }
  };

  const statFor = (key: string) => statsByAgent[key] || EMPTY_STAT(key);
  const selectedDef = AGENTS.find((a) => a.key === selected) || AGENTS[0];
  const selectedStat = statFor(selectedDef.key);
  const isRunning = (key: string) => running[key] !== undefined;

  return (
    <div className="max-w-6xl mx-auto">
      {/* Header */}
      <div className="flex items-center gap-3 mb-5">
        <div className="w-11 h-11 rounded-xl bg-gradient-to-br from-[#7C3AED] to-[#6366F1] flex items-center justify-center shadow-lg shadow-purple-500/25">
          <Activity className="w-6 h-6 text-white" />
        </div>
        <div>
          <div className="flex items-center gap-2.5">
            <h1 className="text-lg font-bold text-gray-900">Agent Performance</h1>
            <span className={`inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-semibold border ${
              live ? 'bg-emerald-50 text-emerald-700 border-emerald-200' : 'bg-gray-100 text-gray-500 border-gray-200'}`}>
              <span className={`w-2 h-2 rounded-full ${live ? 'bg-emerald-500 diag-live-dot' : 'bg-gray-400'}`} />
              {live ? 'Live' : 'Offline'}
            </span>
          </div>
          <p className="text-sm text-gray-500">Real-time performance of every AI pipeline agent.</p>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <HeaderStat label="Total runs" value={String(totals.totalRuns)} />
          <HeaderStat label="Total time" value={fmtMs(totals.totalDurationMs)} />
          <HeaderStat label="Agents used" value={`${totals.agentsUsed}/${AGENTS.length}`} />
          <button
            onClick={handleReset}
            className="inline-flex items-center gap-1.5 h-9 px-3 rounded-lg border border-gray-200 bg-white text-sm font-medium text-gray-600 hover:bg-gray-50"
            title="Clear captured metrics"
          >
            <RotateCcw className="w-4 h-4" /> Reset
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[280px_1fr] gap-4">
        {/* ── Left rail: agent list ── */}
        <div className="space-y-2">
          {AGENTS.map((a) => {
            const s = statFor(a.key);
            const active = selected === a.key;
            const runningNow = isRunning(a.key);
            return (
              <button
                key={a.key}
                onClick={() => setSelected(a.key)}
                className={`w-full text-left rounded-xl border bg-white p-3 transition-all ${
                  active ? 'border-[#7C3AED] ring-1 ring-[#7C3AED]/25 shadow-md' : 'border-gray-100 shadow-sm hover:border-gray-200'
                }`}
              >
                <div className="flex items-center gap-2.5">
                  <span
                    className="w-9 h-9 rounded-lg flex items-center justify-center shrink-0 shadow-[inset_0_1px_1px_rgba(255,255,255,0.5),0_4px_10px_-4px_rgba(0,0,0,0.35)]"
                    style={{ background: `linear-gradient(135deg, ${a.accent}, ${a.accent}cc)` }}
                  >
                    <a.Icon className="w-4.5 h-4.5 text-white" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-semibold text-gray-900 truncate">{a.name}</div>
                    <div className="text-[11px] text-gray-400 truncate">
                      {runningNow
                        ? <span className="text-[#7C3AED] font-medium">running… {fmtMs(Math.max(0, now - running[a.key]))}</span>
                        : s.runs > 0 ? `${s.runs} run${s.runs > 1 ? 's' : ''} · avg ${fmtMs(s.avgDurationMs)}` : 'idle'}
                    </div>
                  </div>
                </div>
                {/* Mini sparkline */}
                <div className="mt-2">
                  <Sparkline data={s.recent.map((r) => r.durationMs)} accent={a.accent} running={runningNow} />
                </div>
              </button>
            );
          })}
        </div>

        {/* ── Right: detail panel ── */}
        <div className="rounded-2xl border border-gray-100 bg-white shadow-sm p-5">
          {/* Detail header */}
          <div className="flex items-start gap-3 mb-4">
            <span
              className="w-12 h-12 rounded-xl flex items-center justify-center shrink-0 shadow-[inset_0_1px_1px_rgba(255,255,255,0.5),0_8px_18px_-6px_rgba(0,0,0,0.4)]"
              style={{ background: `linear-gradient(135deg, ${selectedDef.accent}, ${selectedDef.accent}bb)` }}
            >
              <selectedDef.Icon className="w-6 h-6 text-white" />
            </span>
            <div className="min-w-0">
              <h2 className="text-xl font-bold text-gray-900">{selectedDef.name}</h2>
              <p className="text-sm text-gray-500">{selectedDef.sub}</p>
            </div>
            <div className="ml-auto">
              {isRunning(selectedDef.key) ? (
                <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold bg-violet-100 text-[#7C3AED]">
                  <span className="w-2 h-2 rounded-full bg-[#7C3AED] diag-live-dot" />
                  Running · {fmtMs(Math.max(0, now - running[selectedDef.key]))}
                </span>
              ) : selectedStat.lastStatus === 'error' ? (
                <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold bg-red-100 text-red-700">
                  <AlertCircle className="w-3.5 h-3.5" /> Last run failed
                </span>
              ) : selectedStat.runs > 0 ? (
                <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold bg-emerald-100 text-emerald-700">
                  <CheckCircle2 className="w-3.5 h-3.5" /> Idle
                </span>
              ) : (
                <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold bg-gray-100 text-gray-500">
                  Not run yet
                </span>
              )}
            </div>
          </div>

          {/* Big live 3D chart */}
          <div className="rounded-xl border border-gray-100 bg-gradient-to-b from-slate-50 to-white p-3 mb-4">
            <div className="flex items-center justify-between mb-1.5 px-1">
              <span className="text-[11px] font-semibold uppercase tracking-wider text-gray-400">Run duration</span>
              <span className="text-[11px] text-gray-400">last {Math.min(selectedStat.recent.length, 40)} runs · newest →</span>
            </div>
            <AreaChart data={selectedStat.recent} accent={selectedDef.accent} />
          </div>

          {/* Stat grid */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <StatTile Icon={Clock}      label="Last run"    value={fmtMs(selectedStat.lastDurationMs)} sub={fmtAgo(selectedStat.lastRunAt)} accent={selectedDef.accent} />
            <StatTile Icon={Gauge}      label="Average"     value={fmtMs(selectedStat.avgDurationMs)} accent={selectedDef.accent} />
            <StatTile Icon={Zap}        label="Fastest"     value={fmtMs(selectedStat.minDurationMs)} accent="#10B981" />
            <StatTile Icon={Timer}      label="Slowest"     value={fmtMs(selectedStat.maxDurationMs)} accent="#F59E0B" />
            <StatTile Icon={TrendingUp} label="Total runs"  value={String(selectedStat.runs)} accent={selectedDef.accent} />
            <StatTile Icon={CheckCircle2} label="Success"   value={selectedStat.runs ? `${Math.round((selectedStat.successes / selectedStat.runs) * 100)}%` : '—'} sub={`${selectedStat.successes}/${selectedStat.runs || 0}`} accent="#10B981" />
            <StatTile Icon={AlertCircle} label="Errors"     value={String(selectedStat.errors)} accent={selectedStat.errors ? '#EF4444' : '#94A3B8'} />
            <StatTile Icon={Layers}     label="Total time"  value={fmtMs(selectedStat.totalDurationMs)} accent={selectedDef.accent} />
          </div>

          {/* Last output metadata */}
          {selectedStat.lastMeta && Object.keys(selectedStat.lastMeta).length > 0 && (
            <div className="mt-4">
              <div className="text-[11px] font-semibold uppercase tracking-wider text-gray-400 mb-1.5">Last output</div>
              <div className="flex flex-wrap gap-1.5">
                {Object.entries(selectedStat.lastMeta).map(([k, v]) => (
                  <span key={k} className="px-2 py-1 rounded-md bg-violet-50 text-[#7C3AED] text-xs font-medium border border-violet-100">
                    {k}: <span className="font-semibold">{String(v)}</span>
                  </span>
                ))}
              </div>
            </div>
          )}

          {selectedStat.lastError && (
            <div className="mt-4 flex items-start gap-2 p-3 rounded-lg bg-red-50 border border-red-100 text-sm text-red-700">
              <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
              <span className="break-words">{selectedStat.lastError}</span>
            </div>
          )}

          {selectedStat.runs === 0 && !isRunning(selectedDef.key) && (
            <p className="mt-4 text-center text-sm text-gray-400">
              This agent hasn't run yet. Start a test generation or run to see its live performance here.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

function HeaderStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="hidden md:block rounded-lg border border-gray-100 bg-white px-3 py-1.5 text-center shadow-sm">
      <div className="text-[10px] uppercase tracking-wide text-gray-400">{label}</div>
      <div className="text-sm font-bold text-gray-900 tabular-nums">{value}</div>
    </div>
  );
}

function StatTile({ Icon, label, value, sub, accent }: { Icon: React.ElementType; label: string; value: string; sub?: string; accent: string }) {
  return (
    <div className="rounded-xl border border-gray-100 bg-white p-3 shadow-[0_2px_8px_-4px_rgba(30,27,75,0.15)]">
      <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide text-gray-400">
        <Icon className="w-3.5 h-3.5" style={{ color: accent }} /> {label}
      </div>
      <div className="mt-1 text-lg font-bold text-gray-900 tabular-nums leading-tight">{value}</div>
      {sub && <div className="text-[11px] text-gray-400">{sub}</div>}
    </div>
  );
}

/** Compact sparkline for the left rail. */
function Sparkline({ data, accent, running }: { data: number[]; accent: string; running?: boolean }) {
  const W = 240, H = 30;
  if (data.length === 0) {
    return (
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-[30px]" preserveAspectRatio="none">
        <line x1="0" y1={H - 2} x2={W} y2={H - 2} stroke="#E5E7EB" strokeWidth="1" strokeDasharray="3 3" />
      </svg>
    );
  }
  const max = Math.max(...data, 1);
  const pts = data.map((d, i) => {
    const x = data.length === 1 ? W : (i / (data.length - 1)) * W;
    const y = H - 3 - (d / max) * (H - 6);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  const area = `0,${H} ${pts.join(' ')} ${W},${H}`;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-[30px]" preserveAspectRatio="none">
      <polygon points={area} fill={accent} opacity="0.12" />
      <polyline points={pts.join(' ')} fill="none" stroke={accent} strokeWidth={running ? 2 : 1.5} strokeLinejoin="round" strokeLinecap="round" opacity={running ? 1 : 0.8} />
    </svg>
  );
}

/**
 * Large live area chart of run durations with a subtle 3D tilt, gradient fill,
 * gridlines, and hover-free axis labels (Task-Manager style).
 */
function AreaChart({ data, accent }: { data: { durationMs: number; status: string; at: string }[]; accent: string }) {
  const W = 800, H = 220, PAD = 6;
  const gid = useRef(`ag-${Math.random().toString(36).slice(2, 8)}`).current;

  if (data.length === 0) {
    return (
      <div className="relative" style={{ perspective: 1000 }}>
        <div className="h-[220px] flex items-center justify-center text-sm text-gray-300"
          style={{ transform: 'rotateX(6deg)', transformOrigin: 'bottom' }}>
          No runs captured yet — the graph fills in as this agent works.
        </div>
      </div>
    );
  }

  const vals = data.map((d) => d.durationMs);
  const max = Math.max(...vals, 1);
  const niceMax = max <= 1000 ? Math.ceil(max / 200) * 200 : Math.ceil(max / 1000) * 1000;
  const x = (i: number) => (data.length === 1 ? W : PAD + (i / (data.length - 1)) * (W - PAD * 2));
  const y = (v: number) => H - PAD - (v / niceMax) * (H - PAD * 2);
  const line = data.map((d, i) => `${x(i).toFixed(1)},${y(d.durationMs).toFixed(1)}`).join(' ');
  const area = `${PAD},${H - PAD} ${line} ${(W - PAD).toFixed(1)},${H - PAD}`;
  const grid = [0.25, 0.5, 0.75, 1].map((f) => ({ f, yy: H - PAD - f * (H - PAD * 2), label: fmtMs(niceMax * f) }));

  return (
    <div className="relative" style={{ perspective: 1200 }}>
      <div style={{ transform: 'rotateX(7deg)', transformOrigin: 'bottom', filter: 'drop-shadow(0 14px 18px rgba(30,27,75,0.16))' }}>
        <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ height: 220 }} preserveAspectRatio="none">
          <defs>
            <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={accent} stopOpacity="0.45" />
              <stop offset="100%" stopColor={accent} stopOpacity="0.04" />
            </linearGradient>
          </defs>
          {/* gridlines + y labels */}
          {grid.map((g) => (
            <g key={g.f}>
              <line x1={PAD} y1={g.yy} x2={W - PAD} y2={g.yy} stroke="#EEF0F4" strokeWidth="1" />
              <text x={PAD + 2} y={g.yy - 3} fontSize="9" fill="#9CA3AF">{g.label}</text>
            </g>
          ))}
          {/* area + line */}
          <polygon points={area} fill={`url(#${gid})`} />
          <polyline points={line} fill="none" stroke={accent} strokeWidth="2.5" strokeLinejoin="round" strokeLinecap="round" />
          {/* points — red dot for failed runs */}
          {data.map((d, i) => (
            <circle key={i} cx={x(i)} cy={y(d.durationMs)} r={data.length > 30 ? 1.5 : 3}
              fill={d.status === 'error' ? '#EF4444' : '#fff'} stroke={d.status === 'error' ? '#EF4444' : accent} strokeWidth="1.5" />
          ))}
        </svg>
      </div>
    </div>
  );
}
