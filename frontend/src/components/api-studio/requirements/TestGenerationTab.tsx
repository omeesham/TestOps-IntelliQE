/**
 * Test Case Generation tab — the test cases already generated for each
 * requirement, read from the integrated matrix (requirement → case →
 * execution/automation status). Searchable, filterable, paginated. Coverage
 * tiles show how many requirements have cases vs none. Generation itself runs in
 * the API Automation pipeline (Endpoints → design) — this tab hands off to it
 * rather than faking an inline generator.
 */
import { useMemo, useState } from 'react';
import { FlaskConical, ArrowRight } from 'lucide-react';
import { CARD, pathOf } from '../format';
import { SectionCard, TableToolbar, Pager, TableHead, EmptyRow, MethodBadge, SourceBadge } from './shared';
import { paginate, matchesSearch, type RmTabProps } from './util';

const PAGE_SIZE = 12;

interface CaseRow { caseId: string; title: string; reqKey: string; source: string; endpoint?: string; method?: string; status: string; automated: boolean }

function CaseStatusPill({ status }: { status: string }) {
  const s = (status || '').toLowerCase();
  const cls = s.includes('pass') ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
    : s.includes('fail') ? 'bg-red-50 text-red-700 border-red-200'
    : 'bg-gray-100 text-gray-500 border-gray-200';
  const label = s.includes('pass') ? 'Passed' : s.includes('fail') ? 'Failed' : status || 'Not run';
  return <span className={`inline-flex px-1.5 py-0.5 rounded border text-[10.5px] font-semibold ${cls}`}>{label}</span>;
}

export default function TestGenerationTab({ matrix, onClose }: RmTabProps) {
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [page, setPage] = useState(1);

  const cases: CaseRow[] = useMemo(() => {
    const out: CaseRow[] = [];
    for (const r of matrix?.rows || []) {
      const ep = r.endpoints[0];
      for (const c of r.cases) {
        out.push({
          caseId: c.id, title: c.title, reqKey: r.reqKey, source: r.source,
          endpoint: ep ? pathOf(ep.url) : undefined, method: ep?.method,
          status: c.status, automated: (r.scriptPaths?.length || 0) > 0,
        });
      }
    }
    return out;
  }, [matrix]);

  const coverage = useMemo(() => {
    const rows = matrix?.rows || [];
    const withCases = rows.filter((r) => r.cases.length > 0).length;
    return { reqs: rows.length, withCases, withoutCases: rows.length - withCases, cases: cases.length, automated: cases.filter((c) => c.automated).length };
  }, [matrix, cases]);

  const filtered = useMemo(() => cases.filter((c) => {
    const s = (c.status || '').toLowerCase();
    const matchStatus = statusFilter === 'all'
      || (statusFilter === 'passed' && s.includes('pass'))
      || (statusFilter === 'failed' && s.includes('fail'))
      || (statusFilter === 'notrun' && !s.includes('pass') && !s.includes('fail'));
    return matchStatus && matchesSearch(search, c.caseId, c.title, c.reqKey, c.endpoint);
  }), [cases, search, statusFilter]);
  const pg = paginate(filtered, page, PAGE_SIZE);

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
        <Tile label="Requirements" value={coverage.reqs} accent="#6366F1" />
        <Tile label="With test cases" value={coverage.withCases} accent="#10B981" />
        <Tile label="Without cases" value={coverage.withoutCases} accent="#F59E0B" />
        <Tile label="Test cases" value={coverage.cases} accent="#7C3AED" />
        <Tile label="Automated" value={coverage.automated} accent="#0EA5E9" />
      </div>

      <SectionCard
        icon={FlaskConical}
        title="Generated Test Cases"
        hint="requirement → case → execution"
        right={<button type="button" onClick={onClose} className="inline-flex items-center gap-1.5 px-3 py-1.5 text-[12px] font-semibold text-[#7C3AED] bg-[#F5F3FF] border border-[#DDD6FE] rounded-lg hover:bg-[#EDE9FE]">Generate in pipeline<ArrowRight className="w-3.5 h-3.5" /></button>}
      >
        <TableToolbar search={search} onSearch={(v) => { setSearch(v); setPage(1); }} placeholder="Search test cases…">
          <select value={statusFilter} onChange={(e) => { setStatusFilter(e.target.value); setPage(1); }} className="px-2.5 py-1.5 text-[12px] text-gray-800 bg-[#FCFBFF] border border-[#E4E0F5] rounded-md w-32">
            <option value="all">All status</option>
            <option value="passed">Passed</option>
            <option value="failed">Failed</option>
            <option value="notrun">Not run</option>
          </select>
        </TableToolbar>
        <div className="overflow-x-auto">
          <table className="w-full text-[11.5px]">
            <TableHead cols={[
              { label: 'Test Case ID' }, { label: 'Scenario' }, { label: 'Req ID' }, { label: 'Endpoint' },
              { label: 'Method' }, { label: 'Execution' }, { label: 'Automation' },
            ]} />
            <tbody className="divide-y divide-gray-100">
              {!matrix ? <EmptyRow span={7} text="Loading test cases…" />
                : cases.length === 0 ? <EmptyRow span={7} text="No test cases generated yet — run generation from the API Automation pipeline." />
                : pg.slice.length === 0 ? <EmptyRow span={7} text="No test cases match this filter." />
                : pg.slice.map((c, i) => (
                  <tr key={`${c.caseId}-${i}`} className="align-top hover:bg-gray-50/60">
                    <td className="px-3 py-2 whitespace-nowrap"><span className="font-mono text-gray-700 font-semibold">{c.caseId}</span></td>
                    <td className="px-3 py-2 max-w-[260px] truncate text-gray-700" title={c.title}>{c.title}</td>
                    <td className="px-3 py-2 whitespace-nowrap"><span className="inline-flex items-center gap-1.5"><SourceBadge source={c.source} /><span className="font-mono text-[#6D28D9] font-semibold">{c.reqKey}</span></span></td>
                    <td className="px-3 py-2 font-mono text-gray-600 max-w-[180px] truncate" title={c.endpoint}>{c.endpoint || <span className="text-gray-300">—</span>}</td>
                    <td className="px-3 py-2">{c.method ? <MethodBadge method={c.method} /> : <span className="text-gray-300">—</span>}</td>
                    <td className="px-3 py-2"><CaseStatusPill status={c.status} /></td>
                    <td className="px-3 py-2">{c.automated ? <span className="inline-flex px-1.5 py-0.5 rounded border text-[10px] font-semibold bg-[#F5F3FF] text-[#6D28D9] border-[#DDD6FE]">Automated</span> : <span className="text-gray-300">—</span>}</td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
        <Pager page={pg.page} pageCount={pg.pageCount} from={pg.from} to={pg.to} total={filtered.length} onPage={setPage} />
      </SectionCard>
    </div>
  );
}

function Tile({ label, value, accent }: { label: string; value: number; accent: string }) {
  return (
    <div className={`${CARD} p-3`}>
      <div className="text-[10.5px] font-semibold uppercase tracking-wide text-gray-500">{label}</div>
      <div className="text-[22px] font-bold tabular-nums leading-none mt-1" style={{ color: accent }}>{value}</div>
    </div>
  );
}
