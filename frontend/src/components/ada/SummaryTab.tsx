/**
 * Report summary — the audit at a glance: issues by severity, by category and
 * by check, plus the pages and components that carry the most issues.
 *
 * Every number is counted from the findings of this audit. Items the scanner
 * could not decide ("needs review") are listed separately and never counted as
 * issues. Rows open the All issues tab filtered to what was clicked.
 */
import { useMemo } from 'react';
import type { AdaCategory, AdaFinding, AdaSeverity, AdaSummary } from '@/services/api';
import { CheckCircle2, ChevronRight, Eye } from 'lucide-react';
import { SEVERITIES, SEV_DOT, SEV_HEX, SEV_LABEL, SEV_STYLE } from '@/components/ada/shared';

export interface IssueSeed { severity?: AdaSeverity; category?: AdaCategory; query?: string }

interface Props {
  findings: AdaFinding[];
  summary: AdaSummary;
  onOpenIssues: (seed: IssueSeed) => void;
  onOpenUx: () => void;
}

const SEV_ORDER: Record<AdaSeverity, number> = { critical: 0, serious: 1, moderate: 2, minor: 3 };
const TOP = 6;

function shortUrl(u: string): string {
  try { const x = new URL(u); return (x.pathname === '/' ? x.host : x.pathname) + (x.search || ''); } catch { return u; }
}

function Card({ title, total, totalLabel, children }: { title: string; total?: number; totalLabel?: string; children: React.ReactNode }) {
  return (
    <section className="rounded-xl border border-gray-100 bg-white p-5 min-w-0">
      <h3 className="text-sm font-semibold text-[#1E1B4B]">{title}</h3>
      {total !== undefined && (
        <div className="mt-2 mb-3">
          <p className="text-xs text-gray-500">{totalLabel || 'Total'}</p>
          <p className="text-3xl font-bold text-[#1E1B4B] tabular-nums leading-tight">{total.toLocaleString()}</p>
        </div>
      )}
      {children}
    </section>
  );
}

/** Severity donut. Segments are drawn as arcs of one circle, largest severity first. */
function Donut({ counts, total }: { counts: Record<AdaSeverity, number>; total: number }) {
  const size = 188, stroke = 22;
  const r = (size - stroke) / 2;
  const circ = 2 * Math.PI * r;
  const present = SEVERITIES.filter((s) => counts[s] > 0);
  const segments = present.map((s, i) => ({
    s,
    len: (counts[s] / total) * circ,
    offset: present.slice(0, i).reduce((a, p) => a + (counts[p] / total) * circ, 0),
  }));
  // A 2px gap between segments, only when there is more than one.
  const gap = segments.length > 1 ? 2 : 0;
  return (
    <div className="relative flex-shrink-0" style={{ width: size, height: size }} role="img" aria-label={`${total} issues: ${SEVERITIES.map((s) => `${counts[s]} ${s}`).join(', ')}`}>
      <svg width={size} height={size} className="-rotate-90">
        <circle cx={size / 2} cy={size / 2} r={r} stroke={total ? '#F3F4F6' : '#D1FAE5'} strokeWidth={stroke} fill="none" />
        {segments.map((g) => (
          <circle
            key={g.s} cx={size / 2} cy={size / 2} r={r} fill="none" stroke={SEV_HEX[g.s]} strokeWidth={stroke}
            strokeDasharray={`${Math.max(1, g.len - gap)} ${circ - Math.max(1, g.len - gap)}`} strokeDashoffset={-g.offset}
          >
            <title>{`${SEV_LABEL[g.s]}: ${counts[g.s].toLocaleString()}`}</title>
          </circle>
        ))}
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <p className="text-3xl font-bold text-[#1E1B4B] tabular-nums leading-none">{total.toLocaleString()}</p>
        <p className="text-xs text-gray-500 mt-1">{total === 1 ? 'Issue' : 'Issues'}</p>
      </div>
    </div>
  );
}

