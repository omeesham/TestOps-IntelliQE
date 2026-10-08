/**
 * WebLabPage — opt-in browser quality tools for Web automation.
 *
 * Four standalone tools, each driving a headless browser server-side, none of
 * which touch the generate → execute → heal pipeline:
 *   • Accessibility — axe-core WCAG scan
 *   • Visual        — cross-browser / cross-viewport screenshots + regression
 *   • Responsive    — device-emulation preview
 *   • Performance   — Core Web Vitals
 */
import { useEffect, useMemo, useState } from 'react';
import {
  Accessibility, Images, Smartphone, Gauge, Play, AlertTriangle, ExternalLink, Camera, GitCompare, Trash2, Check,
} from 'lucide-react';
import Spinner from '@/components/feedback/Spinner';
import PageTabs from '@/components/ui/PageTabs';
import {
  runWebAccessibility, webVisualCapture, captureWebVisualBaseline, compareWebVisual, listWebVisualBaselines, deleteWebVisualBaseline,
  listWebDevices, captureWebDevices, captureWebPerformance,
  type A11yReport, type VisualCaptureReport, type VisualCompareResult, type VisualBaseline, type DeviceReport, type PerfReport, type WebEngine,
} from '@/services/api';

/* ── shared bits ── */
const CARD = 'bg-white rounded-xl border border-gray-100 shadow-sm';
const INPUT = 'w-full px-3 py-2 text-[13px] border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-[#A5B4FC] focus:border-[#7C3AED]';
const BTN = 'inline-flex items-center gap-1.5 px-3.5 py-2 text-[13px] font-semibold text-white bg-gradient-to-r from-[#7C3AED] to-[#6366F1] rounded-lg shadow-sm disabled:opacity-40 transition-all';
const CHIP = (on: boolean) => `px-2.5 py-1 rounded-full border text-[11.5px] font-medium cursor-pointer select-none transition-colors ${on ? 'bg-[#7C3AED] text-white border-[#7C3AED]' : 'bg-white text-gray-600 border-gray-200 hover:border-[#C4B5FD]'}`;
const ENGINES: WebEngine[] = ['chromium', 'firefox', 'webkit'];
const ENGINE_LABEL: Record<WebEngine, string> = { chromium: 'Chromium', firefox: 'Firefox', webkit: 'WebKit' };

function ErrorBox({ msg }: { msg: string }) {
  return <div className="flex items-start gap-2 px-3 py-2 bg-red-50 border border-red-200 rounded-lg"><AlertTriangle className="w-4 h-4 text-red-500 flex-shrink-0 mt-px" /><p className="text-[12px] text-red-700 min-w-0">{msg}</p></div>;
}
function UrlRow({ url, setUrl, placeholder }: { url: string; setUrl: (v: string) => void; placeholder?: string }) {
  return <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder={placeholder || 'https://app.example.com'} className={INPUT} />;
}
const RATING_COLOR: Record<string, string> = { good: 'text-emerald-600 bg-emerald-50 border-emerald-200', 'needs-improvement': 'text-amber-600 bg-amber-50 border-amber-200', poor: 'text-red-600 bg-red-50 border-red-200', na: 'text-gray-400 bg-gray-50 border-gray-200' };
const IMPACT_COLOR: Record<string, string> = { critical: 'text-red-700 bg-red-50 border-red-200', serious: 'text-orange-700 bg-orange-50 border-orange-200', moderate: 'text-amber-700 bg-amber-50 border-amber-200', minor: 'text-gray-600 bg-gray-50 border-gray-200', unknown: 'text-gray-500 bg-gray-50 border-gray-200' };
const errMsg = (e: any) => e?.response?.data?.error || e?.message || 'Request failed.';

