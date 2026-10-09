/**
 * AuditLog — a viewer over the platform's existing audit trail.
 *
 * The backend already records an audit row for every meaningful action; this is
 * the missing viewer: filter by action / resource type / user / date / free
 * text, page through the results, and export the current filter as CSV. Strictly
 * read-only.
 */
import { useEffect, useState } from 'react';
import { ScrollText, X, Download, Search, ChevronLeft, ChevronRight } from 'lucide-react';
import Spinner from '@/components/feedback/Spinner';
import { useToast } from '@/components/feedback/ToastProvider';
import { listAudit, getAuditFacets, exportAuditCsv, type AuditEntry, type AuditFacets, type AuditFilters } from '@/services/api';
import { CARD, STRIP, INPUT, FIELD, LABEL, SECONDARY_BTN, THEAD, relativeTime } from './format';

const PAGE_SIZE = 25;
const clip = (s: string, n = 90) => (s.length > n ? `${s.slice(0, n)}…` : s);

export default function AuditLog({ onClose }: { onClose: () => void }) {
  const toast = useToast();
  const [facets, setFacets] = useState<AuditFacets>({ actions: [], resourceTypes: [], usernames: [] });
  const [filters, setFilters] = useState<AuditFilters>({});
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const [items, setItems] = useState<AuditEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => { void getAuditFacets().then(setFacets).catch(() => { /* facets are a convenience */ }); }, []);

  const load = async (p: number, f: AuditFilters) => {
    setLoading(true); setError('');
    try {
      const res = await listAudit({ ...f, page: p, pageSize: PAGE_SIZE });
      setItems(res.items); setTotal(res.total); setPage(res.page);
    } catch (e: any) {
      setError(e?.response?.data?.error || e?.message || 'Request failed.');
    } finally { setLoading(false); }
  };
  useEffect(() => { void load(1, {}); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);

  const apply = () => { const f = { ...filters, q: q.trim() || undefined }; setFilters(f); void load(1, f); };
  const patch = (p: Partial<AuditFilters>) => setFilters((prev) => ({ ...prev, ...p }));

  const exportCsv = async () => {
    try {
      const blob = await exportAuditCsv({ ...filters, q: q.trim() || undefined });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a'); a.href = url; a.download = 'audit-log.csv'; document.body.appendChild(a); a.click(); a.remove();
      URL.revokeObjectURL(url);
    } catch (e: any) {
      toast.error('Export failed', e?.response?.data?.error || e?.message || 'Request failed.');
    }
  };

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-[#1E1B4B]/30 backdrop-blur-sm p-4" onClick={onClose}>
      <div className={`${CARD} w-full max-w-4xl max-h-[88vh] flex flex-col overflow-hidden`} onClick={(e) => e.stopPropagation()}>
        <div className={`flex items-center gap-2 px-4 h-12 border-b border-[#EDE9FE] flex-shrink-0 ${STRIP}`}>
          <ScrollText className="w-4 h-4 text-[#7C3AED]" />
          <h3 className="text-[13px] font-semibold text-gray-900">Audit log</h3>
          <span className="text-[11px] text-gray-400">every recorded action, filterable</span>
          <button type="button" onClick={() => void exportCsv()} className={`${SECONDARY_BTN} ml-auto`}><Download className="w-3.5 h-3.5" />CSV</button>
          <button type="button" onClick={onClose} className="p-1.5 rounded-md text-gray-400 hover:text-[#7C3AED] hover:bg-[#F5F3FF]"><X className="w-4 h-4" /></button>
        </div>

        <div className="p-4 space-y-3 overflow-y-auto min-h-0">
          {/* Filters */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
            <div>
              <label className={LABEL}>Action</label>
              <select value={filters.action || ''} onChange={(e) => patch({ action: e.target.value || undefined })} className={FIELD}>
                <option value="">any</option>
                {facets.actions.map((a) => <option key={a} value={a}>{a}</option>)}
              </select>
            </div>
            <div>
              <label className={LABEL}>Resource</label>
              <select value={filters.resourceType || ''} onChange={(e) => patch({ resourceType: e.target.value || undefined })} className={FIELD}>
                <option value="">any</option>
                {facets.resourceTypes.map((a) => <option key={a} value={a}>{a}</option>)}
              </select>
            </div>
            <div>
              <label className={LABEL}>User</label>
              <select value={filters.username || ''} onChange={(e) => patch({ username: e.target.value || undefined })} className={FIELD}>
                <option value="">any</option>
                {facets.usernames.map((a) => <option key={a} value={a}>{a}</option>)}
              </select>
            </div>
            <div>
              <label className={LABEL}>From</label>
              <input type="date" value={filters.from?.slice(0, 10) || ''} onChange={(e) => patch({ from: e.target.value || undefined })} className={FIELD} />
            </div>
          </div>
          <div className="flex items-end gap-2">
            <div className="flex-1 min-w-0">
              <label className={LABEL}>Search (resource id / user / details)</label>
              <input value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') apply(); }} placeholder="search…" className={INPUT} />
            </div>
            <button type="button" onClick={apply} className={SECONDARY_BTN}><Search className="w-3.5 h-3.5" />Apply</button>
          </div>

          {error && <p className="text-[12px] text-red-600">{error}</p>}

          {/* Table */}
          <div className="border border-[#E9E5FB] rounded-lg overflow-hidden">
            <table className="w-full text-[11.5px]">
              <thead className={THEAD}>
                <tr className="text-gray-500 text-left">
                  <th className="font-semibold px-2.5 py-1.5">When</th>
                  <th className="font-semibold px-2.5 py-1.5">User</th>
                  <th className="font-semibold px-2.5 py-1.5">Action</th>
                  <th className="font-semibold px-2.5 py-1.5">Resource</th>
                  <th className="font-semibold px-2.5 py-1.5">Details</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {loading && <tr><td colSpan={5} className="px-2.5 py-6 text-center text-gray-400"><Spinner className="w-4 h-4 animate-spin inline" /></td></tr>}
                {!loading && items.length === 0 && <tr><td colSpan={5} className="px-2.5 py-6 text-center text-gray-400">No audit entries match.</td></tr>}
                {!loading && items.map((e) => (
                  <tr key={e.id} className="align-top">
                    <td className="px-2.5 py-1.5 text-gray-500 whitespace-nowrap" title={e.createdAt}>{relativeTime(e.createdAt)}</td>
                    <td className="px-2.5 py-1.5 text-gray-700">{e.username}</td>
                    <td className="px-2.5 py-1.5"><span className="inline-flex px-1.5 py-0.5 rounded bg-[#EDE9FE] text-[#6D28D9] font-medium">{e.action}</span></td>
                    <td className="px-2.5 py-1.5 text-gray-600 font-mono">{e.resourceType}{e.resourceId ? <span className="text-gray-400"> · {clip(e.resourceId, 24)}</span> : null}</td>
                    <td className="px-2.5 py-1.5 text-gray-500 font-mono break-all">{clip(JSON.stringify(e.details || {}))}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Pagination */}
          <div className="flex items-center justify-between text-[11.5px] text-gray-500">
            <span className="tabular-nums">{total} entr{total === 1 ? 'y' : 'ies'}</span>
            <div className="flex items-center gap-2">
              <button type="button" disabled={page <= 1 || loading} onClick={() => void load(page - 1, filters)} className="p-1 rounded disabled:opacity-30 hover:text-[#7C3AED]"><ChevronLeft className="w-4 h-4" /></button>
              <span className="tabular-nums">{page} / {totalPages}</span>
              <button type="button" disabled={page >= totalPages || loading} onClick={() => void load(page + 1, filters)} className="p-1 rounded disabled:opacity-30 hover:text-[#7C3AED]"><ChevronRight className="w-4 h-4" /></button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
