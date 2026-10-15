/**
 * API Studio — the report tab.
 *
 * What the run proved, in the order someone asks it: did it pass, what's the
 * shape of the result, then every scenario it ran — filterable and openable so
 * a passing run is as inspectable as a failing one. Counts come straight from
 * the execution details; a scenario the runner never reached is "not run",
 * never folded into passed or failed.
 *
 * One cohesive page: a verdict hero (ring + bar + compact counters in a single
 * card) over a results table that fills the space on a green run as well as a
 * red one — no empty canvas when nothing failed. The failure triage (AI
 * "Explain", root-cause grouping) and healing notes live inline on the rows
 * they belong to, so there's one list to read instead of three stacked panels.
 */
import { Fragment, useMemo, useState } from 'react';
import {
  BarChart3, ExternalLink, Download, CheckCircle2, XCircle, MinusCircle, Wrench,
  GitBranch, AlertTriangle, Sparkles, Layers, Clock, Search, ChevronRight,
} from 'lucide-react';
import Spinner from '@/components/feedback/Spinner';
import { EmptyState, MethodBadge, CategoryChip, PriorityChip, StatusPill, PassRing, FilterChip, TabHero } from './primitives';
import { formatDuration, CARD, STRIP, THEAD, TILE_ACTIVE, FIELD, PRIMARY_BTN, SECONDARY_BTN } from './format';
import Diagnose, { type FailurePayload } from './Diagnose';
import FailureClusters, { type ClusterFailureInput } from './FailureClusters';
import type { RunReport, RunRow, Scenario, PushState } from './types';

/**
 * The report toolbar's "Push to repo" button is hidden for now. This hides only
 * the button — the push feature itself is untouched: the `onPushToRepo` handler,
 * the useApiRun hook, the backend push, the push-outcome banner below, and the
 * separate "Push to repo" control on the StageRail all still work. Flip to
 * `true` to restore the button here.
 */
const SHOW_PUSH_TO_REPO = false;

interface Props {
  report: RunReport | null;
  rows: RunRow[];
  scenarios: Scenario[];
  onExport: (format: 'excel' | 'json') => void;
  exporting: boolean;
  canExport: boolean;
  /** Commit the generated specs to the connected code repository. */
  onPushToRepo: () => void;
  pushState: PushState;
  /** False when the run produced no specs to push. */
  canPush: boolean;
}

/** Fold the raw status onto the three outcomes the table shows. */
function normStatus(s: string): 'passed' | 'failed' | 'not_run' {
  if (s === 'passed') return 'passed';
  if (s === 'failed' || s === 'broken') return 'failed';
  return 'not_run';
}

type Bucket = 'all' | 'passed' | 'failed' | 'not_run';

/** One row of the results table, joined from the run row and its scenario. */
interface ResultRow {
  id: string;
  title: string;
  method: string;
  endpoint: string;
  type: string;
  priority: string;
  status: 'passed' | 'failed' | 'not_run';
  duration: string;
  error?: string;
  healed?: boolean;
  healNote?: string;
  expectedStatus?: string;
  requestBody?: string;
}

