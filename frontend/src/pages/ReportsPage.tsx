import { useState, useEffect, useCallback } from 'react';
import {
  Loader2, FileText, RefreshCw, BarChart3, Download, Eye, X, Search,
  ChevronLeft, ChevronRight, CheckCircle2, XCircle, Clock, FileSpreadsheet,
  Layers, FolderGit2,
} from 'lucide-react';
import {
  getReportsHistory, downloadReportExport, generateAllureReport,
  getAllureReportStatus, getLatestAllureReport,
  type ReportHistoryItem, type ReportHistoryResponse,
} from '@/services/api';
import ErrorAlert from '@/components/feedback/ErrorAlert';
import ActionIcon from '@/components/ui/ActionIcon';
import { useToast } from '@/components/feedback/ToastProvider';
import { normalizeError } from '@/utils/apiError';

/* ── helpers ── */
function fmtDate(iso?: string): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '—';
  return d.toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}
function fmtDuration(ms?: number): string {
  const s = Math.max(0, Math.round((ms || 0) / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return `${h ? `${h}h ` : ''}${m ? `${m}m ` : ''}${sec}s`;
}
const SOURCE_STYLE: Record<string, string> = {
  jira: 'bg-blue-50 text-blue-700 border-blue-200',
  'azure-devops': 'bg-sky-50 text-sky-700 border-sky-200',
  confluence: 'bg-indigo-50 text-indigo-700 border-indigo-200',
  sharepoint: 'bg-cyan-50 text-cyan-700 border-cyan-200',
  chat: 'bg-violet-50 text-violet-700 border-violet-200',
  'ad-hoc': 'bg-gray-50 text-gray-600 border-gray-200',
};
function sourceLabel(s: string): string {
  if (s === 'azure-devops') return 'Azure DevOps';
  if (s === 'ad-hoc') return 'Ad-hoc';
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export default function ReportsPage() {
  const toast = useToast();
  const [error, setError] = useState('');

  // History + filters
  const [data, setData] = useState<ReportHistoryResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [pageSize] = useState(10);
  const [source, setSource] = useState('');
  const [typeFilter, setTypeFilter] = useState('');
  const [search, setSearch] = useState('');
  const [downloadingKey, setDownloadingKey] = useState('');

  // Report viewer (iframe)
  const [viewRunId, setViewRunId] = useState('');
  const [viewStatus, setViewStatus] = useState<{ reportUrl?: string; allureReportUrl?: string } | null>(null);
  const [viewTab, setViewTab] = useState<'allure' | 'basic'>('allure');
  const [viewLoading, setViewLoading] = useState(false);

  const [generating, setGenerating] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await getReportsHistory({ page, pageSize, source: source || undefined, type: typeFilter || undefined, search: search || undefined });
      setData(res);
      setError('');
    } catch (err) {
      setError(normalizeError(err).message);
    } finally {
      setLoading(false);
    }
  }, [page, pageSize, source, typeFilter, search]);

  useEffect(() => { load(); }, [load]);
  // Reset to page 1 when filters change
  useEffect(() => { setPage(1); }, [source, typeFilter, search]);

  const openReport = useCallback(async (item: ReportHistoryItem) => {
    setViewRunId(item.runId);
    setViewTab(item.hasAllure ? 'allure' : 'basic');
    setViewLoading(true);
    try {
      const s = await getAllureReportStatus(item.runId);
      setViewStatus(s as any);
    } catch {
      setViewStatus(null);
    } finally {
      setViewLoading(false);
    }
  }, []);

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

  // Generate a report for the latest run, then refresh the list.
  const handleGenerateLatest = useCallback(async () => {
    setGenerating(true);
    try {
      const latest = await getLatestAllureReport();
      if (!latest?.runId) {
        toast.error('No run found', 'Run a test execution from the Chat flow first.');
        return;
      }
      await generateAllureReport(latest.runId);
      toast.success('Report generated');
      await load();
    } catch (err) {
      toast.error('Report unavailable', normalizeError(err).message);
    } finally {
      setGenerating(false);
    }
  }, [toast, load]);

  // Aggregate stat cards from the current page's data (whole history counts via total).
  const items = data?.items ?? [];
  const withStats = items.filter((i) => i.stats);
  const avgPassRate = withStats.length
    ? Math.round(withStats.reduce((s, i) => s + (i.stats!.passRate || 0), 0) / withStats.length)
    : 0;

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

  const viewUrl = viewTab === 'allure' ? viewStatus?.allureReportUrl : viewStatus?.reportUrl;

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold text-[#1E1B4B]">Reports</h1>
          <p className="text-sm text-[#6B7280]">History of every report generated — view, classify and export past &amp; present runs.</p>
        </div>
        <button
          onClick={handleGenerateLatest}
          disabled={generating}
          className="flex items-center gap-2 px-4 py-2 text-sm font-medium text-white bg-[#7C3AED] rounded-lg hover:bg-[#6D28D9] disabled:opacity-50 transition-all shadow-md shadow-purple-200"
        >
          {generating ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
          {generating ? 'Generating…' : 'Generate Latest Report'}
        </button>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <StatCard icon={<Layers className="w-4 h-4" />} label="Total Reports" value={data?.total ?? 0} tone="violet" />
        <StatCard icon={<BarChart3 className="w-4 h-4" />} label="Avg Pass Rate (page)" value={`${avgPassRate}%`} tone="emerald" />
        <StatCard icon={<FileText className="w-4 h-4" />} label="Allure Reports" value={items.filter(i => i.hasAllure).length} tone="sky" />
        <StatCard icon={<FolderGit2 className="w-4 h-4" />} label="Sources" value={data?.facets.sources.length ?? 0} tone="amber" />
      </div>

      {/* Filters */}
      <div className="bg-white/80 backdrop-blur-sm rounded-xl border border-[#DDD6FE]/60 p-3 flex flex-wrap items-center gap-2">
        <div className="relative flex-1 min-w-[200px]">
          <Search className="w-4 h-4 text-gray-400 absolute left-3 top-1/2 -translate-y-1/2" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by story, module or run id…"
            className="w-full pl-9 pr-3 py-2 text-sm rounded-lg border border-[#DDD6FE] bg-[#F5F3FF] outline-none focus:ring-2 focus:ring-[#7C3AED]/20"
          />
        </div>
        <select value={source} onChange={(e) => setSource(e.target.value)} className="px-3 py-2 text-sm rounded-lg border border-[#DDD6FE] bg-white outline-none focus:ring-2 focus:ring-[#7C3AED]/20">
          <option value="">All sources</option>
          {(data?.facets.sources ?? []).map((s) => <option key={s} value={s}>{sourceLabel(s)}</option>)}
        </select>
        <div className="flex items-center gap-1 bg-[#F5F3FF]/60 rounded-lg p-1">
          {[['', 'All'], ['allure', 'Allure'], ['basic', 'Basic']].map(([val, label]) => (
            <button
              key={val}
              onClick={() => setTypeFilter(val)}
              className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${typeFilter === val ? 'bg-[#7C3AED] text-white' : 'text-[#6B7280] hover:bg-white'}`}
            >{label}</button>
          ))}
        </div>
      </div>

      {/* Report viewer */}
      {viewRunId && (
        <div className="bg-white/90 backdrop-blur-sm rounded-xl border border-[#DDD6FE]/60 overflow-hidden">
          <div className="flex items-center justify-between px-4 py-2.5 border-b border-[#EDE9FE] bg-[#F5F3FF]/50">
            <div className="flex items-center gap-1 bg-white rounded-lg p-1 border border-[#DDD6FE]/60">
              <button onClick={() => setViewTab('allure')} disabled={!viewStatus?.allureReportUrl} className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md transition-colors disabled:opacity-40 ${viewTab === 'allure' ? 'bg-[#7C3AED] text-white' : 'text-[#6B7280]'}`}><FileText className="w-3.5 h-3.5" />Allure</button>
              <button onClick={() => setViewTab('basic')} disabled={!viewStatus?.reportUrl} className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md transition-colors disabled:opacity-40 ${viewTab === 'basic' ? 'bg-[#7C3AED] text-white' : 'text-[#6B7280]'}`}><BarChart3 className="w-3.5 h-3.5" />Basic</button>
            </div>
            <button onClick={() => { setViewRunId(''); setViewStatus(null); }} className="p-1.5 text-gray-400 hover:text-red-500 hover:bg-red-50 rounded-lg transition-colors" title="Close viewer"><X className="w-4 h-4" /></button>
          </div>
          {viewLoading ? (
            <div className="flex items-center justify-center h-[60vh]"><Loader2 className="w-7 h-7 text-[#7C3AED] animate-spin" /></div>
          ) : viewUrl ? (
            <iframe key={viewUrl} src={viewUrl} className="w-full border-0" style={{ height: '70vh', minHeight: 480 }} title="Test report" />
          ) : (
            <div className="flex items-center justify-center h-64 text-sm text-[#6B7280]">This report type isn't available for this run.</div>
          )}
        </div>
      )}

      {/* History table */}
      <div className="bg-white/80 backdrop-blur-sm rounded-xl border border-[#DDD6FE]/60 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-[11px] font-semibold uppercase tracking-wide text-[#6B7280] bg-[#F5F3FF]/50">
                <th className="px-4 py-3">Report</th>
                <th className="px-3 py-3">Source</th>
                <th className="px-3 py-3">Type</th>
                <th className="px-3 py-3">Generated</th>
                <th className="px-3 py-3 text-center">Results</th>
                <th className="px-3 py-3 w-32">Pass Rate</th>
                <th className="px-3 py-3 text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td colSpan={7} className="px-4 py-16 text-center"><Loader2 className="w-6 h-6 text-[#7C3AED] animate-spin inline" /></td></tr>
              ) : items.length === 0 ? (
                <tr><td colSpan={7} className="px-4 py-16 text-center text-[#6B7280]">
                  <FileText className="w-10 h-10 text-[#A5B4FC] mx-auto mb-3" />
                  <p className="font-medium text-[#1E1B4B]">No reports yet</p>
                  <p className="text-xs mt-1">Run a test execution from the Chat flow, then reports appear here.</p>
                </td></tr>
              ) : items.map((i) => {
                const st = i.stats;
                return (
                  <tr key={i.runId} className="border-t border-[#F1EEFE] hover:bg-[#F5F3FF]/30 transition-colors">
                    <td className="px-4 py-3">
                      <div className="font-medium text-[#1E1B4B] truncate max-w-[280px]" title={i.story || i.runId}>{i.story || i.storyKey || (i.runId.startsWith('chat-') ? 'Chat run' : i.runId)}</div>
                      <div className="text-[11px] text-[#9CA3AF] flex items-center gap-1.5 mt-0.5">
                        {i.module && <span className="truncate max-w-[160px]">{i.module}</span>}
                        <span className="text-[#C4B5FD]">•</span>
                        <span>{i.origin}</span>
                      </div>
                    </td>
                    <td className="px-3 py-3">
                      <span className={`inline-block px-2 py-0.5 text-[11px] font-medium rounded-full border ${SOURCE_STYLE[i.source] || SOURCE_STYLE['ad-hoc']}`}>{sourceLabel(i.source)}</span>
                    </td>
                    <td className="px-3 py-3">
                      <span className={`inline-flex items-center gap-1 px-2 py-0.5 text-[11px] font-medium rounded-full ${i.hasAllure ? 'bg-[#EDE9FE] text-[#7C3AED]' : 'bg-gray-100 text-gray-600'}`}>
                        {i.hasAllure ? <FileText className="w-3 h-3" /> : <BarChart3 className="w-3 h-3" />}
                        {i.hasAllure ? 'Allure' : 'Basic'}
                      </span>
                    </td>
                    <td className="px-3 py-3 text-[#6B7280] whitespace-nowrap"><Clock className="w-3 h-3 inline mr-1 text-[#A5B4FC]" />{fmtDate(i.generatedAt)}</td>
                    <td className="px-3 py-3">
                      {st ? (
                        <div className="flex items-center justify-center gap-2.5 text-xs">
                          <span className="flex items-center gap-1 text-emerald-600"><CheckCircle2 className="w-3.5 h-3.5" />{st.passed}</span>
                          <span className="flex items-center gap-1 text-red-500"><XCircle className="w-3.5 h-3.5" />{st.failed}</span>
                          <span className="text-gray-400">/ {st.total}</span>
                        </div>
                      ) : <span className="text-gray-400 text-xs">—</span>}
                    </td>
                    <td className="px-3 py-3">
                      {st ? (
                        <div className="flex items-center gap-2">
                          <div className="flex-1 h-1.5 rounded-full bg-gray-100 overflow-hidden">
                            <div className={`h-full rounded-full ${st.passRate >= 80 ? 'bg-emerald-500' : st.passRate >= 50 ? 'bg-amber-500' : 'bg-red-500'}`} style={{ width: `${st.passRate}%` }} />
                          </div>
                          <span className="text-[11px] font-medium text-[#6B7280] w-8 text-right">{st.passRate}%</span>
                        </div>
                      ) : <span className="text-gray-400 text-xs">—</span>}
                    </td>
                    <td className="px-3 py-3">
                      <div className="flex items-center justify-end gap-1.5">
                        <ActionIcon tone="view" title="View report" onClick={() => openReport(i)}>
                          <Eye className="w-4 h-4" />
                        </ActionIcon>
                        <ActionIcon tone="excel" title="Download Excel" onClick={() => doDownload(i.runId, 'xlsx')} disabled={downloadingKey === `${i.runId}:xlsx`}>
                          {downloadingKey === `${i.runId}:xlsx` ? <Loader2 className="w-4 h-4 animate-spin" /> : <FileSpreadsheet className="w-4 h-4" />}
                        </ActionIcon>
                        <ActionIcon tone="pdf" title="Download PDF" onClick={() => doDownload(i.runId, 'pdf')} disabled={downloadingKey === `${i.runId}:pdf`}>
                          {downloadingKey === `${i.runId}:pdf` ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />}
                        </ActionIcon>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {/* Pagination */}
        {data && data.total > 0 && (
          <div className="flex items-center justify-between px-4 py-3 border-t border-[#EDE9FE] text-sm">
            <span className="text-[#6B7280]">
              {((data.page - 1) * data.pageSize) + 1}–{Math.min(data.page * data.pageSize, data.total)} of {data.total}
            </span>
            <div className="flex items-center gap-1">
              <button onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={data.page <= 1} className="flex items-center gap-1 px-3 py-1.5 text-xs font-medium rounded-lg border border-[#DDD6FE] text-[#6B7280] hover:bg-[#F5F3FF] disabled:opacity-40 disabled:cursor-not-allowed">
                <ChevronLeft className="w-3.5 h-3.5" />Prev
              </button>
              <span className="px-2 text-xs text-[#6B7280]">Page {data.page} of {data.totalPages}</span>
              <button onClick={() => setPage((p) => Math.min(data.totalPages, p + 1))} disabled={data.page >= data.totalPages} className="flex items-center gap-1 px-3 py-1.5 text-xs font-medium rounded-lg border border-[#DDD6FE] text-[#6B7280] hover:bg-[#F5F3FF] disabled:opacity-40 disabled:cursor-not-allowed">
                Next<ChevronRight className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function StatCard({ icon, label, value, tone }: { icon: React.ReactNode; label: string; value: string | number; tone: 'violet' | 'emerald' | 'sky' | 'amber' }) {
  const tones: Record<string, string> = {
    violet: 'bg-violet-50 text-violet-600',
    emerald: 'bg-emerald-50 text-emerald-600',
    sky: 'bg-sky-50 text-sky-600',
    amber: 'bg-amber-50 text-amber-600',
  };
  return (
    <div className="bg-white/80 backdrop-blur-sm rounded-xl border border-[#DDD6FE]/60 p-3.5 flex items-center gap-3">
      <div className={`w-9 h-9 rounded-lg flex items-center justify-center ${tones[tone]}`}>{icon}</div>
      <div>
        <div className="text-lg font-bold text-[#1E1B4B] leading-tight">{value}</div>
        <div className="text-[11px] text-[#6B7280]">{label}</div>
      </div>
    </div>
  );
}
