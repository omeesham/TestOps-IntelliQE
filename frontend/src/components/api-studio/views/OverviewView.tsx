/**
 * OverviewView — the API Automation dashboard.
 *
 * KPIs across every API run this tenant has made, the pass-rate trend,
 * anomalies the platform spotted (flaky, new failures, slow), the slowest
 * scenarios, recent runs and recent imports — plus the workspace's current
 * state (catalogue size, active environment) so the next step is obvious.
 */
import { useEffect, useState } from 'react';
import { Area, AreaChart, Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { Activity, AlertTriangle, ArrowRight, Clock, RefreshCw, Layers, Upload, Server, Gauge, Zap, TrendingUp } from 'lucide-react';
import { getApiOverview } from '@/services/api';
import { CARD, CARD_HOVER, TILE_ACTIVE, THEAD, PRIMARY_BTN, SECONDARY_BTN, BRAND_CHIP, MUTED_CHIP, relativeTime, formatDuration, IMPORT_METHOD_LABELS } from '../format';
import { StatusPill } from '../primitives';
import type { ApiOverview, NavView } from '../types';
import type { Catalog } from '../hooks/useCatalog';

import Loader from '@/components/feedback/Loader';
interface Props { catalog: Catalog; onNavigate: (v: NavView) => void; onOpenRun: (runId: string) => void; refreshKey: number }

export default function OverviewView({ catalog, onNavigate, onOpenRun, refreshKey }: Props) {
  const [data, setData] = useState<ApiOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = async () => {
    setLoading(true); setError('');
    try { setData(await getApiOverview()); }
    catch (err: any) { setError(err?.response?.data?.error || err?.message || 'Could not load the dashboard.'); }
    finally { setLoading(false); }
  };
  useEffect(() => { void load(); }, [refreshKey]);

  const k = data?.kpis;
  const trend = (data?.trend || []).map((t) => ({ ...t, label: new Date(t.at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) }));
  const cats = Object.entries(data?.categories || {}).sort((a, b) => b[1] - a[1]).map(([name, value]) => ({ name, value }));
  const methods = Object.entries(data?.methods || {}).sort((a, b) => b[1] - a[1]);

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-[1280px] mx-auto px-6 py-5 space-y-4">
        {/* Workspace state — the next step */}
        <div className={`${CARD} p-4 flex items-center gap-4 flex-wrap`}>
          <div className="flex items-center gap-3">
            <span className={`w-9 h-9 rounded-xl flex items-center justify-center ${TILE_ACTIVE}`}><Layers className="w-4 h-4 text-white" /></span>
            <div>
              <p className="text-[13px] font-semibold text-gray-900">{catalog.endpoints.length > 0 ? `${catalog.endpoints.length} endpoints in the catalogue` : 'Start by importing an API'}</p>
              <p className="text-[11px] text-gray-500">
                {catalog.endpoints.length > 0
                  ? `${catalog.selected.size} selected · ${catalog.profile?.resources.length || 0} resources · ${catalog.profile?.flows.length || 0} flows · environment: ${catalog.activeEnv?.name || 'none'}`
                  : 'OpenAPI, Postman, cURL, docs page, SDK, GraphQL, MCP, webhook, middleware, connector or a manual request.'}
              </p>
            </div>
          </div>
          <div className="ml-auto flex items-center gap-2">
            <button type="button" onClick={() => onNavigate('import')} className={SECONDARY_BTN}><Upload className="w-3.5 h-3.5" />Import</button>
            {catalog.endpoints.length > 0 && <button type="button" onClick={() => onNavigate('endpoints')} className={PRIMARY_BTN}>Review & design<ArrowRight className="w-3.5 h-3.5" /></button>}
          </div>
        </div>

        {error && <div className="flex items-center gap-2 px-4 py-2.5 bg-red-50 border border-red-200 rounded-lg text-[12px] text-red-700"><AlertTriangle className="w-4 h-4" />{error}<button type="button" onClick={load} className="ml-auto underline">Retry</button></div>}

        {/* KPIs */}
        <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-3">
          <Kpi icon={Activity} label="API runs" value={k ? k.runs : '—'} sub={k ? `${k.runsLast30d} in 30 days` : ''} loading={loading} />
          <Kpi icon={Gauge} label="Avg pass rate" value={k?.avgPassRate != null ? `${k.avgPassRate}%` : '—'} sub={k?.lastPassRate != null ? `last run ${k.lastPassRate}%` : 'no executed runs yet'} loading={loading} tone={k?.avgPassRate != null ? (k.avgPassRate >= 90 ? 'good' : k.avgPassRate >= 70 ? 'warn' : 'bad') : 'neutral'} />
          <Kpi icon={Layers} label="Scenarios" value={k ? k.scenarios : '—'} sub={k ? `${k.endpointsCovered} endpoints covered` : ''} loading={loading} />
          <Kpi icon={Zap} label="Anomalies" value={data ? data.anomalies.length : '—'} sub={data ? `${data.anomalies.filter((a) => a.kind === 'flaky').length} flaky · ${data.anomalies.filter((a) => a.kind === 'new-failure').length} new` : ''} loading={loading} tone={data?.anomalies.length ? 'warn' : 'neutral'} />
          <Kpi icon={Upload} label="Imports" value={k ? k.imports : '—'} sub={data ? Object.keys(data.imports.byMethod).length + ' methods used' : ''} loading={loading} />
          <Kpi icon={Server} label="Environments" value={k ? k.environments : '—'} sub={k?.lastRunAt ? `last run ${relativeTime(k.lastRunAt)}` : ''} loading={loading} />
        </div>

        {/* Trend + categories */}
        <div className="grid grid-cols-1 xl:grid-cols-3 gap-3">
          <div className={`${CARD} p-4 xl:col-span-2`}>
            <div className="flex items-center gap-2 mb-2"><TrendingUp className="w-4 h-4 text-[#7C3AED]" /><h3 className="text-[12.5px] font-semibold text-gray-900">Pass-rate trend</h3><span className="text-[11px] text-gray-400">last {trend.length} executed runs</span><button type="button" onClick={load} className="ml-auto p-1 text-gray-300 hover:text-[#7C3AED]" title="Refresh"><RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} /></button></div>
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
          <div className={`${CARD} p-4`}>
            <div className="flex items-center gap-2 mb-2"><Zap className="w-4 h-4 text-amber-500" /><h3 className="text-[12.5px] font-semibold text-gray-900">Anomalies</h3><span className="text-[11px] text-gray-400">across the last 8 runs</span></div>
            {!data || data.anomalies.length === 0 ? <p className="text-[11.5px] text-gray-400 py-6 text-center">Nothing unusual — no flaky scenarios, new failures or slow outliers.</p> : (
              <ul className="space-y-1.5">
                {data.anomalies.slice(0, 8).map((a, i) => (
                  <li key={i} className="flex gap-2 text-[11.5px]">
                    <span className={`inline-flex px-1.5 py-0.5 rounded border text-[9.5px] font-semibold flex-shrink-0 h-fit ${a.kind === 'new-failure' ? 'text-red-700 bg-red-50 border-red-200' : a.kind === 'flaky' ? 'text-amber-700 bg-amber-50 border-amber-200' : MUTED_CHIP}`}>{a.kind === 'new-failure' ? 'NEW FAIL' : a.kind.toUpperCase()}</span>
                    <div className="min-w-0"><p className="text-gray-800 truncate" title={a.name}>{a.name}</p><p className="text-[10.5px] text-gray-500">{a.detail}</p></div>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div className={`${CARD} p-4`}>
            <div className="flex items-center gap-2 mb-2"><Clock className="w-4 h-4 text-[#7C3AED]" /><h3 className="text-[12.5px] font-semibold text-gray-900">Slowest scenarios</h3></div>
            {!data || data.slowest.length === 0 ? <p className="text-[11.5px] text-gray-400 py-6 text-center">Timings appear after the first executed run.</p> : (
              <ul className="space-y-1">
                {data.slowest.slice(0, 8).map((s, i) => (
                  <li key={i} className="flex items-center gap-2 text-[11.5px]">
                    <span className="text-gray-800 truncate flex-1 min-w-0" title={s.name}>{s.name}</span>
                    <span className="font-mono text-[10.5px] text-gray-500 tabular-nums">{formatDuration(s.durationMs)}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div className={`${CARD} p-4`}>
            <div className="flex items-center gap-2 mb-2"><Activity className="w-4 h-4 text-[#7C3AED]" /><h3 className="text-[12.5px] font-semibold text-gray-900">Recent runs</h3><button type="button" onClick={() => onNavigate('runs')} className="ml-auto text-[11px] text-[#7C3AED] hover:underline">All runs</button></div>
            {!data || data.recentRuns.length === 0 ? <p className="text-[11.5px] text-gray-400 py-6 text-center">No API runs yet.</p> : (
              <ul className="space-y-1">
                {data.recentRuns.slice(0, 6).map((r) => (
                  <li key={r.runId}>
                    <button type="button" onClick={() => onOpenRun(r.runId)} className="w-full flex items-center gap-2 text-left px-1.5 py-1 rounded-md hover:bg-[#F5F3FF] hover:shadow-[inset_0_1px_0_rgba(255,255,255,0.9),0_2px_6px_-4px_rgba(76,29,149,0.4)] transition-all">
                      <div className="min-w-0 flex-1"><p className="text-[11.5px] text-gray-800 truncate">{r.title}</p><p className="text-[10.5px] text-gray-400">{relativeTime(r.createdAt)} · {r.caseCount} scenarios</p></div>
                      {r.stats ? <span className={`font-mono text-[11px] font-semibold tabular-nums ${r.stats.passRate >= 90 ? 'text-emerald-600' : r.stats.passRate >= 70 ? 'text-amber-600' : 'text-red-600'}`}>{r.stats.passRate}%</span> : <StatusPill status="not_run" />}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>

        {/* Imports */}
        {data && data.imports.recent.length > 0 && (
          <div className={`${CARD} p-4`}>
            <div className="flex items-center gap-2 mb-2"><Upload className="w-4 h-4 text-[#7C3AED]" /><h3 className="text-[12.5px] font-semibold text-gray-900">Recent imports</h3>
              <div className="ml-auto flex flex-wrap gap-1">{Object.entries(data.imports.byMethod).map(([m, n]) => <span key={m} className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded border text-[10px] ${MUTED_CHIP}`}>{IMPORT_METHOD_LABELS[m] || m}<span className="font-mono">{n}</span></span>)}</div>
            </div>
            <table className="w-full text-[11.5px]">
              <thead className={`text-[10.5px] uppercase tracking-wide text-gray-500 ${THEAD}`}><tr><th className="text-left py-1 px-2 font-semibold rounded-l-md">Source</th><th className="text-left py-1 font-semibold">Method</th><th className="text-left py-1 font-semibold">Format</th><th className="text-right py-1 font-semibold">Endpoints</th><th className="text-right py-1 font-semibold">When</th></tr></thead>
              <tbody>
                {data.imports.recent.slice(0, 8).map((im) => (
                  <tr key={im.id} className="border-t border-gray-100">
                    <td className="py-1 text-gray-800 truncate max-w-[360px]">{im.name}</td>
                    <td className="py-1 text-gray-500">{IMPORT_METHOD_LABELS[im.method] || im.method}</td>
                    <td className="py-1 font-mono text-gray-500">{im.format}</td>
                    <td className="py-1 text-right font-mono tabular-nums text-gray-800">{im.endpointCount}</td>
                    <td className="py-1 text-right text-gray-400">{relativeTime(im.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

function Kpi({ icon: Icon, label, value, sub, loading, tone = 'neutral' }: { icon: React.ElementType; label: string; value: string | number; sub?: string; loading: boolean; tone?: 'neutral' | 'good' | 'warn' | 'bad' }) {
  const valueCls = tone === 'good' ? 'text-emerald-600' : tone === 'warn' ? 'text-amber-600' : tone === 'bad' ? 'text-red-600' : 'text-gray-900';
  return (
    <div className={`${CARD_HOVER} p-3.5`}>
      <div className="flex items-center gap-1.5 text-[10.5px] font-semibold uppercase tracking-wide text-gray-500"><Icon className="w-3.5 h-3.5 text-[#7C3AED]" />{label}</div>
      <div className={`mt-1.5 text-[22px] font-semibold tabular-nums leading-none ${valueCls}`}>{loading && value === '—' ? <Loader size="sm" /> : value}</div>
      <p className="mt-1.5 text-[10.5px] text-gray-400 truncate">{sub || ' '}</p>
    </div>
  );
}
