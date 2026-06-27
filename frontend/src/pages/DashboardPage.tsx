import { useEffect, useState, useMemo } from 'react';
import { Link } from 'react-router-dom';
import { Loader2, ArrowRight } from 'lucide-react';
import { getReportsSummary, listTestRuns, listPipelineRuns } from '@/services/api';

/* ──────────────────────────────────────────────────────────────────
   Types
   ────────────────────────────────────────────────────────────────── */
interface ReportsSummary {
  totalTestRuns: number;
  totalTestCases: number;
  statusDistribution: { name: string; value: number }[];
}

interface TestRunRow {
  id: string;
  story_title: string | null;
  feature?: string | null;
  module: string | null;
  submodule: string | null;
  test_case_count: number;
  scripted_count: number;
  created_at: string;
}

interface PipelineRunRow { id: string; status: string; }

/* ──────────────────────────────────────────────────────────────────
   Coverage rollups
   ────────────────────────────────────────────────────────────────── */
interface CoverageGroup {
  key: string;
  primary: string;
  parent?: string;
  totalCases: number;
  scriptedCases: number;
  scriptedPct: number;
}

function lbl(s: string | null | undefined, fb: string): string {
  const v = (s || '').trim();
  return v.length > 0 ? v : fb;
}

function rollupByModule(runs: TestRunRow[]): CoverageGroup[] {
  const m = new Map<string, CoverageGroup>();
  for (const r of runs) {
    const key = lbl(r.module, 'Unclassified');
    const total = Number(r.test_case_count) || 0;
    const scripted = Number(r.scripted_count) || 0;
    const cur = m.get(key);
    if (cur) { cur.totalCases += total; cur.scriptedCases += scripted; }
    else m.set(key, { key, primary: key, totalCases: total, scriptedCases: scripted, scriptedPct: 0 });
  }
  return Array.from(m.values())
    .map((g) => ({ ...g, scriptedPct: g.totalCases > 0 ? Math.round((g.scriptedCases / g.totalCases) * 100) : 0 }))
    .sort((a, b) => b.totalCases - a.totalCases);
}

function rollupBySubmodule(runs: TestRunRow[]): CoverageGroup[] {
  const m = new Map<string, CoverageGroup>();
  for (const r of runs) {
    const parent = lbl(r.module, 'Unclassified');
    const sub = lbl(r.submodule, '(no submodule)');
    const key = `${parent} / ${sub}`;
    const total = Number(r.test_case_count) || 0;
    const scripted = Number(r.scripted_count) || 0;
    const cur = m.get(key);
    if (cur) { cur.totalCases += total; cur.scriptedCases += scripted; }
    else m.set(key, { key, primary: sub, parent, totalCases: total, scriptedCases: scripted, scriptedPct: 0 });
  }
  return Array.from(m.values())
    .map((g) => ({ ...g, scriptedPct: g.totalCases > 0 ? Math.round((g.scriptedCases / g.totalCases) * 100) : 0 }))
    .sort((a, b) => {
      const p = (a.parent || '').localeCompare(b.parent || '');
      return p !== 0 ? p : b.totalCases - a.totalCases;
    });
}

/* ──────────────────────────────────────────────────────────────────
   Component
   ────────────────────────────────────────────────────────────────── */
