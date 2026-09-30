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
  type AdaScanRecord, type AdaSeverity, type AdaSummary, type AdaRemediation, type AdaSiteInventory, type AdaCoverage,
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

/** Crawl coverage section of the downloadable report: what was visited, by source, depth and section. */
function coverageHtml(s: AdaSummary): string {
  const c = s.coverage;
  if (!c) return '';
  const pct = (aud: number, found: number) => found ? `${Math.round((aud / found) * 100)}%` : '—';
  const row = (label: string, found: number, audited: number, extra = '') => `<tr><td>${label}${extra}</td><td>${found.toLocaleString()}</td><td>${audited.toLocaleString()}</td><td>${pct(audited, found)}</td></tr>`;
  const depthLabel = (d: number) => d === 0 ? 'Start page' : d === 1 ? 'Menu, sitemap &amp; home-page links' : `${d} clicks from home`;
  return `<h2 id="coverage">Crawl coverage — ${c.audited.toLocaleString()} of ${c.found.toLocaleString()} pages audited (${pct(c.audited, c.found)}) <a class="top" href="#top">↑ top</a></h2>
<p class="muted">Every number is a count of real browser visits and real links collected from those pages; nothing is sampled or estimated. ${esc(stoppedReason(c))}${c.unreachable ? ` ${c.unreachable} page${c.unreachable === 1 ? '' : 's'} could not be loaded (counted as audited, scored 0).` : ''}${c.redirectedOffSite ? ` ${c.redirectedOffSite} redirected off-site.` : ''}${c.skippedNonHtml ? ` ${c.skippedNonHtml} non-HTML URL${c.skippedNonHtml === 1 ? '' : 's'} skipped and checked as links.` : ''}</p>
<p class="muted">Links: ${c.links.unique.toLocaleString()} unique (${c.links.internal.toLocaleString()} internal · ${c.links.external.toLocaleString()} external) · ${c.links.checked.toLocaleString()} fetched and checked${c.links.skipped ? ` · ${c.links.skipped.toLocaleString()} external skipped` : ''}.</p>
<div class="ex">
<div><table><tr><th>Where the pages came from</th><th>Found</th><th>Audited</th><th>Coverage</th></tr>${row(esc(SOURCE_LABEL.start), c.bySource.start.found, c.bySource.start.audited)}${row(esc(SOURCE_LABEL.sitemap), c.bySource.sitemap.found, c.bySource.sitemap.audited)}${row(esc(SOURCE_LABEL.link), c.bySource.link.found, c.bySource.link.audited)}</table></div>
<div><table><tr><th>Depth</th><th>Found</th><th>Audited</th><th>Coverage</th></tr>${c.byDepth.map((d) => row(depthLabel(d.depth), d.found, d.audited)).join('')}</table></div>
</div>
<table><tr><th>Site section</th><th>Found</th><th>Audited</th><th>Coverage</th></tr>${c.bySection.map((x) => row(`<code>${esc(x.path)}</code>`, x.found, x.audited, x.templated ? ' <span class="muted">templated · sampled first</span>' : '')).join('')}</table>`;
}

