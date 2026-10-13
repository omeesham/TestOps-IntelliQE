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
import { Activity, AlertTriangle, ArrowRight, Clock, RefreshCw, Layers, Upload, Gauge, Zap, TrendingUp, ChevronRight, Timer, ShieldCheck } from 'lucide-react';
import { getApiOverview } from '@/services/api';
import { CARD, CARD_HOVER, TILE_ACTIVE, THEAD, PRIMARY_BTN, SECONDARY_BTN, BRAND_CHIP, MUTED_CHIP, relativeTime, formatDuration, IMPORT_METHOD_LABELS } from '../format';
import { StatusPill, PassRing } from '../primitives';
import type { ApiOverview, NavView } from '../types';
import type { Catalog } from '../hooks/useCatalog';

import Loader from '@/components/feedback/Loader';
interface Props { catalog: Catalog; onNavigate: (v: NavView) => void; onOpenRun: (runId: string) => void; refreshKey: number }

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
        {/* Workspace state — the next step */}
        <div className="flex items-center gap-4 flex-wrap">
          <span className={`w-11 h-11 rounded-xl flex items-center justify-center ${TILE_ACTIVE}`}><Layers className="w-5 h-5 text-white" /></span>
          <div className="min-w-0">
            <h2 className="text-[17px] font-bold text-gray-900 leading-tight">{catalog.endpoints.length > 0 ? 'Endpoint catalogue' : 'Start by importing an API'}</h2>
            <p className="text-[12.5px] text-gray-500 mt-0.5">
              {catalog.endpoints.length > 0
                ? `${catalog.endpoints.length} endpoint${catalog.endpoints.length === 1 ? '' : 's'} · ${catalog.selected.size} selected`
                : 'OpenAPI, Postman, cURL, SDK, GraphQL, MCP and more.'}
            </p>
          </div>
          <div className="ml-auto flex items-center gap-2">
            <button type="button" onClick={() => onNavigate('import')} className={SECONDARY_BTN}><Upload className="w-3.5 h-3.5" />Import</button>
            {catalog.endpoints.length > 0 && <button type="button" onClick={() => onNavigate('endpoints')} className={PRIMARY_BTN}>Review & design<ArrowRight className="w-3.5 h-3.5" /></button>}
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
                {methods.map(([m, n]) => <span key={m} className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded border font-mono text-[10px] ${BRAND_CHIP}`}>{m}<span className="text-gray-400">{n}</span></span>)}
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

function Kpi({ icon: Icon, label, value, sub, loading, tone = 'neutral', ring }: { icon: React.ElementType; label: string; value: string | number; sub?: string; loading: boolean; tone?: 'neutral' | 'good' | 'warn' | 'bad'; ring?: number }) {
  const valueCls = tone === 'good' ? 'text-emerald-600' : tone === 'warn' ? 'text-amber-600' : tone === 'bad' ? 'text-red-600' : 'text-gray-900';
  return (
    <div className={`${CARD_HOVER} p-4`}>
      <div className="flex items-center gap-1.5 text-[10.5px] font-semibold uppercase tracking-wide text-gray-500"><Icon className="w-3.5 h-3.5 text-[#7C3AED]" />{label}</div>
      <div className="mt-3 flex items-center justify-between gap-2"><span className={`text-[28px] font-bold tabular-nums leading-none ${valueCls}`}>{loading && value ==='—' ? <Loader size="sm" /> : value}</span>{ring != null && !loading && <span className="flex-shrink-0"><PassRing value={ring} size={40} /></span>}</div>
      <p className="mt-2 text-[11px] font-medium text-gray-400 truncate">{sub || ' '}</p>
    </div>
  );
}
