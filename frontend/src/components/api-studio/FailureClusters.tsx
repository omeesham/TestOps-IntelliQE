/**
 * FailureClusters — group a run's failures by root cause so similar reds are
 * fixed together instead of one-by-one. Opt-in and standalone; reads only the
 * failures it's given. Optional one-line AI fix suggestion per cluster.
 */
import { useEffect, useState } from 'react';
import { X, Layers, AlertTriangle, Sparkles, ChevronDown, ChevronRight } from 'lucide-react';
import Spinner from '@/components/feedback/Spinner';
import { clusterApiFailures, type FailureClusterReport } from '@/services/api';
import { CARD, STRIP } from './format';

export interface ClusterFailureInput { title?: string; method?: string; url?: string; error?: string; status?: number }

const CAT_COLOR: Record<string, string> = {
  timeout: 'text-amber-700 bg-amber-50 border-amber-200',
  selector: 'text-orange-700 bg-orange-50 border-orange-200',
  assertion: 'text-purple-700 bg-purple-50 border-purple-200',
  auth: 'text-red-700 bg-red-50 border-red-200',
  'server-5xx': 'text-red-700 bg-red-50 border-red-200',
  'not-found-404': 'text-amber-700 bg-amber-50 border-amber-200',
  connection: 'text-red-700 bg-red-50 border-red-200',
  compile: 'text-gray-700 bg-gray-100 border-gray-200',
  'rate-limit': 'text-amber-700 bg-amber-50 border-amber-200',
  other: 'text-gray-600 bg-gray-50 border-gray-200',
};

export default function FailureClusters({ failures, onClose }: { failures: ClusterFailureInput[]; onClose: () => void }) {
  const [report, setReport] = useState<FailureClusterReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [explaining, setExplaining] = useState(false);
  const [error, setError] = useState('');
  const [open, setOpen] = useState<Record<number, boolean>>({});

  const load = async (explain: boolean) => {
    if (explain) setExplaining(true); else setLoading(true);
    setError('');
    try { setReport(await clusterApiFailures(failures, explain)); }
    catch (e: any) { setError(e?.response?.data?.error || e?.message || 'Clustering failed.'); }
    finally { if (explain) setExplaining(false); else setLoading(false); }
  };
  // Run once on open with the failures passed in (they don't change for a given modal).
  useEffect(() => { void load(false); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-[#1E1B4B]/30 backdrop-blur-sm p-4" onClick={onClose}>
      <div className={`${CARD} w-full max-w-2xl max-h-[85vh] flex flex-col overflow-hidden`} onClick={(e) => e.stopPropagation()}>
        <div className={`flex items-center gap-2 px-4 h-12 border-b border-[#EDE9FE] flex-shrink-0 ${STRIP}`}>
          <Layers className="w-4 h-4 text-[#7C3AED]" />
          <h3 className="text-[13px] font-semibold text-gray-900">Failure clusters</h3>
          {report && <span className="text-[11px] text-gray-400">{report.summary.failures} failures → {report.summary.clusters} root cause{report.summary.clusters === 1 ? '' : 's'}</span>}
          <button type="button" onClick={() => void load(true)} disabled={loading || explaining} className="ml-auto inline-flex items-center gap-1 text-[11px] text-[#6D28D9] hover:underline disabled:opacity-40">
            {explaining ? <Spinner className="w-3 h-3 animate-spin" /> : <Sparkles className="w-3.5 h-3.5" />}Suggest fixes
          </button>
          <button type="button" onClick={onClose} className="p-1.5 rounded-md text-gray-400 hover:text-[#7C3AED] hover:bg-[#F5F3FF]"><X className="w-4 h-4" /></button>
        </div>

        <div className="p-4 space-y-2 overflow-y-auto min-h-0">
          {loading ? <div className="flex items-center justify-center py-8 text-gray-400"><Spinner className="w-5 h-5 animate-spin" /></div>
            : error ? <div className="flex items-start gap-2 px-3 py-2 bg-red-50 border border-red-200 rounded-lg"><AlertTriangle className="w-4 h-4 text-red-500 flex-shrink-0 mt-px" /><p className="text-[12px] text-red-700">{error}</p></div>
            : report && report.clusters.map((c, i) => (
              <div key={c.signature} className="border border-gray-100 rounded-lg">
                <button type="button" onClick={() => setOpen((o) => ({ ...o, [i]: !o[i] }))} className="w-full flex items-center gap-2 px-3 py-2 text-left">
                  {open[i] ? <ChevronDown className="w-3.5 h-3.5 text-gray-400" /> : <ChevronRight className="w-3.5 h-3.5 text-gray-400" />}
                  <span className={`inline-flex px-1.5 py-0.5 rounded border text-[10px] font-bold uppercase ${CAT_COLOR[c.category] || CAT_COLOR.other}`}>{c.category}</span>
                  <span className="text-[12px] text-gray-800 flex-1 min-w-0 truncate font-mono">{c.label}</span>
                  <span className="text-[11px] font-semibold text-gray-500 tabular-nums">{c.count}×</span>
                </button>
                {open[i] && (
                  <div className="px-3 pb-2.5 pt-0 space-y-1.5">
                    {c.suggestedFix && <div className="text-[11.5px] text-[#6D28D9] bg-[#F5F3FF] border border-[#E4E0F5] rounded px-2 py-1.5"><span className="font-semibold">Suggested fix:</span> {c.suggestedFix}</div>}
                    {c.sample.error && <pre className="text-[10.5px] font-mono text-gray-600 bg-gray-50 rounded p-2 overflow-x-auto max-h-28">{c.sample.error}</pre>}
                    <div className="text-[11px] text-gray-500">
                      <span className="font-semibold">Affected ({c.members.length}):</span>
                      <ul className="mt-0.5 space-y-0.5">{c.members.slice(0, 20).map((m, j) => <li key={j} className="truncate">· {m}</li>)}</ul>
                    </div>
                  </div>
                )}
              </div>
            ))}
        </div>
      </div>
    </div>
  );
}
