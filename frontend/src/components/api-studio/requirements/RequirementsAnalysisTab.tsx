/**
 * Requirements Analysis tab — reads every requirement source and surfaces what
 * needs a human: review flags (incomplete / ambiguous / conflicting) carried by
 * the extraction, deterministic duplicate detection (same normalised title
 * across sources), and the deterministic BRD↔FRD mapper. Nothing is invented —
 * flags come from the backend, duplicates are an exact client-side grouping.
 */
import { useEffect, useMemo, useState } from 'react';
import { ScanSearch, GitCompareArrows, Copy, Loader2, AlertTriangle, Link2 } from 'lucide-react';
import { useToast } from '@/components/feedback/ToastProvider';
import {
  listBrdDocuments, getBrdDocument, listFrdDocuments, getFrdDocument, listRequirements, mapBrdFrd,
  type ReviewFlag, type BrdFrdLink,
} from '@/services/api';
import { CARD, FIELD, PRIMARY_BTN } from '../format';
import { SectionCard, TableToolbar, Pager, TableHead, EmptyRow, FlagPill, SourceBadge } from './shared';
import { paginate, matchesSearch, worstFlag, type RmTabProps } from './util';

interface AnalRow { key: string; source: 'brd' | 'frd' | 'manual'; title: string; description?: string; flags?: ReviewFlag[] }
const PAGE_SIZE = 10;

function normTitle(t: string): string { return (t || '').toLowerCase().replace(/\s+/g, ' ').trim(); }

