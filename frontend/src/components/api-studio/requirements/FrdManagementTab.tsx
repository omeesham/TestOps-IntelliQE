/**
 * FRD Management tab — same intake shape as BRD, but the extracted table shows
 * the API shape each functional requirement implies (endpoint, parameters,
 * responses), and the mapping table reads the FRD rows of the integrated matrix.
 */
import { useEffect, useMemo, useState } from 'react';
import { ClipboardCheck } from 'lucide-react';
import { useToast } from '@/components/feedback/ToastProvider';
import {
  listFrdDocuments, getFrdDocument,
  type FrdDocument, type FunctionalRequirement,
} from '@/services/api';
import { FIELD } from '../format';
import { SectionCard, TableToolbar, Pager, TableHead, EmptyRow, MethodBadge } from './shared';
import DocFetchCard from './DocFetchCard';
import ApiMappingPanel from './ApiMappingPanel';
import { paginate, matchesSearch, worstFlag, type RmTabProps } from './util';

const PAGE_SIZE = 8;

export default function FrdManagementTab({ dash, matrix, loadingGlobal, username, reloadGlobal, onNavigate }: RmTabProps) {
  const toast = useToast();
  const [docs, setDocs] = useState<FrdDocument[]>([]);
  const [selectedDoc, setSelectedDoc] = useState('');
  const [reqs, setReqs] = useState<FunctionalRequirement[]>([]);
  const [loadingReqs, setLoadingReqs] = useState(false);

  const [search, setSearch] = useState('');
  const [flagFilter, setFlagFilter] = useState('all');
  const [page, setPage] = useState(1);

  const loadReqs = async (docId: string) => {
    if (!docId) { setReqs([]); return; }
    setLoadingReqs(true);
    try { setReqs((await getFrdDocument(docId)).requirements); }
    catch (e: any) { toast.error('Could not open FRD', e?.response?.data?.error || 'Please try again.'); }
    finally { setLoadingReqs(false); }
  };

  const refreshDocs = async (selectNewest = false) => {
    try {
      const list = (await listFrdDocuments()).documents;
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
      matchesSearch(search, r.frId, r.title, r.description, r.auth, (r.endpoints || []).map((e) => `${e.method} ${e.path}`).join(' ')));
  }, [reqs, search, flagFilter]);
  const pg = paginate(filtered, page, PAGE_SIZE);

  const frdMapRows = useMemo(() => (matrix?.rows || []).filter((r) => r.source === 'frd'), [matrix]);

  return (
    <div className="space-y-4">
      <DocFetchCard kind="FRD" username={username} dash={dash} matrix={matrix} loadingGlobal={loadingGlobal} onAnalyzed={onAnalyzed} />

      <div className="grid grid-cols-1 xl:grid-cols-5 gap-4">
        <div className="xl:col-span-3">
          <SectionCard
            icon={ClipboardCheck}
            title="Extracted Requirements (FRD)"
            right={docs.length > 0 && (
              <select value={selectedDoc} onChange={(e) => { setSelectedDoc(e.target.value); setPage(1); void loadReqs(e.target.value); }} className={`${FIELD} max-w-[200px]`}>
                {docs.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
              </select>
            )}
          >
            <TableToolbar search={search} onSearch={(v) => { setSearch(v); setPage(1); }} placeholder="Search functional requirements…">
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
                <TableHead cols={[{ label: 'FR ID' }, { label: 'Requirement Name' }, { label: 'Description' }, { label: 'API Endpoint' }, { label: 'HTTP Method' }, { label: 'Responses' }]} />
                <tbody className="divide-y divide-gray-100">
                  {loadingReqs ? <EmptyRow span={6} text="Loading requirements…" />
                    : reqs.length === 0 ? <EmptyRow span={6} text="No FRD analysed yet — fetch one above to get started." />
                    : pg.slice.length === 0 ? <EmptyRow span={6} text="No requirements match your search." />
                    : pg.slice.map((r) => {
                      const ep = (r.endpoints || [])[0];
                      return (
                        <tr key={r.frId} className="align-top hover:bg-gray-50/60">
                          <td className="px-3 py-2 whitespace-nowrap"><span className="font-mono text-[#4338CA] font-semibold">{r.frId}</span></td>
                          <td className="px-3 py-2 max-w-[160px] font-medium text-gray-800"><div className="truncate" title={r.title}>{r.title}</div></td>
                          <td className="px-3 py-2 max-w-[200px] text-gray-600"><div className="truncate" title={r.description}>{r.description || <span className="text-gray-300">—</span>}</div></td>
                          <td className="px-3 py-2 max-w-[160px]">{ep ? <span className="font-mono text-gray-600 truncate inline-block max-w-full align-bottom" title={ep.path}>{ep.path}{(r.endpoints?.length || 0) > 1 && <span className="text-gray-400"> +{(r.endpoints!.length) - 1}</span>}</span> : <span className="text-gray-300">—</span>}</td>
                          <td className="px-3 py-2">{ep ? <MethodBadge method={ep.method} /> : <span className="text-gray-300">—</span>}</td>
                          <td className="px-3 py-2 text-gray-600 tabular-nums">{r.responses?.length || 0}</td>
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
          <ApiMappingPanel rows={frdMapRows} hint="FRD → endpoints" onViewAll={() => onNavigate('mapping')} />
        </div>
      </div>
    </div>
  );
}
