/**
 * API Studio — the report tab.
 *
 * What the run proved, in the order someone asks it: did it pass, what failed,
 * what did healing do, and where is the full report. Counts come straight from
 * the execution details — a scenario the runner never reached is reported as
 * "not run", never folded into either passed or failed.
 */
import { useState } from 'react';
import {
  BarChart3, ExternalLink, Download, CheckCircle2, XCircle, MinusCircle, Wrench,
  GitBranch, AlertTriangle, Sparkles, Layers,
} from 'lucide-react';
import Spinner from '@/components/feedback/Spinner';
import { EmptyState, MethodBadge } from './primitives';
import { formatDuration, CARD, CARD_HOVER, TILE_ACTIVE, PRIMARY_BTN, SECONDARY_BTN } from './format';
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

function Stat({
  label, value, tone, icon: Icon,
}: {
  label: string; value: string | number; tone: 'neutral' | 'good' | 'bad' | 'muted' | 'accent'; icon: React.ElementType;
}) {
  const valueCls = {
    neutral: 'text-gray-900',
    good: 'text-emerald-600',
    bad: 'text-red-600',
    muted: 'text-gray-400',
    accent: 'text-[#7C3AED]',
  }[tone];
  return (
    <div className={`${CARD_HOVER} p-4`}>
      <div className="flex items-center gap-1.5 text-[10.5px] font-semibold uppercase tracking-wide text-gray-500">
        <Icon className="w-3.5 h-3.5 text-[#7C3AED]" />{label}
      </div>
      <div className={`mt-3 text-[28px] font-bold tabular-nums leading-none ${valueCls}`}>{value}</div>
    </div>
  );
}