export default function RequirementsAnalysisTab(_props: RmTabProps) {
  const toast = useToast();
  const [rows, setRows] = useState<AnalRow[]>([]);
  const [loading, setLoading] = useState(true);

  const [search, setSearch] = useState('');
  const [flagFilter, setFlagFilter] = useState('all');
  const [page, setPage] = useState(1);

  const [mapping, setMapping] = useState(false);
  const [links, setLinks] = useState<BrdFrdLink[] | null>(null);
  const [mapSummary, setMapSummary] = useState<{ frTotal: number; mapped: number; unmapped: number; brTotal: number } | null>(null);

  const loadAll = async () => {
    setLoading(true);
    try {
      const [brdDocs, frdDocs, manual] = await Promise.all([
        listBrdDocuments().then((r) => r.documents).catch(() => []),
        listFrdDocuments().then((r) => r.documents).catch(() => []),
        listRequirements().catch(() => []),
      ]);
      const brdReqs = (await Promise.all(brdDocs.map((d) => getBrdDocument(d.id).then((r) => r.requirements).catch(() => []))))
        .flat().map((r): AnalRow => ({ key: r.brId, source: 'brd', title: r.title, description: r.description, flags: r.reviewFlags }));
      const frdReqs = (await Promise.all(frdDocs.map((d) => getFrdDocument(d.id).then((r) => r.requirements).catch(() => []))))
        .flat().map((r): AnalRow => ({ key: r.frId, source: 'frd', title: r.title, description: r.description, flags: r.reviewFlags }));
      const manualReqs = manual.map((r): AnalRow => ({ key: r.reqKey, source: 'manual', title: r.title, description: r.description }));
      setRows([...brdReqs, ...frdReqs, ...manualReqs]);
    } catch (e: any) { toast.error('Could not load requirements', e?.response?.data?.error || 'Please try again.'); }
    finally { setLoading(false); }
  };

  useEffect(() => { void loadAll(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);

  const stats = useMemo(() => {
    let incomplete = 0, ambiguous = 0, conflict = 0;
    for (const r of rows) for (const f of r.flags || []) {
      if (f.code === 'incomplete') incomplete++; else if (f.code === 'ambiguous') ambiguous++; else if (f.code === 'conflict') conflict++;
    }
    return { total: rows.length, incomplete, ambiguous, conflict };
  }, [rows]);

  const duplicates = useMemo(() => {
    const groups = new Map<string, AnalRow[]>();
    for (const r of rows) {
      const k = normTitle(r.title);
      if (!k) continue;
      const g = groups.get(k) || [];
      g.push(r); groups.set(k, g);
    }
    return [...groups.values()].filter((g) => g.length > 1);
  }, [rows]);

  const filtered = useMemo(() => rows.filter((r) =>
    (flagFilter === 'all' || worstFlag(r.flags) === flagFilter) &&
    matchesSearch(search, r.key, r.title, r.description)), [rows, search, flagFilter]);
  const pg = paginate(filtered, page, PAGE_SIZE);

  const runMap = async () => {
    setMapping(true);
    try {
      const res = await mapBrdFrd();
      setLinks(res.links); setMapSummary(res.summary);
      toast.success('BRD ↔ FRD mapped', `${res.summary.mapped} of ${res.summary.frTotal} functional requirements linked.`);
    } catch (e: any) { toast.error('Could not map', e?.response?.data?.error || 'Need both BRD and FRD requirements first.'); }
    finally { setMapping(false); }
  };

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
        <StatTile label="Requirements" value={stats.total} accent="#6366F1" />
        <StatTile label="Incomplete" value={stats.incomplete} accent="#F59E0B" />
        <StatTile label="Ambiguous" value={stats.ambiguous} accent="#EA580C" />
        <StatTile label="Conflicts" value={stats.conflict} accent="#EF4444" />
        <StatTile label="Duplicates" value={duplicates.length} accent="#8B5CF6" />
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-5 gap-4">
        <div className="xl:col-span-3">
          <SectionCard icon={ScanSearch} title="Requirements review" hint="flags carried from extraction">
            <TableToolbar search={search} onSearch={(v) => { setSearch(v); setPage(1); }} placeholder="Search all requirements…">
              <select value={flagFilter} onChange={(e) => { setFlagFilter(e.target.value); setPage(1); }} className={`${FIELD} w-36`}>
                <option value="all">All</option>
                <option value="ok">Clear</option>
                <option value="incomplete">Incomplete</option>
                <option value="ambiguous">Ambiguous</option>
                <option value="conflict">Conflict</option>
              </select>
            </TableToolbar>
            <div className="overflow-x-auto">
              <table className="w-full text-[11.5px]">
                <TableHead cols={[{ label: 'Source' }, { label: 'Req ID' }, { label: 'Requirement' }, { label: 'Status' }]} />
                <tbody className="divide-y divide-gray-100">
                  {loading ? <EmptyRow span={4} text="Reading every requirement source…" />
                    : pg.slice.length === 0 ? <EmptyRow span={4} text="No requirements match your search." />
                    : pg.slice.map((r, i) => (
                      <tr key={`${r.source}-${r.key}-${i}`} className="align-top hover:bg-gray-50/60">
                        <td className="px-3 py-2"><SourceBadge source={r.source} /></td>
                        <td className="px-3 py-2 whitespace-nowrap"><span className="font-mono text-[#6D28D9] font-semibold">{r.key}</span></td>
                        <td className="px-3 py-2 max-w-[280px]"><div className="font-medium text-gray-800 truncate" title={r.title}>{r.title}</div>{(r.flags?.length || 0) > 0 && <div className="text-[10.5px] text-gray-400 truncate" title={r.flags!.map((f) => f.message).join(' · ')}>{r.flags![0].message}</div>}</td>
                        <td className="px-3 py-2"><FlagPill code={worstFlag(r.flags)} /></td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
            <Pager page={pg.page} pageCount={pg.pageCount} from={pg.from} to={pg.to} total={filtered.length} onPage={setPage} />
          </SectionCard>
        </div>

        <div className="xl:col-span-2 space-y-4">
          {/* BRD ↔ FRD mapping */}
          <SectionCard icon={GitCompareArrows} title="BRD ↔ FRD mapping" right={<button type="button" onClick={() => void runMap()} disabled={mapping} className={PRIMARY_BTN}>{mapping ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Link2 className="w-3.5 h-3.5" />}Map</button>}>
            {mapSummary && (
              <div className="flex flex-wrap gap-2 mb-2.5 text-[11px]">
                <Pill>{mapSummary.mapped} mapped</Pill>
                <Pill tone="warn">{mapSummary.unmapped} unmapped</Pill>
                <Pill tone="muted">{mapSummary.brTotal} BR · {mapSummary.frTotal} FR</Pill>
              </div>
            )}
            {!links ? (
              <p className="text-[12px] text-gray-400 py-4 text-center">Run the deterministic mapper to link functional requirements to their business requirements.</p>
            ) : links.length === 0 ? (
              <p className="text-[12px] text-gray-400 py-4 text-center">No confident links found.</p>
            ) : (
              <ul className="space-y-1.5 max-h-72 overflow-y-auto">
                {links.map((l, i) => (
                  <li key={i} className="flex items-center gap-2 text-[11.5px] rounded-lg border border-[#ECE9F8] bg-[#FCFBFF] px-2.5 py-1.5">
                    <span className="font-mono text-[#4338CA] font-semibold">{l.frKey}</span>
                    <span className="text-gray-300">→</span>
                    <span className="font-mono text-[#6D28D9] font-semibold">{l.brKey}</span>
                    <span className="ml-auto text-[10px] text-gray-400 tabular-nums" title={l.rationale}>{Math.round(l.confidence * 100)}%</span>
                  </li>
                ))}
              </ul>
            )}
          </SectionCard>

          {/* Duplicates */}
          <SectionCard icon={Copy} title="Possible duplicates" hint="same requirement title">
            {duplicates.length === 0 ? (
              <p className="text-[12px] text-gray-400 py-4 text-center">No duplicate titles across sources.</p>
            ) : (
              <ul className="space-y-2 max-h-72 overflow-y-auto">
                {duplicates.map((g, i) => (
                  <li key={i} className="rounded-lg border border-amber-200 bg-amber-50/60 px-2.5 py-2">
                    <div className="flex items-start gap-1.5 text-[11.5px] font-medium text-amber-800"><AlertTriangle className="w-3.5 h-3.5 flex-shrink-0 mt-px" /><span className="min-w-0">{g[0].title}</span></div>
                    <div className="mt-1 flex flex-wrap gap-1.5">
                      {g.map((r, j) => <span key={j} className="inline-flex items-center gap-1"><SourceBadge source={r.source} /><span className="font-mono text-[10.5px] text-gray-600">{r.key}</span></span>)}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </SectionCard>
        </div>
      </div>
    </div>
  );
}

function StatTile({ label, value, accent }: { label: string; value: number; accent: string }) {
  return (
    <div className={`${CARD} p-3`}>
      <div className="text-[10.5px] font-semibold uppercase tracking-wide text-gray-500">{label}</div>
      <div className="text-[22px] font-bold tabular-nums leading-none mt-1" style={{ color: accent }}>{value}</div>
    </div>
  );
}

function Pill({ children, tone }: { children: React.ReactNode; tone?: 'warn' | 'muted' }) {
  const cls = tone === 'warn' ? 'bg-amber-50 text-amber-700 border-amber-200' : tone === 'muted' ? 'bg-gray-50 text-gray-500 border-gray-200' : 'bg-emerald-50 text-emerald-700 border-emerald-200';
  return <span className={`inline-flex px-2 py-0.5 rounded border font-semibold ${cls}`}>{children}</span>;
}
