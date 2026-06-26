/**
 * CoverageDashboard
 * ─────────────────
 * Test-case coverage dashboard inside Reports. Shows KPIs, status/type/priority/
 * feature distributions, a pass/fail trend, and a per-run table. Filterable by
 * time period (today / 7d / 30d / month / year / custom) and outcome (passed/failed).
 * Data is the REAL execution outcome (automation_scripts.last_run_result).
 */
import { useEffect, useMemo, useState, useCallback } from 'react';
import {
  ResponsiveContainer, PieChart, Pie, Cell, BarChart, Bar, XAxis, YAxis,
  CartesianGrid, Tooltip, AreaChart, Area, Legend,
} from 'recharts';
import {
  Loader2, ListChecks, Bot, CheckCircle2, XCircle, MinusCircle, Gauge, Layers, Calendar,
} from 'lucide-react';
import { getCoverageReport, type CoverageReport } from '@/services/api';

const C = {
  brand: '#3366FF', indigo: '#2645D6', passed: '#10B981', failed: '#EF4444',
  notRun: '#9CA3AF', ink: '#1E3A8A', grid: '#E5EAF5', muted: '#6B7280',
};

type Preset = 'all' | 'today' | '7d' | '30d' | 'month' | 'year' | 'custom';
type StatusFilter = 'all' | 'passed' | 'failed';

const startOfDay = (d: Date) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; };
const endOfDay = (d: Date) => { const x = new Date(d); x.setHours(23, 59, 59, 999); return x; };

function rangeForPreset(p: Preset, custom: { from: string; to: string }): { from?: string; to?: string } {
  const now = new Date();
  switch (p) {
    case 'today': return { from: startOfDay(now).toISOString(), to: endOfDay(now).toISOString() };
    case '7d': { const f = new Date(now); f.setDate(now.getDate() - 6); return { from: startOfDay(f).toISOString(), to: endOfDay(now).toISOString() }; }
    case '30d': { const f = new Date(now); f.setDate(now.getDate() - 29); return { from: startOfDay(f).toISOString(), to: endOfDay(now).toISOString() }; }
    case 'month': return { from: startOfDay(new Date(now.getFullYear(), now.getMonth(), 1)).toISOString(), to: endOfDay(now).toISOString() };
    case 'year': return { from: startOfDay(new Date(now.getFullYear(), 0, 1)).toISOString(), to: endOfDay(now).toISOString() };
    case 'custom': return {
      from: custom.from ? startOfDay(new Date(custom.from)).toISOString() : undefined,
      to: custom.to ? endOfDay(new Date(custom.to)).toISOString() : undefined,
    };
    default: return {};
  }
}

const PRESETS: { id: Preset; label: string }[] = [
  { id: 'all', label: 'All time' }, { id: 'today', label: 'Today' }, { id: '7d', label: 'Last 7 days' },
  { id: '30d', label: 'Last 30 days' }, { id: 'month', label: 'This month' }, { id: 'year', label: 'This year' },
  { id: 'custom', label: 'Custom' },
];