export default function ReportTab({
  report, rows, scenarios, onExport, exporting, canExport,
  onPushToRepo, pushState, canPush,
}: Props) {
  const [diagnoseFor, setDiagnoseFor] = useState<FailurePayload | null>(null);
  const [clustersFor, setClustersFor] = useState<ClusterFailureInput[] | null>(null);
  const [bucket, setBucket] = useState<Bucket>('all');
  const [q, setQ] = useState('');
  const [expanded, setExpanded] = useState<string | null>(null);

  const byId = useMemo(() => new Map(scenarios.map((s) => [s.id, s])), [scenarios]);
  const results = useMemo<ResultRow[]>(() => rows.map((r) => {
    const sc = byId.get(r.testCaseId);
    return {
      id: r.testCaseId,
      title: sc?.title || r.name,
      method: sc?.api?.method || '',
      endpoint: sc?.api?.endpoint || '',
      type: sc?.type || 'other',
      priority: sc?.priority || 'P2',
      status: normStatus(r.status),
      duration: r.duration,
      error: r.error,
      healed: r.healed,
      healNote: r.healNote,
      expectedStatus: sc?.api?.expectedStatus,
      requestBody: sc?.api?.requestBody,
    };
  }), [rows, byId]);

  const counts = useMemo(() => {
    const c = { all: results.length, passed: 0, failed: 0, not_run: 0 };
    for (const r of results) c[r.status]++;
    return c;
  }, [results]);
  const visible = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return results.filter((r) => {
      if (bucket !== 'all' && r.status !== bucket) return false;
      if (!needle) return true;
      return r.title.toLowerCase().includes(needle) || r.id.toLowerCase().includes(needle) || r.endpoint.toLowerCase().includes(needle);
    });
  }, [results, bucket, q]);

  const failedRows = useMemo(() => results.filter((r) => r.status === 'failed'), [results]);

  if (!report) {
    return <EmptyState icon={BarChart3} title="No report yet" hint="Run a suite and its report lands here — the verdict, the breakdown, and every scenario it executed." />;
  }

  const green = report.failed === 0 && report.notRun === 0 && report.total > 0;
  // The verdict hero wears the run's health as a top accent + faint wash, so the
  // outcome reads before any number — the same language as the Overview KPIs.
  const heroTone = report.total === 0 ? 'neutral' : green ? 'good' : report.passRate >= 70 ? 'warn' : 'bad';
  const heroAccent = { good: 'from-emerald-400 to-emerald-500', warn: 'from-amber-400 to-amber-500', bad: 'from-red-400 to-red-500', neutral: 'from-[#7C3AED] to-[#6366F1]' }[heroTone];
  const heroWash = { good: 'from-emerald-50/70', warn: 'from-amber-50/70', bad: 'from-red-50/60', neutral: 'from-[#F5F3FF]' }[heroTone];
  const explain = (r: ResultRow) => setDiagnoseFor({
    title: r.title, method: r.method || 'GET', url: r.endpoint,
    error: r.error || '', expectedStatus: r.expectedStatus ? Number(r.expectedStatus) || undefined : undefined, requestBody: r.requestBody,
  });

  return (
    <div className="h-full overflow-y-auto min-h-0">
      <div className="max-w-5xl mx-auto p-5 space-y-3">

        <TabHero icon={BarChart3} title="Run report" subtitle={`${report.passed} of ${report.total} passed · ${report.passRate}% pass rate · ${formatDuration(report.durationMs)}`} />

        {/* ── Verdict hero — ring, verdict, actions, bar and counters in one card ── */}
        <section className={`${CARD} relative overflow-hidden p-5 pt-6`}>
          <span className={`absolute inset-x-0 top-0 h-1 bg-gradient-to-r ${heroAccent}`} />
          <span className={`pointer-events-none absolute inset-0 bg-gradient-to-br ${heroWash} to-transparent to-55%`} />
          <div className="relative flex items-center gap-4 flex-wrap">
            {report.total > 0
              ? <span className="flex-shrink-0"><PassRing value={report.passRate} size={66} /></span>
              : <span className={`w-12 h-12 rounded-xl flex items-center justify-center ${TILE_ACTIVE}`}><BarChart3 className="w-5 h-5 text-white" /></span>}
            <div className="min-w-0">
              <h2 className="text-[18px] font-bold text-gray-900 leading-tight">
                {green ? `All ${report.total} scenarios passed` : `${report.passed} of ${report.total} scenarios passed`}
              </h2>
              <p className="text-[12.5px] mt-0.5">
                <span className={`font-semibold ${green ? 'text-emerald-600' : report.passRate >= 70 ? 'text-amber-600' : 'text-red-600'}`}>{report.passRate}% pass rate</span>
                <span className="text-gray-500"> · {formatDuration(report.durationMs)}</span>
              </p>
            </div>
            <div className="ml-auto flex items-center gap-2 flex-shrink-0">
              {report.reportUrl && (
                <a href={report.reportUrl} target="_blank" rel="noopener noreferrer" className={PRIMARY_BTN}><ExternalLink className="w-3.5 h-3.5" />HTML report</a>
              )}
              {SHOW_PUSH_TO_REPO && (
                <button type="button" onClick={onPushToRepo} disabled={!canPush || pushState.status === 'pushing'} className={SECONDARY_BTN}>
                  {pushState.status === 'pushing' ? <Spinner className="w-3.5 h-3.5 animate-spin" /> : <GitBranch className="w-3.5 h-3.5" />}
                  {pushState.status === 'pushing' ? 'Pushing…' : 'Push to repo'}
                </button>
              )}
              <button type="button" onClick={() => onExport('excel')} disabled={exporting || !canExport} className={SECONDARY_BTN}>
                {exporting ? <Spinner className="w-3.5 h-3.5 animate-spin" /> : <Download className="w-3.5 h-3.5" />}CSV
              </button>
              <button type="button" onClick={() => onExport('json')} disabled={exporting || !canExport} className={SECONDARY_BTN}><Download className="w-3.5 h-3.5" />JSON</button>
            </div>
          </div>

          {/* Proportional bar — the shape of the run at a glance */}
          <div className="mt-4 flex h-2 rounded-full overflow-hidden bg-gray-200">
            {report.passed > 0 && <div className="bg-emerald-500" style={{ width: `${(report.passed / report.total) * 100}%` }} title={`Passed · ${report.passed}`} />}
            {report.failed > 0 && <div className="bg-red-500" style={{ width: `${(report.failed / report.total) * 100}%` }} title={`Failed · ${report.failed}`} />}
            {report.notRun > 0 && <div className="bg-gray-400" style={{ width: `${(report.notRun / report.total) * 100}%` }} title={`Not run · ${report.notRun}`} />}
          </div>

          {/* Compact counter strip — the five numbers, without five floating cards */}
          <div className="mt-3 flex items-center gap-x-6 gap-y-2 flex-wrap">
            <Counter icon={CheckCircle2} label="Passed" value={report.passed} cls="text-emerald-600" />
            <Counter icon={XCircle} label="Failed" value={report.failed} cls={report.failed ? 'text-red-600' : 'text-gray-400'} />
            <Counter icon={MinusCircle} label="Not run" value={report.notRun} cls="text-gray-400" />
            <Counter icon={Wrench} label="Healed" value={report.healed} cls={report.healed ? 'text-[#7C3AED]' : 'text-gray-400'} />
            <Counter icon={Clock} label="Duration" value={formatDuration(report.durationMs)} cls="text-gray-700" />
          </div>
        </section>

        {/* Outcome of a push — a link to what it produced, or why it failed. */}
        {pushState.status === 'done' && (
          <div className="flex items-center gap-2 text-[12px] bg-emerald-50 border border-emerald-200 rounded-lg px-3 py-2">
            <CheckCircle2 className="w-4 h-4 text-emerald-600 flex-shrink-0" />
            <span className="text-emerald-800 min-w-0">
              {pushState.mode === 'pr' ? 'Pull request opened' : 'Committed'} on <span className="font-mono font-medium">{pushState.branch}</span>
              {pushState.repo && <> in <span className="font-medium">{pushState.repo}</span></>}{' · '}{pushState.fileCount} file{pushState.fileCount === 1 ? '' : 's'}
            </span>
            <a href={pushState.url} target="_blank" rel="noopener noreferrer" className="ml-auto inline-flex items-center gap-1 font-medium text-emerald-700 hover:text-emerald-900 flex-shrink-0"><ExternalLink className="w-3.5 h-3.5" />{pushState.mode === 'pr' ? 'View pull request' : 'View branch'}</a>
          </div>
        )}
        {pushState.status === 'error' && (
          <div className="flex items-start gap-2 text-[12px] bg-red-50 border border-red-200 rounded-lg px-3 py-2">
            <AlertTriangle className="w-4 h-4 text-red-500 flex-shrink-0 mt-px" /><span className="text-red-700 min-w-0">{pushState.error}</span>
          </div>
        )}

        {/* ── Results — every scenario the run executed, filterable and openable ── */}
        <section className={`${CARD} overflow-hidden`}>
          <div className={`flex items-center gap-1.5 flex-wrap px-4 h-11 border-b border-[#EDE9FE] ${STRIP}`}>
            <h3 className="text-[12.5px] font-semibold text-gray-900">Results</h3>
            <span className="text-[11px] text-gray-400 tabular-nums">{results.length}</span>
            <div className="w-px h-4 bg-gray-200 mx-1" />
            <FilterChip active={bucket === 'all'} onClick={() => setBucket('all')} count={counts.all}>All</FilterChip>
            <FilterChip active={bucket === 'passed'} onClick={() => setBucket('passed')} count={counts.passed}>Passed</FilterChip>
            <FilterChip active={bucket === 'failed'} onClick={() => setBucket('failed')} count={counts.failed} tone="danger">Failed</FilterChip>
            {counts.not_run > 0 && <FilterChip active={bucket === 'not_run'} onClick={() => setBucket('not_run')} count={counts.not_run}>Not run</FilterChip>}
            <div className="ml-auto flex items-center gap-2">
              {failedRows.length > 1 && (
                <button
                  type="button"
                  onClick={() => setClustersFor(failedRows.map((r) => ({ title: r.title, method: r.method, url: r.endpoint, error: r.error || '', status: r.expectedStatus ? Number(r.expectedStatus) || undefined : undefined })))}
                  title="Group similar failures by root cause"
                  className="inline-flex items-center gap-1 px-2 py-1 rounded-md border border-[#DDD6FE] text-[11px] font-semibold text-[#6D28D9] bg-[#F5F3FF] hover:bg-[#EDE9FE] transition-colors"
                ><Layers className="w-3 h-3" />Group ({failedRows.length})</button>
              )}
              <div className="relative">
                <Search className="w-3 h-3 text-gray-300 absolute left-2 top-1/2 -translate-y-1/2 pointer-events-none" />
                <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search scenarios…" className={`${FIELD} w-48 pl-6 py-1`} />
              </div>
            </div>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[720px] text-[12px]">
              <thead className={`text-[10.5px] uppercase tracking-wide text-gray-500 ${THEAD}`}><tr><th className="w-7" /><th className="text-left px-2 py-1.5 font-semibold w-[84px]">Case</th><th className="text-left px-2 py-1.5 font-semibold">Scenario</th><th className="text-left px-2 py-1.5 font-semibold w-[90px]">Layer</th><th className="text-left px-2 py-1.5 font-semibold w-[50px]">Pri</th><th className="text-left px-2 py-1.5 font-semibold w-[110px]">Status</th><th className="text-right px-4 py-1.5 font-semibold w-[80px]">Time</th></tr></thead>
              <tbody>
                {visible.map((r) => (
                  <ResultRowView key={r.id} r={r} open={expanded === r.id} onToggle={() => setExpanded(expanded === r.id ? null : r.id)} onExplain={() => explain(r)} />
                ))}
              </tbody>
            </table>
          </div>
          {results.length > 0 && visible.length === 0 && (
            <p className="px-4 py-8 text-center text-[12px] text-gray-400">No scenarios match that filter.</p>
          )}
          {results.length === 0 && (
            <p className="px-4 py-8 text-center text-[12px] text-gray-400">This run recorded no per-scenario results.</p>
          )}
        </section>
      </div>

      {diagnoseFor && <Diagnose failure={diagnoseFor} onClose={() => setDiagnoseFor(null)} />}
      {clustersFor && <FailureClusters failures={clustersFor} onClose={() => setClustersFor(null)} />}
    </div>
  );
}