/** One row of a ranked list: label, a bar relative to the largest row, and the count. */
function BarRow({ rank, label, sub, mono, value, max, badge, onClick }: {
  rank?: number; label: string; sub?: string; mono?: boolean; value: number; max: number; badge?: React.ReactNode; onClick?: () => void;
}) {
  const pct = max > 0 ? Math.max(value > 0 ? 2 : 0, Math.round((value / max) * 100)) : 0;
  const body = (
    <>
      {rank !== undefined && <span className="w-5 text-xs text-gray-400 tabular-nums flex-shrink-0">{rank}</span>}
      <span className="flex-1 min-w-0">
        <span className="flex items-center gap-2">
          <span className={`truncate text-sm text-gray-800 ${mono ? 'font-mono text-xs' : ''}`} title={label}>{label}</span>
          {badge}
        </span>
        {sub && <span className="block text-xs text-gray-400 truncate">{sub}</span>}
        <span className="block h-1.5 mt-1.5 bg-gray-100 rounded-full overflow-hidden">
          <span className="block h-full rounded-full bg-gradient-to-r from-violet-500 to-indigo-500" style={{ width: `${pct}%` }} />
        </span>
      </span>
      <span className="w-14 text-right text-sm font-semibold text-gray-700 tabular-nums flex-shrink-0">{value.toLocaleString()}</span>
      {onClick && <ChevronRight className="w-4 h-4 text-gray-300 flex-shrink-0" />}
    </>
  );
  return onClick
    ? <button type="button" onClick={onClick} className="w-full text-left flex items-center gap-3 px-2 py-2 -mx-2 rounded-lg hover:bg-violet-50/50" style={{ transform: 'none' }}>{body}</button>
    : <div className="flex items-center gap-3 py-2">{body}</div>;
}

