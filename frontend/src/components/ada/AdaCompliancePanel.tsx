/**
 * ADA Compliance / website audit panel.
 *
 * Three screens in one component:
 *   1. form      — the user types a URL (plus optional sign-in), that's all
 *   2. scanning  — a live log of the crawl: every page navigated, links found,
 *                  checks run, problems as they are discovered; can be stopped
 *   3. report    — the issue explorer: a summary pane (issues, pages, severity
 *                  breakdown, needs-review), a grouped issue list, and a detail
 *                  pane for the selected issue — plus the workflow log, the
 *                  page list, and HTML / CSV download. A stopped scan gets the
 *                  same report for the pages it managed to audit.
 *
 * Used inside the Chat wizard (ChatPage) and on the standalone
 * /ada-compliance page. `onBrownfield` hands the crawled site to the existing
 * explore-mode pipeline so requirements and test cases are rebuilt from it.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  startAdaScan, getAdaScan, getAdaFindings, getAdaPages, cancelAdaScan, getAdaTrend, type AdaTrendPoint,
  type AdaCategory, type AdaFinding, type AdaPage, type AdaProgress, type AdaProgressEvent,
  type AdaScanRecord, type AdaSeverity, type AdaSummary, type AdaRemediation, type AdaSiteInventory, type AdaCoverage,
} from '@/services/api';
import {
  Accessibility, Globe, Lock, Unlock, Loader2, CheckCircle2, AlertTriangle, XCircle, Link2Off,
  ShieldCheck, FileSearch, Compass, ChevronDown, ChevronRight, Download, ExternalLink, Search,
  Square, RotateCcw, Sparkles, ListChecks, Map as MapIcon, Bot, Info, Eye, Copy, FileText, Table2,
  MousePointerClick, Wrench, Timer,
} from 'lucide-react';

const EFFORT_STYLE: Record<AdaRemediation['effort'], string> = {
  quick: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  moderate: 'bg-amber-50 text-amber-700 border-amber-200',
  involved: 'bg-red-50 text-red-700 border-red-200',
};
const EFFORT_LABEL: Record<AdaRemediation['effort'], string> = { quick: 'Quick fix', moderate: 'Moderate', involved: 'Involved' };
function remediationOf(f: AdaFinding | null | undefined): AdaRemediation | undefined {
  const r = f?.details?.remediation;
  return r && typeof r === 'object' && Array.isArray((r as AdaRemediation).steps) ? (r as AdaRemediation) : undefined;
}

type Screen = 'form' | 'scanning' | 'results';
type Tab = 'issues' | 'log' | 'coverage' | 'pages';

export interface BrownfieldHandoff { url: string; siteName?: string; username?: string; password?: string }

interface Props {
  /** Open an existing scan straight into results (standalone page). */
  initialScanId?: string;
  /** Called when the user asks to rebuild requirements & test cases from the crawl. */
  onBrownfield?: (ctx: BrownfieldHandoff) => void;
  /** Called when the user clicks "New audit" from results (standalone page resets its list). */
  onReset?: () => void;
  /** Compact layout for the chat column. */
  embedded?: boolean;
}

const SEVERITIES: AdaSeverity[] = ['critical', 'serious', 'moderate', 'minor'];
const SEV_STYLE: Record<AdaSeverity, string> = {
  critical: 'bg-red-100 text-red-700 border-red-200',
  serious: 'bg-orange-100 text-orange-700 border-orange-200',
  moderate: 'bg-amber-100 text-amber-700 border-amber-200',
  minor: 'bg-gray-100 text-gray-600 border-gray-200',
};
const SEV_DOT: Record<AdaSeverity, string> = {
  critical: 'bg-red-500', serious: 'bg-orange-500', moderate: 'bg-amber-400', minor: 'bg-gray-400',
};
const CATEGORY_LABEL: Record<AdaCategory, string> = {
  accessibility: 'Accessibility', links: 'Broken link', 'best-practice': 'Best practice', review: 'Needs review',
};
const GRADE_COLOR: Record<string, string> = {
  A: 'text-emerald-600', B: 'text-green-600', C: 'text-amber-600', D: 'text-orange-600', F: 'text-red-600',
};
const GRADE_RING: Record<string, string> = {
  A: '#059669', B: '#16a34a', C: '#d97706', D: '#ea580c', F: '#dc2626',
};

const EVENT_ICON: Record<AdaProgressEvent['type'], React.ElementType> = {
  start: Globe, robots: FileSearch, sitemap: MapIcon, navigate: Compass, page: CheckCircle2, login: Lock,
  accessibility: Accessibility, 'best-practice': ListChecks, links: Link2Off, 'link-check': XCircle,
  summary: Sparkles, warning: AlertTriangle, error: XCircle, done: CheckCircle2,
};
const EVENT_COLOR: Record<AdaProgressEvent['type'], string> = {
  start: 'text-violet-500', robots: 'text-gray-400', sitemap: 'text-gray-400', navigate: 'text-indigo-500',
  page: 'text-emerald-500', login: 'text-violet-500', accessibility: 'text-blue-500', 'best-practice': 'text-teal-500',
  links: 'text-gray-500', 'link-check': 'text-red-500', summary: 'text-violet-600', warning: 'text-amber-500',
  error: 'text-red-600', done: 'text-emerald-600',
};

const inputCls = 'w-full px-3.5 py-2.5 bg-white border border-gray-200 rounded-lg text-sm text-gray-800 placeholder:text-gray-400 outline-none focus:ring-2 focus:ring-violet-500/20 focus:border-violet-400 transition-all';

