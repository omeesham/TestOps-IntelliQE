import { useState, useEffect, useCallback } from 'react';
import {
  Loader2, FileText, BarChart3, Download, ArrowLeft,
  CheckCircle2, XCircle, Clock, FileSpreadsheet, Hammer, AlertTriangle,
} from 'lucide-react';
import {
  getReportsHistory, downloadReportExport,
  loadAllureReport, generateAllureReport,
  type ReportHistoryItem, type ReportHistoryResponse,
} from '@/services/api';
import ErrorAlert from '@/components/feedback/ErrorAlert';
import { useToast } from '@/components/feedback/ToastProvider';
import { normalizeError } from '@/utils/apiError';

import Loader from '@/components/feedback/Loader';
/* ── helpers ── */
function fmtDate(iso?: string): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '—';
  return d.toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}
function reportTitle(i: ReportHistoryItem): string {
  return i.story || i.storyKey || (i.runId.startsWith('chat-') ? 'Chat run' : i.runId);
}

/**
 * Reports — executive view.
 *   • List: the latest 10 reports (retention prunes older ones from storage).
 *   • Row click → full-page report view with Allure / Basic HTML tabs; the
 *     report is restored from Azure storage automatically on open, with Excel
 *     and PDF export beside the tabs.
 */
export default function ReportsPage() {
  const toast = useToast();
  const [error, setError] = useState('');

  const [data, setData] = useState<ReportHistoryResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [downloadingKey, setDownloadingKey] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);

  // Full-page report view
  const [viewItem, setViewItem] = useState<ReportHistoryItem | null>(null);
  const [viewStatus, setViewStatus] = useState<{ reportUrl?: string; allureReportUrl?: string; allureError?: string; source?: string } | null>(null);
  const [viewTab, setViewTab] = useState<'allure' | 'basic'>('allure');
  const [viewLoading, setViewLoading] = useState(false);
  const [buildingAllure, setBuildingAllure] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      // Web and API reports share ONE list — no automation-kind filter. Each row
      // carries its own Web/API marker instead (see the Type column), so the two
      // stay tellable apart without splitting the page into separate tabs.
      // Retention caps the total at REPORT_RETENTION (10); server paginates within it.
      const res = await getReportsHistory({ page, pageSize });
      setData(res);
      setError('');
    } catch (err) {
      setError(normalizeError(err).message);
    } finally {
      setLoading(false);
    }
  }, [page, pageSize]);

  useEffect(() => { load(); }, [load]);

  /** Open a report full-page; restore it from Azure storage when not local. */
  const openReport = useCallback(async (item: ReportHistoryItem) => {
    setViewItem(item);
    setViewTab(item.hasAllure ? 'allure' : 'basic');
    setViewStatus(null);
    setViewLoading(true);
    try {
      const s = await loadAllureReport(item.runId);
      setViewStatus(s);
      if (s.source === 'restored') toast.success('Report loaded from Azure Storage');
    } catch {
      setViewStatus(null);
    } finally {
      setViewLoading(false);
    }
  }, [toast]);

  /**
   * Build the Allure report for a run that has none. The run's Playwright HTML
   * ("Basic") report can exist without it — an Allure build needs a JRE, and
   * when that step failed at execution time this is the way back to a report
   * without re-running the suite by hand.
   */
  const buildAllure = useCallback(async (runId: string) => {
    setBuildingAllure(true);
    try {
      await generateAllureReport(runId);
      const s = await loadAllureReport(runId);
      setViewStatus(s);
      if (s.allureReportUrl) {
        setViewTab('allure');
        toast.success('Allure report built');
      } else {
        toast.error('Allure report not built', s.allureError || 'The build produced no report.');
      }
    } catch (err) {
      toast.error('Could not build the Allure report', normalizeError(err).message);
    } finally {
      setBuildingAllure(false);
    }
  }, [toast]);

  const doDownload = useCallback(async (runId: string, format: 'xlsx' | 'pdf') => {
    const key = `${runId}:${format}`;
    setDownloadingKey(key);
    try {
      await downloadReportExport(runId, format);
      toast.success(`${format === 'xlsx' ? 'Excel' : 'PDF'} downloaded`);
    } catch (err) {
      toast.error('Download failed', normalizeError(err).message);
    } finally {
      setDownloadingKey('');
    }
  }, [toast]);

  const items = data?.items ?? [];
  const total = data?.total ?? 0;
  const totalPages = data?.totalPages ?? 1;

  if (error) {
    return (
      <div className="max-w-2xl mx-auto py-10">
        <ErrorAlert
          error={{ code: 'LOAD_FAIL', title: 'Could not load reports', message: error, severity: 'error', retryable: true }}
          onRetry={() => load()}
        />
      </div>
    );
  }

  /* ════════ FULL-PAGE REPORT VIEW ════════ */
  if (viewItem) {
    const viewUrl = viewTab === 'allure' ? viewStatus?.allureReportUrl : viewStatus?.reportUrl;
    return (
      <div className="space-y-2">
        {/* Header bar */}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3 min-w-0">
            <button
              onClick={() => { setViewItem(null); setViewStatus(null); }}
              title="All reports"
              aria-label="All reports"
              className="p-2 text-[#6B7280] bg-white border border-[#DDD6FE] rounded-lg hover:bg-[#F5F3FF] hover:text-[#7C3AED] transition-colors flex-shrink-0"
            >
              <ArrowLeft className="w-4 h-4" />
            </button>
            {/* Same Web/API marker the list row carries, so the report's
                identity survives the click-through. */}
            <span
              className={`shrink-0 text-[10px] font-bold px-2 py-0.5 rounded-full ${viewItem.kind === 'api' ? 'bg-violet-100 text-violet-700' : 'bg-sky-100 text-sky-700'}`}
              title={viewItem.kind === 'api' ? 'API Automation report' : 'Web Automation report'}
            >
              {viewItem.kind === 'api' ? 'API' : 'Web'}
            </span>
            <h1 className="text-sm font-bold text-[#1E1B4B] truncate" title={reportTitle(viewItem)}>{reportTitle(viewItem)}</h1>
          </div>
          <span className="flex items-center gap-1 text-xs text-[#6B7280] flex-shrink-0"><Clock className="w-3 h-3" />{fmtDate(viewItem.generatedAt)}</span>
        </div>

        {/* Tabs + full-page report */}
        <div className="bg-white/90 backdrop-blur-sm rounded-xl border border-[#DDD6FE]/60 overflow-hidden">
          <div className="flex items-center justify-between px-4 py-2 border-b border-[#EDE9FE] bg-[#F5F3FF]/50">
            <div className="flex items-center gap-1 bg-white rounded-lg p-1 border border-[#DDD6FE]/60">
              <button
                onClick={() => setViewTab('allure')}
                disabled={!viewStatus}
                title={viewStatus?.allureReportUrl ? 'Allure report' : 'No Allure report for this run yet'}
                className={`flex items-center gap-1.5 px-4 py-1.5 text-xs font-semibold rounded-md transition-colors disabled:opacity-40 ${viewTab === 'allure' ? 'bg-[#7C3AED] text-white' : 'text-[#6B7280] hover:text-[#7C3AED]'}`}
              >
                <FileText className="w-3.5 h-3.5" />Allure
              </button>
              <button
                onClick={() => setViewTab('basic')}
                disabled={!viewStatus?.reportUrl}
                className={`flex items-center gap-1.5 px-4 py-1.5 text-xs font-semibold rounded-md transition-colors disabled:opacity-40 ${viewTab === 'basic' ? 'bg-[#7C3AED] text-white' : 'text-[#6B7280] hover:text-[#7C3AED]'}`}
              >
                <BarChart3 className="w-3.5 h-3.5" />Basic HTML
              </button>
            </div>
            <div className="flex items-center gap-2">
              <button onClick={() => doDownload(viewItem.runId, 'xlsx')} disabled={downloadingKey === `${viewItem.runId}:xlsx`} title="Download Excel" className="p-2 rounded-lg border border-[#DDD6FE] text-emerald-600 bg-white hover:bg-emerald-50 disabled:opacity-50 transition-colors">
                {downloadingKey === `${viewItem.runId}:xlsx` ? <Loader2 className="w-4 h-4 animate-spin" /> : <FileSpreadsheet className="w-4 h-4" />}
              </button>
              <button onClick={() => doDownload(viewItem.runId, 'pdf')} disabled={downloadingKey === `${viewItem.runId}:pdf`} title="Download PDF" className="p-2 rounded-lg border border-[#DDD6FE] text-red-500 bg-white hover:bg-red-50 disabled:opacity-50 transition-colors">
                {downloadingKey === `${viewItem.runId}:pdf` ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />}
              </button>
            </div>
          </div>
          {viewLoading ? (
            <div className="flex flex-col items-center justify-center" style={{ height: 'calc(100vh - 200px)', minHeight: 460 }}>
              <Loader size="lg" label="Loading report" />
            </div>
          ) : viewUrl ? (
            <iframe key={viewUrl} src={viewUrl} className="w-full border-0" style={{ height: 'calc(100vh - 200px)', minHeight: 460 }} title="Test report" />
          ) : viewTab === 'allure' && viewStatus?.reportUrl ? (
            /* The run HAS a report — just not the Allure one. Say why, and offer
               to build it, instead of greying the tab out with no explanation. */
            <div className="flex flex-col items-center justify-center gap-3 px-6 text-center text-sm text-[#6B7280]" style={{ height: 'calc(100vh - 200px)', minHeight: 460 }}>
              <AlertTriangle className="w-10 h-10 text-[#A5B4FC]" />
              <p className="font-medium text-[#1E1B4B]">No Allure report for this run</p>
              <p className="text-xs max-w-lg leading-relaxed">
                {viewStatus.allureError || 'It was never built for this run.'}
              </p>
              <div className="flex items-center gap-2 mt-1">
                <button
                  onClick={() => buildAllure(viewItem.runId)}
                  disabled={buildingAllure}
                  className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold text-white bg-gradient-to-r from-[#7C3AED] to-[#6366F1] hover:from-[#6D28D9] hover:to-[#4F46E5] rounded-lg disabled:opacity-50 transition-all"
                >
                  {buildingAllure ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Hammer className="w-3.5 h-3.5" />}
                  {buildingAllure ? 'Building…' : 'Build Allure report'}
                </button>
                <button
                  onClick={() => setViewTab('basic')}
                  className="px-4 py-2 text-xs font-semibold text-[#6B7280] bg-white border border-[#DDD6FE] rounded-lg hover:text-[#7C3AED] transition-colors"
                >
                  Open Basic HTML instead
                </button>
              </div>
              {buildingAllure && <p className="text-[11px] text-[#9CA3AF]">Re-running this suite to collect results — this can take a minute.</p>}
            </div>
          ) : (
            <div className="flex flex-col items-center justify-center gap-2 text-sm text-[#6B7280]" style={{ height: 'calc(100vh - 200px)', minHeight: 460 }}>
              <FileText className="w-10 h-10 text-[#A5B4FC]" />
              <p className="font-medium text-[#1E1B4B]">This report isn't available</p>
              <p className="text-xs">No saved report was found for this run in Azure Storage.</p>
            </div>
          )}
        </div>
      </div>
    );
  }

  /* ════════ EXECUTIVE LIST VIEW ════════ */
  return (
    <div className="space-y-4">
      {/* Executive table — latest 10 Web AND API reports together, clickable rows */}
      <div className="bg-white/80 backdrop-blur-sm rounded-xl border border-[#DDD6FE]/60 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-gray-50 border-b border-gray-100">
                <th className="text-left px-3 py-1.5 text-xs font-semibold text-gray-500 uppercase tracking-wider whitespace-nowrap w-20">Type</th>
                <th className="text-left px-3 py-1.5 text-xs font-semibold text-gray-500 uppercase tracking-wider">Report</th>
                <th className="text-left px-3 py-1.5 text-xs font-semibold text-gray-500 uppercase tracking-wider whitespace-nowrap">Generated</th>
                <th className="text-center px-3 py-1.5 text-xs font-semibold text-gray-500 uppercase tracking-wider whitespace-nowrap">Results</th>
                <th className="text-left px-3 py-1.5 text-xs font-semibold text-gray-500 uppercase tracking-wider whitespace-nowrap w-36">Pass Rate</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td colSpan={5} className="px-4 py-16 text-center"><Loader label="Loading runs" /></td></tr>
              ) : items.length === 0 ? (
                <tr><td colSpan={5} className="px-4 py-16 text-center text-[#6B7280]">
                  <FileText className="w-10 h-10 text-[#A5B4FC] mx-auto mb-3" />
                  <p className="font-medium text-[#1E1B4B]">No reports yet</p>
                  <p className="text-xs mt-1">Run a Web Application or API Automation execution from the Chat flow, then reports appear here.</p>
                </td></tr>
              ) : items.map((i) => {
                const st = i.stats;
                return (
                  <tr
                    key={i.runId}
                    onClick={() => openReport(i)}
                    className="border-b border-gray-50 hover:bg-gray-50/50 transition-colors cursor-pointer"
                    title="Open full-page report"
                  >
                    {/* Type — the row's own Web/API identity, now that the two
                        kinds share a single unfiltered list. */}
                    <td className="px-3 py-1.5">
                      <span
                        className={`inline-block text-[10px] font-bold px-2 py-0.5 rounded-full ${i.kind === 'api' ? 'bg-violet-100 text-violet-700' : 'bg-sky-100 text-sky-700'}`}
                        title={i.kind === 'api' ? 'API Automation report' : 'Web Automation report'}
                      >
                        {i.kind === 'api' ? 'API' : 'Web'}
                      </span>
                    </td>
                    <td className="px-3 py-1.5">
                      <div className="text-[#1E1B4B] truncate max-w-[360px]" title={reportTitle(i)}>{reportTitle(i)}</div>
                      {i.module && (
                        <div className="text-[11px] text-[#9CA3AF] mt-0.5">
                          <span className="truncate max-w-[180px] inline-block align-bottom">{i.module}</span>
                        </div>
                      )}
                    </td>
                    <td className="px-3 py-1.5 text-[#6B7280] whitespace-nowrap">{fmtDate(i.generatedAt)}</td>
                    <td className="px-3 py-1.5">
                      {st ? (
                        <div className="flex items-center justify-center gap-2.5 text-xs">
                          <span className="flex items-center gap-1 text-emerald-600"><CheckCircle2 className="w-3.5 h-3.5" />{st.passed}</span>
                          <span className="flex items-center gap-1 text-red-500"><XCircle className="w-3.5 h-3.5" />{st.failed}</span>
                          <span className="text-gray-400">/ {st.total}</span>
                        </div>
                      ) : <span className="text-gray-400 text-xs text-center block">—</span>}
                    </td>
                    <td className="px-3 py-1.5">
                      {st ? (
                        <span className={`text-sm ${st.passRate >= 80 ? 'text-emerald-600' : st.passRate >= 50 ? 'text-amber-600' : 'text-red-500'}`}>{st.passRate}%</span>
                      ) : <span className="text-gray-400 text-xs">—</span>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {/* Pagination */}
        <div className="flex items-center justify-between px-4 py-1.5 border-t border-gray-100 bg-gray-50/50 text-xs">
          <div className="flex items-center gap-1.5 text-gray-600">
            <span>Rows:</span>
            <select
              value={pageSize}
              onChange={(e) => { setPageSize(Number(e.target.value)); setPage(1); }}
              className="px-1.5 py-0.5 bg-white border border-gray-200 rounded text-xs outline-none focus:ring-1 focus:ring-[#7C3AED]/20 focus:border-[#7C3AED]"
            >
              {[5, 10, 25, 50].map((n) => <option key={n} value={n}>{n}</option>)}
            </select>
            <span className="ml-2 text-gray-500">
              {total === 0 ? 0 : Math.min((page - 1) * pageSize + 1, total)}–{Math.min(page * pageSize, total)} of {total}
            </span>
          </div>
          <div className="flex items-center gap-1">
            <button
              disabled={page <= 1}
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              className="px-2 py-0.5 rounded font-medium text-gray-600 hover:bg-white border border-gray-200 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              Prev
            </button>
            <span className="px-2 text-gray-600">
              Page <span className="font-semibold text-[#7C3AED]">{page}</span> of {totalPages}
            </span>
            <button
              disabled={page >= totalPages}
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              className="px-2 py-0.5 rounded font-medium text-gray-600 hover:bg-white border border-gray-200 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              Next
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
