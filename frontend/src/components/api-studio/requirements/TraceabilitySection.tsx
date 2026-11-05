/**
 * TraceabilitySection — the bottom "Traceability Matrix" band (donut + table +
 * Export Excel), reused across the dashboard. Pure read over the integrated
 * matrix the backend already builds; the .xlsx is the server-rendered RTM.
 */
import { useMemo, useState } from 'react';
import { Waypoints, FileSpreadsheet, Loader2 } from 'lucide-react';
import { useToast } from '@/components/feedback/ToastProvider';
import { downloadRtmXlsx, type IntegratedMatrix, type IntegratedRow } from '@/services/api';
import { FIELD, pathOf } from '../format';
import { SectionCard, CoverageDonut, SourceBadge, MethodBadge, AutomationChip, ExecutionPill, TableHead, EmptyRow } from './shared';
import { coverageSegments } from './util';

type StatusFilter = 'all' | IntegratedRow['status'];

function rowCoverage(r: IntegratedRow): number {
  const total = r.passed + r.failed + r.notRun;
  if (total === 0) return 0;
  return Math.round((r.passed / total) * 100);
}

export default function TraceabilitySection({ matrix, runId }: { matrix: IntegratedMatrix | null; runId: string }) {
  const toast = useToast();
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [busy, setBusy] = useState(false);

  const rows = useMemo(() => {
    const all = matrix?.rows || [];
    return statusFilter === 'all' ? all : all.filter((r) => r.status === statusFilter);
  }, [matrix, statusFilter]);

  const segs = coverageSegments(matrix?.summary);
  const coveragePct = matrix?.summary.coveragePct ?? 0;

  const exportXlsx = async () => {
    setBusy(true);
    try {
      const blob = await downloadRtmXlsx(runId || undefined);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = `rtm-${new Date().toISOString().slice(0, 10)}.xlsx`;
      a.click(); URL.revokeObjectURL(url);
    } catch (e: any) { toast.fromError(e); }
    finally { setBusy(false); }
  };

  return (
    <SectionCard
      icon={Waypoints}
      title="Traceability Matrix"
      hint={`${matrix?.summary.total ?? 0} requirements · ${coveragePct}% coverage`}
      right={(
        <>
          <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as StatusFilter)} className={`${FIELD} w-32`}>
            <option value="all">All status</option>
            <option value="covered">Covered</option>
            <option value="partial">Partial</option>
            <option value="failing">Failing</option>
            <option value="uncovered">Uncovered</option>
          </select>
          <button type="button" onClick={() => void exportXlsx()} disabled={busy || !matrix} className="inline-flex items-center gap-1.5 px-3 py-1.5 text-[12px] font-semibold text-[#7C3AED] bg-[#F5F3FF] border border-[#DDD6FE] rounded-lg hover:bg-[#EDE9FE] disabled:opacity-40">
            {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <FileSpreadsheet className="w-3.5 h-3.5" />}Export Excel
          </button>
        </>
      )}
    >
      <div className="grid grid-cols-1 lg:grid-cols-[auto,1fr] gap-5 items-start">
        <div className="lg:pr-5 lg:border-r border-[#F0EDFA]">
          <CoverageDonut segments={segs} centerValue={`${coveragePct}%`} centerLabel="Coverage" />
        </div>
        <div className="min-w-0 overflow-x-auto">
          <table className="w-full text-[11.5px]">
            <TableHead cols={[
              { label: 'Req ID' }, { label: 'Requirement Description' }, { label: 'API Endpoint' },
              { label: 'HTTP Method' }, { label: 'Test Case ID' }, { label: 'Automation Status' },
              { label: 'Execution Status' }, { label: 'Coverage', className: 'text-right' },
            ]} />
            <tbody className="divide-y divide-gray-100">
              {rows.length === 0 && <EmptyRow span={8} text="No requirements match this filter yet." />}
              {rows.map((r, i) => {
                const ep = r.endpoints[0];
                const firstCase = r.cases[0];
                return (
                  <tr key={`${r.source}-${r.reqKey}-${i}`} className="align-top hover:bg-gray-50/60">
                    <td className="px-3 py-2 whitespace-nowrap"><span className="inline-flex items-center gap-1.5"><SourceBadge source={r.source} /><span className="font-mono text-[#6D28D9] font-semibold">{r.reqKey}</span></span></td>
                    <td className="px-3 py-2 text-gray-700 max-w-[220px] truncate" title={r.title}>{r.title}</td>
                    <td className="px-3 py-2 font-mono text-gray-600 max-w-[200px] truncate" title={ep?.url}>{ep ? pathOf(ep.url) : <span className="text-gray-300">—</span>}{r.endpoints.length > 1 && <span className="text-gray-400"> +{r.endpoints.length - 1}</span>}</td>
                    <td className="px-3 py-2">{ep ? <MethodBadge method={ep.method} /> : <span className="text-gray-300">—</span>}</td>
                    <td className="px-3 py-2 font-mono text-gray-600 whitespace-nowrap">{firstCase ? <>{firstCase.id}{r.cases.length > 1 && <span className="text-gray-400"> +{r.cases.length - 1}</span>}</> : <span className="text-gray-300">—</span>}</td>
                    <td className="px-3 py-2"><AutomationChip generated={r.cases.length > 0} /></td>
                    <td className="px-3 py-2"><ExecutionPill status={r.status} /></td>
                    <td className="px-3 py-2 text-right font-semibold tabular-nums text-gray-700">{rowCoverage(r)}%</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </SectionCard>
  );
}
