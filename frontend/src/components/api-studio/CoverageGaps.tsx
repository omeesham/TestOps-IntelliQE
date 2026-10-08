/**
 * CoverageGaps — production-traffic coverage gaps.
 *
 * Opt-in and standalone. Compares recorded traffic (the capture sessions)
 * against the current tested catalogue and surfaces the endpoints that have
 * real traffic but no test — then lets you add them to the catalogue and
 * generate. (Katalon "TrueTest" / testRigor production-metadata parity.)
 */
import { useEffect, useState } from 'react';
import { X, Radar, Play, AlertTriangle, Layers, CheckCircle2 } from 'lucide-react';
import Spinner from '@/components/feedback/Spinner';
import { useToast } from '@/components/feedback/ToastProvider';
import { analyzeCoverageGaps, listCaptureSessions, type CoverageGapsReport, type CaptureSession } from '@/services/api';
import { CARD, STRIP, INPUT, LABEL, PRIMARY_BTN } from './format';
import type { Catalog } from './hooks/useCatalog';

export default function CoverageGaps({ catalog, onClose }: { catalog: Catalog; onClose: () => void }) {
  const toast = useToast();
  const [sessions, setSessions] = useState<CaptureSession[]>([]);
  const [sessionId, setSessionId] = useState('');
  const [report, setReport] = useState<CoverageGapsReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => { listCaptureSessions().then((r) => setSessions(r.sessions.filter((s) => s.entryCount > 0))).catch(() => {}); }, []);

  const run = async () => {
    setLoading(true); setError(''); setReport(null);
    try {
      const tested = catalog.endpoints.map((e) => ({ method: e.method, url: e.url, title: e.title }));
      setReport(await analyzeCoverageGaps(tested, sessionId || undefined));
    } catch (e: any) {
      setError(e?.response?.data?.error || e?.message || 'Coverage analysis failed.');
    } finally { setLoading(false); }
  };

  const addGaps = () => {
    if (!report?.gaps.length) return;
    const r = catalog.addEndpoints(report.gaps, { method: 'capture', name: 'Coverage gaps', format: 'Captured traffic', parser: 'har', profile: report.profile });
    toast.success('Gaps added to catalogue', `${r.added} untested endpoint${r.added === 1 ? '' : 's'} added — review and generate.`);
    onClose();
  };

  const s = report?.summary;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-[#1E1B4B]/30 backdrop-blur-sm p-4" onClick={onClose}>
      <div className={`${CARD} w-full max-w-2xl max-h-[85vh] flex flex-col overflow-hidden`} onClick={(e) => e.stopPropagation()}>
        <div className={`flex items-center gap-2 px-4 h-12 border-b border-[#EDE9FE] flex-shrink-0 ${STRIP}`}>
          <Radar className="w-4 h-4 text-[#7C3AED]" />
          <h3 className="text-[13px] font-semibold text-gray-900">Traffic coverage gaps</h3>
          <span className="text-[11px] text-gray-400">real traffic vs tested catalogue</span>
          <button type="button" onClick={onClose} className="ml-auto p-1.5 rounded-md text-gray-400 hover:text-[#7C3AED] hover:bg-[#F5F3FF]"><X className="w-4 h-4" /></button>
        </div>

        <div className="p-4 space-y-3 overflow-y-auto min-h-0">
          <div className="flex items-end gap-2">
            <div className="flex-1 min-w-0">
              <label className={LABEL}>Recorded traffic</label>
              <select value={sessionId} onChange={(e) => setSessionId(e.target.value)} className={INPUT}>
                <option value="">All capture sessions</option>
                {sessions.map((s) => <option key={s.id} value={s.id}>{s.name} · {s.entryCount} req</option>)}
              </select>
            </div>
            <button type="button" onClick={() => void run()} disabled={loading} className={PRIMARY_BTN}>{loading ? <Spinner className="w-3.5 h-3.5 animate-spin" /> : <Play className="w-3.5 h-3.5" />}Analyze</button>
          </div>
          {!sessions.length && <p className="text-[11px] text-amber-600">No recorded traffic yet — use Traffic capture first to record real API calls.</p>}

          {error && <div className="flex items-start gap-2 px-3 py-2 bg-red-50 border border-red-200 rounded-lg"><AlertTriangle className="w-4 h-4 text-red-500 flex-shrink-0 mt-px" /><p className="text-[12px] text-red-700">{error}</p></div>}

          {report && s && (
            <div className="space-y-3">
              <div className="flex items-center gap-4">
                <div className="text-center">
                  <div className={`text-3xl font-bold tabular-nums ${s.coveragePct >= 80 ? 'text-emerald-600' : s.coveragePct >= 50 ? 'text-amber-600' : 'text-red-600'}`}>{s.coveragePct}%</div>
                  <div className="text-[10px] text-gray-400 uppercase tracking-wide">traffic covered</div>
                </div>
                <div className="flex flex-wrap gap-1.5 text-[11.5px]">
                  <span className="inline-flex items-center gap-1 px-2 py-1 rounded-md border bg-gray-50 border-gray-200 text-gray-600">{s.observed} observed</span>
                  <span className="inline-flex items-center gap-1 px-2 py-1 rounded-md border bg-emerald-50 border-emerald-200 text-emerald-700">{s.covered} covered</span>
                  <span className={`inline-flex items-center gap-1 px-2 py-1 rounded-md border ${s.gaps ? 'bg-red-50 border-red-200 text-red-700' : 'bg-gray-50 border-gray-200 text-gray-500'}`}>{s.gaps} gaps</span>
                </div>
              </div>

              {s.gaps === 0 ? (
                <p className="text-[13px] text-emerald-700 font-medium flex items-center gap-1.5"><CheckCircle2 className="w-4 h-4" />Every observed endpoint is in the catalogue.</p>
              ) : (
                <>
                  <div className="border border-[#E9E5FB] rounded-lg divide-y divide-gray-100 max-h-64 overflow-y-auto">
                    {report.gapSignatures.map((sig) => (
                      <div key={sig} className="px-3 py-1.5 text-[11.5px] font-mono text-gray-700">{sig}</div>
                    ))}
                  </div>
                  <div className="flex justify-end">
                    <button type="button" onClick={addGaps} className={PRIMARY_BTN}><Layers className="w-3.5 h-3.5" />Add {s.gaps} gap{s.gaps === 1 ? '' : 's'} to catalogue</button>
                  </div>
                </>
              )}
              {report.fromSessions.length > 0 && <p className="text-[10.5px] text-gray-400">From: {report.fromSessions.map((f) => `${f.name} (${f.entryCount})`).join(', ')}</p>}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