function shortUrl(u: string): string {
  try { const x = new URL(u); return (x.pathname === '/' ? x.host : x.pathname) + (x.search || ''); } catch { return u; }
}
function fmtDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}
/** Message from an axios/network error without reaching for `any`. */
function errorMessage(err: unknown, fallback: string): string {
  const e = err as { response?: { status?: number; data?: { error?: string } }; message?: string } | undefined;
  return e?.response?.data?.error || e?.message || fallback;
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

export default function AdaCompliancePanel({ initialScanId, onBrownfield, onReset, embedded }: Props) {
  const [screen, setScreen] = useState<Screen>(initialScanId ? 'results' : 'form');

  // ── form ──
  const [url, setUrl] = useState('');
  const [needsLogin, setNeedsLogin] = useState(false);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [quickSample, setQuickSample] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [checkExternal, setCheckExternal] = useState(true);
  const [formError, setFormError] = useState('');
  /** Id of the audit that is already running for this account (from a 409), so the form can stop or open it. */
  const [blockingScanId, setBlockingScanId] = useState<string | null>(null);
  const [stoppingBlocking, setStoppingBlocking] = useState(false);
  const [starting, setStarting] = useState(false);

  // ── scan ──
  const [scanId, setScanId] = useState<string | null>(initialScanId || null);
  const [scan, setScan] = useState<AdaScanRecord | null>(null);
  const [progress, setProgress] = useState<AdaProgress | null>(null);
  const [events, setEvents] = useState<AdaProgressEvent[]>([]);
  const lastSeq = useRef(0);
  const logRef = useRef<HTMLDivElement>(null);
  const [cancelling, setCancelling] = useState(false);

  // ── report ──
  const [tab, setTab] = useState<Tab>('issues');
  const [findings, setFindings] = useState<AdaFinding[]>([]);
  const [findingsFor, setFindingsFor] = useState<string>('');

  const summary: AdaSummary | null = progress?.summary || scan?.result || null;

  /* ── polling ── */
  useEffect(() => {
    if (!scanId || screen === 'form') return;
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
          if (res.progress.status !== 'running') { setScreen('results'); return; }
        } else if (res.scan.status !== 'running') {
          setScreen('results');
          return;
        }
      } catch (err: unknown) {
        if (errorStatus(err) === 404) { setFormError('This audit no longer exists.'); setScreen('form'); return; }
      }
      timer = setTimeout(tick, 1500);
    };
    tick();
    return () => { stopped = true; if (timer) clearTimeout(timer); };
  }, [scanId, screen]);

  /* ── load every finding once the report is open ── */
  useEffect(() => {
    if (screen !== 'results' || !scanId || !summary || findingsFor === scanId) return;
    let alive = true;
    getAdaFindings(scanId, { limit: 2000 })
      .then((r) => { if (alive) setFindings(r.findings); })
      .catch(() => { if (alive) setFindings([]); })
      .finally(() => { if (alive) setFindingsFor(scanId); });
    return () => { alive = false; };
  }, [screen, scanId, summary, findingsFor]);

  useEffect(() => {
    if (screen === 'scanning' && logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [events, screen]);

  const start = async () => {
    setFormError(''); setBlockingScanId(null);
    if (!url.trim()) { setFormError('Enter the website address to audit.'); return; }
    setStarting(true);
    try {
      const res = await startAdaScan({
        url: url.trim(),
        username: needsLogin && username ? username : undefined,
        password: needsLogin && password ? password : undefined,
        maxPages: quickSample ? 15 : undefined,
        checkExternalLinks: checkExternal,
      });
      lastSeq.current = 0;
      setEvents([]); setProgress(null); setScan(null); setFindings([]); setFindingsFor('');
      setScanId(res.scanId);
      setTab('issues');
      setScreen('scanning');
    } catch (err: unknown) {
      setFormError(errorMessage(err, 'Could not start the audit.'));
      const other = (err as { response?: { data?: { scanId?: string } } } | undefined)?.response?.data?.scanId;
      if (errorStatus(err) === 409 && other) setBlockingScanId(other);
    } finally {
      setStarting(false);
    }
  };

  /** Stop the audit that is blocking a new one, then retry automatically. */
  const stopBlockingAndStart = async () => {
    if (!blockingScanId) return;
    setStoppingBlocking(true);
    try {
      await cancelAdaScan(blockingScanId);
      // The engine needs a moment to finish the current page and persist the partial report.
      for (let i = 0; i < 20; i++) {
        await new Promise((r) => setTimeout(r, 1500));
        const p = await getAdaScan(blockingScanId).catch(() => null);
        if (p && p.scan.status !== 'running') break;
      }
      setBlockingScanId(null); setFormError('');
      await start();
    } catch (err: unknown) {
      setFormError(errorMessage(err, 'Could not stop the running audit.'));
    } finally {
      setStoppingBlocking(false);
    }
  };

  /** Open the audit that is already running instead of starting another. */
  const openBlocking = () => {
    if (!blockingScanId) return;
    lastSeq.current = 0;
    setEvents([]); setProgress(null); setScan(null); setFindings([]); setFindingsFor('');
    setScanId(blockingScanId); setBlockingScanId(null); setFormError('');
    setTab('issues');
    setScreen('scanning');
  };

  const cancel = async () => {
    if (!scanId) return;
    setCancelling(true);
    try { await cancelAdaScan(scanId); } catch { /* the poll will surface the state */ }
  };

  const reset = () => {
    setScanId(null); setScan(null); setProgress(null); setEvents([]); lastSeq.current = 0;
    setFindings([]); setFindingsFor(''); setCancelling(false); setScreen('form'); onReset?.();
  };

  const brownfield = () => {
    const target = summary?.targetUrl || scan?.target_url || url;
    onBrownfield?.({ url: target, siteName: summary?.siteName, username: needsLogin ? username : undefined, password: needsLogin ? password : undefined });
  };

  /* ═════════════════════════════ FORM ═════════════════════════════ */
  if (screen === 'form') {
    return (
      <div className={`${embedded ? 'max-w-lg ml-11' : 'max-w-2xl'} bg-white border border-gray-100 rounded-xl p-5 shadow-sm space-y-4`}>
        <div className="flex items-center gap-2">
          <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-violet-500 to-indigo-600 flex items-center justify-center">
            <Accessibility className="w-4 h-4 text-white" />
          </div>
          <div>
            <p className="text-sm font-semibold text-gray-800">Website audit</p>
            <p className="text-[11px] text-gray-400">Accessibility (WCAG 2.2 AA) · broken links · best practices · health score</p>
          </div>
        </div>

        <div>
          <label className="block text-xs font-medium text-gray-600 mb-1.5">Website address</label>
          <div className="relative">
            <Globe className="w-4 h-4 text-gray-400 absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') start(); }}
              placeholder="www.example.com"
              className={inputCls + ' pl-9'}
              autoFocus
            />
          </div>
          <p className="text-[11px] text-gray-400 mt-1.5">
            That's all that's needed. IntelliQE opens the site in a browser, follows every menu and link, and checks each page it reaches. You can stop at any time and keep the report for the pages done so far.
          </p>
        </div>

        <label className="flex items-center gap-2.5 text-xs text-gray-600 cursor-pointer select-none">
          <input type="checkbox" checked={needsLogin} onChange={(e) => setNeedsLogin(e.target.checked)} className="w-4 h-4 rounded border-gray-300 text-violet-600 focus:ring-violet-500" />
          {needsLogin ? <Lock className="w-3.5 h-3.5 text-violet-500" /> : <Unlock className="w-3.5 h-3.5 text-gray-400" />}
          The site needs a sign-in to see everything
        </label>
        {needsLogin && (
          <div className="grid grid-cols-2 gap-2 pl-6">
            <input value={username} onChange={(e) => setUsername(e.target.value)} placeholder="Username or email" className={inputCls} autoComplete="off" />
            <input value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Password" type="password" className={inputCls} autoComplete="new-password" />
            <p className="col-span-2 text-[11px] text-gray-400">Used once, for this audit only. If the first page is a sign-in form, IntelliQE signs in and audits the pages behind it; otherwise it audits the public pages.</p>
          </div>
        )}

        <button onClick={() => setShowAdvanced((v) => !v)} className="text-[11px] text-violet-500 hover:text-violet-700 flex items-center gap-1">
          {showAdvanced ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />} Scan options
        </button>
        {showAdvanced && (
          <div className="space-y-2 pl-1">
            <div className="grid grid-cols-2 gap-2">
              <button type="button" onClick={() => setQuickSample(false)} className={`text-left rounded-lg border px-3 py-2 transition-colors ${!quickSample ? 'border-violet-400 bg-violet-50/60' : 'border-gray-200 hover:border-gray-300'}`}>
                <p className="text-xs font-semibold text-gray-800">Whole website <span className="text-[10px] font-normal text-violet-600">recommended</span></p>
                <p className="text-[11px] text-gray-500 mt-0.5">IntelliQE finds every page itself from the menus, links and sitemap. The page count shows live while it scans.</p>
              </button>
              <button type="button" onClick={() => setQuickSample(true)} className={`text-left rounded-lg border px-3 py-2 transition-colors ${quickSample ? 'border-violet-400 bg-violet-50/60' : 'border-gray-200 hover:border-gray-300'}`}>
                <p className="text-xs font-semibold text-gray-800">Quick sample</p>
                <p className="text-[11px] text-gray-500 mt-0.5">First 15 pages only, for a fast first impression (~3 min).</p>
              </button>
            </div>
            <label className="flex items-center gap-2 text-[11px] text-gray-600 cursor-pointer">
              <input type="checkbox" checked={checkExternal} onChange={(e) => setCheckExternal(e.target.checked)} className="w-4 h-4 rounded border-gray-300 text-violet-600" />
              Also check links to other websites
            </label>
            <p className="text-[11px] text-gray-400">You can stop at any time — the report always covers the pages audited so far.</p>
          </div>
        )}

        {formError && (
          <div className="text-xs text-red-600 bg-red-50 border border-red-100 rounded-lg px-3 py-2 flex flex-wrap items-center gap-2">
            <span className="flex-1 min-w-[12rem]">{formError}</span>
            {blockingScanId && (
              <span className="flex items-center gap-2">
                <button type="button" onClick={openBlocking} disabled={stoppingBlocking} className="px-2.5 py-1 rounded-md border border-red-200 bg-white text-red-700 hover:bg-red-100 disabled:opacity-50">View progress</button>
                <button type="button" onClick={stopBlockingAndStart} disabled={stoppingBlocking} className="px-2.5 py-1 rounded-md bg-red-600 text-white hover:bg-red-500 disabled:opacity-50 flex items-center gap-1.5" title="Stop the running audit (its partial report is kept) and start this one">
                  {stoppingBlocking ? <Loader2 className="w-3 h-3 animate-spin" /> : <Square className="w-3 h-3 fill-current" />} {stoppingBlocking ? 'Stopping…' : 'Stop it & start this audit'}
                </button>
              </span>
            )}
          </div>
        )}

        <button
          onClick={start}
          disabled={starting || !url.trim()}
          className="w-full py-2.5 bg-gradient-to-r from-violet-600 to-indigo-600 hover:from-violet-500 hover:to-indigo-500 disabled:opacity-40 text-white text-sm font-medium rounded-lg transition-all flex items-center justify-center gap-2"
        >
          {starting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Search className="w-4 h-4" />}
          {starting ? 'Starting…' : 'Audit this website'}
        </button>
      </div>
    );
  }

  /* ═════════════════════════════ SCANNING ═════════════════════════════ */
  if (screen === 'scanning') {
    const c = progress?.counters;
    // Progress is measured against pages found so far; the total grows as new links are discovered.
    const target = c ? Math.min(c.maxPages, Math.max(c.discovered || 0, c.pages, 1)) : 1;
    const pct = c ? Math.min(100, Math.round((c.pages / target) * 100)) : 0;
    const linkPhase = !!c && c.linksFound > 0 && c.linksChecked > 0;
    return (
      <div className={`${embedded ? 'max-w-2xl ml-11' : 'max-w-4xl'} bg-white border border-gray-100 rounded-xl shadow-sm overflow-hidden`}>
        <div className="px-5 py-4 border-b border-gray-100 bg-gradient-to-r from-violet-50/60 to-indigo-50/40">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="text-xs text-gray-500 flex items-center gap-1.5"><Loader2 className="w-3.5 h-3.5 animate-spin text-violet-500" /> {linkPhase ? 'Checking links' : 'Auditing pages'}</p>
              <p className="text-sm font-semibold text-gray-800 truncate">{scan?.target_url || url}</p>
              <p className="text-[11px] text-gray-500 mt-0.5 truncate">
                {c?.currentUrl ? <>Now on <span className="font-mono text-gray-700">{shortUrl(c.currentUrl)}</span></> : 'Opening the site…'}
              </p>
            </div>
            <button onClick={cancel} disabled={cancelling} className="flex-shrink-0 text-xs text-gray-600 hover:text-red-600 border border-gray-200 hover:border-red-200 bg-white rounded-lg px-2.5 py-1.5 flex items-center gap-1.5 transition-colors disabled:opacity-50" title="Stop now and keep the report for the pages audited so far">
              <Square className="w-3 h-3 fill-current" /> {cancelling ? 'Stopping…' : 'Stop & report'}
            </button>
          </div>
          <div className="mt-3 h-1.5 bg-gray-100 rounded-full overflow-hidden">
            <div className="h-full bg-gradient-to-r from-violet-500 to-indigo-500 transition-all duration-700" style={{ width: `${linkPhase ? 100 : pct}%` }} />
          </div>
          {progress?.inventory && <InventoryLine inv={progress.inventory} className="mt-3" />}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mt-3">
            <Stat label="Pages audited" value={c ? c.pages : '—'} sub={c ? `of ${Math.max(c.discovered || 0, c.pages).toLocaleString()} found` : undefined} title="Audited = opened in the browser with every check finished. Found = start page + sitemap pages in scope + pages linked from audited pages." />
            <Stat label="Links found" value={c?.linksFound ?? '—'} sub={c && c.linksFound ? `${(c.linksInternal || 0).toLocaleString()} internal · ${(c.linksExternal || 0).toLocaleString()} external` : undefined} title="Unique links seen on the pages audited so far." />
            <Stat label="Links checked" value={c?.linksChecked ?? '—'} />
            <Stat label="Issues so far" value={c?.issues ?? '—'} tone={c?.issues ? 'warn' : undefined} />
          </div>
        </div>
        <div ref={logRef} className="h-72 overflow-y-auto px-4 py-3 space-y-1 bg-gray-50/50 font-mono text-[11px]">
          {events.length === 0 && <p className="text-gray-400">Starting the browser…</p>}
          {events.map((e) => <LogLine key={e.seq} e={e} />)}
        </div>
        <p className="px-5 py-2 text-[11px] text-gray-400 border-t border-gray-100">
          {progress ? `${fmtDuration(progress.elapsedMs)} elapsed` : ''} · Every page is opened in a real browser and checked for accessibility, broken links and best practices. Stop at any point — the report covers whatever has been audited.
        </p>
      </div>
    );
  }

  /* ═════════════════════════════ REPORT ═════════════════════════════ */
  if (!summary) {
    return (
      <div className={`${embedded ? 'max-w-2xl ml-11' : 'max-w-4xl'} bg-white border border-gray-100 rounded-xl p-5 shadow-sm`}>
        {scan?.status === 'failed' ? (
          <>
            <p className="text-sm font-semibold text-red-700 flex items-center gap-2"><XCircle className="w-4 h-4" /> The audit could not be completed</p>
            <p className="text-xs text-gray-600 mt-1">{scan.error || progress?.error || 'Unknown error'}</p>
          </>
        ) : (
          <p className="text-sm text-gray-500 flex items-center gap-2"><Loader2 className="w-4 h-4 animate-spin" /> Loading report…</p>
        )}
        <button onClick={reset} className="mt-3 text-xs text-violet-600 hover:text-violet-800 flex items-center gap-1"><RotateCcw className="w-3 h-3" /> Start another audit</button>
      </div>
    );
  }

  const partial = scan?.status === 'cancelled' || progress?.status === 'cancelled';
  const logEvents = events.length ? events : (scan?.log || []);
  const findingsLoading = findingsFor !== scanId;

  return (
    <div className={`${embedded ? 'max-w-3xl ml-11' : 'max-w-6xl'} space-y-3`}>
      <ReportHeader
        scanId={scanId}
        summary={summary}
        partial={partial}
        findings={findings}
        onReset={reset}
        onBrownfield={onBrownfield ? brownfield : undefined}
      />
      <div className="bg-white border border-gray-100 rounded-xl shadow-sm">
        <div className="flex gap-1 px-2 pt-2 border-b border-gray-100 overflow-x-auto">
          {([
            ['issues', 'Issue summary', Accessibility],
            ['log', 'Workflow log', ListChecks],
            ['coverage', 'Coverage', MapIcon],
            ['pages', 'Pages', Compass],
          ] as [Tab, string, React.ElementType][]).map(([key, label, Icon]) => (
            <button
              key={key}
              onClick={() => setTab(key)}
              className={`px-3 py-2 text-xs font-medium rounded-t-lg border-b-2 -mb-px whitespace-nowrap flex items-center gap-1.5 transition-colors ${tab === key ? 'border-violet-500 text-violet-700 bg-violet-50/50' : 'border-transparent text-gray-500 hover:text-gray-700'}`}
            >
              <Icon className="w-3.5 h-3.5" /> {label}
              {key === 'pages' && <span className="px-1.5 py-0.5 rounded-full text-[10px] bg-gray-100 text-gray-500">{summary.pagesCrawled}</span>}
            </button>
          ))}
        </div>
        {tab === 'issues' && (findingsLoading
          ? <p className="p-5 text-xs text-gray-400 flex items-center gap-2"><Loader2 className="w-3.5 h-3.5 animate-spin" /> Loading issues…</p>
          : <IssueExplorer findings={findings} summary={summary} embedded={!!embedded} />)}
        {tab === 'log' && <WorkflowLog events={logEvents} summary={summary} partial={partial} />}
        {tab === 'coverage' && <CoverageView summary={summary} />}
        {tab === 'pages' && scanId && <PagesTable scanId={scanId} />}
      </div>
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

function ScoreRing({ score, grade, size = 84 }: { score: number; grade: string; size?: number }) {
  const r = (size - 10) / 2;
  const circ = 2 * Math.PI * r;
  const dash = (score / 100) * circ;
  return (
    <div className="relative flex-shrink-0" style={{ width: size, height: size }}>
      <svg width={size} height={size} className="-rotate-90">
        <circle cx={size / 2} cy={size / 2} r={r} stroke="#E5E7EB" strokeWidth="8" fill="none" />
        <circle cx={size / 2} cy={size / 2} r={r} stroke={GRADE_RING[grade]} strokeWidth="8" fill="none" strokeLinecap="round" strokeDasharray={`${dash} ${circ - dash}`} />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <p className={`font-bold leading-none ${GRADE_COLOR[grade]}`} style={{ fontSize: size / 3.2 }}>{score}</p>
        <p className="text-[10px] text-gray-400 mt-0.5">Health · {grade}</p>
      </div>
    </div>
  );
}

function SevChip({ s, count, active, onClick }: { s: AdaSeverity; count: number; active?: boolean; onClick?: () => void }) {
  return (
    <button
      onClick={onClick}
      className={`inline-flex items-center gap-1.5 px-2 py-1 rounded-full border text-[11px] font-medium transition-all ${active ? 'ring-2 ring-violet-400 ring-offset-1' : ''} ${SEV_STYLE[s]} ${onClick ? 'hover:brightness-95' : ''}`}
    >
      <span className={`w-2 h-2 rounded-full ${SEV_DOT[s]}`} /> {count} {s.charAt(0).toUpperCase() + s.slice(1)}
    </button>
  );
}

/* ───────────────────────────── report header ───────────────────────────── */

function ReportHeader({ scanId, summary, partial, findings, onReset, onBrownfield }: {
  scanId: string | null; summary: AdaSummary; partial: boolean; findings: AdaFinding[]; onReset: () => void; onBrownfield?: () => void;
}) {
  const [menu, setMenu] = useState(false);
  const a = summary.categories.accessibility;
  const l = summary.categories.links;
  const brokenTotal = l.broken + l.serverErrors + l.timeouts;
  const dl = async (kind: 'html' | 'csv' | 'pages') => {
    setMenu(false);
    const base = `website-audit-${safeName(summary.siteName)}-${summary.finishedAt.slice(0, 10)}`;
    if (kind === 'csv') { downloadBlob(buildCsv(findings), `${base}-issues.csv`, 'text/csv'); return; }
    // The page list is stored per page in the database; fetch it so the download names every page visited.
    const pages = scanId ? await getAdaPages(scanId).catch(() => [] as AdaPage[]) : [];
    const trend = kind === 'html' ? await getAdaTrend(summary.targetUrl).then((r) => r.points).catch(() => [] as AdaTrendPoint[]) : [];
    if (kind === 'html') downloadBlob(buildHtmlReport(summary, partial, findings, pages, trend, scanId), `${base}.html`, 'text/html');
    else downloadBlob(buildPagesCsv(pages, summary.coverage), `${base}-pages.csv`, 'text/csv');
  };
  return (
    <div className="bg-white border border-gray-100 rounded-xl shadow-sm p-4">
      <div className="flex flex-wrap items-center gap-4">
        <ScoreRing score={summary.overall.score} grade={summary.overall.grade} />
        <div className="flex-1 min-w-[220px]">
          <div className="flex items-center gap-2 flex-wrap">
            <p className="text-[11px] uppercase tracking-wide text-gray-400">Website audit report</p>
            {partial
              ? <span className="px-2 py-0.5 rounded-full bg-amber-50 text-amber-700 border border-amber-200 text-[10px] font-semibold">STOPPED EARLY — PARTIAL</span>
              : <span className="px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-700 border border-emerald-200 text-[10px] font-semibold">COMPLETE</span>}
            <span className="px-2 py-0.5 rounded-full bg-violet-50 text-violet-700 border border-violet-200 text-[10px] font-semibold">WCAG 2.2 AA</span>
          </div>
          <p className="text-base font-semibold text-gray-800 leading-tight mt-0.5">{summary.siteName || summary.targetUrl}</p>
          <a href={summary.targetUrl} target="_blank" rel="noopener noreferrer" className="text-[11px] text-violet-600 hover:underline inline-flex items-center gap-1 break-all">{summary.targetUrl} <ExternalLink className="w-3 h-3" /></a>
          {summary.inventory && summary.inventory.sitemapUrls > 0 && <InventoryLine inv={summary.inventory} className="mt-2" />}
          <p className="text-xs text-gray-500 mt-1">
            {summary.pagesCrawled} page{summary.pagesCrawled === 1 ? '' : 's'} audited{(summary.pagesDiscovered || 0) > summary.pagesCrawled ? ` of ${summary.pagesDiscovered} found` : ''} · {summary.linksChecked} links checked · {a.violations} accessibility violation{a.violations === 1 ? '' : 's'} · {brokenTotal} broken link{brokenTotal === 1 ? '' : 's'} · {summary.categories.bestPractice.failingRules.length} best-practice checks failing · {fmtDuration(summary.durationMs)}
          </p>
          <TrendStrip scanId={scanId} summary={summary} />
          {summary.loginAttempted && (
            <p className="text-[11px] text-gray-500 mt-1 flex items-center gap-1">
              {summary.loginSucceeded ? <Lock className="w-3 h-3 text-emerald-500" /> : <Unlock className="w-3 h-3 text-amber-500" />}
              {summary.loginSucceeded ? 'Signed in — audited the authenticated site.' : 'Sign-in did not succeed — public pages only.'}
            </p>
          )}
        </div>
        <div className="grid grid-cols-3 gap-2">
          <MiniScore label="Accessibility" cat={summary.categories.accessibility} Icon={Accessibility} />
          <MiniScore label="Links" cat={summary.categories.links} Icon={Link2Off} />
          <MiniScore label="Practices" cat={summary.categories.bestPractice} Icon={ShieldCheck} />
        </div>
      </div>
      <div className="flex flex-wrap gap-2 mt-3 pt-3 border-t border-gray-100 relative">
        <div className="relative">
          <button onClick={() => setMenu((v) => !v)} className="text-xs px-3 py-2 bg-gray-100 hover:bg-gray-200 text-gray-700 rounded-lg flex items-center gap-1.5 transition-colors">
            <Download className="w-3.5 h-3.5" /> Download report <ChevronDown className="w-3 h-3" />
          </button>
          {menu && (
            <div className="absolute z-10 mt-1 w-56 bg-white border border-gray-200 rounded-lg shadow-lg overflow-hidden">
              <button onClick={() => dl('html')} className="w-full text-left px-3 py-2 text-xs hover:bg-violet-50 flex items-center gap-2"><FileText className="w-3.5 h-3.5 text-violet-500" /> Full report (HTML)</button>
              <button onClick={() => dl('csv')} className="w-full text-left px-3 py-2 text-xs hover:bg-violet-50 flex items-center gap-2"><Table2 className="w-3.5 h-3.5 text-emerald-600" /> All issues (CSV / Excel)</button>
              <button onClick={() => dl('pages')} className="w-full text-left px-3 py-2 text-xs hover:bg-violet-50 flex items-center gap-2"><Compass className="w-3.5 h-3.5 text-indigo-500" /> Pages visited &amp; not visited (CSV)</button>
            </div>
          )}
        </div>
        {onBrownfield && (
          <button onClick={onBrownfield} className="text-xs px-3 py-2 bg-gradient-to-r from-violet-600 to-indigo-600 hover:from-violet-500 hover:to-indigo-500 text-white rounded-lg flex items-center gap-1.5 transition-all">
            <Bot className="w-3.5 h-3.5" /> Rebuild requirements &amp; generate test cases from this site
          </button>
        )}
        <button onClick={onReset} className="text-xs px-3 py-2 text-gray-500 hover:text-gray-800 flex items-center gap-1.5 ml-auto"><RotateCcw className="w-3.5 h-3.5" /> New audit</button>
      </div>
    </div>
  );
}

function MiniScore({ label, cat, Icon }: { label: string; cat: { score: number; grade: string }; Icon: React.ElementType }) {
  return (
    <div className="text-center bg-gray-50/70 border border-gray-100 rounded-lg px-3 py-2 min-w-[84px]">
      <Icon className="w-4 h-4 text-gray-400 mx-auto" />
      <p className={`text-lg font-bold leading-tight ${GRADE_COLOR[cat.grade]}`}>{cat.score}</p>
      <p className="text-[10px] text-gray-500">{label}</p>
    </div>
  );
}

/* ───────────────────────────── issue explorer ───────────────────────────── */

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

function IssueExplorer({ findings, summary, embedded }: { findings: AdaFinding[]; summary: AdaSummary; embedded: boolean }) {
  const [sev, setSev] = useState<AdaSeverity | ''>('');
  const [cat, setCat] = useState<AdaCategory | 'all'>('all');
  const [q, setQ] = useState('');
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<AdaFinding | null>(null);

  // Totals are over the whole report, not the current filter, so the summary
  // pane always reads the same regardless of what the user is looking at.
  const totals = useMemo(() => {
    const issues = findings.filter((f) => f.category !== 'review');
    const bySeverity: Record<AdaSeverity, number> = { critical: 0, serious: 0, moderate: 0, minor: 0 };
    for (const f of issues) bySeverity[f.severity] += f.occurrences;
    const byCat: Record<AdaCategory, number> = { accessibility: 0, links: 0, 'best-practice': 0, review: 0 };
    for (const f of findings) byCat[f.category] += f.occurrences;
    return {
      issues: issues.reduce((a, f) => a + f.occurrences, 0),
      review: byCat.review,
      pages: new Set(issues.map((f) => f.page_url)).size,
      components: new Set(findings.filter((f) => f.element).map((f) => f.element)).size,
      bySeverity, byCat,
    };
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
    return [...m.values()].sort((x, y) => SEV_ORDER[x.severity] - SEV_ORDER[y.severity] || y.occurrences - x.occurrences);
  }, [findings, cat, sev, q]);

  const shown = groups.reduce((a, g) => a + g.occurrences, 0);
  const shownPages = new Set(groups.flatMap((g) => g.rows.map((r) => r.page_url))).size;
  const toggle = (key: string) => setOpen((prev) => { const n = new Set(prev); if (n.has(key)) n.delete(key); else n.add(key); return n; });

  const summaryPane = (
    <div className={`${embedded ? 'grid grid-cols-2 gap-3' : 'space-y-4'}`}>
      <div>
        <p className="text-4xl font-bold text-gray-800 leading-none">{totals.issues}</p>
        <p className="text-xs text-gray-600 mt-1">Issues in {totals.pages} page{totals.pages === 1 ? '' : 's'} and {totals.components} component{totals.components === 1 ? '' : 's'}</p>
        <div className="flex flex-wrap gap-1.5 mt-2">
          <span className="px-2 py-0.5 rounded border border-gray-200 text-[10px] text-gray-600 font-medium">WCAG 2.2 AA</span>
          <span className={`px-2 py-0.5 rounded border border-gray-200 text-[10px] font-medium ${GRADE_COLOR[summary.overall.grade]}`}>Health {summary.overall.score}/100</span>
        </div>
      </div>
      <div>
        <p className="text-[11px] font-semibold text-gray-500 uppercase tracking-wide mb-1.5">Severity breakdown</p>
        <div className="flex flex-wrap gap-1.5">
          {SEVERITIES.map((s) => <SevChip key={s} s={s} count={totals.bySeverity[s]} active={sev === s} onClick={() => setSev(sev === s ? '' : s)} />)}
        </div>
      </div>
      <div>
        <p className="text-[11px] font-semibold text-gray-500 uppercase tracking-wide mb-1.5">Category</p>
        <div className="flex flex-wrap gap-1.5">
          {([['all', 'All issues', totals.issues], ['accessibility', 'Accessibility', totals.byCat.accessibility], ['links', 'Broken links', totals.byCat.links], ['best-practice', 'Best practices', totals.byCat['best-practice']]] as [AdaCategory | 'all', string, number][]).map(([k, label, n]) => (
            <button key={k} onClick={() => setCat(k)} className={`px-2 py-1 rounded-full border text-[11px] font-medium transition-colors ${cat === k ? 'bg-violet-600 border-violet-600 text-white' : 'bg-white border-gray-200 text-gray-600 hover:border-violet-300'}`}>{label} <span className={cat === k ? 'text-violet-100' : 'text-gray-400'}>{n}</span></button>
          ))}
        </div>
      </div>
      <div className={`rounded-lg border px-3 py-2 ${totals.review > 0 ? 'bg-amber-50 border-amber-200' : 'bg-gray-50 border-gray-100'} ${embedded ? 'col-span-2' : ''}`}>
        <p className="text-xs text-gray-700 flex items-center gap-1.5"><Eye className={`w-3.5 h-3.5 ${totals.review > 0 ? 'text-amber-500' : 'text-gray-400'}`} /> {totals.review} issue{totals.review === 1 ? '' : 's'} need review</p>
        <p className="text-[10px] text-gray-500 mt-0.5">Checks the scanner could not settle by itself — a person has to confirm.</p>
        {totals.review > 0 && <button onClick={() => { setCat('review'); setSev(''); }} className={`text-[11px] font-medium mt-1 ${cat === 'review' ? 'text-violet-700' : 'text-amber-700 hover:underline'}`}>Review all →</button>}
      </div>
    </div>
  );

  const listPane = (
    <div className="flex flex-col min-h-0">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-gray-100">
        <p className="text-xs text-gray-600 whitespace-nowrap">Showing <span className="font-semibold text-gray-800">{shown}</span> {cat === 'review' ? 'items to review' : 'issues'} in {shownPages} page{shownPages === 1 ? '' : 's'}</p>
        <div className="relative flex-1 min-w-[120px]">
          <Search className="w-3.5 h-3.5 text-gray-400 absolute left-2.5 top-1/2 -translate-y-1/2" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter issues" className={inputCls + ' !py-1.5 pl-8 text-xs'} />
        </div>
      </div>
      <div className={`${embedded ? 'max-h-[420px]' : 'max-h-[560px]'} overflow-y-auto divide-y divide-gray-100`}>
        {groups.length === 0 && (
          <p className="px-4 py-6 text-xs text-emerald-700 flex items-center gap-2"><CheckCircle2 className="w-4 h-4" /> Nothing matches — {findings.length === 0 ? 'no issues were found.' : 'try clearing a filter.'}</p>
        )}
        {groups.map((g) => {
          const isOpen = open.has(g.key);
          return (
            <div key={g.key}>
              <button onClick={() => toggle(g.key)} className={`w-full text-left px-3 py-2.5 flex items-center gap-2 hover:bg-gray-50 ${isOpen ? 'bg-violet-50/40' : ''}`}>
                <span className="flex-1 min-w-0">
                  <span className="text-xs text-gray-800">{g.title} <span className="font-semibold">({g.occurrences})</span></span>
                  <span className="block text-[10px] text-gray-400">{CATEGORY_LABEL[g.category]} · {g.pages} page{g.pages === 1 ? '' : 's'}{g.wcag ? ` · WCAG ${g.wcag}` : ''}</span>
                </span>
                {remediationOf(g.rows[0]) && <span className={`px-1.5 py-0.5 rounded border text-[10px] flex-shrink-0 hidden sm:inline ${EFFORT_STYLE[remediationOf(g.rows[0])!.effort]}`}>{EFFORT_LABEL[remediationOf(g.rows[0])!.effort]}</span>}
                <span className={`px-2 py-0.5 rounded border text-[10px] font-medium flex-shrink-0 ${SEV_STYLE[g.severity]}`}>{g.severity.charAt(0).toUpperCase() + g.severity.slice(1)}</span>
                {isOpen ? <ChevronDown className="w-3.5 h-3.5 text-gray-400 flex-shrink-0" /> : <ChevronRight className="w-3.5 h-3.5 text-gray-400 flex-shrink-0" />}
              </button>
              {isOpen && (
                <div className="bg-gray-50/70 border-t border-gray-100">
                  {g.rows.slice(0, 80).map((f) => {
                    const active = selected?.id === f.id;
                    return (
                      <button key={f.id} onClick={() => setSelected(f)} className={`w-full text-left px-4 py-1.5 pl-6 flex items-start gap-2 text-[11px] border-l-2 ${active ? 'border-violet-500 bg-violet-50' : 'border-transparent hover:bg-white'}`}>
                        <MousePointerClick className={`w-3 h-3 mt-[2px] flex-shrink-0 ${active ? 'text-violet-500' : 'text-gray-300'}`} />
                        <span className="min-w-0">
                          <span className="block text-gray-700 truncate">{g.category === 'links' ? String(f.details?.link || f.element || '') : shortUrl(f.page_url)}</span>
                          <span className="block text-gray-400 font-mono truncate">{g.category === 'links' ? `on ${shortUrl(f.page_url)}` : (f.element || f.description || '')}</span>
                        </span>
                        {f.occurrences > 1 && <span className="ml-auto text-gray-400 flex-shrink-0">×{f.occurrences}</span>}
                      </button>
                    );
                  })}
                  {g.rows.length > 80 && <p className="px-6 py-1.5 text-[11px] text-gray-400">…and {g.rows.length - 80} more instances (all included in the CSV).</p>}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );

  const detailPane = <IssueDetail finding={selected} />;

  if (embedded) {
    return (
      <div className="p-4 space-y-3">
        {summaryPane}
        <div className="border border-gray-100 rounded-lg overflow-hidden">{listPane}</div>
        <div className="border border-gray-100 rounded-lg">{detailPane}</div>
      </div>
    );
  }
  // Three panes side by side on wide screens; the detail pane drops below the
  // list on laptops so the issue list is never squeezed to a sliver.
  return (
    <div className="grid grid-cols-1 lg:grid-cols-[220px_minmax(0,1fr)] xl:grid-cols-[240px_minmax(0,1fr)_340px] lg:divide-x divide-gray-100">
      <div className="p-4 border-b lg:border-b-0 border-gray-100">{summaryPane}</div>
      <div className="min-w-0">{listPane}</div>
      <div className="min-h-[220px] lg:col-span-2 xl:col-span-1 border-t xl:border-t-0 border-gray-100">{detailPane}</div>
    </div>
  );
}

function IssueDetail({ finding }: { finding: AdaFinding | null }) {
  const [copied, setCopied] = useState(false);
  const rem = remediationOf(finding);
  if (!finding) {
    return (
      <div className="h-full flex flex-col items-center justify-center text-center p-6 text-gray-400">
        <MousePointerClick className="w-8 h-8 mb-2 text-gray-300" />
        <p className="text-xs">Select an issue to view details</p>
        <p className="text-[10px] mt-1">Expand a rule on the left, then pick an instance.</p>
      </div>
    );
  }
  const d = finding.details || {};
  const isLink = finding.category === 'links';
  const copy = (text: string) => { navigator.clipboard?.writeText(text).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1200); }); };
  return (
    <div className="p-4 space-y-3 text-xs">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className={`px-2 py-0.5 rounded border text-[10px] font-medium ${SEV_STYLE[finding.severity]}`}>{finding.severity}</span>
        <span className="px-2 py-0.5 rounded border border-gray-200 text-[10px] text-gray-600">{CATEGORY_LABEL[finding.category]}</span>
        {finding.wcag && <span className="px-2 py-0.5 rounded border border-violet-200 bg-violet-50 text-[10px] text-violet-700">WCAG {finding.wcag}</span>}
      </div>
      <p className="text-sm font-semibold text-gray-800 leading-snug">{finding.title}</p>
      {rem ? (
        <div className="space-y-3 rounded-lg border border-violet-100 bg-violet-50/40 p-3">
          <div>
            <p className="text-[10px] uppercase tracking-wide text-red-500 font-semibold flex items-center gap-1"><AlertTriangle className="w-3 h-3" /> Problem</p>
            <p className="text-gray-800 mt-0.5">{rem.problem}</p>
            {rem.impact && <p className="text-gray-500 mt-1">{rem.impact}</p>}
          </div>
          <div>
            <p className="text-[10px] uppercase tracking-wide text-emerald-600 font-semibold flex items-center gap-1"><Wrench className="w-3 h-3" /> How to fix <span className={`ml-auto normal-case tracking-normal px-1.5 py-0.5 rounded border font-medium ${EFFORT_STYLE[rem.effort]}`}><Timer className="w-3 h-3 inline mr-0.5" />{EFFORT_LABEL[rem.effort]}</span></p>
            <ol className="list-decimal pl-4 mt-1 space-y-0.5 text-gray-700">{rem.steps.map((s, i) => <li key={i}>{s}</li>)}</ol>
          </div>
          {rem.example && (
            <div>
              <p className="text-[10px] uppercase tracking-wide text-gray-500 font-semibold">Example</p>
              <p className="text-[10px] text-gray-400 mt-1">Before</p>
              <pre className="font-mono text-[10.5px] text-red-800 bg-red-50 border border-red-100 rounded px-2 py-1.5 whitespace-pre-wrap break-all max-h-32 overflow-auto">{rem.example.before}</pre>
              <p className="text-[10px] text-gray-400 mt-1.5">After</p>
              <pre className="font-mono text-[10.5px] text-emerald-800 bg-emerald-50 border border-emerald-100 rounded px-2 py-1.5 whitespace-pre-wrap break-all max-h-32 overflow-auto">{rem.example.after}</pre>
              {rem.example.note && <p className="text-[10px] text-gray-500 mt-1">{rem.example.note}</p>}
            </div>
          )}
        </div>
      ) : finding.description && <p className="text-gray-600">{finding.description}</p>}
      {finding.category === 'review' && (
        <p className="text-amber-700 bg-amber-50 border border-amber-100 rounded px-2.5 py-1.5 text-[11px]">The scanner could not decide this one automatically. Open the page and confirm whether it is a real problem.</p>
      )}
      {finding.help_url && <a href={finding.help_url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-[11px] text-gray-400 hover:text-violet-600 hover:underline">Reference: full rule description <ExternalLink className="w-3 h-3" /></a>}

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
        <Field label="Element" action={<button onClick={() => copy(finding.element!)} className="text-[10px] text-gray-400 hover:text-violet-600 flex items-center gap-1"><Copy className="w-3 h-3" /> {copied ? 'Copied' : 'Copy selector'}</button>}>
          <code className="block font-mono text-[11px] text-violet-700 bg-violet-50/60 rounded px-2 py-1 break-all">{finding.element}</code>
        </Field>
      )}
      {finding.html_snippet && (
        <Field label="HTML">
          <pre className="font-mono text-[10.5px] text-gray-700 bg-gray-50 border border-gray-100 rounded px-2 py-1.5 whitespace-pre-wrap break-all max-h-40 overflow-auto">{finding.html_snippet}</pre>
        </Field>
      )}
      {!rem && typeof d.failureSummary === 'string' && d.failureSummary && (
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
        <span><span className="font-semibold text-gray-800">{summary.pagesCrawled}</span> pages audited{(summary.pagesDiscovered || 0) > summary.pagesCrawled ? <span className="text-gray-400"> of {summary.pagesDiscovered} found</span> : null}</span>
        <span><span className="font-semibold text-gray-800">{summary.linksChecked}</span> links checked</span>
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

function Delta({ value, lowerIsBetter }: { value: number | null; lowerIsBetter?: boolean }) {
  if (value === null) return <span className="text-gray-400">n/a</span>;
  if (value === 0) return <span className="text-gray-500">±0</span>;
  const good = lowerIsBetter ? value < 0 : value > 0;
  return <span className={`font-semibold ${good ? 'text-emerald-600' : 'text-red-600'}`}>{value > 0 ? '+' : ''}{value}</span>;
}

/** Score of the last audits of this site plus the delta against the previous run. */
function TrendStrip({ scanId, summary }: { scanId: string | null; summary: AdaSummary }) {
  const [points, setPoints] = useState<AdaTrendPoint[] | null>(null);
  useEffect(() => {
    let alive = true;
    getAdaTrend(summary.targetUrl).then((r) => { if (alive) setPoints(r.points); }).catch(() => { if (alive) setPoints([]); });
    return () => { alive = false; };
  }, [summary.targetUrl, scanId]);
  const pos = points ? trendPosition(points, scanId) : null;
  if (!points || !pos) return null;
  const { cur, prev, index } = pos;
  const shown = points.slice(Math.max(0, index - 11), index + 1);
  const d = (a: number | null, b: number | null) => a === null || b === null ? null : a - b;
  return (
    <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px]">
      {shown.length > 1 && (
        <div className="flex items-end gap-[3px] h-7" aria-label="Health score of the last audits of this site, oldest to newest">
          {shown.map((p) => (
            <div
              key={p.id}
              className={`w-2 rounded-t-[2px] ${sameId(p.id, cur.id) ? 'bg-violet-600' : 'bg-violet-300'}`}
              style={{ height: `${Math.max(3, Math.round(((p.score ?? 0) / 100) * 28))}px` }}
              title={`${new Date(p.finishedAt).toLocaleString()} · score ${p.score ?? '—'} · ${p.issues} issues · ${p.pagesAudited} pages${p.status === 'cancelled' ? ' · stopped early' : ''}${p.createdBy === 'schedule' ? ' · scheduled' : ''}`}
            />
          ))}
        </div>
      )}
      {prev ? (
        <span className="text-gray-600">
          vs previous audit ({new Date(prev.finishedAt).toLocaleDateString()}{prev.createdBy === 'schedule' ? ', scheduled' : ''}):
          {' '}score <Delta value={d(cur.score, prev.score)} />
          {' · '}issues <Delta value={d(cur.issues, prev.issues)} lowerIsBetter />
          {' · '}violations <Delta value={d(cur.violations, prev.violations)} lowerIsBetter />
          {' · '}broken links <Delta value={d(cur.brokenLinks, prev.brokenLinks)} lowerIsBetter />
          {cur.pagesAudited !== prev.pagesAudited && <span className="text-gray-400"> · {cur.pagesAudited} pages audited vs {prev.pagesAudited} — counts are not like-for-like</span>}
        </span>
      ) : (
        <span className="text-gray-400">First audit of this site. Add a recurring audit on the ADA Compliance page to track the trend.</span>
      )}
    </div>
  );
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
  const score = (c: { score: number; grade: string }, label: string, anchor?: string) =>
    `<${anchor ? `a href="#${anchor}"` : 'div'} class="score"><div class="big" style="color:${gradeColor[c.grade]}">${c.score}</div><div class="lbl">${esc(label)}</div><div class="grade">Grade ${c.grade}${anchor ? ' · view' : ''}</div></${anchor ? 'a' : 'div'}>`;
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
<div class="muted" style="margin:6px 0 10px"><span class="tag ${partial ? 'part' : 'ok'}">${partial ? 'STOPPED EARLY — PARTIAL RESULTS' : 'COMPLETE'}</span><span class="tag wcag">WCAG 2.2 AA</span> ${esc(s.targetUrl)} · audited ${esc(new Date(s.finishedAt).toLocaleString())} · ${s.pagesCrawled} pages audited${(s.pagesDiscovered || 0) > s.pagesCrawled ? ` of ${s.pagesDiscovered} found` : ''} · ${s.linksChecked} links checked · ${Math.round(s.durationMs / 1000)}s</div>
<nav class="toc">
<a href="#accessibility">Accessibility violations <b>${a.violations}</b></a>
<a href="#links">Broken links <b>${broken}</b></a>
<a href="#best-practice">Best practices failing <b>${b.failingRules.length}</b></a>
<a href="#review">Needs manual review <b>${a.needsReview}</b></a>
${trend.length > 1 ? '<a href="#trend">Trend</a>' : ''}
${s.coverage ? '<a href="#coverage">Coverage</a>' : ''}
<a href="#pages">Pages audited <b>${(pages.length || s.pagesCrawled).toLocaleString()}</b></a>
${s.coverage && s.coverage.notAuditedTotal > 0 ? `<a href="#not-audited">Not audited <b>${s.coverage.notAuditedTotal.toLocaleString()}</b></a>` : ''}
${s.notes.length ? '<a href="#notes">Notes</a>' : ''}
</nav>
<div class="scores">${score(s.overall, 'Overall health')}${score(a, 'Accessibility (WCAG 2.2 AA)', 'accessibility')}${score(l, 'Links', 'links')}${score(b, 'Best practices', 'best-practice')}</div>
<div class="summary"><div><div class="n">${totalIssues}</div><div class="muted">Issues in ${new Set(issues.map((f) => f.page_url)).size} pages and ${new Set(findings.filter((f) => f.element).map((f) => f.element)).size} components</div></div>
<div><div class="muted" style="font-weight:600;margin-bottom:4px">Severity breakdown</div><span class="sev critical">${bySev.critical} critical</span> <span class="sev serious">${bySev.serious} serious</span> <span class="sev moderate">${bySev.moderate} moderate</span> <span class="sev minor">${bySev.minor} minor</span><div class="muted" style="margin-top:8px"><a href="#review">${a.needsReview} issue${a.needsReview === 1 ? '' : 's'} need manual review</a> · <a href="#accessibility">${a.violations} accessibility violation${a.violations === 1 ? '' : 's'}</a> · <a href="#links">${broken} broken link${broken === 1 ? '' : 's'}</a> · <a href="#best-practice">${b.failingRules.length} best-practice check${b.failingRules.length === 1 ? '' : 's'} failing</a></div></div></div>
${section('accessibility', `Accessibility violations (WCAG) — ${a.violations}`)}
${section('links', `Broken links — ${broken} of ${l.checked} checked${l.blocked ? ` (${l.blocked} could not be verified)` : ''}`)}
${section('best-practice', `Best-practice issues — ${b.failingRules.length} checks failing`)}
${section('review', `Needs manual review — ${a.needsReview}`)}
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
