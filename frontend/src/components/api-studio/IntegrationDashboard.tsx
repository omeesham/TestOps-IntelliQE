/**
 * IntegrationDashboard — the unified integration dashboard (Module 7).
 *
 * One read-only view over the whole program: requirement counts (BRD/FRD/
 * manual), requirement coverage + orphans (from the integrated traceability
 * matrix), defect-automation stats (Jira + Azure), run success rates and
 * imports-by-method. A filterable coverage table (by source / status) and a CSV
 * export make it the reporting surface the integration spec asks for.
 *
 * Read-only and additive — it composes existing aggregates; no pipeline changes.
 */
import { useEffect, useMemo, useState } from 'react';
import {
  LayoutDashboard, X, RefreshCw, Loader2, AlertTriangle, Download, FileText, ClipboardCheck,
  ClipboardList, Bug, Target, Radar,
} from 'lucide-react';
import Spinner from '@/components/feedback/Spinner';
import {
  getIntegrationDashboard, listApiRuns,
  type IntegrationDashboard as Dash, type TraceSource, type TraceStatus,
} from '@/services/api';
import { CARD, STRIP, FIELD, LABEL, SECONDARY_BTN, THEAD } from './format';

const STATUS_STYLE: Record<TraceStatus, string> = {
  covered: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  partial: 'bg-amber-50 text-amber-700 border-amber-200',
  failing: 'bg-red-50 text-red-700 border-red-200',
  uncovered: 'bg-gray-100 text-gray-500 border-gray-200',
};
const SOURCE_STYLE: Record<TraceSource, string> = {
  brd: 'bg-[#F5F3FF] text-[#6D28D9] border-[#DDD6FE]',
  frd: 'bg-[#E0E7FF] text-[#4338CA] border-[#C7D2FE]',
  manual: 'bg-gray-100 text-gray-600 border-gray-200',
};