function fmtBucket(b: string, g: 'day' | 'month'): string {
  if (g === 'month') { const [y, m] = b.split('-'); return new Date(Number(y), Number(m) - 1, 1).toLocaleDateString('en-US', { month: 'short', year: '2-digit' }); }
  const d = new Date(b + 'T00:00:00'); return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

export default function CoverageDashboard() {
  const [preset, setPreset] = useState<Preset>('all');
  const [custom, setCustom] = useState({ from: '', to: '' });
  const [status, setStatus] = useState<StatusFilter>('all');
  const [data, setData] = useState<CoverageReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const range = useMemo(() => rangeForPreset(preset, custom), [preset, custom]);

  const load = useCallback(async () => {
    setLoading(true); setError('');
    try { setData(await getCoverageReport(range)); }
    catch (e: any) { setError(e?.response?.data?.error || e?.message || 'Failed to load coverage'); }
    finally { setLoading(false); }
  }, [range]);

  useEffect(() => { load(); }, [load]);

  const s = data?.summary;
  const runs = useMemo(() => {
    if (!data) return [];
    if (status === 'passed') return data.runs.filter((r) => r.passed > 0);
    if (status === 'failed') return data.runs.filter((r) => r.failed > 0);
    return data.runs;
  }, [data, status]);

  const trendData = useMemo(() => (data?.trend || []).map((t) => ({ ...t, label: fmtBucket(t.bucket, data!.range.granularity) })), [data]);

  return (
    <div className="space-y-5">
      {/* Filter bar */}
      <div className="bg-white/80 backdrop-blur-sm rounded-2xl border border-[#DCE7FF] shadow-sm p-4">
        <div className="flex flex-wrap items-center gap-2">
          <span className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-[#2143A8] mr-1">
            <Calendar className="w-3.5 h-3.5" /> Period
          </span>
          {PRESETS.map((p) => (
            <button
              key={p.id}
              onClick={() => setPreset(p.id)}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors ${
                preset === p.id ? 'bg-[#3366FF] text-white border-[#3366FF]' : 'bg-[#EEF4FF] text-[#1E3A8A] border-[#C5D6FF] hover:bg-[#DCE7FF]'
              }`}
            >{p.label}</button>
          ))}
          <div className="ml-auto flex items-center gap-1.5">
            <span className="text-xs font-semibold uppercase tracking-wide text-[#2143A8] mr-1">Outcome</span>
            {(['all', 'passed', 'failed'] as StatusFilter[]).map((st) => (
              <button
                key={st}
                onClick={() => setStatus(st)}
                className={`px-3 py-1.5 rounded-lg text-xs font-medium border capitalize transition-colors ${
                  status === st
                    ? st === 'passed' ? 'bg-emerald-500 text-white border-emerald-500'
                      : st === 'failed' ? 'bg-rose-500 text-white border-rose-500'
                      : 'bg-[#3366FF] text-white border-[#3366FF]'
                    : 'bg-white text-[#1E3A8A] border-[#C5D6FF] hover:bg-[#EEF4FF]'
                }`}
              >{st}</button>
            ))}
          </div>
        </div>
        {preset === 'custom' && (
          <div className="flex items-center gap-2 mt-3">
            <input type="date" value={custom.from} onChange={(e) => setCustom((c) => ({ ...c, from: e.target.value }))}
              className="px-3 py-1.5 text-sm rounded-lg border border-[#C5D6FF] bg-[#EEF4FF] text-[#1E3A8A] outline-none focus:ring-2 focus:ring-[#3366FF]/20" />
            <span className="text-xs text-[#6B7280]">to</span>
            <input type="date" value={custom.to} onChange={(e) => setCustom((c) => ({ ...c, to: e.target.value }))}
              className="px-3 py-1.5 text-sm rounded-lg border border-[#C5D6FF] bg-[#EEF4FF] text-[#1E3A8A] outline-none focus:ring-2 focus:ring-[#3366FF]/20" />
          </div>
        )}
      </div>

      {error && <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-600">{error}</div>}

      {loading ? (
        <div className="flex items-center justify-center h-72 bg-white/70 rounded-2xl border border-[#DCE7FF]">
          <Loader2 className="w-7 h-7 text-[#3366FF] animate-spin" /><span className="ml-3 text-sm text-[#6B7280]">Loading coverage…</span>
        </div>
      ) : !s || s.total === 0 ? (
        <div className="flex flex-col items-center justify-center h-72 bg-white/70 rounded-2xl border border-[#DCE7FF] text-center">
          <ListChecks className="w-12 h-12 text-[#9CA3AF] mb-3" />
          <h3 className="text-base font-semibold text-[#1E3A8A]">No test cases in this period</h3>
          <p className="text-sm text-[#6B7280] mt-1">Generate and save test cases, or widen the date range.</p>
        </div>
      ) : (
        <>
          {/* KPI cards */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <Kpi icon={ListChecks} label="Total Test Cases" value={s.total} sub={`${s.totalRuns} run${s.totalRuns === 1 ? '' : 's'}`} tone="brand" />
            <Kpi icon={Bot} label="Automation Coverage" value={`${s.automationCoverage}%`} sub={`${s.scripted}/${s.total} scripted`} tone="indigo" />
            <Kpi icon={Gauge} label="Pass Rate" value={`${s.passRate}%`} sub={`${s.executed} executed`} tone={s.passRate >= 80 ? 'passed' : s.passRate >= 50 ? 'brand' : 'failed'} />
            <Kpi icon={CheckCircle2} label="Passed" value={s.passed} tone="passed" />
            <Kpi icon={XCircle} label="Failed" value={s.failed} tone="failed" />
            <Kpi icon={MinusCircle} label="Not Run" value={s.notRun} tone="muted" />
            <Kpi icon={CheckCircle2} label="Executed" value={s.executed} tone="brand" />
            <Kpi icon={Layers} label="Scripted" value={s.scripted} tone="indigo" />
          </div>

          {/* Charts */}
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
            <Card title="Outcome distribution">
              <ResponsiveContainer width="100%" height={240}>
                <PieChart>
                  <Pie data={data!.byStatus} dataKey="value" nameKey="name" innerRadius={55} outerRadius={85} paddingAngle={2}>
                    {data!.byStatus.map((e) => (
                      <Cell key={e.name} fill={e.name === 'Passed' ? C.passed : e.name === 'Failed' ? C.failed : C.notRun} />
                    ))}
                  </Pie>
                  <Tooltip />
                  <Legend iconType="circle" />
                </PieChart>
              </ResponsiveContainer>
            </Card>

            <Card title={`Pass / fail trend (${data!.range.granularity === 'month' ? 'monthly' : 'daily'})`} className="lg:col-span-2">
              <ResponsiveContainer width="100%" height={240}>
                <AreaChart data={trendData} margin={{ top: 8, right: 12, left: -16, bottom: 0 }}>
                  <defs>
                    <linearGradient id="gP" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor={C.passed} stopOpacity={0.35} /><stop offset="100%" stopColor={C.passed} stopOpacity={0} /></linearGradient>
                    <linearGradient id="gF" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor={C.failed} stopOpacity={0.35} /><stop offset="100%" stopColor={C.failed} stopOpacity={0} /></linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke={C.grid} vertical={false} />
                  <XAxis dataKey="label" tick={{ fontSize: 11, fill: C.muted }} />
                  <YAxis allowDecimals={false} tick={{ fontSize: 11, fill: C.muted }} />
                  <Tooltip />
                  {status !== 'failed' && <Area type="monotone" dataKey="passed" name="Passed" stroke={C.passed} fill="url(#gP)" strokeWidth={2} />}
                  {status !== 'passed' && <Area type="monotone" dataKey="failed" name="Failed" stroke={C.failed} fill="url(#gF)" strokeWidth={2} />}
                  <Legend iconType="plainline" />
                </AreaChart>
              </ResponsiveContainer>
            </Card>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
            <DistCard title="By Type" rows={data!.byType} />
            <DistCard title="By Priority" rows={data!.byPriority} />
            <DistCard title="Top Features" rows={data!.byFeature} />
          </div>

          {/* Per-run table */}
          <Card title={`Coverage by run${status !== 'all' ? ` · ${status}` : ''}`}>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-[11px] uppercase tracking-wide text-[#6B7280] border-b border-[#DCE7FF]">
                    <th className="py-2 pr-3 font-semibold">Run</th>
                    <th className="py-2 px-3 font-semibold">Source</th>
                    <th className="py-2 px-3 font-semibold">Date</th>
                    <th className="py-2 px-3 font-semibold text-right">Total</th>
                    <th className="py-2 px-3 font-semibold text-right">Passed</th>
                    <th className="py-2 px-3 font-semibold text-right">Failed</th>
                    <th className="py-2 px-3 font-semibold text-right">Not run</th>
                    <th className="py-2 pl-3 font-semibold w-40">Pass rate</th>
                  </tr>
                </thead>
                <tbody>
                  {runs.length === 0 ? (
                    <tr><td colSpan={8} className="py-6 text-center text-[#6B7280]">No runs match this filter.</td></tr>
                  ) : runs.map((r) => {
                    const exec = r.passed + r.failed;
                    const rate = exec > 0 ? Math.round((r.passed / exec) * 100) : 0;
                    return (
                      <tr key={r.id} className="border-b border-[#EEF4FF] hover:bg-[#EEF4FF]/50">
                        <td className="py-2.5 pr-3">
                          <div className="flex items-center gap-2">
                            {r.storyKey && <span className="px-1.5 py-0.5 bg-[#DCE7FF] text-[#2143A8] rounded text-[11px] font-mono">{r.storyKey}</span>}
                            <span className="text-[#1E3A8A] truncate max-w-[220px]">{r.storyTitle || 'Manual input'}</span>
                          </div>
                        </td>
                        <td className="py-2.5 px-3 text-[#6B7280]">{r.platform ? `Mobile (${r.platform})` : r.source || '—'}</td>
                        <td className="py-2.5 px-3 text-[#6B7280] whitespace-nowrap">{new Date(r.createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}</td>
                        <td className="py-2.5 px-3 text-right font-medium text-[#1E3A8A]">{r.total}</td>
                        <td className="py-2.5 px-3 text-right text-emerald-600 font-medium">{r.passed}</td>
                        <td className="py-2.5 px-3 text-right text-rose-600 font-medium">{r.failed}</td>
                        <td className="py-2.5 px-3 text-right text-[#6B7280]">{r.notRun}</td>
                        <td className="py-2.5 pl-3">
                          <div className="flex items-center gap-2">
                            <div className="flex-1 h-2 rounded-full bg-[#EEF4FF] overflow-hidden">
                              <div className="h-full rounded-full" style={{ width: `${rate}%`, background: rate >= 80 ? C.passed : rate >= 50 ? C.brand : C.failed }} />
                            </div>
                            <span className="text-xs text-[#6B7280] w-9 text-right">{exec > 0 ? `${rate}%` : '—'}</span>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </Card>
        </>
      )}
    </div>
  );
}

/* ── small presentational helpers ── */
function Kpi({ icon: Icon, label, value, sub, tone }: { icon: React.ElementType; label: string; value: React.ReactNode; sub?: string; tone: 'brand' | 'indigo' | 'passed' | 'failed' | 'muted' }) {
  const toneMap: Record<string, string> = {
    brand: 'text-[#3366FF] bg-[#EEF4FF]', indigo: 'text-[#2645D6] bg-[#EDF1FE]',
    passed: 'text-emerald-600 bg-emerald-50', failed: 'text-rose-600 bg-rose-50', muted: 'text-gray-500 bg-gray-100',
  };
  return (
    <div className="bg-white/80 backdrop-blur-sm rounded-xl border border-[#DCE7FF] shadow-sm p-4">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-[#6B7280]">{label}</span>
        <span className={`w-7 h-7 rounded-lg flex items-center justify-center ${toneMap[tone]}`}><Icon className="w-4 h-4" /></span>
      </div>
      <p className="text-2xl font-bold text-[#1E3A8A] mt-2 leading-none">{value}</p>
      {sub && <p className="text-[11px] text-[#6B7280] mt-1">{sub}</p>}
    </div>
  );
}

function Card({ title, children, className = '' }: { title: string; children: React.ReactNode; className?: string }) {
  return (
    <div className={`bg-white/80 backdrop-blur-sm rounded-2xl border border-[#DCE7FF] shadow-sm p-4 ${className}`}>
      <h3 className="text-sm font-semibold text-[#1E3A8A] mb-3">{title}</h3>
      {children}
    </div>
  );
}

function DistCard({ title, rows }: { title: string; rows: { name: string; value: number }[] }) {
  return (
    <Card title={title}>
      {rows.length === 0 ? (
        <p className="text-sm text-[#6B7280] py-6 text-center">No data</p>
      ) : (
        <ResponsiveContainer width="100%" height={Math.max(160, rows.length * 34)}>
          <BarChart data={rows} layout="vertical" margin={{ top: 0, right: 16, left: 8, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke={C.grid} horizontal={false} />
            <XAxis type="number" allowDecimals={false} tick={{ fontSize: 11, fill: C.muted }} />
            <YAxis type="category" dataKey="name" width={92} tick={{ fontSize: 11, fill: C.ink }} />
            <Tooltip cursor={{ fill: '#EEF4FF' }} />
            <Bar dataKey="value" fill={C.brand} radius={[0, 4, 4, 0]} barSize={16} />
          </BarChart>
        </ResponsiveContainer>
      )}
    </Card>
  );
}
