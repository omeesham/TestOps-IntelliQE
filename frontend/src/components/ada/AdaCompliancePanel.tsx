/**
 * ADA Compliance / website audit report.
 *
 * One audit, shown as a page:
 *   running   a live view of the crawl: every page navigated, links found,
 *             checks run, problems as they are discovered; can be stopped
 *   finished  the report: header with the health score, then tabs for the
 *             summary (charts), all issues (grouped list with a detail pane),
 *             UX testing, pages, coverage and the workflow log, plus HTML / CSV
 *             download. A stopped audit gets the same report for the pages it
 *             managed to audit.
 *
 * Audits are started from the New audit drawer on the /ada-compliance page.
 * `onBrownfield` hands the crawled site to the existing explore-mode pipeline
 * so requirements and test cases are rebuilt from it.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  getAdaScan, getAdaFindings, getAdaPages, cancelAdaScan, getAdaTrend, type AdaTrendPoint,
  type AdaCategory, type AdaFinding, type AdaPage, type AdaProgress, type AdaProgressEvent,
  type AdaScanRecord, type AdaSeverity, type AdaSummary, type AdaRemediation, type AdaSiteInventory, type AdaCoverage, type AdaCategoryScore,
} from '@/services/api';
import {
  Globe, Lock, Loader2, CheckCircle2, AlertTriangle, XCircle, Link2Off,
  FileSearch, Compass, ChevronDown, ChevronLeft, ChevronRight, Download, ExternalLink, Search,
  Square, Plus, Sparkles, ListChecks, Map as MapIcon, Info, Copy, FileText, Table2,
  MousePointerClick, LayoutDashboard,
} from 'lucide-react';
import UniversalAccess from '@/components/icons/UniversalAccess';
import { UxReport } from '@/components/ada/UxTesting';
import SummaryTab, { type IssueSeed } from '@/components/ada/SummaryTab';

const EFFORT_LABEL: Record<AdaRemediation['effort'], string> = { quick: 'Quick fix', moderate: 'Moderate', involved: 'Involved' };
function remediationOf(f: AdaFinding | null | undefined): AdaRemediation | undefined {
  const r = f?.details?.remediation;
  return r && typeof r === 'object' && Array.isArray((r as AdaRemediation).steps) ? (r as AdaRemediation) : undefined;
}

type Tab = 'summary' | 'issues' | 'ux' | 'log' | 'coverage' | 'pages';

export interface BrownfieldHandoff { url: string; siteName?: string; username?: string; password?: string }

interface Props {
  /** The audit to show. Remount (key) the panel to switch audits. */
  scanId: string;
  /** Called when the user asks to rebuild requirements & test cases from the crawl. */
  onBrownfield?: (ctx: BrownfieldHandoff) => void;
  /** Opens the New audit drawer. */
  onNewAudit?: () => void;
}

const SEVERITIES: AdaSeverity[] = ['critical', 'serious', 'moderate', 'minor'];
const SEV_STYLE: Record<AdaSeverity, string> = {
  critical: 'bg-red-100 text-red-700 border-red-200',
  serious: 'bg-orange-100 text-orange-700 border-orange-200',
  moderate: 'bg-amber-100 text-amber-700 border-amber-200',
  minor: 'bg-gray-100 text-gray-600 border-gray-200',
};
const CATEGORY_LABEL: Record<AdaCategory, string> = {
  accessibility: 'Accessibility', links: 'Broken link', 'best-practice': 'Best practice', review: 'Needs review', visual: 'UX',
};

const EVENT_ICON: Record<AdaProgressEvent['type'], React.ElementType> = {
  start: Globe, robots: FileSearch, sitemap: MapIcon, navigate: Compass, page: CheckCircle2, login: Lock,
  accessibility: UniversalAccess, 'best-practice': ListChecks, ux: MousePointerClick, links: Link2Off, 'link-check': XCircle,
  summary: Sparkles, warning: AlertTriangle, error: XCircle, done: CheckCircle2,
};
const EVENT_COLOR: Record<AdaProgressEvent['type'], string> = {
  start: 'text-violet-500', robots: 'text-gray-400', sitemap: 'text-gray-400', navigate: 'text-indigo-500',
  page: 'text-emerald-500', login: 'text-violet-500', accessibility: 'text-blue-500', 'best-practice': 'text-teal-500', ux: 'text-fuchsia-500',
  links: 'text-gray-500', 'link-check': 'text-red-500', summary: 'text-violet-600', warning: 'text-amber-500',
  error: 'text-red-600', done: 'text-emerald-600',
};

const inputCls = 'w-full px-3.5 py-2.5 bg-white border border-gray-200 rounded-lg text-sm text-gray-800 placeholder:text-gray-400 outline-none focus:ring-2 focus:ring-violet-500/20 focus:border-violet-400 transition-all';

/** "397 of 2,017 pages audited (1,988 listed in the sitemap, 29 more found by following links)" — every number accounted for. */
function describePages(s: AdaSummary): string {
  const n = (x: number) => x.toLocaleString();
  const found = Math.max(s.pagesDiscovered || 0, s.pagesCrawled);
  if (found <= s.pagesCrawled) return `${n(s.pagesCrawled)} page${s.pagesCrawled === 1 ? '' : 's'} audited, every page found`;
  const fromSitemap = s.coverage?.bySource.sitemap.found ?? 0;
  const extra = found - fromSitemap;
  const how = fromSitemap > 0
    ? ` (${n(fromSitemap)} listed in the sitemap, ${n(extra)} more found by following links)`
    : ' (found by following links from the start page)';
  return `${n(s.pagesCrawled)} of ${n(found)} pages audited${how}`;
}

/** "1,234 of 2,300 links checked" or "links not checked" — never a count that implies a check that did not happen. */
function describeLinks(s: AdaSummary): string {
  const l = s.categories.links;
  if (l.measured === false || l.checked === 0) return 'links not checked';
  const n = (x: number) => x.toLocaleString();
  return s.linksFound > l.checked ? `${n(l.checked)} of ${n(s.linksFound)} links checked` : `${n(l.checked)} links checked`;
}