export default function IntegrationDashboard({ onClose }: { onClose: () => void }) {
  const [runs, setRuns] = useState<any[]>([]);
  const [runId, setRunId] = useState('');
  const [dash, setDash] = useState<Dash | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [srcFilter, setSrcFilter] = useState<TraceSource | 'all'>('all');
  const [statusFilter, setStatusFilter] = useState<TraceStatus | 'all'>('all');

  const load = async (rid?: string) => {
    setLoading(true); setError('');
    try { setDash(await getIntegrationDashboard(rid || undefined)); }
    catch (e: any) { setError(e?.response?.data?.error || e?.message || 'Could not load the dashboard.'); }
    finally { setLoading(false); }
  };

  useEffect(() => {
    void load();
    void listApiRuns(1, 20).then((r) => setRuns(Array.isArray(r?.items) ? r.items : [])).catch(() => { /* convenience */ });
  }, []);

  const filteredRows = useMemo(() => {
    if (!dash) return [];
    return dash.rows.filter((r) => (srcFilter === 'all' || r.source === srcFilter) && (statusFilter === 'all' || r.status === statusFilter));
  }, [dash, srcFilter, statusFilter]);

  const exportCsv = () => {
    if (!dash) return;
    const lines: string[] = [];
    lines.push('Integration dashboard export');
    lines.push(`Run,${csv(dash.runTitle || dash.runId || 'latest')}`);
    lines.push('');
    lines.push('Metric,Value');
    lines.push(`Runs,${dash.kpis.runs}`);
    lines.push(`Avg pass rate %,${dash.kpis.avgPassRate ?? ''}`);
    lines.push(`Last pass rate %,${dash.kpis.lastPassRate ?? ''}`);
    lines.push(`Requirements (total),${dash.requirements.total}`);
    lines.push(`BRD docs,${dash.requirements.brdDocs}`);
    lines.push(`BRD requirements,${dash.requirements.brdReqs}`);
    lines.push(`FRD docs,${dash.requirements.frdDocs}`);
    lines.push(`FRD requirements,${dash.requirements.frdReqs}`);
    lines.push(`Manual requirements,${dash.requirements.manual}`);
    lines.push(`Coverage %,${dash.coverage.coveragePct}`);
    lines.push(`Covered,${dash.coverage.covered}`);
    lines.push(`Partial,${dash.coverage.partial}`);
    lines.push(`Failing,${dash.coverage.failing}`);
    lines.push(`Uncovered,${dash.coverage.uncovered}`);
    lines.push(`Tracker defects,${dash.defects.links}`);
    lines.push(`Open defects,${dash.defects.open}`);
    lines.push(`Jira defect links,${dash.defects.byProvider.jira}`);
    lines.push(`Azure defect links,${dash.defects.byProvider.azure}`);
    lines.push(`Defect sync runs,${dash.defects.syncRuns}`);
    lines.push(`Defects created,${dash.defects.created}`);
    lines.push(`Defects updated,${dash.defects.updated}`);
    lines.push(`Orphan tests,${dash.orphanTests}`);
    lines.push(`Orphan defects,${dash.orphanDefects}`);
    lines.push('');
    lines.push('Source,Key,Requirement,Endpoints,Status,Passed,Failed,NotRun,TrackerDefects');
    for (const r of dash.rows) {
      lines.push([r.source, csv(r.reqKey), csv(r.title), r.endpoints.length, r.status, r.passed, r.failed, r.notRun, r.trackerDefects.length].join(','));
    }
    const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `integration-dashboard-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click(); URL.revokeObjectURL(url);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-[#1E1B4B]/45 backdrop-blur-md p-4" onClick={onClose}>
      <div className={`${CARD} w-full max-w-5xl h-[88vh] flex flex-col overflow-hidden`} onClick={(e) => e.stopPropagation()}>
        <div className={`flex items-center gap-2 px-4 h-12 border-b border-[#EDE9FE] flex-shrink-0 ${STRIP}`}>
          <LayoutDashboard className="w-4 h-4 text-[#7C3AED]" />
          <h3 className="text-[13px] font-semibold text-gray-900">Integration dashboard</h3>
          <span className="text-[11px] text-gray-400">requirements · coverage · defects · runs</span>
          <button type="button" onClick={onClose} className="ml-auto p-1.5 rounded-md text-gray-400 hover:text-[#7C3AED] hover:bg-[#F5F3FF]"><X className="w-4 h-4" /></button>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto p-5 space-y-5">
          {/* Controls */}
          <div className="flex flex-wrap items-end gap-2">
            <div className="min-w-[200px]">
              <label className={LABEL}>Coverage against run</label>
              <select value={runId} onChange={(e) => { setRunId(e.target.value); void load(e.target.value); }} className={FIELD}>
                <option value="">Latest run</option>
                {runs.map((r, i) => <option key={r.runId ?? i} value={String(r.runId ?? '')}>{r.title || r.runId || 'Run'}</option>)}
              </select>
            </div>
            <button type="button" onClick={() => void load(runId)} disabled={loading} className={SECONDARY_BTN}>
              {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}Refresh
            </button>
            <button type="button" onClick={exportCsv} disabled={!dash} className={`${SECONDARY_BTN} ml-auto`}>
              <Download className="w-3.5 h-3.5" />Export CSV
            </button>
          </div>

          {error && <div className="flex items-start gap-2 px-4 py-2.5 bg-red-50 border border-red-200 rounded-lg"><AlertTriangle className="w-4 h-4 text-red-500 flex-shrink-0 mt-px" /><p className="text-[12px] text-red-700 min-w-0">{error}</p></div>}

          {loading && !dash ? (
            <div className="flex items-center justify-center py-16 text-gray-400"><Spinner className="w-5 h-5 animate-spin" /></div>
          ) : dash ? (
            <>
              {/* KPI tiles */}
              <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
                <Kpi icon={Target} label="Coverage" value={`${dash.kpis.coveragePct}%`} accent="#10B981" />
                <Kpi icon={ClipboardCheck} label="Requirements" value={dash.kpis.requirements} accent="#6366F1" />
                <Kpi icon={Bug} label="Tracker defects" value={dash.kpis.trackerDefects} sub={`${dash.kpis.openDefects} open`} accent="#F43F5E" />
                <Kpi icon={Radar} label="Orphan tests" value={dash.kpis.orphanTests} accent="#F59E0B" />
                <Kpi icon={LayoutDashboard} label="Runs" value={dash.kpis.runs} accent="#7C3AED" />
                <Kpi icon={Target} label="Avg pass rate" value={dash.kpis.avgPassRate != null ? `${dash.kpis.avgPassRate}%` : '—'} accent="#0EA5E9" />
                <Kpi icon={Target} label="Last pass rate" value={dash.kpis.lastPassRate != null ? `${dash.kpis.lastPassRate}%` : '—'} accent="#0EA5E9" />
                <Kpi icon={FileText} label="Imports" value={dash.imports.total} accent="#8B5CF6" />
              </div>

              {/* Requirements + coverage + defects */}
              <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
                <Panel title="Requirements" icon={ClipboardList}>
                  <Row label="BRD documents" value={dash.requirements.brdDocs} />
                  <Row label="Business requirements" value={dash.requirements.brdReqs} />
                  <Row label="FRD documents" value={dash.requirements.frdDocs} />
                  <Row label="Functional requirements" value={dash.requirements.frdReqs} />
                  <Row label="Manual requirements" value={dash.requirements.manual} />
                </Panel>
                <Panel title="Coverage" icon={Target}>
                  <CoverageBar c={dash.coverage} />
                  <Row label="Covered" value={dash.coverage.covered} tone="good" />
                  <Row label="Partial" value={dash.coverage.partial} tone="warn" />
                  <Row label="Failing" value={dash.coverage.failing} tone="bad" />
                  <Row label="Uncovered" value={dash.coverage.uncovered} />
                </Panel>
                <Panel title="Defect automation" icon={Bug}>
                  <Row label="Defect links" value={dash.defects.links} />
                  <Row label="Open" value={dash.defects.open} tone="bad" />
                  <Row label="Jira / Azure" value={`${dash.defects.byProvider.jira} / ${dash.defects.byProvider.azure}`} />
                  <Row label="Sync runs" value={dash.defects.syncRuns} />
                  <Row label="Created / updated" value={`${dash.defects.created} / ${dash.defects.updated}`} />
                </Panel>
              </div>

              {/* Coverage table with filters */}
              <div className={`${CARD} p-3 space-y-2`}>
                <div className="flex flex-wrap items-center gap-2">
                  <h4 className="text-[12px] font-bold text-gray-800">Requirement coverage</h4>
                  <select value={srcFilter} onChange={(e) => setSrcFilter(e.target.value as any)} className={`${FIELD} ml-auto w-32`}>
                    <option value="all">All sources</option>
                    <option value="brd">BRD</option>
                    <option value="frd">FRD</option>
                    <option value="manual">Manual</option>
                  </select>
                  <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as any)} className={`${FIELD} w-32`}>
                    <option value="all">All statuses</option>
                    <option value="covered">Covered</option>
                    <option value="partial">Partial</option>
                    <option value="failing">Failing</option>
                    <option value="uncovered">Uncovered</option>
                  </select>
                </div>
                <div className="border border-[#E9E5FB] rounded-lg overflow-hidden">
                  <table className="w-full text-[11.5px]">
                    <thead className={THEAD}><tr className="text-gray-500 text-left">
                      <th className="font-semibold px-2.5 py-1.5">Src</th>
                      <th className="font-semibold px-2.5 py-1.5">Requirement</th>
                      <th className="font-semibold px-2.5 py-1.5 text-right">EP</th>
                      <th className="font-semibold px-2.5 py-1.5">Status</th>
                      <th className="font-semibold px-2.5 py-1.5 text-right">Cases</th>
                      <th className="font-semibold px-2.5 py-1.5 text-right">Defects</th>
                    </tr></thead>
                    <tbody className="divide-y divide-gray-100">
                      {filteredRows.length === 0 && <tr><td colSpan={6} className="px-2.5 py-4 text-center text-gray-400">No requirements match the filter.</td></tr>}
                      {filteredRows.map((row, i) => (
                        <tr key={`${row.source}-${row.reqKey}-${i}`} className="align-top">
                          <td className="px-2.5 py-1.5"><span className={`inline-flex px-1.5 py-0.5 rounded border text-[9.5px] font-bold uppercase ${SOURCE_STYLE[row.source]}`}>{row.source}</span></td>
                          <td className="px-2.5 py-1.5"><span className="text-gray-700">{row.reqKey ? <b className="font-mono text-[#6D28D9]">{row.reqKey} </b> : null}{row.title}</span></td>
                          <td className="px-2.5 py-1.5 text-right font-mono tabular-nums text-gray-500">{row.endpoints.length}</td>
                          <td className="px-2.5 py-1.5"><span className={`inline-flex px-1.5 py-0.5 rounded border text-[10.5px] font-semibold ${STATUS_STYLE[row.status]}`}>{row.status}</span></td>
                          <td className="px-2.5 py-1.5 text-right font-mono tabular-nums text-gray-600">{row.passed}✓ {row.failed}✗ {row.notRun}·</td>
                          <td className="px-2.5 py-1.5 text-right font-mono tabular-nums">{row.trackerDefects.length || row.caseDefects.length ? <span className="text-red-600">{row.trackerDefects.length + row.caseDefects.length}</span> : <span className="text-gray-300">0</span>}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function Kpi({ icon: Icon, label, value, sub, accent }: { icon: React.ElementType; label: string; value: React.ReactNode; sub?: string; accent: string }) {
  return (
    <div className={`${CARD} p-3`}>
      <div className="flex items-center gap-1.5 mb-1"><Icon className="w-3.5 h-3.5 flex-shrink-0" style={{ color: accent }} /><span className="text-[10.5px] font-semibold uppercase tracking-wide text-gray-500">{label}</span></div>
      <div className="text-[20px] font-bold text-gray-900 tabular-nums leading-none">{value}</div>
      {sub && <div className="text-[10.5px] text-gray-400 mt-0.5">{sub}</div>}
    </div>
  );
}

function Panel({ title, icon: Icon, children }: { title: string; icon: React.ElementType; children: React.ReactNode }) {
  return (
    <div className={`${CARD} p-3`}>
      <div className="flex items-center gap-1.5 mb-2"><Icon className="w-3.5 h-3.5 text-[#7C3AED]" /><h4 className="text-[12px] font-bold text-gray-800">{title}</h4></div>
      <div className="space-y-1">{children}</div>
    </div>
  );
}

function Row({ label, value, tone }: { label: string; value: React.ReactNode; tone?: 'good' | 'warn' | 'bad' }) {
  const color = tone === 'good' ? 'text-emerald-600' : tone === 'warn' ? 'text-amber-600' : tone === 'bad' ? 'text-red-600' : 'text-gray-800';
  return <div className="flex items-center justify-between text-[11.5px]"><span className="text-gray-500">{label}</span><span className={`font-semibold tabular-nums ${color}`}>{value}</span></div>;
}

function CoverageBar({ c }: { c: Dash['coverage'] }) {
  const total = Math.max(1, c.covered + c.partial + c.failing + c.uncovered);
  const seg = (n: number, cls: string) => n > 0 ? <div className={cls} style={{ width: `${(n / total) * 100}%` }} /> : null;
  return (
    <div className="flex h-2 rounded-full overflow-hidden bg-gray-100 mb-2">
      {seg(c.covered, 'bg-emerald-500')}
      {seg(c.partial, 'bg-amber-500')}
      {seg(c.failing, 'bg-red-500')}
      {seg(c.uncovered, 'bg-gray-300')}
    </div>
  );
}

function csv(v: unknown): string {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
