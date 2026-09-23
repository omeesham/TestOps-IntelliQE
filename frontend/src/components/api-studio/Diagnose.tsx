/**
 * Diagnose — AI root-cause triage for one failed scenario.
 *
 * Opt-in and standalone: asks the model why a test failed and shows a plain
 * -English root cause, a suggested fix, and a repro curl. It heals nothing and
 * touches no pipeline state — it only explains.
 */
import { useEffect, useState } from 'react';
import { X, Loader2, Sparkles, AlertTriangle, Wrench, Terminal } from 'lucide-react';
import { diagnoseApiFailure, type Diagnosis } from '@/services/api';
import { CopyButton } from './primitives';
import { CARD, STRIP, INSET, BRAND_CHIP } from './format';

export interface FailurePayload {
  title?: string; method: string; url: string; error: string;
  expectedStatus?: number; requestBody?: string;
}

export default function Diagnose({ failure, onClose }: { failure: FailurePayload; onClose: () => void }) {
  const [diag, setDiag] = useState<Diagnosis | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const d = await diagnoseApiFailure(failure);
        if (!cancelled) setDiag(d);
      } catch (err: any) {
        if (!cancelled) setError(err?.response?.data?.error || err?.message || 'Diagnosis failed.');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const confCls = diag ? { high: 'text-emerald-700 bg-emerald-50 border-emerald-200', medium: 'text-amber-700 bg-amber-50 border-amber-200', low: 'text-gray-600 bg-gray-100 border-gray-300' }[diag.confidence] : '';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-[#1E1B4B]/30 backdrop-blur-sm p-4" onClick={onClose}>
      <div className={`${CARD} w-full max-w-xl max-h-[85vh] flex flex-col overflow-hidden`} onClick={(e) => e.stopPropagation()}>
        <div className={`flex items-center gap-2 px-4 h-12 border-b border-[#EDE9FE] flex-shrink-0 ${STRIP}`}>
          <Sparkles className="w-4 h-4 text-[#7C3AED]" />
          <h3 className="text-[13px] font-semibold text-gray-900">Root-cause analysis</h3>
          <button type="button" onClick={onClose} className="ml-auto p-1.5 rounded-md text-gray-400 hover:text-[#7C3AED] hover:bg-[#F5F3FF]"><X className="w-4 h-4" /></button>
        </div>

        <div className="p-4 space-y-3 overflow-y-auto min-h-0">
          <div className="flex items-center gap-2 text-[11.5px] text-gray-500 min-w-0">
            <span className="font-mono font-semibold text-[#6D28D9]">{failure.method.toUpperCase()}</span>
            <span className="font-mono truncate">{failure.url || failure.title}</span>
          </div>

          {loading ? (
            <div className="flex items-center justify-center gap-2 py-10 text-[12px] text-gray-500"><Loader2 className="w-4 h-4 animate-spin text-[#7C3AED]" />Analysing the failure…</div>
          ) : error ? (
            <div className="flex items-start gap-2 px-3 py-2 bg-red-50 border border-red-200 rounded-lg"><AlertTriangle className="w-4 h-4 text-red-500 flex-shrink-0 mt-px" /><p className="text-[12px] text-red-700 min-w-0">{error}</p></div>
          ) : diag ? (
            <>
              <div className="flex items-center gap-2">
                <span className={`text-[10px] font-semibold uppercase px-1.5 py-0.5 rounded border ${BRAND_CHIP}`}>{diag.category}</span>
                <span className={`text-[10px] font-semibold uppercase px-1.5 py-0.5 rounded border ${confCls}`}>{diag.confidence} confidence</span>
              </div>
              <div>
                <div className="text-[10.5px] font-semibold uppercase tracking-wide text-gray-500 mb-1">Root cause</div>
                <p className="text-[12.5px] text-gray-800 leading-relaxed">{diag.rootCause}</p>
              </div>
              {diag.suggestedFix && (
                <div className="flex items-start gap-2 bg-[#F5F3FF] border border-[#DDD6FE] rounded-lg px-3 py-2">
                  <Wrench className="w-3.5 h-3.5 text-[#7C3AED] flex-shrink-0 mt-0.5" />
                  <div><div className="text-[10.5px] font-semibold uppercase tracking-wide text-[#6D28D9] mb-0.5">Suggested fix</div><p className="text-[12px] text-[#4C1D95] leading-relaxed">{diag.suggestedFix}</p></div>
                </div>
              )}
              <div>
                <div className="flex items-center gap-1.5 mb-1"><Terminal className="w-3.5 h-3.5 text-gray-400" /><span className="text-[10.5px] font-semibold uppercase tracking-wide text-gray-500">Reproduce</span><CopyButton text={diag.reproCurl} className="ml-auto" /></div>
                <pre className={`font-mono text-[11px] text-gray-700 bg-[#FCFBFF] border border-[#E4E0F5] rounded-md p-2.5 whitespace-pre-wrap ${INSET}`}>{diag.reproCurl}</pre>
              </div>
              <p className="text-[10.5px] text-gray-400">To file this, use the Bug Tracker — the repro above is ready to paste.</p>
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}