/** UX testing section of the downloadable report. */
function uxHtml(s: AdaSummary): string {
  const ux = s.categories.ux;
  if (!ux) return '';
  const v = (n: number | null) => n === null ? '—' : String(n);
  return `<h2 id="ux">UX testing — score ${v(ux.score)} · ${ux.issues.toLocaleString()} issues · ${ux.needsReview.toLocaleString()} to review <a class="top" href="#top">↑ top</a></h2>
<p class="muted"><b>Layout integrity ${v(ux.layout.score)}</b> (overlapping or covered controls, cut-off text, sideways scrolling, touch targets) · <b>Design adherence ${v(ux.adherence.score)}</b> ${ux.standard ? `against the design standard "${esc(ux.standard.name)}" (fonts, sizes, colours, radius, spacing)` : '— not scored: no design standard was uploaded, so the site was only checked against itself'}.</p>
<table><tr><th>Device</th><th>Viewport</th><th>Pages</th><th>Issues</th><th>Layout</th><th>Adherence</th></tr>${ux.devices.map((d) => `<tr><td>${esc(d.label)}</td><td>${esc(d.viewport)}</td><td>${d.pagesChecked}</td><td>${d.issues}</td><td>${v(d.layoutScore)}</td><td>${v(d.adherenceScore)}</td></tr>`).join('')}</table>
<p class="muted">${esc(ux.emulationNote)}</p>
<table><tr><th>Finding</th><th>Type</th><th>Severity</th><th>Occurrences</th><th>Pages</th><th>Devices</th></tr>${ux.topRules.map((r) => `<tr><td>${esc(r.title)}</td><td>${r.confidence === 'high' ? esc(r.family) : 'to review'}</td><td><span class="sev ${r.severity}">${r.severity}</span></td><td>${r.occurrences.toLocaleString()}</td><td>${r.pages}</td><td>${esc(r.devices.join(', '))}</td></tr>`).join('')}</table>
${ux.standard && ux.colors.some((c) => c.inStandard === false) ? `<p class="muted"><b>Most used colours not in the standard:</b> ${ux.colors.filter((c) => c.inStandard === false).slice(0, 10).map((c) => `<code>${esc(c.hex)}</code> (${c.uses.toLocaleString()} uses${c.nearest ? `, nearest ${esc(c.nearest.hex)}` : ''})`).join(' · ')}</p>` : ''}`;
}

/** Trend section of the downloadable report: this audit against the previous ones of the same site. */
function trendHtml(points: AdaTrendPoint[], scanId: string | null): string {
  const pos = trendPosition(points, scanId);
  if (!pos || points.length < 2) return '';
  const { cur, prev } = pos;
  const d = (a: number | null, b: number | null) => (a === null || b === null) ? 'n/a' : `${a - b > 0 ? '+' : ''}${a - b}`;
  const rows = points.slice(-12).map((p) => `<tr${sameId(p.id, cur.id) ? ' style="font-weight:600"' : ''}><td>${esc(new Date(p.finishedAt).toLocaleString())}${p.status === 'cancelled' ? ' <span class="muted">stopped early</span>' : ''}</td><td>${esc(p.createdBy || '')}</td><td>${p.score ?? '—'}</td><td>${p.pagesAudited}</td><td>${p.issues}</td><td>${p.violations ?? '—'}</td><td>${p.brokenLinks ?? '—'}</td><td>${p.bestPracticeFailing ?? '—'}</td></tr>`).join('');
  return `<h2 id="trend">Trend — ${points.length} audit${points.length === 1 ? '' : 's'} of this site <a class="top" href="#top">↑ top</a></h2>
${prev ? `<p class="muted">Compared with the previous audit (${esc(new Date(prev.finishedAt).toLocaleString())}): score ${d(cur.score, prev.score)} · issues ${d(cur.issues, prev.issues)} · accessibility violations ${d(cur.violations, prev.violations)} · broken links ${d(cur.brokenLinks, prev.brokenLinks)} · pages audited ${cur.pagesAudited} vs ${prev.pagesAudited}${cur.pagesAudited !== prev.pagesAudited ? ' (page counts differ — issue counts are not like-for-like)' : ''}.</p>` : ''}
<table><tr><th>Audit</th><th>Run by</th><th>Score</th><th>Pages</th><th>Issues</th><th>Violations</th><th>Broken links</th><th>Practices failing</th></tr>${rows}</table>`;
}