function shortUrl(u: string): string {
  try { const x = new URL(u); return (x.pathname === '/' ? x.host : x.pathname) + (x.search || ''); } catch { return u; }
}
function fmtDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}
function errorStatus(err: unknown): number | undefined {
  return (err as { response?: { status?: number } } | undefined)?.response?.status;
}
function downloadBlob(content: string, filename: string, type: string) {
  const blob = new Blob([content], { type });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
function safeName(s: string): string {
  return (s || 'site').replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase() || 'site';
}

const card = 'bg-white border border-gray-100 rounded-2xl shadow-sm';

export default function AdaCompliancePanel({ scanId, onBrownfield, onNewAudit }: Props) {
  const [scan, setScan] = useState<AdaScanRecord | null>(null);
  const [progress, setProgress] = useState<AdaProgress | null>(null);
  const [events, setEvents] = useState<AdaProgressEvent[]>([]);
  const [missing, setMissing] = useState(false);
  const lastSeq = useRef(0);
  const logRef = useRef<HTMLDivElement>(null);
  const [cancelling, setCancelling] = useState(false);

  // ── report ──
  const [tab, setTab] = useState<Tab>('summary');
  const [issueSeed, setIssueSeed] = useState<IssueSeed>({});
  const [findings, setFindings] = useState<AdaFinding[]>([]);
  const [findingsLoaded, setFindingsLoaded] = useState(false);

  const status = progress?.status || scan?.status || null;
  const running = status === 'running' || status === 'queued';
  const summary: AdaSummary | null = progress?.summary || scan?.result || null;

  /* ── polling: follows the audit while it runs, stops once it has finished ── */
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      if (stopped) return;
      try {
        const res = await getAdaScan(scanId, lastSeq.current);
        if (stopped) return;
        setScan(res.scan);
        if (res.progress) {
          setProgress(res.progress);
          if (res.progress.events.length) {
            setEvents((prev) => [...prev, ...res.progress!.events].slice(-1500));
            lastSeq.current = res.progress.lastSeq;
          }
          if (res.progress.status !== 'running') return;
        } else if (res.scan.status !== 'running' && res.scan.status !== 'queued') {
          return;
        }
      } catch (err: unknown) {
        if (errorStatus(err) === 404) { setMissing(true); return; }
      }
      timer = setTimeout(tick, 1500);
    };
    tick();
    return () => { stopped = true; if (timer) clearTimeout(timer); };
  }, [scanId]);

  /* ── load every finding once the report is open ── */
  const hasSummary = !!summary;
  useEffect(() => {
    if (running || !hasSummary || findingsLoaded) return;
    let alive = true;
    getAdaFindings(scanId, { notCategory: 'visual', limit: 2000 })
      .then((r) => { if (alive) setFindings(r.findings); })
      .catch(() => { if (alive) setFindings([]); })
      .finally(() => { if (alive) setFindingsLoaded(true); });
    return () => { alive = false; };
  }, [running, scanId, hasSummary, findingsLoaded]);

  useEffect(() => {
    if (running && logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [events, running]);

  const cancel = async () => {
    setCancelling(true);
    try { await cancelAdaScan(scanId); } catch { /* the poll will surface the state */ }
  };

  const brownfield = () => {
    const target = summary?.targetUrl || scan?.target_url;
    if (target) onBrownfield?.({ url: target, siteName: summary?.siteName });
  };

  const openIssues = (seed: IssueSeed) => { setIssueSeed(seed); setTab('issues'); };

  if (missing) {
    return (
      <div className={`${card} p-10 text-center`}>
        <XCircle className="w-8 h-8 text-gray-300 mx-auto mb-2" />
        <p className="text-sm text-gray-700">This audit no longer exists.</p>
      </div>
    );
  }

  if (!scan) {
    return <div className={`${card} p-6 text-sm text-gray-500 flex items-center gap-2`}><Loader2 className="w-4 h-4 animate-spin text-violet-500" /> Loading audit</div>;
  }

  /* ═════════════════════════════ RUNNING ═════════════════════════════ */
  if (running) {
    const c = progress?.counters;
    // Progress is measured against pages found so far; the total grows as new links are discovered.
    const target = c ? Math.min(c.maxPages, Math.max(c.discovered || 0, c.pages, 1)) : 1;
    const pct = c ? Math.min(100, Math.round((c.pages / target) * 100)) : 0;
    const linkPhase = !!c && c.linksFound > 0 && c.linksChecked > 0;
    return (
      <div className="space-y-4">
        <div className={`${card} overflow-hidden`}>
          <div className="px-6 py-5 bg-gradient-to-r from-violet-50/80 via-indigo-50/50 to-cyan-50/40">
            <div className="flex items-start justify-between gap-4">
              <div className="flex items-start gap-3 min-w-0">
                <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-violet-500 to-indigo-600 flex items-center justify-center flex-shrink-0 shadow-md shadow-purple-500/20 animate-pulseGlow">
                  <Loader2 className="w-5 h-5 text-white animate-spin" />
                </div>
                <div className="min-w-0">
                  <p className="text-xs font-medium text-violet-700">{linkPhase ? 'Checking links' : 'Auditing pages'}</p>
                  <h2 className="text-lg font-semibold text-[#1E1B4B] truncate">{scan.target_url}</h2>
                  <p className="text-xs text-gray-500 mt-0.5 truncate">
                    {c?.currentUrl ? <>Now on <span className="font-mono text-gray-700">{shortUrl(c.currentUrl)}</span></> : 'Opening the site'}
                    {progress ? ` · ${fmtDuration(progress.elapsedMs)} elapsed` : ''}
                  </p>
                </div>
              </div>
              <button onClick={cancel} disabled={cancelling} className="flex-shrink-0 text-sm text-gray-700 hover:text-red-600 border border-gray-200 hover:border-red-200 bg-white rounded-lg px-3.5 py-2 flex items-center gap-2 disabled:opacity-50" title="Stop now and keep the report for the pages audited so far">
                <Square className="w-3 h-3 fill-current" /> {cancelling ? 'Stopping' : 'Stop and report'}
              </button>
            </div>
            <div className="mt-4 h-2 bg-white rounded-full overflow-hidden border border-violet-100">
              <div className="h-full bg-gradient-to-r from-violet-500 via-indigo-500 to-cyan-500 transition-all duration-700" style={{ width: `${linkPhase ? 100 : pct}%` }} />
            </div>
            {progress?.inventory && <InventoryLine inv={progress.inventory} className="mt-3" />}
          </div>
          <div className="grid grid-cols-2 lg:grid-cols-4 divide-x divide-y lg:divide-y-0 divide-gray-100 border-t border-gray-100">
            <LiveStat label="Pages audited" value={c ? c.pages.toLocaleString() : '—'} sub={c ? `of ${Math.max(c.discovered || 0, c.pages).toLocaleString()} found` : undefined} title="Audited = opened in the browser with every check finished. Found = start page + sitemap pages in scope + pages linked from audited pages." />
            <LiveStat label="Links found" value={c ? c.linksFound.toLocaleString() : '—'} sub={c && c.linksFound ? `${(c.linksInternal || 0).toLocaleString()} internal · ${(c.linksExternal || 0).toLocaleString()} external` : undefined} title="Unique links seen on the pages audited so far." />
            <LiveStat label="Links checked" value={c ? c.linksChecked.toLocaleString() : '—'} />
            <LiveStat label="Issues so far" value={c ? c.issues.toLocaleString() : '—'} warn={!!c?.issues} />
          </div>
        </div>
        <div className={`${card} overflow-hidden`}>
          <div className="px-5 py-3 border-b border-gray-100 flex items-center gap-2">
            <ListChecks className="w-4 h-4 text-violet-500" />
            <h3 className="text-sm font-semibold text-[#1E1B4B]">Live activity</h3>
          </div>
          <div ref={logRef} className="h-[22rem] overflow-y-auto px-5 py-3 space-y-1 bg-gray-50/50 font-mono text-xs">
            {events.length === 0 && <p className="text-gray-400">Starting the browser</p>}
            {events.map((e) => <LogLine key={e.seq} e={e} />)}
          </div>
        </div>
      </div>
    );
  }

  /* ═════════════════════════════ REPORT ═════════════════════════════ */
  if (!summary) {
    const failed = status === 'failed';
    return (
      <div className={`${card} p-6`}>
        <p className={`text-sm font-semibold flex items-center gap-2 ${failed ? 'text-red-700' : 'text-gray-700'}`}><XCircle className="w-4 h-4" /> {failed ? 'The audit could not be completed' : 'This audit has no report'}</p>
        <p className="text-sm text-gray-600 mt-1">{scan.target_url}</p>
        {(scan.error || progress?.error) && <p className="text-xs text-gray-500 mt-2">{scan.error || progress?.error}</p>}
        {onNewAudit && <button onClick={onNewAudit} className="mt-4 text-sm px-3.5 py-2 bg-white border border-gray-200 hover:border-violet-300 text-gray-700 rounded-lg flex items-center gap-2"><Plus className="w-4 h-4" /> New audit</button>}
      </div>
    );
  }

  const partial = status === 'cancelled';
  const logEvents = events.length ? events : (scan.log || []);
  const tabs = ([
    ['summary', 'Summary', LayoutDashboard, null],
    ['issues', 'All issues', UniversalAccess, findingsLoaded ? findings.filter((f) => f.category !== 'review').reduce((a, f) => a + f.occurrences, 0) : null],
    ...(summary.categories.ux ? [['ux', 'UX testing', MousePointerClick, summary.categories.ux.issues] as [Tab, string, React.ElementType, number | null]] : []),
    ['pages', 'Pages', Compass, summary.pagesCrawled],
    ['coverage', 'Coverage', MapIcon, null],
    ['log', 'Workflow log', ListChecks, null],
  ] as [Tab, string, React.ElementType, number | null][]);

  return (
    <div className="space-y-4">
      <ReportHeader
        scanId={scanId}
        scan={scan}
        summary={summary}
        partial={partial}
        findings={findings}
        onNewAudit={onNewAudit}
        onBrownfield={onBrownfield ? brownfield : undefined}
      />
      <div className={card}>
        <div className="flex flex-wrap gap-1 px-3 border-b border-gray-100" role="tablist">
          {tabs.map(([key, label, Icon, count]) => (
            <button
              key={key}
              role="tab"
              aria-selected={tab === key}
              onClick={() => setTab(key)}
              className={`px-3.5 py-3 text-sm font-medium border-b-2 -mb-px whitespace-nowrap flex items-center gap-2 !rounded-none ${tab === key ? 'border-violet-600 text-violet-700' : 'border-transparent text-gray-500 hover:text-gray-800'}`}
            >
              <Icon className="w-4 h-4" /> {label}
              {count !== null && <span className={`px-1.5 py-0.5 rounded-full text-[11px] tabular-nums ${tab === key ? 'bg-violet-100 text-violet-700' : 'bg-gray-100 text-gray-500'}`}>{count.toLocaleString()}</span>}
            </button>
          ))}
        </div>
        {(tab === 'summary' || tab === 'issues') && !findingsLoaded && <p className="p-6 text-sm text-gray-400 flex items-center gap-2"><Loader2 className="w-4 h-4 animate-spin" /> Loading issues</p>}
        {tab === 'summary' && findingsLoaded && <SummaryTab findings={findings} summary={summary} onOpenIssues={openIssues} onOpenUx={() => setTab('ux')} />}
        {tab === 'issues' && findingsLoaded && <IssueExplorer key={JSON.stringify(issueSeed)} findings={findings} summary={summary} seed={issueSeed} />}
        {tab === 'log' && <WorkflowLog events={logEvents} summary={summary} partial={partial} />}
        {tab === 'ux' && <UxReport scanId={scanId} summary={summary} />}
        {tab === 'coverage' && <CoverageView summary={summary} />}
        {tab === 'pages' && <PagesTable scanId={scanId} />}
      </div>
    </div>
  );
}

function LiveStat({ label, value, sub, warn, title }: { label: string; value: string; sub?: string; warn?: boolean; title?: string }) {
  return (
    <div className="px-6 py-4 min-w-0" title={title}>
      <p className="text-xs text-gray-500">{label}</p>
      <p className={`text-2xl font-bold tabular-nums leading-tight mt-0.5 ${warn ? 'text-amber-600' : 'text-[#1E1B4B]'}`}>{value}</p>
      {sub && <p className="text-xs text-gray-400 truncate">{sub}</p>}
    </div>
  );
}

/* ───────────────────────────── shared bits ───────────────────────────── */

function Chip({ label, value, title }: { label: string; value: string; title?: string }) {
  return (
    <span className="inline-flex items-baseline gap-1 rounded-md bg-white/80 border border-gray-100 px-2 py-1" title={title}>
      <span className="font-semibold text-gray-800">{value}</span><span className="text-gray-500">{label}</span>
    </span>
  );
}

/** "9,894 URLs → 5 languages → 1,987 pages in en-us → 1,354 news articles" in one glance. */
function InventoryLine({ inv, className = '' }: { inv: AdaSiteInventory; className?: string }) {
  const others = inv.locales.filter((l) => !l.audited);
  const templated = inv.sections.filter((s) => s.templated);
  const n = (x: number) => x.toLocaleString();
  return (
    <div className={`flex flex-wrap items-center gap-1.5 text-[11px] ${className}`}>
      <Chip value={n(inv.sitemapUrls)} label="URLs in sitemap" />
      {inv.auditedLocale && (
        <>
          <span className="text-gray-300">→</span>
          <Chip value={String(inv.locales.length)} label={`language${inv.locales.length === 1 ? '' : 's'}`} title={inv.locales.map((l) => `${l.code}: ${n(l.pages)}`).join('\n')} />
        </>
      )}
      <span className="text-gray-300">→</span>
      <Chip value={n(inv.pagesInScope)} label={`unique pages${inv.auditedLocale ? ` in ${inv.auditedLocale}` : ''}`} title={inv.sections.slice(0, 12).map((s) => `${s.path}: ${n(s.pages)}`).join('\n')} />
      {templated.length > 0 && (
        <>
          <span className="text-gray-300">→</span>
          <Chip value={n(inv.templatedPages)} label="templated articles (sampled)" title={templated.map((s) => `${s.path}: ${n(s.pages)}`).join('\n')} />
        </>
      )}
      {others.length > 0 && <span className="text-gray-400">{others.map((l) => l.code).join(', ')} not audited — translations of the same pages</span>}
    </div>
  );
}

function Stat({ label, value, sub, tone, title }: { label: string; value: string | number; sub?: string; tone?: 'warn'; title?: string }) {
  return (
    <div className="bg-white/70 border border-gray-100 rounded-lg px-3 py-2 min-w-0" title={title}>
      <p className="text-[10px] uppercase tracking-wide text-gray-400">{label}</p>
      <p className={`text-base font-semibold ${tone === 'warn' ? 'text-amber-600' : 'text-gray-800'}`}>{value}{sub && <span className="ml-1 text-[11px] font-normal text-gray-500">{sub}</span>}</p>
    </div>
  );
}

function LogLine({ e }: { e: AdaProgressEvent }) {
  const Icon = EVENT_ICON[e.type] || Info;
  return (
    <div className="flex gap-2 items-start">
      <Icon className={`w-3.5 h-3.5 mt-[1px] flex-shrink-0 ${EVENT_COLOR[e.type] || 'text-gray-400'}`} />
      <span className={`break-all ${e.type === 'warning' ? 'text-amber-700' : e.type === 'error' || e.type === 'link-check' ? 'text-red-700' : e.type === 'navigate' ? 'text-gray-700' : 'text-gray-600'}`}>{e.message}</span>
    </div>
  );
}

/* ───────────────────────────── report header ───────────────────────────── */

/**
 * One card. Who and what at the top, one row of figures below, one line of
 * scope at the bottom. No rings, no coloured numbers: the figures are in ink,
 * the grade sits beside each one, and anything more lives in the tabs.
 */
function ReportHeader({ scanId, scan, summary, partial, findings, onNewAudit, onBrownfield }: {
  scanId: string; scan: AdaScanRecord; summary: AdaSummary; partial: boolean; findings: AdaFinding[]; onNewAudit?: () => void; onBrownfield?: () => void;
}) {
  const [menu, setMenu] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!menu) return;
    const onDoc = (e: MouseEvent) => { if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenu(false); };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [menu]);
  const prev = usePreviousAudit(summary.targetUrl, scanId);
  const a = summary.categories.accessibility;
  const l = summary.categories.links;
  const b = summary.categories.bestPractice;
  const ux = summary.categories.ux;
  const n = (x: number) => x.toLocaleString();
  const brokenTotal = l.broken + l.serverErrors + l.timeouts;
  const pagesFound = Math.max(summary.pagesDiscovered || 0, summary.pagesCrawled);
  const dl = async (kind: 'html' | 'csv' | 'pages') => {
    setMenu(false);
    const base = `website-audit-${safeName(summary.siteName)}-${summary.finishedAt.slice(0, 10)}`;
    if (kind === 'csv') { downloadBlob(buildCsv(findings), `${base}-issues.csv`, 'text/csv'); return; }
    // The page list is stored per page in the database; fetch it so the download names every page visited.
    const pages = await getAdaPages(scanId).catch(() => [] as AdaPage[]);
    const trend = kind === 'html' ? await getAdaTrend(summary.targetUrl).then((r) => r.points).catch(() => [] as AdaTrendPoint[]) : [];
    if (kind === 'html') downloadBlob(buildHtmlReport(summary, partial, findings, pages, trend, scanId), `${base}.html`, 'text/html');
    else downloadBlob(buildPagesCsv(pages, summary.coverage), `${base}-pages.csv`, 'text/csv');
  };

  const score = summary.overall.score;
  const healthSub = prev === undefined ? undefined
    : prev === null ? 'First audit of this site'
    : score === null || prev.score === null ? `Previous audit ${new Date(prev.finishedAt).toLocaleDateString()}`
    : `${score - prev.score > 0 ? '+' : ''}${score - prev.score} since ${new Date(prev.finishedAt).toLocaleDateString()}`;

  const meta = [
    `Audited ${new Date(summary.finishedAt).toLocaleString()}`,
    fmtDuration(summary.durationMs),
    scan.created_by ? (scan.created_by === 'schedule' ? 'Scheduled run' : scan.created_by) : null,
    'WCAG 2.2 AA',
    partial ? 'Stopped early' : 'Complete',
    summary.loginAttempted ? (summary.loginSucceeded ? 'Signed in' : 'Public pages only') : null,
  ].filter(Boolean) as string[];

  return (
    <div className={`${card} overflow-hidden`}>
      <div className="px-6 pt-5 pb-4 flex flex-wrap items-start gap-4">
        <div className="flex-1 min-w-[260px]">
          <h2 className="text-lg font-semibold text-gray-900 leading-tight">{summary.siteName || summary.targetUrl}</h2>
          <a href={summary.targetUrl} target="_blank" rel="noopener noreferrer" className="mt-0.5 text-[13px] text-gray-500 hover:text-violet-700 inline-flex items-center gap-1 break-all">{summary.targetUrl} <ExternalLink className="w-3 h-3 flex-shrink-0" /></a>
          <p className="mt-2 text-xs text-gray-500">{meta.join('  ·  ')}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative" ref={menuRef}>
            <button onClick={() => setMenu((v) => !v)} aria-haspopup="menu" aria-expanded={menu} className="text-sm px-3.5 py-2 bg-white border border-gray-200 hover:border-violet-300 text-gray-700 rounded-lg flex items-center gap-2">
              <Download className="w-4 h-4" /> Export <ChevronDown className="w-3.5 h-3.5" />
            </button>
            {menu && (
              <div role="menu" className="absolute right-0 z-20 mt-1 w-64 bg-white border border-gray-200 rounded-xl shadow-lg overflow-hidden py-1">
                <button role="menuitem" onClick={() => dl('html')} className="w-full text-left px-3.5 py-2 text-sm text-gray-700 hover:bg-violet-50 flex items-center gap-2 !rounded-none"><FileText className="w-4 h-4 text-gray-400" /> Full report (HTML)</button>
                <button role="menuitem" onClick={() => dl('csv')} className="w-full text-left px-3.5 py-2 text-sm text-gray-700 hover:bg-violet-50 flex items-center gap-2 !rounded-none"><Table2 className="w-4 h-4 text-gray-400" /> All issues (CSV)</button>
                <button role="menuitem" onClick={() => dl('pages')} className="w-full text-left px-3.5 py-2 text-sm text-gray-700 hover:bg-violet-50 flex items-center gap-2 !rounded-none"><Compass className="w-4 h-4 text-gray-400" /> Pages visited and not visited (CSV)</button>
              </div>
            )}
          </div>
          {onNewAudit && <button onClick={onNewAudit} className="text-sm px-3.5 py-2 bg-white border border-gray-200 hover:border-violet-300 text-gray-700 rounded-lg flex items-center gap-2"><Plus className="w-4 h-4" /> New audit</button>}
          {onBrownfield && (
            <button onClick={onBrownfield} className="text-sm px-3.5 py-2 bg-gradient-to-r from-violet-600 to-indigo-600 hover:from-violet-500 hover:to-indigo-500 text-white rounded-lg flex items-center gap-2" title="Rebuild requirements and generate test cases from this site">
              Generate test cases
            </button>
          )}
        </div>
      </div>

      <div className={`grid grid-cols-2 sm:grid-cols-3 ${ux ? 'lg:grid-cols-5' : 'lg:grid-cols-4'} border-t border-gray-100 divide-x divide-gray-100`}>
        <Figure label="Health" score={score} grade={summary.overall.grade} sub={healthSub} lead />
        <Figure label="Accessibility" score={a.score} grade={a.grade} sub={`${n(a.violations)} violation${a.violations === 1 ? '' : 's'}`} />
        <Figure label="Links" score={l.score} grade={l.grade} sub={l.measured === false ? 'Not checked' : `${n(brokenTotal)} broken of ${n(l.checked)}`} />
        <Figure label="Best practices" score={b.score} grade={b.grade} sub={`${b.rulesPassed} of ${b.rulesEvaluated} checks passing`} />
        {ux && <Figure label="UX" score={ux.score} grade={ux.grade} sub={`${ux.devices.length} device${ux.devices.length === 1 ? '' : 's'}${ux.standard ? '' : ', layout only'}`} />}
      </div>

      <p className="px-6 py-2.5 border-t border-gray-100 text-xs text-gray-500">
        {n(summary.pagesCrawled)} of {n(pagesFound)} pages audited · {describeLinks(summary)}
      </p>
    </div>
  );
}

