/**
 * ApiMappingPanel — the compact "API Mapping" card on the BRD / FRD tabs, with
 * the mockup's columns: Requirement ID (joined BRD/FRD) · API Endpoint · HTTP
 * Method · Test Cases · Status. A "View All →" link jumps to the full API
 * Mapping tab. Pure read over integrated-matrix rows passed in by the tab.
 */
import { Link2, ArrowRight } from 'lucide-react';
import { pathOf } from '../format';
import type { IntegratedRow } from '@/services/api';
import { SectionCard, TableHead, EmptyRow, MethodBadge, MappingBadge } from './shared';
import { combinedReqId } from './util';

export default function ApiMappingPanel({ rows, hint, onViewAll, limit = 8 }: { rows: IntegratedRow[]; hint?: string; onViewAll?: () => void; limit?: number }) {
  const shown = rows.slice(0, limit);
  return (
    <SectionCard
      icon={Link2}
      title="API Mapping"
      hint={hint}
      right={onViewAll && <button type="button" onClick={onViewAll} className="inline-flex items-center gap-1 text-[12px] font-semibold text-[#7C3AED] hover:text-[#6D28D9]">View All<ArrowRight className="w-3.5 h-3.5" /></button>}
    >
      <div className="overflow-x-auto">
        <table className="w-full text-[11.5px]">
          <TableHead cols={[{ label: 'Requirement ID' }, { label: 'API Endpoint' }, { label: 'HTTP Method' }, { label: 'Test Cases' }, { label: 'Status' }]} />
          <tbody className="divide-y divide-gray-100">
            {rows.length === 0 && <EmptyRow span={5} text="No mappings yet." />}
            {shown.map((r, i) => {
              const ep = r.endpoints[0];
              return (
                <tr key={`${r.source}-${r.reqKey}-${i}`} className="align-top hover:bg-gray-50/60">
                  <td className="px-3 py-2 whitespace-nowrap"><span className="font-mono text-[#6D28D9] font-semibold">{combinedReqId(r)}</span></td>
                  <td className="px-3 py-2 font-mono text-gray-600 max-w-[150px] truncate" title={ep?.url}>{ep ? pathOf(ep.url) : <span className="text-gray-300">—</span>}</td>
                  <td className="px-3 py-2">{ep ? <MethodBadge method={ep.method} /> : <span className="text-gray-300">—</span>}</td>
                  <td className="px-3 py-2 text-gray-600 tabular-nums">{r.cases.length || <span className="text-gray-300">0</span>}</td>
                  <td className="px-3 py-2"><MappingBadge mapped={r.endpoints.length > 0} /></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </SectionCard>
  );
}
