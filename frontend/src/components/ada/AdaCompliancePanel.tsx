/**
 * ADA Compliance / website audit panel.
 *
 * Three screens in one component:
 *   1. form      — the user types a URL (plus optional sign-in), that's all
 *   2. scanning  — a live log of the crawl: every page navigated, links found,
 *                  checks run, problems as they are discovered
 *   3. results   — the scored website health report with drill-downs for
 *                  accessibility, broken links, best practices and pages
 *
 * Used inside the Chat wizard (ChatPage) and on the standalone
 * /ada-compliance page. `onBrownfield` hands the crawled site to the existing
 * explore-mode pipeline so requirements and test cases are rebuilt from it.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  startAdaScan, getAdaScan, getAdaFindings, getAdaPages, cancelAdaScan,
  type AdaCategory, type AdaFinding, type AdaPage, type AdaProgress, type AdaProgressEvent,
  type AdaScanRecord, type AdaSeverity, type AdaSummary,
} from '@/services/api';
import {
  Accessibility, Globe, Lock, Unlock, Loader2, CheckCircle2, AlertTriangle, XCircle, Link2Off,
  ShieldCheck, FileSearch, Compass, ChevronDown, ChevronRight, Download, ExternalLink, Search,
  Square, RotateCcw, Sparkles, ListChecks, Map as MapIcon, Bot, Info,
} from 'lucide-react';

type Screen = 'form' | 'scanning' | 'results';
type Tab = 'overview' | 'accessibility' | 'links' | 'best-practice' | 'pages';

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

const SEV_STYLE: Record<AdaSeverity, string> = {
  critical: 'bg-red-100 text-red-700 border-red-200',
  serious: 'bg-orange-100 text-orange-700 border-orange-200',
  moderate: 'bg-amber-100 text-amber-700 border-amber-200',
  minor: 'bg-gray-100 text-gray-600 border-gray-200',
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

export default function AdaCompliancePanel({ initialScanId, onBrownfield, onReset, embedded }: Props) {
  const [screen, setScreen] = useState<Screen>(initialScanId ? 'results' : 'form');

  // ── form ──
  const [url, setUrl] = useState('');
  const [needsLogin, setNeedsLogin] = useState(false);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [maxPages, setMaxPages] = useState(40);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [checkExternal, setCheckExternal] = useState(true);
  const [formError, setFormError] = useState('');
  const [starting, setStarting] = useState(false);

  // ── scan ──
  const [scanId, setScanId] = useState<string | null>(initialScanId || null);
  const [scan, setScan] = useState<AdaScanRecord | null>(null);
  const [progress, setProgress] = useState<AdaProgress | null>(null);
  const [events, setEvents] = useState<AdaProgressEvent[]>([]);
  const lastSeq = useRef(0);
  const logRef = useRef<HTMLDivElement>(null);
  const [cancelling, setCancelling] = useState(false);

  // ── results ──
  const [tab, setTab] = useState<Tab>('overview');

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
            setEvents((prev) => [...prev, ...res.progress!.events].slice(-600));
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

  useEffect(() => {
    if (screen === 'scanning' && logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [events, screen]);

  const start = async () => {
    setFormError('');
    if (!url.trim()) { setFormError('Enter the website address to audit.'); return; }
    setStarting(true);
    try {
      const res = await startAdaScan({
        url: url.trim(),
        username: needsLogin && username ? username : undefined,
        password: needsLogin && password ? password : undefined,
        maxPages,
        checkExternalLinks: checkExternal,
      });
      lastSeq.current = 0;
      setEvents([]);
      setProgress(null);
      setScan(null);
      setScanId(res.scanId);
      setTab('overview');
      setScreen('scanning');
    } catch (err: unknown) {
      setFormError(errorMessage(err, 'Could not start the audit.'));
    } finally {
      setStarting(false);
    }
  };

  const cancel = async () => {
    if (!scanId) return;
    setCancelling(true);
    try { await cancelAdaScan(scanId); } catch { /* the poll will surface the state */ }
  };

  const reset = () => {
    setScanId(null); setScan(null); setProgress(null); setEvents([]); lastSeq.current = 0;
    setCancelling(false); setScreen('form'); onReset?.();
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
            That's all that's needed. IntelliQE opens the site in a browser, follows every menu and link, and checks each page it reaches.
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
          {showAdvanced ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />} Scan size
        </button>
        {showAdvanced && (
          <div className="grid grid-cols-2 gap-3 pl-1">
            <div>
              <label className="block text-[11px] font-medium text-gray-600 mb-1">Pages to visit</label>
              <select value={maxPages} onChange={(e) => setMaxPages(Number(e.target.value))} className={inputCls + ' !py-2'}>
                <option value={15}>15 pages — quick look (~3 min)</option>
                <option value={40}>40 pages — standard (~8 min)</option>
                <option value={80}>80 pages — thorough (~15 min)</option>
                <option value={150}>150 pages — full site (~30 min)</option>
              </select>
            </div>
            <label className="flex items-end gap-2 text-[11px] text-gray-600 pb-2.5 cursor-pointer">
              <input type="checkbox" checked={checkExternal} onChange={(e) => setCheckExternal(e.target.checked)} className="w-4 h-4 rounded border-gray-300 text-violet-600" />
              Also check links to other websites
            </label>
          </div>
        )}

        {formError && <p className="text-xs text-red-600 bg-red-50 border border-red-100 rounded-lg px-3 py-2">{formError}</p>}

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
    const pct = c ? Math.min(100, Math.round((c.pages / Math.max(1, c.maxPages)) * 100)) : 0;
    const phase = c?.linksFound && (c.linksChecked ?? 0) > 0 && c.pages >= c.maxPages ? 'links' : 'crawl';
    return (
      <div className={`${embedded ? 'max-w-2xl ml-11' : 'max-w-4xl'} bg-white border border-gray-100 rounded-xl shadow-sm overflow-hidden`}>
        <div className="px-5 py-4 border-b border-gray-100 bg-gradient-to-r from-violet-50/60 to-indigo-50/40">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="text-xs text-gray-500 flex items-center gap-1.5"><Loader2 className="w-3.5 h-3.5 animate-spin text-violet-500" /> Auditing</p>
              <p className="text-sm font-semibold text-gray-800 truncate">{scan?.target_url || url}</p>
              <p className="text-[11px] text-gray-500 mt-0.5 truncate">
                {c?.currentUrl ? <>Now on <span className="font-mono text-gray-700">{shortUrl(c.currentUrl)}</span></> : 'Opening the site…'}
              </p>
            </div>
            <button onClick={cancel} disabled={cancelling} className="flex-shrink-0 text-xs text-gray-500 hover:text-red-600 border border-gray-200 hover:border-red-200 rounded-lg px-2.5 py-1.5 flex items-center gap-1 transition-colors disabled:opacity-50">
              <Square className="w-3 h-3" /> {cancelling ? 'Stopping…' : 'Stop'}
            </button>
          </div>
          <div className="mt-3 h-1.5 bg-gray-100 rounded-full overflow-hidden">
            <div className="h-full bg-gradient-to-r from-violet-500 to-indigo-500 transition-all duration-700" style={{ width: `${phase === 'links' ? 100 : pct}%` }} />
          </div>
          <div className="grid grid-cols-4 gap-2 mt-3">
            <Stat label="Pages visited" value={c ? `${c.pages}/${c.maxPages}` : '—'} />
            <Stat label="Links found" value={c?.linksFound ?? '—'} />
            <Stat label="Links checked" value={c?.linksChecked ?? '—'} />
            <Stat label="Issues so far" value={c?.issues ?? '—'} tone={c?.issues ? 'warn' : undefined} />
          </div>
        </div>
        <div ref={logRef} className="h-72 overflow-y-auto px-4 py-3 space-y-1 bg-gray-50/50 font-mono text-[11px]">
          {events.length === 0 && <p className="text-gray-400">Starting the browser…</p>}
          {events.map((e) => {
            const Icon = EVENT_ICON[e.type] || Info;
            return (
              <div key={e.seq} className="flex gap-2 items-start">
                <Icon className={`w-3.5 h-3.5 mt-[1px] flex-shrink-0 ${EVENT_COLOR[e.type] || 'text-gray-400'}`} />
                <span className={`break-all ${e.type === 'warning' ? 'text-amber-700' : e.type === 'error' || e.type === 'link-check' ? 'text-red-700' : e.type === 'navigate' ? 'text-gray-700' : 'text-gray-600'}`}>{e.message}</span>
              </div>
            );
          })}
        </div>
        <p className="px-5 py-2 text-[11px] text-gray-400 border-t border-gray-100">
          {progress ? `${fmtDuration(progress.elapsedMs)} elapsed` : ''} · Every page is opened in a real browser and checked for accessibility, broken links and best practices. You can leave this open or come back — the audit keeps running.
        </p>
      </div>
    );
  }

  /* ═════════════════════════════ RESULTS ═════════════════════════════ */
  if (!summary) {
    return (
      <div className={`${embedded ? 'max-w-2xl ml-11' : 'max-w-4xl'} bg-white border border-gray-100 rounded-xl p-5 shadow-sm`}>
        {scan?.status === 'failed' ? (
          <>
            <p className="text-sm font-semibold text-red-700 flex items-center gap-2"><XCircle className="w-4 h-4" /> The audit could not be completed</p>
            <p className="text-xs text-gray-600 mt-1">{scan.error || progress?.error || 'Unknown error'}</p>
          </>
        ) : (
          <p className="text-sm text-gray-500 flex items-center gap-2"><Loader2 className="w-4 h-4 animate-spin" /> Loading results…</p>
        )}
        <button onClick={reset} className="mt-3 text-xs text-violet-600 hover:text-violet-800 flex items-center gap-1"><RotateCcw className="w-3 h-3" /> Start another audit</button>
      </div>
    );
  }

  return (
    <div className={`${embedded ? 'max-w-3xl ml-11' : 'max-w-5xl'} space-y-3`}>
      <ReportHeader summary={summary} scan={scan} onReset={reset} onBrownfield={onBrownfield ? brownfield : undefined} />
      <div className="bg-white border border-gray-100 rounded-xl shadow-sm">
        <div className="flex gap-1 px-2 pt-2 border-b border-gray-100 overflow-x-auto">
          {([
            ['overview', 'Overview', null],
            ['accessibility', 'Accessibility', summary.categories.accessibility.violations],
            ['links', 'Broken links', summary.categories.links.broken + summary.categories.links.serverErrors + summary.categories.links.timeouts],
            ['best-practice', 'Best practices', summary.categories.bestPractice.failingRules.length],
            ['pages', 'Pages', summary.pagesCrawled],
          ] as [Tab, string, number | null][]).map(([key, label, count]) => (
            <button
              key={key}
              onClick={() => setTab(key)}
              className={`px-3 py-2 text-xs font-medium rounded-t-lg border-b-2 -mb-px whitespace-nowrap flex items-center gap-1.5 transition-colors ${tab === key ? 'border-violet-500 text-violet-700 bg-violet-50/50' : 'border-transparent text-gray-500 hover:text-gray-700'}`}
            >
              {label}
              {count !== null && <span className={`px-1.5 py-0.5 rounded-full text-[10px] ${key !== 'pages' && count > 0 ? 'bg-red-100 text-red-700' : 'bg-gray-100 text-gray-500'}`}>{count}</span>}
            </button>
          ))}
        </div>
        <div className="p-4">
          {tab === 'overview' && <Overview summary={summary} onTab={setTab} />}
          {tab === 'accessibility' && scanId && <FindingsTable scanId={scanId} category="accessibility" summary={summary} />}
          {tab === 'links' && <BrokenLinks summary={summary} />}
          {tab === 'best-practice' && scanId && <BestPractices summary={summary} scanId={scanId} />}
          {tab === 'pages' && scanId && <PagesTable scanId={scanId} />}
        </div>
      </div>
    </div>
  );
}

