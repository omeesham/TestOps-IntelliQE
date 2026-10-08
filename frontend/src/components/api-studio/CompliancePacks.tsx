/**
 * CompliancePacks — vertical compliance posture over the catalogue.
 *
 * Scores the endpoint catalogue against a chosen regulatory pack (PCI, HIPAA,
 * GDPR, PSD2) using static heuristics over what the workspace already knows —
 * transport, auth schemes, data shapes — plus two operator-supplied assumptions
 * (TLS everywhere, security headers verified) it cannot see on its own. It reads
 * the catalogue and asserts nothing live; this is a posture snapshot, not a
 * certified audit.
 */
import { useEffect, useState } from 'react';
import { X, BadgeCheck, Play, AlertTriangle } from 'lucide-react';
import Spinner from '@/components/feedback/Spinner';
import { listCompliancePacks, runCompliancePack, type CompliancePack } from '@/services/api';
import { CARD, STRIP, INPUT, LABEL, PRIMARY_BTN } from './format';
import type { CatalogEndpoint } from './types';

type StatusKey = 'pass' | 'warn' | 'fail' | 'review' | 'not_assessed';

const STATUS_ORDER: StatusKey[] = ['pass', 'warn', 'fail', 'review', 'not_assessed'];
const STATUS_LABEL: Record<StatusKey, string> = { pass: 'pass', warn: 'warn', fail: 'fail', review: 'review', not_assessed: 'not assessed' };

function statusCls(s: string): string {
  if (s === 'pass') return 'text-emerald-700 bg-emerald-50 border-emerald-200';
  if (s === 'warn') return 'text-amber-700 bg-amber-50 border-amber-200';
  if (s === 'fail') return 'text-red-700 bg-red-50 border-red-200';
  if (s === 'review') return 'text-indigo-700 bg-indigo-50 border-indigo-200';
  return 'text-gray-600 bg-gray-50 border-gray-200';
}

function gradeCls(g: string): string {
  if (g === 'A' || g === 'B') return 'text-emerald-700 bg-emerald-50 border-emerald-200';
  if (g === 'C') return 'text-amber-700 bg-amber-50 border-amber-200';
  return 'text-red-700 bg-red-50 border-red-200';
}

