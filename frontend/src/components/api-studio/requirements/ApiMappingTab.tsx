/**
 * API Mapping tab — the full requirement→API map across every source, from the
 * integrated matrix. Filter by source and by mapped/unmapped, search, paginate.
 * The "Re-map BRD↔FRD" action runs the deterministic linker and refreshes the
 * shared matrix. Columns only show what the backend actually knows — no invented
 * request/response schemas.
 */
import { useMemo, useState } from 'react';
import { Link2, GitCompareArrows, Loader2 } from 'lucide-react';
import { useToast } from '@/components/feedback/ToastProvider';
import { mapBrdFrd, type IntegratedRow } from '@/services/api';
import { FIELD, pathOf } from '../format';
import { SectionCard, TableToolbar, Pager, TableHead, EmptyRow, MethodBadge, MappingBadge, SourceBadge, StatusPill } from './shared';
import { paginate, matchesSearch, type RmTabProps } from './util';

const PAGE_SIZE = 12;

export default function ApiMappingTab({ matrix, reloadGlobal }: RmTabProps) {
  const toast = useToast();
  const [search, setSearch] = useState('');
  const [sourceFilter, setSourceFilter] = useState<'all' | IntegratedRow['source']>('all');
  const [mapFilter, setMapFilter] = useState<'all' | 'mapped' | 'unmapped'>('all');
  const [page, setPage] = useState(1);
  const [remapping, setRemapping] = useState(false);

  const rows = useMemo(() => {
    const all = matrix?.rows || [];
    return all.filter((r) => {
      const mapped = r.endpoints.length > 0;
      return (sourceFilter === 'all' || r.source === sourceFilter)
        && (mapFilter === 'all' || (mapFilter === 'mapped' ? mapped : !mapped))
        && matchesSearch(search, r.reqKey, r.title, r.endpoints.map((e) => `${e.method} ${e.url}`).join(' '));
    });
  }, [matrix, sourceFilter, mapFilter, search]);
  const pg = paginate(rows, page, PAGE_SIZE);

  const mappedCount = (matrix?.rows || []).filter((r) => r.endpoints.length > 0).length;
  const total = matrix?.rows.length || 0;

  const remap = async () => {
    setRemapping(true);
    try {
      const res = await mapBrdFrd();
      toast.success('BRD ↔ FRD re-mapped', `${res.summary.mapped} of ${res.summary.frTotal} functional requirements linked.`);
      await reloadGlobal();
    } catch (e: any) { toast.error('Could not re-map', e?.response?.data?.error || 'Need both BRD and FRD requirements first.'); }
    finally { setRemapping(false); }
  };

  return (
    <SectionCard
      icon={Link2}
      title="API Mapping"
      hint={`${mappedCount} of ${total} requirements mapped to endpoints`}
      right={<button type="button" onClick={() => void remap()} disabled={remapping} className="inline-flex items-center gap-1.5 px-3 py-1.5 text-[12px] font-semibold text-[#7C3AED] bg-[#F5F3FF] border border-[#DDD6FE] rounded-lg hover:bg-[#EDE9FE] disabled:opacity-40">{remapping ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <GitCompareArrows className="w-3.5 h-3.5" />}Re-map BRD↔FRD</button>}
    >
      <TableToolbar search={search} onSearch={(v) => { setSearch(v); setPage(1); }} placeholder="Search requirements or endpoints…">
        <select value={sourceFilter} onChange={(e) => { setSourceFilter(e.target.value as any); setPage(1); }} className={`${FIELD} w-28`}>
          <option value="all">All sources</option>
          <option value="brd">BRD</option>
          <option value="frd">FRD</option>
          <option value="manual">Manual</option>
        </select>
        <select value={mapFilter} onChange={(e) => { setMapFilter(e.target.value as any); setPage(1); }} className={`${FIELD} w-32`}>
          <option value="all">All</option>
          <option value="mapped">Mapped</option>
          <option value="unmapped">Unmapped</option>
        </select>
      </TableToolbar>
      <div className="overflow-x-auto">
        <table className="w-full text-[11.5px]">
          <TableHead cols={[
            { label: 'Source' }, { label: 'Req ID' }, { label: 'Requirement' }, { label: 'API Endpoint' },
            { label: 'Method' }, { label: 'Test Cases' }, { label: 'Execution' }, { label: 'Mapping' },
          ]} />
          <tbody className="divide-y divide-gray-100">
            {!matrix ? <EmptyRow span={8} text="Loading mapping…" />
              : pg.slice.length === 0 ? <EmptyRow span={8} text="No requirements match this filter." />
              : pg.slice.map((r, i) => {
                const ep = r.endpoints[0];
                return (
                  <tr key={`${r.source}-${r.reqKey}-${i}`} className="align-top hover:bg-gray-50/60">
                    <td className="px-3 py-2"><SourceBadge source={r.source} /></td>
                    <td className="px-3 py-2 whitespace-nowrap"><span className="font-mono text-[#6D28D9] font-semibold">{r.reqKey}</span></td>
                    <td className="px-3 py-2 max-w-[220px] truncate text-gray-700" title={r.title}>{r.title}</td>
                    <td className="px-3 py-2 font-mono text-gray-600 max-w-[200px] truncate" title={ep?.url}>{ep ? pathOf(ep.url) : <span className="text-gray-300">—</span>}{r.endpoints.length > 1 && <span className="text-gray-400"> +{r.endpoints.length - 1}</span>}</td>
                    <td className="px-3 py-2">{ep ? <MethodBadge method={ep.method} /> : <span className="text-gray-300">—</span>}</td>
                    <td className="px-3 py-2 text-gray-600 tabular-nums">{r.cases.length || <span className="text-gray-300">0</span>}</td>
                    <td className="px-3 py-2"><StatusPill status={r.status} /></td>
                    <td className="px-3 py-2"><MappingBadge mapped={r.endpoints.length > 0} /></td>
                  </tr>
                );
              })}
          </tbody>
        </table>
      </div>
      <Pager page={pg.page} pageCount={pg.pageCount} from={pg.from} to={pg.to} total={rows.length} onPage={setPage} />
    </SectionCard>
  );
}
