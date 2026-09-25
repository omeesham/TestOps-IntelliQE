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
  BarChart3, ExternalLink, Download, Loader2, CheckCircle2, XCircle, MinusCircle, Wrench,
  GitBranch, AlertTriangle, Sparkles,
} from 'lucide-react';
import { EmptyState, MethodBadge } from './primitives';
import { formatDuration, RAISED, RAISED_HOVER, SECONDARY_3D, CARD, STRIP, TILE_ACTIVE } from './format';
import Diagnose, { type FailurePayload } from './Diagnose';
import type { RunReport, RunRow, Scenario, PushState } from './types';

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
  const cls = {
    neutral: 'text-gray-800 bg-white border-gray-200',
    good: 'text-emerald-700 bg-emerald-50 border-emerald-200',
    bad: 'text-red-700 bg-red-50 border-red-200',
    muted: 'text-gray-500 bg-gray-50 border-gray-200',
    accent: 'text-[#6D28D9] bg-[#F5F3FF] border-[#DDD6FE]',
  }[tone];
  return (
    <div className={`flex-1 min-w-[110px] border rounded-lg px-3 py-2.5 ${RAISED} ${RAISED_HOVER} ${cls}`}>
      <div className="flex items-center gap-1.5">
        <Icon className="w-3.5 h-3.5 opacity-70" />
        <span className="text-[10px] font-semibold uppercase tracking-wide opacity-80">{label}</span>
      </div>
      <div className="text-2xl font-semibold tabular-nums mt-1 leading-none">{value}</div>
    </div>
  );
}