/* ───────────────────────────── pieces ───────────────────────────── */

function Stat({ label, value, tone }: { label: string; value: string | number; tone?: 'warn' }) {
  return (
    <div className="bg-white/70 border border-gray-100 rounded-lg px-3 py-2">
      <p className="text-[10px] uppercase tracking-wide text-gray-400">{label}</p>
      <p className={`text-base font-semibold ${tone === 'warn' ? 'text-amber-600' : 'text-gray-800'}`}>{value}</p>
    </div>
  );
}

function ScoreRing({ score, grade, size = 96, label }: { score: number; grade: string; size?: number; label?: string }) {
  const r = (size - 10) / 2;
  const circ = 2 * Math.PI * r;
  const dash = (score / 100) * circ;
  return (
    <div className="flex flex-col items-center">
      <svg width={size} height={size} className="-rotate-90">
        <circle cx={size / 2} cy={size / 2} r={r} stroke="#E5E7EB" strokeWidth="8" fill="none" />
        <circle cx={size / 2} cy={size / 2} r={r} stroke={GRADE_RING[grade]} strokeWidth="8" fill="none" strokeLinecap="round" strokeDasharray={`${dash} ${circ - dash}`} />
      </svg>
      <div className="-mt-[calc(50%+14px)] text-center" style={{ marginTop: -(size / 2 + 14) }}>
        <p className={`font-bold leading-none ${GRADE_COLOR[grade]}`} style={{ fontSize: size / 3.2 }}>{score}</p>
        <p className="text-[10px] text-gray-400 mt-0.5">{grade}</p>
      </div>
      {label && <p className="text-[11px] text-gray-600 font-medium mt-[calc(50%-8px)]" style={{ marginTop: size / 2 - 6 }}>{label}</p>}
    </div>
  );
}