export default function CompliancePacks({ endpoints, onClose }: { endpoints: CatalogEndpoint[]; onClose: () => void }) {
  const [packs, setPacks] = useState<{ id: string; label: string }[]>([]);
  const [pack, setPack] = useState('');
  const [tlsChecked, setTlsChecked] = useState(false);
  const [hdrChecked, setHdrChecked] = useState(false);
  const [result, setResult] = useState<CompliancePack | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    (async () => {
      try {
        const { packs: list } = await listCompliancePacks();
        setPacks(list);
        setPack(list[0]?.id || '');
      } catch (e: any) {
        setError(e?.response?.data?.error || e?.message || 'Could not load compliance packs.');
      } finally { setLoading(false); }
    })();
  }, []);

  const run = async () => {
    if (!pack) return;
    setBusy(true); setError(''); setResult(null);
    try {
      setResult(await runCompliancePack(pack, endpoints, {
        transportSecure: tlsChecked || undefined,
        headersSecure: hdrChecked || undefined,
      }));
    } catch (e: any) {
      setError(e?.response?.data?.error || e?.message || 'Compliance scan failed.');
    } finally { setBusy(false); }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-[#1E1B4B]/30 backdrop-blur-sm p-4" onClick={onClose}>
      <div className={`${CARD} w-full max-w-3xl max-h-[88vh] flex flex-col overflow-hidden`} onClick={(e) => e.stopPropagation()}>
        <div className={`flex items-center gap-2 px-4 h-12 border-b border-[#EDE9FE] flex-shrink-0 ${STRIP}`}>
          <BadgeCheck className="w-4 h-4 text-[#7C3AED]" />
          <h3 className="text-[13px] font-semibold text-gray-900">Compliance packs</h3>
          <span className="text-[11px] text-gray-400">PCI · HIPAA · GDPR · PSD2 posture</span>
          <button type="button" onClick={onClose} className="ml-auto p-1.5 rounded-md text-gray-400 hover:text-[#7C3AED] hover:bg-[#F5F3FF]"><X className="w-4 h-4" /></button>
        </div>

        <div className="p-4 space-y-3 overflow-y-auto min-h-0">
          {error && (
            <div className="flex items-start gap-2 px-3 py-2 bg-red-50 border border-red-200 rounded-lg">
              <AlertTriangle className="w-4 h-4 text-red-500 flex-shrink-0 mt-px" /><p className="text-[12px] text-red-700 min-w-0 whitespace-pre-wrap break-words">{error}</p>
            </div>
          )}

          {loading ? (
            <div className="flex items-center justify-center py-8 text-gray-400"><Spinner className="w-5 h-5 animate-spin" /></div>
          ) : (
            <>
              <div>
                <label className={LABEL}>Pack</label>
                <select value={pack} onChange={(e) => { setPack(e.target.value); setResult(null); }} className={INPUT} disabled={!packs.length}>
                  {packs.length === 0 && <option>No packs available</option>}
                  {packs.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
                </select>
              </div>

              <div className="flex flex-wrap items-center gap-4">
                <label className="flex items-center gap-2 text-[11.5px] text-gray-600">
                  <input type="checkbox" checked={tlsChecked} onChange={(e) => setTlsChecked(e.target.checked)} className="w-3.5 h-3.5" />
                  Assume TLS on all endpoints
                </label>
                <label className="flex items-center gap-2 text-[11.5px] text-gray-600">
                  <input type="checkbox" checked={hdrChecked} onChange={(e) => setHdrChecked(e.target.checked)} className="w-3.5 h-3.5" />
                  Security headers verified
                </label>
              </div>

              <div className="flex items-center justify-end gap-2">
                {busy && <span className="text-[11px] text-gray-400">scanning {endpoints.length} endpoints…</span>}
                <button type="button" onClick={() => void run()} disabled={busy || !pack} className={PRIMARY_BTN}>
                  {busy ? <Spinner className="w-3.5 h-3.5 animate-spin" /> : <Play className="w-3.5 h-3.5" />}
                  {busy ? 'Running…' : 'Run scan'}
                </button>
              </div>

              {result && (
                <div className="space-y-3">
                  {/* Grade + score + summary strip */}
                  <div className="flex flex-wrap items-center gap-3">
                    <span className={`inline-flex items-center justify-center w-12 h-12 rounded-xl border text-2xl font-bold ${gradeCls(result.grade)}`}>{result.grade}</span>
                    <div>
                      <div className="text-[13px] font-semibold text-gray-900">{result.packLabel}</div>
                      <div className="text-[11px] text-gray-400 tabular-nums">score {result.score}</div>
                    </div>
                    <div className="ml-auto flex flex-wrap gap-1.5">
                      {STATUS_ORDER.map((s) => (
                        <span key={s} className={`inline-flex items-center gap-1 px-2 py-0.5 rounded border text-[10.5px] font-mono tabular-nums ${statusCls(s)}`}>
                          {result.summary[s] ?? 0} {STATUS_LABEL[s]}
                        </span>
                      ))}
                    </div>
                  </div>

                  {/* Controls */}
                  <div className="space-y-2">
                    {result.controls.map((c) => (
                      <div key={c.id} className="rounded-lg border border-[#E9E5FB] bg-[#FCFBFF] p-3">
                        <div className="flex items-center gap-2 mb-1">
                          <span className="text-[12px] font-semibold text-gray-800 min-w-0 flex-1">{c.title}</span>
                          <span className="text-[10px] text-gray-400 uppercase tracking-wide">{c.assessment}</span>
                          <span className={`inline-flex items-center px-2 py-0.5 rounded border text-[10.5px] font-medium ${statusCls(c.status)}`}>{STATUS_LABEL[c.status] ?? c.status}</span>
                        </div>
                        {c.finding && <p className="text-[11.5px] text-gray-600 whitespace-pre-wrap break-words">{c.finding}</p>}
                        {c.remediation && <p className="text-[10.5px] text-gray-400 mt-1 whitespace-pre-wrap break-words">{c.remediation}</p>}
                      </div>
                    ))}
                  </div>
                </div>
              )}

              <p className="text-[10px] text-gray-400">Static heuristics over your catalogue — not a certified audit.</p>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