export default function DashboardPage() {
  const [summary, setSummary] = useState<ReportsSummary | null>(null);
  const [runs, setRuns] = useState<TestRunRow[]>([]);
  const [pipelineRuns, setPipelineRuns] = useState<PipelineRunRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [covTab, setCovTab] = useState<'module' | 'submodule'>('module');

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [summaryRes, runsRes, pipeRes] = await Promise.all([
          getReportsSummary().catch(() => null),
          listTestRuns({ page: 1, limit: 50 }).catch(() => ({ runs: [] })),
          listPipelineRuns().catch(() => ({ runs: [] })),
        ]);
        if (cancelled) return;
        setSummary(summaryRes);
        setRuns(runsRes.runs || []);
        setPipelineRuns(pipeRes.runs || []);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const totalCases = summary?.totalTestCases ?? runs.reduce((s, r) => s + (Number(r.test_case_count) || 0), 0);
  const totalScripted = useMemo(() => runs.reduce((s, r) => s + (Number(r.scripted_count) || 0), 0), [runs]);
  const automationCoverage = totalCases > 0 ? Math.round((totalScripted / totalCases) * 100) : 0;
  const executedCases = (summary?.statusDistribution || [])
    .filter((s) => s.name === 'passed' || s.name === 'failed' || s.name === 'executed')
    .reduce((sum, s) => sum + s.value, 0);
  const passedCases = (summary?.statusDistribution || []).find((s) => s.name === 'passed')?.value ?? 0;
  const passRate = executedCases > 0 ? Math.round((passedCases / executedCases) * 100) : 0;
  const activePipelines = pipelineRuns.filter((p) => p.status === 'running' || p.status === 'queued').length;
  const moduleCov = useMemo(() => rollupByModule(runs), [runs]);
  const submoduleCov = useMemo(() => rollupBySubmodule(runs), [runs]);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-32">
        <Loader2 className="w-4 h-4 text-[#155dfc] animate-spin" />
        <span className="ml-2 text-xs text-[#9CA3AF]">Loading…</span>
      </div>
    );
  }

  return (
    <div className="space-y-3 max-w-5xl">
      {/* ── KPI strip — one row, dividers between, very compact ── */}
      <section className="bg-white rounded-lg border border-[#E5E7EB] divide-x divide-[#F3F4F6] flex">
        <Kpi label="Test Cases" value={fmt(totalCases)} />
        <Kpi label="Pass Rate"  value={`${passRate}%`}
             tone={passRate >= 90 ? 'pos' : passRate >= 70 ? 'warn' : passRate > 0 ? 'neg' : 'mute'} />
        <Kpi label="Automation" value={`${automationCoverage}%`} />
        <Kpi label="Active"     value={fmt(activePipelines)} />
      </section>

      {/* ── Recent Test Runs ── */}
      <section className="bg-white rounded-lg border border-[#E5E7EB]">
        <header className="flex items-center justify-between px-4 py-2.5 border-b border-[#F3F4F6]">
          <h2 className="text-xs font-semibold text-[#1E1B4B] uppercase tracking-wider">Recent Runs</h2>
          <Link to="/generated-tests" className="text-[11px] text-[#155dfc] hover:underline inline-flex items-center gap-1">
            View all <ArrowRight className="w-3 h-3" />
          </Link>
        </header>
        {runs.length === 0 ? (
          <Empty text="No test runs yet." linkTo="/chat" linkText="Generate your first run" />
        ) : (
          <table className="w-full text-xs">
            <thead>
              <tr className="text-[10px] uppercase tracking-wider text-[#9CA3AF]">
                <th className="py-1.5 px-4 text-left font-medium">Feature / Story</th>
                <th className="py-1.5 px-2 text-left font-medium">Module</th>
                <th className="py-1.5 px-2 text-right font-medium">Cases</th>
                <th className="py-1.5 px-2 text-right font-medium">Scripted</th>
                <th className="py-1.5 px-4 text-right font-medium">When</th>
              </tr>
            </thead>
            <tbody>
              {runs.slice(0, 6).map((r) => {
                const total = Number(r.test_case_count) || 0;
                const scripted = Number(r.scripted_count) || 0;
                return (
                  <tr key={r.id} className="border-t border-[#F3F4F6]">
                    <td className="py-1.5 px-4 max-w-0">
                      <div className="text-[#1E1B4B] truncate" title={r.story_title || r.feature || ''}>
                        {r.story_title || r.feature || '—'}
                      </div>
                    </td>
                    <td className="py-1.5 px-2 text-[#6B7280] truncate max-w-[120px]">
                      {r.module || <span className="text-[#D1D5DB]">—</span>}
                    </td>
                    <td className="py-1.5 px-2 text-right text-[#1E1B4B] tabular-nums">{total}</td>
                    <td className="py-1.5 px-2 text-right tabular-nums text-[#6B7280]">{scripted}</td>
                    <td className="py-1.5 px-4 text-right text-[#9CA3AF] tabular-nums">{rel(r.created_at)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </section>

      {/* ── Coverage Breakdown — Module / Submodule ── */}
      <section className="bg-white rounded-lg border border-[#E5E7EB]">
        <header className="flex items-center justify-between px-4 py-2.5 border-b border-[#F3F4F6]">
          <h2 className="text-xs font-semibold text-[#1E1B4B] uppercase tracking-wider">Coverage</h2>
          <div className="flex items-center gap-0.5 text-[11px]">
            <Tab active={covTab === 'module'} onClick={() => setCovTab('module')}>
              Module <span className="text-[10px] text-[#9CA3AF] ml-1 tabular-nums">{moduleCov.length}</span>
            </Tab>
            <Tab active={covTab === 'submodule'} onClick={() => setCovTab('submodule')}>
              Submodule <span className="text-[10px] text-[#9CA3AF] ml-1 tabular-nums">{submoduleCov.length}</span>
            </Tab>
          </div>
        </header>
        <div className="px-4 py-3">
          {covTab === 'module' && (
            moduleCov.length === 0
              ? <Empty text="No module data yet." />
              : <div className="space-y-1.5">
                  {moduleCov.slice(0, 8).map((g) => <Row key={g.key} cov={g} />)}
                  {moduleCov.length > 8 && <p className="text-[10px] text-[#9CA3AF] pt-1">+ {moduleCov.length - 8} more</p>}
                </div>
          )}
          {covTab === 'submodule' && (
            submoduleCov.length === 0
              ? <Empty text="No submodule data yet." />
              : <div className="space-y-1.5">
                  {submoduleCov.slice(0, 10).map((g) => <Row key={g.key} cov={g} showParent />)}
                  {submoduleCov.length > 10 && <p className="text-[10px] text-[#9CA3AF] pt-1">+ {submoduleCov.length - 10} more</p>}
                </div>
          )}
        </div>
      </section>
    </div>
  );
}

/* ──────────────────────────────────────────────────────────────────
   Sub-components — minimal
   ────────────────────────────────────────────────────────────────── */

function Kpi({
  label, value, tone,
}: {
  label: string;
  value: string;
  tone?: 'pos' | 'neg' | 'warn' | 'mute';
}) {
  const valueColor =
    tone === 'pos'  ? 'text-emerald-600' :
    tone === 'neg'  ? 'text-red-600' :
    tone === 'warn' ? 'text-amber-600' :
    tone === 'mute' ? 'text-[#9CA3AF]' :
                      'text-[#1E1B4B]';
  return (
    <div className="flex-1 px-4 py-3 min-w-0">
      <div className="text-[10px] uppercase tracking-wider text-[#9CA3AF] font-medium">{label}</div>
      <div className={`text-xl font-bold tabular-nums mt-0.5 ${valueColor}`}>{value}</div>
    </div>
  );
}

function Tab({
  active, onClick, children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={
        'px-2.5 py-1 rounded font-medium transition-colors ' +
        (active ? 'bg-[#EFF5FF] text-[#155dfc]' : 'text-[#6B7280] hover:text-[#1E1B4B]')
      }
    >
      {children}
    </button>
  );
}

function Row({ cov, showParent }: { cov: CoverageGroup; showParent?: boolean }) {
  const pct = cov.scriptedPct;
  const barColor = pct >= 80 ? '#16A34A' : pct >= 50 ? '#155dfc' : pct > 0 ? '#D97706' : '#E5E7EB';
  return (
    <div className="grid grid-cols-12 items-center gap-3 text-[11px]">
      <div className="col-span-4 min-w-0">
        {showParent && cov.parent && (
          <span className="text-[#9CA3AF] truncate mr-1" title={cov.parent}>{cov.parent} ·</span>
        )}
        <span className="text-[#1E1B4B]" title={cov.primary}>{cov.primary}</span>
      </div>
      <div className="col-span-6">
        <div className="h-1 bg-[#F3F4F6] rounded-full overflow-hidden">
          <div className="h-full rounded-full" style={{ width: `${pct}%`, background: barColor }} />
        </div>
      </div>
      <div className="col-span-2 text-right tabular-nums text-[#9CA3AF]">
        <span className="text-[#1E1B4B] font-medium">{pct}%</span>
        <span className="ml-1.5">{cov.scriptedCases}/{cov.totalCases}</span>
      </div>
    </div>
  );
}

function Empty({ text, linkTo, linkText }: { text: string; linkTo?: string; linkText?: string }) {
  return (
    <div className="text-center py-4 text-xs text-[#9CA3AF]">
      <div>{text}</div>
      {linkTo && linkText && (
        <Link to={linkTo} className="inline-block mt-1 text-[#155dfc] hover:underline">
          {linkText} →
        </Link>
      )}
    </div>
  );
}

/* Formatters */
function fmt(n: number): string {
  return Number.isFinite(n) ? Math.round(n).toLocaleString() : '0';
}
function rel(iso: string): string {
  try {
    const t = new Date(iso).getTime();
    const m = (Date.now() - t) / 60_000;
    if (m < 1) return 'now';
    if (m < 60) return `${Math.round(m)}m`;
    const h = m / 60;
    if (h < 24) return `${Math.round(h)}h`;
    const d = h / 24;
    if (d < 7) return `${Math.round(d)}d`;
    return new Date(iso).toLocaleDateString();
  } catch {
    return iso;
  }
}
