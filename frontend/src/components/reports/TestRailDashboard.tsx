/**
 * TestRailDashboard
 * ─────────────────
 * TestRail is the data source; this is the visualization layer. Data is synced
 * into IntelliQE's DB (see backend testrail.service) and read back here. Shows a
 * connect panel when not connected, otherwise KPIs + status donut + pass/fail
 * trend + per-run breakdown + milestone progress + a runs table.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ResponsiveContainer, PieChart, Pie, Cell, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend, AreaChart, Area,
} from 'recharts';
import {
  Loader2, RefreshCw, Plug, Unplug, Eye, EyeOff, ExternalLink, CheckCircle2, XCircle, Ban,
  RotateCcw, MinusCircle, Gauge, Flag, AlertTriangle,
} from 'lucide-react';
import {
  getTestRailStatus, connectTestRail, syncTestRail, getTestRailDashboard, disconnectTestRail,
  type TestRailStatus, type TestRailDashboardData,
} from '@/services/api';

const C = {
  brand: '#3366FF', passed: '#10B981', failed: '#EF4444', blocked: '#F59E0B',
  retest: '#6366F1', untested: '#9CA3AF', ink: '#1E3A8A', grid: '#E5EAF5', muted: '#6B7280',
};
const STATUS_COLOR: Record<string, string> = { Passed: C.passed, Failed: C.failed, Blocked: C.blocked, Retest: C.retest, Untested: C.untested };

const fmtDate = (iso: string | null) => iso ? new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—';
const fmtMonth = (b: string) => { const [y, m] = b.split('-'); return new Date(Number(y), Number(m) - 1, 1).toLocaleDateString('en-US', { month: 'short', year: '2-digit' }); };

export default function TestRailDashboard() {
  const [status, setStatus] = useState<TestRailStatus | null>(null);
  const [data, setData] = useState<TestRailDashboardData | null>(null);
  const [projectId, setProjectId] = useState<number | 'all'>('all');
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState('');

  // connect form
  const [baseUrl, setBaseUrl] = useState('');
  const [email, setEmail] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [showKey, setShowKey] = useState(false);
  const [connecting, setConnecting] = useState(false);

  const loadDashboard = useCallback(async (pid: number | 'all') => {
    const d = await getTestRailDashboard(pid === 'all' ? undefined : pid);
    setData(d);
  }, []);

  const refresh = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const st = await getTestRailStatus();
      setStatus(st);
      if (st.connected) await loadDashboard('all');
    } catch (e: any) { setError(e?.response?.data?.error || e?.message || 'Failed to load TestRail'); }
    finally { setLoading(false); }
  }, [loadDashboard]);

  useEffect(() => { refresh(); }, [refresh]);
  useEffect(() => { if (status?.connected) loadDashboard(projectId).catch(() => {}); }, [projectId, status?.connected, loadDashboard]);

  const handleConnect = async () => {
    if (!baseUrl.trim() || !email.trim() || !apiKey.trim()) { setError('Instance URL, email and API key are required.'); return; }
    setConnecting(true); setError('');
    try {
      await connectTestRail(baseUrl.trim(), email.trim(), apiKey.trim());
      setApiKey('');
      await refresh();
    } catch (e: any) { setError(e?.response?.data?.error || e?.message || 'Could not connect to TestRail'); }
    finally { setConnecting(false); }
  };

  const handleSync = async () => {
    setSyncing(true); setError('');
    try { await syncTestRail(); await refresh(); }
    catch (e: any) { setError(e?.response?.data?.error || e?.message || 'Sync failed'); }
    finally { setSyncing(false); }
  };

  const handleDisconnect = async () => {
    setSyncing(true);
    try { await disconnectTestRail(); setData(null); await refresh(); }
    catch (e: any) { setError(e?.response?.data?.error || e?.message || 'Disconnect failed'); }
    finally { setSyncing(false); }
  };

  const perRunData = useMemo(() => (data?.perRun || []).map((r) => ({
    name: r.name.length > 18 ? r.name.slice(0, 17) + '…' : r.name,
    Passed: r.passed, Failed: r.failed, Blocked: r.blocked, Untested: r.untested,
  })), [data]);
  const trendData = useMemo(() => (data?.trend || []).map((t) => ({ ...t, label: fmtMonth(t.bucket) })), [data]);

  if (loading) {
    return <div className="flex items-center justify-center h-72 bg-white/70 rounded-2xl border border-[#DCE7FF]"><Loader2 className="w-7 h-7 text-[#3366FF] animate-spin" /><span className="ml-3 text-sm text-[#6B7280]">Loading TestRail…</span></div>;
  }

  /* ── Not connected → connect panel ── */
  if (!status?.connected) {
    return (
      <div className="max-w-xl mx-auto bg-white/80 backdrop-blur-sm rounded-2xl border border-[#DCE7FF] shadow-sm p-6">
        <div className="flex items-center gap-3 mb-1">
          <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-[#3366FF] to-[#2645D6] flex items-center justify-center"><Plug className="w-5 h-5 text-white" /></div>
          <div>
            <h3 className="text-base font-semibold text-[#1E3A8A]">Connect TestRail</h3>
            <p className="text-xs text-[#6B7280]">IntelliQE will sync your TestRail projects, runs & milestones and visualize them here.</p>
          </div>
        </div>
        {error && <div className="mt-3 flex items-center gap-2 p-3 bg-red-50 border border-red-200 rounded-lg text-xs text-red-600"><AlertTriangle className="w-4 h-4" />{error}</div>}
        <div className="space-y-3 mt-4">
          <Field label="TestRail Instance URL">
            <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://yourcompany.testrail.io" className={inputCls} />
          </Field>
          <Field label="Email">
            <input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@company.com" className={inputCls} />
          </Field>
          <Field label="API Key">
            <div className="relative">
              <input type={showKey ? 'text' : 'password'} value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder="TestRail API key" autoComplete="off" className={inputCls + ' pr-10'} />
              <button type="button" onClick={() => setShowKey((s) => !s)} className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-[#2143A8]">{showKey ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}</button>
            </div>
            <p className="text-[11px] text-[#6B7280] mt-1">Create one in TestRail → My Settings → API Keys. Stored encrypted; never shown again.</p>
          </Field>
          <button onClick={handleConnect} disabled={connecting} className="w-full flex items-center justify-center gap-2 px-5 py-2.5 bg-gradient-to-r from-[#3366FF] to-[#2645D6] text-white rounded-lg text-sm font-medium hover:from-[#2A55D6] hover:to-[#2645D6] shadow-md shadow-blue-500/20 transition-all disabled:opacity-50">
            {connecting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plug className="w-4 h-4" />}{connecting ? 'Connecting & syncing…' : 'Connect & Sync'}
          </button>
        </div>
      </div>
    );
  }

  /* ── Connected → dashboard ── */
  const s = data?.summary;
  return (
    <div className="space-y-5">
      {/* Connection bar */}
      <div className="bg-white/80 backdrop-blur-sm rounded-2xl border border-[#DCE7FF] shadow-sm p-4 flex flex-wrap items-center gap-3">
        <span className="flex items-center gap-2 text-sm text-[#1E3A8A] font-medium">
          <CheckCircle2 className="w-4 h-4 text-emerald-500" /> Connected
          {status.baseUrl && <a href={status.baseUrl} target="_blank" rel="noreferrer" className="text-[#3366FF] inline-flex items-center gap-1 hover:underline">{status.baseUrl.replace(/^https?:\/\//, '')}<ExternalLink className="w-3 h-3" /></a>}
        </span>
        <span className="text-xs text-[#6B7280]">Last synced: {fmtDate(status.lastSyncedAt)}</span>
        {data && data.projects.length > 0 && (
          <select value={projectId} onChange={(e) => setProjectId(e.target.value === 'all' ? 'all' : Number(e.target.value))}
            className="px-3 py-1.5 text-sm rounded-lg border border-[#C5D6FF] bg-[#EEF4FF] text-[#1E3A8A] outline-none focus:ring-2 focus:ring-[#3366FF]/20">
            <option value="all">All projects</option>
            {data.projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        )}
        <div className="ml-auto flex items-center gap-2">
          <button onClick={handleSync} disabled={syncing} className="flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-white bg-gradient-to-r from-[#3366FF] to-[#2645D6] rounded-lg disabled:opacity-50 transition-all">
            {syncing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}{syncing ? 'Syncing…' : 'Sync now'}
          </button>
          <button onClick={handleDisconnect} disabled={syncing} className="flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-[#6B7280] bg-white border border-[#C5D6FF] rounded-lg hover:text-rose-600 hover:border-rose-200 transition-colors">
            <Unplug className="w-3.5 h-3.5" /> Disconnect
          </button>
        </div>
      </div>

      {error && <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-600">{error}</div>}

      {!s || s.total === 0 ? (
        <div className="flex flex-col items-center justify-center h-60 bg-white/70 rounded-2xl border border-[#DCE7FF] text-center">
          <RefreshCw className="w-10 h-10 text-[#9CA3AF] mb-3" />
          <h3 className="text-base font-semibold text-[#1E3A8A]">No TestRail data yet</h3>
          <p className="text-sm text-[#6B7280] mt-1">Click "Sync now" to pull projects, runs and results from TestRail.</p>
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <Kpi icon={Gauge} label="Pass Rate" value={`${s.passRate}%`} sub={`${s.executed} executed`} tone={s.passRate >= 80 ? 'passed' : s.passRate >= 50 ? 'brand' : 'failed'} />
            <Kpi icon={Flag} label="Test Runs" value={s.runs} sub={`${s.total} tests`} tone="brand" />
            <Kpi icon={CheckCircle2} label="Passed" value={s.passed} tone="passed" />
            <Kpi icon={XCircle} label="Failed" value={s.failed} tone="failed" />
            <Kpi icon={Ban} label="Blocked" value={s.blocked} tone="blocked" />
            <Kpi icon={RotateCcw} label="Retest" value={s.retest} tone="retest" />
            <Kpi icon={MinusCircle} label="Untested" value={s.untested} tone="muted" />
            <Kpi icon={Flag} label="Milestones" value={data!.milestones.length} tone="brand" />
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
            <Card title="Result distribution">
              <ResponsiveContainer width="100%" height={240}>
                <PieChart>
                  <Pie data={data!.byStatus.filter((x) => x.value > 0)} dataKey="value" nameKey="name" innerRadius={55} outerRadius={85} paddingAngle={2}>
                    {data!.byStatus.map((e) => <Cell key={e.name} fill={STATUS_COLOR[e.name] || C.muted} />)}
                  </Pie>
                  <Tooltip /><Legend iconType="circle" />
                </PieChart>
              </ResponsiveContainer>
            </Card>

            <Card title="Pass / fail trend (monthly)" className="lg:col-span-2">
              <ResponsiveContainer width="100%" height={240}>
                <AreaChart data={trendData} margin={{ top: 8, right: 12, left: -16, bottom: 0 }}>
                  <defs>
                    <linearGradient id="trP" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor={C.passed} stopOpacity={0.35} /><stop offset="100%" stopColor={C.passed} stopOpacity={0} /></linearGradient>
                    <linearGradient id="trF" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor={C.failed} stopOpacity={0.35} /><stop offset="100%" stopColor={C.failed} stopOpacity={0} /></linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke={C.grid} vertical={false} />
                  <XAxis dataKey="label" tick={{ fontSize: 11, fill: C.muted }} /><YAxis allowDecimals={false} tick={{ fontSize: 11, fill: C.muted }} />
                  <Tooltip />
                  <Area type="monotone" dataKey="passed" name="Passed" stroke={C.passed} fill="url(#trP)" strokeWidth={2} />
                  <Area type="monotone" dataKey="failed" name="Failed" stroke={C.failed} fill="url(#trF)" strokeWidth={2} />
                  <Legend iconType="plainline" />
                </AreaChart>
              </ResponsiveContainer>
            </Card>
          </div>

          <Card title="Results by run">
            <ResponsiveContainer width="100%" height={Math.max(220, perRunData.length * 34)}>
              <BarChart data={perRunData} layout="vertical" margin={{ top: 0, right: 16, left: 8, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke={C.grid} horizontal={false} />
                <XAxis type="number" allowDecimals={false} tick={{ fontSize: 11, fill: C.muted }} />
                <YAxis type="category" dataKey="name" width={130} tick={{ fontSize: 11, fill: C.ink }} />
                <Tooltip cursor={{ fill: '#EEF4FF' }} /><Legend iconType="circle" />
                <Bar dataKey="Passed" stackId="a" fill={C.passed} />
                <Bar dataKey="Failed" stackId="a" fill={C.failed} />
                <Bar dataKey="Blocked" stackId="a" fill={C.blocked} />
                <Bar dataKey="Untested" stackId="a" fill={C.untested} radius={[0, 4, 4, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </Card>

          {data!.milestones.length > 0 && (
            <Card title="Milestones">
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
                {data!.milestones.map((m) => (
                  <div key={m.id} className="flex items-center justify-between gap-3 p-3 rounded-lg border border-[#DCE7FF] bg-[#EEF4FF]/40">
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-[#1E3A8A] truncate">{m.name}</p>
                      <p className="text-[11px] text-[#6B7280]">{m.dueOn ? `Due ${new Date(m.dueOn).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}` : 'No due date'}</p>
                    </div>
                    <span className={`text-[10px] font-semibold uppercase tracking-wide px-2 py-1 rounded-full ${m.isCompleted ? 'bg-emerald-50 text-emerald-700' : 'bg-blue-50 text-[#2143A8]'}`}>
                      {m.isCompleted ? 'Completed' : 'Active'}
                    </span>
                  </div>
                ))}
              </div>
            </Card>
          )}

          <Card title="Recent runs">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-[11px] uppercase tracking-wide text-[#6B7280] border-b border-[#DCE7FF]">
                    <th className="py-2 pr-3 font-semibold">Run</th>
                    <th className="py-2 px-3 font-semibold">Created</th>
                    <th className="py-2 px-3 font-semibold text-right">Passed</th>
                    <th className="py-2 px-3 font-semibold text-right">Failed</th>
                    <th className="py-2 px-3 font-semibold text-right">Blocked</th>
                    <th className="py-2 px-3 font-semibold text-right">Untested</th>
                    <th className="py-2 pl-3 font-semibold w-40">Pass rate</th>
                  </tr>
                </thead>
                <tbody>
                  {data!.perRun.map((r) => {
                    const exec = r.passed + r.failed + r.blocked;
                    const rate = exec > 0 ? Math.round((r.passed / exec) * 100) : 0;
                    return (
                      <tr key={r.id} className="border-b border-[#EEF4FF] hover:bg-[#EEF4FF]/50">
                        <td className="py-2.5 pr-3 text-[#1E3A8A] truncate max-w-[260px]">{r.name}</td>
                        <td className="py-2.5 px-3 text-[#6B7280] whitespace-nowrap">{r.createdOn ? new Date(r.createdOn).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '—'}</td>
                        <td className="py-2.5 px-3 text-right text-emerald-600 font-medium">{r.passed}</td>
                        <td className="py-2.5 px-3 text-right text-rose-600 font-medium">{r.failed}</td>
                        <td className="py-2.5 px-3 text-right text-amber-600 font-medium">{r.blocked}</td>
                        <td className="py-2.5 px-3 text-right text-[#6B7280]">{r.untested}</td>
                        <td className="py-2.5 pl-3">
                          <div className="flex items-center gap-2">
                            <div className="flex-1 h-2 rounded-full bg-[#EEF4FF] overflow-hidden"><div className="h-full rounded-full" style={{ width: `${rate}%`, background: rate >= 80 ? C.passed : rate >= 50 ? C.brand : C.failed }} /></div>
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

const inputCls = 'w-full px-3 py-2.5 rounded-xl border border-[#C5D6FF] bg-[#EEF4FF] text-sm text-[#1E3A8A] outline-none focus:ring-2 focus:ring-[#3366FF]/20 focus:border-[#3366FF] transition-all';

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <div><label className="block text-xs font-medium text-[#2143A8] mb-1">{label}</label>{children}</div>;
}

function Kpi({ icon: Icon, label, value, sub, tone }: { icon: React.ElementType; label: string; value: React.ReactNode; sub?: string; tone: 'brand' | 'passed' | 'failed' | 'blocked' | 'retest' | 'muted' }) {
  const toneMap: Record<string, string> = {
    brand: 'text-[#3366FF] bg-[#EEF4FF]', passed: 'text-emerald-600 bg-emerald-50', failed: 'text-rose-600 bg-rose-50',
    blocked: 'text-amber-600 bg-amber-50', retest: 'text-indigo-600 bg-indigo-50', muted: 'text-gray-500 bg-gray-100',
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