function ReportHeader({ summary, scan, onReset, onBrownfield }: { summary: AdaSummary; scan: AdaScanRecord | null; onReset: () => void; onBrownfield?: () => void }) {
  const brokenTotal = summary.categories.links.broken + summary.categories.links.serverErrors + summary.categories.links.timeouts;
  const download = () => {
    const html = buildHtmlReport(summary);
    const blob = new Blob([html], { type: 'text/html' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `website-audit-${(summary.siteName || 'site').replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.html`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };
  return (
    <div className="bg-white border border-gray-100 rounded-xl shadow-sm p-5">
      <div className="flex flex-wrap items-start gap-5">
        <ScoreRing score={summary.overall.score} grade={summary.overall.grade} size={108} />
        <div className="flex-1 min-w-[220px]">
          <p className="text-[11px] uppercase tracking-wide text-gray-400">Website health report</p>
          <p className="text-base font-semibold text-gray-800 leading-tight">{summary.siteName || summary.targetUrl}</p>
          <a href={summary.targetUrl} target="_blank" rel="noopener noreferrer" className="text-[11px] text-violet-600 hover:underline inline-flex items-center gap-1 break-all">{summary.targetUrl} <ExternalLink className="w-3 h-3" /></a>
          <p className={`text-sm font-medium mt-2 ${GRADE_COLOR[summary.overall.grade]}`}>{summary.overall.label}</p>
          <p className="text-xs text-gray-500 mt-1">
            {summary.pagesCrawled} pages visited · {summary.linksChecked} links checked · {summary.categories.accessibility.violations} accessibility violations · {brokenTotal} broken links · {fmtDuration(summary.durationMs)}
            {scan?.status === 'cancelled' && <span className="ml-1 text-amber-600">(stopped early — partial results)</span>}
          </p>
          {summary.loginAttempted && (
            <p className="text-[11px] text-gray-500 mt-1 flex items-center gap-1">
              {summary.loginSucceeded ? <Lock className="w-3 h-3 text-emerald-500" /> : <Unlock className="w-3 h-3 text-amber-500" />}
              {summary.loginSucceeded ? 'Signed in — audited the authenticated site.' : 'Sign-in did not succeed — public pages only.'}
            </p>
          )}
        </div>
        <div className="grid grid-cols-3 gap-3">
          <MiniScore label="Accessibility" cat={summary.categories.accessibility} Icon={Accessibility} />
          <MiniScore label="Links" cat={summary.categories.links} Icon={Link2Off} />
          <MiniScore label="Best practices" cat={summary.categories.bestPractice} Icon={ShieldCheck} />
        </div>
      </div>
      <div className="flex flex-wrap gap-2 mt-4 pt-4 border-t border-gray-100">
        <button onClick={download} className="text-xs px-3 py-2 bg-gray-100 hover:bg-gray-200 text-gray-700 rounded-lg flex items-center gap-1.5 transition-colors"><Download className="w-3.5 h-3.5" /> Download report</button>
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
    <div className="text-center bg-gray-50/70 border border-gray-100 rounded-lg px-3 py-2 min-w-[92px]">
      <Icon className="w-4 h-4 text-gray-400 mx-auto" />
      <p className={`text-xl font-bold leading-tight ${GRADE_COLOR[cat.grade]}`}>{cat.score}</p>
      <p className="text-[10px] text-gray-500">{label}</p>
    </div>
  );
}

function Overview({ summary, onTab }: { summary: AdaSummary; onTab: (t: Tab) => void }) {
  const a = summary.categories.accessibility;
  const l = summary.categories.links;
  const b = summary.categories.bestPractice;
  const brokenTotal = l.broken + l.serverErrors + l.timeouts;
  return (
    <div className="space-y-4">
      <div className="grid sm:grid-cols-3 gap-3">
        <Card title="Accessibility (WCAG 2.2 AA)" Icon={Accessibility} onClick={() => onTab('accessibility')}>
          <p className="text-2xl font-bold text-gray-800">{a.violations} <span className="text-xs font-normal text-gray-500">violations</span></p>
          <div className="flex flex-wrap gap-1 mt-1.5">
            {(['critical', 'serious', 'moderate', 'minor'] as AdaSeverity[]).map((s) => (
              <span key={s} className={`px-1.5 py-0.5 rounded border text-[10px] font-medium ${SEV_STYLE[s]}`}>{a.bySeverity[s]} {s}</span>
            ))}
          </div>
        </Card>
        <Card title="Links" Icon={Link2Off} onClick={() => onTab('links')}>
          <p className="text-2xl font-bold text-gray-800">{brokenTotal} <span className="text-xs font-normal text-gray-500">broken of {l.checked}</span></p>
          <p className="text-[11px] text-gray-500 mt-1.5">{l.broken} not found · {l.serverErrors} server errors · {l.timeouts} unreachable · {l.redirects} redirects</p>
        </Card>
        <Card title="Best practices" Icon={ShieldCheck} onClick={() => onTab('best-practice')}>
          <p className="text-2xl font-bold text-gray-800">{b.failingRules.length} <span className="text-xs font-normal text-gray-500">of {b.rulesEvaluated} checks failing</span></p>
          <p className="text-[11px] text-gray-500 mt-1.5 truncate">{b.failingRules.slice(0, 3).map((r) => r.title).join(' · ') || 'All checks pass'}</p>
        </Card>
      </div>

      <div className="grid md:grid-cols-2 gap-4">
        <div>
          <p className="text-xs font-semibold text-gray-700 mb-2">Top accessibility issues</p>
          {a.topRules.length === 0 ? <p className="text-xs text-gray-400">No violations found.</p> : (
            <ul className="space-y-1.5">
              {a.topRules.slice(0, 6).map((r) => (
                <li key={r.ruleId} className="flex items-start gap-2 text-xs">
                  <span className={`px-1.5 py-0.5 rounded border text-[10px] font-medium flex-shrink-0 ${SEV_STYLE[r.severity]}`}>{r.severity}</span>
                  <span className="text-gray-700 flex-1">
                    {r.title}
                    <span className="text-gray-400"> — {r.pages} page{r.pages === 1 ? '' : 's'}, {r.occurrences} element{r.occurrences === 1 ? '' : 's'}{r.wcag ? ` · WCAG ${r.wcag}` : ''}</span>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div>
          <p className="text-xs font-semibold text-gray-700 mb-2">Pages needing the most attention</p>
          <ul className="space-y-1.5">
            {summary.worstPages.slice(0, 6).map((p) => (
              <li key={p.url} className="text-xs flex items-center gap-2">
                <span className={`font-mono text-[10px] w-8 text-right ${p.a11yScore < 70 ? 'text-red-600' : p.a11yScore < 90 ? 'text-amber-600' : 'text-emerald-600'}`}>{p.a11yScore}</span>
                <span className="truncate text-gray-700" title={p.url}>{p.title || shortUrl(p.url)}</span>
                <span className="text-gray-400 flex-shrink-0">{p.findings} issues</span>
              </li>
            ))}
          </ul>
        </div>
      </div>

      {summary.notes.length > 0 && (
        <div className="text-[11px] text-gray-500 bg-gray-50 border border-gray-100 rounded-lg px-3 py-2 space-y-0.5">
          {summary.notes.map((n, i) => <p key={i} className="flex gap-1.5"><Info className="w-3 h-3 mt-[2px] flex-shrink-0 text-gray-400" />{n}</p>)}
        </div>
      )}
    </div>
  );
}

function Card({ title, Icon, children, onClick }: { title: string; Icon: React.ElementType; children: React.ReactNode; onClick?: () => void }) {
  return (
    <button onClick={onClick} className="text-left bg-gray-50/70 hover:bg-violet-50/40 border border-gray-100 hover:border-violet-200 rounded-lg p-3 transition-colors">
      <p className="text-[11px] font-medium text-gray-500 flex items-center gap-1.5 mb-1"><Icon className="w-3.5 h-3.5" /> {title}</p>
      {children}
    </button>
  );
}

function FindingsTable({ scanId, category, summary }: { scanId: string; category: AdaCategory; summary: AdaSummary }) {
  const [severity, setSeverity] = useState<AdaSeverity | ''>('');
  const [q, setQ] = useState('');
  const [rows, setRows] = useState<AdaFinding[]>([]);
  const [total, setTotal] = useState(0);
  const [loadedKey, setLoadedKey] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const key = `${scanId}|${category}|${severity}|${q}`;
  const loading = loadedKey !== key;

  useEffect(() => {
    let alive = true;
    getAdaFindings(scanId, { category, severity, q, limit: 300 })
      .then((r) => { if (alive) { setRows(r.findings); setTotal(r.total); } })
      .catch(() => { if (alive) { setRows([]); setTotal(0); } })
      .finally(() => { if (alive) setLoadedKey(key); });
    return () => { alive = false; };
  }, [scanId, category, severity, q, key]);

  const grouped = useMemo(() => {
    const m = new Map<string, AdaFinding[]>();
    for (const f of rows) { const k = f.rule_id; if (!m.has(k)) m.set(k, []); m.get(k)!.push(f); }
    return [...m.entries()];
  }, [rows]);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2 items-center">
        <select value={severity} onChange={(e) => setSeverity(e.target.value as AdaSeverity | '')} className={inputCls + ' !w-auto !py-1.5 text-xs'}>
          <option value="">All severities</option>
          {(['critical', 'serious', 'moderate', 'minor'] as AdaSeverity[]).map((s) => <option key={s} value={s}>{s} ({summary.categories.accessibility.bySeverity[s]})</option>)}
        </select>
        <div className="relative flex-1 min-w-[160px]">
          <Search className="w-3.5 h-3.5 text-gray-400 absolute left-2.5 top-1/2 -translate-y-1/2" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter by rule, page or element" className={inputCls + ' !py-1.5 pl-8 text-xs'} />
        </div>
        <span className="text-[11px] text-gray-400">{total} finding{total === 1 ? '' : 's'}</span>
      </div>
      {loading ? <p className="text-xs text-gray-400 flex items-center gap-2"><Loader2 className="w-3.5 h-3.5 animate-spin" /> Loading…</p> : grouped.length === 0 ? (
        <p className="text-xs text-emerald-700 bg-emerald-50 border border-emerald-100 rounded-lg px-3 py-2 flex items-center gap-2"><CheckCircle2 className="w-4 h-4" /> No accessibility violations match.</p>
      ) : (
        <div className="space-y-2">
          {grouped.map(([ruleId, list]) => {
            const first = list[0];
            const pages = new Set(list.map((f) => f.page_url)).size;
            const occ = list.reduce((a, f) => a + f.occurrences, 0);
            const isOpen = open === ruleId;
            return (
              <div key={ruleId} className="border border-gray-100 rounded-lg overflow-hidden">
                <button onClick={() => setOpen(isOpen ? null : ruleId)} className="w-full text-left px-3 py-2.5 flex items-start gap-2 hover:bg-gray-50">
                  {isOpen ? <ChevronDown className="w-3.5 h-3.5 mt-0.5 text-gray-400 flex-shrink-0" /> : <ChevronRight className="w-3.5 h-3.5 mt-0.5 text-gray-400 flex-shrink-0" />}
                  <span className={`px-1.5 py-0.5 rounded border text-[10px] font-medium flex-shrink-0 ${SEV_STYLE[first.severity]}`}>{first.severity}</span>
                  <span className="flex-1 min-w-0">
                    <span className="text-xs font-medium text-gray-800">{first.title}</span>
                    <span className="block text-[11px] text-gray-500">{pages} page{pages === 1 ? '' : 's'} · {occ} element{occ === 1 ? '' : 's'}{first.wcag ? ` · WCAG ${first.wcag}` : ''} · <span className="font-mono">{ruleId}</span></span>
                  </span>
                  {first.help_url && <a href={first.help_url} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()} className="text-[11px] text-violet-600 hover:underline flex items-center gap-1 flex-shrink-0">How to fix <ExternalLink className="w-3 h-3" /></a>}
                </button>
                {isOpen && (
                  <div className="border-t border-gray-100 bg-gray-50/60 px-3 py-2 space-y-2">
                    {first.description && <p className="text-[11px] text-gray-600">{first.description}</p>}
                    {list.slice(0, 40).map((f) => (
                      <div key={f.id} className="text-[11px] bg-white border border-gray-100 rounded px-2.5 py-2">
                        <p className="text-gray-500 truncate" title={f.page_url}><Compass className="w-3 h-3 inline mr-1 text-gray-400" />{shortUrl(f.page_url)}{f.occurrences > 1 ? ` · ${f.occurrences} occurrences` : ''}</p>
                        {f.element && <p className="font-mono text-violet-700 break-all mt-0.5">{f.element}</p>}
                        {f.html_snippet && <pre className="font-mono text-gray-600 bg-gray-50 rounded px-2 py-1 mt-1 whitespace-pre-wrap break-all max-h-24 overflow-auto">{f.html_snippet}</pre>}
                        {typeof f.details?.failureSummary === 'string' && <p className="text-gray-600 mt-1 whitespace-pre-line">{f.details.failureSummary}</p>}
                      </div>
                    ))}
                    {list.length > 40 && <p className="text-[11px] text-gray-400">…and {list.length - 40} more</p>}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function BrokenLinks({ summary }: { summary: AdaSummary }) {
  const l = summary.categories.links;
  const [filter, setFilter] = useState<'all' | 'internal' | 'external'>('all');
  const rows = l.brokenLinks.filter((x) => filter === 'all' || (filter === 'internal' ? !x.external : x.external));
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3 text-xs">
        <span className="text-gray-600">{l.checked} links checked · <span className="text-emerald-600">{l.ok} OK</span> · <span className="text-gray-500">{l.redirects} redirects</span> · <span className="text-red-600">{l.broken + l.serverErrors + l.timeouts} broken</span>{l.blocked > 0 && <> · <span className="text-gray-400">{l.blocked} could not be verified</span></>}</span>
        <div className="flex gap-1 ml-auto">
          {(['all', 'internal', 'external'] as const).map((f) => (
            <button key={f} onClick={() => setFilter(f)} className={`px-2 py-1 rounded text-[11px] ${filter === f ? 'bg-violet-100 text-violet-700' : 'text-gray-500 hover:bg-gray-100'}`}>{f}</button>
          ))}
        </div>
      </div>
      {rows.length === 0 ? (
        <p className="text-xs text-emerald-700 bg-emerald-50 border border-emerald-100 rounded-lg px-3 py-2 flex items-center gap-2"><CheckCircle2 className="w-4 h-4" /> No broken links found.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-left text-[11px] text-gray-400 border-b border-gray-100">
                <th className="py-1.5 pr-3 font-medium">Status</th>
                <th className="py-1.5 pr-3 font-medium">Link</th>
                <th className="py-1.5 pr-3 font-medium">Found on</th>
                <th className="py-1.5 font-medium">Type</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.url} className="border-b border-gray-50 align-top">
                  <td className="py-2 pr-3"><span className={`px-1.5 py-0.5 rounded border text-[10px] font-mono font-medium ${r.kind === 'server-error' ? SEV_STYLE.critical : r.kind === 'broken' ? SEV_STYLE.serious : SEV_STYLE.moderate}`}>{r.status ?? r.kind}</span></td>
                  <td className="py-2 pr-3 max-w-[320px]">
                    <a href={r.url} target="_blank" rel="noopener noreferrer" className="text-violet-700 hover:underline break-all">{r.url}</a>
                    {r.linkText && <p className="text-gray-400">"{r.linkText}"</p>}
                    {r.error && <p className="text-gray-400">{r.error}</p>}
                  </td>
                  <td className="py-2 pr-3 max-w-[240px] text-gray-600">
                    {r.referrers.slice(0, 3).map((ref) => <p key={ref} className="truncate" title={ref}>{shortUrl(ref)}</p>)}
                    {r.referrers.length > 3 && <p className="text-gray-400">+{r.referrers.length - 3} more</p>}
                  </td>
                  <td className="py-2 text-gray-500">{r.external ? 'external' : 'internal'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {l.blocked > 0 && (
        <details className="text-[11px] text-gray-500">
          <summary className="cursor-pointer hover:text-gray-700">{l.blocked} link{l.blocked === 1 ? '' : 's'} could not be verified — the destination blocks automated checks (HTTP 401/403/429). They are not counted as broken.</summary>
          <ul className="mt-1.5 space-y-0.5 pl-4 list-disc">
            {l.blockedLinks.map((x) => <li key={x.url} className="break-all"><span className="font-mono text-gray-400">{x.status}</span> {x.url}</li>)}
          </ul>
        </details>
      )}
    </div>
  );
}

function BestPractices({ summary, scanId }: { summary: AdaSummary; scanId: string }) {
  const b = summary.categories.bestPractice;
  const [open, setOpen] = useState<string | null>(null);
  const [rows, setRows] = useState<Record<string, AdaFinding[]>>({});
  const load = useCallback(async (ruleId: string) => {
    if (rows[ruleId]) return;
    const r = await getAdaFindings(scanId, { category: 'best-practice', q: ruleId, limit: 200 });
    setRows((prev) => ({ ...prev, [ruleId]: r.findings.filter((f) => f.rule_id === ruleId) }));
  }, [rows, scanId]);
  return (
    <div className="space-y-3">
      <p className="text-xs text-gray-600">{b.rulesPassed} of {b.rulesEvaluated} checks pass on every page. Checks failing on at least one page:</p>
      {b.failingRules.length === 0 ? (
        <p className="text-xs text-emerald-700 bg-emerald-50 border border-emerald-100 rounded-lg px-3 py-2 flex items-center gap-2"><CheckCircle2 className="w-4 h-4" /> Every check passed on every page.</p>
      ) : (
        <div className="space-y-2">
          {b.failingRules.map((r) => {
            const isOpen = open === r.ruleId;
            return (
              <div key={r.ruleId} className="border border-gray-100 rounded-lg overflow-hidden">
                <button onClick={() => { setOpen(isOpen ? null : r.ruleId); load(r.ruleId); }} className="w-full text-left px-3 py-2.5 flex items-center gap-2 hover:bg-gray-50">
                  {isOpen ? <ChevronDown className="w-3.5 h-3.5 text-gray-400" /> : <ChevronRight className="w-3.5 h-3.5 text-gray-400" />}
                  <span className={`px-1.5 py-0.5 rounded border text-[10px] font-medium ${SEV_STYLE[r.severity]}`}>{r.severity}</span>
                  <span className="text-xs font-medium text-gray-800 flex-1">{r.title}</span>
                  <span className="text-[11px] text-gray-400">{r.pages} page{r.pages === 1 ? '' : 's'}</span>
                </button>
                {isOpen && (
                  <div className="border-t border-gray-100 bg-gray-50/60 px-3 py-2 space-y-1">
                    {!rows[r.ruleId] ? <p className="text-[11px] text-gray-400">Loading…</p> : rows[r.ruleId].map((f) => (
                      <p key={f.id} className="text-[11px] text-gray-600"><span className="text-gray-500 font-mono">{shortUrl(f.page_url)}</span> — {f.description}</p>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function PagesTable({ scanId }: { scanId: string }) {
  const [pages, setPages] = useState<AdaPage[] | null>(null);
  useEffect(() => { getAdaPages(scanId).then(setPages).catch(() => setPages([])); }, [scanId]);
  if (!pages) return <p className="text-xs text-gray-400 flex items-center gap-2"><Loader2 className="w-3.5 h-3.5 animate-spin" /> Loading…</p>;
  const tone = (s: number) => s < 70 ? 'text-red-600' : s < 90 ? 'text-amber-600' : 'text-emerald-600';
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs">
        <thead>
          <tr className="text-left text-[11px] text-gray-400 border-b border-gray-100">
            <th className="py-1.5 pr-3 font-medium">Page</th>
            <th className="py-1.5 pr-3 font-medium">HTTP</th>
            <th className="py-1.5 pr-3 font-medium text-right">Load</th>
            <th className="py-1.5 pr-3 font-medium text-right">Links</th>
            <th className="py-1.5 pr-3 font-medium text-right">A11y</th>
            <th className="py-1.5 pr-3 font-medium text-right">Practices</th>
            <th className="py-1.5 font-medium text-right">Issues</th>
          </tr>
        </thead>
        <tbody>
          {pages.map((p) => (
            <tr key={p.url} className="border-b border-gray-50">
              <td className="py-2 pr-3 max-w-[360px]">
                <p className="text-gray-800 truncate" title={p.url}>{'· '.repeat(p.depth)}{p.title || shortUrl(p.url)}</p>
                <a href={p.url} target="_blank" rel="noopener noreferrer" className="text-[10px] text-gray-400 hover:text-violet-600 truncate block">{shortUrl(p.url)}</a>
              </td>
              <td className="py-2 pr-3"><span className={`font-mono ${p.status_code && p.status_code < 400 ? 'text-gray-600' : 'text-red-600'}`}>{p.status_code ?? 'ERR'}</span></td>
              <td className="py-2 pr-3 text-right text-gray-600">{(p.load_ms / 1000).toFixed(1)}s</td>
              <td className="py-2 pr-3 text-right text-gray-600">{p.links_found}</td>
              <td className={`py-2 pr-3 text-right font-medium ${tone(p.a11y_score)}`}>{p.a11y_score}</td>
              <td className={`py-2 pr-3 text-right font-medium ${tone(p.bp_score)}`}>{p.bp_score}</td>
              <td className="py-2 text-right text-gray-600">{p.findings_count}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* ───────────────────────────── HTML export ───────────────────────────── */

function esc(s: unknown): string {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
}

function buildHtmlReport(s: AdaSummary): string {
  const a = s.categories.accessibility, l = s.categories.links, b = s.categories.bestPractice;
  const broken = l.broken + l.serverErrors + l.timeouts;
  const gradeColor: Record<string, string> = { A: '#059669', B: '#16a34a', C: '#d97706', D: '#ea580c', F: '#dc2626' };
  const score = (c: { score: number; grade: string }, label: string) =>
    `<div class="score"><div class="big" style="color:${gradeColor[c.grade]}">${c.score}</div><div class="lbl">${esc(label)}</div><div class="grade">Grade ${c.grade}</div></div>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Website audit — ${esc(s.siteName)}</title>
<style>body{font-family:Segoe UI,Arial,sans-serif;color:#1f2937;margin:0;padding:32px;max-width:1000px}h1{font-size:22px;margin:0 0 4px}h2{font-size:15px;margin:28px 0 8px;border-bottom:1px solid #e5e7eb;padding-bottom:4px}
.muted{color:#6b7280;font-size:12px}.scores{display:flex;gap:16px;margin:20px 0}.score{flex:1;border:1px solid #e5e7eb;border-radius:10px;padding:14px;text-align:center}.big{font-size:34px;font-weight:700}.lbl{font-size:12px;color:#6b7280}.grade{font-size:11px;color:#9ca3af}
table{width:100%;border-collapse:collapse;font-size:12px}th,td{text-align:left;padding:6px 8px;border-bottom:1px solid #f3f4f6;vertical-align:top}th{color:#6b7280;font-weight:600;font-size:11px}
.sev{display:inline-block;padding:1px 6px;border-radius:4px;font-size:10px;font-weight:600}.critical{background:#fee2e2;color:#b91c1c}.serious{background:#ffedd5;color:#c2410c}.moderate{background:#fef3c7;color:#b45309}.minor{background:#f3f4f6;color:#4b5563}
.foot{margin-top:32px;font-size:11px;color:#9ca3af}</style></head><body>
<h1>Website health report — ${esc(s.siteName)}</h1>
<div class="muted">${esc(s.targetUrl)} · audited ${esc(new Date(s.finishedAt).toLocaleString())} · ${s.pagesCrawled} pages · ${s.linksChecked} links checked · ${Math.round(s.durationMs / 1000)}s</div>
<div class="scores">${score(s.overall, 'Overall health')}${score(a, 'Accessibility (WCAG 2.2 AA)')}${score(l, 'Links')}${score(b, 'Best practices')}</div>
<h2>Accessibility — ${a.violations} violations (${a.bySeverity.critical} critical, ${a.bySeverity.serious} serious, ${a.bySeverity.moderate} moderate, ${a.bySeverity.minor} minor)</h2>
<table><tr><th>Severity</th><th>Issue</th><th>WCAG</th><th>Pages</th><th>Elements</th><th>Guidance</th></tr>
${a.topRules.map((r) => `<tr><td><span class="sev ${r.severity}">${r.severity}</span></td><td>${esc(r.title)}<br><span class="muted">${esc(r.ruleId)}</span></td><td>${esc(r.wcag || '')}</td><td>${r.pages}</td><td>${r.occurrences}</td><td>${r.helpUrl ? `<a href="${esc(r.helpUrl)}">How to fix</a>` : ''}</td></tr>`).join('')}
</table>
<h2>Broken links — ${broken} of ${l.checked} checked (${l.broken} not found, ${l.serverErrors} server errors, ${l.timeouts} unreachable)</h2>
<table><tr><th>Status</th><th>Link</th><th>Found on</th><th>Type</th></tr>
${l.brokenLinks.map((x) => `<tr><td>${esc(x.status ?? x.kind)}</td><td>${esc(x.url)}${x.linkText ? `<br><span class="muted">"${esc(x.linkText)}"</span>` : ''}</td><td>${x.referrers.slice(0, 3).map(esc).join('<br>')}</td><td>${x.external ? 'external' : 'internal'}</td></tr>`).join('') || '<tr><td colspan="4">None</td></tr>'}
</table>
<h2>Best practices — ${b.rulesPassed} of ${b.rulesEvaluated} checks pass everywhere</h2>
<table><tr><th>Severity</th><th>Check</th><th>Pages failing</th></tr>
${b.failingRules.map((r) => `<tr><td><span class="sev ${r.severity}">${r.severity}</span></td><td>${esc(r.title)}</td><td>${r.pages}</td></tr>`).join('') || '<tr><td colspan="3">All checks pass</td></tr>'}
</table>
<h2>Pages needing the most attention</h2>
<table><tr><th>Page</th><th>Accessibility</th><th>Best practices</th><th>Issues</th></tr>
${s.worstPages.map((p) => `<tr><td>${esc(p.title || p.url)}<br><span class="muted">${esc(p.url)}</span></td><td>${p.a11yScore}</td><td>${p.bpScore}</td><td>${p.findings}</td></tr>`).join('')}
</table>
${s.notes.length ? `<h2>Notes</h2><ul class="muted">${s.notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul>` : ''}
<div class="foot">Generated by IntelliQE. Accessibility rules by axe-core (Deque). Scores: accessibility 45%, links 30%, best practices 25%.</div>
</body></html>`;
}