/** A figure in the header strip: label, the score in ink, the grade beside it, one short basis line. */
function Figure({ label, score, grade, sub, lead }: { label: string; score: number | null; grade: string | null; sub?: string; lead?: boolean }) {
  const measured = score !== null && grade !== null;
  return (
    <div className="px-6 py-4 min-w-0" title={measured ? undefined : 'Nothing in this category was checked, so it is not scored and not counted in the overall health score.'}>
      <p className="text-xs text-gray-500">{label}</p>
      <p className={`mt-0.5 leading-none tabular-nums ${measured ? 'text-gray-900' : 'text-gray-300'} ${lead ? 'text-3xl font-semibold' : 'text-2xl font-semibold'}`}>
        {measured ? score : '—'}
        {measured && <span className="ml-1.5 text-xs font-medium text-gray-400 align-middle">{grade}</span>}
      </p>
      <p className="mt-1.5 text-xs text-gray-400 truncate">{measured ? sub : 'Not checked'}</p>
    </div>
  );
}

/** The audit before this one on the same site: undefined while loading, null when this is the first. */
function usePreviousAudit(targetUrl: string, scanId: string | null): AdaTrendPoint | null | undefined {
  const [prev, setPrev] = useState<AdaTrendPoint | null | undefined>(undefined);
  useEffect(() => {
    let alive = true;
    getAdaTrend(targetUrl)
      .then((r) => { if (alive) setPrev(trendPosition(r.points, scanId)?.prev ?? null); })
      .catch(() => { if (alive) setPrev(null); });
    return () => { alive = false; };
  }, [targetUrl, scanId]);
  return prev;
}

/* ───────────────────────────── issue explorer ───────────────────────────── */

/**
 * All issues, three levels deep and every level paged:
 *   toolbar   category, severity, search and sort, with the result line
 *   rules     one row per failing check, ten to a page
 *   rule      the fix, then its instances ten to a page, each opening in place
 * Nothing on this tab repeats the header, and nothing is coloured except the
 * severity badge.
 */

interface IssueGroup {
  key: string;
  category: AdaCategory;
  ruleId: string;
  title: string;
  severity: AdaSeverity;
  wcag?: string | null;
  helpUrl?: string | null;
  rows: AdaFinding[];
  occurrences: number;
  pages: number;
}

const SEV_ORDER: Record<AdaSeverity, number> = { critical: 0, serious: 1, moderate: 2, minor: 3 };
const RULES_PER_PAGE = 10;
const INSTANCES_PER_PAGE = 10;
type SortKey = 'severity' | 'instances' | 'pages';
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const chipCls = (active: boolean) => `px-2.5 py-1 rounded-full border text-[11px] font-medium transition-colors ${active ? 'bg-violet-600 border-violet-600 text-white' : 'bg-white border-gray-200 text-gray-600 hover:border-violet-300'}`;

