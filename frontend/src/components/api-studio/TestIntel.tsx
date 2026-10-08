/**
 * TestIntel — test intelligence over the run history.
 *
 * Three read-mostly lenses on a tenant's accumulated runs: flaky-test detection
 * (which cases flip verdict across runs), a quarantine list (cases to exclude
 * from gating while they are stabilised), and change-impact analysis (given a
 * set of changed endpoints, which catalogue cases are selected to re-run).
 * Standalone and opt-in; nothing here mutates the pipeline or the catalogue.
 */
import { useEffect, useState } from 'react';
import { X, Microscope, Play, Plus, Trash2, AlertTriangle } from 'lucide-react';
import Spinner from '@/components/feedback/Spinner';
import { useToast } from '@/components/feedback/ToastProvider';
import {
  detectFlakyTests, listQuarantine, addQuarantine, removeQuarantine, analyzeImpact,
  type FlakyReport, type QuarantineItem, type ImpactResult,
} from '@/services/api';
import { MethodBadge } from './primitives';
import { CARD, STRIP, INPUT, LABEL, PRIMARY_BTN, relativeTime } from './format';
import type { CatalogEndpoint } from './types';

type Tab = 'flaky' | 'quarantine' | 'impact';

const TAB_ACTIVE = 'px-3 py-1.5 text-[12px] font-medium text-[#6D28D9] border-b-2 border-[#7C3AED]';
const TAB_INACTIVE = 'px-3 py-1.5 text-[12px] font-medium text-gray-500 hover:text-gray-700';

function statusChipClass(s: string): string {
  if (/pass/i.test(s)) return 'text-emerald-700 bg-emerald-50 border-emerald-200';
  if (/fail/i.test(s)) return 'text-red-700 bg-red-50 border-red-200';
  return 'text-gray-600 bg-gray-50 border-gray-200';
}

