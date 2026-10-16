/**
 * WebLabPage — opt-in browser quality tools for Web automation.
 *
 * Four standalone tools, each driving a headless browser server-side, none of
 * which touch the generate → execute → heal pipeline:
 *   • Accessibility — axe-core WCAG scan
 *   • Visual        — cross-browser / cross-viewport screenshots + regression
 *   • Responsive    — device-emulation preview
 *   • Performance   — Core Web Vitals
 *
 * Redesigned to the app's premium language: the violet→indigo TabHero, the
 * PassRing score donut, EmptyStates and FilterChips from the API Studio kit —
 * so the Web Lab reads as the same product as the rest of IntelliQE. Beyond the
 * restyle it adds: a score ring + impact filter + live search + per-node selector
 * copy + JSON export on Accessibility; a zoomable screenshot lightbox with PNG
 * download on Visual and Responsive; device-group quick-select; an overall score
 * ring + resource-weight breakdown on Performance; and a remembered recent-URL
 * list with Enter-to-run shared across every tool.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  Accessibility, Images, Smartphone, Gauge, Play, AlertTriangle, ExternalLink, Camera, GitCompare,
  Trash2, Check, MonitorSmartphone, Download, Search, X, Copy, Maximize2, FileJson, ShieldCheck,
  Clock, ChevronDown, Sparkles, History,
} from 'lucide-react';
import Spinner from '@/components/feedback/Spinner';
import PageTabs from '@/components/ui/PageTabs';
import { TabHero, PassRing, FilterChip, EmptyState } from '@/components/api-studio/primitives';
import {
  runWebAccessibility, webVisualCapture, captureWebVisualBaseline, compareWebVisual, listWebVisualBaselines, deleteWebVisualBaseline,
  listWebDevices, captureWebDevices, captureWebPerformance,
  type A11yReport, type A11yViolation, type VisualCaptureReport, type VisualCompareResult, type VisualBaseline, type DeviceReport, type PerfReport, type WebEngine,
} from '@/services/api';

/* ── shared bits ── */
const CARD = 'bg-white rounded-2xl border border-gray-100 shadow-[0_1px_2px_rgba(16,24,40,0.04),0_12px_28px_-20px_rgba(76,29,149,0.25)]';
const INPUT = 'w-full px-3 py-2 text-[13px] border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-[#A5B4FC] focus:border-[#7C3AED] transition-shadow';
const BTN = 'inline-flex items-center gap-1.5 px-4 py-2 text-[13px] font-semibold text-white bg-gradient-to-r from-[#7C3AED] to-[#6366F1] rounded-lg shadow-[0_6px_16px_-6px_rgba(99,102,241,0.7)] disabled:opacity-40 disabled:shadow-none hover:brightness-[1.05] active:translate-y-px transition-all';
const GHOST_BTN = 'inline-flex items-center gap-1.5 px-3 py-2 text-[12.5px] font-medium text-gray-700 bg-white border border-gray-200 rounded-lg hover:bg-gray-50 hover:border-[#C4B5FD] disabled:opacity-40 transition-colors';
const CHIP = (on: boolean) => `px-2.5 py-1 rounded-full border text-[11.5px] font-medium cursor-pointer select-none transition-colors ${on ? 'bg-[#7C3AED] text-white border-[#7C3AED]' : 'bg-white text-gray-600 border-gray-200 hover:border-[#C4B5FD]'}`;
const ENGINES: WebEngine[] = ['chromium', 'firefox', 'webkit'];
const ENGINE_LABEL: Record<WebEngine, string> = { chromium: 'Chromium', firefox: 'Firefox', webkit: 'WebKit' };

const RATING_COLOR: Record<string, string> = { good: 'text-emerald-600 bg-emerald-50 border-emerald-200', 'needs-improvement': 'text-amber-600 bg-amber-50 border-amber-200', poor: 'text-red-600 bg-red-50 border-red-200', na: 'text-gray-400 bg-gray-50 border-gray-200' };
const IMPACT_COLOR: Record<string, string> = { critical: 'text-red-700 bg-red-50 border-red-200', serious: 'text-orange-700 bg-orange-50 border-orange-200', moderate: 'text-amber-700 bg-amber-50 border-amber-200', minor: 'text-gray-600 bg-gray-50 border-gray-200', unknown: 'text-gray-500 bg-gray-50 border-gray-200' };
const IMPACT_ORDER = ['critical', 'serious', 'moderate', 'minor'] as const;
const RES_PALETTE = ['#7C3AED', '#6366F1', '#A78BFA', '#22D3EE', '#E879F9', '#F59E0B', '#10B981', '#94A3B8'];
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const errMsg = (e: any) => e?.response?.data?.error || e?.message || 'Request failed.';

