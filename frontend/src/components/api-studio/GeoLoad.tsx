/**
 * GeoLoad — distributed / multi-region load generation with an SLA gate.
 *
 * Opt-in and standalone. Fires load at one endpoint from several labelled
 * "regions" — each with its own concurrency, an optional egress proxy and an
 * optional simulated added latency — for a fixed duration, then grades the run
 * against an SLA. Point each region's proxy at a regional forward-proxy to
 * originate traffic from that geography; the added-latency knob approximates
 * distance when you have none. It live-fires the endpoint and changes nothing
 * in the catalogue or the pipeline; write methods require explicit opt-in.
 */
import { useState } from 'react';
import { X, Globe, Play, Plus, Trash2, AlertTriangle, CheckCircle2, XCircle } from 'lucide-react';
import Spinner from '@/components/feedback/Spinner';
import { runGeoLoad, type GeoLoadResult, type GeoRegionInput } from '@/services/api';
import { MethodBadge } from './primitives';
import { CARD, STRIP, INPUT, LABEL, PRIMARY_BTN, formatDuration } from './format';
import type { CatalogEndpoint } from './types';

type Sla = { p95Ms?: number; p99Ms?: number; maxErrorRatePct?: number; minThroughputRps?: number };

const DEFAULT_REGIONS: GeoRegionInput[] = [
  { name: 'us-east', concurrency: 10 },
  { name: 'eu-west', concurrency: 10, addedLatencyMs: 80 },
];

function statusChipClass(code: string): string {
  if (/^2/.test(code)) return 'text-emerald-700 bg-emerald-50 border-emerald-200';
  if (/^[45]/.test(code)) return 'text-red-700 bg-red-50 border-red-200';
  return 'text-gray-600 bg-gray-50 border-gray-200';
}