export default function ReportTab({
  report, rows, scenarios, onExport, exporting, canExport,
  onPushToRepo, pushState, canPush,
}: Props) {
  const [diagnoseFor, setDiagnoseFor] = useState<FailurePayload | null>(null);
  if (!report) {
    return (
      <EmptyState
        icon={BarChart3}
        title="No report yet"
        hint="The report is assembled once the suite has executed — pass rate, failures, what self-healing changed, and a link to the full Html report."
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
      <div className="max-w-4xl mx-auto p-5 space-y-5">
        {/* Verdict */}
        <div className={`rounded-xl border p-4 ${RAISED} ${green ? 'bg-gradient-to-b from-emerald-50 to-[#E6F7EF] border-emerald-200' : 'bg-white border-[#E9E5FB]'}`}>
          <div className="flex items-start gap-3">
            <div className={`w-10 h-10 rounded-lg flex items-center justify-center flex-shrink-0 ring-1 ring-white/40 ${green ? 'bg-gradient-to-br from-emerald-400 to-emerald-600 shadow-[inset_0_1px_0_rgba(255,255,255,0.4),0_3px_0_0_#047857,0_8px_16px_-6px_rgba(16,185,129,0.6)]' : TILE_ACTIVE + ' shadow-[inset_0_1px_0_rgba(255,255,255,0.4),0_3px_0_0_#4338CA,0_8px_16px_-6px_rgba(124,58,237,0.6)]'}`}>
              {green ? <CheckCircle2 className="w-5 h-5 text-white" /> : <BarChart3 className="w-5 h-5 text-white" />}
            </div>
            <div className="min-w-0 flex-1">
              <h2 className="text-base font-semibold text-gray-900">
                {green
                  ? `All ${report.total} scenarios passed`
                  : `${report.passed} of ${report.total} scenarios passed`}
              </h2>
            </div>
            <div className="text-right flex-shrink-0">
              <div className={`text-3xl font-semibold tabular-nums leading-none ${green ? 'text-emerald-600' : report.passRate >= 50 ? 'text-[#7C3AED]' : 'text-red-600'}`}>
                {report.passRate}%
              </div>
              <div className="text-[10px] text-gray-400 uppercase tracking-wide mt-1">pass rate</div>
            </div>
          </div>

          {/* Proportional bar — the shape of the run at a glance */}
          <div className="flex h-2 rounded-full overflow-hidden bg-gray-200 mt-4">
            {report.passed > 0 && <div className="bg-emerald-500" style={{ width: `${(report.passed / report.total) * 100}%` }} />}
            {report.failed > 0 && <div className="bg-red-500" style={{ width: `${(report.failed / report.total) * 100}%` }} />}
            {report.notRun > 0 && <div className="bg-gray-400" style={{ width: `${(report.notRun / report.total) * 100}%` }} />}
          </div>
        </div>

        {/* Counters */}
        <div className="flex flex-wrap gap-2">
          <Stat label="Passed" value={report.passed} tone="good" icon={CheckCircle2} />
          <Stat label="Failed" value={report.failed} tone={report.failed ? 'bad' : 'muted'} icon={XCircle} />
          <Stat label="Not run" value={report.notRun} tone="muted" icon={MinusCircle} />
          <Stat label="Healed" value={report.healed} tone={report.healed ? 'accent' : 'muted'} icon={Wrench} />
          <Stat label="Duration" value={formatDuration(report.durationMs)} tone="neutral" icon={BarChart3} />
        </div>

        {/* Actions */}
        <div className="flex flex-wrap items-center gap-2">
          {report.reportUrl && (
            <a
              href={report.reportUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-[12px] font-medium text-white bg-gradient-to-r from-[#7C3AED] to-[#6366F1] rounded-md hover:from-[#6D28D9] hover:to-[#4F46E5] transition-all"
            >
              <ExternalLink className="w-3.5 h-3.5" />Html report
            </a>
          )}
          {/* Push to repo — commit the generated specs to the connected repository. */}
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
              ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
              : <GitBranch className="w-3.5 h-3.5" />}
            {pushState.status === 'pushing' ? 'Pushing…' : 'Push to repo'}
          </button>
          <button
            type="button"
            onClick={() => onExport('excel')}
            disabled={exporting || !canExport}
            className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-[12px] font-medium text-gray-700 bg-white border border-[#E4E0F5] rounded-md hover:border-[#C4B5FD] hover:text-[#6D28D9] transition-all disabled:opacity-40 ${SECONDARY_3D}`}
          >
            {exporting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Download className="w-3.5 h-3.5" />}
            Export scenarios (CSV)
          </button>
          <button
            type="button"
            onClick={() => onExport('json')}
            disabled={exporting || !canExport}
            className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-[12px] font-medium text-gray-700 bg-white border border-[#E4E0F5] rounded-md hover:border-[#C4B5FD] hover:text-[#6D28D9] transition-all disabled:opacity-40 ${SECONDARY_3D}`}
          >
            <Download className="w-3.5 h-3.5" />Export (JSON)
          </button>
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
          <section className={`${CARD} overflow-hidden`}>
            <div className={`px-4 py-2.5 border-b border-[#EDE9FE] ${STRIP}`}>
              <h3 className="text-[12px] font-semibold text-gray-800">
                Needs attention · {failures.length + notRun.length}
              </h3>
            </div>
            <div className="divide-y divide-gray-100">
              {[...failures, ...notRun].map((r) => {
                const sc = byId.get(r.testCaseId);
                return (
                  <div key={r.testCaseId} className="px-4 py-2.5">
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
                    {r.error && (
                      <p className="font-mono text-[11px] text-red-600 mt-1 leading-relaxed line-clamp-2">
                        {/* Playwright separates the assertion header from the Expected/Received
                            pair with a blank line, so skipping empties keeps the lines
                            that actually inform. */}
                        {r.error.split('\n').map((l) => l.trim()).filter(Boolean).slice(0, 3).join(' · ')}
                      </p>
                    )}
                  </div>
                );
              })}
            </div>
          </section>
        )}

        {/* What healing did — including what it deliberately did not do */}
        {healNotes.length > 0 && (
          <section className={`${CARD} overflow-hidden`}>
            <div className="px-4 py-2.5 border-b border-gray-100 flex items-center gap-1.5">
              <Wrench className="w-3.5 h-3.5 text-[#7C3AED]" />
              <h3 className="text-[12px] font-semibold text-gray-800">Self-healing · {healNotes.length} reviewed</h3>
            </div>
            <div className="divide-y divide-gray-100">
              {healNotes.map((r) => {
                const sc = byId.get(r.testCaseId);
                return (
                  <div key={r.testCaseId} className="px-4 py-2.5">
                    <div className="flex items-center gap-2">
                      <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded ${r.healed ? 'text-[#6D28D9] bg-[#F5F3FF]' : 'text-gray-600 bg-gray-100'}`}>
                        {r.healed ? 'repaired' : 'left as-is'}
                      </span>
                      <span className="text-[12px] text-gray-800 flex-1 min-w-0 truncate">{sc?.title || r.name}</span>
                    </div>
                    <p className="text-[11px] text-gray-500 mt-1 leading-relaxed">{r.healNote}</p>
                  </div>
                );
              })}
            </div>
          </section>
        )}
      </div>

      {diagnoseFor && <Diagnose failure={diagnoseFor} onClose={() => setDiagnoseFor(null)} />}
    </div>
  );
}