/* ── recent-URL memory (per tool, localStorage) ── */
function useRecentUrls(key: string) {
  const storeKey = `weblab.recent.${key}`;
  const [recents, setRecents] = useState<string[]>(() => {
    try { const raw = localStorage.getItem(storeKey); return raw ? JSON.parse(raw) : []; } catch { return []; }
  });
  const remember = (url: string) => {
    const u = url.trim();
    if (!u) return;
    setRecents((prev) => {
      const next = [u, ...prev.filter((x) => x !== u)].slice(0, 6);
      try { localStorage.setItem(storeKey, JSON.stringify(next)); } catch { /* ignore */ }
      return next;
    });
  };
  return { recents, remember };
}

/* ── download helpers ── */
function downloadPng(base64: string, name: string) {
  try {
    const bin = atob(base64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    triggerDownload(new Blob([bytes], { type: 'image/png' }), name.endsWith('.png') ? name : `${name}.png`);
  } catch { /* ignore */ }
}
function downloadJson(data: unknown, name: string) {
  triggerDownload(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }), name.endsWith('.json') ? name : `${name}.json`);
}
function triggerDownload(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name; document.body.appendChild(a); a.click();
  document.body.removeChild(a); setTimeout(() => URL.revokeObjectURL(url), 2000);
}
const slug = (s: string) => (s || 'web').replace(/^https?:\/\//, '').replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').slice(0, 48) || 'web';

/* ── small shared UI ── */
function ErrorBox({ msg }: { msg: string }) {
  return <div className="flex items-start gap-2 px-3 py-2 bg-red-50 border border-red-200 rounded-lg"><AlertTriangle className="w-4 h-4 text-red-500 flex-shrink-0 mt-px" /><p className="text-[12px] text-red-700 min-w-0">{msg}</p></div>;
}

/** URL field with Enter-to-run and a remembered-recents dropdown. */
function ScanBar({
  url, setUrl, recents, onRun, running, disabled, cta = 'Scan', icon: Icon = Play, placeholder, children,
}: {
  url: string; setUrl: (v: string) => void; recents: string[]; onRun: () => void; running: boolean;
  disabled?: boolean; cta?: string; icon?: React.ElementType; placeholder?: string; children?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const h = (e: MouseEvent) => { if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', h); return () => document.removeEventListener('mousedown', h);
  }, []);
  return (
    <div className="flex flex-wrap items-end gap-2">
      <div className="flex-1 min-w-[260px]">
        <label className="block text-[11px] font-semibold text-gray-500 mb-1">URL to scan</label>
        <div className="relative" ref={wrapRef}>
          <input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !disabled && !running && url.trim()) { setOpen(false); onRun(); } }}
            onFocus={() => recents.length > 0 && setOpen(true)}
            placeholder={placeholder || 'https://app.example.com'}
            className={`${INPUT} pr-9`}
          />
          {recents.length > 0 && (
            <button type="button" onClick={() => setOpen((o) => !o)} className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-[#7C3AED]" aria-label="Recent URLs">
              <History className="w-4 h-4" />
            </button>
          )}
          {open && recents.length > 0 && (
            <div className="absolute z-20 mt-1 w-full bg-white border border-gray-100 rounded-lg shadow-lg overflow-hidden">
              <div className="px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wide text-gray-400 border-b border-gray-50">Recent</div>
              {recents.map((r) => (
                <button key={r} type="button" onClick={() => { setUrl(r); setOpen(false); }} className="flex items-center gap-2 w-full px-3 py-1.5 text-[12px] text-gray-600 hover:bg-[#F5F3FF] text-left">
                  <Clock className="w-3 h-3 text-gray-300 flex-shrink-0" /><span className="truncate">{r}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
      {children}
      <button type="button" onClick={onRun} disabled={running || disabled || !url.trim()} className={BTN}>
        {running ? <Spinner className="w-3.5 h-3.5 animate-spin" /> : <Icon className="w-3.5 h-3.5" />}{cta}
      </button>
    </div>
  );
}

/** Full-screen image viewer with download. */
function Lightbox({ src, name, onClose }: { src: string; name: string; onClose: () => void }) {
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', h); return () => document.removeEventListener('keydown', h);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-6" onClick={onClose}>
      <div className="relative max-w-[94vw] max-h-[92vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-2 mb-2">
          <span className="text-[12px] text-white/80 truncate">{name}</span>
          <button type="button" onClick={() => downloadPng(src, name)} className="ml-auto inline-flex items-center gap-1 px-2.5 py-1 text-[11.5px] font-medium text-gray-800 bg-white/90 rounded-md hover:bg-white"><Download className="w-3.5 h-3.5" />Download</button>
          <button type="button" onClick={onClose} className="inline-flex items-center justify-center w-7 h-7 rounded-md bg-white/15 text-white hover:bg-white/25"><X className="w-4 h-4" /></button>
        </div>
        <img src={`data:image/png;base64,${src}`} alt={name} className="max-w-full max-h-[84vh] object-contain rounded-lg shadow-2xl bg-white" />
      </div>
    </div>
  );
}

/** A screenshot tile shared by Visual + Responsive: hover overlay to zoom / download. */
function ShotTile({ header, png, alt, name, maxH = 'max-h-72' }: { header: ReactNode; png?: string; alt: string; name: string; maxH?: string }) {
  const [box, setBox] = useState(false);
  return (
    <div className={`${CARD} overflow-hidden group`}>
      <div className="flex items-center gap-2 px-3 py-1.5 border-b border-gray-100 text-[11.5px]">{header}</div>
      {png ? (
        <div className="relative">
          <img src={`data:image/png;base64,${png}`} alt={alt} className={`w-full ${maxH} object-contain object-top bg-gray-50`} />
          <div className="absolute inset-0 flex items-center justify-center gap-2 opacity-0 group-hover:opacity-100 bg-black/25 transition-opacity">
            <button type="button" onClick={() => setBox(true)} className="inline-flex items-center gap-1 px-2.5 py-1.5 text-[11.5px] font-medium text-gray-800 bg-white/95 rounded-md hover:bg-white"><Maximize2 className="w-3.5 h-3.5" />Zoom</button>
            <button type="button" onClick={() => downloadPng(png, name)} className="inline-flex items-center gap-1 px-2.5 py-1.5 text-[11.5px] font-medium text-gray-800 bg-white/95 rounded-md hover:bg-white"><Download className="w-3.5 h-3.5" />PNG</button>
          </div>
        </div>
      ) : null}
      {box && png && <Lightbox src={png} name={name} onClose={() => setBox(false)} />}
    </div>
  );
}

function SummaryTile({ value, label, tone = 'muted' }: { value: ReactNode; label: string; tone?: 'muted' | 'good' | 'warn' | 'bad' }) {
  const cls = tone === 'good' ? 'text-emerald-600' : tone === 'warn' ? 'text-amber-600' : tone === 'bad' ? 'text-red-600' : 'text-gray-700';
  return (
    <div className="rounded-xl border border-gray-100 bg-gradient-to-b from-white to-[#FBFAFF] px-3 py-2 text-center min-w-[72px]">
      <div className={`text-[20px] font-bold tabular-nums leading-none ${cls}`}>{value}</div>
      <div className="text-[10px] text-gray-400 uppercase tracking-wide mt-1">{label}</div>
    </div>
  );
}

/* ══════════ Accessibility ══════════ */
function AccessibilityPanel() {
  const [url, setUrl] = useState('');
  const [standard, setStandard] = useState('wcag21aa');
  const [report, setReport] = useState<A11yReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [impactFilter, setImpactFilter] = useState<string>('all');
  const [query, setQuery] = useState('');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [copied, setCopied] = useState('');
  const { recents, remember } = useRecentUrls('a11y');

  const run = async () => {
    setLoading(true); setError(''); setReport(null); setImpactFilter('all'); setQuery(''); setExpanded(new Set());
    try { const r = await runWebAccessibility({ url, standard }); setReport(r); remember(url); }
    catch (e) { setError(errMsg(e)); }
    finally { setLoading(false); }
  };
  const copySel = (sel: string, k: string) => { navigator.clipboard?.writeText(sel).then(() => { setCopied(k); setTimeout(() => setCopied(''), 1400); }, () => {}); };

  const shown = useMemo(() => {
    if (!report) return [] as A11yViolation[];
    const q = query.trim().toLowerCase();
    return report.violations.filter((v) =>
      (impactFilter === 'all' || v.impact === impactFilter) &&
      (!q || v.help.toLowerCase().includes(q) || v.description.toLowerCase().includes(q) || v.id.toLowerCase().includes(q)));
  }, [report, impactFilter, query]);

  return (
    <div className="space-y-3">
      <div className={`${CARD} p-4 space-y-3`}>
        <ScanBar url={url} setUrl={setUrl} recents={recents} onRun={() => void run()} running={loading} cta="Scan">
          <div>
            <label className="block text-[11px] font-semibold text-gray-500 mb-1">Standard</label>
            <select value={standard} onChange={(e) => setStandard(e.target.value)} className={INPUT}>
              <option value="wcag2a">WCAG 2.0 A</option><option value="wcag2aa">WCAG 2.0 AA</option>
              <option value="wcag21aa">WCAG 2.1 AA</option><option value="wcag22aa">WCAG 2.2 AA</option>
              <option value="best-practice">+ Best practices</option>
            </select>
          </div>
        </ScanBar>
        {error && <ErrorBox msg={error} />}
      </div>

      {loading && <SkeletonReport />}

      {!loading && !report && !error && (
        <div className={CARD}><EmptyState icon={ShieldCheck} title="Scan a page for accessibility issues" hint="Runs an axe-core audit against your chosen WCAG standard and scores the page, grouped by impact. Press Enter in the URL field to run." /></div>
      )}

      {report && (
        <>
          <div className={`${CARD} p-4`}>
            <div className="flex items-center gap-5 flex-wrap">
              <PassRing value={report.summary.score} label="a11y score" />
              <div className="flex flex-wrap gap-2">
                {IMPACT_ORDER.map((k) => (
                  <SummaryTile key={k} value={report.summary.byImpact[k] || 0} label={k} tone={(report.summary.byImpact[k] || 0) > 0 ? (k === 'critical' || k === 'serious' ? 'bad' : 'warn') : 'muted'} />
                ))}
                <SummaryTile value={report.summary.passes} label="passed" tone="good" />
                <SummaryTile value={report.summary.incomplete} label="review" />
              </div>
              <div className="ml-auto flex flex-col items-end gap-2">
                <span className="text-[11px] text-gray-400">{report.standardLabel} · {report.engineLabel}</span>
                <div className="flex gap-1.5">
                  <button type="button" onClick={() => downloadJson(report, `a11y-${slug(report.url)}`)} className={GHOST_BTN}><FileJson className="w-3.5 h-3.5" />Export JSON</button>
                </div>
              </div>
            </div>
          </div>

          {report.violations.length === 0 ? (
            <div className={`${CARD} p-6 text-center`}>
              <div className="inline-flex items-center justify-center w-12 h-12 rounded-2xl bg-emerald-50 text-emerald-600 mb-2"><Check className="w-6 h-6" /></div>
              <p className="text-[13px] text-emerald-700 font-semibold">No violations found for {report.standardLabel}.</p>
              <p className="text-[12px] text-gray-400 mt-0.5">{report.summary.passes} checks passed · {report.summary.incomplete} need manual review.</p>
            </div>
          ) : (
            <div className={`${CARD} p-4 space-y-3`}>
              <div className="flex items-center gap-2 flex-wrap">
                <FilterChip active={impactFilter === 'all'} onClick={() => setImpactFilter('all')} count={report.violations.length}>All</FilterChip>
                {IMPACT_ORDER.filter((k) => (report.summary.byImpact[k] || 0) > 0).map((k) => (
                  <FilterChip key={k} active={impactFilter === k} onClick={() => setImpactFilter(k)} count={report.summary.byImpact[k]} tone={k === 'critical' || k === 'serious' ? 'danger' : 'brand'}>
                    {k[0].toUpperCase() + k.slice(1)}
                  </FilterChip>
                ))}
                <div className="relative ml-auto">
                  <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-400" />
                  <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Filter rules…" className={`${INPUT} pl-7 w-48`} />
                </div>
              </div>
              <div className="space-y-2">
                {shown.map((v) => {
                  const isOpen = expanded.has(v.id);
                  return (
                    <div key={v.id} className="border border-gray-100 rounded-xl overflow-hidden">
                      <button type="button" onClick={() => setExpanded((s) => { const n = new Set(s); if (n.has(v.id)) n.delete(v.id); else n.add(v.id); return n; })} className="flex items-center gap-2 w-full px-3 py-2 text-left hover:bg-gray-50/70">
                        <span className={`inline-flex px-1.5 py-0.5 rounded border text-[10px] font-bold uppercase ${IMPACT_COLOR[v.impact] || IMPACT_COLOR.unknown}`}>{v.impact}</span>
                        <span className="text-[12.5px] font-semibold text-gray-800">{v.help}</span>
                        <span className="text-[11px] text-gray-400">×{v.nodeCount}</span>
                        <ChevronDown className={`ml-auto w-4 h-4 text-gray-300 transition-transform ${isOpen ? 'rotate-180' : ''}`} />
                      </button>
                      {isOpen && (
                        <div className="px-3 pb-3 space-y-2 border-t border-gray-50">
                          <p className="text-[11.5px] text-gray-500 mt-2">{v.description}</p>
                          <div className="flex flex-wrap items-center gap-1.5">
                            {v.wcagTags.map((t) => <span key={t} className="text-[10px] font-mono text-gray-400 bg-gray-50 border border-gray-100 rounded px-1">{t}</span>)}
                            <a href={v.helpUrl} target="_blank" rel="noreferrer" className="ml-auto text-[11px] text-[#6D28D9] hover:underline inline-flex items-center gap-0.5">how to fix <ExternalLink className="w-3 h-3" /></a>
                          </div>
                          {v.sampleNodes.map((n, i) => (
                            <div key={i} className="rounded-lg bg-gray-50 border border-gray-100 overflow-hidden">
                              {n.target && (
                                <div className="flex items-center gap-2 px-2 py-1 border-b border-gray-100">
                                  <code className="text-[10.5px] font-mono text-[#6D28D9] truncate flex-1 min-w-0">{n.target}</code>
                                  <button type="button" onClick={() => copySel(n.target, `${v.id}-${i}`)} className="inline-flex items-center gap-0.5 text-[10.5px] text-gray-500 hover:text-[#7C3AED]">
                                    {copied === `${v.id}-${i}` ? <Check className="w-3 h-3 text-emerald-600" /> : <Copy className="w-3 h-3" />}{copied === `${v.id}-${i}` ? 'Copied' : 'Selector'}
                                  </button>
                                </div>
                              )}
                              <pre className="text-[10.5px] font-mono text-gray-600 p-2 overflow-x-auto">{n.html}</pre>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })}
                {shown.length === 0 && <p className="text-[12px] text-gray-400 text-center py-4">No rules match this filter.</p>}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function SkeletonReport() {
  return (
    <div className={`${CARD} p-4`}>
      <div className="flex items-center gap-5">
        <div className="w-[104px] h-[104px] rounded-full bg-gray-100 animate-pulse" />
        <div className="flex-1 space-y-2">
          <div className="h-5 w-2/3 bg-gray-100 rounded animate-pulse" />
          <div className="h-5 w-1/2 bg-gray-100 rounded animate-pulse" />
          <div className="h-5 w-1/3 bg-gray-100 rounded animate-pulse" />
        </div>
      </div>
    </div>
  );
}

/* ══════════ Visual + cross-browser ══════════ */
function VisualPanel() {
  const [url, setUrl] = useState('');
  const [engines, setEngines] = useState<WebEngine[]>(['chromium']);
  const [viewports, setViewports] = useState<string[]>(['desktop']);
  const [fullPage, setFullPage] = useState(false);
  const [report, setReport] = useState<VisualCaptureReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const { recents, remember } = useRecentUrls('visual');
  // regression
  const [rEngine, setREngine] = useState<WebEngine>('chromium');
  const [rViewport, setRViewport] = useState('desktop');
  const [cmp, setCmp] = useState<VisualCompareResult | null>(null);
  const [baselines, setBaselines] = useState<VisualBaseline[]>([]);
  const [rBusy, setRBusy] = useState(false);
  const [rError, setRError] = useState('');
  const [box, setBox] = useState<{ png: string; name: string } | null>(null);
  const VP = ['desktop', 'laptop', 'tablet', 'mobile'];

  const refreshBaselines = async () => { try { setBaselines((await listWebVisualBaselines()).baselines); } catch { /* ignore */ } };
  useEffect(() => { void refreshBaselines(); }, []);
  const toggle = <T,>(arr: T[], set: (v: T[]) => void, v: T) => set(arr.includes(v) ? arr.filter((x) => x !== v) : [...arr, v]);

  const capture = async () => {
    setLoading(true); setError(''); setReport(null);
    try { const r = await webVisualCapture({ url, engines, viewports, fullPage }); setReport(r); remember(url); }
    catch (e) { setError(errMsg(e)); }
    finally { setLoading(false); }
  };
  const setBaseline = async () => {
    setRBusy(true); setRError('');
    try { await captureWebVisualBaseline({ url, engine: rEngine, viewport: rViewport, fullPage }); await refreshBaselines(); setCmp(null); }
    catch (e) { setRError(errMsg(e)); }
    finally { setRBusy(false); }
  };
  const compare = async () => {
    setRBusy(true); setRError(''); setCmp(null);
    try { setCmp(await compareWebVisual({ url, engine: rEngine, viewport: rViewport, fullPage })); }
    catch (e) { setRError(errMsg(e)); }
    finally { setRBusy(false); }
  };
  const delBaseline = async (id: string) => { await deleteWebVisualBaseline(id); await refreshBaselines(); };

  return (
    <div className="space-y-3">
      <div className={`${CARD} p-4 space-y-3`}>
        <ScanBar url={url} setUrl={setUrl} recents={recents} onRun={() => void capture()} running={loading} disabled={!engines.length} cta="Capture" icon={Camera} />
        <div className="flex flex-wrap gap-4">
          <div><span className="text-[11px] font-semibold text-gray-500 mr-2">Engines</span>{ENGINES.map((e) => <button key={e} type="button" onClick={() => toggle(engines, setEngines, e)} className={`${CHIP(engines.includes(e))} mr-1`}>{ENGINE_LABEL[e]}</button>)}</div>
          <div><span className="text-[11px] font-semibold text-gray-500 mr-2">Viewports</span>{VP.map((v) => <button key={v} type="button" onClick={() => toggle(viewports, setViewports, v)} className={`${CHIP(viewports.includes(v))} mr-1`}>{v}</button>)}</div>
          <label className="flex items-center gap-1.5 text-[11.5px] text-gray-600"><input type="checkbox" checked={fullPage} onChange={(e) => setFullPage(e.target.checked)} />full page</label>
        </div>
        <p className="text-[10.5px] text-gray-400">Firefox / WebKit must be installed on the server (<code className="font-mono">npx playwright install firefox webkit</code>); unavailable engines are flagged, not failed.</p>
        {error && <ErrorBox msg={error} />}
      </div>

      {!report && !loading && !error && (
        <div className={CARD}><EmptyState icon={Images} title="Capture screenshots across browsers & viewports" hint="Pick engines and viewports, then capture. Hover any shot to zoom or download the PNG." /></div>
      )}

      {report && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {report.cells.map((c, i) => (
            <ShotTile
              key={i}
              png={c.ok ? c.pngBase64 : undefined}
              alt={`${c.engine} ${c.viewport}`}
              name={`${slug(report.url)}-${c.engine}-${c.viewport}`}
              header={<>
                <span className="font-semibold text-gray-700">{c.engineLabel}</span><span className="text-gray-400">{c.viewport}</span>
                {c.ok ? <span className="ml-auto text-gray-400 font-mono">{c.width}×{c.height}</span> : <span className={`ml-auto ${c.unavailable ? 'text-amber-600' : 'text-red-500'}`}>{c.unavailable ? 'not installed' : 'failed'}</span>}
              </>}
            />
          ))}
        </div>
      )}

      {/* Visual regression */}
      <div className={`${CARD} p-4 space-y-3`}>
        <div className="flex items-center gap-2"><GitCompare className="w-4 h-4 text-[#7C3AED]" /><h3 className="text-[13px] font-semibold text-gray-900">Visual regression</h3><span className="text-[11px] text-gray-400">baseline → diff</span></div>
        <div className="flex flex-wrap items-end gap-2">
          <select value={rEngine} onChange={(e) => setREngine(e.target.value as WebEngine)} className={`${INPUT} w-auto`}>{ENGINES.map((e) => <option key={e} value={e}>{ENGINE_LABEL[e]}</option>)}</select>
          <select value={rViewport} onChange={(e) => setRViewport(e.target.value)} className={`${INPUT} w-auto`}>{VP.map((v) => <option key={v} value={v}>{v}</option>)}</select>
          <button type="button" onClick={() => void setBaseline()} disabled={rBusy || !url.trim()} className={GHOST_BTN}><Camera className="w-3.5 h-3.5" />Set baseline</button>
          <button type="button" onClick={() => void compare()} disabled={rBusy || !url.trim()} className={BTN}>{rBusy ? <Spinner className="w-3.5 h-3.5 animate-spin" /> : <GitCompare className="w-3.5 h-3.5" />}Compare</button>
        </div>
        {rError && <ErrorBox msg={rError} />}
        {cmp && (cmp.hasBaseline ? (
          <div className="space-y-2">
            <div className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md border text-[12px] font-semibold ${cmp.matched ? 'text-emerald-700 bg-emerald-50 border-emerald-200' : 'text-red-700 bg-red-50 border-red-200'}`}>
              {cmp.matched ? <><Check className="w-3.5 h-3.5" />Pixel-identical</> : cmp.reason === 'size-changed' ? 'Dimensions changed' : `${(cmp.diffRatio * 100).toFixed(2)}% different (${cmp.diffPixels.toLocaleString()} px)`}
            </div>
            {!cmp.matched && cmp.reason !== 'size-changed' && (
              <div className="h-1.5 w-full max-w-xs rounded-full bg-gray-100 overflow-hidden">
                <div className="h-full rounded-full bg-gradient-to-r from-amber-400 to-red-500" style={{ width: `${Math.max(2, Math.min(100, cmp.diffRatio * 100))}%` }} />
              </div>
            )}
            <div className="grid grid-cols-3 gap-2">
              {([['Baseline', cmp.baselinePng], ['Current', cmp.currentPng], ['Diff', cmp.diffPng]] as const).map(([lbl, png]) => (
                <div key={lbl} className="border border-gray-100 rounded-lg overflow-hidden group relative">
                  <div className="px-2 py-1 text-[10.5px] text-gray-500 border-b border-gray-100">{lbl}</div>
                  {png ? <>
                    <img src={`data:image/png;base64,${png}`} alt={lbl} className="w-full max-h-64 object-contain object-top bg-gray-50" />
                    <button type="button" onClick={() => setBox({ png, name: `${slug(cmp.url)}-${lbl.toLowerCase()}` })} className="absolute top-7 right-1 opacity-0 group-hover:opacity-100 inline-flex items-center justify-center w-6 h-6 rounded bg-white/90 text-gray-700 hover:bg-white transition-opacity"><Maximize2 className="w-3.5 h-3.5" /></button>
                  </> : <div className="p-2 text-[10px] text-gray-400">—</div>}
                </div>
              ))}
            </div>
          </div>
        ) : <p className="text-[12px] text-amber-600">No baseline yet for this URL + {ENGINE_LABEL[cmp.engine]} + {cmp.viewport}. Click “Set baseline” first.</p>)}
        {baselines.length > 0 && (
          <div className="pt-1">
            <div className="text-[11px] font-semibold text-gray-500 mb-1">Stored baselines</div>
            <div className="space-y-1">
              {baselines.slice(0, 12).map((b) => (
                <div key={b.id} className="flex items-center gap-2 text-[11px] text-gray-600">
                  <span className="font-mono truncate flex-1 min-w-0" title={b.url}>{b.url}</span>
                  <span className="text-gray-400">{ENGINE_LABEL[b.engine]} · {b.viewport} · {b.width}×{b.height}</span>
                  <button type="button" onClick={() => void delBaseline(b.id)} className="p-0.5 text-gray-400 hover:text-red-500"><Trash2 className="w-3.5 h-3.5" /></button>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
      {box && <Lightbox src={box.png} name={box.name} onClose={() => setBox(null)} />}
    </div>
  );
}

/* ══════════ Responsive / device ══════════ */
const DEVICE_GROUPS: { label: string; match: (d: string) => boolean }[] = [
  { label: 'Phones', match: (d) => /iphone|pixel|galaxy|phone/i.test(d) },
  { label: 'Tablets', match: (d) => /ipad|tablet|nexus (7|9|10)/i.test(d) },
  { label: 'Desktops', match: (d) => /desktop/i.test(d) },
];
function ResponsivePanel() {
  const [url, setUrl] = useState('');
  const [devices, setDevices] = useState<string[]>([]);
  const [selected, setSelected] = useState<string[]>(['iPhone 13', 'iPad (gen 7)', 'Desktop Chrome']);
  const [report, setReport] = useState<DeviceReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const { recents, remember } = useRecentUrls('responsive');
  useEffect(() => { listWebDevices().then((d) => setDevices(d.devices)).catch(() => {}); }, []);
  const toggle = (d: string) => setSelected((s) => s.includes(d) ? s.filter((x) => x !== d) : [...s, d]);
  const selectGroup = (match: (d: string) => boolean) => {
    const g = devices.filter(match);
    const allOn = g.every((d) => selected.includes(d));
    setSelected((s) => allOn ? s.filter((d) => !g.includes(d)) : Array.from(new Set([...s, ...g])));
  };
  const run = async () => {
    setLoading(true); setError(''); setReport(null);
    try { const r = await captureWebDevices({ url, devices: selected }); setReport(r); remember(url); }
    catch (e) { setError(errMsg(e)); }
    finally { setLoading(false); }
  };
  return (
    <div className="space-y-3">
      <div className={`${CARD} p-4 space-y-3`}>
        <ScanBar url={url} setUrl={setUrl} recents={recents} onRun={() => void run()} running={loading} disabled={!selected.length} cta={`Capture (${selected.length})`} />
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[11px] font-semibold text-gray-500">Quick:</span>
          {DEVICE_GROUPS.map((g) => <button key={g.label} type="button" onClick={() => selectGroup(g.match)} className="px-2 py-0.5 text-[11px] font-medium text-[#6D28D9] bg-[#F5F3FF] border border-[#DDD6FE] rounded-full hover:bg-[#EDE9FE]">{g.label}</button>)}
          {selected.length > 0 && <button type="button" onClick={() => setSelected([])} className="px-2 py-0.5 text-[11px] text-gray-400 hover:text-red-500">Clear</button>}
        </div>
        <div className="flex flex-wrap gap-1.5">
          {devices.map((d) => <button key={d} type="button" onClick={() => toggle(d)} className={CHIP(selected.includes(d))}>{d}</button>)}
        </div>
        {error && <ErrorBox msg={error} />}
      </div>
      {!report && !loading && !error && (
        <div className={CARD}><EmptyState icon={Smartphone} title="Preview a page across real device profiles" hint="Pick devices (or a quick group), then capture. Hover a shot to zoom or download." /></div>
      )}
      {report && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {report.cells.map((c, i) => (
            <ShotTile
              key={i}
              png={c.ok ? c.pngBase64 : undefined}
              alt={c.device}
              name={`${slug(report.url)}-${slug(c.device)}`}
              maxH="max-h-96"
              header={<>
                <Smartphone className="w-3.5 h-3.5 text-gray-400" /><span className="font-semibold text-gray-700 truncate">{c.device}</span>
                {c.ok ? <span className="ml-auto text-gray-400 font-mono">{c.width}×{c.height}{c.isMobile ? ' 📱' : ''}</span> : <span className="ml-auto text-red-500">failed</span>}
              </>}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/* ══════════ Performance ══════════ */
const RATING_SCORE: Record<string, number> = { good: 100, 'needs-improvement': 60, poor: 25 };
function PerformancePanel() {
  const [url, setUrl] = useState('');
  const [report, setReport] = useState<PerfReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const { recents, remember } = useRecentUrls('perf');
  const run = async () => {
    setLoading(true); setError(''); setReport(null);
    try { const r = await captureWebPerformance({ url }); setReport(r); remember(url); }
    catch (e) { setError(errMsg(e)); }
    finally { setLoading(false); }
  };
  const fmtBytes = (b: number) => b > 1e6 ? `${(b / 1e6).toFixed(1)} MB` : `${Math.round(b / 1024)} KB`;
  const score = useMemo(() => {
    if (!report) return 0;
    const rated = report.metrics.filter((m) => m.rating in RATING_SCORE);
    if (!rated.length) return 0;
    return Math.round(rated.reduce((s, m) => s + RATING_SCORE[m.rating], 0) / rated.length);
  }, [report]);

  return (
    <div className="space-y-3">
      <div className={`${CARD} p-4 space-y-3`}>
        <ScanBar url={url} setUrl={setUrl} recents={recents} onRun={() => void run()} running={loading} cta="Measure" />
        {error && <ErrorBox msg={error} />}
      </div>
      {!report && !loading && !error && (
        <div className={CARD}><EmptyState icon={Gauge} title="Measure Core Web Vitals" hint="Loads the page in a headless browser and reports LCP, CLS, TTFB and friends, plus the resource weight breakdown." /></div>
      )}
      {report && (
        <>
          <div className={`${CARD} p-4`}>
            <div className="flex items-center gap-5 flex-wrap">
              <PassRing value={score} label="perf score" />
              <div>
                <span className={`inline-flex px-2.5 py-1 rounded-md border text-[12px] font-semibold ${RATING_COLOR[report.overall]}`}>Core Web Vitals: {report.overall}</span>
                <p className="text-[11px] text-gray-400 mt-1">{report.resources.total} requests · {fmtBytes(report.resources.transferBytes)} transferred</p>
              </div>
              <span className="ml-auto text-[11px] text-gray-400">{report.engineLabel}</span>
            </div>
          </div>
          <div className={`${CARD} p-4 space-y-3`}>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
              {report.metrics.map((m) => (
                <div key={m.key} className={`rounded-xl border p-3 ${RATING_COLOR[m.rating]}`}>
                  <div className="text-[10.5px] uppercase tracking-wide opacity-70">{m.label}</div>
                  <div className="text-[20px] font-bold tabular-nums">{m.value == null ? '—' : m.key === 'cls' ? m.value : `${m.value}${m.unit}`}</div>
                  <div className="text-[10px] font-medium capitalize opacity-70">{m.rating.replace('-', ' ')}</div>
                </div>
              ))}
            </div>
          </div>
          <div className={`${CARD} p-4 space-y-2`}>
            <div className="flex items-center gap-2"><Sparkles className="w-3.5 h-3.5 text-[#7C3AED]" /><h3 className="text-[12.5px] font-semibold text-gray-900">Resource weight</h3><span className="text-[11px] text-gray-400 ml-auto">{fmtBytes(report.resources.transferBytes)} total</span></div>
            <div className="flex h-3 w-full rounded-full overflow-hidden bg-gray-100">
              {report.resources.byType.map((r, i) => {
                const pct = report.resources.transferBytes > 0 ? (r.bytes / report.resources.transferBytes) * 100 : 0;
                return pct > 0 ? <div key={r.type} title={`${r.type}: ${fmtBytes(r.bytes)}`} style={{ width: `${pct}%`, background: RES_PALETTE[i % RES_PALETTE.length] }} /> : null;
              })}
            </div>
            <div className="flex flex-wrap gap-x-3 gap-y-1">
              {report.resources.byType.map((r, i) => (
                <span key={r.type} className="inline-flex items-center gap-1.5 text-[11px] text-gray-600">
                  <span className="w-2.5 h-2.5 rounded-sm" style={{ background: RES_PALETTE[i % RES_PALETTE.length] }} />
                  {r.type} <span className="font-mono text-gray-400">{r.count} · {fmtBytes(r.bytes)}</span>
                </span>
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

/* ══════════ Page shell ══════════ */
export default function WebLabPage() {
  const [tab, setTab] = useState('accessibility');
  const tabs = useMemo(() => [
    { id: 'accessibility', label: 'Accessibility', icon: Accessibility },
    { id: 'visual', label: 'Visual', icon: Images },
    { id: 'responsive', label: 'Responsive', icon: Smartphone },
    { id: 'performance', label: 'Performance', icon: Gauge },
  ], []);
  return (
    <div className="space-y-4">
      <TabHero
        icon={MonitorSmartphone}
        title="Web Lab"
        subtitle="Browser quality tools — accessibility, visual & cross-browser, responsive, performance."
        actions={<span className="hidden sm:inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-white/15 border border-white/25 text-[11px] font-medium text-white/90 backdrop-blur-sm"><Sparkles className="w-3.5 h-3.5" />Playwright-powered</span>}
      />
      <PageTabs tabs={tabs} active={tab} onChange={setTab} ariaLabel="Web Lab tools" />
      <div role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`}>
        {tab === 'accessibility' && <AccessibilityPanel />}
        {tab === 'visual' && <VisualPanel />}
        {tab === 'responsive' && <ResponsivePanel />}
        {tab === 'performance' && <PerformancePanel />}
      </div>
    </div>
  );
}