function buildHtmlReport(s: AdaSummary, partial: boolean, findings: AdaFinding[], pages: AdaPage[], trend: AdaTrendPoint[] = [], scanId: string | null = null): string {
  const a = s.categories.accessibility, l = s.categories.links, b = s.categories.bestPractice;
  const broken = l.broken + l.serverErrors + l.timeouts;
  const gradeColor: Record<string, string> = { A: '#059669', B: '#16a34a', C: '#d97706', D: '#ea580c', F: '#dc2626' };
  const score = (c: { score: number | null; grade: string | null; label?: string }, label: string, anchor?: string, basis?: string) =>
    c.score === null || c.grade === null
      ? `<div class="score" style="border-style:dashed;background:#f9fafb"><div class="big" style="color:#9ca3af">—</div><div class="lbl">${esc(label)}</div><div class="grade">${esc(c.label || 'Not checked')} · not counted in overall</div></div>`
      : `<${anchor ? `a href="#${anchor}"` : 'div'} class="score"><div class="big" style="color:${gradeColor[c.grade]}">${c.score}</div><div class="lbl">${esc(label)}</div><div class="grade">Grade ${c.grade}${basis ? ` · ${esc(basis)}` : ''}${anchor ? ' · view' : ''}</div></${anchor ? 'a' : 'div'}>`;
  const issues = findings.filter((f) => f.category !== 'review');
  const totalIssues = issues.reduce((x, f) => x + f.occurrences, 0);
  const bySev: Record<AdaSeverity, number> = { critical: 0, serious: 0, moderate: 0, minor: 0 };
  for (const f of issues) bySev[f.severity] += f.occurrences;
  const groups = new Map<string, { title: string; category: AdaCategory; severity: AdaSeverity; wcag?: string | null; helpUrl?: string | null; occ: number; pages: Set<string>; rows: AdaFinding[] }>();
  for (const f of findings) {
    const k = `${f.category}|${f.rule_id}`;
    const g = groups.get(k) || { title: f.title, category: f.category, severity: f.severity, wcag: f.wcag, helpUrl: f.help_url, occ: 0, pages: new Set<string>(), rows: [] };
    g.occ += f.occurrences; g.pages.add(f.page_url); g.rows.push(f); groups.set(k, g);
  }
  const sorted = [...groups.values()].sort((x, y) => SEV_ORDER[x.severity] - SEV_ORDER[y.severity] || y.occ - x.occ);
  const section = (cat: AdaCategory, heading: string) => {
    const gs = sorted.filter((g) => g.category === cat);
    const h2 = `<h2 id="${cat}">${esc(heading)} <a class="top" href="#top">↑ top</a></h2>`;
    if (!gs.length) return `${h2}<p class="muted">None found.</p>`;
    return h2 + gs.map((g) => {
      const r = remediationOf(g.rows[0]);
      const fix = r ? `<div class="fix"><div class="fixh"><span class="eff ${r.effort}">${esc(EFFORT_LABEL[r.effort])}</span> How to fix</div><p class="prob"><b>Problem:</b> ${esc(r.problem)}${r.impact ? ` <span class="muted">${esc(r.impact)}</span>` : ''}</p><ol>${r.steps.map((s) => `<li>${esc(s)}</li>`).join('')}</ol>${r.example ? `<div class="ex"><div><span class="muted">Before</span><pre class="bad">${esc(r.example.before)}</pre></div><div><span class="muted">After</span><pre class="good">${esc(r.example.after)}</pre></div></div>${r.example.note ? `<p class="muted">${esc(r.example.note)}</p>` : ''}` : ''}${g.helpUrl ? `<p class="muted">Reference: <a href="${esc(g.helpUrl)}">${esc(g.helpUrl)}</a></p>` : ''}</div>` : (g.helpUrl ? `<p class="muted">Reference: <a href="${esc(g.helpUrl)}">${esc(g.helpUrl)}</a></p>` : '');
      return `
<details open><summary><span class="sev ${g.severity}">${g.severity}</span> ${esc(g.title)} <b>(${g.occ})</b> <span class="muted">— ${g.pages.size} page${g.pages.size === 1 ? '' : 's'}${g.wcag ? ` · WCAG ${esc(g.wcag)}` : ''}</span></summary>
${fix}
<table><tr><th>Page</th><th>${cat === 'links' ? 'Link' : 'Element'}</th><th>Problem on this page</th></tr>
${g.rows.slice(0, 200).map((f) => { const fr = remediationOf(f); return `<tr><td><a href="${esc(f.page_url)}">${esc(shortUrl(f.page_url))}</a></td><td><code>${esc(cat === 'links' ? String(f.details?.link || f.element || '') : (f.element || ''))}</code></td><td>${esc(fr?.problem || f.description || '')}${fr?.example && cat !== 'links' && fr.example.after !== fr.example.before ? `<br><code class="good">${esc(fr.example.after)}</code>` : ''}${f.occurrences > 1 ? ` <span class="muted">(×${f.occurrences})</span>` : ''}</td></tr>`; }).join('')}
</table></details>`; }).join('');
  };
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Website audit — ${esc(s.siteName)}</title>
<style>html{scroll-behavior:smooth}body{font-family:Segoe UI,Arial,sans-serif;color:#1f2937;margin:0;padding:32px;max-width:1100px}h1{font-size:22px;margin:0 0 4px}h2{font-size:15px;margin:28px 0 8px;border-bottom:1px solid #e5e7eb;padding-bottom:4px;scroll-margin-top:64px;display:flex;justify-content:space-between;align-items:baseline}h2 a.top{font-size:11px;font-weight:400;color:#9ca3af;text-decoration:none}h2 a.top:hover{color:#5b21b6}
.toc{position:sticky;top:0;z-index:2;background:#fff;border-bottom:1px solid #e5e7eb;padding:8px 0;margin:14px 0 6px;display:flex;flex-wrap:wrap;gap:6px 16px;font-size:12px}.toc a{color:#5b21b6;text-decoration:none;white-space:nowrap}.toc a:hover{text-decoration:underline}.toc b{color:#1f2937;font-weight:600}a.score{text-decoration:none;color:inherit}a.score:hover{border-color:#a78bfa;background:#f5f3ff}.muted a{color:#5b21b6}
.muted{color:#6b7280;font-size:12px}.tag{display:inline-block;padding:2px 8px;border-radius:999px;font-size:11px;font-weight:600;margin-right:6px}.ok{background:#d1fae5;color:#065f46}.part{background:#fef3c7;color:#92400e}.wcag{background:#ede9fe;color:#5b21b6}
.scores{display:flex;gap:16px;margin:20px 0}.score{flex:1;border:1px solid #e5e7eb;border-radius:10px;padding:14px;text-align:center}.big{font-size:34px;font-weight:700}.lbl{font-size:12px;color:#6b7280}.grade{font-size:11px;color:#9ca3af}
.summary{display:flex;gap:24px;align-items:flex-start;border:1px solid #e5e7eb;border-radius:10px;padding:16px;margin:16px 0}.summary .n{font-size:40px;font-weight:700;line-height:1}
table{width:100%;border-collapse:collapse;font-size:12px;margin:6px 0 10px}th,td{text-align:left;padding:6px 8px;border-bottom:1px solid #f3f4f6;vertical-align:top}th{color:#6b7280;font-weight:600;font-size:11px}code{font-family:Consolas,monospace;font-size:11px;color:#5b21b6;word-break:break-all}
details{border:1px solid #e5e7eb;border-radius:8px;padding:8px 12px;margin:6px 0}summary{cursor:pointer;font-size:13px}
.sev{display:inline-block;padding:1px 6px;border-radius:4px;font-size:10px;font-weight:600;margin-right:4px}.critical{background:#fee2e2;color:#b91c1c}.serious{background:#ffedd5;color:#c2410c}.moderate{background:#fef3c7;color:#b45309}.minor{background:#f3f4f6;color:#4b5563}
.fix{background:#f5f3ff;border:1px solid #ddd6fe;border-radius:8px;padding:10px 12px;margin:8px 0;font-size:12px}.fixh{font-weight:600;color:#5b21b6;margin-bottom:4px}.fix ol{margin:4px 0 6px 18px;padding:0}.fix li{margin:2px 0}.prob{margin:0 0 4px}
.eff{display:inline-block;padding:1px 6px;border-radius:4px;font-size:10px;font-weight:600;margin-right:6px;border:1px solid}.quick{background:#ecfdf5;color:#047857;border-color:#a7f3d0}.moderate.eff{background:#fffbeb;color:#b45309;border-color:#fde68a}.involved{background:#fef2f2;color:#b91c1c;border-color:#fecaca}
.ex{display:grid;grid-template-columns:1fr 1fr;gap:8px}.ex pre,code.good{font-family:Consolas,monospace;font-size:11px;white-space:pre-wrap;word-break:break-all;border-radius:6px;padding:6px 8px;margin:2px 0 0}pre.bad{background:#fef2f2;color:#991b1b;border:1px solid #fecaca}pre.good,code.good{background:#ecfdf5;color:#065f46;border:1px solid #a7f3d0}code.good{display:inline-block;margin-top:4px;color:#065f46}
.foot{margin-top:32px;font-size:11px;color:#9ca3af}</style></head><body>
<h1 id="top">Website audit report — ${esc(s.siteName)}</h1>
${s.inventory && s.inventory.sitemapUrls > 0 ? `<p class="muted" style="margin:4px 0">Site inventory: ${s.inventory.sitemapUrls.toLocaleString()} URLs in sitemap${s.inventory.auditedLocale ? ` · ${s.inventory.locales.length} language version${s.inventory.locales.length === 1 ? '' : 's'} (${esc(s.inventory.locales.map((l) => l.code).join(', '))})` : ''} · ${s.inventory.pagesInScope.toLocaleString()} unique pages${s.inventory.auditedLocale ? ` in ${esc(s.inventory.auditedLocale)}` : ''}${s.inventory.templatedPages ? ` · ${s.inventory.templatedPages.toLocaleString()} templated articles (${esc(s.inventory.sections.filter((x) => x.templated).map((x) => x.path).join(', '))})` : ''}</p>` : ''}
<div class="muted" style="margin:6px 0 10px"><span class="tag ${partial ? 'part' : 'ok'}">${partial ? 'STOPPED EARLY — PARTIAL RESULTS' : 'COMPLETE'}</span><span class="tag wcag">WCAG 2.2 AA</span> ${esc(s.targetUrl)} · audited ${esc(new Date(s.finishedAt).toLocaleString())} · ${esc(describePages(s))} · ${esc(describeLinks(s))} · ${esc(fmtDuration(s.durationMs))}</div>
<nav class="toc">
<a href="#accessibility">Accessibility violations <b>${a.violations}</b></a>
<a href="#links">Broken links <b>${l.measured === false ? 'not checked' : broken}</b></a>
<a href="#best-practice">Best practices failing <b>${b.failingRules.length}</b></a>
<a href="#review">Needs manual review <b>${a.needsReview}</b></a>
${s.categories.ux ? `<a href="#ux">UX testing <b>${s.categories.ux.issues.toLocaleString()}</b></a>` : ''}
${trend.length > 1 ? '<a href="#trend">Trend</a>' : ''}
${s.coverage ? '<a href="#coverage">Coverage</a>' : ''}
<a href="#pages">Pages audited <b>${(pages.length || s.pagesCrawled).toLocaleString()}</b></a>
${s.coverage && s.coverage.notAuditedTotal > 0 ? `<a href="#not-audited">Not audited <b>${s.coverage.notAuditedTotal.toLocaleString()}</b></a>` : ''}
${s.notes.length ? '<a href="#notes">Notes</a>' : ''}
</nav>
<div class="scores">${score(s.overall, 'Overall health')}${score(a, 'Accessibility (WCAG 2.2 AA)', 'accessibility')}${score(l, 'Links', 'links', `${l.checked.toLocaleString()} checked · ${broken} broken`)}${score(b, 'Best practices', 'best-practice', `${b.rulesPassed}/${b.rulesEvaluated} checks passing`)}${s.categories.ux ? score(s.categories.ux, 'UX (layout + design)', 'ux', `${s.categories.ux.devices.length} devices`) : ''}</div>
<div class="summary"><div><div class="n">${totalIssues}</div><div class="muted">Issues in ${new Set(issues.map((f) => f.page_url)).size} pages and ${new Set(findings.filter((f) => f.element).map((f) => f.element)).size} components</div></div>
<div><div class="muted" style="font-weight:600;margin-bottom:4px">Severity breakdown</div><span class="sev critical">${bySev.critical} critical</span> <span class="sev serious">${bySev.serious} serious</span> <span class="sev moderate">${bySev.moderate} moderate</span> <span class="sev minor">${bySev.minor} minor</span><div class="muted" style="margin-top:8px"><a href="#review">${a.needsReview.toLocaleString()} item${a.needsReview === 1 ? '' : 's'} the scanner could not decide — manual review</a> · <a href="#accessibility">${a.violations} accessibility violation${a.violations === 1 ? '' : 's'}</a> · <a href="#links">${l.measured === false ? 'links not checked' : `${broken} broken link${broken === 1 ? '' : 's'}`}</a> · <a href="#best-practice">${b.failingRules.length} best-practice check${b.failingRules.length === 1 ? '' : 's'} failing</a></div></div></div>
${section('accessibility', `Accessibility violations (WCAG) — ${a.violations}`)}
${l.measured === false
    ? `<h2 id="links">Broken links — not checked <a class="top" href="#top">↑ top</a></h2><p class="muted">No links were checked in this audit${s.linksFound ? ` (${s.linksFound.toLocaleString()} were collected)` : ''}. The Links category is not scored and is not part of the overall health score. Run the audit to completion to check them.</p>`
    : section('links', `Broken links — ${broken} of ${l.checked} checked${l.blocked ? ` (${l.blocked} could not be verified)` : ''}`)}
${section('best-practice', `Best-practice issues — ${b.failingRules.length} checks failing`)}
${section('review', `Needs manual review — ${a.needsReview}`)}
${uxHtml(s)}
${trendHtml(trend, scanId)}
${coverageHtml(s)}
<h2 id="pages">Pages audited — ${(pages.length || s.pagesCrawled).toLocaleString()} <a class="top" href="#top">↑ top</a></h2>
<p class="muted">Every page below was opened in a real browser and had every check run. Depth 0 is the start page.</p>
${pages.length ? `<table><tr><th>Page</th><th>Found via</th><th>Depth</th><th>HTTP</th><th>Load</th><th>Links</th><th>Accessibility</th><th>Best practices</th><th>Issues</th></tr>
${pages.map((p) => `<tr><td>${esc(p.title || shortUrl(p.url))}<br><a class="muted" href="${esc(p.url)}">${esc(p.url)}</a></td><td>${esc(SOURCE_LABEL[p.source || 'link'])}${p.parent_url ? `<br><span class="muted">from ${esc(shortUrl(p.parent_url))}</span>` : ''}</td><td>${p.depth}</td><td>${p.status_code ?? 'ERR'}</td><td>${(p.load_ms / 1000).toFixed(1)}s</td><td>${p.links_found}</td><td>${p.a11y_score}</td><td>${p.bp_score}</td><td>${p.findings_count}</td></tr>`).join('')}
</table>` : `<table><tr><th>Page</th><th>Accessibility</th><th>Best practices</th><th>Issues</th></tr>
${s.worstPages.map((p) => `<tr><td>${esc(p.title || p.url)}<br><span class="muted">${esc(p.url)}</span></td><td>${p.a11yScore}</td><td>${p.bpScore}</td><td>${p.findings}</td></tr>`).join('')}
</table><p class="muted">The full page list could not be loaded; the ${s.worstPages.length} lowest-scoring pages are shown.</p>`}
${s.coverage && s.coverage.notAuditedTotal > 0 ? `<h2 id="not-audited">Pages found but not audited — ${s.coverage.notAuditedTotal.toLocaleString()} <a class="top" href="#top">↑ top</a></h2>
<p class="muted">${esc(stoppedReason(s.coverage))}${s.coverage.notAudited.length < s.coverage.notAuditedTotal ? ` The first ${s.coverage.notAudited.length.toLocaleString()} are listed.` : ''}</p>
<details><summary>Show the list</summary><table><tr><th>Page</th><th>Found via</th><th>Depth</th></tr>
${s.coverage.notAudited.map((p) => `<tr><td><a href="${esc(p.url)}">${esc(p.url)}</a></td><td>${esc(SOURCE_LABEL[p.source])}${p.parentUrl ? `<br><span class="muted">from ${esc(shortUrl(p.parentUrl))}</span>` : ''}</td><td>${p.depth}</td></tr>`).join('')}
</table></details>` : ''}
${s.notes.length ? `<h2 id="notes">Notes <a class="top" href="#top">↑ top</a></h2><ul class="muted">${s.notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul>` : ''}
<div class="foot">Generated by IntelliQE. Accessibility rules by axe-core (Deque). Health score = accessibility 45% · links 30% · best practices 25%.</div>
</body></html>`;
}
