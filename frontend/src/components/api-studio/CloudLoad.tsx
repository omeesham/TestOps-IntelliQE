/**
 * CloudLoad — distributed load generation that fans out to remote agents.
 *
 * Opt-in and standalone. Registers labelled remote agents, then fires load at
 * one endpoint from every enabled agent for a fixed duration and grades the
 * aggregate against an SLA. With no agents a local burst runs as the single
 * node. It live-fires the endpoint and changes nothing in the catalogue or the
 * pipeline; write methods require explicit opt-in.
 */
import { useEffect, useState } from 'react';
import { Cloud, X, Play, Plus, Trash2, AlertTriangle, CheckCircle2, XCircle } from 'lucide-react';
import Spinner from '@/components/feedback/Spinner';
import { listLoadAgents, saveLoadAgent, deleteLoadAgent, runCloudLoad, type LoadAgent, type CloudLoadResult } from '@/services/api';
import { MethodBadge } from './primitives';
import { CARD, STRIP, INPUT, LABEL, PRIMARY_BTN, formatDuration } from './format';
import type { CatalogEndpoint } from './types';

type Sla = { p95Ms?: number; maxErrorRatePct?: number; minThroughputRps?: number };

export default function CloudLoad({ endpoints, onClose }: { endpoints: CatalogEndpoint[]; onClose: () => void }) {
  const [idx, setIdx] = useState(0);
  const [agents, setAgents] = useState<LoadAgent[]>([]);
  const [newName, setNewName] = useState('');
  const [newUrl, setNewUrl] = useState('');
  const [newRegion, setNewRegion] = useState('');
  const [durationSec, setDurationSec] = useState(15);
  const [concurrencyPerAgent, setConcurrencyPerAgent] = useState(10);
  const [allowWrites, setAllowWrites] = useState(false);
  const [sla, setSla] = useState<Sla>({});
  const [result, setResult] = useState<CloudLoadResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const ep = endpoints.length ? endpoints[Math.min(idx, endpoints.length - 1)] : undefined;
  const slaNum = (v: string): number | undefined => (v.trim() === '' ? undefined : Math.max(0, Number(v)));

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const { agents: list } = await listLoadAgents();
        if (alive) setAgents(list);
      } catch { /* agents are optional — a local burst runs without them */ }
    })();
    return () => { alive = false; };
  }, []);

  const addAgent = async () => {
    if (!newUrl.trim()) return;
    try {
      const { agent } = await saveLoadAgent({ name: newName.trim() || undefined, url: newUrl.trim(), region: newRegion.trim() || undefined });
      setAgents((prev) => [...prev, agent]);
      setNewName(''); setNewUrl(''); setNewRegion('');
    } catch (e: any) {
      setError(e?.response?.data?.error || e?.message || 'Could not add the agent.');
    }
  };

  const removeAgent = async (id: string) => {
    try {
      await deleteLoadAgent(id);
      setAgents((prev) => prev.filter((a) => a.id !== id));
    } catch (e: any) {
      setError(e?.response?.data?.error || e?.message || 'Could not delete the agent.');
    }
  };

  const run = async () => {
    if (!ep) return;
    setLoading(true); setError(''); setResult(null);
    try {
      const slaInput: Sla = {};
      (Object.keys(sla) as (keyof Sla)[]).forEach((k) => { if (sla[k] !== undefined) slaInput[k] = sla[k]; });
      setResult(await runCloudLoad({
        endpoint: { method: ep.method, url: ep.url, headers: ep.headers, auth: ep.auth, body: ep.body },
        durationSec,
        concurrencyPerAgent,
        allowWrites,
        sla: Object.keys(slaInput).length ? slaInput : undefined,
      }));
    } catch (e: any) {
      setError(e?.response?.data?.error || e?.message || 'Cloud load run failed.');
    } finally {
      setLoading(false);
    }
  };

  const t = result?.totals;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-[#1E1B4B]/30 backdrop-blur-sm p-4" onClick={onClose}>
      <div className={`${CARD} w-full max-w-3xl max-h-[88vh] flex flex-col overflow-hidden`} onClick={(e) => e.stopPropagation()}>
        <div className={`flex items-center gap-2 px-4 h-12 border-b border-[#EDE9FE] flex-shrink-0 ${STRIP}`}>
          <Cloud className="w-4 h-4 text-[#7C3AED]" />
          <h3 className="text-[13px] font-semibold text-gray-900">Distributed cloud load</h3>
          <span className="text-[11px] text-gray-400">fan out to remote agents + SLA gate</span>
          <button type="button" onClick={onClose} className="ml-auto p-1.5 rounded-md text-gray-400 hover:text-[#7C3AED] hover:bg-[#F5F3FF]"><X className="w-4 h-4" /></button>
        </div>

        <div className="p-4 space-y-3 overflow-y-auto min-h-0">
          {/* Agents */}
          <div>
            <label className={LABEL}>Agents</label>
            <div className="space-y-1">
              {agents.map((a) => (
                <div key={a.id} className="flex items-center gap-2 text-[11.5px] text-gray-600 px-2.5 py-1.5 rounded-md border border-gray-100 bg-gray-50/60">
                  <span className={`w-1.5 h-1.5 rounded-full ${a.enabled ? 'bg-emerald-500' : 'bg-gray-300'}`} />
                  <span className="font-medium text-gray-700">{a.name}</span>
                  <span className="text-gray-400">{a.region}</span>
                  <span className="font-mono text-[11px] text-gray-400 truncate flex-1 min-w-0">{a.url}</span>
                  <button type="button" onClick={() => void removeAgent(a.id)} className="p-1 rounded text-gray-400 hover:text-red-500"><Trash2 className="w-3.5 h-3.5" /></button>
                </div>
              ))}
            </div>
            <div className="flex flex-wrap items-center gap-1.5 mt-1.5">
              <input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="name" className={`${INPUT} w-28 py-1`} />
              <input value={newUrl} onChange={(e) => setNewUrl(e.target.value)} placeholder="agent url" className={`${INPUT} flex-1 min-w-[160px] py-1 font-mono text-[11px]`} />
              <input value={newRegion} onChange={(e) => setNewRegion(e.target.value)} placeholder="region" className={`${INPUT} w-28 py-1`} />
              <button type="button" onClick={() => void addAgent()} disabled={!newUrl.trim()} className="inline-flex items-center gap-1 px-2.5 py-1.5 text-[11px] font-medium text-[#6D28D9] border border-[#DDD6FE] rounded-md hover:bg-[#F5F3FF] disabled:opacity-40"><Plus className="w-3.5 h-3.5" />Add</button>
            </div>
            <p className="text-[10px] text-gray-400 mt-1">No agents? A local burst runs as the single node.</p>
          </div>

          {/* Endpoint */}
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

          {/* Run knobs */}
          <div className="flex flex-wrap items-center gap-4">
            <label className="flex items-center gap-2 text-[11.5px] text-gray-600">
              <span className="font-semibold">Duration</span>
              <input type="number" min={1} max={120} value={durationSec} onChange={(e) => setDurationSec(Math.max(1, Number(e.target.value)))} className={`${INPUT} w-20 py-1`} /> sec
            </label>
            <label className="flex items-center gap-2 text-[11.5px] text-gray-600">
              <span className="font-semibold">Conc / agent</span>
              <input type="number" min={1} max={100} value={concurrencyPerAgent} onChange={(e) => setConcurrencyPerAgent(Math.max(1, Number(e.target.value)))} className={`${INPUT} w-20 py-1`} />
            </label>
            <label className="flex items-center gap-2 text-[11.5px] text-gray-600">
              <input type="checkbox" checked={allowWrites} onChange={(e) => setAllowWrites(e.target.checked)} className="w-3.5 h-3.5" />
              Allow writes
            </label>
          </div>

          {/* SLA */}
          <div>
            <label className={LABEL}>SLA gate — leave a field blank to skip that check</label>
            <div className="grid grid-cols-3 gap-2">
              <label className="text-[11px] text-gray-600">p95 ≤ (ms)
                <input type="number" min={0} value={sla.p95Ms ?? ''} onChange={(e) => setSla((p) => ({ ...p, p95Ms: slaNum(e.target.value) }))} className={`${INPUT} py-1 mt-0.5`} />
              </label>
              <label className="text-[11px] text-gray-600">error ≤ (%)
                <input type="number" min={0} value={sla.maxErrorRatePct ?? ''} onChange={(e) => setSla((p) => ({ ...p, maxErrorRatePct: slaNum(e.target.value) }))} className={`${INPUT} py-1 mt-0.5`} />
              </label>
              <label className="text-[11px] text-gray-600">tput ≥ (rps)
                <input type="number" min={0} value={sla.minThroughputRps ?? ''} onChange={(e) => setSla((p) => ({ ...p, minThroughputRps: slaNum(e.target.value) }))} className={`${INPUT} py-1 mt-0.5`} />
              </label>
            </div>
          </div>

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

              {/* Per-node */}
              <div className="border border-[#E9E5FB] rounded-lg overflow-hidden">
                <table className="w-full text-[11.5px]">
                  <thead>
                    <tr className="bg-[#FAF9FE] text-gray-500 text-left">
                      <th className="font-semibold px-2.5 py-1.5">Node</th>
                      <th className="font-semibold px-2.5 py-1.5">region</th>
                      <th className="font-semibold px-2.5 py-1.5 text-center">remote</th>
                      <th className="font-semibold px-2.5 py-1.5 text-right">done</th>
                      <th className="font-semibold px-2.5 py-1.5 text-right">failed</th>
                      <th className="font-semibold px-2.5 py-1.5 text-right">rps</th>
                      <th className="font-semibold px-2.5 py-1.5 text-right">p95</th>
                      <th className="font-semibold px-2.5 py-1.5">error</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {result.nodes.map((n) => (
                      <tr key={n.node}>
                        <td className="px-2.5 py-1.5 text-gray-700">{n.node}</td>
                        <td className="px-2.5 py-1.5 text-gray-500">{n.region}</td>
                        <td className="px-2.5 py-1.5 text-center text-gray-500">{n.remote ? 'yes' : '—'}</td>
                        <td className="px-2.5 py-1.5 text-right font-mono tabular-nums">{n.completed}</td>
                        <td className={`px-2.5 py-1.5 text-right font-mono tabular-nums ${n.failed ? 'text-red-500' : ''}`}>{n.failed}</td>
                        <td className="px-2.5 py-1.5 text-right font-mono tabular-nums">{n.throughputRps}</td>
                        <td className="px-2.5 py-1.5 text-right font-mono tabular-nums">{n.latency.p95}ms</td>
                        <td className="px-2.5 py-1.5 text-red-500 truncate max-w-[160px]">{n.error || ''}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {result.note && <p className="text-[10.5px] text-gray-400">{result.note}</p>}

              <div className="text-[11px] text-gray-400 tabular-nums">{result.method} {result.url} · {formatDuration(result.durationMs)}</div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
