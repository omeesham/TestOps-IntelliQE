import { useState, useEffect } from 'react';
import { Download, Loader2, BarChart3, Database, ShieldCheck, AlertTriangle } from 'lucide-react';
import { getExecutionReport, downloadArtifactZip } from '../../services/api';
import type { RunReport } from '../../types';

interface ReportsTabProps {
  runId: string;
}

export default function ReportsTab({ runId }: ReportsTabProps) {
  const [loading, setLoading] = useState(true);
  const [downloading, setDownloading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [report, setReport] = useState<RunReport | null>(null);

  useEffect(() => {
    let mounted = true;
    setLoading(true);
    getExecutionReport(runId)
      .then((data) => {
        if (!mounted) return;
        setReport(data);
        setError(null);
      })
      .catch((err) => {
        if (!mounted) return;
        setError(err?.response?.status === 404 ? 'No report available for this run.' : 'Failed to load report.');
      })
      .finally(() => { if (mounted) setLoading(false); });
    return () => { mounted = false; };
  }, [runId]);

  const handleDownload = async () => {
    setDownloading(true);
    try {
      await downloadArtifactZip(runId);
    } catch {
      alert('Failed to download artifacts. Please try again.');
    } finally {
      setDownloading(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16 text-gray-400">
        <Loader2 className="w-5 h-5 animate-spin mr-2" />
        Loading report...
      </div>
    );
  }

  if (error || !report) {
    return (
      <div className="flex flex-col items-center justify-center py-16 text-gray-400">
        <BarChart3 className="w-10 h-10 mb-3 opacity-40" />
        <p>{error || 'No report available.'}</p>
      </div>
    );
  }

  const { executionSummary, dataReport, accessibilityReport } = report;

  return (
    <div className="space-y-6">
      {/* Download button */}
      <div className="flex justify-end">
        <button
          onClick={handleDownload}
          disabled={downloading}
          className="flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-sm font-medium transition-colors disabled:opacity-50"
        >
          {downloading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />}
          {downloading ? 'Preparing ZIP...' : 'Download All Artifacts (ZIP)'}
        </button>
      </div>

      {/* Execution Summary Cards */}
      <div>
        <h3 className="text-sm font-semibold text-gray-300 mb-3 flex items-center gap-2">
          <BarChart3 className="w-4 h-4" /> Execution Summary
        </h3>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <StatCard label="Total Tests" value={executionSummary.total_tests} color="blue" />
          <StatCard label="Passed" value={executionSummary.passed} color="green" />
          <StatCard label="Failed" value={executionSummary.failed} color="red" />
          <StatCard label="Pass Rate" value={`${executionSummary.pass_rate}%`} color={executionSummary.pass_rate >= 80 ? 'green' : executionSummary.pass_rate >= 50 ? 'yellow' : 'red'} />
        </div>
      </div>

      {/* Type Breakdown */}
      {Object.keys(executionSummary.type_breakdown).length > 0 && (
        <div>
          <h4 className="text-xs font-semibold text-gray-400 mb-2 uppercase tracking-wider">Test Type Breakdown</h4>
          <div className="space-y-2">
            {Object.entries(executionSummary.type_breakdown).map(([type, count]) => {
              const pct = executionSummary.total_tests > 0 ? Math.round((count / executionSummary.total_tests) * 100) : 0;
              return (
                <div key={type} className="flex items-center gap-3">
                  <span className="text-xs text-gray-400 w-20 text-right">{type}</span>
                  <div className="flex-1 h-5 bg-gray-800 rounded-full overflow-hidden">
                    <div className="h-full bg-blue-600 rounded-full transition-all" style={{ width: `${pct}%` }} />
                  </div>
                  <span className="text-xs text-gray-300 w-16">{count} ({pct}%)</span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Priority Breakdown */}
      {Object.keys(executionSummary.priority_breakdown).length > 0 && (
        <div>
          <h4 className="text-xs font-semibold text-gray-400 mb-2 uppercase tracking-wider">Priority Breakdown</h4>
          <div className="flex gap-3">
            {Object.entries(executionSummary.priority_breakdown).map(([priority, count]) => (
              <div key={priority} className="flex items-center gap-1.5 px-3 py-1.5 bg-gray-800 rounded">
                <span className={`text-xs font-bold ${
                  priority === 'P0' ? 'text-red-400' :
                  priority === 'P1' ? 'text-orange-400' :
                  priority === 'P2' ? 'text-yellow-400' : 'text-gray-400'
                }`}>{priority}</span>
                <span className="text-sm text-gray-300">{count}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Data Report */}
      <div>
        <h3 className="text-sm font-semibold text-gray-300 mb-3 flex items-center gap-2">
          <Database className="w-4 h-4" /> Data Coverage Report
        </h3>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <StatCard label="Datasets" value={dataReport.total_datasets} color="purple" />
          <StatCard label="Field Data" value={dataReport.total_field_data} color="blue" />
          <StatCard label="Mappings" value={dataReport.total_mappings} color="green" />
          <StatCard label="Coverage" value={`${dataReport.mapping_coverage}%`} color={dataReport.mapping_coverage >= 80 ? 'green' : 'yellow'} />
        </div>

        {dataReport.unmapped_test_cases.length > 0 && (
          <div className="mt-3 p-3 bg-yellow-900/20 border border-yellow-800 rounded">
            <p className="text-xs text-yellow-400 flex items-center gap-1">
              <AlertTriangle className="w-3.5 h-3.5" />
              {dataReport.unmapped_test_cases.length} test case(s) have no mapped dataset:
            </p>
            <p className="text-xs text-yellow-300 mt-1 font-mono">
              {dataReport.unmapped_test_cases.join(', ')}
            </p>
          </div>
        )}

        {Object.keys(dataReport.datasets_by_role).length > 0 && (
          <div className="mt-3">
            <h4 className="text-xs text-gray-400 mb-1">Datasets by Role</h4>
            <div className="flex gap-2">
              {Object.entries(dataReport.datasets_by_role).map(([role, count]) => (
                <span key={role} className="px-2 py-1 bg-gray-800 rounded text-xs text-gray-300">
                  {role}: <span className="text-purple-300">{count}</span>
                </span>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Accessibility Report */}
      {accessibilityReport && (
        <div>
          <h3 className="text-sm font-semibold text-gray-300 mb-3 flex items-center gap-2">
            <ShieldCheck className="w-4 h-4" /> Accessibility Report (WCAG)
          </h3>
          <div className="grid grid-cols-3 gap-3">
            <StatCard label="Elements Checked" value={accessibilityReport.total_elements_checked} color="blue" />
            <StatCard label="Passed" value={accessibilityReport.pass_count} color="green" />
            <StatCard label="Violations" value={accessibilityReport.fail_count} color={accessibilityReport.fail_count > 0 ? 'red' : 'green'} />
          </div>
          {accessibilityReport.violations.length > 0 && (
            <div className="mt-3 overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-gray-400 border-b border-gray-700">
                    <th className="pb-2 pr-4">Element</th>
                    <th className="pb-2 pr-4">Violation</th>
                    <th className="pb-2 pr-4">Severity</th>
                    <th className="pb-2">Recommendation</th>
                  </tr>
                </thead>
                <tbody>
                  {accessibilityReport.violations.map((v, i) => (
                    <tr key={i} className="border-b border-gray-800">
                      <td className="py-2 pr-4 font-mono text-xs">{v.element}</td>
                      <td className="py-2 pr-4 text-gray-300">{v.violation}</td>
                      <td className="py-2 pr-4">
                        <span className={`px-2 py-0.5 rounded text-xs ${
                          v.severity === 'critical' ? 'bg-red-900/40 text-red-300' :
                          v.severity === 'serious' ? 'bg-orange-900/40 text-orange-300' :
                          v.severity === 'moderate' ? 'bg-yellow-900/40 text-yellow-300' :
                          'bg-gray-700 text-gray-300'
                        }`}>{v.severity}</span>
                      </td>
                      <td className="py-2 text-xs text-gray-400">{v.recommendation}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function StatCard({ label, value, color }: { label: string; value: number | string; color: string }) {
  const colorMap: Record<string, string> = {
    blue: 'bg-blue-900/30 border-blue-800 text-blue-300',
    green: 'bg-green-900/30 border-green-800 text-green-300',
    red: 'bg-red-900/30 border-red-800 text-red-300',
    yellow: 'bg-yellow-900/30 border-yellow-800 text-yellow-300',
    purple: 'bg-purple-900/30 border-purple-800 text-purple-300',
  };

  return (
    <div className={`p-3 rounded-lg border ${colorMap[color] || colorMap.blue}`}>
      <p className="text-xs text-gray-400 mb-1">{label}</p>
      <p className="text-xl font-bold">{value}</p>
    </div>
  );
}
