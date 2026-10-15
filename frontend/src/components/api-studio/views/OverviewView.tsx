/**
 * OverviewView — the API Automation dashboard.
 *
 * KPIs across every API run this tenant has made, the pass-rate trend,
 * anomalies the platform spotted (flaky, new failures, slow), the slowest
 * scenarios, recent runs and recent imports — plus the workspace's current
 * state (catalogue size, selection) so the next step is obvious.
 */
import { useEffect, useState } from 'react';
import { Area, AreaChart, Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { Activity, AlertTriangle, ArrowRight, Clock, RefreshCw, Layers, Upload, Gauge, Zap, TrendingUp, ChevronRight, Timer, ShieldCheck, Sparkles, BrainCircuit, ShieldAlert, HeartPulse, Radar } from 'lucide-react';
import { getApiOverview } from '@/services/api';
import { CARD, CARD_HOVER, THEAD, BRAND_CHIP, MUTED_CHIP, relativeTime, formatDuration, IMPORT_METHOD_LABELS, methodColor } from '../format';
import { StatusPill, PassRing } from '../primitives';
import type { ApiOverview, NavView } from '../types';
import type { Catalog } from '../hooks/useCatalog';

import Loader from '@/components/feedback/Loader';
interface Props { catalog: Catalog; onNavigate: (v: NavView, toolsSearch?: string) => void; onOpenRun: (runId: string) => void; refreshKey: number }

/**
 * The capability strip in the hero — the platform's headline features as vivid,
 * on-brand chips. Each keeps its own hue so the banner reads as colourful while
 * the violet gradient holds it together. Decorative: these colours label the
 * capability, they are not outcome colours.
 */
const HERO_FEATURES: { icon: React.ElementType; label: string; color: string; seed: string }[] = [
  { icon: BrainCircuit, label: 'AI test generation', color: '#C4B5FD', seed: 'generation' },
  { icon: ShieldAlert, label: 'Security & OWASP', color: '#FB7185', seed: 'security' },
  { icon: Gauge, label: 'Load & performance', color: '#FBBF24', seed: 'load' },
  { icon: ShieldCheck, label: 'Contracts & drift', color: '#34D399', seed: 'contract' },
  { icon: HeartPulse, label: 'Self-healing', color: '#F472B6', seed: 'heal' },
  { icon: Radar, label: 'Coverage intelligence', color: '#38BDF8', seed: 'coverage' },
];

export default function OverviewView({ catalog, onNavigate, onOpenRun, refreshKey }: Props) {
  const [data, setData] = useState<ApiOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  /** `fresh` bypasses the server's 20s roll-up cache — the Refresh button and
      the reload after a run both want the new numbers, not the cached ones. */
  const load = async (fresh = false) => {
    setLoading(true); setError('');
    try { setData(await getApiOverview(fresh)); }
    catch (err: any) { setError(err?.response?.data?.error || err?.message || 'Could not load the dashboard.'); }
    finally { setLoading(false); }
  };
  useEffect(() => { void load(refreshKey > 0); }, [refreshKey]);

  const k = data?.kpis;
  const trend = (data?.trend || []).map((t) => ({ ...t, label: new Date(t.at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) }));
  const cats = Object.entries(data?.categories || {}).sort((a, b) => b[1] - a[1]).map(([name, value]) => ({ name, value }));
  const methods = Object.entries(data?.methods || {}).sort((a, b) => b[1] - a[1]);

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-[1280px] mx-auto px-6 py-5 space-y-4">
        {/* ── Hero banner — the first-look showcase ── */}
        <div className="relative overflow-hidden rounded-2xl bg-gradient-to-br from-[#5B21B6] via-[#7C3AED] to-[#4338CA] px-6 py-6 sm:px-8 sm:py-7 shadow-[0_24px_60px_-24px_rgba(76,29,149,0.8)]">
          {/* vivid light pools + a faint dotted grid give the panel colourful depth */}
          <div className="pointer-events-none absolute -top-24 -right-10 w-80 h-80 rounded-full bg-[#E879F9]/30 blur-3xl" />
          <div className="pointer-events-none absolute top-10 right-40 w-64 h-64 rounded-full bg-[#818CF8]/30 blur-3xl" />
          <div className="pointer-events-none absolute -bottom-28 -left-16 w-80 h-80 rounded-full bg-[#22D3EE]/25 blur-3xl" />
          <div className="pointer-events-none absolute inset-0 opacity-[0.06]" style={{ backgroundImage: 'radial-gradient(circle at 1px 1px, white 1px, transparent 0)', backgroundSize: '22px 22px' }} />
          <div className="relative flex items-center gap-6 flex-wrap">
            <div className="min-w-0 flex-1">
              <span className="inline-flex items-center gap-1.5 whitespace-nowrap px-2.5 py-1 rounded-full bg-white/15 border border-white/25 text-[10.5px] font-semibold uppercase tracking-wide text-white backdrop-blur-sm">
                <Sparkles className="w-3 h-3 flex-shrink-0" /> AI-powered API quality
              </span>
              <h1 className="mt-3 text-[26px] sm:text-[31px] font-extrabold text-white leading-[1.08] tracking-tight">
                {catalog.endpoints.length > 0 ? 'Your API test workspace' : 'Ship APIs the world can trust'}
              </h1>
              <p className="mt-2 text-[13px] text-white/80 max-w-xl leading-relaxed">
                {catalog.endpoints.length > 0
                  ? `${catalog.endpoints.length} endpoint${catalog.endpoints.length === 1 ? '' : 's'} in the catalogue · ${catalog.selected.size} selected. Generate, run and self-heal your suite end to end.`
                  : 'Autonomous agents generate, execute and self-heal API tests — from OpenAPI, Postman, cURL, GraphQL, MCP and more.'}
              </p>
              <div className="mt-4 flex items-center gap-2.5 flex-wrap">
                <button type="button" onClick={() => onNavigate('import')} className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl bg-white text-[#6D28D9] text-[13px] font-semibold shadow-lg shadow-black/15 hover:shadow-xl hover:-translate-y-0.5 transition-all">
                  <Upload className="w-4 h-4" /> Import an API
                </button>
                {catalog.endpoints.length > 0 && (
                  <button type="button" onClick={() => onNavigate('endpoints')} className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl bg-white/10 border border-white/30 text-white text-[13px] font-semibold hover:bg-white/20 transition-all backdrop-blur-sm">
                    Review & design <ArrowRight className="w-4 h-4" />
                  </button>
                )}
              </div>
            </div>
            {/* Headline stats — a confident, glanceable product read (mirrored in
                the KPI grid below, so it hides when the banner gets tight) */}
            <div className="relative hidden lg:flex items-center gap-4 sm:gap-5 flex-shrink-0 rounded-2xl bg-white/10 border border-white/15 px-5 py-3.5 backdrop-blur-sm">
              <HeroStat value={k?.avgPassRate != null ? `${k.avgPassRate}%` : '—'} label="Pass rate" loading={loading} />
              <div className="w-px h-10 bg-white/20" />
              <HeroStat value={k ? k.runs : '—'} label="Runs" loading={loading} />
              <div className="w-px h-10 bg-white/20" />
              <HeroStat value={k ? k.scenarios : '—'} label="Scenarios" loading={loading} />
            </div>
          </div>

          {/* Capability strip — the headline features, each in its own vivid hue */}
          <div className="relative mt-4 pt-3.5 border-t border-white/10 flex flex-wrap items-center gap-2">
            {HERO_FEATURES.map((f) => (
              <button
                key={f.label}
                type="button"
                onClick={() => onNavigate('tools', f.seed)}
                title={`Open ${f.label} tools`}
                className="group inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-white/10 border border-white/15 backdrop-blur-sm hover:bg-white/20 hover:border-white/30 hover:-translate-y-0.5 transition-all active:translate-y-0 focus:outline-none focus:ring-2 focus:ring-white/40"
              >
                <span className="w-4 h-4 rounded-md flex items-center justify-center flex-shrink-0" style={{ backgroundColor: `${f.color}26` }}>
                  <f.icon className="w-3 h-3" style={{ color: f.color }} />
                </span>
                <span className="text-[11px] font-medium text-white/90 whitespace-nowrap">{f.label}</span>
              </button>
            ))}
            <button type="button" onClick={() => onNavigate('tools')} className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full bg-white/15 border border-white/25 text-[11px] font-semibold text-white hover:bg-white/25 transition-colors">
              +80 more tools <ArrowRight className="w-3 h-3" />
            </button>
          </div>
        </div>

        {error && <div className="flex items-center gap-2 px-4 py-2.5 bg-red-50 border border-red-200 rounded-lg text-[12px] text-red-700"><AlertTriangle className="w-4 h-4" />{error}<button type="button" onClick={() => load(true)} className="ml-auto underline">Retry</button></div>}

        {/* KPIs */}
        <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-5 gap-3">
          <Kpi icon={Activity} label="API runs" value={k ? k.runs : '—'} sub={k ? 'Last 30 days' : ''} loading={loading} />
          <Kpi icon={Gauge} label="Pass rate" value={k?.avgPassRate != null ? `${k.avgPassRate}%` : '—'} sub={k?.lastPassRate != null ? 'Latest run' : 'No runs yet'} loading={loading} tone={k?.avgPassRate != null ? (k.avgPassRate >= 90 ? 'good' : k.avgPassRate >= 70 ? 'warn' : 'bad') : 'neutral'} ring={k?.avgPassRate != null ? k.avgPassRate : undefined} />
          <Kpi icon={Layers} label="Scenarios" value={k ? k.scenarios : '—'} sub={k ? `${k.endpointsCovered} endpoints covered` : ''} loading={loading} />
          <Kpi icon={Zap} label="Anomalies" value={data ? data.anomalies.length : '—'} sub={data ? (data.anomalies.length ? `${data.anomalies.filter((a) => a.kind === 'flaky').length} flaky · ${data.anomalies.filter((a) => a.kind === 'new-failure').length} new` : 'All healthy') : ''} loading={loading} tone={data?.anomalies.length ? 'warn' : 'neutral'} />
          <Kpi icon={Upload} label="Imports" value={k ? k.imports : '—'} sub={k?.lastRunAt ? relativeTime(k.lastRunAt) : data ? `${Object.keys(data.imports.byMethod).length} methods` : ''} loading={loading} />
        </div>

        {/* Trend + categories */}
        <div className="grid grid-cols-1 xl:grid-cols-3 gap-3">
          <div className={`${CARD} p-4 xl:col-span-2`}>
            <div className="flex items-center gap-2 mb-2"><TrendingUp className="w-4 h-4 text-[#7C3AED]" /><h3 className="text-[12.5px] font-semibold text-gray-900">Pass-rate trend</h3><span className="text-[11px] text-gray-400">last {trend.length} executed runs</span><button type="button" onClick={() => load(true)} className="ml-auto p-1 text-gray-300 hover:text-[#7C3AED]" title="Refresh"><RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} /></button></div>
            {trend.length === 0 ? (
              <p className="text-[11.5px] text-gray-400 py-10 text-center">No executed runs yet — the trend appears after the first suite runs.</p>
            ) : (
              <div className="h-[200px]">
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={trend} margin={{ top: 8, right: 8, left: -18, bottom: 0 }}>
                    <defs><linearGradient id="apiTrend" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#7C3AED" stopOpacity={0.35} /><stop offset="100%" stopColor="#7C3AED" stopOpacity={0.02} /></linearGradient></defs>
                    <CartesianGrid stroke="#EEEAFB" vertical={false} />
                    <XAxis dataKey="label" tick={{ fontSize: 10, fill: '#9CA3AF' }} axisLine={false} tickLine={false} />
                    <YAxis domain={[0, 100]} tick={{ fontSize: 10, fill: '#9CA3AF' }} axisLine={false} tickLine={false} />
                    <Tooltip contentStyle={{ fontSize: 11, borderRadius: 8, borderColor: '#DDD6FE' }} formatter={(v: any, _n: any, p: any) => [`${v}% · ${p.payload.passed}/${p.payload.total} passed`, 'Pass rate']} labelFormatter={(_l: any, p: any) => p?.[0]?.payload?.title || ''} />
                    <Area type="monotone" dataKey="passRate" stroke="#7C3AED" strokeWidth={2} fill="url(#apiTrend)" dot={{ r: 3, fill: '#7C3AED', strokeWidth: 0 }} activeDot={{ r: 4 }} />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            )}
          </div>
          <div className={`${CARD} p-4`}>
            <h3 className="text-[12.5px] font-semibold text-gray-900 mb-2">Coverage by layer</h3>
            {cats.length === 0 ? <p className="text-[11.5px] text-gray-400 py-10 text-center">Appears once scenarios have been designed.</p> : (
              <div className="h-[200px]">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={cats} layout="vertical" margin={{ top: 0, right: 12, left: 8, bottom: 0 }}>
                    <XAxis type="number" hide />
                    <YAxis type="category" dataKey="name" width={70} tick={{ fontSize: 10.5, fill: '#4B5563' }} axisLine={false} tickLine={false} />
                    <Tooltip contentStyle={{ fontSize: 11, borderRadius: 8, borderColor: '#DDD6FE' }} cursor={{ fill: '#F5F3FF' }} />
                    <Bar dataKey="value" fill="#8B5CF6" radius={[0, 4, 4, 0]} barSize={12} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            )}
            {methods.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-1">
                {methods.map(([m, n]) => <span key={m} className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded border font-mono text-[10px] ${methodColor(m)}`}>{m}<span className="opacity-60">{n}</span></span>)}
              </div>
            )}
          </div>
        </div>

        {/* Anomalies + slowest + recent runs */}
        <div className="grid grid-cols-1 xl:grid-cols-3 gap-3">
          {/* ── Anomalies ── */}
          <div className={`${CARD} p-4 flex flex-col`}>
            <CardHead icon={Zap} iconCls="text-amber-500 bg-amber-50" title="Anomalies" hint="last 8 runs" count={data?.anomalies.length} countCls={data?.anomalies.length ? 'text-amber-700 bg-amber-50 border-amber-200' : undefined} />
            {!data || data.anomalies.length === 0 ? (
              <div className="flex-1 flex flex-col items-center justify-center text-center py-8 gap-2.5">
                <span className="w-12 h-12 rounded-full bg-emerald-50 border border-emerald-100 flex items-center justify-center"><ShieldCheck className="w-6 h-6 text-emerald-500" /></span>
                <p className="text-[12.5px] font-semibold text-gray-700">All clear</p>
                <p className="text-[11px] text-gray-400 max-w-[200px] leading-relaxed">No flaky scenarios, new failures or slow outliers across the last 8 runs.</p>
              </div>
            ) : (
              <ul className="space-y-1.5">
                {data.anomalies.slice(0, 8).map((a, i) => {
                  const cfg = a.kind === 'new-failure'
                    ? { Icon: AlertTriangle, bar: 'bg-red-400', chip: 'text-red-700 bg-red-50 border-red-200', label: 'NEW FAIL' }
                    : a.kind === 'flaky'
                      ? { Icon: Zap, bar: 'bg-amber-400', chip: 'text-amber-700 bg-amber-50 border-amber-200', label: 'FLAKY' }
                      : { Icon: Clock, bar: 'bg-violet-400', chip: 'text-[#6D28D9] bg-[#F5F3FF] border-[#DDD6FE]', label: 'SLOW' };
                  return (
                    <li key={i} className="flex items-stretch gap-2 rounded-lg border border-gray-100 bg-gray-50/40 p-2 hover:bg-gray-50 transition-colors">
                      <span className={`w-1 rounded-full flex-shrink-0 ${cfg.bar}`} />
                      <cfg.Icon className={`w-3.5 h-3.5 mt-px flex-shrink-0 ${a.kind === 'new-failure' ? 'text-red-500' : a.kind === 'flaky' ? 'text-amber-500' : 'text-violet-500'}`} />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1.5">
                          <span className={`inline-flex px-1.5 py-0.5 rounded border text-[9px] font-bold tracking-wide flex-shrink-0 ${cfg.chip}`}>{cfg.label}</span>
                          <p className="text-[11.5px] font-medium text-gray-800 truncate" title={a.name}>{a.name}</p>
                        </div>
                        <p className="text-[10.5px] text-gray-500 mt-0.5 leading-snug">{a.detail}{a.runs ? <span className="text-gray-400"> · {a.runs} run{a.runs === 1 ? '' : 's'}</span> : null}</p>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>

          {/* ── Slowest scenarios ── */}
          <div className={`${CARD} p-4 flex flex-col`}>
            <CardHead icon={Timer} iconCls="text-[#7C3AED] bg-[#F5F3FF]" title="Slowest scenarios" count={data?.slowest.length} />
            {!data || data.slowest.length === 0 ? (
              <EmptyCard icon={Clock} title="No timings yet" hint="Durations appear after the first executed run." />
            ) : (() => {
              const maxMs = Math.max(...data.slowest.map((s) => s.durationMs), 1);
              return (
                <ul className="space-y-1.5">
                  {data.slowest.slice(0, 8).map((s, i) => {
                    const m = /^\s*(TC[-\s]?\d+)\s*[—:-]\s*(.*)$/i.exec(s.name);
                    const id = m?.[1]?.replace(/\s/, '-'); const label = m?.[2] || s.name;
                    const pct = Math.max(6, Math.round((s.durationMs / maxMs) * 100));
                    const tone = s.durationMs >= 1000 ? 'text-red-600' : s.durationMs >= 500 ? 'text-amber-600' : 'text-gray-600';
                    const barTone = s.durationMs >= 1000 ? 'bg-red-400' : s.durationMs >= 500 ? 'bg-amber-400' : 'bg-violet-400';
                    return (
                      <li key={i} className="group">
                        <div className="flex items-center gap-2 text-[11.5px]">
                          <span className="w-4 text-[10px] font-semibold text-gray-300 tabular-nums flex-shrink-0 text-right">{i + 1}</span>
                          {id && <span className="font-mono text-[9.5px] px-1 py-0.5 rounded bg-[#F5F3FF] text-[#6D28D9] border border-[#EDE9FE] flex-shrink-0">{id}</span>}
                          <span className="text-gray-700 truncate flex-1 min-w-0" title={s.name}>{label}</span>
                          <span className={`font-mono text-[10.5px] font-semibold tabular-nums flex-shrink-0 ${tone}`}>{formatDuration(s.durationMs)}</span>
                        </div>
                        <div className="ml-6 mt-1 h-1 rounded-full bg-gray-100 overflow-hidden"><div className={`h-full rounded-full ${barTone}`} style={{ width: `${pct}%` }} /></div>
                      </li>
                    );
                  })}
                </ul>
              );
            })()}
          </div>

          {/* ── Recent runs ── */}
          <div className={`${CARD} p-4 flex flex-col`}>
            <CardHead icon={Activity} iconCls="text-[#7C3AED] bg-[#F5F3FF]" title="Recent runs" count={data?.recentRuns.length}
              action={<button type="button" onClick={() => onNavigate('runs')} className="inline-flex items-center gap-0.5 text-[11px] font-medium text-[#7C3AED] hover:text-[#5B21B6]">All runs<ArrowRight className="w-3 h-3" /></button>} />
            {!data || data.recentRuns.length === 0 ? (
              <EmptyCard icon={Activity} title="No runs yet" hint="Design scenarios and run a suite to see history here." />
            ) : (
              <ul className="space-y-0.5">
                {data.recentRuns.slice(0, 6).map((r) => {
                  const pr = r.stats?.passRate;
                  const tone = pr == null ? 'text-gray-400' : pr >= 90 ? 'text-emerald-600' : pr >= 70 ? 'text-amber-600' : 'text-red-600';
                  const dot = pr == null ? 'bg-gray-300' : pr >= 90 ? 'bg-emerald-500' : pr >= 70 ? 'bg-amber-500' : 'bg-red-500';
                  return (
                    <li key={r.runId}>
                      <button type="button" onClick={() => onOpenRun(r.runId)} className="group w-full flex items-center gap-2.5 text-left px-2 py-1.5 rounded-lg hover:bg-[#F5F3FF] transition-colors">
                        <span className={`w-2 h-2 rounded-full flex-shrink-0 ${dot}`} />
                        <div className="min-w-0 flex-1">
                          <p className="text-[11.5px] font-medium text-gray-800 truncate">{r.title}</p>
                          <p className="text-[10.5px] text-gray-400 flex items-center gap-1.5 mt-0.5">
                            <span>{relativeTime(r.createdAt)}</span><span className="text-gray-300">·</span>
                            <span className="inline-flex items-center gap-0.5"><Layers className="w-3 h-3" />{r.caseCount}</span>
                          </p>
                        </div>
                        {r.stats ? (
                          <div className="flex flex-col items-end flex-shrink-0">
                            <span className={`font-mono text-[12px] font-bold tabular-nums leading-none ${tone}`}>{r.stats.passRate}%</span>
                            <span className="text-[9.5px] text-gray-400 tabular-nums mt-0.5">{r.stats.passed}/{r.stats.total}</span>
                          </div>
                        ) : <StatusPill status="not_run" />}
                        <ChevronRight className="w-3.5 h-3.5 text-gray-300 group-hover:text-[#7C3AED] flex-shrink-0 transition-colors" />
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </div>

        {/* Imports */}
        {data && data.imports.recent.length > 0 && (
          <div className={`${CARD} overflow-hidden`}>
            <div className="flex items-center gap-2 px-4 pt-4 pb-3">
              <span className="w-7 h-7 rounded-lg bg-[#F5F3FF] flex items-center justify-center flex-shrink-0"><Upload className="w-4 h-4 text-[#7C3AED]" /></span>
              <h3 className="text-[13px] font-semibold text-gray-900">Recent imports</h3>
              <span className="text-[11px] text-gray-400">{data.imports.total} total</span>
              <div className="ml-auto flex flex-wrap gap-1">{Object.entries(data.imports.byMethod).map(([m, n]) => <span key={m} className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full border text-[10px] font-medium ${BRAND_CHIP}`}>{IMPORT_METHOD_LABELS[m] || m}<span className="font-mono text-[#8B5CF6]">{n}</span></span>)}</div>
            </div>
            <table className="w-full text-[11.5px]">
              <thead className={`text-[10px] uppercase tracking-wide text-gray-500 ${THEAD}`}><tr><th className="text-left py-2 px-4 font-semibold">Source</th><th className="text-left py-2 font-semibold">Method</th><th className="text-left py-2 font-semibold">Format</th><th className="text-right py-2 font-semibold">Endpoints</th><th className="text-right py-2 px-4 font-semibold">When</th></tr></thead>
              <tbody>
                {data.imports.recent.slice(0, 8).map((im, i) => {
                  const ml = IMPORT_METHOD_LABELS[im.method] || im.method;
                  return (
                    <tr key={im.id} className={`border-t border-gray-100 hover:bg-[#FBFAFF] transition-colors ${i % 2 ? 'bg-gray-50/30' : ''}`}>
                      <td className="py-2 px-4 max-w-[340px]">
                        <div className="flex items-center gap-2">
                          <span className="w-6 h-6 rounded-md bg-[#F5F3FF] border border-[#EDE9FE] flex items-center justify-center text-[10px] font-bold text-[#7C3AED] flex-shrink-0 uppercase">{ml.charAt(0)}</span>
                          <span className="text-gray-800 font-medium truncate" title={im.name}>{im.name}</span>
                        </div>
                      </td>
                      <td className="py-2 text-gray-600">{ml}</td>
                      <td className="py-2"><span className={`inline-flex px-1.5 py-0.5 rounded border font-mono text-[10px] ${MUTED_CHIP}`}>{im.format}</span></td>
                      <td className="py-2 text-right"><span className="inline-flex items-center justify-center min-w-[24px] px-1.5 py-0.5 rounded-full bg-[#F5F3FF] text-[#6D28D9] font-mono text-[10.5px] font-semibold tabular-nums">{im.endpointCount}</span></td>
                      <td className="py-2 px-4 text-right text-gray-400 whitespace-nowrap">{relativeTime(im.createdAt)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

/** A consistent card header: a tinted icon square, title, optional hint, a count pill and an optional action. */
function CardHead({ icon: Icon, iconCls, title, hint, count, countCls, action }: { icon: React.ElementType; iconCls: string; title: string; hint?: string; count?: number; countCls?: string; action?: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2 mb-3">
      <span className={`w-7 h-7 rounded-lg flex items-center justify-center flex-shrink-0 ${iconCls}`}><Icon className="w-4 h-4" /></span>
      <h3 className="text-[13px] font-semibold text-gray-900">{title}</h3>
      {count != null && count > 0 && <span className={`inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full border text-[10px] font-semibold tabular-nums ${countCls || 'text-gray-500 bg-gray-50 border-gray-200'}`}>{count}</span>}
      {hint && <span className="text-[11px] text-gray-400">{hint}</span>}
      {action && <span className="ml-auto">{action}</span>}
    </div>
  );
}

/** A friendly empty state inside a card. */
function EmptyCard({ icon: Icon, title, hint }: { icon: React.ElementType; title: string; hint: string }) {
  return (
    <div className="flex-1 flex flex-col items-center justify-center text-center py-8 gap-2.5">
      <span className="w-12 h-12 rounded-full bg-gray-50 border border-gray-100 flex items-center justify-center"><Icon className="w-6 h-6 text-gray-300" /></span>
      <p className="text-[12.5px] font-semibold text-gray-600">{title}</p>
      <p className="text-[11px] text-gray-400 max-w-[200px] leading-relaxed">{hint}</p>
    </div>
  );
}

/** A single headline figure inside the hero banner's glass stat cluster. */
function HeroStat({ value, label, loading }: { value: string | number; label: string; loading: boolean }) {
  return (
    <div className="text-center">
      <div className="text-[22px] sm:text-[24px] font-extrabold text-white tabular-nums leading-none tracking-tight">
        {loading && value === '—' ? <span className="inline-block w-8 h-5 rounded bg-white/20 animate-pulse align-middle" /> : value}
      </div>
      <div className="mt-1 text-[10px] font-semibold uppercase tracking-wide text-white/60">{label}</div>
    </div>
  );
}

function Kpi({ icon: Icon, label, value, sub, loading, tone = 'neutral', ring }: { icon: React.ElementType; label: string; value: string | number; sub?: string; loading: boolean; tone?: 'neutral' | 'good' | 'warn' | 'bad'; ring?: number }) {
  const valueCls = tone === 'good' ? 'text-emerald-600' : tone === 'warn' ? 'text-amber-600' : tone === 'bad' ? 'text-red-600' : 'text-gray-900';
  // A hairline accent along the top edge, tinted by the KPI's health, gives the
  // row a premium "instrument panel" read while colour still means outcome.
  const accent = tone === 'good' ? 'from-emerald-400 to-emerald-500'
    : tone === 'warn' ? 'from-amber-400 to-amber-500'
    : tone === 'bad' ? 'from-red-400 to-red-500'
    : 'from-[#7C3AED] to-[#6366F1]';
  const iconTile = tone === 'good' ? 'text-emerald-600 bg-emerald-50 border-emerald-100'
    : tone === 'warn' ? 'text-amber-600 bg-amber-50 border-amber-100'
    : tone === 'bad' ? 'text-red-600 bg-red-50 border-red-100'
    : 'text-[#7C3AED] bg-[#F5F3FF] border-[#E9E5FB]';
  return (
    <div className={`${CARD_HOVER} relative overflow-hidden p-4 pt-[18px] hover:-translate-y-0.5 transition-transform`}>
      <span className={`absolute inset-x-0 top-0 h-[3px] bg-gradient-to-r ${accent} opacity-80`} />
      <div className="flex items-center gap-2">
        <span className={`w-7 h-7 rounded-lg flex items-center justify-center border flex-shrink-0 ${iconTile}`}><Icon className="w-3.5 h-3.5" /></span>
        <span className="text-[10.5px] font-semibold uppercase tracking-wide text-gray-500 truncate">{label}</span>
      </div>
      <div className="mt-3 flex items-center justify-between gap-2"><span className={`text-[30px] font-bold tabular-nums leading-none tracking-tight ${valueCls}`}>{loading && value ==='—' ? <Loader size="sm" /> : value}</span>{ring != null && !loading && <span className="flex-shrink-0"><PassRing value={ring} size={42} /></span>}</div>
      <p className="mt-2 text-[11px] font-medium text-gray-400 truncate">{sub || ' '}</p>
    </div>
  );
}