export default function ReportTab({
  report, rows, scenarios, onExport, exporting, canExport,
  onPushToRepo, pushState, canPush,
}: Props) {
  const [diagnoseFor, setDiagnoseFor] = useState<FailurePayload | null>(null);
  const [clustersFor, setClustersFor] = useState<ClusterFailureInput[] | null>(null);
  if (!report) {
    return (
      <EmptyState
        icon={BarChart3}
        title="No report yet"
      />
    );
  }

  const byId = new Map(scenarios.map((s) => [s.id, s]));
  const failures = rows.filter((r) => r.status === 'failed');
  const notRun = rows.filter((r) => r.status === 'not_run');
  const healNotes = rows.filter((r) => r.healNote);
  const green = report.failed === 0 && report.notRun === 0 && report.total > 0;

  return (
    <div className="h-full overflow-y-auto min-h-0">
      <div className="max-w-4xl mx-auto p-5 space-y-4">
        {/* Verdict header */}
        <div className="flex items-center gap-4 flex-wrap">
          <span className={`w-11 h-11 rounded-xl flex items-center justify-center ${TILE_ACTIVE}`}>
            {green ? <CheckCircle2 className="w-5 h-5 text-white" /> : <BarChart3 className="w-5 h-5 text-white" />}
          </span>
          <div className="min-w-0">
            <h2 className="text-[17px] font-bold text-gray-900 leading-tight">
              {green
                ? `All ${report.total} scenarios passed`
                : `${report.passed} of ${report.total} scenarios passed`}
            </h2>
            <p className="text-[12.5px] mt-0.5">
              <span className={`font-semibold ${green ? 'text-emerald-600' : report.passRate >= 50 ? 'text-[#7C3AED]' : 'text-red-600'}`}>{report.passRate}% pass rate</span>
              <span className="text-gray-500"> · {formatDuration(report.durationMs)}</span>
            </p>
          </div>
          <div className="ml-auto flex items-center gap-2">
            {report.reportUrl && (
              <a
                href={report.reportUrl}
                target="_blank"
                rel="noopener noreferrer"
                className={PRIMARY_BTN}
              >
                <ExternalLink className="w-3.5 h-3.5" />HTML report
              </a>
            )}
            {/* Push to repo — commit the generated specs to the connected repository.
                Hidden here via SHOW_PUSH_TO_REPO; the push feature itself is intact. */}
            {SHOW_PUSH_TO_REPO && (
              <button
                type="button"
                onClick={onPushToRepo}
                disabled={!canPush || pushState.status === 'pushing'}
                title={canPush
                  ? 'Commit the generated specs to the repository connected under System Configuration → Code Repositories'
                  : 'There are no generated specs to push'}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-[12px] font-semibold text-white rounded-md transition-all disabled:opacity-40 disabled:cursor-not-allowed bg-gradient-to-b from-emerald-400 to-emerald-600 border border-emerald-500/50 ring-1 ring-inset ring-white/25 shadow-[inset_0_1px_0_rgba(255,255,255,0.35),0_3px_0_0_#047857,0_8px_18px_-6px_rgba(16,185,129,0.55)] hover:from-emerald-500 hover:to-emerald-700 hover:-translate-y-px active:translate-y-[2px] active:shadow-[inset_0_1px_0_rgba(255,255,255,0.35),0_0_0_0_#047857,0_4px_10px_-6px_rgba(16,185,129,0.5)] disabled:translate-y-0 disabled:shadow-[0_2px_0_0_#A7F3D0]"
              >
                {pushState.status === 'pushing'
                  ? <Spinner className="w-3.5 h-3.5 animate-spin" />
                  : <GitBranch className="w-3.5 h-3.5" />}
                {pushState.status === 'pushing' ? 'Pushing…' : 'Push to repo'}
              </button>
            )}
            <button
              type="button"
              onClick={() => onExport('excel')}
              disabled={exporting || !canExport}
              className={SECONDARY_BTN}
            >
              {exporting ? <Spinner className="w-3.5 h-3.5 animate-spin" /> : <Download className="w-3.5 h-3.5" />}
              Export (CSV)
            </button>
            <button
              type="button"
              onClick={() => onExport('json')}
              disabled={exporting || !canExport}
              className={SECONDARY_BTN}
            >
              <Download className="w-3.5 h-3.5" />Export (JSON)
            </button>
          </div>
        </div>

        {/* Proportional bar — the shape of the run at a glance */}
        <div className="flex h-2 rounded-full overflow-hidden bg-gray-200">
          {report.passed > 0 && <div className="bg-emerald-500" style={{ width: `${(report.passed / report.total) * 100}%` }} title={`Passed · ${report.passed}`} />}
          {report.failed > 0 && <div className="bg-red-500" style={{ width: `${(report.failed / report.total) * 100}%` }} title={`Failed · ${report.failed}`} />}
          {report.notRun > 0 && <div className="bg-gray-400" style={{ width: `${(report.notRun / report.total) * 100}%` }} title={`Not run · ${report.notRun}`} />}
        </div>

        {/* Counters */}
        <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-5 gap-3">
          <Stat label="Passed" value={report.passed} tone="good" icon={CheckCircle2} />
          <Stat label="Failed" value={report.failed} tone={report.failed ? 'bad' : 'muted'} icon={XCircle} />
          <Stat label="Not run" value={report.notRun} tone="muted" icon={MinusCircle} />
          <Stat label="Healed" value={report.healed} tone={report.healed ? 'accent' : 'muted'} icon={Wrench} />
          <Stat label="Duration" value={formatDuration(report.durationMs)} tone="neutral" icon={BarChart3} />
        </div>

        {/* Outcome of the push — a link to what it produced, or why it failed. */}
        {pushState.status === 'done' && (
          <div className="flex items-center gap-2 text-[12px] bg-emerald-50 border border-emerald-200 rounded-lg px-3 py-2">
            <CheckCircle2 className="w-4 h-4 text-emerald-600 flex-shrink-0" />
            <span className="text-emerald-800 min-w-0">
              {pushState.mode === 'pr' ? 'Pull request opened' : 'Committed'} on{' '}
              <span className="font-mono font-medium">{pushState.branch}</span>
              {pushState.repo && <> in <span className="font-medium">{pushState.repo}</span></>}
              {' · '}{pushState.fileCount} file{pushState.fileCount === 1 ? '' : 's'}
            </span>
            <a
              href={pushState.url}
              target="_blank"
              rel="noopener noreferrer"
              className="ml-auto inline-flex items-center gap-1 font-medium text-emerald-700 hover:text-emerald-900 flex-shrink-0"
            >
              <ExternalLink className="w-3.5 h-3.5" />
              {pushState.mode === 'pr' ? 'View pull request' : 'View branch'}
            </a>
          </div>
        )}
        {pushState.status === 'error' && (
          <div className="flex items-start gap-2 text-[12px] bg-red-50 border border-red-200 rounded-lg px-3 py-2">
            <AlertTriangle className="w-4 h-4 text-red-500 flex-shrink-0 mt-px" />
            <span className="text-red-700 min-w-0">{pushState.error}</span>
          </div>
        )}

        {/* Failures — the actionable part of any red run */}
        {(failures.length > 0 || notRun.length > 0) && (
          <section className={`${CARD} p-4`}>
            <div className="flex items-center gap-2 mb-2">
              <AlertTriangle className="w-4 h-4 text-red-500 flex-shrink-0" />
              <h3 className="text-[12.5px] font-semibold text-gray-900">Needs attention</h3>
              <span className="text-[11px] text-gray-400">{failures.length + notRun.length}</span>
              {failures.length > 1 && (
                <button
                  type="button"
                  onClick={() => setClustersFor(failures.map((r) => {
                    const sc = byId.get(r.testCaseId);
                    return { title: sc?.title || r.name, method: sc?.api?.method, url: sc?.api?.endpoint, error: r.error || '', status: sc?.api?.expectedStatus ? Number(sc.api.expectedStatus) || undefined : undefined };
                  }))}
                  title="Group similar failures by root cause"
                  className="ml-auto inline-flex items-center gap-1 px-1.5 py-0.5 rounded border border-[#DDD6FE] text-[10px] font-semibold text-[#6D28D9] bg-[#F5F3FF] hover:bg-[#EDE9FE] transition-colors flex-shrink-0"
                >
                  <Layers className="w-2.5 h-2.5" />Group ({failures.length})
                </button>
              )}
            </div>
            <div className="divide-y divide-gray-100">
              {[...failures, ...notRun].map((r) => {
                const sc = byId.get(r.testCaseId);
                return (
                  <div key={r.testCaseId} className="py-2">
                    <div className="flex items-center gap-2">
                      <MethodBadge method={sc?.api?.method || ''} />
                      <span className="text-[12px] text-gray-800 flex-1 min-w-0 truncate">{sc?.title || r.name}</span>
                      {r.status === 'failed' && (
                        <button
                          type="button"
                          onClick={() => setDiagnoseFor({
                            title: sc?.title || r.name,
                            method: sc?.api?.method || 'GET',
                            url: sc?.api?.endpoint || '',
                            error: r.error || '',
                            expectedStatus: sc?.api?.expectedStatus ? Number(sc.api.expectedStatus) || undefined : undefined,
                            requestBody: sc?.api?.requestBody,
                          })}
                          title="AI root-cause analysis"
                          className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded border border-[#DDD6FE] text-[10px] font-semibold text-[#6D28D9] bg-[#F5F3FF] hover:bg-[#EDE9FE] transition-colors flex-shrink-0"
                        >
                          <Sparkles className="w-2.5 h-2.5" />Explain
                        </button>
                      )}
                      <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded ${r.status === 'failed' ? 'text-red-700 bg-red-50' : 'text-gray-600 bg-gray-100'}`}>
                        {r.status === 'failed' ? 'failed' : 'not run'}
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
          </section>
        )}

        {/* What healing did — including what it deliberately did not do */}
        {healNotes.length > 0 && (
          <section className={`${CARD} p-4`}>
            <div className="flex items-center gap-2 mb-2">
              <Wrench className="w-4 h-4 text-[#7C3AED] flex-shrink-0" />
              <h3 className="text-[12.5px] font-semibold text-gray-900">Self-healing</h3>
              <span className="text-[11px] text-gray-400">{healNotes.length} reviewed</span>
            </div>
            <div className="divide-y divide-gray-100">
              {healNotes.map((r) => {
                const sc = byId.get(r.testCaseId);
                return (
                  <div key={r.testCaseId} className="py-2">
                    <div className="flex items-center gap-2">
                      <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded ${r.healed ? 'text-[#6D28D9] bg-[#F5F3FF]' : 'text-gray-600 bg-gray-100'}`}>
                        {r.healed ? 'repaired' : 'left as-is'}
                      </span>
                      <span className="text-[12px] text-gray-800 flex-1 min-w-0 truncate">{sc?.title || r.name}</span>
                    </div>
                  </div>
                );
              })}
            </div>
          </section>
        )}
      </div>

      {diagnoseFor && <Diagnose failure={diagnoseFor} onClose={() => setDiagnoseFor(null)} />}
      {clustersFor && <FailureClusters failures={clustersFor} onClose={() => setClustersFor(null)} />}
    </div>
  );
}