/** One compact figure in the hero's counter strip. */
function Counter({ icon: Icon, label, value, cls }: { icon: React.ElementType; label: string; value: string | number; cls: string }) {
  return (
    <div className="flex items-center gap-1.5">
      <Icon className={`w-4 h-4 ${cls}`} />
      <span className={`text-[16px] font-bold tabular-nums leading-none ${cls}`}>{value}</span>
      <span className="text-[11px] font-medium uppercase tracking-wide text-gray-400">{label}</span>
    </div>
  );
}

/** One results row — opens to show its request, any failure, and healing notes. */
function ResultRowView({ r, open, onToggle, onExplain }: { r: ResultRow; open: boolean; onToggle: () => void; onExplain: () => void }) {
  const stripe = r.status === 'failed' ? 'shadow-[inset_3px_0_0_0_#F87171]' : open ? 'shadow-[inset_3px_0_0_0_#C4B5FD]' : '';
  const hasDetail = !!(r.error || r.endpoint || r.healNote);
  return (
    <Fragment>
      <tr onClick={hasDetail ? onToggle : undefined} className={`border-t border-gray-50 align-top transition-colors ${hasDetail ? 'cursor-pointer hover:bg-[#FAFAFE]' : ''} ${open ? 'bg-[#F5F3FF]' : ''} ${stripe}`}>
        <td className="pl-3 py-1.5 text-gray-300">{hasDetail && <ChevronRight className={`w-3.5 h-3.5 transition-transform ${open ? 'rotate-90 text-[#7C3AED]' : ''}`} />}</td>
        <td className="px-2 py-1.5 font-mono text-[11px] text-gray-500">{r.id}</td>
        <td className="px-2 py-1.5">
          <div className="flex items-center gap-1.5">{r.method && <MethodBadge method={r.method} />}<span className="text-gray-800">{r.title}</span>{r.healed && <span className="inline-flex items-center gap-0.5 px-1 py-px rounded text-[9.5px] font-semibold text-[#6D28D9] bg-[#F5F3FF] border border-[#DDD6FE]"><Wrench className="w-2.5 h-2.5" />healed</span>}</div>
          {r.endpoint && <p className="font-mono text-[10.5px] text-gray-400 truncate max-w-[520px]">{r.endpoint}</p>}
        </td>
        <td className="px-2 py-1.5"><CategoryChip type={r.type} /></td>
        <td className="px-2 py-1.5"><PriorityChip priority={r.priority} /></td>
        <td className="px-2 py-1.5"><StatusPill status={r.status} /></td>
        <td className="px-4 py-1.5 text-right font-mono text-[11px] text-gray-500 tabular-nums">{r.duration || '—'}</td>
      </tr>
      {open && hasDetail && (
        <tr className="border-t border-gray-100 bg-[#FAFAFE]">
          <td />
          <td colSpan={6} className="px-2 py-3 pr-4 space-y-2">
            {r.endpoint && (
              <div className="flex items-center gap-1.5 flex-wrap">
                <span className="text-[10px] font-semibold uppercase tracking-wide text-gray-400">Request</span>
                {r.method && <MethodBadge method={r.method} />}
                <span className="font-mono text-[11px] text-gray-700 break-all">{r.endpoint}</span>
                {r.expectedStatus && <span className="text-[10px] text-gray-400">expects {r.expectedStatus}</span>}
              </div>
            )}
            {r.error ? (
              <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2">
                <div className="flex items-center justify-between gap-2 mb-1">
                  <div className="flex items-center gap-1.5"><AlertTriangle className="w-3.5 h-3.5 text-red-500" /><span className="text-[10px] font-semibold uppercase tracking-wide text-red-600">Failure</span></div>
                  <button type="button" onClick={(e) => { e.stopPropagation(); onExplain(); }} title="AI root-cause analysis" className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded border border-[#DDD6FE] text-[10px] font-semibold text-[#6D28D9] bg-white hover:bg-[#F5F3FF] transition-colors"><Sparkles className="w-2.5 h-2.5" />Explain</button>
                </div>
                <p className="text-[11px] text-red-700 font-mono whitespace-pre-wrap break-words">{r.error}</p>
              </div>
            ) : r.status === 'failed' ? (
              <p className="text-[11px] text-red-600 flex items-center gap-1.5"><AlertTriangle className="w-3.5 h-3.5" />Failed — no error detail was captured. Open the HTML report for the full trace.</p>
            ) : r.status === 'not_run' ? (
              <p className="text-[11px] text-gray-500 flex items-center gap-1.5"><MinusCircle className="w-3.5 h-3.5" />Not run — this scenario was skipped in this run.</p>
            ) : (
              <p className="text-[11px] text-emerald-700 flex items-center gap-1.5"><CheckCircle2 className="w-3.5 h-3.5" />Passed — the response met every assertion.</p>
            )}
            {r.healNote && (
              <div className="flex items-start gap-1.5 text-[11px] text-[#6D28D9] bg-[#F5F3FF] border border-[#DDD6FE] rounded-lg px-3 py-2">
                <Wrench className="w-3.5 h-3.5 flex-shrink-0 mt-px" /><span className="min-w-0"><span className="font-semibold">{r.healed ? 'Repaired' : 'Reviewed'}:</span> {r.healNote}</span>
              </div>
            )}
          </td>
        </tr>
      )}
    </Fragment>
  );
}
