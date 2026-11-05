/**
 * BRD Management tab — the hero screen.
 *
 * Fetch card (Upload/ADO/Jira/Swagger) + Document Options + live Processing
 * Status, then a searchable/filterable/paginated Extracted Requirements table,
 * an API Mapping table (from the integrated matrix), and the Traceability band.
 * All data is live: BRD requirements from /brd, mapping + coverage from the
 * integrated matrix.
 */
import { useEffect, useMemo, useState } from 'react';
import { ListChecks } from 'lucide-react';
import { useToast } from '@/components/feedback/ToastProvider';
import {
  listBrdDocuments, getBrdDocument,
  type BrdDocument, type BusinessRequirement,
} from '@/services/api';
import { FIELD } from '../format';
import { SectionCard, TableToolbar, Pager, TableHead, EmptyRow } from './shared';
import DocFetchCard from './DocFetchCard';
import ApiMappingPanel from './ApiMappingPanel';
import TraceabilitySection from './TraceabilitySection';
import { paginate, matchesSearch, worstFlag, firstOf, type RmTabProps } from './util';

const PAGE_SIZE = 8;

export default function BrdManagementTab({ runId, dash, matrix, loadingGlobal, username, reloadGlobal, onNavigate }: RmTabProps) {
  const toast = useToast();
  const [docs, setDocs] = useState<BrdDocument[]>([]);
  const [selectedDoc, setSelectedDoc] = useState('');
  const [reqs, setReqs] = useState<BusinessRequirement[]>([]);
  const [loadingReqs, setLoadingReqs] = useState(false);

  const [search, setSearch] = useState('');
  const [flagFilter, setFlagFilter] = useState('all');
  const [page, setPage] = useState(1);

  const loadReqs = async (docId: string) => {
    if (!docId) { setReqs([]); return; }
    setLoadingReqs(true);
    try { setReqs((await getBrdDocument(docId)).requirements); }
    catch (e: any) { toast.error('Could not open BRD', e?.response?.data?.error || 'Please try again.'); }
    finally { setLoadingReqs(false); }
  };

  const refreshDocs = async (selectNewest = false) => {
    try {
      const list = (await listBrdDocuments()).documents;
      setDocs(list);
      if (selectNewest && list.length) { setSelectedDoc(list[0].id); void loadReqs(list[0].id); }
      else if (!selectedDoc && list.length) { setSelectedDoc(list[0].id); void loadReqs(list[0].id); }
    } catch { /* table simply stays empty */ }
  };

  useEffect(() => { void refreshDocs(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);

  const onAnalyzed = async () => { await Promise.all([reloadGlobal(), refreshDocs(true)]); };

  const filtered = useMemo(() => {
    return reqs.filter((r) =>
      (flagFilter === 'all' || worstFlag(r.reviewFlags) === flagFilter) &&
      matchesSearch(search, r.brId, r.title, r.description, r.objective));
  }, [reqs, search, flagFilter]);
  const pg = paginate(filtered, page, PAGE_SIZE);

  // BRD mapping view = BRD requirements and the FRD requirements linked to a BRD
  // (those carry the endpoints), so the panel reads as the mockup's BRD/FRD map.
  const brdMapRows = useMemo(() => (matrix?.rows || []).filter((r) => r.source === 'brd' || (r.source === 'frd' && !!r.brdRef)), [matrix]);

  return (
    <div className="space-y-4">
      {/* Fetch + options + processing */}
      <DocFetchCard kind="BRD" username={username} dash={dash} matrix={matrix} loadingGlobal={loadingGlobal} onAnalyzed={onAnalyzed} />

      {/* Extracted requirements + API mapping */}
      <div className="grid grid-cols-1 xl:grid-cols-5 gap-4">
        <div className="xl:col-span-3">
          <SectionCard
            icon={ListChecks}
            title="Extracted Requirements (BRD)"
            right={docs.length > 0 && (
              <select value={selectedDoc} onChange={(e) => { setSelectedDoc(e.target.value); setPage(1); void loadReqs(e.target.value); }} className={`${FIELD} max-w-[200px]`}>
                {docs.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
              </select>
            )}
          >
            <TableToolbar search={search} onSearch={(v) => { setSearch(v); setPage(1); }} placeholder="Search requirements…">
              <select value={flagFilter} onChange={(e) => { setFlagFilter(e.target.value); setPage(1); }} className={`${FIELD} w-32`}>
                <option value="all">All</option>
                <option value="ok">Clear</option>
                <option value="incomplete">Incomplete</option>
                <option value="ambiguous">Ambiguous</option>
                <option value="conflict">Conflict</option>
              </select>
            </TableToolbar>
            <div className="overflow-x-auto">
              <table className="w-full text-[11.5px]">
                <TableHead cols={[{ label: 'Req ID' }, { label: 'Requirement Name' }, { label: 'Description' }, { label: 'Business Rules' }, { label: 'Acceptance Criteria' }]} />
                <tbody className="divide-y divide-gray-100">
                  {loadingReqs ? <EmptyRow span={5} text="Loading requirements…" />
                    : reqs.length === 0 ? <EmptyRow span={5} text="No BRD analysed yet — fetch one above to get started." />
                    : pg.slice.length === 0 ? <EmptyRow span={5} text="No requirements match your search." />
                    : pg.slice.map((r) => {
                      const rules = firstOf(r.rules); const ac = firstOf(r.acceptanceCriteria);
                      return (
                        <tr key={r.brId} className="align-top hover:bg-gray-50/60">
                          <td className="px-3 py-2 whitespace-nowrap"><span className="font-mono text-[#6D28D9] font-semibold">{r.brId}</span></td>
                          <td className="px-3 py-2 max-w-[160px] font-medium text-gray-800"><div className="truncate" title={r.title}>{r.title}</div></td>
                          <td className="px-3 py-2 max-w-[200px] text-gray-600"><div className="truncate" title={r.description}>{r.description || <span className="text-gray-300">—</span>}</div></td>
                          <td className="px-3 py-2 max-w-[160px] text-gray-600"><div className="truncate" title={rules.full}>{rules.text || <span className="text-gray-300">—</span>}{rules.more > 0 && <span className="text-gray-400"> +{rules.more}</span>}</div></td>
                          <td className="px-3 py-2 max-w-[160px] text-gray-600"><div className="truncate" title={ac.full}>{ac.text || <span className="text-gray-300">—</span>}{ac.more > 0 && <span className="text-gray-400"> +{ac.more}</span>}</div></td>
                        </tr>
                      );
                    })}
                </tbody>
              </table>
            </div>
            <Pager page={pg.page} pageCount={pg.pageCount} from={pg.from} to={pg.to} total={filtered.length} onPage={setPage} />
          </SectionCard>
        </div>

        <div className="xl:col-span-2">
          <ApiMappingPanel rows={brdMapRows} hint="BRD ↔ FRD → endpoints" onViewAll={() => onNavigate('mapping')} />
        </div>
      </div>

      <TraceabilitySection matrix={matrix} runId={runId} />
    </div>
  );
}