export default function SummaryTab({ findings, summary, onOpenIssues, onOpenUx }: Props) {
  const data = useMemo(() => {
    const issues = findings.filter((f) => f.category !== 'review');
    const bySeverity: Record<AdaSeverity, number> = { critical: 0, serious: 0, moderate: 0, minor: 0 };
    const byCat: Record<AdaCategory, number> = { accessibility: 0, links: 0, 'best-practice': 0, review: 0, visual: 0 };
    for (const f of findings) byCat[f.category] += f.occurrences;

    const rules = new Map<string, { title: string; category: AdaCategory; severity: AdaSeverity; occurrences: number; pages: Set<string> }>();
    const pages = new Map<string, number>();
    const components = new Map<string, number>();
    for (const f of issues) {
      bySeverity[f.severity] += f.occurrences;
      const key = `${f.category}|${f.rule_id}`;
      const r = rules.get(key) || { title: f.title, category: f.category, severity: f.severity, occurrences: 0, pages: new Set<string>() };
      r.occurrences += f.occurrences; r.pages.add(f.page_url);
      rules.set(key, r);
      pages.set(f.page_url, (pages.get(f.page_url) || 0) + f.occurrences);
      if (f.element && f.category !== 'links') components.set(f.element, (components.get(f.element) || 0) + f.occurrences);
    }
    const desc = <T,>(m: Map<string, T>, n: (v: T) => number) => [...m.entries()].sort((a, b) => n(b[1]) - n(a[1]));
    return {
      total: issues.reduce((a, f) => a + f.occurrences, 0),
      bySeverity, byCat,
      rules: [...rules.values()].sort((a, b) => b.occurrences - a.occurrences || SEV_ORDER[a.severity] - SEV_ORDER[b.severity]),
      pages: desc(pages, (v) => v),
      components: desc(components, (v) => v),
    };
  }, [findings]);

  const ux = summary.categories.ux;
  const linksChecked = summary.categories.links.measured !== false;
  const categories: { label: string; value: number | null; note?: string; onClick?: () => void }[] = [
    { label: 'Accessibility', value: data.byCat.accessibility, onClick: () => onOpenIssues({ category: 'accessibility' }) },
    { label: 'Broken links', value: linksChecked ? data.byCat.links : null, note: 'Not checked', onClick: linksChecked ? () => onOpenIssues({ category: 'links' }) : undefined },
    { label: 'Best practices', value: data.byCat['best-practice'], onClick: () => onOpenIssues({ category: 'best-practice' }) },
    ...(ux ? [{ label: 'UX', value: ux.issues, onClick: onOpenUx }] : []),
  ];
  const catMax = Math.max(1, ...categories.map((c) => c.value || 0));

  return (
    <div className="p-5 grid grid-cols-1 xl:grid-cols-2 gap-4 bg-gray-50/40 rounded-b-2xl">
      <Card title="Issue summary">
        <div className="flex flex-wrap items-center gap-8 mt-4">
          <Donut counts={data.bySeverity} total={data.total} />
          <div className="flex-1 min-w-[200px] divide-y divide-gray-100">
            {SEVERITIES.map((s) => (
              <button key={s} type="button" onClick={() => onOpenIssues({ severity: s })} disabled={!data.bySeverity[s]} className="w-full flex items-center gap-2.5 py-2.5 text-left hover:bg-violet-50/50 disabled:hover:bg-transparent px-2 -mx-2 rounded-lg" style={{ transform: 'none' }}>
                <span className={`w-2.5 h-2.5 rounded-full ${SEV_DOT[s]}`} />
                <span className="flex-1 text-sm text-gray-700">{SEV_LABEL[s]}</span>
                <span className="text-sm font-semibold text-gray-800 tabular-nums">{data.bySeverity[s].toLocaleString()}</span>
              </button>
            ))}
          </div>
        </div>
        {data.total === 0 && <p className="mt-4 text-sm text-emerald-700 flex items-center gap-2"><CheckCircle2 className="w-4 h-4" /> No issues were found on the pages audited.</p>}
        <div className={`mt-4 rounded-lg border px-3.5 py-2.5 flex items-center gap-3 ${data.byCat.review > 0 ? 'bg-amber-50 border-amber-200' : 'bg-gray-50 border-gray-100'}`}>
          <Eye className={`w-4 h-4 flex-shrink-0 ${data.byCat.review > 0 ? 'text-amber-500' : 'text-gray-400'}`} />
          <p className="flex-1 text-sm text-gray-700">
            <span className="font-semibold tabular-nums">{data.byCat.review.toLocaleString()}</span> need{data.byCat.review === 1 ? 's' : ''} review
            <span className="block text-xs text-gray-500">Checks a person has to confirm. Not counted as issues.</span>
          </p>
          {data.byCat.review > 0 && <button type="button" onClick={() => onOpenIssues({ category: 'review' })} className="text-xs font-medium text-amber-800 bg-white border border-amber-200 hover:bg-amber-100 rounded-lg px-3 py-1.5">Review</button>}
        </div>
      </Card>

      <Card title="Issues by category" total={data.total + (ux ? ux.issues : 0)} totalLabel={ux ? 'Total, including UX' : 'Total'}>
        <div>
          {categories.map((c) => c.value === null
            ? (
              <div key={c.label} className="flex items-center gap-3 py-2">
                <span className="flex-1 text-sm text-gray-500">{c.label}</span>
                <span className="text-xs text-gray-400">{c.note}</span>
              </div>
            )
            : <BarRow key={c.label} label={c.label} value={c.value} max={catMax} onClick={c.value > 0 ? c.onClick : undefined} />)}
        </div>
      </Card>

      <Card title="Most frequent issues" total={data.rules.length} totalLabel="Checks failing">
        {data.rules.length === 0 ? <p className="text-sm text-gray-400">None.</p> : data.rules.slice(0, TOP).map((r, i) => (
          <BarRow
            key={`${r.category}|${r.title}`} rank={i + 1} label={r.title} value={r.occurrences} max={data.rules[0].occurrences}
            sub={`${r.pages.size.toLocaleString()} page${r.pages.size === 1 ? '' : 's'}`}
            badge={<span className={`px-1.5 py-0.5 rounded border text-[10px] font-medium flex-shrink-0 ${SEV_STYLE[r.severity]}`}>{SEV_LABEL[r.severity]}</span>}
            onClick={() => onOpenIssues({ query: r.title })}
          />
        ))}
        {data.rules.length > TOP && <button type="button" onClick={() => onOpenIssues({})} className="mt-2 text-xs font-medium text-violet-700 hover:underline">View all {data.rules.length.toLocaleString()}</button>}
      </Card>

      <div className="grid grid-cols-1 gap-4">
        <Card title="Affected pages" total={data.pages.length}>
          {data.pages.length === 0 ? <p className="text-sm text-gray-400">None.</p> : data.pages.slice(0, TOP).map(([url, n], i) => (
            <BarRow key={url} rank={i + 1} label={shortUrl(url)} value={n} max={data.pages[0][1]} onClick={() => onOpenIssues({ query: url })} />
          ))}
        </Card>
        <Card title="Affected components" total={data.components.length}>
          {data.components.length === 0 ? <p className="text-sm text-gray-400">None.</p> : data.components.slice(0, TOP).map(([el, n], i) => (
            <BarRow key={el} rank={i + 1} label={el} mono value={n} max={data.components[0][1]} onClick={() => onOpenIssues({ query: el })} />
          ))}
        </Card>
      </div>
    </div>
  );
}