export default function TestIntel({ endpoints, onClose }: { endpoints: CatalogEndpoint[]; onClose: () => void }) {
  const toast = useToast();
  const [tab, setTab] = useState<Tab>('flaky');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  // Flaky
  const [runLimit, setRunLimit] = useState(20);
  const [flaky, setFlaky] = useState<FlakyReport | null>(null);

  // Quarantine
  const [quarantine, setQuarantine] = useState<QuarantineItem[]>([]);
  const [loadingQuar, setLoadingQuar] = useState(true);
  const [testKey, setTestKey] = useState('');
  const [reason, setReason] = useState('');

  // Impact
  const [changed, setChanged] = useState('');
  const [impact, setImpact] = useState<ImpactResult | null>(null);

  const loadQuarantine = async () => {
    const { items } = await listQuarantine();
    setQuarantine(items);
  };

  useEffect(() => {
    (async () => {
      try { await loadQuarantine(); }
      catch (e: any) { setError(e?.response?.data?.error || e?.message || 'Could not load the quarantine list.'); }
      finally { setLoadingQuar(false); }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const detect = async () => {
    setBusy(true); setError(''); setFlaky(null);
    try {
      setFlaky(await detectFlakyTests(runLimit));
    } catch (e: any) {
      setError(e?.response?.data?.error || e?.message || 'Flaky detection failed.');
    } finally { setBusy(false); }
  };

  const quarantineFromFlaky = async (name: string) => {
    setBusy(true); setError('');
    try {
      await addQuarantine(name);
      await loadQuarantine();
      toast.success('Quarantined', name);
    } catch (e: any) {
      setError(e?.response?.data?.error || e?.message || 'Could not quarantine the test.');
    } finally { setBusy(false); }
  };

  const addQuar = async () => {
    setBusy(true); setError('');
    try {
      await addQuarantine(testKey.trim(), reason.trim() || undefined);
      setTestKey(''); setReason('');
      await loadQuarantine();
      toast.success('Added to quarantine');
    } catch (e: any) {
      setError(e?.response?.data?.error || e?.message || 'Could not add to quarantine.');
    } finally { setBusy(false); }
  };

  const removeQuar = async (id: string) => {
    setBusy(true); setError('');
    try {
      await removeQuarantine(id);
      await loadQuarantine();
      toast.success('Removed from quarantine');
    } catch (e: any) {
      setError(e?.response?.data?.error || e?.message || 'Could not remove from quarantine.');
    } finally { setBusy(false); }
  };

  const analyze = async () => {
    setBusy(true); setError(''); setImpact(null);
    try {
      const changedList = changed.split('\n').map((l) => l.trim()).filter(Boolean).map((line) => {
        const parts = line.split(/\s+/);
        return parts.length === 1 ? { url: parts[0] } : { method: parts[0], url: parts.slice(1).join(' ') };
      });
      const candidates = endpoints.map((e) => ({ id: e.id, title: e.title, method: e.method, url: e.url }));
      setImpact(await analyzeImpact({ changed: changedList, candidates }));
    } catch (e: any) {
      setError(e?.response?.data?.error || e?.message || 'Impact analysis failed.');
    } finally { setBusy(false); }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-[#1E1B4B]/30 backdrop-blur-sm p-4" onClick={onClose}>
      <div className={`${CARD} w-full max-w-3xl max-h-[88vh] flex flex-col overflow-hidden`} onClick={(e) => e.stopPropagation()}>
        <div className={`flex items-center gap-2 px-4 h-12 border-b border-[#EDE9FE] flex-shrink-0 ${STRIP}`}>
          <Microscope className="w-4 h-4 text-[#7C3AED]" />
          <h3 className="text-[13px] font-semibold text-gray-900">Test intelligence</h3>
          <span className="text-[11px] text-gray-400">flaky detection · quarantine · change impact</span>
          <button type="button" onClick={onClose} className="ml-auto p-1.5 rounded-md text-gray-400 hover:text-[#7C3AED] hover:bg-[#F5F3FF]"><X className="w-4 h-4" /></button>
        </div>

        <div className="flex items-center gap-1 px-3 border-b border-[#EDE9FE] flex-shrink-0">
          <button type="button" onClick={() => setTab('flaky')} className={tab === 'flaky' ? TAB_ACTIVE : TAB_INACTIVE}>Flaky</button>
          <button type="button" onClick={() => setTab('quarantine')} className={tab === 'quarantine' ? TAB_ACTIVE : TAB_INACTIVE}>Quarantine</button>
          <button type="button" onClick={() => setTab('impact')} className={tab === 'impact' ? TAB_ACTIVE : TAB_INACTIVE}>Impact</button>
        </div>

        <div className="p-4 space-y-3 overflow-y-auto min-h-0">
          {error && (
            <div className="flex items-start gap-2 px-3 py-2 bg-red-50 border border-red-200 rounded-lg">
              <AlertTriangle className="w-4 h-4 text-red-500 flex-shrink-0 mt-px" /><p className="text-[12px] text-red-700 min-w-0 whitespace-pre-wrap break-words">{error}</p>
            </div>
          )}

          {/* ── Flaky ── */}
          {tab === 'flaky' && (
            <div className="space-y-3">
              <div className="flex items-end gap-2">
                <label className="text-[11.5px] text-gray-600">
                  <span className="font-semibold">Runs to analyze</span>
                  <input type="number" min={1} max={500} value={runLimit} onChange={(e) => setRunLimit(Math.max(1, Number(e.target.value)))} className={`${INPUT} w-24 py-1 mt-0.5`} />
                </label>
                <button type="button" onClick={() => void detect()} disabled={busy} className={PRIMARY_BTN}>
                  {busy ? <Spinner className="w-3.5 h-3.5 animate-spin" /> : <Play className="w-3.5 h-3.5" />}
                  {busy ? 'Detecting…' : 'Detect'}
                </button>
              </div>

              {flaky && (
                <div className="space-y-3">
                  <div className="flex flex-wrap items-center gap-2 text-[11.5px]">
                    <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md border bg-red-50 border-red-200 text-red-700 font-mono tabular-nums">{flaky.summary.flaky} flaky</span>
                    <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md border bg-emerald-50 border-emerald-200 text-emerald-700 font-mono tabular-nums">{flaky.summary.stable} stable</span>
                    <span className="ml-auto text-[11px] text-gray-400 tabular-nums">{flaky.runsAnalyzed} runs · {flaky.totalTests} tests</span>
                  </div>

                  {flaky.flaky.length === 0 ? (
                    <div className="text-center py-6 text-[12px] text-gray-400">No flaky tests across the analyzed runs.</div>
                  ) : (
                    <div className="border border-[#E9E5FB] rounded-lg overflow-hidden">
                      <table className="w-full text-[11.5px]">
                        <thead>
                          <tr className="bg-[#FAF9FE] text-gray-500 text-left">
                            <th className="font-semibold px-2.5 py-1.5">Test</th>
                            <th className="font-semibold px-2.5 py-1.5 text-right">seen</th>
                            <th className="font-semibold px-2.5 py-1.5 text-right">pass</th>
                            <th className="font-semibold px-2.5 py-1.5 text-right">fail</th>
                            <th className="font-semibold px-2.5 py-1.5 text-right">flaky %</th>
                            <th className="font-semibold px-2.5 py-1.5">recent</th>
                            <th className="font-semibold px-2.5 py-1.5" />
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-gray-100">
                          {flaky.flaky.map((f) => (
                            <tr key={f.name}>
                              <td className="px-2.5 py-1.5 text-gray-700 font-mono truncate max-w-[200px]">{f.name}</td>
                              <td className="px-2.5 py-1.5 text-right font-mono tabular-nums">{f.appearances}</td>
                              <td className="px-2.5 py-1.5 text-right font-mono tabular-nums text-emerald-600">{f.passed}</td>
                              <td className="px-2.5 py-1.5 text-right font-mono tabular-nums text-red-500">{f.failed}</td>
                              <td className="px-2.5 py-1.5 text-right font-mono tabular-nums">{Math.round(f.flakiness * 100)}%</td>
                              <td className="px-2.5 py-1.5">
                                <div className="flex flex-wrap gap-1">
                                  {f.lastStatuses.map((s, i) => (
                                    <span key={i} className={`inline-flex items-center px-1 py-0.5 rounded border text-[9.5px] font-mono ${statusChipClass(s)}`}>{s}</span>
                                  ))}
                                </div>
                              </td>
                              <td className="px-2.5 py-1.5 text-right">
                                <button type="button" onClick={() => void quarantineFromFlaky(f.name)} disabled={busy} className="inline-flex items-center gap-1 px-2 py-0.5 rounded border text-[10.5px] font-medium text-[#6D28D9] bg-white border-[#DDD6FE] hover:bg-[#F5F3FF] disabled:opacity-40">
                                  <Plus className="w-3 h-3" />Quarantine
                                </button>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {/* ── Quarantine ── */}
          {tab === 'quarantine' && (
            <div className="space-y-3">
              <div className="rounded-lg border border-[#E4E0F5] bg-[#FAF9FE] p-3">
                <label className={LABEL}>Quarantine a test</label>
                <div className="flex items-end gap-2">
                  <input value={testKey} onChange={(e) => setTestKey(e.target.value)} placeholder="test key / name" className={`${INPUT} flex-1`} />
                  <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="reason (optional)" className={`${INPUT} flex-1`} />
                  <button type="button" onClick={() => void addQuar()} disabled={busy || !testKey.trim()} className={PRIMARY_BTN}>
                    {busy ? <Spinner className="w-3.5 h-3.5 animate-spin" /> : <Plus className="w-3.5 h-3.5" />}Add
                  </button>
                </div>
              </div>

              {loadingQuar ? (
                <div className="flex items-center justify-center py-8 text-gray-400"><Spinner className="w-5 h-5 animate-spin" /></div>
              ) : quarantine.length === 0 ? (
                <div className="text-center py-6 text-[12px] text-gray-400">Nothing quarantined.</div>
              ) : (
                <div className="border border-[#E9E5FB] rounded-lg overflow-hidden">
                  <table className="w-full text-[11.5px]">
                    <thead>
                      <tr className="bg-[#FAF9FE] text-gray-500 text-left">
                        <th className="font-semibold px-2.5 py-1.5">Test</th>
                        <th className="font-semibold px-2.5 py-1.5">Reason</th>
                        <th className="font-semibold px-2.5 py-1.5">By</th>
                        <th className="font-semibold px-2.5 py-1.5">When</th>
                        <th className="font-semibold px-2.5 py-1.5" />
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-100">
                      {quarantine.map((q) => (
                        <tr key={q.id}>
                          <td className="px-2.5 py-1.5 text-gray-700 font-mono truncate max-w-[200px]">{q.testKey}</td>
                          <td className="px-2.5 py-1.5 text-gray-500 min-w-0">{q.reason || '—'}</td>
                          <td className="px-2.5 py-1.5 text-gray-500">{q.createdBy || '—'}</td>
                          <td className="px-2.5 py-1.5 text-gray-400 tabular-nums">{relativeTime(q.createdAt)}</td>
                          <td className="px-2.5 py-1.5 text-right">
                            <button type="button" onClick={() => void removeQuar(q.id)} disabled={busy} className="p-1 rounded text-gray-400 hover:text-red-500 disabled:opacity-40"><Trash2 className="w-3.5 h-3.5" /></button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}

          {/* ── Impact ── */}
          {tab === 'impact' && (
            <div className="space-y-3">
              <div>
                <label className={LABEL}>Changed endpoints — one per line, as <code className="font-mono">METHOD url</code> or just <code className="font-mono">url</code></label>
                <textarea value={changed} onChange={(e) => setChanged(e.target.value)} rows={5} placeholder={'POST https://api.x.com/v1/orders\nhttps://api.x.com/v1/users/{id}'} className={`${INPUT} font-mono text-[11px]`} />
              </div>
              <div className="flex items-center justify-between">
                <span className="text-[11px] text-gray-400">{endpoints.length} endpoint{endpoints.length === 1 ? '' : 's'} in the catalogue as candidates</span>
                <button type="button" onClick={() => void analyze()} disabled={busy || !changed.trim()} className={PRIMARY_BTN}>
                  {busy ? <Spinner className="w-3.5 h-3.5 animate-spin" /> : <Play className="w-3.5 h-3.5" />}
                  {busy ? 'Analyzing…' : 'Analyze'}
                </button>
              </div>

              {impact && (
                <div className="space-y-3">
                  <div className="flex items-center gap-4">
                    <div>
                      <div className="text-3xl font-bold text-[#6D28D9] tabular-nums">{impact.summary.selectedPct}%</div>
                      <div className="text-[10.5px] text-gray-400 uppercase tracking-wide">selected to re-run</div>
                    </div>
                    <div className="flex flex-wrap items-center gap-2 text-[11.5px]">
                      <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md border bg-gray-50 border-gray-200 text-gray-700 font-mono tabular-nums">{impact.summary.candidates} candidates</span>
                      <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md border bg-[#F5F3FF] border-[#DDD6FE] text-[#6D28D9] font-mono tabular-nums">{impact.summary.impacted} impacted</span>
                      <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md border bg-gray-50 border-gray-200 text-gray-500 font-mono tabular-nums">{impact.notImpacted} skipped</span>
                    </div>
                  </div>

                  {impact.changedSignatures.length > 0 && (
                    <div className="flex flex-wrap gap-1.5">
                      {impact.changedSignatures.map((s) => (
                        <span key={s} className="inline-flex items-center px-2 py-0.5 rounded border text-[10.5px] font-mono text-[#6B7280] bg-gray-50 border-gray-200">{s}</span>
                      ))}
                    </div>
                  )}

                  {impact.impacted.length === 0 ? (
                    <div className="text-center py-6 text-[12px] text-gray-400">No catalogue cases are impacted by those changes.</div>
                  ) : (
                    <div className="border border-[#E9E5FB] rounded-lg overflow-hidden">
                      <table className="w-full text-[11.5px]">
                        <thead>
                          <tr className="bg-[#FAF9FE] text-gray-500 text-left">
                            <th className="font-semibold px-2.5 py-1.5">Method</th>
                            <th className="font-semibold px-2.5 py-1.5">URL</th>
                            <th className="font-semibold px-2.5 py-1.5">Title</th>
                            <th className="font-semibold px-2.5 py-1.5">Signature</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-gray-100">
                          {impact.impacted.map((r, i) => (
                            <tr key={r.id || `${r.signature}-${i}`}>
                              <td className="px-2.5 py-1.5"><MethodBadge method={r.method} /></td>
                              <td className="px-2.5 py-1.5 text-gray-700 font-mono truncate max-w-[220px]">{r.url}</td>
                              <td className="px-2.5 py-1.5 text-gray-500 truncate max-w-[160px]">{r.title || '—'}</td>
                              <td className="px-2.5 py-1.5 text-gray-400 font-mono truncate max-w-[160px]">{r.signature}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