function IssueExplorer({ findings, seed }: { findings: AdaFinding[]; summary: AdaSummary; seed: IssueSeed }) {
  const [sev, setSev] = useState<AdaSeverity | ''>(seed.severity || '');
  const [cat, setCat] = useState<AdaCategory | 'all'>(seed.category || 'all');
  const [q, setQ] = useState(seed.query || '');
  const [sort, setSort] = useState<SortKey>('severity');
  const [ruleKey, setRuleKey] = useState<string | null>(null);
  // The page number belongs to one filter combination: change a filter and it reads as 1 again.
  const filterKey = `${cat}|${sev}|${q}|${sort}`;
  const [paging, setPaging] = useState({ key: filterKey, page: 1 });
  const page = paging.key === filterKey ? paging.page : 1;
  const setPage = (p: number) => setPaging({ key: filterKey, page: p });

  // Counts for the chips are over the whole report, so a chip always says how many it would show.
  const totals = useMemo(() => {
    const issues = findings.filter((f) => f.category !== 'review');
    const bySeverity: Record<AdaSeverity, number> = { critical: 0, serious: 0, moderate: 0, minor: 0 };
    for (const f of issues) bySeverity[f.severity] += f.occurrences;
    const byCat: Record<AdaCategory, number> = { accessibility: 0, links: 0, 'best-practice': 0, review: 0, visual: 0 };
    for (const f of findings) byCat[f.category] += f.occurrences;
    return { issues: issues.reduce((a, f) => a + f.occurrences, 0), bySeverity, byCat };
  }, [findings]);

  const groups = useMemo<IssueGroup[]>(() => {
    const needle = q.trim().toLowerCase();
    const filtered = findings.filter((f) =>
      (cat === 'all' ? f.category !== 'review' : f.category === cat)
      && (!sev || f.severity === sev)
      && (!needle || [f.title, f.rule_id, f.page_url, f.element, f.description].some((s) => (s || '').toLowerCase().includes(needle))));
    const m = new Map<string, IssueGroup>();
    for (const f of filtered) {
      const key = `${f.category}|${f.rule_id}`;
      const g = m.get(key) || { key, category: f.category, ruleId: f.rule_id, title: f.title, severity: f.severity, wcag: f.wcag, helpUrl: f.help_url, rows: [], occurrences: 0, pages: 0 };
      g.rows.push(f);
      g.occurrences += f.occurrences;
      m.set(key, g);
    }
    for (const g of m.values()) g.pages = new Set(g.rows.map((r) => r.page_url)).size;
    const list = [...m.values()];
    if (sort === 'instances') list.sort((x, y) => y.occurrences - x.occurrences);
    else if (sort === 'pages') list.sort((x, y) => y.pages - x.pages || y.occurrences - x.occurrences);
    else list.sort((x, y) => SEV_ORDER[x.severity] - SEV_ORDER[y.severity] || y.occurrences - x.occurrences);
    return list;
  }, [findings, cat, sev, q, sort]);

  const pageCount = Math.max(1, Math.ceil(groups.length / RULES_PER_PAGE));
  const safePage = Math.min(page, pageCount);
  const pageGroups = groups.slice((safePage - 1) * RULES_PER_PAGE, safePage * RULES_PER_PAGE);
  const selected = groups.find((g) => g.key === ruleKey) || null;
  const instances = groups.reduce((a, g) => a + g.occurrences, 0);
  const sitePages = new Set(groups.flatMap((g) => g.rows.map((r) => r.page_url))).size;
  const filtersOn = cat !== 'all' || !!sev || !!q.trim();
  const n = (x: number) => x.toLocaleString();

  const categories: [AdaCategory | 'all', string, number][] = [
    ['all', 'All issues', totals.issues],
    ['accessibility', 'Accessibility', totals.byCat.accessibility],
    ['links', 'Broken links', totals.byCat.links],
    ['best-practice', 'Best practices', totals.byCat['best-practice']],
    ['review', 'Needs review', totals.byCat.review],
  ];

  return (
    <div>
      {/* Toolbar */}
      <div className="px-4 py-3 border-b border-gray-100 space-y-2.5">
        <div className="flex flex-wrap items-center gap-1.5">
          {categories.map(([k, label, count]) => (
            <button key={k} type="button" onClick={() => { setCat(k); if (k === 'review') setSev(''); }} title={k === 'review' ? 'Checks a person has to confirm. Not counted as issues.' : undefined} className={chipCls(cat === k)}>
              {label} <span className={cat === k ? 'text-violet-100' : 'text-gray-400'}>{n(count)}</span>
            </button>
          ))}
          <span className="mx-1 h-4 w-px bg-gray-200 hidden sm:block" aria-hidden />
          {SEVERITIES.map((s) => (
            <button key={s} type="button" onClick={() => setSev(sev === s ? '' : s)} className={chipCls(sev === s)}>
              {cap(s)} <span className={sev === s ? 'text-violet-100' : 'text-gray-400'}>{n(totals.bySeverity[s])}</span>
            </button>
          ))}
          <div className="ml-auto flex items-center gap-2">
            <div className="relative w-56">
              <Search className="w-3.5 h-3.5 text-gray-400 absolute left-2.5 top-1/2 -translate-y-1/2" />
              <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search rules, pages, elements" aria-label="Search issues" className={inputCls + ' !py-1.5 pl-8 text-xs'} />
            </div>
            <select value={sort} onChange={(e) => setSort(e.target.value as SortKey)} aria-label="Sort rules" className="px-2.5 py-1.5 bg-white border border-gray-200 rounded-lg text-xs text-gray-700 outline-none focus:ring-2 focus:ring-violet-500/20 focus:border-violet-400">
              <option value="severity">Sort: Severity</option>
              <option value="instances">Sort: Instances</option>
              <option value="pages">Sort: Site pages</option>
            </select>
          </div>
        </div>
        <p className="text-xs text-gray-500">
          <span className="font-semibold text-gray-800 tabular-nums">{n(groups.length)}</span> rule{groups.length === 1 ? '' : 's'}
          {' · '}<span className="font-semibold text-gray-800 tabular-nums">{n(instances)}</span> instance{instances === 1 ? '' : 's'}
          {' · '}<span className="font-semibold text-gray-800 tabular-nums">{n(sitePages)}</span> site page{sitePages === 1 ? '' : 's'}
          {filtersOn && <button type="button" onClick={() => { setCat('all'); setSev(''); setQ(''); }} className="ml-3 text-violet-700 hover:underline">Clear filters</button>}
        </p>
      </div>

      {/* Rules on the left, the chosen rule on the right */}
      <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,1fr)_440px] xl:divide-x divide-gray-100">
        <div className="min-w-0">
          {groups.length === 0 ? (
            <p className="px-4 py-10 text-xs text-gray-500 text-center">{findings.length === 0 ? 'No issues were found on the pages audited.' : 'No issues match these filters.'}</p>
          ) : (
            <table className="w-full text-xs">
              <thead>
                <tr className="text-[10.5px] uppercase tracking-wide text-gray-400">
                  <th className="text-left px-4 py-2 font-medium">Rule</th>
                  <th className="text-left px-2 py-2 font-medium w-24">Severity</th>
                  <th className="text-right px-2 py-2 font-medium w-24">Site pages</th>
                  <th className="text-right px-4 py-2 font-medium w-24">Instances</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100 border-t border-gray-100">
                {pageGroups.map((g) => {
                  const active = selected?.key === g.key;
                  return (
                    <tr key={g.key} onClick={() => setRuleKey(g.key)} className={`cursor-pointer transition-colors ${active ? 'bg-violet-50/60' : 'hover:bg-gray-50'}`}>
                      <td className="px-4 py-2.5 align-top">
                        <p className={`leading-snug ${active ? 'text-violet-800 font-medium' : 'text-gray-800'}`}>{g.title}</p>
                        <p className="text-[10.5px] text-gray-400 mt-0.5">{CATEGORY_LABEL[g.category]}{g.wcag ? ` · WCAG ${g.wcag}` : ''}</p>
                      </td>
                      <td className="px-2 py-2.5 align-top"><span className={`inline-block px-2 py-0.5 rounded border text-[10px] font-medium ${SEV_STYLE[g.severity]}`}>{cap(g.severity)}</span></td>
                      <td className="px-2 py-2.5 align-top text-right tabular-nums text-gray-600">{n(g.pages)}</td>
                      <td className="px-4 py-2.5 align-top text-right tabular-nums font-semibold text-gray-800">{n(g.occurrences)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
          <Pager page={safePage} pageCount={pageCount} total={groups.length} pageSize={RULES_PER_PAGE} unit="rules" onPage={setPage} />
        </div>
        <div className="min-w-0 border-t xl:border-t-0 border-gray-100">
          {selected
            ? <RuleDetail key={selected.key} group={selected} />
            : <p className="px-6 py-10 text-xs text-gray-400 text-center">Select a rule to see how to fix it and where it occurs.</p>}
        </div>
      </div>
    </div>
  );
}

/** "1-10 of 47 rules" with previous / next. Hidden when there is nothing to page. */
function Pager({ page, pageCount, total, pageSize, unit, onPage }: { page: number; pageCount: number; total: number; pageSize: number; unit: string; onPage: (p: number) => void }) {
  if (total === 0) return null;
  const from = (page - 1) * pageSize + 1;
  const to = Math.min(total, page * pageSize);
  const btn = 'p-1 rounded-md border border-gray-200 text-gray-500 hover:border-violet-300 hover:text-violet-700 disabled:opacity-30 disabled:hover:border-gray-200 disabled:hover:text-gray-500';
  return (
    <div className="flex items-center justify-between px-4 py-2 border-t border-gray-100 text-[11px] text-gray-500">
      <span className="tabular-nums">{from.toLocaleString()}-{to.toLocaleString()} of {total.toLocaleString()} {unit}</span>
      {pageCount > 1 && (
        <div className="flex items-center gap-1">
          <button type="button" onClick={() => onPage(page - 1)} disabled={page <= 1} aria-label="Previous page" className={btn}><ChevronLeft className="w-3.5 h-3.5" /></button>
          <span className="px-2 tabular-nums text-gray-600">{page} / {pageCount}</span>
          <button type="button" onClick={() => onPage(page + 1)} disabled={page >= pageCount} aria-label="Next page" className={btn}><ChevronRight className="w-3.5 h-3.5" /></button>
        </div>
      )}
    </div>
  );
}

/** One rule: what it is, how to fix it, then every instance ten at a time. */
function RuleDetail({ group }: { group: IssueGroup }) {
  const [pq, setPq] = useState('');
  const [paging, setPaging] = useState({ key: '', page: 1 });
  const page = paging.key === pq ? paging.page : 1;
  const setPage = (p: number) => setPaging({ key: pq, page: p });
  const [inst, setInst] = useState<AdaFinding | null>(null);
  const [showExample, setShowExample] = useState(false);
  const rem = remediationOf(group.rows[0]);
  const isLink = group.category === 'links';
  const rows = useMemo(() => {
    const needle = pq.trim().toLowerCase();
    if (!needle) return group.rows;
    return group.rows.filter((f) => [f.page_url, f.element, String(f.details?.link || '')].some((s) => (s || '').toLowerCase().includes(needle)));
  }, [group, pq]);
  const pageCount = Math.max(1, Math.ceil(rows.length / INSTANCES_PER_PAGE));
  const safePage = Math.min(page, pageCount);
  const slice = rows.slice((safePage - 1) * INSTANCES_PER_PAGE, safePage * INSTANCES_PER_PAGE);
  const n = (x: number) => x.toLocaleString();

  return (
    <div className="text-xs">
      <div className="px-4 pt-4 pb-3 border-b border-gray-100">
        <div className="flex flex-wrap items-center gap-1.5 mb-1.5">
          <span className={`px-2 py-0.5 rounded border text-[10px] font-medium ${SEV_STYLE[group.severity]}`}>{cap(group.severity)}</span>
          <span className="px-2 py-0.5 rounded border border-gray-200 text-[10px] text-gray-600">{CATEGORY_LABEL[group.category]}</span>
          {group.wcag && <span className="px-2 py-0.5 rounded border border-gray-200 text-[10px] text-gray-600">WCAG {group.wcag}</span>}
          {rem && <span className="px-2 py-0.5 rounded border border-gray-200 text-[10px] text-gray-600">{EFFORT_LABEL[rem.effort]}</span>}
        </div>
        <p className="text-sm font-semibold text-gray-900 leading-snug">{group.title}</p>
        <p className="text-gray-500 mt-1">
          {n(group.occurrences)} instance{group.occurrences === 1 ? '' : 's'} on {n(group.pages)} site page{group.pages === 1 ? '' : 's'}
          {group.helpUrl && <> · <a href={group.helpUrl} target="_blank" rel="noopener noreferrer" className="text-violet-700 hover:underline">Rule reference</a></>}
        </p>
      </div>

      {rem ? (
        <div className="px-4 py-3 border-b border-gray-100 space-y-2">
          <p className="text-gray-800">{rem.problem}</p>
          {rem.impact && <p className="text-gray-500">{rem.impact}</p>}
          <p className="text-[10.5px] uppercase tracking-wide text-gray-400 pt-1">How to fix</p>
          <ol className="list-decimal pl-4 space-y-0.5 text-gray-700">{rem.steps.map((st, i) => <li key={i}>{st}</li>)}</ol>
          {rem.example && (
            <div>
              <button type="button" onClick={() => setShowExample((v) => !v)} className="text-violet-700 hover:underline">{showExample ? 'Hide example' : 'Show example'}</button>
              {showExample && (
                <div className="mt-2 space-y-1.5">
                  <p className="text-[10px] text-gray-400">Before</p>
                  <pre className="font-mono text-[10.5px] text-gray-700 bg-gray-50 border border-gray-100 rounded px-2 py-1.5 whitespace-pre-wrap break-all max-h-32 overflow-auto">{rem.example.before}</pre>
                  <p className="text-[10px] text-gray-400">After</p>
                  <pre className="font-mono text-[10.5px] text-gray-700 bg-gray-50 border border-gray-100 rounded px-2 py-1.5 whitespace-pre-wrap break-all max-h-32 overflow-auto">{rem.example.after}</pre>
                  {rem.example.note && <p className="text-[10px] text-gray-500">{rem.example.note}</p>}
                </div>
              )}
            </div>
          )}
        </div>
      ) : group.rows[0]?.description ? (
        <p className="px-4 py-3 border-b border-gray-100 text-gray-600">{group.rows[0].description}</p>
      ) : null}
      {group.category === 'review' && (
        <p className="px-4 py-2.5 border-b border-gray-100 text-gray-500">The scanner could not decide these automatically. Open each page and confirm.</p>
      )}

      <div className="px-4 py-2 border-b border-gray-100 flex items-center gap-2">
        <p className="flex-1 text-[10.5px] uppercase tracking-wide text-gray-400">Instances</p>
        <div className="relative w-44">
          <Search className="w-3.5 h-3.5 text-gray-400 absolute left-2.5 top-1/2 -translate-y-1/2" />
          <input value={pq} onChange={(e) => setPq(e.target.value)} placeholder={isLink ? 'Filter by link or page' : 'Filter by page'} aria-label="Filter instances" className={inputCls + ' !py-1 pl-8 text-[11px]'} />
        </div>
      </div>
      <div className="divide-y divide-gray-100">
        {slice.length === 0 && <p className="px-4 py-6 text-gray-500 text-center">No instances match.</p>}
        {slice.map((f) => {
          const active = inst?.id === f.id;
          const primary = isLink ? String(f.details?.link || f.element || '') : shortUrl(f.page_url);
          const secondary = isLink ? `on ${shortUrl(f.page_url)}` : (f.element || '');
          return (
            <div key={f.id}>
              <button type="button" onClick={() => setInst(active ? null : f)} className={`w-full text-left px-4 py-2 flex items-start gap-2 transition-colors ${active ? 'bg-violet-50/60' : 'hover:bg-gray-50'}`}>
                <span className="min-w-0 flex-1">
                  <span className={`block truncate ${active ? 'text-violet-800 font-medium' : 'text-gray-800'}`} title={primary}>{primary}</span>
                  {secondary && <span className="block text-[10.5px] text-gray-400 font-mono truncate" title={secondary}>{secondary}</span>}
                </span>
                {f.occurrences > 1 && <span className="text-gray-400 tabular-nums flex-shrink-0 mt-px">×{f.occurrences}</span>}
                {active ? <ChevronDown className="w-3.5 h-3.5 text-gray-400 flex-shrink-0 mt-px" /> : <ChevronRight className="w-3.5 h-3.5 text-gray-300 flex-shrink-0 mt-px" />}
              </button>
              {active && <InstanceDetail finding={f} showFailure={!rem} />}
            </div>
          );
        })}
      </div>
      <Pager page={safePage} pageCount={pageCount} total={rows.length} pageSize={INSTANCES_PER_PAGE} unit="instances" onPage={setPage} />
    </div>
  );
}

/** Where exactly one instance is: the page, the element or link, the HTML. Opens under its row. */
function InstanceDetail({ finding, showFailure }: { finding: AdaFinding; showFailure: boolean }) {
  const [copied, setCopied] = useState(false);
  const d = finding.details || {};
  const isLink = finding.category === 'links';
  const copy = (text: string) => { navigator.clipboard?.writeText(text).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1200); }); };
  return (
    <div className="px-4 pb-3 pt-1 space-y-2.5 bg-violet-50/30">
      <Field label={isLink ? 'Found on page' : 'Page'}>
        <a href={finding.page_url} target="_blank" rel="noopener noreferrer" className="text-violet-700 hover:underline break-all inline-flex items-center gap-1">{finding.page_url} <ExternalLink className="w-3 h-3 flex-shrink-0" /></a>
      </Field>
      {isLink && (
        <>
          <Field label="Link">
            <a href={String(d.link || finding.element || '')} target="_blank" rel="noopener noreferrer" className="text-violet-700 hover:underline break-all">{String(d.link || finding.element || '')}</a>
            {typeof d.linkText === 'string' && d.linkText && <p className="text-gray-500 mt-0.5">Link text: "{d.linkText}"</p>}
          </Field>
          <Field label="Response">
            <span className="font-mono">{d.status ? `HTTP ${String(d.status)}` : String(finding.rule_id)}</span>
            {typeof d.finalUrl === 'string' && d.finalUrl && <p className="text-gray-500 break-all mt-0.5">Redirected to {d.finalUrl}</p>}
          </Field>
          {Array.isArray(d.referrers) && d.referrers.length > 1 && (
            <Field label={`Also referenced from ${d.referrers.length - 1} other page${d.referrers.length - 1 === 1 ? '' : 's'}`}>
              {(d.referrers as string[]).slice(1, 8).map((r) => <p key={r} className="text-gray-600 truncate" title={r}>{shortUrl(r)}</p>)}
            </Field>
          )}
        </>
      )}
      {!isLink && finding.element && (
        <Field label="Element" action={<button type="button" onClick={() => copy(finding.element!)} className="text-[10px] text-gray-400 hover:text-violet-600 flex items-center gap-1"><Copy className="w-3 h-3" /> {copied ? 'Copied' : 'Copy selector'}</button>}>
          <code className="block font-mono text-[11px] text-gray-800 bg-white border border-gray-100 rounded px-2 py-1 break-all">{finding.element}</code>
        </Field>
      )}
      {finding.html_snippet && (
        <Field label="HTML">
          <pre className="font-mono text-[10.5px] text-gray-700 bg-white border border-gray-100 rounded px-2 py-1.5 whitespace-pre-wrap break-all max-h-40 overflow-auto">{finding.html_snippet}</pre>
        </Field>
      )}
      {showFailure && typeof d.failureSummary === 'string' && d.failureSummary && (
        <Field label="What failed">
          <p className="text-gray-700 whitespace-pre-line">{d.failureSummary}</p>
        </Field>
      )}
      {finding.occurrences > 1 && <p className="text-[11px] text-gray-400">This entry stands for {finding.occurrences} matching elements on the page.</p>}
    </div>
  );
}

function Field({ label, children, action }: { label: string; children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <div>
      <div className="flex items-center justify-between mb-0.5">
        <p className="text-[10px] uppercase tracking-wide text-gray-400">{label}</p>
        {action}
      </div>
      {children}
    </div>
  );
}

/* ───────────────────────────── workflow log ───────────────────────────── */

function WorkflowLog({ events, summary, partial }: { events: AdaProgressEvent[]; summary: AdaSummary; partial: boolean }) {
  const counts = useMemo(() => {
    const c = { navigate: 0, warning: 0, 'link-check': 0 };
    for (const e of events) if (e.type in c) c[e.type as keyof typeof c]++;
    return c;
  }, [events]);
  return (
    <div>
      <div className="px-4 py-2.5 border-b border-gray-100 text-xs text-gray-600 flex flex-wrap gap-x-4 gap-y-1">
        <span>{describePages(summary)}</span>
        <span>{describeLinks(summary)}</span>
        <span><span className="font-semibold text-gray-800">{counts['link-check']}</span> link problems logged</span>
        <span><span className="font-semibold text-gray-800">{counts.warning}</span> warnings</span>
        <span>{fmtDuration(summary.durationMs)}</span>
        {partial && <span className="text-amber-700">stopped early</span>}
        {summary.robots.crawlDelay ? <span className="text-gray-400">robots.txt crawl-delay {summary.robots.crawlDelay}s honoured</span> : null}
      </div>
      {events.length === 0 ? (
        <p className="px-4 py-6 text-xs text-gray-400">No workflow log was kept for this audit.</p>
      ) : (
        <div className="max-h-[560px] overflow-y-auto px-4 py-3 space-y-1 bg-gray-50/50 font-mono text-[11px]">
          {events.map((e) => (
            <div key={e.seq} className="flex gap-2 items-start">
              <span className="text-gray-300 w-14 flex-shrink-0 tabular-nums">{new Date(e.at).toLocaleTimeString([], { hour12: false })}</span>
              <LogLine e={e} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ───────────────────────────── pages ───────────────────────────── */

function PagesTable({ scanId }: { scanId: string }) {
  const [pages, setPages] = useState<AdaPage[] | null>(null);
  useEffect(() => { getAdaPages(scanId).then(setPages).catch(() => setPages([])); }, [scanId]);
  if (!pages) return <p className="p-4 text-xs text-gray-400 flex items-center gap-2"><Loader2 className="w-3.5 h-3.5 animate-spin" /> Loading…</p>;
  const tone = (s: number) => s < 70 ? 'text-red-600' : s < 90 ? 'text-amber-600' : 'text-emerald-600';
  return (
    <div className="overflow-x-auto p-2">
      <table className="w-full text-xs">
        <thead>
          <tr className="text-left text-[11px] text-gray-400 border-b border-gray-100">
            <th className="py-1.5 px-2 font-medium">Page</th>
            <th className="py-1.5 px-2 font-medium">Found via</th>
            <th className="py-1.5 px-2 font-medium">HTTP</th>
            <th className="py-1.5 px-2 font-medium text-right">Load</th>
            <th className="py-1.5 px-2 font-medium text-right">Links</th>
            <th className="py-1.5 px-2 font-medium text-right">A11y</th>
            <th className="py-1.5 px-2 font-medium text-right">Practices</th>
            <th className="py-1.5 px-2 font-medium text-right">Issues</th>
          </tr>
        </thead>
        <tbody>
          {pages.map((p) => (
            <tr key={p.url} className="border-b border-gray-50">
              <td className="py-2 px-2 max-w-[360px]">
                <p className="text-gray-800 truncate" title={p.url}>{'· '.repeat(p.depth)}{p.title || shortUrl(p.url)}</p>
                <a href={p.url} target="_blank" rel="noopener noreferrer" className="text-[10px] text-gray-400 hover:text-violet-600 truncate block">{shortUrl(p.url)}</a>
              </td>
              <td className="py-2 px-2 text-gray-500 whitespace-nowrap" title={p.parent_url ? `Linked from ${p.parent_url}` : undefined}>{SOURCE_LABEL[p.source || 'link']}{p.depth ? <span className="text-gray-400"> · depth {p.depth}</span> : null}</td>
              <td className="py-2 px-2"><span className={`font-mono ${p.status_code && p.status_code < 400 ? 'text-gray-600' : 'text-red-600'}`}>{p.status_code ?? 'ERR'}</span></td>
              <td className="py-2 px-2 text-right text-gray-600">{(p.load_ms / 1000).toFixed(1)}s</td>
              <td className="py-2 px-2 text-right text-gray-600">{p.links_found}</td>
              <td className={`py-2 px-2 text-right font-medium ${tone(p.a11y_score)}`}>{p.a11y_score}</td>
              <td className={`py-2 px-2 text-right font-medium ${tone(p.bp_score)}`}>{p.bp_score}</td>
              <td className="py-2 px-2 text-right text-gray-600">{p.findings_count}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* ───────────────────────────── trend ───────────────────────────── */

const sameId = (a: string | null | undefined, b: string | null | undefined) => !!a && !!b && a.toLowerCase() === b.toLowerCase();

/** Locate this audit and the one before it in a site's trend. */
function trendPosition(points: AdaTrendPoint[], scanId: string | null): { cur: AdaTrendPoint; prev: AdaTrendPoint | null; index: number } | null {
  if (!points.length) return null;
  let index = scanId ? points.findIndex((p) => sameId(p.id, scanId)) : -1;
  if (index === -1) index = points.length - 1;
  return { cur: points[index], prev: index > 0 ? points[index - 1] : null, index };
}

/* ───────────────────────────── coverage ───────────────────────────── */

const SOURCE_LABEL: Record<string, string> = { start: 'Start page', sitemap: 'Sitemap', link: 'Link on an audited page' };

function stoppedReason(c: AdaCoverage): string {
  if (c.stoppedBecause === 'every-page-audited') return 'Every page found was audited.';
  if (c.stoppedBecause === 'cancelled') return `Stopped by the user; ${c.notAuditedTotal.toLocaleString()} page${c.notAuditedTotal === 1 ? ' was' : 's were'} found but not audited.`;
  return `Stopped at the per-audit page limit; ${c.notAuditedTotal.toLocaleString()} page${c.notAuditedTotal === 1 ? ' was' : 's were'} found but not audited.`;
}

function CoverageBar({ audited, found }: { audited: number; found: number }) {
  const pct = found ? Math.round((audited / found) * 100) : 0;
  return (
    <div className="flex items-center gap-2 min-w-[120px]">
      <div className="flex-1 h-1.5 bg-gray-100 rounded-full overflow-hidden"><div className="h-full bg-violet-500" style={{ width: `${pct}%` }} /></div>
      <span className="text-gray-500 tabular-nums w-9 text-right">{pct}%</span>
    </div>
  );
}

/** What was visited: pages by source, depth and section, links seen, and the pages left unaudited. */
function CoverageView({ summary }: { summary: AdaSummary }) {
  const c = summary.coverage;
  const [showUnaudited, setShowUnaudited] = useState(false);
  const [filter, setFilter] = useState('');
  if (!c) {
    return (
      <p className="px-4 py-6 text-xs text-gray-400">
        This audit ran before coverage tracking was added. {summary.pagesCrawled} page{summary.pagesCrawled === 1 ? '' : 's'} audited{(summary.pagesDiscovered || 0) > summary.pagesCrawled ? ` of ${summary.pagesDiscovered} found` : ''} · {summary.linksChecked} links checked. Run the audit again for the full breakdown.
      </p>
    );
  }
  const pct = c.found ? Math.round((c.audited / c.found) * 100) : 100;
  const q = filter.trim().toLowerCase();
  const unaudited = q ? c.notAudited.filter((p) => p.url.toLowerCase().includes(q)) : c.notAudited;
  const th = 'py-1.5 px-2 font-medium text-[11px] text-gray-400 text-left';
  const num = 'py-1.5 px-2 text-right tabular-nums text-gray-700';
  return (
    <div className="p-4 space-y-4 text-xs">
      <p className="text-gray-600">Every number below is a count of real browser visits and real links collected from those pages. Nothing is sampled or estimated. {stoppedReason(c)}</p>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        <Stat label="Pages audited" value={c.audited.toLocaleString()} sub={`of ${c.found.toLocaleString()} found (${pct}%)`} />
        <Stat label="Could not load" value={c.unreachable.toLocaleString()} sub="counted as audited, scored 0" tone={c.unreachable ? 'warn' : undefined} />
        <Stat label="Unique links seen" value={c.links.unique.toLocaleString()} sub={`${c.links.internal.toLocaleString()} internal · ${c.links.external.toLocaleString()} external`} />
        <Stat label="Links checked" value={c.links.checked.toLocaleString()} sub={c.links.skipped ? `${c.links.skipped.toLocaleString()} external skipped` : 'every link fetched once'} />
      </div>
      {(c.redirectedOffSite > 0 || c.skippedNonHtml > 0) && (
        <p className="text-gray-500">
          {c.redirectedOffSite > 0 && `${c.redirectedOffSite} page${c.redirectedOffSite === 1 ? '' : 's'} redirected off-site (recorded, not crawled further)`}
          {c.redirectedOffSite > 0 && c.skippedNonHtml > 0 && ' · '}
          {c.skippedNonHtml > 0 && `${c.skippedNonHtml} non-HTML URL${c.skippedNonHtml === 1 ? '' : 's'} skipped (PDF, images…) and checked as links instead`}
        </p>
      )}

      <div className="grid md:grid-cols-2 gap-4">
        <div>
          <p className="font-semibold text-gray-700 mb-1">Where the pages came from</p>
          <table className="w-full">
            <thead><tr className="border-b border-gray-100"><th className={th}>Source</th><th className={`${th} text-right`}>Found</th><th className={`${th} text-right`}>Audited</th><th className={th}></th></tr></thead>
            <tbody>
              {(['start', 'sitemap', 'link'] as const).map((k) => (
                <tr key={k} className="border-b border-gray-50">
                  <td className="py-1.5 px-2 text-gray-700">{SOURCE_LABEL[k]}</td>
                  <td className={num}>{c.bySource[k].found.toLocaleString()}</td>
                  <td className={num}>{c.bySource[k].audited.toLocaleString()}</td>
                  <td className="py-1.5 px-2"><CoverageBar audited={c.bySource[k].audited} found={c.bySource[k].found} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div>
          <p className="font-semibold text-gray-700 mb-1">How deep the crawl went</p>
          <table className="w-full">
            <thead><tr className="border-b border-gray-100"><th className={th}>Depth</th><th className={`${th} text-right`}>Found</th><th className={`${th} text-right`}>Audited</th><th className={th}></th></tr></thead>
            <tbody>
              {c.byDepth.map((d) => (
                <tr key={d.depth} className="border-b border-gray-50">
                  <td className="py-1.5 px-2 text-gray-700">{d.depth === 0 ? 'Start page' : d.depth === 1 ? 'Menu, sitemap & home-page links' : `${d.depth} clicks from home`}</td>
                  <td className={num}>{d.found.toLocaleString()}</td>
                  <td className={num}>{d.audited.toLocaleString()}</td>
                  <td className="py-1.5 px-2"><CoverageBar audited={d.audited} found={d.found} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div>
        <p className="font-semibold text-gray-700 mb-1">By site section <span className="font-normal text-gray-400">({c.bySection.length} section{c.bySection.length === 1 ? '' : 's'} — first two path segments)</span></p>
        <div className="max-h-[360px] overflow-y-auto">
          <table className="w-full">
            <thead className="sticky top-0 bg-white"><tr className="border-b border-gray-100"><th className={th}>Section</th><th className={`${th} text-right`}>Found</th><th className={`${th} text-right`}>Audited</th><th className={th}></th></tr></thead>
            <tbody>
              {c.bySection.map((s) => (
                <tr key={s.path} className="border-b border-gray-50">
                  <td className="py-1.5 px-2 font-mono text-gray-700">{s.path}{s.templated && <span className="ml-1.5 px-1.5 py-0.5 rounded bg-amber-50 text-amber-700 border border-amber-200 text-[10px] font-sans">templated · sampled first</span>}</td>
                  <td className={num}>{s.found.toLocaleString()}</td>
                  <td className={num}>{s.audited.toLocaleString()}</td>
                  <td className="py-1.5 px-2"><CoverageBar audited={s.audited} found={s.found} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {c.notAuditedTotal > 0 && (
        <div>
          <button onClick={() => setShowUnaudited((v) => !v)} className="flex items-center gap-1.5 font-semibold text-gray-700 hover:text-violet-700">
            {showUnaudited ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
            {c.notAuditedTotal.toLocaleString()} page{c.notAuditedTotal === 1 ? '' : 's'} found but not audited
          </button>
          {showUnaudited && (
            <div className="mt-2 border border-gray-100 rounded-lg overflow-hidden">
              <div className="px-2 py-1.5 border-b border-gray-100 bg-gray-50/60 flex items-center gap-2">
                <Search className="w-3.5 h-3.5 text-gray-400" />
                <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter by URL…" className="flex-1 bg-transparent outline-none text-xs" />
                <span className="text-gray-400">{unaudited.length.toLocaleString()}{c.notAudited.length < c.notAuditedTotal ? ` of first ${c.notAudited.length.toLocaleString()}` : ''}</span>
              </div>
              <div className="max-h-[320px] overflow-y-auto font-mono text-[11px]">
                {unaudited.slice(0, 1000).map((p) => (
                  <div key={p.url} className="px-2 py-1 border-b border-gray-50 flex items-center gap-2" title={p.parentUrl ? `Linked from ${p.parentUrl}` : SOURCE_LABEL[p.source]}>
                    <a href={p.url} target="_blank" rel="noopener noreferrer" className="text-gray-700 hover:text-violet-600 truncate flex-1">{shortUrl(p.url)}</a>
                    <span className="text-gray-400 font-sans whitespace-nowrap">{SOURCE_LABEL[p.source]}</span>
                  </div>
                ))}
                {unaudited.length > 1000 && <p className="px-2 py-1.5 text-gray-400 font-sans">Showing the first 1,000 — narrow the filter or download the pages CSV for the full list.</p>}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/* ───────────────────────────── exports ───────────────────────────── */

/** One row per page visited, then one per page found but not audited — the full trail of the crawl. */
function buildPagesCsv(pages: AdaPage[], coverage?: AdaCoverage): string {
  const cell = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""').replace(/\r?\n/g, ' ')}"`;
  const head = ['Status', 'Page', 'Title', 'Found via', 'Linked from', 'Depth', 'HTTP', 'Load (s)', 'Links on page', 'Accessibility score', 'Best-practice score', 'Issues'];
  const rows: unknown[][] = pages.map((p) => [
    p.status_code === null ? 'Audited — could not load' : 'Audited', p.url, p.title, SOURCE_LABEL[p.source || 'link'], p.parent_url || '', p.depth,
    p.status_code ?? 'ERR', (p.load_ms / 1000).toFixed(1), p.links_found, p.a11y_score, p.bp_score, p.findings_count,
  ]);
  for (const p of coverage?.notAudited || []) rows.push(['Found — not audited', p.url, '', SOURCE_LABEL[p.source], p.parentUrl || '', p.depth, '', '', '', '', '', '']);
  return '\ufeff' + [head, ...rows].map((r) => r.map(cell).join(',')).join('\r\n');
}

function esc(s: unknown): string {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
}

function buildCsv(findings: AdaFinding[]): string {
  const cell = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""').replace(/\r?\n/g, ' ')}"`;
  const head = ['Category', 'Severity', 'Effort', 'Rule', 'Issue', 'WCAG', 'Page', 'Element / Link', 'Occurrences', 'Problem', 'How to fix', 'Example (after)', 'Reference'];
  const rows = findings.map((f) => {
    const r = remediationOf(f);
    return [
      CATEGORY_LABEL[f.category], f.severity, r ? EFFORT_LABEL[r.effort] : '', f.rule_id, f.title, f.wcag || '', f.page_url,
      f.category === 'links' ? String(f.details?.link || f.element || '') : (f.element || ''),
      f.occurrences, r?.problem || f.description || '', r ? r.steps.map((s, i) => `${i + 1}. ${s}`).join(' ') : '', r?.example?.after || '', f.help_url || '',
    ];
  });
  return '﻿' + [head, ...rows].map((r) => r.map(cell).join(',')).join('\r\n');
}

/* ───────────────────────────────────────────────────────────────
   Downloadable HTML report — the executive report that goes to leadership.
   One masthead, one summary card, one "needs attention" list, then the
   evidence in collapsed sections. Figures are in ink; severity is a thin bar.
   ─────────────────────────────────────────────────────────────── */

const n = (x: number) => x.toLocaleString();
const SEV_HEX: Record<AdaSeverity, string> = { critical: '#dc2626', serious: '#ea580c', moderate: '#d97706', minor: '#9ca3af' };
const GRADE_WORD: Record<string, string> = { A: 'Excellent', B: 'Good', C: 'Fair', D: 'Poor', F: 'Failing' };

function fmtDate(iso: string): string {
  const d = new Date(iso);
  return `${d.toLocaleDateString('en-US', { day: 'numeric', month: 'short', year: 'numeric' })}, ${d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}`;
}
function fmtDay(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', { day: 'numeric', month: 'short' });
}
const topLink = '<a class="top" href="#top">Top</a>';
const h2 = (id: string, title: string, count?: string) => `<h2 id="${id}"><span>${esc(title)}${count !== undefined ? ` <em>${esc(count)}</em>` : ''}</span>${topLink}</h2>`;
const sev = (s: AdaSeverity) => `<span class="dot" style="background:${SEV_HEX[s]}"></span>${s}`;

/** One figure: number in ink, label under it, grade or basis in small gray. */
function figure(label: string, c: AdaCategoryScore, sub?: string, anchor?: string): string {
  const tag = anchor ? `a href="#${anchor}"` : 'div';
  const close = anchor ? 'a' : 'div';
  if (c.score === null || c.grade === null) return `<${tag} class="fig"><div class="v muted">—</div><div class="l">${esc(label)}</div><div class="s">${esc(c.label || 'Not checked')}</div></${close}>`;
  return `<${tag} class="fig"><div class="v">${c.score}</div><div class="l">${esc(label)}</div><div class="s">Grade ${c.grade}${sub ? ` · ${esc(sub)}` : ''}</div></${close}>`;
}

/** Thin stacked severity bar with a dot legend. */
function severityBar(by: Record<AdaSeverity, number>): string {
  const total = by.critical + by.serious + by.moderate + by.minor;
  const seg = (k: AdaSeverity) => total && by[k] ? `<i style="flex:${by[k]};background:${SEV_HEX[k]}"></i>` : '';
  const leg = (k: AdaSeverity) => `<span>${sev(k)} ${n(by[k])}</span>`;
  return `<div class="bar">${seg('critical')}${seg('serious')}${seg('moderate')}${seg('minor')}${total ? '' : '<i style="flex:1;background:#e5e7eb"></i>'}</div><div class="legend">${leg('critical')}${leg('serious')}${leg('moderate')}${leg('minor')}</div>`;
}

/** Crawl coverage section: what was visited, by source, depth and section. */
function coverageHtml(s: AdaSummary): string {
  const c = s.coverage;
  if (!c) return '';
  const pct = (aud: number, found: number) => found ? `${Math.round((aud / found) * 100)}%` : '—';
  const row = (label: string, found: number, audited: number, extra = '') => `<tr><td>${label}${extra}</td><td class="num">${n(found)}</td><td class="num">${n(audited)}</td><td class="num">${pct(audited, found)}</td></tr>`;
  const depthLabel = (d: number) => d === 0 ? 'Start page' : d === 1 ? 'Menu, sitemap &amp; home-page links' : `${d} clicks from home`;
  const inv = s.inventory;
  const facts: [string, string][] = [];
  if (inv && inv.sitemapUrls > 0) {
    facts.push(['URLs in sitemap', n(inv.sitemapUrls)]);
    if (inv.auditedLocale) facts.push(['Language versions', `${inv.locales.length} (${inv.locales.map((l) => l.code).join(', ')}) · audited ${inv.auditedLocale}`]);
    facts.push(['Pages in scope', n(inv.pagesInScope)]);
    if (inv.templatedPages) facts.push(['Templated articles', `${n(inv.templatedPages)} in ${inv.sections.filter((x) => x.templated).map((x) => x.path).join(', ')}`]);
  }
  facts.push(['Links', `${n(c.links.unique)} unique · ${n(c.links.internal)} internal · ${n(c.links.external)} external · ${n(c.links.checked)} checked${c.links.skipped ? ` · ${n(c.links.skipped)} external skipped` : ''}`]);
  const notes = [stoppedReason(c),
    c.unreachable ? `${c.unreachable} page${c.unreachable === 1 ? '' : 's'} could not be loaded (counted as audited, scored 0).` : '',
    c.redirectedOffSite ? `${c.redirectedOffSite} redirected off-site.` : '',
    c.skippedNonHtml ? `${c.skippedNonHtml} non-HTML URL${c.skippedNonHtml === 1 ? '' : 's'} checked as links.` : ''].filter(Boolean).join(' ');
  return `<section class="card">${h2('coverage', 'Coverage', `${n(c.audited)} of ${n(c.found)} pages audited · ${pct(c.audited, c.found)}`)}
<dl class="facts">${facts.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join('')}</dl>
<p class="note">${esc(notes)}</p>
<div class="two">
<table><tr><th>Where the pages came from</th><th class="num">Found</th><th class="num">Audited</th><th class="num">Coverage</th></tr>${row(esc(SOURCE_LABEL.start), c.bySource.start.found, c.bySource.start.audited)}${row(esc(SOURCE_LABEL.sitemap), c.bySource.sitemap.found, c.bySource.sitemap.audited)}${row(esc(SOURCE_LABEL.link), c.bySource.link.found, c.bySource.link.audited)}</table>
<table><tr><th>Depth</th><th class="num">Found</th><th class="num">Audited</th><th class="num">Coverage</th></tr>${c.byDepth.map((d) => row(depthLabel(d.depth), d.found, d.audited)).join('')}</table>
</div>
<table><tr><th>Site section</th><th class="num">Found</th><th class="num">Audited</th><th class="num">Coverage</th></tr>${c.bySection.map((x) => row(`<code>${esc(x.path)}</code>`, x.found, x.audited, x.templated ? ' <span class="muted">templated · sampled first</span>' : '')).join('')}</table></section>`;
}

/** UX testing section: layout integrity and design adherence, per device. */
function uxHtml(s: AdaSummary): string {
  const ux = s.categories.ux;
  if (!ux) return '';
  const v = (x: number | null) => x === null ? '—' : String(x);
  const off = ux.standard ? ux.colors.filter((c) => c.inStandard === false).slice(0, 12) : [];
  return `<section class="card">${h2('ux', 'UX testing', `${n(ux.issues)} issues · ${n(ux.needsReview)} to review`)}
<div class="figs small">${figure('UX score', ux)}${figure('Layout integrity', ux.layout, 'overlaps, cut-off text, scrolling, touch targets')}${figure('Design adherence', ux.adherence, ux.standard ? `against "${ux.standard.name}"` : undefined)}</div>
${ux.standard ? '' : '<p class="note">Design adherence is not scored: no design standard was uploaded, so the site was only checked against itself.</p>'}
<table><tr><th>Device</th><th>Viewport</th><th class="num">Pages</th><th class="num">Issues</th><th class="num">Layout</th><th class="num">Adherence</th></tr>${ux.devices.map((d) => `<tr><td>${esc(d.label)}</td><td class="muted">${esc(d.viewport)}</td><td class="num">${d.pagesChecked}</td><td class="num">${d.issues}</td><td class="num">${v(d.layoutScore)}</td><td class="num">${v(d.adherenceScore)}</td></tr>`).join('')}</table>
<p class="note">${esc(ux.emulationNote)}</p>
${ux.topRules.length ? `<table><tr><th>Finding</th><th>Type</th><th>Severity</th><th class="num">Occurrences</th><th class="num">Pages</th><th>Devices</th></tr>${ux.topRules.map((r) => `<tr><td>${esc(r.title)}</td><td class="muted">${r.confidence === 'high' ? esc(r.family) : 'to review'}</td><td class="sv">${sev(r.severity)}</td><td class="num">${n(r.occurrences)}</td><td class="num">${r.pages}</td><td class="muted">${esc(r.devices.join(', '))}</td></tr>`).join('')}</table>` : ''}
${off.length ? `<h3>Colours in use that are not in the standard</h3><div class="swatches">${off.map((c) => `<span><i style="background:${esc(c.hex)}"></i><code>${esc(c.hex)}</code> ${n(c.uses)} uses${c.nearest ? ` · nearest ${esc(c.nearest.hex)}` : ''}</span>`).join('')}</div>` : ''}</section>`;
}

/** Trend section: this audit against the previous ones of the same site. */
function trendHtml(points: AdaTrendPoint[], scanId: string | null): string {
  const pos = trendPosition(points, scanId);
  if (!pos || points.length < 2) return '';
  const { cur, prev } = pos;
  const d = (a: number | null, b: number | null) => (a === null || b === null) ? '—' : `${a - b > 0 ? '+' : ''}${n(a - b)}`;
  const rows = points.slice(-12).map((p) => `<tr${sameId(p.id, cur.id) ? ' class="cur"' : ''}><td>${esc(fmtDate(p.finishedAt))}${p.status === 'cancelled' ? ' <span class="muted">stopped early</span>' : ''}</td><td class="muted">${esc(p.createdBy || '')}</td><td class="num">${p.score ?? '—'}</td><td class="num">${n(p.pagesAudited)}</td><td class="num">${n(p.issues)}</td><td class="num">${p.violations ?? '—'}</td><td class="num">${p.brokenLinks ?? '—'}</td><td class="num">${p.bestPracticeFailing ?? '—'}</td></tr>`).join('');
  return `<section class="card">${h2('trend', 'Trend', `${points.length} audits of this site`)}
${prev ? `<dl class="facts"><div><dt>Since ${esc(fmtDay(prev.finishedAt))}</dt><dd>Score ${d(cur.score, prev.score)} · issues ${d(cur.issues, prev.issues)} · violations ${d(cur.violations, prev.violations)} · broken links ${d(cur.brokenLinks, prev.brokenLinks)}${cur.pagesAudited !== prev.pagesAudited ? ` · ${n(cur.pagesAudited)} vs ${n(prev.pagesAudited)} pages, so counts are not like-for-like` : ''}</dd></div></dl>` : ''}
<table><tr><th>Audit</th><th>Run by</th><th class="num">Score</th><th class="num">Pages</th><th class="num">Issues</th><th class="num">Violations</th><th class="num">Broken links</th><th class="num">Practices failing</th></tr>${rows}</table></section>`;
}

function buildHtmlReport(s: AdaSummary, partial: boolean, findings: AdaFinding[], pages: AdaPage[], trend: AdaTrendPoint[] = [], scanId: string | null = null): string {
  const a = s.categories.accessibility, l = s.categories.links, b = s.categories.bestPractice, ux = s.categories.ux;
  const broken = l.broken + l.serverErrors + l.timeouts;
  const issues = findings.filter((f) => f.category !== 'review');
  const totalIssues = issues.reduce((x, f) => x + f.occurrences, 0);
  const issuePages = new Set(issues.map((f) => f.page_url)).size;
  const bySev: Record<AdaSeverity, number> = { critical: 0, serious: 0, moderate: 0, minor: 0 };
  for (const f of issues) bySev[f.severity] += f.occurrences;

  type Group = { title: string; category: AdaCategory; severity: AdaSeverity; wcag?: string | null; helpUrl?: string | null; occ: number; pages: Set<string>; rows: AdaFinding[] };
  const groups = new Map<string, Group>();
  for (const f of findings) {
    const k = `${f.category}|${f.rule_id}`;
    const g = groups.get(k) || { title: f.title, category: f.category, severity: f.severity, wcag: f.wcag, helpUrl: f.help_url, occ: 0, pages: new Set<string>(), rows: [] };
    g.occ += f.occurrences; g.pages.add(f.page_url); g.rows.push(f); groups.set(k, g);
  }
  const sorted = [...groups.values()].sort((x, y) => SEV_ORDER[x.severity] - SEV_ORDER[y.severity] || y.occ - x.occ);

  /* Trend delta for the headline figure. */
  const pos = trendPosition(trend, scanId);
  const prev = pos?.prev || null;
  const delta = prev && prev.score !== null && s.overall.score !== null ? s.overall.score - prev.score : null;
  const deltaText = delta === null ? '' : delta === 0 ? `Unchanged since ${fmtDay(prev!.finishedAt)}` : `${delta > 0 ? '+' : ''}${delta} since ${fmtDay(prev!.finishedAt)}`;

  /* What needs attention: the six most important things, across every category. */
  type Item = { title: string; severity: AdaSeverity; occ: number; pages: number; effort?: string; anchor: string; where: string };
  const items: Item[] = sorted.filter((g) => g.category !== 'review').map((g) => ({
    title: g.title, severity: g.severity, occ: g.occ, pages: g.pages.size, effort: remediationOf(g.rows[0])?.effort, anchor: g.category, where: CATEGORY_LABEL[g.category],
  }));
  if (ux) for (const r of ux.topRules.filter((r) => r.confidence === 'high')) items.push({ title: r.title, severity: r.severity, occ: r.occurrences, pages: r.pages, anchor: 'ux', where: 'UX' });
  items.sort((x, y) => SEV_ORDER[x.severity] - SEV_ORDER[y.severity] || y.occ - x.occ);
  const attention = items.slice(0, 6);

  const scope = [
    describePages(s),
    describeLinks(s),
    ux ? `${ux.devices.length} device${ux.devices.length === 1 ? '' : 's'}` : '',
    fmtDuration(s.durationMs),
  ].filter(Boolean).join(' · ');

  const section = (cat: AdaCategory, heading: string, count: string) => {
    const gs = sorted.filter((g) => g.category === cat);
    if (!gs.length) return `<section class="card">${h2(cat, heading, count)}<p class="note">None found.</p></section>`;
    return `<section class="card">${h2(cat, heading, count)}` + gs.map((g) => {
      const r = remediationOf(g.rows[0]);
      const fix = r ? `<div class="fix"><div class="fixh">How to fix <span class="eff ${r.effort}">${esc(EFFORT_LABEL[r.effort])}</span></div><p><b>Problem.</b> ${esc(r.problem)}${r.impact ? ` <span class="muted">${esc(r.impact)}</span>` : ''}</p><ol>${r.steps.map((st) => `<li>${esc(st)}</li>`).join('')}</ol>${r.example ? `<div class="two"><div><span class="muted">Before</span><pre class="bad">${esc(r.example.before)}</pre></div><div><span class="muted">After</span><pre class="good">${esc(r.example.after)}</pre></div></div>${r.example.note ? `<p class="note">${esc(r.example.note)}</p>` : ''}` : ''}${g.helpUrl ? `<p class="note">Reference: <a href="${esc(g.helpUrl)}">${esc(g.helpUrl)}</a></p>` : ''}</div>` : (g.helpUrl ? `<p class="note">Reference: <a href="${esc(g.helpUrl)}">${esc(g.helpUrl)}</a></p>` : '');
      const rows = g.rows.slice(0, 200);
      return `<details${g.severity === 'critical' ? ' open' : ''}><summary><span class="sv">${sev(g.severity)}</span><span class="t">${esc(g.title)}</span><span class="m">${n(g.occ)} on ${g.pages.size} page${g.pages.size === 1 ? '' : 's'}${g.wcag ? ` · WCAG ${esc(g.wcag)}` : ''}</span></summary>
${fix}
<table><tr><th>Page</th><th>${cat === 'links' ? 'Link' : 'Element'}</th><th>Problem on this page</th></tr>
${rows.map((f) => { const fr = remediationOf(f); return `<tr><td><a href="${esc(f.page_url)}">${esc(shortUrl(f.page_url))}</a></td><td><code>${esc(cat === 'links' ? String(f.details?.link || f.element || '') : (f.element || ''))}</code></td><td>${esc(fr?.problem || f.description || '')}${fr?.example && cat !== 'links' && fr.example.after !== fr.example.before ? `<br><code class="good">${esc(fr.example.after)}</code>` : ''}${f.occurrences > 1 ? ` <span class="muted">×${f.occurrences}</span>` : ''}</td></tr>`; }).join('')}
</table>${g.rows.length > rows.length ? `<p class="note">${n(g.rows.length - rows.length)} more in the CSV export.</p>` : ''}</details>`; }).join('') + '</section>';
  };

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Website audit — ${esc(s.siteName)}</title>
<style>
:root{--ink:#111827;--body:#374151;--muted:#6b7280;--faint:#9ca3af;--line:#e5e7eb;--soft:#f3f4f6;--page:#f6f7f9;--accent:#5b21b6}
*{box-sizing:border-box}html{scroll-behavior:smooth}
body{font-family:-apple-system,"Segoe UI",Inter,Roboto,Arial,sans-serif;color:var(--body);background:var(--page);margin:0;padding:40px 24px 64px;font-size:13px;line-height:1.5}
.wrap{max-width:1040px;margin:0 auto}
a{color:var(--accent);text-decoration:none}a:hover{text-decoration:underline}
.eyebrow{font-size:11px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:var(--faint);margin:0 0 6px}
h1{font-size:28px;font-weight:700;color:var(--ink);margin:0 0 6px;letter-spacing:-.01em}
.meta{font-size:13px;color:var(--muted);margin:0 0 20px;display:flex;flex-wrap:wrap;gap:6px 14px;align-items:center}
.pill{display:inline-block;padding:2px 9px;border-radius:999px;font-size:11px;font-weight:600;border:1px solid var(--line);color:var(--body);background:#fff}.pill.warn{border-color:#fde68a;background:#fffbeb;color:#92400e}
.card{background:#fff;border:1px solid var(--line);border-radius:12px;padding:22px 24px;margin:0 0 16px;overflow-x:auto}
.figs{display:flex;align-items:stretch;gap:0}.fig{flex:1;padding:4px 18px;border-left:1px solid var(--line);color:inherit}.fig:first-child{padding-left:0;border-left:0}.fig.lead{flex:1.35}a.fig:hover{text-decoration:none;background:#faf9ff;border-radius:8px}
.fig .v{font-size:30px;font-weight:700;color:var(--ink);line-height:1.1;letter-spacing:-.02em}.fig.lead .v{font-size:48px}.fig .v.muted{color:var(--faint)}.fig .l{font-size:12px;color:var(--body);margin-top:6px;font-weight:600}.fig .s{font-size:11.5px;color:var(--muted);margin-top:2px}
.figs.small .fig .v{font-size:24px}
.row{display:flex;gap:28px;align-items:flex-start;margin-top:22px;padding-top:18px;border-top:1px solid var(--line)}.row>div{flex:1;min-width:0}
.k{font-size:11px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:var(--faint);margin:0 0 6px}
.big{font-size:24px;font-weight:700;color:var(--ink);line-height:1.1}.big small{font-size:12px;font-weight:400;color:var(--muted);margin-left:8px}
.bar{display:flex;height:6px;border-radius:3px;overflow:hidden;background:var(--soft);margin:10px 0 8px}.bar i{display:block}
.legend{display:flex;flex-wrap:wrap;gap:6px 16px;font-size:12px;color:var(--body)}.legend span{white-space:nowrap}
.dot{display:inline-block;width:8px;height:8px;border-radius:50%;margin:0 6px 1px 0;vertical-align:middle}
.scope{font-size:12.5px;color:var(--muted);margin:18px 0 0;padding-top:14px;border-top:1px solid var(--line)}
nav.toc{position:sticky;top:0;z-index:2;background:var(--page);padding:10px 0;margin:4px 0 12px;display:flex;flex-wrap:wrap;gap:4px 18px;font-size:12px;border-bottom:1px solid var(--line)}nav.toc a{color:var(--body);white-space:nowrap}nav.toc a:hover{color:var(--accent);text-decoration:none}nav.toc b{color:var(--ink);font-weight:600;margin-left:3px}
h2{font-size:16px;font-weight:700;color:var(--ink);margin:0 0 14px;display:flex;justify-content:space-between;align-items:baseline;scroll-margin-top:56px}h2 em{font-style:normal;font-weight:400;color:var(--muted);font-size:13px;margin-left:8px}h2 a.top{font-size:11px;font-weight:400;color:var(--faint)}
h3{font-size:12.5px;font-weight:600;color:var(--ink);margin:18px 0 8px}
.note{font-size:12px;color:var(--muted);margin:6px 0 10px}.muted{color:var(--muted)}
table{width:100%;border-collapse:collapse;font-size:12.5px;margin:4px 0 12px}th,td{text-align:left;padding:8px 10px;border-bottom:1px solid var(--soft);vertical-align:top}th{color:var(--muted);font-weight:600;font-size:11px;letter-spacing:.04em;text-transform:uppercase;border-bottom:1px solid var(--line)}td.num,th.num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}tr.cur td{font-weight:600;color:var(--ink)}td.sv,td.ef{white-space:nowrap}td.url{word-break:break-all;min-width:220px}
table.attn td:first-child{color:var(--ink);font-weight:600}table.attn td:first-child a{color:var(--ink)}
code{font-family:Consolas,"SF Mono",Menlo,monospace;font-size:11.5px;color:var(--accent);word-break:break-all}
dl.facts{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:10px 24px;margin:0 0 12px}dl.facts div{min-width:0}dt{font-size:11px;color:var(--faint);font-weight:600;text-transform:uppercase;letter-spacing:.04em}dd{margin:2px 0 0;color:var(--ink);font-size:13px}
details{border-top:1px solid var(--line);padding:10px 0 4px}details:last-of-type{padding-bottom:0}summary{cursor:pointer;list-style:none;display:flex;align-items:baseline;gap:12px;padding:4px 0}summary::-webkit-details-marker{display:none}summary::before{content:"";display:inline-block;width:6px;height:6px;border-right:1.5px solid var(--faint);border-bottom:1.5px solid var(--faint);transform:rotate(-45deg);margin-right:2px;flex:none}details[open]>summary::before{transform:rotate(45deg)}
summary .sv{font-size:11.5px;color:var(--body);width:82px;flex:none;text-transform:capitalize}summary .t{font-weight:600;color:var(--ink);font-size:13.5px}summary .m{margin-left:auto;font-size:12px;color:var(--muted);white-space:nowrap}
.fix{background:#fafafa;border:1px solid var(--line);border-radius:10px;padding:12px 14px;margin:10px 0;font-size:12.5px}.fixh{font-weight:600;color:var(--ink);margin-bottom:6px}.fix p{margin:0 0 6px}.fix ol{margin:4px 0 8px 18px;padding:0}.fix li{margin:2px 0}
.eff{display:inline-block;padding:1px 7px;border-radius:999px;font-size:10.5px;font-weight:600;margin-left:8px;border:1px solid var(--line);color:var(--muted);vertical-align:1px}.eff.quick{color:#047857;border-color:#a7f3d0}.eff.involved{color:#b91c1c;border-color:#fecaca}
.two{display:grid;grid-template-columns:1fr 1fr;gap:12px}
pre,code.good{font-family:Consolas,"SF Mono",Menlo,monospace;font-size:11.5px;white-space:pre-wrap;word-break:break-all;border-radius:8px;padding:8px 10px;margin:4px 0 0}pre.bad{background:#fef2f2;color:#991b1b;border:1px solid #fecaca}pre.good,code.good{background:#ecfdf5;color:#065f46;border:1px solid #a7f3d0}code.good{display:inline-block;margin-top:4px}
.swatches{display:flex;flex-wrap:wrap;gap:8px 18px;font-size:12px;color:var(--body)}.swatches i{display:inline-block;width:12px;height:12px;border-radius:3px;border:1px solid var(--line);vertical-align:-2px;margin-right:6px}
.foot{margin-top:24px;font-size:11.5px;color:var(--faint);display:flex;flex-wrap:wrap;gap:6px 16px}
@media (max-width:720px){body{padding:20px 14px 48px}.card{overflow-x:auto}.meta a{word-break:break-all}.figs{flex-wrap:wrap}.fig{flex:1 1 45%;border-left:0;padding:8px 12px 8px 0}.fig.lead{flex:1 1 100%}.row,.two{display:block}.row>div+div{margin-top:16px}summary .m{margin-left:0;white-space:normal}summary{flex-wrap:wrap}}
@media print{body{background:#fff;padding:0;font-size:11.5px}.card{border:0;padding:0 0 12px;break-inside:avoid;page-break-inside:avoid}nav.toc,h2 a.top{display:none}details{break-inside:avoid}a{color:inherit}.fig .v{font-size:26px}.fig.lead .v{font-size:40px}}
</style></head><body><div class="wrap">
<p class="eyebrow">IntelliQE · Website audit report</p>
<h1 id="top">${esc(s.siteName)}</h1>
<div class="meta"><span class="pill${partial ? ' warn' : ''}">${partial ? 'Partial · stopped early' : 'Complete'}</span><span class="pill">WCAG 2.2 AA</span><a href="${esc(s.targetUrl)}">${esc(s.targetUrl)}</a><span>${esc(fmtDate(s.finishedAt))}</span></div>

<section class="card">
<div class="figs">
${figure('Overall health', s.overall, s.overall.grade ? `${GRADE_WORD[s.overall.grade]}${deltaText ? ` · ${deltaText}` : ''}` : undefined).replace('class="fig"', 'class="fig lead"')}
${figure('Accessibility', a, 'WCAG 2.2 AA', 'accessibility')}
${figure('Links', l, l.measured === false ? undefined : `${n(broken)} broken of ${n(l.checked)}`, 'links')}
${figure('Best practices', b, `${b.rulesPassed} of ${b.rulesEvaluated} checks pass`, 'best-practice')}
${ux ? figure('UX', ux, `${ux.devices.length} device${ux.devices.length === 1 ? '' : 's'}`, 'ux') : ''}
</div>
<div class="row">
<div><p class="k">Issues</p><div class="big">${n(totalIssues)}<small>on ${n(issuePages)} page${issuePages === 1 ? '' : 's'}</small></div>${severityBar(bySev)}</div>
<div><p class="k">By category</p><table style="margin:0"><tr><td><a href="#accessibility">Accessibility violations</a></td><td class="num">${n(a.violations)}</td></tr><tr><td><a href="#links">Broken links</a></td><td class="num">${l.measured === false ? 'Not checked' : n(broken)}</td></tr><tr><td><a href="#best-practice">Best-practice checks failing</a></td><td class="num">${n(b.failingRules.length)}</td></tr>${ux ? `<tr><td><a href="#ux">UX issues</a></td><td class="num">${n(ux.issues)}</td></tr>` : ''}<tr><td><a href="#review">Needs manual review</a></td><td class="num">${n(a.needsReview)}</td></tr></table></div>
</div>
<p class="scope">${esc(scope)}</p>
</section>

${attention.length ? `<section class="card">${h2('attention', 'What needs attention')}
<table class="attn"><tr><th>Issue</th><th>Area</th><th>Severity</th><th class="num">Occurrences</th><th class="num">Pages</th><th>Effort</th></tr>
${attention.map((i) => `<tr><td><a href="#${i.anchor}">${esc(i.title)}</a></td><td class="muted">${esc(i.where)}</td><td class="sv">${sev(i.severity)}</td><td class="num">${n(i.occ)}</td><td class="num">${n(i.pages)}</td><td class="muted ef">${i.effort ? esc(EFFORT_LABEL[i.effort as AdaRemediation['effort']]) : ''}</td></tr>`).join('')}
</table></section>` : ''}

<nav class="toc">
<a href="#accessibility">Accessibility<b>${n(a.violations)}</b></a>
<a href="#links">Broken links<b>${l.measured === false ? '—' : n(broken)}</b></a>
<a href="#best-practice">Best practices<b>${n(b.failingRules.length)}</b></a>
<a href="#review">Manual review<b>${n(a.needsReview)}</b></a>
${ux ? `<a href="#ux">UX testing<b>${n(ux.issues)}</b></a>` : ''}
${trend.length > 1 ? '<a href="#trend">Trend</a>' : ''}
${s.coverage ? '<a href="#coverage">Coverage</a>' : ''}
<a href="#pages">Pages<b>${n(pages.length || s.pagesCrawled)}</b></a>
${s.coverage && s.coverage.notAuditedTotal > 0 ? `<a href="#not-audited">Not audited<b>${n(s.coverage.notAuditedTotal)}</b></a>` : ''}
${s.notes.length ? '<a href="#notes">Notes</a>' : ''}
</nav>

${section('accessibility', 'Accessibility violations', `${n(a.violations)} · WCAG 2.2 AA`)}
${l.measured === false
    ? `<section class="card">${h2('links', 'Broken links', 'not checked')}<p class="note">No links were checked in this audit${s.linksFound ? ` (${n(s.linksFound)} were collected)` : ''}. Links are not scored and not part of the overall health score.</p></section>`
    : section('links', 'Broken links', `${n(broken)} of ${n(l.checked)} checked${l.blocked ? ` · ${l.blocked} could not be verified` : ''}`)}
${section('best-practice', 'Best-practice issues', `${n(b.failingRules.length)} checks failing`)}
${section('review', 'Needs manual review', `${n(a.needsReview)} · not counted as issues`)}
${uxHtml(s)}
${trendHtml(trend, scanId)}
${coverageHtml(s)}
<section class="card">${h2('pages', 'Pages audited', n(pages.length || s.pagesCrawled))}
${pages.length ? `<table><tr><th>Page</th><th>Found via</th><th class="num">Depth</th><th class="num">HTTP</th><th class="num">Load</th><th class="num">Links</th><th class="num">Accessibility</th><th class="num">Best practices</th><th class="num">Issues</th></tr>
${pages.map((p) => `<tr><td class="url">${esc(p.title || shortUrl(p.url))}<br><a class="muted" href="${esc(p.url)}">${esc(p.url)}</a></td><td class="muted">${esc(SOURCE_LABEL[p.source || 'link'])}${p.parent_url ? `<br>from ${esc(shortUrl(p.parent_url))}` : ''}</td><td class="num">${p.depth}</td><td class="num">${p.status_code ?? 'ERR'}</td><td class="num">${(p.load_ms / 1000).toFixed(1)}s</td><td class="num">${p.links_found}</td><td class="num">${p.a11y_score}</td><td class="num">${p.bp_score}</td><td class="num">${p.findings_count}</td></tr>`).join('')}
</table>` : `<table><tr><th>Page</th><th class="num">Accessibility</th><th class="num">Best practices</th><th class="num">Issues</th></tr>
${s.worstPages.map((p) => `<tr><td>${esc(p.title || p.url)}<br><span class="muted">${esc(p.url)}</span></td><td class="num">${p.a11yScore}</td><td class="num">${p.bpScore}</td><td class="num">${p.findings}</td></tr>`).join('')}
</table><p class="note">The full page list could not be loaded; the ${s.worstPages.length} lowest-scoring pages are shown.</p>`}</section>
${s.coverage && s.coverage.notAuditedTotal > 0 ? `<section class="card">${h2('not-audited', 'Pages found but not audited', n(s.coverage.notAuditedTotal))}
<p class="note">${esc(stoppedReason(s.coverage))}${s.coverage.notAudited.length < s.coverage.notAuditedTotal ? ` The first ${n(s.coverage.notAudited.length)} are listed.` : ''}</p>
<details><summary><span class="t">Show the list</span></summary><table><tr><th>Page</th><th>Found via</th><th class="num">Depth</th></tr>
${s.coverage.notAudited.map((p) => `<tr><td><a href="${esc(p.url)}">${esc(p.url)}</a></td><td class="muted">${esc(SOURCE_LABEL[p.source])}${p.parentUrl ? `<br>from ${esc(shortUrl(p.parentUrl))}` : ''}</td><td class="num">${p.depth}</td></tr>`).join('')}
</table></details></section>` : ''}
${s.notes.length ? `<section class="card">${h2('notes', 'Notes')}<ul class="note" style="margin:0;padding-left:18px">${s.notes.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></section>` : ''}
<div class="foot"><span>Generated by IntelliQE · ${esc(fmtDate(s.finishedAt))}</span><span>Accessibility rules by axe-core (Deque)</span><span>Health score = accessibility 45% · links 30% · best practices 25%</span></div>
</div></body></html>`;
}