/* ══════════ Accessibility ══════════ */
function AccessibilityPanel() {
  const [url, setUrl] = useState('');
  const [standard, setStandard] = useState('wcag21aa');
  const [report, setReport] = useState<A11yReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const run = async () => {
    setLoading(true); setError(''); setReport(null);
    try { setReport(await runWebAccessibility({ url, standard })); }
    catch (e: any) { setError(errMsg(e)); }
    finally { setLoading(false); }
  };
  return (
    <div className="space-y-3">
      <div className={`${CARD} p-4 space-y-3`}>
        <div className="flex flex-wrap items-end gap-2">
          <div className="flex-1 min-w-[260px]"><label className="block text-[11px] font-semibold text-gray-500 mb-1">URL to scan</label><UrlRow url={url} setUrl={setUrl} /></div>
          <div><label className="block text-[11px] font-semibold text-gray-500 mb-1">Standard</label>
            <select value={standard} onChange={(e) => setStandard(e.target.value)} className={INPUT}>
              <option value="wcag2a">WCAG 2.0 A</option><option value="wcag2aa">WCAG 2.0 AA</option>
              <option value="wcag21aa">WCAG 2.1 AA</option><option value="wcag22aa">WCAG 2.2 AA</option>
              <option value="best-practice">+ Best practices</option>
            </select>
          </div>
          <button type="button" onClick={() => void run()} disabled={loading || !url.trim()} className={BTN}>{loading ? <Spinner className="w-3.5 h-3.5 animate-spin" /> : <Play className="w-3.5 h-3.5" />}Scan</button>
        </div>
        {error && <ErrorBox msg={error} />}
      </div>
      {report && (
        <div className={`${CARD} p-4 space-y-3`}>
          <div className="flex items-center gap-4">
            <div className="text-center">
              <div className={`text-3xl font-bold tabular-nums ${report.summary.score >= 90 ? 'text-emerald-600' : report.summary.score >= 70 ? 'text-amber-600' : 'text-red-600'}`}>{report.summary.score}</div>
              <div className="text-[10px] text-gray-400 uppercase tracking-wide">score</div>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {(['critical', 'serious', 'moderate', 'minor'] as const).map((k) => (
                <span key={k} className={`inline-flex items-center gap-1 px-2 py-1 rounded-md border text-[11.5px] font-medium ${IMPACT_COLOR[k]}`}>{report.summary.byImpact[k] || 0} {k}</span>
              ))}
              <span className="inline-flex items-center gap-1 px-2 py-1 rounded-md border text-[11.5px] text-gray-500 bg-gray-50 border-gray-200">{report.summary.passes} passed · {report.summary.incomplete} needs review</span>
            </div>
            <span className="ml-auto text-[11px] text-gray-400">{report.standardLabel} · {report.engineLabel}</span>
          </div>
          {report.violations.length === 0 ? (
            <p className="text-[13px] text-emerald-700 font-medium">No violations found for {report.standardLabel}. 🎉</p>
          ) : (
            <div className="space-y-2">
              {report.violations.map((v) => (
                <div key={v.id} className="border border-gray-100 rounded-lg p-3">
                  <div className="flex items-center gap-2">
                    <span className={`inline-flex px-1.5 py-0.5 rounded border text-[10px] font-bold uppercase ${IMPACT_COLOR[v.impact] || IMPACT_COLOR.unknown}`}>{v.impact}</span>
                    <span className="text-[12.5px] font-semibold text-gray-800">{v.help}</span>
                    <span className="text-[11px] text-gray-400">×{v.nodeCount}</span>
                    <a href={v.helpUrl} target="_blank" rel="noreferrer" className="ml-auto text-[11px] text-[#6D28D9] hover:underline inline-flex items-center gap-0.5">rule <ExternalLink className="w-3 h-3" /></a>
                  </div>
                  <p className="text-[11.5px] text-gray-500 mt-1">{v.description}</p>
                  {v.wcagTags.length > 0 && <div className="flex flex-wrap gap-1 mt-1.5">{v.wcagTags.map((t) => <span key={t} className="text-[10px] font-mono text-gray-400 bg-gray-50 border border-gray-100 rounded px-1">{t}</span>)}</div>}
                  {v.sampleNodes[0] && <pre className="mt-1.5 text-[10.5px] font-mono text-gray-600 bg-gray-50 rounded p-2 overflow-x-auto">{v.sampleNodes[0].html}</pre>}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
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
  // regression
  const [rEngine, setREngine] = useState<WebEngine>('chromium');
  const [rViewport, setRViewport] = useState('desktop');
  const [cmp, setCmp] = useState<VisualCompareResult | null>(null);
  const [baselines, setBaselines] = useState<VisualBaseline[]>([]);
  const [rBusy, setRBusy] = useState(false);
  const [rError, setRError] = useState('');
  const VP = ['desktop', 'laptop', 'tablet', 'mobile'];

  const refreshBaselines = async () => { try { setBaselines((await listWebVisualBaselines()).baselines); } catch { /* ignore */ } };
  useEffect(() => { void refreshBaselines(); }, []);

  const toggle = <T,>(arr: T[], set: (v: T[]) => void, v: T) => set(arr.includes(v) ? arr.filter((x) => x !== v) : [...arr, v]);

  const capture = async () => {
    setLoading(true); setError(''); setReport(null);
    try { setReport(await webVisualCapture({ url, engines, viewports, fullPage })); }
    catch (e: any) { setError(errMsg(e)); }
    finally { setLoading(false); }
  };
  const setBaseline = async () => {
    setRBusy(true); setRError('');
    try { await captureWebVisualBaseline({ url, engine: rEngine, viewport: rViewport, fullPage }); await refreshBaselines(); setCmp(null); }
    catch (e: any) { setRError(errMsg(e)); }
    finally { setRBusy(false); }
  };
  const compare = async () => {
    setRBusy(true); setRError(''); setCmp(null);
    try { setCmp(await compareWebVisual({ url, engine: rEngine, viewport: rViewport, fullPage })); }
    catch (e: any) { setRError(errMsg(e)); }
    finally { setRBusy(false); }
  };
  const delBaseline = async (id: string) => { await deleteWebVisualBaseline(id); await refreshBaselines(); };

  return (
    <div className="space-y-3">
      <div className={`${CARD} p-4 space-y-3`}>
        <div className="flex flex-wrap items-end gap-2">
          <div className="flex-1 min-w-[260px]"><label className="block text-[11px] font-semibold text-gray-500 mb-1">URL</label><UrlRow url={url} setUrl={setUrl} /></div>
          <button type="button" onClick={() => void capture()} disabled={loading || !url.trim() || !engines.length} className={BTN}>{loading ? <Spinner className="w-3.5 h-3.5 animate-spin" /> : <Camera className="w-3.5 h-3.5" />}Capture</button>
        </div>
        <div className="flex flex-wrap gap-4">
          <div><span className="text-[11px] font-semibold text-gray-500 mr-2">Engines</span>{ENGINES.map((e) => <button key={e} type="button" onClick={() => toggle(engines, setEngines, e)} className={`${CHIP(engines.includes(e))} mr-1`}>{ENGINE_LABEL[e]}</button>)}</div>
          <div><span className="text-[11px] font-semibold text-gray-500 mr-2">Viewports</span>{VP.map((v) => <button key={v} type="button" onClick={() => toggle(viewports, setViewports, v)} className={`${CHIP(viewports.includes(v))} mr-1`}>{v}</button>)}</div>
          <label className="flex items-center gap-1.5 text-[11.5px] text-gray-600"><input type="checkbox" checked={fullPage} onChange={(e) => setFullPage(e.target.checked)} />full page</label>
        </div>
        <p className="text-[10.5px] text-gray-400">Firefox / WebKit must be installed on the server (<code className="font-mono">npx playwright install firefox webkit</code>); unavailable engines are flagged, not failed.</p>
        {error && <ErrorBox msg={error} />}
      </div>

      {report && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {report.cells.map((c, i) => (
            <div key={i} className={`${CARD} overflow-hidden`}>
              <div className="flex items-center gap-2 px-3 py-1.5 border-b border-gray-100 text-[11.5px]">
                <span className="font-semibold text-gray-700">{c.engineLabel}</span><span className="text-gray-400">{c.viewport}</span>
                {c.ok ? <span className="ml-auto text-gray-400 font-mono">{c.width}×{c.height}</span> : <span className={`ml-auto ${c.unavailable ? 'text-amber-600' : 'text-red-500'}`}>{c.unavailable ? 'not installed' : 'failed'}</span>}
              </div>
              {c.ok && c.pngBase64 ? <img src={`data:image/png;base64,${c.pngBase64}`} alt={`${c.engine} ${c.viewport}`} className="w-full max-h-72 object-contain object-top bg-gray-50" />
                : <div className="p-3 text-[11px] text-gray-400">{c.error}</div>}
            </div>
          ))}
        </div>
      )}

      {/* Visual regression */}
      <div className={`${CARD} p-4 space-y-3`}>
        <div className="flex items-center gap-2"><GitCompare className="w-4 h-4 text-[#7C3AED]" /><h3 className="text-[13px] font-semibold text-gray-900">Visual regression</h3><span className="text-[11px] text-gray-400">baseline → diff</span></div>
        <div className="flex flex-wrap items-end gap-2">
          <select value={rEngine} onChange={(e) => setREngine(e.target.value as WebEngine)} className={`${INPUT} w-auto`}>{ENGINES.map((e) => <option key={e} value={e}>{ENGINE_LABEL[e]}</option>)}</select>
          <select value={rViewport} onChange={(e) => setRViewport(e.target.value)} className={`${INPUT} w-auto`}>{VP.map((v) => <option key={v} value={v}>{v}</option>)}</select>
          <button type="button" onClick={() => void setBaseline()} disabled={rBusy || !url.trim()} className="inline-flex items-center gap-1.5 px-3 py-2 text-[12.5px] font-medium text-gray-700 bg-white border border-gray-200 rounded-lg hover:bg-gray-50 disabled:opacity-40"><Camera className="w-3.5 h-3.5" />Set baseline</button>
          <button type="button" onClick={() => void compare()} disabled={rBusy || !url.trim()} className={BTN}>{rBusy ? <Spinner className="w-3.5 h-3.5 animate-spin" /> : <GitCompare className="w-3.5 h-3.5" />}Compare</button>
        </div>
        {rError && <ErrorBox msg={rError} />}
        {cmp && (cmp.hasBaseline ? (
          <div className="space-y-2">
            <div className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md border text-[12px] font-semibold ${cmp.matched ? 'text-emerald-700 bg-emerald-50 border-emerald-200' : 'text-red-700 bg-red-50 border-red-200'}`}>
              {cmp.matched ? <><Check className="w-3.5 h-3.5" />Pixel-identical</> : cmp.reason === 'size-changed' ? 'Dimensions changed' : `${(cmp.diffRatio * 100).toFixed(2)}% different (${cmp.diffPixels.toLocaleString()} px)`}
            </div>
            <div className="grid grid-cols-3 gap-2">
              {([['Baseline', cmp.baselinePng], ['Current', cmp.currentPng], ['Diff', cmp.diffPng]] as const).map(([lbl, png]) => (
                <div key={lbl} className="border border-gray-100 rounded-lg overflow-hidden">
                  <div className="px-2 py-1 text-[10.5px] text-gray-500 border-b border-gray-100">{lbl}</div>
                  {png ? <img src={`data:image/png;base64,${png}`} alt={lbl} className="w-full max-h-64 object-contain object-top bg-gray-50" /> : <div className="p-2 text-[10px] text-gray-400">—</div>}
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
    </div>
  );
}

/* ══════════ Responsive / device ══════════ */
function ResponsivePanel() {
  const [url, setUrl] = useState('');
  const [devices, setDevices] = useState<string[]>([]);
  const [selected, setSelected] = useState<string[]>(['iPhone 13', 'iPad (gen 7)', 'Desktop Chrome']);
  const [report, setReport] = useState<DeviceReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => { listWebDevices().then((d) => setDevices(d.devices)).catch(() => {}); }, []);
  const toggle = (d: string) => setSelected((s) => s.includes(d) ? s.filter((x) => x !== d) : [...s, d]);
  const run = async () => {
    setLoading(true); setError(''); setReport(null);
    try { setReport(await captureWebDevices({ url, devices: selected })); }
    catch (e: any) { setError(errMsg(e)); }
    finally { setLoading(false); }
  };
  return (
    <div className="space-y-3">
      <div className={`${CARD} p-4 space-y-3`}>
        <div className="flex flex-wrap items-end gap-2">
          <div className="flex-1 min-w-[260px]"><label className="block text-[11px] font-semibold text-gray-500 mb-1">URL</label><UrlRow url={url} setUrl={setUrl} /></div>
          <button type="button" onClick={() => void run()} disabled={loading || !url.trim() || !selected.length} className={BTN}>{loading ? <Spinner className="w-3.5 h-3.5 animate-spin" /> : <Play className="w-3.5 h-3.5" />}Capture ({selected.length})</button>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {devices.map((d) => <button key={d} type="button" onClick={() => toggle(d)} className={CHIP(selected.includes(d))}>{d}</button>)}
        </div>
        {error && <ErrorBox msg={error} />}
      </div>
      {report && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {report.cells.map((c, i) => (
            <div key={i} className={`${CARD} overflow-hidden`}>
              <div className="flex items-center gap-2 px-3 py-1.5 border-b border-gray-100 text-[11.5px]">
                <Smartphone className="w-3.5 h-3.5 text-gray-400" /><span className="font-semibold text-gray-700 truncate">{c.device}</span>
                {c.ok ? <span className="ml-auto text-gray-400 font-mono">{c.width}×{c.height}{c.isMobile ? ' 📱' : ''}</span> : <span className="ml-auto text-red-500">failed</span>}
              </div>
              {c.ok && c.pngBase64 ? <img src={`data:image/png;base64,${c.pngBase64}`} alt={c.device} className="w-full max-h-96 object-contain object-top bg-gray-50" /> : <div className="p-3 text-[11px] text-gray-400">{c.error}</div>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ══════════ Performance ══════════ */
function PerformancePanel() {
  const [url, setUrl] = useState('');
  const [report, setReport] = useState<PerfReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const run = async () => {
    setLoading(true); setError(''); setReport(null);
    try { setReport(await captureWebPerformance({ url })); }
    catch (e: any) { setError(errMsg(e)); }
    finally { setLoading(false); }
  };
  const fmtBytes = (b: number) => b > 1e6 ? `${(b / 1e6).toFixed(1)} MB` : `${Math.round(b / 1024)} KB`;
  return (
    <div className="space-y-3">
      <div className={`${CARD} p-4 space-y-3`}>
        <div className="flex flex-wrap items-end gap-2">
          <div className="flex-1 min-w-[260px]"><label className="block text-[11px] font-semibold text-gray-500 mb-1">URL</label><UrlRow url={url} setUrl={setUrl} /></div>
          <button type="button" onClick={() => void run()} disabled={loading || !url.trim()} className={BTN}>{loading ? <Spinner className="w-3.5 h-3.5 animate-spin" /> : <Play className="w-3.5 h-3.5" />}Measure</button>
        </div>
        {error && <ErrorBox msg={error} />}
      </div>
      {report && (
        <div className={`${CARD} p-4 space-y-3`}>
          <div className="flex items-center gap-2">
            <span className={`inline-flex px-2.5 py-1 rounded-md border text-[12px] font-semibold ${RATING_COLOR[report.overall]}`}>Core Web Vitals: {report.overall}</span>
            <span className="ml-auto text-[11px] text-gray-400">{report.engineLabel}</span>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
            {report.metrics.map((m) => (
              <div key={m.key} className={`rounded-lg border p-2.5 ${RATING_COLOR[m.rating]}`}>
                <div className="text-[10.5px] uppercase tracking-wide opacity-70">{m.label}</div>
                <div className="text-[18px] font-bold tabular-nums">{m.value == null ? '—' : m.key === 'cls' ? m.value : `${m.value}${m.unit}`}</div>
              </div>
            ))}
          </div>
          <div>
            <div className="text-[11px] font-semibold text-gray-500 mb-1">Resources — {report.resources.total} requests · {fmtBytes(report.resources.transferBytes)}</div>
            <div className="flex flex-wrap gap-1.5">
              {report.resources.byType.map((r) => <span key={r.type} className="inline-flex items-center gap-1 px-2 py-0.5 rounded border border-gray-200 bg-gray-50 text-[11px] text-gray-600">{r.type} <span className="font-mono text-gray-400">{r.count} · {fmtBytes(r.bytes)}</span></span>)}
            </div>
          </div>
        </div>
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
      <div className="flex items-center gap-3">
        <div>
          <h1 className="text-lg font-bold text-[#1E1B4B]">Web Lab</h1>
          <p className="text-[12px] text-gray-500">Browser quality tools — accessibility, visual &amp; cross-browser, responsive, performance.</p>
        </div>
      </div>
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