export default function GeoLoad({ endpoints, onClose }: { endpoints: CatalogEndpoint[]; onClose: () => void }) {
  const [idx, setIdx] = useState(0);
  const [regions, setRegions] = useState<GeoRegionInput[]>(DEFAULT_REGIONS);
  const [durationSec, setDurationSec] = useState(15);
  const [allowWrites, setAllowWrites] = useState(false);
  const [sla, setSla] = useState<Sla>({});
  const [result, setResult] = useState<GeoLoadResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const ep = endpoints.length ? endpoints[Math.min(idx, endpoints.length - 1)] : undefined;

  const setRegion = (i: number, patch: Partial<GeoRegionInput>) => setRegions((prev) => prev.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const addRegion = () => setRegions((prev) => [...prev, { name: '', concurrency: 10 }].slice(0, 8));
  const removeRegion = (i: number) => setRegions((prev) => (prev.length > 1 ? prev.filter((_, j) => j !== i) : prev));
  const slaNum = (v: string): number | undefined => (v.trim() === '' ? undefined : Math.max(0, Number(v)));

  const run = async () => {
    if (!ep) return;
    setLoading(true); setError(''); setResult(null);
    try {
      const slaInput: Sla = {};
      (Object.keys(sla) as (keyof Sla)[]).forEach((k) => { if (sla[k] !== undefined) slaInput[k] = sla[k]; });
      setResult(await runGeoLoad({
        endpoint: { method: ep.method, url: ep.url, headers: ep.headers, auth: ep.auth, body: ep.body },
        regions: regions.map((r) => ({
          name: r.name.trim() || 'region',
          concurrency: r.concurrency,
          addedLatencyMs: r.addedLatencyMs,
          proxyUrl: r.proxyUrl?.trim() || undefined,
        })),
        durationSec,
        sla: Object.keys(slaInput).length ? slaInput : undefined,
        allowWrites,
      }));
    } catch (e: any) {
      setError(e?.response?.data?.error || e?.message || 'Geo load run failed.');
    } finally {
      setLoading(false);
    }
  };

  const t = result?.totals;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-[#1E1B4B]/30 backdrop-blur-sm p-4" onClick={onClose}>
      <div className={`${CARD} w-full max-w-2xl max-h-[88vh] flex flex-col overflow-hidden`} onClick={(e) => e.stopPropagation()}>
        <div className={`flex items-center gap-2 px-4 h-12 border-b border-[#EDE9FE] flex-shrink-0 ${STRIP}`}>
          <Globe className="w-4 h-4 text-[#7C3AED]" />
          <h3 className="text-[13px] font-semibold text-gray-900">Geo / distributed load</h3>
          <span className="text-[11px] text-gray-400">multi-region load with an SLA gate</span>
          <button type="button" onClick={onClose} className="ml-auto p-1.5 rounded-md text-gray-400 hover:text-[#7C3AED] hover:bg-[#F5F3FF]"><X className="w-4 h-4" /></button>
        </div>

        <div className="p-4 space-y-3 overflow-y-auto min-h-0">
          <div>
            <label className={LABEL}>Endpoint</label>
            <select value={idx} onChange={(e) => { setIdx(Number(e.target.value)); setResult(null); }} className={INPUT} disabled={!endpoints.length}>
              {endpoints.length === 0 && <option>No endpoints in the catalogue</option>}
              {endpoints.map((e, i) => <option key={e.id} value={i}>{e.method} {e.url}</option>)}
            </select>
          </div>
          {ep && (
            <div className="flex items-center gap-2 text-[11.5px] text-gray-500">
              <MethodBadge method={ep.method} /><span className="font-mono truncate">{ep.url}</span>
            </div>
          )}

          {/* Regions */}
          <div>
            <label className={LABEL}>Regions — each fires its own concurrency, with an optional egress proxy &amp; added latency</label>
            <div className="space-y-1.5">
              {regions.map((r, i) => (
                <div key={i} className="flex flex-wrap items-center gap-1.5">
                  <input value={r.name} onChange={(e) => setRegion(i, { name: e.target.value })} placeholder="region" className={`${INPUT} w-28 py-1`} />
                  <label className="flex items-center gap-1 text-[11px] text-gray-500">
                    <input type="number" min={1} max={100} value={r.concurrency ?? ''} onChange={(e) => setRegion(i, { concurrency: Math.max(1, Number(e.target.value)) })} className={`${INPUT} w-16 py-1`} /> conc.
                  </label>
                  <label className="flex items-center gap-1 text-[11px] text-gray-500">
                    <input type="number" min={0} value={r.addedLatencyMs ?? ''} onChange={(e) => setRegion(i, { addedLatencyMs: e.target.value.trim() === '' ? undefined : Math.max(0, Number(e.target.value)) })} className={`${INPUT} w-16 py-1`} /> +ms
                  </label>
                  <input value={r.proxyUrl ?? ''} onChange={(e) => setRegion(i, { proxyUrl: e.target.value })} placeholder="proxy url (optional)" className={`${INPUT} flex-1 min-w-[140px] py-1 font-mono text-[11px]`} />
                  <button type="button" onClick={() => removeRegion(i)} disabled={regions.length <= 1} className="p-1 rounded text-gray-400 hover:text-red-500 disabled:opacity-30"><Trash2 className="w-3.5 h-3.5" /></button>
                </div>
              ))}
            </div>
            <button type="button" onClick={addRegion} disabled={regions.length >= 8} className="mt-1.5 inline-flex items-center gap-1 text-[11px] text-[#6D28D9] hover:underline disabled:opacity-40"><Plus className="w-3.5 h-3.5" />Add region</button>
          </div>

          {/* Duration + writes */}
          <div className="flex flex-wrap items-center gap-4">
            <label className="flex items-center gap-2 text-[11.5px] text-gray-600">
              <span className="font-semibold">Duration</span>
              <input type="number" min={1} max={120} value={durationSec} onChange={(e) => setDurationSec(Math.max(1, Number(e.target.value)))} className={`${INPUT} w-20 py-1`} /> sec
            </label>
            <label className="flex items-center gap-2 text-[11.5px] text-gray-600">
              <input type="checkbox" checked={allowWrites} onChange={(e) => setAllowWrites(e.target.checked)} className="w-3.5 h-3.5" />
              Allow writes
            </label>
          </div>

          {/* SLA */}
          <div>
            <label className={LABEL}>SLA gate — leave a field blank to skip that check</label>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
              <label className="text-[11px] text-gray-600">p95 ≤ (ms)
                <input type="number" min={0} value={sla.p95Ms ?? ''} onChange={(e) => setSla((p) => ({ ...p, p95Ms: slaNum(e.target.value) }))} className={`${INPUT} py-1 mt-0.5`} />
              </label>
              <label className="text-[11px] text-gray-600">p99 ≤ (ms)
                <input type="number" min={0} value={sla.p99Ms ?? ''} onChange={(e) => setSla((p) => ({ ...p, p99Ms: slaNum(e.target.value) }))} className={`${INPUT} py-1 mt-0.5`} />
              </label>
              <label className="text-[11px] text-gray-600">error ≤ (%)
                <input type="number" min={0} value={sla.maxErrorRatePct ?? ''} onChange={(e) => setSla((p) => ({ ...p, maxErrorRatePct: slaNum(e.target.value) }))} className={`${INPUT} py-1 mt-0.5`} />
              </label>
              <label className="text-[11px] text-gray-600">tput ≥ (rps)
                <input type="number" min={0} value={sla.minThroughputRps ?? ''} onChange={(e) => setSla((p) => ({ ...p, minThroughputRps: slaNum(e.target.value) }))} className={`${INPUT} py-1 mt-0.5`} />
              </label>
            </div>
          </div>

          <p className="text-[10px] text-gray-400">Point each region&apos;s proxy at a regional forward-proxy to originate traffic from that geography; added-latency simulates distance without one.</p>

          <div className="flex items-center justify-end gap-2">
            {loading && <span className="text-[11px] text-gray-400">takes up to ~{durationSec}s…</span>}
            <button type="button" onClick={() => void run()} disabled={loading || !ep} className={PRIMARY_BTN}>
              {loading ? <Spinner className="w-3.5 h-3.5 animate-spin" /> : <Play className="w-3.5 h-3.5" />}
              {loading ? 'Running…' : 'Run'}
            </button>
          </div>

          {error && (
            <div className="flex items-start gap-2 px-3 py-2 bg-red-50 border border-red-200 rounded-lg">
              <AlertTriangle className="w-4 h-4 text-red-500 flex-shrink-0 mt-px" /><p className="text-[12px] text-red-700 min-w-0 whitespace-pre-wrap break-words">{error}</p>
            </div>
          )}

          {result && t && (
            <div className="space-y-3">
              {/* SLA verdict */}
              {result.sla && (
                <div className={`rounded-lg border px-3 py-2.5 ${result.sla.pass ? 'bg-emerald-50 border-emerald-200' : 'bg-red-50 border-red-200'}`}>
                  <div className="flex items-center gap-2 mb-1.5">
                    {result.sla.pass ? <CheckCircle2 className="w-4 h-4 text-emerald-600" /> : <XCircle className="w-4 h-4 text-red-600" />}
                    <span className={`text-[12.5px] font-semibold ${result.sla.pass ? 'text-emerald-700' : 'text-red-700'}`}>SLA gate {result.sla.pass ? 'passed' : 'failed'}</span>
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {result.sla.checks.map((c) => (
                      <span key={c.name} className={`inline-flex items-center gap-1 px-2 py-0.5 rounded border text-[10.5px] font-mono ${c.pass ? 'text-emerald-700 bg-white border-emerald-200' : 'text-red-700 bg-white border-red-200'}`}>
                        {c.pass ? <CheckCircle2 className="w-3 h-3" /> : <XCircle className="w-3 h-3" />}{c.name} {c.actual}{c.unit} / {c.limit}{c.unit}
                      </span>
                    ))}
                  </div>
                </div>
              )}

              {/* Totals */}
              <div className="flex flex-wrap items-center gap-2 text-[11.5px]">
                <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md border bg-gray-50 border-gray-200 text-gray-700 font-mono tabular-nums">{t.throughputRps} rps</span>
                <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md border font-mono tabular-nums ${t.errorRatePct > 0 ? 'text-red-700 bg-red-50 border-red-200' : 'text-emerald-700 bg-emerald-50 border-emerald-200'}`}>{t.errorRatePct}% errors</span>
                <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md border bg-gray-50 border-gray-200 text-gray-700 font-mono tabular-nums">p50 {t.latency.p50}ms</span>
                <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md border bg-gray-50 border-gray-200 text-gray-700 font-mono tabular-nums">p95 {t.latency.p95}ms</span>
                <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md border bg-gray-50 border-gray-200 text-gray-700 font-mono tabular-nums">p99 {t.latency.p99}ms</span>
                <span className="ml-auto text-[11px] text-gray-400 tabular-nums">{t.completed} ok · {t.failed} failed · {t.non2xx} non-2xx</span>
              </div>

              {/* Per-region */}
              <div className="border border-[#E9E5FB] rounded-lg overflow-hidden">
                <table className="w-full text-[11.5px]">
                  <thead>
                    <tr className="bg-[#FAF9FE] text-gray-500 text-left">
                      <th className="font-semibold px-2.5 py-1.5">Region</th>
                      <th className="font-semibold px-2.5 py-1.5 text-right">conc.</th>
                      <th className="font-semibold px-2.5 py-1.5 text-center">proxied</th>
                      <th className="font-semibold px-2.5 py-1.5 text-right">+lat</th>
                      <th className="font-semibold px-2.5 py-1.5 text-right">done</th>
                      <th className="font-semibold px-2.5 py-1.5 text-right">failed</th>
                      <th className="font-semibold px-2.5 py-1.5 text-right">rps</th>
                      <th className="font-semibold px-2.5 py-1.5 text-right">p95</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {result.regions.map((r) => (
                      <tr key={r.name}>
                        <td className="px-2.5 py-1.5 text-gray-700">{r.name}</td>
                        <td className="px-2.5 py-1.5 text-right font-mono tabular-nums">{r.concurrency}</td>
                        <td className="px-2.5 py-1.5 text-center text-gray-500">{r.proxied ? 'yes' : '—'}</td>
                        <td className="px-2.5 py-1.5 text-right font-mono tabular-nums">{r.addedLatencyMs}ms</td>
                        <td className="px-2.5 py-1.5 text-right font-mono tabular-nums">{r.completed}</td>
                        <td className={`px-2.5 py-1.5 text-right font-mono tabular-nums ${r.failed ? 'text-red-500' : ''}`}>{r.failed}</td>
                        <td className="px-2.5 py-1.5 text-right font-mono tabular-nums">{r.throughputRps}</td>
                        <td className="px-2.5 py-1.5 text-right font-mono tabular-nums">{r.latency.p95}ms</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {/* Status mix */}
              {Object.keys(result.statusCounts).length > 0 && (
                <div className="flex flex-wrap gap-1.5">
                  {Object.entries(result.statusCounts).map(([code, count]) => (
                    <span key={code} className={`inline-flex items-center gap-1 px-2 py-0.5 rounded border text-[10.5px] font-mono tabular-nums ${statusChipClass(code)}`}>{code} · {count}</span>
                  ))}
                </div>
              )}

              {/* Top errors */}
              {result.errors.length > 0 && (
                <div className="text-[11px] text-gray-500 space-y-0.5">
                  {result.errors.map((e) => <div key={e.message} className="truncate"><span className="font-mono text-red-500">{e.count}×</span> {e.message}</div>)}
                </div>
              )}

              {/* Notes */}
              {result.notes.length > 0 && (
                <div className="text-[10.5px] text-gray-400 space-y-0.5">
                  {result.notes.map((n, i) => <div key={i}>{n}</div>)}
                </div>
              )}

              <div className="text-[11px] text-gray-400 tabular-nums">{result.method} {result.url} · {formatDuration(result.durationMs)}</div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
